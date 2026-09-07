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
const UNBOUNDED_TEXTURE_EXTENSIONS = ['exr', 'hdr', 'tif', 'tiff'];

const SCENE_TEXTURE_MAX_SIZE_KEY = 'mtlx_scene_texture_size';
const SCENE_TEXTURE_MAX_SIZE_VALUES = [512, 1024, 2048];
const SCENE_TEXTURE_MAX_SIZE_DEFAULT = 2048;

const storedSceneTextureMaxSize = () => {
    if (window.top !== window) return SCENE_TEXTURE_MAX_SIZE_DEFAULT;
    try {
        const stored = Number(localStorage.getItem(SCENE_TEXTURE_MAX_SIZE_KEY));
        return SCENE_TEXTURE_MAX_SIZE_VALUES.includes(stored) ? stored : SCENE_TEXTURE_MAX_SIZE_DEFAULT;
    } catch (e) { return SCENE_TEXTURE_MAX_SIZE_DEFAULT; /* privacy mode */ }
};

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
const sceneExactFile = (map, ref, fromDir) => {
    const want = sceneJoinPath(fromDir, ref);
    return map[want] ? { path: want, blob: map[want] } : null;
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
        tiles.set(code, { path, blob, u, v });
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
    udimTileSize = 512, udimMaxTiles = 256,
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
    let resizeObserver = null;
    let stopped = false;
    let active = true;
    let raf = 0;
    let studioPolarApplied = false;
    let studioDistanceApplied = false;
    let lastFrameDistance = 0;
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
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    camera.position.set(0, 0, 4);
    let env = null;
    let mxEnv = null;
    const sceneOptions = {
        udimTileSize: Math.max(128, Number(udimTileSize) || 512),
        udimMaxTiles: Math.max(1, Number(udimMaxTiles) || 256),
        udimMaxBytes: Math.max(4 * 1024 * 1024, Number(udimMaxBytes) || 256 * 1024 * 1024),
        textureMaxSize: Math.max(128, Number(textureMaxSize) || storedSceneTextureMaxSize()),
        textureMaxBytes: Math.max(64 * 1024 * 1024, Number(textureMaxBytes) || 1024 * 1024 * 1024),
    };
    const textureStats = { jobs: 0, loaded: 0, failed: 0, udimTiles: 0, udimBytes: 0, bytesReserved: 0, ordinaryBytes: 0 };
    let samplerReport = [];
    const textureReservations = new Set();
    // Ordinary textures and UDIM tiles are tracked against separate byte
    // budgets (textureMaxBytes / udimMaxBytes) so a scene with many ordinary
    // maps cannot starve UDIM tiles or vice versa. The ordinary size tier is
    // decided once up front by planOrdinaryTextureSize (see below), not
    // degraded mid-stream as textures are bound.
    let ordinaryTextureSize = sceneOptions.textureMaxSize;
    let plannedTextureSize = sceneOptions.textureMaxSize;
    // Counts the distinct ordinary (non-UDIM) texture files the given
    // compiled materials reference, resolved against the file map and
    // deduplicated by resolved path, then picks the largest size tier in
    // [textureMaxSize, 1024, 512] whose estimated total fits textureMaxBytes.
    // Falls back to 512 if even that does not fit; reservations beyond the
    // budget still fail at bind time. Called before any ordinary texture is
    // bound, and again by setTextureMaxSize before its display rebuild.
    const planOrdinaryTextureSize = (compiledList) => {
        const seen = new Set();
        for (const compiled of compiledList) {
            if (!compiled || !Array.isArray(compiled.introspected)) continue;
            for (const u of compiled.introspected) {
                if (u.type !== 'filename' || u.data == null) continue;
                if (/<UDIM>/i.test(String(u.data))) continue;
                const hit = sceneExactFile(fileMap, u.data, '');
                if (hit) seen.add(hit.path);
            }
        }
        const count = seen.size;
        const tiers = Array.from(new Set([sceneOptions.textureMaxSize, 1024, 512]
            .filter((value) => value <= sceneOptions.textureMaxSize))).sort((a, b) => b - a);
        if (!tiers.length) tiers.push(512);
        let chosen = tiers[tiers.length - 1];
        for (const tier of tiers) {
            const estimate = count * Math.ceil(4 * tier * tier * 4 / 3);
            if (estimate <= sceneOptions.textureMaxBytes) { chosen = tier; break; }
        }
        ordinaryTextureSize = chosen;
        plannedTextureSize = chosen;
        if (chosen < sceneOptions.textureMaxSize) {
            warnings.push('Texture budget: ' + count + ' textures loaded at ' + chosen
                + ' px (requested ' + sceneOptions.textureMaxSize + ' px)');
        }
        return chosen;
    };
    const reserveTexture = (path, isUdim = false) => {
        const key = String(path || '');
        if (textureReservations.has(key)) return true;
        const size = isUdim ? sceneOptions.udimTileSize : ordinaryTextureSize;
        const estimate = Math.ceil(4 * size * size * 4 / 3);
        if (isUdim) {
            if (textureStats.udimBytes + estimate > sceneOptions.udimMaxBytes) return false;
            textureReservations.add(key);
            textureStats.udimTiles += 1;
            textureStats.udimBytes += estimate;
            textureStats.bytesReserved += estimate;
            return true;
        }
        if (textureStats.ordinaryBytes + estimate > sceneOptions.textureMaxBytes) return false;
        textureReservations.add(key);
        textureStats.ordinaryBytes += estimate;
        textureStats.bytesReserved += estimate;
        return true;
    };
    // EXR/HDR/TIF are not resized by createImageBitmap (the bounded PNG/JPEG
    // path), so their real decoded size must be known before budgeting.
    const decodeUnboundedSceneTexture = async (blob, ext) => {
        let tex = null;
        try {
            if (ext === 'exr') tex = await window.loadExrTexture(blob);
            else if (ext === 'hdr') tex = await window.loadHdrTexture(blob);
            else tex = await window.loadTifTexture(blob);
        } catch (error) { return null; }
        if (!tex || !tex.image) return null;
        // TIF decodes to 8bpc RGBA (4 bytes/px); EXR/HDR decode float RGBA
        // (4 channels x 4 bytes = 16 bytes/px).
        const bytesPerPixel = (ext === 'exr' || ext === 'hdr') ? 16 : 4;
        const bytes = (tex.image.width || 0) * (tex.image.height || 0) * bytesPerPixel;
        window.configureLoadedTexture(tex);
        return { tex, bytes };
    };
    const udimWarnings = new Set();
    const compiledByPath = new Map();
    const programByKey = new Map();
    const sourceXmlByRecord = new WeakMap();
    const materialRecords = new Map();

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
            for (const name of names) {
                const matches = renderables.filter((r) => String(r.name || '') === name);
                if (matches.length === 1) return { node: matches[0].node, document: doc };
            }
            // A composed alias can differ from the sole authored renderable
            // name (the common sourceAsset-only case).  This fallback is
            // safe only for the native inferred-selection path; an authored
            // subidentifier that did not match must remain an error.
            if (renderables.length === 1 && !explicitName) {
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
            compiled, env, lightData: mxEnv.lightData || [],
        });
        // USD typed material inputs may override scalar shader parameters. The
        // stage bridge keeps these separate from structural MaterialX graph
        // selection; only uniforms already declared by the generated shader
        // are eligible here.
        for (const [key, value] of Object.entries(record && record.overrides || {})) {
            const uniformName = key.startsWith('u_') ? key : 'u_' + key;
            if (uniforms[uniformName]) uniforms[uniformName].value = value;
            else warnings.push('Unsupported scalar MaterialX override ' + key + ' on ' + label);
        }
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
        materials.add(material);
        const pendingTextures = [];
        const udimRefs = [];
        // Existing filename binding understands the generated introspection
        // shape. It is deliberately additive; missing files leave defaults.
        if (window.bindDroppedTextures && Object.keys(fileMap).length) {
            const prefix = sceneFilePrefix(sourceXmlByRecord.get(record) || '');
            for (const u of compiled.introspected || []) {
                if (u.type !== 'filename' || u.data == null) continue;
                if (/<UDIM>/i.test(String(u.data))) {
                    udimRefs.push({ uniform: u, tiles: sceneUdimTiles(u.data, fileMap) });
                    continue;
                }
                // Filename values were canonicalized against their declaring
                // MaterialX document before generation. Do not retry with a
                // basename or parent prefix: that can bind a duplicate file
                // from an unrelated layer.
                const hit = sceneExactFile(fileMap, u.data, '');
                if (!hit) { warnings.push('Texture file unavailable for ' + label + ': ' + u.data); continue; }
                const extension = String(hit.path).split('.').pop().toLowerCase();
                if (UNBOUNDED_TEXTURE_EXTENSIONS.includes(extension)) {
                    // Not resized by createImageBitmap, so the reserveTexture
                    // estimate would be wrong-sized; decode first, account the
                    // real bytes, and drop only when that exceeds the budget.
                    pendingTextures.push(decodeUnboundedSceneTexture(hit.blob, extension).then((result) => {
                        if (!result) return;
                        const { tex, bytes } = result;
                        if (textureStats.ordinaryBytes + bytes > sceneOptions.textureMaxBytes) {
                            warnings.push('Texture preview budget exceeded for ' + hit.path);
                            tex.dispose && tex.dispose();
                            return;
                        }
                        textureReservations.add(hit.path);
                        textureStats.ordinaryBytes += bytes;
                        textureStats.bytesReserved += bytes;
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
                maxTextureSize: ordinaryTextureSize,
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
        env = await window.getEnvOverride() || await window.getEnvironment();
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
        planOrdinaryTextureSize(precompiled);
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
            materials.add(material);
            const pending = [];
            info.udimRefs.forEach((entry, index) => {
                const hit = tileHits[index];
                const ext = String(hit.path).split('.').pop().toLowerCase();
                if (UNBOUNDED_TEXTURE_EXTENSIONS.includes(ext)) {
                    pending.push(decodeUnboundedSceneTexture(hit.blob, ext).then((result) => {
                        if (!result) return;
                        const { tex, bytes } = result;
                        if (textureStats.udimBytes + bytes > sceneOptions.udimMaxBytes) {
                            const warning = 'UDIM preview budget exceeded for ' + label + ' tile ' + code;
                            if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                            tex.dispose && tex.dispose();
                            return;
                        }
                        textureStats.udimBytes += bytes;
                        textureStats.bytesReserved += bytes;
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
                    maxTextureSize: sceneOptions.udimTileSize,
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
        let envRotationRad = 0;
        let envExposure = 1;
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
                    compiled, env, lightData: mxEnv.lightData || [],
                    envRotationRad, envExposure,
                });
                for (const [name, slot] of Object.entries(next)) {
                    if (!(/^(?:u_env|u_lightData$|u_numActiveLightSources$)/).test(name) || !material.uniforms[name]) continue;
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
        };
        const rebuildDisplayMaterials = async () => {
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
                if (replacementInfo.size !== materialRecords.size
                    || Array.from(replacementInfo.values()).some((info) => !info || !info.compiled)) {
                    provisional.forEach(disposeMaterial);
                    rebuildingProvisional = null;
                    udimVariantByMaterial.clear();
                    oldUdimCache.forEach((value, key) => udimVariantByMaterial.set(key, value));
                    displayDirty = false;
                    warnings.push('USD display-transform refresh kept the previous materials because one or more materials failed to regenerate.');
                    report({ phase: 'display-transform', status: 'error', value: targetMode, error: 'incomplete material regeneration' });
                    return;
                }
                replaceMaterialReferences(replacements);
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
        const render = () => {
            if (stopped || !active) { raf = 0; return; }
            if (window.MTLX_CLOCK && typeof window.clockTick === 'function') window.clockTick(performance.now());
            if (environmentBridge && environmentBridge.update) environmentBridge.update();
            applyStudioPolarClamp();
            applyStudioDistanceClamp();
            if (controls) controls.update();
            renderer.render(scene, camera);
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
            const next = Math.round(Number(px));
            if (!SCENE_TEXTURE_MAX_SIZE_VALUES.includes(next) || next === sceneOptions.textureMaxSize) {
                return sceneOptions.textureMaxSize;
            }
            sceneOptions.textureMaxSize = next;
            planOrdinaryTextureSize(Array.from(byPath.values()).map((info) => info.compiled));
            if (window.top === window) {
                try { localStorage.setItem(SCENE_TEXTURE_MAX_SIZE_KEY, String(next)); } catch (e) { /* privacy mode */ }
            }
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
            udimVariantByMaterial.clear();
            displayDirty = true;
            displayRevision += 1;
            if (queueDisplayRebuild && active && !stopped) queueDisplayRebuild();
            return sceneOptions.textureMaxSize;
        };
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
            getTextureStats: () => ({
                textureMaxSize: sceneOptions.textureMaxSize,
                plannedTextureSize,
                udimTileSize: sceneOptions.udimTileSize,
                reservedBytes: textureStats.bytesReserved,
                ordinaryBytes: textureStats.ordinaryBytes,
                textureCount: textureReservations.size,
                udimTileCount: textureStats.udimTiles,
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
                renderer.render(scene, camera);
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
                renderer.render(scene, camera);
            },
            snapshot: () => {
                if (stopped || !renderer.domElement || !renderer.domElement.toDataURL) return null;
                if (environmentBridge && environmentBridge.update) environmentBridge.update();
                renderer.render(scene, camera);
                return renderer.domElement.toDataURL('image/png');
            },
            dispose: () => {
                if (stopped) return;
                stopped = true;
                if (displayTransformListener) {
                    window.removeEventListener('mtlx-display-transform', displayTransformListener);
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
                try { renderer.dispose(); } catch (e) {}
                if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
                __captureCanvas = null; __captureCtx = null;
            },
            // Debug hook: raw GPU state for a headed diagnosis harness.
            // Not for production UI code.
            __debug: () => ({ renderer, scene, camera, materials: Array.from(materials) }),
        };
        return handle;
    } catch (e) {
        stopped = true;
        if (displayTransformListener) {
            window.removeEventListener('mtlx-display-transform', displayTransformListener);
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
        if (controls) controls.dispose();
        if (environmentBridge && environmentBridge.dispose) environmentBridge.dispose();
        if (renderer) renderer.dispose();
        if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
        throw e;
    }
};

Object.assign(window, { createMtlxSceneView });
