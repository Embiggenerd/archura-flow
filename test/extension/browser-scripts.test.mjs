import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as scripts from '../../extension/browser-scripts.js';
import { CdpSession } from '../../extension/cdp.js';

// The CDP transport stringifies these and applies them to one JSON argument.
const PAGE_FUNCTIONS = [
  'injectedListeners',
  'screenSkeleton',
  'harvestInteractive',
  'readStyleSheets',
  'serializeDocument',
  'readPageMetrics',
  'restoreScroll',
];

// Names that exist in the module scope. A page function that closes over any of
// them works under Playwright and fails only once it reaches the extension.
const MODULE_SCOPE = [
  'VIEWPORTS',
  'MAX_SCREENSHOT_HEIGHT',
  'SKELETON_DEPTH',
  'INTERACTIVE_SELECTOR',
  'rebaseCss',
];

test('every shared page function is stringifiable and closure-free', () => {
  for (const name of PAGE_FUNCTIONS) {
    const source = scripts[name].toString();
    assert.equal(typeof scripts[name], 'function', `${name} must be exported`);
    assert.doesNotThrow(() => new Function(`return (${source});`), `${name} must be stringifiable`);
    for (const identifier of MODULE_SCOPE) {
      assert.doesNotMatch(source, new RegExp(`\\b${identifier}\\b`),
        `${name} closes over module-scope ${identifier}; pass it as the argument instead`);
    }
    assert.equal(scripts[name].length <= 1, true, `${name} must take at most one argument`);
  }
});

function evaluateLikeCdp(pageFunction, argument, context) {
  const expression = `(${pageFunction.toString()})(${JSON.stringify(argument ?? null)})`;
  return vm.runInNewContext(expression, context);
}

test('the CDP calling convention round-trips through a stringified function', () => {
  const scrolled = [];
  const context = {
    window: { scrollTo: (x, y) => scrolled.push([x, y]) },
  };
  context.globalThis = context;
  evaluateLikeCdp(scripts.restoreScroll, { x: 40, y: 900 }, context);
  assert.deepEqual(scrolled, [[40, 900]]);
});

test('readPageMetrics reports the live viewport and scroll position', () => {
  const context = {
    location: { href: 'https://app.example.com/plans' },
    document: { title: 'Plans', documentElement: { scrollHeight: 4200 }, body: { scrollHeight: 4100 } },
    window: { scrollX: 0, scrollY: 120, innerWidth: 1378, innerHeight: 812, devicePixelRatio: 2 },
  };
  context.globalThis = context;
  // Spread back into this realm: the vm returns an object with a foreign prototype.
  const metrics = { ...evaluateLikeCdp(scripts.readPageMetrics, null, context) };
  assert.deepEqual(metrics, {
    url: 'https://app.example.com/plans',
    title: 'Plans',
    scrollX: 0,
    scrollY: 120,
    width: 1378,
    height: 812,
    deviceScaleFactor: 2,
    scrollHeight: 4200,
  });
});

// A CDP Runtime binding returns undefined where Playwright's exposeBinding
// returns a promise. The listener must survive both.
test('the journal listener tolerates a binding that returns no promise', () => {
  const handlers = {};
  const received = [];
  class Element {}
  const button = Object.assign(new Element(), {
    tagName: 'BUTTON',
    innerText: 'Add plan',
    parentElement: null,
    getAttribute: () => null,
    closest: () => button,
  });
  const context = {
    Element,
    window: { __archuraFlow: (payload) => { received.push(payload); } },
    document: {
      documentElement: {},
      addEventListener: (type, handler) => { handlers[type] = handler; },
      activeElement: button,
    },
    location: { href: 'https://app.example.com/plans' },
    Date,
  };
  context.globalThis = context;
  context.window.__archuraFlowInstalled = false;

  evaluateLikeCdp(scripts.injectedListeners, null, context);
  assert.doesNotThrow(() => handlers.click({ target: button }));
  assert.equal(received.length, 1);
  assert.equal(received[0].kind, 'journal');
  assert.equal(received[0].type, 'click');
  assert.equal(received[0].label, "click on 'Add plan'");
  assert.equal(received[0].key, 'button|Add plan|button[0]');
  assert.equal(received[0].url, 'https://app.example.com/plans');
});

test('a null combo disables the in-page capture shortcut in extension mode', () => {
  const handlers = {};
  const received = [];
  class Element {}
  const context = {
    Element,
    window: { __archuraFlow: (payload) => { received.push(payload); }, __archuraFlowInstalled: false },
    document: {
      documentElement: {},
      addEventListener: (type, handler) => { handlers[type] = handler; },
      activeElement: null,
    },
    location: { href: 'https://app.example.com/plans' },
    Date,
  };
  context.globalThis = context;

  evaluateLikeCdp(scripts.injectedListeners, null, context);
  let prevented = false;
  handlers.keydown({
    ctrlKey: true,
    shiftKey: true,
    code: 'KeyS',
    key: 's',
    target: null,
    preventDefault: () => { prevented = true; },
    stopImmediatePropagation: () => {},
  });
  assert.equal(prevented, false, 'extension mode must not swallow the page\'s own Ctrl+Shift+S');
  assert.deepEqual(received, []);
});

test('the Playwright combo still fires a capture request when a combo is supplied', () => {
  const handlers = {};
  const received = [];
  class Element {}
  const context = {
    Element,
    window: { __archuraFlow: (payload) => { received.push(payload); return Promise.resolve(); } },
    document: {
      documentElement: {},
      addEventListener: (type, handler) => { handlers[type] = handler; },
      activeElement: null,
    },
    location: { href: 'https://app.example.com/plans' },
    Date,
  };
  context.globalThis = context;

  evaluateLikeCdp(scripts.injectedListeners, { ctrlKey: true, shiftKey: true, code: 'KeyS' }, context);
  handlers.keydown({
    ctrlKey: true,
    shiftKey: true,
    code: 'KeyS',
    key: 's',
    target: null,
    preventDefault: () => {},
    stopImmediatePropagation: () => {},
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].kind, 'capture');
});

test('rebaseCss makes sheet-relative urls absolute against the sheet, not the page', () => {
  const css = rebased('.a{background:url(../img/x.png)}', 'https://cdn.example.com/css/app.css');
  assert.match(css, /https:\/\/cdn\.example\.com\/img\/x\.png/);
  const imported = rebased('@import "theme.css";', 'https://cdn.example.com/css/app.css');
  assert.match(imported, /https:\/\/cdn\.example\.com\/css\/theme\.css/);
  const data = rebased('.a{background:url(data:image/png;base64,AAA)}', 'https://cdn.example.com/css/app.css');
  assert.match(data, /url\(data:image\/png;base64,AAA\)/);
});

test('device emulation pins screenshot scale to one by default', async () => {
  let command;
  globalThis.chrome = {
    debugger: {
      sendCommand: async (_target, method, params) => {
        command = { method, params };
      },
    },
  };
  const cdp = new CdpSession(42);
  await cdp.setDeviceMetrics({ width: 768, height: 1024 });
  assert.equal(command.method, 'Emulation.setDeviceMetricsOverride');
  assert.equal(command.params.deviceScaleFactor, 1);
});

function rebased(css, href) {
  return scripts.rebaseCss(css, href, 'https://app.example.com/plans');
}
