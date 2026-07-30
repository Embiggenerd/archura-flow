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

export async function harvestElements(page) {
  return page.evaluate((selector) => {
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
  }, INTERACTIVE_SELECTOR);
}

export function ledgerEntry(element, screen, bucket = 'skipped', reason = 'needs-manual') {
  return {
    key: element.key,
    screen,
    bucket,
    ...(bucket === 'skipped' ? { reason } : {}),
    href: element.href,
    tag: element.tag,
    text: element.text,
    role: element.role,
    name: element.name,
    type: element.type,
  };
}

export function setLedgerBucket(ledger, screen, key, bucket, reason) {
  const entry = ledger.elements.find((item) => item.screen === screen && item.key === key);
  if (!entry) return false;
  entry.bucket = bucket;
  if (bucket === 'skipped') entry.reason = reason || 'needs-manual';
  else delete entry.reason;
  return true;
}
