import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWindowsEncryption, openSystemBrowser } from '../platform.mjs';

test('credential provider has the stable official SDK interface', () => {
  const provider = createWindowsEncryption();
  assert.equal(provider.id, 'windows-dpapi-v1');
  for (const method of ['isAvailable', 'encrypt', 'decrypt']) assert.equal(typeof provider[method], 'function');
});

test('Windows DPAPI protects and restores UTF-8 credential data for this user', {
  skip: process.platform !== 'win32',
  timeout: 60000,
}, async () => {
  const provider = createWindowsEncryption();
  assert.equal(await provider.isAvailable(), true);
  const sample = JSON.stringify({ accessToken: 'fabricated-test-only-credential', name: '中文 🎵', value: '\0\n' });
  const encrypted = await provider.encrypt(sample);
  assert.ok(encrypted instanceof Uint8Array);
  assert.equal(Buffer.from(encrypted).includes(Buffer.from(sample)), false);
  assert.equal(await provider.decrypt(encrypted), sample);
  const second = await provider.encrypt(sample);
  assert.notDeepEqual(second, encrypted);
  assert.equal(await provider.decrypt(second), sample);
});

test('Windows DPAPI supports an empty plaintext', {
  skip: process.platform !== 'win32',
  timeout: 30000,
}, async () => {
  const provider = createWindowsEncryption();
  assert.equal(await provider.decrypt(await provider.encrypt('')), '');
});

test('invalid ciphertext fails without including the sensitive input', {
  skip: process.platform !== 'win32',
  timeout: 30000,
}, async () => {
  const secret = 'fabricated-sensitive-payload-do-not-log';
  await assert.rejects(createWindowsEncryption().decrypt(Buffer.from(secret)), (error) => {
    assert.equal(error.message, 'Windows credential protection is unavailable.');
    assert.equal(String(error).includes(secret), false);
    return true;
  });
});

test('missing or invalid PowerShell fails closed with a sanitized error', async () => {
  const provider = createWindowsEncryption({ powershellPath: 'not-an-absolute-path-private-marker' });
  assert.equal(await provider.isAvailable(), false);
  for (const operation of [() => provider.encrypt('private-marker'), () => provider.decrypt(new Uint8Array([1]))]) {
    await assert.rejects(operation(), { message: 'Windows credential protection is unavailable.' });
  }
});

test('an unavailable helper executable cannot expose input or process errors', {
  skip: process.platform !== 'win32',
  timeout: 30000,
}, async () => {
  const privateMarker = 'fabricated-private-marker';
  const provider = createWindowsEncryption({ powershellPath: join(tmpdir(), 'bridge-missing-executable', `${privateMarker}.exe`) });
  assert.equal(await provider.isAvailable(), false);
  await assert.rejects(provider.encrypt(privateMarker), (error) => {
    assert.equal(error.message, 'Windows credential protection is unavailable.');
    assert.equal(String(error).includes(privateMarker), false);
    assert.equal(String(error).includes('ENOENT'), false);
    return true;
  });
});

test('non-Windows hosts fail closed', { skip: process.platform === 'win32' }, async () => {
  const provider = createWindowsEncryption();
  assert.equal(await provider.isAvailable(), false);
  await assert.rejects(provider.encrypt('fabricated-test-only'), { message: 'Windows credential protection is unavailable.' });
  await assert.rejects(provider.decrypt(new Uint8Array([1])), { message: 'Windows credential protection is unavailable.' });
});

test('credential input types and size are bounded before spawning a helper', async () => {
  const provider = createWindowsEncryption();
  await assert.rejects(provider.encrypt({ accessToken: 'fabricated' }), { message: 'Windows credential protection is unavailable.' });
  await assert.rejects(provider.encrypt('x'.repeat(1024 * 1024 + 1)), { message: 'Windows credential protection is unavailable.' });
  for (const invalid of [null, 'fabricated-ciphertext', new Uint8Array(), new Uint8Array(1024 * 1024 + 65537)]) {
    await assert.rejects(provider.decrypt(invalid), { message: 'Windows credential protection is unavailable.' });
  }
});

test('browser opener rejects non-official or ambiguous URLs without launching', async () => {
  const invalid = [
    'http://auth.openai.com/authorize',
    'https://chatgpt.com/',
    'https://auth.openai.com.evil.invalid/authorize',
    'https://auth.openai.com@evil.invalid/',
    'https://user:password@auth.openai.com/',
    'https://auth.openai.com:444/',
    'https://auth.openai.com/#fragment',
    ' https://auth.openai.com/',
    'https://auth.openai.com/\nmalformed',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    null,
  ];
  for (const url of invalid) {
    await assert.rejects(openSystemBrowser(url), { message: 'Only official OpenAI HTTPS authorization URLs can be opened.' });
  }
});
