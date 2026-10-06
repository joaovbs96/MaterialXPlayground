// Guard: every document the importers author must use input names and types
// that exist in the real nodedefs (libraries/**/*.mtlx). A wrong type (a
// float where open_pbr_surface wants a boolean) only fails at shader time.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { parseXml } from '../../js/usd/scene-import-common.js';

const defs = new Map(); // node category -> [{ type, inputs: Map }]
const collect = (el) => {
  if (el.name === 'nodedef') {
    const inputs = new Map(el.children.filter((c) => c.name === 'input').map((c) => [c.attrs.name, c.attrs.type]));
    const list = defs.get(el.attrs.node) || [];
    const outs = el.children.filter((c) => c.name === 'output').map((c) => c.attrs.type);
    list.push({ types: el.attrs.type ? [el.attrs.type] : outs, inputs });
    defs.set(el.attrs.node, list);
  }
  el.children.forEach(collect);
};
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.mtlx')) collect(parseXml(fs.readFileSync(full, 'utf8')));
  }
};
walk(path.resolve('libraries'));

const problems = (label, xml) => {
  const out = [];
  const check = (el) => {
    if (el.name === 'nodegraph') { el.children.forEach(check); return; }
    if (!el.attrs.type || el.name === 'input' || el.name === 'output') return;
    const candidates = (defs.get(el.name) || []).filter((d) => el.attrs.type === 'multioutput' ? d.types.length > 1 : d.types.includes(el.attrs.type));
    if (!candidates.length) { out.push(`${label}: no nodedef for <${el.name}> type ${el.attrs.type}`); return; }
    const bad = [];
    const ok = candidates.some((d) => {
      const miss = el.children.filter((c) => c.name === 'input').filter((c) => d.inputs.get(c.attrs.name) !== c.attrs.type);
      if (!miss.length) return true;
      bad.push(...miss.map((c) => `${c.attrs.name}:${c.attrs.type} (nodedef: ${d.inputs.get(c.attrs.name) || 'absent'})`));
      return false;
    });
    if (!ok) out.push(`${label}: <${el.name} ${el.attrs.name}> ${[...new Set(bad)].join(', ')}`);
  };
  parseXml(xml).children.forEach(check);
  return out;
};

import { materialDocCases } from './fixtures/material-doc-cases.mjs';

test('nodedef index is populated', () => {
  assert.ok(defs.get('open_pbr_surface'));
  assert.ok(defs.get('gltf_pbr'));
});

test('every importer material document matches its nodedefs', () => {
  const cases = materialDocCases();
  assert.ok(cases.length >= 30);
  assert.deepEqual(cases.flatMap((c) => problems(c.label, c.xml)), []);
});
