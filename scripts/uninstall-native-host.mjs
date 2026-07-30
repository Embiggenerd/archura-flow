#!/usr/bin/env node
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { HOST_NAME, manifestDirectory } from './install-native-host.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function uninstall() {
  const manifestPath = path.join(manifestDirectory(), `${HOST_NAME}.json`);
  const wrapperPath = path.join(ROOT_DIR, 'scripts', 'archura-flow-host');

  // Only remove a manifest this project wrote: a same-named file pointing
  // somewhere else belongs to another install and is left alone.
  let owned = false;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    owned = manifest.name === HOST_NAME && manifest.path === wrapperPath;
    if (!owned) {
      console.log(`• left ${manifestPath} alone — it points at ${manifest.path}, not this checkout.`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log(`• no manifest at ${manifestPath}`);
  }

  if (owned) {
    await rm(manifestPath, { force: true });
    console.log(`✓ removed ${manifestPath}`);
  }
  await rm(wrapperPath, { force: true });
  console.log(`✓ removed ${wrapperPath}`);
  console.log('');
  console.log('Captures under out/ and your Chrome profile were not touched.');
  console.log('Remove the extension itself from chrome://extensions.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await uninstall().catch((error) => {
    console.error(`Uninstall failed: ${error.message}`);
    process.exitCode = 1;
  });
}
