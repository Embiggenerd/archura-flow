import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACT_NAMES, ProtocolError } from './native-protocol.mjs';
import { signatureFor } from './identity.mjs';
import { recordScreen } from './snapshot.mjs';

// Streamed artifacts land here and are moved into html/ and shots/ only on
// commit, so an interrupted capture can never leave a half-valid screen node.
export const TEMP_DIR = '.captures';

const SHOT_ARTIFACTS = ARTIFACT_NAMES.filter((name) => name !== 'html');

export async function cleanupAbandonedCaptures(run) {
  await rm(path.join(run.dir, TEMP_DIR), { recursive: true, force: true });
}

export class PendingCapture {
  constructor({ run, requestId, url, title, viewports, warnings = [], tab }) {
    if (!requestId) throw new ProtocolError('bad-capture', 'capture.begin requires a request id.');
    if (!url) throw new ProtocolError('bad-capture', 'capture.begin requires a url.');
    this.run = run;
    this.requestId = requestId;
    this.url = url;
    this.title = title || '';
    this.viewports = viewports || {};
    this.warnings = warnings;
    this.tab = tab;
    this.dir = path.join(run.dir, TEMP_DIR, String(requestId));
    this.received = new Map();
  }

  async open() {
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
  }

  tempFile(artifact) {
    return path.join(this.dir, artifact === 'html' ? 'page.html' : `${artifact}.png`);
  }

  // Chunks must arrive in order: appending an out-of-order chunk would silently
  // corrupt the artifact rather than fail loudly.
  async appendChunk({ artifact, index, data }) {
    const expected = this.received.get(artifact) ?? 0;
    if (index !== expected) {
      throw new ProtocolError('bad-chunk',
        `Artifact ${artifact} expected chunk ${expected} but received ${index}.`);
    }
    await appendFile(this.tempFile(artifact), Buffer.from(data, 'base64'));
    this.received.set(artifact, expected + 1);
  }

  async discard() {
    await rm(this.dir, { recursive: true, force: true });
  }

  async commit({ skeleton, elements = [], source = 'combo', state, edge = [], rootDir, driver = 'chrome-extension' }) {
    if (typeof skeleton !== 'string') {
      throw new ProtocolError('bad-capture', 'capture.commit requires a skeleton string.');
    }
    if (!this.received.has('html')) {
      throw new ProtocolError('missing-artifact', 'capture.commit arrived without html.');
    }
    if (!this.received.has('desktop')) {
      throw new ProtocolError('missing-artifact', 'capture.commit arrived without a desktop screenshot.');
    }

    try {
      const result = await recordScreen({
        run: this.run,
        rootDir,
        signature: signatureFor(skeleton, this.url),
        url: this.url,
        title: this.title,
        source,
        state: state || { root: this.url, path: [] },
        edge,
        metadata: {
          driver,
          ...(this.tab ? { tab: this.tab } : {}),
          viewports: this.viewports,
          snapshotWarnings: this.warnings,
        },
        writeArtifacts: async ({ id, htmlPath, shots }) => {
          await rename(this.tempFile('html'), path.join(this.run.dir, htmlPath));
          const written = {};
          for (const artifact of SHOT_ARTIFACTS) {
            if (!this.received.has(artifact)) continue;
            await rename(this.tempFile(artifact), path.join(this.run.dir, shots[artifact]));
            written[artifact] = shots[artifact];
          }
          return { shots: written };
        },
        collectElements: () => elements,
      });
      return result;
    } finally {
      await this.discard();
    }
  }
}

export async function artifactSize(pending, artifact) {
  try {
    return (await stat(pending.tempFile(artifact))).size;
  } catch {
    return 0;
  }
}
