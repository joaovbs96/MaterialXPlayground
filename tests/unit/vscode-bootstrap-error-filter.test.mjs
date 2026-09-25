// Coverage for media/bootstrap.js's benign-ResizeObserver-error filter.
//
// bootstrap.js is a webview-only IIFE that touches ~90 window/document
// APIs at load time, so it can't be safely require()'d or vm-executed in
// a plain Node test (that needs a real or simulated webview, see
// tests/vscode/**, which this task is scoped away from running). Instead
// this extracts the BENIGN_ERROR_RE literal straight from the source and
// exercises it directly, so a regression in the pattern itself (e.g. one
// that stops matching the real browser message text, or over-matches and
// swallows real errors) still fails a Node-only test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'vscode_extension', 'media', 'bootstrap.js'), 'utf8');

const match = SOURCE.match(/var BENIGN_ERROR_RE = (\/.*\/);/);
assert.ok(match, 'BENIGN_ERROR_RE literal not found in bootstrap.js');
// eslint-disable-next-line no-eval -- extracting a regex literal, not arbitrary code
const BENIGN_ERROR_RE = eval(match[1]);

test('both known-benign ResizeObserver messages match', () => {
  assert.ok(BENIGN_ERROR_RE.test('ResizeObserver loop completed with undelivered notifications.'));
  assert.ok(BENIGN_ERROR_RE.test('ResizeObserver loop limit exceeded'));
});

test('real errors, including unrelated ResizeObserver-mentioning ones, still match', () => {
  assert.ok(!BENIGN_ERROR_RE.test('TypeError: Cannot read properties of undefined'));
  assert.ok(!BENIGN_ERROR_RE.test('Uncaught ReferenceError: foo is not defined'));
  assert.ok(!BENIGN_ERROR_RE.test('Something mentions a ResizeObserver loop but is not the benign one'));
});

test('bootstrap.js actually drops benign messages before postError', () => {
  const errorListenerSrc = SOURCE.slice(SOURCE.indexOf("window.addEventListener('error'"));
  const handlerBody = errorListenerSrc.slice(0, errorListenerSrc.indexOf('});') + 3);
  assert.match(handlerBody, /if \(BENIGN_ERROR_RE\.test\(message\)\) return;/);
});
