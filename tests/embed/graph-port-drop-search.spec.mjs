import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

// Graph Editor: a drag from a port to empty canvas offers multi-output nodes
// whose outputs match, and wires the matching output; a plain click on a card
// never writes positions into the document.
const OUTPUT_ONLY = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39">',
  '  <constant name="c1" type="color3">',
  '    <input name="value" type="color3" value="1, 0, 0" />',
  '  </constant>',
  '  <output name="out1" type="float" />',
  '</materialx>',
].join('\n');

const openGraphWith = async (page, embedURL, xml) => {
  // With thumbnails the cards grow and the fixed drop point (55%/15% of the pane) lands on a card, not empty canvas.
  await page.addInitScript(() => { try { localStorage.setItem('mtlxGraphThumbnails', 'false'); } catch (e) { /* storage blocked */ } });
  await page.goto(embedURL + '/index.html#!graph');
  await page.waitForSelector('.gtb-bar', { timeout: WAIT_TIMEOUT });
  await page.waitForFunction(() => typeof window.parseMtlxDocument === 'function', null, { timeout: WAIT_TIMEOUT });
  await page.evaluate((x) => {
    window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: { xml: x, name: 'portdrop' } }));
  }, xml);
};

const graphXml = (page) => page.evaluate(async () => {
  try { return await window.__mtlxGetGraphXml(); } catch (e) { return ''; }
});

// Waits until a locator's box stops moving (layout and fit settle async).
const settledBox = async (page, locator) => {
  let box = await locator.boundingBox();
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(200);
    const next = await locator.boundingBox();
    if (next && box && Math.abs(next.x - box.x) < 0.5 && Math.abs(next.y - box.y) < 0.5) return next;
    box = next;
  }
  return box;
};

test('dropping an output port on empty canvas offers separate3 and wires output=', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, OUTPUT_ONLY);
  const card = page.locator('.react-flow__node[data-id="o:out1"]');
  await card.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  const handle = card.locator('.react-flow__handle').first();
  const hBox = await settledBox(page, handle);
  const pane = await page.locator('.react-flow__pane').first().boundingBox();
  const drop = { x: pane.x + pane.width * 0.55, y: pane.y + pane.height * 0.15 };

  await page.mouse.move(hBox.x + hBox.width / 2, hBox.y + hBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(hBox.x + hBox.width / 2 + 15, hBox.y + hBox.height / 2 + 10, { steps: 5 });
  await page.mouse.move(drop.x, drop.y, { steps: 15 });
  await page.mouse.up();

  const search = page.getByPlaceholder(/Add a connected node|Add a node/);
  await search.waitFor({ state: 'visible', timeout: 8000 });
  await search.fill('separate3');
  await expect(page.getByText(/No node matches/)).toHaveCount(0);
  await page.keyboard.press('Enter');

  await expect.poll(async () => {
    const m = /<output [^>]*name="out1"[^>]*>/.exec(await graphXml(page));
    return m ? m[0] : '';
  }, { timeout: 10000 }).toMatch(/nodename="separate3\w*"/);
  const out = /<output [^>]*name="out1"[^>]*>/.exec(await graphXml(page))[0];
  expect(out).toMatch(/output="out[rgb]"/);
});

// Real mice move 1-4 px between down and up: a click with that jitter must
// not write positions, while a real drag still snapshots the layout.
for (const [label, jitter] of [['no jitter', []], ['1 px jitter', [[1, 0]]], ['4 px jitter', [[2, 1], [4, 2]]]]) {
  test(`a click with ${label} on a card does not write xpos/ypos into the document`, async ({ page, embedURL }) => {
    await page.addInitScript(() => { window.__edits = []; window.__mtlxNotifyEdit = (x) => window.__edits.push(x); });
    await openGraphWith(page, embedURL, OUTPUT_ONLY);
    const card = page.locator('.react-flow__node[data-id="n:c1"]');
    await card.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    const box = await settledBox(page, card);
    await page.waitForTimeout(800);
    await page.evaluate(() => { window.__edits.length = 0; });
    const x = box.x + 14, y = box.y + 8;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (const [dx, dy] of jitter) { await page.mouse.move(x + dx, y + dy); await page.waitForTimeout(16); }
    await page.mouse.up();
    await page.waitForTimeout(1200);
    await expect(card).toHaveClass(/selected/);
    expect(await graphXml(page)).not.toMatch(/xpos=/);
    expect(await page.evaluate(() => window.__edits.filter((e) => /xpos=/.test(e)).length)).toBe(0);
    const after = await card.boundingBox();
    expect(Math.abs(after.x - box.x) + Math.abs(after.y - box.y)).toBeLessThan(0.5);
  });
}

test('a real drag of a card still writes xpos/ypos', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, OUTPUT_ONLY);
  const card = page.locator('.react-flow__node[data-id="n:c1"]');
  await card.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  const box = await settledBox(page, card);
  const x = box.x + 14, y = box.y + 8;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y + 20, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => graphXml(page), { timeout: WAIT_TIMEOUT }).toMatch(/xpos=/);
});
