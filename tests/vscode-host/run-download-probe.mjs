// run-download-probe.mjs: standalone runner for the SDL (download probe)
// scenario only, on VS Code stable. Separate from run.mjs's full S1-S7
// two-version sweep -- this is a single, fast, evidence-gathering pass
// asking one question: does a synthetic <a download> click inside a real
// webview actually produce a file, and if so where.
'use strict';

import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

// Same ELECTRON_RUN_AS_NODE fix as run.mjs -- this harness itself often
// runs under an Electron-hosted shell, which sets that var for itself; it
// leaks to spawned children and makes Code.exe boot as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = path.resolve(__dirname, '..', '..');

const FIXTURES_DIR = 'C:/Users/joaov/AppData/Local/Temp/mxpt-renders/stress-fixtures';
const VSCODE_CACHE = 'C:/Users/joaov/AppData/Local/Temp/mxpt-renders/vscode-test-cache';
const RESULTS_DIR = 'C:/Users/joaov/AppData/Local/Temp/claude/c--Users-joaov-Desktop-Programming-Projects-MaterialXNodeDocs/75b02cbf-b6a2-46f6-82b9-1aa04d93ec19/scratchpad/stress-results';

const SUITE_PATH = path.join(__dirname, 'suite', 'index.js');

function log(msg) { console.log('[dlprobe] ' + msg); }

async function main() {
    const wsDir = path.join(FIXTURES_DIR, 'ws');
    if (!fs.existsSync(path.join(FIXTURES_DIR, 'manifest.json'))) {
        throw new Error('fixtures not generated yet -- run tests/vscode-host/run.mjs once first, or run gen-fixtures.mjs');
    }

    log('downloading/locating VS Code stable ...');
    const stableExe = await downloadAndUnzipVSCode({ version: 'stable', cachePath: VSCODE_CACHE });
    log('stable executable: ' + stableExe);

    const label = 'dlprobe';
    const userDataDir = path.join(VSCODE_CACHE, 'user-data-' + label);
    const extDir = path.join(VSCODE_CACHE, 'extensions-' + label);
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const resultsFile = path.join(RESULTS_DIR, 'results-download-probe.json');

    log('Downloads folder being watched: ' + path.join(os.homedir(), 'Downloads'));
    log('launching VS Code (' + label + ') against ' + wsDir + ' for scenario SDL ...');
    try {
        await runTests({
            vscodeExecutablePath: stableExe,
            extensionDevelopmentPath: WORKTREE_ROOT,
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
            ],
            extensionTestsEnv: {
                MTLX_TEST_TRANSPORT: '1',
                MTLX_STRESS_FIXTURES: FIXTURES_DIR,
                MTLX_STRESS_SCENARIOS: 'SDL',
                MTLX_STRESS_RESULTS_FILE: resultsFile,
                MTLX_STRESS_EXT_ROOT: WORKTREE_ROOT,
                MTLX_STRESS_LABEL: label,
                MTLX_STRESS_USER_DATA_DIR: userDataDir,
            },
        });
        log('host exited cleanly.');
    } catch (e) {
        log('host run FAILED at the process level: ' + (e && e.message || e));
    }

    let results = null;
    try {
        results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    } catch (e) {
        log('no results file was written: ' + (e && e.message || e));
    }
    if (results) {
        log('vscodeVersion=' + results.vscodeVersion);
        log('SDL result: ' + JSON.stringify(results.scenarios && results.scenarios.SDL, null, 2));
    }
    log('wrote ' + resultsFile);
}

main().catch((e) => {
    console.error('[dlprobe] FATAL', e);
    process.exitCode = 1;
});
