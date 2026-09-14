// Pure Node check of findFilesForRef: UDIM references expand to every tile
// with a concrete ref, plain references keep the single-hit behaviour.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.resolve(__dirname, '../../js/mtlx-engine.js'), 'utf8');
const extract = (name) => {
    const begin = src.indexOf('const ' + name + ' = ');
    assert(begin >= 0, name + ' not found');
    const end = src.indexOf('\n};', begin) + 3;
    return src.slice(begin, end);
};
const extractOneLiner = (name) => {
    const begin = src.indexOf('const ' + name + ' = ');
    assert(begin >= 0, name + ' not found');
    const end = src.indexOf(';\n', begin) + 1;
    return src.slice(begin, end);
};
const ctx = {};
vm.runInNewContext(extractOneLiner('normPath') + '\n' + extract('findFileForRef') + ';\n' + extract('findFilesForRef') + ';\n'
    + 'globalThis.findFilesForRef = findFilesForRef;', ctx);
const { findFilesForRef } = ctx;

const fileMap = {
    'Scene/textures/wall_base1001.png': 1,
    'Scene/textures/wall_base1002.png': 1,
    'Scene/textures/wall_base1011.png': 1,
    'Scene/textures/wall_rough1001.png': 1,
    'Scene/textures/floor.png': 1,
};

const tiles = findFilesForRef(fileMap, 'Scene/textures/wall_base<UDIM>.png');
assert.deepEqual(tiles.map((h) => h.key).sort(), ['Scene/textures/wall_base1001.png', 'Scene/textures/wall_base1002.png', 'Scene/textures/wall_base1011.png']);
assert.deepEqual(tiles.map((h) => h.ref).sort(), ['Scene/textures/wall_base1001.png', 'Scene/textures/wall_base1002.png', 'Scene/textures/wall_base1011.png']);
assert(tiles.every((h) => h.how === 'exact'));

const bySuffix = findFilesForRef(fileMap, 'textures/wall_base<udim>.png');
assert.equal(bySuffix.length, 3, 'suffix match expected');
assert(bySuffix.every((h) => h.how === 'suffix'));

const byBase = findFilesForRef(fileMap, 'elsewhere/wall_rough<UDIM>.png');
assert.deepEqual(byBase.map((h) => [h.key, h.ref, h.how]), [['Scene/textures/wall_rough1001.png', 'elsewhere/wall_rough1001.png', 'basename']]);

assert.deepEqual(findFilesForRef(fileMap, 'Scene/textures/none<UDIM>.png'), []);
assert.deepEqual(findFilesForRef(fileMap, 'Scene/textures/floor.png'), [{ key: 'Scene/textures/floor.png', how: 'exact', ref: 'Scene/textures/floor.png' }]);
assert.deepEqual(findFilesForRef(fileMap, 'missing.png'), []);

console.log('findFilesForRef UDIM expansion PASS');
