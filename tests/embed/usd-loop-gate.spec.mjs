// Not part of any CI tier: opt-in Step-1 prototype gate for Loop
// subdivision. Loads the Rook material once in the Viewer, then swaps
// geometry across the raw export and two Loop levels with fixed framing.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';

const rookRoot = process.env.USD_CHESS_ROOT
  ? path.join(path.dirname(process.env.USD_CHESS_ROOT), 'assets', 'Rook')
  : '';
const AB5 = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab5';
const AB7 = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab7';

test.describe('@viewer Loop subdivision prototype gate (opt-in)', () => {
  test.skip(!rookRoot, 'Set USD_CHESS_ROOT to run this gate.');
  test.setTimeout(300000);

  test('shoot rook-scene / rook-loop1 / rook-loop2 with the same framing', async ({ page, embedURL }) => {
    await page.setViewportSize({ width: 1400, height: 1100 });
    await page.goto(embedURL + '/index.html#!viewer');
    await page.waitForFunction(() => !document.body.innerText.includes('Generating shader'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);

    await page.locator('input[type=file][webkitdirectory]').first().setInputFiles(rookRoot);
    await page.waitForFunction(() => !document.body.innerText.includes('Generating shader'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.waitForFunction(() => !!window.__mtlxViewerHandle, { timeout: 20000 }).catch(() => {});

    await page.evaluate(() => { if (window.__setBackdropModeForTest) window.__setBackdropModeForTest('studio'); });
    await page.waitForTimeout(500);

    const objFiles = [
      ['rook-scene.obj', path.join(AB5, 'rook-scene.obj'), 'rook-scene.png'],
      ['rook-loop1.obj', path.join(AB7, 'rook-loop1.obj'), 'rook-loop1.png'],
      ['rook-loop2.obj', path.join(AB7, 'rook-loop2.obj'), 'rook-loop2.png'],
    ];

    for (const [label, objPath, outName] of objFiles) {
      expect(fs.existsSync(objPath), `${objPath} missing`).toBeTruthy();
      await page.locator('input[type=file][accept*=".obj"]').first().setInputFiles(objPath);
      await page.waitForFunction(() => !document.body.innerText.includes('Generating shader'), { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.locator('canvas').first().screenshot({ path: path.join(AB7, outName) });
      console.log('shot', label, '->', outName);
    }
  });
});
