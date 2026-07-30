#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CaptureSession } from './capture-session.mjs';
import { cleanupAbandonedCaptures, PendingCapture } from './extension-capture.mjs';
import { startLiveViewer } from './live-viewer.mjs';
import {
  createWriter,
  FrameReader,
  PROTOCOL_VERSION,
  ProtocolError,
  validateInbound,
} from './native-protocol.mjs';
import { createRun, outputName } from './snapshot.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// stdout belongs to the protocol. Anything a dependency logs there would be
// read by Chrome as a frame header and desynchronize the stream permanently.
export function guardStdout() {
  const toStderr = (...args) => process.stderr.write(`${args.join(' ')}\n`);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
}

export class NativeHost {
  constructor({ send, rootDir = ROOT_DIR, viewerFactory = startLiveViewer }) {
    this.send = send;
    this.rootDir = rootDir;
    this.viewerFactory = viewerFactory;
    this.session = null;
    this.pending = new Map();
    this.viewer = null;
    this.greeted = false;
  }

  get state() {
    if (!this.session) return 'idle';
    return this.pending.size ? 'capturing' : 'recording';
  }

  async describeState() {
    return {
      type: 'state',
      state: this.state,
      output: this.session?.output || null,
      epoch: this.session?.epoch || null,
      screenCount: this.session?.capture.screenCount ?? 0,
      viewerUrl: this.viewer?.url || null,
    };
  }

  async handle(raw) {
    let message;
    try {
      message = validateInbound(raw);
    } catch (error) {
      await this.fail(raw?.requestId, error);
      return;
    }
    try {
      await this.dispatch(message);
    } catch (error) {
      await this.fail(message.requestId, error);
    }
  }

  async fail(requestId, error) {
    const code = error instanceof ProtocolError ? error.code : 'host-error';
    process.stderr.write(`[archura-flow] ${code}: ${error.message}\n`);
    await this.send({
      type: 'error',
      ...(requestId ? { requestId } : {}),
      code,
      message: error.message,
    });
  }

  requireSession(message) {
    if (!this.session) {
      throw new ProtocolError('no-session', `${message.type} arrived before session.start.`);
    }
    if (message.epoch && message.epoch !== this.session.epoch) {
      throw new ProtocolError('stale-epoch',
        `Message carries epoch ${message.epoch}; current epoch is ${this.session.epoch}.`);
    }
    return this.session;
  }

  async dispatch(message) {
    switch (message.type) {
      case 'hello':
        this.greeted = true;
        await this.send({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
        return;
      case 'session.start':
        await this.startSession(message);
        return;
      case 'journal.append':
        this.appendJournal(message);
        return;
      case 'capture.begin':
        await this.beginCapture(message);
        return;
      case 'capture.chunk':
        await this.chunkCapture(message);
        return;
      case 'capture.commit':
        await this.commitCapture(message);
        return;
      case 'viewer.open':
        await this.openViewer(message);
        return;
      case 'session.stop':
        await this.stopSession(message);
        return;
      default:
        throw new ProtocolError('unknown-type', `No handler for ${message.type}.`);
    }
  }

  async startSession(message) {
    if (!message.url) throw new ProtocolError('bad-session', 'session.start requires a url.');
    if (this.session) {
      throw new ProtocolError('session-active',
        'A recording is already active; send session.stop before starting another.');
    }
    const run = await createRun({
      rootDir: this.rootDir,
      startUrl: message.url,
      viewportOnly: Boolean(message.viewportOnly),
    });
    await cleanupAbandonedCaptures(run);
    this.session = {
      id: randomBytes(8).toString('hex'),
      // A fresh epoch per host process: a restarted host must not accept
      // sequence numbers minted against the previous process's counter.
      epoch: randomBytes(8).toString('hex'),
      output: outputName(message.url),
      tab: message.tab || null,
      run,
      capture: new CaptureSession({ run, rootDir: this.rootDir }),
      lastSequence: 0,
    };
    this.session.capture.openChannel('extension');
    await this.send({
      type: 'session.started',
      sessionId: this.session.id,
      epoch: this.session.epoch,
      output: this.session.output,
      screenCount: this.session.capture.screenCount,
    });
  }

  // Entries are deduplicated by (epoch, sequence): a retried batch replays
  // sequence numbers the host has already seen and must be ignored, not appended.
  appendJournal(message) {
    const session = this.requireSession(message);
    for (const entry of message.entries) {
      if (!Number.isInteger(entry?.sequence)) {
        throw new ProtocolError('bad-journal', 'Journal entries require an integer sequence.');
      }
      if (entry.sequence <= session.lastSequence) continue;
      session.lastSequence = entry.sequence;
      session.capture.appendJournal('extension', {
        type: entry.type,
        key: entry.key ?? null,
        label: entry.label,
        url: entry.url,
        at: entry.at,
      });
    }
  }

  async beginCapture(message) {
    const session = this.requireSession(message);
    if (this.pending.has(message.requestId)) {
      throw new ProtocolError('duplicate-capture', `Capture ${message.requestId} is already open.`);
    }
    const pending = new PendingCapture({
      run: session.run,
      requestId: message.requestId,
      url: message.url,
      title: message.title,
      viewports: message.viewports,
      warnings: message.warnings || [],
      tab: message.tab || session.tab,
    });
    await pending.open();
    this.pending.set(message.requestId, pending);
  }

  async chunkCapture(message) {
    this.requireSession(message);
    const pending = this.pending.get(message.requestId);
    if (!pending) throw new ProtocolError('unknown-capture', `No open capture ${message.requestId}.`);
    await pending.appendChunk(message);
  }

  async commitCapture(message) {
    const session = this.requireSession(message);
    const pending = this.pending.get(message.requestId);
    if (!pending) throw new ProtocolError('unknown-capture', `No open capture ${message.requestId}.`);
    try {
      const result = await session.capture.enqueue(() => pending.commit({
        skeleton: message.skeleton,
        elements: message.elements || [],
        state: message.state,
        edge: session.capture.takeEdge('extension'),
        rootDir: this.rootDir,
      }));
      await this.send({
        type: 'capture.done',
        requestId: message.requestId,
        screenId: result.screen.id,
        ...(result.screen.sameAs ? { sameAs: result.screen.sameAs } : {}),
        screenCount: session.capture.screenCount,
      });
    } finally {
      this.pending.delete(message.requestId);
    }
  }

  async openViewer(message) {
    const session = this.requireSession(message);
    if (!this.viewer) {
      this.viewer = await this.viewerFactory({ run: session.run, rootDir: this.rootDir });
    }
    await this.send({ type: 'viewer.url', requestId: message.requestId, url: this.viewer.url });
  }

  async stopSession(message) {
    if (!this.session) {
      await this.send(await this.describeState());
      return;
    }
    for (const pending of this.pending.values()) await pending.discard();
    this.pending.clear();
    await cleanupAbandonedCaptures(this.session.run);
    this.session = null;
    await this.send({
      type: 'state',
      state: 'idle',
      reason: message.reason || 'stopped',
      output: null,
      epoch: null,
      screenCount: 0,
      viewerUrl: this.viewer?.url || null,
    });
  }

  async shutdown() {
    for (const pending of this.pending.values()) await pending.discard().catch(() => {});
    this.pending.clear();
    if (this.viewer) await this.viewer.close().catch(() => {});
    this.viewer = null;
    this.session = null;
  }
}

async function main() {
  guardStdout();
  const send = createWriter(process.stdout);
  const host = new NativeHost({ send });
  const reader = new FrameReader();

  const finish = async (code = 0) => {
    await host.shutdown();
    process.exit(code);
  };

  process.stdin.on('data', async (chunk) => {
    let messages;
    try {
      messages = reader.push(chunk);
    } catch (error) {
      await host.fail(null, error);
      await finish(1);
      return;
    }
    for (const message of messages) await host.handle(message);
  });
  process.stdin.on('end', () => finish(0));
  process.on('SIGTERM', () => finish(0));
  process.on('SIGINT', () => finish(0));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
