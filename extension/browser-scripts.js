// Page functions shared by the Playwright transport and the extension's CDP
// transport.
//
// Contract for every exported page function:
//   - closure-free and stringifiable: the body must not reference imports,
//     module constants, or transport globals;
//   - exactly one JSON-serializable argument.
//
// Playwright calls `page.evaluate(fn, argument)`; the CDP adapter evaluates
// `(${fn})(${JSON.stringify(argument)})`. Breaking the contract breaks the CDP
// side only, which no Playwright test would notice — keep bodies self-contained.

// Capture geometry lives here so the Playwright transport and the extension
// cannot drift apart on what "tablet" means or where a tall page gets cut.
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};
export const MAX_SCREENSHOT_HEIGHT = 12_000;
export const SKELETON_DEPTH = 12;

// Not a page function: a plain helper both transports use to make stylesheet
// URLs absolute against the sheet they came from.
export function rebaseCss(css, stylesheetUrl, pageUrl) {
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

export const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  '[role="button"]',
  'input',
  'select',
  'textarea',
  '[contenteditable]',
  'summary',
  '[onclick]',
  '[tabindex]',
].join(',');

// `combo` may be null to disable the in-page capture shortcut. Extension mode
// passes null: capture requests there come from chrome.commands only.
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
  // Playwright's exposeBinding returns a promise; a CDP Runtime binding returns
  // undefined. Tolerate both so one listener serves both transports.
  const send = (entry) => {
    try {
      const result = window.__archuraFlow({
        ...entry,
        url: location.href,
        at: new Date().toISOString(),
      });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // A detached transport must never break the page being audited.
    }
  };

  document.addEventListener('click', (event) => {
    const element = event.target?.closest?.('a,button,input,select,textarea,[role="button"],[onclick],[tabindex],summary,[contenteditable]');
    if (element) send({ kind: 'journal', type: 'click', key: keyFor(element), label: describe(element, 'click') });
  }, true);
  document.addEventListener('keydown', (event) => {
    if (combo && event.ctrlKey === combo.ctrlKey && event.shiftKey === combo.shiftKey &&
        event.code === combo.code) {
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

export function screenSkeleton(depthLimit) {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const token = (element) => {
    const classes = [...element.classList]
      .map((name) => name.replace(/\d+/g, ''))
      .filter(Boolean)
      .sort();
    const state = [];
    if ('checked' in element) state.push(`checked=${element.checked}`);
    if ('selected' in element) state.push(`selected=${element.selected}`);
    if ('disabled' in element) state.push(`disabled=${element.disabled}`);
    if ('open' in element) state.push(`open=${element.open}`);
    if ('value' in element) state.push(`value=${element.value ? 'set' : 'empty'}`);
    for (const name of ['aria-expanded', 'aria-pressed', 'aria-checked', 'aria-invalid']) {
      if (element.hasAttribute(name)) state.push(`${name}=${element.getAttribute(name)}`);
    }
    return `${element.tagName.toLowerCase()}${classes.length ? `.${classes.join('.')}` : ''}${state.length ? `[${state.join(',')}]` : ''}`;
  };
  const walk = (element, depth) => {
    if (depth > depthLimit || !visible(element)) return '';
    const children = [...element.children].map((child) => walk(child, depth + 1)).filter(Boolean);
    return `${token(element)}${children.length ? `(${children.join('')})` : ''}`;
  };
  return walk(document.documentElement, 0);
}

export function harvestInteractive(selector) {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const pathFor = (element) => {
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName)
        : [current];
      parts.unshift(`${tag}[${siblings.indexOf(current)}]`);
      current = current.parentElement;
    }
    return parts.join('>');
  };
  const selectorFor = (element) => {
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName)
        : [current];
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
      if (current === document.documentElement) break;
      current = current.parentElement;
    }
    return parts.join(' > ');
  };

  return [...document.querySelectorAll(selector)]
    .filter(visible)
    .filter((element) => !element.matches('[tabindex]') ||
      element.matches('a[href],button,[role="button"],input,select,textarea,[contenteditable],summary,[onclick]') ||
      element.tabIndex >= 0)
    .filter((element, index, all) => !all.some((other, otherIndex) =>
      otherIndex < index && other.contains(element) &&
      other.matches('[role="button"], [onclick], [tabindex]')))
    .map((element) => {
      const tag = element.tagName.toLowerCase();
      const text = clean(element.innerText || element.value || element.getAttribute('aria-label') ||
        element.getAttribute('title') || element.getAttribute('name') || element.type);
      const path = pathFor(element);
      const role = element.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : null);
      const name = clean(element.getAttribute('aria-label') || element.innerText ||
        element.getAttribute('name') || element.value || element.type);
      const href = tag === 'a' ? element.href : null;
      return {
        key: `${tag}|${text}|${path}`,
        tag,
        text,
        role,
        name,
        type: element.getAttribute('type'),
        href,
        selector: selectorFor(element),
        context: clean([
          element.closest('dialog,[role="dialog"]')?.innerText,
          element.closest('form')?.innerText,
          element.closest('form')?.getAttribute('action'),
          element.closest('section,article')?.querySelector('h1,h2,h3')?.innerText,
          element.closest('label')?.innerText,
        ].filter(Boolean).join(' ')),
        formTypes: element.closest('form')
          ? [...element.closest('form').querySelectorAll('input')].map((input) => input.type)
          : [],
      };
    });
}

// Same-origin sheets expose cssRules; cross-origin sheets throw and come back
// with `css: null` for the caller to fetch by another route.
export function readStyleSheets() {
  return [...document.styleSheets].map((sheet) => {
    try {
      return { href: sheet.href, css: [...sheet.cssRules].map((rule) => rule.cssText).join('\n') };
    } catch {
      return { href: sheet.href, css: null };
    }
  });
}

export function serializeDocument({ bundledCss, currentUrl }) {
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
}

export function readPageMetrics() {
  return {
    url: location.href,
    title: document.title,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    width: window.innerWidth,
    height: window.innerHeight,
    deviceScaleFactor: window.devicePixelRatio,
    scrollHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
    ),
  };
}

export function restoreScroll({ x, y }) {
  window.scrollTo(x, y);
}
