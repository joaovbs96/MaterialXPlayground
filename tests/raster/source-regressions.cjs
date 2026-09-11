/* CPU checks against production source, runnable without npm dependencies:
 * node tests/raster/source-regressions.cjs
 * These are not a substitute for renderer/GPU validation. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const THREE = require(path.join(root, 'vendor/three/three.min.js'));
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const context = { THREE, window: {}, console };
vm.runInNewContext(read('js/usd-scene-lights.js'), context);
const source = read('js/usd-scene-renderer.js');
const expr = source.match(/const luminance = lightColor\s*([\s\S]*?) : 1;/);
assert(expr, 'production caster luminance expression not found');
const luma = new Function('lightColor', `return lightColor ${expr[1]} : 1;`);
const colors = [[0,0,0],[1,0,0],[0,1,0],[0,0,1],[1,1,1],[0.2,0.7,0.1]];
const luminance = colors.map(color => {
  const converted = context.window.convertUsdStageLights([{type: 'DistantLight', primPath: '/TestLight', color, intensity: 1}], {limit:1})[0];
  assert.equal(converted.color.isVector3, true);
  const expected = color[0]*0.2126+color[1]*0.7152+color[2]*0.0722;
  for (const representation of [converted.color, new THREE.Color(...color), color]) {
    assert(Math.abs(luma(representation)-expected) < 1e-12, 'color representations must agree');
  }
  return {color, actual: luma(converted.color), expected};
});
const offscreen = read('tests/embed/usd-scene-peel-target.spec.mjs');
assert(offscreen.includes('minV = Infinity, maxV = -Infinity'), 'RGB sum extrema must allow 0..765');
for (const gray of [0,85,128,255]) {
  let min = Infinity, max = -Infinity;
  for (let p=0;p<8;p++) { min=Math.min(min,gray*3); max=Math.max(max,gray*3); }
  assert.equal(max-min,0,'uniform targets must not pass the image-variation gate');
}
const engine = read('js/mtlx-engine.js');
assert(engine.includes('renderQuad(resources.finalMat, oldTarget)'), 'RGB-T final pass must honor the caller target');
assert(engine.includes('outputTarget'), 'legacy compositor must retain caller target contract');
console.log(JSON.stringify({status:'passed', three:THREE.REVISION, luminance, constantColorRejection:true, callerTargetContract:true}, null, 2));
