import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createWriter,
  encodeMessage,
  FrameReader,
  MAX_CHUNK_BYTES,
  MAX_OUTBOUND_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  validateInbound,
} from '../src/native-protocol.mjs';
import { guardStdout, MessageProcessor, NativeHost } from '../src/native-host.mjs';

const frame = (value) => encodeMessage(value);

test('frame reader reassembles a message split across arbitrary chunks', () => {
  const reader = new FrameReader();
  const buffer = frame({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
  assert.deepEqual(reader.push(buffer.subarray(0, 2)), []);
  assert.deepEqual(reader.push(buffer.subarray(2, 3)), []);
  assert.deepEqual(reader.push(buffer.subarray(3, 9)), []);
  const messages = reader.push(buffer.subarray(9));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'hello');
});

test('frame reader yields several coalesced frames in order and keeps a partial tail', () => {
  const reader = new FrameReader();
  const combined = Buffer.concat([
    frame({ type: 'hello', protocolVersion: PROTOCOL_VERSION }),
    frame({ type: 'session.stop', reason: 'first' }),
    frame({ type: 'session.stop', reason: 'second' }).subarray(0, 5),
  ]);
  const messages = reader.push(combined);
  assert.deepEqual(messages.map((message) => message.reason), [undefined, 'first']);
  assert.equal(reader.buffer.length, 5);
});

test('frame length is measured in bytes, not characters, so Unicode survives', () => {
  const reader = new FrameReader();
  const label = "click on 'Ünicode ✓ 日本語 🎉'";
  const messages = reader.push(frame({ type: 'journal.append', entries: [{ label }] }));
  assert.equal(messages[0].entries[0].label, label);
});

test('a frame larger than the cap is fatal rather than silently truncated', () => {
  const reader = new FrameReader({ maxBytes: 64 });
  const header = Buffer.alloc(4);
  header.writeUInt32LE(65, 0);
  assert.throws(() => reader.push(header), (error) =>
    error instanceof ProtocolError && error.code === 'message-too-large');
});

test('malformed JSON and non-object frames are rejected', () => {
  const body = Buffer.from('{"type":', 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  assert.throws(() => new FrameReader().push(Buffer.concat([header, body])), (error) =>
    error instanceof ProtocolError && error.code === 'malformed-json');

  const array = Buffer.from('[1,2]', 'utf8');
  const arrayHeader = Buffer.alloc(4);
  arrayHeader.writeUInt32LE(array.length, 0);
  assert.throws(() => new FrameReader().push(Buffer.concat([arrayHeader, array])), (error) =>
    error instanceof ProtocolError && error.code === 'malformed-json');
});

test('outbound frames are held under Chrome host-to-extension limit', () => {
  assert.throws(() => encodeMessage({ type: 'state', blob: 'x'.repeat(MAX_OUTBOUND_BYTES) }), (error) =>
    error instanceof ProtocolError && error.code === 'outbound-too-large');
});

test('validation rejects unsupported versions, unknown types, and bad chunks', () => {
  assert.throws(() => validateInbound({ type: 'hello', protocolVersion: PROTOCOL_VERSION + 1 }), (error) =>
    error.code === 'unsupported-version');
  assert.throws(() => validateInbound({ type: 'debugger.sendCommand' }), (error) =>
    error.code === 'unknown-type');
  // The artifact allowlist is what stops a message from naming a file path.
  assert.throws(() => validateInbound({
    type: 'capture.chunk', requestId: 'r1', artifact: '../../etc/passwd', index: 0, data: '',
  }),
    (error) => error.code === 'unknown-artifact');
  assert.throws(() => validateInbound({
    type: 'capture.chunk', requestId: 'r1', artifact: 'html', index: -1, data: '',
  }), (error) => error.code === 'bad-chunk');
  assert.throws(() => validateInbound({
    type: 'capture.chunk',
    requestId: 'r1',
    artifact: 'html',
    index: 0,
    data: 'x'.repeat(MAX_CHUNK_BYTES * 2 + 1),
  }), (error) => error.code === 'bad-chunk');
  assert.throws(() => validateInbound({ type: 'journal.append', entries: 'nope' }), (error) =>
    error.code === 'bad-journal');
  assert.throws(() => validateInbound({
    type: 'capture.begin',
    requestId: '../../../../outside',
  }), (error) => error.code === 'bad-request-id');
});

test('guardStdout diverts stray logging away from the protocol stream', () => {
  const original = { log: console.log, warn: console.warn };
  const stderrWrite = process.stderr.write;
  const stdoutWrite = process.stdout.write;
  const stderr = [];
  let stdoutBytes = 0;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  process.stdout.write = (chunk) => { stdoutBytes += chunk.length; return true; };
  try {
    guardStdout();
    console.log('a stray diagnostic');
    console.warn('and a warning');
  } finally {
    process.stderr.write = stderrWrite;
    process.stdout.write = stdoutWrite;
    Object.assign(console, original);
  }
  assert.equal(stdoutBytes, 0);
  assert.match(stderr.join(''), /a stray diagnostic/);
  assert.match(stderr.join(''), /and a warning/);
});

test('writer serializes frames onto the stream a reader can consume', async () => {
  const chunks = [];
  const write = createWriter({ write: (chunk, callback) => { chunks.push(chunk); callback(); return true; } });
  await write({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
  const messages = new FrameReader().push(Buffer.concat(chunks));
  assert.deepEqual(messages, [{ type: 'ready', protocolVersion: PROTOCOL_VERSION }]);
});

test('message processor serializes separate stdin data events', async () => {
  const order = [];
  const host = {
    async handle(message) {
      order.push(`start:${message.reason}`);
      if (message.reason === 'first') await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end:${message.reason}`);
    },
  };
  const processor = new MessageProcessor({ reader: new FrameReader(), host });
  const first = processor.push(frame({ type: 'session.stop', reason: 'first' }));
  const second = processor.push(frame({ type: 'session.stop', reason: 'second' }));
  await Promise.all([first, second]);
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);
});

test('message processor drain preserves a fatal framing error', async () => {
  const processor = new MessageProcessor({
    reader: new FrameReader({ maxBytes: 4 }),
    host: { handle: async () => {} },
  });
  const header = Buffer.alloc(4);
  header.writeUInt32LE(5);
  await assert.rejects(processor.push(header), (error) => error.code === 'message-too-large');
  await assert.rejects(processor.drain(), (error) => error.code === 'message-too-large');
});

async function makeHost() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'archura-flow-host-'));
  const sent = [];
  const host = new NativeHost({
    rootDir,
    send: async (message) => { sent.push(message); },
    viewerFactory: async () => ({ url: 'http://127.0.0.1:1/token/', close: async () => {} }),
  });
  return { host, sent, rootDir };
}

test('host answers hello and refuses work before a session exists', async () => {
  const { host, sent } = await makeHost();
  await host.handle({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
  assert.deepEqual(sent.at(-1), { type: 'ready', protocolVersion: PROTOCOL_VERSION });

  await host.handle({ type: 'journal.append', entries: [{ sequence: 1, type: 'click' }] });
  assert.equal(sent.at(-1).type, 'error');
  assert.equal(sent.at(-1).code, 'no-session');
});

test('journal entries deduplicate by sequence and reject a stale epoch', async () => {
  const { host, sent } = await makeHost();
  await host.handle({ type: 'session.start', url: 'https://app.example.com/plans' });
  const { epoch } = sent.at(-1);

  const entry = (sequence, label) => ({ sequence, type: 'click', key: `k${sequence}`, label, url: 'u', at: 'now' });
  await host.handle({ type: 'journal.append', epoch, entries: [entry(1, 'first'), entry(2, 'second')] });
  // A retried batch replays sequences the host already recorded.
  await host.handle({ type: 'journal.append', epoch, entries: [entry(2, 'second again'), entry(3, 'third')] });
  const edge = host.session.capture.takeEdge('extension');
  assert.deepEqual(edge.map((item) => item.label), ['first', 'second', 'third']);

  await host.handle({ type: 'journal.append', epoch: 'from-a-dead-host', entries: [entry(9, 'stale')] });
  assert.equal(sent.at(-1).code, 'stale-epoch');

  await host.handle({ type: 'journal.append', entries: [entry(10, 'missing epoch')] });
  assert.equal(sent.at(-1).code, 'stale-epoch');
});

test('a second session.start is refused while one is recording', async () => {
  const { host, sent } = await makeHost();
  await host.handle({ type: 'session.start', url: 'https://app.example.com/' });
  await host.handle({ type: 'session.start', url: 'https://other.example.com/' });
  assert.equal(sent.at(-1).code, 'session-active');
});

test('stopping clears session state and reports idle', async () => {
  const { host, sent } = await makeHost();
  await host.handle({ type: 'session.start', url: 'https://app.example.com/' });
  const { epoch } = host.session;
  await host.handle({ type: 'session.stop', epoch, reason: 'tab-closed' });
  assert.equal(host.state, 'idle');
  assert.equal(sent.at(-1).state, 'idle');
  assert.equal(sent.at(-1).reason, 'tab-closed');
});

test('starting a new session replaces the viewer bound to the previous run', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'archura-flow-viewer-session-'));
  const opened = [];
  const sent = [];
  const host = new NativeHost({
    rootDir,
    send: async (message) => { sent.push(message); },
    viewerFactory: async ({ run }) => {
      opened.push(run.name);
      return { url: `http://viewer/${run.name}`, close: async () => {} };
    },
  });
  await host.handle({ type: 'session.start', url: 'https://first.example/' });
  let { epoch } = host.session;
  await host.handle({ type: 'viewer.open', epoch, requestId: 'v1' });
  await host.handle({ type: 'session.stop', epoch, reason: 'switch' });
  await host.handle({ type: 'session.start', url: 'https://second.example/' });
  ({ epoch } = host.session);
  await host.handle({ type: 'viewer.open', epoch, requestId: 'v2' });
  assert.deepEqual(opened, ['first.example', 'second.example']);
  assert.equal(sent.at(-1).url, 'http://viewer/second.example');
  await host.shutdown();
});
