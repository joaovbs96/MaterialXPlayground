// doc-links.jsx — project links, permalink hash<->selection helpers, and
// official spec deep-link URL builders for the MaterialX node
// documentation browser. Split out of doc-ui.jsx (Phase 3) — pure move,
// no behavior change. Loaded as text/babel; Babel executes each file in
// its own function scope, so the public API is exported onto window at
// the bottom.

        // Project links. The shared header (js/site-header.js) is the single
        // source of truth when it's loaded; the literals below are fallbacks
        // so doc-ui also works standalone.
        const REPO_URL = (window.SITE_LINKS && window.SITE_LINKS.repo) || 'https://github.com/joaovbs96/MaterialXNodeDocs';
        const ISSUES_URL = (window.SITE_LINKS && window.SITE_LINKS.issues) || (REPO_URL + '/issues');
        const SPEC_DOCS_URL = (window.SITE_LINKS && window.SITE_LINKS.spec) || 'https://github.com/AcademySoftwareFoundation/MaterialX/tree/main/documents/Specification';

        // Permalinks: a node is addressed by lib/group/name in the URL hash,
        // e.g. #/stdlib/math/add — hash routing needs no server config, so it
        // works as-is on GitHub Pages. These convert between a selection and
        // the hash both ways. A NAME-ONLY hash (#/multiply) is also accepted:
        // other pages (e.g. the node graph's "?" documentation button) know a
        // node's category but not its library/group, so it's resolved here by
        // search — exact name first, then the squashed-key convention the
        // cross-reference index uses (separators stripped, lowercased), with
        // 'stdlib' winning ties so ambiguous names resolve deterministically.
        const selToHash = (sel) =>
            sel ? '#/' + [sel.lib, sel.group, sel.name].map(encodeURIComponent).join('/') : '';

        // Parses a `?sig=<token>` query suffix — a VS Code hover deep
        // link only (see vscode_extension/src/extension.js's openDocs
        // command and its SIG_TOKEN_RE; selToHash above never emits one)
        // — into { out, ins: [{name, type}] }, or null when absent/
        // malformed. Token shape mirrors vscode_extension/src/
        // nodeSignature.js's buildSigToken output exactly: `<outType>`
        // optionally followed by `(<name>:<type>,...)`. extension.js
        // already shape-validated the token before ever building the
        // hash, but this parse is independently defensive — a hand-
        // typed/pasted/bookmarked hash is untrusted input too.
        const SIG_HINT_RE = /^([\w.\-:]+)(?:\(([^)]*)\))?$/;
        const parseSigHint = (query) => {
            if (!query) return null;
            let sigRaw = null;
            for (const pair of query.split('&')) {
                if (pair.slice(0, 4) === 'sig=') { sigRaw = pair.slice(4); break; }
            }
            if (!sigRaw) return null;
            let sig;
            try { sig = decodeURIComponent(sigRaw); } catch (e) { return null; }
            const m = SIG_HINT_RE.exec(sig);
            if (!m) return null;
            const ins = [];
            if (m[2]) {
                for (const pair of m[2].split(',')) {
                    const idx = pair.indexOf(':');
                    if (idx === -1) continue; // malformed pair — skip, not fatal
                    const name = pair.slice(0, idx);
                    const type = pair.slice(idx + 1);
                    if (name && type) ins.push({ name, type });
                }
            }
            return { out: m[1], ins };
        };

        const hashToSel = (data, hash) => {
            if (!data || !hash) return null;
            let body = hash.replace(/^#\/?/, '');
            if (!body) return null;

            // Strip a `?sig=...` suffix BEFORE splitting into lib/group/
            // name segments — it's not part of the addressing scheme,
            // just an optional hint for which signature to pre-select
            // once the node itself resolves. `q === -1` (no '?' at all —
            // every permalink the site itself ever writes) leaves body/
            // sigHint exactly as they were before this feature existed,
            // so existing permalinks resolve identically.
            const q = body.indexOf('?');
            const sigHint = q === -1 ? null : parseSigHint(body.slice(q + 1));
            if (q !== -1) body = body.slice(0, q);

            const parts = body.split('/').map((s) => { try { return decodeURIComponent(s); } catch (e) { return s; } });
            // Attaches sigHint (when one was parsed) onto an otherwise-
            // resolved selection, on every successful return path below.
            const withSig = (sel) => {
                if (sel && sigHint) sel.sigHint = sigHint;
                return sel;
            };

            // Canonical form: #/lib/group/name (what this page itself writes).
            if (parts.length >= 3) {
                const name = parts.slice(2).join('/'); // names shouldn't contain '/', but be safe
                const [lib, group] = parts;
                if (data[lib] && data[lib][group] && data[lib][group][name]) {
                    return withSig({ lib, group, name, info: data[lib][group][name] });
                }
                return null;
            }

            // Name-only deep link: #/<name> (a 2-segment hash resolves by its
            // last segment too, tolerating a future #/n/<name> style).
            const want = parts[parts.length - 1];
            if (!want) return null;
            const squash = (s) => String(s).replace(/[-_]/g, '').toLowerCase();
            const wantKey = squash(want);
            const libs = Object.keys(data).sort((a, b) =>
                (a === 'stdlib' ? -1 : b === 'stdlib' ? 1 : a.localeCompare(b)));
            let fuzzy = null; // first squashed-key match, kept only if no exact match exists anywhere
            for (const lib of libs) {
                for (const group of Object.keys(data[lib]).sort()) {
                    const nodes = data[lib][group];
                    if (nodes[want]) return withSig({ lib, group, name: want, info: nodes[want] });
                    if (!fuzzy) {
                        for (const name of Object.keys(nodes)) {
                            if (squash(name) === wantKey) { fuzzy = { lib, group, name, info: nodes[name] }; break; }
                        }
                    }
                }
            }
            return withSig(fuzzy);
        };

        // ---- Official spec deep-links ----
        // Prefer a parser-provided `spec_url` (new JSON schema regenerated
        // from spec_parser.py). For older JSON, derive it: the spec file
        // follows the node's library, and the heading anchors in the spec MD
        // follow the hyphenated "node-<name>" convention observed in the MD
        // (e.g. oren_nayar_diffuse_bsdf → #node-oren-nayar-diffuse-bsdf).
        // GitHub resolves those fragments to user-content-prefixed ids.
        const SPEC_BASE = 'https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/Specification/';
        // Delegates to spec-parser.js's identical mapping (js/spec-parser.js's
        // specFileForLibrary) when it's loaded, so the two copies can't drift;
        // the inline fallback keeps this file working standalone.
        const specFileForLib = (lib) => {
            if (window.MtlxSpecParser && window.MtlxSpecParser.specFileForLibrary) {
                return window.MtlxSpecParser.specFileForLibrary(lib);
            }
            const base = (lib || '').split('/')[0];
            if (base === 'pbrlib' || base === 'bxdf') return 'MaterialX.PBRSpec.md';
            if (base === 'nprlib') return 'MaterialX.NPRSpec.md';
            if (base === 'stdlib') return 'MaterialX.StandardNodes.md';
            return 'MaterialX.Specification.md';
        };
        const specUrlForNode = (node) => {
            if (node.info && node.info.spec_url) return node.info.spec_url;
            return SPEC_BASE + specFileForLib(node.lib) + '#node-' + node.name.replace(/_/g, '-');
        };

        // ---- public API ----
        // REPO_URL/SPEC_DOCS_URL/specFileForLib have no consumers outside
        // this file (checked repo-wide, word-boundary grep) — kept as
        // declarations (specFileForLib backs specUrlForNode; REPO_URL backs
        // ISSUES_URL's fallback) but omitted from the export list.
        Object.assign(window, {
            ISSUES_URL,
            selToHash, hashToSel,
            specUrlForNode,
        });
