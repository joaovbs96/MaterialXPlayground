import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

// Round B env test: does the Stirling hood speckle come from the
// environment texture's own texel content (photographic HDR keeps it,
// a blurred studio env removes it)?
const suppliedRoot = process.env.USD_STIRLING_ROOT || '';
const suppliedDir = path.dirname(path.dirname(suppliedRoot));
const outDir = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab17';
const ENVIRONMENT_INPUT = 'input[type=file][accept=".hdr,.exr"]';

const E1 = 'C:\\Users\\joaov\\Downloads\\ehingen_hillside_02_1k.exr';
const E2 = path.join(outDir, 'studio-blur3.hdr');
const E3 = path.join(outDir, 'studio-unblurred.hdr');

function metrics(image) {
  const { width, height } = image;
  const x0 = Math.floor(width * 0.25), x1 = Math.floor(width * 0.75);
  const y0 = Math.floor(height * 0.25), y1 = Math.floor(height * 0.75);
  const lum = (x, y) => {
    const p = image.getPixel(x, y);
    return 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
  };
  let sum = 0, count = 0, above230 = 0, sparkle = 0;
  const values = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const l = lum(x, y);
      values.push(l);
      sum += l;
      count++;
      if (l > 230) above230++;
      if (x > x0 && x < x1 - 1 && y > y0 && y < y1 - 1) {
        let nsum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) nsum += lum(x + dx, y + dy);
        const nmean = nsum / 9;
        if (l - nmean > 40) sparkle++;
      }
    }
  }
  values.sort((a, b) => a - b);
  const p95 = values[Math.floor(values.length * 0.95)];
  return { mean: sum / count, p95, frac230: above230 / count, sparkleFrac: sparkle / count };
}

// Minimal 8-bit RGB PNG encoder (filter type 0 rows) for writing crops.
function encodePNG(width, height, rgbBuffer) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    const crcInput = Buffer.concat([typeBuf, data]);
    crcBuf.writeUInt32BE(crc32(crcInput) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rowBytes = width * 3;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    rgbBuffer.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, y * rowBytes + rowBytes);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff);
}

function writeCrop(image, name) {
  const cx = Math.floor(image.width * 0.5);
  const cy = Math.floor(image.height * 0.55);
  const cw = 160, ch = 120, scale = 2;
  const x0 = Math.max(0, cx - cw / 2), y0 = Math.max(0, cy - ch / 2);
  const outW = cw * scale, outH = ch * scale;
  const buf = Buffer.alloc(outW * outH * 3);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(image.width - 1, x0 + Math.floor(x / scale));
      const sy = Math.min(image.height - 1, y0 + Math.floor(y / scale));
      const p = image.getPixel(sx, sy);
      const o = (y * outW + x) * 3;
      buf[o] = p.r; buf[o + 1] = p.g; buf[o + 2] = p.b;
    }
  }
  const png = encodePNG(outW, outH, buf);
  const outPath = path.join(outDir, name + '-crop.png');
  fs.writeFileSync(outPath, png);
  return outPath;
}

async function loadAsset(page, embedURL) {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(suppliedDir);
  await expect(page.getByTestId('usd-scene-root-select')).toBeVisible({ timeout: 30000 });
  const rootSelectWrap = page.getByTestId('usd-scene-root-select');
  const rootCombobox = rootSelectWrap.getByRole('combobox');
  if (await rootCombobox.count()) {
    await rootCombobox.click();
    const options = await page.getByRole('option').allTextContents();
    const rootName = path.basename(suppliedRoot);
    const selectedRoot = options.find((label) => label.endsWith('/' + rootName) || label === rootName)
      || options.find((label) => label.toLowerCase().includes('real_time') && label.toLowerCase().endsWith('.usda'));
    await page.getByRole('option', { name: selectedRoot, exact: true }).click();
    await expect(rootCombobox).toContainText(selectedRoot);
  }
  await page.getByTestId('usd-scene-sidebar').getByRole('button', { name: /^Load (?!example)/ }).click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 180000 });
  await expect(page.getByTestId('usd-scene-canvas').locator('canvas')).toHaveCount(1);
}

async function frameHoodCloseup(page) {
  await page.evaluate(() => {
    const handle = window.__mtlxUsdSceneHandle;
    const pose = handle.getCamera();
    const newPos = pose.position.map((p, i) => p + 0.6 * (pose.target[i] - p));
    handle.setCamera({ position: newPos, target: pose.target });
  });
}

async function twoFrames(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function threeFrames(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }));
}

async function shoot(page, name) {
  const p = path.join(outDir, name + '.png');
  await page.getByTestId('usd-scene-canvas').locator('canvas').screenshot({ path: p });
  return p;
}

async function runOne(page, embedURL, label, envFile) {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await loadAsset(page, embedURL);
  if (envFile) {
    await page.locator(ENVIRONMENT_INPUT).setInputFiles(envFile);
    await page.waitForFunction(() => window.getEnvOverride && window.getEnvOverride(), null, { timeout: WAIT_TIMEOUT });
    await threeFrames(page);
  }
  await frameHoodCloseup(page);
  await twoFrames(page);
  const shotPath = await shoot(page, label);
  const image = decodePNG(fs.readFileSync(shotPath));
  const m = metrics(image);
  const cropPath = writeCrop(image, label);
  return { m, shotPath, cropPath };
}

test('@scene compares real environment textures against a blurred studio env for the hood speckle', async ({ browser, embedURL }) => {
  test.skip(!suppliedRoot, 'Set USD_STIRLING_ROOT to run this bounded diagnosis.');
  test.setTimeout(1800000);
  fs.mkdirSync(outDir, { recursive: true });

  const results = {};

  // E0: baseline, default environment, fresh page load.
  {
    const page = await browser.newPage();
    results.E0 = await runOne(page, embedURL, 'E0-baseline', null);
    await page.close();
  }

  // E1: photographic HDR (ehingen hillside), fresh page load.
  {
    const page = await browser.newPage();
    results.E1 = await runOne(page, embedURL, 'E1-photo', E1);
    await page.close();
  }

  // E2: 3x3 box-blurred studio env, fresh page load.
  {
    const page = await browser.newPage();
    results.E2 = await runOne(page, embedURL, 'E2-blurred-studio', E2);
    await page.close();
  }

  // E3: unblurred studio env control (same RGBE path as E2), fresh page load.
  {
    const page = await browser.newPage();
    results.E3 = await runOne(page, embedURL, 'E3-unblurred-studio', E3);
    await page.close();
  }

  const rowKeys = ['E0', 'E1', 'E2', 'E3'];
  const rows = rowKeys.map((k) => {
    const r = results[k].m;
    return `| ${k} | ${r.mean.toFixed(2)} | ${r.p95.toFixed(2)} | ${(r.frac230 * 100).toFixed(3)}% | ${(r.sparkleFrac * 100).toFixed(3)}% |`;
  });

  const e1Sparkles = results.E1.m.sparkleFrac > results.E0.m.sparkleFrac * 0.5;
  const e2RemovesVsE3 = results.E2.m.sparkleFrac < results.E3.m.sparkleFrac * 0.5;

  let verdict;
  if (e1Sparkles && e2RemovesVsE3) {
    verdict = 'A real photographic HDR (E1) reproduces the speckle while blurring the studio env (E2) removes it relative to the unblurred control (E3): the speckle is the environment texture own texel-level content shown through near-mirror coats, confirming the hypothesis.';
  } else if (!e1Sparkles && e2RemovesVsE3) {
    verdict = 'Blurring removes the speckle (E2 vs E3) but the photographic HDR (E1) does not reproduce it as strongly as the studio env: environment content matters but the studio env specifically (not photographic content in general) drives the effect at this resolution/exposure.';
  } else if (e1Sparkles && !e2RemovesVsE3) {
    verdict = 'The photographic HDR (E1) reproduces the speckle but blurring the studio env (E2) does not remove it relative to the control (E3): environment content contributes but is not fully explained by texel-level detail alone, or the RGBE round trip is not preserving the blur.';
  } else {
    verdict = 'Neither the photographic HDR (E1) nor removing high-frequency env detail via blur (E2 vs E3) changes the speckle materially: the hypothesis is not confirmed by this test, re-examine the RGBE encode path and the env override wiring.';
  }

  const report = [
    '# Stirling hood speckle vs environment texture content (E0-E3)',
    '',
    '## Metrics (central 50% box)',
    '',
    '| Capture | mean | p95 | frac>230 | sparkle proxy |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '## Verdict',
    '',
    verdict,
    '',
    '## Screenshots and crops',
    '',
    ...rowKeys.map((k) => `- ${k}: ${results[k].shotPath} / crop: ${results[k].cropPath}`),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'REPORT.md'), report, 'utf8');

  // eslint-disable-next-line no-console
  console.log(report);
});
