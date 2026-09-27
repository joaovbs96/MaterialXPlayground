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
        // instead proves 'nodedef' is offered (a node-instance attribute),
        // while 'inherit' (shader-inheritance only) and input/token-only
        // UI attributes like uivisible are NOT.
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
            && nodeAttrLabels.includes('nodedef') && !nodeAttrLabels.includes('inherit') && !nodeAttrLabels.includes('uivisible')
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

// Scenario: a glTF/GLB/OBJ scene root renders through the same Scene
// Viewer path USD stages use (materialxPlayground.openScene ->
// usdFileSet.js collects the file set -> js/usd-scene-app.jsx picks the
// loader by root extension). expectedMinFiles is the root file plus its
// side files (buffer/mtl, texture), so this also proves the texture was
// part of the sent file set: a missing texture would leave report.files
// short and the material would fail to bind the way report.materials
// checks for.
async function scenarioSceneFormat(ctx, rootPath, expectedMinFiles) {
    const uri = vscode.Uri.file(rootPath);
    const errorsBefore = ctx.testApi.getErrors().length;
    const reportStart = ctx.sceneReports.length;
    try {
        await vscode.commands.executeCommand('materialxPlayground.openScene', uri);
        const report = await waitForValue(() => ctx.sceneReports.slice(reportStart).find((r) => r && (r.status === 'rendered' || r.status === 'error')), 120000);
        const newErrors = ctx.testApi.getErrors().slice(errorsBefore);
        const ok = !!report && report.status === 'rendered' && report.files >= expectedMinFiles
            && report.meshes >= 1 && report.materials >= 1 && report.errors === 0;
        return { pass: ok && newErrors.length === 0, report, newErrors: newErrors.slice(0, 5) };
    } finally {
        await closeTabsForUri(uri);
    }
}

// Scenario: sceneNoSiblings -- a folder holding quad.glb plus several
// unrelated .glb/.usda files nothing references (smoke-fixtures.mjs's
// scenenosiblings folder). Opening quad.glb must send exactly the root
// plus its one referenced texture (report.files === 2), never the
// unrelated siblings, and the Root layer selector must not render since
// there is only ever one candidate root in VS Code (js/usd-scene-app.jsx).
async function scenarioSceneNoSiblings(ctx) {
    const rootPath = ctx.fixtures.noSiblingsRootPath;
    const uri = vscode.Uri.file(rootPath);
    const errorsBefore = ctx.testApi.getErrors().length;
    const reportStart = ctx.sceneReports.length;
    try {
        await vscode.commands.executeCommand('materialxPlayground.openScene', uri);
        const report = await waitForValue(() => ctx.sceneReports.slice(reportStart).find((r) => r && (r.status === 'rendered' || r.status === 'error')), 120000);
        const newErrors = ctx.testApi.getErrors().slice(errorsBefore);
        // The Scene card is not empty for a single .glb: file name, format and files count.
        const card = (report && report.sceneCard) || {};
        const cardOk = card.file === 'quad.glb' && card.format === 'glTF binary' && card.files === 2
            && card.cameraOptions >= 1 && (card.inDom ? card.fileText === 'quad.glb' && /^2 files, /.test(card.filesText) : card.sidebarOpen === false);
        const ok = !!report && report.status === 'rendered' && report.files === 2
            && report.meshes >= 1 && report.materials >= 1 && report.errors === 0
            && report.rootSelectVisible === false && cardOk;
        return { pass: ok && newErrors.length === 0, cardOk, report, newErrors: newErrors.slice(0, 5) };
    } finally {
        await closeTabsForUri(uri);
    }
}

// Scenario: sceneFormatAutoOpen -- the same auto-open contract as USD's
// (scenarioSceneAutoOpen above), checked for the three new root types:
// .gltf and .obj are real text documents so the viewer opens BESIDE them
// (two tabs for that uri); .glb has no text form, so its placeholder tab
// is REPLACED in place (one tab).
async function scenarioSceneFormatAutoOpen(ctx) {
    const SCENE_VIEW_TYPE = 'materialxPlayground.sceneViewer';
    const cfg = vscode.workspace.getConfiguration('materialxPlayground');
    const prevSetting = cfg.inspect('autoOpenSceneViewer')?.globalValue;
    const gltfUri = vscode.Uri.file(ctx.fixtures.gltfRootPath);
    const objUri = vscode.Uri.file(ctx.fixtures.objRootPath);
    const glbUri = vscode.Uri.file(ctx.fixtures.glbRootPath);

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

    const out = { gltfBeside: null, objBeside: null, glbReplaced: null };
    try {
        await cfg.update('autoOpenSceneViewer', true, vscode.ConfigurationTarget.Global);

        const gltfDoc = await vscode.workspace.openTextDocument(gltfUri);
        await vscode.window.showTextDocument(gltfDoc, { preview: false });
        const gltfSceneTab = await waitForValue(() => sceneTabFor(gltfUri), 20000);
        out.gltfBeside = { pass: !!gltfSceneTab && tabsFor(gltfUri).length === 2, tabCount: tabsFor(gltfUri).length };
        await closeTabsForUri(gltfUri);

        const objDoc = await vscode.workspace.openTextDocument(objUri);
        await vscode.window.showTextDocument(objDoc, { preview: false });
        const objSceneTab = await waitForValue(() => sceneTabFor(objUri), 20000);
        out.objBeside = { pass: !!objSceneTab && tabsFor(objUri).length === 2, tabCount: tabsFor(objUri).length };
        await closeTabsForUri(objUri);

        await vscode.commands.executeCommand('vscode.open', glbUri);
        const replaced = await waitForValue(() => {
            const tabs = tabsFor(glbUri);
            return tabs.length === 1 && tabs[0].input instanceof vscode.TabInputCustom
                && tabs[0].input.viewType === SCENE_VIEW_TYPE ? tabs[0] : null;
        }, 20000);
        out.glbReplaced = { pass: !!replaced, tabCount: tabsFor(glbUri).length };
        await closeTabsForUri(glbUri);

        return { pass: out.gltfBeside.pass && out.objBeside.pass && out.glbReplaced.pass, ...out };
    } finally {
        try { await cfg.update('autoOpenSceneViewer', prevSetting, vscode.ConfigurationTarget.Global); } catch (e) { /* best effort */ }
        await closeTabsForUri(gltfUri);
        await closeTabsForUri(objUri);
        await closeTabsForUri(glbUri);
    }
}

async function scenarioDocsPanel(ctx) {
    const errorsBefore = ctx.testApi.getErrors().length;
    await vscode.commands.executeCommand('materialxPlayground.openDocs');
    await new Promise((r) => setTimeout(r, 20000));
    const newErrors = ctx.testApi.getErrors().length - errorsBefore;
    // Both spellings -- see lifecycleCloseReopen's comment on
    // TabInputWebview's 'mainThreadWebview-' viewType prefix; closing only
    // the bare id left the tab (and the host-side docs panel) open for
    // whatever scenario runs next.
    await closeTabsForViewType('materialxPlayground.docs');
    await closeTabsForViewType('mainThreadWebview-materialxPlayground.docs');
    return { pass: newErrors === 0, newErrors };
}

// Scenario: docsFilter -- materialxPlayground.filterDocsByFile (the
// sidebar's "Filter Node Docs by Current File" button) from a COLD start:
// no docs panel open yet. Proves it opens the panel itself (previously it
// only showed an info message telling the user to open Node Documentation
// first) and that the filter actually reaches the docs page's own state
// (js/docs-app.jsx's fileFilter, reported via __mtlxDocsFilterState/
// ctx.testApi.triggerDocsFilter) rather than just "a message was posted"
// -- the panel-just-opened race (filter sent before docs-app.jsx mounts
// its 'mtlx-docs-filter' listener) is exactly what this proves is fixed,
// via bootstrap.js's __mtlxPendingDocsFilter replay. Running the command
// again clears it.
async function scenarioDocsFilter(ctx) {
    const fixturePath = path.join(ctx.fixtures.matDir, 'docsfilter.mtlx');
    const fixtureText = [
        '<?xml version="1.0"?>',
        '<materialx version="1.39" colorspace="lin_rec709">',
        '  <nodegraph name="NG_main">',
        '    <constant name="base" type="color3">',
        '      <input name="value" type="color3" value="0.8, 0.2, 0.1" />',
        '    </constant>',
        '    <output name="color_out" type="color3" nodename="base" />',
        '  </nodegraph>',
        '  <standard_surface name="SR_test" type="surfaceshader">',
        '    <input name="base_color" type="color3" nodegraph="NG_main" output="color_out" />',
        '  </standard_surface>',
        '  <surfacematerial name="M_test" type="material">',
        '    <input name="surfaceshader" type="surfaceshader" nodename="SR_test" />',
        '  </surfacematerial>',
        '</materialx>',
        '',
    ].join('\n');
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, fixtureText);
    const uri = vscode.Uri.file(fixturePath);

    try {
        // cold start -- a TabInputWebview's viewType is prefixed by VS
        // Code ('mainThreadWebview-<id>'), see lifecycleCloseReopen above;
        // both spellings need closing or the docs tab survives.
        await closeTabsForViewType('materialxPlayground.docs');
        await closeTabsForViewType('mainThreadWebview-materialxPlayground.docs');
        // The tab close resolving doesn't guarantee the panel's
        // onDidDispose has already run on the host side (a prior
        // scenario's own docs panel close can still be draining) -- poll
        // briefly instead of assuming it's synchronous.
        {
            const deadline = Date.now() + 5000;
            while (ctx.testApi.isDocsPanelOpen() && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 100));
            }
        }
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
        await new Promise((r) => setTimeout(r, 500)); // let activeMtlxDocument() settle

        const openBefore = ctx.testApi.isDocsPanelOpen();

        const reportStart1 = ctx.docsFilterReports.length;
        await vscode.commands.executeCommand('materialxPlayground.filterDocsByFile');
        await waitForValue(() => ctx.testApi.isDocsPanelOpen() || null, 20000);
        const openedByCommand = ctx.testApi.isDocsPanelOpen();
        await new Promise((r) => setTimeout(r, 20000)); // let docs-app.jsx boot/mount for real
        ctx.testApi.triggerDocsFilter();
        const onReport = await waitForValue(() => ctx.docsFilterReports.slice(reportStart1)[0], 20000);

        const onOk = !!onReport && onReport.active === true
            && onReport.file === 'docsfilter.mtlx'
            && onReport.categoryCount > 0 && onReport.nodeCount > 0;

        const reportStart2 = ctx.docsFilterReports.length;
        await vscode.commands.executeCommand('materialxPlayground.filterDocsByFile');
        await new Promise((r) => setTimeout(r, 500));
        ctx.testApi.triggerDocsFilter();
        const offReport = await waitForValue(() => ctx.docsFilterReports.slice(reportStart2)[0], 20000);
        const offOk = !!offReport && offReport.active === false;

        return {
            pass: !openBefore && openedByCommand && onOk && offOk,
            openBefore, openedByCommand, onReport, offReport,
        };
    } finally {
        await closeTabsForViewType('materialxPlayground.docs');
        await closeTabsForViewType('mainThreadWebview-materialxPlayground.docs');
        await closeTabsForUri(uri);
        try { fs.unlinkSync(fixturePath); } catch (e) { /* best effort cleanup */ }
    }
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
        const refused = !!save && save.ok === false && /(scene|USD) file/.test(save.error || '');
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
// In VS Code the 3D preview column is not rendered at all (no WebGL2
// column, no divider, no toggle button): the node graph fills the panel.
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
        const fallbackOk = !!preview && preview.previewPaneAbsent;
        return {
            pass: graphOk && fallbackOk && newErrors.length === 0,
            graphOk, fallbackOk, preview, newErrors: newErrors.slice(0, 5),
        };
    } finally {
        await closeTabsForUri(uri);
    }
}

// Scenario: sceneTreePreview -- double-clicks the Card mesh row in the Scene
// Viewer's outliner (test seam), waits for the material panel, then rewrites the
// root layer so the file watcher reloads the stage, which must close the panel.
async function scenarioSceneTreePreview(ctx) {
    const rootPath = ctx.fixtures.usdMtlxRootPath;
    const uri = vscode.Uri.file(rootPath);
    const errorsBefore = ctx.testApi.getErrors().length;
    const reportStart = ctx.sceneReports.length;
    const previewStart = ctx.previewReports.length;
    try {
        await vscode.commands.executeCommand('materialxPlayground.openScene', uri);
        const scene = await waitForValue(() => ctx.sceneReports.slice(reportStart).find((r) => r && (r.status === 'rendered' || r.status === 'error')), 120000);
        if (!scene || scene.status !== 'rendered') return { pass: false, scene };
        await new Promise((r) => setTimeout(r, 1000));
        ctx.testApi.triggerSceneMaterialPreview(45000, { target: 'tree' });
        const preview = await waitForValue(() => ctx.previewReports[previewStart], 60000);
        const opened = !!preview && !preview.fatal && preview.panel && !preview.panelHidden && preview.nodes > 0
            && !preview.graphLoading && preview.dblReason === 'ok';
        // Same bytes, new mtime: the watcher resends the set as a new host seq.
        const reloadStart = ctx.sceneReports.length;
        fs.writeFileSync(rootPath, fs.readFileSync(rootPath));
        const reloaded = await waitForValue(() => ctx.sceneReports.slice(reloadStart)
            .find((r) => r && (r.status === 'rendered' || r.status === 'error') && r.hostSeq > scene.hostSeq), 120000);
        const closedOnReload = !!reloaded && reloaded.status === 'rendered' && reloaded.previewOpen === false;
        // Objects under Scene (World, Card) plus the Materials group (CardMat).
        const treeOk = scene.treeNodes >= 2 && scene.treeMaterials >= 1;
        const newErrors = ctx.testApi.getErrors().slice(errorsBefore);
        return {
            pass: opened && closedOnReload && treeOk && newErrors.length === 0,
            opened, closedOnReload, treeOk, treeNodes: scene.treeNodes,
            preview, reloaded: reloaded ? { status: reloaded.status, hostSeq: reloaded.hostSeq, previewOpen: reloaded.previewOpen } : null,
            newErrors: newErrors.slice(0, 5),
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

            // Generous window for the text editor to open and the
            // auto-open listener (extension.js's maybeAutoOpen) to place
            // the Playground beside it, then forward any errors.
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

            // Same result as opening the file from the Explorer: a text
            // tab AND a Playground custom-editor tab for the new file,
            // with the text tab active (has focus).
            let tabCheck = { textTabs: 0, customTabs: 0, textTabActive: false };
            if (newMtlxUri) {
                const uriStr = newMtlxUri.toString();
                const allTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
                const textTabs = allTabs.filter((t) => t.input instanceof vscode.TabInputText
                    && t.input.uri.toString() === uriStr);
                const customTabs = allTabs.filter((t) => t.input instanceof vscode.TabInputCustom
                    && t.input.viewType === 'materialxPlayground.editor'
                    && t.input.uri.toString() === uriStr);
                tabCheck = {
                    textTabs: textTabs.length,
                    customTabs: customTabs.length,
                    textTabActive: textTabs.length === 1 && textTabs[0].isActive,
                };
            }
            const tabsOk = tabCheck.textTabs === 1 && tabCheck.customTabs === 1 && tabCheck.textTabActive;

            const errorSample = ctx.testApi.getErrors().slice(errorsBefore, errorsBefore + 3);
            out[kind] = {
                pass: mismatches.length === 0 && newErrors === 0 && tabsOk,
                id, mismatches, newErrors, errorSample, fileCount: example.files.length, tabCheck,
            };
        } finally {
            if (newMtlxUri) await closeTabsForUri(newMtlxUri);
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
        }
    }

    return { pass: out.singleFile.pass && out.textured.pass, singleFile: out.singleFile, textured: out.textured };
}

// Scenario: galleryPanel -- materialxPlayground.newFromExample now opens
// the "New Material from Example" webview panel (not the old QuickPick),
// listing every catalog entry (14) as a card, and a card click runs the
// same creation flow the (id, targetFolder) command form always has, all
// through exampleGallery.js's own test API (ctx.testApi.gallery), which
// goes through the same validated message handler a real webview click
// would (never a raw command string built from the message).
async function scenarioGalleryPanel(ctx) {
    const gallery = ctx.testApi.gallery;
    if (!gallery) return { pass: false, error: 'testApi.gallery is missing' };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtlx-smoke-gallery-'));
    let newMtlxUri = null;
    try {
        await gallery.open(tmpDir);
        const isOpen = gallery.isOpen();
        const rendered = await gallery.waitForRendered(20000);
        const cardCountOk = rendered.cardCount === 14;

        const errorsBefore = ctx.testApi.getErrors().length;
        await gallery.triggerCard('example-standard-surface-gold');
        await new Promise((r) => setTimeout(r, 8000)); // let materialxPlayground.open's panel boot
        const newErrors = ctx.testApi.getErrors().length - errorsBefore;

        const destAbs = path.join(tmpDir, 'standard_surface_gold.mtlx');
        newMtlxUri = vscode.Uri.file(destAbs);
        const fileExists = fs.existsSync(destAbs);

        return {
            pass: isOpen && cardCountOk && fileExists && newErrors === 0,
            isOpen, cardCount: rendered.cardCount, fileExists, newErrors,
        };
    } finally {
        if (newMtlxUri) await closeTabsForUri(newMtlxUri);
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    }
}

// Scenario: actionsView -- the materialxPlayground.actions sidebar view is
// now a WebviewView (was a TreeView); focusing it makes VS Code call
// resolveWebviewView, and the row list it would render matches
// actionsModel.js's six ids in order.
async function scenarioActionsView(ctx) {
    const actions = ctx.testApi.actions;
    if (!actions) return { pass: false, error: 'testApi.actions is missing' };

    await actions.focus();
    await new Promise((r) => setTimeout(r, 3000)); // let the view resolve
    const state = actions.getState();
    const expectedIds = ['newDocument', 'openDocs', 'openInGraphEditor', 'openInMaterialViewer', 'filterDocsByFile', 'newFromExample'];
    const idsOk = JSON.stringify(state.rowIds) === JSON.stringify(expectedIds);
    return { pass: state.resolved && idsOk, resolved: state.resolved, rowIds: state.rowIds };
}

// Scenario: actionsExamples -- the "New Material from Example" catalog is
// now embedded directly in the Actions webview (below its button), not a
// separate materialxPlayground.examples view: every catalog entry (14)
// renders as a card regardless of the panel's expanded state, and a card
// click runs the same creation flow through the exact validated
// _handleMessage() a real click would. No Explorer folder here, so the
// target folder comes from the active .mtlx editor (opened first, below),
// matching resolveTargetFolder's own precedence chain in newFromExample.js.
async function scenarioActionsExamples(ctx) {
    const actions = ctx.testApi.actions;
    if (!actions) return { pass: false, error: 'testApi.actions is missing' };

    const uri = vscode.Uri.file(ctx.fixtures.mainMtlxPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });

    const destAbs = path.join(path.dirname(ctx.fixtures.mainMtlxPath), 'standard_surface_gold.mtlx');
    let newMtlxUri = null;
    try {
        // The sidebar container may already be open (another scenario may
        // have revealed it), in which case the view already resolved and
        // rendered before this call -- waitForExamplesRendered() returns
        // that buffered report instead of waiting for an event that
        // already happened.
        await actions.focus();
        const rendered = await actions.waitForExamplesRendered(20000);
        const cardCountOk = rendered.cardCount === 14;

        // The toggle button reveals the panel (aria-expanded/state), never
        // opening a separate gallery tab as a side effect.
        const galleryOpenBefore = ctx.testApi.gallery.isOpen();
        await actions.toggleExamples(true);
        const toggleOk = actions.getState().examplesExpanded === true;
        const galleryUnaffected = ctx.testApi.gallery.isOpen() === galleryOpenBefore;

        const errorsBefore = ctx.testApi.getErrors().length;
        await actions.triggerCard('example-standard-surface-gold');
        await new Promise((r) => setTimeout(r, 8000)); // let materialxPlayground.open's panel boot
        const newErrors = ctx.testApi.getErrors().length - errorsBefore;

        newMtlxUri = vscode.Uri.file(destAbs);
        const fileExists = fs.existsSync(destAbs);

        return {
            pass: cardCountOk && toggleOk && galleryUnaffected && fileExists && newErrors === 0,
            cardCount: rendered.cardCount, toggleOk, galleryUnaffected, fileExists, newErrors,
        };
    } finally {
        if (newMtlxUri) await closeTabsForUri(newMtlxUri);
        await closeTabsForUri(uri);
        try { fs.rmSync(destAbs, { force: true }); } catch (e) { /* best effort */ }
    }
}

// Scenario: actionsAbout -- the "?" button's About overlay data, computed
// entirely by the host (actionsView.js's _buildAbout, backed by
// actionsModel.js's buildAboutData): a real vX.Y.Z extension version, the
// stamped MaterialX tag (never hand-typed -- see js/gen/mtlx-version.json),
// and at least one credited third-party library.
async function scenarioActionsAbout(ctx) {
    const actions = ctx.testApi.actions;
    if (!actions) return { pass: false, error: 'testApi.actions is missing' };

    await actions.focus();
    await new Promise((r) => setTimeout(r, 2000)); // let the actions view resolve
    const about = await actions.getAboutData();
    const versionOk = typeof about.extensionVersionText === 'string' && about.extensionVersionText.indexOf('v') === 0;
    const mtlxOk = typeof about.mtlxVersion === 'string' && about.mtlxVersion.indexOf('v') === 0;
    const creditsOk = Array.isArray(about.vendorEntries) && about.vendorEntries.length > 0;
    const requestCounted = actions.getState().aboutRequests > 0;
    return { pass: versionOk && mtlxOk && creditsOk && requestCounted, about, requestCounted };
}

// Scenario: actionsGithub -- the GitHub button posts a validated 'github'
// message; the host's TEST_TRANSPORT gate short-circuits the real
// vscode.env.openExternal call (see actionsView.js), so this never opens a
// real browser, but still proves the click reached the handler.
async function scenarioActionsGithub(ctx) {
    const actions = ctx.testApi.actions;
    if (!actions) return { pass: false, error: 'testApi.actions is missing' };

    await actions.focus();
    await new Promise((r) => setTimeout(r, 2000)); // let the actions view resolve
    const before = actions.getState().githubOpens;
    await actions.triggerGithub();
    const after = actions.getState().githubOpens;
    return { pass: after === before + 1, before, after };
}

// Scenario: aboutLicense -- opens the About dialog on the already-open
// custom editor panel (reuses scenarioEditorSession's tab) and checks the
// license loader falls back from LICENSE to vsce's renamed LICENSE.txt
// inside the PACKAGED extension, and that the displayed extension version
// carries the "v" prefix. testApi.triggerAbout() dispatches the same
// 'mtlx-about' event the header help button does; __mtlxAboutReport
// (bootstrap.js) forwards the dialog's real license/version state.
async function scenarioAboutLicense(ctx) {
    const uri = vscode.Uri.file(ctx.fixtures.mainMtlxPath);
    const reportStart = ctx.aboutReports.length;
    try {
        await openEditor(uri);
        await new Promise((r) => setTimeout(r, 3000)); // let the panel settle
        ctx.testApi.triggerAbout();
        const report = await waitForValue(() => ctx.aboutReports.slice(reportStart)[0], 20000);
        const licenseOk = !!report && !report.licenseError && typeof report.license === 'string' && report.license.trim().length > 0;
        const versionOk = !!report && typeof report.extensionVersionText === 'string' && report.extensionVersionText.indexOf('v') === 0;
        return { pass: licenseOk && versionOk, licenseOk, versionOk, report };
    } finally {
        await closeTabsForUri(uri);
    }
}

// Scenario: fullWidth -- proves the webview-only body padding/margin reset
// (scripts/build-webview.mjs's FOCUS_CSS_BLOCK) beats VS Code's injected
// default webview styles in BOTH webview.html-based hosts: the playground
// custom editor and the USD Scene Viewer, each its own webview.html
// document with its own copy of the injected default + our reset.
async function scenarioFullWidth(ctx) {
    const uri = vscode.Uri.file(ctx.fixtures.mainMtlxPath);
    const sceneUri = vscode.Uri.file(ctx.fixtures.usdRootPath);
    let playgroundReport = null;
    let sceneReport = null;
    try {
        await openEditor(uri);
        await new Promise((r) => setTimeout(r, 2000)); // let the panel settle
        const playgroundStart = ctx.fullWidthReports.length;
        ctx.testApi.triggerFullWidth();
        playgroundReport = await waitForValue(() => ctx.fullWidthReports.slice(playgroundStart)[0], 20000);

        const reportStart = ctx.sceneReports.length;
        await vscode.commands.executeCommand('materialxPlayground.openScene', sceneUri);
        await waitForValue(() => ctx.sceneReports.slice(reportStart).find((r) => r && (r.status === 'rendered' || r.status === 'error')), 120000);
        const sceneStart = ctx.fullWidthReports.length;
        ctx.testApi.triggerSceneFullWidth();
        sceneReport = await waitForValue(() => ctx.fullWidthReports.slice(sceneStart)[0], 20000);

        const isZero = (r) => !!r && r.paddingLeft === '0px' && r.paddingRight === '0px';
        const playgroundOk = isZero(playgroundReport);
        const sceneOk = isZero(sceneReport);
        return { pass: playgroundOk && sceneOk, playgroundOk, sceneOk, playgroundReport, sceneReport };
    } finally {
        await closeTabsForUri(uri);
        await closeTabsForUri(sceneUri);
    }
}

// Scenario: openViewCommands -- materialxPlayground.openInGraphEditor and
// .openInMaterialViewer both (a) open a NEW panel on exactly the requested
// view, ignoring materialxPlayground.defaultView, and (b) reuse an
// ALREADY-OPEN panel for the same file by switching its view in place
// (one tab total) rather than opening a second one.
async function scenarioOpenViewCommands(ctx) {
    const uri = vscode.Uri.file(ctx.fixtures.mainMtlxPath);
    try {
        // New panel opened straight into the graph view.
        let start = ctx.viewHashReports.length;
        await vscode.commands.executeCommand('materialxPlayground.openInGraphEditor', uri);
        await new Promise((r) => setTimeout(r, 2000)); // let the panel settle
        ctx.testApi.triggerViewHash();
        const graphHash = await waitForValue(() => ctx.viewHashReports.slice(start)[0], 20000);
        const openedOnGraph = graphHash === '#!graph';

        // Same file, other command: must reuse the tab (still exactly one
        // tab for this uri) and switch it to the viewer.
        const tabsBefore = vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .filter((t) => t.input && t.input.uri && t.input.uri.toString() === uri.toString()).length;
        start = ctx.viewHashReports.length;
        await vscode.commands.executeCommand('materialxPlayground.openInMaterialViewer', uri);
        await new Promise((r) => setTimeout(r, 1500));
        ctx.testApi.triggerViewHash();
        const viewerHash = await waitForValue(() => ctx.viewHashReports.slice(start)[0], 20000);
        const switchedToViewer = viewerHash === '#!viewer';
        const tabsAfter = vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .filter((t) => t.input && t.input.uri && t.input.uri.toString() === uri.toString()).length;
        const reusedOneTab = tabsBefore === 1 && tabsAfter === 1;

        return {
            pass: openedOnGraph && switchedToViewer && reusedOneTab,
            openedOnGraph, switchedToViewer, reusedOneTab, graphHash, viewerHash, tabsBefore, tabsAfter,
        };
    } finally {
        await closeTabsForUri(uri);
    }
}

// Scenario: sceneMissingRoundTrip -- with the host's static reference scan
// switched off (test-only), root.usda arrives alone; its sublayer
// (layers/geo.usda) and that layer's texture must then come through the
// on-demand missing-file rounds, and the final render must be clean.
async function scenarioSceneMissingRoundTrip(ctx) {
    const uri = vscode.Uri.file(ctx.fixtures.missingRootPath);
    const errorsBefore = ctx.testApi.getErrors().length;
    const reportStart = ctx.sceneReports.length;
    const roundStart = ctx.sceneRounds.length;
    ctx.testApi.setSceneStaticScan(false);
    try {
        await vscode.commands.executeCommand('materialxPlayground.openScene', uri);
        const final = await waitForValue(() => ctx.sceneReports.slice(reportStart)
            .find((r) => r && (r.status === 'error' || (r.status === 'rendered' && r.files >= 3))), 180000);
        const rounds = ctx.sceneRounds.slice(roundStart).map((r) => ({ round: r.round, files: r.files, added: r.added, stillMissing: r.stillMissing }));
        const roundOf = (rel) => { const hit = rounds.find((r) => (r.added || []).includes(rel)); return hit ? hit.round : -1; };
        const firstRound = rounds.find((r) => r.round === 0);
        const sublayerRound = roundOf('layers/geo.usda');
        const textureRound = roundOf('textures/checker.png');
        const newErrors = ctx.testApi.getErrors().slice(errorsBefore);
        const ok = !!final && final.status === 'rendered' && final.meshes >= 1 && final.errors === 0
            && !!firstRound && firstRound.files === 1 && sublayerRound >= 1 && textureRound > sublayerRound;
        return { pass: ok && newErrors.length === 0, final, rounds, sublayerRound, textureRound, newErrors: newErrors.slice(0, 5) };
    } finally {
        ctx.testApi.setSceneStaticScan(true);
        await closeTabsForUri(uri);
    }
}

// Scenario: sceneLoadCancel -- a scene whose texture is a large generated
// file (written here, deleted after). The progress Cancel button is clicked
// while that file downloads; loading must stop (fetch aborted, nothing new
// fetched, no render, no further host round) and the viewport must show
// the cancelled state with a Reload action.
async function scenarioSceneLoadCancel(ctx) {
    const dir = path.join(ctx.fixtures.wsDir, 'scenecancel');
    fs.mkdirSync(dir, { recursive: true });
    const bigPath = path.join(dir, 'big.png');
    const rootPath = path.join(dir, 'big.usda');
    const chunk = Buffer.alloc(16 * 1024 * 1024, 0x5a);
    const fd = fs.openSync(bigPath, 'w');
    try { for (let i = 0; i < 15; i++) fs.writeSync(fd, chunk); } finally { fs.closeSync(fd); }
    fs.writeFileSync(rootPath, [
        '#usda 1.0',
        '(',
        '    defaultPrim = "World"',
        ')',
        '',
        'def Xform "World"',
        '{',
        '    asset inputs:file = @big.png@',
        '}',
        '',
    ].join('\n'));
    const uri = vscode.Uri.file(rootPath);
    const reportStart = ctx.sceneReports.length;
    const roundStart = ctx.sceneRounds.length;
    const cancelStart = ctx.sceneCancelReports.length;
    // Throttle the streamed read so the 240 MB file cannot finish before
    // Cancel gets clicked -- without this the load sometimes wins the race
    // (flaky on a fast disk/cache) and the scenario never sees a chance to
    // cancel. Always turned back off in the finally below.
    ctx.testApi.setSceneFetchThrottle(50);
    try {
        await vscode.commands.executeCommand('materialxPlayground.openScene', uri);
        await waitForValue(() => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input && t.input.uri && t.input.uri.toString() === uri.toString())), 20000);
        await new Promise((r) => setTimeout(r, 500));
        ctx.testApi.triggerSceneCancel({ timeoutMs: 60000, settleMs: 5000 });
        const report = await waitForValue(() => ctx.sceneCancelReports[cancelStart], 90000);
        const rounds = ctx.sceneRounds.slice(roundStart);
        const rendered = ctx.sceneReports.slice(reportStart).filter((r) => r && r.status === 'rendered');
        const at = report && report.atCancel;
        const after = report && report.after;
        const stopped = !!at && !!after && after.started === at.started && after.inFlight === 0
            && (at.inFlight > 0 ? after.aborted > at.aborted : true);
        const ok = !!report && report.clicked && report.cancelledShown && report.reloadShown && !report.progressShown
            && stopped && rendered.length === 0 && rounds.length <= 1;
        return { pass: ok, report, rounds: rounds.map((r) => ({ round: r.round, files: r.files })), renderedAfterCancel: rendered.length };
    } finally {
        ctx.testApi.setSceneFetchThrottle(0);
        await closeTabsForUri(uri);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    }
}

// Optional manual scenario, only when MTLX_SMOKE_EXTRA_SCENE names a real
// scene on disk: time to first render, files per host round, and warnings
// left once the load settles (no new scene report for 20 s).
async function scenarioExternalScene(ctx, scenePath) {
    const uri = vscode.Uri.file(scenePath);
    const reportStart = ctx.sceneReports.length;
    const roundStart = ctx.sceneRounds.length;
    const t0 = Date.now();
    try {
        await vscode.commands.executeCommand('materialxPlayground.openScene', uri);
        const settledReport = (r) => r && (r.status === 'rendered' || r.status === 'error');
        const first = await waitForValue(() => ctx.sceneReports.slice(reportStart).find(settledReport), 900000);
        let quietSince = Date.now();
        let seen = ctx.sceneReports.length;
        while (Date.now() - quietSince < 20000) {
            await new Promise((r) => setTimeout(r, 500));
            if (ctx.sceneReports.length !== seen) { seen = ctx.sceneReports.length; quietSince = Date.now(); }
        }
        const reports = ctx.sceneReports.slice(reportStart).filter(settledReport);
        const last = reports[reports.length - 1] || null;
        return {
            pass: !!last && last.status === 'rendered',
            firstRenderMs: first ? first.ts - t0 : null,
            finalRenderMs: last ? last.ts - t0 : null,
            reports,
            rounds: ctx.sceneRounds.slice(roundStart),
        };
    } finally {
        await closeTabsForUri(uri);
    }
}

// "Webview is disposed" host errors (toasts or unhandled rejections) since index `from`.
function disposedErrorsSince(ctx, from) {
    return ctx.testApi.getHostErrors().slice(from).filter((t) => /disposed/i.test(t));
}

// Scenario: lifecycleCloseReopen -- closes playground, scene and docs tabs
// while they are still resolving and again once booted, reopening each time.
// No "Webview is disposed" error may surface and the last open must load.
async function scenarioLifecycleCloseReopen(ctx) {
    const uri = vscode.Uri.file(ctx.fixtures.mainMtlxPath);
    const sceneUri = vscode.Uri.file(ctx.fixtures.gltfRootPath);
    const hostFrom = ctx.testApi.getHostErrors().length;
    const steps = [];
    try {
        for (const delay of [0, 30, 150, 600]) {
            const open = openEditor(uri);
            await new Promise((r) => setTimeout(r, delay));
            await closeTabsForUri(uri);
            await open.catch(() => {});
            steps.push('mtlx close after ' + delay + 'ms');
        }
        for (const delay of [0, 30, 150]) {
            const open = vscode.commands.executeCommand('materialxPlayground.openScene', sceneUri);
            await new Promise((r) => setTimeout(r, delay));
            await closeTabsForUri(sceneUri);
            await Promise.resolve(open).catch(() => {});
            steps.push('scene close after ' + delay + 'ms');
        }
        for (const delay of [0, 30, 150]) {
            const open = vscode.commands.executeCommand('materialxPlayground.openDocs');
            await new Promise((r) => setTimeout(r, delay));
            await closeTabsForViewType('materialxPlayground.docs');
            await Promise.resolve(open).catch(() => {});
            steps.push('docs close after ' + delay + 'ms');
        }
        // Reopen the docs panel after those closes: the reuse path must not
        // reach a panel that was closed while it was being created.
        await vscode.commands.executeCommand('materialxPlayground.openDocs');
        await new Promise((r) => setTimeout(r, 1500));
        await vscode.commands.executeCommand('materialxPlayground.openDocs', 'image');
        await new Promise((r) => setTimeout(r, 1500));
        const docsOpen = vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input && t.input.viewType && /materialxPlayground\.docs/.test(t.input.viewType)));
        await closeTabsForViewType('materialxPlayground.docs');
        await closeTabsForViewType('mainThreadWebview-materialxPlayground.docs');
        // Booted close/reopen: the last open has to deliver its document.
        const start = ctx.allReports.length;
        await openEditor(uri);
        await waitForReportAfter(ctx.allReports, start, 60000);
        await closeTabsForUri(uri);
        const start2 = ctx.allReports.length;
        await openEditor(uri);
        const reopened = await waitForReportAfter(ctx.allReports, start2, 60000).then(() => true, () => false);
        await new Promise((r) => setTimeout(r, 3000));
        const disposed = disposedErrorsSince(ctx, hostFrom);
        const allHost = ctx.testApi.getHostErrors().slice(hostFrom);
        return { pass: disposed.length === 0 && reopened && docsOpen, disposed: disposed.slice(0, 5), hostErrors: allHost.slice(0, 5), reopened, docsOpen, steps };
    } finally {
        await closeTabsForUri(uri);
        await closeTabsForUri(sceneUri);
        await closeTabsForViewType('materialxPlayground.docs');
        await closeTabsForViewType('mainThreadWebview-materialxPlayground.docs');
    }
}

// Polls the active panel's viewer centre pixel until `predicate` holds; the
// last thumbnail is written to <tmp>/mtlx-smoke-pixels/<label>.png as evidence.
async function waitForPixel(ctx, predicate, timeoutMs, label, x, y) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        const from = ctx.pixelReports.length;
        ctx.testApi.triggerPixel(x, y);
        last = await waitForValue(() => ctx.pixelReports[from], 5000);
        if (last && !last.error && predicate(last)) break;
        await new Promise((r) => setTimeout(r, 1000));
    }
    const ok = !!(last && !last.error && predicate(last));
    if (last && last.thumb) {
        const dir = path.join(os.tmpdir(), 'mtlx-smoke-pixels');
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, (label || 'pixel') + '.png'), Buffer.from(last.thumb.split(',')[1], 'base64'));
        } catch (e) { /* evidence only */ }
    }
    const pixel = last ? Object.assign({}, last, { thumb: undefined }) : null;
    return { ok, pixel };
}

// Scenario: textureSwap -- swap.mtlx shows tex.png unlit. Replacing tex.png
// on disk with a same-size image of another colour must reach the viewer:
// after a text edit (same mtime too), and with no edit at all (file watcher).
async function scenarioTextureSwap(ctx) {
    const fx = ctx.fixtures;
    const uri = vscode.Uri.file(fx.swapMtlxPath);
    const isRed = (p) => p.r > p.b + 60;
    const isBlue = (p) => p.b > p.r + 60;
    // A spot on the shaderball's outer shell (the centre is the grey core).
    const probe = (pred, ms, label) => waitForPixel(ctx, pred, ms, label, 0.25, 0.45);
    const hostFrom = ctx.testApi.getHostErrors().length;
    const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
    // Copies src over tex.png; `mtime` pins the replaced file's timestamp.
    const replace = (src, mtime) => {
        fs.copyFileSync(src, fx.swapTexPath);
        fs.utimesSync(fx.swapTexPath, mtime, mtime);
    };
    const texSha = (report) => (report && report.files && report.files['tex.png'] ? report.files['tex.png'].sha256.slice(0, 12) : null);
    const editText = async (marker) => {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) || await vscode.workspace.openTextDocument(uri);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, doc.positionAt(doc.getText().indexOf('</materialx>')), '  <!-- ' + marker + ' -->\n');
        await vscode.workspace.applyEdit(edit);
        await doc.save();
    };
    const t0 = new Date(Date.now() - 60000);
    replace(fx.swapRedPath, t0);
    const out = {
        sameSize: fs.statSync(fx.swapRedPath).size === fs.statSync(fx.swapBluePath).size,
        redSha: sha(fx.swapRedPath), blueSha: sha(fx.swapBluePath),
    };
    const cfg = vscode.workspace.getConfiguration('materialxPlayground');
    const prevDefaultView = cfg.inspect('defaultView')?.globalValue;
    try {
        await cfg.update('defaultView', 'viewer', vscode.ConfigurationTarget.Global);
        const start = ctx.allReports.length;
        await openEditor(uri);
        await waitForReportAfter(ctx.allReports, start, 60000);
        out.initialRed = await probe(isRed, 60000, 'swap-initial');

        // B: a different image with a fresh mtime, then a text edit.
        let from = ctx.allReports.length;
        const tB = new Date(Date.now() - 30000);
        replace(fx.swapBluePath, tB);
        await editText('edit b');
        out.bFetchedSha = texSha(await waitForReportAfter(ctx.allReports, from, 30000).then((r) => r.report, () => null));
        out.bNewMtimeEdit = await probe(isBlue, 30000, 'swap-b-new-mtime-edit');

        // A: same size AND the same mtime as the file it replaces (a copy
        // that keeps the timestamp), then a text edit.
        from = ctx.allReports.length;
        replace(fx.swapRedPath, tB);
        await editText('edit a');
        out.aFetchedSha = texSha(await waitForReportAfter(ctx.allReports, from, 30000).then((r) => r.report, () => null));
        out.aSameMtimeEdit = await probe(isRed, 30000, 'swap-a-same-mtime-edit');

        // C: replace with no text edit at all: the texture watcher reloads.
        replace(fx.swapBluePath, new Date());
        out.cWatcher = await probe(isBlue, 30000, 'swap-c-watcher');

        const disposed = disposedErrorsSince(ctx, hostFrom);
        out.pass = !!(out.initialRed.ok && out.aSameMtimeEdit.ok && out.bNewMtimeEdit.ok && out.cWatcher.ok && disposed.length === 0);
        return out;
    } finally {
        try { await cfg.update('defaultView', prevDefaultView, vscode.ConfigurationTarget.Global); } catch (e) { /* best effort */ }
        await closeTabsForUri(uri);
        fs.copyFileSync(fx.swapRedPath, fx.swapTexPath);
    }
}

// Scenario: selectionSync (E18) -- a text cursor move inside a nodegraph node
// selects that node in the Graph Editor (entering the scope), a graph click
// moves the text selection, and syncSelection=false stops the text -> graph leg.
async function scenarioSelectionSync(ctx) {
    const uri = vscode.Uri.file(ctx.fixtures.selSyncMtlxPath);
    const uriStr = uri.toString();
    const cfg = vscode.workspace.getConfiguration('materialxPlayground');
    const prevDefaultView = cfg.inspect('defaultView')?.globalValue;
    const prevSync = cfg.inspect('syncSelection')?.globalValue;
    const out = {};
    const state = async (predicate, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        let last = null;
        while (Date.now() < deadline) {
            const from = ctx.graphSelectionReports.length;
            ctx.testApi.triggerGraphSelection(uriStr);
            last = await waitForValue(() => ctx.graphSelectionReports.slice(from).find((r) => r && !('clicked' in r)), 3000).catch(() => null);
            if (last && predicate(last)) return { ok: true, state: last };
            await new Promise((r) => setTimeout(r, 400));
        }
        return { ok: false, state: last };
    };
    const hasPanel = () => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) =>
        t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === uriStr));
    try {
        await cfg.update('defaultView', 'graph', vscode.ConfigurationTarget.Global);
        await cfg.update('syncSelection', true, vscode.ConfigurationTarget.Global);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
        const lines = doc.getText().split('\n');
        const lineOf = (needle) => lines.findIndex((l) => l.includes(needle));
        // autoOpenPlayground normally opens the playground beside the text.
        await waitForValue(() => hasPanel() || null, 8000).catch(() => null);
        if (!hasPanel()) {
            await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
        }
        const loaded = await state((r) => r.loaded && r.cardCount > 0, 90000);
        out.loaded = loaded.ok;
        if (!loaded.ok) { out.pass = false; out.loadedState = loaded.state; return out; }
        await new Promise((r) => setTimeout(r, 1500));
        const editorFor = () => vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uriStr);

        // Text -> graph: cursor inside tinted's in1 input.
        const in1Line = lineOf('name="in1"');
        editorFor().selection = new vscode.Selection(in1Line, 10, in1Line, 10);
        const textToGraph = await state((r) => r.scope === 'NG_main' && r.selectedId === 'n:tinted', 20000);
        out.textToGraph = { ok: textToGraph.ok, state: textToGraph.state };

        // Graph -> text: a user click on the base card selects its name in the text.
        const baseLine = lineOf('name="base"');
        const clickFrom = ctx.graphSelectionReports.length;
        ctx.testApi.triggerGraphClick(uriStr, 'n:base');
        const click = await waitForValue(() => ctx.graphSelectionReports.slice(clickFrom).find((r) => r && ('clicked' in r || r.error)), 10000).catch(() => null);
        const moved = await waitForValue(() => {
            const ed = editorFor();
            return ed && ed.selection.start.line === baseLine ? ed.selection : null;
        }, 10000).catch(() => null);
        const selText = moved ? editorFor().document.getText(moved) : null;
        // No echo: the host's own text selection must not re-drive the graph.
        await new Promise((r) => setTimeout(r, 1200));
        const afterClick = await state((r) => r.selectedId === 'n:base', 5000);
        out.graphToText = { ok: !!moved && selText === 'base' && afterClick.ok, click, line: moved ? moved.start.line : null, expectedLine: baseLine, selText, afterClick: afterClick.state };

        // Setting off: a cursor move no longer changes the graph.
        await cfg.update('syncSelection', false, vscode.ConfigurationTarget.Global);
        const srLine = lineOf('name="SR_test"');
        editorFor().selection = new vscode.Selection(srLine, 6, srLine, 6);
        await new Promise((r) => setTimeout(r, 1500));
        const off = await state(() => true, 5000);
        out.settingOff = { ok: !!off.state && off.state.scope === 'NG_main' && off.state.selectedId === 'n:base', state: off.state };

        out.pass = out.loaded && out.textToGraph.ok && out.graphToText.ok && out.settingOff.ok;
        return out;
    } finally {
        try { await cfg.update('defaultView', prevDefaultView, vscode.ConfigurationTarget.Global); } catch (e) { /* best effort */ }
        try { await cfg.update('syncSelection', prevSync, vscode.ConfigurationTarget.Global); } catch (e) { /* best effort */ }
        await closeTabsForUri(uri);
    }
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
            gltfRootPath: path.join(wsDir, 'scenegltf', 'quad.gltf'),
            glbRootPath: path.join(wsDir, 'sceneglb', 'quad.glb'),
            objRootPath: path.join(wsDir, 'sceneobj', 'quad.obj'),
            noSiblingsRootPath: path.join(wsDir, 'scenenosiblings', 'quad.glb'),
            missingRootPath: path.join(wsDir, 'scenemissing', 'root.usda'),
            swapMtlxPath: path.join(wsDir, 'texswap', 'swap.mtlx'),
            swapTexPath: path.join(wsDir, 'texswap', 'tex.png'),
            swapRedPath: path.join(fixturesDir, 'texswap-src', 'red.png'),
            swapBluePath: path.join(fixturesDir, 'texswap-src', 'blue.png'),
            selSyncMtlxPath: path.join(wsDir, 'selsync', 'sync.mtlx'),
            wsDir,
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
        testApi.onSceneReport((r) => { sceneReports.push(r ? Object.assign({}, r, { ts: Date.now() }) : r); });
        const sceneRounds = [];
        if (testApi.onSceneRound) testApi.onSceneRound((r) => { sceneRounds.push(Object.assign({}, r, { ts: Date.now() })); });
        const sceneCancelReports = [];
        if (testApi.onSceneCancelReport) testApi.onSceneCancelReport((r) => { sceneCancelReports.push(r); });
        testApi.onGraphSaveResult((r) => { graphSaves.push(r); });
        const previewReports = [];
        testApi.onMaterialPreviewReport((r) => { previewReports.push(r); });
        const aboutReports = [];
        testApi.onAboutReport((r) => { aboutReports.push(r); });
        const fullWidthReports = [];
        testApi.onFullWidthReport((r) => { fullWidthReports.push(r); });
        const viewHashReports = [];
        testApi.onViewHashReport((r) => { viewHashReports.push(r); });
        const pixelReports = [];
        if (testApi.onPixelReport) testApi.onPixelReport((r) => { pixelReports.push(r); });
        const graphSelectionReports = [];
        if (testApi.onGraphSelectionReport) testApi.onGraphSelectionReport((r) => { graphSelectionReports.push(r); });
        const docsFilterReports = [];
        if (testApi.onDocsFilterReport) testApi.onDocsFilterReport((r) => { docsFilterReports.push(r); });
        const ctx = { fixtures, extensionUri: ext.extensionUri, extensionRoot, testApi, allReports, sceneReports, sceneRounds, sceneCancelReports, graphSaves, previewReports, aboutReports, fullWidthReports, viewHashReports, pixelReports, graphSelectionReports, docsFilterReports };

        const extraScene = process.env.MTLX_SMOKE_EXTRA_SCENE;
        if (extraScene) {
            out.scenarios.externalScene = await scenarioExternalScene(ctx, extraScene);
            writeOut();
            if (process.env.MTLX_SMOKE_EXTRA_ONLY === '1') return;
        }

        // MTLX_SMOKE_ONLY: comma-separated scenario names for a local rerun (all when empty).
        const only = (process.env.MTLX_SMOKE_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
        const want = (name) => !only.length || only.includes(name);
        if (want('editorSession')) {
            const editorSession = await scenarioEditorSession(ctx);
            out.scenarios.editorE2E = editorSession.editorE2E;
            out.scenarios.viewerRendered = editorSession.viewerRendered;
            out.scenarios.saveBridge = editorSession.saveBridge;
            writeOut();
        }

        if (want('validationWorker')) { out.scenarios.validationWorker = await scenarioValidationWorker(ctx); writeOut(); }
        if (want('hoverDocs')) { out.scenarios.hoverDocs = await scenarioHoverDocs(ctx); writeOut(); }
        if (want('languageFeatures')) { out.scenarios.languageFeatures = await scenarioLanguageFeatures(ctx); writeOut(); }
        if (want('completion')) { out.scenarios.completion = await scenarioCompletion(ctx); writeOut(); }
        if (want('boundary')) { out.scenarios.boundary = await scenarioBoundary(ctx); writeOut(); }
        if (want('settingsFallback')) { out.scenarios.settingsFallback = await scenarioSettingsFallback(ctx); writeOut(); }
        if (want('docsPanel')) { out.scenarios.docsPanel = await scenarioDocsPanel(ctx); writeOut(); }
        if (want('docsFilter')) { out.scenarios.docsFilter = await scenarioDocsFilter(ctx); writeOut(); }
        if (want('sceneAutoOpen')) { out.scenarios.sceneAutoOpen = await scenarioSceneAutoOpen(ctx); writeOut(); }
        if (want('usdScene')) { out.scenarios.usdScene = await scenarioUsdScene(ctx); writeOut(); }
        if (want('usdMaterialPreview')) { out.scenarios.usdMaterialPreview = await scenarioUsdMaterialPreview(ctx); writeOut(); }
        if (want('sceneTreePreview')) { out.scenarios.sceneTreePreview = await scenarioSceneTreePreview(ctx); writeOut(); }
        if (want('sceneGltf')) { out.scenarios.sceneGltf = await scenarioSceneFormat(ctx, ctx.fixtures.gltfRootPath, 3); writeOut(); }
        if (want('sceneGlb')) { out.scenarios.sceneGlb = await scenarioSceneFormat(ctx, ctx.fixtures.glbRootPath, 2); writeOut(); }
        if (want('sceneObj')) { out.scenarios.sceneObj = await scenarioSceneFormat(ctx, ctx.fixtures.objRootPath, 3); writeOut(); }
        if (want('sceneNoSiblings')) { out.scenarios.sceneNoSiblings = await scenarioSceneNoSiblings(ctx); writeOut(); }
        if (want('sceneMissingRoundTrip')) { out.scenarios.sceneMissingRoundTrip = await scenarioSceneMissingRoundTrip(ctx); writeOut(); }
        if (want('sceneLoadCancel')) { out.scenarios.sceneLoadCancel = await scenarioSceneLoadCancel(ctx); writeOut(); }
        if (want('sceneFormatAutoOpen')) { out.scenarios.sceneFormatAutoOpen = await scenarioSceneFormatAutoOpen(ctx); writeOut(); }
        if (want('newFromExample')) { out.scenarios.newFromExample = await scenarioNewFromExample(ctx); writeOut(); }
        if (want('galleryPanel')) { out.scenarios.galleryPanel = await scenarioGalleryPanel(ctx); writeOut(); }
        if (want('actionsView')) { out.scenarios.actionsView = await scenarioActionsView(ctx); writeOut(); }
        if (want('actionsExamples')) { out.scenarios.actionsExamples = await scenarioActionsExamples(ctx); writeOut(); }
        if (want('actionsAbout')) { out.scenarios.actionsAbout = await scenarioActionsAbout(ctx); writeOut(); }
        if (want('actionsGithub')) { out.scenarios.actionsGithub = await scenarioActionsGithub(ctx); writeOut(); }
        if (want('aboutLicense')) { out.scenarios.aboutLicense = await scenarioAboutLicense(ctx); writeOut(); }
        if (want('fullWidth')) { out.scenarios.fullWidth = await scenarioFullWidth(ctx); writeOut(); }
        if (want('openViewCommands')) { out.scenarios.openViewCommands = await scenarioOpenViewCommands(ctx); writeOut(); }
        if (want('lifecycleCloseReopen')) { out.scenarios.lifecycleCloseReopen = await scenarioLifecycleCloseReopen(ctx); writeOut(); }
        if (want('textureSwap')) { out.scenarios.textureSwap = await scenarioTextureSwap(ctx); writeOut(); }
        if (want('selectionSync')) { out.scenarios.selectionSync = await scenarioSelectionSync(ctx); writeOut(); }
    } catch (e) {
        out.fatalError = String((e && e.stack) || e);
        log('FATAL: ' + (e && e.message || e));
    } finally {
        writeOut();
    }
}

module.exports = { run };
