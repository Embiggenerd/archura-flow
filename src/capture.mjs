#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { DEFAULT_BUDGET, DEFAULT_DELAY, DEFAULT_DEPTH, explore } from './explore.mjs';
import { captureScreen, createRun, outputName, VIEWPORTS } from './snapshot.mjs';

export const CAPTURE_COMBO = { ctrlKey: true, shiftKey: true, code: 'KeyS' };
export const DEFAULT_CDP_PORT = 9222;

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  return `Usage: node src/capture.mjs <domain> [options]

Options:
  --explore             automatically explore links and controls
  --budget <number>     global action budget (default: ${DEFAULT_BUDGET})
  --depth <number>      nested click depth (default: ${DEFAULT_DEPTH})
  --delay <ms>          navigation pacing (default: ${DEFAULT_DELAY})
  --viewport-only       do not take full-page screenshots
  --cdp-port <number>   remote debugging port (default: ${DEFAULT_CDP_PORT})
  --headless            run without a visible browser
`;
}

export function parseArgs(argv) {
  const options = {
    explore: false,
    budget: DEFAULT_BUDGET,
    depth: DEFAULT_DEPTH,
    delay: DEFAULT_DELAY,
    viewportOnly: false,
    cdpPort: DEFAULT_CDP_PORT,
    headless: false,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--explore') options.explore = true;
    else if (argument === '--viewport-only') options.viewportOnly = true;
    else if (argument === '--headless') options.headless = true;
    else if (argument === '--budget') options.budget = Number(argv[++index]);
    else if (argument === '--depth') options.depth = Number(argv[++index]);
    else if (argument === '--delay') options.delay = Number(argv[++index]);
    else if (argument === '--cdp-port') options.cdpPort = Number(argv[++index]);
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    else positional.push(argument);
  }
  if (options.help) return options;
  if (positional.length !== 1) throw new Error('Provide exactly one domain.');
  for (const [name, value] of [
    ['budget', options.budget],
    ['depth', options.depth],
    ['delay', options.delay],
    ['cdp-port', options.cdpPort],
  ]) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  }
  const raw = positional[0];
  const local = /^(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/.test(raw);
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `${local ? 'http' : 'https'}://${raw}`;
  options.url = new URL(candidate).href;
  return options;
}

export function injectedListeners(combo) {
  if (window.__archuraFlowInstalled) return;
  window.__archuraFlowInstalled = true;

  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const keyFor = (element) => {
    if (!(element instanceof Element)) return null;
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName)
        : [current];
      parts.unshift(`${tag}[${siblings.indexOf(current)}]`);
      current = current.parentElement;
    }
    const text = clean(element.innerText || element.value || element.getAttribute('aria-label') ||
      element.getAttribute('title') || element.getAttribute('name') || element.type);
    return `${element.tagName.toLowerCase()}|${text}|${parts.join('>')}`;
  };
  const describe = (element, verb) => {
    const name = clean(element?.innerText || element?.value || element?.getAttribute?.('aria-label') ||
      element?.getAttribute?.('name') || element?.tagName?.toLowerCase() || 'element');
    return `${verb} on '${name}'`;
  };
  const send = (entry) => window.__archuraFlow({
    ...entry,
    url: location.href,
    at: new Date().toISOString(),
  }).catch(() => {});

  document.addEventListener('click', (event) => {
    const element = event.target?.closest?.('a,button,input,select,textarea,[role="button"],[onclick],[tabindex],summary,[contenteditable]');
    if (element) send({ kind: 'journal', type: 'click', key: keyFor(element), label: describe(element, 'click') });
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey === combo.ctrlKey && event.shiftKey === combo.shiftKey && event.code === combo.code) {
      event.preventDefault();
      event.stopImmediatePropagation();
      send({ kind: 'capture' });
      return;
    }
    if (event.key === 'Enter') {
      const element = event.target instanceof Element ? event.target : document.activeElement;
      send({ kind: 'journal', type: 'enter', key: keyFor(element), label: describe(element, 'enter') });
    }
  }, true);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  const profileDir = path.join(ROOT_DIR, 'profiles', outputName(options.url));
  await mkdir(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: options.headless,
    viewport: VIEWPORTS.desktop,
    args: [`--remote-debugging-port=${options.cdpPort}`],
  });
  const run = await createRun({
    rootDir: ROOT_DIR,
    startUrl: options.url,
    viewportOnly: options.viewportOnly,
  });
  const journals = new Map();
  let captureQueue = Promise.resolve();

  await context.exposeBinding('__archuraFlow', async ({ page }, payload) => {
    if (payload.kind === 'journal') {
      const entries = journals.get(page) || [];
      entries.push({
        type: payload.type,
        key: payload.key,
        label: payload.label,
        url: payload.url,
        at: payload.at,
      });
      journals.set(page, entries);
      return;
    }
    captureQueue = captureQueue.then(async () => {
      const edge = journals.get(page) || [];
      journals.set(page, []);
      const result = await captureScreen({
        page,
        context,
        run,
        rootDir: ROOT_DIR,
        source: 'combo',
        state: { root: page.url(), path: [] },
        edge,
      });
      console.log(`✓ screen ${result.screen.id.slice(1)}: ${new URL(result.screen.url).pathname} "${result.screen.title}"`);
    }).catch((error) => console.error(`Capture failed: ${error.message}`));
    await captureQueue;
  });
  await context.addInitScript(injectedListeners, CAPTURE_COMBO);

  const preparePage = (page) => {
    journals.set(page, []);
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const entries = journals.get(page) || [];
      entries.push({
        type: 'nav',
        key: null,
        label: `navigate to '${frame.url()}'`,
        url: frame.url(),
        at: new Date().toISOString(),
      });
      journals.set(page, entries);
    });
  };
  context.pages().forEach(preparePage);
  context.on('page', preparePage);

  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(options.url, { waitUntil: 'domcontentloaded' });
    journals.set(page, []);
    console.log(`Browser ready at ${page.url()}`);
    console.log(`Capture: Ctrl+Shift+S · CDP: http://127.0.0.1:${options.cdpPort}`);

    if (options.explore) {
      const result = await explore({
        page,
        context,
        run,
        rootDir: ROOT_DIR,
        startUrl: options.url,
        budget: options.budget,
        maxDepth: options.depth,
        pace: options.delay,
      });
      console.log(`Exploration complete: ${result.used}/${result.limit} actions used.`);
      await context.close();
      return;
    }

    const stop = () => context.close().catch(() => {});
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await new Promise((resolve) => context.once('close', resolve));
  } finally {
    if (context.pages().length) await context.close().catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
