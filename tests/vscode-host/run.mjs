// run.mjs: orchestrates the whole VS Code extension stress test.
// 1. generates fixtures (idempotent, skips what's already correct-sized)
// 2. downloads VS Code 'stable' and runs the full scenario suite (S1-S7)
// 3. downloads VS Code 1.100.0 (the engines floor) and runs S3 only
// 4. merges both runs' results.json into one report + a summary.md
'use strict';

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { generateFixtures } from './lib/fixtures.mjs';

// This harness itself often runs under an Electron-hosted shell (VS Code's
// own terminal, Claude Code, etc.), which sets ELECTRON_RUN_AS_NODE=1 for
// itself. That var is inherited by spawned children, so the Code.exe
// runTests() launches would boot as plain Node instead of as VS Code
// (fails with "Cannot find module <workspace path>"). Strip it before any
// child process is spawned; this is a harness-environment fix, not an
// extension change.
delete process.env.ELECTRON_RUN_AS_NODE;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = path.resolve(__dirname, '..', '..');

const FIXTURES_DIR = 'C:/Users/joaov/AppData/Local/Temp/mxpt-renders/stress-fixtures';
const VSCODE_CACHE = 'C:/Users/joaov/AppData/Local/Temp/mxpt-renders/vscode-test-cache';
const RESULTS_DIR = 'C:/Users/joaov/AppData/Local/Temp/claude/c--Users-joaov-Desktop-Programming-Projects-MaterialXNodeDocs/75b02cbf-b6a2-46f6-82b9-1aa04d93ec19/scratchpad/stress-results';

const SUITE_PATH = path.join(__dirname, 'suite', 'index.js');

function log(msg) { console.log('[run] ' + msg); }

async function runOnePass(vscodeExecutablePath, wsDir, label, scenariosCsv, resultsFile) {
    const userDataDir = path.join(VSCODE_CACHE, 'user-data-' + label);
    const extDir = path.join(VSCODE_CACHE, 'extensions-' + label);
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.dirname(resultsFile), { recursive: true });

    log('launching VS Code (' + label + ') against ' + wsDir + ' for scenarios [' + scenariosCsv + ']');
    try {
        await runTests({
            vscodeExecutablePath,
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
                MTLX_STRESS_SCENARIOS: scenariosCsv,
                MTLX_STRESS_RESULTS_FILE: resultsFile,
                MTLX_STRESS_EXT_ROOT: WORKTREE_ROOT,
                MTLX_STRESS_LABEL: label,
            },
        });
        log(label + ' host exited cleanly.');
    } catch (e) {
        log(label + ' host run FAILED at the process level: ' + (e && e.message || e));
        // The suite writes results incrementally after every scenario, so even
        // a host crash usually leaves partial data behind -- record the
        // process-level failure alongside whatever the suite already wrote.
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(resultsFile, 'utf8')); } catch (e2) { /* nothing written yet */ }
        existing.processLevelError = String((e && e.stack) || e);
        fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
        fs.writeFileSync(resultsFile, JSON.stringify(existing, null, 2));
    }
    try {
        return JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    } catch (e) {
        return { label, fatalError: 'no results file was written: ' + (e && e.message || e) };
    }
}

function fmtBytes(n) {
    if (n == null) return 'n/a';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
    return n + ' B';
}

function buildSummaryMarkdown(stableResults, floorResults) {
    const lines = [];
    lines.push('# VS Code extension stress test: direct texture reads');
    lines.push('');
    lines.push('Stable VS Code: ' + (stableResults.vscodeVersion || 'unknown') + (stableResults.fatalError ? ' -- FATAL: ' + stableResults.fatalError : ''));
    lines.push('Engines-floor VS Code (S3 only): ' + (floorResults.vscodeVersion || 'unknown') + (floorResults.fatalError ? ' -- FATAL: ' + floorResults.fatalError : ''));
    lines.push('');

    const s = stableResults.scenarios || {};
    lines.push('## S1 -- raw pipeline integrity (webview resource fetch ceiling)');
    if (s.S1) {
        lines.push('- Largest payload that fetched AND hashed correctly: ' + fmtBytes(s.S1.largestSucceededBytes));
        lines.push('- .data/.wasm hashes matched: ' + s.S1.dataWasmHashesMatched);
        if (s.S1.firstFailure) lines.push('- First failure: `' + s.S1.firstFailure.key + '` -- ' + (s.S1.firstFailure.note || s.S1.firstFailure.error || 'hash mismatch'));
        for (const r of (s.S1.results || [])) {
            const mb = r.mbPerSec ? r.mbPerSec.toFixed(1) + ' MB/s' : '';
            lines.push('  - ' + r.key + ': ' + (r.attempted ? (r.ok ? 'OK' : 'FAILED (' + r.error + ')') : 'NO RESPONSE') +
                (r.ok ? ', ' + fmtBytes(r.size) + ', ' + Math.round(r.ms) + 'ms, ' + mb + (r.hashMatch === false ? ' HASH MISMATCH' : '') : ''));
        }
    } else {
        lines.push('- did not run');
    }
    lines.push('');
    lines.push('## S2 -- boundary (localResourceRoots containment)');
    if (s.S2) {
        lines.push('- pass: ' + s.S2.pass);
        for (const r of (s.S2.results || [])) lines.push('  - ' + r.key + ': blocked as expected = ' + r.blockedAsExpected + (r.error ? ' (' + r.error + ')' : ''));
    } else lines.push('- did not run');
    lines.push('');

    function s3Section(label, res) {
        lines.push('## S3 (' + label + ') -- editor end-to-end');
        const sc = (res.scenarios || {}).S3;
        if (!sc) { lines.push('- did not run'); return; }
        lines.push('- pass: ' + sc.pass);
        for (const it of (sc.iterations || [])) {
            lines.push('  - iteration ' + it.iteration + ': totalMs=' + Math.round(it.totalMs) +
                ', rssBefore=' + fmtBytes(it.rssBeforeBytes) + ', rssAfter=' + fmtBytes(it.rssAfterBytes) +
                ', rssDelta=' + it.rssDeltaMB + 'MB, mismatches=' + it.mismatches.length +
                ', newErrorsIn30s=' + it.newErrorsIn30s);
            if (it.mismatches.length) lines.push('    mismatches: ' + it.mismatches.join('; '));
        }
        lines.push('');
    }
    s3Section('stable', stableResults);
    s3Section('1.100.0', floorResults);

    lines.push('## S4 -- live reload + cache-buster');
    if (s.S4) lines.push('- pass: ' + s.S4.pass + ', matched=' + s.S4.matched); else lines.push('- did not run');
    lines.push('');
    lines.push('## S5 -- many textures (200)');
    if (s.S5) lines.push('- pass: ' + s.S5.pass + ', totalMs=' + Math.round(s.S5.totalMs) + ', fileCount=' + s.S5.fileCount + ', mismatches=' + s.S5.mismatchCount); else lines.push('- did not run');
    lines.push('');
    lines.push('## S6 -- stale guard');
    if (s.S6) lines.push('- pass: ' + s.S6.pass + ', seqs=' + JSON.stringify(s.S6.seqs) + ', increasing=' + s.S6.increasing + ', bothMarkersPresent=' + s.S6.bothMarkersPresent); else lines.push('- did not run');
    lines.push('');
    lines.push('## S7 -- containment');
    if (s.S7) lines.push('- pass: ' + s.S7.pass + ', scanHasOutsideWarning=' + s.S7.scanHasOutsideWarning + ', notInFiles=' + s.S7.notInFiles + ', notInFailures=' + s.S7.notInFailures); else lines.push('- did not run');
    lines.push('');

    return lines.join('\n');
}

async function main() {
    const t0 = Date.now();
    log('generating fixtures under ' + FIXTURES_DIR);
    await generateFixtures(FIXTURES_DIR);
    const wsDir = path.join(FIXTURES_DIR, 'ws');

    log('downloading VS Code stable ...');
    const stableExe = await downloadAndUnzipVSCode({ version: 'stable', cachePath: VSCODE_CACHE });
    log('stable executable: ' + stableExe);

    const stableResultsFile = path.join(RESULTS_DIR, 'results-stable.json');
    const stableResults = await runOnePass(stableExe, wsDir, 'stable', 'S1,S2,S3,S4,S5,S6,S7', stableResultsFile);

    log('downloading VS Code 1.100.0 (engines floor) ...');
    const floorExe = await downloadAndUnzipVSCode({ version: '1.100.0', cachePath: VSCODE_CACHE });
    log('1.100.0 executable: ' + floorExe);

    const floorResultsFile = path.join(RESULTS_DIR, 'results-1.100.0.json');
    const floorResults = await runOnePass(floorExe, wsDir, '1.100.0', 'S3', floorResultsFile);

    const merged = {
        generatedAt: new Date().toISOString(),
        totalWallMs: Date.now() - t0,
        stable: stableResults,
        floor1100: floorResults,
    };
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RESULTS_DIR, 'results.json'), JSON.stringify(merged, null, 2));
    fs.writeFileSync(path.join(RESULTS_DIR, 'summary.md'), buildSummaryMarkdown(stableResults, floorResults));
    log('wrote ' + path.join(RESULTS_DIR, 'results.json') + ' and summary.md');
    log('total wall time: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

main().catch((e) => {
    console.error('[run] FATAL', e);
    process.exitCode = 1;
});
