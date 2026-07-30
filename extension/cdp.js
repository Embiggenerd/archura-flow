import { MAX_SCREENSHOT_HEIGHT } from './browser-scripts.js';

// Every CDP method archura-flow may issue is named in this file. The native
// host sends capture data and session commands; it can never ask the extension
// to run an arbitrary command, so this list is the whole browser-control
// surface the protocol exposes.
const PROTOCOL_VERSION = '1.3';

export const BINDING_NAME = '__archuraFlowRaw';

export class CdpSession {
  constructor(tabId) {
    this.target = { tabId };
    this.attached = false;
    this.listeners = new Set();
    this.onEvent = (source, method, params) => {
      if (source.tabId !== this.target.tabId) return;
      for (const listener of this.listeners) listener(method, params);
    };
  }

  async attach() {
    await chrome.debugger.attach(this.target, PROTOCOL_VERSION);
    this.attached = true;
    chrome.debugger.onEvent.addListener(this.onEvent);
  }

  async detach() {
    if (!this.attached) return;
    chrome.debugger.onEvent.removeListener(this.onEvent);
    this.attached = false;
    await chrome.debugger.detach(this.target).catch(() => {});
  }

  listen(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(method, params = {}) {
    return chrome.debugger.sendCommand(this.target, method, params);
  }

  async enableCaptureDomains() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  // Page functions are stringified and applied to a single JSON argument —
  // the same calling convention the Playwright adapter uses.
  async evaluate(pageFunction, argument = null) {
    const expression = `(${pageFunction.toString()})(${JSON.stringify(argument)})`;
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text || 'Runtime.evaluate failed';
      throw new Error(text);
    }
    return result.result?.value;
  }

  async addBinding(name = BINDING_NAME) {
    await this.send('Runtime.addBinding', { name });
  }

  async addStartupScript(source) {
    const { identifier } = await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
    return identifier;
  }

  async evaluateSource(source) {
    const result = await this.send('Runtime.evaluate', { expression: source, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed');
    }
  }

  async layoutMetrics() {
    return this.send('Page.getLayoutMetrics');
  }

  // Full-page capture is `captureBeyondViewport` plus an explicit clip, which
  // is also how the height cap for infinite feeds is applied.
  async captureScreenshot({ fullPage = true, width, height } = {}) {
    if (!fullPage) {
      const { result } = { result: await this.send('Page.captureScreenshot', { format: 'png' }) };
      return result.data;
    }
    const metrics = await this.layoutMetrics();
    const content = metrics.cssContentSize || metrics.contentSize;
    const clipWidth = width || content.width;
    const clipHeight = Math.min(height || content.height, MAX_SCREENSHOT_HEIGHT);
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: clipWidth, height: clipHeight, scale: 1 },
    });
    return result.data;
  }

  async setDeviceMetrics({ width, height, mobile = false, deviceScaleFactor = 0 }) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      mobile,
      deviceScaleFactor,
    });
  }

  async clearDeviceMetrics() {
    await this.send('Emulation.clearDeviceMetricsOverride');
  }

  // CSS.getStyleSheetText reaches cross-origin sheets that document.styleSheets
  // refuses to expose, which is why the extension path uses it instead.
  async collectStyleSheets() {
    const seen = [];
    const stop = this.listen((method, params) => {
      if (method === 'CSS.styleSheetAdded') seen.push(params.header);
    });
    try {
      await this.send('DOM.enable');
      await this.send('CSS.enable');
      // Give Chrome a turn to replay styleSheetAdded for the current document.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const sheets = [];
      for (const header of seen) {
        if (header.isInline && !header.sourceURL) continue;
        try {
          const { text } = await this.send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId });
          sheets.push({ href: header.sourceURL || null, css: text });
        } catch (error) {
          sheets.push({ href: header.sourceURL || null, css: null, error: String(error?.message || error) });
        }
      }
      return sheets;
    } finally {
      stop();
      await this.send('CSS.disable').catch(() => {});
    }
  }
}
