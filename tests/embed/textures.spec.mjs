// tests/embed/textures.spec.mjs: `src=` must crawl the loaded document
// for its own referenced textures (js/shared/mtlx-ui.jsx's
// fetchRemoteDocumentFiles), fetching same-origin ones and blocking
// cross-origin ones instead of leaking a request to another origin.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  test, expect, gotoHarness,
  createViewer, waitForReady, waitForEventCount, getEvents,
} from './lib/test-base.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEXTURED_MTLX_PATH = '/tests/embed/fixtures/textured.mtlx';
const TEXTURE_PNG_PATH = '/tests/embed/fixtures/textures/uv-test.png';
const CROSSORIGIN_MTLX_PATH = '/tests/embed/fixtures/textured-crossorigin.mtlx';
const CROSSORIGIN_TEMPLATE = path.join(__dirname, 'fixtures', 'textured-crossorigin.mtlx');

test('same-origin texture references are fetched and rendered without error', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const requests = [];
  page.on('request', (req) => requests.push(req.url()));

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + TEXTURED_MTLX_PATH,
    geometry: 'sphere',
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  await page.waitForTimeout(800); // a "beat" for any late mtlx-error to land

  const textureUrl = embedURL + TEXTURE_PNG_PATH;
  expect(requests).toContain(textureUrl);

  const errors = await getEvents(page, idx, 'mtlx-error');
  expect(errors).toEqual([]);

  const renderableEvents = await getEvents(page, idx, 'mtlx-renderables');
  expect(renderableEvents[0].detail.map((r) => r.name)).toEqual(['Textured']);
});

// Shared by both cross-origin tests below: fulfills a request for
// CROSSORIGIN_MTLX_PATH with the template fixture, its placeholder
// swapped for the given texture ref, then drives the same assertions.
async function runCrossOriginCheck(page, embedURL, cleanUrlsURL, ref) {
  const template = fs.readFileSync(CROSSORIGIN_TEMPLATE, 'utf8');
  const body = template.replaceAll('OTHER_ORIGIN_REF_PLACEHOLDER', ref);

  await page.route(embedURL + CROSSORIGIN_MTLX_PATH, (route) => {
    route.fulfill({ status: 200, contentType: 'application/xml', body });
  });

  const requests = [];
  page.on('request', (req) => requests.push(req.url()));

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + CROSSORIGIN_MTLX_PATH,
    geometry: 'sphere',
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  await waitForEventCount(page, idx, 'mtlx-error', 1);

  const errors = await getEvents(page, idx, 'mtlx-error');
  const blocked = errors.find((e) => /outside the document.s origin \(cross-origin fetches are blocked\)/i.test(e.detail.message));
  expect(blocked).toBeTruthy();

  const otherOriginRequests = requests.filter((u) => u.startsWith(cleanUrlsURL));
  expect(otherOriginRequests).toEqual([]);

  const renderableEvents = await getEvents(page, idx, 'mtlx-renderables');
  expect(renderableEvents[0].detail.map((r) => r.name)).toEqual(['Textured']);
}

test('cross-origin texture references are blocked, reported, and the document still renders', async ({ page, embedURL, cleanUrlsURL }) => {
  await gotoHarness(page, embedURL);
  // A plain absolute URL to the other origin's copy of the texture,
  // the common real-world shape of a cross-origin reference.
  const ref = cleanUrlsURL + TEXTURE_PNG_PATH;
  await runCrossOriginCheck(page, embedURL, cleanUrlsURL, ref);
});

// Cheap extra coverage: a mixed backslash/slash ref (`\/host/path`)
// resolves to the same cross-origin URL via the URL parser's
// backslash-as-slash rule, so the gate must catch this shape too.
test('a mixed-separator cross-origin reference is also blocked and reported', async ({ page, embedURL, cleanUrlsURL }) => {
  await gotoHarness(page, embedURL);
  const otherHost = new URL(cleanUrlsURL).host;
  const ref = '\\/' + otherHost + TEXTURE_PNG_PATH;
  await runCrossOriginCheck(page, embedURL, cleanUrlsURL, ref);
});
