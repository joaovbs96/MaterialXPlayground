// Regression for the u_envIrradiance / u_envRadiance swap bug: the
// diffuse env uniform must bind the small SH irradiance texture, not
// the sharp radiance map, on every Scene material and on getEnvironment().
import { test, expect } from './lib/test-base.mjs';

test('@scene binds u_envIrradiance to the irradiance texture, not radiance', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-load-example').click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });

  const result = await page.evaluate(async () => {
    const handle = window.__mtlxUsdSceneHandle;
    const dbg = handle.__debug();
    const env = await window.getEnvironment();
    const perMaterial = dbg.materials.map((m) => {
      const u = m.uniforms || {};
      const irr = u.u_envIrradiance && u.u_envIrradiance.value;
      const rad = u.u_envRadiance && u.u_envRadiance.value;
      return {
        hasBoth: !!irr && !!rad,
        sameObject: irr === rad,
        irrWidth: irr && irr.image && irr.image.width,
        radWidth: rad && rad.image && rad.image.width,
        matchesEnvIrradiance: irr === env.irradiance,
      };
    });
    return { perMaterial };
  });

  expect(result.perMaterial.length).toBeGreaterThan(0);
  for (const m of result.perMaterial) {
    if (!m.hasBoth) continue;
    expect(m.sameObject).toBe(false);
    expect(m.irrWidth).toBeLessThan(m.radWidth);
    expect(m.matchesEnvIrradiance).toBe(true);
  }
});
