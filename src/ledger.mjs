import { harvestInteractive, INTERACTIVE_SELECTOR } from '../extension/browser-scripts.js';

export { INTERACTIVE_SELECTOR };

export async function harvestElements(page) {
  return page.evaluate(harvestInteractive, INTERACTIVE_SELECTOR);
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
