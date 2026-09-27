// Exercises vscode_extension/language/mtlx.language-configuration.json:
// the file must parse as plain JSON, and its regex-bearing fields
// (onEnterRules, indentationRules, folding.markers, wordPattern) must
// match/reject the representative lines they are meant to.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'vscode_extension', 'language', 'mtlx.language-configuration.json');

function loadConfig() {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
}

test('mtlx.language-configuration.json parses as plain JSON', () => {
    assert.doesNotThrow(() => loadConfig());
});

test('indentationRules.increaseIndentPattern matches an open tag not self-closed or closed on the line', () => {
    const cfg = loadConfig();
    const re = new RegExp(cfg.indentationRules.increaseIndentPattern);
    assert.ok(re.test('  <nodegraph name="NG1">'));
    assert.ok(re.test('<materialx version="1.39">'));
});

test('indentationRules.increaseIndentPattern rejects self-closing tags, same-line-closed tags and comments', () => {
    const cfg = loadConfig();
    const re = new RegExp(cfg.indentationRules.increaseIndentPattern);
    assert.equal(re.test('  <input name="x" value="1" />'), false);
    assert.equal(re.test('  <a name="a1">text</a>'), false);
    assert.equal(re.test('  <!-- a plain comment -->'), false);
});

test('indentationRules.decreaseIndentPattern matches a line starting with a closing tag only', () => {
    const cfg = loadConfig();
    const re = new RegExp(cfg.indentationRules.decreaseIndentPattern);
    assert.ok(re.test('  </nodegraph>'));
    assert.ok(re.test('</materialx>'));
    assert.equal(re.test('  <nodegraph>'), false);
    assert.equal(re.test('  some text </nodegraph>'), false);
});

test('folding.markers matches #region/#endregion comments and rejects a plain comment', () => {
    const cfg = loadConfig();
    const start = new RegExp(cfg.folding.markers.start);
    const end = new RegExp(cfg.folding.markers.end);
    assert.ok(start.test('  <!-- #region shading network -->'));
    assert.ok(end.test('  <!-- #endregion -->'));
    assert.equal(start.test('  <!-- just a comment -->'), false);
    assert.equal(end.test('  <!-- #region shading network -->'), false);
});

test('wordPattern selects an underscored identifier as a single word', () => {
    const cfg = loadConfig();
    const re = new RegExp(cfg.wordPattern);
    assert.equal('base_color'.match(re)[0], 'base_color');
    assert.equal('ND_image_color3'.match(re)[0], 'ND_image_color3');
});

test('wordPattern keeps a decimal number literal as a single word', () => {
    const cfg = loadConfig();
    const re = new RegExp(cfg.wordPattern);
    assert.equal('0.8'.match(re)[0], '0.8');
});

test('onEnterRules[0] (indentOutdent): matches an open tag before the cursor and a matching close tag after it', () => {
    const cfg = loadConfig();
    const rule = cfg.onEnterRules[0];
    assert.equal(rule.action.indent, 'indentOutdent');
    const before = new RegExp(rule.beforeText);
    const after = new RegExp(rule.afterText);
    assert.ok(before.test('  <nodegraph name="NG1">'));
    assert.ok(after.test('</nodegraph>'));
    assert.equal(before.test('  <input name="x" />'), false, 'self-closing tags must not trigger indentOutdent');
});

test('onEnterRules[1] (indent): matches an open tag left unclosed on the line', () => {
    const cfg = loadConfig();
    const rule = cfg.onEnterRules[1];
    assert.equal(rule.action.indent, 'indent');
    const before = new RegExp(rule.beforeText);
    assert.ok(before.test('  <standard_surface name="SR1" type="surfaceshader">'));
    assert.equal(before.test('  <input name="x" />'), false, 'self-closing tags must not trigger indent');
    assert.equal(before.test('  <a name="a1">text</a>'), false, 'a tag closed on the same line must not trigger indent');
});
