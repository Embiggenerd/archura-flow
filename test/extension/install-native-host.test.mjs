import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveExtensionId,
  manifestDirectory,
  selfTest,
  wrapperSource,
} from '../../scripts/install-native-host.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the extension id derived from the manifest key matches what Chrome computes', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT_DIR, 'extension', 'manifest.json'), 'utf8'));
  const id = deriveExtensionId(manifest.key);
  assert.match(id, /^[a-p]{32}$/);
  // Pinned: allowed_origins in the installed host manifest must match the id
  // Chrome shows for the unpacked extension, so a key change has to be deliberate.
  assert.equal(id, 'lddeibbpklcgmddooalfkbkcilhcdban');
});

test('manifest location is resolved per platform and unsupported ones say so', () => {
  assert.equal(
    manifestDirectory('darwin', '/Users/example'),
    '/Users/example/Library/Application Support/Google/Chrome/NativeMessagingHosts',
  );
  assert.equal(
    manifestDirectory('linux', '/home/example'),
    '/home/example/.config/google-chrome/NativeMessagingHosts',
  );
  assert.throws(() => manifestDirectory('win32', 'C:\\Users\\example'), /not supported yet/);
});

test('the wrapper pins an absolute node so Chrome does not need it on PATH', () => {
  const source = wrapperSource('/opt/homebrew/bin/node', '/repo/src/native-host.mjs');
  assert.match(source, /^#!\/bin\/sh\n/);
  assert.match(source, /exec "\/opt\/homebrew\/bin\/node" "\/repo\/src\/native-host\.mjs"/);
});

// The real host process, spawned the way Chrome spawns it, over real stdio.
test('a spawned host answers hello with ready', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'archura-flow-wrapper-'));
  const wrapperPath = path.join(directory, 'archura-flow-host');
  await writeFile(wrapperPath, wrapperSource(process.execPath, path.join(ROOT_DIR, 'src', 'native-host.mjs')));
  await chmod(wrapperPath, 0o755);

  const ready = await selfTest(wrapperPath);
  assert.equal(ready.type, 'ready');
  assert.equal(ready.protocolVersion, 1);
});
