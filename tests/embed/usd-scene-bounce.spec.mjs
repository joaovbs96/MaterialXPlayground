// tests/embed/usd-scene-bounce.spec.mjs: "no effect outside the Scene" for
// the diffuse bounce term (js/mtlx-engine.js's mx_diffuse_bounce_add,
// injected by patchDiffuseBounceAdd; see bounce/implementation.md and its
// v2 addendum). Two independent checks:
//   1. a plain (non-Scene) #!viewer compile DOES get the
//      mx_diffuse_bounce_add() call textually (needsLighting:true gives it
//      the same positionWorld/normalWorld varyings the existing
//      sky-visibility/AO-volume hooks already rely on there, and
//      standard_surface's own generated code always has
//      base_color_nonnegative_out in scope), but its u_skyBounceStrength
//      AND u_bounceERef uniforms both default to 0, which is what actually
//      makes it an exact no-op (the injected function's first line is "if
//      (u_skyBounceStrength <= 0.0 || u_bounceERef <= 0.0) return
//      vec3(0.0);"). This mirrors u_skyVisStrength/u_aoVolumeStrength,
//      both already 0 by default outside the Scene;
//   2. storedSceneBounce() (js/usd-scene-renderer.js), the setting's
//      reader, returns false whenever window.top !== window, which is the
//      guard that keeps every embed and the VS Code webview off by
//      construction regardless of what is stored in localStorage.
import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

const SIMPLE_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="surf" type="surfaceshader">
    <input name="base_color" type="color3" value="0.5, 0.5, 0.5" />
  </standard_surface>
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
  </surfacematerial>
</materialx>`;

test('a non-Scene compiled material has the bounce hook wired but its strength defaults to 0 (exact no-op)', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!viewer');
  await page.waitForFunction(
    () => window.getMxEnv && window.createMtlxRenderView && window.THREE,
    null, { timeout: WAIT_TIMEOUT }
  );

  const result = await page.evaluate(async (xml) => {
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const { name: resolvedMaterialName, node: renderable } = window.listDocRenderables(doc)[0];
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const view = await window.createMtlxRenderView({
      canvas, mx: env.mx, gen: env.gen, genContext: env.genContext, renderable,
      label: 'usd-scene-bounce-embed-test', geomName: 'sphere', needsLighting: true,
      materialName: resolvedMaterialName,
      isMounted: () => true,
    });
    const material = view.__debug().material;
    const strengthUniform = material.uniforms && material.uniforms.u_skyBounceStrength;
    const eRefUniform = material.uniforms && material.uniforms.u_bounceERef;
    return {
      fragmentShader: material.fragmentShader,
      strength: strengthUniform ? strengthUniform.value : null,
      eRef: eRefUniform ? eRefUniform.value : null,
    };
  }, SIMPLE_MTLX);

  expect(typeof result.fragmentShader).toBe('string');
  // Same pattern as the existing sky-visibility/AO-volume hooks: present in
  // the source (needsLighting gives the Viewer the same world-position
  // varyings the Scene uses, and standard_surface always computes
  // base_color_nonnegative_out), inert because both uniforms are 0.
  expect(result.fragmentShader).toContain('vec3 mx_diffuse_bounce_add(vec3 albedo)');
  expect(result.fragmentShader).toContain('if (u_skyBounceStrength <= 0.0 || u_bounceERef <= 0.0) return vec3(0.0);');
  // Regression guard: the additive call must be part of the SAME statement
  // as the original "shader_constructor_out.color += occlusion * ...
  // response;" line, not appended after its semicolon (that split one
  // statement into a bare "+ fn(...);" expression-statement, which hung
  // the real GPU's shader compiler solid on a real asset with no console
  // error at all -- caught only by an actual headed render, not by reading
  // the source text alone, which is why this spec exists in the embed
  // suite rather than only in the Node unit test).
  expect(result.fragmentShader).toMatch(/shader_constructor_out\.color \+= occlusion \* \w+\.response \+ mx_diffuse_bounce_add\(base_color_nonnegative_out\);/);
  expect(result.strength).toBe(0);
  expect(result.eRef).toBe(0);
});

test('storedSceneBounce() reads false inside an embed (window.top !== window)', async ({ page, embedURL }) => {
  // Force the setting on in the raw localStorage key first, so this proves
  // the iframe guard itself (not just an unset default) is what returns
  // false: this only works because the iframe below is same-origin, so it
  // shares the same localStorage as the top page it is embedded in.
  await page.goto(embedURL + '/index.html#!scene');
  await page.evaluate(() => localStorage.setItem('mtlx_scene_bounce', '1'));

  const frameAttached = page.waitForEvent('frameattached');
  await page.evaluate((src) => {
    const f = document.createElement('iframe');
    f.src = src;
    document.body.appendChild(f);
    window.__bounceTestIframe = f;
  }, embedURL + '/index.html#!scene');
  const frame = await frameAttached;
  await frame.waitForFunction(() => typeof storedSceneBounce === 'function', null, { timeout: WAIT_TIMEOUT });

  const [topIsWindow, storedInIframe, storedOnTop] = await Promise.all([
    frame.evaluate(() => window.top === window),
    frame.evaluate(() => storedSceneBounce()),
    page.evaluate(() => storedSceneBounce()),
  ]);

  expect(topIsWindow).toBe(false);
  expect(storedInIframe).toBe(false);
  // Sanity check on the harness itself: the same setting read from the top
  // page (window.top === window there) must reflect the '1' just written.
  expect(storedOnTop).toBe(true);
});
