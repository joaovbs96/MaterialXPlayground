// tests/embed/graph-nodegraph-pins.spec.mjs: wires into a root nodegraph's
// interface inputs (its pins, as on a ShadingLanguageX code node) follow
// the node or nodegraph feeding them through rename and ungroup
// (collectConnectables, js/graph/model.jsx).

import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

// k feeds NG_a's pin x; NG_a feeds NG_b's pin y.
const CHAIN = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39">',
  '  <constant name="k" type="float" xpos="-3" ypos="0">',
  '    <input name="value" type="float" value="0.5" />',
  '  </constant>',
  '  <nodegraph name="NG_a" xpos="0" ypos="0">',
  '    <input name="x" type="float" nodename="k" />',
  '    <multiply name="m" type="float">',
  '      <input name="in1" type="float" interfacename="x" />',
  '      <input name="in2" type="float" value="2" />',
  '    </multiply>',
  '    <output name="out" type="float" nodename="m" />',
  '  </nodegraph>',
  '  <nodegraph name="NG_b" xpos="3" ypos="0">',
  '    <input name="y" type="float" nodegraph="NG_a" output="out" />',
  '    <add name="a" type="float">',
  '      <input name="in1" type="float" interfacename="y" />',
  '      <input name="in2" type="float" value="1" />',
  '    </add>',
  '    <output name="out" type="float" nodename="a" />',
  '  </nodegraph>',
  '</materialx>',
].join('\n');

const openGraphWith = async (page, embedURL, xml) => {
  await page.goto(embedURL + '/index.html#!graph');
  await page.waitForSelector('.gtb-bar', { timeout: WAIT_TIMEOUT });
  await page.waitForFunction(() => typeof window.parseMtlxDocument === 'function', null, { timeout: WAIT_TIMEOUT });
  await page.evaluate((x) => {
    window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: { xml: x, name: 'pins' } }));
  }, xml);
};

const graphXml = (page) => page.evaluate(async () => {
  try { return await window.__mtlxGetGraphXml(); } catch (e) { return ''; }
});
const pin = (xml, name) => (new RegExp('<input name="' + name + '"[^>]*/>').exec(xml) || [''])[0];
const card = (page, id) => page.locator('.react-flow__node[data-id="' + id + '"]');

const rename = async (page, id, to) => {
  await card(page, id).locator('.mtlx-node-name').first().dblclick();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(to);
  await page.keyboard.press('Enter');
};

test('renaming a node or nodegraph rewires the nodegraph pins it feeds', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, CHAIN);
  await card(page, 'g:NG_a').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });

  await rename(page, 'n:k', 'kk');
  await expect.poll(async () => pin(await graphXml(page), 'x'), { timeout: 10000 }).toMatch(/nodename="kk"/);

  await rename(page, 'g:NG_a', 'NG_aa');
  await expect.poll(async () => pin(await graphXml(page), 'y'), { timeout: 10000 }).toMatch(/nodegraph="NG_aa" output="out"/);
});

test('ungrouping a nodegraph rewires the nodegraph pins it feeds', async ({ page, embedURL }) => {
  await openGraphWith(page, embedURL, CHAIN);
  const ng = card(page, 'g:NG_a');
  await ng.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  await ng.locator('.mtlx-node-name').first().click();
  await page.getByRole('button', { name: /^Ungroup/ }).click();

  // NG_b's pin now reads the dissolved graph's output node, which reads k.
  await expect.poll(async () => pin(await graphXml(page), 'y'), { timeout: 10000 }).toMatch(/nodename="m"/);
  const xml = await graphXml(page);
  expect(xml).not.toMatch(/NG_a"/);
  expect(xml).toMatch(/<multiply name="m" type="float">\s*<input name="in1" type="float" nodename="k" \/>/);
  await expect(page.locator('.react-flow__edge[data-testid="rf__edge-n:m.out→g:NG_b.y"]')).toHaveCount(1);
});
