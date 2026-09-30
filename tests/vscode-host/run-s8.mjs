// run-s8.mjs: standalone runner for the S8 (VS Code save bridge) scenario
// only, on VS Code stable. Same shape as run-download-probe.mjs -- a
// single fast pass, not the full S1-S7 two-version sweep in run.mjs.
'use strict';

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

delete process.env.ELECTRON_RUN_AS_NODE;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = path.resolve(__dirname, '..', '..');

const FIXTURES_DIR = 'C:/Users/joaov/AppData/Local/Temp/mxpt-renders/stress-fixtures';
const VSCODE_CACHE = 'C:/Users/joaov/AppData/Local/Temp/mxpt-renders/vscode-test-cache';
const RESULTS_DIR = 'C:/Users/joaov/AppData/Local/Temp/claude/c--Users-joaov-Desktop-Programming-Projects-MaterialXNodeDocs/75b02cbf-b6a2-46f6-82b9-1aa04d93ec19/scratchpad/stress-results';

const SUITE_PATH = path.join(__dirname, 'suite', 'index.js');

function log(msg) { console.log('[s8] ' + msg); }

async function main() {
    const wsDir = path.join(FIXTURES_DIR, 'ws');
    if (!fs.existsSync(path.join(FIXTURES_DIR, 'manifest.json'))) {
        throw new Error('fixtures not generated yet -- run tests/vscode-host/run.mjs once first, or run gen-fixtures.mjs');
    }

    log('downloading/locating VS Code stable ...');
    const stableExe = await downloadAndUnzipVSCode({ version: 'stable', cachePath: VSCODE_CACHE });
    log('stable executable: ' + stableExe);

    const label = 's8';
    const userDataDir = path.join(VSCODE_CACHE, 'user-data-' + label);
    const extDir = path.join(VSCODE_CACHE, 'extensions-' + label);
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const resultsFile = path.join(RESULTS_DIR, 'results-s8.json');

    log('launching VS Code (' + label + ') against ' + wsDir + ' for scenario S8 ...');
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
                MTLX_STRESS_SCENARIOS: 'S8',
                MTLX_STRESS_RESULTS_FILE: resultsFile,
                MTLX_STRESS_EXT_ROOT: WORKTREE_ROOT,
                MTLX_STRESS_LABEL: label,
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
        log('S8 result: ' + JSON.stringify(results.scenarios && results.scenarios.S8, null, 2));
    }
    log('wrote ' + resultsFile);
}

main().catch((e) => {
    console.error('[s8] FATAL', e);
    process.exitCode = 1;
});
