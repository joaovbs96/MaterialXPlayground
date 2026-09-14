import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

// Graph Editor .mtlx roundtrip: element order, comments and bytes stay
// stable across load and save cycles, and the export attribution is optional.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TRACKED_DOCUMENTS = [
  'examples/animated_noise.mtlx',
  'examples/atan2_version_difference.mtlx',
  'materials/AnimatedChristmasTreeOrnament/ChristmasTreeOrnament016_1K-JPG.mtlx',
  'materials/Motley_Patchwork_Rug/Motley_Patchwork_Rug.mtlx',
  'materials/open_pbr_default.mtlx',
  'materials/standard_surface_carpaint_to_openpbr.mtlx',
];

const COMMENTED = [
  '<?xml version="1.0"?>',
  '<!-- prolog comment -->',
  '<materialx version="1.39">',
  '  <!-- before the shader -->',
  '  <standard_surface name="zeta_shader" type="surfaceshader">',
  '    <!-- inside the shader -->',
  '    <input name="base" type="float" value="0.8" />',
  '  </standard_surface>',
  '  <!-- between shader and graph -->',
  '  <nodegraph name="alpha_graph">',
  '    <!-- inside the graph -->',
  '    <constant name="c" type="float">',
  '      <input name="value" type="float" value="1.0" />',
  '    </constant>',
  '    <output name="out" type="float" nodename="c" />',
  '  </nodegraph>',
  '  <surfacematerial name="mid_material" type="material">',
  '    <input name="surfaceshader" type="surfaceshader" nodename="zeta_shader" />',
  '  </surfacematerial>',
  '</materialx>',
  '<!-- trailing comment -->',
  '',
].join('\r\n');

const openGraphEditor = async (page, embedURL) => {
  await page.goto(embedURL + '/index.html#!graph');
  await page.waitForSelector('.gtb-bar', { timeout: WAIT_TIMEOUT });
  await page.waitForFunction(() => typeof window.parseMtlxDocument === 'function'
    && typeof window.serializeDocXml === 'function', null, { timeout: WAIT_TIMEOUT });
};

// Runs load/save cycles through the editor's own parse and serialize, and
// reports each output plus the depth-first element sequence of every parse.
const cycleInPage = (page, xml, cycles) => page.evaluate(async ({ xml, cycles }) => {
  const sequence = (el, out = []) => {
    for (const child of vecToArray(el.getChildren())) {
      out.push(child.getCategory() + ':' + (child.getCategory() === 'comment' ? child.getDocString() : child.getName()));
      sequence(child, out);
    }
    return out;
  };
  const outputs = [];
  const sequences = [];
  let text = xml;
  for (let i = 0; i < cycles; i++) {
    const parsed = await window.parseMtlxDocument(text);
    sequences.push(sequence(parsed.doc));
    text = window.serializeDocXml(parsed);
    outputs.push(text);
  }
  return { outputs, sequences };
}, { xml, cycles });

test('graph roundtrip keeps element order and bytes stable for every tracked document', async ({ page, embedURL }) => {
  await openGraphEditor(page, embedURL);
  for (const rel of TRACKED_DOCUMENTS) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    expect(source.includes('xi:include'), rel + ' uses xi:include, outside the roundtrip guarantee').toBe(false);
    const { outputs, sequences } = await cycleInPage(page, source, 3);
    const [a, b, c] = outputs;
    expect(b, rel + ': second save differs from the first').toBe(a);
    expect(c, rel + ': third save differs from the second').toBe(b);
    // Order: the source parse and the parse of the first export agree.
    expect(sequences[1], rel + ': element order changed by a save').toEqual(sequences[0]);
  }
});

test('graph roundtrip keeps comments in place inside and around the root', async ({ page, embedURL }) => {
  await openGraphEditor(page, embedURL);
  const { outputs, sequences } = await cycleInPage(page, COMMENTED, 3);
  const [a, b, c] = outputs;
  for (const text of ['prolog comment', 'before the shader', 'inside the shader', 'between shader and graph', 'inside the graph', 'trailing comment']) {
    expect(a, 'comment lost: ' + text).toContain('<!-- ' + text + ' -->');
  }
  expect(a.indexOf('prolog comment')).toBeLessThan(a.indexOf('<materialx'));
  expect(a.indexOf('before the shader')).toBeLessThan(a.indexOf('zeta_shader'));
  expect(a.indexOf('inside the shader')).toBeGreaterThan(a.indexOf('zeta_shader'));
  expect(a.indexOf('between shader and graph')).toBeLessThan(a.indexOf('alpha_graph'));
  expect(a.indexOf('trailing comment')).toBeGreaterThan(a.indexOf('</materialx>'));
  expect(b).toBe(a);
  expect(c).toBe(b);
  expect(sequences[1]).toEqual(sequences[0]);
  expect(sequences[0]).toContain('comment: inside the graph ');
});

test('graph roundtrip edits change attributes and names but never the element order', async ({ page, embedURL }) => {
  await openGraphEditor(page, embedURL);
  const result = await page.evaluate(async (xml) => {
    const sequence = (el, out = []) => {
      for (const child of vecToArray(el.getChildren())) {
        out.push(child.getCategory());
        sequence(child, out);
      }
      return out;
    };
    const parsed = await window.parseMtlxDocument(xml);
    const before = sequence(parsed.doc);
    const shader = parsed.doc.getChild('zeta_shader');
    mxSetAttr(shader, 'xpos', '3.5');
    mxSetAttr(shader, 'ypos', '-1.25');
    parsed.doc.getChild('mid_material').setName('renamed_material');
    const saved = window.serializeDocXml(parsed);
    const reparsed = await window.parseMtlxDocument(saved);
    return { before, after: sequence(reparsed.doc), saved, again: window.serializeDocXml(reparsed) };
  }, COMMENTED);
  expect(result.after).toEqual(result.before);
  expect(result.saved).toContain('name="renamed_material"');
  expect(result.saved).toContain('xpos="3.5"');
  expect(result.again).toBe(result.saved);
});

// Hand-formatted source: wrapped attributes, blank lines, single quotes.
const HAND_FORMATTED = [
  "<?xml version='1.0' encoding='utf-8'?>",
  '<materialx version="1.39">',
  '',
  '  <nodedef name="ND_probe_surface" node="probe_surface" nodegroup="pbr"',
  '           doc="Probe definition" uiname="Probe">',
  '    <input name="weight" type="float" value="1.0" uimin="0.0" uimax="1.0"',
  '           doc="Wrapped doc string." />',
  "    <input name='tint' type='color3' value='1, 1, 1' />",
  '    <output name="out" type="surfaceshader" />',
  '  </nodedef>',
  '',
  '  <nodegraph name="NG_probe_surface" nodedef="ND_probe_surface">',
  '',
  '    <!-- Stage one -->',
  '    <multiply name="scaled" type="float">',
  '      <input name="in1" type="float" interfacename="weight" />',
  '      <input name="in2" type="float" value="2.0" />',
  '    </multiply>',
  '',
  '    <output name="out" type="surfaceshader" />',
  '',
  '  </nodegraph>',
  '',
  '</materialx>',
  '',
].join('\n');

test('graph roundtrip keeps hand formatting and edits only the changed lines', async ({ page, embedURL }) => {
  await openGraphEditor(page, embedURL);
  const { outputs } = await cycleInPage(page, HAND_FORMATTED, 2);
  expect(outputs[0], 'an unedited save rewrote the formatting').toBe(HAND_FORMATTED);
  expect(outputs[1]).toBe(outputs[0]);

  const crlf = HAND_FORMATTED.replace(/\n/g, '\r\n');
  const crlfOut = await cycleInPage(page, crlf, 1);
  expect(crlfOut.outputs[0], 'CRLF source was not kept byte for byte').toBe(crlf);

  const edited = await page.evaluate(async (xml) => {
    const parsed = await window.parseMtlxDocument(xml);
    parsed.doc.getNodeDef('ND_probe_surface').getInput('weight').setValueString('0.25', 'float');
    const saved = window.serializeDocXml(parsed);
    const reparsed = await window.parseMtlxDocument(saved);
    return { saved, again: window.serializeDocXml(reparsed) };
  }, HAND_FORMATTED);
  const before = HAND_FORMATTED.split('\n');
  const after = edited.saved.split('\n');
  expect(after.length, 'line count changed by a value edit').toBe(before.length);
  const changed = before.map((line, i) => (line === after[i] ? null : i)).filter((i) => i != null);
  expect(changed).toEqual([5]);
  expect(after[5]).toContain('value="0.25"');
  expect(after[6]).toBe('           doc="Wrapped doc string." />');
  expect(edited.again).toBe(edited.saved);
});

test('graph export attribution is optional, never stacks and is remembered', async ({ page, embedURL }) => {
  await openGraphEditor(page, embedURL);
  // Captures what the export writes instead of opening a native save picker.
  await page.evaluate(() => {
    window.__exports = [];
    window.showSaveFilePicker = async () => ({
      createWritable: async () => {
        const parts = [];
        return {
          write: async (blob) => { parts.push(await blob.text()); },
          close: async () => { window.__exports.push(parts.join('')); },
        };
      },
    });
  });
  const loadXml = async (xml, marker) => {
    await page.evaluate((xml) => {
      window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: { xml, name: 'roundtrip', files: {} } }));
    }, xml);
    await expect.poll(async () => page.evaluate(async () => {
      try { return await window.__mtlxGetGraphXml(); } catch (e) { return ''; }
    }), { timeout: WAIT_TIMEOUT }).toContain(marker);
  };
  const exportOnce = async (attribution) => {
    const count = await page.evaluate(() => window.__exports.length);
    await page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
    await page.getByText('Export .mtlx…', { exact: true }).click();
    const box = page.getByTestId('export-attribution');
    await expect(box).toBeVisible();
    if (attribution != null && (await box.isChecked()) !== attribution) await box.click();
    const checked = await box.isChecked();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__exports.length)).toBe(count + 1);
    return { checked, text: await page.evaluate(() => window.__exports[window.__exports.length - 1]) };
  };
  const attributionCount = (text) => (text.match(/Exported by MaterialX Playground/g) || []).length;

  await loadXml(COMMENTED, 'prolog comment');
  const first = await exportOnce(null);
  expect(first.checked, 'attribution defaults on').toBe(true);
  expect(attributionCount(first.text)).toBe(1);
  expect(first.text).toContain('<!-- prolog comment -->');

  // Re-importing an attributed export and exporting again yields the same bytes.
  await loadXml('<?xml version="1.0"?>\n<materialx version="1.39">\n  <constant name="spacer" type="float" />\n</materialx>\n', 'spacer');
  await loadXml(first.text, 'prolog comment');
  const second = await exportOnce(true);
  expect(attributionCount(second.text)).toBe(1);
  expect(second.text).toBe(first.text);

  const plain = await exportOnce(false);
  expect(plain.checked).toBe(false);
  expect(attributionCount(plain.text)).toBe(0);
  expect(plain.text).toContain('<!-- prolog comment -->');

  // The unchecked state is remembered for the next export.
  const remembered = await exportOnce(null);
  expect(remembered.checked).toBe(false);
  expect(attributionCount(remembered.text)).toBe(0);
});
