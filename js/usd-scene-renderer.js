// usd-scene-renderer.js
//
// Renderer for the extracted USD scene snapshot. The USD parser/worker owns
// composition and produces typed mesh data; this module owns one Three.js
// renderer, per-object transforms, and MaterialX material instances.

// Ordinary (non-UDIM) scene texture resolution cap, persisted separately
// from the UDIM tile size (which stays fixed per scene). Mirrors the
// engine's getDisplayTransform persistence idiom (js/mtlx-engine.js:1601-1629).
// Formats the engine's exr/hdr/tif loaders decode whole (never resized by
// createImageBitmap, unlike the bounded PNG/JPEG path).
const UNBOUNDED_TEXTURE_EXTENSIONS = ['exr', 'hdr', 'tif', 'tiff', 'ktx2'];

const SCENE_TEXTURE_MAX_SIZE_KEY = 'mtlx_scene_texture_size';
// Original is unbounded (Infinity internally); persisted as the string
// "original" since Infinity does not round-trip through localStorage.
const SCENE_TEXTURE_MAX_SIZE_VALUES = [512, 1024, 2048, 4096, Infinity];
const SCENE_TEXTURE_MAX_SIZE_DEFAULT = 2048;

const storedSceneTextureMaxSize = () => {
    if (window.top !== window) return SCENE_TEXTURE_MAX_SIZE_DEFAULT;
    try {
        const raw = localStorage.getItem(SCENE_TEXTURE_MAX_SIZE_KEY);
        if (raw === 'original') return Infinity;
        const stored = Number(raw);
        return SCENE_TEXTURE_MAX_SIZE_VALUES.includes(stored) ? stored : SCENE_TEXTURE_MAX_SIZE_DEFAULT;
    } catch (e) { return SCENE_TEXTURE_MAX_SIZE_DEFAULT; /* privacy mode */ }
};

// Analytic lights imported from the stage. USD intensity units and our
// environment units share no calibration, so the multiplier lets the user
// match a reference by eye instead of us hardcoding a factor.
const SCENE_STAGE_LIGHTS_KEY = 'mtlx_scene_stage_lights';
const SCENE_STAGE_LIGHTS_EV_KEY = 'mtlx_scene_stage_lights_ev';
const SCENE_SHADOWS_KEY = 'mtlx_scene_shadows';

const storedSceneShadows = () => {
    if (window.top !== window) return false;
    try { return localStorage.getItem(SCENE_SHADOWS_KEY) === '1'; } catch (e) { return false; }
};

const storedSceneStageLights = () => {
    if (window.top !== window) return true;
    try { return localStorage.getItem(SCENE_STAGE_LIGHTS_KEY) !== '0'; } catch (e) { return true; }
};
const storedSceneStageLightsEv = () => {
    if (window.top !== window) return 0;
    try {
        const value = Number(localStorage.getItem(SCENE_STAGE_LIGHTS_EV_KEY));
        return Number.isFinite(value) ? Math.max(-8, Math.min(8, value)) : 0;
    } catch (e) { return 0; }
};

// Texture memory budget: caps the total decoded bytes the planner will
// allow across every ordinary and UDIM texture combined. Persisted at the
// top realm only, like the size tier above.
const SCENE_TEXTURE_BUDGET_KEY = 'mtlx_scene_texture_budget';
const SCENE_TEXTURE_BUDGET_VALUES = [1, 2, 4]; // GiB
const SCENE_TEXTURE_BUDGET_DEFAULT_GIB = 1;
const GIB = 1024 * 1024 * 1024;

const storedSceneTextureBudgetBytes = () => {
    if (window.top !== window) return SCENE_TEXTURE_BUDGET_DEFAULT_GIB * GIB;
    try {
        const stored = Number(localStorage.getItem(SCENE_TEXTURE_BUDGET_KEY));
        return (SCENE_TEXTURE_BUDGET_VALUES.includes(stored) ? stored : SCENE_TEXTURE_BUDGET_DEFAULT_GIB) * GIB;
    } catch (e) { return SCENE_TEXTURE_BUDGET_DEFAULT_GIB * GIB; /* privacy mode */ }
};

const setStoredSceneTextureMaxSize = (value) => {
    if (window.top !== window) return;
    const next = value === Infinity || String(value).toLowerCase() === 'original' ? Infinity : Math.round(Number(value));
    if (!SCENE_TEXTURE_MAX_SIZE_VALUES.includes(next)) return;
    try { localStorage.setItem(SCENE_TEXTURE_MAX_SIZE_KEY, next === Infinity ? 'original' : String(next)); } catch (e) { /* privacy mode */ }
};

const setStoredSceneTextureBudgetBytes = (bytes) => {
    if (window.top !== window) return;
    const gib = Number(bytes) / GIB;
    if (!SCENE_TEXTURE_BUDGET_VALUES.includes(gib)) return;
    try { localStorage.setItem(SCENE_TEXTURE_BUDGET_KEY, String(gib)); } catch (e) { /* privacy mode */ }
};

const formatGB = (bytes) => (bytes / GIB).toFixed(2) + ' GB';
const formatMB = (bytes) => Math.round(bytes / (1024 * 1024)) + ' MB';

// Loop subdivision level for catmullClark/loop meshes, persisted the same
// way as the texture size cap above.
const SCENE_SUBDIVISION_KEY = 'mtlx_scene_subdivision';
const SCENE_SUBDIVISION_VALUES = [0, 1, 2];
const SCENE_SUBDIVISION_DEFAULT = 1;

const storedSceneSubdivisionLevel = () => {
    if (window.top !== window) return SCENE_SUBDIVISION_DEFAULT;
    try {
        const stored = Number(localStorage.getItem(SCENE_SUBDIVISION_KEY));
        return SCENE_SUBDIVISION_VALUES.includes(stored) ? stored : SCENE_SUBDIVISION_DEFAULT;
    } catch (e) { return SCENE_SUBDIVISION_DEFAULT; /* privacy mode */ }
};

const setStoredSceneSubdivisionLevel = (level) => {
    if (window.top === window) {
        try { localStorage.setItem(SCENE_SUBDIVISION_KEY, String(level)); } catch (e) { /* privacy mode */ }
    }
};

const sceneArray = (value) => value == null ? [] : (Array.isArray(value) ? value : [value]);

const sceneFileMap = (files, stage) => {
    const map = {};
    const add = (entry) => {
        if (!entry || !entry.path || entry.data == null) return;
        // MaterialX texture binding expects Blob-like values. Blob/File
        // inputs are immutable; avoid duplicating large user-provided
        // ArrayBuffers before wrapping them.
        const data = entry.data;
        // Rewrap File/Blob values so the engine cache uses the canonical map
        // key rather than a basename plus file metadata. Blob parts avoid an
        // explicit ArrayBuffer slice or second JS heap allocation.
        const canonical = String(entry.path).replace(/\\/g, '/');
        const ext = canonical.split('.').pop().toLowerCase();
        const typeByExtension = {
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
            tif: 'image/tiff', tiff: 'image/tiff', exr: 'image/x-exr', hdr: 'image/vnd.radiance',
            ktx2: 'image/ktx2',
        };
        // Preserve the user's authored file when the Worker also returns a
        // composed/generated payload at the same path. Stage assets remain a
        // fallback for references that were not part of the original upload.
        if (!map[canonical]) map[canonical] = new Blob([data], { type: data.type || entry.mimeType || typeByExtension[ext] || '' });
    };
    sceneArray(files).forEach(add);
    sceneArray(stage && stage.assets).forEach(add);
    return map;
};

const sceneNormPath = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
const sceneDir = (value) => {
    const p = sceneNormPath(value);
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
};
const sceneJoinPath = (base, value) => sceneNormPath((base ? base + '/' : '') + String(value || ''))
    .split('/').reduce((out, part) => {
        if (!part || part === '.') return out;
        if (part === '..') { out.pop(); return out; }
        out.push(part); return out;
    }, []).join('/');
// Given a resolved map path, prefer a sibling "<stem>.ktx2" in the same
// directory when one exists, and never touch the original file.
const sceneKtx2SiblingPath = (map, path) => {
    if (/\.ktx2$/i.test(path) || /\.mtlx$/i.test(path)) return path; // documents, not textures
    const dot = path.lastIndexOf('.');
    if (dot < 0) return path;
    const ktx2Path = path.slice(0, dot) + '.ktx2';
    return map[ktx2Path] ? ktx2Path : path;
};
const sceneExactFile = (map, ref, fromDir) => {
    const want = sceneJoinPath(fromDir, ref);
    if (!map[want]) return null;
    const path = sceneKtx2SiblingPath(map, want);
    return { path, blob: map[path], substituted: path !== want, originalPath: want, originalBlob: map[want] };
};

// A dome light's texture is authored relative to the layer that declares it,
// and the runtime does not report which layer that was. Every directory that
// holds a USD layer is therefore a candidate base, deepest first, with the
// stage root next and a unique basename match as the last resort.
const sceneDomeTextureCandidates = (fileMap, stage) => {
    const dirs = new Set();
    for (const path of Object.keys(fileMap)) {
        if (/\.usd[ac]?$/i.test(path)) dirs.add(sceneDir(path));
    }
    const ordered = Array.from(dirs).sort((a, b) => b.split('/').length - a.split('/').length);
    ordered.push(sceneDir(stage && stage.rootPath), '');
    return Array.from(new Set(ordered));
};
const sceneResolveDomeTexture = (fileMap, stage, rawRef) => {
    const match = String(rawRef || '').trim().match(/^@(.*)@$/);
    const ref = sceneNormPath(match ? match[1] : rawRef);
    if (!ref) return { path: null, reason: 'empty' };
    for (const dir of sceneDomeTextureCandidates(fileMap, stage)) {
        const candidate = sceneJoinPath(dir, ref);
        if (fileMap[candidate]) return { path: candidate, ref };
    }
    const base = ref.split('/').pop().toLowerCase();
    const hits = Object.keys(fileMap).filter((path) => path.toLowerCase().split('/').pop() === base);
    if (hits.length === 1) return { path: hits[0], ref, byBasename: true };
    return { path: null, ref, reason: hits.length ? 'ambiguous' : 'missing' };
};

// Builds the environment a stage's own dome light describes, so a stage
// renders under the lighting it was authored with. Returns null when the
// stage has no dome; never throws, since a light must not block a load.
const sceneDomeEnvironment = async (stage, fileMap, warnings) => {
    const dome = sceneArray(stage && stage.lights)
        .find((light) => String(light && light.type || '').toLowerCase() === 'domelight');
    if (!dome) return null;
    const warn = (message) => { if (warnings && warnings.indexOf(message) < 0) warnings.push(message); };
    try {
        let env = null;
        let fileName = null;
        if (dome.textureFile) {
            const resolved = sceneResolveDomeTexture(fileMap, stage, dome.textureFile);
            if (!resolved.path) {
                warn(resolved.reason === 'ambiguous'
                    ? 'Dome light texture "' + resolved.ref + '" is ambiguous, using the default environment'
                    : 'Dome light texture not found: "' + String(dome.textureFile) + '"');
                return null;
            }
            const ext = resolved.path.slice(resolved.path.lastIndexOf('.')).toLowerCase();
            if (ext !== '.hdr' && ext !== '.exr') {
                warn('Dome light texture "' + resolved.path + '" is not a .hdr or .exr environment');
                return null;
            }
            const buffer = await fileMap[resolved.path].arrayBuffer();
            env = await window.loadEnvironmentFromBuffer(buffer, ext, resolved.path, false);
            fileName = resolved.path.split('/').pop();
        } else {
            if (!window.makeFlatEnvironment) return null;
            env = window.makeFlatEnvironment(dome.color);
            fileName = 'dome colour';
        }
        if (!env) return null;
        // Only a Y rotation is representable, so take the yaw and report a
        // tilt the environment cannot express rather than silently dropping it.
        const euler = new THREE.Euler().setFromRotationMatrix(sceneMatrix(dome.matrix), 'YXZ');
        const tiltDeg = Math.max(Math.abs(euler.x), Math.abs(euler.z)) * 180 / Math.PI;
        if (tiltDeg > 5) {
            warn('Dome light ' + dome.primPath + ' is tilted ' + tiltDeg.toFixed(0)
                + ' deg off vertical; only its Y rotation is applied');
        }
        const rotationDeg = ((euler.y * 180 / Math.PI) % 360 + 360) % 360;
        const exposure = (Number(dome.intensity) || 0) * Math.pow(2, Number(dome.exposure) || 0);
        if (Number(dome.diffuse) !== 1 || Number(dome.specular) !== 1) {
            warn('Dome light ' + dome.primPath + ' sets diffuse/specular multipliers, which are not applied');
        }
        warn('Dome light ' + dome.primPath + ' applied as the environment (' + fileName
            + ', rotation ' + rotationDeg.toFixed(0) + ' deg)');
        return { env, descriptor: { primPath: dome.primPath, fileName, rotationDeg, exposure } };
    } catch (error) {
        warn('Dome light import failed: ' + String(error && error.message || error));
        return null;
    }
};

// Shadow pass for MaterialX materials. MaterialX generates
// mx_shadow_occlusion() against a variance (moments) map, so we render our own
// vec2(z, z*z) rather than reuse three's VSM target, whose packing is not
// guaranteed to match and would misread rather than error.
const SHADOW_MAP_SIZE = 2048;
const createShadowDepthMaterial = () => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: [
        'in vec3 position;',
        'uniform mat4 modelViewMatrix;',
        'uniform mat4 projectionMatrix;',
        'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    ].join('\n'),
    fragmentShader: [
        'precision highp float;',
        'out vec4 fragColor;',
        // Matches MaterialX's mx_compute_depth_moments() exactly.
        'void main() { float d = gl_FragCoord.z; fragColor = vec4(d, d * d, 0.0, 1.0); }',
    ].join('\n'),
    side: THREE.FrontSide,
    // Depth bias: without it a surface shadows itself and the whole stage
    // bands. Applied here rather than in the shader so it scales with slope.
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
});

// The same transform sceneRoot carries, needed before that group exists so
// lights and the dome can be placed in final world space.
const sceneRootMatrix = (stage) => {
    const m = new THREE.Matrix4();
    if (String(stage && stage.upAxis || 'Y').toUpperCase() === 'Z') m.makeRotationX(-Math.PI / 2);
    const meters = Number(stage && stage.metersPerUnit);
    if (Number.isFinite(meters) && meters > 0) m.multiply(new THREE.Matrix4().makeScale(meters, meters, meters));
    return m;
};

const sceneUdimCode = (u, v) => 1001 + u + v * 10;
const sceneUdimTile = (u, v) => {
    if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || v < 0) return null;
    const epsilon = 1e-7;
    const tu = Math.floor(u + epsilon);
    const tv = Math.floor(v + epsilon);
    // UDIM numbers reserve the first decimal digit for U coordinates 0..9.
    // Treating U=10 as 1011 would alias the V=1,U=0 tile 1011.
    if (tu > 9) return null;
    return { u: tu, v: tv, code: sceneUdimCode(tu, tv) };
};
const sceneUdimTriangle = (uvs, tri) => {
    if (!uvs) return null;
    const values = tri.map((index) => [Number(uvs[index * 2]), Number(uvs[index * 2 + 1])]);
    if (values.some(([u, v]) => !Number.isFinite(u) || !Number.isFinite(v) || u < 0 || v < 0)) return null;
    const center = values.reduce((sum, value) => [sum[0] + value[0], sum[1] + value[1]], [0, 0]);
    const tile = sceneUdimTile(center[0] / 3, center[1] / 3);
    if (!tile) return null;
    const epsilon = 1e-6;
    if (values.some(([u, v]) => u < tile.u - epsilon || u > tile.u + 1 + epsilon
        || v < tile.v - epsilon || v > tile.v + 1 + epsilon)) return { crossing: true };
    return tile;
};
const sceneUdimRefs = (compiled) => (compiled && compiled.introspected || [])
    .filter((u) => u.type === 'filename' && typeof u.data === 'string' && /<UDIM>/i.test(u.data));
const sceneUdimTiles = (ref, map) => {
    const marker = /<UDIM>/i;
    const parts = String(ref).split(marker);
    if (parts.length !== 2) return new Map();
    const prefix = parts[0], suffix = parts[1];
    const tiles = new Map();
    for (const [path, blob] of Object.entries(map)) {
        if (!path.startsWith(prefix) || !path.endsWith(suffix)) continue;
        const end = suffix.length ? path.length - suffix.length : path.length;
        const codeText = path.slice(prefix.length, end);
        if (!/^\d{4}$/.test(codeText)) continue;
        const code = Number(codeText);
        if (code < 1001) continue;
        const offset = code - 1001;
        const u = offset % 10, v = Math.floor(offset / 10);
        const ktx2Path = sceneKtx2SiblingPath(map, path);
        tiles.set(code, { path: ktx2Path, blob: map[ktx2Path], u, v, substituted: ktx2Path !== path, originalPath: path, originalBlob: map[path] });
    }
    return tiles;
};

const sceneCloneUniforms = (source) => Object.fromEntries(Object.entries(source || {}).map(([name, slot]) => {
    const value = slot && slot.value;
    // Texture objects are GPU resources. Share them between variants and
    // clone only value objects, avoiding duplicate uploads/disposal hazards.
    let cloned = value;
    if (value && !value.isTexture && typeof value.clone === 'function') cloned = value.clone();
    else if (Array.isArray(value)) cloned = value.slice();
    return [name, Object.assign({}, slot, { value: cloned })];
}));

// MaterialX filename inputs are interpreted relative to the document that
// declares them and its fileprefix. Canonicalize those values while each
// included document still has its own declaring path; this keeps two
// same-named textures in different layer directories distinct.
const SCENE_CANONICAL_MARKER = '__MX_SCENE_CANONICAL__/';
const canonicalizeSceneFilenameInputs = (xml, declaringPath, map, finalize = false) => {
    // Some DCCs emit the USD/MaterialX UDIM token literally inside an XML
    // attribute. Escape it before parsing, while retaining the token for a
    // future tile resolver; never silently substitute tile 1001.
    xml = String(xml || '')
        .replace(/<UDIM>/gi, '&lt;UDIM&gt;')
        // Defensive normalization for the current usdMtlx inline payload,
        // which emits a space between '<' and the tag name.
        .replace(/<\s+(?=[/?A-Za-z])/g, '<');
    const base = sceneDir(declaringPath);
    const prefix = sceneFilePrefix(xml);
    const canonicalized = xml.replace(/<[^>]*\btype\s*=\s*(["'])filename\1[^>]*>/gi, (tag) => tag.replace(/\b(value|default)\s*=\s*(["'])(.*?)\2/i, (whole, attr, quote, ref) => {
        if (!ref || ref.startsWith(SCENE_CANONICAL_MARKER) || /^(?:[a-z]+:|\/\/)/i.test(ref)) return whole;
        // Concatenate first, then normalize dot segments once. Normalizing
        // `../Texture` before adding the declaring directory loses the
        // document anchor and resolves Teapot/Looks/../Texture incorrectly.
        const rooted = sceneJoinPath(base, String(prefix || '') + '/' + ref);
        return attr + '=' + quote + SCENE_CANONICAL_MARKER + rooted + quote;
    }));
    // Once references are canonical, remove the active document prefix so
    // MaterialX does not prepend it a second time during XML parsing.
    const withoutPrefix = canonicalized.replace(/(<materialx\b[^>]*?)\s+fileprefix\s*=\s*(["'])(.*?)\2/i, '$1');
    return finalize ? withoutPrefix.replaceAll(SCENE_CANONICAL_MARKER, '') : withoutPrefix;
};

// MaterialX includes are resolved here rather than through the viewer's
// basename fallback. A composed USD scene can contain duplicate names, so a
// missing exact path must remain missing.
const resolveSceneIncludes = async (xml, fromDir, map, visited = new Set(), warnings = []) => {
    const re = /<xi:include\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*?\/?>(?:\s*<\/xi:include>)?/g;
    let out = '', last = 0, match;
    while ((match = re.exec(xml)) !== null) {
        out += xml.slice(last, match.index);
        last = re.lastIndex;
        const href = match[1] || match[2] || '';
        const hit = sceneExactFile(map, href, fromDir);
        if (!hit) {
            out += '<!-- unresolved include: ' + href.replace(/--/g, '- -') + ' -->';
            warnings.push('Unresolved MaterialX include ' + href + ' from ' + (fromDir || '.'));
            continue;
        }
        if (visited.has(hit.path)) continue; // already in this document closure
        visited.add(hit.path);
        let child = await hit.blob.text();
        child = await resolveSceneIncludes(child, sceneDir(hit.path), map, visited, warnings);
        child = canonicalizeSceneFilenameInputs(child, hit.path, map);
        child = child.replace(/<\?xml[^>]*\?>/, '')
            .replace(/<materialx\b[^>]*>/, '').replace(/<\/materialx>\s*$/, '');
        out += child;
    }
    return out + xml.slice(last);
};

const sceneFilePrefix = (xml) => {
    const m = /<materialx\b[^>]*\bfileprefix\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(xml);
    return m ? (m[1] || m[2] || '') : '';
};

const sceneMatrix = (value) => {
    const a = value && (value.length === 16 ? value : value.data);
    if (!a || a.length !== 16) return new THREE.Matrix4();
    return new THREE.Matrix4().fromArray(Array.from(a));
};

// PointInstancer MeshUpdates carry one local transform per generated instance.
// Keep these as ordinary Mesh objects: the scene materials are RawShaderMaterial
// instances and therefore do not consume Three's InstancedMesh instanceMatrix
// attribute.  The geometry and material remain shared across all instances.
const sceneInstanceMatrices = (value) => {
    if (value == null) return [];
    const values = ArrayBuffer.isView(value) ||
        (Array.isArray(value) && value.every(item => typeof item === 'number'))
        ? [value]
        : (Array.isArray(value) ? value : (typeof value.size === 'function' && typeof value.get === 'function'
            ? Array.from({ length: value.size() }, (_, index) => value.get(index)) : []));
    const matrices = [];
    for (const item of values) {
        const data = item && item.data && item.length === undefined ? item.data : item;
        if (!data || data.length !== 16) continue;
        const matrix = Array.from(data, Number);
        if (matrix.length === 16 && matrix.every(Number.isFinite)) matrices.push(matrix);
    }
    return matrices;
};

const sceneGeometry = (record) => {
    if (!record || !record.positions || record.positions.length < 3) return null;
    const g = new THREE.BufferGeometry();
    const positions = record.positions instanceof Float32Array ? record.positions : new Float32Array(record.positions);
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // Set the index before deriving normals so indexed USD topology produces
    // shared vertex normals instead of normals from an unintended non-indexed
    // triangle stream.
    if (record.indices && record.indices.length) {
        const indices = record.indices instanceof Uint32Array ? record.indices : new Uint32Array(record.indices);
        g.setIndex(new THREE.BufferAttribute(indices, 1));
    }
    if (record.normals && record.normals.length === positions.length) {
        const normals = record.normals instanceof Float32Array ? record.normals : new Float32Array(record.normals);
        g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    } else {
        g.computeVertexNormals();
    }
    if (record.uvs && record.uvs.length >= (positions.length / 3) * 2) {
        const uvs = record.uvs instanceof Float32Array ? record.uvs : new Float32Array(record.uvs);
        g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    }
    if (window.prepGeometry) window.prepGeometry(g);
    const groups = sceneArray(record.groups);
    if (groups.length) {
        groups.forEach((group, index) => {
            if (group && Number.isFinite(group.start) && Number.isFinite(group.count) && group.count > 0) {
                g.addGroup(group.start, group.count, index);
            }
        });
    }
    return g;
};

const sceneNeutralMaterial = (label) => new THREE.MeshNormalMaterial({
    name: 'USD unsupported material: ' + String(label || 'unknown'),
});

const createMtlxSceneView = async ({
    container, stage, files = [], version, onProgress, isMounted = () => true,
    udimTileSize = 512, udimMaxTiles = 1024,
    // udimMaxBytes and udimTileSize are accepted for compatibility but no
    // longer drive accounting: UDIM tiles now resize to plannedTextureSize
    // and reserve against the single textureMaxBytes budget (see
    // planTextureSize/reserveTexture below). udimMaxTiles stays a sanity cap.
    udimMaxBytes = 256 * 1024 * 1024, textureMaxSize, textureMaxBytes,
}) => {
    if (!container) throw new Error('USD scene view requires a container.');
    if (!stage || !Array.isArray(stage.meshes)) throw new Error('USD scene snapshot is missing meshes.');
    if (!window.THREE || !THREE.WebGLRenderer) throw new Error('Three.js WebGL renderer is unavailable.');
    const report = (event) => { if (onProgress) { try { onProgress(event); } catch (e) {} } };
    const warnings = Array.isArray(stage.warnings) ? stage.warnings.slice() : [];
    let displayTransformListener = null;
    let queueDisplayRebuild = null;
    let displayRebuildPromise = null;
    let displayDirty = false;
    let displayRevision = 0;
    displayTransformListener = () => {
        displayDirty = true;
        displayRevision += 1;
        if (queueDisplayRebuild && active && !stopped) queueDisplayRebuild();
    };
    window.addEventListener('mtlx-display-transform', displayTransformListener);
    // heightToNormalTexel is generation-affecting like the display
    // transform: reuse the same rebuild path so a flag flip recompiles.
    const settingsChangedListener = (e) => {
        if (e.detail && e.detail.key === 'heightToNormalTexel') displayTransformListener();
    };
    window.addEventListener('mtlx-settings-changed', settingsChangedListener);
    const fileMap = sceneFileMap(files, stage);
    const creationDisplayRevision = displayRevision;
    const creationDisplayTransform = window.getDisplayTransform ? window.getDisplayTransform() : 'srgb';
    const canvas = document.createElement('canvas');
    canvas.className = 'w-full h-full block cursor-grab active:cursor-grabbing';
    canvas.tabIndex = -1;
    canvas.style.outline = 'none';
    container.appendChild(canvas);
    let renderer = null;
    let environmentBridge = null;
    let controls = null;
    // Depth-peel OIT pipeline (js/mtlx-engine.js createPeelPipeline) and its
    // cached list of transparent meshes under sceneRoot; the cache is
    // invalidated on every material create/replace and on refreshRenderMode.
    let peelPipeline = null;
    let transparentMeshCache = null;
    const invalidateTransparentMeshCache = () => { transparentMeshCache = null; };
    let resizeObserver = null;
    let stopped = false;
    let active = true;
    let raf = 0;
    let studioPolarApplied = false;
    let studioDistanceApplied = false;
    let lastFrameDistance = 0;
    // null = the Default (auto framing) entry; otherwise a stage.cameras
    // primPath. resetCamera() re-applies whichever of these is selected.
    let selectedCameraPath = null;
    // Turntable/GIF capture state: while true, resize() is a no-op so the
    // fixed capture resolution set by beginCapture() sticks between frames.
    let resizeSuspended = false;
    let captureState = null;
    let __captureCanvas = null, __captureCtx = null;
    const materials = new Set();
    // Exact per-material bad-program attribution: r128 sets
    // properties.get(material).currentProgram in setProgram() for every
    // material renderer.compile()/render() actually touches, so a material
    // is warned about only when ITS OWN program is not runnable, never the
    // first bad program found anywhere in the scene. A material renderer
    // hasn't touched yet (no currentProgram) is skipped silently.
    const reportBadPrograms = (materialsIterable, contextSuffix) => {
        for (const material of materialsIterable) {
            if (!material || !material.userData || !material.userData.mtlxSceneCompiled) continue;
            const props = renderer.properties.get(material);
            const program = props && props.currentProgram;
            if (!program || !program.diagnostics || program.diagnostics.runnable !== false) continue;
            const diagnostics = program.diagnostics;
            const label = material.userData.mtlxSceneSourceAsset || material.name || 'material';
            const log = diagnostics.programLog || (diagnostics.fragmentShader && diagnostics.fragmentShader.log) || (diagnostics.vertexShader && diagnostics.vertexShader.log);
            warnings.push('GPU program compilation failed for MaterialX material: ' + label + (contextSuffix || '')
                + (log ? ' (' + String(log).slice(0, 180) + ')' : ''));
            report({ phase: 'gpu-program', label, status: 'error', error: log || 'program is not runnable' });
        }
    };
    const geometries = new Set();
    const textureCache = new Map();
    const textureQueue = { tail: Promise.resolve() };
    const documents = new Set();
    const prims = [];
    let rebuildingProvisional = null;
    const scene = new THREE.Scene();
    // One shadow caster only: MaterialX's generated `occlusion` is a single
    // per-fragment scalar shared by every light and the environment, so there
    // is nowhere to put a second map.
    let shadowTarget = null;
    let shadowDepthMaterial = null;
    let shadowMatrix = null;
    let shadowsEnabled = storedSceneShadows();
    let shadowDirty = true;
    const disposeShadowResources = () => {
        if (shadowTarget) { shadowTarget.dispose(); shadowTarget = null; }
        if (shadowDepthMaterial) { shadowDepthMaterial.dispose(); shadowDepthMaterial = null; }
    };
    // Applies the sidebar toggle and EV multiplier without rebuilding the
    // converted list, so both are live controls.
    const activeStageLights = () => {
        if (!stageLightsEnabled || !stageLights.length) return null;
        const gain = Math.pow(2, stageLightsEv);
        return stageLights.map((light) => Object.assign({}, light, { intensity: light.intensity * gain }));
    };
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    camera.position.set(0, 0, 4);
    let env = null;
    let mxEnv = null;
    let domeLight = null;
    let domeEnv = null;
    let stageLights = [];
    let stageLightsEnabled = storedSceneStageLights();
    let stageLightsEv = storedSceneStageLightsEv();
    const sceneOptions = {
        udimTileSize: Math.max(128, Number(udimTileSize) || 512),
        udimMaxTiles: Math.max(1, Number(udimMaxTiles) || 1024),
        udimMaxBytes: Math.max(4 * 1024 * 1024, Number(udimMaxBytes) || 256 * 1024 * 1024),
        textureMaxSize: Number.isFinite(Number(textureMaxSize)) || textureMaxSize === Infinity
            ? Math.max(128, Number(textureMaxSize) || storedSceneTextureMaxSize())
            : storedSceneTextureMaxSize(),
        // Any positive finite override is honored as-is (specs pass small
        // budgets); persistence still only happens for the 1/2/4 GiB steps.
        textureMaxBytes: (Number(textureMaxBytes) > 0) ? Number(textureMaxBytes) : storedSceneTextureBudgetBytes(),
    };
    const textureStats = { jobs: 0, loaded: 0, failed: 0, udimTiles: 0, udimBytes: 0, bytesReserved: 0, ordinaryBytes: 0, ktx2Substituted: 0 };
    let samplerReport = [];
    const textureReservations = new Set();
    // One shared budget: ordinary and UDIM textures both reserve against
    // textureMaxBytes and both resize to plannedTextureSize, decided once up
    // front by planTextureSize (below), not degraded mid-stream as textures
    // are bound. udimMaxTiles is kept only as a sanity cap.
    let plannedTextureSize = sceneOptions.textureMaxSize;
    let plannedBytes = 0;
    let fullBytes = 0;
    // Reads every unique texture referenced by the compiled materials
    // (ordinary refs plus UDIM tiles), estimates decoded bytes per texture
    // at each tier in the ladder [requested, 4096, 2048, 1024, 512] (capped
    // at the requested tier), and picks the largest tier whose total fits
    // sceneOptions.textureMaxBytes, else 512. Called before any texture is
    // bound, and again by setTextureMaxSize/setTextureBudgetBytes before
    // their display rebuild.
    const planTextureSize = async (compiledList) => {
        const entries = new Map(); // path -> { blob, ext, mipmapped }
        for (const compiled of compiledList) {
            if (!compiled || !Array.isArray(compiled.introspected)) continue;
            for (const u of compiled.introspected) {
                if (u.type !== 'filename' || u.data == null) continue;
                if (/<UDIM>/i.test(String(u.data))) {
                    const tiles = sceneUdimTiles(u.data, fileMap);
                    tiles.forEach((hit) => { if (hit && !entries.has(hit.path)) entries.set(hit.path, hit.blob); });
                    continue;
                }
                const hit = sceneExactFile(fileMap, u.data, '');
                if (hit && !entries.has(hit.path)) entries.set(hit.path, hit.blob);
            }
        }
        const dims = await Promise.all(Array.from(entries.entries()).map(async ([path, blob]) => {
            const ext = String(path).split('.').pop().toLowerCase();
            let dimensions = null;
            try { dimensions = window.readImageDimensions ? await window.readImageDimensions(blob) : null; } catch (e) { dimensions = null; }
            const w = (dimensions && dimensions.width) || 4096;
            const h = (dimensions && dimensions.height) || 4096;
            const isFloat = ext === 'exr' || ext === 'hdr';
            const mipmapped = !isFloat; // 8-bit formats get mips; float unbounded formats do not
            // KTX2 (UASTC, our cook script's only mode) already carries its own
            // mip chain at ~1 byte/pixel; the 4/3 factor below still applies.
            const bytesPerPixel = ext === 'ktx2' ? 1 : (isFloat ? 16 : 4);
            return { w, h, bytesPerPixel, mipmapped };
        }));
        const textureCount = dims.length;
        const requested = Number.isFinite(sceneOptions.textureMaxSize) ? sceneOptions.textureMaxSize : Infinity;
        const ladder = Array.from(new Set([requested, 4096, 2048, 1024, 512]
            .filter((value) => value <= requested))).sort((a, b) => b - a);
        if (!ladder.length) ladder.push(512);
        const estimateAt = (tier) => dims.reduce((total, d) => {
            const w = Math.min(d.w, tier), h = Math.min(d.h, tier);
            return total + w * h * d.bytesPerPixel * (d.mipmapped ? 4 / 3 : 1);
        }, 0);
        fullBytes = estimateAt(requested === Infinity ? Math.max(4096, ...dims.map((d) => Math.max(d.w, d.h)), 1) : requested);
        let chosen = 512;
        for (const tier of ladder) {
            const estimate = estimateAt(tier);
            if (estimate <= sceneOptions.textureMaxBytes) { chosen = tier; plannedBytes = estimate; break; }
            plannedBytes = estimate;
        }
        if (!ladder.includes(chosen)) { chosen = 512; plannedBytes = estimateAt(512); }
        plannedTextureSize = chosen;
        const udimTileCount = dims.length ? Array.from(entries.keys()).filter((path) => /\.(\d{4})\./.test(path) || /1[0-9]{3}/.test(path)).length : 0;
        if (chosen < requested) {
            const requestedLabel = requested === Infinity ? 'Original' : requested + ' px';
            warnings.push('Texture budget: ' + textureCount + ' textures (' + udimTileCount + ' UDIM tiles) loaded at ' + chosen
                + ' px; requested ' + requestedLabel + ' needs ' + formatGB(fullBytes)
                + ', planned ' + formatMB(plannedBytes) + ' of the ' + formatGB(sceneOptions.textureMaxBytes) + ' budget');
        }
        return chosen;
    };
    const reserveTexture = (path, isUdim = false, bytesOverride = null) => {
        const key = String(path || '');
        if (textureReservations.has(key)) return true;
        const estimate = bytesOverride != null ? bytesOverride : Math.ceil(4 * plannedTextureSize * plannedTextureSize * 4 / 3);
        if (textureStats.ordinaryBytes + estimate > sceneOptions.textureMaxBytes) return false;
        textureReservations.add(key);
        if (isUdim) textureStats.udimTiles += 1;
        textureStats.ordinaryBytes += estimate;
        textureStats.bytesReserved += estimate;
        return true;
    };
    // EXR/HDR/TIF are not resized by createImageBitmap (the bounded PNG/JPEG
    // path), so they are decoded then explicitly bounded to the planned tier
    // via boundDecodedTexture before their real bytes are known/reserved.
    const decodeUnboundedSceneTexture = async (blob, ext, path, fallback) => {
        let tex = null;
        try {
            if (ext === 'ktx2') tex = await window.loadKtx2Texture(blob, null, path);
            else if (ext === 'exr') tex = await window.loadExrTexture(blob);
            else if (ext === 'hdr') tex = await window.loadHdrTexture(blob);
            else tex = await window.loadTifTexture(blob, path);
        } catch (error) {
            if (ext === 'ktx2' && error && error.ktx2InvalidBaseLevel && fallback && fallback.blob && fallback.path !== path) {
                const notice = 'KTX2 texture ' + path + ' is not a multiple of 4; falling back to ' + fallback.path;
                if (!udimWarnings.has(notice)) { udimWarnings.add(notice); warnings.push(notice); }
                const fallbackExt = String(fallback.path).split('.').pop().toLowerCase();
                if (UNBOUNDED_TEXTURE_EXTENSIONS.includes(fallbackExt)) {
                    return decodeUnboundedSceneTexture(fallback.blob, fallbackExt, fallback.path, null);
                }
                // Ordinary 8-bit source (png/jpg): bound it the same way the
                // regular (non-unbounded) texture path does.
                try {
                    const boundedTex = await window.loadBoundedBitmapTexture(fallback.blob, plannedTextureSize);
                    if (!boundedTex) return null;
                    window.configureLoadedTexture(boundedTex);
                    const bytes = Math.ceil((boundedTex.image.width || 0) * (boundedTex.image.height || 0) * 4 * 4 / 3);
                    return { tex: boundedTex, bytes };
                } catch (e) { return null; }
            }
            const warning = (error && error.message) || ('MaterialX texture decode failed for ' + (path || '(unknown)'));
            if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
            return null;
        }
        if (!tex || !tex.image) {
            const warning = 'MaterialX texture decode failed for ' + (path || '(unknown)');
            if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
            return null;
        }
        if (ext === 'ktx2') {
            // Already GPU block data with its own mip chain: cap by dropping
            // the largest levels instead of resampling, then bytes are the
            // exact sum of the kept levels (no 4/3 mip-factor estimate).
            const bytes = window.capKtx2MipLevels(tex, plannedTextureSize);
            window.configureLoadedTexture(tex);
            return { tex, bytes };
        }
        try {
            tex = await window.boundDecodedTexture(tex, plannedTextureSize);
        } catch (e) { /* keep the undecimated texture rather than fail the material */ }
        const isFloat = ext === 'exr' || ext === 'hdr';
        const bytesPerPixel = isFloat ? 16 : 4;
        const mipFactor = (!isFloat && tex.generateMipmaps) ? 4 / 3 : 1;
        const bytes = Math.ceil((tex.image.width || 0) * (tex.image.height || 0) * bytesPerPixel * mipFactor);
        window.configureLoadedTexture(tex);
        return { tex, bytes };
    };
    const udimWarnings = new Set();
    const compiledByPath = new Map();
    const programByKey = new Map();
    const sourceXmlByRecord = new WeakMap();
    const materialRecords = new Map();

    // USD `over` blocks recorded by the worker (usd-stage-worker.js
    // collectMaterialOverrides) as { node, input, value } text triples.
    // node is null when the attribute sits on the Material prim itself,
    // meaning it targets the bound surface shader node.
    const findMxNode = (doc, name) => {
        let node = window.mxSafe(() => doc.getNode(name), null);
        if (node) return node;
        const graphs = window.vecToArray(window.mxSafe(() => doc.getNodeGraphs(), []));
        for (const graph of graphs) {
            node = window.mxSafe(() => graph.getNode(name), null);
            if (node) return node;
        }
        return null;
    };
    const findOrAddInput = (node, inputName) => {
        let input = window.mxSafe(() => node.getInput(inputName), null);
        if (input) return input;
        input = window.mxSafe(() => (typeof node.addInputFromNodeDef === 'function' ? node.addInputFromNodeDef(inputName) : null), null);
        return input || null;
    };
    const convertUsdOverrideValue = (rawText, declaredType, baseDirs) => {
        const raw = String(rawText || '').trim();
        if (declaredType === 'filename' || declaredType === 'asset') {
            const match = raw.match(/^@(.*)@$/);
            const ref = match ? match[1] : raw;
            // USD resolves the asset against the layer that authored the
            // override; that layer normally sits beside the .mtlx, so try the
            // material's directory first and the stage root as a fallback.
            const candidates = baseDirs.map((dir) => sceneJoinPath(dir, ref));
            return candidates.find((candidate) => fileMap[candidate]) || candidates[0];
        }
        if (/^\(.*\)$/.test(raw)) return raw.slice(1, -1).split(',').map((v) => v.trim()).join(', ');
        return raw; // bool/number/plain string, verbatim
    };
    // Applies one material record's overrides onto its freshly parsed
    // document, before generation. `matchedNode` is the surface shader
    // node already resolved for this record (used when override.node is
    // null). Missing nodes/inputs each push one deduped warning.
    const applyUsdOverrides = (doc, matchedNode, record, baseDirs) => {
        const overrides = Array.isArray(record && record.overrides) ? record.overrides : [];
        if (!overrides.length) return;
        const label = record.materialName || String(record.path || '').split('/').filter(Boolean).pop() || record.sourceAsset || 'material';
        for (const ov of overrides) {
            const targetNode = ov.node ? findMxNode(doc, ov.node) : matchedNode;
            if (!targetNode) {
                const warning = `USD override targets missing MaterialX node "${ov.node}" in ${label}`;
                if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                continue;
            }
            const input = findOrAddInput(targetNode, ov.input);
            if (!input) {
                const nodeLabel = ov.node || window.mxSafe(() => targetNode.getName(), label);
                const warning = `USD override targets missing input "${ov.input}" on node "${nodeLabel}" in ${label}`;
                if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                continue;
            }
            const declaredType = window.mxSafe(() => input.getType(), 'string');
            const value = convertUsdOverrideValue(ov.value, declaredType, baseDirs);
            // A literal override must win over an existing connection, or
            // the generated shader keeps reading the connected node instead.
            window.mxRemoveAttr(input, 'nodename');
            window.mxRemoveAttr(input, 'nodegraph');
            window.mxRemoveAttr(input, 'output');
            window.mxRemoveAttr(input, 'interfacename');
            window.mxWriteValue(input, value, declaredType);
        }
    };

    const loadRenderable = async (record) => {
        if (record && (record.renderable || record.node)) {
            return { node: record.renderable || record.node, document: null };
        }
        const source = sceneNormPath(record && record.sourceAsset);
        const blob = source && fileMap[source];
        if (!blob) throw new Error('MaterialX source asset is unavailable: ' + (record && record.sourceAsset || 'unknown'));
        const raw = await blob.text();
        const resolved = canonicalizeSceneFilenameInputs(
            await resolveSceneIncludes(raw, sceneDir(source), fileMap, new Set([source]), warnings),
            source,
            fileMap,
            true,
        );
        let doc = null;
        try {
            await window.mxExclusive(async () => {
                doc = mxEnv.mx.createDocument();
                await mxEnv.mx.readFromXmlString(doc, resolved);
                if (doc.setDataLibrary) doc.setDataLibrary(mxEnv.stdlib);
                else if (doc.importLibrary) doc.importLibrary(mxEnv.stdlib);
            });
            documents.add(doc);
            sourceXmlByRecord.set(record, raw);
            const renderables = await window.mxExclusive(() => window.listDocRenderables(doc));
            // A native payload without an authored sourceAsset subidentifier
            // still carries the composed USD material alias as a useful
            // name hint.  Try that hint exactly; dropping it makes every
            // multi-material .mtlx (for example the ChessSet black/white
            // documents) look ambiguous.  An explicit subidentifier remains
            // authoritative and is never replaced by the inferred alias.
            const inferredSelection = !!(record &&
                ((record.materialX && record.materialX.selectionIsInferred) || record.selectionIsInferred));
            const explicitName = record.subIdentifier || (!inferredSelection && record.materialName);
            // Without an authored sourceAsset subidentifier, materialName is
            // still the exact composed alias to try. Keep it separate from
            // an explicit selector so a bad authored selector cannot fall
            // through to a different renderable.
            const names = [explicitName, explicitName ? null : record.materialName]
                .filter((value, index, values) => value && values.indexOf(value) === index)
                .map((value) => String(value));
            const usdaDir = [sceneDir(source), sceneDir(stage.rootPath)];
            for (const name of names) {
                const matches = renderables.filter((r) => String(r.name || '') === name);
                if (matches.length === 1) {
                    await window.mxExclusive(() => applyUsdOverrides(doc, matches[0].node, record, usdaDir));
                    return { node: matches[0].node, document: doc };
                }
            }
            // A composed alias can differ from the sole authored renderable
            // name (the common sourceAsset-only case).  This fallback is
            // safe only for the native inferred-selection path; an authored
            // subidentifier that did not match must remain an error.
            if (renderables.length === 1 && !explicitName) {
                await window.mxExclusive(() => applyUsdOverrides(doc, renderables[0].node, record, usdaDir));
                return { node: renderables[0].node, document: doc };
            }
            throw new Error('MaterialX source has no unambiguous renderable for ' + (record.materialName || record.subIdentifier || source));
        } catch (error) {
            if (doc) {
                documents.delete(doc);
                try { doc.delete && doc.delete(); } catch (e) {}
            }
            throw error;
        }
    };

    const applyObjectUniforms = (material, object) => {
        const u = material && material.uniforms;
        if (!u) return;
        object.updateMatrixWorld(true);
        camera.updateMatrixWorld(true);
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        if (u.u_worldMatrix) u.u_worldMatrix.value.copy(object.matrixWorld);
        if (u.u_viewProjectionMatrix) {
            const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
            u.u_viewProjectionMatrix.value.copy(vp);
        }
        if (u.u_worldInverseTransposeMatrix) u.u_worldInverseTransposeMatrix.value.copy(object.matrixWorld).invert().transpose();
        if (u.u_viewPosition) camera.getWorldPosition(u.u_viewPosition.value);
        if (u.u_time && window.MTLX_CLOCK) u.u_time.value = window.MTLX_CLOCK.time;
        if (u.u_frame && window.MTLX_CLOCK) u.u_frame.value = window.MTLX_CLOCK.frame;
        // r128 may retain a material/program upload cache across consecutive
        // draws. Every object has its own uniforms, and this flag makes the
        // per-draw matrices observable even when source/program is shared.
        material.uniformsNeedUpdate = true;
    };

    // Compiles (or returns the cached compile for) one material record,
    // without binding any texture. Returns null when compileMtlxSceneMaterial
    // itself yields nothing (hard failure, caller skips the record), or
    // { compiled: null } for a setup/compile error (caller falls back to a
    // neutral material), or { compiled, cacheKey } on success.
    const ensureCompiledMaterial = async (record, forceCompile = false) => {
        const label = record && (record.materialName || record.path || record.sourceAsset) || 'material';
        if (!window.compileMtlxSceneMaterial || !window.createMtlxSceneUniforms) {
            warnings.push('MaterialX material has no compiled renderable: ' + label);
            return { compiled: null };
        }
        const cacheKey = String(record.path || record.sourceAsset || label) + '|' + String(record.subIdentifier || '') + '|' + String(version || '');
        if (forceCompile) compiledByPath.delete(cacheKey);
        let compiled = compiledByPath.get(cacheKey);
        if (compiled) return { compiled, cacheKey };
        report({ phase: 'material', path: record.path, label, status: 'start' });
        let sourceDocument = null;
        try {
            const loaded = await loadRenderable(record);
            const renderable = loaded.node;
            sourceDocument = loaded.document;
            compiled = await window.compileMtlxSceneMaterial({
                mx: mxEnv.mx, gen: mxEnv.gen, genContext: mxEnv.genContext,
                renderable, label, isMounted, document: sourceDocument,
            });
            if (!compiled) return null;
            // Reuse the engine's hidden KHR warm context before this
            // scene's display WebGL context submits the same source.
            if (window.prewarmShaderCompile) {
                await window.prewarmShaderCompile({ vs: compiled.vs, fs: compiled.fs, isMounted, label });
            }
            compiledByPath.set(cacheKey, compiled);
            if (!programByKey.has(compiled.programKey)) programByKey.set(compiled.programKey, compiled);
            report({ phase: 'material', path: record.path, label, status: 'ready' });
            return { compiled, cacheKey };
        } catch (e) {
            const detail = window.mxErr ? window.mxErr(mxEnv && mxEnv.mx, e) : ((e && e.message) || e);
            warnings.push('MaterialX compile failed for ' + label + ': ' + detail);
            report({ phase: 'material', path: record.path, label, status: 'error', error: String(detail) });
            return { compiled: null };
        } finally {
            // Shader generation has detached its source and uniform data;
            // the temporary embind document must not remain live per
            // material for the lifetime of the scene.
            if (sourceDocument) {
                documents.delete(sourceDocument);
                try { sourceDocument.delete && sourceDocument.delete(); } catch (e) {}
            }
        }
    };

    const makeMtlxMaterial = async (record, forceCompile = false) => {
        const label = record && (record.materialName || record.path || record.sourceAsset) || 'material';
        const ensured = await ensureCompiledMaterial(record, forceCompile);
        if (!ensured) return null;
        if (!ensured.compiled) return { material: sceneNeutralMaterial(label), compiled: null };
        const { compiled, cacheKey } = ensured;
        const uniforms = window.createMtlxSceneUniforms({
            compiled, env, lightData: mxEnv.lightData || [], stageLights: activeStageLights(),
            shadowMap: shadowsEnabled && shadowTarget ? shadowTarget.texture : null, shadowMatrix,
        });
        // USD value overrides (record.overrides) are applied onto the
        // MaterialX document itself in loadRenderable/applyUsdOverrides,
        // before generation, so the compiled shader here already reflects them.
        const material = new THREE.RawShaderMaterial({
            vertexShader: compiled.vs,
            fragmentShader: compiled.fs,
            glslVersion: THREE.GLSL3,
            uniforms,
            side: THREE.DoubleSide,
            transparent: false,
            depthWrite: true,
        });
        material.userData.mtlxSceneCompiled = compiled;
        material.userData.mtlxSceneSourceAsset = record.sourceAsset || '';
        material.userData.mtlxSceneSubIdentifier = record.subIdentifier || '';
        material.userData.mtlxSceneMaterialPath = String(record.path || '');
        material.userData.mtlxSceneTransparent = !!compiled.transparent;
        if (window.applyPeelMaterialMode) {
            window.applyPeelMaterialMode(material, material.userData.mtlxSceneTransparent && window.getForceTransparency && window.getForceTransparency());
        }
        materials.add(material);
        invalidateTransparentMeshCache();
        const pendingTextures = [];
        const udimRefs = [];
        // Existing filename binding understands the generated introspection
        // shape. It is deliberately additive; missing files leave defaults.
        if (window.bindDroppedTextures && Object.keys(fileMap).length) {
            const prefix = sceneFilePrefix(sourceXmlByRecord.get(record) || '');
            for (const u of compiled.introspected || []) {
                if (u.type !== 'filename' || u.data == null) continue;
                if (/<UDIM>/i.test(String(u.data))) {
                    const tiles = sceneUdimTiles(u.data, fileMap);
                    tiles.forEach((tile) => { if (tile.substituted) textureStats.ktx2Substituted += 1; });
                    udimRefs.push({ uniform: u, tiles });
                    continue;
                }
                // Filename values were canonicalized against their declaring
                // MaterialX document before generation. Do not retry with a
                // basename or parent prefix: that can bind a duplicate file
                // from an unrelated layer.
                const hit = sceneExactFile(fileMap, u.data, '');
                if (!hit) { warnings.push('Texture file unavailable for ' + label + ': ' + u.data); continue; }
                if (hit.substituted) textureStats.ktx2Substituted += 1;
                const extension = String(hit.path).split('.').pop().toLowerCase();
                if (UNBOUNDED_TEXTURE_EXTENSIONS.includes(extension)) {
                    // Decode+bound first (boundDecodedTexture inside), then
                    // account the real post-resize bytes via the bytes
                    // override so a rebuild does not double count.
                    const fallbackHit = hit.substituted && hit.originalBlob
                        ? { path: hit.originalPath, blob: hit.originalBlob } : null;
                    pendingTextures.push(decodeUnboundedSceneTexture(hit.blob, extension, hit.path, fallbackHit).then((result) => {
                        if (!result) return;
                        const { tex, bytes } = result;
                        if (!reserveTexture(hit.path, false, bytes)) {
                            warnings.push('Texture preview budget exceeded for ' + hit.path);
                            tex.dispose && tex.dispose();
                            return;
                        }
                        if (uniforms[u.name]) uniforms[u.name].value = tex;
                    }, (error) => ({ error })));
                    continue;
                }
                if (!reserveTexture(hit.path)) { warnings.push('Texture preview budget exceeded for ' + hit.path); continue; }
                const binding = window.bindDroppedTextures({
                uniforms,
                introspected: [u],
                textureCache,
                textureQueue,
                maxTextureSize: plannedTextureSize,
                isAlive: () => !stopped && isMounted(),
                }, { [hit.path]: hit.blob });
                pendingTextures.push(...(binding && binding.pending || []));
            }
        }
        return { material, compiled, pendingTextures, udimRefs, cacheKey,
            materialPath: String(record.path || '') };
    };

    try {
        report({ phase: 'renderer', status: 'start' });
        mxEnv = await window.getMxEnv(version);
        const userEnv = await window.getEnvOverride();
        env = userEnv || await window.getEnvironment();
        // A stage's own dome light is its authored lighting, so apply it
        // unless the user already imported an environment this session.
        if (!userEnv) {
            const domeResult = await sceneDomeEnvironment(stage, fileMap, warnings);
            if (domeResult && domeResult.env) {
                env = domeResult.env;
                domeEnv = domeResult.env;
                domeLight = domeResult.descriptor;
            }
        }
        if (window.convertUsdStageLights) {
            try {
                stageLights = window.convertUsdStageLights(stage.lights, {
                    rootMatrix: sceneRootMatrix(stage),
                    limit: 8,
                    warn: (message) => { if (warnings.indexOf(message) < 0) warnings.push(message); },
                });
            } catch (e) {
                warnings.push('Stage light import failed: ' + String(e && e.message || e));
                stageLights = [];
            }
        }
        if (!isMounted()) throw new Error('USD scene view was cancelled.');
        const byPath = new Map();
        const pendingTextures = [];
        const awaitTextureJobs = async (jobs) => {
            if (!jobs.length) return;
            const total = jobs.length;
            let done = 0;
            report({ phase: 'texture', done: 0, total, loaded: 0, failed: 0, udimTiles: textureStats.udimTiles });
            const watched = jobs.map((job) => Promise.resolve(job).then((result) => {
                done += 1;
                textureStats.jobs += 1;
                if (result && result.error) {
                    textureStats.failed += 1;
                    warnings.push('MaterialX texture decode failed: ' + String(result.error.message || result.error));
                } else textureStats.loaded += 1;
                report({ phase: 'texture', done, total, loaded: textureStats.loaded, failed: textureStats.failed,
                    udimTiles: textureStats.udimTiles });
                return result;
            }));
            await Promise.all(watched);
        };
        const missingBindingWarnings = new Set();
        const materialForPath = (path, label) => {
            const key = String(path || '');
            const info = byPath.get(key);
            if (info) return info.material;
            if (key && !missingBindingWarnings.has(key)) {
                missingBindingWarnings.add(key);
                warnings.push('USD material binding has no compiled MaterialX material: ' + key + (label ? ' (' + label + ')' : ''));
            }
            return sceneNeutralMaterial(key || label || 'unbound');
        };
        // Compile every material first (cheap on the second pass below, since
        // it just hits compiledByPath) so the ordinary-texture size tier can
        // be planned from the full reference count before any texture binds.
        const precompiled = [];
        for (const record of sceneArray(stage.materials)) {
            const ensured = await ensureCompiledMaterial(record);
            if (ensured && ensured.compiled) precompiled.push(ensured.compiled);
        }
        await planTextureSize(precompiled);
        for (const record of sceneArray(stage.materials)) {
            const result = await makeMtlxMaterial(record);
            if (result) {
                byPath.set(String(record.path || ''), result);
                materialRecords.set(String(record.path || ''), record);
                pendingTextures.push(...(result.pendingTextures || []));
            }
        }
        await awaitTextureJobs(pendingTextures);
        // These jobs have settled; only variant jobs created during mesh
        // partitioning belong to the later wait below.
        pendingTextures.length = 0;
        const udimVariantByMaterial = new Map();
        const udimMaterial = (info, code, label) => {
            if (!info || !info.udimRefs || !info.udimRefs.length) return info && info.material;
            const key = String(info.cacheKey || label) + '|' + code;
            if (udimVariantByMaterial.has(key)) return udimVariantByMaterial.get(key);
            if (textureStats.udimTiles >= sceneOptions.udimMaxTiles) {
                const warning = 'UDIM preview budget exceeded for ' + label + ' tile ' + code;
                if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                const fallback = sceneNeutralMaterial(label + ' UDIM budget');
                materials.add(fallback);
                udimVariantByMaterial.set(key, fallback);
                return fallback;
            }
            const tileHits = info.udimRefs.map((entry) => entry.tiles.get(code) || null);
            if (tileHits.some((hit) => !hit)) {
                const warning = 'Missing UDIM tile ' + code + ' for ' + label;
                if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                const fallback = sceneNeutralMaterial(label + ' missing UDIM ' + code);
                materials.add(fallback);
                udimVariantByMaterial.set(key, fallback);
                return fallback;
            }
            // Real bytes for exr/hdr/tif tiles are only known after decode,
            // so those hits skip this pre-emptive udimTileSize-based
            // reservation and are budgeted individually below instead.
            if (tileHits.some((hit) => {
                const ext = String(hit.path).split('.').pop().toLowerCase();
                if (UNBOUNDED_TEXTURE_EXTENSIONS.includes(ext)) return false;
                return !reserveTexture(hit.path, true);
            })) {
                const warning = 'UDIM preview budget exceeded for ' + label + ' tile ' + code;
                if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                const fallback = sceneNeutralMaterial(label + ' UDIM budget');
                materials.add(fallback);
                udimVariantByMaterial.set(key, fallback);
                return fallback;
            }
            const uniforms = sceneCloneUniforms(info.material.uniforms);
            const material = new THREE.RawShaderMaterial({
                vertexShader: info.compiled.vs,
                fragmentShader: info.compiled.fs,
                glslVersion: THREE.GLSL3,
                uniforms,
                side: THREE.DoubleSide,
                transparent: false,
                depthWrite: true,
            });
            material.userData.mtlxSceneCompiled = info.compiled;
            material.userData.mtlxSceneSourceAsset = label;
            material.userData.mtlxSceneMaterialPath = info.materialPath || '';
            material.userData.mtlxSceneUdimTile = code;
            material.userData.mtlxSceneTransparent = !!info.compiled.transparent;
            if (window.applyPeelMaterialMode) {
                window.applyPeelMaterialMode(material, material.userData.mtlxSceneTransparent && window.getForceTransparency && window.getForceTransparency());
            }
            materials.add(material);
            invalidateTransparentMeshCache();
            const pending = [];
            info.udimRefs.forEach((entry, index) => {
                const hit = tileHits[index];
                const ext = String(hit.path).split('.').pop().toLowerCase();
                if (UNBOUNDED_TEXTURE_EXTENSIONS.includes(ext)) {
                    const fallbackHit = hit.substituted && hit.originalBlob
                        ? { path: hit.originalPath, blob: hit.originalBlob } : null;
                    pending.push(decodeUnboundedSceneTexture(hit.blob, ext, hit.path, fallbackHit).then((result) => {
                        if (!result) return;
                        const { tex, bytes } = result;
                        if (!reserveTexture(hit.path, true, bytes)) {
                            const warning = 'UDIM preview budget exceeded for ' + label + ' tile ' + code;
                            if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                            tex.dispose && tex.dispose();
                            return;
                        }
                        if (uniforms[entry.uniform.name]) uniforms[entry.uniform.name].value = tex;
                    }, (error) => ({ error })));
                    return;
                }
                const bindingUniform = Object.assign({}, entry.uniform, { data: hit.path });
                const binding = window.bindDroppedTextures({
                    uniforms,
                    introspected: [bindingUniform],
                    textureCache,
                    textureQueue,
                    maxTextureSize: plannedTextureSize,
                    isAlive: () => !stopped && isMounted(),
                }, { [hit.path]: hit.blob });
                pending.push(...(binding && binding.pending || []));
            });
            material.userData.mtlxScenePendingTextures = pending;
            udimVariantByMaterial.set(key, material);
            return material;
        };
        const meshParts = (record, materialForPath) => {
            const positions = record.positions;
            const normals = record.normals;
            const uvs = record.uvs;
            const originalGroups = sceneArray(record.groups);
            const originalMaterialPaths = originalGroups.length
                ? originalGroups.map((group) => group && (group.materialPath || record.materialPath))
                : [record.materialPath];
            const needsUdimPartition = originalMaterialPaths.some((path) => {
                const info = byPath.get(String(path || ''));
                return !!(info && info.udimRefs && info.udimRefs.length);
            });
            if (!needsUdimPartition) {
                const geometry = sceneGeometry(record);
                if (!geometry) return [];
                const material = originalGroups.length
                    ? originalMaterialPaths.map((path) => materialForPath(path, record.primPath || record.name))
                    : materialForPath(record.materialPath, record.primPath || record.name);
                (Array.isArray(material) ? material : [material]).forEach((entry) => materials.add(entry));
                return [{ geometry, material }];
            }
            const sourceIndices = record.indices && record.indices.length
                ? Array.from(record.indices) : Array.from({ length: positions.length / 3 }, (_, i) => i);
            const groups = sceneArray(record.groups).filter((g) => g && g.count > 0);
            if (!groups.length) groups.push({ start: 0, count: sourceIndices.length, materialPath: record.materialPath });
            const parts = [];
            for (const group of groups) {
                const materialPath = group.materialPath || record.materialPath || '';
                const info = byPath.get(String(materialPath));
                const udimRefs = info && info.udimRefs || [];
                const start = Math.max(0, Number(group.start) || 0);
                const end = Math.min(sourceIndices.length, start + Math.max(0, Number(group.count) || 0));
                const buckets = new Map();
                for (let cursor = start; cursor + 2 < end; cursor += 3) {
                    const tri = [sourceIndices[cursor], sourceIndices[cursor + 1], sourceIndices[cursor + 2]];
                    let tile = null;
                    let crossing = false;
                    if (udimRefs.length) {
                        if (!uvs || uvs.length < (positions.length / 3) * 2) crossing = true;
                        else {
                            const classification = sceneUdimTriangle(uvs, tri);
                            crossing = !classification || classification.crossing === true;
                            if (!crossing) tile = classification;
                        }
                        if (crossing) {
                            const warning = 'Unsupported UDIM UV crossing or missing UVs on ' + String(record.primPath || record.name || materialPath);
                            if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                        }
                    }
                    const bucketKey = crossing ? 'neutral' : (tile ? String(tile.code) : 'base');
                    let bucket = buckets.get(bucketKey);
                    if (!bucket) { bucket = { triangles: [], tile, crossing }; buckets.set(bucketKey, bucket); }
                    bucket.triangles.push(tri);
                }
                buckets.forEach((bucket) => {
                    const vertexMap = new Map();
                    const outPositions = [], outNormals = [], outUvs = [], outIndices = [];
                    const addVertex = (sourceIndex) => {
                        if (vertexMap.has(sourceIndex)) return vertexMap.get(sourceIndex);
                        const n = vertexMap.size;
                        outPositions.push(positions[sourceIndex * 3], positions[sourceIndex * 3 + 1], positions[sourceIndex * 3 + 2]);
                        if (normals && normals.length >= positions.length) outNormals.push(normals[sourceIndex * 3], normals[sourceIndex * 3 + 1], normals[sourceIndex * 3 + 2]);
                        if (uvs && uvs.length >= (positions.length / 3) * 2) {
                            // Keep authored/global UVs. RepeatWrapping maps
                            // each tile's integer offset to the same local
                            // sampler range without changing procedural or
                            // ordinary image coordinates.
                            outUvs.push(uvs[sourceIndex * 2], uvs[sourceIndex * 2 + 1]);
                        }
                        vertexMap.set(sourceIndex, n);
                        return n;
                    };
                    bucket.triangles.forEach((tri) => tri.forEach((index) => outIndices.push(addVertex(index))));
                    const geometry = new THREE.BufferGeometry();
                    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(outPositions), 3));
                    geometry.setIndex(outIndices);
                    if (outNormals.length) geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(outNormals), 3));
                    else geometry.computeVertexNormals();
                    if (outUvs.length) geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(outUvs), 2));
                    if (window.prepGeometry) window.prepGeometry(geometry);
                    const material = bucket.crossing ? sceneNeutralMaterial('UDIM UV crossing')
                        : (bucket.tile ? udimMaterial(info, bucket.tile.code, materialPath) : materialForPath(materialPath, record.primPath || record.name));
                    materials.add(material);
                    const bucketCompiled = material.userData && material.userData.mtlxSceneCompiled;
                    if (window.bindGeompropAttributes && bucketCompiled && bucketCompiled.geomprops) {
                        window.bindGeompropAttributes(geometry, bucketCompiled.geomprops, (text) => {
                            if (!warnings.includes(text)) warnings.push(text);
                        });
                    }
                    parts.push({ geometry, material });
                });
            }
            return parts;
        };
        // A stage dome seeds rotation and exposure so the render matches the
        // authored lighting; the sidebar mirrors these through getDomeLight().
        let envRotationRad = domeLight ? domeLight.rotationDeg * Math.PI / 180 : 0;
        let envExposure = domeLight ? domeLight.exposure : 1;
        // Renders the moments map from the brightest stage light, or from the
        // environment key direction when the stage has none. Runs on demand,
        // never per frame: nothing here changes while the camera moves.
        const updateShadowMap = () => {
            if (!shadowsEnabled || !sceneRoot) { shadowMatrix = null; return; }
            const box = new THREE.Box3().setFromObject(sceneRoot);
            if (box.isEmpty()) return;
            const center = box.getCenter(new THREE.Vector3());
            const radius = Math.max(1e-6, box.getSize(new THREE.Vector3()).length() * 0.5);
            // Directional only, deliberately. A point light sits inside the
            // scene, so no single 2D map can cover it: everything outside the
            // frustum clamps to edge texels and smears. MaterialX has one map
            // and no bounds check, so an orthographic frustum that encloses the
            // whole stage is the only shape that is correct everywhere.
            const lights = (activeStageLights() || []).filter((l) => l.type === 1);
            const caster = lights.slice().sort((a, b) => b.intensity - a.intensity)[0];
            const dir = caster ? caster.direction.clone()
                : ((env && env.keyLight && env.keyLight.direction) || (env && env.softKeyDir) || new THREE.Vector3(-0.4, -1, 0.7)).clone();
            if (dir.lengthSq() < 1e-9) dir.set(-0.4, -1, 0.7);
            dir.normalize();
            const extent = radius * 1.05;
            const shadowCamera = new THREE.OrthographicCamera(-extent, extent, extent, -extent, 0.01, radius * 4);
            shadowCamera.position.copy(center).addScaledVector(dir, -radius * 2);
            shadowCamera.lookAt(center);
            shadowCamera.updateMatrixWorld(true);
            shadowCamera.updateProjectionMatrix();
            if (!shadowTarget) {
                shadowTarget = new THREE.WebGLRenderTarget(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, {
                    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
                    format: THREE.RGBAFormat, type: THREE.HalfFloatType, depthBuffer: true,
                    // Clamped to a white border-equivalent: mx_shadow_occlusion
                    // does not bounds-check, so anything outside the frustum
                    // must read as unshadowed rather than repeat the map.
                    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
                });
            }
            if (!shadowDepthMaterial) shadowDepthMaterial = createShadowDepthMaterial();
            // Only stage geometry casts: the backdrop and catcher would wrap
            // the scene and shadow everything.
            const hidden = [];
            scene.traverse((object) => {
                if (object.isMesh && object.userData && object.userData.excludeFromFrame && object.visible) {
                    object.visible = false; hidden.push(object);
                }
            });
            const previousTarget = renderer.getRenderTarget();
            scene.overrideMaterial = shadowDepthMaterial;
            renderer.setRenderTarget(shadowTarget);
            renderer.setClearColor(0xffffff, 1); // white moments read as fully lit
            renderer.clear();
            renderer.render(scene, shadowCamera);
            scene.overrideMaterial = null;
            renderer.setRenderTarget(previousTarget);
            renderer.setClearColor(0x111827, 1);
            hidden.forEach((object) => { object.visible = true; });
            // MaterialX applies the *0.5+0.5 itself, so this stays a raw
            // world-to-light-clip matrix, unlike three's shadow.matrix.
            shadowMatrix = new THREE.Matrix4().multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse);
            shadowDirty = false;
        };
        const applyMaterialEnvironment = () => {
            const radiance = env && env.radiance;
            if (radiance && radiance.isTexture && (radiance.minFilter !== THREE.LinearMipmapLinearFilter || !radiance.generateMipmaps)) {
                console.warn('usd-scene-renderer: env.radiance lost its mip chain (minFilter or generateMipmaps reset), restoring it.');
                radiance.minFilter = THREE.LinearMipmapLinearFilter;
                radiance.generateMipmaps = true;
                radiance.needsUpdate = true;
            }
            for (const material of materials) {
                const compiled = material.userData && material.userData.mtlxSceneCompiled;
                if (!compiled || !window.createMtlxSceneUniforms) continue;
                const next = window.createMtlxSceneUniforms({
                    compiled, env, lightData: mxEnv.lightData || [], stageLights: activeStageLights(),
                    shadowMap: shadowsEnabled && shadowTarget ? shadowTarget.texture : null, shadowMatrix,
                    envRotationRad, envExposure,
                });
                for (const [name, slot] of Object.entries(next)) {
                    if (!(/^(?:u_env|u_lightData$|u_numActiveLightSources$|u_shadowMap$|u_shadowMatrix$)/).test(name) || !material.uniforms[name]) continue;
                    const current = material.uniforms[name].value;
                    if ((current && current.isTexture) || (slot.value && slot.value.isTexture)) material.uniforms[name].value = slot.value;
                    else if (current && typeof current.copy === 'function' && slot.value && typeof slot.value.copy === 'function') current.copy(slot.value);
                    else material.uniforms[name].value = slot.value;
                }
                material.uniformsNeedUpdate = true;
            }
        };
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        // r128's blend-state cache otherwise corrupts VSM and PMREM passes;
        // see js/mtlx-engine.js:4290-4292 for the same reset after construction.
        renderer.resetState();
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setClearColor(0x111827, 1);
        const displayTransform = window.getDisplayTransform && window.getDisplayTransform();
        if (displayTransform && 'outputEncoding' in renderer) {
            renderer.outputEncoding = displayTransform === 'lin_rec709' ? THREE.LinearEncoding : THREE.sRGBEncoding;
        }
        if ('toneMapping' in renderer) {
            renderer.toneMapping = displayTransform === 'aces' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
            renderer.toneMappingExposure = 1;
        }
        // linearComposite:false forces the display-space peel path (the
        // Scene's u_peelLinear stays hard 0, see createMtlxSceneUniforms);
        // a linear merged pass is a recorded follow-up, not this pass.
        peelPipeline = window.createPeelPipeline ? window.createPeelPipeline(renderer, { linearComposite: false, opaqueOutput: true }) : null;
        if (THREE.OrbitControls) {
            controls = new THREE.OrbitControls(camera, canvas);
            controls.enableDamping = true;
        }
        const sceneRoot = new THREE.Group();
        const upAxis = String(stage.upAxis || 'Y').toUpperCase();
        if (upAxis === 'Z') sceneRoot.rotation.x = -Math.PI / 2;
        const meters = Number(stage.metersPerUnit);
        if (Number.isFinite(meters) && meters > 0) sceneRoot.scale.setScalar(meters);
        scene.add(sceneRoot);
        if (window.createUsdSceneEnvironment) {
            environmentBridge = window.createUsdSceneEnvironment({ scene, renderer, camera, contentRoot: sceneRoot });
            if (env) environmentBridge.setEnvironment(env);
            if (domeLight) {
                environmentBridge.setEnvRotation(envRotationRad);
                environmentBridge.setEnvExposure(envExposure);
            }
        }
        for (let i = 0; i < stage.meshes.length; i++) {
            if (!isMounted() || stopped) throw new Error('USD scene view was cancelled.');
            const record = stage.meshes[i];
            if (!record || !record.positions || record.positions.length < 3) {
                warnings.push('Skipped mesh without valid positions: ' + String(record && (record.primPath || record.name) || i));
                continue;
            }
            const instanceMatrices = sceneInstanceMatrices(record.instanceMatrices);
            if (record.instanceMatricesInvalid) {
                warnings.push('Skipped PointInstancer mesh with invalid instance matrices: ' + String(record.primPath || record.name || i));
                continue;
            }
            if (record.instanceMatrices != null && !instanceMatrices.length) continue;
            const parts = meshParts(record, materialForPath);
            if (!parts.length) { warnings.push('Skipped mesh without triangle faces: ' + String(record.primPath || record.name || i)); continue; }
            // An explicit empty matrix array means the PointInstancer has no
            // visible instances.  Only ordinary meshes with the field absent
            // get the single parent-matrix draw.
            const drawMatrices = record.instanceMatrices != null ? instanceMatrices : [null];
            const parentMatrix = sceneMatrix(record.matrix);
            parts.forEach((part, partIndex) => {
                geometries.add(part.geometry);
                const partMaterials = Array.isArray(part.material) ? part.material : [part.material];
                partMaterials.forEach((material) => materials.add(material));
                if (window.bindGeompropAttributes) {
                    const seen = new Map();
                    for (const material of partMaterials) {
                        const compiled = material.userData && material.userData.mtlxSceneCompiled;
                        for (const gp of (compiled && compiled.geomprops) || []) seen.set(gp.name, gp);
                    }
                    if (seen.size) {
                        window.bindGeompropAttributes(part.geometry, Array.from(seen.values()), (text) => {
                            if (!warnings.includes(text)) warnings.push(text);
                        });
                    }
                }
                if (part.material.userData && part.material.userData.mtlxScenePendingTextures) {
                    pendingTextures.push(...part.material.userData.mtlxScenePendingTextures);
                    delete part.material.userData.mtlxScenePendingTextures;
                }
                drawMatrices.forEach((instanceMatrix, instanceIndex) => {
                    const object = new THREE.Mesh(part.geometry, part.material);
                    const partSuffix = parts.length > 1 ? '-part-' + partIndex : '';
                    const instanceSuffix = instanceMatrix ? '-instance-' + instanceIndex : '';
                    object.name = String(record.name || record.primPath || ('mesh-' + i)) + partSuffix + instanceSuffix;
                    // The generated MeshUpdate path identifies the prototype
                    // geometry.  Use the owner path for selection and retain
                    // the generated path/index for diagnostics and picking.
                    object.userData.primPath = String(record.instanceOwnerPath || record.primPath || '');
                    object.userData.geometryPath = String(record.primPath || '');
                    object.userData.instanceIndex = instanceMatrix ? instanceIndex : undefined;
                    object.userData.materialPath = String(record.materialPath || '');
                    object.matrixAutoUpdate = false;
                    const worldMatrix = parentMatrix.clone();
                    if (instanceMatrix) worldMatrix.multiply(sceneMatrix(instanceMatrix));
                    object.matrix.copy(worldMatrix);
                    object.castShadow = true;
                    object.receiveShadow = true;
                    object.updateMatrixWorld(true);
                    object.onBeforeRender = () => {
                        const currentMaterials = Array.isArray(object.material) ? object.material : [object.material];
                        currentMaterials.forEach((material) => applyObjectUniforms(material, object));
                    };
                    sceneRoot.add(object);
                    prims.push(object);
                });
            });
            report({ phase: 'geometry', index: i + 1, total: stage.meshes.length, primPath: String(record.primPath || '') });
        }
        await awaitTextureJobs(pendingTextures);
        if (!isMounted() || stopped) throw new Error('USD scene view was cancelled.');
        if (environmentBridge && typeof environmentBridge.updateBounds === 'function') {
            environmentBridge.updateBounds(new THREE.Box3().setFromObject(sceneRoot));
        }
        // Geometry and lights are final here, so draw the map once before the
        // first frame rather than leaving the opening frames unshadowed.
        if (shadowsEnabled) updateShadowMap();
        applyMaterialEnvironment();
        const resize = () => {
            if (!renderer || !container || resizeSuspended) return;
            const w = Math.max(1, container.clientWidth || 640);
            const h = Math.max(1, container.clientHeight || 480);
            renderer.setSize(w, h, false);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
        };
        const frameAll = () => {
            // Backdrops/skyboxes are deliberately excluded from framing.
            // A USD camera may have left a non-default fov/aperture-derived
            // fov behind; the auto-framing entry always uses the plain 45.
            camera.fov = 45;
            const box = new THREE.Box3().setFromObject(sceneRoot);
            if (box.isEmpty()) return;
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const radius = size.length() * 0.5 || 1;
            const halfY = THREE.MathUtils.degToRad(camera.fov * 0.5);
            const halfX = Math.atan(Math.tan(halfY) * Math.max(camera.aspect, 0.01));
            const distance = Math.max(radius / Math.tan(halfY), radius / Math.tan(halfX)) * 1.25;
            lastFrameDistance = distance;
            camera.position.copy(center).add(new THREE.Vector3(0, 0.25, 1).normalize().multiplyScalar(distance));
            camera.near = Math.max(radius / 1000, 0.001);
            // Studio wall sits at STUDIO_WALL_R + STUDIO_MAX_ORBIT_DISTANCE (world
            // units, at studioScale 1), so the far plane must also cover that
            // wall once the studio is scaled to the scene, not just the scene.
            const studioScale = environmentBridge && environmentBridge.getStudioScale ? environmentBridge.getStudioScale() : 0;
            camera.far = Math.max(distance + radius * 4, 100, studioScale * 36);
            camera.updateProjectionMatrix();
            if (controls) { controls.target.copy(center); controls.update(); }
        };
        const getCameras = () => sceneArray(stage.cameras).map((record) => ({
            primPath: String(record.primPath || ''),
            name: String(record.name || record.primPath || ''),
        }));
        // The dome light the stage supplied, so the Environment card can show
        // what is actually applied instead of its own stale defaults.
        const getDomeLight = () => (domeLight ? Object.assign({}, domeLight) : null);
        // Restores the stage's own dome after a user import, so Reset means
        // "back to how this stage was authored" when the stage supplied one.
        const applyDomeLight = () => {
            if (!domeEnv || !domeLight || stopped) return false;
            env = domeEnv;
            if (environmentBridge && environmentBridge.setEnvironment) environmentBridge.setEnvironment(domeEnv);
            setEnvRotation(domeLight.rotationDeg * Math.PI / 180);
            setEnvExposure(domeLight.exposure);
            return true;
        };
        const getLights = () => sceneArray(stage.lights).map((record) => ({
            primPath: String(record.primPath || ''),
            name: String(record.name || record.primPath || ''),
            type: String(record.type || ''),
        }));
        // Positions the camera/controls rig at a USD camera prim's composed
        // world pose. Fov is set directly from the aperture/focal length
        // ratio (setFocalLength assumes the aperture aspect matches the
        // viewport, which is not true here).
        const applyCamera = (primPath) => {
            selectedCameraPath = primPath || null;
            if (!primPath) { frameAll(); return true; }
            const record = sceneArray(stage.cameras).find((c) => c.primPath === primPath);
            if (!record) return false;
            sceneRoot.updateMatrixWorld(true);
            const local = sceneMatrix(record.matrix);
            const world = new THREE.Matrix4().multiplyMatrices(sceneRoot.matrixWorld, local);
            const position = new THREE.Vector3();
            const quaternion = new THREE.Quaternion();
            const scale = new THREE.Vector3();
            world.decompose(position, quaternion, scale);
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion).normalize();
            const meters = Number.isFinite(Number(stage.metersPerUnit)) && Number(stage.metersPerUnit) > 0
                ? Number(stage.metersPerUnit) : 1;
            const box = new THREE.Box3().setFromObject(sceneRoot);
            const boxCenter = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
            const boxRadius = box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length() * 0.5 || 1;
            const focusDistance = Number(record.focusDistance);
            let distance = Number.isFinite(focusDistance) && focusDistance > 0 ? focusDistance * meters : NaN;
            if (!Number.isFinite(distance)) {
                const toCenter = boxCenter.clone().sub(position);
                const projected = toCenter.dot(forward);
                distance = Number.isFinite(projected) && projected > 0 ? projected : boxRadius;
            }
            const target = position.clone().add(forward.multiplyScalar(distance));
            const verticalAperture = Number(record.verticalAperture) || 24;
            const focalLength = Number(record.focalLength) || 50;
            camera.fov = 2 * Math.atan(verticalAperture / (2 * focalLength)) * 180 / Math.PI;
            const clip = Array.isArray(record.clippingRange) ? record.clippingRange : [0.1, 100000];
            camera.near = Math.max(Number(clip[0]) * meters, boxRadius / 1000, 0.001);
            camera.far = Math.max(Number(clip[1]) * meters, camera.near + 1);
            camera.position.copy(position);
            camera.quaternion.copy(quaternion);
            camera.updateProjectionMatrix();
            if (controls) {
                controls.target.copy(target);
                controls.update();
            }
            lastFrameDistance = distance;
            return true;
        };
        const resetCamera = () => { applyCamera(selectedCameraPath); };
        const updateRendererDisplayTransform = () => {
            const mode = window.getDisplayTransform ? window.getDisplayTransform() : 'srgb';
            if ('outputEncoding' in renderer) renderer.outputEncoding = mode === 'lin_rec709' ? THREE.LinearEncoding : THREE.sRGBEncoding;
            if ('toneMapping' in renderer) {
                renderer.toneMapping = mode === 'aces' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
                // Exposure is applied exactly once, through u_envLightIntensity
                // (applyMaterialEnvironment/envExposure below), matching the
                // Viewer (js/mtlx-engine.js pins this to 1.0 too).
                renderer.toneMappingExposure = 1;
            }
        };
        const disposeMaterial = (material) => {
            if (!material) return;
            materials.delete(material);
            try { material.dispose && material.dispose(); } catch (e) {}
        };
        const replaceMaterialReferences = (replacements) => {
            sceneRoot.traverse((object) => {
                if (!object || !object.material) return;
                if (Array.isArray(object.material)) {
                    object.material = object.material.map((material) => replacements.get(material) || material);
                } else if (replacements.has(object.material)) object.material = replacements.get(object.material);
            });
            invalidateTransparentMeshCache();
        };
        const rebuildDisplayMaterials = async () => {
            // Every material regenerates below, so drop stale reservations
            // and byte counters up front (as setTextureMaxSize/
            // setTextureBudgetBytes already do before enqueueing this).
            textureCache.forEach((texture) => {
                try { texture.dispose && texture.dispose(); } catch (e) {}
                try { texture.image && texture.image.close && texture.image.close(); } catch (e) {}
            });
            textureCache.clear();
            textureReservations.clear();
            textureStats.bytesReserved = 0;
            textureStats.ordinaryBytes = 0;
            textureStats.udimTiles = 0;
            textureStats.udimBytes = 0;
            // Compile all replacement sources before changing any live mesh.
            // If the global event changes again while WASM is busy, discard
            // the provisional set and retry so one scene cannot mix modes.
            while (!stopped && isMounted()) {
                const targetRevision = displayRevision;
                const targetMode = window.getDisplayTransform ? window.getDisplayTransform() : 'srgb';
                const replacementInfo = new Map();
                const provisional = new Set();
                rebuildingProvisional = provisional;
                const rebuildPending = [];
                const oldMaterials = Array.from(materials);
                for (const [path, record] of materialRecords) {
                    const result = await makeMtlxMaterial(record, true);
                    if (result) {
                        replacementInfo.set(path, result);
                        if (result.material) provisional.add(result.material);
                        rebuildPending.push(...(result.pendingTextures || []));
                    }
                    if (stopped || !isMounted()) break;
                }
                if (stopped || !isMounted()) {
                    provisional.forEach(disposeMaterial);
                    rebuildingProvisional = null;
                    return;
                }
                if (targetRevision !== displayRevision || targetMode !== (window.getDisplayTransform ? window.getDisplayTransform() : 'srgb')) {
                    provisional.forEach(disposeMaterial);
                    rebuildingProvisional = null;
                    continue;
                }
                const replacements = new Map();
                const oldUdimCache = new Map(udimVariantByMaterial);
                udimVariantByMaterial.clear();
                for (const oldMaterial of oldMaterials) {
                    const data = oldMaterial && oldMaterial.userData;
                    const path = data && data.mtlxSceneMaterialPath;
                    const info = path && replacementInfo.get(path);
                    if (!info || !info.compiled) continue;
                    let next = info.material;
                    const tile = data.mtlxSceneUdimTile;
                    if (tile != null) next = udimMaterial(info, tile, data.mtlxSceneSourceAsset || path);
                    if (next) {
                        replacements.set(oldMaterial, next);
                        provisional.add(next);
                        if (next.userData && next.userData.mtlxScenePendingTextures) {
                            rebuildPending.push(...next.userData.mtlxScenePendingTextures);
                            delete next.userData.mtlxScenePendingTextures;
                        }
                    }
                }
                await awaitTextureJobs(rebuildPending);
                if (stopped || !isMounted()) {
                    provisional.forEach(disposeMaterial);
                    rebuildingProvisional = null;
                    return;
                }
                if (targetRevision !== displayRevision || targetMode !== (window.getDisplayTransform ? window.getDisplayTransform() : 'srgb')) {
                    provisional.forEach(disposeMaterial);
                    rebuildingProvisional = null;
                    udimVariantByMaterial.clear();
                    oldUdimCache.forEach((value, key) => udimVariantByMaterial.set(key, value));
                    continue;
                }
                // Partial refresh: a stage with one un-compilable material used
                // to discard the whole rebuild, so switching sRGB to ACES did
                // nothing at all on any large stage. Keep every material that
                // did regenerate and leave the failures on their old shader.
                const failed = [];
                for (const [path, info] of replacementInfo) {
                    if (!info || !info.compiled) failed.push(path);
                }
                if (failed.length) {
                    warnings.push('USD display-transform refresh kept ' + failed.length
                        + ' material(s) on the previous shader because they failed to regenerate: ' + failed.slice(0, 3).join(', ')
                        + (failed.length > 3 ? ', ...' : ''));
                }
                if (!replacements.size) {
                    provisional.forEach(disposeMaterial);
                    rebuildingProvisional = null;
                    udimVariantByMaterial.clear();
                    oldUdimCache.forEach((value, key) => udimVariantByMaterial.set(key, value));
                    displayDirty = false;
                    report({ phase: 'display-transform', status: 'error', value: targetMode, error: 'no material regenerated' });
                    return;
                }
                replaceMaterialReferences(replacements);
                // finalMat bakes the display transform at alloc time, so a
                // rebuild (which can be triggered by a transform change)
                // must drop the pipeline; re-apply modes from each new
                // material's own userData so the peel/opaque split survives.
                if (window.applyPeelMaterialMode) {
                    const forceOn = window.getForceTransparency && window.getForceTransparency();
                    replacements.forEach((material) => {
                        window.applyPeelMaterialMode(material, !!(material.userData && material.userData.mtlxSceneTransparent) && forceOn);
                    });
                }
                if (peelPipeline) peelPipeline.dispose();
                const oldInfo = new Map(byPath);
                byPath.clear();
                replacementInfo.forEach((info, path) => {
                    if (info.compiled) byPath.set(path, info);
                    else if (oldInfo.has(path)) byPath.set(path, oldInfo.get(path));
                });
                const liveNew = new Set(replacements.values());
                replacementInfo.forEach((info) => {
                    if (info && info.material && !liveNew.has(info.material)) disposeMaterial(info.material);
                });
                oldMaterials.forEach((material) => {
                    if (!liveNew.has(material) && replacements.has(material)) disposeMaterial(material);
                });
                updateRendererDisplayTransform();
                if (environmentBridge && typeof environmentBridge.refreshDisplayTransform === 'function') {
                    environmentBridge.refreshDisplayTransform();
                }
                applyMaterialEnvironment();
                displayDirty = targetRevision !== displayRevision;
                if (!displayDirty) {
                    rebuildingProvisional = null;
                    renderer.compile(scene, camera);
                    reportBadPrograms(materials, ' after display-transform refresh');
                    report({ phase: 'display-transform', status: 'ready', value: targetMode });
                    return;
                }
            }
        };
        queueDisplayRebuild = () => {
            if (displayRebuildPromise || stopped || !active || !displayDirty || !isMounted()) return displayRebuildPromise;
            const scheduledRevision = displayRevision;
            displayRebuildPromise = rebuildDisplayMaterials().catch((error) => {
                if (rebuildingProvisional) rebuildingProvisional.forEach(disposeMaterial);
                rebuildingProvisional = null;
                if (!stopped && isMounted()) {
                    const detail = error && error.message || String(error);
                    warnings.push('USD display-transform refresh failed: ' + detail);
                    report({ phase: 'display-transform', status: 'error', error: detail });
                }
                if (displayRevision === scheduledRevision) displayDirty = false;
            }).finally(() => {
                displayRebuildPromise = null;
                if (displayDirty && active && !stopped && isMounted()) queueDisplayRebuild();
            });
            return displayRebuildPromise;
        };
        resize();
        frameAll();
        displayDirty = creationDisplayRevision !== displayRevision
            || creationDisplayTransform !== (window.getDisplayTransform ? window.getDisplayTransform() : 'srgb');
        if (displayDirty) await queueDisplayRebuild();
        // Force the actual display renderer to link every scene program before
        // advertising the view as ready. Three may report a GLSL failure via
        // console and leave no public exception, so turn missing material
        // program handles into per-material diagnostics.
        try {
            renderer.compile(scene, camera);
            reportBadPrograms(materials, '');
        } catch (error) {
            warnings.push('USD scene GPU program compilation failed: ' + String(error && error.message || error));
            report({ phase: 'gpu-program', status: 'error', error: String(error && error.message || error) });
        }
        // Samplers still holding the engine's 1x1 default after every texture
        // job settled, same warnings path the texture-tier budget uses so
        // Diagnostics and DevTools both surface it.
        samplerReport = [];
        for (const [path, info] of byPath) {
            if (!info || !info.compiled || !info.material) continue;
            for (const u of info.compiled.introspected || []) {
                if (u.type !== 'filename' || u.data == null) continue;
                // UDIM tiles bind on per-partition variant materials, so the
                // base material keeps its <UDIM> sampler at the default by design.
                if (/<UDIM>/i.test(String(u.data))) continue;
                if (window.samplerHoldsDefault(info.material.uniforms[u.name])) {
                    samplerReport.push({ material: info.materialPath || path, uniform: u.name, file: u.data });
                }
            }
        }
        if (samplerReport.length) {
            warnings.push(samplerReport.length + ' texture samplers fell back to MaterialX defaults (see console)');
            console.warn('MaterialX sampler defaults:', samplerReport);
        }
        if (window.ResizeObserver) { resizeObserver = new ResizeObserver(resize); resizeObserver.observe(container); }
        report({ phase: 'renderer', status: 'ready', warnings: warnings.slice() });
        // Mirrors the material viewer's applyStudioPolarClamp (js/mtlx-
        // engine.js:4804-4819): the orbit target sits above the floor, so a
        // fixed dip below the horizon drops the eye through the floor once
        // the distance grows. Re-derived per frame from that distance.
        const applyStudioPolarClamp = () => {
            if (!controls) return;
            const studio = window.MtlxStudio;
            const maxPolar = (studio && Number(studio.studioMaxPolar)) || Math.PI * 0.54;
            if (!environmentBridge || !environmentBridge.isStudio || !environmentBridge.isStudio()) {
                if (studioPolarApplied) { controls.maxPolarAngle = Math.PI; studioPolarApplied = false; }
                return;
            }
            const floorY = environmentBridge.getFloorY ? environmentBridge.getFloorY() : null;
            if (floorY == null) return;
            const clearance = environmentBridge.getFloorClearance ? environmentBridge.getFloorClearance() : 0;
            const dist = camera.position.distanceTo(controls.target);
            const rel = (floorY + clearance) - controls.target.y;
            const limit = dist > 1e-3
                ? Math.acos(Math.max(-1, Math.min(1, rel / dist)))
                : maxPolar;
            controls.maxPolarAngle = Math.min(maxPolar, limit);
            studioPolarApplied = true;
        };
        // Keeps the orbit from zooming out past the studio backdrop: the wall
        // sits at studioMaxOrbitDistance * studioScale (matching the Viewer's
        // own maxDistance-vs-STUDIO_WALL_R relationship), scaled down 10% so
        // the top-down clamp still stays under the studio ceiling.
        const applyStudioDistanceClamp = () => {
            if (!controls) return;
            if (!environmentBridge || !environmentBridge.isStudio || !environmentBridge.isStudio()) {
                if (studioDistanceApplied) { controls.maxDistance = Infinity; studioDistanceApplied = false; }
                return;
            }
            const studio = window.MtlxStudio;
            const maxOrbitDistance = (studio && Number(studio.studioMaxOrbitDistance)) || 9;
            const studioScale = environmentBridge.getStudioScale ? environmentBridge.getStudioScale() : 1;
            controls.maxDistance = Math.max(lastFrameDistance, maxOrbitDistance * studioScale * 0.9);
            studioDistanceApplied = true;
        };
        // renderFrame(): the one chokepoint for every display render (loop,
        // captureFrame, renderNow, snapshot). Routes through the peel
        // pipeline only when Force Transparency is on and at least one
        // mesh under sceneRoot currently carries a transparent material;
        // the mesh list is cached and invalidated on material rebuild.
        const collectTransparentMeshes = () => {
            if (transparentMeshCache) return transparentMeshCache;
            const list = [];
            sceneRoot.traverse((object) => {
                if (!object || !object.isMesh || !object.material) return;
                const mats = Array.isArray(object.material) ? object.material : [object.material];
                if (mats.some((m) => m && m.userData && m.userData.mtlxSceneTransparent)) list.push(object);
            });
            transparentMeshCache = list;
            return list;
        };
        const renderFrame = () => {
            const forceOn = window.getForceTransparency && window.getForceTransparency();
            const list = forceOn ? collectTransparentMeshes() : [];
            if (peelPipeline && forceOn && list.length) peelPipeline.render(scene, camera, list);
            else renderer.render(scene, camera);
        };
        const render = () => {
            if (stopped || !active) { raf = 0; return; }
            if (window.MTLX_CLOCK && typeof window.clockTick === 'function') window.clockTick(performance.now());
            if (environmentBridge && environmentBridge.update) environmentBridge.update();
            applyStudioPolarClamp();
            applyStudioDistanceClamp();
            if (controls) controls.update();
            renderFrame();
            raf = requestAnimationFrame(render);
        };
        const startLoop = () => { if (!raf && !stopped && active) render(); };
        startLoop();
        const setEnvironment = (next) => {
            if (!next || stopped) return false;
            env = next;
            if (environmentBridge && environmentBridge.setEnvironment) environmentBridge.setEnvironment(next);
            applyMaterialEnvironment();
            return true;
        };
        const setEnvRotation = (radians) => {
            envRotationRad = Number(radians) || 0;
            if (environmentBridge && environmentBridge.setEnvRotation) environmentBridge.setEnvRotation(envRotationRad);
            applyMaterialEnvironment();
            return envRotationRad;
        };
        // Stage lights are live: both controls only re-push uniforms, no
        // recompile, because the slots were reserved at generation time.
        const setShadowsEnabled = (on) => {
            shadowsEnabled = !!on;
            try { if (window.top === window) localStorage.setItem(SCENE_SHADOWS_KEY, shadowsEnabled ? '1' : '0'); } catch (e) { /* privacy mode */ }
            if (shadowsEnabled) updateShadowMap(); else shadowMatrix = null;
            applyMaterialEnvironment();
            return shadowsEnabled;
        };
        const getShadows = () => ({ enabled: shadowsEnabled, ready: !!shadowTarget });
        const setStageLightsEnabled = (on) => {
            stageLightsEnabled = !!on;
            try { if (window.top === window) localStorage.setItem(SCENE_STAGE_LIGHTS_KEY, stageLightsEnabled ? '1' : '0'); } catch (e) { /* privacy mode */ }
            applyMaterialEnvironment();
            return stageLightsEnabled;
        };
        const setStageLightsEv = (value) => {
            stageLightsEv = Math.max(-8, Math.min(8, Number(value) || 0));
            if (shadowsEnabled) updateShadowMap();
            try { if (window.top === window) localStorage.setItem(SCENE_STAGE_LIGHTS_EV_KEY, String(stageLightsEv)); } catch (e) { /* privacy mode */ }
            applyMaterialEnvironment();
            return stageLightsEv;
        };
        const getStageLights = () => ({
            count: stageLights.length,
            enabled: stageLightsEnabled,
            ev: stageLightsEv,
        });
        const setEnvExposure = (value) => {
            envExposure = Math.max(0, Number(value) || 0);
            if (environmentBridge && environmentBridge.setEnvExposure) environmentBridge.setEnvExposure(envExposure);
            applyMaterialEnvironment();
            return envExposure;
        };
        // Changes the ordinary-texture resolution cap, persists it (top
        // realm only) and drops every cached ordinary/UDIM texture and its
        // budget reservation so the display-rebuild path below decodes
        // fresh textures at the new size while keeping camera, environment
        // and the loaded stage untouched. Re-plans the size tier against the
        // new cap (from the already-compiled materials) before that rebuild.
        const setTextureMaxSize = (px) => {
            const value = px === Infinity || String(px).toLowerCase() === 'original' ? Infinity : Math.round(Number(px));
            const next = Number.isNaN(value) ? sceneOptions.textureMaxSize : value;
            if (!SCENE_TEXTURE_MAX_SIZE_VALUES.includes(next) || next === sceneOptions.textureMaxSize) {
                return sceneOptions.textureMaxSize;
            }
            sceneOptions.textureMaxSize = next;
            if (window.top === window) {
                try { localStorage.setItem(SCENE_TEXTURE_MAX_SIZE_KEY, next === Infinity ? 'original' : String(next)); } catch (e) { /* privacy mode */ }
            }
            udimVariantByMaterial.clear();
            displayDirty = true;
            displayRevision += 1;
            planTextureSize(Array.from(byPath.values()).map((info) => info.compiled)).finally(() => {
                if (queueDisplayRebuild && active && !stopped) queueDisplayRebuild();
            });
            return sceneOptions.textureMaxSize;
        };
        // Texture memory budget: any positive finite value is honored (specs
        // pass small budgets), but only the 1/2/4 GiB steps persist. Changing
        // it re-plans and re-enters the same rebuild path as setTextureMaxSize.
        const setTextureBudgetBytes = (bytes) => {
            const next = Number(bytes);
            if (!(next > 0) || !Number.isFinite(next) || next === sceneOptions.textureMaxBytes) {
                return sceneOptions.textureMaxBytes;
            }
            sceneOptions.textureMaxBytes = next;
            if (window.top === window) {
                const gib = next / GIB;
                if (SCENE_TEXTURE_BUDGET_VALUES.includes(gib)) {
                    try { localStorage.setItem(SCENE_TEXTURE_BUDGET_KEY, String(gib)); } catch (e) { /* privacy mode */ }
                }
            }
            udimVariantByMaterial.clear();
            displayDirty = true;
            displayRevision += 1;
            planTextureSize(Array.from(byPath.values()).map((info) => info.compiled)).finally(() => {
                if (queueDisplayRebuild && active && !stopped) queueDisplayRebuild();
            });
            return sceneOptions.textureMaxBytes;
        };
        const getTextureBudgetBytes = () => sceneOptions.textureMaxBytes;
        if (textureStats.ktx2Substituted > 0) {
            warnings.push(textureStats.ktx2Substituted + ' texture' + (textureStats.ktx2Substituted === 1 ? '' : 's')
                + ' loaded from KTX2 sibling' + (textureStats.ktx2Substituted === 1 ? '' : 's'));
        }
        const handle = {
            scene, camera, renderer, controls, prims, warnings, textureStats,
            udimStats: {
                tileSize: sceneOptions.udimTileSize,
                maxTiles: sceneOptions.udimMaxTiles,
                maxBytes: sceneOptions.udimMaxBytes,
                get tiles() { return textureStats.udimTiles; },
                get bytes() { return textureStats.udimBytes; },
            },
            resize, frameAll,
            getCameras, applyCamera, resetCamera, getDomeLight, getLights, applyDomeLight,
            setStageLightsEnabled, setStageLightsEv, getStageLights,
            setShadowsEnabled, getShadows,
            setEnvironment, setEnvRotation, setEnvExposure,
            // getTextureMaxSize/setTextureMaxSize expose the ordinary-texture
            // resolution cap (512/1024/2048, persisted under
            // mtlx_scene_texture_size in the top realm); setTextureMaxSize
            // re-runs the display-rebuild path so new textures load at the
            // new size. getTextureStats reports the current cap alongside
            // the UDIM tile size and the budget counters reserveTexture
            // already tracks.
            getTextureMaxSize: () => sceneOptions.textureMaxSize,
            setTextureMaxSize,
            getTextureBudgetBytes,
            setTextureBudgetBytes,
            getTextureStats: () => ({
                textureMaxSize: sceneOptions.textureMaxSize,
                plannedTextureSize,
                udimTileSize: sceneOptions.udimTileSize,
                reservedBytes: textureStats.bytesReserved,
                ordinaryBytes: textureStats.ordinaryBytes,
                textureCount: textureReservations.size,
                udimTileCount: textureStats.udimTiles,
                budgetBytes: sceneOptions.textureMaxBytes,
                plannedBytes,
                fullBytes,
                ktx2Substituted: textureStats.ktx2Substituted,
            }),
            getSamplerReport: () => samplerReport.slice(),
            setBackdrop: (mode) => {
                const result = environmentBridge && environmentBridge.setBackdrop ? environmentBridge.setBackdrop(mode) : mode;
                applyStudioPolarClamp();
                applyStudioDistanceClamp();
                return result;
            },
            getBackdrop: () => environmentBridge && environmentBridge.getBackdrop ? environmentBridge.getBackdrop() : 'studio',
            setAutoRotate: (value) => { if (controls) controls.autoRotate = !!value; return !!(controls && controls.autoRotate); },
            setActive: (value) => {
                active = !!value;
                if (!active && raf) { cancelAnimationFrame(raf); raf = 0; }
                if (active) { startLoop(); if (displayDirty && queueDisplayRebuild && isMounted()) queueDisplayRebuild(); }
            },
            selectPrim: (primPath) => prims.find((o) => o.userData.primPath === primPath) || null,
            // Current camera pose for a turntable recorder or URL/state
            // persistence. null when there is no OrbitControls rig.
            // Rounded to 4 decimals, same contract as the shader-preview handle.
            getCamera: () => {
                if (!controls) return null;
                const r4 = (n) => Math.round(n * 10000) / 10000;
                return {
                    position: [camera.position.x, camera.position.y, camera.position.z].map(r4),
                    target: [controls.target.x, controls.target.y, controls.target.z].map(r4),
                    cameraPath: selectedCameraPath,
                };
            },
            // Applies a saved pose from getCamera(); invalid input is
            // silently ignored, same validation as the shader-preview handle.
            setCamera: (pose) => {
                if (!controls || !pose) return false;
                const isVec3 = (v) => Array.isArray(v) && v.length === 3
                    && v.every((n) => typeof n === 'number' && isFinite(n));
                if (pose.position !== undefined && !isVec3(pose.position)) return false;
                if (pose.target !== undefined && !isVec3(pose.target)) return false;
                if (pose.position) camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
                if (pose.target) controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
                controls.update();
                return true;
            },
            // Enters fixed-resolution, off-screen capture mode: same
            // sizing resize() would apply, just pinned and hidden on-screen.
            // Returns false if the view is gone or already capturing.
            beginCapture: ({ width, height }) => {
                if (stopped || captureState) return false;
                captureState = {
                    prevPixelRatio: renderer.getPixelRatio(),
                    prevVisibility: canvas.style.visibility,
                    width, height,
                };
                resizeSuspended = true;
                renderer.setPixelRatio(1);
                renderer.setSize(width, height, false);
                camera.aspect = width / height;
                camera.updateProjectionMatrix();
                canvas.style.visibility = 'hidden';
                return true;
            },
            // Renders one frame at the capture resolution and reads it
            // back as ImageData via a lazily created, cached 2D canvas.
            captureFrame: () => {
                if (!captureState) throw new Error('captureFrame() called with no active beginCapture().');
                if (environmentBridge && environmentBridge.update) environmentBridge.update();
                renderFrame();
                const { width: w, height: h } = captureState;
                if (!__captureCanvas) {
                    __captureCanvas = document.createElement('canvas');
                    __captureCtx = __captureCanvas.getContext('2d', { willReadFrequently: true });
                }
                if (__captureCanvas.width !== w || __captureCanvas.height !== h) {
                    __captureCanvas.width = w; __captureCanvas.height = h;
                }
                __captureCtx.clearRect(0, 0, w, h);
                __captureCtx.drawImage(renderer.domElement, 0, 0, w, h);
                return __captureCtx.getImageData(0, 0, w, h);
            },
            // Leaves capture mode: restores on-screen visibility, pixel
            // ratio and layout-driven sizing. Idempotent, safe to call twice.
            endCapture: () => {
                if (!captureState) return;
                canvas.style.visibility = captureState.prevVisibility;
                renderer.setPixelRatio(captureState.prevPixelRatio);
                captureState = null;
                resizeSuspended = false;
                resize();
            },
            renderNow: () => {
                if (stopped) return;
                if (environmentBridge && environmentBridge.update) environmentBridge.update();
                renderFrame();
            },
            snapshot: () => {
                if (stopped || !renderer.domElement || !renderer.domElement.toDataURL) return null;
                if (environmentBridge && environmentBridge.update) environmentBridge.update();
                renderFrame();
                return renderer.domElement.toDataURL('image/png');
            },
            // Re-applies peel/opaque mode on every compiled material from
            // its own userData.mtlxSceneTransparent verdict against the
            // current Force Transparency flag; called by setForceTransparency
            // through LIVE_VIEWS. Drops the pipeline when peeling turns off
            // or nothing in the scene is transparent (nothing to free by
            // keeping it allocated).
            refreshRenderMode: () => {
                if (stopped) return;
                const forceOn = window.getForceTransparency && window.getForceTransparency();
                let anyTransparent = false;
                materials.forEach((material) => {
                    const transparent = !!(material.userData && material.userData.mtlxSceneTransparent);
                    if (transparent) anyTransparent = true;
                    if (window.applyPeelMaterialMode) window.applyPeelMaterialMode(material, transparent && forceOn);
                });
                invalidateTransparentMeshCache();
                if (peelPipeline && (!forceOn || !anyTransparent)) peelPipeline.dispose();
            },
            dispose: () => {
                if (stopped) return;
                stopped = true;
                disposeShadowResources();
                if (displayTransformListener) {
                    window.removeEventListener('mtlx-display-transform', displayTransformListener);
                    window.removeEventListener('mtlx-settings-changed', settingsChangedListener);
                    displayTransformListener = null;
                }
                if (raf) cancelAnimationFrame(raf);
                if (resizeObserver) resizeObserver.disconnect();
                if (controls) controls.dispose();
                if (environmentBridge && environmentBridge.dispose) environmentBridge.dispose();
                documents.forEach((d) => { try { d.delete && d.delete(); } catch (e) {} });
                geometries.forEach((g) => { try { g.dispose(); } catch (e) {} });
                materials.forEach((m) => { try { m.dispose(); } catch (e) {} });
                textureCache.forEach((t) => {
                    try { t.dispose && t.dispose(); } catch (e) {}
                    try { t.image && t.image.close && t.image.close(); } catch (e) {}
                });
                textureCache.clear();
                if (peelPipeline) { try { peelPipeline.dispose(); } catch (e) {} }
                if (window.unregisterLiveView) window.unregisterLiveView(handle);
                try { renderer.dispose(); } catch (e) {}
                if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
                __captureCanvas = null; __captureCtx = null;
            },
            // Debug hook: raw GPU state for a headed diagnosis harness.
            // Not for production UI code.
            __debug: () => ({ renderer, scene, camera, materials: Array.from(materials) }),
        };
        if (window.registerLiveView) window.registerLiveView(handle);
        return handle;
    } catch (e) {
        stopped = true;
        if (displayTransformListener) {
            window.removeEventListener('mtlx-display-transform', displayTransformListener);
                    window.removeEventListener('mtlx-settings-changed', settingsChangedListener);
            displayTransformListener = null;
        }
        if (raf) cancelAnimationFrame(raf);
        if (resizeObserver) resizeObserver.disconnect();
        documents.forEach((d) => { try { d.delete && d.delete(); } catch (err) {} });
        materials.forEach((m) => { try { m.dispose(); } catch (err) {} });
        textureCache.forEach((t) => {
            try { t.dispose && t.dispose(); } catch (err) {}
            try { t.image && t.image.close && t.image.close(); } catch (err) {}
        });
        textureCache.clear();
        geometries.forEach((g) => { try { g.dispose(); } catch (err) {} });
        if (peelPipeline) { try { peelPipeline.dispose(); } catch (err) {} }
        if (controls) controls.dispose();
        if (environmentBridge && environmentBridge.dispose) environmentBridge.dispose();
        if (renderer) renderer.dispose();
        if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
        throw e;
    }
};

Object.assign(window, { createMtlxSceneView });
