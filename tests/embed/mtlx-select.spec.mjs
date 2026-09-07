import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene', 'nested');
function nestedFile(name) {
  return { name: 'nested/' + name, mimeType: 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, name)) };
}

// @select: exercises MtlxSelect's fit-to-text sizing and tooltip policy
// through the USD Scene root-layer picker, which already carries several
// long, similarly-prefixed candidate paths (the nested/ kettle fixtures).
test('@select root-layer options are not clipped and carry full-text tooltips', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    nestedFile('nested.usda'),
    nestedFile('prototype.usda'),
    nestedFile('instanced.usda'),
    nestedFile('curved-prototype.usda'),
    nestedFile('curved-instanced.usda'),
    nestedFile('direct-mesh-instanced.usda'),
    nestedFile('left-handed-mesh-instanced.usda'),
    nestedFile('kettle.usda'),
    nestedFile('materials/red.mtlx'),
    nestedFile('materials/blue.mtlx'),
  ]);

  const rootSelect = page.getByTestId('usd-scene-root-select');
  const trigger = rootSelect.getByRole('combobox');
  await expect(trigger).toBeVisible();
  const triggerBox = await trigger.boundingBox();

  await trigger.click();
  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  const popBox = await listbox.boundingBox();

  // The popover never renders narrower than the trigger it hangs from.
  expect(popBox.width).toBeGreaterThanOrEqual(triggerBox.width - 1);

  const options = listbox.getByRole('option');
  const count = await options.count();
  expect(count).toBeGreaterThan(1);
  for (let i = 0; i < count; i++) {
    const row = options.nth(i);
    const label = row.locator('span.truncate');
    const metrics = await label.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, text: el.textContent }));
    // No ellipsis clipping: the row grew (or the popover widened) enough
    // that the label's full text fits inside its own box.
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    const title = await row.getAttribute('title');
    expect(title).toBeTruthy();
    expect(title).toContain(metrics.text);
  }

  // Pick one option, then check the trigger's own tooltip includes it.
  const firstLabel = await options.first().locator('span.truncate').textContent();
  await options.first().click();
  const triggerTitle = await trigger.getAttribute('title');
  expect(triggerTitle).toContain(firstLabel);
});
