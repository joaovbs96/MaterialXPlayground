// Converts UsdLux light prims into MaterialX LightData entries.
//
// Storm's own LightSource struct (glf/resources/shaders/simpleLighting.glslfx)
// carries position, colour, a spot cone and a quadratic attenuation, and has
// no width, height or radius field at all: it renders every rect, disk and
// sphere light as a single point at its centre.
//
// We go one step further, because that single point is only accurate beyond
// roughly five times the emitter's largest dimension and real rigs are not
// in that regime: an area emitter is split into several point samples across
// its surface, each carrying its share of the power. See emitterSamples.
(function () {
    'use strict';

    // Must match the bindLightShader ids in js/mtlx-engine.js: the id IS the
    // LightData.type the generated sampleLightSource() switches on.
    var LIGHT_TYPE_DIRECTIONAL = 1;
    var LIGHT_TYPE_POINT = 2;
    var LIGHT_TYPE_SPOT = 3;

    var DEG = Math.PI / 180;

    // Number(null) is 0, which is finite, so a plain Number() coercion turned
    // every unauthored attribute into an authored zero. The worker writes null
    // for attributes a prim does not author precisely so the two can be told
    // apart, and this is where that distinction was being thrown away: a rect
    // light relying on the UsdLux width/height defaults reported zero area, so
    // the area multiply was skipped and the emitter was never split.
    function num(value, fallback) {
        if (value === null || value === undefined || value === '') return fallback;
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

    // Sample positions across an emitter's surface, in the light's own local
    // space, as cell centres of an n-by-m grid (or a Fibonacci disc). A point
    // stand-in is only accurate beyond roughly five times the emitter's
    // largest dimension, and this rig is nowhere near that: mainLamp_spill_AL
    // is about 12 units across lighting a wall 20 to 50 units away. Splitting
    // the emitter into several point lights, each carrying its share of the
    // power, is a Riemann sum of the area integral, so it converges on the
    // right answer for near-field falloff and terminator softness with no
    // shader change at all.
    //
    // A SphereLight is deliberately absent: outside a uniform sphere the
    // irradiance is exactly that of a point light at its centre carrying the
    // same power, so subdividing one would only spend slots.
    function emitterSamples(record, count) {
        var kind = String(record.type || '').toLowerCase();
        var out = [];
        var i, j;
        if (count <= 1) return [new THREE.Vector3(0, 0, 0)];
        if (kind === 'rectlight') {
            var w = num(record.width, 1);
            var h = num(record.height, 1);
            // Pick the nx-by-ny grid that uses the most of the budget, and
            // among equal sizes the one closest to the emitter's own aspect,
            // so cells stay near square without wasting slots to rounding.
            var aspect = w / Math.max(h, 1e-6);
            var nx = 1, ny = 1, best = -1;
            for (var cx = 1; cx <= count; cx++) {
                var cy = Math.floor(count / cx);
                if (cy < 1) break;
                var score = cx * cy - Math.abs((cx / cy) - aspect) * 0.01;
                if (score > best) { best = score; nx = cx; ny = cy; }
            }
            for (i = 0; i < nx; i++) {
                for (j = 0; j < ny; j++) {
                    out.push(new THREE.Vector3(
                        ((i + 0.5) / nx - 0.5) * w,
                        ((j + 0.5) / ny - 0.5) * h,
                        0
                    ));
                }
            }
            return out;
        }
        if (kind === 'disklight') {
            var rd = num(record.radius, 0.5);
            var GOLDEN = Math.PI * (3 - Math.sqrt(5));
            for (i = 0; i < count; i++) {
                var r = rd * Math.sqrt((i + 0.5) / count);
                var a = i * GOLDEN;
                out.push(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), 0));
            }
            return out;
        }
        if (kind === 'cylinderlight') {
            var len = num(record.length, 1);
            for (i = 0; i < count; i++) {
                out.push(new THREE.Vector3(((i + 0.5) / count - 0.5) * len, 0, 0));
            }
            return out;
        }
        return [new THREE.Vector3(0, 0, 0)];
    }

    // Largest world-space dimension of an emitter, the number that decides
    // how badly a single point stands in for it.
    function emitterExtent(record, scale) {
        var kind = String(record.type || '').toLowerCase();
        if (kind === 'rectlight') {
            return Math.max(Math.abs(num(record.width, 1) * scale.x), Math.abs(num(record.height, 1) * scale.y));
        }
        if (kind === 'disklight') return 2 * num(record.radius, 0.5) * ((scale.x + scale.y) / 2);
        if (kind === 'cylinderlight') return Math.abs(num(record.length, 1) * scale.x);
        return 0;
    }

    // Hands out the sample budget across the area emitters. Every light keeps
    // at least one sample, so nothing is ever dropped by the split itself.
    //
    // The weight is ANGULAR size, extent over distance to what the light
    // illuminates, not absolute size. Absolute size is the wrong criterion
    // and gets this rig backwards: a 152-unit screen light 350 units away is
    // a better point approximation than a 12-unit desk lamp 48 units from the
    // wall it lights, yet it is twelve times larger.
    function allocateSamples(entries, budget, sceneCenter) {
        var counts = new Map();
        entries.forEach(function (e) { counts.set(e, 1); });
        var spare = budget - entries.length;
        if (spare <= 0) return counts;
        var areaEntries = entries.filter(function (e) { return e.extent > 0; });
        if (!areaEntries.length) return counts;
        areaEntries.forEach(function (e) {
            var distance = sceneCenter ? e.entry.position.distanceTo(sceneCenter) : 0;
            e.angular = e.extent / Math.max(distance, e.extent * 0.5);
        });
        var total = areaEntries.reduce(function (sum, e) { return sum + e.angular; }, 0);
        if (!(total > 0)) return counts;
        var remaining = spare;
        areaEntries.sort(function (a, b) { return b.angular - a.angular; });
        for (var i = 0; i < areaEntries.length && remaining > 0; i++) {
            var e = areaEntries[i];
            var share = (i === areaEntries.length - 1)
                ? remaining
                : Math.min(remaining, Math.round(spare * (e.angular / total)));
            counts.set(e, 1 + Math.max(0, share));
            remaining -= Math.max(0, share);
        }
        return counts;
    }

    function convertStageLights(lights, options) {
        var opts = options || {};
        var rootMatrix = opts.rootMatrix || null;
        var warn = typeof opts.warn === 'function' ? opts.warn : function () {};
        var limit = Number.isFinite(opts.limit) ? opts.limit : 16;
        var list = Array.isArray(lights) ? lights : [];
        var prepared = [];

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
            }
            prepared.push({
                entry: entry,
                record: record,
                kind: kind,
                matrix: pose.matrix,
                // Only the area emitters have a meaningful extent; a distant
                // or sphere light reports 0 and keeps its single sample.
                extent: entry.type === LIGHT_TYPE_DIRECTIONAL ? 0 : emitterExtent(record, scale),
            });
        }

        // Brightest first, so a stage over budget keeps the lights that matter.
        prepared.sort(function (a, b) {
            return (b.entry.intensity * b.entry.color.length()) - (a.entry.intensity * a.entry.color.length());
        });
        if (prepared.length > limit) {
            warn('Stage has ' + prepared.length + ' analytic lights; using the brightest ' + limit);
            prepared = prepared.slice(0, limit);
        }

        var counts = allocateSamples(prepared, limit, opts.sceneCenter || null);
        var out = [];
        var splitReported = 0;
        for (var k = 0; k < prepared.length; k++) {
            var item = prepared[k];
            var want = Math.max(1, counts.get(item) || 1);
            var samples = emitterSamples(item.record, want);
            if (samples.length <= 1) {
                item.entry.emitter = {
                    primPath: item.record.primPath,
                    intensity: item.entry.intensity,
                    position: item.entry.position.clone(),
                    direction: item.entry.direction.clone(),
                    type: item.entry.type,
                };
                out.push(item.entry);
                if (item.extent > 0) {
                    warn('[info] Light ' + item.record.primPath + ' (' + item.record.type
                        + ') is approximated as a point at its centre; no slots were left to split it');
                }
                continue;
            }
            // Fixed total power: each sample carries its share, so the split
            // changes the shape of the falloff without changing the energy.
            var share = item.entry.intensity / samples.length;
            // Each sample carries the emitter it came from, so consumers that
            // reason about whole lights (the shadow caster picks one) are not
            // fooled into treating a fraction of a lamp as a separate light.
            var emitter = {
                primPath: item.record.primPath,
                intensity: item.entry.intensity,
                position: item.entry.position.clone(),
                direction: item.entry.direction.clone(),
                type: item.entry.type,
            };
            for (var sIdx = 0; sIdx < samples.length; sIdx++) {
                var local = samples[sIdx].clone().applyMatrix4(item.matrix);
                var sub = Object.assign({}, item.entry, {
                    position: local,
                    intensity: share,
                    color: item.entry.color.clone(),
                    emitter: emitter,
                });
                out.push(sub);
            }
            splitReported++;
            warn('[info] Light ' + item.record.primPath + ' (' + item.record.type + ') is split into '
                + samples.length + ' point samples across its surface');
        }
        return out;
    }

    window.convertUsdStageLights = convertStageLights;
    window.UsdSceneLights = { convert: convertStageLights };
})();
