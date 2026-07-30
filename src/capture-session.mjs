import { captureScreen } from './snapshot.mjs';

// Journals are keyed by channel so one session can track several sources
// independently: the Playwright CLI keys by page (a tab's clicks belong to that
// tab's next capture), the extension keys by its single recording tab.
export class CaptureSession {
  constructor({ run, rootDir }) {
    this.run = run;
    this.rootDir = rootDir;
    this.journals = new Map();
    this.queue = Promise.resolve();
  }

  get screenCount() {
    return this.run.screens.screens.length;
  }

  openChannel(channel) {
    this.journals.set(channel, []);
  }

  appendJournal(channel, entry) {
    const entries = this.journals.get(channel) || [];
    entries.push(entry);
    this.journals.set(channel, entries);
  }

  // The edge is everything journaled since the previous capture on this channel.
  takeEdge(channel) {
    const entries = this.journals.get(channel) || [];
    this.journals.set(channel, []);
    return entries;
  }

  restoreEdge(channel, entries) {
    if (!entries.length) return;
    const current = this.journals.get(channel) || [];
    this.journals.set(channel, [...entries, ...current]);
  }

  // Captures are serialized: two shortcut presses in flight at once would
  // interleave screenshot viewport changes and corrupt both nodes.
  enqueue(task) {
    this.queue = this.queue.then(task, task);
    return this.queue;
  }

  async capture({ page, context, source = 'combo', state, channel = page }) {
    return this.enqueue(async () => {
      const edge = this.takeEdge(channel);
      try {
        return await captureScreen({
          page,
          context,
          run: this.run,
          rootDir: this.rootDir,
          source,
          state: state || { root: page.url(), path: [] },
          edge,
        });
      } catch (error) {
        this.restoreEdge(channel, edge);
        throw error;
      }
    });
  }
}

export function formatCaptureResult(result) {
  const { screen } = result;
  return `✓ screen ${screen.id.slice(1)}: ${new URL(screen.url).pathname} "${screen.title}"`;
}
