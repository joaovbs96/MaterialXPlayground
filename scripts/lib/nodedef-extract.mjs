// scripts/lib/nodedef-extract.mjs
//
// Build-land port of the nodedef-walking machinery that used to live in two
// browser files — js/docs/port-tables.jsx (defInputs/defOutputs/safeType,
// nodeDefSigKey, groupDefVersions, dedupeDefsBySignature,
// buildAutoTablesFromDefs, getPortTables/isUndocumented, and the
// NodeDefPortsTable union-walk ported here as buildDefPorts) and
// js/docs/impl-matrix.jsx (TARGET_INHERITANCE, buildImplIndex ported from
// getImplIndex, buildImplRows ported from ImplTargetMatrix's per-node bySig
// grouping effect). Both browser files have since been trimmed down to pure
// presentational code that renders pregenerated data instead of walking the
// WASM stdlib live — this module is the one place that logic now lives, run
// once by scripts/build-nodelib.mjs (Node, no browser/React/window) to
// produce js/gen/nodelib-index.json ("Layer 2": per-category signature/
// version groups, auto-generated port tables for undocumented nodes,
// def-port fallback rows, and the implementation-target matrix).
//
// Plain ESM, zero runtime dependencies, no window/DOM — every helper here
// takes its MaterialX WASM objects (nodedefs, {mx, stdlib}) as plain
// arguments and returns plain JSON-serializable data.

// Ported from js/mtlx-engine.js's vecToArray (~line 583): MaterialX JS
// marshals std::vector either as a real JS array or as a {size(), get(i)}
// object depending on the binding; normalize to array. Kept even though
// this repo's current vendored binding always returns real Arrays (verified:
// getNodeDefs/getImplementations/getMatchingNodeDefs/getNodeGraphs etc. all
// return plain Arrays under Node 24) — this tolerance is the established
// convention throughout this codebase for defensiveness against a future
// binding that marshals differently.
export const vecToArray = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v.size === 'function') {
        const out = [];
        for (let i = 0; i < v.size(); i++) out.push(v.get(i));
        return out;
    }
    return [];
};

// Ported from js/docs/port-tables.jsx's safeType: an input/output element's
// type, or '' if the wasm binding throws (e.g. a detached/invalid element) —
// used wherever a type is only needed for a display/signature string and a
// thrown exception shouldn't abort the whole computation.
export const safeType = (el) => { try { return el.getType(); } catch (e) { return ''; } };

// Ported from js/docs/port-tables.jsx: def.getActiveInputs()/
// getActiveOutputs(), falling back to getInputs()/getOutputs() on older
// bindings that don't expose the Active variants — the vecToArray-wrapped
// pattern repeated at every nodedef-walking helper below.
export const defInputs = (def) => vecToArray(def.getActiveInputs ? def.getActiveInputs()
    : (def.getInputs ? def.getInputs() : null));
export const defOutputs = (def) => vecToArray(def.getActiveOutputs ? def.getActiveOutputs()
    : (def.getOutputs ? def.getOutputs() : null));

// Ported from js/docs/port-tables.jsx's getPortTables: normalize a node
// entry so callers support both the new schema
// ({ port_tables: [{headers, ports}, ...] }) and the old one
// ({ ports: {...} }).
export const getPortTables = (nodeInfo) => {
    if (Array.isArray(nodeInfo.port_tables)) return nodeInfo.port_tables;
    if (nodeInfo.ports && Object.keys(nodeInfo.ports).length > 0) {
        const firstRow = Object.values(nodeInfo.ports)[0] || {};
        return [{ headers: ['port', ...Object.keys(firstRow)], ports: nodeInfo.ports }];
    }
    return [];
};

// Ported from js/docs/port-tables.jsx's isUndocumented: a node counts as
// undocumented when it has no port tables, no notes, and no real
// description (the spec parser emits the fallback string
// "No documentation available." for spec-less nodedefs). This is what
// scripts/build-nodelib.mjs uses to decide whether a category needs
// autoTables/defPorts.
export const isUndocumented = (info) => {
    if (getPortTables(info).length > 0) return false;
    if (info.notes) return false;
    const desc = (info.description || '').trim();
    return desc === '' || desc === 'No documentation available.';
};

// Ported from js/docs/port-tables.jsx's nodeDefSigKey: a TYPE-SIGNATURE key
// for a WASM nodedef — the ordered input types plus the resolved output
// type, independent of version. Two nodedefs sharing this key are the SAME
// signature at different VERSIONS (standard_surface 1.0.1 / 1.0.0:
// identical ports, only defaults differ) — see dedupeDefsBySignature.
export const nodeDefSigKey = (def) => {
    const inTypes = defInputs(def).map(safeType).join(',');
    let outType = '';
    try { outType = def.getType(); } catch (e) { /* none */ }
    const outs = defOutputs(def);
    if (outs.length) outType = outs.map(safeType).join('+');
    return outType + '|' + inTypes;
};

// Ported from js/docs/port-tables.jsx's groupDefVersions. Group a
// category's nodedefs into one entry per TYPE SIGNATURE, each carrying
// every VERSION of that signature. Returns
// [{ key, type, inSummary, ambiguous, versions: [{ name, version,
// isDefaultVersion, defaults: {portName: valueString},
// inputTypes: {portName: type}, outputTypes: {portName: type} }] }],
// versions sorted default-first then by version string descending.
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

// Ported from js/docs/port-tables.jsx's buildAutoTablesFromDefs. Build port
// tables (same shape the viewer renders) directly from a node's MaterialX
// nodedefs, for nodes with NO spec documentation. One table per SIGNATURE
// (overload) — version-duplicate nodedefs are already collapsed by
// dedupeDefsBySignature before this runs.
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

// Ported from js/docs/port-tables.jsx's NodeDefPortsTable union walk
// (originally queried stdlib.getMatchingNodeDefs(nodeName) itself; ported
// here to instead take an already-fetched `defs` array as a parameter,
// since scripts/build-nodelib.mjs already has that array from its own
// doc.getMatchingNodeDefs(category) call). Returns
// [{name, kind, types: [...], value, enums}], one row per distinct
// input/output name+kind across every def in `defs`, types accumulated
// (deduped, insertion order) across all defs sharing that name+kind.
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

// Ported from js/docs/impl-matrix.jsx's TARGET_INHERITANCE. Confirmed by
// reading libraries/targets/{genmsl,genslangl,essl}.mtlx in the vendored
// MaterialX standard library: these three targets are declared
// inherit="genglsl", so a nodedef with no explicit implementation for one of
// them still renders fine via the inherited GLSL source at generation time.
export const TARGET_INHERITANCE = { essl: 'genglsl', genmsl: 'genglsl', genslang: 'genglsl' };

// Local try/catch helper equivalent to js/mtlx-engine.js's mxSafe, since
// this module has no window/mtlx-engine.js to import from.
const safe = (fn, fb) => { try { const v = fn(); return v == null ? fb : v; } catch (e) { return fb; } };

// Ported from js/docs/impl-matrix.jsx's getImplIndex, as buildImplIndex
// ({mx, stdlib}) — drops the promise/lock machinery (implIndexPromise,
// mxExclusive) since this runs once synchronously in Node. Returns
// nodedefName -> { targets: Set, inherited: Set, graph: bool }.
export const buildImplIndex = ({ mx, stdlib } = {}) => {
    const impls = vecToArray(safe(() => stdlib.getImplementations(), []));
    const index = {};
    impls.forEach((impl) => {
        const nodedefName = safe(() => impl.getAttribute('nodedef'), null);
        if (!nodedefName) return;
        if (!index[nodedefName]) index[nodedefName] = { targets: new Set(), inherited: new Set(), graph: false };
        const ngAttr = safe(() => impl.getAttribute('nodegraph'), '');
        if (ngAttr) { index[nodedefName].graph = true; return; }
        const target = safe(() => impl.getAttribute('target'), null);
        if (target) index[nodedefName].targets.add(target);
    });
    // A <nodegraph> can serve directly as a function implementation when it
    // carries a `nodedef` attribute itself (dominant pattern in stdlib).
    const nodegraphs = vecToArray(safe(() => stdlib.getNodeGraphs(), []));
    nodegraphs.forEach((g) => {
        const nodedefName = safe(() => g.getAttribute('nodedef'), null);
        if (!nodedefName) return;
        if (!index[nodedefName]) index[nodedefName] = { targets: new Set(), inherited: new Set(), graph: false };
        index[nodedefName].graph = true;
    });
    // Resolve target inheritance.
    Object.values(index).forEach((entry) => {
        Object.entries(TARGET_INHERITANCE).forEach(([child, parent]) => {
            if (entry.targets.has(parent) && !entry.targets.has(child)) {
                entry.inherited.add(child);
            }
        });
    });
    return index;
};

// Ported from js/docs/impl-matrix.jsx's ImplTargetMatrix per-node bySig
// grouping effect, as buildImplRows(index, defs) — defs is an
// already-fetched nodedef array for ONE category (same array
// groupDefVersions/dedupeDefsBySignature consume), index is
// buildImplIndex's return value. Sets are converted to SORTED arrays in the
// returned rows.
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
            bySig[key] = { key, type: outType, targets: new Set(), inherited: new Set(), graph: false };
            order.push(key);
        }
        const info = defName && index[defName];
        if (info) {
            if (info.graph) bySig[key].graph = true;
            info.targets.forEach((t) => bySig[key].targets.add(t));
            info.inherited.forEach((t) => bySig[key].inherited.add(t));
        }
    });
    return order.map((key) => {
        const r = bySig[key];
        return { key: r.key, type: r.type, targets: [...r.targets].sort(), inherited: [...r.inherited].sort(), graph: r.graph };
    });
};
