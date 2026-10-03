// Single store for every render/quality setting that used to be scattered
// localStorage reads across the engine, the Scene, and the tool apps.
// Exports window.MtlxRenderSettings. Load before mtlx-engine.js.
(function () {
    'use strict';

    const SURFACES = ['viewer', 'compare', 'docs', 'graph', 'embed', 'scene'];
    const PROFILE_OF = { viewer: 'preview', compare: 'preview', docs: 'preview', graph: 'preview', embed: 'preview', scene: 'stage' };
    const LEVELS = ['performance', 'default', 'quality'];

    // Mirrors the Scene's Render settings tabs (js/usd-scene-app.jsx
    // RENDER_TABS): every surface lists rows in this group order, and
    // each row carries its own `order` within the group.
    const GROUPS = {
        display: { label: 'Display', order: 0 },
        lighting: { label: 'Lighting', order: 1 },
        effects: { label: 'Effects', order: 2 },
        geometry: { label: 'Geometry and Textures', order: 3 },
    };

    const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

    // Loose boolean spellings accepted by the URL query params that predate
    // this store (1/0, true/false, on/off, yes/no, any case); null when
    // unrecognized, mirroring parseBoolFlag in js/mtlx-engine.js.
    const parseBoolFlag = (raw) => {
        const s = String(raw).trim().toLowerCase();
        if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
        if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
        return null;
    };

    // ---- Codecs: reproduce the exact spellings today's readers use. ----
    const CODECS = {
        bool01: {
            decode: (raw) => (raw === '1') ? true : (raw === '0') ? false : undefined,
            encode: (v) => (v ? '1' : '0'),
        },
        boolOn: {
            decode: (raw) => (raw === null || raw === undefined) ? undefined : raw !== '0',
            encode: (v) => (v ? '1' : '0'),
        },
        boolOnlyOne: {
            decode: (raw) => (raw === null || raw === undefined) ? undefined : raw === '1',
            encode: (v) => (v ? '1' : '0'),
        },
        boolTrueFalse: {
            decode: (raw) => (raw === null || raw === undefined || raw.trim() === '') ? undefined : raw !== 'false',
            encode: (v) => String(v !== false),
        },
        number: {
            decode: (raw, P) => {
                if (raw === null || raw === undefined || raw === '') return undefined;
                const n = Number(raw);
                return Number.isFinite(n) ? clamp(n, P.min, P.max) : undefined;
            },
            encode: (v, P) => String(clamp(Number(v) || 0, P.min, P.max)),
        },
        int: {
            decode: (raw, P) => {
                if (raw === null || raw === undefined || raw === '') return undefined;
                const n = Number(raw);
                return Number.isInteger(n) ? clamp(n, P.min, P.max) : undefined;
            },
            encode: (v, P) => String(clamp(Math.round(Number(v) || 0), P.min, P.max)),
        },
        enum: {
            decode: (raw, P) => (P.options && P.options.indexOf(raw) !== -1) ? raw : undefined,
            encode: (v, P) => (P.options && P.options.indexOf(v) !== -1) ? v : P.levels.default,
        },
        // 'original' <-> Infinity; other values validated against P.options.
        sizeOrOriginal: {
            decode: (raw, P) => {
                if (raw === 'original') return Infinity;
                if (raw === null || raw === undefined || raw === '') return undefined;
                const n = Number(raw);
                return (P.options && P.options.indexOf(n) !== -1) ? n : undefined;
            },
            encode: (v) => (v === Infinity ? 'original' : String(Math.round(Number(v)))),
        },
        // Numeric GiB string, validated against P.options.
        gib: {
            decode: (raw, P) => {
                if (raw === null || raw === undefined || raw === '') return undefined;
                const n = Number(raw);
                return (P.options && P.options.indexOf(n) !== -1) ? n : undefined;
            },
            encode: (v) => String(Number(v)),
        },
        // One field of a JSON object stored under P.storage; the rest of
        // the object (other fields, e.g. debugView) is preserved on write.
        jsonField: {
            decode: (raw, P) => {
                if (raw === null || raw === undefined || raw === '') return undefined;
                try {
                    const obj = JSON.parse(raw);
                    if (!obj || typeof obj !== 'object') return undefined;
                    const v = obj[P.field];
                    return v === undefined ? undefined : v;
                } catch (e) { return undefined; }
            },
            encode: (v) => v,
        },
    };

    const validate = (P, value) => {
        switch (P.codec) {
            case 'bool01': case 'boolOn': case 'boolOnlyOne': case 'boolTrueFalse':
                return !!value;
            case 'number':
                return clamp(Number(value) || 0, P.min, P.max);
            case 'int':
                return clamp(Math.round(Number(value) || 0), P.min, P.max);
            case 'enum':
                return (P.options && P.options.indexOf(value) !== -1) ? value : P.levels.default;
            case 'sizeOrOriginal':
                if (value === Infinity || String(value).toLowerCase() === 'original') return Infinity;
                { const n = Number(value); return (P.options && P.options.indexOf(n) !== -1) ? n : P.levels.default; }
            case 'gib':
                { const n = Number(value); return (P.options && P.options.indexOf(n) !== -1) ? n : P.levels.default; }
            case 'jsonField':
                return value;
            default:
                return value;
        }
    };

    // Manifest. P = { storage, field?, codec, legacy?, query?, options?,
    // min?, max?, levels }. Row = { key, label, group, type, apply, ui,
    // profiles: { preview?, stage? }, surfaces, embed?, legacyEvent?, ... }
    const NA = (reason) => ({ na: reason });
    const PLANNED = (phase) => ({ planned: phase });

    const ROWS = [
        {
            key: 'transparency', label: 'Force Transparency', group: 'effects', order: 9, type: 'bool', apply: 'renderMode', ui: true, experimental: true,
            hint: 'Render opacity/transmission with real alpha blending in previews. When off, previews match the standard MaterialX viewer (opaque). Applies immediately to open previews.',
            profiles: {
                preview: { storage: 'mtlxForceTransparency', codec: 'bool01', setter: 'setForceTransparency', levels: { performance: false, default: false, quality: false } },
                stage: { storage: 'mtlxUsdSceneTransparency', codec: 'bool01', legacy: ['mtlxForceTransparency'], levels: { performance: false, default: true, quality: true } },
            },
            surfaces: { viewer: 'yes', compare: 'yes', docs: 'yes', graph: 'yes', embed: 'yes', scene: 'yes' },
            embed: { attr: 'forcetransparency', live: true },
        },
        {
            key: 'displacement', label: 'Displacement', group: 'geometry', order: 3, type: 'bool', apply: 'geometry', ui: true,
            hint: "Moves the mesh by the material's displacement; the material itself is unchanged.",
            profiles: {
                preview: { storage: 'mtlxDisplacement', codec: 'boolOn', query: 'displacement', queryDecode: parseBoolFlag, setter: 'setDisplacementEnabled', levels: { performance: true, default: true, quality: true } },
                stage: { storage: 'mtlxDisplacement', codec: 'boolOn', levels: { performance: false, default: true, quality: true } },
            },
            surfaces: { viewer: 'yes', compare: 'yes', docs: NA("docs previews render a single node's output, so no displacement shader is ever bound"), graph: 'yes', embed: 'yes', scene: 'yes' },
            embed: { attr: 'displacement', live: true },
        },
        {
            key: 'displacementNormals', label: 'Displacement Normals', group: 'geometry', order: 10, type: 'enum', options: ['mesh', 'analytic'], apply: 'geometry', ui: false,
            profiles: {
                preview: { storage: 'mtlxDisplacementNormals', codec: 'enum', options: ['mesh', 'analytic'], query: 'displacementnormals', setter: 'setDisplacementNormalsMode', levels: { performance: 'mesh', default: 'mesh', quality: 'mesh' } },
            },
            surfaces: { viewer: 'yes', compare: 'yes', docs: NA("docs previews render a single node's output, so no displacement shader is ever bound"), graph: 'yes', embed: 'yes', scene: PLANNED('P6') },
        },
        {
            key: 'previewSubdivision', label: 'Subdivision', group: 'geometry', order: 11, type: 'number', min: 0, max: 3, step: 1, apply: 'geometry', ui: true,
            control: 'select', options: [0, 1, 2, 3],
            optionLabels: { 0: 'Off', 1: '1', 2: '2', 3: '3' },
            hint: 'Applied to preview geometry when the material has displacement; each level is 4x triangles, capped at 1.5M.',
            profiles: {
                preview: { storage: 'mtlxPreviewSubdivision', codec: 'int', min: 0, max: 3, query: 'previewsubdivision', setter: 'setPreviewSubdivisionLevel', levels: { performance: 2, default: 2, quality: 2 } },
            },
            surfaces: { viewer: 'yes', compare: 'yes', docs: NA("docs previews render a single node's output, so no displacement shader is ever bound"), graph: 'yes', embed: 'yes', scene: NA('the Scene uses displacementSubdivision') },
            embed: { attr: 'previewsubdivision', live: true },
        },
        {
            key: 'textureAnisotropy', label: 'Texture Anisotropy', group: 'geometry', order: 13, type: 'number', min: 1, max: 16, apply: 'texture', ui: true,
            control: 'select', options: [1, 2, 4, 8, 16],
            hint: 'Anisotropic filtering samples for grazing-angle textures. Higher looks sharper at oblique angles and costs more bandwidth.',
            profiles: {
                preview: { storage: 'mtlx_texture_anisotropy', codec: 'int', min: 1, max: 16, setter: 'setTextureAnisotropy', levels: { performance: 8, default: 8, quality: 8 } },
                stage: { storage: 'mtlx_scene_texture_anisotropy', codec: 'int', min: 1, max: 16, levels: { performance: 8, default: 8, quality: 8 } },
            },
            surfaces: { viewer: 'yes', compare: 'yes', docs: 'yes', graph: 'yes', embed: 'yes', scene: PLANNED('P6') },
        },
        {
            key: 'heightToNormalTexel', label: 'Height-to-Normal Texel Space', group: 'effects', order: 20, type: 'bool', apply: 'regenerate', ui: false, experimental: true,
            profiles: {
                preview: { storage: 'mtlxHeightToNormalTexel', codec: 'bool01', query: 'heightToNormalTexel', queryDecode: (raw) => raw === '1', setter: 'setHeightToNormalTexel', levels: { performance: false, default: false, quality: false } },
                stage: { storage: 'mtlxHeightToNormalTexel', codec: 'bool01', levels: { performance: false, default: false, quality: false } },
            },
            surfaces: { viewer: 'yes', compare: 'yes', docs: 'yes', graph: 'yes', embed: 'yes', scene: 'yes' },
        },
        {
            key: 'diffuseEnv', label: 'Diffuse Environment Method', group: 'effects', order: 10, type: 'enum', options: ['convolve', 'sh'], apply: 'environment', ui: true,
            optionLabels: { convolve: 'Convolve', sh: 'Spherical Harmonics' },
            hint: 'Cosine-convolves the environment instead of a 9 term spherical harmonic fit. More accurate diffuse under small bright lights.',
            profiles: {
                preview: { storage: 'mtlx_diffuse_env', codec: 'enum', options: ['convolve', 'sh'], query: 'diffuseEnv', queryDecode: (raw) => (raw === 'sh' ? 'sh' : 'convolve'), setter: 'setDiffuseEnvMethod', levels: { performance: 'convolve', default: 'convolve', quality: 'convolve' } },
                stage: { storage: 'mtlx_diffuse_env', codec: 'enum', options: ['convolve', 'sh'], levels: { performance: 'convolve', default: 'convolve', quality: 'convolve' } },
            },
            surfaces: { viewer: 'yes', compare: 'yes', docs: 'yes', graph: 'yes', embed: 'yes', scene: 'yes' },
        },
        {
            key: 'displayTransform', label: 'View Transform', group: 'display', order: 0, type: 'enum', options: ['srgb', 'aces', 'neutral', 'lin_rec709'], apply: 'uniform', ui: true,
            optionLabels: { srgb: 'sRGB', aces: 'ACES', neutral: 'Neutral', lin_rec709: 'lin_rec709' },
            hint: 'How the linear render is encoded for display. sRGB matches the official MaterialX viewer (no tone mapping).',
            profiles: {
                preview: { storage: 'mtlx_display_transform', codec: 'enum', options: ['srgb', 'aces', 'neutral', 'lin_rec709'], setter: 'setDisplayTransform', levels: { performance: 'srgb', default: 'srgb', quality: 'srgb' } },
                stage: { storage: 'mtlx_scene_display_transform', codec: 'enum', options: ['srgb', 'aces', 'neutral', 'lin_rec709'], levels: { performance: 'neutral', default: 'neutral', quality: 'neutral' } },
            },
            surfaces: { viewer: 'yes', compare: 'yes', docs: 'yes', graph: 'yes', embed: 'yes', scene: 'yes' },
        },
        {
            key: 'displayExposure', label: 'Camera Exposure', group: 'display', order: 3, type: 'number', min: -8, max: 8, step: 0.25, unit: 'EV', apply: 'uniform', ui: true,
            hint: 'Scales the whole image before the display transform, the way a camera would.',
            profiles: {
                preview: { storage: 'mtlx_display_exposure', codec: 'number', min: -8, max: 8, setter: 'setDisplayExposure', levels: { performance: 0, default: 0, quality: 0 } },
                stage: { storage: 'mtlx_display_exposure', codec: 'number', min: -8, max: 8, levels: { performance: 0, default: 0, quality: 0 } },
            },
            surfaces: { viewer: 'yes', compare: 'yes', docs: 'yes', graph: 'yes', embed: 'yes', scene: 'yes' },
        },
        {
            key: 'keyLight', label: 'Extract key light', group: 'lighting', order: 10, type: 'bool', apply: 'environment', ui: true,
            hint: 'Automatically extract a strong sun into a directional light so sharp highlights stay crisp (rebuilds the environment).',
            profiles: {
                preview: { storage: 'mtlx_env_keylight', codec: 'boolOn', setter: 'setKeyLightEnabled', levels: { performance: true, default: true, quality: true } },
            },
            surfaces: { viewer: 'yes', compare: 'yes', docs: 'yes', graph: 'yes', embed: 'yes', scene: PLANNED('P5') },
        },
        {
            key: 'geometry', label: 'Preview Geometry', group: 'geometry', order: 12, type: 'enum',
            options: ['shaderball-scene', 'shaderball', 'shaderball-mtlx', 'sphere', 'cube', 'cloth', 'buffer2d', 'custom'],
            apply: 'geometry', ui: true,
            profiles: {
                preview: {
                    storage: 'mtlx_geom_global', codec: 'enum',
                    options: ['shaderball-scene', 'shaderball', 'shaderball-mtlx', 'sphere', 'cube', 'cloth', 'buffer2d', 'custom'],
                    legacy: ['mtlx_preview_geom_choice', 'mtlx_graph_preview_geom'],
                    // 'custom' is registry-local and session-only; a stored or
                    // legacy value that decodes into it counts as undefined,
                    // same as the old initGlobalGeom/legacy-seed skip.
                    rejectStored: ['custom'],
                    setter: 'setGlobalGeom',
                    levels: { performance: 'shaderball-scene', default: 'shaderball-scene', quality: 'shaderball-scene' },
                },
            },
            surfaces: { viewer: 'yes', compare: 'yes', docs: 'yes', graph: 'yes', embed: 'yes', scene: NA('stage geometry is authored') },
        },
        {
            key: 'graphCompoundCompile', label: 'Compound compile', group: 'effects', order: 21, type: 'bool', apply: 'regenerate', ui: true, experimental: true,
            hint: "Wraps the document's root-level shading network in a temporary node definition so the GPU driver compiles it as one function. Measured 6x faster compiles on large closure networks; parameter edits stay live. Connections and node edits still recompile as before.",
            profiles: {
                preview: { storage: 'mtlx_graph_preview_compound', codec: 'boolOnlyOne', levels: { performance: false, default: false, quality: false } },
            },
            surfaces: {
                viewer: NA('only the Graph Editor compiles compound taps'), compare: NA('only the Graph Editor compiles compound taps'),
                docs: NA('only the Graph Editor compiles compound taps'), graph: 'yes',
                embed: NA('only the Graph Editor compiles compound taps'), scene: NA('only the Graph Editor compiles compound taps'),
            },
        },

        // ---- View-scoped rows (persist: 'view'): per render-view state,
        // never localStorage, applied by the caller's own env import/reset
        // logic rather than a single engine setter. ----
        {
            key: 'backdrop', label: 'Backdrop', group: 'display', order: 13, type: 'enum',
            options: ['studio', 'studio-dark', 'environment', 'none'], apply: 'renderMode', ui: true, persist: 'view',
            optionLabels: { studio: 'Studio', 'studio-dark': 'Studio (Dark)', environment: 'Environment', none: 'None' },
            hint: 'Studio: a white room. Environment: the HDRI as background. None: a dark void.',
            profiles: {
                preview: { codec: 'enum', options: ['studio', 'studio-dark', 'environment', 'none'], levels: { performance: 'studio', default: 'studio', quality: 'studio' } },
                stage: { codec: 'enum', options: ['studio', 'studio-dark', 'environment', 'none'], levels: { performance: 'studio', default: 'studio', quality: 'studio' } },
            },
            surfaces: { viewer: 'yes', compare: 'yes', docs: 'yes', graph: 'yes', embed: 'yes', scene: 'yes' },
            embed: { attr: 'backdrop' },
        },
        {
            key: 'envRotation', label: 'Environment rotation', group: 'lighting', order: 11, type: 'number',
            min: 0, max: 360, step: 1, unit: 'deg', apply: 'environment', ui: true, persist: 'view',
            profiles: {
                preview: { codec: 'number', min: 0, max: 360, levels: { performance: 0, default: 0, quality: 0 } },
                stage: { codec: 'number', min: 0, max: 360, levels: { performance: 0, default: 0, quality: 0 } },
            },
            surfaces: { viewer: 'yes', compare: 'yes', docs: 'yes', graph: 'yes', embed: 'yes', scene: 'yes' },
        },
        {
            key: 'envExposure', label: 'Environment exposure', group: 'lighting', order: 12, type: 'number',
            min: -3, max: 3, step: 0.1, unit: 'EV', apply: 'environment', ui: true, persist: 'view',
            profiles: {
                preview: { codec: 'number', min: -3, max: 3, levels: { performance: 0, default: 0, quality: 0 } },
                stage: { codec: 'number', min: -3, max: 3, levels: { performance: 0, default: 0, quality: 0 } },
            },
            surfaces: { viewer: 'yes', compare: 'yes', docs: 'yes', graph: 'yes', embed: 'yes', scene: 'yes' },
            embed: { attr: 'exposure' },
        },

        // ---- Stage-profile rows (js/usd-scene-renderer.js / js/usd-scene-app.jsx) ----
        {
            key: 'textureMaxSize', label: 'Texture Max Size', group: 'geometry', order: 0, type: 'enum', options: [512, 1024, 2048, 4096, Infinity], apply: 'reload', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_texture_size', codec: 'sizeOrOriginal', options: [512, 1024, 2048, 4096, Infinity], levels: { performance: 512, default: 2048, quality: 4096 } } },
            surfaces: { viewer: NA('the Material Viewer has no scene texture budget'), compare: NA('the Material Viewer has no scene texture budget'), docs: NA('the Material Viewer has no scene texture budget'), graph: NA('the Material Viewer has no scene texture budget'), embed: NA('the Material Viewer has no scene texture budget'), scene: 'yes' },
        },
        {
            key: 'textureBudgetGib', label: 'Texture Budget (GiB)', group: 'geometry', order: 1, type: 'enum', options: [1, 2, 4], apply: 'reload', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_texture_budget', codec: 'gib', options: [1, 2, 4], levels: { performance: 1, default: 1, quality: 4 } } },
            surfaces: { viewer: NA('the Material Viewer has no scene texture budget'), compare: NA('the Material Viewer has no scene texture budget'), docs: NA('the Material Viewer has no scene texture budget'), graph: NA('the Material Viewer has no scene texture budget'), embed: NA('the Material Viewer has no scene texture budget'), scene: 'yes' },
        },
        {
            key: 'subdivision', label: 'Subdivision', group: 'geometry', order: 2, type: 'number', min: 0, max: 2, apply: 'reload', ui: true,
            control: 'select', options: [0, 1, 2], optionLabels: { 0: 'Off', 1: '1', 2: '2' },
            profiles: { stage: { storage: 'mtlx_scene_subdivision', codec: 'int', min: 0, max: 2, levels: { performance: 0, default: 0, quality: 2 } } },
            surfaces: { viewer: NA('the Material Viewer has no stage subdivision'), compare: NA('the Material Viewer has no stage subdivision'), docs: NA('the Material Viewer has no stage subdivision'), graph: NA('the Material Viewer has no stage subdivision'), embed: NA('the Material Viewer has no stage subdivision'), scene: 'yes' },
        },
        {
            key: 'shadows', label: 'Shadows', group: 'lighting', order: 2, type: 'bool', apply: 'renderMode', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_shadows', codec: 'boolOnlyOne', levels: { performance: false, default: false, quality: true } } },
            surfaces: { viewer: PLANNED('P9'), compare: PLANNED('P9'), docs: PLANNED('P9'), graph: PLANNED('P9'), embed: PLANNED('P9'), scene: 'yes' },
        },
        {
            key: 'ao', label: 'Ambient Occlusion', group: 'effects', order: 0, type: 'bool', apply: 'renderMode', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_ao', codec: 'boolOnlyOne', levels: { performance: false, default: false, quality: true } } },
            surfaces: { viewer: PLANNED('P8'), compare: PLANNED('P8'), docs: PLANNED('P8'), graph: PLANNED('P8'), embed: PLANNED('P8'), scene: 'yes' },
        },
        {
            key: 'skyVis', label: 'Sky Visibility', group: 'lighting', order: 3, type: 'bool', apply: 'renderMode', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_skyvis', codec: 'boolOnlyOne', levels: { performance: false, default: false, quality: true } } },
            surfaces: { viewer: NA('the Material Viewer has no room-scale visibility bake'), compare: NA('the Material Viewer has no room-scale visibility bake'), docs: NA('the Material Viewer has no room-scale visibility bake'), graph: NA('the Material Viewer has no room-scale visibility bake'), embed: NA('the Material Viewer has no room-scale visibility bake'), scene: 'yes' },
        },
        {
            key: 'displacementSubdivision', label: 'Displacement Subdivision', group: 'geometry', order: 4, type: 'enum', options: ['follow', 0, 1, 2, 3], apply: 'reload', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_displacement_subdivision', codec: 'enum', options: ['follow', 0, 1, 2, 3], levels: { performance: 'follow', default: 'follow', quality: 3 } } },
            surfaces: { viewer: NA('the Material Viewer uses previewSubdivision'), compare: NA('the Material Viewer uses previewSubdivision'), docs: NA('the Material Viewer uses previewSubdivision'), graph: NA('the Material Viewer uses previewSubdivision'), embed: NA('the Material Viewer uses previewSubdivision'), scene: 'yes' },
        },
        {
            key: 'triangleLimits', label: 'Triangle Limits', group: 'geometry', order: 5, type: 'bool', apply: 'reload', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_triangle_limits', codec: 'boolTrueFalse', levels: { performance: true, default: true, quality: false } } },
            surfaces: { viewer: NA('the Material Viewer has no stage triangle budget'), compare: NA('the Material Viewer has no stage triangle budget'), docs: NA('the Material Viewer has no stage triangle budget'), graph: NA('the Material Viewer has no stage triangle budget'), embed: NA('the Material Viewer has no stage triangle budget'), scene: 'yes' },
        },
        {
            key: 'bounce', label: 'One-Bounce Diffuse', group: 'effects', order: 2, type: 'bool', apply: 'renderMode', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_bounce', codec: 'boolOn', levels: { performance: false, default: true, quality: true } } },
            surfaces: { viewer: NA('the Material Viewer has no room-scale bounce bake'), compare: NA('the Material Viewer has no room-scale bounce bake'), docs: NA('the Material Viewer has no room-scale bounce bake'), graph: NA('the Material Viewer has no room-scale bounce bake'), embed: NA('the Material Viewer has no room-scale bounce bake'), scene: 'yes' },
        },
        {
            key: 'localReflections', label: 'Local Reflections', group: 'effects', order: 4, type: 'bool', apply: 'renderMode', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_local_reflections', codec: 'boolOnlyOne', levels: { performance: false, default: false, quality: true } } },
            surfaces: { viewer: NA('the Material Viewer has no per-stage local environment capture'), compare: NA('the Material Viewer has no per-stage local environment capture'), docs: NA('the Material Viewer has no per-stage local environment capture'), graph: NA('the Material Viewer has no per-stage local environment capture'), embed: NA('the Material Viewer has no per-stage local environment capture'), scene: 'yes' },
        },
        {
            key: 'specularAA', label: 'Specular Anti-Aliasing', group: 'display', order: 2, type: 'bool', apply: 'regenerate', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_specular_aa', codec: 'boolOn', levels: { performance: false, default: true, quality: true } } },
            surfaces: { viewer: PLANNED('P8'), compare: PLANNED('P8'), docs: PLANNED('P8'), graph: PLANNED('P8'), embed: PLANNED('P8'), scene: 'yes' },
        },

        // ---- Stage-profile "live" rows (same value at every level) ----
        {
            key: 'materialWorkspace', label: 'Material Working Space', group: 'display', order: 1, type: 'enum', options: ['rec709', 'acescg'], apply: 'regenerate', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_material_workspace', codec: 'enum', options: ['rec709', 'acescg'], levels: { performance: 'rec709', default: 'rec709', quality: 'rec709' } } },
            surfaces: { viewer: NA('untagged-colour convention is Scene-only'), compare: NA('untagged-colour convention is Scene-only'), docs: NA('untagged-colour convention is Scene-only'), graph: NA('untagged-colour convention is Scene-only'), embed: NA('untagged-colour convention is Scene-only'), scene: 'yes' },
        },
        {
            key: 'stageLightsOn', label: 'Stage Lights', group: 'lighting', order: 0, type: 'bool', apply: 'environment', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_stage_lights', codec: 'boolOn', levels: { performance: true, default: true, quality: true } } },
            surfaces: { viewer: NA('the Material Viewer has no analytic stage lights'), compare: NA('the Material Viewer has no analytic stage lights'), docs: NA('the Material Viewer has no analytic stage lights'), graph: NA('the Material Viewer has no analytic stage lights'), embed: NA('the Material Viewer has no analytic stage lights'), scene: 'yes' },
        },
        {
            key: 'stageLightsEv', label: 'Stage Lights EV', group: 'lighting', order: 1, type: 'number', min: -8, max: 8, apply: 'environment', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_stage_lights_ev', codec: 'number', min: -8, max: 8, levels: { performance: 0, default: 0, quality: 0 } } },
            surfaces: { viewer: NA('the Material Viewer has no analytic stage lights'), compare: NA('the Material Viewer has no analytic stage lights'), docs: NA('the Material Viewer has no analytic stage lights'), graph: NA('the Material Viewer has no analytic stage lights'), embed: NA('the Material Viewer has no analytic stage lights'), scene: 'yes' },
        },
        {
            key: 'aoStrength', label: 'AO Strength', group: 'effects', order: 1, type: 'number', min: 0, max: 1, apply: 'uniform', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_ao_strength', codec: 'number', min: 0, max: 1, levels: { performance: 0.85, default: 0.85, quality: 0.85 } } },
            surfaces: { viewer: PLANNED('P8'), compare: PLANNED('P8'), docs: PLANNED('P8'), graph: PLANNED('P8'), embed: PLANNED('P8'), scene: 'yes' },
        },
        {
            key: 'bounceStrength', label: 'Bounce Strength', group: 'effects', order: 3, type: 'number', min: 0, max: 1, apply: 'uniform', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_bounce_strength', codec: 'number', min: 0, max: 1, levels: { performance: 1, default: 1, quality: 1 } } },
            surfaces: { viewer: NA('the Material Viewer has no room-scale bounce bake'), compare: NA('the Material Viewer has no room-scale bounce bake'), docs: NA('the Material Viewer has no room-scale bounce bake'), graph: NA('the Material Viewer has no room-scale bounce bake'), embed: NA('the Material Viewer has no room-scale bounce bake'), scene: 'yes' },
        },
        {
            key: 'skyVisStrength', label: 'Sky Visibility Strength', group: 'lighting', order: 4, type: 'number', min: 0, max: 1, apply: 'uniform', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_skyvis_strength', codec: 'number', min: 0, max: 1, levels: { performance: 1, default: 1, quality: 1 } } },
            surfaces: { viewer: NA('the Material Viewer has no room-scale visibility bake'), compare: NA('the Material Viewer has no room-scale visibility bake'), docs: NA('the Material Viewer has no room-scale visibility bake'), graph: NA('the Material Viewer has no room-scale visibility bake'), embed: NA('the Material Viewer has no room-scale visibility bake'), scene: 'yes' },
        },
        {
            key: 'localEnvStrength', label: 'Local Reflections Strength', group: 'effects', order: 5, type: 'number', min: 0, max: 1, apply: 'uniform', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_local_reflections_strength', codec: 'number', min: 0, max: 1, levels: { performance: 1, default: 1, quality: 1 } } },
            surfaces: { viewer: NA('the Material Viewer has no per-stage local environment capture'), compare: NA('the Material Viewer has no per-stage local environment capture'), docs: NA('the Material Viewer has no per-stage local environment capture'), graph: NA('the Material Viewer has no per-stage local environment capture'), embed: NA('the Material Viewer has no per-stage local environment capture'), scene: 'yes' },
        },
        {
            key: 'ssrOn', label: 'Screen-Space Reflections', group: 'effects', order: 6, type: 'bool', apply: 'renderMode', ui: true, experimental: true,
            profiles: { stage: { storage: 'mtlx_scene_ssr', codec: 'boolOn', levels: { performance: false, default: false, quality: false } } },
            surfaces: { viewer: NA('SSR is Scene-only and parked'), compare: NA('SSR is Scene-only and parked'), docs: NA('SSR is Scene-only and parked'), graph: NA('SSR is Scene-only and parked'), embed: NA('SSR is Scene-only and parked'), scene: 'yes' },
        },
        {
            key: 'ssrStrength', label: 'SSR Strength', group: 'effects', order: 7, type: 'number', min: 0, max: 1, apply: 'uniform', ui: true, experimental: true,
            profiles: { stage: { storage: 'mtlx_scene_ssr_strength', codec: 'number', min: 0, max: 1, levels: { performance: 1, default: 1, quality: 1 } } },
            surfaces: { viewer: NA('SSR is Scene-only and parked'), compare: NA('SSR is Scene-only and parked'), docs: NA('SSR is Scene-only and parked'), graph: NA('SSR is Scene-only and parked'), embed: NA('SSR is Scene-only and parked'), scene: 'yes' },
        },
        {
            key: 'ssrMaxRoughness', label: 'SSR Max Roughness', group: 'effects', order: 8, type: 'number', min: 0.05, max: 1, apply: 'uniform', ui: true, experimental: true,
            profiles: { stage: { storage: 'mtlx_scene_ssr_max_roughness', codec: 'number', min: 0.05, max: 1, levels: { performance: 0.5, default: 0.5, quality: 0.5 } } },
            surfaces: { viewer: NA('SSR is Scene-only and parked'), compare: NA('SSR is Scene-only and parked'), docs: NA('SSR is Scene-only and parked'), graph: NA('SSR is Scene-only and parked'), embed: NA('SSR is Scene-only and parked'), scene: 'yes' },
        },

        // ---- Presentation jsonField rows (mtlx_scene_presentation) ----
        {
            key: 'hdrPresentation', label: 'HDR Presentation', group: 'display', order: 4, type: 'bool', apply: 'post', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_presentation', field: 'enabled', codec: 'jsonField', levels: { performance: true, default: true, quality: true } } },
            surfaces: { viewer: PLANNED('P8'), compare: PLANNED('P8'), docs: PLANNED('P8'), graph: PLANNED('P8'), embed: PLANNED('P8'), scene: 'yes' },
        },
        {
            key: 'bloom', label: 'Bloom', group: 'display', order: 5, type: 'bool', apply: 'post', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_presentation', field: 'bloom', codec: 'jsonField', levels: { performance: false, default: false, quality: false } } },
            surfaces: { viewer: PLANNED('P8'), compare: PLANNED('P8'), docs: PLANNED('P8'), graph: PLANNED('P8'), embed: PLANNED('P8'), scene: 'yes' },
        },
        {
            key: 'bloomStrength', label: 'Bloom Strength', group: 'display', order: 6, type: 'number', min: 0, max: 1, apply: 'post', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_presentation', field: 'strength', codec: 'jsonField', min: 0, max: 1, levels: { performance: 0.25, default: 0.25, quality: 0.25 } } },
            surfaces: { viewer: PLANNED('P8'), compare: PLANNED('P8'), docs: PLANNED('P8'), graph: PLANNED('P8'), embed: PLANNED('P8'), scene: 'yes' },
        },
        {
            key: 'bloomThreshold', label: 'Bloom Threshold', group: 'display', order: 7, type: 'number', min: 0.01, max: 1000, apply: 'post', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_presentation', field: 'threshold', codec: 'jsonField', min: 0.01, max: 1000, levels: { performance: 1, default: 1, quality: 1 } } },
            surfaces: { viewer: PLANNED('P8'), compare: PLANNED('P8'), docs: PLANNED('P8'), graph: PLANNED('P8'), embed: PLANNED('P8'), scene: 'yes' },
        },
        {
            key: 'bloomKnee', label: 'Bloom Knee', group: 'display', order: 8, type: 'number', min: 0, max: 1, apply: 'post', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_presentation', field: 'knee', codec: 'jsonField', min: 0, max: 1, levels: { performance: 0.5, default: 0.5, quality: 0.5 } } },
            surfaces: { viewer: PLANNED('P8'), compare: PLANNED('P8'), docs: PLANNED('P8'), graph: PLANNED('P8'), embed: PLANNED('P8'), scene: 'yes' },
        },
        {
            key: 'bloomRadius', label: 'Bloom Radius', group: 'display', order: 9, type: 'number', min: 0, max: 1, apply: 'post', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_presentation', field: 'radius', codec: 'jsonField', min: 0, max: 1, levels: { performance: 0.65, default: 0.65, quality: 0.65 } } },
            surfaces: { viewer: PLANNED('P8'), compare: PLANNED('P8'), docs: PLANNED('P8'), graph: PLANNED('P8'), embed: PLANNED('P8'), scene: 'yes' },
        },
        {
            key: 'postAntialias', label: 'Post Antialias', group: 'display', order: 20, type: 'bool', apply: 'post', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_presentation', field: 'antialias', codec: 'jsonField', levels: { performance: true, default: true, quality: true } } },
            surfaces: { viewer: PLANNED('P8'), compare: PLANNED('P8'), docs: PLANNED('P8'), graph: PLANNED('P8'), embed: PLANNED('P8'), scene: 'yes' },
        },
        {
            key: 'msaaSamples', label: 'MSAA Samples', group: 'display', order: 21, type: 'number', min: 0, max: 4, apply: 'post', ui: true,
            profiles: { stage: { storage: 'mtlx_scene_presentation', field: 'samples', codec: 'jsonField', min: 0, max: 4, levels: { performance: 4, default: 4, quality: 4 } } },
            surfaces: { viewer: PLANNED('P8'), compare: PLANNED('P8'), docs: PLANNED('P8'), graph: PLANNED('P8'), embed: PLANNED('P8'), scene: 'yes' },
        },
    ];

    const ROW_BY_KEY = {};
    ROWS.forEach((row) => { ROW_BY_KEY[row.key] = row; });

    // ---- canPersist: embed iframes never persist to shared localStorage. ----
    const canPersist = () => {
        try {
            if (window.__MTLX_EMBED) return false;
            if (window.__MTLX_EMBED_PAGE__) return false;
            if (window.__MTLX_VSCODE__) return true;
            return window.self === window.top;
        } catch (e) { return false; }
    };

    const readStorage = (key) => {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    };
    const writeStorage = (key, value) => {
        try { localStorage.setItem(key, value); } catch (e) { /* privacy mode / quota */ }
    };

    // ---- URL seeds: read once at load, per profile+key. ----
    const URL_SEEDS = new Map();
    (function seedFromUrl() {
        let qs;
        try { qs = new URLSearchParams(window.location.search); } catch (e) { return; }
        ROWS.forEach((row) => {
            Object.keys(row.profiles).forEach((profile) => {
                const P = row.profiles[profile];
                if (!P.query || !qs.has(P.query)) return;
                const raw = qs.get(P.query);
                const decoded = P.queryDecode ? P.queryDecode(raw) : CODECS[P.codec].decode(raw, P);
                if (decoded !== undefined && decoded !== null) URL_SEEDS.set(profile + '|' + row.key, decoded);
            });
        });
    })();

    // ---- In-memory overrides (every set() call, persisted or not). ----
    const OVERRIDES = new Map();

    // ---- Levels ----
    const LEVEL_KEYS = { viewer: 'mtlx_quality_viewer', compare: 'mtlx_quality_compare', docs: 'mtlx_quality_docs', graph: 'mtlx_quality_graph', scene: 'mtlx_scene_quality' };
    const LEVEL_DEFAULTS = { viewer: 'default', compare: 'default', docs: 'performance', graph: 'performance', embed: 'performance', scene: 'default' };
    const LEVEL_OVERRIDES = {}; // embed levels are in-memory only, never persisted

    const getLevel = (surface) => {
        if (LEVEL_OVERRIDES[surface] !== undefined) return LEVEL_OVERRIDES[surface];
        const storageKey = LEVEL_KEYS[surface];
        if (storageKey) {
            const raw = readStorage(storageKey);
            if (LEVELS.indexOf(raw) !== -1) return raw;
        }
        return LEVEL_DEFAULTS[surface] || 'default';
    };

    // A row is "governed" for a profile when its three level values differ.
    const isGoverned = (P) => {
        if (!P || !P.levels) return false;
        const values = LEVELS.map((l) => (P.levels[l] !== undefined ? P.levels[l] : P.levels.default));
        return values.some((v) => JSON.stringify(v) !== JSON.stringify(values[0]));
    };

    // ---- Subscribers ----
    const SUBSCRIBERS = new Set();
    const subscribe = (fn) => { SUBSCRIBERS.add(fn); return () => SUBSCRIBERS.delete(fn); };
    const notify = (detail) => {
        SUBSCRIBERS.forEach((fn) => { try { fn(detail); } catch (e) { /* subscriber error, keep going */ } });
        try { window.dispatchEvent(new CustomEvent('mtlx-render-setting', { detail })); } catch (e) { /* best-effort */ }
    };

    const resolveProfile = (opts) => {
        if (!opts) return undefined;
        if (opts.profile) return opts.profile;
        if (opts.surface) return PROFILE_OF[opts.surface];
        return undefined;
    };

    const persistValue = (P, value) => {
        if (P.codec === 'jsonField') {
            let obj = {};
            const raw = readStorage(P.storage);
            if (raw) { try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') obj = parsed; } catch (e) { /* start fresh */ } }
            obj[P.field] = value;
            writeStorage(P.storage, JSON.stringify(obj));
            return;
        }
        const codec = CODECS[P.codec];
        writeStorage(P.storage, codec.encode(value, P));
    };

    const get = (key, opts) => {
        const row = ROW_BY_KEY[key];
        if (!row) return undefined;
        const profile = resolveProfile(opts);
        if (!profile) return undefined;
        const P = row.profiles[profile];
        if (!P) return undefined;
        const seedKey = profile + '|' + key;
        // An in-memory value from set() this session outranks the URL seed:
        // once the visitor changes a setting, the page-load query param must
        // not keep overriding what they just picked.
        if (OVERRIDES.has(seedKey)) return OVERRIDES.get(seedKey);
        if (URL_SEEDS.has(seedKey)) return URL_SEEDS.get(seedKey);
        if (P.storage) {
            const codec = CODECS[P.codec];
            const rejects = (value) => P.rejectStored && P.rejectStored.indexOf(value) !== -1;
            let decoded = codec.decode(readStorage(P.storage), P);
            if (decoded !== undefined && rejects(decoded)) decoded = undefined;
            if (decoded === undefined && P.legacy) {
                for (let i = 0; i < P.legacy.length; i++) {
                    let legacyDecoded = codec.decode(readStorage(P.legacy[i]), P);
                    if (legacyDecoded !== undefined && rejects(legacyDecoded)) legacyDecoded = undefined;
                    if (legacyDecoded !== undefined) { decoded = legacyDecoded; break; }
                }
            }
            if (decoded !== undefined) return decoded;
        }
        if (P.levels) {
            const level = opts && opts.surface ? getLevel(opts.surface) : 'default';
            return P.levels[level] !== undefined ? P.levels[level] : P.levels.default;
        }
        return undefined;
    };

    const set = (key, value, opts) => {
        const row = ROW_BY_KEY[key];
        if (!row) return undefined;
        const options = opts || {};
        const profile = resolveProfile(options);
        if (!profile) return undefined;
        const P = row.profiles[profile];
        if (!P) return undefined;
        const validated = validate(P, value);
        const seedKey = profile + '|' + key;
        OVERRIDES.set(seedKey, validated);
        const persist = options.persist !== false;
        if (persist && P.storage && canPersist()) persistValue(P, validated);
        notify({ key, profile, surface: options.surface, value: validated });
        if (row.legacyEvent) {
            try { window.dispatchEvent(new CustomEvent(row.legacyEvent, { detail: { value: validated } })); } catch (e) { /* best-effort */ }
        }
        return validated;
    };

    const setLevel = (surface, level, opts) => {
        if (LEVELS.indexOf(level) === -1) return;
        const options = opts || {};
        LEVEL_OVERRIDES[surface] = level;
        const persist = options.persist !== false && surface !== 'embed';
        const storageKey = LEVEL_KEYS[surface];
        if (persist && storageKey && canPersist()) writeStorage(storageKey, level);
        const profile = PROFILE_OF[surface];
        ROWS.forEach((row) => {
            const P = row.profiles[profile];
            if (!isGoverned(P)) return;
            set(row.key, P.levels[level] !== undefined ? P.levels[level] : P.levels.default, { surface, persist });
        });
        try { window.dispatchEvent(new CustomEvent('mtlx-render-level', { detail: { surface, level } })); } catch (e) { /* best-effort */ }
    };

    // The write path a settings UI should use: calls the row's setter if
    // declared, else falls back to plain set() which skips storage for rows
    // with no P.storage or persist: 'view' rows.
    const apply = (key, value, opts) => {
        const row = ROW_BY_KEY[key];
        if (!row) return undefined;
        const options = opts || {};
        const profile = resolveProfile(options);
        const P = profile && row.profiles[profile];
        const setterName = P && P.setter;
        const setterFn = setterName && typeof window[setterName] === 'function' ? window[setterName] : null;
        if (setterFn) {
            const validated = validate(P, value);
            try {
                if (options.persist === false) setterFn(validated, { persist: false });
                else setterFn(validated);
            } catch (e) { /* best-effort */ }
            return validated;
        }
        return set(key, value, options);
    };

    // Group-then-row order, matching the Scene's Render settings tabs.
    const rowSortKey = (row) => {
        const groupOrder = (GROUPS[row.group] && GROUPS[row.group].order) || 0;
        const order = row.order || 0;
        return groupOrder * 1000 + order;
    };

    const rowsFor = (surface, opts) => {
        const uiOnly = opts && opts.ui;
        return ROWS.filter((row) => {
            const s = row.surfaces[surface];
            if (s !== 'yes') return false;
            if (uiOnly && row.ui !== true) return false;
            return true;
        }).sort((a, b) => rowSortKey(a) - rowSortKey(b));
    };

    const storageKeys = () => {
        const keys = new Set();
        ROWS.forEach((row) => {
            Object.keys(row.profiles).forEach((profile) => {
                const P = row.profiles[profile];
                if (P.storage) keys.add(P.storage);
                if (P.legacy) P.legacy.forEach((k) => keys.add(k));
            });
        });
        Object.keys(LEVEL_KEYS).forEach((s) => keys.add(LEVEL_KEYS[s]));
        return Array.from(keys);
    };

    window.MtlxRenderSettings = {
        SURFACES, PROFILE_OF, LEVELS, ROWS, GROUPS,
        get, set, apply, getLevel, setLevel, canPersist,
        rowsFor, subscribe, storageKeys,
    };
})();
