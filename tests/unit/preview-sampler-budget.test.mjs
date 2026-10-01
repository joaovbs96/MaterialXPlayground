// P4b F4: generatePreviewSourcesWithinBudget must not retry a drop key the
// caller's base sceneFeatureOptions already set (PREVIEW_FEATURE_OPTIONS now
// carries skipLocalEnv/skipBounce), and must only record/keep a drop when
// countFragmentSamplers actually fell, so the notice never names a feature
// the preview does not have (P4-DESIGN.md Findings F4, section 2).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_PATH = path.join(ROOT, 'js', 'shared', 'mtlx-gen-core.js');
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

// Loads the real SAMPLER_BUDGET_DROP_ORDER/DEFAULT_SAMPLER_BUDGET/
// joinWithAnd/samplerBudgetNotice/generatePreviewSourcesWithinBudget slice
// with a stub generator and sampler counter, so the drop-order table stays
// live (a future key addition/removal is exercised automatically) while the
// fragment source and its sampler cost are synthetic.
function loadWithinBudget({ generatePreviewSources, countFragmentSamplers }) {
    const combined = [
        extractStatement(ENGINE_SOURCE, 'joinWithAnd'),
        extractStatement(ENGINE_SOURCE, 'SAMPLER_BUDGET_DROP_ORDER'),
        extractStatement(ENGINE_SOURCE, 'samplerBudgetNotice'),
        extractStatement(ENGINE_SOURCE, 'DEFAULT_SAMPLER_BUDGET'),
        extractStatement(ENGINE_SOURCE, 'generatePreviewSourcesWithinBudget'),
        'this.generatePreviewSourcesWithinBudget = generatePreviewSourcesWithinBudget;',
        'this.SAMPLER_BUDGET_DROP_ORDER = SAMPLER_BUDGET_DROP_ORDER;',
    ].join('\n');
    const context = { window: {}, generatePreviewSources, countFragmentSamplers };
    // The core reads the override through its host hook; mirror the page's provider.
    context.host = { samplerBudgetOverride: () => context.window.__mtlxSamplerBudgetOverride };
    vm.runInNewContext(combined, context, { filename: ENGINE_PATH });
    return context;
}

test('skips drop keys already set in the base options and records a drop only when the count falls', async () => {
    const calls = [];
    const BASE_COUNT = 20;
    const generatePreviewSources = async (args) => {
        const opts = Object.assign({}, args.sceneFeatureOptions || null);
        calls.push(opts);
        return { fs: JSON.stringify(opts), notices: [] };
    };
    let dropOrderKeys = null;
    const countFragmentSamplers = (fsText) => {
        const flags = JSON.parse(fsText);
        let count = BASE_COUNT;
        for (const key of dropOrderKeys) {
            // skipAoVolume is wired inert here: toggling it never shrinks
            // the synthetic fragment, so it must never be kept or notice'd.
            if (flags[key] && key !== 'skipAoVolume') count -= 1;
        }
        const material = count;
        return { count, names: [], scene: 0, material };
    };

    const context = loadWithinBudget({ generatePreviewSources, countFragmentSamplers });
    dropOrderKeys = context.SAMPLER_BUDGET_DROP_ORDER.map((d) => d.key);
    // PREVIEW_FEATURE_OPTIONS shape: base already gated off skipLocalEnv and
    // skipBounce. Base count is therefore already 20 - 2 = 18.
    const baseFeatureOptions = { skipShadowMap: true, skipOcclusion: true, skipLocalEnv: true, skipBounce: true };
    context.window.__mtlxSamplerBudgetOverride = 15;

    const srcs = await context.generatePreviewSourcesWithinBudget({ sceneFeatureOptions: baseFeatureOptions });

    assert.ok(srcs, 'generator must return sources');
    // Exactly 5 calls: the initial generation, plus one trial each for
    // skipAoVolume, skipSkyVis, dropThicknessMap, skipTransmittance -- never
    // a trial for skipLocalEnv or skipBounce (already set in the base) and
    // never skipRefraction (budget was met before reaching it).
    assert.equal(calls.length, 5, 'must not retry already-set base keys, and must stop once under budget');
    for (const call of calls.slice(1)) {
        assert.equal(call.skipLocalEnv, true, 'base key stays true throughout, never re-toggled');
        assert.equal(call.skipBounce, true, 'base key stays true throughout, never re-toggled');
    }

    // Array.from: the vm context is a different realm, so its Array is a
    // distinct constructor from this file's; normalize before deepEqual.
    assert.deepEqual(Array.from(srcs.samplerBudget.dropped),
        ['sky visibility (u_skyVisMap)', 'thickness map (u_thicknessMap)', 'shadow transmittance (u_shadowTransmittance)'],
        'the inert skipAoVolume trial must not be recorded as a drop');
    assert.deepEqual(Array.from(srcs.samplerBudget.droppedLabels), ['sky visibility', 'transmission thickness', 'colored shadows through transparent materials']);
    assert.equal(srcs.samplerBudget.count, 15);
    assert.equal(srcs.samplerBudget.needed, 18, 'needed reports the base-options count, not the raw 20');

    const notice = srcs.notices[0];
    assert.match(notice, /sky visibility/);
    assert.match(notice, /transmission thickness/);
    assert.match(notice, /colored shadows through transparent materials/);
    assert.doesNotMatch(notice, /ambient occlusion/, 'inert drop must not be named in the notice');
    assert.doesNotMatch(notice, /local reflections/, 'a feature the preview does not have must never be named');
    assert.doesNotMatch(notice, /diffuse bounce/, 'a feature the preview does not have must never be named');
});

test('no drop recorded and only one generation when the base already fits the budget', async () => {
    const calls = [];
    const generatePreviewSources = async (args) => {
        const opts = Object.assign({}, args.sceneFeatureOptions || null);
        calls.push(opts);
        return { fs: JSON.stringify(opts), notices: [] };
    };
    const countFragmentSamplers = () => ({ count: 4, names: [], scene: 0, material: 4 });

    const context = loadWithinBudget({ generatePreviewSources, countFragmentSamplers });
    context.window.__mtlxSamplerBudgetOverride = 16;

    const srcs = await context.generatePreviewSourcesWithinBudget({ sceneFeatureOptions: { skipLocalEnv: true, skipBounce: true } });

    assert.equal(calls.length, 1, 'a material already under budget must generate exactly once');
    assert.equal(srcs.samplerBudget, undefined, 'no samplerBudget when nothing was dropped');
    assert.deepEqual(srcs.notices, []);
});
