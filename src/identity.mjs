import { createHash } from 'node:crypto';
import { screenSkeleton, SKELETON_DEPTH } from '../extension/browser-scripts.js';

const ID_VALUE = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export { SKELETON_DEPTH };

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

// Hashing stays Node-side so both transports agree: the extension evaluates the
// skeleton in the page and sends the string, Playwright evaluates it locally,
// and neither side computes the hash itself.
export function signatureFor(skeleton, url) {
  const hash = createHash('sha256').update(skeleton).digest('hex').slice(0, 12);
  return `${normalizeUrl(url)}::${hash}`;
}

export async function screenSignature(page, maxDepth = SKELETON_DEPTH) {
  return signatureFor(await page.evaluate(screenSkeleton, maxDepth), page.url());
}
