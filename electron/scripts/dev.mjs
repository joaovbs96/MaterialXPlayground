#!/usr/bin/env node
// dev.mjs: single-command Electron dev launcher. Installs electron/'s
// own deps on first run, then spawns the Electron binary against the
// repo root served live over app:// (no staging, edit-refresh dev loop).
import { existsSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from './lib/resolve-version.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ELECTRON_DIR, '..');
const IS_WIN = process.platform === 'win32';

// npm ships as npm.cmd on Windows; Node refuses to spawn a .cmd/.bat
// directly without shell:true (batch-file argument injection hardening).
function runNpm(args, opts) {
    const result = spawnSync(IS_WIN ? 'npm.cmd' : 'npm', args, Object.assign({ stdio: 'inherit', shell: IS_WIN }, opts));
    if (result.error) {
        console.error(result.error);
        process.exit(1);
    }
    if (result.status !== 0) process.exit(result.status || 1);
}

if (!existsSync(path.join(ELECTRON_DIR, 'node_modules'))) {
    console.log('[electron:dev] installing electron/ dependencies...');
    runNpm(['ci', '--prefix', ELECTRON_DIR]);
}

// Same offline-asset guard as pack.mjs: without this, a fresh tree's first
// electron:dev run silently falls back to remote asset mode instead of
// vendor/materialx, defeating the whole point of the desktop build.
if (!existsSync(path.join(REPO_ROOT, 'vendor', 'materialx', 'manifest.json'))) {
    console.log('[electron:dev] vendor/materialx missing, running npm run vendor:offline at the repo root...');
    runNpm(['run', 'vendor:offline'], { cwd: REPO_ROOT });
}

const require = createRequire(import.meta.url);
const electronPath = require(path.join(ELECTRON_DIR, 'node_modules', 'electron'));

const smoke = process.argv.includes('--smoke');
const smokeOpenIndex = process.argv.indexOf('--smoke-open');
const smokeOpenFile = smokeOpenIndex !== -1 ? process.argv[smokeOpenIndex + 1] : null;
const { version } = resolveVersion(REPO_ROOT);
const env = Object.assign({}, process.env, { MTLX_SITE_ROOT: REPO_ROOT, MTLX_DEV_VERSION: version });
if (smoke) env.MTLX_SMOKE = '1';
if (smokeOpenFile) env.MTLX_SMOKE_OPEN = path.resolve(smokeOpenFile);
// A leaked ELECTRON_RUN_AS_NODE=1 from the parent shell would make the
// binary boot as plain Node instead of the full Electron runtime.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [ELECTRON_DIR], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code === null ? 1 : code));
