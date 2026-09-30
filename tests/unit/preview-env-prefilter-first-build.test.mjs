// P4a-F1: the preview's FIRST material build must prefilter/convolve its
// environment the same way setEnvironment already does, so envRadiance/
// envIrradiance match what the shader was generated for regardless of
// session history (P4-DESIGN.md Findings F1). Pins two things: the shared
// resolveShadingEnv helper runs ensure*/read-back in the right order, and
// createMtlxRenderView's first-build path and setEnvironment both go
// through it rather than calling ensurePrefilteredEnv/ensureConvolvedIrradiance
// directly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_PATH = path.join(ROOT, 'js', 'mtlx-engine.js');
const ENGINE_SOURCE = fs.readFileSync(ENGINE_PATH, 'utf8');

function extractStatement(source, name) {
    const marker = 'const ' + name + ' = ';
    const idx = source.indexOf(marker);
    assert.ok(idx >= 0, 'not found in engine source: ' + name);
    let depth = 0;
    for (let i = idx; i < source.length; i++) {
        const c = source[i];
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') depth--;
        else if (c === ';' && depth === 0) return source.slice(idx, i + 1);
    }
    throw new Error('unterminated statement: ' + name);
}

function loadResolveShadingEnv(log) {
    const combined = [
        extractStatement(ENGINE_SOURCE, 'resolveShadingEnv'),
        'this.resolveShadingEnv = resolveShadingEnv;',
    ].join('\n');
    const context = {
        ensurePrefilteredEnv: (renderer, env) => { log.push('ensurePrefilteredEnv'); env.radiancePrefiltered = 'PREFILTERED'; },
        ensureConvolvedIrradiance: (renderer, env) => { log.push('ensureConvolvedIrradiance'); env.irradianceConvolved = 'CONVOLVED'; },
        envRadianceForShading: (env) => { log.push('envRadianceForShading'); return env.radiancePrefiltered || env.radiance; },
        envIrradianceForShading: (env) => { log.push('envIrradianceForShading'); return env.irradianceConvolved || env.irradiance; },
    };
    vm.runInNewContext(combined, context, { filename: ENGINE_PATH });
    return context.resolveShadingEnv;
}

test('resolveShadingEnv prefilters/convolves before reading back radiance/irradiance', () => {
    const log = [];
    const resolveShadingEnv = loadResolveShadingEnv(log);
    const env = { radiance: 'RAW_RADIANCE', irradiance: 'RAW_IRRADIANCE' };
    const renderer = {};

    const out = resolveShadingEnv(renderer, env);

    assert.deepEqual(log, [
        'ensurePrefilteredEnv', 'ensureConvolvedIrradiance',
        'envRadianceForShading', 'envIrradianceForShading',
    ], 'must ensure both, THEN read back, in that order');
    // A first build with no prior session history still lands on the
    // prefiltered/convolved values, not the raw box-filtered/SH ones.
    assert.equal(out.radiance, 'PREFILTERED');
    assert.equal(out.irradiance, 'CONVOLVED');
});

test('resolveShadingEnv is the ONLY caller of ensurePrefilteredEnv/ensureConvolvedIrradiance', () => {
    // Both the first-build env fetch and setEnvironment must route through
    // the shared helper; a direct call from either site would let them
    // drift again (the bug this slice fixes).
    const prefilterCalls = ENGINE_SOURCE.match(/\bensurePrefilteredEnv\(/g) || [];
    const convolveCalls = ENGINE_SOURCE.match(/\bensureConvolvedIrradiance\(/g) || [];
    assert.equal(prefilterCalls.length, 1, 'ensurePrefilteredEnv( should appear exactly once (inside resolveShadingEnv)');
    assert.equal(convolveCalls.length, 1, 'ensureConvolvedIrradiance( should appear exactly once (inside resolveShadingEnv)');
});

test('the first-build env fetch and setEnvironment both call resolveShadingEnv', () => {
    const calls = ENGINE_SOURCE.match(/\bresolveShadingEnv\(renderer, env\)/g) || [];
    assert.equal(calls.length, 2, 'expected exactly two call sites: first build and setEnvironment');
});
