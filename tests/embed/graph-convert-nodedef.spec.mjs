import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

// Graph Editor "Convert to Node Def": the name field stays hidden until the
// button is pressed, the panel validates live, and one Ctrl+Z undoes it all.
const MARBLE = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39">',
  '  <nodegraph name="NG_marble1">',
  '    <input name="base_color_1" type="color3" value="0.8, 0.8, 0.8" />',
  '    <input name="base_color_2" type="color3" value="0.1, 0.1, 0.1" />',
  '    <input name="noise_scale_1" type="float" value="1.0" />',
  '    <input name="noise_scale_2" type="float" value="2.0" />',
  '    <input name="noise_power" type="float" value="3.0" />',
  '    <input name="marble_amount" type="float" value="0.5" />',
  '    <noise3d name="n1" type="float">',
  '      <input name="amplitude" type="float" interfacename="noise_scale_1" />',
  '    </noise3d>',
  '    <mix name="mix1" type="color3">',
  '      <input name="bg" type="color3" interfacename="base_color_1" />',
  '      <input name="fg" type="color3" interfacename="base_color_2" />',
  '      <input name="mix" type="float" nodename="n1" />',
  '    </mix>',
  '    <output name="out" type="color3" nodename="mix1" />',
  '  </nodegraph>',
  '  <standard_surface name="SR_marble1" type="surfaceshader">',
  '    <input name="base_color" type="color3" nodegraph="NG_marble1" output="out" />',
  '  </standard_surface>',
  '  <surfacematerial name="M_marble1" type="material">',
  '    <input name="surfaceshader" type="surfaceshader" nodename="SR_marble1" />',
  '  </surfacematerial>',
  '</materialx>',
].join('\n');

const open = async (page, embedURL) => {
  await page.addInitScript(() => { try { localStorage.setItem('mtlxGraphThumbnails', 'false'); } catch (e) { /* storage blocked */ } });
  await page.goto(embedURL + '/index.html#!graph');
  await page.waitForSelector('.gtb-bar', { timeout: WAIT_TIMEOUT });
  await page.waitForFunction(() => typeof window.parseMtlxDocument === 'function', null, { timeout: WAIT_TIMEOUT });
  await page.evaluate((x) => {
    window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: { xml: x, name: 'marble' } }));
  }, MARBLE);
  const card = page.locator('.react-flow__node[data-id="g:NG_marble1"]');
  await card.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  await card.click();
};

const xmlOf = (page) => page.evaluate(async () => {
  try { return await window.__mtlxGetGraphXml(); } catch (e) { return ''; }
});

test('convert to node def: hidden until pressed, live checks, one-step undo', async ({ page, embedURL }) => {
  await open(page, embedURL);
  const convert = page.getByRole('button', { name: 'Convert to Node Def' });
  const ungroup = page.getByRole('button', { name: /^Ungroup/ });
  await convert.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  await expect(page.locator('#promote-name')).toHaveCount(0);

  const a = await ungroup.boundingBox();
  const b = await convert.boundingBox();
  expect(Math.abs(a.y - b.y)).toBeLessThan(1);
  expect(Math.abs(a.height - b.height)).toBeLessThan(1);
  expect(Math.abs(a.width - b.width)).toBeLessThan(1);

  await convert.click();
  const name = page.locator('#promote-name');
  await expect(name).toBeVisible();
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('marble1');
  await expect(page.getByTestId('promote-nd')).toHaveText('ND_marble1_color3');
  await expect(page.getByTestId('promote-ng')).toHaveText('NG_marble1_color3');
  await expect(page.getByTestId('promote-inst')).toHaveText('NG_marble1');
  await expect(page.getByTestId('promote-summary')).toHaveText('Exposes 6 inputs and 1 output (color3)');
  await expect(convert).toHaveAttribute('aria-pressed', 'true');

  await name.fill('1bad');
  await expect(page.getByTestId('promote-error')).toContainText('number');
  await expect(page.getByTestId('promote-confirm')).toBeDisabled();
  await name.fill('mix');
  await expect(page.getByTestId('promote-warning')).toContainText('standard library');
  await expect(page.getByTestId('promote-confirm')).toBeEnabled();

  // Escape closes and returns focus to the button.
  await name.press('Escape');
  await expect(page.locator('#promote-name')).toHaveCount(0);
  await expect(convert).toBeFocused();

  const before = await xmlOf(page);
  await convert.click();
  await page.locator('#promote-name').fill('marble_mat');
  await page.locator('#promote-doc').fill('Marble from the test');
  await page.getByRole('combobox', { name: 'Node group' }).click();
  await page.getByRole('option', { name: 'procedural', exact: true }).click();
  await page.getByTestId('promote-confirm').click();

  await expect(page.locator('#promote-name')).toHaveCount(0);
  await expect.poll(async () => (await xmlOf(page)).includes('<nodedef name="ND_marble_mat_color3"'), { timeout: 15000 }).toBe(true);
  const after = await xmlOf(page);
  expect(after).toMatch(/<nodedef name="ND_marble_mat_color3"[^>]*node="marble_mat"/);
  expect(after).toMatch(/<nodedef [^>]*nodegroup="procedural"/);
  expect(after).toMatch(/<nodedef [^>]*doc="Marble from the test"/);
  expect(after).toContain('<nodegraph name="NG_marble_mat_color3" nodedef="ND_marble_mat_color3"');
  expect(after).toMatch(/<marble_mat name="NG_marble1"/);

  await page.locator('.react-flow__pane').first().click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect.poll(async () => xmlOf(page), { timeout: 15000 }).toBe(before);
});

test('convert to node def: Cancel refocuses the button, Enter converts', async ({ page, embedURL }) => {
  await open(page, embedURL);
  const convert = page.getByRole('button', { name: 'Convert to Node Def' });
  await convert.click();
  await page.getByTestId('promote-cancel').click();
  await expect(page.locator('#promote-name')).toHaveCount(0);
  await expect(convert).toBeFocused();
  await expect(convert).toHaveAttribute('aria-pressed', 'false');

  // Toggling the button again closes the open panel.
  await convert.click();
  await expect(page.locator('#promote-name')).toBeVisible();
  await convert.click();
  await expect(page.locator('#promote-name')).toHaveCount(0);

  // Enter in the name field converts, and an instance replaces the card.
  await convert.click();
  await page.locator('#promote-name').fill('marble1');
  await page.locator('#promote-name').press('Enter');
  await expect.poll(async () => (await xmlOf(page)).includes('<nodedef name="ND_marble1_color3"'), { timeout: 15000 }).toBe(true);
  await page.locator('.react-flow__node[data-id="n:NG_marble1"]').click();
  await expect(page.getByRole('button', { name: 'Convert to Node Def' })).toHaveCount(0);
});
