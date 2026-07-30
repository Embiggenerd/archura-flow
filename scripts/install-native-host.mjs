#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { encodeMessage, FrameReader, PROTOCOL_VERSION } from '../src/native-protocol.mjs';

export const HOST_NAME = 'com.archura.flow';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Chrome derives an unpacked extension's id from the manifest's public key, so
// deriving it here too keeps the pinned allowed_origins from drifting.
export function deriveExtensionId(publicKeyBase64) {
  const digest = createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex');
  return [...digest.slice(0, 32)].map((character) => String.fromCharCode(97 + parseInt(character, 16))).join('');
}

export function manifestDirectory(platform = process.platform, home = os.homedir()) {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  }
  if (platform === 'linux') {
    return path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts');
  }
  throw new Error(
    `Native messaging installation for ${platform} is not supported yet. ` +
    'macOS and Linux install by writing a manifest file; Windows needs a registry key.',
  );
}

// Chrome executes this path directly, so it must not depend on Chrome's PATH
// containing whichever node a version manager put there.
export function wrapperSource(nodeBinary, hostEntry) {
  return `#!/bin/sh\nexec ${JSON.stringify(nodeBinary)} ${JSON.stringify(hostEntry)} "$@"\n`;
}

export async function selfTest(wrapperPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(wrapperPath, { stdio: ['pipe', 'pipe', 'pipe'] });
    const reader = new FrameReader();
    const stderr = [];
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      child.kill();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Host did not reply to hello within 10s.')), 10_000);
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    child.stdout.on('data', (chunk) => {
      let messages;
      try {
        messages = reader.push(chunk);
      } catch (error) {
        clearTimeout(timer);
        finish(error);
        return;
      }
      for (const message of messages) {
        if (message.type !== 'ready') continue;
        clearTimeout(timer);
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          finish(new Error(`Host replied with protocol ${message.protocolVersion}.`));
          return;
        }
        finish(null, message);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(new Error(`Host exited with code ${code}. ${stderr.join('')}`.trim()));
    });
    child.stdin.write(encodeMessage({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
  });
}

export async function install({ testOnly = false } = {}) {
  const extensionManifest = JSON.parse(
    await readFile(path.join(ROOT_DIR, 'extension', 'manifest.json'), 'utf8'),
  );
  if (!extensionManifest.key) throw new Error('extension/manifest.json is missing its fixed "key".');
  const extensionId = deriveExtensionId(extensionManifest.key);

  const hostEntry = path.join(ROOT_DIR, 'src', 'native-host.mjs');
  const wrapperPath = path.join(ROOT_DIR, 'scripts', 'archura-flow-host');
  await writeFile(wrapperPath, wrapperSource(process.execPath, hostEntry));
  await chmod(wrapperPath, 0o755);

  const ready = await selfTest(wrapperPath);
  if (testOnly) {
    console.log(`✓ host self-test passed (protocol ${ready.protocolVersion})`);
    console.log(`  wrapper: ${wrapperPath}`);
    return { extensionId, wrapperPath };
  }

  const directory = manifestDirectory();
  await mkdir(directory, { recursive: true });
  const manifestPath = path.join(directory, `${HOST_NAME}.json`);
  await writeFile(manifestPath, `${JSON.stringify({
    name: HOST_NAME,
    description: 'archura-flow capture companion',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2)}\n`);

  console.log('✓ archura-flow native messaging host installed');
  console.log(`  manifest:  ${manifestPath}`);
  console.log(`  wrapper:   ${wrapperPath}`);
  console.log(`  node:      ${process.execPath}`);
  console.log(`  self-test: passed (protocol ${ready.protocolVersion})`);
  console.log('');
  console.log('Next, load the extension in Chrome:');
  console.log('  1. Open chrome://extensions and turn on Developer mode.');
  console.log(`  2. "Load unpacked" and choose: ${path.join(ROOT_DIR, 'extension')}`);
  console.log(`  3. Confirm the extension id reads ${extensionId}`);
  console.log('     (a different id means the manifest key changed — re-run this installer).');
  console.log('  4. Set or change the shortcut at chrome://extensions/shortcuts');
  console.log('     (default Command+Shift+Y on macOS, Ctrl+Shift+Y elsewhere).');
  return { extensionId, manifestPath, wrapperPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await install({ testOnly: process.argv.includes('--self-test') }).catch((error) => {
    console.error(`Install failed: ${error.message}`);
    process.exitCode = 1;
  });
}
