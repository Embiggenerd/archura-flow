import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { CAPTURE_COMBO, injectedListeners } from '../src/capture.mjs';
import { explore } from '../src/explore.mjs';
import { captureScreen, createRun, VIEWPORTS } from '../src/snapshot.mjs';

const fixture = `<!doctype html>
<html>
<head>
  <title>Plans — Fixture</title>
  <style>
    body { margin: 0; font: 16px sans-serif; background: #eef2f7; color: #142033; }
    nav { display: flex; gap: 18px; padding: 20px; background: #142033; }
    nav a { color: white; }
    main { max-width: 900px; margin: 40px auto; padding: 24px; background: white; }
    dialog { border: 0; border-radius: 12px; box-shadow: 0 20px 60px #0005; }
    @media (max-width: 600px) { nav { flex-direction: column; } main { margin: 0; } }
  </style>
</head>
<body>
  <nav>
    <a href="/">Plans</a>
    <a href="/records/1?z=2&a=1">Record 1</a>
    <a href="/records/2?a=1&z=2">Record 2</a>
    <a href="/leave">Leave via redirect</a>
    <a href="https://outside.test/direct">External</a>
    <a href="/logout">Log out</a>
  </nav>
  <main>
    <h1>Plans</h1>
    <button id="add">Add plan</button>
    <label><input id="enabled" type="checkbox"> Enabled</label>
    <ul id="plans"></ul>
    <section>
      <h3>Remove old records</h3>
      <button id="prune">Remove</button>
    </section>
  </main>
  <dialog id="dialog">
    <form method="dialog">
      <h2>Add plan</h2>
      <label>Name <input id="name" name="name" required></label>
      <button id="save" type="submit">Save</button>
    </form>
  </dialog>
  <script>
    add.onclick = () => dialog.showModal();
    save.onclick = (event) => {
      event.preventDefault();
      const item = document.createElement('li');
      item.textContent = name.value || 'empty';
      plans.append(item);
      dialog.close();
    };
  </script>
</body>
</html>`;

async function makeRoot(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(path.join(root, 'viewer'));
  await copyFile(new URL('../viewer/index.html', import.meta.url), path.join(root, 'viewer', 'index.html'));
  return root;
}

async function waitFor(predicate, timeout = 15_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for capture');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('manual capture, explorer, snapshots, and viewer work end to end', { timeout: 120_000 }, async () => {
  const server = createServer((request, response) => {
    if (request.url === '/leave') {
      response.writeHead(302, { location: 'http://outside.test/redirected' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(fixture.replace('<h1>Plans</h1>', `<h1>Record ${request.url}</h1>`));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const startUrl = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch({ headless: true });

  try {
    const manualRoot = await makeRoot('archura-flow-manual-');
    const context = await browser.newContext({ viewport: VIEWPORTS.desktop, acceptDownloads: true });
    const run = await createRun({ rootDir: manualRoot, startUrl, viewportOnly: true });
    let queue = Promise.resolve();
    let journal = [];
    await context.exposeBinding('__archuraFlow', async ({ page }, payload) => {
      if (payload.kind === 'journal') {
        journal.push({
          type: payload.type,
          key: payload.key,
          label: payload.label,
          url: payload.url,
          at: payload.at,
        });
        return;
      }
      queue = queue.then(() => captureScreen({
        page,
        context,
        run,
        rootDir: manualRoot,
        source: 'combo',
        state: { root: page.url(), path: [] },
        edge: journal.splice(0),
      }));
      await queue;
    });
    await context.addInitScript(injectedListeners, CAPTURE_COMBO);
    const page = await context.newPage();
    await page.goto(startUrl);
    await page.keyboard.press('Control+Shift+S');
    await waitFor(() => run.screens.screens.length === 1);
    await page.keyboard.press('Control+Shift+S');
    await waitFor(() => run.screens.screens.length === 2);
    await page.click('#add');
    await page.fill('#name', 'retained value');
    await page.keyboard.press('Control+Shift+S');
    await waitFor(() => run.screens.screens.length === 3);

    assert.equal(run.screens.screens[1].sameAs, 's1');
    assert.notEqual(run.screens.screens[2].signature, run.screens.screens[0].signature);
    assert.match(run.journey.steps[2].edge[0].label, /click on 'Add plan'/);
    assert.equal(
      run.ledger.elements.find((entry) => entry.screen === 's2' && entry.text === 'Add plan').bucket,
      'visited',
    );
    const modalHtml = await readFile(path.join(run.dir, run.screens.screens[2].html), 'utf8');
    assert.match(modalHtml, /value="retained value"/);
    assert.match(modalHtml, /data-archura-flow="bundled"/);
    assert.doesNotMatch(modalHtml, /<script/i);
    for (const shot of Object.values(run.screens.screens[2].shots)) {
      assert.ok((await stat(path.join(run.dir, shot))).size > 1000);
    }
    for (const [viewport, dimensions] of Object.entries(VIEWPORTS)) {
      const imagePage = await context.newPage();
      await imagePage.goto(pathToFileURL(path.join(run.dir, run.screens.screens[2].shots[viewport])).href);
      assert.equal(await imagePage.locator('img').evaluate((image) => image.naturalWidth), dimensions.width);
      await imagePage.close();
    }

    const viewer = await context.newPage();
    await viewer.goto(pathToFileURL(path.join(run.dir, 'index.html')).href);
    assert.equal(await viewer.locator('.screen-card').count(), 3);
    const note = viewer.getByLabel('Notes for s1');
    await note.fill('important state');
    await viewer.reload();
    assert.equal(await viewer.getByLabel('Notes for s1').inputValue(), 'important state');
    await viewer.getByRole('button', { name: 'Graph' }).click();
    assert.equal(await viewer.locator('#graph svg').count(), 1);
    assert.ok(await viewer.locator('#graph .edge-line').count() >= 1);
    const downloadPromise = viewer.waitForEvent('download');
    await viewer.getByRole('button', { name: 'Export notes.json' }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'notes.json');
    assert.match(await readFile(await download.path(), 'utf8'), /important state/);
    await context.close();

    const exploreRoot = await makeRoot('archura-flow-explore-');
    const exploreContext = await browser.newContext({ viewport: VIEWPORTS.desktop });
    await exploreContext.route('http://outside.test/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Outside</title>' }));
    const explorePage = await exploreContext.newPage();
    await explorePage.goto(startUrl);
    const exploreRun = await createRun({
      rootDir: exploreRoot,
      startUrl,
      viewportOnly: true,
    });
    const result = await explore({
      page: explorePage,
      context: exploreContext,
      run: exploreRun,
      rootDir: exploreRoot,
      startUrl,
      budget: 80,
      maxDepth: 2,
      pace: 0,
    });
    assert.ok(result.used <= result.limit);
    assert.equal(
      new Set(exploreRun.screens.screens.map((screen) => screen.signature)).size,
      exploreRun.screens.screens.length,
    );
    assert.ok(exploreRun.screens.screens.some((screen) => screen.state.path.length === 1));
    assert.ok(exploreRun.screens.screens.some((screen) => screen.state.path.length === 2));
    assert.ok(exploreRun.ledger.elements.some((entry) => entry.reason === 'destructive-floor'));
    assert.ok(exploreRun.ledger.elements.some((entry) => entry.reason === 'external'));
    assert.equal(
      exploreRun.ledger.elements.find((entry) => entry.screen === 's1' && entry.text === 'Remove').reason,
      'needs-manual',
    );
    assert.ok(exploreRun.ledger.elements.every((entry) => entry.reason !== 'pending'));
    assert.ok(exploreRun.ledger.elements.every((entry) =>
      ['visited', 'duplicate', 'skipped'].includes(entry.bucket)));
    assert.ok(exploreRun.journey.steps.length >= 2);
    const screenCount = exploreRun.screens.screens.length;
    await explorePage.goto(startUrl);
    await explore({
      page: explorePage,
      context: exploreContext,
      run: exploreRun,
      rootDir: exploreRoot,
      startUrl,
      budget: 10,
      maxDepth: 2,
      pace: 0,
    });
    assert.equal(exploreRun.screens.screens.length, screenCount);
    await exploreContext.close();

    const cdpRoot = await makeRoot('archura-flow-cdp-');
    const profile = await mkdtemp(path.join(os.tmpdir(), 'archura-flow-profile-'));
    const cdpPort = await freePort();
    const persistent = await chromium.launchPersistentContext(profile, {
      headless: true,
      viewport: VIEWPORTS.desktop,
      args: [`--remote-debugging-port=${cdpPort}`],
    });
    try {
      const cdpRun = await createRun({ rootDir: cdpRoot, startUrl, viewportOnly: true });
      let cdpQueue = Promise.resolve();
      await persistent.exposeBinding('__archuraFlow', async ({ page }, payload) => {
        if (payload.kind !== 'capture') return;
        cdpQueue = cdpQueue.then(() => captureScreen({
          page,
          context: persistent,
          run: cdpRun,
          rootDir: cdpRoot,
          source: 'combo',
          state: { root: page.url(), path: [] },
        }));
        await cdpQueue;
      });
      await persistent.addInitScript(injectedListeners, CAPTURE_COMBO);
      const localPage = persistent.pages()[0] || await persistent.newPage();
      await localPage.goto(startUrl);
      const attached = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      const agentPage = attached.contexts()[0].pages()[0];
      await agentPage.keyboard.press('Control+Shift+S');
      await waitFor(() => cdpRun.screens.screens.length === 1);
      const captured = cdpRun.screens.screens[0];
      assert.ok((await stat(path.join(cdpRun.dir, captured.html))).size > 1000);
      for (const shot of Object.values(captured.shots)) {
        assert.ok((await stat(path.join(cdpRun.dir, shot))).size > 1000);
      }
    } finally {
      await persistent.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
