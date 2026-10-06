import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// A tilted dome must orient every environment consumer like its authored transform.
// Ground truth: mx_latlong_map_lookup projects u_envMatrix * worldDir, MaterialX's
// longitude leads UsdLux's by half a turn, so u_envMatrix = RotY(PI) * inverse(domeLocalToWorld).
function load() {
    const ctx = { console };
    ctx.window = ctx; ctx.self = ctx;
    vm.createContext(ctx);
    for (const file of ['vendor/three/three.min.js', 'js/shared/render-settings.js', 'js/shared/render-environment.js', 'js/shared/render-stage-environment.js']) {
        vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
    }
    // The shipped decomposition and yaw mapping, sliced out of the renderer source.
    const source = fs.readFileSync('js/usd-scene-renderer.js', 'utf8');
    const slice = (decl, endMarker) => {
        const start = source.indexOf(decl);
        const end = source.indexOf(endMarker, start);
        assert.ok(start >= 0 && end > start, decl + ' is present');
        return source.slice(start, end + endMarker.length);
    };
    vm.runInContext(slice('const sceneDomeOrientation =', '\n};\n') + slice('const sceneDomeYawDegFromRotation =', '\n')
        + 'this.sceneDomeOrientation = sceneDomeOrientation; this.sceneDomeYawDegFromRotation = sceneDomeYawDegFromRotation;', ctx);
    return ctx;
}

const ctx = load();
const T = ctx.THREE;
const R = ctx.MtlxRender;
const deg = Math.PI / 180;
const rot = (axis, a) => new T.Matrix4()['makeRotation' + axis](a);
const CASES = {
    identity: new T.Matrix4(),
    yaw40: rot('Y', 40 * deg),
    tiltX30: rot('X', 30 * deg),
    rotZ20: rot('Z', 20 * deg),
    yaw40_tiltX30: rot('Y', 40 * deg).multiply(rot('X', 30 * deg)),
    mixed: rot('Y', -125 * deg).multiply(rot('X', -50 * deg)).multiply(rot('Z', 70 * deg)),
};
const DIRS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-0.3, 0.8, -0.52], [0.6, -0.48, 0.64]].map((d) => new T.Vector3(...d).normalize());
const close = (a, b, label, eps = 1e-9) => assert.ok(a.distanceTo(b) < eps, label + ': ' + a.toArray() + ' vs ' + b.toArray());
// What the renderer derives from a dome: the slider's radians and the residual tilt.
const fromDome = (W) => {
    const { tilt, rotationDeg } = ctx.sceneDomeOrientation(W);
    return { tilt, rad: ctx.sceneDomeYawDegFromRotation(rotationDeg) * deg };
};

test('u_envMatrix is RotY(PI) times the inverse of the authored dome rotation', () => {
    for (const [name, W] of Object.entries(CASES)) {
        const { tilt, rad } = fromDome(W);
        const truth = rot('Y', Math.PI).multiply(W.clone().invert());
        const lookup = R.envLookupMatrix(rad, tilt);
        for (const d of DIRS) close(d.clone().applyMatrix4(lookup), d.clone().applyMatrix4(truth), name);
    }
});

test('a yaw-only dome has no tilt and keeps the exact pre-tilt matrices', () => {
    for (const name of ['identity', 'yaw40']) {
        const { tilt, rad } = fromDome(CASES[name]);
        assert.equal(tilt, null, name);
        assert.deepEqual(Array.from(R.envLookupMatrix(rad, tilt).elements), Array.from(new T.Matrix4().makeRotationY(Math.PI / 2 + rad).elements));
        assert.deepEqual(Array.from(R.keyLightRotationMatrix(rad, tilt).elements), Array.from(new T.Matrix4().makeRotationY(-rad).elements));
    }
});

test('the key light and the backdrop sky follow the same rotation the lookup samples', () => {
    const stage = R.createStageEnvironment({ scene: new T.Scene(), renderer: { setClearColor() {} }, camera: new T.PerspectiveCamera() });
    const sky = stage.root.children.find((c) => c.name === '__usd-scene-environment-sky');
    stage.setEnvRotation(0, null);
    sky.updateMatrixWorld(true);
    const skyRef = sky.matrixWorld.clone();
    const lookupRef = R.envLookupMatrix(0, null);
    for (const [name, W] of Object.entries(CASES)) {
        for (const extra of [0, 25 * deg]) {
            const { tilt, rad } = fromDome(W);
            const s = rad + extra;
            const lookup = R.envLookupMatrix(s, tilt);
            // A key extracted at rotation 0 must land where the lookup sees the same texel.
            for (const k of DIRS) close(k.clone().applyMatrix4(R.keyLightRotationMatrix(s, tilt)).applyMatrix4(lookup), k.clone().applyMatrix4(lookupRef), name + ' key');
            // The sky mesh shows texel (skyRef^-1 r) at rotation 0, so lookup * sky must stay constant.
            stage.setEnvRotation(s, tilt);
            sky.updateMatrixWorld(true);
            const a = lookup.clone().multiply(sky.matrixWorld);
            const b = lookupRef.clone().multiply(skyRef);
            for (const d of DIRS) close(d.clone().transformDirection(a), d.clone().transformDirection(b), name + ' sky', 1e-6);
        }
    }
});
