// Unit tests for scripts/check-vsix-files.mjs's derived MATERIALX_KEEP_LIST:
// it must be computed from exampleCatalog.js's real catalog (never
// hand-maintained), cover every gallery material's own .mtlx plus every
// texture it references (fileprefix + xi:include aware), and every listed
// path must actually exist on disk. Importing the module must never shell
// out to `vsce ls` as a side effect (see its own entry-point guard).
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { MATERIALX_KEEP_LIST } from '../../scripts/check-vsix-files.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(require.resolve('../../package.json')));
const hasVendorMaterialx = fs.existsSync(path.join(REPO_ROOT, 'vendor', 'materialx', 'resources', 'Materials', 'Examples'));

test('MATERIALX_KEEP_LIST: every listed path exists on disk', { skip: !hasVendorMaterialx }, () => {
    for (const p of MATERIALX_KEEP_LIST) {
        assert.ok(fs.existsSync(path.join(REPO_ROOT, ...p.split('/'))), 'listed but missing on disk: ' + p);
    }
});

test('MATERIALX_KEEP_LIST: includes the static spec/manifest/license files', { skip: !hasVendorMaterialx }, () => {
    for (const p of [
        'vendor/materialx/manifest.json',
        'vendor/materialx/LICENSE',
        'vendor/materialx/documents/Specification/MaterialX.StandardNodes.md',
    ]) {
        assert.ok(MATERIALX_KEEP_LIST.includes(p), 'missing static extra: ' + p);
    }
});

test('MATERIALX_KEEP_LIST: covers every materialx-origin catalog entry\'s own .mtlx and every texture it references', { skip: !hasVendorMaterialx }, () => {
    const exampleCatalog = require('../../vscode_extension/src/exampleCatalog.js');
    const keep = new Set(MATERIALX_KEEP_LIST);
    for (const entry of exampleCatalog.getCatalog()) {
        if (!entry.mtlxPath.startsWith('vendor/materialx/')) continue;
        assert.ok(keep.has(entry.mtlxPath), entry.id + ': root .mtlx not in keep list: ' + entry.mtlxPath);
        for (const f of entry.files) {
            if (f.from && f.from.startsWith('vendor/materialx/')) {
                assert.ok(keep.has(f.from), entry.id + ': referenced file not in keep list: ' + f.from);
            }
        }
    }
});

test('MATERIALX_KEEP_LIST: covers the xi:include composite examples (look_brass_tiled/look_wood_tiled)', { skip: !hasVendorMaterialx }, () => {
    const keep = new Set(MATERIALX_KEEP_LIST);
    for (const id of ['standard_surface_brass_tiled', 'standard_surface_greysphere_calibration', 'standard_surface_wood_tiled']) {
        assert.ok(
            [...keep].some((p) => p.endsWith('/' + id + '.mtlx')),
            id + '.mtlx (an xi:include target) not in keep list'
        );
    }
});

test('MATERIALX_KEEP_LIST: no duplicate entries', () => {
    assert.equal(new Set(MATERIALX_KEEP_LIST).size, MATERIALX_KEEP_LIST.length);
});
