import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { NativeHost } from '../src/native-host.mjs';
import { startLiveViewer } from '../src/live-viewer.mjs';
import { writeCorpus } from '../src/snapshot.mjs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function capture(host, epoch, requestId, { skeleton, title }) {
  await host.handle({
    type: 'capture.begin', epoch, requestId, url: 'https://app.example.com/plans', title,
  });
  await host.handle({
    type: 'capture.chunk', epoch, requestId, artifact: 'html', index: 0,
    data: Buffer.from(`<!doctype html><title>${title}</title>`, 'utf8').toString('base64'),
  });
  for (const artifact of ['desktop', 'tablet', 'mobile']) {
    await host.handle({
      type: 'capture.chunk', epoch, requestId, artifact, index: 0, data: PNG.toString('base64'),
    });
  }
  await host.handle({ type: 'capture.commit', epoch, requestId, skeleton, elements: [] });
}

// The plan's Phase 5 verify: nodes appear in the open viewer as captures land,
// and the same template still renders the static bundle from disk afterwards.
test('the viewer follows a live session and still opens from file:// after', { timeout: 120_000 }, async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'archura-flow-live-'));
  await mkdir(path.join(rootDir, 'viewer'));
  await copyFile(new URL('../viewer/index.html', import.meta.url), path.join(rootDir, 'viewer', 'index.html'));

  const host = new NativeHost({ rootDir, send: async () => {} });
  await host.handle({ type: 'session.start', url: 'https://app.example.com/plans' });
  const { epoch } = host.session;

  await capture(host, epoch, 'r1', { skeleton: 'html(body(h1))', title: 'Plans' });
  const viewer = await startLiveViewer({ run: host.session.run, rootDir });
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.goto(viewer.url);
    await page.waitForSelector('.screen-card');
    assert.equal(await page.locator('.screen-card').count(), 1);

    await capture(host, epoch, 'r2', { skeleton: 'html(body(h1)(dialog))', title: 'Add plan' });
    // No reload: the open page must pick this up on its own.
    await page.waitForFunction(() => document.querySelectorAll('.screen-card').length === 2, null,
      { timeout: 15_000 });

    await page.getByRole('button', { name: 'Graph' }).click();
    assert.equal(await page.locator('#graph svg').count(), 1);
    assert.ok(await page.locator('#graph .edge-line').count() >= 1);

    await page.getByRole('button', { name: 'Journeys' }).click();
    const note = page.getByLabel('Notes for s1');
    await note.fill('checked while live');
    await page.reload();
    await page.waitForSelector('.screen-card');
    assert.equal(await page.getByLabel('Notes for s1').inputValue(), 'checked while live');

    // Same template, no server: the static bundle on disk must render alone.
    await viewer.close();
    host.session.run.notes.s1 = 'from notes.json';
    await writeCorpus(host.session.run, rootDir);

    const offline = await browser.newPage();
    await offline.goto(new URL(`file://${path.join(host.session.run.dir, 'index.html')}`).href);
    await offline.waitForSelector('.screen-card');
    assert.equal(await offline.locator('.screen-card').count(), 2);
    // notes.json travels with the corpus and shows up in the static viewer.
    assert.equal(await offline.getByLabel('Notes for s1').inputValue(), 'from notes.json');
    // A note typed into the live viewer does not: localStorage is per-origin,
    // and http://127.0.0.1:<port> is a different origin from file://. Live notes
    // have to be exported with the viewer's Export button to survive the move.
    assert.notEqual(await offline.getByLabel('Notes for s1').inputValue(), 'checked while live');
  } finally {
    await browser.close();
    await viewer.close().catch(() => {});
  }
});
