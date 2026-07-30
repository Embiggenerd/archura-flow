import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCorpusData } from './snapshot.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

// Requests never name a file. Every servable path is derived from the corpus
// itself, so there is no request-supplied path to traverse out of.
function allowedPaths(run) {
  const allowed = new Set(['index.html', 'data.js']);
  for (const screen of run.screens.screens) {
    if (screen.html) allowed.add(screen.html);
    for (const shot of Object.values(screen.shots || {})) allowed.add(shot);
  }
  return allowed;
}

export async function startLiveViewer({ run, rootDir, hostname = '127.0.0.1' }) {
  const token = randomBytes(16).toString('hex');
  const prefix = `/${token}/`;

  const server = createServer((request, response) => {
    const deny = (status, body = '') => {
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : body);
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') return deny(405, 'Method not allowed');

    // A non-loopback Host header means the request was routed here from
    // somewhere else; the viewer is for this machine only.
    const host = (request.headers.host || '').toLowerCase();
    const hostOnly = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!['127.0.0.1', 'localhost', '::1'].includes(hostOnly)) return deny(403, 'Forbidden');

    const url = new URL(request.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith(prefix)) return deny(404, 'Not found');
    const relative = url.pathname.slice(prefix.length);

    const send = async () => {
      if (relative === 'api/data') {
        const body = Buffer.from(`${JSON.stringify(await buildCorpusData(run))}\n`, 'utf8');
        response.writeHead(200, {
          'content-type': TYPES['.json'],
          'content-length': body.length,
          'cache-control': 'no-store',
        });
        response.end(request.method === 'HEAD' ? undefined : body);
        return;
      }
      const name = relative === '' ? 'index.html' : relative;
      if (!allowedPaths(run).has(name)) return deny(404, 'Not found');
      const file = name === 'index.html'
        ? path.join(rootDir, 'viewer', 'index.html')
        : path.join(run.dir, name);
      // data.js only exists once something has been captured; before that the
      // page falls through to /api/data rather than showing a console error.
      const body = name === 'data.js'
        ? await readFile(file).catch(() => Buffer.from('window.DATA = null;\n', 'utf8'))
        : await readFile(file);
      response.writeHead(200, {
        'content-type': TYPES[path.extname(name)] || 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    };

    send().catch(() => deny(404, 'Not found'));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, hostname, resolve);
  });
  const { port } = server.address();

  return {
    port,
    url: `http://${hostname}:${port}${prefix}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
