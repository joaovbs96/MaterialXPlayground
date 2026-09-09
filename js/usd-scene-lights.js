// Converts UsdLux light prims into MaterialX LightData entries.
//
// This mirrors Hydra Storm rather than out-engineering it. Storm's own
// LightSource struct (glf/resources/shaders/simpleLighting.glslfx) carries
// position, colour, a spot cone and a quadratic attenuation, and has no
// width, height or radius field at all: every rect, disk and sphere light
// is rendered as a point light at its centre. Matching that is what makes a
// stage look the way it does in usdview.
(function () {
    'use strict';

    // Must match the bindLightShader ids in js/mtlx-engine.js: the id IS the
    // LightData.type the generated sampleLightSource() switches on.
    var LIGHT_TYPE_DIRECTIONAL = 1;
    var LIGHT_TYPE_POINT = 2;
    var LIGHT_TYPE_SPOT = 3;

    var DEG = Math.PI / 180;

    function num(value, fallback) {
        var n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function lightMatrix(record) {
        var a = record && record.matrix;
        if (!a || a.length !== 16) return new THREE.Matrix4();
        return new THREE.Matrix4().fromArray(Array.prototype.slice.call(a));
    }

    // UsdLux emitters point down their local -Z, the same convention the
    // camera import uses, so direction and position come from one matrix.
    function poseOf(record, rootMatrix) {
        var m = lightMatrix(record);
        if (rootMatrix) m = new THREE.Matrix4().multiplyMatrices(rootMatrix, m);
        var position = new THREE.Vector3().setFromMatrixPosition(m);
        var direction = new THREE.Vector3(0, 0, -1).transformDirection(m).normalize();
        return { position: position, direction: direction, matrix: m };
    }

    // World-space scale, needed because DCCs bake a rect light's real size
    // into xformOp:scale and leave inputs:width/height at 2.
    function scaleOf(matrix) {
        var m = matrix.elements;
        return new THREE.Vector3(
            new THREE.Vector3(m[0], m[1], m[2]).length(),
            new THREE.Vector3(m[4], m[5], m[6]).length(),
            new THREE.Vector3(m[8], m[9], m[10]).length()
        );
    }

    // Emitter area in world units, used to convert authored radiance into the
    // radiant intensity a point stand-in needs.
    function emitterArea(record, scale) {
        var kind = String(record.type || '').toLowerCase();
        if (kind === 'spherelight') {
            var r = num(record.radius, 0.5) * ((scale.x + scale.y + scale.z) / 3);
            return 4 * Math.PI * r * r;
        }
        if (kind === 'disklight') {
            var rd = num(record.radius, 0.5) * ((scale.x + scale.y) / 2);
            return Math.PI * rd * rd;
        }
        if (kind === 'rectlight') {
            return Math.abs(num(record.width, 1) * scale.x * num(record.height, 1) * scale.y);
        }
        if (kind === 'cylinderlight') {
            var rc = num(record.radius, 0.5) * ((scale.y + scale.z) / 2);
            return 2 * Math.PI * rc * Math.abs(num(record.length, 1) * scale.x);
        }
        return 1;
    }

    // Radiance carried into LightData.color, with intensity folded in so the
    // shader's own colour * intensity product lands on the right value.
    function radianceOf(record, scale, warn) {
        var color = Array.isArray(record.color) && record.color.length >= 3
            ? record.color : [1, 1, 1];
        var scalar = num(record.intensity, 1) * Math.pow(2, num(record.exposure, 0));
        // A point stand-in carries radiant intensity, which is radiance times
        // area. With normalize the authored value is already power-like, so
        // the area cancels; without it the area has to be multiplied back in.
        if (!record.normalize) {
            var area = emitterArea(record, scale);
            if (area > 1e-9) scalar *= area;
        }
        if (num(record.diffuse, 1) !== 1 || num(record.specular, 1) !== 1) {
            warn('Light ' + record.primPath + ' sets diffuse/specular multipliers, which are not applied');
        }
        return { color: new THREE.Vector3(color[0], color[1], color[2]), intensity: scalar };
    }

    // A cone authored through UsdLuxShapingAPI becomes a real spot light;
    // MaterialX's mx_spot_light smoothsteps between the two angles as cosines.
    function coneOf(record) {
        var angle = record.coneAngle;
        if (angle == null || !Number.isFinite(Number(angle))) return null;
        var outer = Math.cos(Math.min(89.9, Math.max(0, Number(angle))) * DEG);
        var softness = Math.min(1, Math.max(0, num(record.coneSoftness, 0)));
        // smoothstep runs from outer up to inner, so the gap between them is
        // the penumbra: softness 0 collapses it to a hard edge.
        var inner = outer + (1 - outer) * softness;
        return { inner: Math.min(1, inner), outer: outer };
    }

    // Storm has no area lights, so rect, disk and cylinder all collapse to a
    // point at their centre. Reported per light so the approximation is never
    // invisible to the user.
    var POINT_APPROXIMATED = { rectlight: 1, disklight: 1, cylinderlight: 1 };

    function convertStageLights(lights, options) {
        var opts = options || {};
        var rootMatrix = opts.rootMatrix || null;
        var warn = typeof opts.warn === 'function' ? opts.warn : function () {};
        var limit = Number.isFinite(opts.limit) ? opts.limit : 8;
        var out = [];
        var list = Array.isArray(lights) ? lights : [];

        for (var i = 0; i < list.length; i++) {
            var record = list[i];
            if (!record) continue;
            var kind = String(record.type || '').toLowerCase();
            if (kind === 'domelight') continue; // handled as the environment
            var pose = poseOf(record, rootMatrix);
            var scale = scaleOf(pose.matrix);
            var rad = radianceOf(record, scale, warn);
            if (!(rad.intensity > 0)) continue;

            var entry = {
                primPath: record.primPath,
                color: rad.color,
                intensity: rad.intensity,
                position: pose.position,
                direction: pose.direction,
                decay_rate: 2,
            };

            if (kind === 'distantlight') {
                entry.type = LIGHT_TYPE_DIRECTIONAL;
                entry.decay_rate = 0;
                if (num(record.angle, 0.53) !== 0.53) {
                    warn('Light ' + record.primPath + ' authors an angular diameter, which is not applied');
                }
            } else {
                var cone = coneOf(record);
                if (cone) {
                    entry.type = LIGHT_TYPE_SPOT;
                    entry.inner_angle = cone.inner;
                    entry.outer_angle = cone.outer;
                } else {
                    entry.type = LIGHT_TYPE_POINT;
                }
                if (POINT_APPROXIMATED[kind]) {
                    warn('[info] Light ' + record.primPath + ' (' + record.type
                        + ') is approximated as a point at its centre, matching Hydra Storm');
                }
            }
            out.push(entry);
        }

        // Brightest first, so a stage over budget keeps the lights that matter.
        out.sort(function (a, b) {
            return (b.intensity * b.color.length()) - (a.intensity * a.color.length());
        });
        if (out.length > limit) {
            warn('Stage has ' + out.length + ' analytic lights; using the brightest ' + limit);
            out = out.slice(0, limit);
        }
        return out;
    }

    window.convertUsdStageLights = convertStageLights;
    window.UsdSceneLights = { convert: convertStageLights };
})();
