// Chrome Native Messaging framing: a 4-byte native-endian uint32 length prefix
// followed by that many bytes of UTF-8 JSON.
//
// Two asymmetric limits matter and they are not the same number. Chrome caps a
// host -> extension message at 1 MB and rejects the host if it overruns, while
// extension -> host messages may be far larger. Artifacts therefore flow inbound
// in chunks and every outbound frame is checked against the 1 MB ceiling.

export const PROTOCOL_VERSION = 1;

export const MAX_INBOUND_BYTES = 64 * 1024 * 1024;
export const MAX_OUTBOUND_BYTES = 1024 * 1024;
export const MAX_CHUNK_BYTES = 512 * 1024;

export const ARTIFACT_NAMES = ['html', 'desktop', 'tablet', 'mobile'];

export const INBOUND_TYPES = [
  'hello',
  'session.start',
  'journal.append',
  'capture.begin',
  'capture.chunk',
  'capture.commit',
  'session.stop',
  'viewer.open',
];

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export function encodeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_OUTBOUND_BYTES) {
    throw new ProtocolError('outbound-too-large',
      `Outbound message is ${body.length} bytes; Chrome's limit is ${MAX_OUTBOUND_BYTES}.`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// Accumulates arbitrarily fragmented or coalesced stdin chunks and yields whole
// messages. A frame larger than the cap is fatal: the stream can no longer be
// resynchronized, so the caller must tear the session down.
export class FrameReader {
  constructor({ maxBytes = MAX_INBOUND_BYTES } = {}) {
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxBytes) {
        throw new ProtocolError('message-too-large',
          `Inbound frame declares ${length} bytes; limit is ${this.maxBytes}.`);
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch (error) {
        throw new ProtocolError('malformed-json', `Frame is not valid JSON: ${error.message}`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ProtocolError('malformed-json', 'Frame must be a JSON object.');
      }
      messages.push(parsed);
    }
    return messages;
  }
}

// Shape validation only — the host still owns session/epoch semantics.
export function validateInbound(message) {
  const { type } = message;
  if (typeof type !== 'string' || !INBOUND_TYPES.includes(type)) {
    throw new ProtocolError('unknown-type', `Unsupported message type: ${String(type)}`);
  }
  if (type === 'hello') {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      throw new ProtocolError('unsupported-version',
        `Extension speaks protocol ${message.protocolVersion}; host speaks ${PROTOCOL_VERSION}.`);
    }
    return message;
  }
  if (type === 'capture.chunk') {
    if (!ARTIFACT_NAMES.includes(message.artifact)) {
      throw new ProtocolError('unknown-artifact',
        `Artifact must be one of ${ARTIFACT_NAMES.join(', ')}; got ${String(message.artifact)}.`);
    }
    if (!Number.isInteger(message.index) || message.index < 0) {
      throw new ProtocolError('bad-chunk', 'Chunk index must be a non-negative integer.');
    }
    if (typeof message.data !== 'string') {
      throw new ProtocolError('bad-chunk', 'Chunk data must be a base64 string.');
    }
    if (message.data.length > MAX_CHUNK_BYTES * 2) {
      throw new ProtocolError('bad-chunk',
        `Chunk payload exceeds ${MAX_CHUNK_BYTES * 2} base64 characters.`);
    }
  }
  if (type === 'journal.append' && !Array.isArray(message.entries)) {
    throw new ProtocolError('bad-journal', 'journal.append requires an entries array.');
  }
  return message;
}

// stdout carries protocol frames only; anything else desynchronizes Chrome.
export function createWriter(stream) {
  return (value) => new Promise((resolve, reject) => {
    let frame;
    try {
      frame = encodeMessage(value);
    } catch (error) {
      reject(error);
      return;
    }
    stream.write(frame, (error) => (error ? reject(error) : resolve()));
  });
}
