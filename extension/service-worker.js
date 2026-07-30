import { BINDING_NAME, CdpSession } from './cdp.js';
import {
  harvestInteractive,
  injectedListeners,
  INTERACTIVE_SELECTOR,
  readPageMetrics,
  rebaseCss,
  restoreScroll,
  screenSkeleton,
  serializeDocument,
  SKELETON_DEPTH,
  VIEWPORTS,
} from './browser-scripts.js';

const HOST_NAME = 'com.archura.flow';
const PROTOCOL_VERSION = 1;
// Base64 chunks must stay a multiple of 4 so each one decodes independently.
const CHUNK_CHARS = 512 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

const state = {
  status: 'idle',
  tabId: null,
  tabUrl: null,
  tabTitle: null,
  epoch: null,
  output: null,
  screenCount: 0,
  sequence: 0,
  lastResult: null,
  lastError: null,
  viewerUrl: null,
};

let cdp = null;
let port = null;
let waiters = [];
let requestCounter = 0;

const BADGES = {
  idle: { text: '', color: '#334157' },
  starting: { text: '…', color: '#2f6feb' },
  recording: { text: 'REC', color: '#1f9d55' },
  capturing: { text: '…', color: '#2f6feb' },
  error: { text: '!', color: '#c53030' },
};

function setStatus(status, patch = {}) {
  state.status = status;
  Object.assign(state, patch);
  const badge = BADGES[status] || BADGES.idle;
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
  chrome.storage.session.set({
    archuraFlow: {
      status: state.status,
      tabId: state.tabId,
      epoch: state.epoch,
      output: state.output,
      sequence: state.sequence,
    },
  });
  chrome.runtime.sendMessage({ type: 'state', state: publicState() }).catch(() => {});
}

function publicState() {
  return { ...state };
}

function nextRequestId() {
  requestCounter += 1;
  return `r${Date.now().toString(36)}-${requestCounter}`;
}

// Host replies are correlated by requestId where one exists and by type
// otherwise; `error` frames reject the matching waiter instead of hanging it.
function expect(match, timeout = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const waiter = { match, resolve, reject };
    waiter.timer = setTimeout(() => {
      waiters = waiters.filter((item) => item !== waiter);
      reject(new Error('The archura-flow host did not respond in time.'));
    }, timeout);
    waiters.push(waiter);
  });
}

function deliver(message) {
  for (const waiter of [...waiters]) {
    if (!waiter.match(message)) continue;
    waiters = waiters.filter((item) => item !== waiter);
    clearTimeout(waiter.timer);
    if (message.type === 'error') waiter.reject(new Error(`${message.code}: ${message.message}`));
    else waiter.resolve(message);
    return true;
  }
  return false;
}

function rejectAll(error) {
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  waiters = [];
}

async function connectHost() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener((message) => {
    if (deliver(message)) return;
    if (message.type === 'error') fail(new Error(`${message.code}: ${message.message}`));
    if (message.type === 'state') setStatus(state.status, { screenCount: message.screenCount ?? state.screenCount });
  });
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    port = null;
    rejectAll(new Error(error?.message || 'The archura-flow host disconnected.'));
    if (state.status !== 'idle') {
      fail(new Error(error?.message || 'The archura-flow host stopped. Press the shortcut to start it again.'));
    }
  });
  const ready = expect((message) => message.type === 'ready' || message.type === 'error', 15_000);
  port.postMessage({ type: 'hello', protocolVersion: PROTOCOL_VERSION, extensionVersion: chrome.runtime.getManifest().version });
  const reply = await ready;
  if (reply.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Host speaks protocol ${reply.protocolVersion}; extension speaks ${PROTOCOL_VERSION}.`);
  }
  return port;
}

function send(message) {
  if (!port) throw new Error('The archura-flow host is not connected.');
  port.postMessage(message);
}

async function fail(error) {
  state.lastError = error.message;
  // Release the host's session too. Leaving it open would make the next
  // shortcut press fail with "a recording is already active" forever.
  if (port && state.epoch) {
    try {
      send({ type: 'session.stop', epoch: state.epoch, reason: 'error' });
    } catch {
      // The port is already gone, which is the same outcome.
    }
  }
  state.epoch = null;
  setStatus('error');
  await teardown().catch(() => {});
}

async function teardown() {
  if (cdp) {
    await cdp.detach().catch(() => {});
    cdp = null;
  }
}

function assertCapturable(tab) {
  if (!tab?.id) throw new Error('No tab to capture.');
  const url = tab.url || '';
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('archura-flow captures http and https pages only.');
  }
  if (/^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/i.test(url)) {
    throw new Error('Chrome blocks extensions from attaching to the Chrome Web Store.');
  }
  if (tab.discarded) throw new Error('This tab is discarded; reload it before recording.');
}

// The listener is the shared page function. The shim adapts it to a CDP
// binding, which takes a single string rather than a structured payload.
function listenerSource() {
  return `(() => {
    const raw = globalThis.${BINDING_NAME};
    if (!raw) return;
    globalThis.__archuraFlow = (payload) => raw(JSON.stringify(payload));
    (${injectedListeners.toString()})(null);
  })();`;
}

async function startSession(tab) {
  assertCapturable(tab);
  setStatus('starting', { tabId: tab.id, tabUrl: tab.url, tabTitle: tab.title, lastError: null });
  await connectHost();

  cdp = new CdpSession(tab.id);
  await cdp.attach();
  await cdp.enableCaptureDomains();
  await cdp.addBinding();

  cdp.listen((method, params) => {
    if (method === 'Runtime.bindingCalled' && params.name === BINDING_NAME) {
      let payload;
      try {
        payload = JSON.parse(params.payload);
      } catch {
        return;
      }
      if (payload.kind !== 'journal') return;
      journal({ type: payload.type, key: payload.key, label: payload.label, url: payload.url, at: payload.at });
    }
    if (method === 'Page.frameNavigated' && !params.frame.parentId) {
      journal({
        type: 'nav',
        key: null,
        label: `navigate to '${params.frame.url}'`,
        url: params.frame.url,
        at: new Date().toISOString(),
      });
    }
  });

  await cdp.addStartupScript(listenerSource());
  await cdp.evaluateSource(listenerSource());

  const started = expect((message) => message.type === 'session.started' || message.type === 'error');
  send({ type: 'session.start', url: tab.url, title: tab.title, tab: { id: tab.id, windowId: tab.windowId } });
  const session = await started;
  setStatus('recording', {
    epoch: session.epoch,
    output: session.output,
    screenCount: session.screenCount,
    sequence: 0,
  });
}

function journal(entry) {
  if (!port || !state.epoch) return;
  state.sequence += 1;
  try {
    send({ type: 'journal.append', epoch: state.epoch, entries: [{ sequence: state.sequence, ...entry }] });
  } catch {
    // A dropped journal entry costs an edge label, not the capture.
  }
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

function streamArtifact(requestId, artifact, base64) {
  let index = 0;
  for (let offset = 0; offset < base64.length; offset += CHUNK_CHARS) {
    send({
      type: 'capture.chunk',
      epoch: state.epoch,
      requestId,
      artifact,
      index,
      data: base64.slice(offset, offset + CHUNK_CHARS),
    });
    index += 1;
  }
}

async function captureNow() {
  // Hold a local reference: an onDetach during the capture nulls the module
  // one, and the restore step in `finally` still needs the session it started with.
  const session = cdp;
  if (!session) throw new Error('Not recording.');
  setStatus('capturing');
  const requestId = nextRequestId();
  const warnings = [];

  // Everything that describes the page is read at the live viewport, before any
  // emulation touches it.
  const metrics = await session.evaluate(readPageMetrics);
  const skeleton = await session.evaluate(screenSkeleton, SKELETON_DEPTH);
  const elements = await session.evaluate(harvestInteractive, INTERACTIVE_SELECTOR);

  const sheets = await session.collectStyleSheets();
  const css = [];
  for (const sheet of sheets) {
    if (sheet.css === null) {
      warnings.push({ kind: 'stylesheet-unreadable', href: sheet.href, detail: sheet.error || null });
      continue;
    }
    css.push(rebaseCss(sheet.css, sheet.href, metrics.url));
  }
  const html = await session.evaluate(serializeDocument, {
    bundledCss: css.join('\n'),
    currentUrl: metrics.url,
  });

  const viewports = {
    desktop: { width: metrics.width, height: metrics.height, source: 'live' },
    tablet: { ...VIEWPORTS.tablet },
    mobile: { ...VIEWPORTS.mobile },
  };

  const done = expect((message) =>
    (message.type === 'capture.done' || message.type === 'error') && message.requestId === requestId);
  send({
    type: 'capture.begin',
    epoch: state.epoch,
    requestId,
    url: metrics.url,
    title: metrics.title,
    viewports,
    warnings,
    tab: { id: state.tabId },
  });
  streamArtifact(requestId, 'html', toBase64(html));

  const desktop = await session.captureScreenshot({ fullPage: true, width: metrics.width });
  streamArtifact(requestId, 'desktop', desktop);

  try {
    for (const name of ['tablet', 'mobile']) {
      await session.setDeviceMetrics({ ...VIEWPORTS[name], mobile: name === 'mobile' });
      const shot = await session.captureScreenshot({ fullPage: true, width: VIEWPORTS[name].width });
      streamArtifact(requestId, name, shot);
    }
  } finally {
    // A tab left under emulation is unusable for the operator, so a failure to
    // restore is fatal rather than a warning.
    try {
      await session.clearDeviceMetrics();
      await session.evaluate(restoreScroll, { x: metrics.scrollX, y: metrics.scrollY });
    } catch (error) {
      await fail(new Error(`Could not restore the tab after emulation — reload it. ${error.message}`));
      throw error;
    }
  }

  send({ type: 'capture.commit', epoch: state.epoch, requestId, skeleton, elements });
  const result = await done;
  setStatus('recording', {
    screenCount: result.screenCount,
    lastResult: result.sameAs ? `${result.screenId} (same as ${result.sameAs})` : result.screenId,
    lastError: null,
  });
  return result;
}

async function stopSession(reason = 'stopped') {
  if (port && state.epoch) {
    try {
      send({ type: 'session.stop', epoch: state.epoch, reason });
    } catch {
      // Already gone; teardown below is what matters.
    }
  }
  await teardown();
  setStatus('idle', { tabId: null, epoch: null, sequence: 0, tabUrl: null, tabTitle: null });
}

async function onCommand(tab) {
  try {
    if (state.status === 'idle' || state.status === 'error') {
      await startSession(tab);
      await captureNow();
      return;
    }
    if (state.tabId !== tab.id) {
      throw new Error('Another tab is recording. Stop it from the popup before recording this one.');
    }
    if (state.status === 'capturing') return;
    await captureNow();
  } catch (error) {
    await fail(error);
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'capture') return;
  // The command callback carries the exact tab that received the shortcut —
  // this is what binds the session to a tab without a picker.
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  await onCommand(target);
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  if (source.tabId !== state.tabId) return;
  cdp = null;
  // Chrome's own "Cancel" on the debugger banner is an operator stop, not a fault.
  if (reason === 'canceled_by_user' || reason === 'target_closed') {
    await stopSession(reason === 'target_closed' ? 'tab-closed' : 'detached-by-user');
    return;
  }
  await fail(new Error(`The debugger detached (${reason}).`));
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId !== state.tabId) return;
  await stopSession('tab-closed');
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  (async () => {
    switch (message.type) {
      case 'state':
        respond({ state: publicState() });
        return;
      case 'capture': {
        const tab = state.tabId
          ? await chrome.tabs.get(state.tabId)
          : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        await onCommand(tab);
        respond({ state: publicState() });
        return;
      }
      case 'stop':
        await stopSession('stopped');
        respond({ state: publicState() });
        return;
      case 'retry':
        await teardown();
        setStatus('idle', { tabId: null, epoch: null, lastError: null });
        respond({ state: publicState() });
        return;
      case 'viewer': {
        const requestId = nextRequestId();
        const reply = expect((item) =>
          (item.type === 'viewer.url' || item.type === 'error') && item.requestId === requestId, 15_000);
        send({ type: 'viewer.open', epoch: state.epoch, requestId });
        const { url } = await reply;
        state.viewerUrl = url;
        await chrome.tabs.create({ url });
        respond({ state: publicState() });
        return;
      }
      default:
        respond({ error: `Unknown message ${message.type}` });
    }
  })().catch((error) => respond({ error: error.message }));
  return true;
});

// A restarted worker must not believe it is still attached: reconcile against
// the host before accepting another capture.
chrome.runtime.onStartup.addListener(() => setStatus('idle'));
setStatus(state.status);
