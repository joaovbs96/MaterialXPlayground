// tests/embed/lib/server.mjs: plain node:http static server, rooted at
// the repo. `cleanUrls: true` 301-redirects /embed/viewer.html requests
// to drop their query string, reproducing the serve/Vercel hazard.

import http from 'node:http';
import fs from 'node:fs';
import { mimeFor, resolveSafePath, listenLocal } from '../../lib/static-server.mjs';

function serveFile(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found: ' + filePath);
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeFor(filePath),
      'Content-Length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/** Starts a static server rooted at `root`. Resolves once listening on
 * a free port. Returns { port, baseURL, close }. */
export function startServer({ root, cleanUrls = false } = {}) {
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }
    const pathname = url.pathname;

    // cleanUrls mode: reproduce serve/Vercel's default behavior of
    // dropping the query string on a rewritten URL.
    if (cleanUrls && pathname === '/embed/viewer.html' && url.search) {
      res.writeHead(301, { Location: pathname });
      res.end();
      return;
    }

    const target = pathname === '/' ? '/index.html' : pathname;
    const filePath = resolveSafePath(root, target);
    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    serveFile(res, filePath);
  });

  return listenLocal(server);
}
