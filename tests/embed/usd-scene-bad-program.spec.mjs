// tests/embed/usd-scene-bad-program.spec.mjs: the Scene used to stamp the
// FIRST bad program's log onto every compiled material (js/usd-scene-
// renderer.js's renderer.compile() check), so one broken material made
// every other material's warning misleading. Covers exact per-material
// attribution via renderer.properties.get(material).currentProgram.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
function fixtureFile(relativePath) {
  return { name: relativePath, mimeType: 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, relativePath)) };
}

test('@scene GPU program compilation failure is attributed to the broken material only', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();

  // GoodMaterial (good-material.mtlx) is an ordinary surface_unlit; BadMaterial
  // (bad-program.mtlx) reads an integer geompropvalue, which ESSL emits as a
  // non-flat vertex-to-fragment varying and fails at GPU link. Both quads
  // load in one stage so a shared/first-bad-log stamp would mislabel the
  // good one too.
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('bad-program-root.usda'),
    fixtureFile('good-material.mtlx'),
    fixtureFile('bad-program.mtlx'),
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 60000 });

  const warningsText = await page.getByTestId('usd-material-warnings').allTextContents();
  const compileFailures = warningsText.filter((w) => w.includes('GPU program compilation failed'));
  expect(compileFailures.length).toBe(1);
  expect(compileFailures[0]).toContain('bad-program.mtlx');
  expect(compileFailures.join('\n')).not.toContain('good-material.mtlx');
});
