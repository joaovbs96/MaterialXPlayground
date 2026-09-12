import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COOK = path.join(ROOT, 'scripts/cook-textures.mjs');
const FIX = path.join(ROOT, 'tests/fixtures/usd-scene');
function crc32(buf) { let c=0xffffffff; for(const b of buf){let x=(c^b)&255;for(let i=0;i<8;i++)x=x&1?(0xedb88320^(x>>>1)):(x>>>1);c=(c>>>8)^x;} return (c^0xffffffff)>>>0; }
function chunk(type,data) { const t=Buffer.from(type),l=Buffer.alloc(4),c=Buffer.alloc(4);l.writeUInt32BE(data.length);c.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([l,t,data,c]); }
function png() { const w=64,h=64,s=Buffer.from([137,80,78,71,13,10,26,10]),ih=Buffer.alloc(13);ih.writeUInt32BE(w);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6;const raw=Buffer.alloc(h*(1+w*4));for(let y=0;y<h;y++){raw[y*(1+w*4)]=0;for(let x=0;x<w;x++){const o=y*(1+w*4)+1+x*4;raw[o]=64;raw[o+1]=128;raw[o+2]=192;raw[o+3]=255;}}return Buffer.concat([s,chunk('IHDR',ih),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]); }
let work;
test.beforeAll(() => { work=fs.mkdtempSync(path.join(os.tmpdir(),'m5-ktx-linear-')); fs.copyFileSync(path.join(FIX,'texture-formats-ktx2-root.usda'),path.join(work,'texture-formats-ktx2-root.usda')); fs.copyFileSync(path.join(FIX,'texture-formats-ktx2.mtlx'),path.join(work,'texture-formats-ktx2.mtlx')); fs.writeFileSync(path.join(work,'quad.png'),png()); execFileSync(process.execPath,[COOK,work,'--jobs','1'],{stdio:'pipe',timeout:120000}); });
test.afterAll(() => { try { fs.rmSync(work,{recursive:true,force:true}); } catch {} });
const file = name => ({name,mimeType:name.endsWith('.ktx2')?'image/ktx2':'text/plain',buffer:fs.readFileSync(path.join(work,name))});

test('@scene KTX2 sibling preserves known linear transfer', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene'); await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  const run = async includeKtx => {
    await page.getByTestId('usd-scene-file-picker').setInputFiles([file('texture-formats-ktx2-root.usda'),file('texture-formats-ktx2.mtlx'),file('quad.png'),...(includeKtx?[file('quad.ktx2')]:[])]);
    await expect(page.getByTestId('usd-scene-status')).toContainText('rendered',{timeout:120000});
    return page.evaluate(async includeKtx => { const h=window.__mtlxUsdSceneHandle,THREE=window.THREE;h.setBackdrop('none');h.setEnvironment(window.makeFlatEnvironment([0,0,0]));h.setEnvExposure(0);h.setSkyVisibility(false);h.setAmbientOcclusionEnabled(false);h.setShadowsEnabled(false);h.setPresentation({enabled:true,bloom:false,antialias:false,samples:0,persist:false});h.setSceneDisplayTransform('lin_rec709');const r=h.renderer,gl=r.getContext(),rt=new THREE.WebGLRenderTarget(128,128,{type:THREE.FloatType,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false});r.setRenderTarget(rt);h.renderNow();const p=new Float32Array(4);r.readRenderTargetPixels(rt,64,64,1,1,p);return {includeKtx,pixel:Array.from(p),glError:gl.getError(),stats:h.getTextureStats(),warnings:h.warnings.slice(),backend:gl.getParameter(gl.RENDERER)}; },includeKtx);
  };
  const pngOnly=await run(false), withKtx=await run(true); const srgb=v=>v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4); const expected=[srgb(64/255),srgb(128/255),srgb(192/255)];
  for(const row of [pngOnly,withKtx]){expect(row.glError).toBe(0);for(let c=0;c<3;c++)expect(row.pixel[c],`${row.includeKtx?'ktx2':'png'} c${c}`).toBeCloseTo(expected[c],1);}
  expect(withKtx.stats.ktx2Substituted).toBeGreaterThan(0); expect(withKtx.warnings.join('\n')).toMatch(/KTX2 sibling/i);
  for(let c=0;c<3;c++)expect(withKtx.pixel[c]-pngOnly.pixel[c]).toBeCloseTo(0,1);
});
