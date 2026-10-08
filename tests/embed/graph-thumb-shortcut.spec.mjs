import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

// Graph Editor: V toggles node thumbnails of the selection; Ctrl+V stays paste.
const DOC = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39">',
  '  <constant name="c1" type="color3" xpos="0" ypos="0">',
  '    <input name="value" type="color3" value="1, 0, 0" />',
  '  </constant>',
  '  <constant name="c2" type="color3" xpos="2" ypos="0">',
  '    <input name="value" type="color3" value="0, 1, 0" />',
  '  </constant>',
  '</materialx>',
].join('\n');

const openGraphWith = async (page, embedURL, xml) => {
  // Thumbnails default off here so a per-node toggle is the only thing that can show one.
  await page.addInitScript(() => { try { localStorage.setItem('mtlxGraphThumbnails', 'false'); } catch (e) { /* storage blocked */ } });
  await page.goto(embedURL + '/index.html#!graph');
  await page.waitForSelector('.gtb-bar', { timeout: WAIT_TIMEOUT });
  await page.waitForFunction(() => typeof window.parseMtlxDocument === 'function', null, { timeout: WAIT_TIMEOUT });
  await page.evaluate((x) => {
    window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: { xml: x, name: 'thumbkey' } }));
  }, xml);
};

const card = (page, id) => page.locator('.react-flow__node[data-id="' + id + '"]');
const selectCard = (page, id) => card(page, id).click({ position: { x: 12, y: 8 } });
const thumb = (page, id) => card(page, id).locator('[data-mtlx-thumb]');

test('V toggles the thumbnail of the selected node, Ctrl+V does not', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, DOC);
  await card(page, 'n:c1').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  await expect(thumb(page, 'n:c1')).toHaveCount(0);

  await selectCard(page, 'n:c1');
  await page.keyboard.press('v');
  await expect(thumb(page, 'n:c1')).toHaveCount(1, { timeout: WAIT_TIMEOUT });
  await expect(thumb(page, 'n:c2')).toHaveCount(0);

  // Ctrl+V is paste and must leave thumbnails alone.
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(300);
  await expect(thumb(page, 'n:c1')).toHaveCount(1);

  await page.keyboard.press('v');
  await expect(thumb(page, 'n:c1')).toHaveCount(0, { timeout: WAIT_TIMEOUT });
});

test('V toggles every node of a multi-selection', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, DOC);
  await card(page, 'n:c1').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  await selectCard(page, 'n:c1');
  await card(page, 'n:c2').click({ position: { x: 12, y: 8 }, modifiers: ['Shift'] });
  await page.keyboard.press('v');
  await expect(thumb(page, 'n:c1')).toHaveCount(1, { timeout: WAIT_TIMEOUT });
  await expect(thumb(page, 'n:c2')).toHaveCount(1, { timeout: WAIT_TIMEOUT });

  // A second V turns both off again.
  await page.keyboard.press('v');
  await expect(thumb(page, 'n:c1')).toHaveCount(0, { timeout: WAIT_TIMEOUT });
  await expect(thumb(page, 'n:c2')).toHaveCount(0, { timeout: WAIT_TIMEOUT });
});
