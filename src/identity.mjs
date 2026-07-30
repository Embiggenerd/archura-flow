import { createHash } from 'node:crypto';

const ID_VALUE = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function normalizeUrl(input) {
  const url = new URL(input);
  url.hash = '';
  url.pathname = url.pathname
    .split('/')
    .map((part) => ID_VALUE.test(decodeURIComponent(part)) ? ':id' : part)
    .join('/');

  const sorted = [...url.searchParams.entries()]
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
  url.search = '';
  for (const [key, value] of sorted) {
    url.searchParams.append(key, ID_VALUE.test(value) ? ':id' : value);
  }
  return url.toString();
}

export async function screenSignature(page, maxDepth = 12) {
  const skeleton = await page.evaluate((depthLimit) => {
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
  }, maxDepth);
  const hash = createHash('sha256').update(skeleton).digest('hex').slice(0, 12);
  return `${normalizeUrl(page.url())}::${hash}`;
}
