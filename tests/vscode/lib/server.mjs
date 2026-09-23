// tests/vscode/lib/server.mjs: a static server rooted at the repo that
// serves ONLY files in `allowedFiles` (matching what `vsce ls` would
// package) - 404 for everything else, so a file .vscodeignore drops fails the same way the real bug did.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { VSCE_VERSION } from '../../../scripts/lib/vsce.mjs';

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
  '.ico': 'image/x-icon',
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function resolveSafePath(root, pathname) {
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
  return full;
}

/** Starts a whitelist-only static server rooted at `root`. `allowedFiles`
 * is a Set of repo-relative paths (forward slashes, no leading '/') -
 * anything not in it 404s regardless of whether the file exists on disk.
 * Resolves once listening on a free port. Returns { port, baseURL, close }. */
export function startWhitelistServer({ root, allowedFiles }) {
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const relPath = pathname.replace(/^\/+/, '');

    if (!allowedFiles.has(relPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not packaged in the vsix: ' + relPath);
      return;
    }

    const filePath = resolveSafePath(root, pathname);
    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found: ' + filePath);
        return;
      }
      res.writeHead(200, { 'Content-Type': mimeFor(filePath), 'Content-Length': stat.size });
      fs.createReadStream(filePath).pipe(res);
    });
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

/** Runs `npx --yes @vscode/vsce@<VSCE_VERSION> ls --no-dependencies` (or reads
 * MTLX_VSIX_FILE_LIST, one packaged path per line, for fast local
 * iteration) and returns the packaged file set as repo-relative paths. */
export function getPackagedFileSet({ repoRoot, spawnSyncFn }) {
  const listFile = process.env.MTLX_VSIX_FILE_LIST;
  let raw;
  if (listFile) {
    raw = fs.readFileSync(listFile, 'utf8');
  } else {
    const result = spawnSyncFn('npx', ['--yes', `@vscode/vsce@${VSCE_VERSION}`, 'ls', '--no-dependencies'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
    });
    if (result.error) throw new Error('failed to run vsce: ' + result.error.message);
    if (result.status !== 0) {
      throw new Error('vsce ls exited ' + result.status + '\n' + (result.stdout || '') + '\n' + (result.stderr || ''));
    }
    raw = result.stdout;
  }
  const files = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const rel = trimmed.startsWith('extension/') ? trimmed.slice('extension/'.length) : trimmed;
    files.add(rel.replaceAll('\\', '/'));
  }
  return files;
}
