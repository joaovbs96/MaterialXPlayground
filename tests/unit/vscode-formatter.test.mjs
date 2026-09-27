// Unit tests for vscode_extension/src/formatter.js: the xml-formatter
// re-indent pass validated by scratchpad/fmt-spike (see
// gate-results.md there for the full corpus check this mirrors).
//
// Also covers the DocumentFormattingEditProvider /
// DocumentRangeFormattingEditProvider wiring, tested against a
// minimal fake 'vscode' (formatter.js takes vscode as a parameter).
//
// xml-formatter ships via vendor/xml-formatter/ (scripts/vendor-deps.mjs).
// Tests still point MTLX_XML_FORMATTER_DIR at the fmt-spike scratch
// install when present, and skip gracefully if neither is available.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mtlxNode = require('../../vscode_extension/src/mtlxNode.js');

const SPIKE_NODE_MODULES = path.join(ROOT, 'scratchpad', 'fmt-spike', 'node_modules');
if (fs.existsSync(SPIKE_NODE_MODULES)) {
    process.env.MTLX_XML_FORMATTER_DIR = SPIKE_NODE_MODULES;
}

const formatter = require('../../vscode_extension/src/formatter.js');
const DEP_AVAILABLE = formatter._internal.resolveXmlFormatter() !== null;
const SKIP_REASON = 'xml-formatter not resolvable (no vendor/xml-formatter, no scratchpad/fmt-spike/node_modules: run the Batch D spike setup first)';

function skipIfUnavailable(t) {
    if (!DEP_AVAILABLE) { t.skip(SKIP_REASON); return true; }
    return false;
}

// --- Fake vscode: only the surface formatter.js's register()/providers
// touch. Positions are opaque {offset} markers round-tripped through
// document.positionAt/offsetAt, exactly like the real API contract. ---
class FakeRange {
    constructor(start, end) { this.start = start; this.end = end; }
}
const fakeVscode = {
    Range: FakeRange,
    TextEdit: { replace: (range, newText) => ({ range, newText }) },
    languages: {
        registerDocumentFormattingEditProvider: (lang, provider) => ({ lang, provider }),
        registerDocumentRangeFormattingEditProvider: (lang, provider) => ({ lang, provider }),
    },
};

function makeDoc(text) {
    return {
        getText: () => text,
        positionAt: (offset) => ({ offset }),
        offsetAt: (pos) => pos.offset,
    };
}

function registerFake() {
    const context = { subscriptions: [] };
    const { documentProvider, rangeProvider } = formatter.register(context, fakeVscode);
    return { context, documentProvider, rangeProvider };
}

// --- Small inline corpus, mirroring the spike's checks (a)-(e). ---

const SRC_COMMENT_ENTITY = [
    '<?xml version="1.0"?>\r\n',
    '<materialx version="1.39">\r\n',
    '<!-- a comment with &amp; inside -->\r\n',
    '<input name="a" type="filename" value="x.&lt;UDIM&gt;.tif" colorspace="srgb_texture" />\r\n',
    '</materialx>\r\n',
].join('');

const SRC_XINCLUDE = [
    '<?xml version="1.0"?>\n',
    '<materialx version="1.39">\n',
    '<xi:include href="other.mtlx" />\n',
    '<standard_surface name="SR_x" type="surfaceshader" />\n',
    '</materialx>\n',
].join('');

const SRC_CDATA = [
    '<?xml version="1.0"?>\n',
    '<materialx version="1.39">\n',
    '<nodedef name="ND_test" node="test"><![CDATA[raw <not a real tag> text]]></nodedef>\n',
    '</materialx>\n',
].join('');

const SRC_NO_TRAILING_EOL = '<?xml version="1.0"?>\n<materialx version="1.39">\n<input name="a" type="float" value="1" />\n</materialx>';

const SRC_BLANK_RUN = [
    '<?xml version="1.0"?>\n',
    '<materialx version="1.39">\n',
    '  <input name="a" type="float" value="1" />\n',
    '\n',
    '\n',
    '\n',
    '  <input name="b" type="float" value="2" />\n',
    '</materialx>\n',
].join('');

function countBlankLines(text) {
    const lines = text.split('\n');
    // A trailing newline produces a final empty split segment that isn't
    // a real line, so drop it before counting blank lines.
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.filter((l) => l.trim() === '').length;
}

test('formatMtlx preserves comments, entities and self-closing style (CRLF source)', (t) => {
    if (skipIfUnavailable(t)) return;
    const out = formatter.formatMtlx(SRC_COMMENT_ENTITY);
    assert.match(out, /<!-- a comment with &amp; inside -->/);
    assert.match(out, /value="x\.&lt;UDIM&gt;\.tif"/);
    assert.match(out, /\/>/);
    assert.ok(!out.includes('\n\r'), 'no stray LF-before-CRLF');
    assert.ok(out.split('\r\n').length > 1, 'kept CRLF line endings');
});

test('formatMtlx preserves an xi:include self-closing element', (t) => {
    if (skipIfUnavailable(t)) return;
    const out = formatter.formatMtlx(SRC_XINCLUDE);
    assert.match(out, /<xi:include href="other\.mtlx" \/>/);
});

test('formatMtlx preserves a CDATA section verbatim', (t) => {
    if (skipIfUnavailable(t)) return;
    const out = formatter.formatMtlx(SRC_CDATA);
    assert.match(out, /<!\[CDATA\[raw <not a real tag> text\]\]>/);
});

test('formatMtlx collapses a run of blank lines to exactly one', (t) => {
    if (skipIfUnavailable(t)) return;
    const out = formatter.formatMtlx(SRC_BLANK_RUN);
    assert.equal(countBlankLines(out), 1);
    assert.match(out, /<input name="a"[^\n]*\/>\n\n\s*<input name="b"/);
});

test('formatMtlx never adds a blank line where the source had none', (t) => {
    if (skipIfUnavailable(t)) return;
    for (const src of [SRC_COMMENT_ENTITY, SRC_XINCLUDE, SRC_CDATA]) {
        assert.equal(countBlankLines(formatter.formatMtlx(src)), 0);
    }
});

test('formatMtlx blank-line preservation is idempotent', (t) => {
    if (skipIfUnavailable(t)) return;
    const once = formatter.formatMtlx(SRC_BLANK_RUN);
    const twice = formatter.formatMtlx(once);
    assert.equal(twice, once);
    assert.equal(countBlankLines(twice), 1);
});

test('formatMtlx does not change MaterialX validation messages when blank lines are collapsed', async (t) => {
    if (skipIfUnavailable(t)) return;
    const out = formatter.formatMtlx(SRC_BLANK_RUN);
    const [before, after] = await Promise.all([
        mtlxNode.validateSemantic(ROOT, SRC_BLANK_RUN),
        mtlxNode.validateSemantic(ROOT, out),
    ]);
    if (!before.available || !after.available) { t.skip('MaterialX WASM unavailable in this environment'); return; }
    assert.deepEqual(after.messages.map((m) => m.text), before.messages.map((m) => m.text));
});

test('pickBlankPlaceholder picks a token not already present in the source', (t) => {
    if (skipIfUnavailable(t)) return;
    const collidingSrc = '<materialx>\n<!--__mtlx_blank__-->\n</materialx>';
    const token = formatter._internal.pickBlankPlaceholder(collidingSrc);
    assert.notEqual(token, '<!--__mtlx_blank__-->');
    assert.ok(!collidingSrc.includes(token));
});

test('formatMtlx uses tabs when insertSpaces is false', (t) => {
    if (skipIfUnavailable(t)) return;
    const out = formatter.formatMtlx(SRC_XINCLUDE, { insertSpaces: false });
    assert.match(out, /\n\t<xi:include/);
});

test('formatMtlx re-adds a trailing newline the source had', (t) => {
    if (skipIfUnavailable(t)) return;
    const withEol = SRC_XINCLUDE; // ends with \n
    const out = formatter.formatMtlx(withEol);
    assert.ok(out.endsWith('\n'));
});

test('formatMtlx does not invent a trailing newline the source lacked', (t) => {
    if (skipIfUnavailable(t)) return;
    const out = formatter.formatMtlx(SRC_NO_TRAILING_EOL);
    assert.ok(!out.endsWith('\n'));
});

test('formatMtlx is idempotent', (t) => {
    if (skipIfUnavailable(t)) return;
    for (const src of [SRC_COMMENT_ENTITY, SRC_XINCLUDE, SRC_CDATA, SRC_BLANK_RUN]) {
        const once = formatter.formatMtlx(src);
        const twice = formatter.formatMtlx(once);
        assert.equal(twice, once);
    }
});

// --- Range formatting ---

test('register() wires both providers for language mtlx', (t) => {
    if (skipIfUnavailable(t)) return;
    const { context, documentProvider, rangeProvider } = registerFake();
    assert.equal(context.subscriptions.length, 2);
    assert.equal(context.subscriptions[0].lang, 'mtlx');
    assert.equal(context.subscriptions[1].lang, 'mtlx');
    assert.equal(typeof documentProvider.provideDocumentFormattingEdits, 'function');
    assert.equal(typeof rangeProvider.provideDocumentRangeFormattingEdits, 'function');
});

test('whole-document formatting via the registered provider', (t) => {
    if (skipIfUnavailable(t)) return;
    const { documentProvider } = registerFake();
    const doc = makeDoc(SRC_XINCLUDE);
    const edits = documentProvider.provideDocumentFormattingEdits(doc, { tabSize: 2, insertSpaces: true });
    assert.equal(edits.length, 1);
    assert.equal(edits[0].newText, formatter.formatMtlx(SRC_XINCLUDE));
});

test('range formatting covering the whole document behaves like whole-document formatting', (t) => {
    if (skipIfUnavailable(t)) return;
    const { rangeProvider } = registerFake();
    const doc = makeDoc(SRC_XINCLUDE);
    const range = new FakeRange(doc.positionAt(0), doc.positionAt(SRC_XINCLUDE.length));
    const edits = rangeProvider.provideDocumentRangeFormattingEdits(doc, range, { tabSize: 2, insertSpaces: true });
    assert.equal(edits.length, 1);
    assert.equal(edits[0].newText, formatter.formatMtlx(SRC_XINCLUDE));
});

test('range formatting inside one element only re-indents that element', (t) => {
    if (skipIfUnavailable(t)) return;
    const src = [
        '<?xml version="1.0"?>\n',
        '<materialx version="1.39">\n',
        '  <nodegraph name="NG_test">\n',
        '  <input name="a" type="float" value="1" /><input name="b" type="float" value="2" />\n',
        '  </nodegraph>\n',
        '</materialx>\n',
    ].join('');
    const doc = makeDoc(src);
    const nodegraphStart = src.indexOf('<nodegraph');
    const nodegraphEnd = src.indexOf('</nodegraph>') + '</nodegraph>'.length;
    // A range crossing from inside the first <input> into the second, so
    // neither self-closing element alone contains it and the smallest
    // enclosing element is the parent <nodegraph>, not the whole document.
    const startOffset = src.indexOf('name="a"');
    const endOffset = src.indexOf('name="b"');
    const range = new FakeRange(doc.positionAt(startOffset), doc.positionAt(endOffset));

    const { rangeProvider } = registerFake();
    const edits = rangeProvider.provideDocumentRangeFormattingEdits(doc, range, { tabSize: 2, insertSpaces: true });
    assert.equal(edits.length, 1);
    assert.equal(edits[0].range.start.offset, nodegraphStart);
    assert.equal(edits[0].range.end.offset, nodegraphEnd);
    // The two collapsed inputs land on their own re-indented lines, and
    // nothing outside the <nodegraph> element was touched.
    assert.match(edits[0].newText, /<nodegraph name="NG_test">\n {4}<input name="a"[^]*<input name="b"[^]*<\/nodegraph>/);
});

test('range formatting outside any element returns no edits', (t) => {
    if (skipIfUnavailable(t)) return;
    const src = SRC_XINCLUDE;
    const doc = makeDoc(src);
    // A zero-width range at offset 0 (before the XML declaration, not
    // covering the whole document, and not inside any element).
    const range = new FakeRange(doc.positionAt(0), doc.positionAt(0));
    const { rangeProvider } = registerFake();
    const edits = rangeProvider.provideDocumentRangeFormattingEdits(doc, range, { tabSize: 2, insertSpaces: true });
    assert.deepEqual(edits, []);
});

// --- loadVendoredXmlFormatter: the contained loader that remaps the flat
// vendor/xml-formatter and vendor/xml-parser-xo dirs (no nested
// node_modules -- that would fall under .gitignore's blanket rule and
// never reach a clean clone) back into a working require graph. ---

function writeTempModule(dir, name, source) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, source);
    return file;
}

test('loadVendoredXmlFormatter maps the bare "xml-parser-xo" specifier to the vendored file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtlx-fmt-loader-'));
    try {
        const parserPath = writeTempModule(dir, 'parser.js', 'module.exports = { MARK: "fake-parser" };\n');
        const formatterPath = writeTempModule(dir, 'formatter.js', [
            'const xp = require("xml-parser-xo");',
            'module.exports = function () { return xp.MARK; };',
        ].join('\n'));
        const loaded = formatter._internal.loadVendoredXmlFormatter(formatterPath, parserPath);
        assert.equal(loaded(), 'fake-parser');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('loadVendoredXmlFormatter lets every other specifier fall through to real require', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtlx-fmt-loader-'));
    try {
        const parserPath = writeTempModule(dir, 'parser.js', 'module.exports = {};\n');
        const formatterPath = writeTempModule(dir, 'formatter.js', [
            'const p = require("path");', // a real Node builtin, not remapped
            'require("xml-parser-xo");', // still resolves, just unused here
            'module.exports = function () { return typeof p.join; };',
        ].join('\n'));
        const loaded = formatter._internal.loadVendoredXmlFormatter(formatterPath, parserPath);
        assert.equal(loaded(), 'function');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('loadVendoredXmlFormatter does not leak its fake stub into the real "xml-parser-xo" resolution', () => {
    // xml-parser-xo is also a real devDependency (root node_modules), so a
    // bare require('xml-parser-xo') from this test always succeeds either
    // way -- the containment this checks is that the loader's remapping
    // for ONE formatter module never pollutes that real, shared resolution
    // with its fake stand-in.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtlx-fmt-loader-'));
    try {
        const parserPath = writeTempModule(dir, 'parser.js', 'module.exports = { MARK: "fake-parser-should-not-leak" };\n');
        const formatterPath = writeTempModule(dir, 'formatter.js', 'module.exports = {};\n');
        formatter._internal.loadVendoredXmlFormatter(formatterPath, parserPath);
        const real = require('xml-parser-xo');
        assert.notEqual(real && real.MARK, 'fake-parser-should-not-leak');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('loadVendoredXmlFormatter propagates a require error for an unresolvable specifier', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtlx-fmt-loader-'));
    try {
        const parserPath = writeTempModule(dir, 'parser.js', 'module.exports = {};\n');
        const formatterPath = writeTempModule(dir, 'formatter.js', 'require("this-module-does-not-exist-anywhere");\n');
        assert.throws(() => formatter._internal.loadVendoredXmlFormatter(formatterPath, parserPath));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
