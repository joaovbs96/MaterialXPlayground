import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

// Graph Editor: duplicate the clicked node or the selection through Shift+D, the context and Edit
// menus and Shift+drag; Ctrl+click extends a selection, Shift+click does not.
const DOC = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39">',
  '  <constant name="c1" type="color3" xpos="0" ypos="0">',
  '    <input name="value" type="color3" value="1, 0, 0" />',
  '  </constant>',
  '  <multiply name="m1" type="color3" xpos="2" ypos="0">',
  '    <input name="in1" type="color3" nodename="c1" />',
  '    <input name="in2" type="color3" value="0.5, 0.5, 0.5" />',
  '  </multiply>',
  '  <constant name="c2" type="color3" xpos="0" ypos="2">',
  '    <input name="value" type="color3" value="0, 1, 0" />',
  '  </constant>',
  '</materialx>',
].join('\n');

const card = (page, id) => page.locator('.react-flow__node[data-id="' + id + '"]');
const HEAD = { x: 14, y: 8 };
const selectCard = (page, id, modifiers) => card(page, id).click({ position: HEAD, modifiers });

const openGraphWith = async (page, embedURL, xml) => {
  await page.addInitScript(() => { try { localStorage.setItem('mtlxGraphThumbnails', 'false'); } catch (e) { /* storage blocked */ } });
  await page.goto(embedURL + '/index.html#!graph');
  await page.waitForSelector('.gtb-bar', { timeout: WAIT_TIMEOUT });
  await page.waitForFunction(() => typeof window.parseMtlxDocument === 'function', null, { timeout: WAIT_TIMEOUT });
  await page.evaluate((x) => {
    window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: { xml: x, name: 'dup' } }));
  }, xml);
  await card(page, 'n:c1').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  await page.waitForTimeout(500); // fit and layout settle
};

// Every top-level node of the live document: name, category, xpos, ypos, input wiring.
const docNodes = (page) => page.evaluate(async () => {
  const xml = await window.__mtlxGetGraphXml();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return Array.from(doc.documentElement.children).filter((e) => e.getAttribute('name')).map((e) => ({
    name: e.getAttribute('name'), cat: e.tagName,
    x: parseFloat(e.getAttribute('xpos')), y: parseFloat(e.getAttribute('ypos')),
    wires: Array.from(e.children).map((i) => i.getAttribute('nodename')).filter(Boolean),
  }));
});
const byName = (nodes, name) => nodes.find((n) => n.name === name);
const nodeCount = async (page) => (await docNodes(page)).length;

test('Shift+D duplicates the selected node next to the original', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, DOC);
  await selectCard(page, 'n:c2');
  await page.keyboard.press('Shift+D');
  await expect.poll(() => nodeCount(page)).toBe(4);
  const nodes = await docNodes(page);
  const copy = nodes.find((n) => n.cat === 'constant' && n.name !== 'c1' && n.name !== 'c2');
  expect(copy).toBeTruthy();
  expect(copy.name).toMatch(/^c\d+$/);
  expect(byName(nodes, 'c2')).toMatchObject({ x: 0, y: 2 });
  expect(copy.x).toBeGreaterThan(0);
  expect(copy.y).toBeGreaterThan(2);
});

test('the context menu duplicates the clicked node and keeps inner wires of a selection', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, DOC);
  await selectCard(page, 'n:c1');
  await card(page, 'n:c1').click({ button: 'right', position: HEAD });
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect.poll(() => nodeCount(page)).toBe(4);

  // Selection of c1 + m1: the copy of m1 reads the copy of c1, not the original.
  await selectCard(page, 'n:c1');
  await selectCard(page, 'n:m1', ['Control']);
  await card(page, 'n:m1').click({ button: 'right', position: HEAD });
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect.poll(() => nodeCount(page)).toBe(6);
  const nodes = await docNodes(page);
  const originals = new Set(['c1', 'm1', 'c2']);
  const mults = nodes.filter((n) => n.cat === 'multiply');
  expect(mults.length).toBe(2);
  const mCopy = mults.find((n) => !originals.has(n.name));
  expect(mCopy.name).toMatch(/^m\d+$/);
  expect(mCopy.wires.length).toBe(1);
  expect(mCopy.wires[0]).not.toBe('c1');
  expect(byName(nodes, mCopy.wires[0])).toBeTruthy();
  expect(byName(nodes, 'm1').wires).toEqual(['c1']);
  expect(byName(nodes, 'c1')).toMatchObject({ x: 0, y: 0 });
});

test('the Edit menu Duplicate row works and is disabled with nothing selected', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, DOC);
  await page.locator('.react-flow__pane').first().click({ position: { x: 5, y: 5 } });
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');

  await selectCard(page, 'n:c2');
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect.poll(() => nodeCount(page)).toBe(4);
});

test('Shift+drag leaves the original, drops a copy, and one undo removes the copy', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, DOC);
  const box = await card(page, 'n:c2').boundingBox();
  const sx = box.x + HEAD.x, sy = box.y + HEAD.y;
  await page.keyboard.down('Shift');
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 40, sy + 30, { steps: 5 });
  await page.mouse.move(sx + 330, sy + 40, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Shift');

  await expect.poll(() => nodeCount(page), { timeout: WAIT_TIMEOUT }).toBe(4);
  const nodes = await docNodes(page);
  expect(byName(nodes, 'c2')).toMatchObject({ x: 0, y: 2 });
  const copy = nodes.find((n) => n.cat === 'constant' && n.name !== 'c1' && n.name !== 'c2');
  expect(copy).toBeTruthy();
  // Dropped well to the right of the original (xpos is in 240 px units).
  expect(copy.x).toBeGreaterThan(0.5);
  expect(byName(nodes, 'c1')).toMatchObject({ x: 0, y: 0 });

  // Undo snapshots are debounced; wait, then one Ctrl+Z drops the copy and the drag in one step.
  await page.waitForTimeout(800);
  await page.keyboard.press('Control+z');
  await expect.poll(() => nodeCount(page), { timeout: WAIT_TIMEOUT }).toBe(3);
  expect(byName(await docNodes(page), 'c2')).toMatchObject({ x: 0, y: 2 });
});

test('Ctrl+click extends the selection, Shift+click does not', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, DOC);
  const selected = () => page.locator('.react-flow__node.selected').count();
  await selectCard(page, 'n:c1');
  await selectCard(page, 'n:c2', ['Control']);
  expect(await selected()).toBe(2);
  await page.locator('.react-flow__pane').first().click({ position: { x: 5, y: 5 } });
  expect(await selected()).toBe(0);
  await selectCard(page, 'n:c1');
  await selectCard(page, 'n:c2', ['Shift']);
  expect(await selected()).toBe(1);
});
