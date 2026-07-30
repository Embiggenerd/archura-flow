import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_SCREENSHOT_HEIGHT,
  readStyleSheets,
  rebaseCss,
  serializeDocument,
  VIEWPORTS,
} from '../extension/browser-scripts.js';
import { screenSignature } from './identity.mjs';
import { harvestElements, ledgerEntry, setLedgerBucket } from './ledger.mjs';

export { MAX_SCREENSHOT_HEIGHT, rebaseCss, VIEWPORTS };

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function outputName(url) {
  return new URL(url).host.replace(/[^a-z0-9.-]+/gi, '_').replace(/:/g, '_');
}

export async function createRun({ rootDir, startUrl, viewportOnly = false }) {
  const name = outputName(startUrl);
  const dir = path.join(rootDir, 'out', name);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const journeyPath = path.join(dir, 'journeys', `${timestamp}.json`);
  await Promise.all([
    mkdir(path.join(dir, 'html'), { recursive: true }),
    mkdir(path.join(dir, 'shots'), { recursive: true }),
    mkdir(path.join(dir, 'journeys'), { recursive: true }),
  ]);

  const readJson = async (file, fallback) => {
    try {
      return JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  };

  return {
    dir,
    name,
    viewportOnly,
    screens: await readJson('screens.json', { screens: [] }),
    ledger: await readJson('ledger.json', { elements: [] }),
    notes: await readJson('notes.json', {}),
    journey: { steps: [] },
    journeyPath,
  };
}


async function collectCss(page, context) {
  const sheets = await page.evaluate(readStyleSheets, null);

  const chunks = [];
  for (const sheet of sheets) {
    let css = sheet.css;
    if (css === null && sheet.href) {
      try {
        const response = await context.request.get(sheet.href);
        if (response.ok()) css = await response.text();
      } catch {
        css = null;
      }
    }
    if (css !== null) chunks.push(rebaseCss(css, sheet.href, page.url()));
  }
  return chunks.join('\n');
}

async function serializePage(page, context) {
  const css = await collectCss(page, context);
  return page.evaluate(serializeDocument, { bundledCss: css, currentUrl: page.url() });
}

async function screenshot(page, file, viewportOnly) {
  if (viewportOnly) {
    await page.screenshot({ path: file, animations: 'disabled' });
    return;
  }
  const height = await page.evaluate(() => Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight || 0,
  ));
  if (height <= MAX_SCREENSHOT_HEIGHT) {
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
    return;
  }
  const viewport = page.viewportSize();
  await page.screenshot({
    path: file,
    clip: { x: 0, y: 0, width: viewport.width, height: MAX_SCREENSHOT_HEIGHT },
    animations: 'disabled',
  });
}

// The one corpus shape, shared by the static bundle and the live viewer's
// /api/data so the two can never disagree about what was captured.
export async function buildCorpusData(run) {
  const journeys = [];
  const journeyDir = path.join(run.dir, 'journeys');
  const { readdir } = await import('node:fs/promises');
  for (const file of (await readdir(journeyDir)).filter((name) => name.endsWith('.json')).sort()) {
    journeys.push({
      id: file.replace(/\.json$/, ''),
      ...JSON.parse(await readFile(path.join(journeyDir, file), 'utf8')),
    });
  }
  return {
    domain: run.name,
    screens: run.screens.screens,
    journeys,
    ledger: run.ledger.elements,
    notes: run.notes,
  };
}

export async function writeCorpus(run, rootDir) {
  await Promise.all([
    writeFile(path.join(run.dir, 'screens.json'), json(run.screens)),
    writeFile(path.join(run.dir, 'ledger.json'), json(run.ledger)),
    writeFile(path.join(run.dir, 'notes.json'), json(run.notes)),
    writeFile(run.journeyPath, json(run.journey)),
  ]);
  const data = await buildCorpusData(run);
  await Promise.all([
    writeFile(path.join(run.dir, 'data.js'), `window.DATA = ${JSON.stringify(data)};\n`),
    readFile(path.join(rootDir, 'viewer', 'index.html')).then((viewer) =>
      writeFile(path.join(run.dir, 'index.html'), viewer)),
  ]);
}

// The single writer of screen, journey, and ledger records. Both transports go
// through here: `writeArtifacts` puts the HTML and PNGs in place (Playwright
// renders them; the extension moves already-streamed temp files), and
// `collectElements` supplies the harvest.
export async function recordScreen({
  run,
  rootDir,
  signature,
  url,
  title,
  source,
  state,
  edge = [],
  metadata,
  writeArtifacts,
  collectElements,
}) {
  const known = run.screens.screens.find((screen) => screen.signature === signature);

  if (source === 'explorer' && known) {
    known.seenCount = (known.seenCount || 1) + 1;
    run.journey.steps.push({ screen: known.id, edge });
    await writeCorpus(run, rootDir);
    return { screen: known, created: false, elements: [] };
  }

  const id = `s${run.screens.screens.length + 1}`;
  const htmlPath = `html/${id}.html`;
  const shots = Object.fromEntries(Object.keys(VIEWPORTS).map((name) =>
    [name, `shots/${id}-${name}.png`]));
  const screenLength = run.screens.screens.length;
  const ledgerBefore = structuredClone(run.ledger);
  const journeyLength = run.journey.steps.length;

  try {
    const written = await writeArtifacts({ id, htmlPath, shots });
    const screen = {
      id,
      signature,
      url,
      title,
      source,
      ...(source === 'combo' && known ? { sameAs: known.id } : {}),
      state: {
        root: state?.root || url,
        path: state?.path || [],
      },
      shots: written?.shots || shots,
      html: htmlPath,
      capturedAt: new Date().toISOString(),
      ...(metadata || {}),
    };
    run.screens.screens.push(screen);

    const elements = await collectElements();
    run.ledger.elements.push(...elements.map((element) => ledgerEntry(element, id)));

    const previous = run.journey.steps.at(-1);
    for (const action of edge) {
      if (previous && action.key) {
        setLedgerBucket(run.ledger, previous.screen, action.key, 'visited');
      }
    }
    run.journey.steps.push({ screen: id, edge });
    await writeCorpus(run, rootDir);
    return { screen, created: true, elements };
  } catch (error) {
    run.screens.screens.length = screenLength;
    run.ledger.elements = ledgerBefore.elements;
    run.journey.steps.length = journeyLength;
    await Promise.all([
      rm(path.join(run.dir, htmlPath), { force: true }),
      ...Object.values(shots).map((shot) => rm(path.join(run.dir, shot), { force: true })),
    ]);
    await writeCorpus(run, rootDir).catch(() => {});
    throw error;
  }
}

export async function captureScreen({
  page,
  context,
  run,
  rootDir,
  source,
  state,
  edge = [],
}) {
  return recordScreen({
    run,
    rootDir,
    signature: await screenSignature(page),
    url: page.url(),
    title: await page.title(),
    source,
    state,
    edge,
    writeArtifacts: async ({ htmlPath, shots }) => {
      const html = await serializePage(page, context);
      await writeFile(path.join(run.dir, htmlPath), html);
      try {
        for (const [name, viewport] of Object.entries(VIEWPORTS)) {
          if (name !== 'desktop') await page.setViewportSize(viewport);
          await screenshot(page, path.join(run.dir, shots[name]), run.viewportOnly);
        }
      } finally {
        await page.setViewportSize(VIEWPORTS.desktop);
      }
    },
    collectElements: () => harvestElements(page),
  });
}
