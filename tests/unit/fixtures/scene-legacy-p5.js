// Frozen pre-P6 copies of the Scene's exact resolvers and UDIM helpers
// (js/usd-scene-renderer.js at P6 S3, 4c7ea0c), kept verbatim as the parity
// oracle for the shared engine/mesh-udim functions that replaced them in P6 S4.
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
