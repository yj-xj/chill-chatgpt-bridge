import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER_PATH = fileURLToPath(new URL('./dpapi.ps1', import.meta.url));
const MAX_PLAINTEXT_BYTES = 1024 * 1024;
const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + 65536;
const MAX_PIPE_BYTES = 2 * MAX_CIPHERTEXT_BYTES;
const HELPER_TIMEOUT_MS = 15000;

function platformError() {
  return new Error('Windows credential protection is unavailable.');
}

function defaultPowerShellPath() {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// The child receives secrets only on stdin. Its output and errors never become
// exception messages, and no plaintext file is created by this module.
function runHelper(powershellPath, mode, input) {
  return new Promise((resolve, reject) => {
    let child;
    let done = false;
    let size = 0;
    let stderrSize = 0;
    const chunks = [];
    let timer;

    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        child?.kill();
        for (const chunk of chunks) chunk.fill(0);
        reject(platformError());
      } else {
        const output = Buffer.concat(chunks, size);
        for (const chunk of chunks) chunk.fill(0);
        resolve(output);
      }
    };

    try {
      child = spawn(powershellPath, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', HELPER_PATH, '-Mode', mode,
      ], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      finish(true);
      return;
    }

    timer = setTimeout(() => finish(true), HELPER_TIMEOUT_MS);
    child.on('error', () => finish(true));
    child.on('close', (code) => finish(code !== 0));
    child.stdin.on('error', () => finish(true));
    child.stdout.on('data', (chunk) => {
      if (done) { chunk.fill(0); return; }
      size += chunk.length;
      if (size > MAX_PIPE_BYTES) { chunk.fill(0); finish(true); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrSize += chunk.length;
      chunk.fill(0);
      if (stderrSize > MAX_PIPE_BYTES) finish(true);
    });
    child.stdin.end(input);
  });
}

function decodeBase64(output, maximumLength) {
  let decoded;
  try {
    const encoded = output.toString('ascii');
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw platformError();
    decoded = Buffer.from(encoded, 'base64');
    if (decoded.length > maximumLength || decoded.toString('base64') !== encoded) throw platformError();
    return decoded;
  } catch {
    decoded?.fill(0);
    throw platformError();
  } finally {
    output.fill(0);
  }
}

/** Official SIWC SDK CredentialEncryption provider, bound to this Windows user. */
export function createWindowsEncryption({ powershellPath = defaultPowerShellPath() } = {}) {
  const supported = process.platform === 'win32' &&
    typeof powershellPath === 'string' && isAbsolute(powershellPath) && !powershellPath.includes('\0');

  return {
    id: 'windows-dpapi-v1',
    async isAvailable() {
      if (!supported) return false;
      let output;
      try {
        output = await runHelper(powershellPath, 'Probe', Buffer.alloc(0));
        return output.toString('ascii') === 'ok';
      } catch {
        return false;
      } finally {
        output?.fill(0);
      }
    },
    async encrypt(plaintext) {
      if (!supported || typeof plaintext !== 'string') throw platformError();
      const input = Buffer.from(plaintext, 'utf8');
      let protectedBytes;
      try {
        if (input.length > MAX_PLAINTEXT_BYTES) throw platformError();
        const output = await runHelper(powershellPath, 'Encrypt', input);
        protectedBytes = decodeBase64(output, MAX_CIPHERTEXT_BYTES);
        if (protectedBytes.length === 0) throw platformError();
        return Uint8Array.from(protectedBytes);
      } finally {
        input.fill(0);
        protectedBytes?.fill(0);
      }
    },
    async decrypt(ciphertext) {
      if (!supported || !(ciphertext instanceof Uint8Array) ||
          ciphertext.length === 0 || ciphertext.length > MAX_CIPHERTEXT_BYTES) throw platformError();
      const input = Buffer.from(Buffer.from(ciphertext).toString('base64'), 'ascii');
      let plaintextBytes;
      try {
        const output = await runHelper(powershellPath, 'Decrypt', input);
        plaintextBytes = decodeBase64(output, MAX_PLAINTEXT_BYTES);
        return new TextDecoder('utf-8', { fatal: true }).decode(plaintextBytes);
      } catch {
        throw platformError();
      } finally {
        input.fill(0);
        plaintextBytes?.fill(0);
      }
    },
  };
}

/** Open only the official OpenAI authorization host in the system browser. */
export async function openSystemBrowser(value) {
  let url;
  try {
    if (typeof value !== 'string' || value.length > 16384 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error();
    url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' ||
        url.username || url.password || url.port || url.hash) throw new Error();
  } catch {
    throw new Error('Only official OpenAI HTTPS authorization URLs can be opened.');
  }
  if (process.platform !== 'win32') throw new Error('System browser launch requires Windows.');

  await new Promise((resolve, reject) => {
    let child;
    let done = false;
    let timer;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        child?.kill();
        reject(new Error('Could not open the system browser.'));
      } else resolve();
    };
    try {
      const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe');
      child = spawn(executable, ['url.dll,FileProtocolHandler', url.href], {
        shell: false, windowsHide: true, stdio: 'ignore',
      });
      timer = setTimeout(() => finish(true), HELPER_TIMEOUT_MS);
      child.on('error', () => finish(true));
      child.on('close', (code) => finish(code !== 0));
    } catch {
      finish(true);
    }
  });
}
