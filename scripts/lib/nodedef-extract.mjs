// scripts/lib/nodedef-extract.mjs
//
// Build-time port of the nodedef-walking logic from js/docs/port-tables.jsx
// and js/docs/impl-matrix.jsx (browser code is now pure presentational).
// Run by scripts/build-nodelib.mjs to produce js/gen/nodelib-index.json.

// Ported from js/mtlx-engine.js's vecToArray: normalizes MaterialX's
// std::vector marshaling (real Array or {size(),get(i)}) to a plain Array.
// Current binding always returns Arrays; kept for future-binding safety.
export const vecToArray = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v.size === 'function') {
        const out = [];
        for (let i = 0; i < v.size(); i++) out.push(v.get(i));
        // Unlike js/mtlx-engine.js's copy, this one doesn't delete() the
        // vector wrapper: this is a one-shot build-time script and the
        // process exits right after, so any wasm-heap growth here is moot.
        return out;
    }
    return [];
};

// Ported from js/docs/port-tables.jsx's safeType: an element's type, or ''
// if the binding throws (e.g. a detached element) — for display/signature
// strings where a thrown exception shouldn't abort the whole computation.
export const safeType = (el) => { try { return el.getType(); } catch (e) { return ''; } };

// Ported from js/docs/port-tables.jsx: getActiveInputs/Outputs(), falling
// back to getInputs/Outputs() on older bindings without the Active variants.
export const defInputs = (def) => vecToArray(def.getActiveInputs ? def.getActiveInputs()
    : (def.getInputs ? def.getInputs() : null));
export const defOutputs = (def) => vecToArray(def.getActiveOutputs ? def.getActiveOutputs()
    : (def.getOutputs ? def.getOutputs() : null));

// Ported from js/docs/port-tables.jsx's getPortTables: normalize a node
// entry so callers support both the new ({port_tables:[...]}) schema and
// the old ({ports:{...}}) one.
export const getPortTables = (nodeInfo) => {
    if (Array.isArray(nodeInfo.port_tables)) return nodeInfo.port_tables;
    if (nodeInfo.ports && Object.keys(nodeInfo.ports).length > 0) {
        const firstRow = Object.values(nodeInfo.ports)[0] || {};
        return [{ headers: ['port', ...Object.keys(firstRow)], ports: nodeInfo.ports }];
    }
    return [];
};

// Ported from js/docs/port-tables.jsx's isUndocumented: true when a node
// has no port tables, no notes, and only the spec parser's fallback text
// ("No documentation available.") as description.
export const isUndocumented = (info) => {
    if (getPortTables(info).length > 0) return false;
    if (info.notes) return false;
    const desc = (info.description || '').trim();
    return desc === '' || desc === 'No documentation available.';
};

// Ported from js/docs/port-tables.jsx's nodeDefSigKey: a version-independent
// TYPE-SIGNATURE key (ordered input types + resolved output type). Nodedefs
// sharing this key are the same signature at different versions.
export const nodeDefSigKey = (def) => {
    const inTypes = defInputs(def).map(safeType).join(',');
    let outType = '';
    try { outType = def.getType(); } catch (e) { /* none */ }
    const outs = defOutputs(def);
    if (outs.length) outType = outs.map(safeType).join('+');
    return outType + '|' + inTypes;
};

// Ported from js/docs/port-tables.jsx's groupDefVersions: groups a
// category's nodedefs into one entry per TYPE SIGNATURE, each carrying
// every VERSION (sorted default-first, then version descending).
export const groupDefVersions = (defs) => {
    const byKey = {};
    const order = [];
    for (const def of defs) {
        let key = null;
        try { key = nodeDefSigKey(def); } catch (e) { /* ignore */ }
        if (!key) continue;
        let outType = '';
        try { outType = def.getType(); } catch (e) { /* none */ }
        let version = '';
        try { version = def.getVersionString() || ''; } catch (e) { /* none */ }
        let isDefaultVersion = false;
        try { isDefaultVersion = !!(def.getDefaultVersion && def.getDefaultVersion()); } catch (e) { /* none */ }
        const defaults = {};
        const inputTypes = {};
        const inputs = defInputs(def);
        for (const inp of inputs) {
            let nm = '', dv = '';
            try { nm = inp.getName(); } catch (e) { /* skip */ }
            if (!nm) continue;
            try { dv = (inp.getValueString && inp.getValueString()) || ''; } catch (e) { /* none */ }
            defaults[nm] = dv;
            try { inputTypes[nm] = inp.getType(); } catch (e) { /* none */ }
        }
        const outputTypes = {};
        const outputs = defOutputs(def);
        if (outputs.length) {
            for (const out of outputs) {
                let nm = '';
                try { nm = out.getName(); } catch (e) { /* skip */ }
                if (!nm) continue;
                try { outputTypes[nm] = out.getType(); } catch (e) { /* none */ }
            }
        } else {
            outputTypes['out'] = outType;
        }
        if (!byKey[key]) { byKey[key] = { key, type: outType, versions: [] }; order.push(key); }
        byKey[key].versions.push({
            name: def.getName ? def.getName() : '', version, isDefaultVersion,
            defaults, inputTypes, outputTypes,
        });
    }
    const groups = order.map((key) => {
        const g = byKey[key];
        g.versions.sort((a, b) => {
            if (a.isDefaultVersion !== b.isDefaultVersion) return a.isDefaultVersion ? -1 : 1;
            return b.version.localeCompare(a.version, undefined, { numeric: true });
        });
        return g;
    });
    const typeCounts = {};
    groups.forEach((g) => { typeCounts[g.type] = (typeCounts[g.type] || 0) + 1; });
    groups.forEach((g) => {
        g.ambiguous = typeCounts[g.type] > 1;
        const defaultVersion = g.versions[0];
        const seen = new Set();
        const ordered = [];
        if (defaultVersion) {
            Object.keys(defaultVersion.inputTypes).forEach((nm) => {
                const t = defaultVersion.inputTypes[nm];
                if (t && !seen.has(t)) { seen.add(t); ordered.push(t); }
            });
        }
        g.inSummary = ordered.join(', ');
    });
    return groups;
};

// Ported from js/docs/port-tables.jsx's dedupeDefsBySignature. Collapse
// version-duplicate nodedefs down to their DEFAULT version before building
// auto tables — one table per genuine SIGNATURE, not one per nodedef.
export const dedupeDefsBySignature = (defs) => {
    const chosen = new Map();
    const order = [];
    for (const def of defs) {
        let key = null;
        try { key = nodeDefSigKey(def); } catch (e) { /* ignore */ }
        if (!key) { order.push(def); continue; }
        let isDefault = false;
        try { isDefault = !!(def.getDefaultVersion && def.getDefaultVersion()); } catch (e) { /* none */ }
        if (!chosen.has(key)) { chosen.set(key, def); order.push(key); }
        else if (isDefault) { chosen.set(key, def); }
    }
    return order.map((item) => (typeof item === 'string' ? chosen.get(item) : item));
};

// Ported from js/docs/port-tables.jsx's buildAutoTablesFromDefs: builds
// port tables (viewer's shape) from a node's nodedefs when there's no spec
// documentation. One table per SIGNATURE; callers pre-dedupe versions.
export const buildAutoTablesFromDefs = (defs) => {
    const tables = [];
    for (const def of defs) {
        const ports = {};
        let anyEnum = false;
        const inputs = defInputs(def);
        for (const inp of inputs) {
            let dv = '', enumv = '';
            try { dv = (inp.getValueString && inp.getValueString()) || ''; } catch (e) { /* none */ }
            try { enumv = (inp.getAttribute && inp.getAttribute('enum')) || ''; } catch (e) { /* none */ }
            const row = { description: '', type: inp.getType(), default: dv };
            if (enumv) { row.accepted_values = enumv; anyEnum = true; }
            ports[inp.getName()] = row;
        }
        const outs = defOutputs(def);
        if (outs.length === 0) {
            let t = 'output';
            try { t = def.getType(); } catch (e) { /* keep */ }
            ports['out'] = { description: 'Output', type: t, default: '' };
        } else {
            for (const out of outs) {
                ports[out.getName()] = { description: 'Output', type: out.getType(), default: '' };
            }
        }
        if (Object.keys(ports).length) {
            const headers = anyEnum
                ? ['port', 'description', 'type', 'default', 'accepted_values']
                : ['port', 'description', 'type', 'default'];
            tables.push({ headers, ports });
        }
    }
    return tables;
};

// Ported from js/docs/port-tables.jsx's NodeDefPortsTable union walk; takes
// an already-fetched `defs` array instead of querying stdlib itself. One
// row per distinct input/output name+kind, types deduped across all defs.
export const buildDefPorts = (defs) => {
    const byName = {};
    const order = [];
    const record = (el, kindLabel) => {
        const nm = el.getName();
        const key = kindLabel + ':' + nm;
        let ty = '';
        try { const t = el.getType && el.getType(); ty = (t && t.getName) ? t.getName() : String(t || ''); } catch (e) { ty = ''; }
        let val = '';
        try { val = (el.getValueString && el.getValueString()) || ''; } catch (e) { val = ''; }
        let en = '';
        try { en = (el.getAttribute && el.getAttribute('enum')) || ''; } catch (e) { en = ''; }
        if (!byName[key]) {
            byName[key] = { name: nm, kind: kindLabel, types: [], value: val, enums: en };
            order.push(key);
        }
        if (ty && byName[key].types.indexOf(ty) === -1) byName[key].types.push(ty);
    };
    try {
        for (const def of defs) {
            for (const inp of vecToArray(def.getInputs ? def.getInputs() : null)) record(inp, 'input');
            for (const out of vecToArray(def.getOutputs ? def.getOutputs() : null)) record(out, 'output');
        }
    } catch (e) { /* nodedef read is best-effort */ }
    return order.map((k) => byName[k]);
};

// Ported from js/docs/impl-matrix.jsx's TARGET_INHERITANCE. Per
// libraries/targets/{genmsl,genslangl,essl}.mtlx, these targets declare
// inherit="genglsl", so nodedefs without an explicit impl still render.
export const TARGET_INHERITANCE = { essl: 'genglsl', genmsl: 'genglsl', genslang: 'genglsl' };

// Local try/catch helper equivalent to js/mtlx-engine.js's mxSafe, since
// this module has no window/mtlx-engine.js to import from.
const safe = (fn, fb) => { try { const v = fn(); return v == null ? fb : v; } catch (e) { return fb; } };

// Repo-relative path ('libraries/...') from an element source URI —
// modeled on spec-parser.js's libraryFromSourceUri but returns the whole
// path, not just the library name. null if there's no 'libraries' segment.
const repoPathFromSourceUri = (uri) => {
    if (!uri) return null;
    const parts = String(uri).replace(/\\/g, '/').split('/');
    const i = parts.indexOf('libraries');
    return i === -1 ? null : parts.slice(i).join('/');
};
// file= is relative to the impl .mtlx's directory and may climb ('../
// genglsl/mx_image_float.glsl'). No file= -> the containing .mtlx.
const resolveImplFile = (implUri, fileAttr) => {
    const implPath = repoPathFromSourceUri(implUri);
    if (!implPath) return null;
    if (!fileAttr) return implPath;
    const segs = implPath.split('/').slice(0, -1);
    for (const s of String(fileAttr).replace(/\\/g, '/').split('/')) {
        if (!s || s === '.') continue;
        if (s === '..') segs.pop(); else segs.push(s);
    }
    const out = segs.join('/');
    return out.indexOf('libraries/') === 0 ? out : null; // never escape the mirror
};

// Ported from js/docs/impl-matrix.jsx's getImplIndex as buildImplIndex
// ({mx, stdlib}) — drops the promise/lock machinery since this runs once
// synchronously in Node, not concurrently in a browser.
export const buildImplIndex = ({ mx, stdlib } = {}) => {
    const impls = vecToArray(safe(() => stdlib.getImplementations(), []));
    const index = {};
    impls.forEach((impl) => {
        const nodedefName = safe(() => impl.getAttribute('nodedef'), null);
        if (!nodedefName) return;
        if (!index[nodedefName]) index[nodedefName] = { targets: new Set(), inherited: new Set(), graph: false, files: {}, graphFile: null };
        const entry = index[nodedefName];
        const ngAttr = safe(() => impl.getAttribute('nodegraph'), '');
        if (ngAttr) {
            entry.graph = true;
            const ng = safe(() => stdlib.getNodeGraph(ngAttr), null);
            if (!entry.graphFile) entry.graphFile = repoPathFromSourceUri(safe(() => (ng || impl).getSourceUri(), ''));
            return;
        }
        const target = safe(() => impl.getAttribute('target'), null);
        if (target) {
            entry.targets.add(target);
            const sourceUri = safe(() => impl.getSourceUri(), '');
            const fileAttr = safe(() => impl.getAttribute('file'), '');
            const resolved = resolveImplFile(sourceUri, fileAttr);
            if (resolved != null && !entry.files[target]) entry.files[target] = resolved;
        }
    });
    // A <nodegraph> can serve directly as a function implementation when it
    // carries a `nodedef` attribute itself (dominant pattern in stdlib).
    const nodegraphs = vecToArray(safe(() => stdlib.getNodeGraphs(), []));
    nodegraphs.forEach((g) => {
        const nodedefName = safe(() => g.getAttribute('nodedef'), null);
        if (!nodedefName) return;
        if (!index[nodedefName]) index[nodedefName] = { targets: new Set(), inherited: new Set(), graph: false, files: {}, graphFile: null };
        const entry = index[nodedefName];
        entry.graph = true;
        if (!entry.graphFile) entry.graphFile = repoPathFromSourceUri(safe(() => g.getSourceUri(), ''));
    });
    // Resolve target inheritance.
    Object.values(index).forEach((entry) => {
        Object.entries(TARGET_INHERITANCE).forEach(([child, parent]) => {
            if (entry.targets.has(parent) && !entry.targets.has(child)) {
                entry.inherited.add(child);
            }
            if (entry.files[parent] && !entry.files[child]) entry.files[child] = entry.files[parent];
        });
    });
    return index;
};

// Ported from js/docs/impl-matrix.jsx's ImplTargetMatrix per-node bySig
// grouping effect. defs is one category's nodedef array, index is
// buildImplIndex's return value; Sets become sorted arrays in the output.
export const buildImplRows = (index, defs) => {
    const bySig = {};
    const order = [];
    defs.forEach((def) => {
        let key = null;
        try { key = nodeDefSigKey(def); } catch (e) { /* ignore */ }
        const defName = safe(() => def.getName(), null);
        if (!key) key = defName || String(order.length);
        let outType = '';
        try { outType = def.getType(); } catch (e) { /* none */ }
        if (!bySig[key]) {
            bySig[key] = { key, type: outType, targets: new Set(), inherited: new Set(), graph: false, files: {}, graphFile: null };
            order.push(key);
        }
        const info = defName && index[defName];
        if (info) {
            if (info.graph) bySig[key].graph = true;
            info.targets.forEach((t) => bySig[key].targets.add(t));
            info.inherited.forEach((t) => bySig[key].inherited.add(t));
            // First-wins merge: multiple versions can share a sig key
            // (grouped by signature, not name) — keep whichever
            // files/graphFile were captured first, not the later version.
            Object.entries(info.files).forEach(([t, p]) => { if (p && !bySig[key].files[t]) bySig[key].files[t] = p; });
            if (info.graphFile && !bySig[key].graphFile) bySig[key].graphFile = info.graphFile;
        }
    });
    return order.map((key) => {
        const r = bySig[key];
        const row = { key: r.key, type: r.type, targets: [...r.targets].sort(), inherited: [...r.inherited].sort(), graph: r.graph };
        const fileKeys = Object.keys(r.files).sort();
        if (fileKeys.length) {
            const files = {};
            fileKeys.forEach((t) => { files[t] = r.files[t]; });
            row.files = files;
        }
        if (r.graphFile) row.graphFile = r.graphFile;
        return row;
    });
};
