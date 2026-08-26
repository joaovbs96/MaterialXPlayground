#!/usr/bin/env node
// pack.mjs: single-command local packaging: ensures deps and vendor
// data, stages the site, then runs electron-builder for the current
// platform (unsigned, --publish never; this is the in-depth-test build).
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from './lib/resolve-version.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ELECTRON_DIR, '..');
const IS_WIN = process.platform === 'win32';

function run(cmd, args, opts) {
    const result = spawnSync(cmd, args, Object.assign({ stdio: 'inherit' }, opts));
    if (result.error) {
        console.error(result.error);
        process.exit(1);
    }
    if (result.status !== 0) process.exit(result.status || 1);
}

// The committed root package.json version is not the source of truth for
// the packaged app (see resolveVersion), but a stale value is a smell
// worth flagging so it doesn't silently drift too far from releases.
function warnIfVersionStale() {
    const rootVersion = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
    const latestTag = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (latestTag.error || latestTag.status !== 0) return;
    const tagVersion = latestTag.stdout.trim().replace(/^v/, '');
    if (tagVersion && tagVersion !== rootVersion) {
        console.warn(
            '[electron:pack] WARNING: root package.json version "' + rootVersion +
            '" does not match latest git tag "' + tagVersion + '". Consider bumping package.json.'
        );
    }
}

// npm ships as npm.cmd on Windows; Node refuses to spawn a .cmd/.bat
// directly without shell:true (batch-file argument injection hardening).
function runNpm(args, opts) {
    run(IS_WIN ? 'npm.cmd' : 'npm', args, Object.assign({ shell: IS_WIN }, opts));
}

warnIfVersionStale();

if (!existsSync(path.join(ELECTRON_DIR, 'node_modules'))) {
    console.log('[electron:pack] installing electron/ dependencies...');
    runNpm(['ci', '--prefix', ELECTRON_DIR]);
}

if (!existsSync(path.join(REPO_ROOT, 'vendor', 'materialx', 'manifest.json'))) {
    console.log('[electron:pack] vendor/materialx missing, running npm run vendor:offline at the repo root...');
    runNpm(['run', 'vendor:offline'], { cwd: REPO_ROOT });
}

console.log('[electron:pack] staging site...');
run(process.execPath, [path.join(__dirname, 'stage-site.mjs')]);

const { version, source } = resolveVersion(REPO_ROOT);
console.log('[electron:pack] resolved version ' + version + ' (source: ' + source + ')');

console.log('[electron:pack] running electron-builder...');
// Invoke electron-builder's own entry script with node directly rather
// than the node_modules/.bin/electron-builder.cmd shim (same .cmd spawn
// restriction as npm above).
const builderCli = path.join(ELECTRON_DIR, 'node_modules', 'electron-builder', 'cli.js');
const nodeArgs = [];
if (IS_WIN) {
    // Windows real-time antivirus can hold a brief exclusive lock on a
    // just-written file, making electron-builder's own chmod fail with a
    // transient EPERM; this preloaded shim retries it (see the file).
    nodeArgs.push('--require', path.join(__dirname, 'lib', 'win-fs-retry-shim.cjs'));
}
// extraMetadata.version overrides the packaged app.asar's package.json
// version at build time only, without touching the tracked file.
run(process.execPath, [
    ...nodeArgs, builderCli, '--publish', 'never',
    '--config.extraMetadata.version=' + version,
], { cwd: ELECTRON_DIR });

const distDir = path.join(ELECTRON_DIR, 'dist');
console.log('[electron:pack] output in ' + distDir + ':');
if (existsSync(distDir)) {
    for (const name of readdirSync(distDir)) {
        if (statSync(path.join(distDir, name)).isFile()) console.log('[electron:pack]   ' + name);
    }
}
