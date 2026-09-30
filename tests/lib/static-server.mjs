// tests/lib/static-server.mjs
//
// Shared building blocks for the embed and vscode test static servers:
// the MIME table, a strict path-containment resolver, and the
// listen-on-127.0.0.1/close boilerplate both servers repeated.

import fs from 'node:fs';
import path from 'node:path';

export const MIME = {
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
  '.ico': 'image/x-icon',
};

export function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// Resolves a URL pathname against root, rejecting any path that escapes
// it: encoded traversal, dot-segments, dotfiles, or a symlink whose real
// path lands outside root. Returns null on rejection.
export function resolveSafePath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    return null;
  }
  const resolvedRoot = path.resolve(root);
  if (decoded.includes('\0')) return null;
  decoded = decoded.replaceAll('\\', '/');
  const full = path.resolve(resolvedRoot, '.' + decoded);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) return null;
  if (decoded.split('/').some(part => part === '.' || part === '..' || part.startsWith('.'))) return null;
  try {
    const real = fs.realpathSync.native(full);
    if (real !== resolvedRoot && !real.startsWith(resolvedRoot + path.sep)) return null;
  } catch (e) {
    // Missing files are handled by the caller; containment is checked when present.
  }
  return full;
}

/** Wraps an http.Server: resolves once it is listening on a free
 * 127.0.0.1 port, with { port, baseURL, close }. */
export function listenLocal(server) {
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
