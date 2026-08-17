// tests/embed/lib/server.mjs: plain node:http static server, rooted at
// the repo. `cleanUrls: true` 301-redirects /embed/viewer.html requests
// to drop their query string, reproducing the serve/Vercel hazard.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.exr': 'application/octet-stream',
  '.hdr': 'application/octet-stream',
  '.mtlx': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// Resolves a URL pathname against root, rejecting any path that escapes
// it (encoded traversal, ../, etc). Returns null on rejection.
function resolveSafePath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    return null;
  }
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, '.' + decoded);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) return null;
  return full;
}

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

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        baseURL: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
