import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const xml = `<?xml version="1.0"?>
<materialx version="1.39">
  <oren_nayar_diffuse_bsdf name="substrate" type="BSDF"><input name="color" type="color3" value="0.05, 0.7, 0.12"/><input name="roughness" type="float" value="0.4"/></oren_nayar_diffuse_bsdf>
  <oren_nayar_diffuse_bsdf name="dust" type="BSDF"><input name="color" type="color3" value="1.0, 1.0, 1.0"/><input name="roughness" type="float" value="0.4"/></oren_nayar_diffuse_bsdf>
  <dielectric_bsdf name="dummy" type="BSDF"><input name="weight" type="float" value="0.0"/><input name="ior" type="float" value="1.5"/></dielectric_bsdf>
  <mix name="dustMix0" type="BSDF"><input name="fg" type="BSDF" nodename="dust"/><input name="bg" type="BSDF" nodename="dummy"/><input name="mix" type="float" value="0.0"/></mix>
  <mix name="dustMix05" type="BSDF"><input name="fg" type="BSDF" nodename="dust"/><input name="bg" type="BSDF" nodename="dummy"/><input name="mix" type="float" value="0.5"/></mix>
  <mix name="dustMix1" type="BSDF"><input name="fg" type="BSDF" nodename="dust"/><input name="bg" type="BSDF" nodename="dummy"/><input name="mix" type="float" value="1.0"/></mix>
  <layer name="result0" type="BSDF"><input name="top" type="BSDF" nodename="dustMix0"/><input name="base" type="BSDF" nodename="substrate"/></layer>
  <layer name="result05" type="BSDF"><input name="top" type="BSDF" nodename="dustMix05"/><input name="base" type="BSDF" nodename="substrate"/></layer>
  <layer name="result1" type="BSDF"><input name="top" type="BSDF" nodename="dustMix1"/><input name="base" type="BSDF" nodename="substrate"/></layer>
  <surface name="surface0" type="surfaceshader"><input name="bsdf" type="BSDF" nodename="result0"/></surface>
  <surface name="surface05" type="surfaceshader"><input name="bsdf" type="BSDF" nodename="result05"/></surface>
  <surface name="surface1" type="surfaceshader"><input name="bsdf" type="BSDF" nodename="result1"/></surface>
  <surfacematerial name="M0" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface0"/></surfacematerial>
  <surfacematerial name="M05" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface05"/></surfacematerial>
  <surfacematerial name="M1" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface1"/></surfacematerial>
</materialx>`;

function coloredPixels(png) {
  let count = 0;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const p = png.getPixel(x, y);
    if (p.g > p.r * 1.35 && p.g > p.b * 1.1 && p.g > 45) count++;
  }
  return count;
}

function regionMean(png, minX, maxX) {
  let count = 0;
  const sum = [0, 0, 0];
  for (let y = 0; y < png.height; y++) for (let x = minX; x < maxX; x++) {
    const p = png.getPixel(x, y);
    if (p.a < 10) continue;
    sum[0] += p.r; sum[1] += p.g; sum[2] += p.b; count++;
  }
  return sum.map((value) => value / Math.max(1, count));
}

function regionColoredMean(png, minX, maxX) {
  let count = 0;
  const sum = [0, 0, 0];
  for (let y = 0; y < png.height; y++) for (let x = minX; x < maxX; x++) {
    const p = png.getPixel(x, y);
    if (p.g <= p.r * 1.08 || p.g <= p.b * 1.03) continue;
    sum[0] += p.r; sum[1] += p.g; sum[2] += p.b; count++;
  }
  return { count, mean: sum.map((value) => value / Math.max(1, count)) };
}

test('@scene preserves colored substrate through BSDF mix masks', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => typeof window.createMtlxSceneView === 'function');
  const result = await page.evaluate(async ({ xml }) => {
    const holder = document.createElement('div');
    holder.style.cssText = 'width:320px;height:180px;position:absolute;left:-1000px;';
    document.body.appendChild(holder);
    const stage = {
      meshes: [{
        primPath: '/Mix/Test',
        positions: new Float32Array([-2,-0.6,0,-0.7,-0.6,0,-1.35,0.6,0, -0.7,-0.6,0,0.7,-0.6,0,0,0.6,0, 0.7,-0.6,0,2,-0.6,0,1.35,0.6,0]),
        normals: new Float32Array(27).fill(0).map((value, index) => index % 3 === 2 ? 1 : value),
        uvs: new Float32Array([0,0,1,0,0.5,1, 0,0,1,0,0.5,1, 0,0,1,0,0.5,1]),
        indices: new Uint32Array([0,1,2,3,4,5,6,7,8]),
        matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
        groups: [{start:0,count:3,materialPath:'/Mix/M0'},{start:3,count:3,materialPath:'/Mix/M05'},{start:6,count:3,materialPath:'/Mix/M1'}],
      }],
      materials: [
        {path:'/Mix/M0',sourceAsset:'mix.mtlx',subIdentifier:'M0'},
        {path:'/Mix/M05',sourceAsset:'mix.mtlx',subIdentifier:'M05'},
        {path:'/Mix/M1',sourceAsset:'mix.mtlx',subIdentifier:'M1'},
      ],
      warnings: [],
    };
    const h = await window.createMtlxSceneView({container:holder,stage,files:[{path:'mix.mtlx',data:new Blob([xml],{type:'application/xml'})}],version:'1.39.5'});
    h.setBackdrop('none');
    h.renderNow();
    const canvas = holder.querySelector('canvas');
    const png = canvas.toDataURL('image/png');
    const mats = []; h.scene.traverse(o=>{const ms=o.material?(Array.isArray(o.material)?o.material:[o.material]):[]; for(const m of ms) mats.push({label:m.name,fs:m.userData?.mtlxSceneCompiled?.fs||''});});
    const pixel = new Uint8Array(await (await fetch(png)).arrayBuffer());
    h.dispose(); holder.remove();
    return {mats, data: Array.from(pixel)};
  }, { xml });
  expect(result.mats.filter(m => m.fs.includes('mx_mix_bsdf')).length).toBeGreaterThanOrEqual(3);
  const png = decodePNG(Buffer.from(result.data));
  expect(coloredPixels(png)).toBeGreaterThan(30);
  const means = [regionMean(png, 0, 106), regionMean(png, 107, 213), regionMean(png, 214, 320)];
  const colored = [regionColoredMean(png, 0, 106), regionColoredMean(png, 107, 213), regionColoredMean(png, 214, 320)];
  // The mask-0 substrate remains visibly green. The half mix is a less green
  // response between that substrate and the neutral white top. Mask 1 has no
  // green excess, which catches the zero-throughput regression at mask 0.
  expect(colored[0].count).toBeGreaterThan(50);
  expect(colored[0].mean[1] - colored[0].mean[0]).toBeGreaterThan(80);
  expect(colored[1].count).toBeGreaterThan(50);
  expect(colored[1].mean[1] - colored[1].mean[0]).toBeGreaterThan(35);
  expect(colored[1].mean[1] - colored[1].mean[0]).toBeLessThan(colored[0].mean[1] - colored[0].mean[0]);
  expect(colored[2].count).toBeLessThan(10);
  expect(means[2][0]).toBeGreaterThan(80);
  expect(means[2][1]).toBeGreaterThan(80);
  expect(means[2][2]).toBeGreaterThan(80);
});

