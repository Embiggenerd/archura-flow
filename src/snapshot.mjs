import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { screenSignature } from './identity.mjs';
import { harvestElements, ledgerEntry, setLedgerBucket } from './ledger.mjs';

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};
export const MAX_SCREENSHOT_HEIGHT = 12_000;

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

function rebaseCss(css, stylesheetUrl, pageUrl) {
  const base = stylesheetUrl || pageUrl;
  const absolute = (raw) => {
    const value = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!value || /^(?:data:|blob:|#)/i.test(value)) return raw;
    try {
      return `"${new URL(value, base).href}"`;
    } catch {
      return raw;
    }
  };
  return css
    .replace(/url\(([^)]+)\)/gi, (_, value) => `url(${absolute(value)})`)
    .replace(/@import\s+(?:url\()?(['"]?)([^'")\s;]+)\1\)?/gi,
      (_, _quote, value) => `@import url(${absolute(value)})`);
}

async function collectCss(page, context) {
  const sheets = await page.evaluate(() => [...document.styleSheets].map((sheet) => {
    try {
      return { href: sheet.href, css: [...sheet.cssRules].map((rule) => rule.cssText).join('\n') };
    } catch {
      return { href: sheet.href, css: null };
    }
  }));

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
  return page.evaluate(({ bundledCss, currentUrl }) => {
    const root = document.documentElement.cloneNode(true);
    const originals = [document.documentElement, ...document.documentElement.querySelectorAll('*')];
    const clones = [root, ...root.querySelectorAll('*')];
    const rebaseInlineCss = (value) => value.replace(/url\(([^)]+)\)/gi, (_, raw) => {
      const unquoted = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
      if (!unquoted || /^(?:data:|blob:|#)/i.test(unquoted)) return `url(${raw})`;
      try {
        return `url("${new URL(unquoted, currentUrl).href}")`;
      } catch {
        return `url(${raw})`;
      }
    });

    for (let index = 0; index < originals.length; index += 1) {
      const original = originals[index];
      const clone = clones[index];
      if (!clone) continue;
      if ('value' in original) clone.setAttribute('value', original.value);
      if (original instanceof HTMLTextAreaElement) clone.textContent = original.value;
      if ('checked' in original) clone.toggleAttribute('checked', original.checked);
      if ('selected' in original) clone.toggleAttribute('selected', original.selected);
      if ('open' in original) clone.toggleAttribute('open', original.open);
      for (const attribute of ['src', 'href', 'action', 'poster']) {
        const value = clone.getAttribute(attribute);
        if (!value || /^(?:data:|blob:|#|javascript:|mailto:|tel:)/i.test(value)) continue;
        try {
          clone.setAttribute(attribute, new URL(value, currentUrl).href);
        } catch {
          // Keep malformed app-authored values unchanged.
        }
      }
      const srcset = clone.getAttribute('srcset');
      if (srcset) {
        clone.setAttribute('srcset', srcset.split(',').map((candidate) => {
          const [value, descriptor] = candidate.trim().split(/\s+/, 2);
          try {
            return `${new URL(value, currentUrl).href}${descriptor ? ` ${descriptor}` : ''}`;
          } catch {
            return candidate;
          }
        }).join(', '));
      }
      const inlineStyle = clone.getAttribute('style');
      if (inlineStyle) clone.setAttribute('style', rebaseInlineCss(inlineStyle));
    }

    root.querySelectorAll('script,link[rel~="stylesheet"],meta[http-equiv="Content-Security-Policy" i]')
      .forEach((element) => element.remove());
    const style = document.createElement('style');
    style.setAttribute('data-archura-flow', 'bundled');
    style.textContent = bundledCss;
    root.querySelector('head')?.append(style);
    return `<!doctype html>\n${root.outerHTML}`;
  }, { bundledCss: css, currentUrl: page.url() });
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

export async function writeCorpus(run, rootDir) {
  await Promise.all([
    writeFile(path.join(run.dir, 'screens.json'), json(run.screens)),
    writeFile(path.join(run.dir, 'ledger.json'), json(run.ledger)),
    writeFile(path.join(run.dir, 'notes.json'), json(run.notes)),
    writeFile(run.journeyPath, json(run.journey)),
  ]);
  const journeys = [];
  const journeyDir = path.join(run.dir, 'journeys');
  const { readdir } = await import('node:fs/promises');
  for (const file of (await readdir(journeyDir)).filter((name) => name.endsWith('.json')).sort()) {
    journeys.push({
      id: file.replace(/\.json$/, ''),
      ...JSON.parse(await readFile(path.join(journeyDir, file), 'utf8')),
    });
  }
  const data = {
    domain: run.name,
    screens: run.screens.screens,
    journeys,
    ledger: run.ledger.elements,
    notes: run.notes,
  };
  await Promise.all([
    writeFile(path.join(run.dir, 'data.js'), `window.DATA = ${JSON.stringify(data)};\n`),
    readFile(path.join(rootDir, 'viewer', 'index.html')).then((viewer) =>
      writeFile(path.join(run.dir, 'index.html'), viewer)),
  ]);
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
  const signature = await screenSignature(page);
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

  const screen = {
    id,
    signature,
    url: page.url(),
    title: await page.title(),
    source,
    ...(source === 'combo' && known ? { sameAs: known.id } : {}),
    state: {
      root: state?.root || page.url(),
      path: state?.path || [],
    },
    shots,
    html: htmlPath,
    capturedAt: new Date().toISOString(),
  };
  run.screens.screens.push(screen);

  const elements = await harvestElements(page);
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
}
