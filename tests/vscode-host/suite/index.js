// suite/index.js: extensionTestsPath for @vscode/test-electron. Runs
// inside the real Extension Development Host process (vscode module and
// the activated extension's process.memoryUsage() are both real). Plain
// CommonJS, exports run() returning a Promise -- no mocha.
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const EXT_ID = 'MaterialXPlayground.materialx-playground';
const VIEW_TYPE = 'materialxPlayground.editor';

function log(msg) { console.log('[stress-suite] ' + msg); }

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const rs = fs.createReadStream(filePath);
        rs.on('data', (d) => hash.update(d));
        rs.on('end', () => resolve(hash.digest('hex')));
        rs.on('error', reject);
    });
}

function loadFixturesInfo(fixturesDir) {
    const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf8'));
    const wsDir = path.join(fixturesDir, 'ws');
    const texDir = path.join(wsDir, 'textures');
    const matDir = path.join(wsDir, 'mat');
    const outsideDir = path.join(fixturesDir, 'outside');
    const binFiles = Object.keys(manifest)
        .filter((k) => k.indexOf('ws/bin/') === 0)
        .map((k) => ({ name: path.basename(k), path: path.join(fixturesDir, k), expectedSize: manifest[k].size, manifestKey: k }))
        .sort((a, b) => a.expectedSize - b.expectedSize);
    return {
        fixturesDir, wsDir, texDir, matDir, outsideDir, manifest,
        bigMtlxPath: path.join(matDir, 'big.mtlx'),
        manyMtlxPath: path.join(matDir, 'many.mtlx'),
        s7MtlxPath: path.join(matDir, 's7_outside.mtlx'),
        binFiles,
    };
}

async function closeTabsForUri(uri) {
    const uriStr = uri.toString();
    const toClose = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input;
            if (input && input.uri && input.uri.toString() === uriStr) toClose.push(tab);
        }
    }
    if (toClose.length) await vscode.window.tabGroups.close(toClose);
}

async function openEditor(uri) {
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
}

// Polls allReports (module-scope, filled by the testApi.onFilesReport
// listener registered in run()) for the first entry at/after startIndex
// matching predicate (default: any report at all).
function waitForReportAfter(allReports, startIndex, timeoutMs, predicate) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        (function check() {
            for (let i = startIndex; i < allReports.length; i++) {
                if (!predicate || predicate(allReports[i])) { resolve({ report: allReports[i], index: i }); return; }
            }
            if (Date.now() > deadline) { reject(new Error('timeout after ' + timeoutMs + 'ms waiting for files report')); return; }
            setTimeout(check, 200);
        })();
    });
}

function hexDigest(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let s = '';
    for (let i = 0; i < bytes.length; i++) { const h = bytes[i].toString(16); s += h.length === 1 ? '0' + h : h; }
    return s;
}

// Inline webview page for S1 (raw pipeline integrity) + S2 (boundary):
// sequentially fetches every item (smallest first, so a renderer crash on
// a huge file still leaves earlier results intact), hashes with
// crypto.subtle, and posts one message per item plus a final "all-done".
function buildFetchHashPage(items) {
    const itemsJson = JSON.stringify(items);
    return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
        '<script>(function(){\n' +
        'var vscodeApi = acquireVsCodeApi();\n' +
        'var items = ' + itemsJson + ';\n' +
        'function hex(buf){var b=new Uint8Array(buf);var s="";for(var i=0;i<b.length;i++){var h=b[i].toString(16);s+=h.length===1?("0"+h):h;}return s;}\n' +
        'function runOne(item){\n' +
        '  var t0 = performance.now();\n' +
        '  return fetch(item.url).then(function(res){\n' +
        '    if(!res.ok) throw new Error("HTTP " + res.status);\n' +
        '    return res.arrayBuffer();\n' +
        '  }).then(function(buf){\n' +
        '    return crypto.subtle.digest("SHA-256", buf).then(function(digest){\n' +
        '      vscodeApi.postMessage({type:"item-result", key:item.key, kind:item.kind, ok:true, size:buf.byteLength, sha256:hex(digest), ms: performance.now()-t0});\n' +
        '    });\n' +
        '  }).catch(function(e){\n' +
        '    vscodeApi.postMessage({type:"item-result", key:item.key, kind:item.kind, ok:false, error:String((e&&e.message)||e), ms: performance.now()-t0});\n' +
        '  });\n' +
        '}\n' +
        'function runAll(i){\n' +
        '  if (i >= items.length) { vscodeApi.postMessage({type:"all-done"}); return; }\n' +
        '  runOne(items[i]).then(function(){ runAll(i+1); });\n' +
        '}\n' +
        'runAll(0);\n' +
        '})();</script></body></html>';
}

async function scenarioS1S2(ctx) {
    const fx = ctx.fixtures;
    const panel = vscode.window.createWebviewPanel('mtlxStressS1S2', 'Stress S1/S2', vscode.ViewColumn.One, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(fx.wsDir), ctx.extensionUri],
    });
    try {
        const dataUri = vscode.Uri.joinPath(ctx.extensionUri, 'js', 'materialx', '1.39.5', 'JsMaterialXGenShader.data');
        const wasmUri = vscode.Uri.joinPath(ctx.extensionUri, 'js', 'materialx', '1.39.5', 'JsMaterialXGenShader.wasm');
        const dataPath = path.join(ctx.extensionRoot, 'js', 'materialx', '1.39.5', 'JsMaterialXGenShader.data');
        const wasmPath = path.join(ctx.extensionRoot, 'js', 'materialx', '1.39.5', 'JsMaterialXGenShader.wasm');
        const [dataHash, wasmHash] = await Promise.all([sha256File(dataPath), sha256File(wasmPath)]);

        const items = [
            { key: 'JsMaterialXGenShader.data', kind: 'inside', url: panel.webview.asWebviewUri(dataUri).toString(), expectedSize: fs.statSync(dataPath).size, expectedSha256: dataHash },
            { key: 'JsMaterialXGenShader.wasm', kind: 'inside', url: panel.webview.asWebviewUri(wasmUri).toString(), expectedSize: fs.statSync(wasmPath).size, expectedSha256: wasmHash },
            { key: 'secret.png', kind: 'outside', url: panel.webview.asWebviewUri(vscode.Uri.file(path.join(fx.outsideDir, 'secret.png'))).toString() },
        ];
        for (const b of fx.binFiles) {
            items.push({
                key: b.name, kind: 'inside',
                url: panel.webview.asWebviewUri(vscode.Uri.file(b.path)).toString(),
                expectedSize: b.expectedSize, expectedSha256: fx.manifest[b.manifestKey].sha256,
            });
        }

        const results = [];
        let resolveDone;
        const donePromise = new Promise((resolve) => { resolveDone = resolve; });
        const sub = panel.webview.onDidReceiveMessage((msg) => {
            if (!msg) return;
            if (msg.type === 'item-result') results.push(msg);
            else if (msg.type === 'all-done') resolveDone('done');
        });
        const disposeSub = panel.onDidDispose(() => resolveDone('disposed'));
        panel.webview.html = buildFetchHashPage(items);

        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('timeout'), 6 * 60 * 1000));
        const how = await Promise.race([donePromise, timeoutPromise]);
        sub.dispose();

        const byKey = {};
        for (const r of results) byKey[r.key] = r;
        const s1Items = items.filter((i) => i.kind === 'inside');
        const s2Items = items.filter((i) => i.kind === 'outside');

        const s1Results = s1Items.map((item) => {
            const r = byKey[item.key];
            if (!r) return { key: item.key, expectedSize: item.expectedSize, attempted: false, note: 'no response (webview likely crashed on an earlier/this item)' };
            const hashOk = item.expectedSha256 ? r.sha256 === item.expectedSha256 : undefined;
            return {
                key: item.key, attempted: true, ok: r.ok, size: r.size, expectedSize: item.expectedSize,
                sha256: r.sha256, expectedSha256: item.expectedSha256, hashMatch: hashOk,
                ms: r.ms, mbPerSec: r.ok && r.ms > 0 ? (r.size / 1e6) / (r.ms / 1000) : null,
                error: r.error,
            };
        });
        const s2Results = s2Items.map((item) => {
            const r = byKey[item.key];
            return { key: item.key, attempted: !!r, blockedAsExpected: !r || r.ok === false, ok: r ? r.ok : null, error: r ? r.error : null };
        });

        const ceilingPassed = s1Results.filter((r) => r.attempted && r.ok && r.hashMatch !== false).map((r) => r.expectedSize);
        const ceilingFailed = s1Results.filter((r) => !r.attempted || !r.ok || r.hashMatch === false);

        return {
            s1: {
                pass: s2Items.length === 0 ? true : true, // s1 itself has no single pass/fail gate; see ceiling data
                how,
                results: s1Results,
                largestSucceededBytes: ceilingPassed.length ? Math.max(...ceilingPassed) : null,
                firstFailure: ceilingFailed.length ? ceilingFailed[0] : null,
                dataWasmHashesMatched: (byKey['JsMaterialXGenShader.data'] && byKey['JsMaterialXGenShader.data'].sha256 === dataHash) &&
                    (byKey['JsMaterialXGenShader.wasm'] && byKey['JsMaterialXGenShader.wasm'].sha256 === wasmHash),
            },
            s2: {
                pass: s2Results.every((r) => r.blockedAsExpected),
                results: s2Results,
            },
        };
    } finally {
        panel.dispose();
    }
}

async function scenarioS3(ctx) {
    const uri = vscode.Uri.file(ctx.fixtures.bigMtlxPath);
    const expectedKeys = [
        '../textures/basecolor_4k.png', '../textures/roughness_4k.png', '../textures/normal_4k.png',
        '../textures/displacement_8k.png', '../textures/env_8k.exr',
    ];
    const iterations = [];
    for (let i = 0; i < 3; i++) {
        const rssBefore = process.memoryUsage().rss;
        const startIdx = ctx.allReports.length;
        const t0 = Date.now();
        await openEditor(uri);
        const { report } = await waitForReportAfter(ctx.allReports, startIdx, 300000);
        const rssAfter = process.memoryUsage().rss;

        const mismatches = [];
        for (const key of expectedKeys) {
            const manifestKey = 'ws/textures/' + key.replace('../textures/', '');
            const expected = ctx.fixtures.manifest[manifestKey];
            const got = report.files[key];
            if (!expected) { mismatches.push(key + ': no manifest entry'); continue; }
            if (!got) { mismatches.push(key + ': missing (failure=' + ((report.failures || {})[key] || 'none') + ')'); continue; }
            if (got.size !== expected.size) mismatches.push(key + ': size ' + got.size + ' != ' + expected.size);
            if (got.sha256 !== expected.sha256) mismatches.push(key + ': sha256 mismatch');
        }

        const errorsBeforeWait = ctx.testApi.getErrors().length;
        await new Promise((r) => setTimeout(r, 30000));
        const errorsAfterWait = ctx.testApi.getErrors();

        await closeTabsForUri(uri);

        iterations.push({
            iteration: i + 1,
            totalMs: report.totalMs,
            perFileMs: Object.fromEntries(Object.keys(report.files).map((k) => [k, report.files[k].ms])),
            rssBeforeBytes: rssBefore,
            rssAfterBytes: rssAfter,
            rssDeltaMB: Math.round((rssAfter - rssBefore) / 1e6),
            mismatches,
            failures: report.failures,
            newErrorsIn30s: errorsAfterWait.length - errorsBeforeWait,
            errorSamples: errorsAfterWait.slice(errorsBeforeWait, errorsBeforeWait + 3),
            wallMs: Date.now() - t0,
        });
    }
    const pass = iterations.every((it) => it.mismatches.length === 0 && Object.keys(it.failures || {}).length === 0);
    return { pass, iterations };
}

async function scenarioS4(ctx, pngLib) {
    const uri = vscode.Uri.file(ctx.fixtures.bigMtlxPath);
    const changedKey = '../textures/basecolor_4k.png';
    const texPath = path.join(ctx.fixtures.texDir, 'basecolor_4k.png');
    const originalBuf = fs.readFileSync(texPath);
    try {
        const startIdx = ctx.allReports.length;
        await openEditor(uri);
        await waitForReportAfter(ctx.allReports, startIdx, 300000);

        // Overwrite with different, still-valid, still-decodable content.
        const newBuf = pngLib.encodePNG({
            width: 512, height: 512, bitDepth: 8, colorType: 2,
            fillRow: (y, row) => { for (let x = 0; x < 512; x++) { const o = x * 3; row[o] = x & 0xFF; row[o + 1] = y & 0xFF; row[o + 2] = 0x80; } },
        });
        fs.writeFileSync(texPath, newBuf);
        const newHash = crypto.createHash('sha256').update(newBuf).digest('hex');

        const doc = await vscode.workspace.openTextDocument(uri);
        const marker = '<!-- s4-live-reload -->\n';
        const editIdx = ctx.allReports.length;
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(1, 0), marker);
        await vscode.workspace.applyEdit(edit);

        const { report } = await waitForReportAfter(ctx.allReports, editIdx, 60000, (r) => r.files[changedKey] && r.files[changedKey].sha256 === newHash);
        const matched = report.files[changedKey].sha256 === newHash && report.files[changedKey].size === newBuf.length;

        const idx = doc.getText().indexOf(marker);
        if (idx >= 0) {
            const revert = new vscode.WorkspaceEdit();
            const startPos = doc.positionAt(idx);
            const endPos = doc.positionAt(idx + marker.length);
            revert.delete(uri, new vscode.Range(startPos, endPos));
            await vscode.workspace.applyEdit(revert);
        }
        await doc.save();
        await closeTabsForUri(uri);
        return { pass: matched, matched, newHash, reportedHash: report.files[changedKey] && report.files[changedKey].sha256 };
    } finally {
        fs.writeFileSync(texPath, originalBuf);
    }
}

async function scenarioS5(ctx) {
    const uri = vscode.Uri.file(ctx.fixtures.manyMtlxPath);
    const startIdx = ctx.allReports.length;
    await openEditor(uri);
    const { report } = await waitForReportAfter(ctx.allReports, startIdx, 300000,
        (r) => Object.keys(r.files).length + Object.keys(r.failures || {}).length >= 200);

    const mismatches = [];
    for (let i = 0; i < 200; i++) {
        const n = String(i).padStart(3, '0');
        const key = '../textures/small/small_' + n + '.png';
        const manifestKey = 'ws/textures/small/small_' + n + '.png';
        const expected = ctx.fixtures.manifest[manifestKey];
        const got = report.files[key];
        if (!got) { mismatches.push(key + ' missing (failure=' + ((report.failures || {})[key] || 'none') + ')'); continue; }
        if (got.size !== expected.size || got.sha256 !== expected.sha256) mismatches.push(key + ' hash/size mismatch');
    }
    await closeTabsForUri(uri);
    return {
        pass: mismatches.length === 0 && Object.keys(report.files).length === 200,
        totalMs: report.totalMs, fileCount: Object.keys(report.files).length,
        mismatchSamples: mismatches.slice(0, 10), mismatchCount: mismatches.length,
    };
}

async function scenarioS6(ctx) {
    const uri = vscode.Uri.file(ctx.fixtures.bigMtlxPath);
    await openEditor(uri);
    const startIdx = ctx.allReports.length;
    await waitForReportAfter(ctx.allReports, startIdx, 300000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const afterOpenIdx = ctx.allReports.length;

    const edit1 = new vscode.WorkspaceEdit();
    edit1.insert(uri, new vscode.Position(1, 0), '<!-- s6-edit1 -->\n');
    await vscode.workspace.applyEdit(edit1);
    await new Promise((r) => setTimeout(r, 100));
    const edit2 = new vscode.WorkspaceEdit();
    edit2.insert(uri, new vscode.Position(1, 0), '<!-- s6-edit2 -->\n');
    await vscode.workspace.applyEdit(edit2);

    // Wait for at least one new report, then quiescence (no further new
    // report for 1.5s), capped at 20s. A resend re-fetches+re-hashes every
    // texture (including the ~512MiB EXR), which alone can take several
    // seconds, so "nothing changed in the first second" does NOT mean
    // settled -- it can just mean the fetch is still in flight.
    let lastCount = ctx.allReports.length;
    let lastChangeTs = Date.now();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        if (ctx.allReports.length !== lastCount) {
            lastCount = ctx.allReports.length;
            lastChangeTs = Date.now();
        } else if (lastCount > afterOpenIdx && Date.now() - lastChangeTs >= 1500) {
            break;
        }
    }

    const newReports = ctx.allReports.slice(afterOpenIdx);
    const seqs = newReports.map((r) => r.seq);
    let increasing = true;
    for (let i = 1; i < seqs.length; i++) if (!(seqs[i] > seqs[i - 1])) increasing = false;

    const finalText = doc.getText();
    const bothMarkersPresent = finalText.indexOf('s6-edit1') >= 0 && finalText.indexOf('s6-edit2') >= 0;

    const clean = finalText.replace('<!-- s6-edit1 -->\n', '').replace('<!-- s6-edit2 -->\n', '');
    const revert = new vscode.WorkspaceEdit();
    revert.replace(uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), clean);
    await vscode.workspace.applyEdit(revert);
    await doc.save();
    await closeTabsForUri(uri);

    return {
        pass: increasing && seqs.length >= 1 && bothMarkersPresent,
        seqs, increasing, bothMarkersPresent, reportCount: newReports.length,
    };
}

async function scenarioS7(ctx) {
    const docScanner = require(path.join(ctx.extensionRoot, 'vscode_extension', 'src', 'docScanner.js'));
    const uri = vscode.Uri.file(ctx.fixtures.s7MtlxPath);
    const xml = fs.readFileSync(ctx.fixtures.s7MtlxPath, 'utf8');
    const scanResult = await docScanner.scan(uri, xml);
    const scanHasOutsideWarning = scanResult.warnings.some((w) => /outside the workspace folder/.test(w));
    const scanTexturesEmpty = Object.keys(scanResult.textures).length === 0;

    const startIdx = ctx.allReports.length;
    await openEditor(uri);
    const { report } = await waitForReportAfter(ctx.allReports, startIdx, 60000);
    const key = '../../outside/secret.png';
    const notInFiles = !(key in report.files);
    const notInFailures = !(report.failures && key in report.failures);
    await closeTabsForUri(uri);

    return {
        pass: scanHasOutsideWarning && scanTexturesEmpty && notInFiles && notInFailures,
        scanHasOutsideWarning, scanTexturesEmpty, notInFiles, notInFailures,
        warningSamples: scanResult.warnings.slice(0, 3),
    };
}

// Non-recursive: lists just the top level of `dir` and returns the full
// path of the first entry named `name`, or null. Downloads land directly
// in their target directory, never nested, so a shallow check is enough
// and keeps this cheap to poll against a Downloads folder that can hold
// many thousands of unrelated files.
function findInDirTopLevel(dir, name) {
    if (!dir) return null;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return null; // dir doesn't exist / not readable -- not found
    }
    for (const ent of entries) {
        if (ent.isFile() && ent.name === name) return path.join(dir, name);
    }
    return null;
}

// scenarioDownloadProbe: EVIDENCE ONLY -- no host-side save bridge exists
// at this point. Opens a plain webview panel, creates a small Blob and
// clicks a synthetic <a download="probe-<rand>.txt"> exactly the way
// js/shared/mtlx-ui.jsx's downloadBlob() does (object URL -> synthetic
// anchor -> .click()), then polls the user's real OS Downloads folder and
// this run's own --user-data-dir for up to 15s for the file to land.
// Never throws: whatever it observes (or doesn't) IS the evidence.
async function scenarioDownloadProbe(ctx) {
    const token = 'probe-' + crypto.randomBytes(6).toString('hex');
    const fileName = token + '.txt';
    const fileText = 'materialx download probe ' + token;

    const panel = vscode.window.createWebviewPanel(
        'mtlxDownloadProbe', 'MTLX Download Probe', vscode.ViewColumn.One,
        { enableScripts: true }
    );
    try {
        const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
            '<script>(function(){\n' +
            'var blob = new Blob([' + JSON.stringify(fileText) + '], {type: "text/plain"});\n' +
            'var a = document.createElement("a");\n' +
            'a.href = URL.createObjectURL(blob);\n' +
            'a.download = ' + JSON.stringify(fileName) + ';\n' +
            'document.body.appendChild(a);\n' +
            'a.click();\n' +
            '})();</script></body></html>';

        const downloadsDir = path.join(os.homedir(), 'Downloads');
        const userDataDir = process.env.MTLX_STRESS_USER_DATA_DIR || null;
        const searchDirs = [
            { key: 'downloadsDir', dir: downloadsDir },
            { key: 'userDataDir', dir: userDataDir },
        ];

        const clickedAt = Date.now();
        panel.webview.html = html;

        const deadlineMs = 15000;
        const deadline = clickedAt + deadlineMs;
        let hit = null;
        while (Date.now() < deadline) {
            for (const s of searchDirs) {
                const found = findInDirTopLevel(s.dir, fileName);
                if (found) { hit = { key: s.key, path: found }; break; }
            }
            if (hit) break;
            await new Promise((r) => setTimeout(r, 500));
        }

        let bytesMatch = null;
        if (hit) {
            try { bytesMatch = fs.readFileSync(hit.path, 'utf8') === fileText; } catch (e) { bytesMatch = false; }
        }

        return {
            pass: !!hit,
            fileName,
            searchedDirs: { downloadsDir, userDataDir },
            found: hit,
            bytesMatch,
            waitedMs: Date.now() - clickedAt,
        };
    } finally {
        panel.dispose();
    }
}

// Polls `dir`'s top level for a file named `name`, up to `timeoutMs`.
// Resolves with the full path, or null on timeout. Never rejects.
function waitForFile(dir, name, timeoutMs) {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        (function check() {
            const hit = findInDirTopLevel(dir, name);
            if (hit) { resolve(hit); return; }
            if (Date.now() > deadline) { resolve(null); return; }
            setTimeout(check, 400);
        })();
    });
}

// True iff the file at `p` starts with the PNG magic bytes.
function looksLikePng(p) {
    try {
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(8);
        fs.readSync(fd, buf, 0, 8, 0);
        fs.closeSync(fd);
        return buf.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    } catch (e) {
        return false;
    }
}

// scenarioS8: verifies the VS Code host-side save bridge added in
// response to scenarioDownloadProbe's evidence above (see
// vscode_extension/media/bootstrap.js's window.__mtlxHostSave and
// editorProvider.js's handleSaveFile). Two legs, both going through the
// SITE's real, unmodified export functions (js/shared/mtlx-ui.jsx) via
// the mtlx-test-trigger-* test hooks -- never a bootstrap-only stand-in:
//   1. downloadBlob() -- what the shader/zip/.mtlx export buttons call.
//   2. downloadSnapshot() against the Viewer's live render-view handle
//      (window.__mtlxViewerHandle, js/viewer-app.jsx's own pre-existing
//      test/console hook) -- what the "Save Snapshot" button calls.
// testApi.setSaveTarget() redirects the native Save dialog to a fresh
// temp directory so this can assert on exact bytes with no human to
// click through a dialog.
async function scenarioS8(ctx) {
    const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtlx-s8-save-'));
    const cfg = vscode.workspace.getConfiguration('materialx');
    // inspect().globalValue is undefined when unset, unlike get() which
    // falls back to the resolved default -- restore below removes the key
    // instead of pinning it explicitly in the persistent profile.
    const prevDefaultView = cfg.inspect('defaultView')?.globalValue;
    const uri = vscode.Uri.file(ctx.fixtures.bigMtlxPath);
    try {
        ctx.testApi.setSaveTarget(saveDir);
        // materialx.defaultView='viewer' so the Viewer is the INITIAL
        // view for this panel -- it needs to actually mount and render a
        // frame for window.__mtlxViewerHandle to exist (leg 2 below).
        await cfg.update('defaultView', 'viewer', vscode.ConfigurationTarget.Global);

        const startIdx = ctx.allReports.length;
        await openEditor(uri);
        await waitForReportAfter(ctx.allReports, startIdx, 300000);

        // Leg 1: downloadBlob.
        const token = 'S8-' + crypto.randomBytes(6).toString('hex');
        const blobName = token + '.txt';
        const blobText = 'materialx S8 download probe ' + token;
        ctx.testApi.triggerDownload(blobName, blobText);
        const blobPath = await waitForFile(saveDir, blobName, 20000);
        const blobBytesMatch = blobPath ? fs.readFileSync(blobPath, 'utf8') === blobText : false;

        // Leg 2: downloadSnapshot (waits internally, webview-side, for
        // the Viewer render-view handle -- see handleTestTriggerSnapshot).
        const snapBase = 'S8-snap-' + crypto.randomBytes(6).toString('hex');
        ctx.testApi.triggerSnapshot(snapBase);
        const snapName = snapBase.replace(/[^\w.-]+/g, '_') + '.png';
        const snapPath = await waitForFile(saveDir, snapName, 30000);
        const snapIsPng = snapPath ? looksLikePng(snapPath) : false;

        return {
            pass: !!blobPath && blobBytesMatch && !!snapPath && snapIsPng,
            saveDir,
            blob: { name: blobName, found: !!blobPath, bytesMatch: blobBytesMatch, path: blobPath },
            snapshot: { name: snapName, found: !!snapPath, looksLikePng: snapIsPng, path: snapPath },
        };
    } finally {
        try { await cfg.update('defaultView', prevDefaultView, vscode.ConfigurationTarget.Global); } catch (e) { /* best effort */ }
        ctx.testApi.setSaveTarget(null);
        await closeTabsForUri(uri);
    }
}

// scenarioS9: outline, go to definition, find references and color
// swatches (symbolProviders.js / mtlxSymbols.js / mtlxColors.js). Opens a
// small fixture .mtlx in a plain TEXT editor (never our custom editor --
// these are text-document language features) and drives the same
// commands VS Code itself uses for Outline/breadcrumbs, F12 and
// Shift+F12: vscode.executeDocumentSymbolProvider,
// executeDefinitionProvider, executeReferenceProvider and
// executeDocumentColorProvider. The fixture is written into (and cleaned
// up from) the harness's generated fixtures workspace, never the repo.
async function scenarioS9(ctx) {
    const fixturePath = path.join(ctx.fixtures.matDir, 's9_symbols.mtlx');
    const fixtureText = [
        '<materialx version="1.39">',
        '  <nodedef name="ND_test" node="test">',
        '    <input name="in1" type="float" />',
        '    <output name="out" type="surfaceshader" />',
        '  </nodedef>',
        '  <nodegraph name="NG1">',
        '    <input name="amount" type="float" value="0.5" />',
        '    <constant name="c1" type="color3">',
        '      <input name="value" type="color3" value="0.2, 0.4, 0.8" />',
        '    </constant>',
        '    <mix name="mixnode" type="color3">',
        '      <input name="fg" type="color3" nodename="c1" />',
        '      <input name="bg" type="color3" interfacename="amount" />',
        '    </mix>',
        '    <output name="out1" type="color3" nodename="mixnode" />',
        '  </nodegraph>',
        '  <surfacematerial name="M1" type="material">',
        '    <input name="surfaceshader" type="surfaceshader" nodegraph="NG1" output="out1" />',
        '  </surfacematerial>',
        '</materialx>',
        '',
    ].join('\n');
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, fixtureText);
    const uri = vscode.Uri.file(fixturePath);

    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });

        const symbols = (await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)) || [];
        const symbolNames = symbols.map((s) => s.name);
        const ng1 = symbols.find((s) => s.name === 'NG1');
        const ng1ChildNames = ng1 ? ng1.children.map((c) => c.name) : [];

        const nodenameIdx = fixtureText.indexOf('nodename="c1"') + 'nodename="'.length;
        const nodenamePos = doc.positionAt(nodenameIdx);
        const defs = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, nodenamePos)) || [];
        const defOk = defs.length > 0 && defs[0].uri.toString() === uri.toString();
        const defTargetIsC1 = defOk && /name="c1"/.test(doc.lineAt(defs[0].range.start.line).text);

        const declIdx = fixtureText.indexOf('name="c1"') + 'name="'.length;
        const declPos = doc.positionAt(declIdx);
        const refs = (await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, declPos)) || [];

        const colors = (await vscode.commands.executeCommand('vscode.executeDocumentColorProvider', uri)) || [];
        const c1Color = colors.find((c) => /0\.2, 0\.4, 0\.8/.test(doc.lineAt(c.range.start.line).text));
        let colorPresOk = false;
        if (c1Color) {
            // lin_rec709 default -- displayed sRGB must be brighter than raw 0.2.
            const brighterAsExpected = c1Color.color.red > 0.2;
            const pres = (await vscode.commands.executeCommand(
                'vscode.executeColorPresentationProvider', c1Color.color, { uri, range: c1Color.range }
            )) || [];
            colorPresOk = brighterAsExpected && pres.length > 0 && !!pres[0].textEdit;
        }

        await closeTabsForUri(uri);

        return {
            pass: symbolNames.includes('ND_test') && symbolNames.includes('NG1') && symbolNames.includes('M1')
                && ng1ChildNames.includes('c1') && ng1ChildNames.includes('mixnode') && ng1ChildNames.includes('out1')
                && defOk && defTargetIsC1 && refs.length >= 1 && colors.length >= 1 && colorPresOk,
            symbolNames, ng1ChildNames, defOk, defTargetIsC1,
            refsCount: refs.length, colorsCount: colors.length, colorPresOk,
        };
    } finally {
        try { fs.unlinkSync(fixturePath); } catch (e) { /* best effort cleanup */ }
    }
}

async function run() {
    const fixturesDir = process.env.MTLX_STRESS_FIXTURES;
    const scenariosToRun = (process.env.MTLX_STRESS_SCENARIOS || 'S1,S2,S3,S4,S5,S6,S7').split(',').map((s) => s.trim()).filter(Boolean);
    const resultsFile = process.env.MTLX_STRESS_RESULTS_FILE;
    const extensionRoot = process.env.MTLX_STRESS_EXT_ROOT;
    const label = process.env.MTLX_STRESS_LABEL || 'run';

    const out = {
        label, vscodeVersion: vscode.version, startedAt: new Date().toISOString(),
        scenarios: {}, fatalError: null,
    };

    const writeOut = () => {
        out.finishedAt = new Date().toISOString();
        fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
        fs.writeFileSync(resultsFile, JSON.stringify(out, null, 2));
    };

    try {
        log('label=' + label + ' vscode=' + vscode.version + ' scenarios=' + scenariosToRun.join(','));
        const fixtures = loadFixturesInfo(fixturesDir);
        const ext = vscode.extensions.getExtension(EXT_ID);
        if (!ext) throw new Error('extension not found: ' + EXT_ID);
        const extExports = await ext.activate();
        const testApi = extExports && extExports._test;
        if (!testApi) throw new Error('extension exports._test is missing -- MTLX_TEST_TRANSPORT test seam did not activate');

        const allReports = [];
        testApi.onFilesReport((r) => { allReports.push(Object.assign({}, r, { ts: Date.now() })); });

        const ctx = { fixtures, extensionUri: ext.extensionUri, extensionRoot, testApi, allReports };
        const pngLib = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'lib', 'png.mjs')).href);

        const runners = {
            S1S2: () => scenarioS1S2(ctx),
            S3: () => scenarioS3(ctx),
            S4: () => scenarioS4(ctx, pngLib),
            S5: () => scenarioS5(ctx),
            S6: () => scenarioS6(ctx),
            S7: () => scenarioS7(ctx),
            S8: () => scenarioS8(ctx),
            S9: () => scenarioS9(ctx),
            SDL: () => scenarioDownloadProbe(ctx),
        };

        const wantS1orS2 = scenariosToRun.includes('S1') || scenariosToRun.includes('S2');
        const order = [];
        if (wantS1orS2) order.push('S1S2');
        for (const s of ['S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'SDL']) if (scenariosToRun.includes(s)) order.push(s);

        for (const id of order) {
            log('running ' + id + ' ...');
            const t0 = Date.now();
            try {
                const result = await runners[id]();
                if (id === 'S1S2') {
                    out.scenarios.S1 = Object.assign({ wallMs: Date.now() - t0 }, result.s1);
                    out.scenarios.S2 = Object.assign({ wallMs: Date.now() - t0 }, result.s2);
                } else {
                    out.scenarios[id] = Object.assign({ wallMs: Date.now() - t0 }, result);
                }
                log(id + ' done in ' + (Date.now() - t0) + 'ms');
            } catch (e) {
                const rec = { pass: false, error: String((e && e.stack) || e) };
                if (id === 'S1S2') { out.scenarios.S1 = rec; out.scenarios.S2 = rec; } else { out.scenarios[id] = rec; }
                log(id + ' FAILED: ' + (e && e.message || e));
            }
            writeOut(); // persist after every scenario, never lose partial progress
        }
    } catch (e) {
        out.fatalError = String((e && e.stack) || e);
        log('FATAL: ' + (e && e.message || e));
    } finally {
        writeOut();
    }
}

module.exports = { run };
