import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

// Graph Editor: duplicate the clicked node or the selection through Shift+D, the context and Edit
// menus and Shift+drag; Shift+click adds to a selection, Ctrl+click removes from it, a plain click collapses it.
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
  await selectCard(page, 'n:m1', ['Shift']);
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

const cardIds = (page) => page.locator('.react-flow__node').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
const selectedIds = (page) => page.locator('.react-flow__node.selected').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')).sort());

test('Shift+drag duplicates once past the dead zone, the copy follows the pointer, one undo removes it', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, DOC);
  const before = await card(page, 'n:c2').boundingBox();
  const sx = before.x + HEAD.x, sy = before.y + HEAD.y;
  await page.keyboard.down('Shift');
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  // Inside the dead zone: nothing happens yet.
  await page.mouse.move(sx + 2, sy + 1);
  await page.waitForTimeout(150);
  expect(await nodeCount(page)).toBe(3);
  // Just past it, before release: the copy appears on the original, offset only by the pointer travel.
  await page.mouse.move(sx + 6, sy + 1);
  await expect.poll(() => nodeCount(page), { timeout: WAIT_TIMEOUT }).toBe(4);
  const copyId = (await cardIds(page)).find((id) => !['n:c1', 'n:m1', 'n:c2'].includes(id));
  expect(copyId).toMatch(/^n:c\d+$/);
  const first = await card(page, copyId).boundingBox();
  expect(Math.abs(first.x - before.x - 6)).toBeLessThan(1);
  expect(Math.abs(first.y - before.y - 1)).toBeLessThan(1);
  // Then it follows the pointer while the original stays.
  await page.mouse.move(sx + 40, sy + 30, { steps: 5 });
  await expect.poll(async () => Math.round((await card(page, copyId).boundingBox()).x - before.x)).toBe(40);
  await page.mouse.move(sx + 330, sy + 40, { steps: 10 });
  await expect.poll(async () => Math.round((await card(page, copyId).boundingBox()).x - before.x)).toBe(330);
  const copyBox = await card(page, copyId).boundingBox();
  expect(Math.abs(copyBox.y - before.y - 40)).toBeLessThan(2);
  const orig = await card(page, 'n:c2').boundingBox();
  expect(Math.abs(orig.x - before.x) + Math.abs(orig.y - before.y)).toBeLessThan(1);
  expect(byName(await docNodes(page), 'c2')).toMatchObject({ x: 0, y: 2 });
  await page.mouse.up();
  await page.keyboard.up('Shift');

  const nodes = await docNodes(page);
  expect(nodes.length).toBe(4);
  expect(byName(nodes, 'c2')).toMatchObject({ x: 0, y: 2 });
  expect(byName(nodes, 'c1')).toMatchObject({ x: 0, y: 0 });
  // Dropped well to the right of the original (xpos is in 240 px units).
  expect(byName(nodes, copyId.slice(2)).x).toBeGreaterThan(0.5);
  expect(await selectedIds(page)).toEqual([copyId]);

  // Undo snapshots are debounced; wait, then one Ctrl+Z drops the copy and the move in one step.
  await page.waitForTimeout(800);
  await page.keyboard.press('Control+z');
  await expect.poll(() => nodeCount(page), { timeout: WAIT_TIMEOUT }).toBe(3);
  expect(byName(await docNodes(page), 'c2')).toMatchObject({ x: 0, y: 2 });

  // A second, long gesture duplicates again, exactly once.
  const again = await card(page, 'n:c2').boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.move(again.x + HEAD.x, again.y + HEAD.y);
  await page.mouse.down();
  await page.mouse.move(again.x + HEAD.x + 300, again.y + HEAD.y + 120, { steps: 30 });
  await page.mouse.move(again.x + HEAD.x + 120, again.y + HEAD.y + 200, { steps: 30 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
  expect(await nodeCount(page)).toBe(4);
  expect(byName(await docNodes(page), 'c2')).toMatchObject({ x: 0, y: 2 });
});

test('Shift+drag on a selected node duplicates the whole selection and keeps inner wires', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, DOC);
  await selectCard(page, 'n:c1');
  await selectCard(page, 'n:m1', ['Shift']);
  const box = await card(page, 'n:m1').boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + HEAD.x, box.y + HEAD.y);
  await page.mouse.down();
  await page.mouse.move(box.x + HEAD.x + 60, box.y + HEAD.y + 200, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect.poll(() => nodeCount(page), { timeout: WAIT_TIMEOUT }).toBe(5);
  const nodes = await docNodes(page);
  expect(byName(nodes, 'c1')).toMatchObject({ x: 0, y: 0 });
  expect(byName(nodes, 'm1')).toMatchObject({ x: 2, y: 0, wires: ['c1'] });
  const mCopy = nodes.find((n) => n.cat === 'multiply' && n.name !== 'm1');
  expect(mCopy.wires.length).toBe(1);
  expect(mCopy.wires[0]).not.toBe('c1');
  expect(mCopy.y).toBeGreaterThan(0.3);
});

test('Shift+click adds to the selection, Ctrl+click removes a selected node and ignores an unselected one', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, DOC);
  await selectCard(page, 'n:c1');
  await selectCard(page, 'n:c2', ['Shift']);
  await selectCard(page, 'n:m1', ['Shift']);
  expect(await selectedIds(page)).toEqual(['n:c1', 'n:c2', 'n:m1']);
  // Shift+click on a selected node keeps it selected.
  await selectCard(page, 'n:c2', ['Shift']);
  expect(await selectedIds(page)).toEqual(['n:c1', 'n:c2', 'n:m1']);
  await selectCard(page, 'n:c2', ['Control']);
  expect(await selectedIds(page)).toEqual(['n:c1', 'n:m1']);
  await selectCard(page, 'n:m1', ['Control']);
  expect(await selectedIds(page)).toEqual(['n:c1']);
  await selectCard(page, 'n:c2', ['Control']);
  expect(await selectedIds(page)).toEqual(['n:c1']);
  expect(await nodeCount(page)).toBe(3);
  await page.locator('.react-flow__pane').first().click({ position: { x: 5, y: 5 } });
  expect(await selectedIds(page)).toEqual([]);
});

test('a plain click inside a multi-selection collapses it, a plain drag moves all of it', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, DOC);
  await selectCard(page, 'n:c1');
  await selectCard(page, 'n:c2', ['Shift']);
  await selectCard(page, 'n:m1', ['Shift']);
  await selectCard(page, 'n:c2');
  expect(await selectedIds(page)).toEqual(['n:c2']);

  await selectCard(page, 'n:c1');
  await selectCard(page, 'n:c2', ['Shift']);
  const box = await card(page, 'n:c2').boundingBox();
  await page.mouse.move(box.x + HEAD.x, box.y + HEAD.y);
  await page.mouse.down();
  await page.mouse.move(box.x + HEAD.x + 120, box.y + HEAD.y + 20, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => byName(await docNodes(page), 'c1').x, { timeout: WAIT_TIMEOUT }).toBeGreaterThan(0.2);
  const nodes = await docNodes(page);
  expect(nodes.length).toBe(3);
  expect(byName(nodes, 'c2').x).toBeGreaterThan(0.2);
  expect(byName(nodes, 'm1')).toMatchObject({ x: 2, y: 0 });
  expect(await selectedIds(page)).toEqual(['n:c1', 'n:c2']);
});

test('a plain click on a box-selected node collapses the selection to it', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, DOC);
  const boxes = await Promise.all(['n:c1', 'n:m1', 'n:c2'].map((id) => card(page, id).boundingBox()));
  const left = Math.min(...boxes.map((b) => b.x)) - 20, top = Math.min(...boxes.map((b) => b.y)) - 20;
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + 20, bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 20;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(right, bottom, { steps: 10 });
  await page.mouse.up();
  expect(await selectedIds(page)).toEqual(['n:c1', 'n:c2', 'n:m1']);
  const m1 = boxes[1];
  await page.mouse.click(m1.x + HEAD.x, m1.y + HEAD.y);
  await expect.poll(() => selectedIds(page)).toEqual(['n:m1']);
});
