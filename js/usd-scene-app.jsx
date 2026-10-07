// Scene Viewer route. This page owns file selection and lifecycle only. USD
// composition and rendering stay behind the two small runtime contracts.
// UI skeleton mirrors js/viewer-app.jsx (docked sidebar, HUD, pinned
// statistics panel like js/compare-app.jsx) so the Scene Viewer looks and
// behaves like the rest of the toolset.
(() => {
    // In the VS Code extension the host sends the stage's file set
    // ('mtlx-load-scene'); pickers, drop and the example are hidden there.
    const IN_VSCODE = !!window.__MTLX_VSCODE__;
    const ROOT_EXTENSIONS = ['.usd', '.usda', '.usdc', '.usdz'];
    // glTF/OBJ/pbrt/Mitsuba (.xml) roots route through window.MtlxSceneSources (js/usd-scene-sources.js)
    // instead of the USD worker; see detectRootKind() and load() below.
    const MODEL_ROOT_EXTENSIONS = ['.glb', '.gltf', '.obj', '.pbrt', '.xml'];
    // Sentinel MtlxSelect option (item 4): picking it reveals every root
    // candidate instead of just the top-level ones, never a real root path.
    const SHOW_ALL_ROOT_FILES_VALUE = '__mtlx_scene_show_all_files__';
    // Self-authored (not imported from js/compare-app.jsx per the ground
    // rule against importing across apps): the same grid-mask empty-stage
    // treatment as Compare's own empty slot.
    const EMPTY_STAGE_GRID_IMAGE = 'linear-gradient(to right, rgb(var(--mtlx-line-heavy) / calc(41 / 255)) 1px, transparent 1px), linear-gradient(to bottom, rgb(var(--mtlx-line-heavy) / calc(41 / 255)) 1px, transparent 1px)';
    const EMPTY_STAGE_GRID_MASK = 'radial-gradient(ellipse at center, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 30%, rgba(0,0,0,0) 70%)';
    // Shared HUD pieces (js/shared/render-hud.jsx), also used by the Viewer and Compare.
    const {
        HUD_POPOVER_BG, HUD_POPOVER_CLASS, ROW_LABEL: SCENE_ROW_LABEL, InfoRow: SceneInfoRow,
        SidebarSectionHeader, popoverHeader, QualitySegments: HudQualitySegments, TabStrip,
    } = window.MtlxRenderHud;

    // Mirrors js/usd-scene-renderer.js sceneDomeYawDegFromRotation (not
    // exported, math not to be changed here): converts an authored dome
    // rotationDeg into the engine's mx_latlong yaw degrees, so a manual
    // nudge of the slider matches the yaw the renderer already applied.
    const domeYawDegFromRotation = (rotationDeg) => (((90 - Number(rotationDeg || 0)) % 360) + 360) % 360;

    const asPath = (file) => String(file.webkitRelativePath || file.relativePath || file.name || '').replace(/\\/g, '/');
    const ext = (path) => { const i = path.lastIndexOf('.'); return i < 0 ? '' : path.slice(i).toLowerCase(); };
    const ALL_ROOT_EXTENSIONS = ROOT_EXTENSIONS.concat(MODEL_ROOT_EXTENSIONS);
    const isUsdRootPath = (path) => ROOT_EXTENSIONS.indexOf(ext(path)) >= 0;
    const isModelRootPath = (path) => MODEL_ROOT_EXTENSIONS.indexOf(ext(path)) >= 0;
    const rootCandidates = (files, mitsubaRoots) => {
        // Keep every supplied USD or model (glTF/OBJ) root selectable; the
        // default still picks a conventional top-level root in
        // pickDefaultRootLayer(). An .xml is offered only when its content made
        // it a Mitsuba root (mitsubaRoots: lower-case paths); other .xml are companions.
        return files.filter((f) => ALL_ROOT_EXTENSIONS.indexOf(ext(f.path)) >= 0
            && (ext(f.path) !== '.xml' || !!(mitsubaRoots && mitsubaRoots.has(String(f.path).replace(/\\/g, '/').toLowerCase()))));
    };
    const dirOf = (path) => { const i = String(path).lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); };
    // Collapses '.' and '..' segments without touching the filesystem, the
    // same way a USD composer resolves an asset path relative to the layer
    // that references it.
    const normalizeRelativePath = (path) => {
        const out = [];
        String(path).split('/').forEach((part) => {
            if (part === '' || part === '.') return;
            if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push('..'); return; }
            out.push(part);
        });
        return out.join('/');
    };
    // Root ranking by resolvable references. A reference counts when it names
    // a known layer/texture/mtlx file; "resolved" means a picked file sits at
    // that path relative to the referencing layer's directory.
    const RANK_REF_EXTENSIONS = ['.usd', '.usda', '.usdc', '.usdz', '.mtlx', '.png', '.jpg', '.jpeg', '.webp',
        '.gif', '.bmp', '.tif', '.tiff', '.exr', '.hdr', '.ktx2'];
    const CRATE_TOKEN_MAX_BYTES = 64 * 1024 * 1024;
    const CRATE_TOKEN_MAX_LENGTH = 1024;
    const cleanRankRef = (raw) => {
        let ref = String(raw || '').replace(/:SDF_FORMAT_ARGS:.*$/, '').trim().replace(/^@+|@+$/g, '').trim();
        if (!ref || ref.length > CRATE_TOKEN_MAX_LENGTH || /[\n\r\0]/.test(ref)) return '';
        if (ref.indexOf('anon:') === 0 || /^data:/i.test(ref) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(ref)) return '';
        ref = ref.replace(/\\/g, '/').split(/[?#]/)[0];
        return RANK_REF_EXTENSIONS.indexOf(ext(ref)) >= 0 ? ref : '';
    };
    // Rankable references of an ASCII layer's text (its @asset@ tokens).
    const textRankRefs = (text) => {
        const out = new Set();
        const tokenPattern = /@([^@\n]+)@/g;
        let match;
        while ((match = tokenPattern.exec(String(text || '')))) {
            const ref = cleanRankRef(match[1]);
            if (ref) out.add(ref);
        }
        return Array.from(out);
    };
    // One LZ4 block (TfFastCompression chunk) into out at start; returns the end offset.
    const lz4DecodeBlock = (src, out, start) => {
        let s = 0, d = start;
        const fail = () => { throw new Error('malformed LZ4 block'); };
        while (s < src.length) {
            const token = src[s++];
            let literals = token >> 4;
            if (literals === 15) { let b; do { if (s >= src.length) fail(); b = src[s++]; literals += b; } while (b === 255); }
            if (s + literals > src.length || d + literals > out.length) fail();
            out.set(src.subarray(s, s + literals), d);
            s += literals; d += literals;
            if (s >= src.length) break;
            if (s + 2 > src.length) fail();
            const offset = src[s] | (src[s + 1] << 8);
            s += 2;
            let match = token & 15;
            if (match === 15) { let b; do { if (s >= src.length) fail(); b = src[s++]; match += b; } while (b === 255); }
            match += 4;
            if (!offset || offset > d - start || d + match > out.length) fail();
            for (let i = 0; i < match; i++, d++) out[d] = out[d - offset];
        }
        return d;
    };
    const tfDecompress = (src, size) => {
        const out = new Uint8Array(size);
        const chunks = src[0];
        if (!chunks) { lz4DecodeBlock(src.subarray(1), out, 0); return out; }
        const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
        let s = 1, d = 0;
        for (let i = 0; i < chunks; i++) {
            if (s + 4 > src.length) throw new Error('malformed compressed tokens');
            const len = view.getInt32(s, true);
            s += 4;
            if (len < 0 || s + len > src.length) throw new Error('malformed compressed tokens');
            d = lz4DecodeBlock(src.subarray(s, s + len), out, d);
            s += len;
        }
        return out;
    };
    // Rankable references of a USD crate, from its TOKENS section only (header
    // and TOC are read by range, never the whole file). [] when not a crate.
    const crateRankRefs = async (blob, maxBytes) => {
        const cap = maxBytes || CRATE_TOKEN_MAX_BYTES;
        const range = async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
        const ascii = (bytes) => String.fromCharCode.apply(null, bytes);
        const header = await range(0, 24);
        if (header.length < 24 || ascii(header.subarray(0, 8)) !== 'PXR-USDC') return [];
        const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
        const oldTokens = header[8] === 0 && header[9] < 4; // before 0.4.0 tokens are stored uncompressed
        const tocOffset = Number(hv.getBigInt64(16, true));
        const countBuf = await range(tocOffset, 8);
        if (countBuf.length < 8) return [];
        const sections = Number(new DataView(countBuf.buffer, countBuf.byteOffset, 8).getBigUint64(0, true));
        if (sections > 64) return [];
        const toc = await range(tocOffset + 8, sections * 32);
        const tv = new DataView(toc.buffer, toc.byteOffset, toc.byteLength);
        for (let i = 0; (i + 1) * 32 <= toc.length; i++) {
            const o = i * 32;
            if (ascii(toc.subarray(o, o + 16)).replace(/\0[\s\S]*$/, '') !== 'TOKENS') continue;
            const start = Number(tv.getBigInt64(o + 16, true));
            const size = Number(tv.getBigInt64(o + 24, true));
            if (size > cap || size < 24) return [];
            const section = await range(start, size);
            const sv = new DataView(section.buffer, section.byteOffset, section.byteLength);
            let chars;
            if (oldTokens) {
                chars = section.subarray(16, 16 + Number(sv.getBigUint64(8, true)));
            } else {
                const uncompressed = Number(sv.getBigUint64(8, true));
                const compressed = Number(sv.getBigUint64(16, true));
                if (uncompressed > cap || 24 + compressed > section.length) return [];
                chars = tfDecompress(section.subarray(24, 24 + compressed), uncompressed);
            }
            const out = new Set();
            new TextDecoder().decode(chars).split('\0').forEach((token) => {
                const ref = cleanRankRef(token);
                if (ref) out.add(ref);
            });
            return Array.from(out);
        }
        return [];
    };
    // { resolved, unresolved } for a layer at layerPath: refs that land on a
    // picked file (lowercase normalized path set) versus those that do not.
    const resolveRankRefs = (layerPath, refs, pickedKeys) => {
        const dir = dirOf(String(layerPath).replace(/\\/g, '/'));
        let resolved = 0, unresolved = 0;
        new Set(refs || []).forEach((raw) => {
            const ref = String(raw).replace(/\\/g, '/');
            const full = ref.charAt(0) === '/' ? normalizeRelativePath(ref) : normalizeRelativePath(dir ? dir + '/' + ref : ref);
            if (pickedKeys.has(full.toLowerCase())) resolved++; else unresolved++;
        });
        return { resolved, unresolved };
    };
    // Comparator: more resolved references first, then fewer unresolved.
    const compareRefScores = (a, b) => {
        const resolvedDiff = (b ? b.resolved : 0) - (a ? a.resolved : 0);
        if (resolvedDiff !== 0) return resolvedDiff;
        return (a ? a.unresolved : 0) - (b ? b.unresolved : 0);
    };
    // Pure: given each candidate layer's own text (ASCII USD or glTF JSON,
    // read by the caller so this needs no Blob/File API), returns the set of
    // normalized lowercase paths any of them references: a USD `@asset@`
    // token, or a glTF buffer/image "uri". Used to tell a folder's top-level
    // scenes from sub-layers/buffers other picked files pull in (item 4).
    const scanReferencedAssetPaths = (entries) => {
        const referenced = new Set();
        (entries || []).forEach((entry) => {
            const path = String((entry && entry.path) || '');
            const text = String((entry && entry.text) || '');
            const dir = dirOf(path);
            const selfKey = normalizeRelativePath(path).toLowerCase();
            const addRef = (raw) => {
                let ref = String(raw || '').trim();
                if (!ref || ref.indexOf('anon:') === 0) return;
                if (/^data:/i.test(ref) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(ref)) return;
                ref = ref.replace(/\\/g, '/').split(/[?#]/)[0];
                if (!ref) return;
                const resolved = ref.charAt(0) === '/' ? normalizeRelativePath(ref) : normalizeRelativePath(dir ? dir + '/' + ref : ref);
                const resolvedKey = resolved.toLowerCase();
                if (!resolvedKey || resolvedKey === selfKey) return; // self references never count as "referenced by something else"
                referenced.add(resolvedKey);
            };
            if (ext(path) === '.gltf') {
                const uriPattern = /"uri"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
                let m;
                while ((m = uriPattern.exec(text))) {
                    let ref = m[1].replace(/\\(.)/g, '$1');
                    try { ref = decodeURIComponent(ref); } catch (e) { /* keep raw */ }
                    addRef(ref);
                }
                return;
            }
            const tokenPattern = /@([^@\n]+)@/g;
            let match;
            while ((match = tokenPattern.exec(text))) addRef(match[1].replace(/:SDF_FORMAT_ARGS:.*$/, ''));
        });
        return referenced;
    };
    // Pure: candidate paths not referenced by anything else scanned stay
    // "top level" (the Scene file dropdown's default list); everything else
    // only shows once "Show all files" is picked.
    const topLevelRootPaths = (candidatePaths, referenced) => {
        const list = Array.isArray(candidatePaths) ? candidatePaths : [];
        if (!referenced || !referenced.size) return list.slice();
        return list.filter((p) => !referenced.has(String(p).replace(/\\/g, '/').toLowerCase()));
    };
    // Source containers (the dropped .glb/.usdz/.obj and friends) are never
    // textures: handing one to the material preview ships megabytes through
    // the embed for nothing.
    const CONTAINER_EXTENSIONS = ['.glb', '.gltf', '.obj', '.pbrt', '.xml', '.ply', '.gz', '.fbx', '.zip', '.usd', '.usda', '.usdc', '.usdz'];
    // Files the floating material preview and the graph hand-off get: the
    // renderer's own per-material map, plus any scene file whose name
    // matches a file="..." reference the renderer did not resolve. Pure so
    // tests/unit/usd-scene-preview-files.test.mjs can exercise it.
    const materialPreviewFiles = (documentFiles, documentXml, sceneFiles) => {
        const out = {};
        const isContainer = (path) => {
            const lower = String(path).toLowerCase();
            return CONTAINER_EXTENSIONS.some((e) => lower.endsWith(e));
        };
        Object.keys(documentFiles || {}).forEach((key) => {
            if (!isContainer(key)) out[key] = documentFiles[key];
        });
        const scene = sceneFiles || {};
        const sceneKeys = Object.keys(scene).filter((key) => !isContainer(key));
        if (!sceneKeys.length) return out;
        const refs = new Set();
        String(documentXml || '').replace(/(?:file|value)\s*=\s*"([^"]+)"/g, (all, ref) => {
            const trimmed = ref.trim();
            if (trimmed) refs.add(trimmed);
            return all;
        });
        const baseName = (path) => String(path).split('/').pop().toLowerCase();
        const wanted = new Set();
        refs.forEach((ref) => {
            const normalized = ref.split('\\').join('/');
            wanted.add(normalized.toLowerCase());
            wanted.add(baseName(normalized));
        });
        sceneKeys.forEach((key) => {
            if (out[key] !== undefined) return;
            const normalized = key.split('\\').join('/').toLowerCase();
            if (wanted.has(normalized) || wanted.has(baseName(normalized))
                || Array.from(wanted).some((ref) => ref.length > 3 && normalized.endsWith('/' + ref))) {
                out[key] = scene[key];
            }
        });
        return out;
    };
    const rootNamePattern = /(^|\/)root\.(usd|usda|usdc|usdz)$/i;
    const oldDefaultRoot = (candidates) => {
        const preferred = candidates.find((f) => rootNamePattern.test(f.path));
        return preferred ? preferred.path : (candidates.length === 1 ? candidates[0].path : '');
    };
    // A candidate's data may be a File/Blob (file picker, window drop) or an
    // ArrayBuffer/typed array (host-provided buffers); normalize both
    // to a Blob so slice()/text() work the same way.
    const blobOfCandidate = (file) => {
        const data = file && file.data !== undefined ? file.data : file;
        if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
        if (data instanceof ArrayBuffer) return new Blob([data]);
        if (ArrayBuffer.isView(data)) return new Blob([data.buffer]);
        return null;
    };
    const ASCII_SCAN_SKIP_BYTES = 64 * 1024 * 1024;
    const ASCII_SCAN_MAX_CHARS = 32 * 1024 * 1024;
    const isAsciiUsdBlob = async (blob) => {
        if (!blob || typeof blob.slice !== 'function') return false;
        try { return /^#usda\b/.test(await blob.slice(0, 8).text()); } catch (e) { return false; }
    };
    // Scans every ASCII USD candidate once for `@asset@` tokens (references,
    // payloads, subLayers) to tell top-level layers from layers something
    // else pulls in, then picks the shallowest unreferenced one so a folder
    // like the Teapot's (root usda referencing Geometry/* and Looks/*)
    // defaults to the actual root instead of leaving the picker empty.
    // Keyed by the candidate set's own identity (path|size|lastModified per
    // file, sorted and joined) so re-selecting the same folder skips the
    // whole ASCII scan. Insertion-order eviction keeps this small.
    const ROOT_LAYER_CACHE_MAX = 8;
    const rootLayerCache = new Map();
    const cacheRootLayer = (key, value) => {
        if (rootLayerCache.size >= ROOT_LAYER_CACHE_MAX) rootLayerCache.delete(rootLayerCache.keys().next().value);
        rootLayerCache.set(key, value);
        return value;
    };
    // Shallowest-first, then alphabetical, the same tiebreak
    // pickDefaultUsdRootLayer uses for composition roots below.
    const shallowestFirst = (a, b) => {
        const depthDiff = String(a.path).split('/').length - String(b.path).split('/').length;
        if (depthDiff !== 0) return depthDiff;
        const aPath = String(a.path), bPath = String(b.path);
        return aPath < bPath ? -1 : (aPath > bPath ? 1 : 0);
    };
    // Model-only root selection (no USD candidate present): a single root
    // wins outright; otherwise prefer the shallowest .gltf/.glb, then a .pbrt
    // no other .pbrt includes, then the best Mitsuba root (mitsubaOrder, from
    // classifyMitsubaXmlFiles: highest version first), then .obj.
    function pickDefaultModelRoot(modelCandidates, referenced, mitsubaOrder) {
        if (modelCandidates.length === 0) return '';
        if (modelCandidates.length === 1) return modelCandidates[0].path;
        const gltfLike = modelCandidates.filter((f) => ext(f.path) === '.gltf' || ext(f.path) === '.glb');
        const pbrtRoots = modelCandidates.filter((f) => ext(f.path) === '.pbrt'
            && !(referenced && referenced.has(String(f.path).replace(/\\/g, '/').toLowerCase())));
        const mitsubaRank = (f) => { const i = (mitsubaOrder || []).indexOf(f.path); return i < 0 ? Infinity : i; };
        const mitsubaRoots = modelCandidates.filter((f) => ext(f.path) === '.xml').sort((a, b) => mitsubaRank(a) - mitsubaRank(b));
        if (!gltfLike.length && !pbrtRoots.length && mitsubaRoots.length) return mitsubaRoots[0].path;
        const pool = (gltfLike.length ? gltfLike : (pbrtRoots.length ? pbrtRoots : (mitsubaRoots.length ? mitsubaRoots : modelCandidates.filter((f) => ext(f.path) === '.obj')))) || [];
        const sorted = (pool.length ? pool : modelCandidates).slice().sort(shallowestFirst);
        return sorted[0].path;
    }
    // .gltf candidates only (glTF JSON, always text): scanReferencedAssetPaths'
    // buffer/image "uri" branch, so a folder of model roots can also tell a
    // top-level scene from something only another .gltf pulls in (item 4).
    async function scanGltfCandidateReferences(candidates) {
        const entries = [];
        for (const file of candidates) {
            if (ext(file.path) !== '.gltf') continue;
            const blob = blobOfCandidate(file);
            if (!blob) continue;
            const size = typeof blob.size === 'number' ? blob.size : 0;
            if (size > ASCII_SCAN_SKIP_BYTES) continue;
            let text;
            try { text = await blob.text(); } catch (e) { continue; }
            if (text.length > ASCII_SCAN_MAX_CHARS) text = text.slice(0, ASCII_SCAN_MAX_CHARS);
            entries.push({ path: file.path, text });
        }
        return scanReferencedAssetPaths(entries);
    }
    // .pbrt candidates: files named by an Include/Import of another .pbrt
    // (relative to the including file) are not top-level scene roots.
    async function scanPbrtCandidateReferences(candidates) {
        const referenced = new Set();
        for (const file of candidates) {
            if (ext(file.path) !== '.pbrt') continue;
            const blob = blobOfCandidate(file);
            if (!blob || (typeof blob.size === 'number' && blob.size > ASCII_SCAN_SKIP_BYTES)) continue;
            let text;
            try { text = await blob.text(); } catch (e) { continue; }
            if (text.length > ASCII_SCAN_MAX_CHARS) text = text.slice(0, ASCII_SCAN_MAX_CHARS);
            const dir = dirOf(String(file.path).replace(/\\/g, '/'));
            const pattern = /^\s*(?:Include|Import)\s+"([^"]+)"/gm;
            let match;
            while ((match = pattern.exec(text))) {
                const ref = match[1].replace(/\\/g, '/');
                referenced.add(normalizeRelativePath(dir ? dir + '/' + ref : ref).toLowerCase());
            }
        }
        return referenced;
    }
    // Valid Mitsuba roots among the dropped .xml files, best first, by content
    // (MtlxSceneSources.classifyMitsubaXmlFiles). Any other .xml is a companion file.
    async function scanMitsubaRoots(files) {
        const xml = files.filter((f) => ext(f.path) === '.xml');
        const sources = window.MtlxSceneSources;
        if (!xml.length || !sources || typeof sources.classifyMitsubaXmlFiles !== 'function') return [];
        try { return (await sources.classifyMitsubaXmlFiles(xml)).roots; } catch (e) { return []; }
    }
    // A USD root always wins the default pick over a co-uploaded model
    // root, which comes back as an ignoredModelRoots entry for the
    // caller's diagnostics; with no USD root, a model root is picked.
    // topLevelPaths (item 4): every candidate path nothing else picked
    // references, reusing the same ASCII scan pickDefaultUsdRootLayer
    // already runs (plus a lightweight glTF buffer/image pass) so the
    // Scene file dropdown's default list costs no extra work.
    async function pickDefaultRootLayer(files) {
        const mitsubaOrder = await scanMitsubaRoots(files);
        const mitsubaRootPaths = mitsubaOrder.map((p) => String(p).toLowerCase());
        const candidates = rootCandidates(files, new Set(mitsubaRootPaths));
        if (candidates.length === 0) return { path: '', ignoredModelRoots: [], topLevelPaths: [], mitsubaRootPaths };
        const usdCandidates = candidates.filter((f) => isUsdRootPath(f.path));
        const modelCandidates = candidates.filter((f) => isModelRootPath(f.path));
        const gltfReferenced = await scanGltfCandidateReferences(candidates);
        (await scanPbrtCandidateReferences(candidates)).forEach((r) => gltfReferenced.add(r));
        const candidatePaths = candidates.map((f) => f.path);
        if (usdCandidates.length === 0) {
            const path = pickDefaultModelRoot(modelCandidates, gltfReferenced, mitsubaOrder);
            return { path, ignoredModelRoots: [], topLevelPaths: topLevelRootPaths(candidatePaths, gltfReferenced), mitsubaRootPaths };
        }
        const { path, referenced } = await pickDefaultUsdRootLayer(usdCandidates, files.map((f) => f.path));
        gltfReferenced.forEach((r) => referenced.add(r));
        return {
            path,
            ignoredModelRoots: modelCandidates.map((f) => f.path),
            topLevelPaths: topLevelRootPaths(candidatePaths, referenced),
            mitsubaRootPaths,
        };
    }
    async function pickDefaultUsdRootLayer(candidates, allPaths) {
        const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (candidates.length === 0) return { path: '', referenced: new Set() };
        if (candidates.length === 1) return { path: candidates[0].path, referenced: new Set() };
        const cacheKey = candidates.map((f) => {
            const size = f && f.data && typeof f.data.size === 'number' ? f.data.size : -1;
            const modified = f && f.data && typeof f.data.lastModified === 'number' ? f.data.lastModified : -1;
            return String(f.path) + '|' + size + '|' + modified;
        }).sort().join(',') + '#' + (allPaths ? allPaths.length : 0);
        if (rootLayerCache.has(cacheKey)) {
            const elapsedMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startedAt;
            console.debug('pickDefaultRootLayer: scanned', candidates.length, 'candidates in', elapsedMs.toFixed(1) + 'ms (cached)');
            const cached = rootLayerCache.get(cacheKey);
            return { path: cached.path, referenced: new Set(cached.referenced) };
        }
        const candidateKeys = new Set(candidates.map((f) => String(f.path).replace(/\\/g, '/').toLowerCase()));
        const referenced = new Set();
        // Which OTHER candidates a layer references, keyed by the scanning
        // layer's own normalized path. Used to prefer composition roots
        // (layers that pull in other candidates) over standalone leaves.
        const outgoing = new Map();
        // Rankable references per candidate (ASCII @..@ tokens or crate tokens).
        const rankRefs = new Map();
        for (const file of candidates) {
            const selfKey = String(file.path).replace(/\\/g, '/').toLowerCase();
            const blob = blobOfCandidate(file);
            if (!blob) continue;
            if (!(await isAsciiUsdBlob(blob))) {
                try { rankRefs.set(selfKey, await crateRankRefs(blob)); } catch (e) { /* unreadable crate: no refs */ }
                continue;
            }
            const size = typeof blob.size === 'number' ? blob.size : 0;
            if (size > ASCII_SCAN_SKIP_BYTES) { console.info('pickDefaultRootLayer: skipping oversized USD layer', file.path, size); continue; }
            let text;
            try { text = await blob.text(); } catch (e) { continue; }
            if (text.length > ASCII_SCAN_MAX_CHARS) text = text.slice(0, ASCII_SCAN_MAX_CHARS);
            rankRefs.set(selfKey, textRankRefs(text));
            const dir = dirOf(file.path);
            const tokenPattern = /@([^@\n]+)@/g;
            let match;
            const outs = new Set();
            while ((match = tokenPattern.exec(text))) {
                let ref = match[1].replace(/:SDF_FORMAT_ARGS:.*$/, '').trim();
                if (!ref || ref.indexOf('anon:') === 0 || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(ref)) continue;
                ref = ref.replace(/\\/g, '/');
                if (ROOT_EXTENSIONS.indexOf(ext(ref.split(/[?#]/)[0])) < 0) continue;
                const resolved = ref.charAt(0) === '/' ? normalizeRelativePath(ref) : normalizeRelativePath(dir ? dir + '/' + ref : ref);
                const resolvedKey = resolved.toLowerCase();
                if (resolvedKey === selfKey) continue; // self references never count as "referenced by something else"
                referenced.add(resolvedKey);
                if (candidateKeys.has(resolvedKey)) outs.add(resolvedKey);
            }
            if (outs.size) outgoing.set(selfKey, outs);
        }
        const topLevel = candidates.filter((f) => !referenced.has(String(f.path).replace(/\\/g, '/').toLowerCase()));
        const elapsedMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startedAt;
        console.debug('pickDefaultRootLayer: scanned', candidates.length, 'candidates in', elapsedMs.toFixed(1) + 'ms');
        if (topLevel.length === 0) {
            const path = cacheRootLayer(cacheKey, { path: oldDefaultRoot(candidates), referenced: Array.from(referenced) }).path;
            return { path, referenced };
        }
        const isComposition = (f) => outgoing.has(String(f.path).replace(/\\/g, '/').toLowerCase());
        const isNamedRoot = (f) => rootNamePattern.test(f.path);
        const pickedKeys = new Set((allPaths || candidates.map((f) => f.path))
            .map((p) => normalizeRelativePath(String(p).replace(/\\/g, '/')).toLowerCase()));
        const refScores = new Map(topLevel.map((f) => [f.path,
            resolveRankRefs(f.path, rankRefs.get(String(f.path).replace(/\\/g, '/').toLowerCase()), pickedKeys)]));
        topLevel.sort((a, b) => {
            const compDiff = (isComposition(b) ? 1 : 0) - (isComposition(a) ? 1 : 0);
            if (compDiff !== 0) return compDiff;
            const namedDiff = (isNamedRoot(b) ? 1 : 0) - (isNamedRoot(a) ? 1 : 0);
            if (namedDiff !== 0) return namedDiff;
            const refDiff = compareRefScores(refScores.get(a.path), refScores.get(b.path));
            if (refDiff !== 0) return refDiff;
            const depthDiff = String(a.path).split('/').length - String(b.path).split('/').length;
            if (depthDiff !== 0) return depthDiff;
            const lenDiff = String(a.path).length - String(b.path).length;
            if (lenDiff !== 0) return lenDiff;
            const aPath = String(a.path), bPath = String(b.path);
            return aPath < bPath ? -1 : (aPath > bPath ? 1 : 0);
        });
        const path = cacheRootLayer(cacheKey, { path: topLevel[0].path, referenced: Array.from(referenced) }).path;
        return { path, referenced };
    }
    // The camera the picker should apply with no user interaction: the one
    // the worker flags defaultCamera, else the first authored camera, else
    // null (auto framing). Defensive since the flag may not exist yet.
    function defaultCameraPathFor(cams) {
        const list = Array.isArray(cams) ? cams : [];
        if (list.length === 0) return null;
        const flagged = list.find((c) => c && c.defaultCamera);
        return (flagged || list[0]).primPath || null;
    }
    // Root-layer candidates from a shared upload often share one long
    // prefix (a zip's top folder), so the basename alone tells them apart
    // in most cases. When two candidates share a basename, extend both by
    // one more parent directory at a time until their labels differ.
    const distinctRootLabels = (paths) => {
        const segs = paths.map((p) => String(p).split('/').filter(Boolean));
        const labels = segs.map((s) => s[s.length - 1] || '');
        const groups = new Map();
        labels.forEach((label, i) => {
            if (!groups.has(label)) groups.set(label, []);
            groups.get(label).push(i);
        });
        groups.forEach((idxs) => {
            if (idxs.length < 2) return;
            let depth = 1;
            for (;;) {
                const tries = idxs.map((i) => segs[i].slice(-1 - depth).join('/'));
                const unique = new Set(tries).size === tries.length;
                const exhausted = idxs.every((i) => depth + 1 >= segs[i].length);
                if (unique || exhausted) {
                    idxs.forEach((i, j) => { labels[i] = tries[j]; });
                    break;
                }
                depth += 1;
            }
        });
        return labels;
    };
    const stageMeshes = (stage) => Array.isArray(stage && stage.meshes) ? stage.meshes : [];
    const stageTriangleCount = (stage) => stageMeshes(stage).reduce((sum, mesh) => {
        if (!mesh) return sum;
        const corners = Array.isArray(mesh.indices) || mesh.indices ? mesh.indices.length : (mesh.positions ? mesh.positions.length / 3 : 0);
        return sum + Math.floor(corners / 3);
    }, 0);
    const stageMaterials = (stage) => Array.isArray(stage && stage.materials) ? stage.materials : [];
    const stageLightRecords = (stage) => (Array.isArray(stage && stage.lights) ? stage.lights.filter(Boolean) : []);
    const materialWarningList = (stage) => {
        const out = [];
        (Array.isArray(stage && stage.warnings) ? stage.warnings : []).forEach((w) => out.push(String(w && (w.message || w.text || w) || 'Scene warning')));
        stageMeshes(stage).forEach((mesh) => (Array.isArray(mesh && mesh.warnings) ? mesh.warnings : []).forEach((w) => out.push(String(w && (w.message || w.text || w) || 'Material warning'))));
        return out;
    };
    const warningRecord = (value) => {
        const raw = String(value || 'Scene warning');
        // Native USD can repeat the same failed asset once per composed prim.
        // Collapse that noisy form to a useful path while retaining the raw
        // diagnostic below a disclosure for debugging.
        const assetMatch = /Could not open asset @([^@]+)@/i.exec(raw);
        if (assetMatch) {
            const path = assetMatch[1].replace(/\\/g, '/');
            return { key: 'missing-asset:' + path.toLowerCase(), label: 'Missing referenced file: ' + path, raw };
        }
        const pathMatch = /(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.(?:usd|usda|usdc|usdz)\b/i.exec(raw);
        if (pathMatch && /(?:open|read|reference|layer)/i.test(raw) && !/too large/i.test(raw)) {
            const path = pathMatch[0].replace(/\\/g, '/');
            return { key: 'missing-layer:' + path.toLowerCase(), label: 'Missing referenced layer: ' + path, raw };
        }
        return { key: raw, label: raw, raw };
    };
    const warningRecords = (values) => {
        const seen = new Set();
        return values.map(warningRecord).filter((record) => {
            if (seen.has(record.key)) return false;
            seen.add(record.key);
            return true;
        });
    };
    const readFiles = async (fileList) => {
        const all = Array.from(fileList || []);
        const kept = all.filter((file) => !isHiddenSideFile(asPath(file)));
        if (kept.length !== all.length) console.info('readFiles: skipped ' + (all.length - kept.length) + ' side file(s)');
        return kept.map((file) => ({ path: asPath(file), data: file }));
    };
    // Window drop hands over a { relPath: File } map (js/mtlx-engine.js's
    // readDroppedItems, which preserves nested directory paths); flatten it
    // to the same { path, data } shape readFiles() produces.
    const filesFromMap = (map) => Object.keys(map || {}).map((path) => ({ path: String(path).replace(/\\/g, '/'), data: map[path] }));
    // VS Code: files a loaded stage asked for but did not receive, with the
    // layer that referenced each one, read from the native USD messages.
    const stageMissingEntries = (stage) => {
        const out = [];
        (Array.isArray(stage && stage.warnings) ? stage.warnings : []).forEach((w) => {
            const raw = String(w && (w.message || w.text || w) || '');
            const m = /Could not open asset @([^@]+)@ for [^\n]*?introduced by @([^@]+)@/i.exec(raw)
                || /Could not load sublayer @([^@]+)@ of layer @([^@]+)@/i.exec(raw);
            if (m) out.push({ asset: m[1], introducedBy: m[2] });
        });
        return out;
    };
    // VS Code: textures the renderer could not find (relative to the file
    // set, UDIM patterns included) and a dome light's missing texture.
    const renderMissingEntries = (handle, root) => {
        const out = [];
        (Array.isArray(handle && handle.missingFiles) ? handle.missingFiles : []).forEach((path) => out.push({ asset: String(path), introducedBy: '' }));
        (Array.isArray(handle && handle.warnings) ? handle.warnings : []).forEach((w) => {
            const m = /^Dome light texture not found: "(.+)"$/.exec(String(w));
            if (m) out.push({ asset: m[1], introducedBy: root || '' });
        });
        return out;
    };
    const formatMegabytes = (bytes) => {
        const mb = Number(bytes || 0) / 1048576;
        return String(mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10);
    };
    // Scene section: the root's format in plain words ('.usd' is sniffed for the
    // crate header), named units for metersPerUnit, and byte sizes.
    const SCENE_FORMAT_LABELS = { '.usda': 'USD', '.usdc': 'USD binary', '.usdz': 'USDZ package', '.gltf': 'glTF', '.glb': 'glTF binary', '.obj': 'OBJ', '.pbrt': 'PBRT v4', '.xml': 'Mitsuba' };
    const sceneFormatLabel = (path, usdBinary) => (ext(String(path || '')) === '.usd'
        ? (usdBinary ? 'USD binary' : 'USD')
        : (SCENE_FORMAT_LABELS[ext(String(path || ''))] || ''));
    const SCENE_UNIT_NAMES = [[1, 'Meters'], [0.1, 'Decimeters'], [0.01, 'Centimeters'], [0.001, 'Millimeters'], [1000, 'Kilometers'], [0.0254, 'Inches'], [0.3048, 'Feet']];
    const sceneUnitsLabel = (metersPerUnit) => {
        const value = Number(metersPerUnit);
        if (!(value > 0)) return '';
        const named = SCENE_UNIT_NAMES.find(([meters]) => Math.abs(meters - value) <= meters * 1e-6);
        return named ? named[1] : value + ' m per unit';
    };
    const sceneFileBytes = (file) => {
        const data = file && file.data !== undefined ? file.data : file;
        if (!data) return 0;
        if (typeof data.size === 'number') return data.size;
        return typeof data.byteLength === 'number' ? data.byteLength : 0;
    };
    const formatByteSize = (bytes) => {
        const n = Number(bytes || 0);
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
        if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
        return (n / 1073741824).toFixed(1) + ' GB';
    };
    // Whole-load phase table: the single source of truth for the load
    // sequence's step numbering, labels and progress-bar segments.
    const USD_SCENE_BASE_LOAD_PHASES = [
        { phase: 'worker', label: 'Reading files', segment: [0.00, 0.06] },
        { phase: 'parse', label: 'Composing scene', segment: [0.06, 0.10] },
        { phase: 'extract-geometry', label: 'Extracting meshes', segment: [0.10, 0.14] },
        { phase: 'extract-materials', label: 'Extracting materials', segment: [0.14, 0.16] },
        { phase: 'prepare-geometry', label: 'Subdividing meshes', segment: [0.16, 0.20] },
        { phase: 'material', label: 'Compiling materials', segment: [0.20, 0.52] },
        { phase: 'material-bind', label: 'Binding materials', segment: [0.52, 0.56] },
        { phase: 'texture', label: 'Loading textures', segment: [0.56, 0.72] },
        { phase: 'geometry', label: 'Preparing geometry', segment: [0.72, 0.86] },
        { phase: 'renderer', label: 'Preparing viewport', segment: [0.86, 0.99] },
    ];
    // In VS Code the host's file collection and the webview's file fetch
    // come first and own the start of the bar; the web table is unchanged.
    const USD_SCENE_LOAD_PHASES = IN_VSCODE
        ? [
            { phase: 'collect', label: 'Finding referenced files', segment: [0.00, 0.03] },
            { phase: 'fetch', label: 'Loading files', segment: [0.03, 0.25] },
        ].concat(USD_SCENE_BASE_LOAD_PHASES.map((entry) => ({
            ...entry, segment: [0.25 + entry.segment[0] * 0.75, 0.25 + entry.segment[1] * 0.75],
        })))
        : USD_SCENE_BASE_LOAD_PHASES;
    window.USD_SCENE_LOAD_PHASES = USD_SCENE_LOAD_PHASES;
    // Each phase owns a slice of the bar so it fills once across the whole
    // load instead of restarting per phase.
    const USD_SCENE_PROGRESS_SEGMENTS = Object.fromEntries(
        USD_SCENE_LOAD_PHASES.map((entry) => [entry.phase, entry.segment])
    );
    // Pure: maps one progress event plus the previous whole-load fraction to
    // the next whole-load fraction. Never moves backwards inside one load.
    const usdSceneProgressFraction = (event, previous) => {
        const prev = Number.isFinite(previous) ? previous : 0;
        const clamp01 = (v) => Math.max(0, Math.min(1, v));
        const p = event && typeof event === 'object' ? event : {};
        const phase = String(p.phase || '');
        if (phase === 'renderer' && String(p.status || '') === 'ready') return 1;
        const segment = USD_SCENE_PROGRESS_SEGMENTS[phase];
        if (!segment) return prev;
        const [start, end] = segment;
        const explicitFraction = p.fraction != null ? Number(p.fraction) : (p.progress != null ? Number(p.progress) : null);
        const total = Number(p.total || 0);
        const done = Number(p.done != null ? p.done : (p.index != null ? p.index : 0));
        const local = Number.isFinite(explicitFraction) ? clamp01(explicitFraction) : (total > 0 ? clamp01(done / total) : 0);
        return Math.max(prev, start + local * (end - start));
    };
    window.usdSceneProgressFraction = usdSceneProgressFraction;
    const progressValue = (value, wholeFraction) => {
        if (typeof value === 'number') {
            const numberFraction = Number.isFinite(wholeFraction) ? wholeFraction : (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null);
            return { phase: 'Loading', fraction: numberFraction, done: 0, total: 0, message: '', label: '', step: '' };
        }
        const p = value && typeof value === 'object' ? value : { message: String(value || '') };
        const done = Number(p.done || p.index || 0);
        const total = Number(p.total || 0);
        const fraction = Number.isFinite(wholeFraction) ? wholeFraction : null;
        return {
            phase: String(p.phase || ''), fraction, done, total,
            message: String(p.message || p.status || ''),
            label: String(p.label || ''), step: String(p.step || ''),
        };
    };
    const apiFunction = (name) => {
        const candidates = [window[name], window.MtlxUsd && window.MtlxUsd[name], window.UsdSceneRuntime && window.UsdSceneRuntime[name]];
        return candidates.find((value) => typeof value === 'function');
    };

    // Pure: keeps a panel rect fully inside bounds, shrinking it first when
    // it is larger than the container. `minY` keeps the top edge below a HUD
    // row (e.g. the scene toolbar); it never grows the rect past the bottom.
    // No side effects, safe for a Node test.
    // `minSize` (optional): a hard floor for width/height that wins over the
    // bounds ceiling when the two conflict (a container narrower/shorter
    // than the floor), so a caller like the material preview panel can
    // guarantee its panel never resizes below a usable size (item 8).
    const clampPanelRect = (rect, bounds, minY, minSize) => {
        // Empty bounds mean the view is hidden (display none); clamping
        // against them would collapse the rect to nothing, so keep it.
        if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        const top = minY || 0;
        const minWidth = (minSize && minSize.width) || 0;
        const minHeight = (minSize && minSize.height) || 0;
        const width = Math.max(minWidth, Math.min(rect.width, bounds.width));
        const height = Math.max(minHeight, Math.min(rect.height, bounds.height));
        const x = Math.max(0, Math.min(rect.x, bounds.width - width));
        const maxY = Math.max(0, bounds.height - height);
        const y = Math.min(Math.max(rect.y, top), maxY);
        return { x, y, width, height };
    };
    window.usdSceneClampPanelRect = clampPanelRect;

    // The USD prim's own name (a composed alias, "Red") and the renderer's
    // cached hint can both differ from the actual MaterialX element name
    // inside the referenced document ("red_material"). Scan the resolved
    // xml for type="material" elements and prefer one that matches the
    // hint; with no match, a single material element is unambiguous.
    const resolveDocMaterialName = (xml, hintName) => {
        if (!xml) return hintName || null;
        const materials = [];
        const tagRe = /<[a-zA-Z_][\w.]*\s+[^>]*>/g;
        let tagMatch;
        while ((tagMatch = tagRe.exec(xml)) !== null) {
            const tag = tagMatch[0];
            if (!/\btype\s*=\s*"material"/.test(tag)) continue;
            const nameMatch = /\bname\s*=\s*"([^"]*)"/.exec(tag);
            if (nameMatch && nameMatch[1]) materials.push(nameMatch[1]);
        }
        if (!materials.length) return hintName || null;
        if (hintName && materials.indexOf(hintName) >= 0) return hintName;
        return materials.length === 1 ? materials[0] : (hintName || materials[0]);
    };

    // Scene outliner model built from the neutral stage payload (USD, glTF, OBJ or pbrt): four
    // fixed groups, Scene (the object tree), Materials, Cameras and Lights. Scene rows key
    // on their path, every other row on a prefixed id. Pure: tests/unit/usd-scene-tree.test.mjs.
    const sceneTreeSegments = (path) => String(path || '').split('/').filter(Boolean);
    const sceneTreeLeafName = (path) => { const segments = sceneTreeSegments(path); return segments.length ? segments[segments.length - 1] : String(path || ''); };
    const SCENE_TREE_GROUPS = [['scene', 'Scene'], ['materials', 'Materials'], ['cameras', 'Cameras'], ['lights', 'Lights']];
    const SCENE_TREE_DEFAULT_CAMERA_ID = 'camera:default';
    const SCENE_TREE_ENVIRONMENT_ID = 'light:environment';
    const sceneTreeNameCollator = typeof Intl !== 'undefined' && Intl.Collator ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;
    const sceneTreeByName = (a, b) => (sceneTreeNameCollator ? sceneTreeNameCollator.compare(a.name, b.name) : (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)))
        || (a.path < b.path ? -1 : (a.path > b.path ? 1 : 0));
    const buildSceneTree = (stage) => {
        const byId = new Map();
        const byPath = new Map();
        const byRenderPath = new Map();
        const meshesByMaterial = new Map();
        const list = (value) => (Array.isArray(value) ? value : []);
        const makeNode = (id, path, name, kind, group, depth, parent) => ({
            id, path, name, kind, group, isGroup: kind === 'group', depth, parent,
            children: [], renderPaths: [], materialPath: '', lightType: '', meshCount: 0, count: 0,
        });
        const groups = {};
        const roots = SCENE_TREE_GROUPS.map(([key, label]) => {
            const node = makeNode('group:' + key, '', label, 'group', key, 0, null);
            groups[key] = node;
            byId.set(node.id, node);
            return node;
        });
        const ensure = (path) => {
            const existing = byPath.get(path);
            if (existing) return existing;
            const segments = sceneTreeSegments(path);
            const parent = segments.length > 1 ? ensure('/' + segments.slice(0, -1).join('/')) : groups.scene;
            const node = makeNode(path, path, segments[segments.length - 1], 'xform', 'scene', segments.length, parent);
            byPath.set(path, node);
            byId.set(path, node);
            parent.children.push(node);
            return node;
        };
        const addObject = (path, kind) => {
            const segments = sceneTreeSegments(path);
            if (!segments.length) return null;
            const node = ensure('/' + segments.join('/'));
            if (kind === 'mesh') node.kind = 'mesh';
            return node;
        };
        const addItem = (groupKey, id, path, name, kind) => {
            if (byId.has(id)) return null;
            const group = groups[groupKey];
            const node = makeNode(id, path, name, kind, groupKey, 1, group);
            byId.set(id, node);
            group.children.push(node);
            return node;
        };
        const bindMaterial = (materialPath, renderPath) => {
            if (!materialPath) return;
            const key = String(materialPath);
            if (!meshesByMaterial.has(key)) meshesByMaterial.set(key, []);
            const bound = meshesByMaterial.get(key);
            if (bound.indexOf(renderPath) < 0) bound.push(renderPath);
        };
        // Scene: glTF node order first (empty transforms count too), then the meshes.
        list(stage && stage.nodes).forEach((entry) => addObject(typeof entry === 'string' ? entry : String((entry && entry.treePath) || ''), 'xform'));
        list(stage && stage.meshes).forEach((mesh) => {
            const renderPath = String((mesh && (mesh.instanceOwnerPath || mesh.primPath)) || '');
            if (!renderPath) return;
            const node = addObject(mesh.treePath || renderPath, 'mesh');
            if (!node) return;
            if (node.renderPaths.indexOf(renderPath) < 0) node.renderPaths.push(renderPath);
            if (!byRenderPath.has(renderPath)) byRenderPath.set(renderPath, node);
            const meshGroups = list(mesh.groups);
            const groupMaterial = (meshGroups.find((group) => group && group.materialPath) || {}).materialPath;
            if (!node.materialPath) node.materialPath = String(mesh.materialPath || groupMaterial || '');
            bindMaterial(mesh.materialPath, renderPath);
            meshGroups.forEach((group) => bindMaterial(group && group.materialPath, renderPath));
        });
        // Materials: every stage material, any bound path the stage did not list, and every
        // Material prim the worker found even when no mesh binds it (stage.materialPrims).
        const materialPaths = [];
        list(stage && stage.materials).forEach((material) => { const path = String((material && material.path) || ''); if (path) materialPaths.push(path); });
        meshesByMaterial.forEach((bound, path) => materialPaths.push(path));
        list(stage && stage.materialPrims).forEach((prim) => { const path = String((prim && prim.path) || ''); if (path) materialPaths.push(path); });
        materialPaths.forEach((path) => {
            const node = addItem('materials', 'material:' + path, path, sceneTreeLeafName(path), 'material');
            if (node) node.materialPath = path;
        });
        groups.materials.children.sort(sceneTreeByName);
        const defaultCamera = addItem('cameras', SCENE_TREE_DEFAULT_CAMERA_ID, '', 'Default camera', 'camera');
        defaultCamera.isDefaultCamera = true;
        list(stage && stage.cameras).forEach((camera) => {
            const path = String((camera && camera.primPath) || '');
            if (path) addItem('cameras', 'camera:' + path, path, String(camera.name || sceneTreeLeafName(path)), 'camera');
        });
        // Lights: the environment first, which is the stage's first dome light when it has one
        // (the one the renderer applies), then every other light in stage order.
        const lights = list(stage && stage.lights);
        const dome = lights.find((light) => String((light && light.type) || '').toLowerCase() === 'domelight');
        const domePath = dome ? String(dome.primPath || '') : '';
        const environment = addItem('lights', SCENE_TREE_ENVIRONMENT_ID, domePath, dome ? String(dome.name || sceneTreeLeafName(domePath)) : 'Environment', 'light');
        environment.isEnvironment = true;
        environment.lightType = dome ? String(dome.type || '') : '';
        lights.forEach((light) => {
            const path = String((light && light.primPath) || '');
            const node = light !== dome && path ? addItem('lights', 'light:' + path, path, String(light.name || sceneTreeLeafName(path)), 'light') : null;
            if (node) node.lightType = String(light.type || '');
        });
        // Post-order mesh counts: a row shows an eye only when it can hide something.
        const order = [];
        const stack = [groups.scene];
        while (stack.length) { const node = stack.pop(); order.push(node); node.children.forEach((child) => stack.push(child)); }
        for (let i = order.length - 1; i >= 0; i--) {
            const node = order[i];
            node.meshCount = node.renderPaths.length + node.children.reduce((sum, child) => sum + child.meshCount, 0);
        }
        groups.scene.count = byPath.size;
        groups.materials.count = groups.materials.children.length;
        groups.cameras.count = groups.cameras.children.length;
        groups.lights.count = groups.lights.children.length;
        return {
            roots, groups, byId, byPath, byRenderPath, meshesByMaterial,
            count: byPath.size, materialCount: groups.materials.count, cameraCount: groups.cameras.count, lightCount: groups.lights.count,
        };
    };
    // Stage lights the renderer converts (every light but the environment and dome lights).
    const sceneTreeLightHideable = (node) => !!node && node.kind === 'light' && !node.isEnvironment && !/^dome/i.test(node.lightType);
    const sceneTreeLightPaths = (tree) => (tree ? tree.groups.lights.children.filter(sceneTreeLightHideable).map((node) => node.path) : []);
    // Every renderer prim path at or under a node (a material row: the meshes it is bound to).
    const sceneTreeRenderPaths = (tree, node) => {
        if (!tree || !node) return [];
        if (node.kind === 'material') return (tree.meshesByMaterial.get(node.path) || []).slice();
        if (node.group !== 'scene') return [];
        const out = [];
        const stack = [node];
        while (stack.length) {
            const current = stack.pop();
            current.renderPaths.forEach((path) => out.push(path));
            current.children.forEach((child) => stack.push(child));
        }
        return out;
    };
    const sceneTreeHiddenRenderPaths = (tree, hidden) => {
        const out = new Set();
        (hidden || new Set()).forEach((id) => {
            const node = tree && tree.byId.get(id);
            if (node && node.group === 'scene') sceneTreeRenderPaths(tree, node).forEach((p) => out.add(p));
        });
        return Array.from(out);
    };
    const sceneTreeHiddenBy = (node, hidden) => {
        for (let current = node; current; current = current.parent) if (hidden.has(current.id)) return current;
        return null;
    };
    // Visible rows in display order. A filter keeps matches, their ancestors (forced
    // open, a group header only when something under it matches) and the descendants
    // of matches the user expanded. A group key other than 'all' shows only that group.
    const flattenSceneTree = (tree, expanded, filter, group) => {
        const rows = [];
        if (!tree) return rows;
        const query = String(filter || '').trim().toLowerCase();
        let matches = null;
        let forced = null;
        if (query) {
            matches = new Set();
            forced = new Set();
            tree.byId.forEach((node) => {
                if (node.isGroup || node.name.toLowerCase().indexOf(query) < 0) return;
                matches.add(node);
                for (let parent = node.parent; parent && !forced.has(parent); parent = parent.parent) forced.add(parent);
            });
        }
        const visit = (nodes, insideMatch) => {
            nodes.forEach((node) => {
                const matched = !!matches && matches.has(node);
                if (matches && !matched && !insideMatch && !forced.has(node)) return;
                rows.push(node);
                const open = (forced && forced.has(node)) || expanded.has(node.id) || (pinned && node.isGroup && !node.parent);
                if (open && node.children.length) visit(node.children, insideMatch || matched);
            });
        };
        const pinned = !!group && group !== 'all';
        visit(pinned ? tree.roots.filter((root) => root.group === group) : tree.roots, false);
        return rows;
    };
    // The four groups start open. Small scenes open fully; larger ones open their roots
    // and single-child chains.
    const defaultSceneTreeExpanded = (tree) => {
        const open = new Set();
        if (!tree) return open;
        tree.roots.forEach((group) => open.add(group.id));
        if (tree.count <= 64) {
            tree.byPath.forEach((node) => { if (node.children.length) open.add(node.id); });
            return open;
        }
        const follow = (node) => {
            if (!node.children.length) return;
            open.add(node.id);
            if (node.children.length === 1) follow(node.children[0]);
        };
        tree.groups.scene.children.forEach(follow);
        return open;
    };
    // Row tooltip: the name path without the leading slash and a generic type, no USD terms.
    const SCENE_TREE_TYPE_LABELS = { xform: 'Group', mesh: 'Mesh', material: 'Material', light: 'Light', camera: 'Camera' };
    const SCENE_TREE_GROUP_TITLES = {
        scene: 'Every object in the scene', materials: 'Every material in the scene',
        cameras: 'Click a camera to look through it', lights: 'Every light in the scene',
    };
    const SCENE_TREE_LIGHT_TYPES = { distant: 'Distant', sphere: 'Sphere', rect: 'Rectangle', disk: 'Disk', cylinder: 'Cylinder', dome: 'Dome', portal: 'Portal', geometry: 'Geometry' };
    const sceneTreeLightTypeLabel = (type) => {
        const raw = String(type || '');
        return SCENE_TREE_LIGHT_TYPES[raw.toLowerCase().replace(/light(_\d+)?$/, '')] || raw;
    };
    const sceneTreeRowTitle = (node) => {
        if (node && node.isGroup) return SCENE_TREE_GROUP_TITLES[node.group] || node.name;
        if (node && node.isDefaultCamera) return 'Frame the whole scene';
        const path = sceneTreeSegments(node && node.path).join('/');
        if (node && node.isEnvironment) return path ? path + ' (Environment, dome light)' : 'The environment map lighting the scene';
        if (node && node.kind === 'light') {
            const type = sceneTreeLightTypeLabel(node.lightType);
            const title = path + ' (Light' + (type ? ': ' + type : '') + ')';
            return /^dome/i.test(node.lightType) ? title + '\nNot applied: only the first dome light lights the scene' : title;
        }
        return path + ' (' + (SCENE_TREE_TYPE_LABELS[node && node.kind] || 'Object') + ')';
    };
    window.usdSceneTree = { buildSceneTree, sceneTreeRenderPaths, sceneTreeHiddenRenderPaths, flattenSceneTree, defaultSceneTreeExpanded, sceneTreeRowTitle, sceneTreeLightPaths };

    const MATERIAL_PREVIEW_RECT_KEY = 'mtlx_scene_material_preview_rect';
    const MATERIAL_PREVIEW_DEFAULT_SIZE = { width: 640, height: 420 };
    const MATERIAL_PREVIEW_MIN_SIZE = { width: 320, height: 220 };
    // Click offset and HUD-row clearance for a fresh open. 44px clears the
    // top-2 (8px) HUD row of h-7 (28px) pills plus a small margin.
    const MATERIAL_PREVIEW_CLICK_OFFSET = 12;
    const MATERIAL_PREVIEW_TOP_INSET = 44;
    const readStoredMaterialPreviewRect = () => {
        try {
            const raw = localStorage.getItem(MATERIAL_PREVIEW_RECT_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            // Malformed/missing fields are genuinely unusable and stay
            // discarded (next open falls back to the default size at the
            // click); an undersized width/height (a stale value, or one
            // clamped down by a small container) is clamped back up to the
            // floor instead, rather than accepted as-is or dropped outright.
            if (parsed && [parsed.x, parsed.y, parsed.width, parsed.height].every(Number.isFinite)) {
                return {
                    x: parsed.x, y: parsed.y,
                    width: Math.max(MATERIAL_PREVIEW_MIN_SIZE.width, parsed.width),
                    height: Math.max(MATERIAL_PREVIEW_MIN_SIZE.height, parsed.height),
                };
            }
        } catch (e) { /* storage unavailable or corrupt */ }
        return null;
    };

    // Trivial document the panel loads while still hidden, so the embed
    // iframe boots its MaterialX runtime, environment and render view
    // before the first double-click instead of during it.
    const MATERIAL_PREVIEW_WARM_XML = [
        '<?xml version="1.0"?>',
        '<materialx version="1.38">',
        '  <standard_surface name="warm_surface" type="surfaceshader" />',
        '  <surfacematerial name="warm_material" type="material">',
        '    <input name="surfaceshader" type="surfaceshader" nodename="warm_surface" />',
        '  </surfacematerial>',
        '</materialx>',
    ].join('\n');
    const MATERIAL_PREVIEW_WARM_PAYLOAD = { xml: MATERIAL_PREVIEW_WARM_XML, name: 'preview-warmup', materialName: '', primPath: '', files: null, warm: true };

    // Floating graph + shaderball preview for the material under a
    // double-click in the viewport. Stays mounted (CSS-hidden) after first
    // open so the graph-preview/materialx-viewer instances survive reopens.
    // `warm` mounts it hidden with the warm-up document ahead of any open.
    function MaterialPreviewPanel({ open, payload, anchor, onClose, containerRef, panelRef, sceneFiles, warm, sceneFileName }) {
        const shownRef = React.useRef(null);
        if (payload) shownRef.current = payload;
        if (!shownRef.current && warm) shownRef.current = MATERIAL_PREVIEW_WARM_PAYLOAD;
        const shown = shownRef.current;
        const [rect, setRect] = React.useState(() => readStoredMaterialPreviewRect());
        const rectRef = React.useRef(rect);
        rectRef.current = rect;
        const bodyRef = React.useRef(null);
        const dragRef = React.useRef(null);
        const resizeRef = React.useRef(null);
        const [bodyHeight, setBodyHeight] = React.useState(0);
        const [depsReady, setDepsReady] = React.useState(!!window.MtlxGraphPreview);
        const [depsError, setDepsError] = React.useState('');

        useEscapeToClose(onClose, open);

        // Clamp a restored rect against the current container once mounted.
        React.useEffect(() => {
            if (!containerRef.current) return;
            const bounds = containerRef.current.getBoundingClientRect();
            setRect((prev) => (prev ? clampPanelRect(prev, bounds, MATERIAL_PREVIEW_TOP_INSET, MATERIAL_PREVIEW_MIN_SIZE) : prev));
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        // A viewport double-click (an anchor) always places the top-left at the
        // click, keeping the remembered size (else 640x420); an open with no
        // anchor (tree row, Enter) keeps the remembered rect, else centres.
        // Clamped below the HUD row; a layout effect, so no misplaced frame.
        React.useLayoutEffect(() => {
            if (!open || !containerRef.current) return;
            const bounds = containerRef.current.getBoundingClientRect();
            const remembered = rectRef.current;
            const width = remembered ? remembered.width : MATERIAL_PREVIEW_DEFAULT_SIZE.width;
            const height = remembered ? remembered.height : MATERIAL_PREVIEW_DEFAULT_SIZE.height;
            const base = anchor
                ? { x: anchor.x + MATERIAL_PREVIEW_CLICK_OFFSET, y: anchor.y + MATERIAL_PREVIEW_CLICK_OFFSET, width, height }
                : (remembered || { x: (bounds.width - width) / 2, y: (bounds.height - height) / 2, width, height });
            setRect(clampPanelRect(base, bounds, MATERIAL_PREVIEW_TOP_INSET, MATERIAL_PREVIEW_MIN_SIZE));
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [open, anchor]);

        // The container's own ResizeObserver (below) covers layout-driven
        // resizes; a window resize (e.g. leaving fullscreen) can change the
        // viewport without necessarily firing that observer first.
        React.useEffect(() => {
            if (!open) return undefined;
            const onWindowResize = () => {
                if (!containerRef.current) return;
                const bounds = containerRef.current.getBoundingClientRect();
                setRect((prev) => (prev ? clampPanelRect(prev, bounds, MATERIAL_PREVIEW_TOP_INSET, MATERIAL_PREVIEW_MIN_SIZE) : prev));
            };
            window.addEventListener('resize', onWindowResize);
            return () => window.removeEventListener('resize', onWindowResize);
        }, [open]);

        React.useEffect(() => {
            if (!rect) return;
            try { localStorage.setItem(MATERIAL_PREVIEW_RECT_KEY, JSON.stringify(rect)); } catch (e) { /* storage unavailable */ }
        }, [rect]);

        // Keyed on depsReady, not window.MtlxGraphPreview: a load that finished
        // while the panel was closed must still flip it on reopen (memoized, so
        // cheap). Warm-up loads too; a rejection shows its reason, the next open retries.
        React.useEffect(() => {
            if (!(open || warm) || depsReady) return undefined;
            let cancelled = false;
            window.mtlxLoadViewDeps('galleryDetail').then(() => {
                if (!cancelled) { setDepsError(''); setDepsReady(true); }
            }, (e) => {
                console.error('[usd-scene] material preview dependencies failed to load', e);
                if (!cancelled) setDepsError(String((e && e.message) || e));
            });
            return () => { cancelled = true; };
        }, [open, warm, depsReady]);

        // Deps on !!shown, not []: the body div does not exist in the DOM
        // until the panel opens for the first time (shown is still null on
        // the very first mount, so a one-shot effect would see no element
        // and never attach), so this must re-run once shown flips truthy.
        React.useEffect(() => {
            if (!bodyRef.current || !window.ResizeObserver) return undefined;
            const observer = new ResizeObserver((entries) => {
                const entry = entries[0];
                if (entry) setBodyHeight(Math.round(entry.contentRect.height));
            });
            observer.observe(bodyRef.current);
            return () => observer.disconnect();
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [!!shown]);

        const beginDrag = (dragTargetRef) => (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            // A pointerdown that started on a button (Close, Open in Graph
            // Editor) must not capture the pointer: capture redirects the
            // matching mouseup, which silently swallows the button's click.
            if (e.target && e.target.closest && e.target.closest('button')) return;
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* unsupported */ }
            dragTargetRef.current = { startX: e.clientX, startY: e.clientY, rect: rectRef.current };
        };
        const endDrag = (dragTargetRef) => (e) => {
            dragTargetRef.current = null;
            try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* unsupported */ }
        };
        const onHeaderMove = (e) => {
            const drag = dragRef.current;
            if (!drag || !containerRef.current) return;
            const bounds = containerRef.current.getBoundingClientRect();
            const next = clampPanelRect({
                x: drag.rect.x + (e.clientX - drag.startX),
                y: drag.rect.y + (e.clientY - drag.startY),
                width: drag.rect.width, height: drag.rect.height,
            }, bounds, MATERIAL_PREVIEW_TOP_INSET, MATERIAL_PREVIEW_MIN_SIZE);
            setRect(next);
        };
        const onResizeMove = (e) => {
            const drag = resizeRef.current;
            if (!drag || !containerRef.current) return;
            const bounds = containerRef.current.getBoundingClientRect();
            const next = clampPanelRect({
                x: drag.rect.x, y: drag.rect.y,
                width: Math.max(MATERIAL_PREVIEW_MIN_SIZE.width, drag.rect.width + (e.clientX - drag.startX)),
                height: Math.max(MATERIAL_PREVIEW_MIN_SIZE.height, drag.rect.height + (e.clientY - drag.startY)),
            }, bounds, MATERIAL_PREVIEW_TOP_INSET, MATERIAL_PREVIEW_MIN_SIZE);
            setRect(next);
        };

        // Only what this material's document references: the scene's whole
        // loose map would push the source .glb/.usdz through the embed's
        // postMessage and into the viewer's file map for nothing. Memoized
        // because a new identity reloads GraphPreviewViewer's document.
        const handoffFiles = React.useMemo(
            () => materialPreviewFiles(shown && shown.files, shown && shown.xml, sceneFiles),
            [shown, sceneFiles]);

        if (!shown) return null; // never opened yet this session

        const openInEditor = () => {
            // window.openInGraphEditor (js/shared/mtlx-ui.jsx) builds its own
            // payload object and does not forward a materialName field, so
            // the Graph Editor's __inline_/__usdshade_/__usdpreview_ name
            // mapping never gets a value from a scene handoff. Build the same
            // window.__mtlxPendingImport + 'mtlx-load-document' contract it
            // uses, with materialName (the material's own name, the leaf of
            // its prim path) always included.
            if (fullscreenElement()) toggleFullscreen();
            const primSegments = sceneTreeSegments(shown.primPath);
            const materialName = shown.materialName || (primSegments.length ? primSegments[primSegments.length - 1] : null);
            window.__mtlxPendingImport = {
                xml: shown.xml, name: shown.name, files: handoffFiles || null,
                select: materialName, implOf: null, materialName,
                readOnly: true, readOnlySource: sceneFileName || 'the scene',
            };
            window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: window.__mtlxPendingImport }));
            window.location.hash = '#!graph';
        };
        const rectStyle = rect
            ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
            : { left: 0, top: 0, width: MATERIAL_PREVIEW_DEFAULT_SIZE.width, height: MATERIAL_PREVIEW_DEFAULT_SIZE.height };

        return (
            <div
                ref={panelRef}
                data-testid="usd-scene-material-preview"
                className={'absolute z-40 flex flex-col backdrop-blur border border-line-strong rounded-lg shadow-2xl overflow-hidden' + (open ? '' : ' hidden')}
                style={Object.assign({ backgroundColor: HUD_POPOVER_BG }, rectStyle)}
                aria-hidden={!open}
            >
                <div
                    className="flex-none flex items-center justify-between gap-2 px-3 py-2 border-b border-line bg-chrome/70 cursor-move touch-none"
                    onPointerDown={beginDrag(dragRef)}
                    onPointerMove={onHeaderMove}
                    onPointerUp={endDrag(dragRef)}
                >
                    <div className="min-w-0 flex flex-col">
                        <span className="text-[11px] text-fg-muted truncate max-w-[16rem]">{shown.primPath || ''}</span>
                        <span className="text-sm font-semibold text-fg truncate max-w-[16rem]">{shown.materialName || shown.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        <button type="button" onClick={openInEditor} className={HUD_PILL}>
                            <MtlxIcon name="external-link" className="w-3.5 h-3.5" /> Open in Graph Editor
                        </button>
                        <button type="button" onClick={onClose} className={HUD_PILL} aria-label="Close">
                            <MtlxIcon name="x" className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
                <div ref={bodyRef} className="relative flex-1 min-h-0">
                    {!depsReady ? (depsError ? (
                        <div role="alert" data-testid="usd-scene-material-preview-error" className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center">
                            <span className="text-sm text-error-text">The node graph preview could not be loaded.</span>
                            <span className="text-[11px] text-fg-muted break-all">{depsError}</span>
                        </div>
                    ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-fg-muted text-sm animate-pulse">Loading preview</div>
                    )) : (
                        <window.MtlxGraphPreview
                            xml={shown.xml}
                            preview={IN_VSCODE ? false : 'right'}
                            previewTextures={handoffFiles}
                            previewName={shown.name}
                            previewExpanded
                            previewResizable
                            previewSplitStorageKey="mtlx_scene_material_preview_split"
                            lazy={false}
                            controls={['zoom']}
                            autoFocus="fit"
                            chrome="card"
                            flush
                            height={bodyHeight || (MATERIAL_PREVIEW_DEFAULT_SIZE.height - 60)}
                        />
                    )}
                </div>
                <div
                    data-testid="usd-scene-material-preview-resize"
                    className="absolute bottom-0 right-0 w-4 h-4 z-20 cursor-nwse-resize touch-none"
                    onPointerDown={beginDrag(resizeRef)}
                    onPointerMove={onResizeMove}
                    onPointerUp={endDrag(resizeRef)}
                />
            </div>
        );
    }

    // Outliner rows: fixed height so only the rows in view (plus overscan) mount,
    // which keeps scenes with thousands of objects responsive. The box fills the
    // Hierarchy section, never shorter than SCENE_TREE_MIN_H.
    const SCENE_TREE_ROW_H = 22;
    const SCENE_TREE_MIN_H = 200;
    const SCENE_TREE_INDENT = 12;
    const SCENE_TREE_OVERSCAN = 8;
    const SCENE_TREE_ICONS = { mesh: 'cube', xform: 'focus-2', material: 'palette', light: 'bolt', camera: 'camera' };
    const SCENE_TREE_GROUP_ICONS = { scene: 'world', materials: 'palette', cameras: 'camera', lights: 'sun' };
    const SCENE_LIGHTS_OFF_TITLE = 'Scene lights are turned off in the render settings';
    // Eye state of a row, or null when it has nothing to hide: objects and the Scene group
    // hide meshes, light rows and the Lights group turn stage lights off, the environment
    // row turns the environment's lighting off.
    const sceneTreeEye = (node, state) => {
        if (node.group === 'scene') {
            if (!(node.meshCount > 0)) return null;
            const own = state.hidden.has(node.id);
            const by = own ? node : sceneTreeHiddenBy(node, state.hidden);
            const noun = node.isGroup ? 'every object' : 'object';
            return { own, by, title: own ? 'Show ' + noun : (by ? 'Hidden by ' + by.name : 'Hide ' + noun) };
        }
        if (node.isGroup && node.group === 'lights') {
            const paths = node.children.filter(sceneTreeLightHideable).map((child) => child.path);
            if (!paths.length) return null;
            const own = paths.every((path) => state.hiddenLights.has(path));
            return { own, by: own ? node : null, title: own ? 'Turn every light on' : 'Turn every light off' };
        }
        if (node.isEnvironment) {
            if (!state.envEyeAvailable) return null;
            const own = !!state.envLightingOff;
            return { own, by: own ? node : null, title: own ? 'Turn the environment lighting on' : 'Turn the environment lighting off' };
        }
        if (sceneTreeLightHideable(node)) {
            const own = state.hiddenLights.has(node.path);
            return { own, by: own ? node : null, title: own ? 'Turn light on' : 'Turn light off' };
        }
        return null;
    };
    function SceneTree({ rows, expanded, selectedId, hidden, hiddenLights, lightsOff, envLightingOff, envEyeAvailable, activeCamera, revealToken, onToggleExpand, onSelect, onRowClick, onToggleHidden, onActivate }) {
        const scrollRef = React.useRef(null);
        const [scrollTop, setScrollTop] = React.useState(0);
        // The rendered window follows the box's measured height, which the flex layout sets.
        const [viewHeight, setViewHeight] = React.useState(SCENE_TREE_MIN_H);
        React.useLayoutEffect(() => {
            const el = scrollRef.current;
            if (!el) return undefined;
            const measure = () => setViewHeight(Math.max(SCENE_TREE_ROW_H, el.clientHeight));
            measure();
            if (typeof ResizeObserver !== 'function') return undefined;
            const observer = new ResizeObserver(measure);
            observer.observe(el);
            return () => observer.disconnect();
        }, []);
        const first = Math.max(0, Math.floor(scrollTop / SCENE_TREE_ROW_H) - SCENE_TREE_OVERSCAN);
        const last = Math.min(rows.length, Math.ceil((scrollTop + viewHeight) / SCENE_TREE_ROW_H) + SCENE_TREE_OVERSCAN);
        const selectedIndex = selectedId ? rows.findIndex((node) => node.id === selectedId) : -1;
        const eyeState = { hidden, hiddenLights, envLightingOff, envEyeAvailable };
        // Scrolls the selection into view when it moved from the viewport or the keyboard.
        React.useEffect(() => {
            const el = scrollRef.current;
            if (!el || selectedIndex < 0) return;
            const top = selectedIndex * SCENE_TREE_ROW_H;
            if (top < el.scrollTop) el.scrollTop = top;
            else if (top + SCENE_TREE_ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + SCENE_TREE_ROW_H - el.clientHeight;
            setScrollTop(el.scrollTop);
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [revealToken]);
        const onKeyDown = (e) => {
            if (!rows.length) return;
            const current = selectedIndex >= 0 ? rows[selectedIndex] : null;
            const go = (index) => { const node = rows[Math.max(0, Math.min(rows.length - 1, index))]; if (node) onSelect(node.id, true); };
            if (e.key === 'ArrowDown') go(selectedIndex + 1);
            else if (e.key === 'ArrowUp') go(selectedIndex < 0 ? rows.length - 1 : selectedIndex - 1);
            else if (e.key === 'Home') go(0);
            else if (e.key === 'End') go(rows.length - 1);
            else if (e.key === 'ArrowRight' && current) {
                if (current.children.length && !expanded.has(current.id)) onToggleExpand(current.id);
                else if (current.children.length) go(selectedIndex + 1);
            } else if (e.key === 'ArrowLeft' && current) {
                if (current.children.length && expanded.has(current.id)) onToggleExpand(current.id);
                else if (current.parent) onSelect(current.parent.id, true);
            } else if (e.key === 'Enter' && current) onActivate(current);
            else return; // Escape goes to the page handler, which lets open panels close first
            e.preventDefault();
            e.stopPropagation();
        };
        const renderEye = (node, eye, selected) => (
            <button
                type="button"
                tabIndex={-1}
                data-testid="usd-scene-tree-eye"
                aria-pressed={eye.own}
                aria-label={eye.title}
                title={eye.title}
                onClick={(e) => { e.stopPropagation(); onToggleHidden(node); }}
                onDoubleClick={(e) => e.stopPropagation()}
                className={'w-5 h-4 shrink-0 inline-flex items-center justify-center rounded '
                    + (selected ? 'text-on-accent-muted hover:text-on-accent' : (eye.own ? 'text-fg-muted hover:text-fg-soft' : 'text-fg-subtle hover:text-fg-soft'))
                    + (eye.by && !eye.own ? ' opacity-40' : '')}
            >
                <MtlxIcon name={eye.own ? 'eye-off' : 'eye'} className="w-3.5 h-3.5" />
            </button>
        );
        const renderChevron = (node, open, selected) => (node.children.length ? (
            <button
                type="button"
                tabIndex={-1}
                aria-label={open ? 'Collapse' : 'Expand'}
                data-testid="usd-scene-tree-toggle"
                onClick={(e) => { e.stopPropagation(); onToggleExpand(node.id); }}
                onDoubleClick={(e) => e.stopPropagation()}
                className={'w-3.5 h-3.5 shrink-0 inline-flex items-center justify-center rounded ' + (selected ? 'text-on-accent-muted' : 'text-fg-subtle hover:text-fg-soft')}
            >
                <MtlxIcon name={open ? 'chevron-down' : 'chevron-right'} className="w-3 h-3" />
            </button>
        ) : <span className="w-3.5 shrink-0" />);
        return (
            <div
                ref={scrollRef}
                role="tree"
                aria-label="Scene hierarchy"
                tabIndex={0}
                data-testid="usd-scene-tree"
                onKeyDown={onKeyDown}
                onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
                className="relative overflow-y-auto custom-scrollbar rounded-md border border-line bg-surface-sunken/60 focus:outline-none focus-visible:border-focus"
                style={{ flex: '1 1 0px', minHeight: SCENE_TREE_MIN_H }}
            >
                <div style={{ height: rows.length * SCENE_TREE_ROW_H, position: 'relative' }}>
                    {rows.slice(first, last).map((node, offset) => {
                        const index = first + offset;
                        const selected = index === selectedIndex;
                        const open = expanded.has(node.id);
                        const eye = sceneTreeEye(node, eyeState);
                        const rowStyle = { top: index * SCENE_TREE_ROW_H, height: SCENE_TREE_ROW_H, paddingLeft: 6 + node.depth * SCENE_TREE_INDENT };
                        if (node.isGroup) {
                            return (
                                <div
                                    key={node.id}
                                    role="treeitem"
                                    aria-level={1}
                                    aria-selected={selected}
                                    aria-expanded={node.children.length ? open : undefined}
                                    data-testid={'usd-scene-tree-group-' + node.group}
                                    data-id={node.id}
                                    data-hidden={eye && eye.own ? 'true' : 'false'}
                                    title={sceneTreeRowTitle(node)}
                                    onClick={() => onRowClick(node)}
                                    className={'absolute left-0 right-0 flex items-center gap-1 pr-1 text-[11px] font-semibold cursor-default select-none '
                                        + (selected ? 'bg-accent-fill text-on-accent' : 'bg-surface-raised/50 text-fg-soft hover:bg-hover/60')}
                                    style={rowStyle}
                                >
                                    {renderChevron(node, open, selected)}
                                    <MtlxIcon name={SCENE_TREE_GROUP_ICONS[node.group] || 'list-details'}
                                        className={'w-3.5 h-3.5 shrink-0 ' + (selected ? 'text-on-accent-muted' : 'text-fg-muted')} />
                                    <span className="flex-1 min-w-0 truncate">{node.name}</span>
                                    <span data-testid="usd-scene-tree-group-count"
                                        className={'shrink-0 px-1 font-mono font-normal tabular-nums text-[10px] ' + (selected ? 'text-on-accent-muted' : 'text-fg-subtle')}>
                                        {node.count.toLocaleString()}
                                    </span>
                                    {eye ? renderEye(node, eye, selected) : <span className="w-5 shrink-0" />}
                                </div>
                            );
                        }
                        const isStageLight = sceneTreeLightHideable(node);
                        const dimmedByOff = isStageLight && lightsOff;
                        const hiddenBy = eye ? eye.by : null;
                        const activeCam = node.kind === 'camera' && activeCamera === (node.isDefaultCamera ? 'default' : node.path);
                        const title = dimmedByOff ? sceneTreeRowTitle(node) + '\n' + SCENE_LIGHTS_OFF_TITLE
                            : (activeCam ? sceneTreeRowTitle(node) + '\nActive camera' : sceneTreeRowTitle(node));
                        return (
                            <div
                                key={node.id}
                                role="treeitem"
                                aria-level={node.depth + 1}
                                aria-selected={selected}
                                aria-expanded={node.children.length ? open : undefined}
                                data-testid="usd-scene-tree-row"
                                data-id={node.id}
                                data-path={node.path}
                                data-kind={node.kind}
                                data-group={node.group}
                                data-hidden={hiddenBy ? 'true' : 'false'}
                                data-has-material={node.materialPath ? 'true' : 'false'}
                                data-active={node.kind === 'camera' ? (activeCam ? 'true' : 'false') : undefined}
                                data-environment={node.isEnvironment ? 'true' : undefined}
                                data-default-camera={node.isDefaultCamera ? 'true' : undefined}
                                data-lights-off={dimmedByOff ? 'true' : undefined}
                                title={title}
                                onClick={() => onRowClick(node)}
                                onDoubleClick={() => onActivate(node)}
                                className={'absolute left-0 right-0 flex items-center gap-1 pr-1 text-[11px] cursor-default select-none '
                                    + (selected ? 'bg-accent-fill text-on-accent' : (hiddenBy ? 'text-fg-subtle hover:bg-hover-subtle' : 'text-fg-secondary hover:bg-hover-subtle'))
                                    + (dimmedByOff && !selected ? ' opacity-50' : '')}
                                style={rowStyle}
                            >
                                {Array.from({ length: node.depth }, (_, level) => (
                                    <span key={level} aria-hidden="true"
                                        className={'absolute top-0 bottom-0 w-px ' + (selected ? 'bg-on-accent-muted/40' : 'bg-line/80')}
                                        style={{ left: 6 + level * SCENE_TREE_INDENT + 6 }} />
                                ))}
                                {renderChevron(node, open, selected)}
                                <MtlxIcon name={node.isEnvironment ? 'sun' : (node.isDefaultCamera ? 'camera-reset' : (SCENE_TREE_ICONS[node.kind] || 'cube'))}
                                    className={'w-3.5 h-3.5 shrink-0 ' + (selected ? 'text-on-accent-muted' : (activeCam ? 'text-accent-fg' : 'text-fg-subtle'))} />
                                <span className={'flex-1 min-w-0 truncate ' + (node.group === 'scene' || node.kind === 'material' ? 'font-mono' : '')
                                    + (activeCam && !selected ? ' text-accent-fg-strong' : '')}>{node.name}</span>
                                {activeCam ? (
                                    <span data-testid="usd-scene-tree-active-camera" className={'shrink-0 mr-1 inline-flex ' + (selected ? 'text-on-accent' : 'text-accent-fg')}>
                                        <MtlxIcon name="check" className="w-3.5 h-3.5" />
                                    </span>
                                ) : null}
                                {eye ? renderEye(node, eye, selected) : null}
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    }

    // Light info popover: plain labels with the raw attribute dimmed below, units where known.
    const SCENE_UNIT_SHORT = [[1, 'm'], [0.1, 'dm'], [0.01, 'cm'], [0.001, 'mm'], [1000, 'km'], [0.0254, 'in'], [0.3048, 'ft']];
    const sceneUnitShort = (metersPerUnit) => {
        const value = Number(metersPerUnit);
        const named = value > 0 ? SCENE_UNIT_SHORT.find(([meters]) => Math.abs(meters - value) <= meters * 1e-6) : null;
        return named ? named[1] : 'units';
    };
    const lightNumber = (value, digits = 3) => {
        const n = Number(value);
        return Number.isFinite(n) ? String(Math.round(n * Math.pow(10, digits)) / Math.pow(10, digits)) : '';
    };
    const lightTriple = (values, digits = 3) => (Array.isArray(values) ? values.slice(0, 3).map((v) => lightNumber(v, digits)).join(', ') : '');
    // A linear colour as an sRGB swatch, scaled down when brighter than 1.
    const lightSwatch = (rgb) => {
        if (!Array.isArray(rgb) || rgb.length < 3) return 'transparent';
        const peak = Math.max(1, ...rgb.slice(0, 3).map((v) => Number(v) || 0));
        const encode = (v) => Math.round(255 * Math.pow(Math.max(0, Math.min(1, (Number(v) || 0) / peak)), 1 / 2.2));
        return 'rgb(' + rgb.slice(0, 3).map(encode).join(', ') + ')';
    };
    const LightInfoRow = ({ label, raw, testId, children }) => (
        <div className="flex items-start justify-between gap-3 min-w-0 py-0.5">
            <span className="shrink-0 flex flex-col">
                <span className="text-[11px] text-fg-muted">{label}</span>
                {raw ? <span className="text-[10px] font-mono text-fg-faint">{raw}</span> : null}
            </span>
            <span data-testid={testId} className="min-w-0 text-right text-[11px] font-mono tabular-nums text-fg-soft break-words">{children}</span>
        </div>
    );
    const LightInfoColor = ({ rgb }) => (
        <React.Fragment>
            <span aria-hidden="true" className="inline-block w-3 h-3 mr-1.5 rounded-sm border border-line-heavy align-[-2px]" style={{ background: lightSwatch(rgb) }} />
            {lightTriple(rgb)}
        </React.Fragment>
    );

    // Kept as one array so the list is easy to edit without touching the
    // popover markup below.
    const SCENE_KNOWN_ISSUES = [
        'A malformed object in a USD file can crash the USD runtime.',
        'UsdPreviewSurface is only flattened to basic constants and textures, not converted to MaterialX.',
        'Reloading scenes many times in one session has hung twice.',
    ];
    const KNOWN_ISSUES_POPOVER_W = 260;

    // Named "quality" throughout, never "preset" alone: MTLX_PRESETS and
    // MtlxPresetPicker already mean material presets app-wide. Levels and
    // defaults come from the manifest (js/shared/render-settings.js, stage
    // profile); nothing here keeps its own copy.
    const sceneStageRow = (key) => window.MtlxRenderSettings.ROWS.find((entry) => entry.key === key);
    const sceneLevelValue = (key, level) => {
        const levels = sceneStageRow(key).profiles.stage.levels;
        return levels[level] !== undefined ? levels[level] : levels.default;
    };
    const sceneStored = (key) => window.MtlxRenderSettings.get(key, { profile: 'stage' });
    const sceneWrite = (key, value) => window.MtlxRenderSettings.set(key, value, { surface: 'scene' });
    const scenePresentationAt = (level) => ({
        enabled: sceneLevelValue('hdrPresentation', level), bloom: sceneLevelValue('bloom', level), strength: sceneLevelValue('bloomStrength', level),
        threshold: sceneLevelValue('bloomThreshold', level), knee: sceneLevelValue('bloomKnee', level), radius: sceneLevelValue('bloomRadius', level),
        antialias: sceneLevelValue('postAntialias', level), samples: sceneLevelValue('msaaSamples', level),
        debugView: sceneLevelValue('hdrView', level), supported: true,
    });
    // HDR presentation is app-owned state (debugView and supported are not stored).
    const SCENE_PRESENTATION_DEFAULT = scenePresentationAt('default');
    // Excluded on purpose: backdrop and env rotation (look, not cost);
    // heightToNormalTexel (engine-global, no Scene UI); MSAA and FXAA
    // (renderer-only test hooks, no row).
    const SCENE_GOVERNED_ROW_KEYS = [
        'textureMaxSize', 'textureBudgetGib', 'subdivision', 'shadows', 'ao', 'skyVis', 'transparency',
        'displacement', 'displacementSubdivision', 'triangleLimits', 'bounce', 'localReflections', 'specularAA',
    ];
    // Live keys carry the SAME value on every level: they stay instant,
    // never staged, so a level never fights an in-progress drag; only Reset
    // and the toolbar menu force them.
    const SCENE_LIVE_ROW_KEYS = [
        'displayTransform', 'materialWorkspace', 'displayExposure', 'stageLightsOn', 'stageLightsEv', 'aoStrength',
        'bounceStrength', 'skyVisStrength', 'localEnvStrength', 'ssrOn', 'ssrStrength', 'ssrMaxRoughness',
    ];
    const sceneLevelValues = (level) => {
        const values = {};
        SCENE_GOVERNED_ROW_KEYS.concat(SCENE_LIVE_ROW_KEYS).forEach((key) => { values[key] = sceneLevelValue(key, level); });
        values.presentation = scenePresentationAt(level);
        values.diffuseEnvConvolve = sceneLevelValue('diffuseEnv', level) === 'convolve';
        return values;
    };
    const LIVE_QUALITY_KEYS = SCENE_LIVE_ROW_KEYS.concat(['presentation', 'diffuseEnvConvolve']);
    const SCENE_QUALITY_LEVELS = [
        { id: 'performance', label: 'Performance', icon: 'bolt', title: 'Lowest settings, fastest loading and drawing' },
        { id: 'default', label: 'Default', icon: 'restore', title: 'Balanced quality and speed' },
        { id: 'quality', label: 'Quality', icon: 'sparkles', title: 'Highest settings, slowest loading and drawing' },
    ].map((level) => Object.assign(level, { values: sceneLevelValues(level.id) }));
    // Cost kinds come from the renderer's own key lists, so they cannot drift.
    const settingsCostKind = (key) => {
        if ((typeof SCENE_SETTINGS_RELOAD_KEYS !== 'undefined' ? SCENE_SETTINGS_RELOAD_KEYS : []).includes(key)) return 'reload';
        if ((typeof SCENE_SETTINGS_REBUILD_KEYS !== 'undefined' ? SCENE_SETTINGS_REBUILD_KEYS : []).includes(key)) return 'rebuild';
        if ((typeof SCENE_SETTINGS_GEOMETRY_KEYS !== 'undefined' ? SCENE_SETTINGS_GEOMETRY_KEYS : []).includes(key)) return 'geometry';
        return null;
    };
    // Rows whose quality-model key (levels, dirty dots) is not the row key.
    const SCENE_QUALITY_KEY_OF = { hdrPresentation: 'presentation', diffuseEnv: 'diffuseEnvConvolve' };
    const SCENE_PRESENTATION_FIELD_OF = {
        bloom: 'bloom', bloomStrength: 'strength', bloomThreshold: 'threshold', bloomKnee: 'knee', bloomRadius: 'radius', hdrView: 'debugView',
    };
    const QualitySegments = (props) => <HudQualitySegments levels={SCENE_QUALITY_LEVELS} testIdPrefix="usd-scene-quality" {...props} />;
    // Hierarchy type filter: the bottom row of the search box, no chrome of its own.
    const SCENE_TREE_GROUP_OPTIONS = [
        ['all', 'All', 'Show everything'],
        ['scene', 'Scene', 'Show only scene objects'],
        ['materials', 'Materials', 'Show only materials'],
        ['cameras', 'Cameras', 'Show only cameras'],
        ['lights', 'Lights', 'Show only lights'],
    ];
    const SceneTreeGroupSegments = ({ value, onChange }) => {
        return (
            <div role="group" aria-label="Show in hierarchy" data-testid="usd-scene-tree-group" className="flex w-full border-t border-line">
                {SCENE_TREE_GROUP_OPTIONS.map(([id, label, title], i) => {
                    const active = value === id;
                    return (
                        <button
                            key={id}
                            type="button"
                            data-testid={'usd-scene-tree-group-' + id}
                            data-active={active ? 'true' : undefined}
                            aria-pressed={active}
                            title={title}
                            onClick={() => onChange(id)}
                            className={'h-6 min-w-0 flex-1 px-1 flex items-center justify-center text-[11px] font-medium transition-colors '
                                + (i > 0 ? 'border-l border-line ' : '')
                                + (active ? 'bg-selection/20 text-accent-fg-strong' : 'bg-transparent text-fg-muted hover:bg-hover-subtle hover:text-fg-soft')}
                        >
                            <span className="truncate">{label}</span>
                        </button>
                    );
                })}
            </div>
        );
    };
    // Diagnostics popover over the Statistics footer: this wide, at most this
    // share of the window tall, clamped to the window.
    const DIAGNOSTICS_POPOVER_W = 440;
    const DIAGNOSTICS_POPOVER_MAX_VH = 0.6;
    const EXPORT_MATERIAL_OPTIONS = [
        { value: 'reference', label: 'USD + referenced .mtlx files' },
        { value: 'networks', label: 'MaterialX as UsdShade networks' },
    ];
    const EXPORT_FORMAT_OPTIONS = [
        { value: 'usda', label: 'USDA (text)' },
        { value: 'usdc', label: 'USDC (binary)' },
        { value: 'usdz', label: 'USDZ (package)' },
    ];
    const EXPORT_PHASE_TEXT = {
        prepare: 'Preparing materials and textures...',
        runtime: 'Starting the OpenUSD runtime...',
        write: 'Copying files into the runtime...',
        stage: 'Writing the USD stage...',
        readback: 'Reading back the result...',
        package: 'Packaging the download...',
    };
    // Export as USD dialog (glTF/OBJ/pbrt/Mitsuba scenes). Runs the OpenUSD worker's
    // ExportStage through MtlxSceneSources.exportUsdStage and downloads the result.
    function ExportUsdDialog({ open, onClose, stage, files, rootBasename }) {
        const [materialMode, setMaterialMode] = React.useState('reference');
        const [format, setFormat] = React.useState('usda');
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState('');
        const [note, setNote] = React.useState('');
        const [phase, setPhase] = React.useState('');
        const controllerRef = React.useRef(null);
        const mountedRef = React.useRef(true);
        React.useEffect(() => () => { mountedRef.current = false; if (controllerRef.current) controllerRef.current.abort(); }, []);
        useEscapeToClose(onClose, open && !busy);
        if (!open) return null;
        const pickMode = (value) => {
            setMaterialMode(value);
            if (value === 'reference' && format === 'usdz') setFormat('usda');
        };
        const run = async () => {
            const sources = window.MtlxSceneSources;
            if (!sources || typeof sources.exportUsdStage !== 'function') { setError('USD export is unavailable in this build.'); return; }
            const controller = new AbortController();
            controllerRef.current = controller;
            setBusy(true); setError(''); setNote(''); setPhase('');
            const onProgress = (value) => { if (mountedRef.current && controllerRef.current === controller) setPhase(value || ''); };
            try {
                const result = await sources.exportUsdStage(stage, { files, materialMode, format, signal: controller.signal, onProgress });
                if (!mountedRef.current) return;
                downloadBlob(result.blob, result.filename);
                // [info] lines (e.g. skipped viewer-only stand-in lights) are not warnings.
                const all = result.warnings || [];
                const count = all.filter((line) => !/^\[info\]/.test(String(line))).length;
                setNote('Exported ' + result.filename + (count ? ' (' + count + ' warning' + (count === 1 ? '' : 's') + ', see the console)' : ''));
                if (count) console.warn('USD export warnings:\n' + all.join('\n'));
                else if (all.length) console.info('USD export notes:\n' + all.join('\n'));
            } catch (e) {
                if (!mountedRef.current || controller.signal.aborted || (e && e.name === 'AbortError')) return;
                setError(String(e && e.message || e));
            } finally {
                if (controllerRef.current === controller) {
                    controllerRef.current = null;
                    if (mountedRef.current) { setBusy(false); setPhase(''); }
                }
            }
        };
        // Cancel settles the UI at once; the aborted export discards its worker.
        const close = () => {
            const controller = controllerRef.current;
            controllerRef.current = null;
            if (controller) { controller.abort(); setBusy(false); setPhase(''); }
            onClose();
        };
        return (
            <DialogFrame
                open={open}
                title="Export USD"
                onClose={close}
                panelClassName="bg-surface-raised border border-line-strong rounded-lg shadow-2xl w-[26rem] max-w-[90%] overflow-hidden flex flex-col"
            >
                <div data-testid="usd-scene-export-dialog" className="px-4 py-3 space-y-3 text-[12px]">
                    <div className="text-fg-muted truncate" title={rootBasename}>{rootBasename}</div>
                    <label className="flex items-center gap-3">
                        <span className={SCENE_ROW_LABEL + ' shrink-0 w-16'}>Materials</span>
                        <div className="flex-1 min-w-0">
                            <MtlxSelect value={materialMode} options={EXPORT_MATERIAL_OPTIONS} onChange={pickMode} defValue={null}
                                size="sm" variant="field" block disabled={busy} ariaLabel="Material export mode" />
                        </div>
                    </label>
                    <label className="flex items-center gap-3">
                        <span className={SCENE_ROW_LABEL + ' shrink-0 w-16'}>Format</span>
                        <div className="flex-1 min-w-0">
                            <MtlxSelect value={format} options={EXPORT_FORMAT_OPTIONS} onChange={setFormat} defValue={null}
                                size="sm" variant="field" block disabled={busy} ariaLabel="USD format"
                                disabledOptions={materialMode === 'reference' ? ['usdz'] : []}
                                titles={{ usdz: materialMode === 'reference' ? 'USDZ cannot contain .mtlx files' : 'Single-file package' }} />
                        </div>
                    </label>
                    {materialMode === 'reference' && (
                        <div className="text-[11px] text-fg-subtle">USDZ cannot contain .mtlx files</div>
                    )}
                    {busy && <div data-testid="usd-scene-export-progress" className="text-fg-muted animate-pulse">{EXPORT_PHASE_TEXT[phase] || 'Exporting...'}</div>}
                    {error && <div role="alert" data-testid="usd-scene-export-error" className="bg-error-bg/60 border border-error-border/60 text-error-text rounded px-3 py-2 break-words">{error}</div>}
                    {note && !error && <div data-testid="usd-scene-export-note" className="text-fg-muted break-words">{note}</div>}
                    <div className="flex items-center justify-end gap-1.5 pt-1">
                        <button type="button" onClick={close} className={BTN_SECONDARY}>{busy ? 'Cancel' : 'Close'}</button>
                        <button type="button" data-testid="usd-scene-export-run" onClick={run} disabled={busy} className={BTN_PRIMARY + ' disabled:opacity-50 disabled:cursor-not-allowed'}>Export</button>
                    </div>
                </div>
            </DialogFrame>
        );
    }
    // Slim viewport indicator for material/texture/geometry rebuilds after a
    // settings change (handle.onRebuildProgress). Shown after a short delay so
    // instant rebuilds never flash; DOM only, so captures never include it.
    const REBUILD_INDICATOR_DELAY_MS = 200;
    function SceneRebuildIndicator({ handle }) {
        const [view, setView] = React.useState(null);
        React.useEffect(() => {
            setView(null);
            if (!handle || typeof handle.onRebuildProgress !== 'function') return undefined;
            const live = new Map();
            let latest = '';
            let timer = 0;
            let shown = false;
            const sync = () => {
                if (!shown) return;
                const state = live.get(latest) || Array.from(live.values()).pop();
                setView(state ? { kind: state.kind, done: state.done, total: state.total, label: state.label } : null);
            };
            const off = handle.onRebuildProgress((event) => {
                if (!event || !event.kind) return;
                if (event.phase === 'end') live.delete(event.kind);
                else { live.set(event.kind, event); latest = event.kind; }
                if (!live.size) {
                    clearTimeout(timer); timer = 0; shown = false;
                    setView(null);
                    return;
                }
                if (!shown && !timer) timer = setTimeout(() => { timer = 0; shown = true; sync(); }, REBUILD_INDICATOR_DELAY_MS);
                sync();
            });
            return () => { off(); clearTimeout(timer); };
        }, [handle]);
        if (!view) return null;
        const determinate = view.total > 0;
        const fraction = determinate ? Math.max(0, Math.min(1, view.done / view.total)) : 0;
        const text = (view.label || 'Updating') + (determinate ? ' ' + view.done + '/' + view.total : '');
        return (
            <React.Fragment>
                <div data-testid="usd-scene-rebuild-bar" role="progressbar" aria-label={text}
                    aria-valuemin="0" aria-valuemax="100" aria-valuenow={determinate ? Math.round(fraction * 100) : undefined}
                    className="absolute top-0 left-0 right-0 z-30 pointer-events-none overflow-hidden"
                    style={{ height: 2, background: 'rgb(var(--mtlx-accent-wash) / calc(46 / 255))' }}>
                    {determinate
                        ? <div className="h-full bg-progress transition-all duration-200" style={{ width: (fraction * 100) + '%' }} />
                        : <div className="mtlx-loading-bar" style={{ height: 2, borderRadius: 0, background: 'transparent' }} />}
                </div>
                <div data-testid="usd-scene-rebuild-indicator" data-kind={view.kind} data-done={view.done} data-total={view.total}
                    aria-live="polite"
                    className="absolute bottom-2 right-2 z-10 pointer-events-none flex items-center gap-2 px-2 py-1 rounded-full bg-black/60 text-[11px] text-white/90">
                    <span className="w-1.5 h-1.5 rounded-full bg-progress shrink-0 animate-pulse" />
                    <span className="whitespace-nowrap tabular-nums">{text}</span>
                </div>
            </React.Fragment>
        );
    }
    function SceneViewerApp({ active = true }) {
        const narrow = useNarrowPane();
        const [sidebarOpen, setSidebarOpen] = React.useState(!narrow);
        const sidebarOpenRef = React.useRef(sidebarOpen);
        sidebarOpenRef.current = sidebarOpen;
        const [files, setFiles] = React.useState([]);
        const [rootPath, setRootPath] = React.useState('');
        // VS Code starts in 'host-loading': the host is already collecting
        // the scene's files when this view mounts.
        const [status, setStatus] = React.useState(IN_VSCODE ? 'host-loading' : 'idle');
        const [progress, setProgress] = React.useState(IN_VSCODE
            ? { phase: 'collect', fraction: 0, done: 0, total: 0, message: '', label: '', step: '' }
            : { phase: '', done: 0, total: 0, message: '' });
        const [stage, setStage] = React.useState(null);
        const [handle, setHandle] = React.useState(null);
        // Full loose (non-.mtlx) file map of the loaded scene, for the
        // material preview panel's editor hand-off: the renderer's own
        // getMaterialDocument().files is scoped to what its own filename-ref
        // scan matched, which can miss a texture the export scanner later
        // wants under a different relative form. Also merges stage.assets so
        // synthetic entries (glTF-embedded textures/materials, USDZ-internal
        // textures) the loader already decoded into memory are included,
        // not just the user's originally-dropped files.
        const sceneLooseFiles = React.useMemo(() => {
            const map = {};
            const add = ({ path, data }) => {
                if (!path || /\.mtlx$/i.test(path)) return;
                if (window.isHiddenSideFile && window.isHiddenSideFile(path)) return;
                map[path] = (data instanceof ArrayBuffer) ? new Blob([data]) : data;
            };
            files.forEach(add);
            (stage && Array.isArray(stage.assets) ? stage.assets : []).forEach(add);
            return map;
        }, [files, stage]);
        const [error, setError] = React.useState('');
        // A fatal load failure (setError below) also needs to show up in
        // Diagnostics as an error-severity record, not just the viewport
        // alert; cleared on every new load attempt.
        const [loadErrorDetails, setLoadErrorDetails] = React.useState([]);
        const [previewOpen, setPreviewOpen] = React.useState(false);
        // Short viewport note explaining why a double-click opened nothing.
        const [doubleClickNote, setDoubleClickNote] = React.useState('');
        const doubleClickNoteTimer = React.useRef(0);
        const showDoubleClickNote = (text) => {
            setDoubleClickNote(text);
            clearTimeout(doubleClickNoteTimer.current);
            doubleClickNoteTimer.current = setTimeout(() => setDoubleClickNote(''), 3000);
        };
        const DOUBLE_CLICK_NOTES = {
            moved: 'Double-click ignored: the pointer moved between the clicks',
            'no-api': 'Double-click preview is unavailable for this scene',
            'no-hit': 'Double-click: no surface under the pointer',
            'no-material': 'Double-click: the surface has no material bound',
            'no-document': 'Double-click: no MaterialX document for this material',
            unbound: 'This material is not assigned to any mesh in the scene',
        };
        const [previewPayload, setPreviewPayload] = React.useState(null);
        const [previewWarm, setPreviewWarm] = React.useState(false);
        const [previewAnchor, setPreviewAnchor] = React.useState(null);
        const previewPanelRef = React.useRef(null);
        // Read by the viewport listeners and row clicks between renders.
        const previewPayloadRef = React.useRef(null);
        previewPayloadRef.current = previewPayload;
        const previewOpenRef = React.useRef(false);
        previewOpenRef.current = previewOpen;
        // 'open' (double-click, Enter) shows the panel, placed at `anchor` when given;
        // 'swap' (single click) only changes what an open panel shows. The same
        // material again never reloads the graph.
        const showMaterialPreview = (doc, info, mode, anchor) => {
            const current = previewPayloadRef.current;
            const same = previewOpenRef.current && !!current && current.previewMaterialPath === info.materialPath;
            if (mode === 'swap' && (!previewOpenRef.current || same)) return false;
            if (!same) {
                // doc.materialName (the renderer's cache) and info.materialName
                // (the USD prim leaf) are both only hints; resolve against the
                // resolved document's own material element names.
                const materialName = resolveDocMaterialName((doc && doc.xml) || null, (doc && doc.materialName) || info.materialName || null);
                const payload = Object.assign({ primPath: info.primPath }, doc, { materialName, previewMaterialPath: info.materialPath });
                previewPayloadRef.current = payload;
                setPreviewPayload(payload);
            }
            if (mode === 'open') {
                previewOpenRef.current = true;
                setPreviewAnchor(anchor || null);
                setPreviewOpen(true);
            }
            return !same;
        };
        const showMaterialPreviewRef = React.useRef(null);
        showMaterialPreviewRef.current = showMaterialPreview;
        // Bumped on every unbound-material preview attempt (tree or viewport)
        // so a stale ensureMaterialDocument() resolution from an earlier
        // double-click, or one that outlives a scene reload, is dropped.
        const previewRequestRef = React.useRef(0);
        // Shared fallback when getMaterialDocument has nothing yet: builds the
        // document on demand (unbound Material prims, or a bound record not
        // compiled yet), then opens/swaps the preview. `wasUnbound` controls
        // whether the "not assigned to any mesh" note accompanies success,
        // matching the existing DOUBLE_CLICK_NOTES.unbound behavior; on a
        // null resolve or a rejection, the usual failure note is shown
        // instead (respecting `mode === 'swap'`, which otherwise stays quiet).
        const previewUnboundMaterial = (current, materialPath, info, mode, anchor, wasUnbound, log) => {
            const note = (reason) => { if (mode !== 'swap' || reason === 'unbound') showDoubleClickNote(DOUBLE_CLICK_NOTES[reason] || reason); };
            const failReason = wasUnbound ? 'unbound' : 'no-document';
            if (typeof current.ensureMaterialDocument !== 'function') { log(failReason); note(failReason); return; }
            const requestId = ++previewRequestRef.current;
            const generation = generationRef.current;
            const stale = () => previewRequestRef.current !== requestId || generationRef.current !== generation || handleRef.current !== current;
            current.ensureMaterialDocument(materialPath).then((doc) => {
                if (stale()) return;
                if (!doc) { log(failReason); note(failReason); return; }
                log('ok');
                showMaterialPreview(doc, info, mode, anchor);
                if (wasUnbound) note('unbound');
            }).catch(() => {
                if (stale()) return;
                log(failReason); note(failReason);
            });
        };
        const [dragOver, setDragOver] = React.useState(false);
        // Outliner state lives here, not in the tree, so closing the sidebar or
        // reloading the same stage keeps it; a different stage resets it.
        // Keys are row ids (an object's path, 'group:scene', 'material:<path>', ...);
        // treeHidden holds Scene ids, lightsHidden the light prim paths.
        const [treeExpanded, setTreeExpanded] = React.useState(() => new Set());
        const [treeSelected, setTreeSelected] = React.useState('');
        const [treeHidden, setTreeHidden] = React.useState(() => new Set());
        const [lightsHidden, setLightsHidden] = React.useState(() => new Set());
        // The Environment row's eye: per view like hidden lights, never persisted.
        const [envLightingOff, setEnvLightingOff] = React.useState(false);
        const [treeFilter, setTreeFilter] = React.useState('');
        const [treeGroup, setTreeGroup] = React.useState('all');
        const [treeReveal, setTreeReveal] = React.useState(0);
        const treeSceneKeyRef = React.useRef(null);
        // The Cameras group's active row: 'default' (frame the scene) or a camera path.
        const [selectedCamera, setSelectedCamera] = React.useState('default');
        React.useEffect(() => {
            const stageCameras = Array.isArray(stage && stage.cameras) ? stage.cameras : [];
            setSelectedCamera(defaultCameraPathFor(stageCameras) || 'default');
        }, [stage]);
        // Scene section: Info and loaded-files disclosures, and whether a '.usd' root is a crate.
        const [sceneInfoOpen, setSceneInfoOpen] = React.useState(true);
        const [sceneFilesOpen, setSceneFilesOpen] = React.useState(false);
        const [rootUsdBinary, setRootUsdBinary] = React.useState(false);
        React.useEffect(() => {
            setRootUsdBinary(false);
            if (ext(rootPath) !== '.usd') return undefined;
            const blob = blobOfCandidate(files.find((file) => file.path === rootPath));
            if (!blob) return undefined;
            let live = true;
            blob.slice(0, 8).text().then((head) => { if (live) setRootUsdBinary(head.indexOf('PXR-USDC') === 0); }, () => {});
            return () => { live = false; };
        }, [files, rootPath]);
        const [rootTouched, setRootTouched] = React.useState(false);
        // Model (glTF/OBJ) root candidates set aside when a USD root layer
        // was also supplied; surfaced as an info-level diagnostic below.
        const [ignoredModelRoots, setIgnoredModelRoots] = React.useState([]);
        // Lowercase normalized paths of the root candidates nothing else
        // picked references (item 4); the Scene file dropdown shows only
        // these until "Show all files" is picked. Empty set means unknown/
        // not yet scanned, which the dropdown treats as "show everything".
        const [rootTopLevelPaths, setRootTopLevelPaths] = React.useState(null);
        // Lower-case paths of the .xml files whose content made them Mitsuba roots.
        const [mitsubaRootPaths, setMitsubaRootPaths] = React.useState(() => new Set());
        const [showAllRootFiles, setShowAllRootFiles] = React.useState(false);
        const [envFileName, setEnvFileName] = React.useState('');
        const [envImportError, setEnvImportError] = React.useState(null);
        const [envRotation, setEnvRotation] = React.useState(0);
        const [envExposureLinear, setEnvExposureLinear] = React.useState(1);
        const [backdrop, setBackdrop] = React.useState('studio');
        const [textureSizeTick, setTextureSizeTick] = React.useState(0);
        const [subdivisionLevel, setSubdivisionLevel] = React.useState(
            () => sceneStored('subdivision')
        );
        const subdivisionLevelRef = React.useRef(subdivisionLevel);
        subdivisionLevelRef.current = subdivisionLevel;
        const [triangleLimits, setTriangleLimitsState] = React.useState(
            () => !!sceneStored('triangleLimits')
        );
        const triangleLimitsRef = React.useRef(triangleLimits);
        triangleLimitsRef.current = triangleLimits;
        const [displacementEnabled, setDisplacementEnabledState] = React.useState(() => !!sceneStored('displacement'));
        const [displacementSubdivisionOverride, setDisplacementSubdivisionOverrideState] = React.useState(
            () => sceneStored('displacementSubdivision')
        );
        const displacementSubdivisionRef = React.useRef(displacementSubdivisionOverride);
        displacementSubdivisionRef.current = displacementSubdivisionOverride;
        // The Scene keeps its own view transform and exposure (the Material
        // Viewer stays on sRGB for MaterialXView parity).
        const [displayTransform, setDisplayTransformState] = React.useState(() => sceneStored('displayTransform'));
        // Karma reads untagged colour constants and displayColor as ACEScg;
        // this viewer treats the same numbers as linear Rec.709. Scene-only,
        // recompiles every material when toggled (see setSceneMaterialWorkspace).
        const [materialWorkspace, setMaterialWorkspaceState] = React.useState(() => sceneStored('materialWorkspace'));
        // Widens the anisotropic specular alpha by screen-space normal/roughness
        // variance to stop procedural-roughness fireflies (see patchSpecularAA in
        // mtlx-engine.js). Scene-only, recompiles every material when toggled
        // (see setSceneSpecularAA); default on.
        const [specularAAOn, setSpecularAAOn] = React.useState(() => !!sceneStored('specularAA'));
        const [displayExposure, setDisplayExposureState] = React.useState(() => sceneStored('displayExposure'));
        // Analytic lights imported from the stage. Count comes from the
        // handle once a stage is loaded; the two controls are live.
        // Diagnostic groups: errors and warnings open, info and the source
        // list collapsed, since those are the long ones.
        const [diagOpen, setDiagOpen] = React.useState({ error: true, warning: true, info: false, materials: false });
        const [stageLightInfo, setStageLightInfo] = React.useState({ count: 0, enabled: true, ev: 0 });
        const [stageLightsOn, setStageLightsOn] = React.useState(() => !!sceneStored('stageLightsOn'));
        const [stageLightsEv, setStageLightsEv] = React.useState(() => sceneStored('stageLightsEv'));
        const [presentation, setPresentation] = React.useState(SCENE_PRESENTATION_DEFAULT);
        const [shadowsOn, setShadowsOn] = React.useState(() => !!sceneStored('shadows'));
        const [aoOn, setAoOn] = React.useState(() => !!sceneStored('ao'));
        const [aoStrength, setAoStrength] = React.useState(() => sceneStored('aoStrength'));
        const [bounceOn, setBounceOn] = React.useState(() => !!sceneStored('bounce'));
        const [bounceStrength, setBounceStrength] = React.useState(() => sceneStored('bounceStrength'));
        // Screen-space reflections are parked: rows hidden, state and handlers kept.
        const SSR_ROWS_HIDDEN = true;
        const [ssrOn, setSsrOn] = React.useState(() => !!sceneStored('ssrOn'));
        const [ssrStrength, setSsrStrength] = React.useState(() => sceneStored('ssrStrength'));
        const [ssrMaxRoughness, setSsrMaxRoughness] = React.useState(() => sceneStored('ssrMaxRoughness'));
        const [skyVisOn, setSkyVisOn] = React.useState(() => !!sceneStored('skyVis'));
        const [skyVisStrength, setSkyVisStrength] = React.useState(() => sceneStored('skyVisStrength'));
        const [localEnvOn, setLocalEnvOn] = React.useState(() => !!sceneStored('localReflections'));
        const [localEnvStrength, setLocalEnvStrength] = React.useState(() => sceneStored('localEnvStrength'));
        // Live, not staged: the renderer's texture session follows the store.
        const [textureAnisotropy, setTextureAnisotropyState] = React.useState(() => sceneStored('textureAnisotropy'));
        // Render settings popover: replaces the old sidebar Rendering card.
        // Tab is persisted so a reopen lands where the user left it.
        const RENDER_TAB_KEY = 'mtlx_scene_render_settings_tab';
        const RENDER_TABS = ['display', 'lighting', 'effects', 'geometry'];
        const [renderSettingsOpen, setRenderSettingsOpen] = React.useState(false);
        const [renderSettingsMounted, setRenderSettingsMounted] = React.useState(false);
        // Quality draft (staged governed values, null until first touched),
        // the live-control snapshot taken when the popover opens (for
        // Cancel), and the label shown while an Apply is in flight.
        const [qualityDraft, setQualityDraft] = React.useState(null);
        const [liveSnapshot, setLiveSnapshot] = React.useState(null);
        const [presetApplying, setPresetApplying] = React.useState(null);
        const [renderTab, setRenderTab] = React.useState(() => {
            try { const v = localStorage.getItem(RENDER_TAB_KEY); return RENDER_TABS.indexOf(v) >= 0 ? v : 'display'; }
            catch (e) { return 'display'; }
        });
        const renderSettingsBtnRef = React.useRef(null);
        const renderSettingsPopRef = React.useRef(null);
        React.useEffect(() => { if (renderSettingsOpen) setRenderSettingsMounted(true); }, [renderSettingsOpen]);
        React.useEffect(() => { try { localStorage.setItem(RENDER_TAB_KEY, renderTab); } catch (e) {} }, [renderTab]);
        useEscapeToClose(() => setRenderSettingsOpen(false), renderSettingsOpen);
        React.useEffect(() => {
            if (!renderSettingsOpen) return undefined;
            const onDown = (e) => {
                if (renderSettingsPopRef.current && renderSettingsPopRef.current.contains(e.target)) return;
                if (renderSettingsBtnRef.current && renderSettingsBtnRef.current.contains(e.target)) return;
                setRenderSettingsOpen(false);
            };
            window.addEventListener('pointerdown', onDown);
            return () => window.removeEventListener('pointerdown', onDown);
        }, [renderSettingsOpen]);
        // Viewport popovers under the HUD row besides Render settings: the editable
        // Environment settings and the view-only info of one stage light (its prim
        // path). At most one of the three is open.
        const [envPopoverOpen, setEnvPopoverOpen] = React.useState(false);
        const [lightInfoPath, setLightInfoPath] = React.useState('');
        const envBtnRef = React.useRef(null);
        const envPopRef = React.useRef(null);
        const lightPopRef = React.useRef(null);
        const openEnvPopover = () => { setRenderSettingsOpen(false); setLightInfoPath(''); setEnvPopoverOpen(true); };
        const openLightInfo = (path) => { setRenderSettingsOpen(false); setEnvPopoverOpen(false); setLightInfoPath(path || ''); };
        React.useEffect(() => { if (renderSettingsOpen) { setEnvPopoverOpen(false); setLightInfoPath(''); } }, [renderSettingsOpen]);
        useEscapeToClose(() => setEnvPopoverOpen(false), envPopoverOpen);
        useEscapeToClose(() => setLightInfoPath(''), !!lightInfoPath);
        React.useEffect(() => {
            if (!envPopoverOpen && !lightInfoPath) return undefined;
            const inside = (ref, target) => !!(ref.current && ref.current.contains(target));
            const onDown = (e) => {
                if (envPopoverOpen && !inside(envPopRef, e.target) && !inside(envBtnRef, e.target)) setEnvPopoverOpen(false);
                if (lightInfoPath && !inside(lightPopRef, e.target)) setLightInfoPath('');
            };
            window.addEventListener('pointerdown', onDown);
            return () => window.removeEventListener('pointerdown', onDown);
        }, [envPopoverOpen, lightInfoPath]);
        // Sidebar "Experimental" pill: a small known-issues popover, portaled
        // out of the sidebar's overflow-hidden and clamped to the viewport
        // the same way SettingsDialog in mtlx-ui.jsx anchors below its cog.
        const [knownIssuesOpen, setKnownIssuesOpen] = React.useState(false);
        const knownIssuesBtnRef = React.useRef(null);
        const knownIssuesPopRef = React.useRef(null);
        const [knownIssuesPos, setKnownIssuesPos] = React.useState(null);
        useEscapeToClose(() => setKnownIssuesOpen(false), knownIssuesOpen);
        React.useLayoutEffect(() => {
            if (!knownIssuesOpen) return undefined;
            const rect = knownIssuesBtnRef.current ? knownIssuesBtnRef.current.getBoundingClientRect() : null;
            if (rect) {
                const left = Math.max(8, Math.min(rect.left, window.innerWidth - KNOWN_ISSUES_POPOVER_W - 8));
                setKnownIssuesPos({ left, top: Math.min(rect.bottom + 4, window.innerHeight - 8) });
            }
            return undefined;
        }, [knownIssuesOpen]);
        React.useEffect(() => {
            if (!knownIssuesOpen) return undefined;
            const onDown = (e) => {
                if (knownIssuesPopRef.current && knownIssuesPopRef.current.contains(e.target)) return;
                if (knownIssuesBtnRef.current && knownIssuesBtnRef.current.contains(e.target)) return;
                setKnownIssuesOpen(false);
            };
            window.addEventListener('pointerdown', onDown);
            return () => window.removeEventListener('pointerdown', onDown);
        }, [knownIssuesOpen]);
        // Diagnostics popover, opened from the Statistics header. Portaled and kept
        // mounted while closed (hidden): specs read its messages without opening it.
        const [diagnosticsOpen, setDiagnosticsOpen] = React.useState(false);
        const diagnosticsBtnRef = React.useRef(null);
        const diagnosticsPopRef = React.useRef(null);
        const [diagnosticsPos, setDiagnosticsPos] = React.useState(null);
        useEscapeToClose(() => setDiagnosticsOpen(false), diagnosticsOpen);
        React.useEffect(() => { if (!active || !sidebarOpen) setDiagnosticsOpen(false); }, [active, sidebarOpen]);
        React.useLayoutEffect(() => {
            if (!diagnosticsOpen) return undefined;
            const place = () => {
                const rect = diagnosticsBtnRef.current ? diagnosticsBtnRef.current.getBoundingClientRect() : null;
                if (!rect) return;
                const width = Math.min(DIAGNOSTICS_POPOVER_W, window.innerWidth - 16);
                const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
                const maxHeight = Math.max(120, Math.min(window.innerHeight * DIAGNOSTICS_POPOVER_MAX_VH, rect.top - 12));
                setDiagnosticsPos({ left, width, maxHeight, bottom: window.innerHeight - rect.top + 4 });
            };
            place();
            window.addEventListener('resize', place);
            return () => window.removeEventListener('resize', place);
        }, [diagnosticsOpen]);
        React.useEffect(() => {
            if (!diagnosticsOpen) return undefined;
            const onDown = (e) => {
                if (diagnosticsPopRef.current && diagnosticsPopRef.current.contains(e.target)) return;
                if (diagnosticsBtnRef.current && diagnosticsBtnRef.current.contains(e.target)) return;
                setDiagnosticsOpen(false);
            };
            window.addEventListener('pointerdown', onDown);
            return () => window.removeEventListener('pointerdown', onDown);
        }, [diagnosticsOpen]);
        const [transparentPrims, setTransparentPrims] = React.useState([]);
        // Scene owns its transparency preference. It intentionally does not
        // mirror the shared Viewer Force Transparency setting: Scene defaults
        // to authored transmission/opacity and has its own explicit opt-out.
        const [sceneTransparency, setSceneTransparencyState] = React.useState(
            () => (typeof window.getUsdSceneTransparency === 'function' ? !!window.getUsdSceneTransparency() : true)
        );
        React.useEffect(() => {
            const onSceneTransparencyChanged = (e) => {
                const detail = e && e.detail;
                const value = detail && detail.value != null ? detail.value : detail && detail.enabled;
                if (value == null) return;
                const enabled = !!value;
                setSceneTransparencyState(enabled);
                // The transparent-prims list only exists while Scene
                // transparency is enabled, so refresh it from the live handle.
                const fn = handleRef.current && handleRef.current.getTransparentPrims;
                if (!enabled) setTransparentPrims([]);
                else if (typeof fn === 'function') { try { setTransparentPrims(fn()); } catch (err) { /* not rendered yet */ } }
            };
            window.addEventListener('mtlx-usd-scene-transparency', onSceneTransparencyChanged);
            return () => window.removeEventListener('mtlx-usd-scene-transparency', onSceneTransparencyChanged);
        }, []);
        // GPU-convolved diffuse irradiance vs. the SH l<=2 fit (js/mtlx-engine.js
        // DIFFUSE_ENV_METHOD). Not generation-affecting: flipping it only
        // rebinds a sampler through applyMaterialEnvironment, no recompile.
        const [diffuseEnvConvolve, setDiffuseEnvConvolveState] = React.useState(() => sceneStored('diffuseEnv') !== 'sh');
        const envSettingsRef = React.useRef({ rotation: 0, exposureLinear: 1, backdrop: 'studio', autoRotate: false });
        const [recordOpen, setRecordOpen] = React.useState(false);
        const [exportOpen, setExportOpen] = React.useState(false);
        const envOverrideRef = React.useRef(null);
        // True while envRotation holds an authored dome rotationDeg rather
        // than a plain engine-degree value; gates the yaw conversion below.
        const domeRotationActiveRef = React.useRef(false);
        const currentEnvironmentRef = React.useRef(null);
        const containerRef = React.useRef(null);
        const viewportRef = containerRef;
        const activeRef = React.useRef(active);
        activeRef.current = active;
        // Sleeping the view also drops the preview panel (its own live
        // viewer) by remounting it empty; the next double-click rebuilds it.
        const [previewEpoch, setPreviewEpoch] = React.useState(0);
        React.useEffect(() => {
            if (active) return;
            setPreviewOpen(false);
            setPreviewPayload(null);
            setPreviewWarm(false);
            setPreviewEpoch((epoch) => epoch + 1);
        }, [active]);
        // Warm the preview once the stage is on screen and the main thread
        // is idle: the panel mounts hidden and boots the embed's runtime, so
        // a double-click only pays this material's own shader generation.
        React.useEffect(() => {
            if (!active || status !== 'rendered' || previewWarm) return undefined;
            let timer = 0;
            let idle = 0;
            const arm = () => setPreviewWarm(true);
            if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(arm, { timeout: 1500 });
            else timer = setTimeout(arm, 500);
            return () => {
                if (idle && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
                if (timer) clearTimeout(timer);
            };
        }, [active, status, previewWarm]);
        const abortRef = React.useRef(null);
        const mountedRef = React.useRef(true);
        const filesRef = React.useRef(files);
        const handleRef = React.useRef(null);
        // The live stage canvas, for WebGL context-loss recovery below.
        const sceneCanvasRef = React.useRef(null);
        const generationRef = React.useRef(0);
        // Compact HUD: below ~720px the left pills (Render settings,
        // Environment settings, both with labels) and the right
        // ViewportControls strip (labelled rotate/reset/screenshot/record/
        // fullscreen) no longer fit on one row without wrapping into each
        // other, so labels drop and the left pills go icon-only. Below
        // ~420px even icon-only clusters can't share a row reliably (narrow
        // VS Code panels), so the right cluster moves to its own row under
        // the left one instead of risking an overlap.
        const [hudCompact, setHudCompact] = React.useState(false);
        const [hudStacked, setHudStacked] = React.useState(false);
        const environmentGenerationRef = React.useRef(0);
        // Tracks the whole-load fraction across both the worker and renderer
        // phases of one load (they share a generation id); a new generation
        // resets it to 0 so the bar never carries over from a prior load.
        const progressFractionGenRef = React.useRef(null);
        const progressFractionRef = React.useRef(0);
        const [rotating, toggleRotating] = useViewToggle(handleRef, 'setAutoRotate', false);
        filesRef.current = files;
        envSettingsRef.current = { rotation: envRotation, exposureLinear: envExposureLinear, backdrop, autoRotate: rotating };
        const updateProgress = (value, generation) => {
            // Perf-only: records every progress event (loader worker phases
            // AND renderer phases) with a timestamp, for the load-timeline
            // harness. Zero cost when MTLX_PERF_LOG is off.
            if (window.MTLX_PERF_LOG && value && typeof value === 'object') {
                window.__mtlxScenePhases = window.__mtlxScenePhases || [];
                window.__mtlxScenePhases.push({ phase: value.phase, status: value.status, t: performance.now() });
            }
            if (!mountedRef.current || (generation != null && generation !== generationRef.current)) return;
            if (progressFractionGenRef.current !== generation) { progressFractionGenRef.current = generation; progressFractionRef.current = 0; }
            const wholeFraction = usdSceneProgressFraction(value, progressFractionRef.current);
            progressFractionRef.current = wholeFraction;
            setProgress(progressValue(value, wholeFraction));
        };

        React.useEffect(() => () => {
            mountedRef.current = false;
            if (abortRef.current) abortRef.current.abort();
            if (handleRef.current && typeof handleRef.current.dispose === 'function') handleRef.current.dispose();
            handleRef.current = null;
            window.__mtlxUsdSceneHandle = null;
        }, []);

        // Compact-mode auto-collapse, same idiom as js/viewer-app.jsx.
        const prevNarrowRef = React.useRef(narrow);
        const preNarrowOpenRef = React.useRef(true);
        React.useEffect(() => {
            const was = prevNarrowRef.current;
            prevNarrowRef.current = narrow;
            if (narrow === was) return;
            if (narrow) {
                preNarrowOpenRef.current = sidebarOpenRef.current;
                setSidebarOpen(false);
            } else {
                setSidebarOpen(preNarrowOpenRef.current);
            }
        }, [narrow]);

        const pickDisplayTransform = (mode) => {
            setDisplayTransformState(mode);
            callHandle('setSceneDisplayTransform', mode);
        };
        const pickMaterialWorkspace = (space) => {
            setMaterialWorkspaceState(space);
            callHandle('setSceneMaterialWorkspace', space);
        };
        const applyDisplayExposure = (raw) => {
            const value = Math.max(-8, Math.min(8, Number(raw)));
            if (!Number.isFinite(value)) return;
            setDisplayExposureState(value);
            sceneWrite('displayExposure', value);
            callHandle('refreshDisplaySettings');
        };

        const applyChosenFiles = async (next, generation) => {
            if (!mountedRef.current || generation !== generationRef.current) return;
            setFiles(next);
            const { path: preferredRoot, ignoredModelRoots, topLevelPaths, mitsubaRootPaths: xmlRoots } = await pickDefaultRootLayer(next);
            if (!mountedRef.current || generation !== generationRef.current) return;
            setRootPath(preferredRoot);
            setIgnoredModelRoots(ignoredModelRoots);
            setRootTopLevelPaths(new Set((topLevelPaths || []).map((p) => String(p).toLowerCase())));
            setMitsubaRootPaths(new Set(xmlRoots || []));
            setShowAllRootFiles(false);
            setRootTouched(false);
            setStage(null);
            setStatus(next.length ? 'ready-to-load' : 'idle');
            setError('');
            // A root only auto-loads when one could actually be determined;
            // an empty result (no candidates, or an unresolved fallback)
            // leaves today's behavior of waiting on an explicit pick.
            if (preferredRoot) await load(next, preferredRoot);
        };
        // Expands chosen .zip files before root picking; null after a failure
        // (shown in the scene error area) or when a newer choice superseded it.
        const expandChosen = async (entries, generation) => {
            if (!entries.some((f) => /\.zip$/i.test(f.path))) return entries;
            setStatus('loading'); setError(''); setLoadErrorDetails([]);
            try {
                const sources = window.MtlxSceneSources;
                if (!sources || typeof sources.expandSceneZips !== 'function') throw new Error('Zip support is unavailable in this build.');
                const result = await sources.expandSceneZips(entries);
                if (!mountedRef.current || generation !== generationRef.current) return null;
                result.warnings.forEach((w) => console.warn(w));
                return result.files;
            } catch (e) {
                if (!mountedRef.current || generation !== generationRef.current) return null;
                const message = (e && e.message) || String(e);
                setError(message); setStatus('error'); setLoadErrorDetails(['[error] ' + message]);
                return null;
            }
        };
        const chooseFiles = async (list) => {
            treeSceneKeyRef.current = null; // new files: a fresh outliner
            const generation = ++generationRef.current;
            if (abortRef.current) abortRef.current.abort();
            if (handleRef.current && handleRef.current.dispose) handleRef.current.dispose();
            handleRef.current = null; setHandle(null); setStage(null);
            window.__mtlxUsdSceneHandle = null;
            const next = await expandChosen(await readFiles(list), generation);
            if (next) applyChosenFiles(next, generation);
        };
        const chooseFilesFromMap = async (map) => {
            treeSceneKeyRef.current = null;
            const generation = ++generationRef.current;
            if (abortRef.current) abortRef.current.abort();
            if (handleRef.current && handleRef.current.dispose) handleRef.current.dispose();
            handleRef.current = null; setHandle(null); setStage(null);
            window.__mtlxUsdSceneHandle = null;
            const next = await expandChosen(filesFromMap(map), generation);
            if (next) applyChosenFiles(next, generation);
        };
        // VS Code: missing-file entries already sent to the host for the
        // current host seq; each is asked for once.
        const hostSeqRef = React.useRef(0);
        const hostMissingSentRef = React.useRef(new Set());
        const unsentMissing = (entries) => entries.filter((entry) => {
            const key = entry.asset + '|' + entry.introducedBy;
            if (hostMissingSentRef.current.has(key)) return false;
            hostMissingSentRef.current.add(key);
            return true;
        });
        const load = async (loadFiles = filesRef.current, loadRoot = rootPath, options = {}) => {
            if (!loadRoot) { setError('Select one root layer before loading.'); setStatus('error'); return; }
            // js/usd-scene-sources.js tells a glTF/OBJ root apart from a
            // USD one; its loaders resolve to the same neutral stage
            // payload, so everything downstream stays identical either way.
            const sources = window.MtlxSceneSources;
            // An .xml root is a Mitsuba scene only by content; anything else is no supported scene.
            const kind = (sources && typeof sources.detectRootKindForFiles === 'function') ? await sources.detectRootKindForFiles(loadFiles, loadRoot)
                : ((sources && typeof sources.detectRootKind === 'function') ? sources.detectRootKind(loadRoot) : 'usd');
            if (!kind && /\.xml$/i.test(loadRoot)) {
                const message = loadRoot.split('/').pop() + ' is not a supported scene: an .xml root must be a Mitsuba <scene version="..."> with a shape, sensor, emitter or integrator';
                setError(message); setStatus('error'); setLoadErrorDetails(['[error] Scene failed to load: ' + message]);
                return;
            }
            const loader = kind === 'gltf' ? (sources && sources.loadGltfStage)
                : kind === 'obj' ? (sources && sources.loadObjStage)
                : kind === 'pbrt' ? (sources && sources.loadPbrtStage)
                : kind === 'mitsuba' ? (sources && sources.loadMitsubaStage)
                : apiFunction('loadUsdStage');
            if (typeof loader !== 'function') { setError('Scene loader is unavailable in this build.'); setStatus('error'); return; }
            const generation = ++generationRef.current;
            if (abortRef.current) abortRef.current.abort();
            const controller = new AbortController();
            abortRef.current = controller;
            if (handleRef.current && typeof handleRef.current.dispose === 'function') handleRef.current.dispose();
            handleRef.current = null; setHandle(null); setStage(null); setError(''); setLoadErrorDetails([]); setStatus('loading');
            window.__mtlxUsdSceneHandle = null;
            try {
                // subdivisionLevel/triangleLimits are USD-only knobs; a
                // glTF/OBJ stage arrives already tessellated, so the model
                // loaders simply ignore the two fields.
                const result = await loader({ files: loadFiles, rootPath: loadRoot, signal: controller.signal, subdivisionLevel: subdivisionLevelRef.current, triangleLimits: triangleLimitsRef.current, onProgress: (value) => updateProgress(value, generation) });
                if (!mountedRef.current || controller.signal.aborted || generation !== generationRef.current) return;
                // VS Code: layers the stage could not open are asked for before
                // rendering; when the host finds any, its bigger set replaces this load.
                if (IN_VSCODE && options.host && typeof window.__mtlxSceneReportMissing === 'function') {
                    const missing = unsentMissing(stageMissingEntries(result));
                    if (missing.length) {
                        updateProgress({ phase: 'parse', fraction: 1, label: 'Looking for ' + missing.length + ' missing file' + (missing.length === 1 ? '' : 's') }, generation);
                        const reply = await window.__mtlxSceneReportMissing(missing);
                        if (!mountedRef.current || controller.signal.aborted || generation !== generationRef.current) return;
                        if (reply && reply.added > 0) return;
                    }
                }
                setStage(result); setStatus('loaded');
            } catch (e) {
                if (!mountedRef.current || controller.signal.aborted || generation !== generationRef.current || e && e.name === 'AbortError') return;
                const message = String(e && e.message || e);
                setError(message); setStatus('error');
                // Diagnostics has no severity of its own for a fatal load
                // failure, so tag it explicitly (severityOf() honors the tag).
                setLoadErrorDetails(['[error] Scene failed to load: ' + message]);
            }
        };
        // VS Code host entry: { files: { relPath: File }, root } from the
        // extension (media/bootstrap.js). load() routes the explicit root by
        // kind, so a USD, glTF/GLB or OBJ root all take the same path.
        // { seq, round } of the host set handed to load(), and the one whose
        // files are being collected or fetched (bootstrap.js progress events).
        const hostLoadRef = React.useRef(null);
        const hostPhaseKeyRef = React.useRef('');
        const hostGenerationRef = React.useRef(0);
        const adoptHostSeq = (seq) => {
            if (seq === hostSeqRef.current) return;
            hostSeqRef.current = seq;
            hostMissingSentRef.current = new Set();
        };
        const loadFromHostRef = React.useRef(null);
        loadFromHostRef.current = (payload) => {
            if (!payload || !payload.files || !payload.root) return;
            const host = { seq: Number(payload.seq) || 0, round: Number(payload.round) || 0 };
            hostLoadRef.current = host;
            hostPhaseKeyRef.current = host.seq + ':' + host.round;
            adoptHostSeq(host.seq);
            generationRef.current += 1;
            if (abortRef.current) abortRef.current.abort();
            if (handleRef.current && handleRef.current.dispose) handleRef.current.dispose();
            handleRef.current = null; setHandle(null); setStage(null);
            window.__mtlxUsdSceneHandle = null;
            const next = filesFromMap(payload.files);
            setFiles(next); setRootPath(payload.root); setRootTouched(true); setError('');
            setIgnoredModelRoots([]);
            load(next, payload.root, { host });
        };
        // Host collection ('collect') and webview fetch ('fetch') progress. A
        // new (seq, round) tears down what is shown and starts a host load.
        const hostProgressRef = React.useRef(null);
        hostProgressRef.current = (detail) => {
            if (!detail || !mountedRef.current) return;
            const seq = Number(detail.seq) || 0;
            const round = Number(detail.round) || 0;
            const loaded = hostLoadRef.current;
            if (loaded && (seq < loaded.seq || (seq === loaded.seq && round <= loaded.round))) return; // already loaded
            const key = seq + ':' + round;
            if (hostPhaseKeyRef.current !== key) {
                hostPhaseKeyRef.current = key;
                adoptHostSeq(seq);
                hostGenerationRef.current = ++generationRef.current;
                if (abortRef.current) abortRef.current.abort();
                abortRef.current = null;
                if (handleRef.current && handleRef.current.dispose) handleRef.current.dispose();
                handleRef.current = null; setHandle(null); setStage(null); setError('');
                window.__mtlxUsdSceneHandle = null;
                setStatus('host-loading');
            }
            if (detail.phase === 'collect') {
                const found = Number(detail.found) || 0;
                updateProgress({ phase: 'collect', label: found ? found + (found === 1 ? ' file, ' : ' files, ') + formatMegabytes(detail.bytes) + ' MB' : '' }, hostGenerationRef.current);
            } else {
                const bytesTotal = Number(detail.bytesTotal) || 0;
                const total = Number(detail.total) || 0;
                updateProgress({
                    phase: 'fetch', done: Number(detail.done) || 0, total,
                    fraction: bytesTotal ? (Number(detail.bytesDone) || 0) / bytesTotal : (total ? (Number(detail.done) || 0) / total : 0),
                    label: (round ? 'More referenced files: ' : '') + formatMegabytes(detail.bytesDone) + ' of ' + formatMegabytes(bytesTotal) + ' MB',
                }, hostGenerationRef.current);
            }
        };
        React.useEffect(() => {
            if (!IN_VSCODE) return undefined;
            const take = () => {
                const payload = window.__mtlxPendingSceneImport;
                window.__mtlxPendingSceneImport = null;
                if (payload) loadFromHostRef.current(payload);
            };
            take();
            const onProgress = (event) => hostProgressRef.current(event.detail);
            // Progress posted before this view mounted still applies unless
            // a newer set was already taken above (the guard checks that).
            if (window.__mtlxSceneHostProgress) hostProgressRef.current(window.__mtlxSceneHostProgress);
            window.addEventListener('mtlx-load-scene', take);
            window.addEventListener('mtlx-scene-host-progress', onProgress);
            return () => {
                window.removeEventListener('mtlx-load-scene', take);
                window.removeEventListener('mtlx-scene-host-progress', onProgress);
            };
        }, []);
        React.useEffect(() => {
            if (!stage || !containerRef.current) return undefined;
            if (handleRef.current && handleRef.current.__sceneStage !== stage) {
                handleRef.current.dispose && handleRef.current.dispose();
                handleRef.current = null; setHandle(null);
                window.__mtlxUsdSceneHandle = null;
            }
            if (!active) {
                if (handleRef.current && handleRef.current.setActive) handleRef.current.setActive(false);
                return undefined;
            }
            if (handleRef.current && handleRef.current.setActive) {
                handleRef.current.setActive(true);
                return undefined;
            }
            let live = true;
            let adopted = false;
            let created = null;
            const rendererGeneration = generationRef.current;
            const rendererController = abortRef.current;
            const renderer = apiFunction('createMtlxSceneView');
            if (typeof renderer !== 'function') { setError('USD scene renderer is unavailable in this build.'); setStatus('error'); return undefined; }
            (async () => {
                try {
                    const version = window.MtlxAssets && window.MtlxAssets.MTLX_DEFAULT_VERSION || window.MTLX_DEFAULT_VERSION;
                    // A retained scene handle survives route visibility pauses
                    // after adoption. During initial construction, the local
                    // effect guard still cancels work when the route leaves.
                    const nextHandle = await renderer({ container: containerRef.current, stage, files, version, displacementSubdivision: displacementSubdivisionRef.current, triangleLimits: triangleLimitsRef.current, onProgress: (value) => updateProgress(value, rendererGeneration), isMounted: () => mountedRef.current && generationRef.current === rendererGeneration && !rendererController?.signal?.aborted && (adopted || (live && active)) });
                    created = nextHandle;
                    if (!live || !mountedRef.current || !active || generationRef.current !== rendererGeneration || rendererController?.signal?.aborted) { if (nextHandle && nextHandle.dispose) nextHandle.dispose(); return; }
                    nextHandle.__sceneStage = stage;
                    adopted = true;
                    handleRef.current = nextHandle;
                    sceneCanvasRef.current = nextHandle.renderer ? nextHandle.renderer.domElement : null;
                    window.__mtlxUsdSceneHandle = nextHandle; // test and console access to the live scene handle.
                    const settings = envSettingsRef.current;
                    // A stage that ships a dome light has already seeded the
                    // renderer with its own environment, rotation and exposure.
                    // Mirror those into the card instead of replaying the
                    // card's defaults over them; a user import still wins.
                    if (nextHandle.getShadows) setShadowsOn(nextHandle.getShadows().enabled);
                    if (nextHandle.getPresentation) setPresentation(nextHandle.getPresentation());
                    if (nextHandle.getSceneDisplayTransform) setDisplayTransformState(nextHandle.getSceneDisplayTransform());
                    if (nextHandle.getSceneMaterialWorkspace) setMaterialWorkspaceState(nextHandle.getSceneMaterialWorkspace());
                    if (nextHandle.getSceneSpecularAA) setSpecularAAOn(nextHandle.getSceneSpecularAA());
                    if (nextHandle.getSkyVisibility) {
                        const sky = nextHandle.getSkyVisibility();
                        setSkyVisOn(sky.enabled);
                        setSkyVisStrength(sky.strength);
                    }
                    if (nextHandle.getAmbientOcclusion) {
                        const ao = nextHandle.getAmbientOcclusion();
                        setAoOn(ao.enabled);
                        setAoStrength(ao.strength);
                    }
                    if (nextHandle.getSceneBounce) {
                        const bounce = nextHandle.getSceneBounce();
                        setBounceOn(bounce.enabled);
                        setBounceStrength(bounce.strength);
                    }
                    if (nextHandle.getScreenSpaceReflections) {
                        const ssr = nextHandle.getScreenSpaceReflections();
                        setSsrOn(ssr.enabled);
                        setSsrStrength(ssr.strength);
                        setSsrMaxRoughness(ssr.maxRoughness);
                    }
                    if (nextHandle.getLocalReflections) {
                        const localEnv = nextHandle.getLocalReflections();
                        setLocalEnvOn(localEnv.enabled);
                        setLocalEnvStrength(localEnv.strength);
                    }
                    const transparencyEnabled = typeof window.getUsdSceneTransparency === 'function'
                        ? !!window.getUsdSceneTransparency() : sceneTransparency;
                    if (nextHandle.getTransparentPrims && transparencyEnabled) {
                        try { setTransparentPrims(nextHandle.getTransparentPrims()); } catch (e) { /* pre-render */ }
                    }
                    if (nextHandle.getStageLights) {
                        const info = nextHandle.getStageLights();
                        setStageLightInfo(info);
                        setStageLightsOn(info.enabled);
                        setStageLightsEv(info.ev);
                    }
                    const dome = nextHandle.getDomeLight ? nextHandle.getDomeLight() : null;
                    const useDome = !!dome && !envOverrideRef.current;
                    if (useDome) {
                        setEnvFileName(dome.fileName || 'Stage dome light');
                        setEnvRotation(Math.round(dome.rotationDeg));
                        setEnvExposureLinear(dome.exposure);
                        domeRotationActiveRef.current = true;
                    } else {
                        domeRotationActiveRef.current = false;
                        callHandle('setEnvRotation', settings.rotation * Math.PI / 180);
                        callHandle('setEnvExposure', settings.exposureLinear);
                    }
                    callHandle('setBackdrop', settings.backdrop);
                    callHandle('setAutoRotate', settings.autoRotate);
                    if (currentEnvironmentRef.current && !useDome) callHandle('setEnvironment', currentEnvironmentRef.current, { user: true });
                    setHandle(nextHandle); setStatus('rendered');
                    // VS Code: textures and layers still missing once rendered go
                    // to the host; if it finds any, a bigger set reloads the scene.
                    if (IN_VSCODE && hostLoadRef.current && typeof window.__mtlxSceneReportMissing === 'function') {
                        const missing = unsentMissing(stageMissingEntries(stage).concat(renderMissingEntries(nextHandle, rootPath)));
                        if (missing.length) window.__mtlxSceneReportMissing(missing);
                    }
                    // Apply the chosen camera up front instead of framing
                    // first, so the view never visibly jumps; applyCamera
                    // already falls back to frameAll when the path is missing.
                    const initialCameraPath = defaultCameraPathFor(stage && stage.cameras);
                    if (initialCameraPath && nextHandle.applyCamera) nextHandle.applyCamera(initialCameraPath);
                    else if (nextHandle && nextHandle.frameAll) nextHandle.frameAll();
                } catch (e) { if (live && mountedRef.current && generationRef.current === rendererGeneration && !rendererController?.signal?.aborted) { setError(String(e && e.message || e)); setStatus('error'); } }
            })();
            return () => { live = false; };
        }, [stage, active]);
        React.useEffect(() => {
            if (!containerRef.current || !window.ResizeObserver) return undefined;
            const observer = new ResizeObserver(() => { if (handle && handle.resize) handle.resize(); });
            observer.observe(containerRef.current); return () => observer.disconnect();
        }, [handle]);
        // Drives hudCompact/hudStacked (see their declaration above) from the
        // viewport's own width, not the window's, so a narrow docked VS Code
        // panel compacts even at full browser width.
        React.useEffect(() => {
            if (!containerRef.current || !window.ResizeObserver) return undefined;
            const observer = new ResizeObserver((entries) => {
                const width = entries[0] && entries[0].contentRect ? entries[0].contentRect.width : containerRef.current.clientWidth;
                setHudCompact(width < 720);
                setHudStacked(width < 420);
            });
            observer.observe(containerRef.current); return () => observer.disconnect();
        }, []);

        // True while a popover or dialog owns the viewport; a double-click
        // whose first press dismisses one never opens the preview.
        const overlayOpenRef = React.useRef(false);
        overlayOpenRef.current = !!(renderSettingsOpen || envPopoverOpen || lightInfoPath || knownIssuesOpen || diagnosticsOpen || recordOpen);

        // Double-click a mesh to open its material's graph + shaderball
        // preview. Only a dblclick on the canvas itself, within 4px of its own
        // pointerdown, counts; popovers, pills and the panel never do.
        React.useEffect(() => {
            const container = containerRef.current;
            if (!container || !handle) return undefined;
            const down = { x: 0, y: 0, t: 0, dismissAt: -Infinity };
            // Diagnostics: every attempt lands in window.__mtlxUsdSceneDoubleClicks
            // (last 40) and a failure shows its reason in the viewport.
            const log = (entry) => {
                const list = (window.__mtlxUsdSceneDoubleClicks = window.__mtlxUsdSceneDoubleClicks || []);
                list.push(Object.assign({ t: Math.round(performance.now()) }, entry));
                if (list.length > 40) list.splice(0, list.length - 40);
                if (entry.event === 'dblclick') console.debug('[usd-scene] double-click ' + entry.reason, entry);
            };
            const onPointerDown = (e) => {
                down.x = e.clientX; down.y = e.clientY; down.t = performance.now();
                if (overlayOpenRef.current && handle.renderer && e.target === handle.renderer.domElement) down.dismissAt = down.t;
                log({ event: 'pointerdown', x: e.clientX, y: e.clientY, button: e.button, pointerType: e.pointerType, target: e.target && e.target.tagName });
            };
            const onDblClick = (e) => {
                const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
                const base = { event: 'dblclick', x: e.clientX, y: e.clientY, moved: Math.round(moved), sinceDown: Math.round(performance.now() - down.t), target: e.target && e.target.tagName };
                const fail = (reason, extra) => { log(Object.assign({ reason }, base, extra || {})); showDoubleClickNote(DOUBLE_CLICK_NOTES[reason] || reason); };
                if (previewPanelRef.current && previewPanelRef.current.contains(e.target)) return log(Object.assign({ reason: 'in-panel' }, base));
                if (!handle.renderer || e.target !== handle.renderer.domElement) return log(Object.assign({ reason: 'off-canvas' }, base));
                if (overlayOpenRef.current || performance.now() - down.dismissAt < 800) return log(Object.assign({ reason: 'overlay-open' }, base));
                if (moved > 4) return fail('moved');
                if (typeof handle.pickAt !== 'function' || typeof handle.getMaterialDocument !== 'function') return fail('no-api');
                const hit = handle.pickAt(e.clientX, e.clientY);
                if (!hit) return fail('no-hit');
                if (!hit.materialPath) return fail('no-material', { hit });
                const info = { primPath: hit.primPath, materialName: hit.materialName, materialPath: hit.materialPath };
                const bounds = container.getBoundingClientRect();
                const anchor = { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
                const doc = handle.getMaterialDocument(hit.materialPath);
                if (!doc) {
                    // Same on-demand build as the tree; a picked mesh is never
                    // itself "unbound", so this only ever shows the plain
                    // no-document note on failure, silently on success.
                    previewUnboundMaterial(handle, hit.materialPath, info, 'open', anchor, false,
                        (reason) => log(Object.assign({ reason }, base, { hit })));
                    return;
                }
                log(Object.assign({ reason: 'ok' }, base, { hit: { primPath: hit.primPath, materialPath: hit.materialPath } }));
                showMaterialPreviewRef.current(doc, info, 'open', anchor);
            };
            // A click on the canvas itself (not an orbit drag, not a HUD pill)
            // selects the surface under it in the outliner; empty space clears.
            // With the preview open, a surface also swaps it to the material under the click.
            const onClick = (e) => {
                if (e.button !== 0 || !handle.renderer || e.target !== handle.renderer.domElement) return;
                if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || typeof handle.pickAt !== 'function') return;
                const hit = handle.pickAt(e.clientX, e.clientY);
                if (viewportSelectRef.current) viewportSelectRef.current(hit ? hit.primPath : '');
                if (!hit || !hit.materialPath || !previewOpenRef.current || typeof handle.getMaterialDocument !== 'function') return;
                const doc = handle.getMaterialDocument(hit.materialPath);
                if (doc) showMaterialPreviewRef.current(doc, { primPath: hit.primPath, materialName: hit.materialName, materialPath: hit.materialPath }, 'swap');
            };
            container.addEventListener('pointerdown', onPointerDown);
            container.addEventListener('dblclick', onDblClick);
            container.addEventListener('click', onClick);
            return () => {
                container.removeEventListener('pointerdown', onPointerDown);
                container.removeEventListener('dblclick', onDblClick);
                container.removeEventListener('click', onClick);
            };
        }, [handle]);

        // Outliner: tree model, renderer sync, selection and activation.
        const sceneTree = React.useMemo(() => (stage ? buildSceneTree(stage) : null), [stage]);
        // Same camera list as the hierarchy's Cameras group.
        const cameraOptions = React.useMemo(() => (sceneTree
            ? sceneTree.groups.cameras.children.map((node) => ({ value: node.isDefaultCamera ? 'default' : node.path, label: node.name }))
            : []), [sceneTree]);
        React.useEffect(() => {
            if (!sceneTree) return;
            if (treeSceneKeyRef.current === rootPath) {
                // The same stage reloaded (Apply, watcher, Reload): keep what still exists.
                setTreeHidden((prev) => { const next = new Set(Array.from(prev).filter((id) => sceneTree.byId.has(id))); return next.size === prev.size ? prev : next; });
                setLightsHidden((prev) => { const next = new Set(Array.from(prev).filter((path) => sceneTree.byId.has('light:' + path))); return next.size === prev.size ? prev : next; });
                setTreeSelected((prev) => (prev && sceneTree.byId.has(prev) ? prev : ''));
                return;
            }
            treeSceneKeyRef.current = rootPath;
            setTreeExpanded(defaultSceneTreeExpanded(sceneTree));
            setTreeSelected('');
            setTreeHidden(new Set());
            setLightsHidden(new Set());
            setEnvLightingOff(false);
            setTreeFilter('');
            setTreeGroup('all');
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [sceneTree]);
        React.useEffect(() => {
            if (handle && typeof handle.setHiddenPrims === 'function') handle.setHiddenPrims(sceneTreeHiddenRenderPaths(sceneTree, treeHidden));
        }, [handle, sceneTree, treeHidden]);
        React.useEffect(() => {
            if (handle && typeof handle.setHiddenLights === 'function') handle.setHiddenLights(Array.from(lightsHidden));
        }, [handle, lightsHidden]);
        React.useEffect(() => {
            if (handle && typeof handle.setEnvironmentLightingEnabled === 'function') handle.setEnvironmentLightingEnabled(!envLightingOff);
        }, [handle, envLightingOff]);
        React.useEffect(() => {
            if (!handle || typeof handle.setHighlightedPrims !== 'function') return;
            const node = treeSelected && sceneTree ? sceneTree.byId.get(treeSelected) : null;
            handle.setHighlightedPrims(node && !node.isGroup ? sceneTreeRenderPaths(sceneTree, node) : []);
        }, [handle, sceneTree, treeSelected]);
        const treeRows = React.useMemo(() => flattenSceneTree(sceneTree, treeExpanded, treeFilter, treeGroup), [sceneTree, treeExpanded, treeFilter, treeGroup]);
        const toggleTreeExpanded = (id) => setTreeExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
        const toggleSetEntry = (setter, key) => setter((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
        // Eye buttons: objects and the Scene group hide meshes, stage lights (one or the
        // whole group) and the environment's lighting are turned off in the renderer.
        const toggleTreeHidden = (node) => {
            if (!node) return;
            if (node.group === 'scene') { toggleSetEntry(setTreeHidden, node.id); return; }
            if (node.isEnvironment) { setEnvLightingOff((off) => !off); return; }
            if (node.isGroup && node.group === 'lights') {
                const paths = sceneTreeLightPaths(sceneTree);
                setLightsHidden((prev) => (paths.length && paths.every((path) => prev.has(path)) ? new Set() : new Set(paths)));
                return;
            }
            if (sceneTreeLightHideable(node)) toggleSetEntry(setLightsHidden, node.path);
        };
        const selectTreePath = (id, reveal) => {
            setTreeSelected(id || '');
            if (!id || !reveal) return;
            const node = sceneTree && sceneTree.byId.get(id);
            setTreeExpanded((prev) => {
                let next = null;
                for (let parent = node && node.parent; parent; parent = parent.parent) {
                    if (!prev.has(parent.id)) { next = next || new Set(prev); next.add(parent.id); }
                }
                return next || prev;
            });
            setTreeReveal((token) => token + 1);
        };
        const viewportSelectRef = React.useRef(null);
        viewportSelectRef.current = (renderPath) => {
            const node = renderPath && sceneTree ? sceneTree.byRenderPath.get(renderPath) : null;
            if (!node) { setTreeSelected(''); return; }
            const query = treeFilter.trim().toLowerCase();
            if (query && node.name.toLowerCase().indexOf(query) < 0) setTreeFilter('');
            if (treeGroup !== 'all' && node.group !== treeGroup) setTreeGroup('all');
            selectTreePath(node.id, true);
        };
        // The material preview for a mesh row (its bound material) or a material row.
        const previewTreeNode = (node, mode) => {
            const current = handleRef.current;
            const log = (reason) => {
                const list = (window.__mtlxUsdSceneDoubleClicks = window.__mtlxUsdSceneDoubleClicks || []);
                list.push({ t: Math.round(performance.now()), event: mode === 'swap' ? 'click' : 'dblclick', source: 'tree', reason, primPath: node.path, materialPath: node.materialPath });
                if (list.length > 40) list.splice(0, list.length - 40);
            };
            // A swap stays quiet about a mesh without a material, never about an unbound one.
            const fail = (reason) => { log(reason); if (mode !== 'swap' || reason === 'unbound') showDoubleClickNote(DOUBLE_CLICK_NOTES[reason] || reason); };
            if (!current || typeof current.getMaterialDocument !== 'function') return fail('no-api');
            if (!node.materialPath) return fail('no-material');
            const doc = current.getMaterialDocument(node.materialPath);
            // Only bound materials are compiled, so an unassigned Material prim has no document.
            const unbound = node.kind === 'material' && !(sceneTree && (sceneTree.meshesByMaterial.get(node.path) || []).length);
            // materialName is the leaf of the material's own prim path, not
            // node.name (which is the mesh's name for a mesh row): the Graph
            // Editor handoff needs the material's real name, not the surface it's bound to.
            const materialSegments = sceneTreeSegments(node.materialPath);
            const materialName = materialSegments.length ? materialSegments[materialSegments.length - 1] : null;
            const info = { primPath: node.path, materialName, materialPath: node.materialPath };
            if (doc) { log('ok'); showMaterialPreview(doc, info, mode, null); return; }
            // No document yet: an unbound Material prim, or a bound record not
            // built yet. Ask the renderer to build it and open once it resolves.
            previewUnboundMaterial(current, node.materialPath, info, mode, null, unbound, log);
        };
        // Single click on a row: selects it; a group header also opens or closes, a
        // camera becomes the view, the environment opens its settings, another light
        // its info, and an open preview follows a mesh or material.
        const clickTreeRow = (node) => {
            if (!node) return;
            selectTreePath(node.id, false);
            if (node.kind !== 'light') setLightInfoPath('');
            if (node.isGroup) { if (node.children.length) toggleTreeExpanded(node.id); return; }
            if (node.kind === 'camera') { selectCamera(node.isDefaultCamera ? 'default' : node.path); return; }
            if (node.isEnvironment) { openEnvPopover(); return; }
            if (node.kind === 'light') { openLightInfo(node.path); return; }
            if ((node.kind === 'mesh' || node.kind === 'material') && previewOpenRef.current) previewTreeNode(node, 'swap');
        };
        // Double-click or Enter on a row: the material preview for a mesh or material
        // row, the camera, environment or light info for those; groups toggle open.
        const activateTreeNode = (node) => {
            if (!node) return;
            if (node.isGroup || node.kind === 'xform') { if (node.children.length) toggleTreeExpanded(node.id); return; }
            if (node.kind === 'camera') { selectCamera(node.isDefaultCamera ? 'default' : node.path); return; }
            if (node.isEnvironment) { openEnvPopover(); return; }
            if (node.kind === 'light') { openLightInfo(node.path); return; }
            if (node.kind === 'mesh' || node.kind === 'material') previewTreeNode(node, 'open');
        };
        // Escape clears the selection once no popover or preview claims it first.
        React.useEffect(() => {
            if (!active || !treeSelected || previewOpen || renderSettingsOpen || envPopoverOpen || lightInfoPath || knownIssuesOpen || diagnosticsOpen || recordOpen) return undefined;
            const onKey = (e) => {
                if (e.key !== 'Escape' || e.defaultPrevented) return;
                const tag = e.target && e.target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
                setTreeSelected('');
            };
            window.addEventListener('keydown', onKey);
            return () => window.removeEventListener('keydown', onKey);
        }, [active, treeSelected, previewOpen, renderSettingsOpen, envPopoverOpen, lightInfoPath, knownIssuesOpen, diagnosticsOpen, recordOpen]);
        // Anything that replaces the stage, its handle or its compiled programs
        // closes the material preview, which would otherwise show a stale document.
        React.useEffect(() => { setPreviewOpen(false); }, [stage, handle]);
        React.useEffect(() => {
            if (!handle || typeof handle.onRebuild !== 'function') return undefined;
            return handle.onRebuild(() => setPreviewOpen(false));
        }, [handle]);

        // Page-wide drag & drop: files can drop anywhere, not just a sidebar
        // drop zone. The engine's readDroppedItems (js/mtlx-engine.js:880,
        // used inside useWindowFileDrop) preserves nested directory-relative
        // paths, which the USD loader needs, so no local walker is kept here.
        useWindowFileDrop({
            activeRef,
            onFiles: (map) => { chooseFilesFromMap(map); },
            onDragState: setDragOver,
            disabled: IN_VSCODE,
        });

        const candidates = rootCandidates(files, mitsubaRootPaths);
        const meshes = stageMeshes(stage);
        const cameras = Array.isArray(stage && stage.cameras) ? stage.cameras : [];
        const materials = stageMaterials(stage);
        // A USD root layer always wins over a co-uploaded glTF/OBJ root; the
        // ignored model roots surface here as [info], the same tag prefix
        // severityOf() below already recognizes.
        const ignoredRootWarnings = ignoredModelRoots.map((path) => '[info] Ignored model root (a USD root layer was found): ' + path);
        const warningDetails = warningRecords(materialWarningList(stage).concat(ignoredRootWarnings).concat(handle && Array.isArray(handle.warnings) ? handle.warnings.map(String) : []).concat(loadErrorDetails));
        const warnings = warningDetails.map((record) => record.label);
        // Diagnostics carry no severity of their own, so classify by wording:
        // anything that stopped working is an error, anything that merely
        // reports what we did is info, and the rest stays a warning.
        const severityOf = (text) => {
            const value = String(text || '');
            // An explicit tag from the producer always wins; the wording rules
            // below are only a fallback for messages that carry no tag.
            if (/^\[info\]/.test(value)) return 'info';
            if (/^\[error\]/.test(value)) return 'error';
            if (/(failed|error|could not|cannot|unsupported|invalid|aborted)/i.test(value)) return 'error';
            if (/(applied as the environment|approximated as a point|loaded from|imported from|skipped)/i.test(value)) return 'info';
            return 'warning';
        };
        // One reusable disclosure row: chevron, icon, label, count badge and a
        // copy button that puts the whole group on the clipboard.
        const DiagGroup = ({ id, icon, tone, label, lines, children }) => {
            const open = !!diagOpen[id];
            const [copied, setCopied] = React.useState(false);
            const copy = (event) => {
                event.stopPropagation();
                const text = lines.join('\n');
                const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
                if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => {});
                else {
                    // Clipboard API needs a secure context; fall back so this
                    // still works when the site is served over plain http.
                    const area = document.createElement('textarea');
                    area.value = text; document.body.appendChild(area); area.select();
                    try { document.execCommand('copy'); done(); } catch (e) { /* blocked */ }
                    document.body.removeChild(area);
                }
            };
            return (
                <div className="border-t border-line/60 first:border-t-0">
                    <div className="w-full flex items-center gap-1.5 py-1.5 px-1 -mx-1 rounded hover:bg-hover-subtle/60">
                        <button
                            type="button"
                            onClick={() => setDiagOpen((prev) => ({ ...prev, [id]: !prev[id] }))}
                            aria-expanded={open}
                            className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
                        >
                            <MtlxIcon name={open ? 'chevron-down' : 'chevron-right'} className="w-3.5 h-3.5 shrink-0 text-fg-subtle" />
                            <MtlxIcon name={icon} className={'w-3.5 h-3.5 shrink-0 ' + tone} />
                            <span className={'text-[10px] font-semibold uppercase tracking-[0.08em] ' + tone}>{label}</span>
                            <span className="ml-auto text-[10px] font-mono tabular-nums text-fg-muted bg-surface-raised border border-line rounded-full px-1.5 py-0.5">{lines.length}</span>
                        </button>
                        <button
                            type="button"
                            onClick={copy}
                            title={'Copy all ' + lines.length + ' line(s)'}
                            aria-label={'Copy ' + label}
                            className="shrink-0 p-1 rounded text-fg-subtle hover:text-fg-soft hover:bg-hover"
                        >
                            <MtlxIcon name={copied ? 'copy-check' : 'copy'} className="w-3.5 h-3.5" />
                        </button>
                    </div>
                    {open ? <div className="pb-2 pl-5 space-y-1">{children}</div> : null}
                </div>
            );
        };
        // Warnings that name a render setting link straight to its tab in the popover;
        // the text must match the path the renderer writes into the warning.
        const SETTING_LINKS = [{ text: 'Render settings > Geometry and Textures > Texture memory', tab: 'geometry' }];
        const renderWarningText = (label) => {
            const link = SETTING_LINKS.find((entry) => label.indexOf(entry.text) !== -1);
            if (!link) return label;
            const at = label.indexOf(link.text);
            return (
                <React.Fragment>
                    {label.slice(0, at)}
                    <button type="button" data-testid="usd-scene-warning-setting-link"
                        onClick={() => { setDiagnosticsOpen(false); setRenderTab(link.tab); setRenderSettingsOpen(true); }}
                        title="Open this setting"
                        className="underline decoration-dotted underline-offset-2 hover:text-warning-text-strong text-left break-all">
                        {link.text}
                    </button>
                    {label.slice(at + link.text.length)}
                </React.Fragment>
            );
        };
        const stripTag = (text) => String(text || '').replace(/^\[(?:info|error|warning)\]\s*/, '');
        const grouped = { error: [], warning: [], info: [] };
        warningDetails.forEach((record) => {
            grouped[severityOf(record.raw || record.label)].push(
                Object.assign({}, record, { label: stripTag(record.label), raw: stripTag(record.raw) }));
        });
        const SEVERITY_STYLE = {
            error: { icon: 'alert-triangle', text: 'text-error-text/90', label: 'Errors' },
            warning: { icon: 'alert-triangle', text: 'text-warning/90', label: 'Warnings' },
            info: { icon: 'info-circle', text: 'text-fg-muted', label: 'Info' },
        };
        // SliderField reports the raw input string through onSlider/onNumber
        // (it has no onChange), so every slider coerces and clamps here.
        const applyAoStrength = (raw) => {
            const value = Math.max(0, Math.min(1, Number(raw)));
            if (!Number.isFinite(value)) return;
            setAoStrength(value);
            callHandle('setAmbientOcclusionStrength', value);
        };
        const applyBounceStrength = (raw) => {
            const value = Math.max(0, Math.min(1, Number(raw)));
            if (!Number.isFinite(value)) return;
            setBounceStrength(value);
            callHandle('setSceneBounceStrength', value);
        };
        const applySsrStrength = (raw) => {
            const value = Math.max(0, Math.min(1, Number(raw)));
            if (!Number.isFinite(value)) return;
            setSsrStrength(value);
            callHandle('setScreenSpaceReflectionStrength', value);
        };
        const applySsrMaxRoughness = (raw) => {
            const value = Math.max(0.05, Math.min(1, Number(raw)));
            if (!Number.isFinite(value)) return;
            setSsrMaxRoughness(value);
            callHandle('setScreenSpaceReflectionMaxRoughness', value);
        };
        const applySkyVisStrength = (raw) => {
            const value = Math.max(0, Math.min(1, Number(raw)));
            if (!Number.isFinite(value)) return;
            setSkyVisStrength(value);
            callHandle('setSkyVisibilityStrength', value);
        };
        const applyLocalEnvStrength = (raw) => {
            const value = Math.max(0, Math.min(1, Number(raw)));
            if (!Number.isFinite(value)) return;
            setLocalEnvStrength(value);
            callHandle('setLocalReflectionStrength', value);
        };
        const applyStageLightsEv = (raw) => {
            const value = Math.max(-8, Math.min(8, Number(raw)));
            if (!Number.isFinite(value)) return;
            setStageLightsEv(value);
            callHandle('setStageLightsEv', value);
        };
        const callHandle = (name, ...args) => {
            const fn = handleRef.current && handleRef.current[name];
            if (typeof fn !== 'function') return false;
            try { fn(...args); return true; } catch (e) { setError(String(e && e.message || e)); return false; }
        };
        const refreshPresentation = () => {
            const getter = handleRef.current && handleRef.current.getPresentation;
            if (typeof getter !== 'function') return;
            try { setPresentation(getter()); } catch (e) {}
        };
        const updatePresentation = (patch) => {
            if (callHandle('setPresentation', patch)) refreshPresentation();
        };
        const disposeUnusedEnvironment = (env) => {
            const seen = new Set();
            ['radiance', 'irradiance', 'background'].forEach((name) => {
                const texture = env && env[name];
                if (!texture || seen.has(texture) || typeof texture.dispose !== 'function') return;
                seen.add(texture);
                try { texture.dispose(); } catch (e) {}
            });
        };
        const importEnvironment = async (list) => {
            const generation = ++environmentGenerationRef.current;
            const file = list && list[0];
            if (!file) return;
            const loader = apiFunction('loadEnvironmentFromFile');
            if (typeof loader !== 'function') { setEnvImportError('Environment import is unavailable in this build.'); return; }
            setEnvImportError(null);
            try {
                const env = await loader(file.data || file);
                if (!mountedRef.current || generation !== environmentGenerationRef.current) { disposeUnusedEnvironment(env); return; }
                // setEnvOverride broadcasts to every LIVE_VIEWS member, but an
                // active stage dome ignores broadcasts, so this Scene's own
                // import replaces it explicitly.
                if (apiFunction('setEnvOverride')) apiFunction('setEnvOverride')(env);
                if (domeRotationActiveRef.current) callHandle('setEnvironment', env, { user: true });
                envOverrideRef.current = env;
                currentEnvironmentRef.current = env;
                domeRotationActiveRef.current = false;
                setEnvFileName(file.name || file.path || 'Imported environment');
            } catch (e) { if (mountedRef.current && generation === environmentGenerationRef.current) setEnvImportError(String(e && e.message || e)); }
        };
        const clearImportedEnvironment = async () => {
            const generation = ++environmentGenerationRef.current;
            envOverrideRef.current = null;
            currentEnvironmentRef.current = null;
            setEnvImportError(null);
            const reset = apiFunction('setEnvOverride');
            if (reset) reset(null);
            const getter = apiFunction('getEnvironment');
            if (getter) { try { const env = await getter(); if (mountedRef.current && generation === environmentGenerationRef.current) { currentEnvironmentRef.current = env; callHandle('setEnvironment', env, { user: true }); } } catch (e) {} }
            if (mountedRef.current && generation === environmentGenerationRef.current) setEnvFileName('');
        };
        const resetEnvironment = async () => {
            const generation = ++environmentGenerationRef.current;
            envOverrideRef.current = null;
            currentEnvironmentRef.current = null;
            setEnvImportError(null);
            const reset = apiFunction('setEnvOverride');
            if (reset) reset(null);
            const getter = apiFunction('getEnvironment');
            let env = null;
            if (getter) { try { env = await getter(); } catch (e) {} }
            if (!mountedRef.current || generation !== environmentGenerationRef.current) return;
            // Reset means "back to how this stage was authored", so a stage
            // that supplied a dome light returns to the dome, not to the site
            // default environment.
            const dome = handleRef.current && handleRef.current.getDomeLight && handleRef.current.getDomeLight();
            if (dome && callHandle('applyDomeLight')) {
                currentEnvironmentRef.current = null;
                setEnvFileName(dome.fileName || 'Stage dome light');
                setEnvRotation(Math.round(dome.rotationDeg));
                setEnvExposureLinear(dome.exposure);
                domeRotationActiveRef.current = true;
                return;
            }
            domeRotationActiveRef.current = false;
            if (env) { currentEnvironmentRef.current = env; callHandle('setEnvironment', env, { user: true }); }
            setEnvFileName(''); setEnvRotation(0); setEnvExposureLinear(1); callHandle('setEnvRotation', 0); callHandle('setEnvExposure', 1);
        };
        // The slider always displays and edits the authored degrees (matching
        // the dome light's own rotationDeg label when one is active); only
        // the value sent to the engine goes through the yaw conversion, so
        // the running rotation stays consistent with what seeded it.
        const applyEnvRotation = (v) => {
            const n = Number(v);
            setEnvRotation(n);
            const engineDeg = domeRotationActiveRef.current ? domeYawDegFromRotation(n) : n;
            callHandle('setEnvRotation', engineDeg * Math.PI / 180);
        };
        const setEnvExposureVal = (linear) => { setEnvExposureLinear(linear); callHandle('setEnvExposure', linear); };
        const cancel = () => {
            generationRef.current += 1;
            if (abortRef.current) abortRef.current.abort();
            if (IN_VSCODE) {
                // Also stops the host's file collection and the file fetches,
                // leaving an empty viewport with a Reload action.
                if (typeof window.__mtlxSceneCancel === 'function') window.__mtlxSceneCancel();
                hostPhaseKeyRef.current = '';
                if (handleRef.current && handleRef.current.dispose) handleRef.current.dispose();
                handleRef.current = null; setHandle(null); setStage(null);
                window.__mtlxUsdSceneHandle = null;
            }
            setStatus('cancelled'); setProgress((p) => ({ ...p, message: 'Cancelled' }));
        };
        const reloadFromHost = () => {
            hostPhaseKeyRef.current = '';
            setError('');
            setStatus('host-loading');
            setProgress({ phase: 'collect', fraction: 0, done: 0, total: 0, message: '', label: '', step: '' });
            if (typeof window.__mtlxSceneReload === 'function') window.__mtlxSceneReload();
        };
        // Scene section Reload: the host re-collects in VS Code, the web reloads the same file set.
        const reloadScene = () => {
            if (IN_VSCODE) { reloadFromHost(); return; }
            if (filesRef.current && filesRef.current.length && rootPath) load(filesRef.current, rootPath);
        };
        // WebGL context recovery: a restore re-inits GL state but not render
        // targets or programs, so the stage view rebuilds through Reload.
        const [sceneGlEpoch] = useRenderContextRecovery({
            groups: [[sceneCanvasRef]],
            isHidden: () => !containerRef.current || containerRef.current.getClientRects().length === 0,
            onLost: () => setError(RENDER_CONTEXT_LOST_MESSAGE),
        });
        React.useEffect(() => {
            if (!sceneGlEpoch) return;
            setError('');
            reloadScene();
        }, [sceneGlEpoch]);
        const frameAll = () => { if (handle && handle.frameAll) { handle.frameAll(); if (handle.renderNow) handle.renderNow(); } };
        const selectCamera = (value) => {
            setSelectedCamera(value);
            callHandle('applyCamera', value === 'default' ? null : value);
            if (handle && handle.renderNow) handle.renderNow();
        };
        const [isFullscreen, toggleFullscreen] = useFullscreen(viewportRef);
        const rootBasename = rootPath ? rootPath.split('/').pop() : '';
        const takeScreenshot = () => { if (handleRef.current && handleRef.current.snapshot) downloadSnapshot(handleRef.current, rootBasename || 'usd-scene'); };
        const pickTextureMaxSize = (px) => {
            const value = px === Infinity || String(px).toLowerCase() === 'infinity' ? Infinity : Number(px);
            if (!callHandle('setTextureMaxSize', value) && typeof setStoredSceneTextureMaxSize === 'function') {
                setStoredSceneTextureMaxSize(value);
            }
            setTextureSizeTick((t) => t + 1);
        };
        const pickTextureBudgetGib = (gib) => {
            const bytes = Number(gib) * 1024 * 1024 * 1024;
            if (!callHandle('setTextureBudgetBytes', bytes) && typeof setStoredSceneTextureBudgetBytes === 'function') {
                setStoredSceneTextureBudgetBytes(bytes);
            }
            setTextureSizeTick((t) => t + 1);
        };
        const pickSubdivisionLevel = (level) => {
            const next = Number(level);
            setSubdivisionLevel(next);
            subdivisionLevelRef.current = next;
            if (typeof setStoredSceneSubdivisionLevel === 'function') setStoredSceneSubdivisionLevel(next);
            if (files.length && rootPath) load();
        };
        const pickDisplacementSubdivisionOverride = (value) => {
            const next = value === 'follow' ? 'follow' : Number(value);
            setDisplacementSubdivisionOverrideState(next);
            displacementSubdivisionRef.current = next;
            if (typeof setStoredSceneDisplacementSubdivision === 'function') setStoredSceneDisplacementSubdivision(next);
            callHandle('setDisplacementSubdivisionOverride', next);
        };
        const pickTriangleLimits = (enabled) => {
            const next = enabled !== false;
            setTriangleLimitsState(next);
            triangleLimitsRef.current = next;
            if (typeof setStoredSceneTriangleLimits === 'function') setStoredSceneTriangleLimits(next);
            callHandle('setTriangleLimits', next);
            if (files.length && rootPath) load();
        };
        const textureMaxSize = (handle && typeof handle.getTextureMaxSize === 'function')
            ? handle.getTextureMaxSize()
            : sceneStored('textureMaxSize');
        const textureBudgetGib = (handle && typeof handle.getTextureBudgetBytes === 'function')
            ? Math.round(handle.getTextureBudgetBytes() / (1024 * 1024 * 1024))
            : sceneStored('textureBudgetGib');
        // Referenced so the memo below re-reads getTextureMaxSize() after a
        // mutation that doesn't otherwise touch React state.
        void textureSizeTick;

        // Every governed value, read the same way the popover controls read
        // them today (live handle first, stored fallback otherwise).
        const currentQualityValues = {
            textureMaxSize: Number(textureMaxSize), textureBudgetGib: Number(textureBudgetGib), subdivision: Number(subdivisionLevel),
            shadows: shadowsOn, ao: aoOn, skyVis: skyVisOn, transparency: sceneTransparency,
            displacement: displacementEnabled, displacementSubdivision: displacementSubdivisionOverride,
            triangleLimits, bounce: bounceOn, localReflections: localEnvOn, specularAA: specularAAOn,
        };
        const QUALITY_GOVERNED_KEYS = Object.keys(currentQualityValues);
        // Live keys: every other popover row. Same shape as captureLiveSnapshot
        // below (which just copies this), read straight off React state.
        const currentLiveValues = {
            displayTransform, materialWorkspace, displayExposure, presentation,
            stageLightsOn, stageLightsEv, aoStrength, bounceStrength, skyVisStrength,
            localEnvStrength, ssrOn, ssrStrength, ssrMaxRoughness, diffuseEnvConvolve,
        };
        const ALL_QUALITY_KEYS = QUALITY_GOVERNED_KEYS.concat(LIVE_QUALITY_KEYS);
        // Exact match first (handles Infinity, matching strings/booleans).
        // Numbers compare with an epsilon (slider drift/float rounding).
        // The one object value (presentation) compares field by field over
        // b's keys, never JSON.stringify: key order or an extra field on a
        // (e.g. a hardware-derived flag) must not fake a difference.
        const valuesEqual = (a, b) => {
            if (a === b) return true;
            if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
            if (a && b && typeof a === 'object') return Object.keys(b).every((k) => valuesEqual(a[k], b[k]));
            return false;
        };
        // "Custom" is derived, never stored: the active level is the stored
        // id (inferred by exact match the first time, else 'default'), and
        // overrides are every governed key (staged or live) that no longer
        // matches it.
        const selectedQualityId = (() => {
            const stored = window.MtlxRenderSettings.getStoredLevel('scene');
            if (SCENE_QUALITY_LEVELS.some((entry) => entry.id === stored)) return stored;
            const inferred = SCENE_QUALITY_LEVELS.find((level) =>
                QUALITY_GOVERNED_KEYS.every((key) => currentQualityValues[key] === level.values[key])
                && LIVE_QUALITY_KEYS.every((key) => valuesEqual(currentLiveValues[key], level.values[key])));
            return inferred ? inferred.id : 'default';
        })();
        const selectedQualityLevel = SCENE_QUALITY_LEVELS.find((entry) => entry.id === selectedQualityId);
        // One forced-apply dispatcher for Reset and the preset segments
        // (the places that move live keys): reuses each row's own handler.
        const forceLiveValue = (key, value) => {
            if (key === 'displayTransform') return pickDisplayTransform(value);
            if (key === 'materialWorkspace') return pickMaterialWorkspace(value);
            if (key === 'displayExposure') return applyDisplayExposure(value);
            if (key === 'presentation') return updatePresentation(value);
            if (key === 'stageLightsOn') return setStageLightsOnValue(value);
            if (key === 'stageLightsEv') return applyStageLightsEv(value);
            if (key === 'aoStrength') return applyAoStrength(value);
            if (key === 'bounceStrength') return applyBounceStrength(value);
            if (key === 'skyVisStrength') return applySkyVisStrength(value);
            if (key === 'localEnvStrength') return applyLocalEnvStrength(value);
            if (key === 'ssrOn') return setSsrOnValue(value);
            if (key === 'ssrStrength') return applySsrStrength(value);
            if (key === 'ssrMaxRoughness') return applySsrMaxRoughness(value);
            if (key === 'diffuseEnvConvolve') return setDiffuseEnvConvolveValue(value);
        };
        // Shared with restoreLiveSnapshot and forceLiveValue: the three live
        // toggles whose onChange body is more than one call, factored once
        // instead of copied at each of their three call sites.
        const setStageLightsOnValue = (next) => { setStageLightsOn(next); callHandle('setStageLightsEnabled', next); sceneWrite('stageLightsOn', next); };
        const setSsrOnValue = (next) => { setSsrOn(next); callHandle('setScreenSpaceReflections', next); sceneWrite('ssrOn', next); };
        const setDiffuseEnvConvolveValue = (next) => {
            setDiffuseEnvConvolveState(next);
            sceneWrite('diffuseEnv', next ? 'convolve' : 'sh');
            if (currentEnvironmentRef.current) callHandle('setEnvironment', currentEnvironmentRef.current, { user: true });
        };
        // No stage handle yet: persist-only, like every governed handler
        // without a handle; the store write is what the next load reads.
        const persistSceneSettingsForNextLoad = (diff) => {
            if ('textureMaxSize' in diff && typeof setStoredSceneTextureMaxSize === 'function') setStoredSceneTextureMaxSize(diff.textureMaxSize);
            if ('textureBudgetGib' in diff && typeof setStoredSceneTextureBudgetBytes === 'function') setStoredSceneTextureBudgetBytes(diff.textureBudgetGib * 1024 * 1024 * 1024);
            ['shadows', 'ao', 'skyVis', 'specularAA', 'bounce', 'localReflections'].forEach((key) => { if (key in diff) sceneWrite(key, diff[key]); });
            if ('triangleLimits' in diff && typeof setStoredSceneTriangleLimits === 'function') setStoredSceneTriangleLimits(diff.triangleLimits);
            if ('displacementSubdivision' in diff && typeof setStoredSceneDisplacementSubdivision === 'function') setStoredSceneDisplacementSubdivision(diff.displacementSubdivision);
            if ('subdivision' in diff && typeof setStoredSceneSubdivisionLevel === 'function') setStoredSceneSubdivisionLevel(diff.subdivision);
            if ('displacement' in diff) sceneWrite('displacement', diff.displacement);
            if ('transparency' in diff && window.setUsdSceneTransparency) window.setUsdSceneTransparency(diff.transparency);
            return { reload: false, rebuild: false, geometry: false };
        };
        // Shared apply path for the toolbar's immediate preset and the
        // popover's Apply: one applySceneSettings call, state sync, reload
        // only if asked.
        const commitQualitySettings = (diff, id) => {
            if (id) window.MtlxRenderSettings.markLevel('scene', id);
            if (!Object.keys(diff).length) return { reload: false, rebuild: false, geometry: false, reloadPromise: null };
            const result = (handle && typeof handle.applySceneSettings === 'function')
                ? handle.applySceneSettings(diff)
                : persistSceneSettingsForNextLoad(diff);
            if ('textureMaxSize' in diff || 'textureBudgetGib' in diff) setTextureSizeTick((t) => t + 1);
            if ('shadows' in diff) setShadowsOn(diff.shadows);
            if ('ao' in diff) setAoOn(diff.ao);
            if ('skyVis' in diff) setSkyVisOn(diff.skyVis);
            if ('transparency' in diff) setSceneTransparencyState(diff.transparency);
            if ('displacement' in diff) setDisplacementEnabledState(diff.displacement);
            if ('displacementSubdivision' in diff) {
                setDisplacementSubdivisionOverrideState(diff.displacementSubdivision);
                displacementSubdivisionRef.current = diff.displacementSubdivision;
            }
            if ('triangleLimits' in diff) { setTriangleLimitsState(diff.triangleLimits); triangleLimitsRef.current = diff.triangleLimits; }
            if ('bounce' in diff) setBounceOn(diff.bounce);
            if ('localReflections' in diff) setLocalEnvOn(diff.localReflections);
            if ('specularAA' in diff) setSpecularAAOn(diff.specularAA);
            if ('subdivision' in diff) { setSubdivisionLevel(diff.subdivision); subdivisionLevelRef.current = diff.subdivision; }
            if (result && (result.reload || result.rebuild || result.geometry)) setPreviewOpen(false);
            const reloadPromise = (result && result.reload && files.length && rootPath) ? load() : null;
            return Object.assign({ reload: false, rebuild: false, geometry: false }, result, { reloadPromise });
        };
        // Draft model for the popover: governed rows edit `qualityDraft`
        // (null until first touched) instead of calling their handlers;
        // nothing reaches the renderer until Apply.
        const draftLevel = qualityDraft ? SCENE_QUALITY_LEVELS.find((entry) => entry.id === qualityDraft.qualityId) : selectedQualityLevel;
        const draftValues = qualityDraft ? qualityDraft.values : currentQualityValues;
        // Value a row actually shows: the draft for a staged key, the live
        // current value for a live key (live keys are never staged).
        const rowValue = (key) => (LIVE_QUALITY_KEYS.includes(key) ? currentLiveValues[key] : draftValues[key]);
        const draftAllOverrides = draftLevel ? ALL_QUALITY_KEYS.filter((key) => !valuesEqual(rowValue(key), draftLevel.values[key])) : [];
        // Staged-only overrides: drives the popover's own segmented control,
        // which only ever stages (never reflects live-key drift).
        const draftStagedOverrides = draftLevel ? QUALITY_GOVERNED_KEYS.filter((key) => draftValues[key] !== draftLevel.values[key]) : [];
        const draftDiff = {};
        QUALITY_GOVERNED_KEYS.forEach((key) => { if (draftValues[key] !== currentQualityValues[key]) draftDiff[key] = draftValues[key]; });
        const draftDirty = Object.keys(draftDiff).length > 0;
        // Enabled whenever ANY key (staged or live) differs from the level.
        const draftResetDirty = draftAllOverrides.length > 0;
        // Dev aid: with mtlxDebugShaders on, print exactly which key(s) made
        // Reset dirty and both of their values, so a report of "Reset is
        // enabled with no dots" can be checked against real data instead of
        // re-deriving this comparison by hand.
        const draftOverridesKey = draftAllOverrides.join(',');
        React.useEffect(() => {
            let debugOn = false;
            try { debugOn = localStorage.getItem('mtlxDebugShaders') === '1'; } catch (e) { /* privacy mode */ }
            if (!debugOn || !draftOverridesKey || !draftLevel) return;
            console.log('[usd-scene] Reset dirty vs "' + draftLevel.id + '":', draftOverridesKey.split(',').map((key) => ({
                key, current: rowValue(key), level: draftLevel.values[key],
            })));
        }, [draftOverridesKey, draftLevel]);
        const draftCost = (typeof describeSceneSettingsCost === 'function')
            ? describeSceneSettingsCost(currentQualityValues, draftDiff)
            : { reload: false, rebuild: false, geometry: false };
        const stageQualityValue = (key, value) => {
            setQualityDraft((d) => {
                const base = d || { qualityId: selectedQualityId, values: { ...currentQualityValues } };
                return { qualityId: base.qualityId, values: { ...base.values, [key]: value } };
            });
        };
        const stageQualityLevel = (id) => {
            const level = SCENE_QUALITY_LEVELS.find((entry) => entry.id === id);
            if (!level) return;
            setQualityDraft({ qualityId: id, values: { ...level.values } });
            // Live keys are never staged (a row's value comes straight off
            // live state, see rowValue above), so a preset pick must force
            // them immediately too — otherwise a row like Sky visibility
            // strength or Stage light intensity keeps its old value while
            // the segmented control already shows the new preset picked.
            // Exactly what Reset already does for live keys.
            LIVE_QUALITY_KEYS.forEach((key) => {
                if (!valuesEqual(currentLiveValues[key], level.values[key])) forceLiveValue(key, level.values[key]);
            });
        };
        const captureLiveSnapshot = () => ({ ...currentLiveValues });
        // Restores every live control through its existing handler (same
        // dispatcher Reset and the toolbar menu use); nothing duplicated here.
        const restoreLiveSnapshot = (snap) => {
            if (!snap) return;
            LIVE_QUALITY_KEYS.forEach((key) => forceLiveValue(key, snap[key]));
        };
        // One editing session per popover visit: taken only when none is in
        // progress, cleared by Apply/Cancel, so close-and-reopen restores
        // from when the session began, not from the last reopen.
        React.useEffect(() => {
            if (renderSettingsOpen && !liveSnapshot) setLiveSnapshot(captureLiveSnapshot());
        }, [renderSettingsOpen, liveSnapshot]);
        const lastCurrentQualityRef = React.useRef(currentQualityValues);
        // currentQualityValues is a fresh object every render, so this still
        // runs each time one of its fields actually changes; the dep array
        // just documents that (and drops the effect on unrelated renders,
        // e.g. a plain slider drag that never touches a governed key).
        React.useEffect(() => {
            const prev = lastCurrentQualityRef.current;
            if (qualityDraft) {
                let next = null;
                QUALITY_GOVERNED_KEYS.forEach((key) => {
                    if (currentQualityValues[key] !== prev[key] && qualityDraft.values[key] === prev[key]) {
                        next = next || { ...qualityDraft.values };
                        next[key] = currentQualityValues[key];
                    }
                });
                if (next) setQualityDraft((d) => (d ? { qualityId: d.qualityId, values: next } : d));
            }
            lastCurrentQualityRef.current = currentQualityValues;
        }, [currentQualityValues, qualityDraft]);
        const applyQualityDraft = () => {
            if (!draftDirty) return;
            // No scene loaded: nothing to reload, recompile or rebuild, so
            // commitQualitySettings already falls through to the persist-only
            // path below; just skip the "Applying ..." label for it too.
            if (hasStage) setPresetApplying(draftStagedOverrides.length ? 'Custom' : (draftLevel ? draftLevel.label : 'Custom'));
            const id = qualityDraft ? qualityDraft.qualityId : selectedQualityId;
            const { reloadPromise } = commitQualitySettings(draftDiff, id);
            const applied = { ...draftValues };
            setQualityDraft({ qualityId: id, values: applied });
            setLiveSnapshot(null); // ends the editing session, live keys were left alone
            if (reloadPromise) reloadPromise.finally(() => setPresetApplying(null));
            else setPresetApplying(null);
        };
        const cancelQualityDraft = () => {
            restoreLiveSnapshot(liveSnapshot);
            setLiveSnapshot(null);
            setQualityDraft(null);
            setRenderSettingsOpen(false);
        };
        // Forces every key (staged and live) to the selected level's values:
        // staged goes into the draft, live goes through forceLiveValue so
        // sliders visibly move right away.
        const resetQualityDraft = () => {
            if (!draftLevel) return;
            const id = qualityDraft ? qualityDraft.qualityId : selectedQualityId;
            setQualityDraft({ qualityId: id, values: { ...draftLevel.values } });
            LIVE_QUALITY_KEYS.forEach((key) => { if (!valuesEqual(currentLiveValues[key], draftLevel.values[key])) forceLiveValue(key, draftLevel.values[key]); });
        };
        // Plain sentence for the footer: nothing when no staged change is
        // pending, else the pending count plus what Apply will actually do.
        const footerHintText = () => {
            const n = Object.keys(draftDiff).length;
            if (!n) return '';
            const count = n + ' change' + (n === 1 ? '' : 's') + '.';
            if (!hasStage) return count + ' Applies when a scene is loaded';
            const action = draftCost.reload ? 'Applying will reload the stage'
                : draftCost.rebuild ? 'Applying will recompile materials'
                : draftCost.geometry ? 'Applying will rebuild geometry'
                : 'Applying will apply instantly';
            return count + ' ' + action;
        };
        const qualitySummaryText = () => {
            const v = draftValues;
            const parts = [
                (v.textureMaxSize === Infinity ? 'Original' : v.textureMaxSize + 'px') + ' textures',
                v.textureBudgetGib + ' GB',
                v.subdivision ? ('subdivision ' + v.subdivision) : 'no subdivision',
                v.displacement ? 'displacement on' : 'displacement off',
                (v.shadows && v.ao) ? 'shadows and ambient occlusion on' : (v.shadows ? 'shadows on' : (v.ao ? 'ambient occlusion on' : 'shadows and ambient occlusion off')),
            ];
            return parts.join(', ');
        };

        const fraction = progress.fraction;
        const phaseLabels = { ...Object.fromEntries(USD_SCENE_LOAD_PHASES.map((entry) => [entry.phase, entry.label])), 'gpu-program': 'Checking GPU programs' };
        const phaseIndex = USD_SCENE_LOAD_PHASES.findIndex((entry) => entry.phase === progress.phase);
        const phaseCount = USD_SCENE_LOAD_PHASES.length;
        const stepPrefix = phaseIndex >= 0 ? ('Step ' + (phaseIndex + 1) + '/' + phaseCount + ': ') : '';
        const progressLabel = stepPrefix + (phaseLabels[progress.phase] || (progress.phase ? progress.phase.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : (status === 'rendered' ? 'Ready' : 'Loading')));
        const progressText = progress.total ? (progress.done + '/' + progress.total) : (/texture|material/i.test(progress.phase) ? '' : progress.message);
        // Second, dimmer overlay line: the current item within the phase.
        const RENDERER_STEP_LABELS = { 'shadow-atlas': 'Building shadow atlas', 'sky-visibility': 'Baking sky visibility', 'occlusion-volume': 'Baking occlusion volume', 'shader-join': 'Finishing shader compiles', 'gpu-program': 'Checking GPU programs', 'first-frame': 'Rendering first frame' };
        const progressDetail = progress.phase === 'renderer' ? (RENDERER_STEP_LABELS[progress.step] || '') : (progress.label || '');
        const busy = status === 'loading' || status === 'loaded' || status === 'host-loading';
        const canTuneEnvironment = !!handle && typeof handle.setEnvRotation === 'function';
        const envSummary = (envRotation === 0 && envExposureLinear === 1)
            ? 'Default environment'
            : Math.round(envRotation) + '°, ' + formatEv(linearToEv(envExposureLinear));
        const renderedPrimCount = (handle && Array.isArray(handle.prims)) ? handle.prims.length : meshes.length;
        const triangleCount = stageTriangleCount(stage);
        const hasStage = !!stage || files.length > 0;
        // Statistics: the objects under Scene (the same number the Hierarchy section shows),
        // and the meshes the eye toggles leave visible.
        const objectCount = sceneTree ? sceneTree.count : 0;
        const hiddenRenderPaths = new Set(treeHidden.size ? sceneTreeHiddenRenderPaths(sceneTree, treeHidden) : []);
        const visibleMeshCount = meshes.filter((mesh) => !hiddenRenderPaths.has(String((mesh && (mesh.instanceOwnerPath || mesh.primPath)) || ''))).length;
        // Scene section facts. glTF is meters and Y up by definition; OBJ declares neither.
        // A reload of the same files keeps the last stage's facts on screen, so its
        // Cancel button takes the Reload button's place instead of jumping up.
        const lastCardStageRef = React.useRef(null);
        if (stage) lastCardStageRef.current = { stage, files, rootPath };
        const lastCard = lastCardStageRef.current;
        const cardStage = stage || (busy && lastCard && lastCard.files === files && lastCard.rootPath === rootPath ? lastCard.stage : null);
        const sceneKind = isUsdRootPath(rootPath) ? 'usd' : (/\.(glb|gltf)$/i.test(rootPath) ? 'gltf' : (/\.obj$/i.test(rootPath) ? 'obj' : (/\.pbrt$/i.test(rootPath) ? 'pbrt' : (/\.xml$/i.test(rootPath) ? 'mitsuba' : ''))));
        const sceneFormat = sceneFormatLabel(rootPath, rootUsdBinary);
        const sceneBytes = files.reduce((sum, file) => sum + sceneFileBytes(file), 0);
        const sceneMissing = cardStage
            ? Array.from(new Set(stageMissingEntries(cardStage).concat(renderMissingEntries(handle, rootPath)).map((entry) => String(entry.asset).replace(/\\/g, '/'))))
            : [];
        const sceneAuthored = (cardStage && cardStage.metricsAuthored) || {};
        const usdDefault = (text, authored) => (text && authored === false ? text + ' (USD default)' : text);
        const sceneUnits = !cardStage ? '' : (sceneKind === 'gltf' ? 'Meters'
            : (sceneKind === 'usd' ? usdDefault(sceneUnitsLabel(cardStage.metersPerUnit), sceneAuthored.metersPerUnit) : ''));
        const sceneUpAxis = !cardStage ? '' : (sceneKind === 'gltf' ? 'Y'
            : (sceneKind === 'usd' ? usdDefault(String(cardStage.upAxis || '').toUpperCase(), sceneAuthored.upAxis) : ''));
        const sceneFilesText = files.length + ' file' + (files.length === 1 ? '' : 's') + ', ' + formatByteSize(sceneBytes);
        // VS Code test seam: bootstrap.js defines __mtlxSceneReport only for
        // the extension's test transport; one report per settled load.
        React.useEffect(() => {
            if (!IN_VSCODE || typeof window.__mtlxSceneReport !== 'function') return;
            if (status !== 'rendered' && status !== 'error') return;
            const errorLines = warnings.filter((label) => severityOf(label) === 'error');
            window.__mtlxSceneReport({
                status, root: rootPath, files: files.length, prims: renderedPrimCount, meshes: meshes.length, materials: materials.length,
                hostSeq: hostLoadRef.current ? hostLoadRef.current.seq : 0, hostRound: hostLoadRef.current ? hostLoadRef.current.round : 0,
                warnings: warnings.filter((label) => severityOf(label) === 'warning').length,
                errors: errorLines.length + (status === 'error' ? 1 : 0),
                error: status === 'error' ? error : '',
                sample: errorLines.concat(warnings).slice(0, 5),
                rootSelectVisible: !!document.querySelector('[data-testid="usd-scene-root-select"]'),
                previewOpen, treeNodes: objectCount,
                treeMaterials: sceneTree ? sceneTree.materialCount : 0, treeCameras: sceneTree ? sceneTree.cameraCount : 0, treeLights: sceneTree ? sceneTree.lightCount : 0,
                visibleMeshes: visibleMeshCount,
                // What the Scene section shows; inDom is false only while the sidebar is collapsed.
                sceneCard: {
                    file: rootBasename, format: sceneFormat, files: files.length, bytes: sceneBytes, missing: sceneMissing.length,
                    units: sceneUnits, upAxis: sceneUpAxis, cameraOptions: stage ? cameras.length + 1 : 0,
                    sidebarOpen: sidebarOpenRef.current,
                    inDom: !!document.querySelector('[data-testid="usd-scene-info"]'),
                    fileText: (document.querySelector('[data-testid="usd-scene-info-file"]') || {}).textContent || '',
                    filesText: (document.querySelector('[data-testid="usd-scene-info-files"]') || {}).textContent || '',
                },
            });
        }, [status]);

        const RENDER_TAB_LABELS = { display: 'Display', lighting: 'Lighting', effects: 'Effects', geometry: 'Geometry and Textures' };
        // Hands the draft/apply model to the shared manifest rows
        // (RenderSettingsSection). Governed rows stage into the draft, live
        // rows apply instantly through their own handlers.
        const rowQualityKey = (row) => SCENE_QUALITY_KEY_OF[row.key] || row.key;
        const sceneRowBinding = {
            value: (row) => {
                const field = SCENE_PRESENTATION_FIELD_OF[row.key];
                if (field) return row.key === 'hdrView' ? (presentation.debugView || 'final') : presentation[field];
                switch (row.key) {
                    case 'hdrPresentation': return !!presentation.enabled;
                    case 'displayTransform': return displayTransform;
                    case 'materialWorkspace': return materialWorkspace;
                    case 'displayExposure': return displayExposure;
                    case 'stageLightsOn': return stageLightsOn;
                    case 'stageLightsEv': return stageLightsEv;
                    case 'skyVisStrength': return skyVisStrength;
                    case 'aoStrength': return aoStrength;
                    case 'bounceStrength': return bounceStrength;
                    case 'localEnvStrength': return localEnvStrength;
                    case 'ssrOn': return ssrOn;
                    case 'ssrStrength': return ssrStrength;
                    case 'ssrMaxRoughness': return ssrMaxRoughness;
                    case 'diffuseEnv': return diffuseEnvConvolve ? 'convolve' : 'sh';
                    case 'textureAnisotropy': return textureAnisotropy;
                    default: return draftValues[row.key];
                }
            },
            onChange: (row, next) => {
                const field = SCENE_PRESENTATION_FIELD_OF[row.key];
                if (field) return updatePresentation({ [field]: next });
                switch (row.key) {
                    case 'hdrPresentation': return updatePresentation({ enabled: next });
                    case 'displayTransform': return pickDisplayTransform(next);
                    case 'materialWorkspace': return pickMaterialWorkspace(next);
                    case 'displayExposure': return applyDisplayExposure(next);
                    case 'stageLightsOn': return setStageLightsOnValue(next);
                    case 'stageLightsEv': return applyStageLightsEv(next);
                    case 'skyVisStrength': return applySkyVisStrength(next);
                    case 'aoStrength': return applyAoStrength(next);
                    case 'bounceStrength': return applyBounceStrength(next);
                    case 'localEnvStrength': return applyLocalEnvStrength(next);
                    case 'ssrOn': return setSsrOnValue(next);
                    case 'ssrStrength': return applySsrStrength(next);
                    case 'ssrMaxRoughness': return applySsrMaxRoughness(next);
                    case 'diffuseEnv': return setDiffuseEnvConvolveValue(next === 'convolve');
                    case 'textureAnisotropy': setTextureAnisotropyState(Number(next)); return sceneWrite('textureAnisotropy', Number(next));
                    case 'subdivision': return stageQualityValue('subdivision', Number(next));
                    case 'displacementSubdivision': return stageQualityValue('displacementSubdivision', next === 'follow' ? 'follow' : Number(next));
                    case 'triangleLimits': return stageQualityValue('triangleLimits', next !== false);
                    default: return stageQualityValue(row.key, next);
                }
            },
            visible: (row) => {
                switch (row.key) {
                    case 'stageLightsEv': return stageLightsOn;
                    case 'skyVisStrength': return skyVisOn;
                    case 'aoStrength': return aoOn;
                    case 'bounceStrength': return bounceOn;
                    case 'localEnvStrength': return localEnvOn;
                    case 'ssrOn': return !SSR_ROWS_HIDDEN;
                    case 'ssrStrength': case 'ssrMaxRoughness': return !SSR_ROWS_HIDDEN && ssrOn;
                    case 'bloomStrength': case 'bloomThreshold': case 'bloomKnee': case 'bloomRadius':
                        return !!(presentation.enabled && presentation.bloom && presentation.supported);
                    case 'hdrView': return !!presentation.supported;
                    default: return true;
                }
            },
            disabled: (row) => {
                switch (row.key) {
                    case 'hdrPresentation': return !handle || !presentation.supported;
                    case 'bloom': return !handle || !presentation.enabled || !presentation.supported;
                    case 'hdrView': return !handle;
                    case 'textureMaxSize': case 'textureBudgetGib': case 'subdivision': case 'displacementSubdivision': case 'triangleLimits': return busy;
                    default: return false;
                }
            },
            dirty: (row) => {
                const field = SCENE_PRESENTATION_FIELD_OF[row.key];
                if (field) return !valuesEqual(row.key === 'hdrView' ? (presentation.debugView || 'final') : presentation[field], SCENE_PRESENTATION_DEFAULT[field]);
                const key = rowQualityKey(row);
                return ALL_QUALITY_KEYS.includes(key) && !!draftLevel && !valuesEqual(rowValue(key), draftLevel.values[key]);
            },
            cost: (row) => settingsCostKind(row.key),
            pending: (row) => hasStage && row.key in draftDiff,
            defaultValue: (row) => {
                const field = SCENE_PRESENTATION_FIELD_OF[row.key];
                if (field) return SCENE_PRESENTATION_DEFAULT[field];
                return draftLevel && draftLevel.values[rowQualityKey(row)];
            },
            hint: (row) => (row.key === 'stageLightsOn'
                ? (stageLightInfo.count || 0) + ' light(s) imported from the stage. Area lights are split into several point samples across their surface, sharing the emitter\'s power.'
                : null),
            title: (row) => {
                switch (row.key) {
                    case 'displayTransform': return 'This is the Scene\'s own setting; the Material Viewer keeps sRGB.';
                    case 'materialWorkspace': return 'This is the Scene\'s own setting; the Material Viewer, Compare, Builder and Graph previews always assume Rec.709.';
                    case 'specularAA': return draftValues.specularAA ? 'Turn off geometric specular anti-aliasing' : 'Widen specular roughness where it is changing fast on screen';
                    case 'stageLightsOn': return stageLightsOn ? 'Ignore the lights authored on this stage' : 'Light the stage with its own lights';
                    case 'shadows': return draftValues.shadows ? 'Turn shadows off' : 'Cast shadows from the brightest light';
                    case 'skyVis': return draftValues.skyVis ? 'Turn baked sky visibility off' : 'Let room geometry block the environment light';
                    case 'ao': return draftValues.ao ? 'Turn ambient occlusion off' : 'Occlude environment light in creases and corners';
                    case 'bounce': return draftValues.bounce ? 'Turn the baked diffuse bounce off' : 'Bounce blocked sky light back off nearby surfaces';
                    case 'localReflections': return draftValues.localReflections ? 'Turn the local reflection capture off' : 'Reflect the captured studio set instead of only the environment';
                    case 'ssrOn': return ssrOn ? 'Turn screen-space reflections off' : 'Reflect the scene colour in specular through a screen-space trace';
                    case 'transparency': return draftValues.transparency ? 'Disable scene material transparency' : 'Enable scene material transparency';
                    case 'diffuseEnv': return diffuseEnvConvolve ? 'Use the second-order spherical harmonic fit instead' : 'Cosine-convolve the environment on the GPU instead';
                    case 'displacement': return draftValues.displacement ? 'Disable displacement' : 'Enable displacement';
                    case 'hdrView': return handle ? undefined : 'Load a stage first';
                    default: return undefined;
                }
            },
        };
        // Environment popover and sidebar backdrop: view state, not staged.
        const envRowBinding = {
            value: (row) => (row.key === 'envRotation' ? envRotation
                : row.key === 'envExposure' ? linearToEv(envExposureLinear)
                : !!sceneStored('keyLight')),
            onChange: (row, next) => {
                if (row.key === 'envRotation') applyEnvRotation(next);
                else if (row.key === 'envExposure') setEnvExposureVal(evToLinear(next));
                else { sceneWrite('keyLight', next); callHandle('refreshKeyLight'); }
            },
            disabled: (row) => (row.key === 'keyLight' ? false : !canTuneEnvironment),
            defaultValue: () => 0,
            title: (row) => (row.key === 'keyLight' ? row.hint : undefined),
        };
        const backdropRowBinding = {
            value: () => backdrop,
            onChange: (row, next) => { setBackdrop(next); callHandle('setBackdrop', next); },
            disabled: () => !handle || typeof handle.setBackdrop !== 'function',
            title: () => (handle ? undefined : 'Load a scene first'),
            testId: () => 'usd-scene-backdrop-select',
        };
        const renderDisplayTab = () => (
            <RenderSettingsSection surface="scene" groups={['display']} exclude={['backdrop']} variant="panel" draft={sceneRowBinding} />
        );
        const renderLightingTab = () => (
            <RenderSettingsSection surface="scene" groups={['lighting']} exclude={['envRotation', 'envExposure', 'keyLight']} variant="panel" draft={sceneRowBinding} />
        );
        const renderEffectsTab = () => (
            <RenderSettingsSection surface="scene" groups={['effects']} variant="panel" draft={sceneRowBinding} />
        );
        const renderGeometryTab = () => (
            <RenderSettingsSection surface="scene" groups={['geometry']} variant="panel" draft={sceneRowBinding} />
        );
        // The Diagnostics button carries the count and the icon of the most severe
        // message, so problems show next to Statistics while the popover is closed.
        const topSeverity = ['error', 'warning', 'info'].find((severity) => grouped[severity].length) || '';
        const diagnosticsContent = warnings.length || transparentPrims.length ? (
            <div data-testid="usd-material-warnings">
                {['error', 'warning', 'info'].map((severity) => {
                    const records = grouped[severity];
                    if (!records.length) return null;
                    const style = SEVERITY_STYLE[severity];
                    return (
                        <DiagGroup
                            key={severity}
                            id={severity}
                            icon={style.icon}
                            tone={style.text}
                            label={style.label}
                            lines={records.map((record) => record.label)}
                        >
                            {records.map((record, i) => (
                                <div key={severity + i} className={'font-mono text-xs break-all ' + style.text}>{renderWarningText(record.label)}</div>
                            ))}
                        </DiagGroup>
                    );
                })}
                {transparentPrims.length ? (
                    <DiagGroup
                        id="transparent"
                        icon="color-filter"
                        tone="text-info/90"
                        label="Transparency"
                        lines={transparentPrims.map((entry) => entry.primPath + ' [' + entry.materialPath + ']')}
                    >
                        {transparentPrims.map((entry, i) => (
                            <div key={'t' + i} className="font-mono text-xs break-all text-info/90">
                                {entry.primPath}
                                <span className="text-fg-subtle"> [{entry.materialPath}]</span>
                            </div>
                        ))}
                    </DiagGroup>
                ) : null}
                {materials.length ? (
                    <DiagGroup
                        id="materials"
                        icon="file-text"
                        tone="text-fg-subtle"
                        label="Material sources"
                        lines={materials.map((material) => String(material.materialX && material.materialX.path || material.sourceAsset || material.path || 'Material source unavailable'))}
                    >
                        {materials.map((material, i) => (
                            <div key={'m' + i} className="text-fg-muted font-mono text-xs break-all">
                                {String(material.materialX && material.materialX.path || material.sourceAsset || material.path || 'Material source unavailable')}
                            </div>
                        ))}
                    </DiagGroup>
                ) : null}
            </div>
        ) : (
            <div className="py-1 text-xs text-fg-subtle">No warnings.</div>
        );
        const statisticsRows = [
            ['Objects', objectCount.toLocaleString(), 'usd-stage-nodes', 'Every item under Scene in the hierarchy'],
            ['Meshes', meshes.length.toLocaleString(), 'usd-stage-meshes'],
            ['Triangles', triangleCount.toLocaleString(), 'usd-stage-triangles'],
            ['Materials', (sceneTree ? sceneTree.materialCount : materials.length).toLocaleString(), 'usd-stage-materials', 'Every item under Materials in the hierarchy'],
            ['Visible meshes', visibleMeshCount.toLocaleString(), 'usd-stage-visible-meshes', 'Meshes not hidden in the hierarchy'],
            // Warnings + errors only: [info] notes (e.g. "Loaded from...")
            // are not problems, so they don't belong in this count even
            // though the Diagnostics popover lists them in their own group.
            ['Warnings', (grouped.warning.length + grouped.error.length).toLocaleString(), 'usd-stage-warnings'],
        ];
        const SEVERITY_NOUNS = { error: ['error', 'errors'], warning: ['warning', 'warnings'], info: ['info', 'info'] };
        const diagnosticsSummary = ['error', 'warning', 'info']
            .filter((severity) => grouped[severity].length)
            .map((severity) => grouped[severity].length.toLocaleString() + ' ' + SEVERITY_NOUNS[severity][grouped[severity].length === 1 ? 0 : 1])
            .join(', ');
        const severityTone = topSeverity ? SEVERITY_STYLE[topSeverity].text : 'text-fg-subtle';
        const diagnosticsButton = (
            <button
                ref={diagnosticsBtnRef}
                type="button"
                data-testid="usd-scene-diagnostics-button"
                data-severity={topSeverity || 'none'}
                aria-haspopup="dialog"
                aria-expanded={diagnosticsOpen}
                title={'Diagnostics: ' + (diagnosticsSummary || 'no warnings')}
                onClick={() => setDiagnosticsOpen((open) => !open)}
                className={'ml-auto -my-0.5 h-6 inline-flex items-center gap-1.5 px-1.5 rounded-md border text-[11px] font-medium whitespace-nowrap transition-colors '
                    + (diagnosticsOpen ? 'bg-pressed border-line-heavy text-hud-fg-strong' : 'bg-hud-raised/80 border-line text-hud-fg hover:bg-hud-hover/80 hover:text-hud-fg-strong')}
            >
                <span data-testid="usd-scene-diagnostics-severity" className={'inline-flex ' + severityTone}>
                    <MtlxIcon name={topSeverity ? SEVERITY_STYLE[topSeverity].icon : 'check'} className="w-3.5 h-3.5" />
                </span>
                Diagnostics
                {/* The worst severity's own count: with a warning/error
                    present this matches the Warnings statistic (info never
                    inflates it); with info only (no warning/error) this is
                    the info count, so the badge still shows a number. */}
                {topSeverity && grouped[topSeverity].length ? (
                    <span data-testid="usd-scene-diagnostics-count"
                        className={'text-[10px] font-mono font-normal tabular-nums bg-surface-sunken/60 border border-line rounded-full px-1.5 ' + severityTone}>
                        {grouped[topSeverity].length.toLocaleString()}
                    </span>
                ) : null}
            </button>
        );
        const statisticsFooter = (
            <div className="shrink-0 border-t border-line px-3.5 py-3.5 space-y-1 bg-surface-card" data-testid="usd-stage-counts">
                <div className="flex items-center gap-2 mb-1.5">
                    <MtlxIcon name="cube" className="w-4 h-4 text-fg-muted shrink-0" />
                    <span className="text-[13px] font-semibold text-fg shrink-0">Statistics</span>
                    {diagnosticsButton}
                </div>
                <div className="space-y-1 text-[11px] text-fg-secondary">
                    {statisticsRows.map(([label, value, testId, title]) => (
                        <div key={label} className="flex justify-between" title={title}>
                            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">{label}</span>
                            <span className="font-mono tabular-nums" data-testid={testId}>{value}</span>
                        </div>
                    ))}
                </div>
            </div>
        );
        // Environment and light info popovers: the Render settings surface, under the
        // Environment settings pill, clamped inside the viewport.
        const HUD_POPOVER_W = 320;
        const hudPopoverStyle = () => {
            const pill = envBtnRef.current;
            const box = containerRef.current;
            const wanted = pill ? 8 + pill.offsetLeft : 8;
            const left = box ? Math.max(8, Math.min(wanted, box.clientWidth - HUD_POPOVER_W - 8)) : wanted;
            return { left, width: 'min(' + HUD_POPOVER_W + 'px, calc(100% - 16px))', maxHeight: 'calc(100% - 56px)', backgroundColor: HUD_POPOVER_BG };
        };
        const envNode = sceneTree ? sceneTree.groups.lights.children.find((node) => node.isEnvironment) : null;
        const envDome = handle && typeof handle.getDomeLight === 'function' ? handle.getDomeLight() : null;
        const envPopover = envPopoverOpen ? (
            <div ref={envPopRef} data-testid="usd-scene-env-popover" className={HUD_POPOVER_CLASS} style={hudPopoverStyle()}>
                {popoverHeader('sun', 'Environment', [envFileName || 'Default environment', (envRotation !== 0 || envExposureLinear !== 1) ? envSummary : ''].filter(Boolean).join(', '), () => setEnvPopoverOpen(false))}
                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 space-y-3">
                    {envNode && envNode.path ? (
                        <div data-testid="usd-scene-env-dome" className="text-[11px] text-fg-muted">
                            {envOverrideRef.current ? 'The imported environment replaces the stage\'s dome light ' : (envDome ? 'From the stage\'s dome light ' : 'The stage\'s dome light could not be applied, see Diagnostics: ')}
                            <span className="font-mono text-fg-secondary">{sceneTreeSegments(envNode.path).join('/')}</span>
                            {envDome && envDome.fileName && !envOverrideRef.current ? ' (' + envDome.fileName + ')' : ''}
                        </div>
                    ) : null}
                    {envLightingOff ? (
                        <div data-testid="usd-scene-env-lighting-off" className="text-[11px] text-warning/90">
                            {backdrop === 'environment'
                                ? 'The environment\'s lighting is turned off in the hierarchy; the Environment backdrop goes black until it is turned back on.'
                                : 'The environment\'s lighting is turned off in the hierarchy; the backdrop is unaffected.'}
                        </div>
                    ) : null}
                    <FilePickerField
                        value={envFileName}
                        placeholder="Default environment"
                        accept=".hdr,.exr"
                        icon="file"
                        onFiles={importEnvironment}
                        onClear={clearImportedEnvironment}
                    />
                    {envImportError && <div className="text-xs text-error">{envImportError}</div>}
                    <RenderSettingsSection surface="scene" keys={['envRotation', 'envExposure']} variant="popover" draft={envRowBinding} />
                    <RenderSettingsSection surface="scene" keys={['keyLight']} variant="popover" labelClassName="text-xs font-medium text-fg-secondary" draft={envRowBinding} />
                    <button type="button" data-testid="usd-scene-env-reset" onClick={resetEnvironment} className={BTN_SECONDARY + ' w-full'}>Reset</button>
                </div>
            </div>
        ) : null;
        // View-only facts of one stage light: what the file authors, then what the
        // viewport made of it (the renderer's converted samples).
        const lightRecord = lightInfoPath && stage ? stageLightRecords(stage).find((record) => String(record.primPath || '') === lightInfoPath) : null;
        const lightNode = lightInfoPath && sceneTree ? sceneTree.byId.get('light:' + lightInfoPath) : null;
        const lightDetails = lightInfoPath && handle && typeof handle.getStageLightDetails === 'function' ? handle.getStageLightDetails(lightInfoPath) : null;
        const lightPopover = lightRecord ? (() => {
            const units = sceneKind === 'gltf' ? 'm' : sceneUnitShort(stage && stage.metersPerUnit);
            const isDome = /^dome/i.test(String(lightRecord.type || ''));
            const exposure = Number(lightRecord.exposure) || 0;
            const effective = (Number(lightRecord.intensity) || 0) * Math.pow(2, exposure);
            const notes = warningDetails.map((record) => stripTag(record.raw || record.label)).filter((text) => text.indexOf(lightInfoPath) >= 0);
            const status = lightsHidden.has(lightInfoPath) ? 'Turned off in the hierarchy'
                : (!stageLightsOn ? 'Off: scene lights are turned off in the render settings'
                    : (lightDetails && lightDetails.converted ? 'On' : 'Not in the viewport'));
            const imported = !lightDetails || !lightDetails.converted
                ? (isDome ? 'Not applied: only the first dome light lights the scene' : 'Skipped, see the notes below')
                : (lightDetails.samples > 1 ? 'Split into ' + lightDetails.samples + ' point samples across its surface'
                    : ({ distant: 'One distant light', spot: 'One spot light', point: lightDetails.area ? 'One point at its centre' : 'One point light' }[lightDetails.kind] || 'One light'));
            const size = [['Radius', 'radius'], ['Width', 'width'], ['Height', 'height'], ['Length', 'length']]
                .filter(([, key]) => lightRecord[key] != null && Number.isFinite(Number(lightRecord[key])));
            return (
                <div ref={lightPopRef} data-testid="usd-scene-light-popover" data-path={lightInfoPath} className={HUD_POPOVER_CLASS} style={hudPopoverStyle()}>
                    {popoverHeader('bolt', String(lightRecord.name || (lightNode && lightNode.name) || lightInfoPath), sceneTreeSegments(lightInfoPath).join('/'), () => setLightInfoPath(''), 'View only', true)}
                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 py-2 space-y-2">
                        <div>
                            <LightInfoRow label="Type" raw={String(lightRecord.type || '')} testId="usd-scene-light-type">{sceneTreeLightTypeLabel(lightRecord.type) || 'Unknown'}</LightInfoRow>
                            <LightInfoRow label="Intensity" raw="inputs:intensity" testId="usd-scene-light-intensity">{lightNumber(lightRecord.intensity)}</LightInfoRow>
                            <LightInfoRow label="Exposure" raw="inputs:exposure">{lightNumber(exposure) + ' EV'}</LightInfoRow>
                            <LightInfoRow label="Effective intensity" raw="intensity x 2^exposure" testId="usd-scene-light-effective">{lightNumber(effective)}</LightInfoRow>
                            <LightInfoRow label="Color" raw="inputs:color" testId="usd-scene-light-color"><LightInfoColor rgb={lightRecord.color} /></LightInfoRow>
                            {lightRecord.enableColorTemperature ? (
                                <LightInfoRow label="Color temperature" raw="inputs:colorTemperature">{lightNumber(lightRecord.colorTemperature, 0) + ' K'}</LightInfoRow>
                            ) : null}
                            {size.map(([label, key]) => (
                                <LightInfoRow key={key} label={label} raw={'inputs:' + key} testId={'usd-scene-light-' + key}>{lightNumber(lightRecord[key]) + ' ' + units}</LightInfoRow>
                            ))}
                            {lightRecord.angle != null ? <LightInfoRow label="Angular size" raw="inputs:angle">{lightNumber(lightRecord.angle) + ' deg'}</LightInfoRow> : null}
                            {lightRecord.coneAngle != null ? <LightInfoRow label="Cone angle" raw="inputs:shaping:cone:angle">{lightNumber(lightRecord.coneAngle) + ' deg'}</LightInfoRow> : null}
                            {lightRecord.coneSoftness != null ? <LightInfoRow label="Cone softness" raw="inputs:shaping:cone:softness">{lightNumber(lightRecord.coneSoftness)}</LightInfoRow> : null}
                            <LightInfoRow label="Normalized by size" raw="inputs:normalize">{lightRecord.normalize ? 'Yes' : 'No'}</LightInfoRow>
                            {Number(lightRecord.diffuse) !== 1 && lightRecord.diffuse != null ? <LightInfoRow label="Diffuse multiplier" raw="inputs:diffuse">{lightNumber(lightRecord.diffuse) + ' (not applied)'}</LightInfoRow> : null}
                            {Number(lightRecord.specular) !== 1 && lightRecord.specular != null ? <LightInfoRow label="Specular multiplier" raw="inputs:specular">{lightNumber(lightRecord.specular) + ' (not applied)'}</LightInfoRow> : null}
                            {lightRecord.textureFile ? <LightInfoRow label="Texture" raw="inputs:texture:file">{String(lightRecord.textureFile)}</LightInfoRow> : null}
                        </div>
                        <div className="pt-2 border-t border-line/60">
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">In the viewport</div>
                            <LightInfoRow label="Status" testId="usd-scene-light-status">{status}</LightInfoRow>
                            <LightInfoRow label="Imported as" testId="usd-scene-light-imported">{imported}</LightInfoRow>
                            {lightDetails && lightDetails.converted ? (
                                <React.Fragment>
                                    <LightInfoRow label="Delivered intensity" raw="after size and the stage light intensity">{lightNumber(lightDetails.intensity * lightDetails.gain)}</LightInfoRow>
                                    {lightDetails.color ? <LightInfoRow label="Final color" raw="color and temperature"><LightInfoColor rgb={lightDetails.color} /></LightInfoRow> : null}
                                    {lightDetails.position && lightDetails.kind !== 'distant' ? <LightInfoRow label="Position" raw="world, meters" testId="usd-scene-light-position">{lightTriple(lightDetails.position, 2)}</LightInfoRow> : null}
                                    {lightDetails.direction ? <LightInfoRow label="Direction" raw="world">{lightTriple(lightDetails.direction, 2)}</LightInfoRow> : null}
                                    {lightDetails.coneOuterDeg != null ? <LightInfoRow label="Cone edge" raw="inner, outer">{lightNumber(lightDetails.coneInnerDeg, 1) + ', ' + lightNumber(lightDetails.coneOuterDeg, 1) + ' deg'}</LightInfoRow> : null}
                                    <LightInfoRow label="Casts shadows" testId="usd-scene-light-shadows">
                                        {!lightDetails.shadows ? 'No, shadows are off in the render settings' : (lightDetails.castsShadows ? 'Yes' : 'No, not among the shadow casters')}
                                    </LightInfoRow>
                                </React.Fragment>
                            ) : null}
                        </div>
                        {notes.length ? (
                            <div data-testid="usd-scene-light-notes" className="pt-2 border-t border-line/60 space-y-1">
                                <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">Notes</div>
                                {notes.map((text, i) => <div key={i} className="text-[11px] text-fg-muted break-words">{text}</div>)}
                            </div>
                        ) : null}
                    </div>
                </div>
            );
        })() : null;
        // Kept mounted while closed (hidden) so the messages stay readable in the DOM.
        const diagnosticsPopover = ReactDOM.createPortal(
            <div
                ref={diagnosticsPopRef}
                role="dialog"
                aria-label="Diagnostics"
                data-testid="usd-scene-diagnostics-popover"
                style={Object.assign({ position: 'fixed', zIndex: 9999, backgroundColor: HUD_POPOVER_BG }, diagnosticsPos || {})}
                className={(diagnosticsOpen && diagnosticsPos ? 'flex' : 'hidden') + ' flex-col backdrop-blur border border-line-strong rounded-lg shadow-2xl overflow-hidden'}
            >
                {popoverHeader('alert-triangle', 'Diagnostics', diagnosticsSummary || 'No warnings', () => setDiagnosticsOpen(false))}
                <div
                    data-testid={materials.length ? 'usd-material-provenance' : 'usd-scene-diagnostics'}
                    className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 py-1.5"
                >
                    {diagnosticsContent}
                </div>
            </div>,
            fullscreenPortalRoot()
        );
        // One slot: Cancel while anything loads, Reload once a stage is shown, else Load.
        const sourceKind = stage && stage.summary && stage.summary.sourceKind;
        const canExportUsd = sourceKind === 'gltf' || sourceKind === 'obj' || sourceKind === 'pbrt' || sourceKind === 'mitsuba';
        const sceneSlotButton = busy ? (
            <button type="button" data-testid="usd-scene-cancel" onClick={cancel} className={BTN_SECONDARY + ' flex-1 min-w-0 gap-1'}>
                <MtlxIcon name="x" className="w-3.5 h-3.5 flex-none" />Cancel
            </button>
        ) : (stage ? (
            <button type="button" data-testid="usd-scene-info-reload" onClick={reloadScene} className={BTN_SECONDARY + ' flex-1 min-w-0 gap-1'}>
                <MtlxIcon name="refresh" className="w-3.5 h-3.5 flex-none" />Reload
            </button>
        ) : (!IN_VSCODE && files.length > 0 && rootPath ? (
            <button type="button" onClick={() => load()} title={'Load ' + rootBasename} className={BTN_PRIMARY + ' flex-1 min-w-0'}>
                <span className="truncate">Load {rootBasename}</span>
            </button>
        ) : null));
        const sidebarBody = (
            <div className="flex-1 min-h-0 flex flex-col overflow-y-auto custom-scrollbar">
                <section data-testid="usd-scene-section-scene" className="flex-none px-3.5 py-3 space-y-2">
                    <SidebarSectionHeader icon="file" title="Scene" summary={rootBasename || 'No scene'} testId="usd-scene-section-header" />
                    {!IN_VSCODE && (
                        <div className="flex items-center gap-1">
                            <div className="flex-1 min-w-0">
                                <FilePickerField
                                    value={files.length ? files.length + ' file' + (files.length === 1 ? '' : 's') : ''}
                                    placeholder="Drop scene files or choose"
                                    multiple
                                    icon="files"
                                    accept={'.usd,.usda,.usdc,.usdz,.glb,.gltf,.obj,.mtl,.bin,.mtlx,.pbrt,.ply,.gz,.xml,.zip,' + window.textureAccept()}
                                    onFiles={chooseFiles}
                                    inputTestId="usd-scene-file-picker"
                                />
                            </div>
                            <label
                                title="Choose a folder"
                                className="h-[26px] w-[26px] shrink-0 inline-flex items-center justify-center border border-line-control rounded-md bg-control/80 hover:bg-hover text-fg-secondary cursor-pointer"
                            >
                                <MtlxIcon name="folder" className="w-3.5 h-3.5" />
                                <input type="file" webkitdirectory="" directory="" multiple className="hidden" onChange={(e) => chooseFiles(e.target.files)} />
                            </label>
                        </div>
                    )}

                    {!IN_VSCODE && candidates.length > 1 && (() => {
                        const allCandidatePaths = candidates.map((f) => f.path);
                        // Sub-layers/buffers another picked file references stay
                        // hidden by default (item 4); a null set means "not yet
                        // scanned", which shows everything rather than nothing.
                        const topLevelPaths = rootTopLevelPaths
                            ? allCandidatePaths.filter((p) => rootTopLevelPaths.has(p.toLowerCase()))
                            : allCandidatePaths;
                        const hiddenCount = allCandidatePaths.length - topLevelPaths.length;
                        const filtering = hiddenCount > 0 && !showAllRootFiles;
                        let visiblePaths = filtering ? topLevelPaths : allCandidatePaths;
                        // The current root always stays selectable even if it
                        // would otherwise be filtered out (e.g. a host-picked layer).
                        if (rootPath && visiblePaths.indexOf(rootPath) < 0) visiblePaths = visiblePaths.concat([rootPath]);
                        const shortLabels = distinctRootLabels(visiblePaths);
                        const rootLabels = {};
                        const rootTitles = {};
                        visiblePaths.forEach((p, i) => { rootLabels[p] = shortLabels[i]; rootTitles[p] = p; });
                        const selectOptions = filtering ? visiblePaths.concat([SHOW_ALL_ROOT_FILES_VALUE]) : visiblePaths;
                        if (filtering) {
                            rootLabels[SHOW_ALL_ROOT_FILES_VALUE] = 'Show all files (' + allCandidatePaths.length + ')';
                            rootTitles[SHOW_ALL_ROOT_FILES_VALUE] = 'Show every scene file in this folder, including referenced sub-layers';
                        }
                        return (
                            <div data-testid="usd-scene-root-select" className="flex items-center gap-3">
                                <span className={SCENE_ROW_LABEL + ' shrink-0 pl-4'}>Scene file</span>
                                <div className="flex-1 min-w-0">
                                    <MtlxSelect
                                        value={rootPath}
                                        options={selectOptions}
                                        labels={rootLabels}
                                        titles={rootTitles}
                                        title={rootPath || undefined}
                                        ariaLabel="Scene selection"
                                        popWidth={320}
                                        onChange={(v) => {
                                            if (v === SHOW_ALL_ROOT_FILES_VALUE) { setShowAllRootFiles(true); return; }
                                            setRootPath(v); setRootTouched(true);
                                            // One-click scene switching: reload the newly picked root
                                            // right away instead of waiting on the explicit Load button.
                                            if (filesRef.current && filesRef.current.length > 0) load(filesRef.current, v);
                                        }}
                                        defValue={null}
                                        size="sm"
                                        variant="field"
                                        block
                                    />
                                </div>
                            </div>
                        );
                    })()}

                    {cardStage ? (
                        <RenderSettingsSection surface="scene" keys={['backdrop']} variant="flat" labelClassName={SCENE_ROW_LABEL + ' shrink-0 pl-4'} draft={backdropRowBinding} />
                    ) : null}

                    {cardStage ? (
                        <div data-testid="usd-scene-info" className="space-y-1">
                            <div>
                                <button
                                    type="button"
                                    data-testid="usd-scene-info-toggle"
                                    aria-expanded={sceneInfoOpen}
                                    title={sceneInfoOpen ? 'Hide the scene facts' : 'Show the scene facts'}
                                    onClick={() => setSceneInfoOpen((open) => !open)}
                                    className="w-full h-5 flex items-center justify-between gap-3 -mx-1 px-1 rounded text-left hover:bg-hover-subtle/60"
                                >
                                    <span className={SCENE_ROW_LABEL + ' inline-flex items-center gap-1 shrink-0'}>
                                        <MtlxIcon name={sceneInfoOpen ? 'chevron-down' : 'chevron-right'} className="w-3 h-3" />Info
                                    </span>
                                    {!sceneInfoOpen ? (
                                        <span data-testid="usd-scene-info-summary" className="min-w-0 truncate text-right text-[11px] text-fg-subtle">
                                            {[sceneFormat, sceneUpAxis ? sceneUpAxis.split(' ')[0] + ' up' : ''].filter(Boolean).join(', ') || rootBasename}
                                        </span>
                                    ) : null}
                                </button>
                                {/* Collapsed rows stay mounted (hidden): the VS Code scene report reads them. */}
                                <div data-testid="usd-scene-info-details" className={(sceneInfoOpen ? 'grid' : 'hidden') + ' grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 mt-0.5 mb-1 pl-4'}>
                                    <SceneInfoRow label="File" testId="usd-scene-info-file" title={rootPath}>{rootBasename}</SceneInfoRow>
                                    {sceneFormat ? <SceneInfoRow label="Format" testId="usd-scene-info-format">{sceneFormat}</SceneInfoRow> : null}
                                    {sceneUnits ? <SceneInfoRow label="Units" testId="usd-scene-info-units">{sceneUnits}</SceneInfoRow> : null}
                                    {sceneUpAxis ? <SceneInfoRow label="Up axis" testId="usd-scene-info-up-axis">{sceneUpAxis}</SceneInfoRow> : null}
                                </div>
                            </div>
                            <div>
                                <button
                                    type="button"
                                    data-testid="usd-scene-info-files-toggle"
                                    aria-expanded={sceneFilesOpen}
                                    title={sceneFilesOpen ? 'Hide the loaded files' : 'List the loaded files'}
                                    onClick={() => setSceneFilesOpen((open) => !open)}
                                    className="w-full h-5 flex items-center justify-between gap-3 -mx-1 px-1 rounded text-left hover:bg-hover-subtle/60"
                                >
                                    <span className={SCENE_ROW_LABEL + ' inline-flex items-center gap-1 shrink-0'}>
                                        <MtlxIcon name={sceneFilesOpen ? 'chevron-down' : 'chevron-right'} className="w-3 h-3" />Files loaded
                                    </span>
                                    <span data-testid="usd-scene-info-files" className="min-w-0 truncate text-right text-[11px] text-fg-secondary">
                                        {sceneFilesText}
                                        {sceneMissing.length ? <span className="text-warning/90">{', ' + sceneMissing.length + ' missing'}</span> : null}
                                    </span>
                                </button>
                                {sceneFilesOpen && (
                                    <div data-testid="usd-scene-info-files-list" className="mt-1 max-h-40 overflow-y-auto custom-scrollbar rounded-md border border-line bg-surface-sunken/60 py-1">
                                        {files.map((file) => (
                                            <div key={file.path} className="flex items-baseline justify-between gap-2 px-2 py-0.5 text-[11px]">
                                                <span className="min-w-0 truncate font-mono text-fg-secondary" title={file.path}>{file.path}</span>
                                                <span className="shrink-0 font-mono tabular-nums text-fg-subtle">{formatByteSize(sceneFileBytes(file))}</span>
                                            </div>
                                        ))}
                                        {sceneMissing.map((asset) => (
                                            <div key={'missing:' + asset} data-missing="true" className="flex items-baseline justify-between gap-2 px-2 py-0.5 text-[11px]">
                                                <span className="min-w-0 truncate font-mono text-fg-subtle" title={asset}>{asset}</span>
                                                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-warning/90">Missing</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (!busy && (IN_VSCODE || files.length > 0) ? (
                        <div data-testid="usd-scene-info-empty" className="text-xs text-fg-subtle">No scene loaded</div>
                    ) : null)}

                    {sceneSlotButton || stage ? (
                        <div className="flex items-center gap-1.5 pt-0.5">
                            {sceneSlotButton}
                            {stage && !busy ? (
                                <button
                                    type="button"
                                    data-testid="usd-scene-export-usd"
                                    onClick={() => setExportOpen(true)}
                                    disabled={!canExportUsd}
                                    title={canExportUsd ? 'Export this scene as USD' : 'Export as USD is available for glTF, GLB, OBJ, PBRT and Mitsuba scenes'}
                                    className={BTN_SECONDARY + ' flex-1 min-w-0 gap-1'}
                                >
                                    <MtlxIcon name="file-download" className="w-3.5 h-3.5 flex-none" />Export USD
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                </section>

                {sceneTree && (
                    <section data-testid="usd-scene-section-hierarchy" className="flex-1 flex flex-col gap-2 px-3.5 py-3 border-t border-line">
                        <SidebarSectionHeader icon="list-details" title="Hierarchy" summary={objectCount.toLocaleString() + ' object' + (objectCount === 1 ? '' : 's')} testId="usd-scene-section-header" />
                        <div className="flex-none rounded-md border border-line-control bg-surface-sunken overflow-hidden focus-within:border-focus">
                        <div className="relative h-[26px]">
                            <MtlxIcon name="search" className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-subtle pointer-events-none" />
                            <input
                                type="text"
                                value={treeFilter}
                                onChange={(e) => setTreeFilter(e.target.value)}
                                onKeyDown={(e) => {
                                    // An open popover (Diagnostics, Render settings,
                                    // Environment, light info) owns the first Escape via
                                    // its window-level useEscapeToClose listener; only
                                    // intercept here once none of them are open.
                                    if (e.key !== 'Escape' || !treeFilter) return;
                                    if (diagnosticsOpen || renderSettingsOpen || envPopoverOpen || lightInfoPath) return;
                                    e.stopPropagation(); setTreeFilter('');
                                }}
                                placeholder="Filter objects"
                                aria-label="Filter objects"
                                data-testid="usd-scene-tree-filter"
                                spellCheck={false}
                                className="w-full h-full bg-transparent border-0 pl-7 pr-2 text-[11px] text-fg-secondary placeholder-fg-subtle focus:outline-none"
                            />
                        </div>
                        <SceneTreeGroupSegments value={treeGroup} onChange={setTreeGroup} />
                        </div>
                        {treeRows.length ? (
                            <SceneTree
                                rows={treeRows}
                                expanded={treeExpanded}
                                selectedId={treeSelected}
                                hidden={treeHidden}
                                hiddenLights={lightsHidden}
                                lightsOff={!stageLightsOn}
                                envLightingOff={envLightingOff}
                                envEyeAvailable={!!handle && typeof handle.setEnvironmentLightingEnabled === 'function'}
                                activeCamera={selectedCamera}
                                revealToken={treeReveal}
                                onToggleExpand={toggleTreeExpanded}
                                onSelect={selectTreePath}
                                onRowClick={clickTreeRow}
                                onToggleHidden={toggleTreeHidden}
                                onActivate={activateTreeNode}
                            />
                        ) : (
                            <div className="flex-1 text-xs text-fg-subtle">No objects match the filter.</div>
                        )}
                        <div className="flex-none text-[11px] text-fg-subtle truncate" title="Click a camera to look through it; while the material preview is open, a single click switches it.">
                            Double-click a row to preview its material.
                        </div>
                    </section>
                )}
            </div>
        );

        return (
        <div data-testid="usd-scene-viewer" className="absolute inset-0 overflow-hidden flex bg-surface-base">
            <span className="sr-only" data-testid="usd-scene-status">{status}</span>
            {dragOver && (
                <div className="fixed left-0 right-0 bottom-0 top-14 z-40 pointer-events-none p-2 sm:p-4">
                    <div className="w-full h-full rounded-xl border-4 border-dashed border-accent-base/70 bg-drop-target/40 flex items-center justify-center">
                        <div className="flex items-center gap-2 text-accent-fg-bright text-lg font-semibold bg-hud/80 rounded-lg px-5 py-3">
                            <MtlxIcon name="file-upload" className="w-6 h-6" /> Drop to load
                        </div>
                    </div>
                </div>
            )}

            {sidebarOpen && (
                <div data-testid="usd-scene-sidebar" className="flex-none w-80 max-w-[90%] flex flex-col bg-surface-base border-r border-line overflow-hidden">
                    <div className="flex-none flex items-center px-3 py-2 border-b border-line">
                        <span className="text-[13px] font-semibold text-fg">Scene Viewer</span>
                        <button
                            ref={knownIssuesBtnRef}
                            type="button"
                            data-testid="usd-scene-experimental-pill"
                            aria-expanded={knownIssuesOpen}
                            title="Known issues"
                            onClick={() => setKnownIssuesOpen((o) => !o)}
                            className="ml-2 text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-experimental-hue/10 border border-experimental-hue/40 text-experimental hover:bg-experimental-hue/20 hover:border-experimental-hue/60"
                        >Experimental</button>
                        <button
                            onClick={() => setSidebarOpen(false)}
                            title="Collapse the scene viewer panel"
                            className="flex-none ml-auto text-fg-muted hover:text-fg-soft px-1 leading-none text-sm"
                        ><MtlxIcon name="chevrons-left" className="w-4 h-4" /></button>
                    </div>
                    {knownIssuesOpen && knownIssuesPos && ReactDOM.createPortal(
                        <div
                            ref={knownIssuesPopRef}
                            data-testid="usd-scene-known-issues"
                            onPointerDown={(e) => e.stopPropagation()}
                            style={{ position: 'fixed', zIndex: 9999, width: KNOWN_ISSUES_POPOVER_W, left: knownIssuesPos.left, top: knownIssuesPos.top, backgroundColor: HUD_POPOVER_BG }}
                            className="backdrop-blur border border-line-strong rounded-lg shadow-2xl overflow-hidden"
                        >
                            <div className="px-3 py-2.5 space-y-1.5">
                                <div className="text-[12px] font-semibold text-fg">Known issues</div>
                                <ul className="list-disc pl-4 space-y-1 text-[11px] text-fg-muted">
                                    {SCENE_KNOWN_ISSUES.map((issue, i) => <li key={i}>{issue}</li>)}
                                </ul>
                            </div>
                        </div>,
                        fullscreenPortalRoot()
                    )}
                    {sidebarBody}
                    {statisticsFooter}
                </div>
            )}
            {diagnosticsPopover}

            <div className="relative flex-1 min-w-0">
                <div ref={containerRef} data-testid="usd-scene-canvas" className="absolute inset-0 bg-stage" aria-label="Rendered scene">
                    <LoadingOverlay
                        show={busy}
                        label={progressLabel + (progressText ? ' ' + progressText : '')}
                        fraction={fraction}
                        testId="usd-scene-progress"
                        className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-veil/70"
                        labelClassName="text-sm text-fg-secondary animate-pulse"
                        barWidthClass="w-56"
                    >
                        {progressDetail && (
                            <span
                                data-testid="usd-scene-progress-detail"
                                className="text-xs text-fg-subtle truncate w-56 text-center"
                            >{progressDetail}</span>
                        )}
                        <button type="button" data-testid="usd-scene-progress-cancel" onClick={cancel} className={HUD_PILL + ' pointer-events-auto'}>Cancel</button>
                    </LoadingOverlay>

                    {IN_VSCODE && status === 'cancelled' && (
                        <div data-testid="usd-scene-cancelled" className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 text-center px-6">
                            <div className="text-stage-fg-muted text-sm">Loading cancelled</div>
                            <button type="button" data-testid="usd-scene-reload" onClick={reloadFromHost} className={PILL_ACTION}>
                                <MtlxIcon name="refresh" className="w-3.5 h-3.5" /> Reload
                            </button>
                        </div>
                    )}

                    {!hasStage && !busy && !IN_VSCODE && (
                        <React.Fragment>
                            <div
                                aria-hidden="true"
                                className="absolute inset-0 pointer-events-none"
                                style={{
                                    backgroundImage: EMPTY_STAGE_GRID_IMAGE,
                                    backgroundSize: '40px 40px',
                                    maskImage: EMPTY_STAGE_GRID_MASK,
                                    WebkitMaskImage: EMPTY_STAGE_GRID_MASK,
                                }}
                            />
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6">
                                <div className="text-stage-fg-subtle text-sm max-w-sm">
                                    Drop a USD stage (.usd, .usda, .usdc, .usdz), a glTF (.gltf, .glb), an OBJ (.obj), a PBRT v4 scene (.pbrt) or a Mitsuba scene (.xml) and its referenced files
                                </div>
                            </div>
                        </React.Fragment>
                    )}

                    {handle && (
                        <ViewportControls
                            containerClassName={hudStacked
                                ? 'absolute top-12 left-2 z-10 flex items-center gap-2.5 flex-wrap max-w-[calc(100%-1rem)]'
                                : 'absolute top-2 right-2 z-10 flex items-center gap-2.5 flex-wrap justify-end max-w-[calc(100%-5rem)]'}
                            clusterClassName="flex items-center gap-1"
                            selectSize="md"
                            buttonClassName={(isActive) => isActive ? HUD_PILL_ACTIVE : HUD_PILL}
                            showGeomSelect={false}
                            envAvail={false}
                            showBackdropPicker={false}
                            showSettings={false}
                            showRotate
                            rotating={rotating}
                            onToggleRotating={toggleRotating}
                            onCameraReset={() => { if (handle && handle.resetCamera) { handle.resetCamera(); if (handle.renderNow) handle.renderNow(); } else frameAll(); }}
                            showScreenshot
                            onScreenshot={takeScreenshot}
                            onRecord={() => setRecordOpen(true)}
                            showRecord={!!handle && typeof handle.beginCapture === 'function'}
                            isFullscreen={isFullscreen}
                            onToggleFullscreen={toggleFullscreen}
                            showLabels={!hudCompact}
                            clusters={[['rotate', 'cameraReset'], ['screenshot', 'record', 'fullscreen']]}
                        />
                    )}

                    <div className="absolute top-2 left-2 z-30 flex items-center gap-2.5 flex-wrap max-w-[calc(100%-5rem)]">
                        {!sidebarOpen && (
                            <button
                                type="button"
                                onClick={() => setSidebarOpen(true)}
                                title="Expand the scene viewer panel"
                                aria-label="Expand the scene viewer panel"
                                className={HUD_PILL}
                            >
                                <MtlxIcon name="chevrons-right" className="w-4 h-4" />
                                {!hudCompact && <span className="max-w-[5rem] md:max-w-[8rem] truncate">Scene</span>}
                            </button>
                        )}
                        <button
                            type="button"
                            ref={renderSettingsBtnRef}
                            data-testid="usd-scene-render-settings"
                            title={draftDirty ? 'Render settings (unapplied changes)' : 'Render settings'}
                            aria-label="Render settings"
                            onClick={() => setRenderSettingsOpen((o) => !o)}
                            className={(renderSettingsOpen ? HUD_PILL_ACTIVE : HUD_PILL) + ' relative'}
                        >
                            <MtlxIcon name="settings-cog" className="w-4 h-4" />
                            {!hudCompact && <span>Render settings</span>}
                            {draftDirty ? (
                                <span title="Unapplied changes" className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-warning-marker border border-surface-base" />
                            ) : null}
                        </button>
                        <button
                            type="button"
                            ref={envBtnRef}
                            data-testid="usd-scene-env-settings"
                            title="Environment settings"
                            aria-label="Environment settings"
                            aria-expanded={envPopoverOpen}
                            onClick={() => { if (envPopoverOpen) setEnvPopoverOpen(false); else openEnvPopover(); }}
                            className={envPopoverOpen ? HUD_PILL_ACTIVE : HUD_PILL}
                        >
                            <MtlxIcon name="sun" className="w-4 h-4" />
                            {!hudCompact && <span>Environment settings</span>}
                        </button>
                        {sceneTree && (
                            <div data-testid="usd-scene-camera-select" className="flex-none">
                                <MtlxSelect
                                    value={selectedCamera}
                                    options={cameraOptions}
                                    defValue="default"
                                    onChange={selectCamera}
                                    icon="camera"
                                    title="Camera"
                                    ariaLabel="Camera"
                                    variant="toolbar"
                                    size="md"
                                    maxWidth={hudCompact ? 110 : 180}
                                    disabled={!handle}
                                />
                            </div>
                        )}
                    </div>

                    {envPopover}
                    {lightPopover}

                    {renderSettingsMounted && (
                        <div
                            ref={renderSettingsPopRef}
                            data-testid="usd-scene-render-settings-popover"
                            className={(renderSettingsOpen ? '' : 'hidden ') + 'absolute z-30 top-11 left-2 flex flex-col backdrop-blur border border-line-strong rounded-lg shadow-2xl overflow-hidden'}
                            style={{ width: 'min(560px, calc(100% - 16px))', maxHeight: 'calc(100% - 56px)', backgroundColor: HUD_POPOVER_BG }}
                        >
                            <div className="flex-none px-3 py-2 border-b border-line">
                                <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium text-fg-secondary">Preset</span>
                                    <QualitySegments tone="panel" value={draftStagedOverrides.length ? 'custom' : (draftLevel ? draftLevel.id : 'default')}
                                        onChange={stageQualityLevel} disabled={busy || !!presetApplying} />
                                </div>
                                <div className="mt-1 text-[11px] text-fg-muted">{qualitySummaryText()}</div>
                            </div>
                            <TabStrip tabs={RENDER_TABS} labels={RENDER_TAB_LABELS} value={renderTab} onChange={setRenderTab} />
                            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 space-y-1">
                                {renderTab === 'display' && renderDisplayTab()}
                                {renderTab === 'lighting' && renderLightingTab()}
                                {renderTab === 'effects' && renderEffectsTab()}
                                {renderTab === 'geometry' && renderGeometryTab()}
                            </div>
                            <div className="flex-none flex items-center justify-between gap-2 px-3 py-2 border-t border-line">
                                <span className="text-[11px] text-fg-muted truncate">
                                    {presetApplying ? ('Applying ' + presetApplying) : footerHintText()}
                                </span>
                                <div className="flex items-center gap-1.5 shrink-0">
                                    <button type="button" data-testid="usd-scene-quality-reset" disabled={busy || !!presetApplying || !draftResetDirty}
                                        onClick={resetQualityDraft} className={BTN_SECONDARY + ' gap-1'}>
                                        <MtlxIcon name="restore" className="w-3.5 h-3.5 flex-none" />Reset</button>
                                    <button type="button" data-testid="usd-scene-quality-cancel" disabled={busy || !!presetApplying}
                                        onClick={cancelQualityDraft} className={BTN_SECONDARY + ' gap-1'}>
                                        <MtlxIcon name="x" className="w-3.5 h-3.5 flex-none" />Cancel</button>
                                    <button type="button" data-testid="usd-scene-quality-apply" disabled={busy || !!presetApplying || !draftDirty}
                                        onClick={applyQualityDraft} className={BTN_SECONDARY + ' gap-1'}>
                                        <MtlxIcon name="check" className="w-3.5 h-3.5 flex-none" />Apply</button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Sits one row above the hint pill below (bottom-10) so a
                        note is never painted over by it; the note is transient
                        (3s, see showDoubleClickNote) so it never crowds the
                        status pill further down. */}
                    {doubleClickNote && (
                        <div data-testid="usd-scene-dblclick-note" className="absolute bottom-[4.5rem] left-2 z-10 pointer-events-none px-2 py-1 rounded-full bg-warning-hue/10 border border-warning-hue/40 text-[11px] text-warning-text">
                            {doubleClickNote}
                        </div>
                    )}
                    {/* Bottom-left hint pill: stacked directly above the
                        status pill below so the two never overlap, even at
                        narrow widths (both are left-anchored, fixed-height
                        rows). DOM overlay, not canvas content, so it never
                        shows up in a viewport screenshot or GIF capture. */}
                    {handle && meshes.length > 0 && status === 'rendered' && (
                        <div data-testid="usd-scene-hint-pill" className="absolute bottom-10 left-2 z-10 flex items-center gap-1.5 pl-2 pr-2 py-1 rounded-full bg-black/60 text-[11px] text-white/90">
                            <MtlxIcon name="info-circle" className="w-3.5 h-3.5 shrink-0 text-white/70" />
                            <span>Double-click a mesh to preview its material graph</span>
                        </div>
                    )}

                    {/* A stage with materials but no meshes (e.g. a .usdc that
                        only holds a Look library) would otherwise render an
                        empty viewport with just an [info] note in Diagnostics;
                        say so plainly, the Materials group still lists them. */}
                    {handle && status === 'rendered' && meshes.length === 0 && (sceneTree ? sceneTree.materialCount : materials.length) > 0 && (
                        <div data-testid="usd-scene-empty-geometry" className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6 pointer-events-none">
                            <MtlxIcon name="info-circle" className="w-5 h-5 text-fg-subtle" />
                            <div className="text-fg-muted text-sm max-w-sm">
                                {/* materials.length only counts stage.materials (mesh-bound,
                                    resolved documents); an unbound Material prim only shows
                                    up in sceneTree via stage.materialPrims, so use the same
                                    count as the Statistics row. */}
                                This file has materials but no geometry ({(sceneTree ? sceneTree.materialCount : materials.length).toLocaleString()} material{(sceneTree ? sceneTree.materialCount : materials.length) === 1 ? '' : 's'})
                            </div>
                        </div>
                    )}

                    {handle && (() => {
                        const segments = [rootBasename, meshes.length + ' mesh' + (meshes.length === 1 ? '' : 'es')];
                        const mtlxVersion = (window.MtlxAssets && window.MtlxAssets.MTLX_DEFAULT_VERSION) || window.__mtlxVersion;
                        if (mtlxVersion) segments.push('v' + mtlxVersion);
                        return (
                            <div data-testid="usd-scene-status-pill" className="absolute bottom-2 left-2 z-10 pointer-events-none flex items-center gap-2 px-2 py-1 rounded-full bg-black/60 text-[11px] text-white/90">
                                <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                                {segments.filter(Boolean).map((seg, i) => (
                                    <React.Fragment key={i}>
                                        {i > 0 && <span className="text-white/40">/</span>}
                                        <span className={seg.charAt(0) === 'v' && i === segments.length - 1 ? 'font-mono' : undefined}>{seg}</span>
                                    </React.Fragment>
                                ))}
                            </div>
                        );
                    })()}

                    {handle && <SceneRebuildIndicator handle={handle} />}

                    <MaterialPreviewPanel
                        key={previewEpoch}
                        open={previewOpen}
                        payload={previewPayload}
                        anchor={previewAnchor}
                        onClose={() => setPreviewOpen(false)}
                        containerRef={containerRef}
                        panelRef={previewPanelRef}
                        sceneFiles={sceneLooseFiles}
                        warm={previewWarm}
                        sceneFileName={rootBasename}
                    />
                </div>
            </div>

            {status === 'cancelled' && !busy && !IN_VSCODE && (
                <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 max-w-[min(42rem,85%)] bg-hud-raised/90 backdrop-blur border border-hud-line text-hud-fg text-sm rounded-lg px-4 py-2 break-words shadow-lg">Cancelled</div>
            )}
            {error && (
                <div role="alert" data-testid="usd-scene-error" className="absolute top-12 left-1/2 -translate-x-1/2 z-30 max-w-[min(42rem,85%)] bg-error-bg/90 border border-error-border/60 text-error-text text-sm rounded-lg px-4 py-2.5 break-words shadow-lg">{error}</div>
            )}

            {exportOpen && canExportUsd && (
                <ExportUsdDialog open={exportOpen} onClose={() => setExportOpen(false)} stage={stage} files={filesRef.current} rootBasename={rootBasename} />
            )}
            {recordOpen && (
                <RecordGifDialog open={recordOpen} onClose={() => setRecordOpen(false)}
                    viewRef={handleRef} baseName={rootBasename ? rootBasename.replace(/\.[^.]+$/, '') : 'usd-scene'} transparent={false} />
            )}
        </div>
        );
    }
    window.SceneViewerApp = SceneViewerApp;
})();
