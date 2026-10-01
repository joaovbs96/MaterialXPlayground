// Content signatures for node thumbnails: a canonical, rename-safe string of a
// target's upstream closure, hashed with FNV-1a 64. Pure; no DOM, no WASM.
// Tree shape: { tag, attrs: {...}, kids: [...] }, root is the materialx element.
(function () {
  'use strict';

  const SKIP_ATTRS = new Set(['name', 'xpos', 'ypos', 'uicolor', 'doc', 'uiname', 'uifolder']);
  const UI_ATTRS = new Set(['xpos', 'ypos', 'uicolor', 'doc', 'uiname', 'uifolder']);
  const DEF_TAGS = new Set(['nodedef', 'implementation', 'typedef']);
  const REF = new Set(['nodename', 'nodegraph', 'interfacename']);

  // FNV-1a 64 on two 32-bit halves. The prime is 2^40 + 435.
  function fnv64(str) {
    let hi = 3421674724;
    let lo = 2216829733;
    const step = (b) => {
      lo = (lo ^ b) >>> 0;
      const lo2 = lo * 435;
      const carry = Math.floor(lo2 / 4294967296);
      const nlo = lo2 % 4294967296;
      const nhi = (hi * 435 + carry + (lo & 16777215) * 256) % 4294967296;
      lo = nlo;
      hi = nhi;
    };
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 128) step(c);
      else { step(c >> 8); step(c & 255); }
    }
    const h8 = (n) => n.toString(16).padStart(8, '0');
    return h8(hi) + h8(lo);
  }

  function attrsOf(el) { return (el && el.attrs) || {}; }
  function kidsOf(el) { return (el && el.kids) || []; }
  function nameOf(el) { return String(attrsOf(el).name || ''); }

  // Full sorted dump of a subtree (names kept), used for the definitions hash.
  function dumpTree(el) {
    const a = attrsOf(el);
    let s = '<' + el.tag;
    for (const k of Object.keys(a).sort()) {
      if (!UI_ATTRS.has(k)) s += ' ' + k + '=' + a[k];
    }
    s += '>';
    for (const kid of kidsOf(el)) s += dumpTree(kid);
    return s + '</>';
  }

  function attrStr(el, skipRefs) {
    const a = attrsOf(el);
    let s = '';
    for (const k of Object.keys(a).sort()) {
      if (SKIP_ATTRS.has(k) || (skipRefs && REF.has(k))) continue;
      s += ';' + k + '=' + a[k];
    }
    return s;
  }

  function computeSignatures(root, targets, opts) {
    const o = opts || {};
    const fileIdentity = typeof o.fileIdentity === 'function' ? o.fileIdentity : (v) => String(v == null ? '' : v);
    const salt = String(o.salt == null ? '' : o.salt);
    const out = {};
    if (!root || !Array.isArray(targets)) return out;

    const rootKids = kidsOf(root);
    const graphs = new Map();
    const nodeDefNodes = new Set();
    for (const k of rootKids) {
      if (k.tag === 'nodegraph' && !graphs.has(nameOf(k))) graphs.set(nameOf(k), k);
      if (k.tag === 'nodedef' && attrsOf(k).node) nodeDefNodes.add(attrsOf(k).node);
    }

    const nameMaps = new Map();
    const childByName = (container, name, tag) => {
      let m = nameMaps.get(container);
      if (!m) { m = new Map(); nameMaps.set(container, m); }
      const ck = (tag || '*') + ':' + name;
      if (m.has(ck)) return m.get(ck);
      let found = null;
      for (const k of kidsOf(container)) {
        if (nameOf(k) !== name) continue;
        const ok = tag === 'node' ? (k.tag !== 'input' && k.tag !== 'output') : (!tag || k.tag === tag);
        if (ok) { found = k; break; }
      }
      m.set(ck, found);
      return found;
    };

    let defsHashCache = null;
    const defsHash = () => {
      if (defsHashCache === null) {
        let s = '';
        for (const k of rootKids) {
          if (DEF_TAGS.has(k.tag) || (k.tag === 'nodegraph' && attrsOf(k).nodedef)) s += dumpTree(k);
        }
        defsHashCache = fnv64(s);
      }
      return defsHashCache;
    };

    const resolve = (scope, id) => {
      if (typeof id !== 'string' || id.length < 3 || id[1] !== ':') return null;
      const kind = id[0];
      const name = id.slice(2);
      if (kind === 'g') {
        const g = graphs.get(name);
        return g ? { el: g, container: root, anc: [root] } : null;
      }
      if (kind === 'd') {
        const d = childByName(root, name, 'nodedef');
        return d ? { el: d, container: root, anc: [root], def: true } : null;
      }
      let container = root;
      let anc = [root];
      if (scope) {
        container = graphs.get(scope);
        if (!container) return null;
        anc = [root, container];
      }
      let el = null;
      if (kind === 'n') el = childByName(container, name, 'node');
      else if (kind === 'o') el = childByName(container, name, 'output');
      else if (kind === 'i') {
        if (container === root) el = null;
        else if (attrsOf(container).nodedef) {
          // Functional graph: its interface inputs live on the nodedef.
          const nd = childByName(root, attrsOf(container).nodedef, 'nodedef');
          el = nd ? childByName(nd, name, 'input') : null;
        } else el = childByName(container, name, 'input');
      }
      return el ? { el, container, anc } : null;
    };

    const signOne = (target) => {
      const main = resolve(target.scope || '', target.id);
      if (!main) return null;
      let origin = null;
      if (target.originId) {
        origin = resolve(target.originScope || '', target.originId);
        if (!origin) return null;
      }
      const idx = new Map();
      const records = [];
      let counter = 0;
      let needDefs = !!main.def || (main.container !== root && !!attrsOf(main.container).nodedef);

      const visit = (el, container, anc) => {
        if (idx.has(el)) return idx.get(el);
        const k = counter++;
        idx.set(el, k);
        const a = attrsOf(el);
        if (nodeDefNodes.has(el.tag) || a.nodedef) needDefs = true;
        let s = '#' + k + ' ' + el.tag + attrStr(el, true);
        const here = anc.concat(el);
        if (a.nodename) {
          const t = childByName(container, a.nodename, null);
          s += ';nodename=' + (t ? '#' + visit(t, container, anc) : '?');
        }
        if (a.nodegraph) {
          const g = graphs.get(a.nodegraph);
          s += ';nodegraph=' + (g ? '#' + visit(g, root, [root]) : '?');
        }
        if (a.interfacename) {
          const t = container === root ? null : childByName(container, a.interfacename, 'input');
          s += ';interface=' + (t ? '#' + visit(t, container, anc) : '?');
        }
        if (a.type === 'filename' && el.tag === 'input') s += ';file=' + fileIdentity(a.value, el, anc);
        if (el.tag === 'nodegraph') {
          for (const kid of kidsOf(el)) s += ' [' + visit(kid, el, here) + ']';
        } else {
          const ports = kidsOf(el).slice().sort((p, q) => {
            const pn = nameOf(p), qn = nameOf(q);
            return pn < qn ? -1 : pn > qn ? 1 : 0;
          });
          for (const p of ports) s += ' {' + nameOf(p) + ':' + visit(p, container, here) + '}';
        }
        records.push(s);
        return k;
      };

      let head = salt + '\nROOT' + attrStr(root, false);
      if (main.container !== root) head += '\nSCOPE' + attrStr(main.container, false);
      visit(main.el, main.container, main.anc);
      records.push('ORIGIN');
      if (origin) {
        if (origin.container !== root) {
          records.push('OSCOPE' + attrStr(origin.container, false));
          if (attrsOf(origin.container).nodedef) needDefs = true;
        }
        visit(origin.el, origin.container, origin.anc);
      }
      let canon = head + '\n' + records.join('\n');
      if (needDefs) canon += '\nDEFS:' + defsHash();
      return fnv64(canon);
    };

    for (const t of targets) {
      if (!t || t.key == null) continue;
      const sig = signOne(t);
      if (sig) out[t.key] = sig;
    }
    return out;
  }

  const api = { computeSignatures, fnv64 };
  globalThis.MtlxThumbSignature = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})();
