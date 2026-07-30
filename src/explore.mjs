import { harvestElements, setLedgerBucket } from './ledger.mjs';
import { captureScreen, writeCorpus } from './snapshot.mjs';

export const DEFAULT_BUDGET = 1000;
export const DEFAULT_DEPTH = 3;
export const DEFAULT_DELAY = 1000;
export const SETTLE_QUIET_MS = 500;
export const SETTLE_TIMEOUT_MS = 5000;
export const FALLBACK_SETTLE_MS = 1500;

const FLOOR_PATTERNS = [
  /\blog\s*out\b/i,
  /\bsign\s*out\b/i,
  /\bdelete\b.{0,40}\b(account|workspace|organization|organisation|team)\b/i,
  /\b(account|workspace|organization|organisation|team)\b.{0,40}\bdelete\b/i,
  /\bcancel\b.{0,30}\b(subscription|plan|membership)\b/i,
  /\b(payment|checkout|pay now|purchase|place order|card number|cvc|cvv)\b/i,
];
const AMBIGUOUS_PATTERNS = [
  /^\s*(confirm|continue|yes|proceed)\s*$/i,
  /\b(remove|destroy|erase|terminate)\b/i,
];

export function inScope(candidate, baseUrl) {
  try {
    const url = new URL(candidate, baseUrl);
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return url.hostname === base.hostname || url.hostname.endsWith(`.${base.hostname}`);
  } catch {
    return false;
  }
}

export function classifyElement(element, baseUrl) {
  if (element.href && !inScope(element.href, baseUrl)) return 'external';
  if (element.tag === 'input' && element.type === 'file') return 'file-upload';
  const evidence = `${element.text} ${element.name} ${element.context} ${element.href || ''}`;
  const paymentForm = element.formTypes.some((type) =>
    ['cc-number', 'cc-csc'].includes(type)) ||
    /\b(card.?number|cvc|cvv)\b/i.test(element.context);
  if (paymentForm || FLOOR_PATTERNS.some((pattern) => pattern.test(evidence))) {
    return 'destructive-floor';
  }
  if (AMBIGUOUS_PATTERNS.some((pattern) => pattern.test(element.text)) &&
      /\b(delete|cancel|payment|subscription|account|workspace|remove|terminate)\b/i.test(element.context)) {
    return 'needs-manual';
  }
  return null;
}

class ActionBudget {
  constructor(limit, initial = 0) {
    this.limit = limit;
    this.used = Math.min(initial, limit);
  }

  take() {
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }

  get exhausted() {
    return this.used >= this.limit;
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function loadLazyContent(page) {
  await page.evaluate(async () => {
    const step = Math.max(window.innerHeight, 600);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    window.scrollTo(0, 0);
  });
}

async function settle(page) {
  try {
    await Promise.race([
      Promise.all([
        page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {}),
        page.evaluate(({ quiet, timeout }) => new Promise((resolve) => {
          let quietTimer;
          const finish = () => {
            observer.disconnect();
            clearTimeout(quietTimer);
            resolve();
          };
          const reset = () => {
            clearTimeout(quietTimer);
            quietTimer = setTimeout(finish, quiet);
          };
          const observer = new MutationObserver(reset);
          observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
          reset();
          setTimeout(finish, timeout);
        }), { quiet: SETTLE_QUIET_MS, timeout: SETTLE_TIMEOUT_MS }),
      ]),
      delay(SETTLE_TIMEOUT_MS),
    ]);
  } catch {
    await delay(FALLBACK_SETTLE_MS);
  }
}

async function currentElement(page, step) {
  const elements = await harvestElements(page);
  const exact = elements.find((element) => element.key === step.key);
  if (exact) return exact;
  const fallback = elements.find((element) =>
    step.role && step.name && element.role === step.role && element.name === step.name);
  return fallback || null;
}

function dummyValue(element) {
  const type = (element.type || '').toLowerCase();
  if (type === 'email') return 'audit@example.com';
  if (type === 'number' || type === 'range') return '1';
  if (type === 'date') return new Date().toISOString().slice(0, 10);
  if (type === 'url') return 'https://example.com';
  if (type === 'tel') return '5550100';
  if (type === 'password') return 'Audit-test-1';
  return 'test';
}

async function fillForm(page, element) {
  if (!/^(button|input)$/.test(element.tag) ||
      !(/^(submit|image)$/.test(element.type || '') ||
        /\b(save|submit|add|create|update|send)\b/i.test(element.text))) return;
  const locator = page.locator(element.selector);
  const form = locator.locator('xpath=ancestor::form[1]');
  const scope = await form.count() ? form : page.locator('body');
  const fields = scope.locator('input:not([type=file]):not([type=hidden]):not([type=submit]):not([type=button]), textarea, select');
  for (let index = 0; index < await fields.count(); index += 1) {
    const field = fields.nth(index);
    if (!await field.isVisible() || await field.isDisabled()) continue;
    const tag = await field.evaluate((node) => node.tagName.toLowerCase());
    const type = (await field.getAttribute('type') || '').toLowerCase();
    if (tag === 'select') {
      const options = await field.locator('option').count();
      if (options) await field.selectOption({ index: Math.min(1, options - 1) });
    } else if (['checkbox', 'radio'].includes(type)) {
      await field.check();
    } else {
      await field.fill(dummyValue({ type }));
    }
  }
}

async function interact(page, element) {
  const locator = page.locator(element.selector);
  await fillForm(page, element);
  const type = (element.type || '').toLowerCase();
  if (element.tag === 'select') {
    const count = await locator.locator('option').count();
    if (count) await locator.selectOption({ index: Math.min(1, count - 1) });
  } else if (element.tag === 'textarea' || element.tag === 'input' &&
    !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image'].includes(type)) {
    await locator.fill(dummyValue(element));
  } else if (element.tag === 'input' && ['checkbox', 'radio'].includes(type)) {
    await locator.check();
  } else if (await locator.getAttribute('contenteditable') !== null) {
    await locator.fill('test');
  } else {
    await locator.click({ timeout: SETTLE_TIMEOUT_MS });
  }
  await settle(page);
}

function pathStep(element) {
  return {
    key: element.key,
    label: `click on '${element.text || element.name || element.tag}'`,
    role: element.role,
    name: element.name,
  };
}

async function recover(page, state, budget, pace) {
  if (!budget.take()) return { ok: false, reason: 'budget-exhausted' };
  try {
    await page.goto(state.root, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await delay(pace);
    for (const step of state.path) {
      if (!budget.take()) return { ok: false, reason: 'budget-exhausted' };
      const element = await currentElement(page, step);
      if (!element) return { ok: false, reason: 'unreplayable' };
      await interact(page, element);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'unreplayable', error: error.message };
  }
}

function skipPending(ledger, screen, reason) {
  for (const entry of ledger.elements) {
    if (entry.screen === screen && entry.bucket === 'skipped' && entry.reason === 'pending') {
      entry.reason = reason;
    }
  }
}

// Static reasons (external, floor, ambiguous) are final; everything else is
// 'pending' — an explorer-internal sentinel resolved before the run ends, so
// 'needs-manual' always means a deliberate human-judgment bucket.
function classifyHarvest(run, screen, elements, baseUrl) {
  for (const element of elements) {
    const reason = classifyElement(element, baseUrl);
    setLedgerBucket(run.ledger, screen, element.key, 'skipped', reason || 'pending');
  }
}

export async function explore({
  page,
  context,
  run,
  rootDir,
  startUrl,
  budget: budgetLimit = DEFAULT_BUDGET,
  maxDepth = DEFAULT_DEPTH,
  pace = DEFAULT_DELAY,
}) {
  const budget = new ActionBudget(budgetLimit, 1);
  await loadLazyContent(page);
  const initial = await captureScreen({
    page,
    context,
    run,
    rootDir,
    source: 'explorer',
    state: { root: page.url(), path: [] },
  });
  classifyHarvest(run, initial.screen.id, initial.elements, startUrl);

  const queue = initial.created
    ? [{ screen: initial.screen, state: initial.screen.state, depth: 0, elements: initial.elements }]
    : [];

  while (queue.length) {
    const item = queue.shift();
    const elements = item.elements.length ? item.elements : await harvestElements(page);
    let restoreFailures = 0;

    for (const original of elements) {
      const existing = run.ledger.elements.find((entry) =>
        entry.screen === item.screen.id && entry.key === original.key);
      if (!existing || existing.bucket !== 'skipped' || existing.reason !== 'pending') continue;

      if (budget.exhausted) {
        setLedgerBucket(run.ledger, item.screen.id, original.key, 'skipped', 'budget-exhausted');
        continue;
      }
      if (!original.href && item.depth >= maxDepth) {
        setLedgerBucket(run.ledger, item.screen.id, original.key, 'skipped', 'max-depth');
        continue;
      }

      let restored = await recover(page, item.state, budget, pace);
      if (!restored.ok && restored.reason === 'unreplayable') {
        restored = await recover(page, item.state, budget, pace);
      }
      if (!restored.ok) {
        if (restored.error) console.warn(`Replay failed for ${item.screen.id}: ${restored.error}`);
        setLedgerBucket(run.ledger, item.screen.id, original.key, 'skipped', restored.reason);
        if (restored.reason === 'unreplayable' && ++restoreFailures >= 2) {
          skipPending(run.ledger, item.screen.id, 'unreplayable');
          break;
        }
        continue;
      }
      restoreFailures = 0;
      const element = await currentElement(page, original);
      if (!element) {
        setLedgerBucket(run.ledger, item.screen.id, original.key, 'skipped', 'unreplayable');
        continue;
      }
      if (!budget.take()) {
        setLedgerBucket(run.ledger, item.screen.id, original.key, 'skipped', 'budget-exhausted');
        continue;
      }

      const step = pathStep(element);
      try {
        if (element.href) {
          await page.goto(element.href, { waitUntil: 'domcontentloaded', timeout: 15_000 });
          await delay(pace);
          await settle(page);
        } else {
          await interact(page, element);
        }
      } catch {
        await delay(250);
        await page.evaluate(() => window.stop()).catch(() => {});
        if (element.href && !inScope(page.url(), startUrl)) {
          setLedgerBucket(run.ledger, item.screen.id, original.key, 'skipped', 'external');
          continue;
        }
        setLedgerBucket(run.ledger, item.screen.id, original.key, 'skipped', 'needs-manual');
        continue;
      }

      if (!inScope(page.url(), startUrl)) {
        await page.evaluate(() => window.stop()).catch(() => {});
        setLedgerBucket(run.ledger, item.screen.id, original.key, 'skipped', 'external');
        continue;
      }

      const state = element.href
        ? { root: page.url(), path: [] }
        : { root: item.state.root, path: [...item.state.path, step] };
      await loadLazyContent(page);
      const result = await captureScreen({
        page,
        context,
        run,
        rootDir,
        source: 'explorer',
        state,
        edge: [{
          type: 'click',
          key: element.key,
          label: step.label,
          url: item.screen.url,
          at: new Date().toISOString(),
        }],
      });
      setLedgerBucket(
        run.ledger,
        item.screen.id,
        original.key,
        result.created ? 'visited' : 'duplicate',
      );
      if (result.created) {
        classifyHarvest(run, result.screen.id, result.elements, startUrl);
        queue.push({
          screen: result.screen,
          state,
          depth: element.href ? 0 : item.depth + 1,
          elements: result.elements,
        });
      }
      await writeCorpus(run, rootDir);
    }
  }

  for (const entry of run.ledger.elements) {
    if (entry.bucket === 'skipped' && entry.reason === 'pending') {
      entry.reason = budget.exhausted ? 'budget-exhausted' : 'needs-manual';
    }
  }
  await writeCorpus(run, rootDir);
  return { used: budget.used, limit: budget.limit };
}
