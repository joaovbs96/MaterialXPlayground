// js/graph/zip-export-paths.js: resolves texture refs into zip-safe entry
// paths for graph-app.jsx's ZIP export (doExportZip). Plain JS (no JSX), so
// tests/unit can eval it directly in Node.

// Splits a ref on '/', collapsing '.' and '..' segments. escaped is true
// when a leading '..' has nowhere left to pop, i.e. the ref climbs above
// wherever it is rooted (the case that used to leak '../' zip entries).
const collapseRefSegments = (ref) => {
    const segments = String(ref || '').replace(/\\/g, '/').split('/');
    const out = [];
    let escaped = false;
    for (const seg of segments) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
            if (out.length > 0) out.pop();
            else escaped = true;
        } else {
            out.push(seg);
        }
    }
    return { path: out.join('/'), escaped };
};

// Assigns each texture ref a zip-safe entry path. Refs that already sit
// inside the zip root keep their collapsed path unchanged; refs that climb
// above it (e.g. '../textures/foo.png') are relocated under `relocateFolder`
// with collision-safe names, e.g. 'textures/foo.png', 'textures/foo_2.png'.
// Returns { [normalizedRef]: { zipPath, relocated } }.
const assignZipTexturePaths = (refs, relocateFolder = 'textures') => {
    const byRef = {};
    const used = new Set();
    const uniquePath = (candidate) => {
        if (!used.has(candidate)) return candidate;
        const dot = candidate.lastIndexOf('.');
        const base = dot > 0 ? candidate.slice(0, dot) : candidate;
        const ext = dot > 0 ? candidate.slice(dot) : '';
        let n = 2;
        let next = base + '_' + n + ext;
        while (used.has(next)) {
            n += 1;
            next = base + '_' + n + ext;
        }
        return next;
    };
    for (const ref of refs || []) {
        const key = String(ref || '').replace(/\\/g, '/');
        if (!key || Object.prototype.hasOwnProperty.call(byRef, key)) continue;
        const { path, escaped } = collapseRefSegments(key);
        let relocated = escaped || !path;
        let zipPath = relocated
            ? relocateFolder + '/' + (path.split('/').pop() || 'texture')
            : path;
        zipPath = uniquePath(zipPath);
        used.add(zipPath);
        if (!relocated && zipPath !== path) relocated = true; // moved by a collision suffix
        byRef[key] = { zipPath, relocated };
    }
    return byRef;
};

if (typeof window !== 'undefined') {
    Object.assign(window, { collapseRefSegments, assignZipTexturePaths });
}
