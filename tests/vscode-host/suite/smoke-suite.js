// smoke-suite.js: extensionTestsPath for the packaged-extension smoke run
// (tests/vscode-host/smoke.mjs). Runs inside a real Extension Development
// Host whose extensionDevelopmentPath is a STAGED/unzipped package, not
// the repo -- every check here proves the packaged files work, not the
// dev tree. Plain CommonJS, exports run() returning a Promise, no mocha.
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const EXT_ID = 'MaterialXPlayground.materialx-playground';
const VIEW_TYPE = 'materialxPlayground.editor';

function log(msg) { console.log('[smoke-suite] ' + msg); }

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const rs = fs.createReadStream(filePath);
        rs.on('data', (d) => hash.update(d));
        rs.on('end', () => resolve(hash.digest('hex')));
        rs.on('error', reject);
    });
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

// Same idea as closeTabsForUri, for a document-less WebviewPanel (the
// docs panel has no uri) -- matched by its createWebviewPanel viewType.
async function closeTabsForViewType(viewType) {
    const toClose = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input;
            if (input && input.viewType === viewType) toClose.push(tab);
        }
    }
    if (toClose.length) await vscode.window.tabGroups.close(toClose);
}

async function openEditor(uri) {
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
}

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

function waitForFile(dir, name, timeoutMs) {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        (function check() {
            let hit = null;
            try {
                for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (ent.isFile() && ent.name === name) { hit = path.join(dir, name); break; }
                }
            } catch (e) { /* dir not there yet */ }
            if (hit) { resolve(hit); return; }
            if (Date.now() > deadline) { resolve(null); return; }
            setTimeout(check, 300);
        })();
    });
}

function looksLikePng(p) {
    try {
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(8);
        fs.readSync(fd, buf, 0, 8, 0);
        fs.closeSync(fd);
        return buf.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && fs.statSync(p).size > 8;
    } catch (e) {
        return false;
    }
}

// waitForDiagnostics: polls vscode.languages.getDiagnostics(uri) -- the
// public, source-agnostic API -- rather than reaching into extension.js's
// private diagnosticCollection, so this proves the real diagnostics the
// user would see in Problems, however they got produced.
function waitForDiagnostics(uri, timeoutMs, predicate) {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        (function check() {
            const diags = vscode.languages.getDiagnostics(uri);
            if (!predicate || predicate(diags)) { resolve(diags); return; }
            if (Date.now() > deadline) { resolve(diags); return; }
            setTimeout(check, 300);
        })();
    });
}

// Scenario: editor end-to-end + viewer rendered + save bridge, all
// sharing one custom-editor session on the small main.mtlx fixture (one
// VS Code boot, one panel) -- cheap enough for a smoke run while still
// exercising the real direct-texture-read transport, the Viewer's actual
// render loop and the save-bridge test hooks against packaged code.
async function scenarioEditorSession(ctx) {
    const fx = ctx.fixtures;
    const uri = vscode.Uri.file(fx.mainMtlxPath);
    const expectedKeys = ['../textures/basecolor.png', '../textures/roughness.png', '../textures/env.exr'];
    // NEW key: an explicit materialxPlayground.defaultView left over from a
    // prior run would otherwise win over the deprecated materialx.* key.
    const cfg = vscode.workspace.getConfiguration('materialxPlayground');
    const prevDefaultView = cfg.inspect('defaultView')?.globalValue;
    const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtlx-smoke-save-'));
    const out = { editorE2E: null, viewerRendered: null, saveBridge: null };

    try {
        await cfg.update('defaultView', 'viewer', vscode.ConfigurationTarget.Global);
        ctx.testApi.setSaveTarget(saveDir);

        const errorsBefore = ctx.testApi.getErrors().length;
        const startIdx = ctx.allReports.length;
        await openEditor(uri);
        const { report } = await waitForReportAfter(ctx.allReports, startIdx, 60000);

        const mismatches = [];
        for (const key of expectedKeys) {
            const manifestKey = 'ws/textures/' + key.replace('../textures/', '');
            const expected = fx.manifest[manifestKey];
            const got = report.files[key];
            if (!expected) { mismatches.push(key + ': no manifest entry'); continue; }
            if (!got) { mismatches.push(key + ': missing (failure=' + ((report.failures || {})[key] || 'none') + ')'); continue; }
            if (got.size !== expected.size) mismatches.push(key + ': size ' + got.size + ' != ' + expected.size);
            if (got.sha256 !== expected.sha256) mismatches.push(key + ': sha256 mismatch');
        }

        // Generous 20s window for forwarded webview errors, per the plan --
        // CI renders with a software GPU, so give it room to settle.
        await new Promise((r) => setTimeout(r, 20000));
        const newErrors = ctx.testApi.getErrors().length - errorsBefore;
        out.editorE2E = { pass: mismatches.length === 0 && newErrors === 0, mismatches, newErrors, fileCount: Object.keys(report.files).length };

        // Leg 1 of the save bridge: downloadBlob().
        const token = 'SMOKE-' + crypto.randomBytes(6).toString('hex');
        const blobName = token + '.txt';
        const blobText = 'materialx smoke save-bridge probe ' + token;
        ctx.testApi.triggerDownload(blobName, blobText);
        const blobPath = await waitForFile(saveDir, blobName, 20000);
        const blobBytesMatch = blobPath ? fs.readFileSync(blobPath, 'utf8') === blobText : false;

        // Leg 2: downloadSnapshot() against the Viewer's live render-view
        // handle -- doubles as proof the Viewer actually rendered a frame.
        const snapBase = 'SMOKE-snap-' + crypto.randomBytes(6).toString('hex');
        ctx.testApi.triggerSnapshot(snapBase);
        const snapName = snapBase.replace(/[^\w.-]+/g, '_') + '.png';
        const snapPath = await waitForFile(saveDir, snapName, 30000);
        const snapIsPng = snapPath ? looksLikePng(snapPath) : false;

        out.viewerRendered = { pass: snapIsPng, snapPath, snapIsPng };
        out.saveBridge = {
            pass: !!blobPath && blobBytesMatch && !!snapPath && snapIsPng,
            blob: { found: !!blobPath, bytesMatch: blobBytesMatch },
            snapshot: { found: !!snapPath, looksLikePng: snapIsPng },
        };
    } finally {
        // undefined removes the key instead of writing back a resolved
        // default, so an unset key stays unset in the persistent profile.
        try { await cfg.update('defaultView', prevDefaultView, vscode.ConfigurationTarget.Global); } catch (e) { /* best effort */ }
        ctx.testApi.setSaveTarget(null);
        await closeTabsForUri(uri);
    }
    return out;
}

// Scenario: validation worker -- opens a fixture with a semantic-only
// error (well-formed XML, wrong input type) and waits for a diagnostic
// from the deeper (tier 2) pass, proving the worker and the bundled
// MaterialX WASM both loaded from the packaged extension.
async function scenarioValidationWorker(ctx) {
    const uri = vscode.Uri.file(ctx.fixtures.validationMtlxPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    try {
        const diags = await waitForDiagnostics(uri, 20000, (d) => d.length > 0);
        return { pass: diags.length > 0, count: diags.length, messages: diags.slice(0, 3).map((d) => d.message) };
    } finally {
        await closeTabsForUri(uri);
    }
}

// Scenario: hover docs -- vscode.executeHoverProvider on a node category,
// checking for text specDocs.js only appends when it actually resolved a
// bundled spec entry (the "Official Specification" link, plus a
// non-trivial description), not just the always-present command link.
async function scenarioHoverDocs(ctx) {
    const uri = vscode.Uri.file(ctx.fixtures.hoverMtlxPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    try {
        const text = doc.getText();
        const idx = text.indexOf('image');
        const pos = doc.positionAt(idx + 1); // inside the tag-name token
        const hovers = (await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, pos)) || [];
        const md = hovers.length && hovers[0].contents.length ? String(hovers[0].contents[0].value || '') : '';
        const pass = hovers.length > 0 && md.length > 100 && /Official Specification/.test(md);
        return { pass, hoverCount: hovers.length, mdLength: md.length };
    } finally {
        await closeTabsForUri(uri);
    }
}

// Scenario: language features -- outline, go to definition, find
// references and color swatches, same commands VS Code's own
// Outline/breadcrumbs, F12 and Shift+F12 use. Writes its own small text
// fixture (never the repo), cleaned up after.
async function scenarioLanguageFeatures(ctx) {
    const fixturePath = path.join(ctx.fixtures.matDir, 'symbols.mtlx');
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
        const defs = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, doc.positionAt(nodenameIdx))) || [];
        const defOk = defs.length > 0 && defs[0].uri.toString() === uri.toString();

        const declIdx = fixtureText.indexOf('name="c1"') + 'name="'.length;
        const refs = (await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, doc.positionAt(declIdx))) || [];

        const colors = (await vscode.commands.executeCommand('vscode.executeDocumentColorProvider', uri)) || [];

        return {
            pass: symbolNames.includes('ND_test') && symbolNames.includes('NG1') && symbolNames.includes('M1')
                && ng1ChildNames.includes('c1') && ng1ChildNames.includes('mixnode') && defOk && refs.length >= 1 && colors.length >= 1,
            symbolNames, ng1ChildNames, defOk, refsCount: refs.length, colorsCount: colors.length,
        };
    } finally {
        await closeTabsForUri(uri);
        try { fs.unlinkSync(fixturePath); } catch (e) { /* best effort cleanup */ }
    }
}

// Scenario: auto-complete -- vscode.executeCompletionItemProvider against
// the PACKAGED completionProvider.js/mtlxCompletions.js, at a handful of
// real positions inside one small fixture: after '<' (node categories +
// structural elements), a type="" attribute value, a colorspace=""
// attribute value, and an <input name=""> value narrowed to the enclosing
// node's own inputs. Writes its own small text fixture (never the repo),
// cleaned up after -- same pattern scenarioLanguageFeatures uses above.
async function scenarioCompletion(ctx) {
    const fixturePath = path.join(ctx.fixtures.matDir, 'completion.mtlx');
    const fixtureText = [
        '<?xml version="1.0"?>',
        '<materialx version="1.39" colorspace="lin_rec709">',
        '  <standard_surface name="SR1" type="surfaceshader">',
        '    <input name="base_color" type="color3" value="0.8, 0.8, 0.8" />',
        '  </standard_surface>',
        '  <surfacematerial name="M1" type="material">',
        '    <input name="surfaceshader" type="surfaceshader" nodename="SR1" />',
        '  </surfacematerial>',
        '</materialx>',
        '',
    ].join('\n');
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, fixtureText);
    const uri = vscode.Uri.file(fixturePath);

    // Unwraps the vscode.executeCompletionItemProvider result, which is a
    // CompletionList ({ items: [...] }) on recent VS Code, not a plain array.
    const itemsOf = (result) => (Array.isArray(result) ? result : (result && result.items) || []);
    const labelsOf = (result) => itemsOf(result).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));

    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });

        // After '<' -- cursor placed right after "<s" of "<standard_surface"
        // (a real position inside already-typed text, same as the unit
        // tests' approach): node categories + structural elements.
        const tagIdx = fixtureText.indexOf('<standard_surface') + 2;
        const tagResult = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, doc.positionAt(tagIdx));
        const tagLabels = labelsOf(tagResult);

        // type="" attribute value, on the standard_surface tag.
        const typeIdx = fixtureText.indexOf('type="surfaceshader"') + 'type="'.length;
        const typeResult = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, doc.positionAt(typeIdx));
        const typeLabels = labelsOf(typeResult);

        // colorspace="" attribute value, on the materialx root.
        const csIdx = fixtureText.indexOf('colorspace="lin_rec709"') + 'colorspace="'.length;
        const csResult = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, doc.positionAt(csIdx));
        const csLabels = labelsOf(csResult);

        // <input name=""> value, narrowed to standard_surface's own inputs.
        const nameIdx = fixtureText.indexOf('name="base_color"') + 'name="'.length;
        const nameResult = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, doc.positionAt(nameIdx));
        const nameLabels = labelsOf(nameResult);

        // Attribute-NAME completion, on a node instance's own open tag
        // (space right after the tag name): the fixture's standard_surface
        // already has name=/type= set, so those are correctly excluded
        // here (see the "<multiply n" unit test in vscode-attribute-
        // schema.test.mjs for the not-yet-present case); this position
        // instead proves 'nodedef'/'inherit' are offered (node-instance
        // attributes) and input/token-only UI attributes like uivisible
        // are NOT.
        const nodeAttrIdx = fixtureText.indexOf('<standard_surface') + '<standard_surface'.length + 1;
        const nodeAttrResult = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, doc.positionAt(nodeAttrIdx));
        const nodeAttrLabels = labelsOf(nodeAttrResult);

        // Attribute-NAME completion, on a nodedef's own <input> child:
        // must offer nodedef-input-only attributes (uivisible, uimin)
        // that a node-instance input does not get.
        const nodedefFixtureText = [
            '<?xml version="1.0"?>',
            '<materialx version="1.39">',
            '  <nodedef name="ND_custom" node="custom">',
            '    <input name="amount" type="float" value="1.0" />',
            '  </nodedef>',
            '</materialx>',
            '',
        ].join('\n');
        const nodedefFixturePath = path.join(ctx.fixtures.matDir, 'completion-nodedef.mtlx');
        fs.writeFileSync(nodedefFixturePath, nodedefFixtureText);
        const nodedefUri = vscode.Uri.file(nodedefFixturePath);
        let nodedefInputAttrLabels = [];
        try {
            const nodedefDoc = await vscode.workspace.openTextDocument(nodedefUri);
            await vscode.window.showTextDocument(nodedefDoc, { preview: false });
            const nodedefInputIdx = nodedefFixtureText.indexOf('<input name="amount"') + '<input name="amount"'.length + 1;
            const nodedefInputResult = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', nodedefUri, nodedefDoc.positionAt(nodedefInputIdx));
            nodedefInputAttrLabels = labelsOf(nodedefInputResult);
        } finally {
            await closeTabsForUri(nodedefUri);
            try { fs.unlinkSync(nodedefFixturePath); } catch (e) { /* best effort cleanup */ }
        }

        const pass = tagLabels.includes('standard_surface') && tagLabels.includes('nodegraph')
            && typeLabels.includes('surfaceshader') && typeLabels.includes('color3')
            && csLabels.includes('lin_rec709') && csLabels.includes('srgb_texture')
            && nameLabels.includes('base_color') && nameLabels.includes('specular_roughness')
            && nodeAttrLabels.includes('nodedef') && nodeAttrLabels.includes('inherit') && !nodeAttrLabels.includes('uivisible')
            && nodedefInputAttrLabels.includes('uivisible') && nodedefInputAttrLabels.includes('uimin');

        return {
            pass,
            tagLabelsCount: tagLabels.length,
            typeLabelsCount: typeLabels.length,
            csLabelsCount: csLabels.length,
            nameLabelsCount: nameLabels.length,
            nodeAttrLabelsCount: nodeAttrLabels.length,
            nodedefInputAttrLabelsCount: nodedefInputAttrLabels.length,
        };
    } finally {
        await closeTabsForUri(uri);
        try { fs.unlinkSync(fixturePath); } catch (e) { /* best effort cleanup */ }
    }
}

// Scenario: boundary -- a texture reference outside the workspace folder
// is scanned with a warning and never fetched, reusing docScanner.js from
// the PACKAGED extension (ctx.extensionRoot points at the staged dir).
async function scenarioBoundary(ctx) {
    const docScanner = require(path.join(ctx.extensionRoot, 'vscode_extension', 'src', 'docScanner.js'));
    const uri = vscode.Uri.file(ctx.fixtures.outsideMtlxPath);
    const xml = fs.readFileSync(ctx.fixtures.outsideMtlxPath, 'utf8');
    const scanResult = await docScanner.scan(uri, xml);
    const scanHasOutsideWarning = scanResult.warnings.some((w) => /outside the workspace folder/.test(w));

    const startIdx = ctx.allReports.length;
    await openEditor(uri);
    const { report } = await waitForReportAfter(ctx.allReports, startIdx, 20000);
    const key = '../../outside/secret.png';
    const notInFiles = !(key in report.files);
    const notInFailures = !(report.failures && key in report.failures);
    await closeTabsForUri(uri);

    return { pass: scanHasOutsideWarning && notInFiles && notInFailures, scanHasOutsideWarning, notInFiles, notInFailures };
}

// Scenario: docs panel -- materialxPlayground.openDocs opens the
// document-less "MaterialX: Node Documentation" webview, which loads the
// WASM (docs-app.jsx's own getMxEnv() warm-up) through the same webview
// resource pipeline as the custom editor, with no fetch bridge. Proves
// the panel boots clean (no forwarded 'mtlx-error') now that
// media/bootstrap.js no longer intercepts window.fetch for it.
// Scenario: settingsFallback -- proves the materialxPlayground.* /
// deprecated materialx.* rename (settings.js's resolveSetting(), wired up
// through settingsHost.js's getSetting()) behaves as documented against a
// PACKAGED extension: setting only the old key is picked up, and setting
// the new key on top of it wins. Uses ctx.testApi.getSetting() (the
// test-mode-only seam in editorProvider.js) rather than reaching into
// extension internals, so this exercises the exact same resolver real
// code paths (extension.js/editorProvider.js) call.
async function scenarioSettingsFallback(ctx) {
    const key = 'defaultView';
    const oldSection = vscode.workspace.getConfiguration('materialx');
    const newSection = vscode.workspace.getConfiguration('materialxPlayground');
    // inspect().globalValue is undefined when unset, unlike get() which
    // falls back to the resolved default -- captured so restore can remove
    // the key instead of pinning it explicitly.
    const prevOld = oldSection.inspect(key)?.globalValue;
    const prevNew = newSection.inspect(key)?.globalValue;

    try {
        // Old key set, new key left alone: effective value follows the
        // deprecated materialx.defaultView.
        await vscode.workspace.getConfiguration('materialx').update(key, 'viewer', vscode.ConfigurationTarget.Global);
        const afterOldOnly = ctx.testApi.getSetting(key);

        // New key set on top: materialxPlayground.defaultView must win
        // even though the old key is still explicitly 'viewer'.
        await vscode.workspace.getConfiguration('materialxPlayground').update(key, 'graph', vscode.ConfigurationTarget.Global);
        const afterBoth = ctx.testApi.getSetting(key);

        return {
            pass: afterOldOnly === 'viewer' && afterBoth === 'graph',
            afterOldOnly, afterBoth,
        };
    } finally {
        try { await vscode.workspace.getConfiguration('materialxPlayground').update(key, prevNew, vscode.ConfigurationTarget.Global); } catch (e) { /* best effort */ }
        try { await vscode.workspace.getConfiguration('materialx').update(key, prevOld, vscode.ConfigurationTarget.Global); } catch (e) { /* best effort */ }
    }
}

// Scenario: sceneAutoOpen -- proves materialxPlayground.autoOpenSceneViewer
// (extension.js's maybeAutoOpenSceneText/maybeAutoOpenSceneTab) against a
// PACKAGED extension: a .usda opened as a real text editor gets the scene
// viewer opened BESIDE it (text half, onDidChangeActiveTextEditor); a
// .usdz VS Code shows as a binary placeholder gets that tab REPLACED by
// the scene viewer (binary half, tabGroups.onDidChangeTabs); and with the
// setting off, neither happens.
async function scenarioSceneAutoOpen(ctx) {
    const SCENE_VIEW_TYPE = 'materialxPlayground.sceneViewer';
    const cfg = vscode.workspace.getConfiguration('materialxPlayground');
    const prevSetting = cfg.inspect('autoOpenSceneViewer')?.globalValue;
    const textUri = vscode.Uri.file(ctx.fixtures.autoOpenUsdaPath);
    const binUri = vscode.Uri.file(ctx.fixtures.autoOpenUsdzPath);

    const sceneTabFor = (uri) => {
        for (const g of vscode.window.tabGroups.all) {
            for (const t of g.tabs) {
                if (t.input instanceof vscode.TabInputCustom && t.input.viewType === SCENE_VIEW_TYPE
                    && t.input.uri.toString() === uri.toString()) return t;
            }
        }
        return null;
    };
    const tabsFor = (uri) => {
        const out = [];
        for (const g of vscode.window.tabGroups.all) {
            for (const t of g.tabs) {
                if (t.input && t.input.uri && t.input.uri.toString() === uri.toString()) out.push(t);
            }
        }
        return out;
    };

    const out = { textOpen: null, binaryOpen: null, offNoOpen: null };
    try {
        await cfg.update('autoOpenSceneViewer', true, vscode.ConfigurationTarget.Global);

        // TEXT half.
        const textDoc = await vscode.workspace.openTextDocument(textUri);
        await vscode.window.showTextDocument(textDoc, { preview: false });
        const sceneTab = await waitForValue(() => sceneTabFor(textUri), 20000);
        out.textOpen = { pass: !!sceneTab, tabCount: tabsFor(textUri).length };
        await closeTabsForUri(textUri);

        // BINARY half.
        await vscode.commands.executeCommand('vscode.open', binUri);
        const replaced = await waitForValue(() => {
            const tabs = tabsFor(binUri);
            return tabs.length === 1 && tabs[0].input instanceof vscode.TabInputCustom
                && tabs[0].input.viewType === SCENE_VIEW_TYPE ? tabs[0] : null;
        }, 20000);
        out.binaryOpen = { pass: !!replaced, tabCount: tabsFor(binUri).length };
        await closeTabsForUri(binUri);

        // OFF: the setting disabled must suppress both halves. Re-probes
        // the text case only -- it's the cheaper of the two and exercises
        // the same getSetting() gate the binary half shares.
        await cfg.update('autoOpenSceneViewer', false, vscode.ConfigurationTarget.Global);
        const textDoc2 = await vscode.workspace.openTextDocument(textUri);
        await vscode.window.showTextDocument(textDoc2, { preview: false });
        await new Promise((r) => setTimeout(r, 3000));
        out.offNoOpen = { pass: !sceneTabFor(textUri) };
        await closeTabsForUri(textUri);

        return { pass: out.textOpen.pass && out.binaryOpen.pass && out.offNoOpen.pass, ...out };
    } finally {
        try { await cfg.update('autoOpenSceneViewer', prevSetting, vscode.ConfigurationTarget.Global); } catch (e) { /* best effort */ }
        await closeTabsForUri(textUri);
        await closeTabsForUri(binUri);
    }
}

async function scenarioDocsPanel(ctx) {
    const errorsBefore = ctx.testApi.getErrors().length;
    await vscode.commands.executeCommand('materialxPlayground.openDocs');
    await new Promise((r) => setTimeout(r, 20000));
    const newErrors = ctx.testApi.getErrors().length - errorsBefore;
    await closeTabsForViewType('materialxPlayground.docs');
    return { pass: newErrors === 0, newErrors };
}

function waitForValue(getter, timeoutMs) {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        (function check() {
            const value = getter();
            if (value) { resolve(value); return; }
            if (Date.now() > deadline) { resolve(null); return; }
            setTimeout(check, 250);
        })();
    });
}

// Scenario: USD Scene Viewer -- materialxPlayground.openScene on a root
// layer whose sublayer and texture live in sibling folders (`..` refs), so
// the host must collect the file set and the USD worker must boot inside
// the real webview. Then a probe graph save must be refused, leaving the
// USD files untouched.
async function scenarioUsdScene(ctx) {
    const rootPath = ctx.fixtures.usdRootPath;
    const geoPath = path.join(path.dirname(path.dirname(rootPath)), 'layers', 'geo.usda');
    const uri = vscode.Uri.file(rootPath);
    const rootBefore = fs.readFileSync(rootPath);
    const geoBefore = fs.readFileSync(geoPath);
    const errorsBefore = ctx.testApi.getErrors().length;
    const reportStart = ctx.sceneReports.length;
    const saveStart = ctx.graphSaves.length;
    try {
        await vscode.commands.executeCommand('materialxPlayground.openScene', uri);
        const report = await waitForValue(() => ctx.sceneReports.slice(reportStart).find((r) => r && (r.status === 'rendered' || r.status === 'error')), 120000);
        ctx.testApi.triggerSceneGraphSave('<?xml version="1.0"?>\n<materialx version="1.39">\n</materialx>\n');
        const save = await waitForValue(() => ctx.graphSaves[saveStart], 20000);
        const untouched = fs.readFileSync(rootPath).equals(rootBefore) && fs.readFileSync(geoPath).equals(geoBefore);
        const newErrors = ctx.testApi.getErrors().slice(errorsBefore);
        const stageOk = !!report && report.status === 'rendered' && report.files >= 3 && report.meshes >= 1 && report.materials >= 1 && report.errors === 0;
        const refused = !!save && save.ok === false && /USD file/.test(save.error || '');
        return {
            pass: stageOk && refused && untouched && newErrors.length === 0,
            report, save, untouched, newErrors: newErrors.slice(0, 5),
        };
    } finally {
        await closeTabsForUri(uri);
    }
}

// Scenario: USD Scene Viewer material preview -- opens the same stage, then
// double-clicks the viewport centre (the card) through the test seam and
// waits for the material panel's read-only node graph to finish loading.
// The 3D column must show the VS Code fallback, never a spinner.
async function scenarioUsdMaterialPreview(ctx) {
    const uri = vscode.Uri.file(ctx.fixtures.usdMtlxRootPath);
    const errorsBefore = ctx.testApi.getErrors().length;
    const reportStart = ctx.sceneReports.length;
    const previewStart = ctx.previewReports.length;
    try {
        await vscode.commands.executeCommand('materialxPlayground.openScene', uri);
        const scene = await waitForValue(() => ctx.sceneReports.slice(reportStart).find((r) => r && (r.status === 'rendered' || r.status === 'error')), 120000);
        if (!scene || scene.status !== 'rendered') return { pass: false, scene };
        // One frame of slack so frameAll has placed the card under the centre.
        await new Promise((r) => setTimeout(r, 1500));
        ctx.testApi.triggerSceneMaterialPreview(45000);
        const preview = await waitForValue(() => ctx.previewReports[previewStart], 60000);
        const newErrors = ctx.testApi.getErrors().slice(errorsBefore);
        const graphOk = !!preview && preview.panel && !preview.panelHidden && preview.nodes > 0
            && !preview.depsSpinner && !preview.graphLoading;
        const fallbackOk = !!preview && preview.previewUnavailable;
        return {
            pass: graphOk && fallbackOk && newErrors.length === 0,
            graphOk, fallbackOk, preview, newErrors: newErrors.slice(0, 5),
        };
    } finally {
        await closeTabsForUri(uri);
    }
}

// Scenario: materialxPlayground.newFromExample, called with explicit
// (exampleId, targetFolderUri) args to skip the QuickPick/folder-picker
// UI. Proves a byte-for-byte copy from the PACKAGED exampleCatalog.js.
async function scenarioNewFromExample(ctx) {
    const catalog = require(path.join(ctx.extensionRoot, 'vscode_extension', 'src', 'exampleCatalog.js'));
    const cases = [
        { id: 'example-standard-surface-gold', kind: 'singleFile' },
        { id: 'playground-motley-patchwork-rug', kind: 'textured' },
    ];

    const out = {};
    for (const { id, kind } of cases) {
        const example = catalog.getExample(id);
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtlx-smoke-newfromexample-'));
        const targetUri = vscode.Uri.file(tmpDir);
        const errorsBefore = ctx.testApi.getErrors().length;
        let newMtlxUri = null;

        try {
            await vscode.commands.executeCommand('materialxPlayground.newFromExample', id, targetUri);

            // Generous window for the custom editor opened by the command
            // (materialxPlayground.open) to boot and forward any errors.
            await new Promise((r) => setTimeout(r, 10000));
            const newErrors = ctx.testApi.getErrors().length - errorsBefore;

            const mismatches = [];
            for (const f of example.files) {
                const srcAbs = path.join(ctx.extensionRoot, ...f.from.split('/'));
                const destAbs = example.hasTextures
                    ? path.join(tmpDir, example.destName, ...f.rel.split('/'))
                    : path.join(tmpDir, example.destName + '.mtlx');
                if (f === example.files[0]) newMtlxUri = vscode.Uri.file(destAbs);
                if (!fs.existsSync(destAbs)) { mismatches.push(f.rel + ': missing at ' + destAbs); continue; }
                const srcHash = await sha256File(srcAbs);
                const destHash = await sha256File(destAbs);
                if (srcHash !== destHash) mismatches.push(f.rel + ': sha256 mismatch');
            }

            const errorSample = ctx.testApi.getErrors().slice(errorsBefore, errorsBefore + 3);
            out[kind] = { pass: mismatches.length === 0 && newErrors === 0, id, mismatches, newErrors, errorSample, fileCount: example.files.length };
        } finally {
            if (newMtlxUri) await closeTabsForUri(newMtlxUri);
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
        }
    }

    return { pass: out.singleFile.pass && out.textured.pass, singleFile: out.singleFile, textured: out.textured };
}

async function run() {
    const fixturesDir = process.env.MTLX_SMOKE_FIXTURES;
    const resultsFile = process.env.MTLX_SMOKE_RESULTS_FILE;
    const extensionRoot = process.env.MTLX_SMOKE_EXT_ROOT;

    const out = { vscodeVersion: vscode.version, startedAt: new Date().toISOString(), scenarios: {}, fatalError: null };
    const writeOut = () => {
        out.finishedAt = new Date().toISOString();
        fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
        fs.writeFileSync(resultsFile, JSON.stringify(out, null, 2));
    };

    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf8'));
        const wsDir = path.join(fixturesDir, 'ws');
        const fixtures = {
            manifest,
            mainMtlxPath: path.join(wsDir, 'mat', 'main.mtlx'),
            outsideMtlxPath: path.join(wsDir, 'mat', 'outside_ref.mtlx'),
            validationMtlxPath: path.join(wsDir, 'mat', 'validation_error.mtlx'),
            hoverMtlxPath: path.join(wsDir, 'mat', 'hover.mtlx'),
            matDir: path.join(wsDir, 'mat'),
            usdRootPath: path.join(wsDir, 'usdscene', 'scene', 'root.usda'),
            usdMtlxRootPath: path.join(wsDir, 'usdmtlx', 'scene', 'mtlx_card.usda'),
            autoOpenUsdaPath: path.join(wsDir, 'usdautoopen', 'scene.usda'),
            autoOpenUsdzPath: path.join(wsDir, 'usdautoopen', 'scene.usdz'),
        };

        log('activating ' + EXT_ID + ' ...');
        const ext = vscode.extensions.getExtension(EXT_ID);
        if (!ext) throw new Error('extension not found: ' + EXT_ID + ' (is the staged/extension-dir folder correct?)');
        const extExports = await ext.activate();
        const testApi = extExports && extExports._test;
        out.scenarios.activation = { pass: !!testApi, extensionActive: ext.isActive, hasTestApi: !!testApi };
        writeOut();
        if (!testApi) throw new Error('extension exports._test is missing -- MTLX_TEST_TRANSPORT test seam did not activate');

        const allReports = [];
        testApi.onFilesReport((r) => { allReports.push(Object.assign({}, r, { ts: Date.now() })); });
        const sceneReports = [];
        const graphSaves = [];
        testApi.onSceneReport((r) => { sceneReports.push(r); });
        testApi.onGraphSaveResult((r) => { graphSaves.push(r); });
        const previewReports = [];
        testApi.onMaterialPreviewReport((r) => { previewReports.push(r); });
        const ctx = { fixtures, extensionUri: ext.extensionUri, extensionRoot, testApi, allReports, sceneReports, graphSaves, previewReports };

        const editorSession = await scenarioEditorSession(ctx);
        out.scenarios.editorE2E = editorSession.editorE2E;
        out.scenarios.viewerRendered = editorSession.viewerRendered;
        out.scenarios.saveBridge = editorSession.saveBridge;
        writeOut();

        out.scenarios.validationWorker = await scenarioValidationWorker(ctx);
        writeOut();

        out.scenarios.hoverDocs = await scenarioHoverDocs(ctx);
        writeOut();

        out.scenarios.languageFeatures = await scenarioLanguageFeatures(ctx);
        writeOut();

        out.scenarios.completion = await scenarioCompletion(ctx);
        writeOut();

        out.scenarios.boundary = await scenarioBoundary(ctx);
        writeOut();

        out.scenarios.settingsFallback = await scenarioSettingsFallback(ctx);
        writeOut();

        out.scenarios.docsPanel = await scenarioDocsPanel(ctx);
        writeOut();

        out.scenarios.sceneAutoOpen = await scenarioSceneAutoOpen(ctx);
        writeOut();

        out.scenarios.usdScene = await scenarioUsdScene(ctx);
        writeOut();

        out.scenarios.usdMaterialPreview = await scenarioUsdMaterialPreview(ctx);
        writeOut();

        out.scenarios.newFromExample = await scenarioNewFromExample(ctx);
        writeOut();
    } catch (e) {
        out.fatalError = String((e && e.stack) || e);
        log('FATAL: ' + (e && e.message || e));
    } finally {
        writeOut();
    }
}

module.exports = { run };
