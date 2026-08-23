// mtlx-engine.js — MaterialX WASM environment, shader introspection,
// environment lighting, preview geometry, and the encapsulated
// createMtlxRenderView() pipeline (generate ESSL -> three.js scene ->
// bind defaults/env/lights -> compile-check -> render loop). Shared by
// the app shell (index.html) and the VS Code webview.
// Public API exported onto window at the bottom.

// ------------------------------------------------------------------
// MaterialX 3D Preview Component
// ------------------------------------------------------------------
// Load ONLY JsMaterialXGenShader.js (superset of JsMaterialXCore.js) —
// loading both makes embind register shared C++ types twice and throw.
// Runtime is cached per-version, not re-downloaded per node select.
// MTLX_DEFAULT_VERSION is build-stamped — see scripts/lib/version.mjs
// STAMP_TABLE, which fails CI if this literal drifts from
// js/gen/mtlx-version.json.
const MTLX_DEFAULT_VERSION = '1.39.5';
const mxEnvPromises = new Map();

// Classic-<script> fallback for UMD builds (e.g. 1.39.4) that have no
// `export` statement and no `root.MaterialX = ...` global fallback — see
// getMxEnv's header comment below for why import() can't reach their
// factory. A classic script makes the build's top-level `var MaterialX =
// ...` land on window, same as any other <script src>. Captures
// window.MaterialX synchronously in onload (before anything else can run),
// restores whatever was there before (both UMD and ESM builds use this
// same global name, so leaving it set risks a later version reading a
// stale factory), then resolves with the captured value.
const loadMxFactoryViaScript = ver => new Promise((resolve, reject) => {
  const url = './js/materialx/' + ver + '/JsMaterialXGenShader.js';
  const prevGlobal = window.MaterialX;
  const script = document.createElement('script');
  script.src = url;
  script.onload = () => {
    const captured = window.MaterialX; // synchronous: capture before restoring
    window.MaterialX = prevGlobal;
    script.remove();
    if (typeof captured !== 'function') {
      // Fail loud here rather than let the caller hit a confusing
      // "captured is not a function" later.
      reject(new Error('MaterialX engine script loaded but window.MaterialX is not a factory function (got ' + typeof captured + ') — url: ' + url));
      return;
    }
    resolve(captured);
  };
  script.onerror = () => {
    window.MaterialX = prevGlobal;
    script.remove();
    reject(new Error('Failed to load MaterialX engine script: ' + url));
  };
  document.head.appendChild(script);
});
const getMxEnv = version => {
  const ver = version || MTLX_DEFAULT_VERSION;
  if (!mxEnvPromises.has(ver)) {
    // ES-module builds (1.39.5+) export the factory as default. Older
    // builds (1.39.4 and earlier) are UMD with no export statement and
    // no global fallback, so under import() the factory is unreachable —
    // re-load those via a classic <script>, where top-level `var` lands
    // on window (see loadMxFactoryViaScript above). Detected by shape
    // (whether mod.default is actually a function), not by version
    // number, so a future build switching either way keeps working.
    // This means a failing version pays for TWO requests (import() then
    // the <script> re-fetch of the same URL) — deliberate and cheap,
    // since the second one is an HTTP cache hit; do not "optimize" this
    // into a hardcoded version check.
    const factoryPromise = import('./js/materialx/' + ver + '/JsMaterialXGenShader.js').then(mod => typeof mod.default === 'function' ? mod.default : loadMxFactoryViaScript(ver));
    mxEnvPromises.set(ver, factoryPromise.then(factory => factory({
      // .wasm and .data live next to the .js.
      locateFile: path => './js/materialx/' + ver + '/' + path
    })).then(mx => {
      // Expose the MaterialX library version (from the JS API)
      // for the top-menu badge; broadcast so the UI can update
      // whenever the WASM finishes loading. Only the default
      // version drives the header badge — a non-default pane
      // (e.g. Compare) must not overwrite it.
      if (ver === MTLX_DEFAULT_VERSION) {
        try {
          const verStr = mx.getVersionString && mx.getVersionString() || null;
          if (verStr) {
            window.__mtlxVersion = verStr;
            window.dispatchEvent(new CustomEvent('mtlx-version', {
              detail: verStr
            }));
          }
        } catch (e) {/* version is optional */}
      }
      // WebGL 2 targets ESSL (GLSL ES 3.00), not the desktop GLSL
      // generator (#version 400 won't compile in-browser).
      // loadStandardLibraries also registers the source-code search path.
      const gen = mx.EsslShaderGenerator.create();
      const genContext = new mx.GenContext(gen);
      const stdlib = mx.loadStandardLibraries(genContext);
      // TONE MAPPING: deliberately diverges from the official
      // viewer (raw linear output here; ACES + sRGB applied by
      // encodeDisplay() below, gated at runtime so linear
      // depth-peel passes can defer it — see its header).
      try {
        genContext.getOptions().hwSrgbEncodeOutput = false;
      } catch (e) {/* option absent */}
      // Textures are uploaded flipY=false (V0 = image top row),
      // so generated shaders must sample file textures at
      // (u, 1-v) for MaterialX's lower-left UV origin — without
      // this, every image renders upside down.
      try {
        genContext.getOptions().fileTextureVerticalFlip = true;
      } catch (e) {/* option absent */}

      // Direct light, like the official viewer's registerLights():
      // binds directional_light (id 1) from any <directional_light>
      // in environment_map.mtlx via DOMParser; no rig means pure IBL.
      return fetch('./environment_map.mtlx').then(r => r.ok ? r.text() : null).catch(() => null).then(rigXml => {
        const lightData = [];
        try {
          const HwGen = mx.HwShaderGenerator;
          const ldef = stdlib.getNodeDef ? stdlib.getNodeDef('ND_directional_light') : null;
          if (HwGen && HwGen.bindLightShader && ldef) {
            try {
              HwGen.unbindLightShaders(genContext);
            } catch (e) {/* fresh ctx */}
            HwGen.bindLightShader(ldef, 1, genContext);
            // Parses <directional_light> via DOMParser,
            // which handles self-closing tags unlike
            // regex. Parse failure warns, never throws.
            const rigLights = [];
            if (rigXml) {
              try {
                const rigDoc = new DOMParser().parseFromString(rigXml, 'text/xml');
                const perr = rigDoc.getElementsByTagName('parsererror');
                if (perr.length) {
                  console.warn('direct-light rig: environment_map.mtlx failed to parse as XML — no rig lights loaded.', perr[0].textContent);
                } else {
                  const v3 = (str, fb) => {
                    if (!str) return fb;
                    const p = str.split(',').map(x => parseFloat(x.trim()));
                    return p.length === 3 && !p.some(isNaN) ? p : fb;
                  };
                  const lightEls = rigDoc.getElementsByTagName('directional_light');
                  for (let i = 0; i < lightEls.length; i++) {
                    const lightEl = lightEls[i];
                    // Scoped to lightEl's own subtree,
                    // so this can't pick up a sibling
                    // light's <input>.
                    const inputEls = lightEl.getElementsByTagName('input');
                    const inp = nm => {
                      for (let j = 0; j < inputEls.length; j++) {
                        if (inputEls[j].getAttribute('name') === nm) {
                          return inputEls[j].getAttribute('value');
                        }
                      }
                      return null; // absent (or self-closing light) -> caller's fallback
                    };
                    rigLights.push({
                      direction: v3(inp('direction'), [0, -1, 0]),
                      color: v3(inp('color'), [1, 1, 1]),
                      intensity: parseFloat(inp('intensity')) || 1.0
                    });
                  }
                }
              } catch (e) {
                console.warn('direct-light rig: DOMParser failed on environment_map.mtlx — no rig lights loaded.', e);
              }
            }
            // Capacity must cover the rig PLUS one slot
            // reserved for the auto-extracted env key
            // light (extractKeyLight) — fixed for good,
            // since a bound array's length can't change.
            try {
              const opts = genContext.getOptions();
              opts.hwMaxActiveLightSources = Math.max(opts.hwMaxActiveLightSources || 0, rigLights.length + 1);
            } catch (e) {/* keep default */}
            // No fallback light: an empty rig leaves
            // lightData empty, so u_numActiveLightSources
            // is 0 and the light loop is a no-op (pure IBL).
            // Official rotates light directions by the
            // same +90° Y it applies to the env map.
            const rot = new THREE.Matrix4().makeRotationY(Math.PI / 2);
            for (const l of rigLights) {
              const dir = new THREE.Vector3(l.direction[0], l.direction[1], l.direction[2]).normalize().transformDirection(rot);
              lightData.push({
                type: 1,
                direction: dir,
                color: new THREE.Vector3(l.color[0], l.color[1], l.color[2]),
                intensity: l.intensity
              });
            }
          }
        } catch (e) {
          console.warn('direct-light registration unavailable:', e);
          lightData.length = 0;
        }
        return {
          mx,
          gen,
          genContext,
          stdlib,
          lightData,
          version: ver
        };
      });
    }).catch(e => {
      // Reset this version's memo so a retry re-attempts the load
      // instead of replaying this rejection forever, and wrap the
      // (often opaque) failure in a message the user can act on.
      mxEnvPromises.delete(ver);
      throw new Error('The MaterialX engine (WASM) failed to load: check your connection and try again, or reload the page. (' + (e && e.message || e) + ')');
    }));
  }
  return mxEnvPromises.get(ver);
};

// Wasm calls must be serialized — the heap can GROW mid-call
// (ALLOW_MEMORY_GROWTH), detaching a concurrent call's typed-array
// views ("memory access out of bounds"). One promise chain at a time.
let mxQueueTail = Promise.resolve();
// Lock-discipline diagnostics (see mxWarnIfLocked). mxLockDepth counts
// in-flight mxExclusive calls; mxExclusiveHeldSync is true only while
// fn's own sync body runs, distinguishing in-lock calls from unlocked ones.
let mxLockDepth = 0;
let mxExclusiveHeldSync = false;
function mxExclusive(fn) {
  mxLockDepth++;
  const run = () => Promise.resolve().then(() => {
    mxExclusiveHeldSync = true;
    try {
      return fn();
    } finally {
      mxExclusiveHeldSync = false;
    }
  });
  const p = mxQueueTail.then(run, run);
  // The tail must never carry a rejection forward (it would look like
  // every later caller failed) — settle it to undefined either way.
  mxQueueTail = p.then(() => undefined, () => undefined);
  // Lock depth follows the OUTER promise (fn plus anything it awaits),
  // not just the synchronous run() above — settles whether fn resolved
  // or rejected.
  p.then(() => {
    mxLockDepth--;
  }, () => {
    mxLockDepth--;
  });
  return p;
}

// Tripwire for synchronous wasm helpers called lock-free from the JSX
// layer (can't self-lock without turning async). Never throws/blocks —
// only warns when one runs during a genuinely concurrent mxExclusive op.
const mxWarnIfLocked = name => {
  if (mxLockDepth > 0 && !mxExclusiveHeldSync) {
    console.warn('[mtlx] ' + name + ' called while an exclusive wasm operation is in flight — possible heap-detach hazard; route this call through mxExclusive.');
  }
};

// Logs generated GLSL + discovered uniforms — fastest way to diagnose a
// black/non-running shader. Opt in via localStorage 'mtlxDebugShaders'.
// Read once at module load, mirroring MTLX_PERF_LOG (js/graph/model.jsx).
const DEBUG_SHADERS = (() => {
  try {
    return !!localStorage.getItem('mtlxDebugShaders');
  } catch (e) {
    return false;
  }
})();

// Gated console.warn for expected/recoverable conditions (e.g. a missing
// texture) that would otherwise spam every load; real warnings stay
// ungated. Exported as window.mtlxWarn for consumers loaded after this file.
const mtlxWarn = (...args) => {
  if (DEBUG_SHADERS) console.warn(...args);
};

// "Force Transparency" (Settings dialog, default off). Off = official-
// viewer parity (opaque previews); on = transparent materials render via
// front-to-back depth-peeled order-independent transparency (see the NOTE
// below, and renderFrame()/syncMeshMaterialMode() in createMtlxRenderView
// for the render graph). Persisted; setter dispatches 'mtlx-settings-changed'.
let FORCE_TRANSPARENCY = (() => {
  try {
    return localStorage.getItem('mtlxForceTransparency') === '1';
  } catch (e) {
    return false;
  }
})();
const getForceTransparency = () => FORCE_TRANSPARENCY;
const setForceTransparency = v => {
  FORCE_TRANSPARENCY = !!v;
  try {
    localStorage.setItem('mtlxForceTransparency', FORCE_TRANSPARENCY ? '1' : '0');
  } catch (e) {/* best-effort */}
  // Only caller: Settings dialog toggle (js/shared/mtlx-ui.jsx), fired
  // well after LIVE_VIEWS is populated (no load-time TDZ concern).
  // Mutates each live view's flags in place — see refreshRenderMode.
  LIVE_VIEWS.forEach(view => {
    try {
      view.refreshRenderMode && view.refreshRenderMode();
    } catch (e) {/* view mid-teardown */}
  });
  try {
    window.dispatchEvent(new CustomEvent('mtlx-settings-changed', {
      detail: {
        key: 'forceTransparency',
        value: FORCE_TRANSPARENCY
      }
    }));
  } catch (e) {/* best-effort */}
};

// NOTE: no separate "depth peeling" setting exists — Force Transparency
// always means front-to-back depth-peeled OIT now (a naive single-pass
// blended mode was collapsed into this one flag). renderFrame()/
// syncMeshMaterialMode() gate the peel graph on FORCE_TRANSPARENCY &&
// (this material's hwTransparency verdict) — see PEEL_LAYERS/getDummyTex.

// Nearest transparent layers the peel loop resolves before giving up on
// farther fragments — ample for the single-mesh shaderball preview this
// targets. Each layer costs a full extra raster+composite pass, so this
// is a fixed small constant rather than "peel until empty".
const PEEL_LAYERS = 8;

// Shared 1x1 opaque-black dummy texture: the DEFAULT binding for the
// peel-depth samplers declared by injectPeelDiscard() below, so those
// uniforms always have SOME bound texture even though they're only
// sampled while u_peelMode != 0. Module-scope + lazily created.
let MTLX_DUMMY_TEX = null;
const getDummyTex = () => {
  if (!MTLX_DUMMY_TEX) {
    MTLX_DUMMY_TEX = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    MTLX_DUMMY_TEX.needsUpdate = true;
  }
  return MTLX_DUMMY_TEX;
};

// White counterpart, depth==1.0 (far plane): the fail-safe default for
// u_opaqueDepth (see bindMaterialUniforms/renderFrame) so a stale/missing
// binding reads as "nothing there", never triggering the peel discard.
let MTLX_DUMMY_TEX_WHITE = null;
const getDummyTexWhite = () => {
  if (!MTLX_DUMMY_TEX_WHITE) {
    MTLX_DUMMY_TEX_WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    MTLX_DUMMY_TEX_WHITE.needsUpdate = true;
  }
  return MTLX_DUMMY_TEX_WHITE;
};

// Filters ONE benign warning: on Windows, ANGLE's fxc backend emits
// "X4008 division by zero" for unrolled FIS/light loops (harmless,
// guarded by M_FLOAT_EPS) — matched by exact signature; always restored.
const compileFilteringDriverNoise = (renderer, scene, camera) => {
  const origWarn = console.warn;
  console.warn = function (...args) {
    const isProgLog = typeof args[0] === 'string' && args[0].indexOf('THREE.WebGLProgram: gl.getProgramInfoLog()') === 0;
    const text = args.join(' ');
    // Anchored on the exact fxc signature (X4008 + "division by
    // zero"), not the generic word "warning" — any OTHER warning
    // in the log must still reach the real console.warn.
    const isKnownDriverNoise = isProgLog && /\bX4008\b/.test(text) && /division by zero/i.test(text) && !/error/i.test(text);
    if (isKnownDriverNoise) {
      if (DEBUG_SHADERS) console.debug('[mtlx] driver warnings (benign, filtered):', ...args);
      return;
    }
    return origWarn.apply(console, args);
  };
  try {
    renderer.compile(scene, camera);
  } finally {
    console.warn = origWarn;
  }
};

// Scrapes `uniform <type> u_<name>;` declarations from generated source
// so bindings use the shader's real names. Returns [{ type, name }, ...].
const parseUniforms = src => {
  const out = [];
  const re = /uniform\s+(\w+)\s+(u_\w+)\s*(?:\[\s*\w+\s*\])?\s*;/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push({
    type: m[1],
    name: m[2]
  });
  return out;
};

// three.js RawShaderMaterial + glslVersion:GLSL3 prepends its own
// "#version 300 es"; MaterialX ESSL output already has one. Strip the
// generated version line to avoid a duplicate-directive compile error.
const stripVersion = src => src.replace(/^\s*#version[^\n]*\n/, '');

// Hair helper pbrlib nodes pull in the full BSDF/lighting include chain,
// which the generator only emits for LIT shaders, leaving an unlit
// preview referencing undefined symbols; this patches in no-op stubs.
const patchUnlitLightingRefs = src => {
  const referencedNotDefined = name => new RegExp('\\b' + name + '\\s*\\(').test(src) && !new RegExp('vec3\\s+' + name + '\\s*\\(').test(src);
  const needsIrr = referencedNotDefined('mx_environment_irradiance');
  const needsRad = referencedNotDefined('mx_environment_radiance');
  const needsTrans = referencedNotDefined('mx_surface_transmission');
  if (needsIrr || needsRad || needsTrans) {
    let simple = ''; // no dependencies — can go at the very top
    let fresnel = ''; // needs the FresnelData struct
    if (needsIrr) simple += 'vec3 mx_environment_irradiance(vec3 N) { return vec3(0.0); }\n';
    if (needsRad) fresnel += 'vec3 mx_environment_radiance(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd) { return vec3(0.0); }\n';
    if (needsTrans) fresnel += 'vec3 mx_surface_transmission(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd, vec3 tint) { return vec3(0.0); }\n';
    const header = '\n// [mtlx-engine] no-op lighting stubs for an unlit shader (see patchUnlitLightingRefs)\n';
    if (simple) src = header + simple + src;
    if (fresnel) {
      const structIdx = src.indexOf('struct FresnelData');
      const insertAt = structIdx !== -1 ? src.indexOf('};', structIdx) + 2 : -1;
      if (insertAt > 1) {
        src = src.slice(0, insertAt) + header + fresnel + src.slice(insertAt);
      } else {
        // A silent skip here would leave mx_environment_radiance/
        // mx_surface_transmission called but never stubbed, failing
        // later with a cryptic GLSL error — throw instead, loudly.
        throw new Error('patchUnlitLightingRefs: could not locate the "struct FresnelData" anchor (or its closing "};") in generated fragment shader — MaterialX output format may have changed');
      }
    }
  }

  // Last prepend so the define stays the very first line of the source.
  if (/\bDIRECTIONAL_ALBEDO_METHOD\b/.test(src) && !/#define\s+DIRECTIONAL_ALBEDO_METHOD\b/.test(src)) {
    src = '#define DIRECTIONAL_ALBEDO_METHOD 0\n' + src;
  }
  return src;
};

// Shared ACES filmic (three r128's Hill fit) + sRGB OETF transform body.
// `inVar` is a vec3 GLSL expression (may be a bare name or `x.rgb`);
// the returned statements declare `outVar` (vec3) as the encoded result.
// Sole source for this math — encodeDisplay() and finalMat's linear
// composite (see allocPeel) both emit it, so the two never drift apart.
const ACES_SRGB_GLSL = (inVar, outVar) => '        vec3 _c = max(' + inVar + ', vec3(0.0));\n' + '        const mat3 _acesIn = mat3(\n' + '            vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383),\n' + '            vec3(0.04823, 0.01566, 0.83777)\n' + '        );\n' + '        const mat3 _acesOut = mat3(\n' + '            vec3( 1.60475, -0.10208, -0.00327), vec3(-0.53108,  1.10813, -0.07276),\n' + '            vec3(-0.07367, -0.00605,  1.07602)\n' + '        );\n' + '        _c *= (1.0 / 0.6); // toneMappingExposure(=1.0) / 0.6, matching three\'s ACESFilmicToneMapping chunk\n' + '        _c = _acesIn * _c;\n' + '        vec3 _aces_a = _c * (_c + vec3(0.0245786)) - vec3(0.000090537);\n' + '        vec3 _aces_b = _c * (0.983729 * _c + vec3(0.4329510)) + vec3(0.238081);\n' + '        _c = _acesOut * (_aces_a / _aces_b);\n' + '        _c = clamp(_c, vec3(0.0), vec3(1.0)); // saturate()\n' + '        vec3 _lo = _c * 12.92;\n' + '        vec3 _hi = 1.055 * pow(_c, vec3(1.0 / 2.4)) - 0.055;\n' + '        vec3 ' + outVar + ' = mix(_hi, _lo, step(_c, vec3(0.0031308)));\n';

// Injects ACES filmic tone mapping (three r128's exact constants) and
// sRGB OETF before main()'s closing brace — RawShaderMaterial bypasses
// renderer.toneMapping, so this keeps it matching the rest of the scene.
// The injected block is gated at runtime (see its `if` opener below):
// linear peel/tail passes defer this transform to finalMat's single
// composite-time pass instead, so it isn't applied twice.
const encodeDisplay = src => {
  // Both anchors are load-bearing: a silent skip here used to ship
  // raw-linear output straight to the display with no error anywhere.
  // Fail loud instead, so a format change surfaces immediately.
  const m = src.match(/\bout\s+vec4\s+(\w+)\s*;/);
  if (!m) throw new Error('encodeDisplay: could not locate the fragment shader\'s "out vec4 <name>;" declaration — MaterialX output format may have changed');
  const v = m[1];
  const idx = src.lastIndexOf('}');
  if (idx === -1) throw new Error('encodeDisplay: could not locate a closing "}" (expected main()\'s closing brace) in generated fragment shader — MaterialX output format may have changed');
  const inject = '\n    // Injected by previewer: ACES filmic tone map (three r128\'s Hill fit — see encodeDisplay()\'s header comment) then sRGB.\n' + '    if (u_peelLinear == 0 || u_peelMode == 0) {\n' + ACES_SRGB_GLSL(v + '.rgb', '_enc') + '        ' + v + ' = vec4(_enc, ' + v + '.a);\n' + '    }\n';
  return src.slice(0, idx) + inject + src.slice(idx);
};

// Deliberate energy-compromise constant for the peel-mode env-refraction
// return below: a FLAT scale (not re-weighted by transmission/color — the
// closure result is already weight-scaled downstream) applied to keep
// transmission hue alive in depth-peel mode, at the cost of some
// double-counting against the real scene now showing through via the
// alpha-composited background. Tune here.
const PEEL_REFRACTION_SCALE = 0.5;

// Folds transmission into peel-pass alpha (ESSL only writes it to RGB) and
// attenuates (rather than zeroes) the env-refraction term while peeling, so
// transmission_color/transmission tint survives instead of washing out to
// neutral gray. Fail-soft.
const patchTransmissionAlpha = fs => {
  let weightName = null;
  if (/uniform\s+float\s+transmission_weight\s*;/.test(fs)) weightName = 'transmission_weight';else if (/uniform\s+float\s+transmission\s*;/.test(fs)) weightName = 'transmission';
  if (!weightName) return fs;
  const colorExpr = /uniform\s+vec3\s+transmission_color\s*;/.test(fs) ? 'transmission_color' : 'vec3(1.0)';
  const transFnIdx = fs.indexOf('vec3 mx_surface_transmission');
  if (transFnIdx === -1) return fs;
  const returnAnchor = 'return mx_environment_radiance(N, V, X, alpha, distribution, fd) * tint;';
  const returnIdx = fs.indexOf(returnAnchor, transFnIdx);
  if (returnIdx === -1) return fs;
  const outAlphaMatch = fs.match(/float outAlpha = clamp\([^;]*\.transparency,\s*vec3\(0\.3333\)\),\s*0\.0,\s*1\.0\);/);
  if (!outAlphaMatch || outAlphaMatch.index <= returnIdx) return fs;
  const alphaInsertAt = outAlphaMatch.index + outAlphaMatch[0].length;

  // T = (1-a) + a*tT => alpha' = a*(1-tT); 0.05 floor keeps clear-glass sheen above u_alphaThreshold (default 0.001).
  const alphaFold = '\n    if (u_peelMode != 0) {\n' + '        float _tT = ' + weightName + ' * dot(' + colorExpr + ', vec3(0.3333));\n' + '        outAlpha = max(clamp(outAlpha * (1.0 - _tT), 0.0, 1.0), 0.05);\n' + '    }';
  let out = fs.slice(0, alphaInsertAt) + alphaFold + fs.slice(alphaInsertAt);
  const gatedReturn = 'if (u_peelMode != 0) {\n' + '        return mx_environment_radiance(N, V, X, alpha, distribution, fd) * tint * ' + PEEL_REFRACTION_SCALE + ';\n' + '    }\n    ' + returnAnchor;
  out = out.slice(0, returnIdx) + gatedReturn + out.slice(returnIdx + returnAnchor.length);
  out = out.slice(0, transFnIdx) + 'uniform int u_peelMode;\n' + out.slice(transFnIdx);
  return out;
};

// injectPeelDiscard(src) — bakes the depth-peel OIT machinery into
// EVERY generated fragment shader unconditionally, gated behind a
// runtime uniform (u_peelMode, default 0 = no-op) so toggling Force
// Transparency never needs a regen/recompile. Inserts four uniform
// decls immediately above void main() (top-level, after any
// #version/#extension directives) and splices a guarded discard block
// right after main()'s opening brace: u_opaqueDepth rejects anything
// behind the opaque scene, u_peelPrevDepth (+eps slop) rejects
// anything at/in-front-of the previous peeled layer — mode 1 (regular
// peel) and mode 2 (tail pass) share this same guard. Mode 2 also gets
// a premultiply epilogue (see below) so its output can under-blend
// into accumRT. Fail-loud (throws) if main() can't be found, same
// contract as encodeDisplay() above.
const injectPeelDiscard = src => {
  // Skip decls patchTransmissionAlpha may have already inserted.
  const declIfAbsent = line => src.indexOf(line) === -1 ? line + '\n' : '';
  const decls = declIfAbsent('uniform int u_peelMode;') + declIfAbsent('uniform int u_peelHasPrev;') + declIfAbsent('uniform highp sampler2D u_peelPrevDepth;') + declIfAbsent('uniform highp sampler2D u_opaqueDepth;') + declIfAbsent('uniform int u_peelLinear;');
  const block = '\n    if (u_peelMode != 0) {\n' + '        ivec2 _pc = ivec2(gl_FragCoord.xy);\n' + '        float _opaqueZ = texelFetch(u_opaqueDepth, _pc, 0).r;\n' + '        if (gl_FragCoord.z >= _opaqueZ) discard;\n' + '        if (u_peelHasPrev != 0) {\n' + '            float _prevZ = texelFetch(u_peelPrevDepth, _pc, 0).r;\n' + '            // PEEL_EPS: ~17 quanta of 24-bit depth precision; constant across cameras/near-far (revisit if coplanar shells misrender).\n' + '            if (gl_FragCoord.z <= _prevZ + 1e-6) discard;\n' + '        }\n' + '    }\n';
  const mainIdx = src.indexOf('void main');
  if (mainIdx === -1) throw new Error('injectPeelDiscard: no main() found (MaterialX output format may have changed)');
  const braceIdx = src.indexOf('{', mainIdx);
  if (braceIdx === -1) throw new Error('injectPeelDiscard: no main() body found (MaterialX output format may have changed)');
  let out = src.slice(0, mainIdx) + decls + src.slice(mainIdx, braceIdx + 1) + block + src.slice(braceIdx + 1);

  // Tail pass (u_peelMode==2) writes premultiplied color so it can
  // under-blend into accumRT; injected right before main()'s closing
  // brace (same anchor encodeDisplay() uses for its own epilogue, which
  // by now has already spliced — gated open or not — and is the last
  // thing before that brace).
  const outMatch = out.match(/\bout\s+vec4\s+(\w+)\s*;/);
  if (outMatch) {
    const v = outMatch[1];
    const closeIdx = out.lastIndexOf('}');
    const premult = '\n    if (u_peelMode == 2) { ' + v + '.rgb *= ' + v + '.a; }\n';
    out = out.slice(0, closeIdx) + premult + out.slice(closeIdx);
  } else {
    mtlxWarn('mtlx-engine: injectPeelDiscard could not locate the fragment output variable — tail-pass premultiply skipped.');
  }
  return out;
};

// Emscripten throws C++ exceptions as raw NUMBER pointers, not Error
// objects — a bare catch stringifies one as "5247184"/"undefined" instead
// of the real message. Decode via mx.getExceptionMessage when available.
const mxErr = (mx, e) => {
  try {
    if (typeof e === 'number' && mx && typeof mx.getExceptionMessage === 'function') {
      const msg = mx.getExceptionMessage(e);
      // getExceptionMessage may return a string or [type, message]
      if (Array.isArray(msg)) return msg.filter(Boolean).join(': ');
      if (msg) return String(msg);
    }
  } catch (_) {/* fall through to generic handling */}
  if (e && e.message) return e.message;
  return String(e);
};

// CRITICAL: the wasm binding of setValueString is the TYPED
// setValue(value, type="string"), so writing a value RETYPES the input
// to "string". Writing the raw `value` attribute never touches type.
const mxWriteValue = (inp, str, type) => {
  mxWarnIfLocked('mxWriteValue'); // exported doc-mutating helper — see mxWarnIfLocked's header comment
  try {
    if (typeof inp.setAttribute === 'function') {
      inp.setAttribute('value', String(str));
      return;
    }
  } catch (e) {/* fall through */}
  try {
    // Two-arg form sets value AND the correct type explicitly.
    inp.setValueString(String(str), type || inp.getType());
    return;
  } catch (e) {/* fall through */}
  inp.setValueString(String(str));
  try {
    if (type) inp.setType(type);
  } catch (e) {/* best-effort */}
};

// MaterialX JS marshals std::vector either as a real JS array or as a
// {size(), get(i)} object depending on the binding; normalize to array.
const vecToArray = v => {
  if (!v) return [];
  if (Array.isArray(v)) return v; // this vendored build marshals vectors as real JS arrays
  if (typeof v.size === 'function') {
    const out = [];
    for (let i = 0; i < v.size(); i++) out.push(v.get(i));
    // embind-owned heap vector; materialized elements are independent
    // shared_ptr handles, so free the wrapper. Audited: no caller
    // retains the raw vector (js/ and scripts/ checked).
    if (typeof v.delete === 'function') {
      try {
        v.delete();
      } catch (e) {/* already freed */}
    }
    return out;
  }
  return [];
};
const mxSafe = (fn, fb) => {
  try {
    const v = fn();
    return v == null ? fb : v;
  } catch (e) {
    return fb;
  }
};
const mxElCat = el => mxSafe(() => el.getCategory(), '');
const mxElType = el => mxSafe(() => String(el.getType()), '');
const mxElName = el => mxSafe(() => el.getName(), '');
const mxElAttr = (el, name) => mxSafe(() => el.getAttribute(name), '');
const mxElHasAttr = (el, name) => mxSafe(() => el.hasAttribute(name), false);
// Exception-safe single-attribute writes — the wasm binding can throw on
// a detached/invalid element, which mxSafe swallows into a `false` return.
const mxSetAttr = (el, name, value) => mxSafe(() => {
  el.setAttribute(name, value);
  return true;
}, false);
const mxRemoveAttr = (el, name) => mxSafe(() => {
  el.removeAttribute(name);
  return true;
}, false);
// Tag an element's colorspace, preferring the typed setColorSpace()
// binding when present and falling back to the raw attribute otherwise —
// not every element's wasm binding exposes the typed setter.
const mxSetColorspace = (el, cs) => {
  mxWarnIfLocked('mxSetColorspace'); // exported doc-mutating helper — see mxWarnIfLocked's header comment
  return mxSafe(() => {
    if (typeof el.setColorSpace === 'function') el.setColorSpace(cs);else el.setAttribute('colorspace', cs);
    return true;
  }, false);
};

// Shortest `convert` hop chain fromType->toType (only conversions the
// library defines) — a mismatched convert otherwise fails silently
// until GLSL compile. []=no convert needed, null=unreachable.
const findConvertChain = (doc, fromType, toType) => {
  mxWarnIfLocked('findConvertChain'); // exported doc-reading helper — see mxWarnIfLocked's header comment
  if (fromType === toType) return [];
  const typeStr = t => t && t.getName ? t.getName() : String(t || '');
  // convert nodedefs -> directed edges inType -> outType
  const convEdges = {};
  for (const def of vecToArray(mxSafe(() => doc.getMatchingNodeDefs('convert'), []))) {
    const ins = vecToArray(mxSafe(() => def.getInputs(), []));
    if (ins.length !== 1) continue;
    const inT = typeStr(mxSafe(() => ins[0].getType(), ''));
    const outT = typeStr(mxSafe(() => def.getType(), ''));
    if (!inT || !outT || outT === 'multioutput') continue;
    (convEdges[inT] = convEdges[inT] || new Set()).add(outT);
  }
  // BFS, shortest chain wins (converts are cheap but each hop is
  // another generated function).
  const prev = {
    [fromType]: null
  };
  let frontier = [fromType];
  while (frontier.length) {
    const next = [];
    for (const t of frontier) {
      for (const n of convEdges[t] || []) {
        if (n in prev) continue;
        prev[n] = t;
        if (n === toType) {
          const chain = [];
          for (let c = toType; c !== fromType; c = prev[c]) chain.unshift(c);
          return chain;
        }
        next.push(n);
      }
    }
    frontier = next;
  }
  return null;
};

// Create-or-fetch an input on `node`, guaranteeing its TYPE — the only
// safe way here: addInput(name, type) can drop the type arg, and
// setValueString retypes to 'string', either breaking nodedef resolution.
const ensureTypedInput = (doc, node, inputName, wantedType) => {
  mxWarnIfLocked('ensureTypedInput'); // exported doc-mutating helper — see mxWarnIfLocked's header comment
  let inp = mxSafe(() => node.getInput(inputName), null);
  let how = 'existing';
  if (!inp) {
    let defInput = null;
    const cat = mxElCat(node);
    for (const d of vecToArray(mxSafe(() => doc.getMatchingNodeDefs(cat), []))) {
      const cand = mxSafe(() => d.getInput(inputName), null) || mxSafe(() => d.getActiveInput(inputName), null);
      if (!cand) continue;
      if (!defInput) defInput = cand; // fallback: first found
      if (wantedType && mxElType(cand) === wantedType) {
        defInput = cand;
        break;
      }
    }
    inp = mxSafe(() => node.addInput(inputName), null);
    how = 'added-bare';
    if (inp && defInput) {
      const copied = mxSafe(() => {
        inp.copyContentFrom(defInput);
        return true;
      }, false);
      if (copied) {
        how = 'copied-from-nodedef';
        // The copy brings nodedef UI/doc metadata along — noisy in
        // exports. defaultgeomprop is worse: MaterialX's validator
        // rejects it outright on a node-instance input.
        for (const attr of ['uimin', 'uimax', 'uisoftmin', 'uisoftmax', 'uistep', 'uiname', 'uifolder', 'uiadvanced', 'doc', 'enum', 'enumvalues', 'defaultgeomprop']) {
          mxRemoveAttr(inp, attr);
        }
      }
    }
  }
  // Enforce the caller's type UNCONDITIONALLY — a wrong-typed copy (see
  // above) must not survive; the caller knows the graph typing, the
  // copy only supplies defaults/metadata.
  if (inp && wantedType && mxElType(inp) !== wantedType) {
    mxSafe(() => {
      if (typeof inp.setType === 'function') inp.setType(wantedType);else inp.setAttribute('type', wantedType);
      return true;
    }, false);
    if (mxElType(inp) !== wantedType) {
      mxSetAttr(inp, 'type', wantedType);
    }
    // A copied default VALUE is malformed for the corrected type —
    // drop it; callers connect or re-value anyway.
    mxRemoveAttr(inp, 'value');
  }
  if (inp && wantedType && mxElType(inp) !== wantedType) {
    mtlxWarn('ensureTypedInput: "' + inputName + '" is "' + mxElType(inp) + '" (wanted "' + wantedType + '"), path=' + how);
  }
  return inp;
};

// Sweep run before every writeToXmlString call, fixing two attributes
// MaterialX's validator rejects: a leftover `value` on a connected
// input, and `defaultgeomprop` on a node-instance input. Depth-capped walk.
const stripValuesFromConnectedInputs = (doc, maxDepth) => {
  mxWarnIfLocked('stripValuesFromConnectedInputs'); // exported doc-mutating helper — see mxWarnIfLocked's header comment
  const cap = typeof maxDepth === 'number' ? maxDepth : 10;
  let stripped = 0;
  const walk = (el, depth) => {
    if (!el || depth > cap) return;
    const children = vecToArray(mxSafe(() => el.getChildren(), []));
    for (const child of children) {
      if (mxElCat(child) === 'input') {
        const connected = mxElAttr(child, 'nodename') || mxElAttr(child, 'nodegraph') || mxElAttr(child, 'interfacename');
        // Presence, not truthiness: an empty value="" on a
        // connected input is just as invalid as a non-empty one;
        // mxElAttr's '' fallback can't tell absent from present-but-empty.
        if (connected && mxElHasAttr(child, 'value')) {
          const removed = mxRemoveAttr(child, 'value');
          if (removed) stripped++;
        }
        // `el` (the loop's parent, already in scope) is this
        // input's parent element — reused here instead of a
        // second getParent() round trip.
        const parentCat = mxElCat(el);
        if (parentCat !== 'nodegraph' && parentCat !== 'nodedef' && mxElHasAttr(child, 'defaultgeomprop')) {
          const removed = mxRemoveAttr(child, 'defaultgeomprop');
          if (removed) stripped++;
        }
      }
      walk(child, depth + 1);
    }
  };
  walk(doc, 0);
  return stripped;
};

// Doc-level renderable scan: returns [{ name, node }], one entry per
// renderable surface. Scans by TYPE rather than getMaterialNodes(),
// which isn't bound in every JS build. Live-doc callers need mxExclusive.
const listDocRenderables = doc => {
  mxWarnIfLocked('listDocRenderables'); // exported doc-reading helper — see mxWarnIfLocked's header comment
  const renderables = [];
  const seen = new Set();
  // Defensive skip of transient __pv_* wrapper nodes: the graph
  // preview pipeline creates/destroys these inside its own mxExclusive
  // hold, so this guards against a caller somehow racing that hold.
  const isPvName = nm => typeof nm === 'string' && nm.indexOf('__pv_') === 0;
  const pushShader = (displayName, shaderNode) => {
    if (!shaderNode) return;
    let nm = displayName;
    try {
      nm = displayName || shaderNode.getName();
    } catch (e) {/* keep */}
    if (seen.has(nm)) return;
    let shaderName = null;
    try {
      shaderName = shaderNode.getName();
    } catch (e) {/* leave null, treated as not __pv_ */}
    if (isPvName(nm) || isPvName(shaderName)) return;
    seen.add(nm);
    renderables.push({
      name: nm,
      node: shaderNode
    });
  };
  const typeOf = n => {
    try {
      return String(n.getType());
    } catch (e) {
      return '';
    }
  };
  const nameOf = n => {
    try {
      return n.getName();
    } catch (e) {
      return null;
    }
  };
  // The shader a material node points at: prefer the binding's own
  // connection resolution, fall back to the nodename lookup.
  const connectedShader = matNode => {
    try {
      const inp = matNode.getInput && matNode.getInput('surfaceshader');
      if (!inp) return null;
      if (typeof inp.getConnectedNode === 'function') {
        const n = inp.getConnectedNode();
        if (n) return n;
      }
      const nm = inp.getNodeName ? inp.getNodeName() : null;
      return nm ? doc.getNode(nm) : null;
    } catch (e) {
      return null;
    }
  };
  let allNodes = [];
  try {
    allNodes = vecToArray(doc.getNodes ? doc.getNodes() : null);
  } catch (e) {
    allNodes = [];
  }
  if (!allNodes.length) {
    try {
      allNodes = vecToArray(doc.getMaterialNodes ? doc.getMaterialNodes() : null);
    } catch (e) {/* none */}
  }
  for (const n of allNodes) {
    if (typeOf(n) === 'material') pushShader(nameOf(n), connectedShader(n));
  }
  if (!renderables.length) {
    for (const n of allNodes) {
      if (typeOf(n) === 'surfaceshader') pushShader(nameOf(n), n);
    }
  }
  return renderables;
};

// Resolves on the next paint — callers awaiting this yield to the
// browser instead of blocking it, letting a queued DOM/state update
// actually paint before continuing.
const nextFrame = () => new Promise(r => requestAnimationFrame(r));

// ------------------------------------------------------------------
// Drag & drop ingestion — shared by the graph editor and material viewer views.
// ------------------------------------------------------------------

// Normalize a path for matching: forward slashes, lowercase, no
// leading ./ or /.
const normPath = p => String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();

// Directory-aware DataTransfer traversal. Returns { relPath: File }.
const readDroppedItems = async dataTransfer => {
  const map = {};
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const entries = items.map(it => it.webkitGetAsEntry ? it.webkitGetAsEntry() : null).filter(Boolean);
  if (!entries.length) {
    // Fallback: flat file list (no folder structure available).
    for (const f of Array.from(dataTransfer.files || [])) map[f.name] = f;
    return map;
  }
  const readEntry = (entry, prefix) => new Promise(resolve => {
    if (entry.isFile) {
      entry.file(f => {
        map[prefix + entry.name] = f;
        resolve();
      }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const sub = [];
      const readBatch = () => reader.readEntries(batch => {
        if (!batch.length) {
          Promise.all(sub.map(e2 => readEntry(e2, prefix + entry.name + '/'))).then(resolve);
          return;
        }
        sub.push(...batch);
        readBatch(); // readEntries returns results in batches
      }, () => resolve());
      readBatch();
    } else resolve();
  });
  await Promise.all(entries.map(e => readEntry(e, '')));
  return map;
};

// Expand any .zip files in the map into their contents (in place).
const expandZips = async map => {
  for (const key of Object.keys(map)) {
    if (!/\.zip$/i.test(key)) continue;
    const file = map[key];
    delete map[key];
    if (!window.JSZip) {
      throw new Error('The JSZip library is not loaded: .zip files can\'t be expanded. Reload the page and try again.');
    }
    const zip = await JSZip.loadAsync(file);
    const names = Object.keys(zip.files);
    for (const name of names) {
      const entry = zip.files[name];
      if (entry.dir) continue;
      map[name] = await entry.async('blob');
    }
  }
  return map;
};

// Find a dropped file for a path referenced inside the document:
// exact normalized match → unique suffix match → unique basename match.
const findFileForRef = (fileMap, ref) => {
  const want = normPath(ref);
  if (!want) return null;
  const keys = Object.keys(fileMap);
  const norm = {};
  for (const k of keys) norm[normPath(k)] = k;
  if (norm[want]) return {
    key: norm[want],
    how: 'exact'
  };
  const suffix = keys.filter(k => normPath(k).endsWith('/' + want) || normPath(k) === want);
  if (suffix.length === 1) return {
    key: suffix[0],
    how: 'suffix'
  };
  const base = want.split('/').pop();
  const byBase = keys.filter(k => normPath(k).split('/').pop() === base);
  if (byBase.length === 1) return {
    key: byBase[0],
    how: 'basename'
  };
  return null;
};

// Inline <xi:include href="..."/> from the dropped files (MaterialX
// documents may be split across files; readFromXmlString can't reach
// our in-memory map). Missing includes are dropped with a warning.
const resolveIncludes = async (xml, fileMap, fromDir, visited) => {
  visited = visited || new Set();
  // href may not be the first attribute and may be single-quoted —
  // any tag this regex misses would be handed to MaterialX, which
  // would try (and fail) to fetch it over HTTP itself.
  const INC = /<xi:include\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*?\/?>(?:\s*<\/xi:include>)?/g;
  const parts = [];
  let last = 0,
    m;
  while ((m = INC.exec(xml)) !== null) {
    parts.push(xml.slice(last, m.index));
    last = m.index + m[0].length;
    const href = m[1] || m[2];
    const refPath = fromDir ? fromDir + '/' + href : href;
    const hit = findFileForRef(fileMap, refPath) || findFileForRef(fileMap, href);
    if (!hit || visited.has(hit.key)) {
      console.warn('xi:include not resolvable from dropped files:', href);
      parts.push('<!-- unresolved include: ' + href.replace(/--/g, '- -') + ' -->');
      continue;
    }
    visited.add(hit.key);
    let inc = await fileMap[hit.key].text();
    const incDir = hit.key.indexOf('/') >= 0 ? hit.key.slice(0, hit.key.lastIndexOf('/')) : '';
    inc = await resolveIncludes(inc, fileMap, incDir, visited);
    // Strip the XML declaration and the outer <materialx> wrapper,
    // keeping only its children.
    inc = inc.replace(/<\?xml[^>]*\?>/, '');
    inc = inc.replace(/<materialx\b[^>]*>/, '').replace(/<\/materialx>\s*$/, '');
    parts.push(inc);
  }
  parts.push(xml.slice(last));
  return parts.join('');
};

// Read a dropped file entry, resolving xi:includes against `map`. Callers
// need BOTH strings: the graph editor validates the RAW as-authored text
// while parsing consumes the RESOLVED text.
const readMtlxText = async (entry, path, map) => {
  const raw = await entry.text();
  const dir = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '';
  const resolved = /<xi:include\b/.test(raw) ? await resolveIncludes(raw, map, dir) : raw;
  return {
    raw,
    resolved
  };
};

// Session-lifetime texture cache, keyed by file identity — re-binding the
// same dropped file after a view rebuild reuses the decoded THREE.Texture
// instead of a fresh async load, which let the default color flash.
const TEXTURE_CACHE = new Map();
const textureCacheKey = (blob, fallback) => {
  if (blob && blob.name != null && blob.size != null && blob.lastModified != null) {
    return blob.name + '|' + blob.size + '|' + blob.lastModified;
  }
  return fallback; // e.g. the fileMap key, when identity fields are missing
};

// Parses a dropped .exr Blob via THREE.EXRLoader (pinned to three@0.147.0,
// see index.html). setDataType(FloatType) is explicit: 0.147.0 defaults to
// HalfFloatType, silently swapping d.data to a Uint16Array otherwise.
const loadExrTexture = async blob => {
  if (typeof THREE.EXRLoader === 'undefined') {
    console.warn('mtlx-engine: THREE.EXRLoader unavailable (script blocked/offline); .exr textures keep the node default color.');
    return null;
  }
  try {
    const buf = await blob.arrayBuffer();
    const d = new THREE.EXRLoader().setDataType(THREE.FloatType).parse(buf);
    if (!d || !d.data) return null;
    const tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    return tex;
  } catch (e) {
    console.warn('mtlx-engine: failed to parse dropped .exr texture, keeping the node default color:', e);
    return null;
  }
};

// Parses a dropped .hdr Blob via THREE.RGBELoader's synchronous .parse().
// Explicitly set to FloatType (not the default RGBE byte packing) so the
// MaterialX sampler, which has no RGBE decode step, reads linear values.
const loadHdrTexture = async blob => {
  if (typeof THREE.RGBELoader === 'undefined') {
    console.warn('mtlx-engine: THREE.RGBELoader unavailable; .hdr textures keep the node default color.');
    return null;
  }
  try {
    const buf = await blob.arrayBuffer();
    const d = new THREE.RGBELoader().setDataType(THREE.FloatType).parse(buf);
    if (!d || !d.data) return null;
    const tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    return tex;
  } catch (e) {
    console.warn('mtlx-engine: failed to parse dropped .hdr texture, keeping the node default color:', e);
    return null;
  }
};

// Binds dropped textures onto the shader's filename sampler uniforms.
// Cache hits assign synchronously; misses load async (TextureLoader, or
// the .exr/.hdr parsers above). `onBound` fires per texture that lands.
const bindDroppedTextures = (view, fileMap, onBound) => {
  const bound = [],
    missing = [];
  for (const u of view.introspected) {
    if (u.type !== 'filename') continue;
    let ref = '';
    try {
      if (typeof u.data === 'string') ref = u.data;else if (u.data != null) ref = String(u.data);
    } catch (e) {
      ref = '';
    }
    if (!ref) continue; // no file reference recorded
    const hit = findFileForRef(fileMap, ref);
    if (!hit) {
      missing.push(ref);
      continue;
    }
    const blob = fileMap[hit.key];
    const cacheKey = textureCacheKey(blob, hit.key);
    const cached = TEXTURE_CACHE.get(cacheKey);
    if (cached) {
      if (view.uniforms[u.name]) view.uniforms[u.name].value = cached;
      if (onBound) onBound();
    } else {
      const ext = (hit.key.split('.').pop() || ref.split('.').pop() || '').toLowerCase();
      if (ext === 'exr' || ext === 'hdr') {
        const parsePromise = ext === 'exr' ? loadExrTexture(blob) : loadHdrTexture(blob);
        parsePromise.then(tex => {
          if (!tex) return; // unsupported/corrupt, the node default color stands
          configureLoadedTexture(tex);
          TEXTURE_CACHE.set(cacheKey, tex);
          if (view.uniforms[u.name]) view.uniforms[u.name].value = tex;
          if (onBound) onBound();
        });
      } else {
        const url = URL.createObjectURL(blob);
        new THREE.TextureLoader().load(url, tex => {
          configureLoadedTexture(tex);
          TEXTURE_CACHE.set(cacheKey, tex);
          if (view.uniforms[u.name]) view.uniforms[u.name].value = tex;
          URL.revokeObjectURL(url);
          if (onBound) onBound();
        }, undefined, () => URL.revokeObjectURL(url));
      }
    }
    bound.push(ref + '  →  ' + hit.key);
  }
  return {
    bound,
    missing
  };
};

// Extracts a plain JS array from a real array or an embind vector-like
// value ({size(),get(i)} or {data()}). plainizeMxUniformData relies on
// this to detach heap-backed views before the mxExclusive lock releases.
const mxDataToPlainArray = d => {
  if (Array.isArray(d)) return d;
  if (d && typeof d.data === 'function') {
    try {
      return Array.from(d.data());
    } catch (e) {/* not iterable */}
  }
  if (d && typeof d.size === 'function') {
    const o = [];
    for (let i = 0; i < d.size(); i++) o.push(d.get(i));
    return o;
  }
  return null;
};

// Enumerate a ShaderStage's uniforms via MaterialX introspection. `data`
// may be a LIVE heap-backed view for vector/matrix/color types — run it
// through plainizeMxUniformData before the mxExclusive lock releases.
const collectMxUniforms = stage => {
  mxWarnIfLocked('collectMxUniforms'); // exported doc-reading helper (per shader-gen, not per-frame) — see mxWarnIfLocked's header comment
  const out = [];
  const blocks = []; // { key, blk }
  let blockMap = null;
  try {
    blockMap = stage.getUniformBlocks && stage.getUniformBlocks();
  } catch (e) {/* older binding */}
  if (blockMap) {
    if (typeof blockMap.keys === 'function') {
      for (const k of vecToArray(blockMap.keys())) {
        try {
          blocks.push({
            key: String(k),
            blk: blockMap.get(k)
          });
        } catch (e) {/* skip */}
      }
    } else {
      for (const k of Object.keys(blockMap)) blocks.push({
        key: k,
        blk: blockMap[k]
      });
    }
  } else {
    // HW shader generators register exactly these two blocks
    // (HW::PUBLIC_UNIFORMS / HW::PRIVATE_UNIFORMS).
    for (const name of ['PublicUniforms', 'PrivateUniforms']) {
      try {
        const b = stage.getUniformBlock(name);
        if (b) blocks.push({
          key: name,
          blk: b
        });
      } catch (e) {/* absent */}
    }
  }
  for (const entry of blocks) {
    const b = entry.blk;
    let n = 0;
    try {
      n = typeof b.size === 'function' ? b.size() : 0;
    } catch (e) {/* skip block */}
    for (let i = 0; i < n; i++) {
      try {
        const v = b.get(i);
        const name = v.getVariable && v.getVariable() || v.getName && v.getName();
        if (!name) continue;
        let type = null;
        try {
          const t = v.getType && v.getType();
          type = t ? t.getName && t.getName() || String(t) : null;
        } catch (e) {/* type unreadable */}
        let data = null;
        try {
          const val = v.getValue && v.getValue();
          if (val && val.getData) data = val.getData();
        } catch (e) {/* no default recorded */}
        // The MaterialX element path (e.g. "preview_node/amplitude")
        // ties the uniform back to a node input — used by the
        // dynamic parameter UI.
        let path = null;
        try {
          path = v.getPath && v.getPath() || null;
        } catch (e) {/* absent */}
        out.push({
          name,
          type,
          data,
          path,
          block: entry.key
        });
      } catch (e) {/* skip unreadable entry */}
    }
  }
  return out;
};

// Types whose collectMxUniforms `data` may be a live embind heap-backed
// view, needing mxDataToPlainArray to detach it. Scalars and
// filename/string values already arrive as plain JS, untouched.
const VECTOR_MX_TYPES = new Set(['vector2', 'vector3', 'vector4', 'color3', 'color4', 'matrix33', 'matrix44']);

// Converts ONE collectMxUniforms() entry's `data` to plain JS — must run
// before the mxExclusive lock (see the caution on collectMxUniforms
// above) releases. Returns a new entry object; never mutates the input.
const plainizeMxUniformData = u => {
  if (u.data == null || !VECTOR_MX_TYPES.has(u.type)) return u;
  return Object.assign({}, u, {
    data: mxDataToPlainArray(u.data)
  });
};

// Converts a MaterialX default value into a three.js uniform. Returns
// null for types that can't be a plain default (filename/sampler/string).
// `data` should be plain JS already; a live wasm vector is tolerated too.
const mxValueToThreeUniform = (type, data) => {
  const arr = mxDataToPlainArray;
  switch (type) {
    case 'float':
      {
        const n = Number(data);
        return {
          value: isNaN(n) ? 0 : n
        };
      }
    case 'integer':
      {
        const n = Number(data);
        return {
          value: isNaN(n) ? 0 : n | 0
        };
      }
    case 'boolean':
      return {
        value: !!data
      };
    case 'vector2':
      {
        const a = arr(data) || [0, 0];
        return {
          value: new THREE.Vector2(a[0], a[1])
        };
      }
    case 'color3':
    case 'vector3':
      {
        const a = arr(data) || [0, 0, 0];
        return {
          value: new THREE.Vector3(a[0], a[1], a[2])
        };
      }
    case 'color4':
    case 'vector4':
      {
        const a = arr(data) || [0, 0, 0, 0];
        return {
          value: new THREE.Vector4(a[0], a[1], a[2], a[3])
        };
      }
    case 'matrix33':
      {
        const a = arr(data);
        const m = new THREE.Matrix3();
        if (a && a.length === 9) m.fromArray(a);
        return {
          value: m
        };
      }
    case 'matrix44':
      {
        const a = arr(data);
        const m = new THREE.Matrix4();
        if (a && a.length === 16) m.fromArray(a);
        return {
          value: m
        };
      }
    default:
      return null;
  }
};

// The parameter UI's color picker speaks LINEAR, like MaterialX itself:
// hex bytes map byte/255 onto stored linear values, deliberately NOT an
// sRGB encode — keeps the picker in agreement with the 0-1 RGB spinners.
const linToSrgb = c => {
  const x = Math.max(0, Math.min(1, c));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
};
const srgbToLin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const rgbToHex = rgb => '#' + rgb.slice(0, 3).map(c => {
  const h = Math.round(Math.max(0, Math.min(1, Number(c) || 0)) * 255).toString(16);
  return h.length === 1 ? '0' + h : h;
}).join('');
const hexToRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

// MaterialXView parity: the generated GLSL takes `defaultval` and never
// reads it, so a filename sampler with no image binds a 1x1 texture of
// that value instead. Shared per value, like the env textures.
const DEFAULT_VALUE_TEXTURES = new Map();
// Membership lives here, not on the texture: r128's Texture has no
// userData (it ends at onUpdate), so tagging one throws.
const DEFAULT_VALUE_TEXTURE_SET = new WeakSet();
const defaultValueToRgba = (type, data) => {
  if (type === 'float') {
    const n = Number(data);
    return isNaN(n) ? null : [n, n, n, 1];
  }
  const a = mxDataToPlainArray(data);
  if (!a) return null;
  const c = i => Number(a[i]) || 0;
  switch (type) {
    case 'vector2':
      return [c(0), c(1), 0, 1];
    case 'color3':
    case 'vector3':
      return [c(0), c(1), c(2), 1];
    case 'color4':
    case 'vector4':
      return [c(0), c(1), c(2), a[3] == null ? 1 : c(3)];
    default:
      return null;
  }
};
// Mirrors ImageSamplingProperties::setProperties: strip the sampler's
// trailing `_file` and read the sibling `_default`, or `_default_cm_in`
// when a colorspace on the image node renamed it.
const getFilenameDefaultTexture = (introspected, samplerName) => {
  const cut = samplerName.lastIndexOf('_');
  if (cut <= 0) return null;
  const root = samplerName.slice(0, cut);
  let port = null;
  for (const u of introspected) {
    if (u.name === root + '_default') {
      port = u;
      break;
    }
    if (u.name === root + '_default_cm_in' && !port) port = u;
  }
  if (!port || port.data == null) return null;
  const rgba = defaultValueToRgba(port.type, port.data);
  if (!rgba) return null;
  return defaultValueTexture(rgba);
};
// Upstream's own caveat rides along: the default is assumed to be in the
// missing image's color space already, so nothing transforms it. Tracked
// so a live edit can tell our bake from a real image the user bound.
const defaultValueTexture = rgba => {
  const key = rgba.join(',');
  const hit = DEFAULT_VALUE_TEXTURES.get(key);
  if (hit) return hit;
  const t = new THREE.DataTexture(new Float32Array(rgba), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  DEFAULT_VALUE_TEXTURE_SET.add(t);
  DEFAULT_VALUE_TEXTURES.set(key, t);
  return t;
};
const isFilenameDefaultTexture = t => !!t && DEFAULT_VALUE_TEXTURE_SET.has(t);
// A sampler still showing our bake may be re-baked; one holding a real
// image must not be. Null counts as ours (a node with no default).
const samplerHoldsDefault = slot => !!slot && (!slot.value || isFilenameDefaultTexture(slot.value));
// The generated GLSL ignores `defaultval`, so the sampler's 1x1 texture is
// what carries the value: editing a `_default` uniform live has to re-bake
// it. `value` is a plain number or array, not MaterialX heap data.
const rebindFilenameDefault = (uniforms, defaultUniformName, type, value) => {
  const m = /^(.*)_default(?:_cm_in)?$/.exec(defaultUniformName || '');
  if (!m) return false;
  const slot = uniforms ? uniforms[m[1] + '_file'] : null;
  if (!samplerHoldsDefault(slot)) return false;
  const rgba = defaultValueToRgba(type, value);
  if (!rgba) return false;
  slot.value = defaultValueTexture(rgba);
  return true;
};

// Configure a user-loaded texture the way the generated shaders expect
// to sample a `filename` input: repeat wrapping, no flipY.
const configureLoadedTexture = t => {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
};

// ---- Preview geometry ----
// Aliases three's attributes to MaterialX vertex-shader names, providing
// tangents (real when computable, constant +X fallback otherwise).
const prepGeometry = geometry => {
  // Already prepped (e.g. a cached shaderball clone) — skip re-running
  // computeTangents on an already-tangented geometry.
  if (geometry.getAttribute('i_tangent')) return geometry;
  if (!geometry.getAttribute('uv')) {
    // MaterialX shaders read texcoords; give degenerate UVs
    // rather than an unbound attribute.
    const count = geometry.getAttribute('position').count;
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  geometry.setAttribute('i_position', geometry.getAttribute('position'));
  geometry.setAttribute('i_normal', geometry.getAttribute('normal'));
  geometry.setAttribute('i_texcoord_0', geometry.getAttribute('uv'));
  let iTangent = null;
  // r128's computeTangents CONSOLE.ERRORs (not throws) when
  // index/position/normal/uv are missing — precheck so an ineligible
  // geometry goes straight to the fallback without the scary log.
  const canTangent = !!(geometry.getIndex() && geometry.getAttribute('position') && geometry.getAttribute('normal') && geometry.getAttribute('uv'));
  if (canTangent) {
    try {
      geometry.computeTangents();
      const t = geometry.getAttribute('tangent'); // vec4 (may be absent on silent failure)
      if (t) {
        const tri = new Float32Array(t.count * 3);
        for (let i = 0; i < t.count; i++) {
          tri[i * 3] = t.getX(i);
          tri[i * 3 + 1] = t.getY(i);
          tri[i * 3 + 2] = t.getZ(i);
        }
        // Zero-UV-area triangles (and the sphere's poles) leave
        // computeTangents' normalize() dividing by zero, writing a
        // (0,0,0) tangent that NaNs the shader's normalize(i_tangent).
        // Repair those with a tangent orthogonal to the vertex normal.
        const nrm = geometry.getAttribute('normal');
        let repaired = 0;
        for (let i = 0; i < t.count; i++) {
          const x = tri[i * 3],
            y = tri[i * 3 + 1],
            z = tri[i * 3 + 2];
          if (x * x + y * y + z * z < 1e-10) {
            const nx = nrm.getX(i),
              ny = nrm.getY(i),
              nz = nrm.getZ(i);
            const ax = Math.abs(nx) < 0.9 ? 1 : 0,
              ay = ax ? 0 : 1;
            let cx = -nz * ay,
              cy = nz * ax,
              cz = nx * ay - ny * ax;
            const len = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
            tri[i * 3] = cx / len;
            tri[i * 3 + 1] = cy / len;
            tri[i * 3 + 2] = cz / len;
            repaired++;
          }
        }
        if (repaired) console.warn('[mtlx] repaired ' + repaired + ' degenerate tangents (zero-UV-area triangles) on geometry');
        iTangent = new THREE.BufferAttribute(tri, 3);
      }
    } catch (e) {/* fall through to constant tangent */}
  }
  if (!iTangent) {
    const vcount = geometry.getAttribute('position').count;
    const tangents = new Float32Array(vcount * 3);
    for (let i = 0; i < vcount; i++) tangents[i * 3] = 1;
    iTangent = new THREE.BufferAttribute(tangents, 3);
  }
  geometry.setAttribute('i_tangent', iTangent);
  return geometry;
};

// Center a geometry at the origin and scale it to bounding radius 1
// so all preview shapes frame identically.
const normalizeGeometry = geometry => {
  geometry.computeBoundingSphere();
  const bs = geometry.boundingSphere;
  if (bs && bs.radius > 0) {
    geometry.translate(-bs.center.x, -bs.center.y, -bs.center.z);
    const s = 1 / bs.radius;
    geometry.scale(s, s, s);
  }
  return geometry;
};

// Shaderball: two GLB exports of the ASWF/USD-WG Standard Shader Ball
// under models/ (see models/LICENSE_shaderball.txt). glbSceneCache holds the raw
// GLTFLoader result per URL; consumers clone() rather than mutate/dispose it.
const glbSceneCache = new Map();
const loadGlbScene = url => {
  if (!glbSceneCache.has(url)) {
    glbSceneCache.set(url, new Promise(resolve => {
      if (!THREE.GLTFLoader) {
        resolve(null);
        return;
      }
      new THREE.GLTFLoader().load(url, gltf => resolve(gltf), undefined, e => {
        console.warn('shaderball scene load failed:', url, e);
        resolve(null);
      });
    }));
  }
  return glbSceneCache.get(url);
};

// Instantiates a PER-VIEW copy of the cached shaderball scene. mode:
// 'full' (shaderball.glb, embedded camera) or 'simple' (ball only).
// Returns null on load failure or a missing 'material_surface' mesh.
const instantiateShaderballScene = async (mode /* 'full' | 'simple' */) => {
  const url = new URL(mode === 'full' ? 'models/shaderball.glb' : 'models/shaderball_simple.glb', document.baseURI).href;
  const gltf = await loadGlbScene(url);
  if (!gltf) return null;

  // Object3D.clone(true) deep-clones the node hierarchy but only
  // shallow-copies each mesh's geometry/material (shared by reference)
  // — two concurrent views need the traverse below to un-share state.
  const group = gltf.scene.clone(true);
  let glbCamera = null;
  let surfaceMesh = null;
  const ownedMaterials = [];
  group.traverse(obj => {
    if (mode === 'full' && obj.isCamera && !glbCamera) {
      glbCamera = obj;
      return;
    }
    if (!obj.isMesh) return;
    if (obj.name === 'material_surface') {
      // The generated MaterialX material lands here (both GLBs
      // author this primitive with a NULL material) —
      // createMtlxRenderView assigns it via applyMaterialInternal.
      surfaceMesh = obj;
      return;
    }
    if (/^backplane/.test(obj.name)) {
      // Emitter panels: NULL glTF material + baked vertex COLOR_0,
      // self-lit "light card" look. toneMapped:true keeps them on
      // the same ACES curve as the MaterialX surface (encodeDisplay).
      const m = new THREE.MeshBasicMaterial({
        vertexColors: true,
        toneMapped: true
      });
      obj.material = m;
      ownedMaterials.push(m);
      return;
    }
    if (obj.material) {
      // Every other glTF-materialed mesh: clone() so this view
      // OWNS its material instance — without it, setEnvExposure's
      // envMapIntensity mutation would leak across cached views.
      const wasArray = Array.isArray(obj.material);
      const clones = (wasArray ? obj.material : [obj.material]).map(m => m.clone());
      obj.material = wasArray ? clones : clones[0];
      ownedMaterials.push(...clones);
    }
  });
  if (!surfaceMesh) return null;

  // Per-view geometry clone: prepGeometry MUTATES the geometry (adds
  // i_position/i_normal/etc aliases) — clone first so the cache's
  // original geometry stays pristine for other views.
  surfaceMesh.geometry = prepGeometry(surfaceMesh.geometry.clone());
  if (mode === 'simple') {
    // Whole-scene analog of normalizeGeometry: centers the bounding
    // sphere at radius 1 so this preset frames like sphere/cube.
    // Wraps in a group transform since meshes keep internal transforms.
    const bs = new THREE.Box3().setFromObject(group).getBoundingSphere(new THREE.Sphere());
    const outer = new THREE.Group();
    outer.add(group);
    if (bs.radius > 0) {
      const s = 1 / bs.radius;
      outer.scale.setScalar(s);
      outer.position.copy(bs.center).multiplyScalar(-s);
    }
    return {
      group: outer,
      surfaceMesh,
      glbCamera: null,
      ownedMaterials
    };
  }
  return {
    group,
    surfaceMesh,
    glbCamera,
    ownedMaterials
  };
};

// The official ASWF MaterialX shaderball (gh-pages branch asset), fetched
// once and cached — reference geometry alongside the bundled models/*.glb
// presets. mtlx-assets.js's ghPagesUrl() was removed in 6da20b1 along with
// this geometry, so its gh-pages-branch URL is rebuilt here instead.
let shaderballMtlxPromise = null;
const getShaderballMtlxGeometry = () => {
  if (!shaderballMtlxPromise) {
    shaderballMtlxPromise = (async () => {
      if (!THREE.GLTFLoader) return null;
      if (window.MtlxAssets && window.MtlxAssets.ready) await window.MtlxAssets.ready;
      const local = window.MtlxAssets && window.MtlxAssets.isLocal && window.MtlxAssets.isLocal();
      const url = local ? new URL('vendor/materialx/gh-pages/Geometry/shaderball.glb', document.baseURI).href : 'https://raw.githubusercontent.com/AcademySoftwareFoundation/MaterialX/gh-pages/Geometry/shaderball.glb';
      return new Promise(resolve => {
        new THREE.GLTFLoader().load(url, gltf => {
          try {
            // Several meshes (ball, base, ...) with node transforms —
            // bake each mesh's world matrix and concatenate into one
            // BufferGeometry so it shares a single preview material.
            const parts = [];
            gltf.scene.updateMatrixWorld(true);
            gltf.scene.traverse(obj => {
              if (obj.isMesh && obj.geometry) {
                const g = obj.geometry.clone().toNonIndexed();
                g.applyMatrix4(obj.matrixWorld);
                parts.push(g);
              }
            });
            if (!parts.length) return resolve(null);
            // Manual attribute concat (BufferGeometryUtils isn't loaded).
            const total = parts.reduce((n, g) => n + g.getAttribute('position').count, 0);
            const pos = new Float32Array(total * 3);
            const nrm = new Float32Array(total * 3);
            const uv = new Float32Array(total * 2);
            let off = 0;
            for (const g of parts) {
              const p = g.getAttribute('position');
              const n = g.getAttribute('normal');
              const u = g.getAttribute('uv');
              pos.set(p.array, off * 3);
              if (n) nrm.set(n.array, off * 3);
              if (u) uv.set(u.array, off * 2);
              off += p.count;
            }
            const merged = new THREE.BufferGeometry();
            merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            merged.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
            merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
            // computeTangents (inside prepGeometry) requires an
            // index; the merge above is non-indexed, so give it
            // a trivial sequential one.
            const idx = new Uint32Array(total);
            for (let ii = 0; ii < total; ii++) idx[ii] = ii;
            merged.setIndex(new THREE.BufferAttribute(idx, 1));
            resolve(prepGeometry(normalizeGeometry(merged)));
          } catch (e) {
            console.warn('shaderball-mtlx merge failed:', e);
            resolve(null);
          }
        }, undefined, e => {
          console.warn('shaderball-mtlx load failed:', e);
          resolve(null);
        });
      });
    })();
  }
  return shaderballMtlxPromise;
};

// Cloth drape preset (models/cloth_base_mesh.glb, see
// models/LICENSE_cloth.txt): a single-mesh GLB — bake its world
// transform, prep once, and clone per view like shaderball-mtlx.
let clothGeometryPromise = null;
const getClothGeometry = () => {
  if (!clothGeometryPromise) {
    clothGeometryPromise = (async () => {
      const url = new URL('models/cloth_base_mesh.glb', document.baseURI).href;
      const gltf = await loadGlbScene(url);
      if (!gltf) return null;
      try {
        gltf.scene.updateMatrixWorld(true);
        let geom = null;
        gltf.scene.traverse(obj => {
          if (!geom && obj.isMesh && obj.geometry) {
            geom = obj.geometry.clone();
            geom.applyMatrix4(obj.matrixWorld);
          }
        });
        if (!geom) return null;
        return prepGeometry(normalizeGeometry(geom));
      } catch (e) {
        console.warn('cloth geometry load failed:', e);
        return null;
      }
    })();
  }
  return clothGeometryPromise;
};

// Builds cube/sphere/cloth/shaderball-mtlx preview geometry — the shaderball/
// shaderball-scene presets are full GLB scenes handled separately by
// instantiateShaderballScene(). Any unrecognized `which` falls back to
// the sphere (including a shaderball-mtlx fetch failure).
const buildPreviewGeometry = async which => {
  if (which === 'cube') {
    return normalizeGeometry(new THREE.BoxGeometry(1.3, 1.3, 1.3));
  }
  if (which === 'shaderball-mtlx') {
    const g = await getShaderballMtlxGeometry();
    if (g) return g.clone();
  }
  if (which === 'cloth') {
    const g = await getClothGeometry();
    if (g) return g.clone();
  }
  if (which === 'buffer2d') {
    // Fullscreen quad for the flat2d ortho frustum: already exactly
    // framed, so no normalizeGeometry (it would shrink the quad to
    // bounding radius 1, off the viewport edges). +Z normal faces
    // the camera; positions and UVs get refit to the canvas aspect
    // by fitQuadToAspect (screen-proportional Shadertoy convention).
    return new THREE.PlaneGeometry(2, 2);
  }
  return new THREE.SphereGeometry(1, 64, 64);
};

// Resolves how to preview a node from its nodedefs: handles overloaded
// defs and MULTI-OUTPUT defs (picks the first viewable output). Returns
// { kind, outType, outputName, multiOutput }.
const COLOR_VIEWABLE = ['color3', 'color4', 'float', 'vector2', 'vector3', 'vector4'];
// `defFilter` (optional) narrows matching nodedefs — categories aren't
// unique across libraries ('add' is math AND BSDF/EDF/VDF). `preferType`
// picks an output type explicitly; `preferDefName` pins an exact nodedef.
const resolveNodeKind = (doc, nodeName, defFilter, preferType, preferDefName) => {
  mxWarnIfLocked('resolveNodeKind'); // exported doc-reading helper (per node-selection, not per-frame) — see mxWarnIfLocked's header comment
  let defs = vecToArray(doc.getMatchingNodeDefs(nodeName));
  let named = null;
  if (preferDefName) {
    named = defs.find(d => d.getName && d.getName() === preferDefName) || null;
  }
  if (named) {
    defs = [named];
  } else if (defFilter) {
    const kept = defs.filter(defFilter);
    if (kept.length) defs = kept;
  }
  // Flatten every def into candidate outputs.
  const candidates = []; // { type, outputName, multiOutput }
  const allTypes = [];
  for (const def of defs) {
    const outs = vecToArray(def.getOutputs ? def.getOutputs() : null);
    const multiOutput = def.getType && def.getType() === 'multioutput' || outs.length > 1;
    if (outs.length === 0) {
      const t = def.getType();
      allTypes.push(t);
      candidates.push({
        type: t,
        outputName: null,
        multiOutput: false
      });
    } else {
      for (const o of outs) {
        const t = o.getType();
        allTypes.push(t);
        // With a single output, downstream doesn't need an
        // explicit output name; with several, it does.
        candidates.push({
          type: t,
          outputName: multiOutput ? o.getName() : null,
          multiOutput
        });
      }
    }
  }

  // Explicit signature selection beats the default priority.
  if (preferType) {
    const want = candidates.find(c => c.type === preferType);
    if (want) {
      if (want.type === 'surfaceshader') return {
        kind: 'surface',
        ...want
      };
      if (want.type === 'BSDF') return {
        kind: 'bsdf',
        ...want
      };
      if (want.type === 'EDF') return {
        kind: 'edf',
        ...want
      };
      if (COLOR_VIEWABLE.indexOf(want.type) !== -1) {
        return {
          kind: 'color',
          outType: want.type,
          outputName: want.outputName,
          multiOutput: want.multiOutput
        };
      }
      return {
        kind: null,
        types: [want.type]
      };
    }
    // No candidate of that type (spec token didn't map to a real
    // nodedef): fall through to the automatic priority below.
  }

  // Priority: surface shader > BSDF > EDF > first viewable color/vector.
  const surf = candidates.find(c => c.type === 'surfaceshader');
  if (surf) return {
    kind: 'surface',
    ...surf
  };
  const bsdf = candidates.find(c => c.type === 'BSDF');
  if (bsdf) return {
    kind: 'bsdf',
    ...bsdf
  };
  const edf = candidates.find(c => c.type === 'EDF');
  if (edf) return {
    kind: 'edf',
    ...edf
  };
  for (const t of COLOR_VIEWABLE) {
    const hit = candidates.find(c => c.type === t);
    if (hit) return {
      kind: 'color',
      outType: t,
      outputName: hit.outputName,
      multiOutput: hit.multiOutput
    };
  }
  return {
    kind: null,
    types: allTypes
  };
};

// Synthesizes a small equirect environment (LDR, filter/mip-safe): a
// sky-to-ground gradient with a soft overhead "sun" for speculars.
// Keeps the viewer self-contained when no HDR is loaded.
const makeEnvTexture = (w, h, blurred) => {
  const data = new Uint8Array(w * h * 4);
  const sky = [150, 190, 235],
    horizon = [225, 225, 220],
    ground = [70, 66, 60];
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1); // 0 top .. 1 bottom
    for (let x = 0; x < w; x++) {
      let r, g, b;
      if (v < 0.5) {
        const t = v / 0.5;
        r = sky[0] + (horizon[0] - sky[0]) * t;
        g = sky[1] + (horizon[1] - sky[1]) * t;
        b = sky[2] + (horizon[2] - sky[2]) * t;
      } else {
        const t = (v - 0.5) / 0.5;
        r = horizon[0] + (ground[0] - horizon[0]) * t;
        g = horizon[1] + (ground[1] - horizon[1]) * t;
        b = horizon[2] + (ground[2] - horizon[2]) * t;
      }
      if (!blurred) {
        // soft sun highlight near the top-center
        const u = x / (w - 1);
        const d = Math.hypot(u - 0.5, v - 0.18);
        const sun = Math.max(0, 1 - d / 0.16);
        const s = sun * sun * 255;
        r = Math.min(255, r + s);
        g = Math.min(255, g + s);
        b = Math.min(255, b + s);
      }
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  // Equirect mapping is irrelevant to the IBL sampler; the skybox gets
  // its own copy via makeBackgroundTexture (see env-prep header above).
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = blurred ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = !blurred;
  tex.needsUpdate = true;
  return tex;
};

// Path to the app's default equirect environment: a studio EXR, parsed
// via EXRLoader and routed through prepareEnv/padToRGBA. No paired
// irradiance file — diffuse irradiance is always SH-synthesized (below).
const ENV_MAP_URL = './env_maps/standard_shader_ball_env_512.exr';

// Load the environment ONCE and reuse across previews. Resolves to
// { radiance, irradiance, mips } or null if no file is present, in
// which case the caller uses the synthesized makeEnvTexture sky.
let envPromise = null;
// Session-wide user-imported environment override: when set, every
// newly-created render view uses this instead of getEnvironment().
// null = no override; getEnvironment() itself stays the Reset target.
let envOverride = null;
// Auto key-light extraction toggle (env dialog UI). Persisted; default on.
const KEYLIGHT_STORAGE_KEY = 'mtlx_env_keylight';
let keyLightEnabled = true;
try {
  const saved = localStorage.getItem(KEYLIGHT_STORAGE_KEY);
  if (saved !== null) keyLightEnabled = saved !== '0';
} catch (e) {/* localStorage unavailable — default stays on */}
// Pristine (pre-extraction) bytes behind the default/override env, so
// the toggle can re-parse + rebuild without a re-fetch/re-drop.
let defaultEnvSource = null,
  overrideEnvSource = null;
// Registry of live render-view handles, so environment imports/resets
// broadcast to EVERY live view, not just the visible one — otherwise a
// hidden keep-alive view keeps its stale baked-in environment.
const LIVE_VIEWS = new Set();
// ---- Environment preparation: OFFICIAL VIEWER PARITY ----
// Conventions (see also makeBackgroundTexture, shIrradianceFromEquirect,
// BG_BASE/BG_SIGN): MaterialX latlong has v=0 at +Y (u=atan2(x,-z)/2PI+0.5);
// three's SphereGeometry/equirectUv put +Y at the OPPOSITE end of V, so a
// three-sampled texture always needs the opposite flipY of a MaterialX-
// sampled one. EXR decodes rows bottom-first, RGBE top-first —
// parseEnvBuffer normalizes both via flipY. Mips are essential (FIS
// specular LOD) — padToRGBA fixes RGBELoader's un-mippable RGB16F while preserving flipY.
const padToRGBA = tex => {
  const img = tex.image;
  if (!img || !img.data) return tex;
  const n = img.width * img.height;
  if (img.data.length >= n * 4) return tex; // already RGBA
  const C = img.data.constructor;
  const out = new C(n * 4);
  const one = C === Uint16Array ? 0x3C00 /* half 1.0 */ : 1.0;
  for (let i = 0; i < n; i++) {
    out[i * 4] = img.data[i * 3];
    out[i * 4 + 1] = img.data[i * 3 + 1];
    out[i * 4 + 2] = img.data[i * 3 + 2];
    out[i * 4 + 3] = one;
  }
  const t = new THREE.DataTexture(out, img.width, img.height, THREE.RGBAFormat, tex.type);
  t.flipY = tex.flipY;
  return t;
};
const prepareEnv = tex => {
  const t = padToRGBA(tex);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8; // three clamps to the device max at upload
  t.encoding = THREE.LinearEncoding;
  t.needsUpdate = true;
  return t;
};
// Builds the skybox mesh's visible backdrop from a prepared radiance
// texture — separate from the IBL sampler because MaterialX and three's
// sphere put +Y at opposite ends of V (env-prep header): inverse flipY.
const makeBackgroundTexture = src => {
  const img = src.image;
  const bg = new THREE.DataTexture(img.data, img.width, img.height, src.format, src.type);
  bg.flipY = !src.flipY; // skybox sphere needs the opposite V orientation of the IBL texture
  bg.mapping = THREE.EquirectangularReflectionMapping;
  bg.wrapS = THREE.RepeatWrapping;
  bg.wrapT = THREE.ClampToEdgeWrapping;
  // Sampled directly by the skybox mesh — no mip chain needed.
  bg.minFilter = THREE.LinearFilter;
  bg.magFilter = THREE.LinearFilter;
  bg.generateMipmaps = false;
  bg.encoding = src.encoding;
  bg.needsUpdate = true;
  return bg;
};
// IEEE-754 float32 → float16 (for building half-float DataTextures).
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
const floatToHalf = val => {
  _f32[0] = val;
  const x = _u32[0];
  const sign = x >> 16 & 0x8000;
  const exp = (x >> 23 & 0xFF) - 127 + 15;
  if (exp <= 0) return sign; // underflow → signed 0
  if (exp >= 31) return sign | 0x7BFF; // clamp to max half
  return sign | exp << 10 | (x & 0x7FFFFF) >> 13;
};
const halfToFloat = h => {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = h >> 10 & 0x1F;
  const frac = h & 0x3FF;
  if (exp === 0) return sign * frac * Math.pow(2, -24);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * Math.pow(2, exp - 15);
};
// True SH (l<=2) cosine-convolution irradiance (Ramamoorthi & Hanrahan
// 2001). Convention-preserving: output rows keep the input's row<->
// latitude mapping, so the result uploads with the source's flipY.
const shIrradianceFromEquirect = tex => {
  try {
    const srcImg = tex.image;
    const srcStride = srcImg.data.length / (srcImg.width * srcImg.height); // 3 or 4
    const srcIsHalf = srcImg.data.constructor === Uint16Array;
    const readPx = idx => [srcIsHalf ? halfToFloat(srcImg.data[idx]) : srcImg.data[idx], srcIsHalf ? halfToFloat(srcImg.data[idx + 1]) : srcImg.data[idx + 1], srcIsHalf ? halfToFloat(srcImg.data[idx + 2]) : srcImg.data[idx + 2]];
    // Pass 0: pre-downsample box-average to a float buffer, capping
    // the Pass 1 projection loop below at <=128x64 texels regardless
    // of source size.
    let W = srcImg.width,
      H = srcImg.height,
      get;
    if (W > 128 || H > 64) {
      const dW = Math.min(W, 128),
        dH = Math.min(H, 64);
      const bx = Math.max(1, Math.floor(W / dW));
      const by = Math.max(1, Math.floor(H / dH));
      const buf = new Float32Array(dW * dH * 3);
      for (let y = 0; y < dH; y++) {
        for (let x = 0; x < dW; x++) {
          let r = 0,
            g = 0,
            b = 0,
            cnt = 0;
          for (let oy = 0; oy < by; oy++) {
            for (let ox = 0; ox < bx; ox++) {
              const spx = x * bx + ox,
                spy = y * by + oy;
              if (spx >= W || spy >= H) continue;
              const px = readPx((spy * W + spx) * srcStride);
              r += px[0];
              g += px[1];
              b += px[2];
              cnt++;
            }
          }
          const o = (y * dW + x) * 3;
          buf[o] = r / cnt;
          buf[o + 1] = g / cnt;
          buf[o + 2] = b / cnt;
        }
      }
      W = dW;
      H = dH;
      get = (x, y) => {
        const o = (y * W + x) * 3;
        return [buf[o], buf[o + 1], buf[o + 2]];
      };
    } else {
      get = (x, y) => readPx((y * W + x) * srcStride);
    }
    // Pass 1: project radiance onto the 9 SH basis functions,
    // weighted by each texel's differential solid angle
    // dOmega = (2*PI/W)*(PI/H)*sin(theta) (texels shrink toward poles).
    const c = new Float64Array(9 * 3); // [coef*3 + channel], RGB per coefficient
    for (let y = 0; y < H; y++) {
      const theta = Math.PI * (y + 0.5) / H;
      const sinT = Math.sin(theta),
        cosT = Math.cos(theta);
      const dOmega = 2 * Math.PI / W * (Math.PI / H) * sinT;
      for (let x = 0; x < W; x++) {
        const phi = 2 * Math.PI * (x + 0.5) / W;
        const sx = sinT * Math.cos(phi),
          sy = cosT,
          sz = sinT * Math.sin(phi);
        const [r, g, b] = get(x, y);
        const Y = [0.282095,
        // Y00
        0.488603 * sz,
        // Y1-1
        0.488603 * sy,
        // Y10  (sy = up axis)
        0.488603 * sx,
        // Y11
        1.092548 * sx * sz,
        // Y2-2
        1.092548 * sz * sy,
        // Y2-1
        1.092548 * sx * sy,
        // Y21
        0.315392 * (3 * sy * sy - 1),
        // Y20
        0.546274 * (sx * sx - sz * sz) // Y22
        ];
        for (let i = 0; i < 9; i++) {
          const yw = Y[i] * dOmega;
          c[i * 3] += r * yw;
          c[i * 3 + 1] += g * yw;
          c[i * 3 + 2] += b * yw;
        }
      }
    }
    // Pass 2: evaluate cosine-convolved irradiance per output texel
    // using the Ramamoorthi-Hanrahan cosine-lobe coefficients, scaled
    // by 1/PI to match mx_environment_irradiance's expected units.
    const OW = 64,
      OH = 32;
    const A0 = Math.PI,
      A1 = 2 * Math.PI / 3,
      A2 = Math.PI / 4;
    const A = [A0, A1, A1, A1, A2, A2, A2, A2, A2];
    const out = new Uint16Array(OW * OH * 4);
    for (let y = 0; y < OH; y++) {
      const theta = Math.PI * (y + 0.5) / OH;
      const sinT = Math.sin(theta),
        cosT = Math.cos(theta);
      for (let x = 0; x < OW; x++) {
        const phi = 2 * Math.PI * (x + 0.5) / OW;
        const sx = sinT * Math.cos(phi),
          sy = cosT,
          sz = sinT * Math.sin(phi);
        const Y = [0.282095, 0.488603 * sz, 0.488603 * sy, 0.488603 * sx, 1.092548 * sx * sz, 1.092548 * sz * sy, 1.092548 * sx * sy, 0.315392 * (3 * sy * sy - 1), 0.546274 * (sx * sx - sz * sz)];
        let r = 0,
          g = 0,
          b = 0;
        for (let i = 0; i < 9; i++) {
          const aw = A[i] * Y[i];
          r += aw * c[i * 3];
          g += aw * c[i * 3 + 1];
          b += aw * c[i * 3 + 2];
        }
        r = Math.max(0, r / Math.PI);
        g = Math.max(0, g / Math.PI);
        b = Math.max(0, b / Math.PI);
        const o = (y * OW + x) * 4;
        out[o] = floatToHalf(r);
        out[o + 1] = floatToHalf(g);
        out[o + 2] = floatToHalf(b);
        out[o + 3] = 0x3C00; // half 1.0 — alpha unused by the IBL sampler
      }
    }
    // Row↔latitude convention mirrors the input, so upload with the
    // same flipY as the source texture.
    const out_tex = new THREE.DataTexture(out, OW, OH, THREE.RGBAFormat, THREE.HalfFloatType);
    out_tex.flipY = tex.flipY;
    return out_tex;
  } catch (e) {
    console.warn('SH irradiance projection failed:', e);
    return null;
  }
};
// Parses a raw environment ArrayBuffer into a bare DataTexture, shared
// by getEnvironment() and loadEnvironmentFromFile — one parser for both
// formats. Returns null on failure; callers decide how to surface it.
const parseEnvBuffer = (buf, ext) => {
  try {
    if (ext === '.hdr') {
      if (typeof THREE.RGBELoader === 'undefined') return null;
      // r128's RGBELoader defaults to UnsignedByteType (RGBE-
      // encoded data only built-in materials can decode);
      // HalfFloatType makes it decode to linear float at parse.
      const d = new THREE.RGBELoader().setDataType(THREE.HalfFloatType).parse(buf);
      if (!d || !d.data) return null;
      const tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
      // RGBELoader keeps rows top-first, which already matches
      // MaterialX's v=0-at-top — no flip.
      tex.flipY = false;
      return tex;
    }
    if (ext === '.exr') {
      if (typeof THREE.EXRLoader === 'undefined') return null;
      // HalfFloatType, not FloatType (unlike loadExrTexture's
      // sampler use above): RGBA16F is core mip-able on WebGL2,
      // while RGBA32F needs optional extensions.
      const d = new THREE.EXRLoader().setDataType(THREE.HalfFloatType).parse(buf);
      if (!d || !d.data) return null;
      const tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
      // EXRLoader flips rows at decode (data row 0 = image bottom),
      // so flip at upload to restore MaterialX's v=0-at-top.
      tex.flipY = true;
      return tex;
    }
    return null; // unrecognized extension
  } catch (e) {
    return null;
  }
};
// ---- Automatic key-light extraction ----
// FIS specular IBL (16 samples, mip LOD) can't reproduce a crisp
// highlight from a tiny ultra-bright sun — it just blurs it. Official
// MaterialX HDRIs solve this offline with a "split" asset: sun removed
// from the image + a companion analytic directional_light. This
// reproduces that automatically for any loaded environment.
const KEYLIGHT_MIN_CONTRAST = 64;
const KEYLIGHT_RADIUS_RAD = 0.10;
const extractKeyLight = tex => {
  try {
    const img = tex.image;
    const W = img.width,
      H = img.height;
    const stride = img.data.length / (W * H);
    const isHalf = img.data.constructor === Uint16Array;
    const rd = i => isHalf ? halfToFloat(img.data[i]) : img.data[i];
    const wr = (i, v) => {
      img.data[i] = isHalf ? floatToHalf(v) : v;
    };

    // Pass 1: per-texel luminance + solid-angle weight -> mean + peak.
    const lum = new Float32Array(W * H);
    let sumW = 0,
      sumLW = 0,
      peakL = -1,
      peakX = 0,
      peakY = 0;
    for (let y = 0; y < H; y++) {
      const theta = Math.PI * (y + 0.5) / H;
      const dOmega = Math.sin(theta) * (2 * Math.PI / W) * (Math.PI / H);
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * stride;
        const L = 0.2126 * rd(idx) + 0.7152 * rd(idx + 1) + 0.0722 * rd(idx + 2);
        lum[y * W + x] = L;
        sumW += dOmega;
        sumLW += L * dOmega;
        if (L > peakL) {
          peakL = L;
          peakX = x;
          peakY = y;
        }
      }
    }
    const meanL = sumW > 0 ? sumLW / sumW : 0;
    if (!(peakL >= KEYLIGHT_MIN_CONTRAST * Math.max(meanL, 1e-6))) return null; // no sun-like source

    // Peak direction (data space), used below for angular clustering.
    const pTheta = Math.PI * (peakY + 0.5) / H,
      pPhi = 2 * Math.PI * (peakX + 0.5) / W;
    const pDir = [Math.sin(pTheta) * Math.cos(pPhi), Math.cos(pTheta), Math.sin(pTheta) * Math.sin(pPhi)];

    // Pass 2: cluster around the peak (angle + luminance-floor gated),
    // accumulating per-channel energy + an L*dOmega-weighted centroid;
    // also averages the surrounding annulus color, used by the clamp below.
    const Lfloor = Math.max(8 * meanL, 0.02 * peakL);
    let Er = 0,
      Eg = 0,
      Eb = 0,
      cxW = 0,
      cyW = 0,
      cW = 0;
    let annR = 0,
      annG = 0,
      annB = 0,
      annN = 0;
    const clusterIdx = [];
    for (let y = 0; y < H; y++) {
      const theta = Math.PI * (y + 0.5) / H;
      const dOmega = Math.sin(theta) * (2 * Math.PI / W) * (Math.PI / H);
      const sinT = Math.sin(theta),
        cosT = Math.cos(theta);
      for (let x = 0; x < W; x++) {
        const phi = 2 * Math.PI * (x + 0.5) / W;
        const dx = sinT * Math.cos(phi),
          dy = cosT,
          dz = sinT * Math.sin(phi);
        const cosAng = dx * pDir[0] + dy * pDir[1] + dz * pDir[2];
        const ang = Math.acos(Math.min(1, Math.max(-1, cosAng)));
        const idx = (y * W + x) * stride;
        const L = lum[y * W + x];
        if (ang <= KEYLIGHT_RADIUS_RAD && L >= Lfloor) {
          const r = rd(idx),
            g = rd(idx + 1),
            b = rd(idx + 2);
          Er += r * dOmega;
          Eg += g * dOmega;
          Eb += b * dOmega;
          cxW += x * (L * dOmega);
          cyW += y * (L * dOmega);
          cW += L * dOmega;
          clusterIdx.push(idx);
        } else if (ang > KEYLIGHT_RADIUS_RAD && ang <= 2 * KEYLIGHT_RADIUS_RAD) {
          annR += rd(idx);
          annG += rd(idx + 1);
          annB += rd(idx + 2);
          annN++;
        }
      }
    }
    if (!clusterIdx.length || cW <= 0) return null;
    const cx = cxW / cW,
      cy = cyW / cW;

    // Direction: data-coord centroid -> world. gamma already absorbs
    // u_envMatrix's +90deg base — do NOT also apply the rig's RotY.
    const U = (cx + 0.5) / W;
    const gamma = 2 * Math.PI * U - Math.PI;
    const vRow = tex.flipY ? H - 1 - cy : cy;
    const thetaV = Math.PI * (vRow + 0.5) / H;
    const sinV = Math.sin(thetaV),
      cosV = Math.cos(thetaV);
    // MaterialX directional lights store the direction light TRAVELS
    // (light -> scene), so negate the computed direction-TO-light.
    const direction = new THREE.Vector3(sinV * Math.cos(gamma), cosV, sinV * Math.sin(gamma)).negate();

    // Clamp: overwrite the cluster with the annulus's mean color — the
    // "split" that removes the sun from radiance/irradiance/backdrop.
    const aN = annN || 1;
    const annColor = [annR / aN, annG / aN, annB / aN];
    for (const idx of clusterIdx) {
      wr(idx, annColor[0]);
      wr(idx + 1, annColor[1]);
      wr(idx + 2, annColor[2]);
    }
    const maxE = Math.max(Er, Eg, Eb, 1e-8);
    return {
      direction,
      color: [Er / maxE, Eg / maxE, Eb / maxE],
      intensity: maxE
    };
  } catch (e) {
    console.warn('key-light extraction failed:', e);
    return null;
  }
};
// Rotates the extracted key light to track env rotation (rig lights are
// historically fixed — only this one rotates). RotY(-rad): env content
// shifts by +rad, so the light direction shifts by -rad to match.
const keyLightRotationMatrix = rad => new THREE.Matrix4().makeRotationY(-rad);
// Rig lights (fixed) + the active env's extracted key light (rotates
// live), padded to a FIXED length (rig.length + 1) for u_lightData —
// the array length must never change after a program's first bind.
const currentLights = (rigLights, keyLight, rotRad) => {
  const out = (rigLights || []).map(l => ({
    type: l.type,
    direction: l.direction.clone(),
    color: l.color.clone(),
    intensity: l.intensity
  }));
  if (keyLight) {
    out.push({
      type: 1,
      direction: keyLight.direction.clone().applyMatrix4(keyLightRotationMatrix(rotRad || 0)),
      color: new THREE.Vector3(keyLight.color[0], keyLight.color[1], keyLight.color[2]),
      intensity: keyLight.intensity
    });
  } else {
    out.push({
      type: 1,
      direction: new THREE.Vector3(0, -1, 0),
      color: new THREE.Vector3(0, 0, 0),
      intensity: 0
    });
  }
  return out;
};
// Live-updates ONLY the key-light slot (last entry) of an already-bound
// u_lightData array in place — mutates values, never replaces the
// array/uniform object (three r128 caches the struct-array layout).
const updateKeyLightUniformEntry = (uniforms, rigCount, keyLight, rotRad) => {
  const entry = uniforms && uniforms.u_lightData && uniforms.u_lightData.value && uniforms.u_lightData.value[rigCount];
  if (!entry) return;
  if (keyLight) {
    entry.direction.copy(keyLight.direction).applyMatrix4(keyLightRotationMatrix(rotRad || 0));
    entry.color.set(keyLight.color[0], keyLight.color[1], keyLight.color[2]);
    entry.intensity = keyLight.intensity;
  } else {
    entry.direction.set(0, -1, 0);
    entry.color.set(0, 0, 0);
    entry.intensity = 0;
  }
  if (uniforms.u_numActiveLightSources) uniforms.u_numActiveLightSources.value = rigCount + (keyLight ? 1 : 0);
};
// Builds the full { radiance, irradiance, mips, background,
// prefilteredIrr, keyLight } shape from a raw parseEnvBuffer() result —
// shared by getEnvironment() and loadEnvironmentFromFile.
const buildEnvFromParsedTexture = raw => {
  // Extraction mutates raw's pixels (clamps the sun) BEFORE mips/SH/
  // background are built below, so it disappears from all three —
  // matching official "split" env assets.
  const keyLight = keyLightEnabled ? extractKeyLight(raw) : null;
  const radiance = prepareEnv(raw);
  const irrSrc = shIrradianceFromEquirect(raw);
  const irradiance = irrSrc ? prepareEnv(irrSrc) : radiance;
  const img = radiance.image;
  const mips = Math.trunc(Math.log2(Math.max(img.width, img.height))) + 1;
  // Correctly-oriented copy for the visible skybox mesh — see
  // makeBackgroundTexture and the env-prep header above.
  const background = makeBackgroundTexture(radiance);
  return {
    radiance,
    irradiance,
    mips,
    background,
    prefilteredIrr: false,
    keyLight
  };
};
const getEnvironment = () => {
  if (!envPromise) {
    // fetch() -> ArrayBuffer -> parseEnvBuffer, mirroring
    // loadEnvironmentFromFile's path (same helper, different byte
    // source). Any failure resolves null; this promise never rejects.
    const ext = ENV_MAP_URL.slice(ENV_MAP_URL.lastIndexOf('.')).toLowerCase();
    envPromise = fetch(ENV_MAP_URL).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null).then(buf => {
      if (!buf) return null; // no file / fetch failed → synthesized sky
      const raw = parseEnvBuffer(buf, ext);
      if (!raw || !raw.image || !raw.image.data) return null; // parse failed → synthesized sky
      defaultEnvSource = {
        buf,
        ext
      }; // pristine bytes, for the key-light toggle rebuild
      return buildEnvFromParsedTexture(raw);
    });
  }
  return envPromise;
};

// Loads a user-dropped environment file into the same shape
// getEnvironment() returns, reusing its parse/build helpers. Unlike
// getEnvironment(), throws on failure instead of a silent fallback.
const loadEnvironmentFromFile = async file => {
  const name = (file && file.name || '').toLowerCase();
  const ext = name.slice(name.lastIndexOf('.'));
  if (ext !== '.hdr' && ext !== '.exr') {
    throw new Error('Unsupported environment file "' + (file && file.name) + '" — expected .hdr or .exr.');
  }
  // Loader-presence checks run BEFORE parseEnvBuffer purely so the
  // dialog can report which specific script is missing — parseEnvBuffer
  // itself just returns null on this, with no message.
  if (ext === '.hdr' && typeof THREE.RGBELoader === 'undefined') {
    throw new Error('RGBELoader unavailable (script blocked/offline) — cannot load .hdr environments.');
  }
  if (ext === '.exr' && typeof THREE.EXRLoader === 'undefined') {
    throw new Error('EXRLoader unavailable (script blocked/offline) — cannot load .exr environments.');
  }
  const buf = await file.arrayBuffer();
  const raw = parseEnvBuffer(buf, ext);
  if (!raw || !raw.image || !raw.image.data) {
    throw new Error('Failed to parse the environment image "' + (file && file.name) + '".');
  }
  overrideEnvSource = {
    buf,
    ext
  }; // pristine bytes, for the key-light toggle rebuild
  return buildEnvFromParsedTexture(raw);
};

// Set/clear the session-wide environment override. null clears it
// (Reset) — new views fall back to getEnvironment(). Also broadcasts to
// every live view (LIVE_VIEWS) so hidden keep-alive views update too.
const setEnvOverride = env => {
  envOverride = env || null;
  if (envOverride) {
    // Import: apply the new environment to every live view right away.
    LIVE_VIEWS.forEach(v => {
      try {
        v.setEnvironment(envOverride);
      } catch (e) {/* view has no lighting/env — no-op */}
    });
  } else {
    // Reset: fall back to the default environment, but re-check
    // envOverride once it resolves — a newer import that landed while
    // this was in flight must win over the stale reset.
    getEnvironment().then(def => {
      if (!envOverride) {
        LIVE_VIEWS.forEach(v => {
          try {
            v.setEnvironment(def);
          } catch (e) {/* view has no lighting/env — no-op */}
        });
      }
    });
  }
};
const getEnvOverride = () => envOverride;

// Key-light toggle (UI-facing): rebuilds the ACTIVE env from its cached
// pristine bytes with extraction on/off, then rebroadcasts it — reusing
// setEnvOverride for an active import, or the memoized envPromise +
// LIVE_VIEWS broadcast for the default env.
const getKeyLightEnabled = () => keyLightEnabled;
const setKeyLightEnabled = on => {
  keyLightEnabled = !!on;
  try {
    localStorage.setItem(KEYLIGHT_STORAGE_KEY, keyLightEnabled ? '1' : '0');
  } catch (e) {/* unavailable */}
  const src = envOverride ? overrideEnvSource : defaultEnvSource;
  if (!src) return; // nothing loaded yet — the next load already honors the flag
  const raw = parseEnvBuffer(src.buf, src.ext);
  if (!raw || !raw.image || !raw.image.data) return;
  const rebuilt = buildEnvFromParsedTexture(raw);
  if (envOverride) {
    setEnvOverride(rebuilt); // re-broadcasts via each view's setEnvironment()
  } else {
    envPromise = Promise.resolve(rebuilt);
    LIVE_VIEWS.forEach(v => {
      try {
        v.setEnvironment(rebuilt);
      } catch (e) {/* view has no lighting/env — no-op */}
    });
  }
};

// Standard MaterialX color spaces accepted on filename inputs. Changing
// one is a CODEGEN decision (the CMS inserts the shader transform), so
// the picker goes through the regen override path, not a uniform.
const COLORSPACES = ['srgb_texture', 'lin_rec709', 'g22_rec709', 'g18_rec709', 'acescg', 'lin_ap1', 'srgb_displayp3', 'lin_displayp3', 'adobergb', 'lin_adobergb', 'none'];

// One persistent hidden WebGL2 context, created lazily and never
// disposed, used ONLY to pre-warm driver shader compiles — a compile
// here makes the display context's later compile a fast driver cache hit.
let MTLX_WARM_CTX = null;
const getWarmContext = () => {
  if (MTLX_WARM_CTX !== null) return MTLX_WARM_CTX;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext('webgl2');
    const ext = gl && gl.getExtension('KHR_parallel_shader_compile');
    MTLX_WARM_CTX = gl && ext ? {
      gl,
      ext
    } : false;
  } catch (e) {
    MTLX_WARM_CTX = false;
  }
  return MTLX_WARM_CTX;
};

// Shader sources already pre-warmed this session — repeating would only
// add pointless background wait. Keyed by a fast djb2 hash; collisions
// are harmless (worst case, one un-warmed sync compile).
const MTLX_WARMED_SOURCES = new Set();
// Deliberately no size gate: standard_surface/OpenPBR previews run
// ~80-106 KB, and skipping pre-warm above some cutoff would freeze the UI 2.5-2.9s synchronously.
const warmKey = (vs, fs) => {
  let h = 5381;
  const s = vs + ' ' + fs;
  for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0;
  return s.length + ':' + h;
};

// Pre-compiles vs/fs on the hidden warm context; never throws. The
// submitted source must match byte-for-byte what three.js's WebGLProgram
// submits for display, or the driver cache misses (harmless, no speed win).
const prewarmShaderCompile = async ({
  vs,
  fs,
  isMounted,
  label
}) => {
  const ctx = getWarmContext();
  if (!ctx) return 'skipped';
  const key = warmKey(vs, fs);
  if (MTLX_WARMED_SOURCES.has(key)) {
    if (window.MTLX_PERF_LOG) {
      console.log('[mtlx-perf] GL prewarm skipped — source already warmed this session (target: ' + label + ')');
    }
    return 'skipped';
  }
  const {
    gl,
    ext
  } = ctx;
  const __warmPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
  let warmProgram = null,
    warmVShader = null,
    warmFShader = null;
  try {
    warmVShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(warmVShader, '#version 300 es\n' + vs);
    gl.compileShader(warmVShader);
    warmFShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(warmFShader, '#version 300 es\n' + fs);
    gl.compileShader(warmFShader);
    warmProgram = gl.createProgram();
    gl.attachShader(warmProgram, warmVShader);
    gl.attachShader(warmProgram, warmFShader);
    gl.linkProgram(warmProgram);
  } catch (e) {
    // Defensive only: any failure here just skips the warm-up — falls
    // through to today's (unwarmed) compile behavior.
    try {
      if (warmProgram) gl.deleteProgram(warmProgram);
    } catch (e2) {/* context lost etc. */}
    try {
      if (warmVShader) gl.deleteShader(warmVShader);
    } catch (e2) {/* ditto */}
    try {
      if (warmFShader) gl.deleteShader(warmFShader);
    } catch (e2) {/* ditto */}
    return 'skipped';
  }
  if (window.MTLX_PERF_LOG) {
    console.log('[mtlx-perf] GL compile submit: ' + (performance.now() - __warmPerfStart).toFixed(1) + 'ms (target: ' + label + ')');
  }
  const cleanup = () => {
    try {
      if (warmProgram) gl.deleteProgram(warmProgram);
    } catch (e) {/* context lost etc. */}
    try {
      if (warmVShader) gl.deleteShader(warmVShader);
    } catch (e) {/* ditto */}
    try {
      if (warmFShader) gl.deleteShader(warmFShader);
    } catch (e) {/* ditto */}
  };
  const WAIT_POLL_MS = 50,
    WAIT_POLL_FAST_MS = 16,
    WAIT_POLL_FAST_TICKS = 6,
    WAIT_TIMEOUT_MS = 15000;
  const __waitStart = performance.now();
  let timedOut = false;

  // isProgram() is the silent validity check: false for a
  // deleted/invalid handle WITHOUT a GL error (unlike getProgramParameter,
  // which logs "GL_INVALID_VALUE" once per pre-warm on Chrome).
  const isWarmDone = () => {
    try {
      if (gl.isContextLost()) return true;
      if (!gl.isProgram(warmProgram)) return true;
      const v = gl.getProgramParameter(warmProgram, ext.COMPLETION_STATUS_KHR);
      // A GL error (invalid/deleted program) returns null WITHOUT
      // throwing — treat it as "nothing left to wait for" instead
      // of polling (and console-spamming) until the timeout cap.
      return v === null ? true : !!v;
    } catch (e) {
      // Disposed/invalid handle — nothing left to wait for.
      return true;
    }
  };

  // Check once immediately, before the first sleep — a fast background
  // compile may already be done before we'd otherwise pay a single poll
  // tick of latency.
  let tick = 0;
  for (;;) {
    if (isWarmDone()) break;
    // Safety cap: on timeout, stop polling and proceed — the real
    // compile then blocks for whatever time remains, so this is
    // never WORSE than not pre-warming, only equal or better.
    if (performance.now() - __waitStart > WAIT_TIMEOUT_MS) {
      timedOut = true;
      break;
    }
    // Escalating poll interval: fast compiles resolve within about a
    // frame, so the first ~6 ticks poll at 16ms; the 50ms tick only
    // matters for multi-second compiles.
    const pollMs = tick < WAIT_POLL_FAST_TICKS ? WAIT_POLL_FAST_MS : WAIT_POLL_MS;
    tick++;
    await new Promise(resolve => setTimeout(resolve, pollMs));
    // Lifecycle bail: a superseded build must stop and clean up rather
    // than keep polling GL objects for a view nobody wants.
    if (!isMounted()) {
      cleanup();
      return 'bailed';
    }
  }
  if (window.MTLX_PERF_LOG) {
    console.log('[mtlx-perf] GL compile wait: ' + (performance.now() - __waitStart).toFixed(1) + 'ms (target: ' + label + ')');
  }
  if (!timedOut) MTLX_WARMED_SOURCES.add(key);
  cleanup();
  return 'done';
};

// Background driver pre-warm for an off-screen preview target — builds,
// generates, and pre-compiles inside ONE mxExclusive hold (so a transient
// __pv_* wrapper is never observable by a concurrent op). NEVER call from
// inside an existing mxExclusive (deadlock).
const prewarmPreviewTarget = async ({
  mx,
  gen,
  genContext,
  buildRenderable,
  label,
  isMounted = () => true
}) => {
  // No warm context (no WebGL2 / no KHR_parallel_shader_compile) means
  // generating sources here would only be thrown away — skip the work.
  if (!getWarmContext()) return 'skipped';
  let srcs = null;
  try {
    srcs = await mxExclusive(() => {
      const built = buildRenderable();
      if (!built || !built.renderable) return null;
      try {
        return generatePreviewSourcesUnlocked({
          mx,
          gen,
          genContext,
          renderable: built.renderable,
          label,
          isMounted
        });
      } finally {
        // Best-effort, ALWAYS: the transient __pv_* wrappers must
        // never survive past this hold (same single-hold rule) —
        // including when generation itself threw.
        try {
          built.cleanup();
        } catch (e) {/* best-effort */}
      }
    });
  } catch (e) {
    // Silent by design (see the doc comment above): a generation
    // failure for an idle-warm target must never bubble up.
    return 'failed';
  }
  if (!srcs || !isMounted()) return 'bailed';
  return prewarmShaderCompile({
    vs: srcs.vs,
    fs: srcs.fs,
    isMounted,
    label
  });
};

// ------------------------------------------------------------------
// checkTargetTransparency: fast-uniform-edit transparency re-check —
// same single-hold rule as prewarmPreviewTarget (build->read->
// cleanup in one mxExclusive hold; never call from inside one).
// ------------------------------------------------------------------
const checkTargetTransparency = async ({
  mx,
  gen,
  buildRenderable
}) => {
  try {
    return await mxExclusive(() => {
      const built = buildRenderable();
      if (!built || !built.renderable) return null;
      try {
        if (typeof mx.isTransparentSurface !== 'function') return null;
        return !!mx.isTransparentSurface(built.renderable, gen.getTarget());
      } catch (e) {
        return null;
      } finally {
        try {
          built.cleanup && built.cleanup();
        } catch (e) {/* best-effort */}
      }
    });
  } catch (e) {
    return null;
  }
};

// MaterialX reports an unresolved node by its INSTANCE name only ("could
// not find a nodedef for node 'x'"), which is a name the author invented.
// This adds the category, and whether that category exists here at all.
const describeUnresolvedNodes = renderable => {
  let doc = null;
  try {
    doc = renderable.getDocument();
  } catch (e) {
    return [];
  }
  if (!doc) return [];

  // Library-owned graphs carry a source URI; user-authored ones don't.
  // Without that filter this would walk the whole standard library.
  const nodes = [];
  try {
    nodes.push(...(doc.getNodes() || []));
  } catch (e) {/* keep going */}
  try {
    for (const g of doc.getNodeGraphs() || []) {
      if (g.getSourceUri && g.getSourceUri()) continue;
      nodes.push(...(g.getNodes() || []));
    }
  } catch (e) {/* keep going */}
  const out = [];
  for (const node of nodes) {
    try {
      if (node.getNodeDef()) continue;
    } catch (e) {/* unresolved counts as a finding */}
    let category = '';
    let known = false;
    try {
      category = node.getCategory() || '';
    } catch (e) {/* unnamed */}
    try {
      known = (doc.getMatchingNodeDefs(category) || []).length > 0;
    } catch (e) {/* assume not */}
    let name = '';
    try {
      name = node.getName() || '';
    } catch (e) {/* unnamed */}
    out.push({
      name,
      category,
      known
    });
  }
  return out;
};

// One sentence per unresolved node. `known` separates "this build has no
// such node type" from "it has the type, but not with these inputs",
// which is the difference between a typo and a version/signature problem.
const unresolvedNodesText = found => found.map(u => u.known ? `Node "${u.name}" (type "${u.category}") exists in this MaterialX build, but no definition matches its inputs.` : `Node "${u.name}" (type "${u.category}") has no definition in this MaterialX build.`).join(' ');

// ------------------------------------------------------------------
// generatePreviewSources: shader-generation slice of createMtlxRenderView,
// letting tryRefreshRenderView diff sources without a full rebuild.
// Frees mxShader before returning, so nothing holds a live wasm handle.
// ------------------------------------------------------------------
const generatePreviewSourcesUnlocked = ({
  mx,
  gen,
  genContext,
  renderable,
  label,
  isMounted = () => true
}) => {
  // OFFICIAL PARITY: per-material generation options on SHARED
  // module-scope genContext. hwTransparency is reset FIRST,
  // unconditionally — else a failed detection leaks A's stale value onto B.
  let transparent = false;
  try {
    genContext.getOptions().hwTransparency = false;
  } catch (e) {/* option absent */}
  try {
    if (typeof mx.isTransparentSurface === 'function') {
      const t = !!mx.isTransparentSurface(renderable, gen.getTarget());
      genContext.getOptions().hwTransparency = t;
      transparent = t; // set only after the option write succeeded
    }
  } catch (e) {
    transparent = false; /* reset above already put the option at the deterministic false default */
  }
  try {
    if (mx.ShaderInterfaceType) {
      genContext.getOptions().shaderInterfaceType = mx.ShaderInterfaceType.SHADER_INTERFACE_COMPLETE;
    }
  } catch (e) {/* default interface */}
  // Generated shaders use the generator's default FIS specular-
  // environment method. hwSpecularEnvironmentMethod is NOT settable
  // in this build — the embind setter rejects it. Don't retry.

  // Bail before the ~expensive shader-generation call if this
  // build was superseded (mounted flipped while awaiting above) —
  // nothing GL-side exists yet, so there's nothing to dispose.
  if (!isMounted()) return null;
  let mxShader;
  const __genPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
  try {
    mxShader = gen.generate('PreviewShader', renderable, genContext);
  } catch (genErr) {
    // Decode the REAL MaterialX error (Emscripten throws
    // numeric pointers) instead of a generic string, then name the
    // node types behind it, which MaterialX's own message omits.
    const detail = unresolvedNodesText(describeUnresolvedNodes(renderable));
    throw new Error(`Shader generation failed for "${label}": ${mxErr(mx, genErr)}` + (detail ? `. ${detail}` : ''));
  }
  if (window.MTLX_PERF_LOG) {
    console.log('[mtlx-perf] gen.generate: ' + (performance.now() - __genPerfStart).toFixed(1) + 'ms (target: ' + label + ')');
  }

  // Stage identifiers: some JS builds don't expose the mx.Stage enum
  // object ("Cannot read ... 'VERTEX'"). The underlying constants are
  // just the strings "vertex"/"pixel", which getSourceCode accepts.
  const VERTEX_STAGE = mx.Stage && mx.Stage.VERTEX || 'vertex';
  const PIXEL_STAGE = mx.Stage && mx.Stage.PIXEL || 'pixel';
  const vs = stripVersion(mxShader.getSourceCode(VERTEX_STAGE));
  // hwSrgbEncodeOutput=false means raw linear output, so encodeDisplay()'s
  // (runtime-gated) epilogue is injected below unless the FRAGMENT
  // OUTPUT's own assignment already encodes srgb — checking the whole
  // shader string false-positives.
  let fs = stripVersion(mxShader.getSourceCode(PIXEL_STAGE));
  fs = patchUnlitLightingRefs(fs);
  const outDeclMatch = fs.match(/\bout\s+vec4\s+(\w+)\s*;/);
  const outVar = outDeclMatch ? outDeclMatch[1] : null;
  const outAssignments = outVar ? fs.match(new RegExp('\\b' + outVar + '\\s*=[^;]*;', 'g')) : null;
  if (!outVar || !outAssignments || !outAssignments.length) {
    mtlxWarn(`mtlx-engine: could not locate the fragment output assignment for "${label}" — skipping encodeDisplay() as a fail-safe (cannot verify it's safe to inject ACES+sRGB without double-encoding).`);
  } else if (/srgb/i.test(outAssignments.join('\n'))) {
    // Self-encoding materials skip the epilogue entirely (no
    // u_peelLinear gate to attach to), so the linear peel/tail passes
    // treat their output as already display-encoded — a pre-existing
    // approximation, sharper now that peeling can otherwise be linear.
    mtlxWarn(`mtlx-engine: the fragment output assignment for "${label}" already calls an sRGB encode (despite hwSrgbEncodeOutput=false): skipping encodeDisplay() to avoid double-encoding (ACES tone mapping will NOT be applied to this material).`);
  } else {
    fs = encodeDisplay(fs);
  }
  // Folds transmission into peel-pass alpha; must precede injectPeelDiscard (see its u_peelMode guard).
  fs = patchTransmissionAlpha(fs);
  // Depth-peel machinery: baked into every fragment shader
  // UNCONDITIONALLY (not just when Force Transparency is on) — see
  // injectPeelDiscard's header comment above for why this keeps
  // toggling the setting a pure uniform flip (no regen/recompile) and
  // is a byte-for-byte no-op whenever u_peelMode is left at its default
  // 0 (the normal, non-peeling path).
  fs = injectPeelDiscard(fs);

  // Uniform introspection, still fully inside the mxExclusive lock:
  // plainizeMxUniformData converts every vector/matrix/color `data`
  // field to a plain, detached JS array before the lock can release.
  let introspected = [];
  for (const stageName of [VERTEX_STAGE, PIXEL_STAGE]) {
    let st = null;
    try {
      st = mxShader.getStage(stageName);
    } catch (e) {/* stage absent */}
    if (st) introspected = introspected.concat(collectMxUniforms(st));
  }
  introspected = introspected.map(plainizeMxUniformData);

  // Last reference to mxShader — free it here, still inside the lock.
  // Guarded: a BindingError here must never fail an otherwise-successful
  // generation. Loop-local `st` handles are left for FinalizationRegistry.
  try {
    mxShader.delete();
  } catch (e) {/* already deleted */}
  return {
    vs,
    fs,
    introspected,
    transparent
  };
};

// Public entry point: serializes generatePreviewSourcesUnlocked against
// the shared wasm heap. Callers must go through THIS wrapper, never call
// generatePreviewSourcesUnlocked directly, to avoid overlapping wasm ops.
const generatePreviewSources = (...args) => mxExclusive(() => generatePreviewSourcesUnlocked(...args));

// ------------------------------------------------------------------
// Shader EXPORT (vs. PREVIEW above): generates canonical, non-browser-
// adapted shader source in MaterialX's other target languages. Each
// target gets its own generator + GenContext — no light rig, no ACES/
// sRGB encode, and it intentionally differs from the preview shader.
// ------------------------------------------------------------------

// One row per selectable export target. `className` names the embind
// ShaderGenerator class (only Essl's .create() was exercised before
// this, so access below is guarded). `isHw` picks the hardware path.
const EXPORT_TARGETS = [{
  key: 'essl',
  label: 'GLSL ES (WebGL 2)',
  className: 'EsslShaderGenerator',
  isHw: true,
  ext: {
    vertex: '.vert',
    pixel: '.frag'
  }
}, {
  key: 'glsl',
  label: 'GLSL (desktop OpenGL)',
  className: 'GlslShaderGenerator',
  isHw: true,
  ext: {
    vertex: '.vert',
    pixel: '.frag'
  }
}, {
  key: 'vkglsl',
  label: 'GLSL (Vulkan)',
  className: 'VkShaderGenerator',
  isHw: true,
  ext: {
    vertex: '.vert',
    pixel: '.frag'
  }
}, {
  key: 'wgsl',
  label: 'WGSL (WebGPU)',
  className: 'WgslShaderGenerator',
  isHw: true,
  ext: {
    vertex: '.vert.wgsl',
    pixel: '.frag.wgsl'
  }
}, {
  key: 'msl',
  label: 'MSL (Metal)',
  className: 'MslShaderGenerator',
  isHw: true,
  ext: {
    vertex: '.vert.metal',
    pixel: '.frag.metal'
  }
}, {
  key: 'slang',
  label: 'Slang',
  className: 'SlangShaderGenerator',
  isHw: true,
  ext: {
    vertex: '.vert.slang',
    pixel: '.frag.slang'
  }
}, {
  key: 'osl',
  label: 'OSL (Open Shading Language)',
  className: 'OslShaderGenerator',
  isHw: false,
  ext: {
    pixel: '.osl'
  }
}, {
  key: 'mdl',
  label: 'MDL (NVIDIA)',
  className: 'MdlShaderGenerator',
  isHw: false,
  ext: {
    pixel: '.mdl'
  }
}];

// Per-target { gen, ctx } cache — building a GenContext + loading
// stdlib isn't free, so each target pays once, lazily. Failed targets
// are deliberately left OUT of the cache so a missing target can retry.
const EXPORT_GEN_CACHE = new Map();

// Resolves (lazily create + cache) the { gen, ctx } pair for one export
// target. Deliberately binds no light rig and starts from MaterialX's
// own defaults, not the preview genContext — exported code is canonical.
const getExportGen = (mx, target) => {
  const cached = EXPORT_GEN_CACHE.get(target.key);
  if (cached) return cached;
  const Cls = mx[target.className];
  if (!Cls || typeof Cls.create !== 'function') {
    throw new Error(target.label + ' is not available in this MaterialX build (' + target.className + ').');
  }
  const gen = Cls.create();
  const ctx = new mx.GenContext(gen);
  // Match the render context's file-texture V flip (see getMxEnv) so
  // exported shader source samples images the same way up.
  try {
    ctx.getOptions().fileTextureVerticalFlip = true;
  } catch (e) {/* option absent */}
  // loadStandardLibraries here only registers the source-code search
  // path on `ctx` — its returned stdlib document is discarded, since
  // callers' documents already carry the shared stdlib.
  mx.loadStandardLibraries(ctx);

  // Cache ONLY once every step above has succeeded — a target that
  // throws (missing class, libraries fail to load) stays retryable on
  // the next call instead of being permanently marked unavailable.
  const entry = {
    gen,
    ctx
  };
  EXPORT_GEN_CACHE.set(target.key, entry);
  return entry;
};

// Unlocked worker for shader EXPORT — see generateTargetSources for the
// public entry point; never call directly outside an mxExclusive hold.
// Skips preview transforms (stripVersion/encodeDisplay) — output is canonical.
const generateTargetSourcesUnlocked = ({
  mx,
  renderable,
  label,
  targetKey
}) => {
  const target = EXPORT_TARGETS.find(t => t.key === targetKey);
  if (!target) throw new Error('Unknown export target: ' + targetKey);
  let gen, ctx;
  try {
    ({
      gen,
      ctx
    } = getExportGen(mx, target));
  } catch (e) {
    throw new Error('Could not initialize the ' + target.label + ' generator: ' + mxErr(mx, e));
  }
  try {
    if (mx.ShaderInterfaceType) {
      ctx.getOptions().shaderInterfaceType = mx.ShaderInterfaceType.SHADER_INTERFACE_COMPLETE;
    }
  } catch (e) {/* default interface */}
  if (target.isHw) {
    try {
      if (typeof mx.isTransparentSurface === 'function') {
        ctx.getOptions().hwTransparency = mx.isTransparentSurface(renderable, gen.getTarget());
      }
    } catch (e) {/* keep previous value */}
  }
  let mxShader;
  try {
    mxShader = gen.generate('Shader', renderable, ctx);
  } catch (genErr) {
    throw new Error('Shader generation (' + target.label + ') failed for "' + label + '": ' + mxErr(mx, genErr));
  }

  // No stage-enumeration API exists — same fallback as the preview
  // path: some JS builds don't expose mx.Stage, but getSourceCode
  // accepts the "vertex"/"pixel" string constants directly.
  const VERTEX_STAGE = mx.Stage && mx.Stage.VERTEX || 'vertex';
  const PIXEL_STAGE = mx.Stage && mx.Stage.PIXEL || 'pixel';
  const read = st => {
    let code = null;
    try {
      code = mxShader.getSourceCode(st);
    } catch (e) {
      return null;
    }
    return code && code.trim() ? code : null;
  };
  const stages = [];
  const vertexCode = read(VERTEX_STAGE);
  if (vertexCode) stages.push({
    id: 'vertex',
    label: 'Vertex',
    code: vertexCode
  });
  const pixelCode = read(PIXEL_STAGE);
  if (pixelCode) stages.push({
    id: 'pixel',
    label: target.isHw ? 'Pixel' : 'Shader',
    code: pixelCode
  });

  // Last reference to mxShader — free it here, before the length check,
  // so the error path below frees it too. Guarded: see the identical
  // delete in generatePreviewSourcesUnlocked above.
  try {
    mxShader.delete();
  } catch (e) {/* already deleted */}
  if (!stages.length) {
    throw new Error(target.label + ' generation produced no source code for "' + label + '".');
  }
  return {
    stages
  };
};

// Public entry point for shader EXPORT: serializes
// generateTargetSourcesUnlocked against the shared wasm heap. NEVER
// call this from inside an existing mxExclusive callback (deadlock).
const generateTargetSources = args => mxExclusive(() => generateTargetSourcesUnlocked(args));

// ------------------------------------------------------------------
// applyIntrospectedUniformDefaults: uploads MaterialX's introspected
// defaults onto a three.js uniforms map. overwrite=false (view creation)
// skips explicit bindings and no-default entries; overwrite=true (fast-
// refresh) overwrites PublicUniforms only, in place — never PrivateUniforms.
// ------------------------------------------------------------------
const PREVIEW_TRANSFORM_UNIFORM_NAMES = new Set(['u_worldMatrix', 'u_viewProjectionMatrix', 'u_worldInverseTransposeMatrix', 'u_viewPosition']);
const applyIntrospectedUniformDefaults = (uniforms, introspected, {
  overwrite = false
} = {}) => {
  if (!overwrite) {
    for (const u of introspected) {
      if (uniforms[u.name] || u.data == null) continue; // explicit bindings win; no default → leave for WebGL 0
      const tu = mxValueToThreeUniform(u.type, u.data);
      if (tu) uniforms[u.name] = tu;
    }
    // A filename sampler with no image samples a 1x1 texture of the
    // node's `default` input; null (three's empty texture, so black)
    // only when codegen published no default for it.
    for (const u of introspected) {
      if (u.type === 'filename' && !uniforms[u.name]) {
        uniforms[u.name] = {
          value: getFilenameDefaultTexture(introspected, u.name)
        };
      }
    }
    return;
  }
  // Fast-refresh: same values just recomputed from a re-generated
  // (but byte-identical-source) shader — overwrite in place.
  for (const u of introspected) {
    // ONLY the public block: PrivateUniforms (transforms, env,
    // lights) was bound at creation and must never be clobbered —
    // some defaults are non-null (u_numActiveLightSources=0 kills lights).
    if (u.block !== 'PublicUniforms') continue;
    if (u.data == null) continue;
    if (u.type === 'filename') continue;
    // Belt-and-suspenders: the transforms are private-block (so the
    // block guard above already skips them), but they're the one
    // thing that would visibly break every frame if ever touched.
    if (PREVIEW_TRANSFORM_UNIFORM_NAMES.has(u.name)) continue;
    const tu = mxValueToThreeUniform(u.type, u.data);
    if (!tu) continue;
    if (uniforms[u.name]) uniforms[u.name].value = tu.value;else uniforms[u.name] = tu;
  }
  // Fast-refresh keeps the live sampler bindings, so a `default` that
  // changed has to re-bake its 1x1 texture here as well.
  for (const u of introspected) {
    if (u.type !== 'filename') continue;
    const slot = uniforms[u.name];
    if (!samplerHoldsDefault(slot)) continue;
    slot.value = getFilenameDefaultTexture(introspected, u.name);
  }
};

// ------------------------------------------------------------------
// tryRefreshRenderView — attempts a cheap in-place refresh of an
// existing view instead of a full rebuild: regenerates sources and, if
// byte-identical to the live view's, re-uploads only uniform defaults.
// Returns { refreshed, srcs } (srcs handed back so a real-mismatch
// caller doesn't need to regenerate again) or { refreshed: true }.
// ------------------------------------------------------------------
const tryRefreshRenderView = async ({
  view,
  mx,
  gen,
  genContext,
  renderable,
  label,
  isMounted = () => true
}) => {
  const __t = window.MTLX_PERF_LOG ? performance.now() : 0;
  let srcs;
  try {
    srcs = await generatePreviewSources({
      mx,
      gen,
      genContext,
      renderable,
      label,
      isMounted
    });
  } catch (e) {
    return {
      refreshed: false,
      srcs: null
    };
  }
  if (!srcs) return {
    refreshed: false,
    srcs: null
  };
  // Belt-and-suspenders: compare the transparency verdict explicitly
  // rather than relying on srcs.vs/fs alone. Gated on FORCE_TRANSPARENCY
  // — when off, a verdict flip is irrelevant and forcing rebuild is pointless.
  if (srcs.vs !== view.vs || srcs.fs !== view.fs || FORCE_TRANSPARENCY && !!srcs.transparent !== !!view.isTransparent) return {
    refreshed: false,
    srcs
  };

  // A filename value can change without the GLSL text changing, so
  // the vs/fs check above misses it — and empirically, rebinding a
  // texture onto a reused view does NOT render; force a full rebuild instead.
  const oldFilenames = new Map();
  for (const u of view.introspected || []) {
    if (u.type === 'filename') oldFilenames.set(u.name, u.data != null ? u.data : null);
  }
  const newFilenames = new Map();
  for (const u of srcs.introspected || []) {
    if (u.type === 'filename') newFilenames.set(u.name, u.data != null ? u.data : null);
  }
  const filenameNames = new Set([...oldFilenames.keys(), ...newFilenames.keys()]);
  for (const name of filenameNames) {
    const oldVal = oldFilenames.has(name) ? oldFilenames.get(name) : null;
    const newVal = newFilenames.has(name) ? newFilenames.get(name) : null;
    if (oldVal !== newVal) return {
      refreshed: false,
      srcs,
      texChange: true
    };
  }

  // Introspection happens inside generatePreviewSourcesUnlocked under
  // the same hold; this function performs no wasm reads.
  view.introspected = srcs.introspected;
  applyIntrospectedUniformDefaults(view.uniforms, srcs.introspected, {
    overwrite: true
  });
  if (window.MTLX_PERF_LOG) {
    console.log('[mtlx-perf] preview fast-refresh (source unchanged): ' + (performance.now() - __t).toFixed(1) + 'ms (target: ' + label + ')');
  }
  return {
    refreshed: true
  };
};

// ------------------------------------------------------------------
// createMtlxRenderView — persistent render-pipeline shell for one
// preview surface: renderer/scene/camera/env/geometry built ONCE;
// every edit calls applyMaterial() to swap materials on the SAME shell.
// ------------------------------------------------------------------
// Skybox <-> IBL rotation calibration — read at shell init (rotation 0
// there) and by setEnvRotation(). Derivation: u_envMatrix rotates env
// queries by RotationY(PI/2 + rad), and MaterialX's longitude is
// atan2(x,-z)/2PI + 0.5, so the IBL shows data column U at world angle
// 2PI*U - PI + rad; the mirrored sphere (phi = 2PI*uv.x) rotated by b
// shows column U at 2PI*U - b. Matching gives rotation.y = PI - rad.
// If the backdrop is 180 degrees out of phase, adjust BG_BASE; if it counter-rotates, flip BG_SIGN.
const BG_BASE = Math.PI;
const BG_SIGN = -1;

// Neutral-material env rotation: r128 lacks a scene.environment rotation knob (arrives r162+), so
// onBeforeCompile patches every neutral glTF material's shader to rotate its env queries via a live
// uEnvRotation uniform. The chunk is r128's own envmap_physical_pars_fragment plus exactly three
// lines: `uniform mat3 uEnvRotation;` and one `uEnvRotation *` rotation in each of
// getLightProbeIndirectIrradiance/Radiance, applied before every #ifdef branch. It's a bare
// RotationY(rad), not PI/2+rad like u_envMatrix, because MaterialX's longitude (atan2(x,-z)) leads
// three's equirectUv (atan2(z,x)) by +0.25 turn, cancelling u_envMatrix's own +90°. The two
// conventions still disagree VERTICALLY (three +Y at v=1, MaterialX v=0) — unaddressed here; see the PMREM comment in createMtlxRenderView.
const NEUTRAL_ENV_ROTATION_CHUNK = `#if defined( USE_ENVMAP )
	#ifdef ENVMAP_MODE_REFRACTION
		uniform float refractionRatio;
	#endif
	uniform mat3 uEnvRotation;
	vec3 getLightProbeIndirectIrradiance( const in GeometricContext geometry, const in int maxMIPLevel ) {
		vec3 worldNormal = inverseTransformDirection( geometry.normal, viewMatrix );
		worldNormal = uEnvRotation * worldNormal;
		#ifdef ENVMAP_TYPE_CUBE
			vec3 queryVec = vec3( flipEnvMap * worldNormal.x, worldNormal.yz );
			#ifdef TEXTURE_LOD_EXT
				vec4 envMapColor = textureCubeLodEXT( envMap, queryVec, float( maxMIPLevel ) );
			#else
				vec4 envMapColor = textureCube( envMap, queryVec, float( maxMIPLevel ) );
			#endif
			envMapColor.rgb = envMapTexelToLinear( envMapColor ).rgb;
		#elif defined( ENVMAP_TYPE_CUBE_UV )
			vec4 envMapColor = textureCubeUV( envMap, worldNormal, 1.0 );
		#else
			vec4 envMapColor = vec4( 0.0 );
		#endif
		return PI * envMapColor.rgb * envMapIntensity;
	}
	float getSpecularMIPLevel( const in float roughness, const in int maxMIPLevel ) {
		float maxMIPLevelScalar = float( maxMIPLevel );
		float sigma = PI * roughness * roughness / ( 1.0 + roughness );
		float desiredMIPLevel = maxMIPLevelScalar + log2( sigma );
		return clamp( desiredMIPLevel, 0.0, maxMIPLevelScalar );
	}
	vec3 getLightProbeIndirectRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in int maxMIPLevel ) {
		#ifdef ENVMAP_MODE_REFLECTION
			vec3 reflectVec = reflect( -viewDir, normal );
			reflectVec = normalize( mix( reflectVec, normal, roughness * roughness) );
		#else
			vec3 reflectVec = refract( -viewDir, normal, refractionRatio );
		#endif
		reflectVec = inverseTransformDirection( reflectVec, viewMatrix );
		reflectVec = uEnvRotation * reflectVec;
		float specularMIPLevel = getSpecularMIPLevel( roughness, maxMIPLevel );
		#ifdef ENVMAP_TYPE_CUBE
			vec3 queryReflectVec = vec3( flipEnvMap * reflectVec.x, reflectVec.yz );
			#ifdef TEXTURE_LOD_EXT
				vec4 envMapColor = textureCubeLodEXT( envMap, queryReflectVec, specularMIPLevel );
			#else
				vec4 envMapColor = textureCube( envMap, queryReflectVec, specularMIPLevel );
			#endif
			envMapColor.rgb = envMapTexelToLinear( envMapColor ).rgb;
		#elif defined( ENVMAP_TYPE_CUBE_UV )
			vec4 envMapColor = textureCubeUV( envMap, reflectVec, roughness );
		#endif
		return envMapColor.rgb * envMapIntensity;
	}
#endif`;
// ------------------------------------------------------------------

// Full-scene mode: the GLB's camera has a FIXED vertical FOV sized for
// its authored 16:9 aspect; a NARROWER canvas would crop the sides. Fix:
// widen the vertical fov to preserve the authored horizontal half-fov.
const effectiveFullSceneVFov = (authoredFovDeg, authoredAspect, canvasAspect) => {
  if (canvasAspect >= authoredAspect) return authoredFovDeg;
  const authoredHalfVFov = authoredFovDeg * Math.PI / 180 / 2;
  const authoredHalfHFov = Math.atan(Math.tan(authoredHalfVFov) * authoredAspect);
  const effHalfVFov = Math.atan(Math.tan(authoredHalfHFov) / canvasAspect);
  return effHalfVFov * 2 * 180 / Math.PI;
};

// ------------------------------------------------------------------
// Studio backdrop: procedural white cyclorama + contact shadow, the
// third mode of the background switch alongside bgMesh's
// 'environment'/'none'. Tunables gathered here for one-place tuning.
// ------------------------------------------------------------------
const STUDIO_WALL_R = 16; // must exceed OrbitControls' maxDistance (9)
const STUDIO_WALL_H = 10; // must clear the top of frame at the polar clamp
const STUDIO_FLOOR_R = 13; // flat floor radius, before the fillet starts
const STUDIO_FILLET_R = 3; // STUDIO_FLOOR_R + STUDIO_FILLET_R == STUDIO_WALL_R, for a tangent join
const STUDIO_SHADOW_OPACITY = 0.28;
const STUDIO_MAX_POLAR = Math.PI * 0.54; // ceiling on the dip below the horizon
const STUDIO_FLOOR_CLEARANCE = 0.25; // world units the eye keeps above the floor
const STUDIO_PROFILE_STEP = 0.4; // world units between profile points, see getStudioGeometry
const STUDIO_LIGHT_DISTANCE = 7.5; // fixed light-to-floor-point distance, see placeStudioLight
const STUDIO_LIGHT_CONE_R = 3; // world-unit radius the spot cone should cover at the floor
const STUDIO_BACKDROP_OFFSET = 0.02; // world units the backdrop sits behind the shadow catcher

// Shared across every view, built once, never disposed per-view (see
// disposePartial's studioGroup block below). Only vertical position
// matters: the lathe's v runs along the profile, not around it.
let studioGradientTex = null;
const getStudioGradient = () => {
  if (studioGradientTex) return studioGradientTex;
  try {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, '#f6f6f6');
    grad.addColorStop(0.35, '#ffffff');
    grad.addColorStop(0.78, '#e3e3e3');
    grad.addColorStop(1, '#c8c8c8');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    // Soft hotspot near the canvas top (== high on the wall once
    // lathed), reads as a key-light wash with no actual scene light.
    const hotspot = ctx.createRadialGradient(size * 0.5, size * 0.28, 0, size * 0.5, size * 0.28, size * 0.55);
    hotspot.addColorStop(0, 'rgba(255,255,255,0.55)');
    hotspot.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hotspot;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.encoding = THREE.sRGBEncoding;
    studioGradientTex = tex;
  } catch (e) {
    studioGradientTex = null; // canvas/2D-context unavailable, caller degrades to no studio backdrop
  }
  return studioGradientTex;
};

// Shared lathe profile, a CLOSED room: floor centre, flat floor, fillet,
// wall, then mirrored back over the top to a ceiling centre. Points
// only, reused by getStudioGeometry and getStudioCatcherGeometry below.
const buildStudioProfile = () => {
  // LatheGeometry sets uv.y from the point INDEX, not arc length, so
  // the profile is emitted at a uniform step. A coarse floor/wall
  // would otherwise squeeze the whole gradient into the fillet.
  const wallH = STUDIO_WALL_H - STUDIO_FILLET_R;
  const filletLen = Math.PI / 2 * STUDIO_FILLET_R;
  const segsFor = len => Math.max(1, Math.round(len / STUDIO_PROFILE_STEP));
  const floorSegs = segsFor(STUDIO_FLOOR_R);
  const filletSegs = segsFor(filletLen);
  const wallSegs = segsFor(wallH);
  const points = [];
  for (let i = 0; i <= floorSegs; i++) {
    points.push(new THREE.Vector2(i / floorSegs * STUDIO_FLOOR_R, 0));
  }
  for (let i = 1; i <= filletSegs; i++) {
    const t = i / filletSegs * (Math.PI / 2);
    points.push(new THREE.Vector2(STUDIO_FLOOR_R + Math.sin(t) * STUDIO_FILLET_R, (1 - Math.cos(t)) * STUDIO_FILLET_R));
  }
  for (let i = 1; i <= wallSegs; i++) {
    points.push(new THREE.Vector2(STUDIO_WALL_R, STUDIO_FILLET_R + i / wallSegs * wallH));
  }
  // Ceiling: the floor's fillet and disc mirrored, closing the room
  // so no camera angle inside it can see past the rim to the page.
  const ceilY = STUDIO_WALL_H + STUDIO_FILLET_R;
  for (let i = 1; i <= filletSegs; i++) {
    const t = i / filletSegs * (Math.PI / 2);
    points.push(new THREE.Vector2(STUDIO_FLOOR_R + Math.cos(t) * STUDIO_FILLET_R, STUDIO_WALL_H + Math.sin(t) * STUDIO_FILLET_R));
  }
  for (let i = 1; i <= floorSegs; i++) {
    points.push(new THREE.Vector2((1 - i / floorSegs) * STUDIO_FLOOR_R, ceilY));
  }
  return points;
};

// Offsets a profile inward by `inset`, from the local tangent at each
// point (forward diff at the first, backward at the last, central
// elsewhere) rotated +90 degrees: (x,y) -> (-y,x). Points into the room.
const insetStudioProfile = (points, inset) => {
  const last = points.length - 1;
  return points.map((p, i) => {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(last, i + 1)];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    return new THREE.Vector2(p.x + -ty / len * inset, p.y + tx / len * inset);
  });
};

// Shared bowl geometry, guarded so a missing THREE.LatheGeometry can't
// throw here.
let studioLatheGeometry = null;
const getStudioGeometry = () => {
  if (studioLatheGeometry) return studioLatheGeometry;
  try {
    if (!THREE.LatheGeometry) return null;
    studioLatheGeometry = new THREE.LatheGeometry(buildStudioProfile(), 64);
  } catch (e) {
    studioLatheGeometry = null; // no studio backdrop this session; bgMesh/no-backdrop modes still work
  }
  return studioLatheGeometry;
};

// The BACKDROP gets its own copy, pushed OUTWARD off the true bowl, so the
// catcher can keep the exact floor the model rests on. Offsetting the catcher
// instead floated the shadow above the contact point.
let studioBackdropLatheGeometry = null;
const getStudioBackdropGeometry = () => {
  if (studioBackdropLatheGeometry) return studioBackdropLatheGeometry;
  try {
    if (!THREE.LatheGeometry) return null;
    const outset = insetStudioProfile(buildStudioProfile(), -STUDIO_BACKDROP_OFFSET);
    studioBackdropLatheGeometry = new THREE.LatheGeometry(outset, 64);
  } catch (e) {
    studioBackdropLatheGeometry = null; // caller degrades along with getStudioGeometry
  }
  return studioBackdropLatheGeometry;
};
const createMtlxRenderView = async ({
  canvas,
  mx,
  gen,
  genContext,
  renderable,
  lightData,
  label,
  needsLighting,
  geomName,
  autoRotate = true,
  envBackground = false,
  // Background switch: 'studio' | 'environment' | 'none'. No default
  // here (see backdropMode below), undefined lets envBackground's
  // back-compat rule decide the initial mode.
  backdrop,
  // 'zoom' (default): plain wheel zooms. 'scroll': plain wheel is gated
  // (page scrolls), Ctrl/Cmd+wheel zooms; see the wheel-gate block below.
  // 'none': no zoom at all (wheel, Ctrl+wheel, pinch), orbit still works.
  wheelMode = 'zoom',
  // isMounted: PERMANENT lifecycle bail (component unmounted). isActive:
  // TEMPORARY visibility (backgrounded view skips render, keeps looping).
  // isAlive: OPTIONAL, read only by animate() via `aliveFn` below.
  isMounted = () => true,
  isActive = () => true,
  isAlive = null,
  debugKind = '',
  // Initial camera pull-back. 3.6 is roomy framing; ~2.55 fills the
  // frame for small square previews. IGNORED in full-scene mode — the
  // camera there is copied verbatim from the GLB's own embedded camera.
  cameraDistance = 3.6,
  // false (default) = fixed, non-interactive authored GLB camera (graph
  // editor); true (docs/viewer) = OrbitControls with pivot/zoom/polar
  // clamp and Box3 containment. Ignored outside full-scene mode.
  sceneOrbit = false,
  // Caps setPixelRatio; lower it for cheap side-by-side/compare views.
  maxPixelRatio = 2
}) => {
  // See the isAlive doc above: defaulting to isMounted here preserves
  // today's exact behavior for every caller that doesn't pass isAlive.
  const aliveFn = isAlive || isMounted;
  // Mode derived from geomName: 'shaderball-scene' -> full authored GLB
  // scene with detached embedded camera; 'shaderball' -> simple
  // (ball-only) GLB; anything else -> null (ordinary sphere/cube path).
  const sceneMode = geomName === 'shaderball-scene' ? 'full' : geomName === 'shaderball' ? 'simple' : null;
  // 'buffer2d': Shadertoy-style fullscreen quad — fixed ortho camera,
  // no controls/spin, no visible backdrop. Orthogonal to sceneMode
  // (null there, so the ordinary buildPreviewGeometry path runs).
  const flat2d = geomName === 'buffer2d';
  // Known before the renderer exists, so the shadow map can be configured
  // up front. Flipping shadowMap.enabled after the PMREM and the materials
  // are built invalidated program state and blacked out scene.environment.
  const wantsStudio = !flat2d && sceneMode !== 'full';
  // Unrecognized/missing values fall back to 'studio'. envBackground
  // back-compat only applies when `backdrop` itself was never passed
  // at all; an explicit `backdrop` (even 'studio') always wins.
  const normalizeBackdropMode = v => v === 'environment' || v === 'none' ? v : 'studio';
  let backdropMode = normalizeBackdropMode(backdrop !== undefined ? backdrop : envBackground ? 'environment' : 'studio');
  let reqId = null;
  let renderer = null;
  let resizeObs = null;
  // While true the canvas keeps its current drawing buffer and the
  // browser scales it to the CSS box. Lets a pane drag rescale the
  // image smoothly instead of reallocating GL every frame.
  let resizeSuspended = false;
  let syncSizeRef = function () {/* set once the canvas sizing closure exists */};
  let controls = null;
  let stopped = false;
  // Reused by snapshotPixels below — avoids a fresh canvas/2D-context
  // allocation on every readback call.
  let __snapshotCanvas = null,
    __snapshotCtx = null;
  // Shell-level material/geometry/uniforms state, reassigned by
  // applyMaterialInternal() on every swap so one shell backs many edits.
  // `uniforms` MUST be `let`: every closure below shares this binding.
  let mesh = null,
    material = null,
    geometry = null,
    uniforms = null;
  // Scene-mode state, null/empty when sceneMode is null (sphere/cube
  // path guards with `if (sceneGroup)`). sceneGroup: instantiated GLB
  // root. sceneOwnedMaterials/pmremRT: disposed by disposePartial below.
  let sceneGroup = null,
    sceneOwnedMaterials = [],
    pmremRT = null;
  // Depth-peel shell state (see the FORCE_TRANSPARENCY flag's header
  // comment above and renderFrame()/allocPeel()/freePeel() further down).
  // viewIsTransparent: a shell-local MIRROR of the handle's
  // isTransparent (raw srcs.transparent from generation) — needed
  // because renderFrame() is invoked synchronously by the FIRST
  // animate() call below, which runs BEFORE `handle` exists (the
  // object literal is constructed further down, after animate() has
  // already been called once) — renderFrame can't read
  // handle.isTransparent yet, so it reads this instead. Kept in sync
  // with handle.isTransparent at every point that field is set.
  // peel: null until the depth-peel render targets/materials are
  // actually needed (lazily allocated by allocPeel, on the first
  // peeling frame or after a resize); holds { w, h, opaqueRT, peelA,
  // peelB, accumRT, quadScene, quadCam, quadMesh, underMat, finalMat }
  // while allocated. freePeel() releases it back to null.
  let viewIsTransparent = false;
  let peel = null;
  // Tracks whether the scene's built-in materials are currently
  // detoned for the linear-peel opaque pass (see setSceneLinear below).
  let sceneLinearOn = false;
  // Outer-scope binding for freePeel (declared `const` deep inside the
  // try block below, out of disposePartial's reach): every call site
  // resolves this instead, assigned once right after that const.
  let freePeelFn = null;
  // The radiance texture, kept so the caller can toggle it as the
  // visible backdrop (setEnvBackground) via bgMesh below — the IBL
  // uniforms are bound regardless.
  let envBgTexture = null;
  let envRadSamplerName = null,
    envIrrSamplerName = null,
    envRotationRad = 0;
  // See NEUTRAL_ENV_ROTATION_CHUNK's header comment above for the full
  // derivation of why this is a bare RotationY(rad) — no extra PI/2.
  const envRotationMatrix3 = rad => new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(rad));
  // Attaches the live-rotatable env patch to one neutral glTF PBR
  // material. Nested here so onBeforeCompile reads `envRotationRad`
  // fresh at ACTUAL compile time, not a value snapshotted at attach time.
  const patchNeutralMaterialEnvRotation = material => {
    material.onBeforeCompile = shader => {
      shader.uniforms.uEnvRotation = {
        value: envRotationMatrix3(envRotationRad)
      };
      shader.fragmentShader = shader.fragmentShader.replace('#include <envmap_physical_pars_fragment>', NEUTRAL_ENV_ROTATION_CHUNK);
      material.userData.envRotationUniform = shader.uniforms.uEnvRotation;
    };
    // r128's Material default already derives customProgramCacheKey
    // from onBeforeCompile.toString(), which already keys these apart
    // — set explicitly anyway as insurance against a future edit.
    material.customProgramCacheKey = () => 'neutralEnvRotation';
  };
  // Shell-owned skybox mesh, replacing scene.background: r128's
  // WebGLBackground caches an equirect texture as a cubemap, ignoring
  // texture.offset/matrix (a per-frame offset write was a silent no-op).
  let bgMesh = null;
  // Studio backdrop group (wall/floor lathe + shadow catcher + zero-
  // intensity spotlight), null for flat2d/full-scene, where the
  // studio mode is never built (see its construction further down).
  let studioGroup = null,
    studioMesh = null,
    studioCatcher = null,
    studioLight = null;
  // Shell-level env (IBL) state, fetched ONCE (not per material
  // apply) since env textures never change across a document edit.
  // bindMaterialUniforms() reads these on every apply.
  let envRadiance = null,
    envIrradiance = null,
    envMips = 0,
    envExposure = 1.0;
  // envHasFile/envPrefilteredIrr: used only by the DEBUG_SHADERS log
  // in bindMaterialUniforms, to reproduce the old descriptive message
  // now that `env` no longer lives past the one-time shell-level fetch.
  let envHasFile = false,
    envPrefilteredIrr = false;
  // The active env's auto-extracted key light (null = none) — see
  // extractKeyLight/currentLights. rigCount fixes u_lightData's length.
  let envKeyLight = null;
  const rigCount = lightData && lightData.length || 0;
  // Per-view state for the handle's setEnvMap(url): the textures from
  // the last URL this view privately fetched, never shared with other
  // views, so a later swap or teardown can free them safely.
  let fetchedEnvMap = null;
  let envMapCallId = 0; // guards latest-call-wins in setEnvMap()
  // Frees a privately-fetched env's textures. Never call this on the
  // shared default/override env from getEnvironment()/envOverride.
  const disposeFetchedEnv = env => {
    if (!env) return;
    try {
      if (env.radiance) env.radiance.dispose();
    } catch (e) {/* already disposed/invalid */}
    try {
      if (env.irradiance && env.irradiance !== env.radiance) env.irradiance.dispose();
    } catch (e) {/* ditto */}
    try {
      if (env.background) env.background.dispose();
    } catch (e) {/* ditto */}
  };
  // No-OrbitControls fallback only (script blocked): mirrors the
  // autoRotate state so the fallback spin can be toggled too.
  let fallbackSpin = !!autoRotate;
  // wheelMode 'scroll' state: the canvas wheel-gate listener plus the
  // lazily-created zoom-hint overlay and its fade timer, all torn
  // down in disposePartial below.
  let wheelGateHandler = null;
  let wheelHintEl = null,
    wheelHintTimer = null;
  const isWheelHintMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  // Shows (or refreshes) the "Use Ctrl/⌘ + scroll to zoom" pill,
  // centered over the canvas's positioned parent; fades ~1.2s after
  // the last gated wheel event. The node is created lazily, once.
  const showWheelHint = () => {
    if (!wheelHintEl) {
      const parent = canvas.parentElement;
      if (!parent) return;
      wheelHintEl = document.createElement('div');
      wheelHintEl.textContent = isWheelHintMac ? 'Use ⌘ + scroll to zoom' : 'Use Ctrl + scroll to zoom';
      wheelHintEl.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);' + 'padding:6px 14px;border-radius:9999px;background:rgba(17,24,39,0.85);' + 'color:#f3f4f6;font:13px system-ui,sans-serif;pointer-events:none;' + 'opacity:0;transition:opacity 200ms ease;z-index:30;white-space:nowrap;';
      parent.appendChild(wheelHintEl);
    }
    wheelHintEl.style.opacity = '1';
    if (wheelHintTimer) clearTimeout(wheelHintTimer);
    wheelHintTimer = setTimeout(() => {
      if (wheelHintEl) wheelHintEl.style.opacity = '0';
    }, 1200);
  };
  const disposePartial = () => {
    stopped = true;
    if (reqId) cancelAnimationFrame(reqId);
    if (resizeObs) resizeObs.disconnect();
    if (controls) controls.dispose();
    // wheelMode 'scroll' teardown: the capture listener and the
    // hint overlay (plus its pending fade timer), if either exists.
    if (wheelGateHandler) canvas.removeEventListener('wheel', wheelGateHandler, {
      capture: true
    });
    if (wheelHintTimer) clearTimeout(wheelHintTimer);
    if (wheelHintEl && wheelHintEl.parentElement) wheelHintEl.parentElement.removeChild(wheelHintEl);
    // Best-effort: renderer.dispose() below only frees the
    // renderer's OWN GL state, not material/geometry — dispose those
    // too (each swap already disposes its own previous ones).
    try {
      if (material) material.dispose();
    } catch (e) {/* already disposed/invalid */}
    try {
      if (geometry) geometry.dispose();
    } catch (e) {/* ditto */}
    // bgMesh: dispose its own geometry/material and drop it from
    // the scene. Do NOT dispose bgMesh.material.map (envBgTexture)
    // — env textures are shared/cached across every live view.
    try {
      if (bgMesh) {
        scene.remove(bgMesh);
        bgMesh.geometry.dispose();
        bgMesh.material.dispose();
      }
    } catch (e) {/* already disposed/invalid, or scene never got this far */}
    // studioGroup: drop it, dispose its two per-view MATERIALS and
    // the spotlight's own shadow render target. Do NOT dispose the
    // shared gradient texture or the two lathe geometries (reused everywhere).
    try {
      if (studioGroup) {
        scene.remove(studioGroup);
        if (studioMesh) studioMesh.material.dispose();
        if (studioCatcher) studioCatcher.material.dispose();
        if (studioLight) studioLight.shadow.dispose();
      }
    } catch (e) {/* already disposed/invalid, or scene never got this far */}
    // sceneGroup (scene-mode only): drops the GLB hierarchy and
    // disposes its per-view material CLONES (sceneOwnedMaterials).
    // Does NOT dispose geometries — shared with other cached views.
    try {
      if (sceneGroup) {
        scene.remove(sceneGroup);
        sceneOwnedMaterials.forEach(m => {
          try {
            m.dispose();
          } catch (e) {/* already disposed/invalid */}
        });
      }
    } catch (e) {/* already disposed/invalid, or scene never got this far */}
    // pmremRT: this view's OWN render target — safe to dispose.
    // Do NOT dispose the PMREMGenerator instance itself: r128 shares
    // its LOD-plane geometries at MODULE scope across all instances.
    try {
      if (pmremRT) pmremRT.dispose();
    } catch (e) {/* already disposed/invalid */}
    // setEnvMap()'s privately-fetched env, if any: this view's own
    // textures (unlike bgMesh.material.map above), safe to dispose.
    try {
      if (fetchedEnvMap) disposeFetchedEnv(fetchedEnvMap);
    } catch (e) {/* already disposed/invalid */}
    // Depth-peel render targets/quad materials (see freePeel's
    // declaration further down) — this view's OWN GPU resources,
    // same disposal rationale as pmremRT immediately above.
    try {
      if (peel) freePeelFn && freePeelFn();
    } catch (e) {/* already disposed/invalid */}
    if (renderer) renderer.dispose();
  };
  // [mtlx-perf] whole-function total, from shader generation through
  // the GL compile. See the finer-grained timers further down for a
  // breakdown (gen.generate / WebGLRenderer init / GL compile).
  const __totalPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
  try {
    // Generates the shader from the renderable surface node
    // — see generatePreviewSources for the full breakdown;
    // extracted so tryRefreshRenderView can reuse it for a diff.
    const __srcs = await generatePreviewSources({
      mx,
      gen,
      genContext,
      renderable,
      label,
      isMounted
    });
    // Bail if this build was superseded while awaiting above
    // — nothing GL-side exists yet, so disposePartial() is a
    // safe, idempotent no-op beyond flagging `stopped`.
    if (!__srcs) {
      disposePartial();
      return null;
    }
    // introspected: already plain JS, converted inside the
    // mxExclusive-locked generatePreviewSourcesUnlocked
    // before the lock released. No wasm reads left here.
    const {
      vs,
      fs,
      introspected,
      transparent
    } = __srcs;

    // Pre-warms the driver compile BEFORE the display renderer
    // is created — the old after-renderer placement measured
    // 0.8-2.5s WebGLRenderer init stalls from queue contention.
    const warmResult = await prewarmShaderCompile({
      vs,
      fs,
      isMounted,
      label
    });
    if (warmResult === 'bailed' || !isMounted()) {
      disposePartial();
      return null;
    }

    // --- three.js scene (WebGL2) ---
    // clientWidth can be 0 before layout; fall back so the
    // viewport isn't 0×0 (which renders nothing → black).
    const cw = canvas.clientWidth || canvas.parentElement && canvas.parentElement.clientWidth || 400;
    const ch = canvas.clientHeight || 256;
    // Bail before allocating the WebGL context if this build
    // was superseded during shader generation above —
    // disposePartial() is still a safe no-op here.
    if (!isMounted()) {
      disposePartial();
      return null;
    }
    const __rendererPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true
    });
    // TEMPORARY: how many renderers this canvas has seen. A canvas
    // has ONE GL context, so a second renderer here inherits the
    // first one's context, and a disposed predecessor can strand it.
    try {
      canvas.__mtlxRendererCount = (canvas.__mtlxRendererCount || 0) + 1;
    } catch (e) {/* ignore */}
    // GLOBAL flag keying every lit material's program cache, so set
    // ONCE here, before any material or PMREM work, and left at the
    // default (off) for views that never build a studio bowl.
    if (wantsStudio) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    renderer.setSize(cw, ch, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
    renderer.debug.checkShaderErrors = true;
    // No-ops for the RawShaderMaterial surface (encodeDisplay
    // bakes its transform into the shader); set here for the
    // ordinary three materials in the scene — skybox, backplanes, neutral glTF parts.
    if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    if (window.MTLX_PERF_LOG) {
      console.log('[mtlx-perf] WebGLRenderer init: ' + (performance.now() - __rendererPerfStart).toFixed(1) + 'ms');
    }
    // Hoisted once renderer exists: gates u_peelLinear binding,
    // peel-layer/accum half-float storage, and finalMat's shader
    // choice, all from this one extension check (see allocPeel).
    const peelLinearOk = !!renderer.extensions.get('EXT_color_buffer_float');
    const scene = new THREE.Scene();

    // Instantiates the scene-mode GLB (if any) BEFORE the
    // camera: full-scene mode needs the GLB's embedded camera
    // to build the shell camera. isMounted bail is a safe no-op.
    const sceneInst = sceneMode ? await instantiateShaderballScene(sceneMode) : null;
    if (!isMounted()) {
      disposePartial();
      return null;
    }
    if (sceneMode && !sceneInst) {
      // GLB missing/corrupt, no GLTFLoader, or the asset
      // lacks a material_surface mesh — degrade to the
      // plain sphere fallback with a warning, not a crash.
      console.warn('shaderball scene unavailable, falling back to sphere:', geomName);
    }
    if (sceneInst) {
      sceneGroup = sceneInst.group;
      sceneOwnedMaterials = sceneInst.ownedMaterials;
      // Env-rotation patch: every neutral glTF PBR material
      // EXCEPT the backplanes' MeshBasicMaterial clones
      // (no envMap). Same duck-typing check as setEnvExposure.
      sceneOwnedMaterials.forEach(m => {
        // BISECT: the env-rotation chunk is the only hand-injected
        // shader in the scene, and it is the last suspect for the
        // black neutral materials under an enabled shadow map.
        if ('envMapIntensity' in m && !wantsStudio) patchNeutralMaterialEnvRotation(m);
      });
    }
    // fullScene: the full authored preset (shaderball.glb) —
    // fixed camera, no fallback spin by default; docs/viewer
    // opt into orbit/zoom via sceneOrbit. 'simple' is NOT fullScene.
    const fullScene = !!(sceneInst && sceneMode === 'full');
    // Populated only in the fullScene-adoption branch below;
    // read again by syncSize on every resize. null in every
    // other mode (fixed-45-degree camera untouched).
    let fullSceneAuthoredFov = null;
    let fullSceneAuthoredAspect = null;
    // Authored GLB camera pose cached at adoption time —
    // the scene-orbit config block restores it (OrbitControls
    // re-aims at (0,0,0)), and resetCamera() returns to it.
    let sceneAuthoredPose = null;

    // flat2d: ortho frustum whose x extent tracks the canvas
    // aspect (fitQuadToAspect rewrites left/right plus the
    // quad's positions/UVs), so the quad stays edge-to-edge
    // while pattern scale stays square in pixels. Head-on at
    // (0,0,1): the default camera orientation already faces
    // -Z, so no lookAt, and u_viewPosition becomes (0,0,1).
    const camera = flat2d ? new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10) : new THREE.PerspectiveCamera(45, cw / ch, 0.1, 100);
    if (flat2d) {
      camera.position.set(0, 0, 1);
    } else {
      // Slightly elevated three-quarter framing; elevation
      // scales with distance so the viewing angle stays constant.
      // (fullScene overrides this wholesale immediately below.)
      camera.position.set(0, 0.5 * (cameraDistance / 3.6), cameraDistance);
    }
    if (fullScene && sceneInst.glbCamera) {
      const gc = sceneInst.glbCamera;
      // DETACHED camera: the GLB's camera sits under a root
      // node baking a 0.01 scale — rendering it in-hierarchy
      // would inflate distances ~100x, clipping past zfar=10.
      sceneGroup.updateMatrixWorld(true); // sceneGroup isn't added to `scene` until below; compute its world matrices standalone first
      gc.getWorldPosition(camera.position);
      gc.getWorldQuaternion(camera.quaternion);
      sceneAuthoredPose = {
        position: camera.position.clone(),
        quaternion: camera.quaternion.clone()
      };
      // gc.near/far are already in THREE.PerspectiveCamera's
      // units — copy verbatim. gc.fov is captured below
      // rather than copied straight — see effectiveFullSceneVFov.
      camera.near = gc.near;
      camera.far = gc.far;
      // Authored aspect: gc.aspect (this GLB authors
      // ~1.7778/16:9); the `|| 1.7778` fallback only matters
      // for a hypothetical GLB that omits aspectRatio.
      fullSceneAuthoredFov = gc.fov;
      fullSceneAuthoredAspect = gc.aspect || 1.7778;
      // Aspect from the CANVAS, not the GLB's own — no
      // letterbox/pillarbox, same as every other preset.
      // effectiveFullSceneVFov widens the fov instead of cropping.
      camera.aspect = cw / ch;
      camera.fov = effectiveFullSceneVFov(fullSceneAuthoredFov, fullSceneAuthoredAspect, camera.aspect);
      camera.updateProjectionMatrix();
    }

    // wheelMode 'scroll': register the gate BEFORE OrbitControls
    // exists, so it runs first on the canvas and can starve its
    // wheel handler via stopImmediatePropagation. The `controls`
    // check inside skips flat2d/fixed-camera views (no rig, no zoom).
    if (wheelMode === 'scroll') {
      wheelGateHandler = e => {
        if (!controls || e.ctrlKey || e.metaKey) return;
        const fsEl = fullscreenElement();
        if (fsEl && fsEl.contains(canvas)) return;
        e.stopImmediatePropagation();
        showWheelHint();
      };
      canvas.addEventListener('wheel', wheelGateHandler, {
        capture: true,
        passive: false
      });
    }

    // Orbit + zoom + auto-rotate: rotating the CAMERA (not
    // the mesh) lets orbit/zoom/pause compose naturally.
    // Full-scene mode is FIXED by default; opt in with sceneOrbit.
    controls = null;
    if (THREE.OrbitControls && !flat2d && (!fullScene || sceneOrbit)) {
      controls = new THREE.OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.enablePan = false;
      controls.enableZoom = wheelMode !== 'none';
      controls.minDistance = 1.4;
      controls.maxDistance = 9;
      // Camera auto-orbit (off by default): pins the
      // specular highlight to the same spot on the model
      // (showcase look); the visible environment pans as a tradeoff.
      controls.autoRotate = !!autoRotate;
      controls.autoRotateSpeed = 1.5;
    }
    // No-OrbitControls fallback spin must also stay off in
    // full-scene mode and for the fixed 2D buffer — no
    // controls instance exists to gate it, so force it here.
    if (fullScene || flat2d) fallbackSpin = false;

    // Fullscreen "fit to ball": keeps the ball's bounding
    // sphere inside the frame, only ever WIDENING the fov on
    // top of the everyday framing. fullScene-only; pure fov change.
    let fullscreenFit = false;
    // World-space bounding sphere of the whole ball assembly,
    // computed ONCE per scene and cached here — see
    // getBallBoundingSphere just below.
    let ballBoundingSphere = null;
    // Scene-orbit hard-containment box (sceneGroup bounds
    // inset 2%/axis, expanded so the default pose stays
    // legal); null in every other mode.
    let sceneOrbitClampBox = null;
    // Reference camera->ball distance for scene-orbit framing,
    // captured from the AUTHORED pose so recomputeCameraFov's
    // fit-to-ball fov stays constant while the user zooms.
    let sceneOrbitFitDist = null;
    // Radius of the framing target (the ball proper, see the
    // config block below), paired with sceneOrbitFitDist for the
    // scene-orbit fov fit. null in every other mode.
    let sceneOrbitFitRadius = null;

    // Finds (and caches) the ball assembly's world bounding
    // sphere: 'shader_ball' by name, falling back to
    // material_surface's parent, then sceneGroup (never throws).
    const getBallBoundingSphere = () => {
      if (ballBoundingSphere) return ballBoundingSphere;
      if (!sceneGroup) return null;
      const ballNode = sceneGroup.getObjectByName('shader_ball') || mesh && mesh.parent || sceneGroup;
      ballNode.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(ballNode);
      ballBoundingSphere = box.getBoundingSphere(new THREE.Sphere());
      return ballBoundingSphere;
    };

    // Single entry point for every fov-affecting event so they
    // never disagree: starts from effectiveFullSceneVFov, then
    // widens further only while fullscreenFit is on.
    const recomputeCameraFov = () => {
      if (fullSceneAuthoredFov == null) return; // non-fullScene modes keep their fixed fov untouched
      let fov = effectiveFullSceneVFov(fullSceneAuthoredFov, fullSceneAuthoredAspect, camera.aspect);
      // Scene-orbit default framing: fits the ball PROPER
      // to the actual viewport aspect (authored ~16:9 fov
      // overflows wider canvases). REPLACES the base fov here.
      if (sceneOrbitFitDist != null && sceneOrbitFitRadius != null && sceneOrbitFitDist > sceneOrbitFitRadius) {
        const theta = Math.asin(Math.min(1, sceneOrbitFitRadius / sceneOrbitFitDist));
        const vForV = 2 * theta;
        const vForH = 2 * Math.atan(Math.tan(theta) / camera.aspect);
        const SCENE_FIT_MARGIN = 1.15; // ball ~1/1.15 of the limiting dimension - tight hero framing
        fov = Math.max(vForV, vForH) * 180 / Math.PI * SCENE_FIT_MARGIN;
      }
      if (fullscreenFit) {
        const sphere = getBallBoundingSphere();
        const dist = sphere ? camera.position.distanceTo(sphere.center) : 0;
        if (sphere && dist > sphere.radius) {
          // Angular radius of the ball as seen from the
          // camera: asin(r/d), clamped to 1 against fp
          // overshoot when dist is barely larger than radius.
          const theta = Math.asin(Math.min(1, sphere.radius / dist));
          // The ball must fit BOTH axes: vertical
          // half-fov covers theta directly; horizontal
          // half-fov converts back via the same tan/atan.
          const vFovForVertical = 2 * theta;
          const vFovForHorizontal = 2 * Math.atan(Math.tan(theta) / camera.aspect);
          const FIT_MARGIN = 1.06; // ~6% breathing room so the ball doesn't touch the frame edge
          const fitFovDeg = Math.max(vFovForVertical, vFovForHorizontal) * 180 / Math.PI * FIT_MARGIN;
          fov = Math.max(fov, fitFovDeg); // only ever widen -- never crop back below the everyday framing
        }
      }
      camera.fov = fov;
    };

    // flat2d screen-proportional fit (Shadertoy's
    // fragCoord/iResolution.y convention): one unit of UV or
    // object-space position covers the same pixel count on
    // both axes, so resizing the canvas REVEALS more pattern
    // instead of stretching it. Height keeps v 0..1 / y
    // -1..1; the frustum, quad positions (x ±aspect), and
    // UVs (u 0..aspect) all track the width. This must touch
    // POSITION too, not just UV — 3D-procedural nodes (noise/
    // fractal) sample i_position and would stretch otherwise.
    // prepGeometry aliases i_position/i_texcoord_0 to the
    // SAME BufferAttributes as position/uv, so these writes
    // update what the MaterialX shader reads. The 4-vert
    // quad's x/u values are strictly signed/zero-or-positive,
    // so re-fitting at any previous aspect is idempotent.
    const fitQuadToAspect = aspect => {
      camera.left = -aspect;
      camera.right = aspect;
      camera.updateProjectionMatrix();
      if (!geometry) return;
      const pos = geometry.getAttribute('position');
      const uv = geometry.getAttribute('uv');
      if (!pos || !uv) return;
      for (let i = 0; i < pos.count; i++) {
        pos.setX(i, pos.getX(i) > 0 ? aspect : -aspect);
        uv.setX(i, uv.getX(i) > 0 ? aspect : 0);
      }
      pos.needsUpdate = true;
      uv.needsUpdate = true;
      // Frustum culling reads the bounding sphere; keep it
      // in sync with the rewritten positions.
      geometry.computeBoundingSphere();
    };

    // Keeps the drawing buffer + aspect in sync with layout
    // (panel reflow, mobile rotation/resize) — without this
    // the sphere stretches on any reflow.
    const syncSize = () => {
      if (resizeSuspended) return;
      const w = canvas.clientWidth || cw;
      const h = canvas.clientHeight || ch;
      renderer.setSize(w, h, false);
      // Depth-peel render targets are sized to the drawing
      // buffer (see allocPeel further down) — just free them
      // here; renderFrame() lazily reallocates at the new
      // size on its next peeling frame, so a resize with
      // peeling OFF costs nothing extra.
      if (peel) freePeelFn();
      if (flat2d) {
        // OrthographicCamera has no .aspect/.fov — the
        // frustum/quad/UV fit tracks the aspect instead
        // (fitQuadToAspect updates the projection itself).
        fitQuadToAspect(w / h);
        return;
      }
      camera.aspect = w / h;
      // fullScene only: resize can flip which side of the
      // canvasAspect >= authoredAspect comparison we're on,
      // so this must be recomputed every resize, not once.
      recomputeCameraFov();
      camera.updateProjectionMatrix();
    };
    syncSizeRef = syncSize;
    if (window.ResizeObserver) {
      resizeObs = new ResizeObserver(syncSize);
      resizeObs.observe(canvas);
    }

    // Image-based lighting for lit surfaces/BSDFs AND/OR
    // scene-mode's glTF meshes (always lit via PMREM, even
    // under an unlit material). Fetched ONCE at shell level.
    if (needsLighting || sceneInst) {
      const env = envOverride || (await getEnvironment());
      if (!isMounted()) {
        disposePartial();
        return null;
      }
      // Independent of envRadiance/etc. below: scene-mode's
      // PMREM further down needs A radiance source even
      // when this material is unlit and never touches u_env*.
      const radianceSrc = env ? env.radiance : makeEnvTexture(256, 128, false);
      if (needsLighting) {
        if (env) {
          envRadiance = env.radiance;
          envIrradiance = env.irradiance;
          envMips = env.mips;
          envBgTexture = env.background;
          envHasFile = true;
          envPrefilteredIrr = !!env.prefilteredIrr;
          envKeyLight = env.keyLight || null;
        } else {
          envRadiance = makeEnvTexture(256, 128, false);
          envIrradiance = makeEnvTexture(64, 32, true);
          envMips = Math.floor(Math.log2(256)) + 1;
          // Same convention gap as the HDR path: the
          // synthesized data is top-first too, so the
          // background needs its own flipY=true copy.
          envBgTexture = makeBackgroundTexture(envRadiance);
          envHasFile = false;
        }
        // Shell-owned skybox mesh (see bgMesh's declaration
        // above). depthWrite:false + a low renderOrder draws
        // it first, so draw order alone keeps it behind everything.
        // flat2d: never created — the quad occupies the whole
        // viewport and must have no backdrop. bgMesh stays
        // null, which setEnvBackground/setEnvironment already
        // guard, while the env textures above keep IBL lit.
        if (!flat2d) {
          const bgGeometry = new THREE.SphereGeometry(50, 64, 32);
          bgGeometry.scale(-1, 1, 1);
          bgMesh = new THREE.Mesh(bgGeometry, new THREE.MeshBasicMaterial({
            map: envBgTexture,
            depthWrite: false
          }));
          bgMesh.renderOrder = -1000;
          bgMesh.rotation.y = BG_BASE + BG_SIGN * envRotationRad;
          bgMesh.visible = false; // real visibility set by applyBackdrop() below
          scene.add(bgMesh);
        }
      }
      if (sceneInst) {
        // Scene-mode lighting: bakes radianceSrc into a
        // PMREM driving scene.environment. NEVER dispose
        // the PMREMGenerator — r128 shares state module-wide.
        // three's equirectUv puts +Y at v=1 — opposite
        // MaterialX's v=0 — so reading the same texture
        // v-mirrors scene reflections vs the surface (ok for now).
        pmremRT = new THREE.PMREMGenerator(renderer).fromEquirectangular(radianceSrc);
        scene.environment = pmremRT.texture;
      }
    }

    // Fallback when envKeyLight is null (see below): the
    // studio's original hardcoded key-light angle, still
    // rotated by envRotationRad so the control stays live.
    const STUDIO_LIGHT_FALLBACK_DIR = new THREE.Vector3(2.5, 6, 4).normalize();
    // Single source of truth for the spotlight's placement
    // (called here and by setEnvRotation), so the shadow
    // tracks extractKeyLight's direction like u_lightData does.
    const placeStudioLight = () => {
      if (!studioLight) return;
      const toLightDir = (envKeyLight ? envKeyLight.direction.clone().negate() : STUDIO_LIGHT_FALLBACK_DIR.clone()).applyMatrix4(keyLightRotationMatrix(envRotationRad)).normalize();
      studioLight.position.copy(toLightDir).multiplyScalar(STUDIO_LIGHT_DISTANCE);
    };

    // Procedural white studio cyclorama + contact shadow,
    // the third backdrop mode alongside bgMesh above. Skipped
    // for flat2d and full-scene (its own authored room).
    if (wantsStudio) {
      try {
        const studioGeom = getStudioGeometry();
        if (studioGeom) {
          studioGroup = new THREE.Group();
          studioMesh = new THREE.Mesh(getStudioBackdropGeometry() || studioGeom, new THREE.MeshBasicMaterial({
            map: getStudioGradient(),
            side: THREE.BackSide,
            toneMapped: false
          }));
          studioMesh.renderOrder = -900;
          // BackSide like studioMesh: a FrontSide catcher
          // would be culled from inside and show no shadow.
          // It keeps the true bowl, so the shadow meets the model where it lands.
          studioCatcher = new THREE.Mesh(studioGeom, new THREE.ShadowMaterial({
            opacity: STUDIO_SHADOW_OPACITY,
            side: THREE.BackSide
          }));
          studioCatcher.receiveShadow = true;
          studioCatcher.material.depthWrite = false;
          studioCatcher.renderOrder = -800;
          // Zero intensity + castShadow: only the simple
          // GLB's neutral glTF meshes read lights, so this
          // casts a shadow while lighting nothing.
          studioLight = new THREE.SpotLight(0xffffff, 0);
          studioLight.target.position.set(0, 0, 0);
          studioLight.castShadow = true;
          studioLight.angle = Math.atan(STUDIO_LIGHT_CONE_R / STUDIO_LIGHT_DISTANCE);
          studioLight.penumbra = 0.5;
          // Bracket tightly around the fixed light-to-
          // floor distance (model radius 1 + catcher
          // margin either side) instead of the loose 1..14 range.
          studioLight.shadow.camera.near = STUDIO_LIGHT_DISTANCE - 4;
          studioLight.shadow.camera.far = STUDIO_LIGHT_DISTANCE + 4;
          studioLight.shadow.mapSize.set(2048, 2048);
          // PCF, not VSM: VSM leans on half-float linear
          // filtering and stippled the whole frustum on
          // real hardware. Softness comes from the map size.
          studioLight.shadow.bias = -0.0005;
          studioLight.shadow.normalBias = 0.02;
          placeStudioLight();
          studioGroup.add(studioMesh, studioCatcher, studioLight, studioLight.target);
          scene.add(studioGroup);
        }
      } catch (e) {
        // Build failure (e.g. no THREE.LatheGeometry) must
        // never take down the whole view, degrade to no
        // studio backdrop instead; bgMesh/'none' still work.
        studioGroup = null;
        studioMesh = null;
        studioCatcher = null;
        studioLight = null;
      }
    }

    // Single source of truth for the three backdrop modes,
    // applied once below for the initial `backdrop` option,
    // and again by the handle's setBackdrop()/setEnvBackground().
    // The orbit target sits above the floor, so a fixed dip below
    // the horizon drops the eye THROUGH the floor once the
    // distance grows. Re-derived per frame from that distance.
    let studioPolarApplied = false;
    const applyStudioPolarClamp = () => {
      if (!controls) return;
      if (!studioGroup || backdropMode !== 'studio') {
        // Only ever restore a clamp we set: full-scene mode
        // has no studioGroup and owns its own orbit limits.
        if (studioPolarApplied) {
          controls.maxPolarAngle = Math.PI;
          studioPolarApplied = false;
        }
        return;
      }
      const dist = camera.position.distanceTo(controls.target);
      const rel = studioGroup.position.y + STUDIO_FLOOR_CLEARANCE - controls.target.y;
      const limit = dist > 1e-3 ? Math.acos(Math.max(-1, Math.min(1, rel / dist))) : STUDIO_MAX_POLAR;
      controls.maxPolarAngle = Math.min(STUDIO_MAX_POLAR, limit);
      studioPolarApplied = true;
    };

    // Single source of truth for the three backdrop modes,
    // applied once below for the initial `backdrop` option,
    // and again by the handle's setBackdrop()/setEnvBackground().
    const applyBackdrop = mode => {
      backdropMode = normalizeBackdropMode(mode);
      if (bgMesh) bgMesh.visible = backdropMode === 'environment';
      if (studioGroup) studioGroup.visible = backdropMode === 'studio';
      applyStudioPolarClamp();
    };
    applyBackdrop(backdropMode);

    // Non-MaterialX materials (skybox + GLB clones) — fixed
    // for this shell's lifetime, so cached once. setSceneLinear
    // detones them for the merged linear-opaque pass (sRGB needs
    // no flag: the RT's own texture.encoding gates that, r128-verified).
    const sceneBuiltinMaterials = (bgMesh ? [bgMesh.material] : []).concat(studioMesh ? [studioMesh.material] : [], studioCatcher ? [studioCatcher.material] : []).concat(sceneOwnedMaterials);
    const setSceneLinear = on => {
      sceneBuiltinMaterials.forEach(m => {
        if (m.toneMapped === !on) return;
        m.toneMapped = !on;
        m.needsUpdate = true;
      });
    };

    // Selected preview geometry. Scene mode pre-assigns the
    // shell's `mesh`/`geometry` to material_surface, so the
    // first applyMaterialInternal() reuses it, not a fresh Mesh.
    if (sceneInst) {
      scene.add(sceneGroup);
      mesh = sceneInst.surfaceMesh;
      geometry = mesh.geometry;
      // Forces sceneGroup's matrixWorld current NOW: the
      // first animate() tick reads mesh.matrixWorld in
      // setUniforms() before renderer.render() would sync it.
      sceneGroup.updateMatrixWorld(true);
    } else {
      geometry = prepGeometry(await buildPreviewGeometry(geomName));
      // Initial screen-proportional fit for the 2D buffer —
      // don't rely on the ResizeObserver's first fire
      // ordering against the first rendered frame.
      if (flat2d) fitQuadToAspect((canvas.clientWidth || cw) / (canvas.clientHeight || ch));
    }
    if (!isMounted()) {
      disposePartial();
      return null;
    }
    if (fullScene && sceneOrbit && controls) {
      // OrbitControls' constructor already ran update()
      // against its placeholder (0,0,0) target and re-aimed
      // the camera — restore the authored pose first.
      if (sceneAuthoredPose) {
        camera.position.copy(sceneAuthoredPose.position);
        camera.quaternion.copy(sceneAuthoredPose.quaternion);
      }
      const sphere = getBallBoundingSphere();
      // Pivot on the authored view ray at the ball's depth:
      // orientation is unchanged by OrbitControls' first
      // lookAt (zero roll), and the orbit pivots at the ball.
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      let d = sphere ? sphere.center.clone().sub(camera.position).dot(fwd) : 0;
      if (!(d > 0)) d = sphere ? camera.position.distanceTo(sphere.center) : 0.5;
      controls.target.copy(camera.position).addScaledVector(fwd, d);
      controls.minDistance = Math.min(d, sphere ? sphere.radius * 1.5 : d * 0.5);
      // Auto-rotate stays OFF regardless of autoRotate: the
      // rotate button is hidden here and setAutoRotate no-ops
      // for fullScene — a stale `rotating` could start a turntable.
      controls.autoRotate = false;
      // Containment: sceneGroup bounds == the backdrop box.
      // Inset 2% per axis, then union the authored camera
      // position so the default pose is always legal.
      const box = new THREE.Box3().setFromObject(sceneGroup);
      const size = box.getSize(new THREE.Vector3());
      box.min.x += size.x * 0.02;
      box.max.x -= size.x * 0.02;
      box.min.y += size.y * 0.02;
      box.max.y -= size.y * 0.02;
      box.min.z += size.z * 0.02;
      box.max.z -= size.z * 0.02;
      box.expandByPoint(camera.position);
      sceneOrbitClampBox = box;
      // Zoom-out limit: the ray-box EXIT distance from the
      // pivot through the camera, always >= the authored
      // distance so the initial framing stays reachable.
      const back = camera.position.clone().sub(controls.target).normalize();
      const exit = box.containsPoint(controls.target) ? new THREE.Ray(controls.target.clone(), back).intersectBox(box, new THREE.Vector3()) : null;
      controls.maxDistance = exit ? controls.target.distanceTo(exit) : d * 4;
      // Captures setup distance + ball radius for the fit-to-
      // ball fov. Radius = HALF the largest AABB extent, not
      // Box3.getBoundingSphere() (which framed ~1.7x too far).
      let fitCenter = null,
        fitRadius = null;
      if (mesh) {
        mesh.updateMatrixWorld(true);
        const bb = new THREE.Box3().setFromObject(mesh);
        fitCenter = bb.getCenter(new THREE.Vector3());
        const bs = bb.getSize(new THREE.Vector3());
        fitRadius = Math.max(bs.x, bs.y, bs.z) / 2;
      } else if (sphere) {
        fitCenter = sphere.center;
        fitRadius = sphere.radius;
      }
      sceneOrbitFitRadius = fitRadius;
      sceneOrbitFitDist = fitCenter ? camera.position.distanceTo(fitCenter) : null;
      recomputeCameraFov();
      camera.updateProjectionMatrix();
      // Snapshot for resetCamera(): position0/target0 now
      // hold the authored pose + derived pivot, so
      // controls.reset() restores this exact framing.
      controls.saveState();
    }
    const vp = new THREE.Matrix4();
    // Hoisted above the first material apply: applyMaterialInternal
    // calls this after every swap, and animate() calls it every
    // frame. The guard is defensive only.
    const setUniforms = () => {
      if (!mesh || !uniforms) return;
      mesh.updateMatrixWorld();
      camera.updateMatrixWorld();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      uniforms.u_worldMatrix.value.copy(mesh.matrixWorld);
      vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      uniforms.u_viewProjectionMatrix.value.copy(vp);
      uniforms.u_worldInverseTransposeMatrix.value.copy(mesh.matrixWorld).invert().transpose();
      camera.getWorldPosition(uniforms.u_viewPosition.value);
    };

    // ------------------------------------------------------
    // bindMaterialUniforms: builds a FRESH uniforms object
    // for ONE material apply, reading the shell-level env
    // state fetched once above rather than re-fetching. Returns
    // the object; does not touch the shell `uniforms` binding.
    // ------------------------------------------------------
    const bindMaterialUniforms = srcs => {
      const {
        vs,
        fs,
        introspected
      } = srcs;
      // MaterialX-generated shaders expect their own attribute
      // names (i_position, i_normal, ...) and u_* transform
      // uniforms, so we use RawShaderMaterial and feed both manually.
      const newUniforms = {
        u_worldMatrix: {
          value: new THREE.Matrix4()
        },
        u_viewProjectionMatrix: {
          value: new THREE.Matrix4()
        },
        u_worldInverseTransposeMatrix: {
          value: new THREE.Matrix4()
        },
        u_viewPosition: {
          value: new THREE.Vector3()
        },
        // Depth-peel uniforms (see injectPeelDiscard's header
        // comment above) — declared on EVERY material
        // regardless of FORCE_TRANSPARENCY/hwTransparency, since
        // the shader itself always declares them now.
        // u_peelMode defaults to 0 (normal path, discard
        // block inert); renderFrame() (createMtlxRenderView)
        // flips these per-pass when peeling is active. The
        // two sampler uniforms default to a dummy texture so
        // they're never left pointing at "nothing" even
        // though they're only ever sampled while
        // u_peelMode != 0. u_opaqueDepth defaults to WHITE
        // (depth==1.0/far) — a stale/missing binding then
        // reads as "nothing there", so `z >= _opaqueZ` never
        // spuriously discards (see getDummyTexWhite's header
        // comment). u_peelPrevDepth keeps the BLACK default
        // (depth==0.0) for the same fail-safe reason on its
        // own `z <= _prevZ + eps` comparison.
        u_peelMode: {
          value: 0
        },
        u_peelHasPrev: {
          value: 0
        },
        u_peelPrevDepth: {
          value: getDummyTex()
        },
        u_opaqueDepth: {
          value: getDummyTexWhite()
        },
        // Lets encodeDisplay's epilogue defer to finalMat
        // when linear peel compositing is available (see
        // the hoisted peelLinearOk const, above allocPeel).
        u_peelLinear: {
          value: peelLinearOk ? 1 : 0
        }
      };

      // GLSL ES 3.0 forbids uniform initializers, so the app
      // must upload each default — an unset uniform reads as
      // 0 in WebGL, which blacked out every unlit/PBR preview.
      applyIntrospectedUniformDefaults(newUniforms, introspected);
      if (DEBUG_SHADERS) {
        console.log('introspected uniforms:', introspected.map(u => `${u.type} ${u.name}${u.data != null ? ' (default uploaded)' : ''}`));
        if (!introspected.length) {
          console.warn('Shader introspection found NO uniform blocks — defaults not uploaded; expect black. (Binding API mismatch — report the mxShader/stage method names used by generatePreviewSourcesUnlocked.)');
        }
      }

      // Discover what the generated shader actually declares,
      // so we bind by real names rather than assumptions.
      const declared = parseUniforms(fs).concat(parseUniforms(vs));
      const declaredNames = new Set(declared.map(u => u.name));
      const has = n => declaredNames.has(n);
      // Finds a declared sampler by pattern, ALWAYS anchored
      // to /env/i first — without it, a material sampler
      // named e.g. "specular" could false-match (a real past bug).
      const findSampler = re => declared.find(u => /sampler/i.test(u.type) && /env/i.test(u.name) && re.test(u.name));
      if (DEBUG_SHADERS) {
        console.group(`MaterialX preview: ${label}`);
        console.log('kind:', debugKind, 'needsLighting:', needsLighting);
        console.log('declared uniforms:', declared.map(u => `${u.type} ${u.name}`));
        console.log('VERTEX SHADER\n', vs);
        console.log('PIXEL SHADER\n', fs);
        console.groupEnd();
      }

      // Image-based lighting: binds the already-fetched,
      // shell-level env textures to whatever sampler names
      // THIS shader uses, matched loosely against version drift.
      if (needsLighting) {
        const radSampler = findSampler(/radiance|specular|prefilter/i);
        const irrSampler = findSampler(/irradiance|diffuse/i);
        if (radSampler) newUniforms[radSampler.name] = {
          value: envRadiance
        };
        if (irrSampler) newUniforms[irrSampler.name] = {
          value: envIrradiance
        };
        // Captured so the view-handle's setEnvironment()/
        // setEnvRotation()/setEnvExposure() methods below can
        // live-swap/mutate the right uniforms after creation.
        envRadSamplerName = radSampler && radSampler.name;
        envIrrSamplerName = irrSampler && irrSampler.name;
        // +90° Y is the official viewer's fixed base; the
        // user's rotation adds on top — seeded from
        // envRotationRad (not 0) so a material swap preserves it.
        if (has('u_envMatrix')) newUniforms.u_envMatrix = {
          value: new THREE.Matrix4().makeRotationY(Math.PI / 2 + envRotationRad)
        };
        if (has('u_envRadianceMips')) newUniforms.u_envRadianceMips = {
          value: envMips
        };
        if (has('u_envRadianceSamples')) newUniforms.u_envRadianceSamples = {
          value: 16
        };
        // Seeded from envExposure (not a literal 1.0) so a
        // material swap PRESERVES whatever exposure the
        // user already dialed in via setEnvExposure().
        if (has('u_envLightIntensity') && !newUniforms.u_envLightIntensity) newUniforms.u_envLightIntensity = {
          value: envExposure
        };
        // Generated ESSL declares u_refractionTwoSided, not
        // u_refractionEnv — matches the official viewer's binding.
        if (has('u_refractionTwoSided')) newUniforms.u_refractionTwoSided = {
          value: true
        };
        // Direct lights = rig (fixed) + auto-extracted env
        // key light (rotates live) — ALWAYS bound at a FIXED
        // length (rigCount+1, see getMxEnv's
        // hwMaxActiveLightSources) so later updates can
        // mutate values in place without a rebuild.
        const nLights = rigCount + (envKeyLight ? 1 : 0);
        if (has('u_numActiveLightSources')) newUniforms.u_numActiveLightSources = {
          value: nLights
        };
        if (has('u_lightData')) newUniforms.u_lightData = {
          value: currentLights(lightData, envKeyLight, envRotationRad)
        };
        if (DEBUG_SHADERS) {
          console.log('env bound → radiance:', radSampler && radSampler.name, '| irradiance:', irrSampler && irrSampler.name, envHasFile ? envPrefilteredIrr ? '(radiance + prefiltered irradiance files)' : '(radiance file; irradiance SH-synthesized)' : '(synthesized)', '| direct lights:', nLights, '(rig ' + rigCount + ' + key ' + (envKeyLight ? 1 : 0) + ')');
          const envUnbound = declared.filter(u => /sampler/i.test(u.type) && /env/i.test(u.name) && !newUniforms[u.name]);
          if (envUnbound.length) mtlxWarn('UNBOUND env samplers (likely cause of black):', envUnbound.map(u => u.name));
        }
      }
      return newUniforms;
    };

    // syncMeshMaterialMode — derives the mesh material's
    // blend/depth flags from viewIsTransparent/
    // FORCE_TRANSPARENCY, in place (no shader rebuild — the
    // peel discard block is baked into every shader
    // unconditionally, see injectPeelDiscard). Called at the
    // end of every applyMaterialInternal and from the
    // handle's refreshRenderMode. `material.transparent`
    // stays FALSE either way: Force Transparency ON drives
    // translucency entirely through renderFrame()'s
    // peel/composite passes, never three.js's own blend
    // state (mixing the two would double-blend and corrupt
    // the peel discard's depth comparisons). u_peelMode is
    // left at 0 here; renderFrame() raises it only for the
    // duration of its peel loop.
    // Tracks the last blending mode APPLIED to the CURRENT
    // material (reset to null on every material swap below, see
    // applyMaterialInternal) so needsUpdate only fires on an
    // actual change, not on every call (e.g. every animate() tick).
    let lastAppliedBlendingMode = null;
    const syncMeshMaterialMode = () => {
      if (!material) return;
      const peelOn = viewIsTransparent && FORCE_TRANSPARENCY;
      // Idempotent transition (renderFrame's own check below is
      // the other call site) — flips scene built-ins' toneMapped.
      const wantLinear = peelOn && peelLinearOk;
      if (sceneLinearOn !== wantLinear) {
        setSceneLinear(wantLinear);
        sceneLinearOn = wantLinear;
      }
      const blending = peelOn ? THREE.NoBlending : THREE.NormalBlending;
      material.blending = blending;
      material.transparent = false;
      material.depthTest = true;
      material.depthWrite = true;
      if (material.uniforms && material.uniforms.u_peelMode) material.uniforms.u_peelMode.value = 0;
      if (lastAppliedBlendingMode !== blending) {
        material.needsUpdate = true;
        lastAppliedBlendingMode = blending;
      }
    };

    // ------------------------------------------------------
    // applyMaterialInternal: builds a new RawShaderMaterial
    // from `srcs` and swaps it onto the shell's mesh IN PLACE
    // (no renderer/scene/camera recreation). On a compile
    // error, restores the OLD material/uniforms and disposes
    // the bad one BEFORE throwing — see the badProg branch below.
    // ------------------------------------------------------
    const applyMaterialInternal = (srcs, applyLabel) => {
      const newUniforms = bindMaterialUniforms(srcs);
      // Transparency verdict is srcs.transparent, gated on
      // FORCE_TRANSPARENCY. When on, translucency is produced
      // by renderFrame()'s depth-peel passes (syncMeshMaterialMode,
      // above), not three.js blend state — STRAIGHT alpha
      // (MaterialX's own epilogue) either way, so do NOT set
      // premultipliedAlpha here.
      // Mirror the raw (pre-FORCE_TRANSPARENCY-gated) verdict
      // onto the shell — see viewIsTransparent's declaration
      // above for why renderFrame() needs this shell-local
      // copy rather than reading handle.isTransparent.
      viewIsTransparent = !!srcs.transparent;
      const newMaterial = new THREE.RawShaderMaterial({
        vertexShader: srcs.vs,
        fragmentShader: srcs.fs,
        glslVersion: THREE.GLSL3,
        uniforms: newUniforms,
        side: THREE.DoubleSide,
        // Neutral literals: syncMeshMaterialMode() below is the
        // real source of truth and overwrites both immediately.
        transparent: false,
        depthWrite: true
      });

      // Stash the outgoing material/uniforms so a compile
      // failure below can restore them, making the swap a
      // no-op from the outside. Both are null on the first build.
      const oldMaterial = material;
      const oldUniforms = uniforms;
      material = newMaterial;
      uniforms = newUniforms;
      // Fresh material object — no blending mode has been
      // applied to it yet, so syncMeshMaterialMode() below
      // must treat this as a first application.
      lastAppliedBlendingMode = null;
      if (!mesh) {
        // First call for this shell: create the mesh and
        // add it to the shell-level scene. Every later
        // call just reassigns mesh.material below.
        mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
      } else {
        mesh.material = material;
      }

      // Compile now and surface any GLSL error to the UI
      // instead of a silent black canvas. Filters benign
      // ANGLE/fxc X4008 warnings — see compileFilteringDriverNoise.
      setUniforms();

      // [mtlx-perf] timing for renderer.compile() alone.
      // With the pre-warm completed beforehand, this is
      // typically an ANGLE cache hit (~15-25ms) vs. 2.5-2.9s cold.
      const __compilePerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
      compileFilteringDriverNoise(renderer, scene, camera);
      if (window.MTLX_PERF_LOG) {
        console.log('[mtlx-perf] GL compile: ' + (performance.now() - __compilePerfStart).toFixed(1) + 'ms (target: ' + applyLabel + ')');
      }
      const badProg = (renderer.info.programs || []).find(p => p.diagnostics && p.diagnostics.runnable === false);
      if (badProg) {
        // LOAD-BEARING ORDER: restore OLD material/uniforms
        // FIRST, then dispose the BAD one — reordering this
        // leaves the bad program in renderer.info.programs forever.
        mesh.material = oldMaterial;
        material = oldMaterial;
        uniforms = oldUniforms;
        newMaterial.dispose();
        const d = badProg.diagnostics;
        const log = (d.programLog || '') + '\n' + (d.fragmentShader && d.fragmentShader.log ? 'FRAG: ' + d.fragmentShader.log : '') + (d.vertexShader && d.vertexShader.log ? ' VERT: ' + d.vertexShader.log : '');
        console.error('MaterialX shader compile error:', log);
        throw new Error(`Shader compile error for "${applyLabel}". See console. ${log.slice(0, 160)}`);
      }

      // Success: the swap stuck — the OLD material/program
      // is no longer needed (null on the very first build,
      // when there's nothing to dispose).
      if (oldMaterial) oldMaterial.dispose();

      // Land the new material in the correct render mode
      // (opaque vs. depth-peel raw-write) right away — this
      // runs on the VERY FIRST build too (see this
      // function's header comment on why first-build and
      // every later edit share this one code path), which
      // is what makes an already-persisted Force
      // Transparency setting take effect immediately
      // without waiting for a toggle event from the
      // Settings dialog.
      syncMeshMaterialMode();
    };

    // First build: routes through the exact same helper every
    // later applyMaterial() call uses, throwing the same styled
    // Error on failure — identical to today's first-build path.
    applyMaterialInternal({
      vs,
      fs,
      introspected,
      transparent
    }, label);

    // Contact-shadow casters, only when a studioGroup exists
    // to receive them. Full-scene mode has no catcher, so
    // `mesh`/sceneGroup meshes there are left untouched.
    if (studioGroup) {
      // Only the MaterialX surface casts. The simple GLB's
      // neutral parts are left out of the shadow system while
      // the black-room bug is still open, see the diag below.
      if (mesh) mesh.castShadow = true;
      // Silhouette bottom, not the bounding-sphere bottom:
      // normalizeGeometry puts sphere at y=-1 but cube at
      // about y=-0.577, so a fixed floor would leave the cube hovering.
      let floorY = -1;
      try {
        const box = new THREE.Box3().setFromObject(sceneGroup || mesh);
        if (isFinite(box.min.y)) floorY = box.min.y;
      } catch (e) {/* degenerate/empty box - keep the -1 fallback */}
      studioGroup.position.y = floorY;
    }

    // TEMPORARY DIAGNOSTIC, remove once the black-room bug is
    // found. Dumps the lighting inputs the neutral glTF
    // materials depend on, on every view build.
    try {
      const neutrals = [];
      if (sceneGroup) {
        sceneGroup.traverse(o => {
          if (o.isMesh && o !== mesh && o.material && 'envMapIntensity' in o.material) {
            neutrals.push({
              name: o.name,
              intensity: o.material.envMapIntensity,
              hasEnvMap: !!o.material.envMap,
              visible: o.visible,
              color: o.material.color && o.material.color.getHexString(),
              map: o.material.map ? {
                w: o.material.map.image && o.material.map.image.width,
                h: o.material.map.image && o.material.map.image.height,
                v: o.material.map.version
              } : null
            });
          }
        });
      }
      const envTex = scene.environment;
      console.log('[mtlx-studio-diag]', JSON.stringify({
        geom: geomName,
        sceneMode,
        backdrop: backdropMode,
        studioGroup: !!studioGroup,
        shadowsOn: renderer.shadowMap.enabled,
        shadowType: renderer.shadowMap.type,
        sceneEnvironment: envTex ? {
          uuid: envTex.uuid.slice(0, 8),
          w: envTex.image && envTex.image.width,
          h: envTex.image && envTex.image.height
        } : null,
        pmremRT: !!pmremRT,
        envRadiance: !!envRadiance,
        envExposure,
        neutralCount: neutrals.length,
        neutrals: neutrals.slice(0, 4),
        // The load-bearing ones: a PMREM target is GPU-only, so it
        // can exist with no content if it lost the renderer that made it.
        renderersOnCanvas: canvas.__mtlxRendererCount,
        contextLost: renderer.getContext().isContextLost(),
        envIsRenderTarget: !!(envTex && envTex.isRenderTargetTexture),
        envHasCpuData: !!(envTex && envTex.image && envTex.image.data),
        envVersion: envTex && envTex.version,
        memory: JSON.parse(JSON.stringify(renderer.info.memory))
      }));
    } catch (e) {
      console.log('[mtlx-studio-diag] failed', e && e.message);
    }

    // ------------------------------------------------------
    // freePeel — release this view's depth-peel GPU resources
    // (render targets, their depth textures, the fullscreen-
    // quad geometry, and the two composite materials) and
    // null out `peel`. Idempotent-safe to call whenever `peel`
    // might or might not be allocated — every call site below
    // guards with `if (peel)` first. Called by allocPeel
    // (below, to free a stale size before reallocating), by
    // syncSize on every resize, by the handle's
    // refreshRenderMode when peeling turns off, and by
    // disposePartial at final teardown.
    // ------------------------------------------------------
    const freePeel = () => {
      if (!peel) return;
      [peel.opaqueRT, peel.peelA, peel.peelB, peel.accumRT].forEach(rt => {
        if (!rt) return;
        rt.dispose();
        if (rt.depthTexture) rt.depthTexture.dispose();
      });
      if (peel.quadMesh && peel.quadMesh.geometry) peel.quadMesh.geometry.dispose();
      if (peel.underMat) peel.underMat.dispose();
      if (peel.finalMat) peel.finalMat.dispose();
      peel = null;
    };
    // Publish to the outer-scope binding (see its declaration
    // above `peel`) so disposePartial and every other call
    // site resolve the SAME function, regardless of scope.
    freePeelFn = freePeel;

    // ------------------------------------------------------
    // allocPeel(w, h) — (re)build every GPU resource the
    // depth-peel render graph (renderFrame, below) needs at
    // drawing-buffer size (w, h):
    //   - opaqueRT: the OPAQUE scene's depth (u_opaqueDepth in
    //     injectPeelDiscard, rejecting peeled fragments behind
    //     solid geometry); color is unused UNLESS peelLinearOk,
    //     where it also holds the merged linear-opaque color
    //     finalMat composites onto the screen (renderFrame step 1).
    //   - peelA/peelB: a ping-ponged pair, each with its OWN
    //     depth texture, used to rasterize one transparent
    //     layer at a time (renderFrame step 4) — ping-ponging
    //     is what lets layer N's discard compare against
    //     layer N-1's depth (u_peelPrevDepth) without the two
    //     layers fighting over one shared depth buffer.
    //   - accumRT: the running under-composite accumulation
    //     buffer (rgb = premultiplied color, a = remaining
    //     transmittance) — see renderFrame's header comment
    //     for the exact blend-factor math.
    //   - a minimal fullscreen-quad scene/camera/mesh, reused
    //     for BOTH the per-layer under-composite and the
    //     final accum-over-opaque composite (quadMesh.material
    //     is swapped between underMat/finalMat per use).
    // NearestFilter everywhere: injectPeelDiscard's depth
    // comparisons use texelFetch at the exact source pixel;
    // underMat/finalMat sample color via texture() (1:1 UV-to-
    // texel, so linear filtering would still be wasted work).
    // Always frees any existing `peel` first — this is the
    // ONLY allocation path, called from renderFrame on a size
    // mismatch.
    // ------------------------------------------------------
    const allocPeel = (w, h) => {
      freePeelFn();
      const mkColorDepthTarget = half => {
        const rt = new THREE.WebGLRenderTarget(w, h, Object.assign({
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          depthBuffer: true,
          stencilBuffer: false
        }, half ? {
          type: THREE.HalfFloatType
        } : {}));
        rt.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
        rt.depthTexture.minFilter = THREE.NearestFilter;
        rt.depthTexture.magFilter = THREE.NearestFilter;
        return rt;
      };
      // peelA/peelB go HalfFloat when peelLinearOk: the preview
      // shader's epilogue is gated off during peel/tail passes
      // (see encodeDisplay), so these hold straight-alpha LINEAR
      // HDR color. On devices lacking EXT_color_buffer_float
      // they stay RGBA8: the epilogue runs as normal there, so
      // materials self-encode to display-ready [0,1] color and
      // 8-bit storage loses nothing perceptible — this also
      // sidesteps float-format COLOR attachments not being
      // unconditionally renderable in WebGL2. opaqueRT stays
      // RGBA8 when NOT peelLinearOk (only its depth texture is
      // read); when peelLinearOk it ALSO carries the merged
      // opaque pass's linear HDR color (renderFrame step 1),
      // read by finalMat's composite alongside accumRT.
      const opaqueRT = mkColorDepthTarget(peelLinearOk);
      const peelA = mkColorDepthTarget(peelLinearOk);
      const peelB = mkColorDepthTarget(peelLinearOk);
      // accumRT shares the peelLinearOk gate above: premultiplied
      // LINEAR color/transmittance in HalfFloat when available
      // (finalMat applies the display transform once, at
      // composite time), else premultiplied display-encoded
      // color in RGBA8, matching the peel layers' fallback.
      const accumRT = new THREE.WebGLRenderTarget(w, h, Object.assign({
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        stencilBuffer: false
      }, peelLinearOk ? {
        type: THREE.HalfFloatType
      } : {}));
      const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const quadScene = new THREE.Scene();
      const quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
      quadScene.add(quadMesh);

      // underMat: under-composites ONE peeled layer into
      // accum. accum starts at (0,0,0,1) — a==1 means "100%
      // transmittance, nothing occluded yet". Blend factors
      // (see renderFrame's header comment for the full
      // derivation): RGB=(DstAlpha,One) adds T*a*color to
      // accum.rgb; ALPHA=(Zero,OneMinusSrcAlpha) multiplies
      // accum.a by (1-a), i.e. T *= (1-a). Do NOT change
      // these factors without re-deriving the math.
      const underMat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: 'in vec3 position;\n' + 'in vec2 uv;\n' + 'out vec2 vUv;\n' + 'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }\n',
        fragmentShader: 'precision highp float;\n' + 'in vec2 vUv;\n' + 'out vec4 o;\n' + 'uniform sampler2D tLayer;\n' + 'void main(){ vec4 c = texture(tLayer, vUv); o = vec4(c.rgb * c.a, c.a); }\n',
        uniforms: {
          tLayer: {
            value: null
          }
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.DstAlphaFactor,
        blendDst: THREE.OneFactor,
        blendEquationAlpha: THREE.AddEquation,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor
      });

      // finalMat: composites the finished accum buffer over
      // whatever is already on screen (the opaque pass from
      // renderFrame step 1). RGB=(One,SrcAlpha) yields
      // screen' = accum.rgb + T*screen (accum.a IS the
      // remaining transmittance T at this point); ALPHA=
      // (OneMinusSrcAlpha,SrcAlpha) writes DESTINATION alpha
      // as (1-T) + T*dstA, so the canvas itself ends up with
      // correct coverage — without this the browser
      // composites the transparent object away over the
      // page since the canvas's own alpha stayed at 0.
      // When peelLinearOk, accum.rgb is linear HDR and tOpaque
      // (opaqueRT, also linear HDR now — see allocPeel) is
      // folded in HERE, so the whole frame gets ACES+sRGB
      // (ACES_SRGB_GLSL, shared with encodeDisplay) exactly
      // ONCE; the result NoBlending-replaces the canvas — no
      // separate opaque screen draw, no double-encoding.
      // Otherwise accum is already display-encoded opaque+
      // transparent composited via three's own blend state,
      // same as before (plain passthrough + CustomBlending).
      const finalMat = new THREE.RawShaderMaterial(Object.assign({
        glslVersion: THREE.GLSL3,
        vertexShader: 'in vec3 position;\n' + 'in vec2 uv;\n' + 'out vec2 vUv;\n' + 'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }\n',
        fragmentShader: peelLinearOk ? 'precision highp float;\n' + 'in vec2 vUv;\n' + 'out vec4 o;\n' + 'uniform sampler2D tAccum;\n' + 'uniform sampler2D tOpaque;\n' + 'void main(){\n' + '    vec4 a = texture(tAccum, vUv);\n' + '    vec4 op = texture(tOpaque, vUv);\n' + '    vec3 lin = a.rgb + a.a * op.rgb;\n' + ACES_SRGB_GLSL('lin', 'encv') + '    float outA = (1.0 - a.a) + a.a * op.a;\n' + '    o = vec4(encv, outA);\n' + '}\n' : 'precision highp float;\n' + 'in vec2 vUv;\n' + 'out vec4 o;\n' + 'uniform sampler2D tAccum;\n' + 'void main(){ vec4 a = texture(tAccum, vUv); o = vec4(a.rgb, a.a); }\n',
        uniforms: peelLinearOk ? {
          tAccum: {
            value: null
          },
          tOpaque: {
            value: null
          }
        } : {
          tAccum: {
            value: null
          }
        },
        depthTest: false,
        depthWrite: false
      }, peelLinearOk ? {
        // Full-screen replace: compositing is already done
        // in-shader above, so no GL blending against the canvas.
        transparent: false,
        blending: THREE.NoBlending
      } : {
        transparent: true,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.SrcAlphaFactor,
        blendEquationAlpha: THREE.AddEquation,
        blendSrcAlpha: THREE.OneMinusSrcAlphaFactor,
        blendDstAlpha: THREE.SrcAlphaFactor
      }));
      peel = {
        w,
        h,
        opaqueRT,
        peelA,
        peelB,
        accumRT,
        quadScene,
        quadCam,
        quadMesh,
        underMat,
        finalMat
      };
      // Precompiles both composite-quad programs (quadMesh
      // starts with material=null, so each must be attached
      // before its own compile() call) — first peeling frame
      // then never hitches on lazy shader compilation.
      quadMesh.material = underMat;
      renderer.compile(quadScene, quadCam);
      quadMesh.material = finalMat;
      renderer.compile(quadScene, quadCam);
    };

    // ------------------------------------------------------
    // renderFrame — the ONE render entry point for this view,
    // called by animate() below and by the handle's
    // snapshot(). Byte-identical to the pre-feature
    // `renderer.render(scene, camera)` whenever depth peeling
    // isn't active for this frame (peelActive false) — no
    // extra render targets, no visibility churn, nothing —
    // so the feature being OFF (this material's own
    // hwTransparency verdict is opaque, or Force Transparency
    // itself is off) costs nothing beyond this one extra
    // boolean check.
    //
    // When peeling IS active, this runs a 6-pass
    // front-to-back order-independent-transparency graph.
    // Isolation between the opaque scene and the transparent
    // `mesh` is done with plain `.visible` toggling —
    // NOT three.js render layers (camera.layers/
    // object.layers). An earlier version used layers and it
    // was NOT reliable at excluding `mesh` from the opaque
    // pass (root-caused as the reason a Force-Transparency
    // material was rendering fully solid — layers apparently
    // weren't isolating it the way object-visibility does);
    // `.visible` is a hard, unambiguous per-object skip in
    // r128's render-list build, so it's used everywhere below
    // instead.
    //   1+2. opaque scene -> screen AND -> opaqueRT (mesh.visible
    //      forced false for both, then restored) so opaqueRT's
    //      depthTexture can gate the peel passes (a peeled
    //      fragment behind solid geometry must never show).
    //      When peelLinearOk, these two draws MERGE into one:
    //      opaqueRT alone, holding LINEAR HDR color (scene
    //      built-ins detoned via setSceneLinear, RT encoding
    //      skips sRGB) — no separate screen draw; finalMat
    //      (step 5) composites it onto the canvas instead. No
    //      MSAA for the merged case (default-framebuffer-only),
    //      matching the already non-MSAA peel silhouettes; a
    //      multisample RT + resolve is a possible future fix.
    //   3. clear accumRT to (0,0,0,1) — a=1 means "nothing
    //      occluded yet" (full transmittance).
    //   4. every OTHER mesh in the scene is hidden (mesh
    //      itself restored to visible first), isolating
    //      `mesh` alone; for each of PEEL_LAYERS nearest
    //      layers: render `mesh` with u_peelMode=1 —
    //      injectPeelDiscard's guard rejects anything behind
    //      the opaque scene AND anything at/in-front-of the
    //      PREVIOUS peeled layer, so each pass resolves
    //      exactly the next-nearest surface — then
    //      under-composite that layer's color into accumRT
    //      (see underMat's header comment for the
    //      blend-factor derivation).
    //   4.5. tail pass: everything deeper than the LAST peel
    //      layer (u_peelMode=2) is captured in one extra draw,
    //      still isolated from other meshes, straight into
    //      accumRT (not through underMat's quad — the shader's
    //      own mode-2 epilogue premultiplies instead, see
    //      injectPeelDiscard). `mesh`'s material is temporarily
    //      switched to underMat's exact under-blend factors,
    //      then restored. Without this, anything past
    //      PEEL_LAYERS silently vanishes instead of just
    //      losing precision. Every hidden mesh is restored
    //      afterward and u_peelMode dropped back to 0 (see
    //      syncMeshMaterialMode's header comment on why it's
    //      kept inert outside this loop).
    //   5. composite accumRT over the already-opaque screen
    //      (see finalMat's header comment).
    // GL state (autoClear, clear color/alpha, render target,
    // u_peelMode, hidden-mesh visibility) is saved before and
    // restored in a finally block, so a peeling frame leaves
    // no observable side effect on anything downstream even if
    // a pass above throws.
    // ------------------------------------------------------
    // Reused every peeling frame instead of a fresh array per
    // call — reset via .length=0 below.
    const __peelHidden = [];
    const renderFrame = () => {
      const peelActive = FORCE_TRANSPARENCY && viewIsTransparent && !!mesh;
      // Idempotent transition (syncMeshMaterialMode is the
      // other call site) — flips scene built-ins' toneMapped.
      const wantLinear = peelActive && peelLinearOk;
      if (sceneLinearOn !== wantLinear) {
        setSceneLinear(wantLinear);
        sceneLinearOn = wantLinear;
      }
      if (!peelActive) {
        renderer.render(scene, camera);
        return;
      } // byte-identical to the old path

      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      if (!peel || peel.w !== size.x || peel.h !== size.y) allocPeel(size.x, size.y);
      const prevAutoClear = renderer.autoClear;
      const prevClearColor = renderer.getClearColor(new THREE.Color());
      const prevClearAlpha = renderer.getClearAlpha();
      renderer.autoClear = false;
      __peelHidden.length = 0;
      try {
        const meshVis = mesh.visible;
        mesh.visible = false;
        if (peelLinearOk) {
          // 1+2 merged: opaque -> opaqueRT only, carrying
          // linear HDR color (alpha 0 where nothing draws)
          // + depth; finalMat composites it onto the
          // screen in step 5, so no screen draw here.
          renderer.setRenderTarget(peel.opaqueRT);
          renderer.setClearColor(prevClearColor, 0);
          renderer.clear(true, true, true);
          renderer.render(scene, camera);
        } else {
          // 1. opaque -> screen (MSAA), transparent mesh hidden
          renderer.setRenderTarget(null);
          renderer.setClearColor(prevClearColor, prevClearAlpha);
          renderer.clear(true, true, true);
          renderer.render(scene, camera);

          // 2. opaque depth -> opaqueRT (mesh still hidden; only .depthTexture is used later)
          renderer.setRenderTarget(peel.opaqueRT);
          renderer.setClearColor(0x000000, 1);
          renderer.clear(true, true, true);
          renderer.render(scene, camera);
        }
        mesh.visible = meshVis;

        // 3. clear accum to (0,0,0,1): rgb = premultiplied color, a = running transmittance T
        renderer.setRenderTarget(peel.accumRT);
        renderer.setClearColor(0x000000, 1);
        renderer.clear(true, false, false);

        // 4. peel PEEL_LAYERS nearest layers of the transparent mesh ONLY.
        //    Isolate it by hiding every OTHER mesh (bulletproof vs. render layers).
        scene.traverse(o => {
          if (o.isMesh && o !== mesh && o.visible) {
            o.visible = false;
            __peelHidden.push(o);
          }
        });
        const mu = mesh.material.uniforms;
        mu.u_peelMode.value = 1;
        mu.u_opaqueDepth.value = peel.opaqueRT.depthTexture;
        let prev = null;
        for (let i = 0; i < PEEL_LAYERS; i++) {
          const curr = i % 2 === 0 ? peel.peelA : peel.peelB;
          mu.u_peelHasPrev.value = i > 0 ? 1 : 0;
          mu.u_peelPrevDepth.value = prev ? prev.depthTexture : getDummyTex();
          renderer.setRenderTarget(curr);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, true, true);
          renderer.render(scene, camera);
          // under-composite this layer's color into accum
          peel.quadMesh.material = peel.underMat;
          peel.underMat.uniforms.tLayer.value = curr.texture;
          renderer.setRenderTarget(peel.accumRT);
          renderer.render(peel.quadScene, peel.quadCam);
          prev = curr;
        }

        // 4.5 tail pass: capture everything deeper than the
        // last peel layer directly (mode 2's shader epilogue
        // premultiplies), under-blended into accumRT with
        // the SAME factors as underMat.
        mu.u_peelMode.value = 2;
        mu.u_peelHasPrev.value = 1;
        mu.u_peelPrevDepth.value = prev ? prev.depthTexture : getDummyTex();
        const tailMat = mesh.material;
        const savedBlending = tailMat.blending;
        const savedBlendEquation = tailMat.blendEquation;
        const savedBlendEquationAlpha = tailMat.blendEquationAlpha;
        const savedBlendSrc = tailMat.blendSrc;
        const savedBlendDst = tailMat.blendDst;
        const savedBlendSrcAlpha = tailMat.blendSrcAlpha;
        const savedBlendDstAlpha = tailMat.blendDstAlpha;
        const savedDepthTest = tailMat.depthTest;
        tailMat.blending = THREE.CustomBlending;
        tailMat.blendEquation = THREE.AddEquation;
        tailMat.blendEquationAlpha = THREE.AddEquation;
        tailMat.blendSrc = THREE.DstAlphaFactor;
        tailMat.blendDst = THREE.OneFactor;
        tailMat.blendSrcAlpha = THREE.ZeroFactor;
        tailMat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
        // accumRT has no depth attachment (depthBuffer:false
        // in allocPeel), so depth test is a no-op either way
        // — disabled explicitly anyway for defensiveness.
        tailMat.depthTest = false;
        renderer.setRenderTarget(peel.accumRT);
        renderer.render(scene, camera);
        tailMat.blending = savedBlending;
        tailMat.blendEquation = savedBlendEquation;
        tailMat.blendEquationAlpha = savedBlendEquationAlpha;
        tailMat.blendSrc = savedBlendSrc;
        tailMat.blendDst = savedBlendDst;
        tailMat.blendSrcAlpha = savedBlendSrcAlpha;
        tailMat.blendDstAlpha = savedBlendDstAlpha;
        tailMat.depthTest = savedDepthTest;
        mu.u_peelMode.value = 0; // leave the material inert outside the peel/tail passes

        __peelHidden.forEach(o => {
          o.visible = true;
        });
        __peelHidden.length = 0;

        // 5. composite accum (+opaqueRT, linear mode) onto the canvas
        renderer.setRenderTarget(null);
        peel.quadMesh.material = peel.finalMat;
        peel.finalMat.uniforms.tAccum.value = peel.accumRT.texture;
        if (peelLinearOk) peel.finalMat.uniforms.tOpaque.value = peel.opaqueRT.texture;
        renderer.render(peel.quadScene, peel.quadCam);
      } finally {
        // restore GL state even if a pass above threw
        renderer.setRenderTarget(null);
        renderer.autoClear = prevAutoClear;
        renderer.setClearColor(prevClearColor, prevClearAlpha);
        if (mesh.material.uniforms && mesh.material.uniforms.u_peelMode) mesh.material.uniforms.u_peelMode.value = 0;
        if (__peelHidden.length) {
          __peelHidden.forEach(o => {
            o.visible = true;
          });
          __peelHidden.length = 0;
        }
      }
    };
    const animate = () => {
      if (stopped || !aliveFn()) return;
      reqId = requestAnimationFrame(animate);
      if (controls) {
        // Before update(): OrbitControls clamps phi in there,
        // so a zoom-out this frame is corrected in the same one.
        applyStudioPolarClamp();
        controls.update(); // damping + autoRotate
        // Scene-orbit hard containment (null elsewhere):
        // the primary floor/side-wall enforcement, since
        // maxDistance is the only OrbitControls-native limit.
        if (sceneOrbitClampBox && !sceneOrbitClampBox.containsPoint(camera.position)) {
          sceneOrbitClampBox.clampPoint(camera.position, camera.position);
          camera.lookAt(controls.target);
        }
      }
      // Paused views must still track camera input (drag/damping);
      // compare's diff mode reads pixels on demand, not via this render.
      if (!isActive()) return;
      if (!controls && fallbackSpin) {
        // OrbitControls script blocked → old behavior.
        // Spins the WHOLE assembled scene when present —
        // rotating just `mesh` would leave the backdrop static.
        (sceneGroup || mesh).rotation.y += 0.005;
      }
      setUniforms();
      renderFrame();
    };
    animate();
    if (window.MTLX_PERF_LOG) {
      console.log('[mtlx-perf] createMtlxRenderView total: ' + (performance.now() - __totalPerfStart).toFixed(1) + 'ms (target: ' + label + ')');
    }
    const handle = {
      uniforms,
      introspected,
      vs,
      fs,
      controls,
      renderer,
      isTransparent: !!transparent,
      // Live auto-orbit toggle (no regen needed). No-op in
      // full-scene mode by contract: every caller hides the rotate
      // button there, and fallbackSpin would rotate the authored scene.
      // Same contract for flat2d: no controls, and fallbackSpin
      // would spin the fullscreen quad.
      setAutoRotate: on => {
        if (fullScene || flat2d) return;
        fallbackSpin = !!on;
        if (controls) controls.autoRotate = !!on;
      },
      // Fullscreen "fit to ball" toggle: keeps the whole shaderball
      // visible while fullscreen, FOV-only (camera position/
      // orientation untouched). No-op outside full-scene mode.
      setFullscreenFit: on => {
        if (!fullScene) return;
        fullscreenFit = !!on;
        recomputeCameraFov();
        camera.updateProjectionMatrix();
      },
      // Resets the camera to this view's default. With OrbitControls,
      // saveState/reset does it uniformly. The graph's fixed-camera
      // full scene and the fixed-ortho 2D buffer have controls ===
      // null — nothing to do there.
      resetCamera: () => {
        if (controls) {
          controls.reset();
          return;
        }
        if (fullScene || flat2d) return;
        camera.position.set(0, 0.5 * (cameraDistance / 3.6), cameraDistance);
        camera.lookAt(0, 0, 0);
      },
      // Current camera pose for URL/state persistence. null when
      // there is no OrbitControls rig (flat2d, fixed full-scene).
      // Rounded to 4 decimals, plenty of precision for a short URL.
      getCamera: () => {
        if (!controls) return null;
        const r4 = n => Math.round(n * 10000) / 10000;
        return {
          position: [camera.position.x, camera.position.y, camera.position.z].map(r4),
          target: [controls.target.x, controls.target.y, controls.target.z].map(r4)
        };
      },
      // Applies a saved pose from getCamera(); invalid input is
      // silently ignored. makeDefault also rebases resetCamera()'s
      // saveState() snapshot onto this pose (default: off).
      setCamera: (pose, makeDefault) => {
        if (!controls || !pose) return false;
        const isVec3 = v => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && isFinite(n));
        if (pose.position !== undefined && !isVec3(pose.position)) return false;
        if (pose.target !== undefined && !isVec3(pose.target)) return false;
        if (pose.position) camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
        if (pose.target) controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
        controls.update();
        // Rebases position0/target0/zoom0 so a later resetCamera()
        // returns HERE instead of the original authored default.
        if (makeDefault) controls.saveState();
        return true;
      },
      // Background switch: 'studio' cyclorama / 'environment'
      // skybox / 'none', see applyBackdrop above. Live, no view
      // rebuild; setup already ran this once for the `backdrop` option.
      setBackdrop: mode => applyBackdrop(mode),
      getBackdrop: () => backdropMode,
      // Thin aliases kept for existing callers, on/off maps onto
      // the same two-mode slice of setBackdrop/getBackdrop.
      setEnvBackground: on => applyBackdrop(on ? 'environment' : 'none'),
      // Pane drags: suspend buffer reallocation so the existing
      // frame just scales, then resync once on release.
      setResizeSuspended: on => {
        const was = resizeSuspended;
        resizeSuspended = !!on;
        if (was && !resizeSuspended) syncSizeRef();
      },
      // Capability, NOT current mode: whether this view has an env
      // texture to show at all. node-preview/graph preview call it
      // once at setup to gate the env control. getBackdrop() is state.
      hasEnvBackground: () => !!envBgTexture,
      // Live rotation offset (radians) for the IBL environment —
      // takes effect next frame via uniform mutation, no rebuild.
      // Also fans out to sceneGroup's patched uEnvRotation uniforms.
      setEnvRotation: rad => {
        if (uniforms.u_envMatrix) {
          uniforms.u_envMatrix.value = new THREE.Matrix4().makeRotationY(Math.PI / 2 + rad);
        }
        envRotationRad = rad;
        // The extracted key light tracks the (clamped) sun's
        // position as the env rotates — rig lights don't.
        updateKeyLightUniformEntry(uniforms, rigCount, envKeyLight, rad);
        // Studio spotlight follows the SAME rotated direction, so
        // the shadow agrees with the highlight; shadow.autoUpdate
        // defaults to true, so the shadow map redraws on its own.
        placeStudioLight();
        // Rotates the visible backdrop mesh to match (a real
        // geometry rotation, not a texture-offset — see bgMesh's
        // declaration above for why offset.x never worked on r128).
        if (bgMesh) bgMesh.rotation.y = BG_BASE + BG_SIGN * rad;
        // Scene-mode neutral parts: mirrors the SAME offset onto
        // every patched material's live uEnvRotation uniform — a
        // call before first compile is a safe no-op, seeded fresh.
        sceneOwnedMaterials.forEach(m => {
          const u = m.userData.envRotationUniform;
          if (u) u.value = envRotationMatrix3(rad);
        });
      },
      // IBL-only exposure multiplier — direct lights are
      // unaffected, but IBL is the dominant light source in these
      // previews so this reads as a full exposure control.
      setEnvExposure: x => {
        if (uniforms.u_envLightIntensity) uniforms.u_envLightIntensity.value = x;
        // Persist onto the shell too: bindMaterialUniforms seeds
        // a NEW material's u_envLightIntensity from envExposure,
        // so a future swap keeps the user's setting, not resetting to 1.0.
        envExposure = x;
        // Scene-mode's sceneGroup meshes are ordinary glTF PBR
        // materials lit via scene.environment/PMREM — their
        // envMapIntensity is the equivalent knob. Skip `mesh`.
        if (sceneGroup) {
          sceneGroup.traverse(obj => {
            if (obj.isMesh && obj !== mesh && obj.material && 'envMapIntensity' in obj.material) {
              obj.material.envMapIntensity = x;
            }
          });
        }
      },
      // Re-derives the material's blend/depth flags from the stored
      // hwTransparency verdict + CURRENT FORCE_TRANSPARENCY, in
      // place — no shader change (syncMeshMaterialMode), so a
      // toggle never needs a rebuild. Broadcast to all live views
      // by setForceTransparency. Also frees this view's depth-peel
      // GPU resources the moment peeling is no longer active —
      // renderFrame() lazily reallocates them (allocPeel) next
      // time they're needed.
      refreshRenderMode: () => {
        syncMeshMaterialMode();
        const peelOn = viewIsTransparent && FORCE_TRANSPARENCY;
        if (!peelOn && peel) freePeelFn();
      },
      // Live-swaps the environment without a shader rebuild — used
      // by the Environment dialog's Import/Reset. Also regenerates
      // scene-mode's PMREM. No-op on views with no lighting/env.
      setEnvironment: env => {
        if (!env) return;
        if (envRadSamplerName && uniforms[envRadSamplerName]) uniforms[envRadSamplerName].value = env.radiance;
        if (envIrrSamplerName && uniforms[envIrrSamplerName]) uniforms[envIrrSamplerName].value = env.irradiance;
        if (uniforms.u_envRadianceMips) uniforms.u_envRadianceMips.value = env.mips;
        // Persist onto the SHELL env state too, not just the
        // current material's uniforms — otherwise a future swap
        // silently reverts to the stale env.
        envRadiance = env.radiance;
        envIrradiance = env.irradiance;
        envMips = env.mips;
        envBgTexture = env.background;
        // New env => possibly a new (or no) key light; refresh the
        // bound uniform entry in place, honoring current rotation.
        envKeyLight = env.keyLight || null;
        updateKeyLightUniformEntry(uniforms, rigCount, envKeyLight, envRotationRad);
        // Same refresh for the shadow: without this the studio light
        // would keep aiming along the PREVIOUS env's key light until
        // the next rotation change.
        placeStudioLight();
        // bgMesh is null for previews with no env — guard so
        // an Import/Reset broadcast (setEnvOverride's LIVE_VIEWS
        // loop) can't throw calling this standalone.
        if (bgMesh) {
          bgMesh.material.map = envBgTexture;
          bgMesh.material.needsUpdate = true;
        }
        // Scene-mode PMREM regen: a PMREM render target is baked
        // from a source texture at generation time — no live-swap
        // API, so rebuild from scratch. try/catch is a pure backstop.
        if (sceneGroup) {
          try {
            const oldPmremRT = pmremRT;
            // Fresh PMREMGenerator, never disposed — disposing
            // one would break every other PMREMGenerator
            // (r128 shares LOD-plane state module-wide).
            pmremRT = new THREE.PMREMGenerator(renderer).fromEquirectangular(env.radiance);
            scene.environment = pmremRT.texture;
            // The OLD render target IS this view's own,
            // ordinary GPU resource — safe to dispose once
            // superseded (unlike the generator that made it).
            if (oldPmremRT) oldPmremRT.dispose();
          } catch (e) {
            console.warn('environment PMREM regeneration failed:', e);
          }
        }
      },
      // Fetches and applies an environment from a URL (decoder
      // chosen by extension, same pipeline as HDR import). Falsy
      // url restores the default; latest call always wins.
      setEnvMap: url => {
        const callId = ++envMapCallId;
        // Applies env to this view via setEnvironment() (rotation/
        // exposure/background all persist there already), then
        // frees whatever WE previously fetched, if superseded.
        const swapIn = (env, owned) => {
          if (callId !== envMapCallId) return; // a newer call already won
          handle.setEnvironment(env);
          if (fetchedEnvMap) disposeFetchedEnv(fetchedEnvMap);
          fetchedEnvMap = owned ? env : null;
        };
        if (!url) {
          if (!fetchedEnvMap) return Promise.resolve(true); // already default
          return getEnvironment().then(def => {
            if (def) swapIn(def, false);
            return true;
          });
        }
        const clean = String(url).split('?')[0].split('#')[0];
        const ext = clean.slice(clean.lastIndexOf('.')).toLowerCase();
        if (ext !== '.hdr' && ext !== '.exr') {
          return Promise.reject(new Error('Unsupported environment URL "' + url + '". Expected .hdr or .exr.'));
        }
        if (ext === '.hdr' && typeof THREE.RGBELoader === 'undefined') {
          return Promise.reject(new Error('RGBELoader unavailable (script blocked/offline). Cannot load .hdr environments.'));
        }
        if (ext === '.exr' && typeof THREE.EXRLoader === 'undefined') {
          return Promise.reject(new Error('EXRLoader unavailable (script blocked/offline). Cannot load .exr environments.'));
        }
        return fetch(url).then(r => {
          if (!r.ok) throw new Error('Failed to fetch environment "' + url + '" (HTTP ' + r.status + ').');
          return r.arrayBuffer();
        }).then(buf => {
          const raw = parseEnvBuffer(buf, ext);
          if (!raw || !raw.image || !raw.image.data) {
            throw new Error('Failed to parse the environment image "' + url + '".');
          }
          swapIn(buildEnvFromParsedTexture(raw), true);
          return true;
        });
      },
      // Applies a new (or already-generated) material into this
      // SAME shell, instead of calling createMtlxRenderView() again.
      // Returns null when superseded/bailed; throws on real compile failure.
      applyMaterial: async ({
        mx,
        gen,
        genContext,
        renderable,
        srcs = null,
        label,
        isMounted = () => true
      }) => {
        const __applyPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
        // `stopped` is disposePartial's flag — an apply arriving
        // after teardown must do nothing, not resurrect GL state
        // on an already-disposed renderer/context.
        if (stopped || !isMounted()) return null;
        if (!srcs) {
          srcs = await generatePreviewSources({
            mx,
            gen,
            genContext,
            renderable,
            label,
            isMounted
          });
        }
        // A thrown generation error is NOT caught here — it
        // propagates like a first-build failure, so the UI shows
        // the same overlay while the old material keeps rendering.
        if (!srcs || !isMounted() || stopped) return null;
        const warmResult = await prewarmShaderCompile({
          vs: srcs.vs,
          fs: srcs.fs,
          isMounted,
          label
        });
        // 'bailed' or a lost isMounted(): must not touch the
        // still-rendering live material — leave it as-is; the
        // superseding call owns the next apply.
        if (warmResult === 'bailed' || !isMounted() || stopped) return null;
        applyMaterialInternal(srcs, label);
        // Updates the handle's public fields IN PLACE: the
        // object-literal shorthand below captures a snapshot,
        // not a live binding, so every swap must re-assign these.
        handle.uniforms = uniforms;
        handle.introspected = srcs.introspected;
        handle.vs = srcs.vs;
        handle.fs = srcs.fs;
        handle.isTransparent = !!srcs.transparent;
        if (window.MTLX_PERF_LOG) {
          console.log('[mtlx-perf] applyMaterial total: ' + (performance.now() - __applyPerfStart).toFixed(1) + 'ms (target: ' + label + ')');
        }
        return handle;
      },
      // PNG snapshot of the CURRENT view. The drawing buffer isn't
      // preserved between frames (preserveDrawingBuffer:false), so
      // render synchronously right before reading it back.
      snapshot: () => {
        setUniforms();
        renderFrame();
        return renderer.domElement.toDataURL('image/png');
      },
      // Reads back the current view at caller-chosen dimensions:
      // syncs a render first, then resamples through a 2D canvas
      // so two compare views can be read at identical sizes.
      // The canvas/context are cached in the closure and only
      // resized when w/h change, instead of allocated per call.
      snapshotPixels: (w, h) => {
        setUniforms();
        renderFrame();
        if (!__snapshotCanvas) {
          __snapshotCanvas = document.createElement('canvas');
          __snapshotCtx = __snapshotCanvas.getContext('2d');
        }
        if (__snapshotCanvas.width !== w || __snapshotCanvas.height !== h) {
          __snapshotCanvas.width = w;
          __snapshotCanvas.height = h;
        }
        // Source is alpha:true, so drawImage's source-over would
        // blend it onto whatever this reused canvas held last —
        // only a size change reallocates (and thus clears) it.
        __snapshotCtx.clearRect(0, 0, w, h);
        __snapshotCtx.drawImage(renderer.domElement, 0, 0, w, h);
        return __snapshotCtx.getImageData(0, 0, w, h);
      },
      // Cheap same-frame render (no readback) — used by camera sync
      // to remove one-frame lag between two mirrored views.
      renderNow: () => {
        setUniforms();
        renderFrame();
      },
      // Wrapped (not disposePartial directly) so dispose() also
      // deregisters the handle from LIVE_VIEWS — otherwise
      // setEnvOverride's broadcast could touch a torn-down view.
      dispose: () => {
        LIVE_VIEWS.delete(handle);
        disposePartial();
      }
    };
    LIVE_VIEWS.add(handle);
    return handle;
  } catch (err) {
    disposePartial();
    throw err;
  }
};

// ---- public API ----
// ------------------------------------------------------------------
// Fullscreen helpers: native requestFullscreen when available; else a
// CSS-maximize fallback (position:fixed + synthesized 'fullscreenchange')
// for hosts that never grant it (VS Code webviews, iframes).
// ------------------------------------------------------------------

// True only when the platform will actually grant a requestFullscreen()
// call. False in VS Code webviews and in iframes lacking allowfullscreen.
const nativeFullscreenAvailable = () => !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);

// Module-level state for the CSS-maximize fallback. null = nothing
// maximized; only one element can be maximized at a time (mirrors
// native semantics — keeps exit() unambiguous).
let cssMaxState = null;

// Saves an element's literal `style` ATTRIBUTE — distinguishing "no
// attribute" from "style=''" — so enter/exit can restore it exactly
// without clobbering framework-authored inline styles (React, etc.).
const cssMaxSaveStyleAttr = node => ({
  node,
  hadAttr: node.hasAttribute('style'),
  value: node.getAttribute('style')
});
const cssMaxRestoreStyleAttr = rec => {
  try {
    if (rec.hadAttr) rec.node.setAttribute('style', rec.value);else rec.node.removeAttribute('style');
  } catch (e) {/* node may have been removed from the DOM meanwhile */}
};

// Whether `cs` would make its element a containing block for — or
// clip — a `position:fixed` descendant: checked per the CSS spec
// (backdrop-filter/transform/filter/perspective/will-change/contain).
const cssMaxComputedIsTrap = cs => {
  try {
    if (cs.backdropFilter && cs.backdropFilter !== 'none') return true;
    if (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none') return true;
    if (cs.transform && cs.transform !== 'none') return true;
    if (cs.filter && cs.filter !== 'none') return true;
    if (cs.perspective && cs.perspective !== 'none') return true;
    if (/transform|filter|perspective/.test(cs.willChange || '')) return true;
    if (/paint|layout|strict|content/.test(cs.contain || '')) return true;
    return false;
  } catch (e) {
    return false;
  }
};

// Exit the current CSS-maximize, restoring everything it touched.
// Called both from toggleFullscreen (user-initiated exit) and from
// the MutationObserver below (auto-exit when el is disconnected).
const exitCssMaximize = () => {
  const state = cssMaxState;
  if (!state) return;
  // Null the module state FIRST, before any teardown below — a
  // re-entrant call (MutationObserver, rapid double toggle) then
  // sees null and is a harmless no-op instead of double-restoring.
  cssMaxState = null;
  try {
    state.domObserver.disconnect();
  } catch (e) {/* already gone */}
  try {
    document.removeEventListener('keydown', state.keyHandler);
  } catch (e) {/* ignore */}
  cssMaxRestoreStyleAttr(state.savedStyle);
  for (const rec of state.savedNeutralized) cssMaxRestoreStyleAttr(rec);
  try {
    document.body.style.overflow = state.savedBodyOverflow;
  } catch (e) {/* ignore */}
  try {
    document.documentElement.style.overflow = state.savedHtmlOverflow;
  } catch (e) {/* ignore */}
  // Same notification channel the native path uses, so watchFullscreen
  // subscribers see this exit exactly like a native fullscreenchange.
  try {
    document.dispatchEvent(new Event('fullscreenchange'));
  } catch (e) {/* ignore */}
};

// Enter CSS-maximize on `el`. Caller (toggleFullscreen) guarantees
// cssMaxState is currently null — only one element maximizes at a time.
const enterCssMaximize = el => {
  try {
    const savedStyle = cssMaxSaveStyleAttr(el);

    // Ancestor neutralization walk: anything between el and <body>
    // that would trap a fixed-position descendant gets its trapping
    // properties inlined away (style attribute saved first, reversible).
    const savedNeutralized = [];
    for (let node = el.parentElement; node; node = node.parentElement) {
      let trap = false;
      try {
        trap = cssMaxComputedIsTrap(getComputedStyle(node));
      } catch (e) {
        trap = false;
      }
      if (!trap) continue;
      savedNeutralized.push(cssMaxSaveStyleAttr(node));
      try {
        node.style.backdropFilter = 'none';
        node.style.webkitBackdropFilter = 'none';
        node.style.transform = 'none';
        node.style.filter = 'none';
        node.style.perspective = 'none';
        node.style.willChange = 'auto';
        node.style.contain = 'none';
      } catch (e) {/* stay defensive even though inline writes rarely throw */}
      if (node === document.body) break;
    }

    // Pins el over the viewport. zIndex 9990 stays below 9999 (body-
    // portaled overlays). Starts below the sticky site header so it
    // stays visible; collapses to full-viewport when the header is hidden.
    try {
      const hdr = document.querySelector('#site-header header');
      const topPx = hdr ? Math.max(0, hdr.getBoundingClientRect().bottom) : 0;
      el.style.position = 'fixed';
      el.style.top = topPx + 'px';
      el.style.left = '0';
      el.style.right = '0';
      el.style.bottom = '0';
      el.style.width = '100%';
      // auto, not 100%: with top offset by topPx AND bottom pinned
      // to 0, height:100% would overflow past the viewport bottom
      // by topPx — auto lets top+bottom do the sizing instead.
      el.style.height = 'auto';
      el.style.maxWidth = 'none';
      el.style.maxHeight = 'none';
      el.style.margin = '0';
      el.style.zIndex = '9990';
      el.style.backgroundColor = '#111827';
    } catch (e) {
      // Couldn't style el at all — nothing was actually maximized,
      // so undo the ancestor neutralization and bail rather than
      // leaving cssMaxState pointing at a half-applied maximize.
      for (const rec of savedNeutralized) cssMaxRestoreStyleAttr(rec);
      return;
    }
    const savedBodyOverflow = document.body.style.overflow;
    const savedHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    // Esc parity with native fullscreen. Bubble phase + document
    // target so it doesn't need to compete with per-widget handlers.
    const keyHandler = e => {
      if (e.key === 'Escape') exitCssMaximize();
    };
    document.addEventListener('keydown', keyHandler);

    // Native fullscreen auto-exits when the element leaves the
    // document; CSS-maximize has no built-in equivalent, so a
    // MutationObserver stands in, else body/html get stuck hidden.
    const domObserver = new MutationObserver(() => {
      if (!document.body.contains(el)) exitCssMaximize();
    });
    domObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
    cssMaxState = {
      el,
      savedStyle,
      savedNeutralized,
      savedBodyOverflow,
      savedHtmlOverflow,
      keyHandler,
      domObserver
    };
    try {
      document.dispatchEvent(new Event('fullscreenchange'));
    } catch (e) {/* ignore */}
  } catch (e) {/* CSS maximize is best-effort; never throw into the caller */}
};
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || (cssMaxState ? cssMaxState.el : null);
// Enter fullscreen on `el`, or exit if anything is fullscreen now.
const toggleFullscreen = el => {
  try {
    if (!nativeFullscreenAvailable()) {
      // CSS-maximize fallback (VS Code webview / no-allowfullscreen
      // iframe). Same "exit whatever's active, else enter on el"
      // shape as the native branch — native parity: never swaps targets.
      if (cssMaxState) exitCssMaximize();else if (el) enterCssMaximize(el);
      return;
    }
    if (fullscreenElement()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) {
        const p = exit.call(document);
        if (p && p.catch) p.catch(() => {});
      }
    } else if (el) {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) {
        const p = req.call(el);
        if (p && p.catch) p.catch(() => {});
      }
    }
  } catch (e) {/* fullscreen can be denied (iframe policy, user gesture) */}
};
// Subscribe to fullscreen changes; cb receives the current fullscreen
// element (or null). Returns an unsubscribe function.
const watchFullscreen = cb => {
  const h = () => cb(fullscreenElement());
  document.addEventListener('fullscreenchange', h);
  document.addEventListener('webkitfullscreenchange', h);
  return () => {
    document.removeEventListener('fullscreenchange', h);
    document.removeEventListener('webkitfullscreenchange', h);
  };
};

// Shared indeterminate loading bar used by the viewer/graph/preview
// views while a shader generates/compiles; injected once from the engine.
(() => {
  if (typeof document === 'undefined' || document.getElementById('mtlx-shared-css')) return;
  const st = document.createElement('style');
  st.id = 'mtlx-shared-css';
  st.textContent = ['.mtlx-loading-bar{position:relative;overflow:hidden;height:6px;border-radius:9999px;background:rgba(75,85,99,.45);}', '.mtlx-loading-bar::after{content:"";position:absolute;top:0;bottom:0;left:0;width:40%;border-radius:9999px;', 'background:linear-gradient(90deg,transparent,#60a5fa,transparent);animation:mtlx-loading-slide 1.1s ease-in-out infinite;}', '@keyframes mtlx-loading-slide{from{transform:translateX(-100%);}to{transform:translateX(350%);}}'].join('');
  document.head.appendChild(st);
})();

// Custom highlight.js theme for the XML "Document" dialog, matching the
// site's dark gray-900/800 + blue-400 palette. Background is explicitly
// transparent so it doesn't paint over the dialog's own panel.
(() => {
  if (typeof document === 'undefined' || document.getElementById('mtlx-hljs-theme')) return;
  const st = document.createElement('style');
  st.id = 'mtlx-hljs-theme';
  st.textContent = ['.hljs{color:#d1d5db;background:transparent;}', '.hljs-tag,.hljs-punctuation{color:#6b7280;}', '.hljs-name{color:#60a5fa;}', '.hljs-attr{color:#9ca3af;}', '.hljs-string{color:#4ade80;}', '.hljs-comment{color:#6b7280;font-style:italic;}'].join('');
  document.head.appendChild(st);
})();
Object.assign(window, {
  getMxEnv,
  DEBUG_SHADERS,
  mtlxWarn,
  mxExclusive,
  getForceTransparency,
  setForceTransparency,
  parseUniforms,
  stripVersion,
  encodeDisplay,
  mxErr,
  mxWriteValue,
  vecToArray,
  mxSafe,
  mxElName,
  mxElCat,
  mxElType,
  mxElAttr,
  mxSetAttr,
  mxRemoveAttr,
  mxSetColorspace,
  nextFrame,
  findConvertChain,
  ensureTypedInput,
  stripValuesFromConnectedInputs,
  listDocRenderables,
  normPath,
  readDroppedItems,
  expandZips,
  findFileForRef,
  resolveIncludes,
  readMtlxText,
  TEXTURE_CACHE,
  textureCacheKey,
  bindDroppedTextures,
  collectMxUniforms,
  mxValueToThreeUniform,
  linToSrgb,
  srgbToLin,
  rgbToHex,
  hexToRgb,
  getFilenameDefaultTexture,
  rebindFilenameDefault,
  configureLoadedTexture,
  prepGeometry,
  normalizeGeometry,
  buildPreviewGeometry,
  COLOR_VIEWABLE,
  resolveNodeKind,
  makeEnvTexture,
  getEnvironment,
  COLORSPACES,
  loadEnvironmentFromFile,
  setEnvOverride,
  getEnvOverride,
  getKeyLightEnabled,
  setKeyLightEnabled,
  createMtlxRenderView,
  tryRefreshRenderView,
  prewarmPreviewTarget,
  checkTargetTransparency,
  EXPORT_TARGETS,
  generateTargetSources,
  fullscreenElement,
  toggleFullscreen,
  watchFullscreen
});