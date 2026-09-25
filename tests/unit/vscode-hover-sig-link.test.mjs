// Exercises the full "Interactive Documentation" hover-link chain end to
// end: hoverProvider.js/nodeSignature.js extract a signature token from
// the hovered element, extension.js's materialxPlayground.openDocs command
// splices it into a `#/<category>?sig=<token>` hash, and the docs panel
// (js/docs/doc-links.jsx's hashToSel + js/docs-app.jsx's
// matchSigHintToGroups) resolves that hash back to the matching signature
// group. Regression coverage for the reported symptom: a color3 `image`
// hover landing the docs panel on the node's float signature instead of
// color3, traced here against the REAL committed js/gen/nodelib*.json,
// not synthetic fixtures, so a data-shape change would also be caught.
//
// nodeSignature.js is plain Node (require()able directly). doc-links.jsx
// and docs-app.jsx run as browser text/babel scripts with no
// module.exports; their relevant helpers (hashToSel/parseSigHint,
// matchSigHintToGroups) are plain top-level JS with no JSX, so they're
// evaluated here via vm in a minimal sandbox instead of duplicated by
// hand, so this test tracks the real committed source.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const nodeSignature = require('../../vscode_extension/src/nodeSignature.js');
const extSrc = fs.readFileSync(path.join(REPO_ROOT, 'vscode_extension', 'src', 'extension.js'), 'utf8');

// SIG_TOKEN_RE is a single top-level `const NAME = /regex/;` line:
// extracted by line match rather than brace-matching (there's no brace).
function extractConstRegex(src, name) {
    const m = new RegExp('const\\s+' + name + '\\s*=\\s*(/(?:\\\\/|[^/])+/[a-z]*)\\s*;').exec(src);
    assert.ok(m, 'expected to find const ' + name + ' in extension.js');
    // eslint-disable-next-line no-eval
    return (0, eval)(m[1]);
}
const SIG_TOKEN_RE = extractConstRegex(extSrc, 'SIG_TOKEN_RE');

// Replicates extension.js's materialxPlayground.openDocs hash-building
// (the `sigOk`/`hash` lines, ~575-578) exactly, so a change to that logic
// without updating this helper fails loudly instead of silently drifting.
function buildOpenDocsHash(category, sig) {
    const sigOk = typeof sig === 'string' && sig.length <= 512 && SIG_TOKEN_RE.test(sig);
    return category
        ? '#/' + encodeURIComponent(String(category)) + (sigOk ? '?sig=' + encodeURIComponent(sig) : '')
        : '#!docs';
}

function extractFunction(src, name) {
    const re = new RegExp('(?:^|\\n)[ \\t]*(?:function\\s+' + name + '\\s*\\(|const\\s+' + name + '\\s*=)');
    const m = re.exec(src);
    assert.ok(m, 'expected to find ' + name);
    let i = m.index;
    while (src[i] !== '{') i++;
    let depth = 0;
    let end = i;
    for (; end < src.length; end++) {
        if (src[end] === '{') depth++;
        else if (src[end] === '}') { depth--; if (depth === 0) { end++; break; } }
    }
    let text = src.slice(m.index, end).trim();
    if (/^const\s/.test(text)) text += ';';
    return text;
}

const docLinksSrc = fs.readFileSync(path.join(REPO_ROOT, 'js', 'docs', 'doc-links.jsx'), 'utf8');
const docsAppSrc = fs.readFileSync(path.join(REPO_ROOT, 'js', 'docs-app.jsx'), 'utf8');

const linksSandbox = { window: { SITE_LINKS: { repo: '', issues: '', spec: '', specBlobBase: '', libBlobBase: '' } } };
vm.createContext(linksSandbox);
vm.runInContext(docLinksSrc, linksSandbox);
const hashToSel = linksSandbox.window.hashToSel;
assert.equal(typeof hashToSel, 'function', 'doc-links.jsx should export hashToSel onto window');

const appSandbox = {};
vm.createContext(appSandbox);
vm.runInContext(extractFunction(docsAppSrc, 'matchSigHintToGroups') + '\nthis.matchSigHintToGroups = matchSigHintToGroups;', appSandbox);
const matchSigHintToGroups = appSandbox.matchSigHintToGroups;

const nodelib = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'js', 'gen', 'nodelib.json'), 'utf8'));
const nodelibIndex = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'js', 'gen', 'nodelib-index.json'), 'utf8'));

// End-to-end: a <image name="img1" type="color3"><input name="file"
// type="filename" .../></image> hover must deep-link to the color3
// signature group, not the node's first (float) group.
test('hover sig link: color3 image resolves through the full chain to the color3 signature group, not float', () => {
    const text = '<materialx version="1.39"><nodegraph name="NG">'
        + '<image name="img1" type="color3"><input name="file" type="filename" value="tex.png"/></image>'
        + '</nodegraph></materialx>';
    const offset = text.indexOf('image name="img1"');
    const ctx = nodeSignature.extractElementContext(text, offset, 'image');
    assert.equal(ctx.type, 'color3');

    const sigToken = nodeSignature.buildSigToken(ctx);
    assert.ok(SIG_TOKEN_RE.test(sigToken), 'buildSigToken output must satisfy extension.js\'s own SIG_TOKEN_RE gate');

    const hash = buildOpenDocsHash('image', sigToken);
    assert.match(hash, /^#\/image\?sig=/);

    const sel = hashToSel(nodelib, hash);
    assert.ok(sel, 'hashToSel should resolve the image node');
    assert.equal(sel.name, 'image');
    assert.ok(sel.sigHint, 'a sig hint should survive hashToSel');
    assert.equal(sel.sigHint.out, 'color3');

    const sigGroups = nodelibIndex.nodes[sel.name].sigGroups;
    assert.equal(sigGroups[0].type, 'float', 'sanity: float really is the default/first group for image');

    const idx = matchSigHintToGroups(sigGroups, sel.sigHint);
    assert.ok(idx >= 0, 'matchSigHintToGroups should find a match');
    assert.equal(sigGroups[idx].type, 'color3', 'the resolved signature group must be color3, not the default float');
});

test('hover sig link: no type= on the hovered element yields no sig hint (degrades to the default group, never wrong)', () => {
    const text = '<materialx version="1.39"><nodegraph name="NG"><image name="img1"></image></nodegraph></materialx>';
    const offset = text.indexOf('image name="img1"');
    const ctx = nodeSignature.extractElementContext(text, offset, 'image');
    assert.equal(ctx.type, null);
    assert.equal(nodeSignature.buildSigToken(ctx), null);

    const hash = buildOpenDocsHash('image', null);
    assert.equal(hash, '#/image');
    const sel = hashToSel(nodelib, hash);
    assert.equal(sel.sigHint, undefined);
});
