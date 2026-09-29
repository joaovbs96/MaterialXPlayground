// smoke.mjs: fast smoke run of the PACKAGED VS Code extension (small
// fixtures, one real VS Code session against --extension-dir, every
// scenario in suite/smoke-suite.js). Exit code 0 only if all pass.
'use strict';

import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { generateSmokeFixtures } from './lib/smoke-fixtures.mjs';

// See run.mjs's identical comment: this harness often runs under an
// Electron-hosted shell that sets ELECTRON_RUN_AS_NODE=1 for itself, which
// would make the spawned Code.exe boot as plain Node instead of VS Code.
delete process.env.ELECTRON_RUN_AS_NODE;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUITE_PATH = path.join(__dirname, 'suite', 'smoke-suite.js');

function log(msg) { console.log('[smoke] ' + msg); }

// Chromium switches for a software (SwiftShader) WebGL2 on GPU-less machines
// such as CI runners, where the GPU blocklist otherwise refuses WebGL2.
const SOFTWARE_GL_ARGS = ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

function parseArgs(argv) {
    const out = { extensionDir: null, vscode: 'stable', softwareGl: process.env.MTLX_SMOKE_SOFTWARE_GL === '1', launchArgs: [], suite: process.env.MTLX_SMOKE_SUITE || 'full' };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--extension-dir') out.extensionDir = argv[++i];
        else if (argv[i] === '--vscode') out.vscode = argv[++i];
        else if (argv[i] === '--suite') out.suite = argv[++i];
        else if (argv[i] === '--software-gl') out.softwareGl = true;
        // Extra VS Code/Chromium switch, e.g. --launch-arg=--disable-gpu to simulate a GPU-less runner.
        else if (argv[i].startsWith('--launch-arg=')) out.launchArgs.push(argv[i].slice('--launch-arg='.length));
    }
    return out;
}

// Prints the table for whatever results exist; returns true only if all passed.
function report(resultsFile, t0, note) {
    let results = null;
    try {
        results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    } catch (e) {
        console.error('[smoke] no results file was written: ' + (e && e.message || e));
        return false;
    }
    const scenarios = results.scenarios || {};
    const names = Object.keys(scenarios);
    const lines = [];
    lines.push('# VS Code packaged-extension smoke test');
    lines.push('');
    lines.push('vscode: ' + (results.vscodeVersion || 'unknown') + (results.fatalError ? ' -- FATAL: ' + results.fatalError : '') + (note ? ' -- ' + note : ''));
    lines.push('wall time: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    lines.push('');
    lines.push('| scenario | pass | seconds |');
    lines.push('|---|---|---|');
    let allPass = !results.fatalError && !note && names.length > 0;
    let passed = 0;
    for (const name of names) {
        const sc = scenarios[name] || {};
        if (sc.pass) passed++; else allPass = false;
        lines.push('| ' + name + ' | ' + (sc.pass ? 'OK' : 'FAILED') + ' | ' + (sc.seconds != null ? sc.seconds : '') + ' |');
        log(name + ': ' + (sc.pass ? 'OK' : 'FAILED (' + JSON.stringify(sc).slice(0, 300) + ')'));
    }
    lines.push('');
    lines.push('passed ' + passed + '/' + names.length);
    const summary = lines.join('\n');
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
    }
    log('passed ' + passed + '/' + names.length + ', total wall time: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    return allPass;
}

async function main() {
    const t0 = Date.now();
    const args = parseArgs(process.argv.slice(2));
    if (!args.extensionDir) {
        console.error('[smoke] usage: node smoke.mjs --extension-dir <dir> [--vscode stable|x.y.z] [--suite core|full]');
        process.exitCode = 1;
        return;
    }
    const extensionDir = path.resolve(args.extensionDir);
    const pkgPath = path.join(extensionDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        console.error('[smoke] no package.json under --extension-dir ' + extensionDir + ' -- point it at a staged/unzipped package (its "extension/" folder for an unzipped .vsix).');
        process.exitCode = 1;
        return;
    }

    const FIXTURES_DIR = process.env.MTLX_SMOKE_FIXTURES_DIR || path.join(os.tmpdir(), 'mtlx-smoke-fixtures');
    const VSCODE_CACHE = process.env.MTLX_SMOKE_VSCODE_CACHE || path.join(os.tmpdir(), 'mtlx-vscode-smoke-cache');
    const RESULTS_FILE = process.env.MTLX_SMOKE_RESULTS_FILE || path.join(os.tmpdir(), 'mtlx-smoke-results', 'results.json');

    log('extension dir: ' + extensionDir);
    log('generating small fixtures under ' + FIXTURES_DIR + ' ...');
    const fixtures = await generateSmokeFixtures(FIXTURES_DIR);
    const wsDir = fixtures.wsDir;

    log('downloading/locating VS Code ' + args.vscode + ' ...');
    const vscodeExe = await downloadAndUnzipVSCode({ version: args.vscode, cachePath: VSCODE_CACHE });
    log('vscode executable: ' + vscodeExe);

    // Fresh user-data-dir per run so a leftover setting (or any other
    // profile state) from one run can never leak into the next. The
    // extensions-dir stays persistent (it's just the downloaded extension
    // cache, not mutable settings state).
    fs.mkdirSync(VSCODE_CACHE, { recursive: true });
    const userDataDir = fs.mkdtempSync(path.join(VSCODE_CACHE, 'user-data-smoke-'));
    const extDir = path.join(VSCODE_CACHE, 'extensions-smoke');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
    try { fs.unlinkSync(RESULTS_FILE); } catch (e) { /* first run */ }

    // Whole-suite budget, shared with the suite (it skips what does not fit);
    // the watchdog below is the backstop if VS Code itself wedges.
    const deadlineSec = Number(process.env.MTLX_SMOKE_DEADLINE_S) || 900;
    const deadlineAt = Date.now() + deadlineSec * 1000;
    const watchdog = setTimeout(() => {
        log('WATCHDOG: VS Code still running ' + deadlineSec + 's + 60s after launch; reporting partial results.');
        report(RESULTS_FILE, t0, 'watchdog: host did not exit');
        process.exit(1);
    }, deadlineSec * 1000 + 60000);

    const glArgs = (args.softwareGl ? SOFTWARE_GL_ARGS : []).concat(args.launchArgs);
    if (glArgs.length) log('extra launch args: ' + glArgs.join(' '));
    log('launching VS Code against ' + wsDir + ' (extensionDevelopmentPath=' + extensionDir + ') ...');
    try {
        await runTests({
            vscodeExecutablePath: vscodeExe,
            extensionDevelopmentPath: extensionDir,
            extensionTestsPath: SUITE_PATH,
            launchArgs: [
                wsDir,
                '--disable-extensions',
                '--disable-workspace-trust',
                '--skip-welcome',
                '--skip-release-notes',
                '--disable-telemetry',
                '--user-data-dir', userDataDir,
                '--extensions-dir', extDir,
                ...glArgs,
            ],
            extensionTestsEnv: {
                MTLX_TEST_TRANSPORT: '1',
                MTLX_SMOKE_FIXTURES: FIXTURES_DIR,
                MTLX_SMOKE_RESULTS_FILE: RESULTS_FILE,
                MTLX_SMOKE_EXT_ROOT: extensionDir,
                // Optional manual measurement of a real scene (see the suite's
                // scenarioExternalScene); empty in CI.
                MTLX_SMOKE_EXTRA_SCENE: process.env.MTLX_SMOKE_EXTRA_SCENE || '',
                MTLX_SMOKE_EXTRA_ONLY: process.env.MTLX_SMOKE_EXTRA_ONLY || '',
                // Comma-separated scenario names to run (all when empty), for local reruns.
                MTLX_SMOKE_ONLY: process.env.MTLX_SMOKE_ONLY || '',
                // core (PR CI subset) or full (default).
                MTLX_SMOKE_SUITE: args.suite,
                MTLX_SMOKE_DEADLINE_AT: String(deadlineAt),
            },
        });
        log('host exited cleanly.');
    } catch (e) {
        log('host run FAILED at the process level: ' + (e && e.message || e));
    } finally {
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        } catch (e) {
            log('user-data-dir cleanup left files behind, ignoring: ' + userDataDir + ' (' + (e && e.code || e) + ')');
        }
    }

    clearTimeout(watchdog);
    process.exitCode = report(RESULTS_FILE, t0) ? 0 : 1;
}

main().catch((e) => {
    console.error('[smoke] FATAL', e);
    process.exitCode = 1;
});
