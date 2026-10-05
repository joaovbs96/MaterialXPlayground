// tests/embed/graph-slx-node.spec.mjs: ShadingLanguageX code nodes in the
// Graph Editor (js/graph/slx-node.jsx). A code node is a root nodegraph
// whose interior is compiled from the SLX source in its slxsource
// attribute; edits made inside the graph decompile back into that source.
// vendor/mxslc/ is gitignored (fetched by `npm run vendor`), so these skip
// cleanly when it isn't on disk.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HAS_MXSLC = fs.existsSync(path.join(REPO_ROOT, 'vendor', 'mxslc', 'JsMxslc.wasm'));

const ROOT_ONLY = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39">',
  '  <constant name="c1" type="float">',
  '    <input name="value" type="float" value="0.25" />',
  '  </constant>',
  '</materialx>',
].join('\n');

// A code node: in1 wired from c1 at the root, in2 at 0.5 against its code's
// 0.0 default (as values set on the node used to be), the result feeding ss1. The
// comment's quotes, < and > must survive the attribute round trip, and the
// code view's decompile (an @slxsource string couldn't hold the quotes).
const CODE = [
  '[[nodegraph]]',
  'float brighten(float in1 = 0.0, float in2 = 0.0, float gain = 2.0)',
  '{',
  '    // keep the "gain" > 0 and < 10',
  '    return (in1 + in2) * clamp(gain, 0.0, 10.0);',
  '}',
].join('\n');
const attr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
const WITH_NODE = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39">',
  '  <constant name="c1" type="float" xpos="0" ypos="0">',
  '    <input name="value" type="float" value="0.25" />',
  '  </constant>',
  '  <nodegraph name="NG_brighten" slxsource="' + attr(CODE) + '" xpos="1.5" ypos="0">',
  '    <input name="in1" type="float" nodename="c1" />',
  '    <input name="in2" type="float" value="0.5" />',
  '    <input name="gain" type="float" value="2" />',
  '    <add name="var__0" type="float">',
  '      <input name="in1" type="float" interfacename="in1" />',
  '      <input name="in2" type="float" interfacename="in2" />',
  '    </add>',
  '    <clamp name="var__1" type="float">',
  '      <input name="in" type="float" interfacename="gain" />',
  '      <input name="low" type="float" value="0" />',
  '      <input name="high" type="float" value="10" />',
  '    </clamp>',
  '    <multiply name="var__2" type="float">',
  '      <input name="in1" type="float" nodename="var__0" />',
  '      <input name="in2" type="float" nodename="var__1" />',
  '    </multiply>',
  '    <output name="out" type="float" nodename="var__2" />',
  '  </nodegraph>',
  '  <standard_surface name="ss1" type="surfaceshader" xpos="3.5" ypos="0">',
  '    <input name="base" type="float" nodegraph="NG_brighten" output="out" />',
  '  </standard_surface>',
  '</materialx>',
].join('\n');

const openGraphWith = async (page, embedURL, xml) => {
  await page.goto(embedURL + '/index.html#!graph');
  await page.waitForSelector('.gtb-bar', { timeout: WAIT_TIMEOUT });
  await page.waitForFunction(() => typeof window.parseMtlxDocument === 'function', null, { timeout: WAIT_TIMEOUT });
  await page.evaluate((x) => {
    window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: { xml: x, name: 'slxnode' } }));
  }, xml);
};

const graphXml = (page) => page.evaluate(async () => {
  try { return await window.__mtlxGetGraphXml(); } catch (e) { return ''; }
});

const decodeAttr = (s) => s.replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
// The opening <nodegraph> tag of `name`, and its decoded slxsource.
const graphTag = (xml, name) => (new RegExp('<nodegraph name="' + name + '"[^>]*>').exec(xml) || [''])[0];
const slxSource = (xml, name) => {
  const m = /slxsource="([^"]*)"/.exec(graphTag(xml, name));
  return m ? decodeAttr(m[1]) : null;
};
const graphBody = (xml, name) => (new RegExp('<nodegraph name="' + name + '"[\\s\\S]*?</nodegraph>').exec(xml) || [''])[0];

// Hands keyboard focus back to the page, where the editor's own shortcuts
// (Tab, Ctrl+Z) listen.
const focusStage = (page) => page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });

const card = (page, id) => page.locator('.react-flow__node[data-id="' + id + '"]');
// Renames card `id` from the side panel's title, which doesn't depend on
// the canvas zoom (a far zoomed out card draws without its rename field).
const renameInPanel = async (page, id, to) => {
  await card(page, id).click();
  await page.getByTitle('Click to rename', { exact: true }).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(to);
  await page.keyboard.press('Enter');
};
// Pairs of cards on the canvas drawn over each other.
const overlappingCards = (page) => page.evaluate(() => {
  const boxes = Array.from(document.querySelectorAll('.react-flow__node')).map((n) => [n.dataset.id, n.getBoundingClientRect()]);
  const pairs = [];
  boxes.forEach(([a, r], i) => boxes.slice(i + 1).forEach(([b, s]) => {
    if (r.left < s.right && s.left < r.right && r.top < s.bottom && s.top < r.bottom) pairs.push(a + ' / ' + b);
  }));
  return pairs;
});
const editorOf = (page, id) => card(page, id).locator('.mtlx-slx-editor textarea');

test('adds a ShadingLanguageX node from the Tab palette and compiles edited code into it', async ({ page, embedURL }) => {
  test.skip(!HAS_MXSLC, 'vendor/mxslc not on disk (gitignored, run npm run vendor first)');
  await openGraphWith(page, embedURL, ROOT_ONLY);
  await card(page, 'n:c1').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });

  await focusStage(page);
  await page.keyboard.press('Tab');
  const search = page.getByPlaceholder(/Add a node/);
  await search.fill('shadinglanguagex');
  await page.keyboard.press('Enter');

  // The new node lands with the starter code, its caret in the editor.
  const editor = editorOf(page, 'g:NG_slx_node');
  await editor.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  await expect(editor).toBeFocused();
  await expect.poll(async () => slxSource(await graphXml(page), 'NG_slx_node'), { timeout: 10000 })
    .toMatch(/^\[\[nodegraph\]\]\ncolor3 slx_node\(/);
  expect(graphBody(await graphXml(page), 'NG_slx_node')).toMatch(/<randomcolor name=/);

  // Its panel can ungroup it, but the code sets its inputs and definition.
  await expect(page.getByRole('button', { name: /^Ungroup/ })).toBeEnabled();
  // Convert to Node Def stays disabled, so its name panel never opens.
  await expect(page.getByRole('button', { name: 'Convert to Node Def' })).toBeDisabled();
  await expect(page.getByPlaceholder('node name')).toHaveCount(0);
  const fields = page.locator('fieldset[disabled] input'); // scale
  await expect(fields).toHaveCount(1);
  for (const f of await fields.all()) await expect(f).toBeDisabled();

  // Typed code (real keystrokes: the editor auto-indents after "{" and
  // steps back for "}"), compiled with Ctrl+Enter. Renaming the function
  // renames the graph after it.
  await editor.fill('');
  await page.keyboard.type('[[nodegraph]]\nfloat scale(float in1 = 0.0, float gain = 3.0)\n{\nreturn in1 * gain;\n}');
  await expect(editor).toHaveValue('[[nodegraph]]\nfloat scale(float in1 = 0.0, float gain = 3.0)\n{\n    return in1 * gain;\n}');
  await page.keyboard.press('Control+Enter');

  await expect(card(page, 'g:NG_scale')).toBeVisible({ timeout: 10000 });
  await expect(card(page, 'g:NG_slx_node')).toHaveCount(0);
  const xml = await graphXml(page);
  expect(xml).not.toMatch(/NG_slx_node/);
  const body = graphBody(xml, 'NG_scale');
  expect(body).toMatch(/<input name="gain" type="float" value="3" \/>/);
  expect(body).toMatch(/<multiply name="var__0"/);
  await expect(card(page, 'g:NG_scale').locator('span', { hasText: /^gain$/ })).toBeVisible();
});

test('recompiling keeps the node\'s wires, gives its inputs the code\'s defaults, and shows compile errors', async ({ page, embedURL }) => {
  test.skip(!HAS_MXSLC, 'vendor/mxslc not on disk (gitignored, run npm run vendor first)');
  await openGraphWith(page, embedURL, WITH_NODE);
  const editor = editorOf(page, 'g:NG_brighten');
  await editor.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  // Read back exactly as authored: line breaks and the escaped "<".
  await expect(editor).toHaveValue(CODE);

  // A compile error stays on the card, squiggled on its line, and leaves
  // the graph alone.
  await editor.fill(CODE.replace('(in1 + in2)', '(in1 + )'));
  await card(page, 'g:NG_brighten').getByRole('button', { name: 'Compile' }).click();
  await expect(card(page, 'g:NG_brighten').locator('.mtlx-slx-error')).toContainText(/Invalid expression/, { timeout: 10000 });
  await expect(card(page, 'g:NG_brighten').locator('.slx-marks .slx-error')).toHaveText('return (in1 + ) * clamp(gain, 0.0, 10.0);');
  expect(graphBody(await graphXml(page), 'NG_brighten')).toMatch(/<clamp name="var__1"/);

  // Undoing the mistake puts back the node's own code: the error goes.
  await editor.fill(CODE);
  await expect(card(page, 'g:NG_brighten').locator('.mtlx-slx-error')).toHaveCount(0);
  await expect(card(page, 'g:NG_brighten').getByText('modified', { exact: true })).toHaveCount(0);
  await expect(card(page, 'g:NG_brighten').getByRole('button', { name: 'Compile' })).toBeDisabled();

  // New code: in1's wire survives, gain and in2 take the code's defaults.
  await editor.fill(CODE.replace('float gain = 2.0', 'float gain = 4.0').replace('(in1 + in2) * clamp(gain, 0.0, 10.0)', 'in1 * gain + in2'));
  await page.keyboard.press('Control+Enter');
  await expect.poll(async () => graphBody(await graphXml(page), 'NG_brighten'), { timeout: 10000 })
    .toMatch(/<input name="gain" type="float" value="4" \/>/);
  let body = graphBody(await graphXml(page), 'NG_brighten');
  expect(body).toMatch(/<input name="in1" type="float" nodename="c1" \/>/);
  expect(body).toMatch(/<input name="in2" type="float" value="0" \/>/);
  expect(await graphXml(page)).toMatch(/<input name="base" type="float" nodegraph="NG_brighten" output="out" \/>/);
  await expect(card(page, 'g:NG_brighten').locator('.mtlx-slx-error')).toHaveCount(0);

  // Two outputs: the root wire reading the old "out" is cut.
  await editor.fill('[[nodegraph]]\n{float a, float b} brighten(float in1 = 0.0, float in2 = 0.0)\n{\n    return {in1, in2};\n}');
  await page.keyboard.press('Control+Enter');
  await expect.poll(async () => graphBody(await graphXml(page), 'NG_brighten'), { timeout: 10000 })
    .toMatch(/<output name="out__b"/);
  body = graphBody(await graphXml(page), 'NG_brighten');
  expect(body).not.toMatch(/name="gain"/);
  expect(await graphXml(page)).not.toMatch(/nodegraph="NG_brighten"/);
});

test('editing inside a code node\'s graph leaves its code stale until the graph closes, and undo restores both', async ({ page, embedURL }) => {
  test.skip(!HAS_MXSLC, 'vendor/mxslc not on disk (gitignored, run npm run vendor first)');
  await page.addInitScript(() => { try { localStorage.setItem('mtlxGraphCodeViewOpen', 'true'); } catch (e) { /* no storage */ } });
  await openGraphWith(page, embedURL, WITH_NODE);
  const node = card(page, 'g:NG_brighten');
  await node.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  const panel = page.locator('aside', { has: page.locator('textarea[aria-label="ShadingLanguageX code"]') });
  const panelCode = panel.locator('textarea');
  const stale = panel.getByText('stale', { exact: true });

  // Double-click the card (outside its code) to open the graph.
  await node.locator('span', { hasText: /^in2$/ }).dblclick();
  const inner = card(page, 'n:var__0');
  await inner.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });

  // Rename a node inside: the node's code stays as it was, flagged stale...
  await inner.locator('.mtlx-node-name').dblclick();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('total');
  await page.keyboard.press('Enter');
  await expect(stale).toBeVisible({ timeout: 10000 });
  await expect(panelCode).toHaveValue(CODE);
  // ...though what leaves the editor (an export) carries it decompiled.
  const code = slxSource(await graphXml(page), 'NG_brighten');
  expect(code).toMatch(/float total = in1 \+ in2;/);
  await expect(panelCode).toHaveValue(CODE);
  // The inputs' values are the code's defaults; a wired one (which would
  // decompile to an uncompilable "= null") keeps the code's own.
  expect(code).toMatch(/float brighten\(float in1 = 0\.0, float in2 = 0\.5, float gain = 2\.0\)/);
  expect(code).not.toMatch(/null/);
  const recompiles = await page.evaluate(async (src) => {
    try { const { mx } = await getMxEnv(); await compileSlxGraph(mx, src, 'check'); return true; } catch (e) { return String(e.message || e); }
  }, code);
  expect(recompiles).toBe(true);
  // ...while the node's own wire and value stay put.
  const body = graphBody(await graphXml(page), 'NG_brighten');
  expect(body).toMatch(/<input name="in1" type="float" nodename="c1" \/>/);
  expect(body).toMatch(/<input name="in2" type="float" value="0.5" \/>/);

  // Back at the root, the code is decompiled from the graph.
  await page.getByRole('button', { name: /^Leave NG_brighten/ }).click();
  await expect(editorOf(page, 'g:NG_brighten')).toHaveValue(code, { timeout: WAIT_TIMEOUT });

  // Undo takes back the decompile, into the graph as it was left: stale...
  await focusStage(page);
  await page.keyboard.press('Control+Z');
  await expect(card(page, 'n:total')).toBeVisible({ timeout: WAIT_TIMEOUT });
  await expect(panelCode).toHaveValue(CODE);
  await expect(stale).toBeVisible();
  // ...then the edit, back out at the root.
  await focusStage(page);
  await page.keyboard.press('Control+Z');
  await expect(editorOf(page, 'g:NG_brighten')).toHaveValue(CODE, { timeout: WAIT_TIMEOUT });
  expect(slxSource(await graphXml(page), 'NG_brighten')).toBe(CODE);
  // Redo is still there for both.
  await page.keyboard.press('Control+Shift+Z');
  await expect(card(page, 'n:total')).toBeVisible({ timeout: WAIT_TIMEOUT });
  await expect(stale).toBeVisible({ timeout: 10000 });
});

test('the code view leaves a code node\'s source out of its code, and its Compile keeps the node a code node', async ({ page, embedURL }) => {
  test.skip(!HAS_MXSLC, 'vendor/mxslc not on disk (gitignored, run npm run vendor first)');
  await page.addInitScript(() => { try { localStorage.setItem('mtlxGraphCodeViewOpen', 'true'); } catch (e) { /* no storage */ } });
  // Unwired, at its code's defaults: compiling the document's code folds a
  // wire from a root node into a value, which changes the node's code.
  await openGraphWith(page, embedURL, WITH_NODE
    .replace('<input name="in1" type="float" nodename="c1" />', '<input name="in1" type="float" value="0" />')
    .replace('<input name="in2" type="float" value="0.5" />', '<input name="in2" type="float" value="0" />'));
  await card(page, 'g:NG_brighten').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });

  // The code view's own editor (the node card's sits on the canvas).
  const panel = page.locator('aside', { has: page.locator('textarea[aria-label="ShadingLanguageX code"]') });
  const panelCode = panel.locator('textarea');
  await expect(panelCode).toHaveValue(/float brighten\(/, { timeout: WAIT_TIMEOUT });
  const decompiled = await panelCode.inputValue();
  expect(decompiled).not.toMatch(/slxsource/);

  // Compiling it unchanged keeps the node's own code, quotes and comment included.
  await panel.getByRole('button', { name: /^Compile/ }).click();
  await expect(panel.getByText('Compiled into the node graph.')).toBeVisible({ timeout: 10000 });
  expect(slxSource(await graphXml(page), 'NG_brighten')).toBe(CODE);
  await expect(editorOf(page, 'g:NG_brighten')).toHaveValue(CODE);

  // A function changed in the code view: the node's code is rebuilt from
  // its new graph.
  expect(decompiled).toMatch(/clamp\(gain, 0\.0, 10\.0\)/);
  await panelCode.fill(decompiled.replace('clamp(gain, 0.0, 10.0)', 'clamp(gain, 0.0, 5.0)'));
  await panel.getByRole('button', { name: /^Compile/ }).click();
  await expect.poll(async () => slxSource(await graphXml(page), 'NG_brighten'), { timeout: 10000 })
    .toMatch(/clamp\(gain, 0\.0, 5\.0\)/);
  const code = slxSource(await graphXml(page), 'NG_brighten');
  expect(code).toMatch(/^\[\[nodegraph\]\]\nfloat brighten\(float in1 = 0\.0, float in2 = 0\.0, float gain = 2\.0\)/);
  expect(code).not.toMatch(/c1|null/);
  const recompiles = await page.evaluate(async (src) => {
    try { const { mx } = await getMxEnv(); await compileSlxGraph(mx, src, 'check'); return true; } catch (e) { return String(e.message || e); }
  }, code);
  expect(recompiles).toBe(true);
});

test('inside a code node\'s graph the code view works on the node\'s code, and leaving decompiles just that code', async ({ page, embedURL }) => {
  test.skip(!HAS_MXSLC, 'vendor/mxslc not on disk (gitignored, run npm run vendor first)');
  await page.addInitScript(() => { try { localStorage.setItem('mtlxGraphCodeViewOpen', 'true'); } catch (e) { /* no storage */ } });
  await openGraphWith(page, embedURL, WITH_NODE);
  const node = card(page, 'g:NG_brighten');
  await node.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  const panel = page.locator('aside', { has: page.locator('textarea[aria-label="ShadingLanguageX code"]') });
  const panelCode = panel.locator('textarea');
  await expect(panelCode).toHaveValue(/float brighten\(/, { timeout: WAIT_TIMEOUT });
  const docCode = await panelCode.inputValue();

  // Opening the graph shows the node's own code, comment and all.
  await node.locator('span', { hasText: /^in2$/ }).dblclick();
  await card(page, 'n:var__0').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  await expect(panelCode).toHaveValue(CODE);

  // An edit inside the graph leaves the code stale until Decompile.
  await card(page, 'n:var__0').locator('.mtlx-node-name').dblclick();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('total');
  await page.keyboard.press('Enter');
  await expect(panel.getByText('stale', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(panelCode).toHaveValue(CODE);
  await panel.getByRole('button', { name: /^Decompile/ }).click();
  await expect(panelCode).toHaveValue(/float total = in1 \+ in2;/, { timeout: 10000 });
  await expect(panel.getByText('stale', { exact: true })).toHaveCount(0);

  // Compile goes into the node alone, its graph laid out afresh: the nodes
  // that kept their names don't keep their old places among the new ones.
  const edited = (await panelCode.inputValue()).replace('clamp(gain, 0.0, 10.0)', 'clamp(gain, 0.0, 5.0) + sin(in1) * 0.5');
  await panelCode.fill(edited);
  await panel.getByRole('button', { name: /^Compile/ }).click();
  await expect(panel.getByText('Compiled into the node graph.')).toBeVisible({ timeout: 10000 });
  expect(slxSource(await graphXml(page), 'NG_brighten')).toBe(edited);
  expect(graphBody(await graphXml(page), 'NG_brighten')).toMatch(/<input name="high" type="float" value="5" \/>/);
  await expect(card(page, 'n:total')).toBeVisible();
  await expect.poll(() => overlappingCards(page), { timeout: 5000 }).toEqual([]);

  // A compile error stays in the panel, squiggled.
  await panelCode.fill(edited.replace('in1 + in2', 'in1 + '));
  await panel.getByRole('button', { name: /^Compile/ }).click();
  await expect(panel.locator('.slx-marks .slx-error')).toHaveCount(1, { timeout: 10000 });
  expect(slxSource(await graphXml(page), 'NG_brighten')).toBe(edited);

  // Decompile rebuilds the node's code from its graph.
  await panel.getByRole('button', { name: /^Decompile/ }).click();
  await expect(panel.getByText('Decompiled from the node\u2019s graph.')).toBeVisible({ timeout: 10000 });
  await expect(panelCode).toHaveValue(/clamp\(gain, 0\.0, 5\.0\)/);
  expect(slxSource(await graphXml(page), 'NG_brighten')).toBe(await panelCode.inputValue());

  // An edit right before leaving is in the node's code as the graph closes;
  // the document's code is left as it was, stale.
  await renameInPanel(page, 'n:total', 'sum');
  await page.getByRole('button', { name: /^Leave NG_brighten/ }).click();
  await expect(editorOf(page, 'g:NG_brighten')).toHaveValue(/float sum = in1 \+ in2;/, { timeout: WAIT_TIMEOUT });
  await expect(panelCode).toHaveValue(docCode);
  await expect(panel.getByText('stale', { exact: true })).toBeVisible({ timeout: 10000 });

  // Uncompiled code left in the panel is the node's draft on its card,
  // over any edit made inside the graph after it, which leaves it stale.
  await node.locator('span', { hasText: /^in2$/ }).dblclick();
  await card(page, 'n:sum').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  await expect(panel.getByText('stale', { exact: true })).toHaveCount(0);
  const draft = (await panelCode.inputValue()) + '\n// draft';
  await panelCode.fill(draft);
  await renameInPanel(page, 'n:sum', 'both');
  await expect(panel.getByText('stale', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(panel.getByText('modified', { exact: true })).toBeVisible();
  await expect(panel.getByText('/', { exact: true })).toBeVisible();
  await expect(panelCode).toHaveValue(draft);
  await page.getByRole('button', { name: /^Leave NG_brighten/ }).click();
  await expect.poll(async () => slxSource(await graphXml(page), 'NG_brighten'), { timeout: 10000 }).toMatch(/float both = in1 \+ in2;/);
  await expect(editorOf(page, 'g:NG_brighten')).toHaveValue(draft);
  await expect(node.getByText('modified', { exact: true })).toBeVisible();
});

test('the code view flags its code stale once the graph changes', async ({ page, embedURL }) => {
  test.skip(!HAS_MXSLC, 'vendor/mxslc not on disk (gitignored, run npm run vendor first)');
  await page.addInitScript(() => { try { localStorage.setItem('mtlxGraphCodeViewOpen', 'true'); } catch (e) { /* no storage */ } });
  await openGraphWith(page, embedURL, ROOT_ONLY);
  const panel = page.locator('aside', { has: page.locator('textarea[aria-label="ShadingLanguageX code"]') });
  const panelCode = panel.locator('textarea');
  await expect(panelCode).toHaveValue(/float c1 = constant\(0\.25\);/, { timeout: WAIT_TIMEOUT });
  const stale = panel.getByText('stale', { exact: true });
  await expect(stale).toHaveCount(0);

  await card(page, 'n:c1').locator('.mtlx-node-name').dblclick();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('c2');
  await page.keyboard.press('Enter');
  await expect(stale).toBeVisible({ timeout: 10000 });

  // Undo puts back the graph the code describes; redo moves off it again.
  await focusStage(page);
  await page.keyboard.press('Control+Z');
  await expect(stale).toHaveCount(0, { timeout: 10000 });
  await page.keyboard.press('Control+Shift+Z');
  await expect(stale).toBeVisible({ timeout: 10000 });

  await panel.getByRole('button', { name: /^Decompile/ }).click();
  await expect(panelCode).toHaveValue(/float c2 = constant\(0\.25\);/, { timeout: 10000 });
  await expect(stale).toHaveCount(0);

  // A compile leaves the code describing its own graph.
  await panelCode.fill((await panelCode.inputValue()).replace('0.25', '0.5'));
  await panel.getByRole('button', { name: /^Compile/ }).click();
  await expect(panel.getByText('Compiled into the node graph.')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(1000); // past the undo snapshot that checks it
  await expect(stale).toHaveCount(0);
});

test('an interface input\'s value set inside a code node\'s graph becomes the code\'s default', async ({ page, embedURL }) => {
  test.skip(!HAS_MXSLC, 'vendor/mxslc not on disk (gitignored, run npm run vendor first)');
  await openGraphWith(page, embedURL, WITH_NODE);
  const node = card(page, 'g:NG_brighten');
  await node.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  await node.locator('span', { hasText: /^in2$/ }).dblclick();
  const gain = card(page, 'i:gain');
  await gain.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  await gain.click();
  const value = page.locator('input[type="number"]').last();
  await expect(value).toHaveValue('2');
  await value.fill('4');
  await value.press('Enter');
  await page.getByRole('button', { name: /^Leave NG_brighten/ }).click();
  await expect(editorOf(page, 'g:NG_brighten')).toHaveValue(/float brighten\(float in1 = 0\.0, float in2 = 0\.5, float gain = 4\.0\)/, { timeout: WAIT_TIMEOUT });
  expect(graphBody(await graphXml(page), 'NG_brighten')).toMatch(/<input name="gain" type="float" value="4" \/>/);
});

// Names of every nodegraph in the document, and the entry function each one's
// slxsource defines (the first function after [[nodegraph]]).
const codeNodes = (xml) => Array.from(xml.matchAll(/<nodegraph name="([^"]+)"[^>]*>/g)).map((m) => {
  const src = slxSource(xml, m[1]);
  const fn = src ? (/(?:^|\n)[^\n(]*?\b(\w+)\s*\(/.exec(src.replace(/^\[\[nodegraph\]\]\n?/, '')) || [])[1] : null;
  return { name: m[1], src, fn };
}).filter((n) => n.src !== null);

test('copy and paste of a code node keeps its name and entry function in step', async ({ page, embedURL }) => {
  test.skip(!HAS_MXSLC, 'vendor/mxslc not on disk (gitignored, run npm run vendor first)');
  await openGraphWith(page, embedURL, WITH_NODE);
  const node = card(page, 'g:NG_brighten');
  await node.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });

  // Select the card by its header (not its code editor), then the app's
  // Ctrl+C / Ctrl+V (graph-app.jsx, stage keydown handler).
  await node.locator('span', { hasText: /^in2$/ }).click();
  await focusStage(page);
  await page.keyboard.press('Control+C');
  await page.keyboard.press('Control+V');

  await expect.poll(async () => codeNodes(await graphXml(page)).length, { timeout: 10000 }).toBe(2);
  const nodes = codeNodes(await graphXml(page));
  const original = nodes.find((n) => n.name === 'NG_brighten');
  const pasted = nodes.find((n) => n.name !== 'NG_brighten');
  // The original is untouched.
  expect(original.src).toBe(CODE);
  // The pasted graph keeps an slxsource whose entry function matches its
  // own name (NG_<fn>), and no two code nodes define the same function.
  expect(pasted.fn).toBeTruthy();
  expect(pasted.name).toBe('NG_' + pasted.fn);
  expect(pasted.fn).not.toBe('brighten');
  expect(new Set(nodes.map((n) => n.fn)).size).toBe(nodes.length);
});
