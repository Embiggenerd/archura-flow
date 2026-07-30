import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { NativeHost } from '../src/native-host.mjs';
import { TEMP_DIR } from '../src/extension-capture.mjs';
import { startLiveViewer } from '../src/live-viewer.mjs';
import { PROTOCOL_VERSION } from '../src/native-protocol.mjs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const HTML = '<!doctype html>\n<html><head><title>Plans</title></head><body><h1>Plans ✓</h1></body></html>';
const SKELETON = 'html(body(h1))';
const URL_UNDER_TEST = 'https://app.example.com/plans';

function rawStatus(port, requestPath, hostHeader) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path: requestPath, method: 'GET', headers: { Host: hostHeader } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function makeHost() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'archura-flow-ext-'));
  await mkdir(path.join(rootDir, 'viewer'));
  await copyFile(new URL('../viewer/index.html', import.meta.url), path.join(rootDir, 'viewer', 'index.html'));
  const sent = [];
  const host = new NativeHost({ rootDir, send: async (message) => { sent.push(message); } });
  const last = (type) => [...sent].reverse().find((message) => message.type === type);
  return { host, sent, rootDir, last };
}

async function startSession(host) {
  await host.handle({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
  await host.handle({
    type: 'session.start',
    url: URL_UNDER_TEST,
    title: 'Plans',
    tab: { id: 42, windowId: 7 },
  });
  return host.session.epoch;
}

async function sendCapture(host, epoch, requestId, {
  skeleton = SKELETON,
  url = URL_UNDER_TEST,
  title = 'Plans',
  elements = [],
  shots = ['desktop', 'tablet', 'mobile'],
} = {}) {
  await host.handle({
    type: 'capture.begin',
    epoch,
    requestId,
    url,
    title,
    viewports: {
      desktop: { width: 1378, height: 812, source: 'live' },
      tablet: { width: 768, height: 1024 },
      mobile: { width: 390, height: 844 },
    },
    warnings: [],
  });
  // Split the HTML so reassembly across chunks is exercised, not just accepted.
  const html = Buffer.from(HTML, 'utf8');
  const middle = Math.floor(html.length / 2);
  await host.handle({
    type: 'capture.chunk', epoch, requestId, artifact: 'html', index: 0,
    data: html.subarray(0, middle).toString('base64'),
  });
  await host.handle({
    type: 'capture.chunk', epoch, requestId, artifact: 'html', index: 1,
    data: html.subarray(middle).toString('base64'),
  });
  for (const artifact of shots) {
    await host.handle({
      type: 'capture.chunk', epoch, requestId, artifact, index: 0, data: PNG.toString('base64'),
    });
  }
  await host.handle({ type: 'capture.commit', epoch, requestId, skeleton, elements });
}

test('an extension capture becomes a screen node with artifacts and metadata', async () => {
  const { host, last, rootDir } = await makeHost();
  const epoch = await startSession(host);

  await host.handle({
    type: 'journal.append',
    epoch,
    entries: [{
      sequence: 1,
      type: 'click',
      key: 'button|Add plan|body>main>button[0]',
      label: "click on 'Add plan'",
      url: URL_UNDER_TEST,
      at: '2026-07-30T12:00:00.000Z',
    }],
  });
  await sendCapture(host, epoch, 'r1', {
    elements: [{
      key: 'button|Add plan|body>main>button[0]',
      tag: 'button',
      text: 'Add plan',
      role: 'button',
      name: 'Add plan',
      type: null,
      href: null,
    }],
  });

  const done = last('capture.done');
  assert.equal(done.screenId, 's1');
  assert.equal(done.screenCount, 1);

  const dir = host.session.run.dir;
  const screens = JSON.parse(await readFile(path.join(dir, 'screens.json'), 'utf8'));
  const screen = screens.screens[0];
  assert.equal(screen.id, 's1');
  assert.equal(screen.url, URL_UNDER_TEST);
  assert.equal(screen.source, 'combo');
  assert.equal(screen.driver, 'chrome-extension');
  assert.deepEqual(screen.tab, { id: 42, windowId: 7 });
  assert.equal(screen.viewports.desktop.source, 'live');
  assert.deepEqual(screen.snapshotWarnings, []);
  assert.match(screen.signature, /^https:\/\/app\.example\.com\/plans::[0-9a-f]{12}$/);

  assert.equal(await readFile(path.join(dir, screen.html), 'utf8'), HTML);
  for (const shot of Object.values(screen.shots)) {
    assert.equal((await stat(path.join(dir, shot))).size, PNG.length);
  }

  const journeyDir = path.join(dir, 'journeys');
  const journeyFile = (await readdir(journeyDir)).find((name) => name.endsWith('.json'));
  const journey = JSON.parse(await readFile(path.join(journeyDir, journeyFile), 'utf8'));
  assert.equal(journey.steps.length, 1);
  assert.match(journey.steps[0].edge[0].label, /click on 'Add plan'/);

  const ledger = JSON.parse(await readFile(path.join(dir, 'ledger.json'), 'utf8'));
  assert.equal(ledger.elements.length, 1);
  assert.equal(ledger.elements[0].screen, 's1');

  // The static bundle the viewer loads from disk is regenerated on commit.
  assert.match(await readFile(path.join(dir, 'data.js'), 'utf8'), /^window\.DATA = \{/);
  assert.ok((await stat(path.join(dir, 'index.html'))).size > 0);
  assert.equal(rootDir, host.rootDir);
});

test('a repeat manual capture creates a second node carrying sameAs', async () => {
  const { host, last } = await makeHost();
  const epoch = await startSession(host);
  await sendCapture(host, epoch, 'r1');
  await sendCapture(host, epoch, 'r2');

  assert.equal(last('capture.done').screenId, 's2');
  assert.equal(last('capture.done').sameAs, 's1');
  const screens = JSON.parse(await readFile(path.join(host.session.run.dir, 'screens.json'), 'utf8'));
  assert.equal(screens.screens.length, 2);
  assert.equal(screens.screens[1].sameAs, 's1');
});

test('a capture missing its desktop screenshot is refused and leaves no node', async () => {
  const { host, sent } = await makeHost();
  const epoch = await startSession(host);
  await host.handle({ type: 'capture.begin', epoch, requestId: 'r1', url: URL_UNDER_TEST, title: 'Plans' });
  const html = Buffer.from(HTML, 'utf8');
  await host.handle({
    type: 'capture.chunk', epoch, requestId: 'r1', artifact: 'html', index: 0, data: html.toString('base64'),
  });
  await host.handle({ type: 'capture.commit', epoch, requestId: 'r1', skeleton: SKELETON });

  assert.equal(sent.at(-1).type, 'error');
  assert.equal(sent.at(-1).code, 'missing-artifact');
  assert.equal(host.session.capture.screenCount, 0);
  await assert.rejects(stat(path.join(host.session.run.dir, 'html', 's1.html')));
});

test('out-of-order chunks fail loudly instead of corrupting an artifact', async () => {
  const { host, sent } = await makeHost();
  const epoch = await startSession(host);
  await host.handle({ type: 'capture.begin', epoch, requestId: 'r1', url: URL_UNDER_TEST, title: 'Plans' });
  await host.handle({
    type: 'capture.chunk', epoch, requestId: 'r1', artifact: 'html', index: 3, data: 'AAAA',
  });
  assert.equal(sent.at(-1).code, 'bad-chunk');
});

test('an interrupted capture leaves the prior graph untouched and clears its temp files', async () => {
  const { host } = await makeHost();
  const epoch = await startSession(host);
  await sendCapture(host, epoch, 'r1');
  const dir = host.session.run.dir;

  await host.handle({ type: 'capture.begin', epoch, requestId: 'r2', url: URL_UNDER_TEST, title: 'Plans' });
  await host.handle({
    type: 'capture.chunk', epoch, requestId: 'r2', artifact: 'html', index: 0, data: 'AAAA',
  });
  assert.equal((await readdir(path.join(dir, TEMP_DIR))).length, 1);

  await host.handle({ type: 'session.stop', reason: 'tab-closed' });
  await assert.rejects(readdir(path.join(dir, TEMP_DIR)));
  const screens = JSON.parse(await readFile(path.join(dir, 'screens.json'), 'utf8'));
  assert.equal(screens.screens.length, 1);
});

test('live viewer serves the corpus over loopback and refuses everything else', async () => {
  const { host, rootDir } = await makeHost();
  const epoch = await startSession(host);
  await sendCapture(host, epoch, 'r1');

  const viewer = await startLiveViewer({ run: host.session.run, rootDir });
  try {
    const base = viewer.url;
    const data = await fetch(`${base}api/data`).then((response) => response.json());
    assert.equal(data.screens.length, 1);
    assert.equal(data.screens[0].id, 's1');
    assert.equal(data.domain, 'app.example.com');

    const index = await fetch(base);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('access-control-allow-origin'), null);
    assert.match(await index.text(), /archura-flow/);

    const shot = await fetch(`${base}${data.screens[0].shots.desktop}`);
    assert.equal(shot.status, 200);
    assert.equal(Buffer.from(await shot.arrayBuffer()).length, PNG.length);

    assert.equal((await fetch(`${base}../../../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${base}screens.json`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${viewer.port}/wrong-token/api/data`)).status, 404);
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
    // fetch() silently drops a forbidden Host header, so drive this one raw.
    assert.equal(await rawStatus(viewer.port, new URL(base).pathname, 'evil.example.com'), 403);
    assert.equal(await rawStatus(viewer.port, new URL(base).pathname, `127.0.0.1:${viewer.port}`), 200);
  } finally {
    await viewer.close();
  }
});
