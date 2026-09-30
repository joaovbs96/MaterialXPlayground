import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Loads the production converter with the vendored three.js in one sandbox.
function load() {
    const ctx = { console };
    ctx.window = ctx; ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync('vendor/three/three.min.js', 'utf8'), ctx);
    vm.runInContext(fs.readFileSync('js/usd-scene-lights.js', 'utf8'), ctx);
    return ctx;
}

const lights = [
    { primPath: '/L/FillRect', type: 'RectLight', intensity: 300, width: 4, height: 2, exposure: 0, color: [1, 1, 1] },
    { primPath: '/L/RimDisk', type: 'DiskLight', intensity: 500, radius: 1, exposure: 0, color: [1, 1, 1] },
].map((l) => Object.assign({ transform: null }, l));

test('reported sample counts match the samples actually produced', () => {
    const ctx = load();
    const run = (center) => {
        const notes = [];
        const out = ctx.window.convertUsdStageLights(lights, { limit: 16, sceneCenter: center, warn: (m) => notes.push(m) });
        return { out, notes };
    };
    const provisional = run(null);
    assert.equal(provisional.notes.filter((n) => /point samples/.test(n)).length, 0);
    const final = run(new ctx.THREE.Vector3(0, 0, 10));
    for (const l of lights) {
        const actual = final.out.filter((o) => (o.emitter || o).primPath === l.primPath).length;
        const said = final.notes.filter((n) => n.indexOf(l.primPath) >= 0 && /point samples/.test(n));
        assert.ok(actual > 1, l.primPath + ' should be split');
        assert.equal(said.length, 1);
        assert.ok(said[0].indexOf('split into ' + actual + ' point samples') >= 0, said[0]);
    }
});
