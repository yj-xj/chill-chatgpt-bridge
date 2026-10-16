import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

// A path is not a credential. Passing it explicitly avoids depending on the
// desktop shell's inherited environment and never changes user/global settings.
let dataDirectory;
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--data-dir' || !isAbsolute(args[1]) || /[\u0000-\u001f]/.test(args[1])) {
    throw new Error('Invalid launcher arguments.');
  }
  dataDirectory = resolve(args[1]);
  process.env.CHILL_BRIDGE_DATA_DIR = dataDirectory;
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(join(dataDirectory, 'launcher-context.json'), JSON.stringify({
    pid: process.pid, parentPid: process.ppid, dataDirectory,
    executable: process.execPath, startedAt: new Date().toISOString(),
  }, null, 2));
  const { main } = await import('./server.mjs');
  await main();
  await appendFile(join(dataDirectory, 'launcher-output.log'), `${new Date().toISOString()} Bridge ready; pid=${process.pid}\n`);
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(error.code) ? error.code : 'launcher_error';
  if (dataDirectory) {
    await appendFile(join(dataDirectory, 'launcher-error.log'), `${new Date().toISOString()} Bridge startup failed: ${code}\n`).catch(() => {});
  }
  // main() may already have bound its HTTP listener before a later operation
  // fails. Do not leave a partially initialized service running.
  process.exit(1);
}
