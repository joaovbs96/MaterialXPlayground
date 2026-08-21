// doc-links.jsx — project links, permalink hash<->selection helpers,
// and official spec deep-link URL builders for the MaterialX node
// documentation browser. Loaded as text/babel, which runs each file
// in its own scope, so the public API is exported onto window at
// the bottom.

        // Project links. js/site-header.js is the single source of truth and
        // sets window.SITE_LINKS synchronously before this file runs.
        const REPO_URL = window.SITE_LINKS.repo;
        const ISSUES_URL = window.SITE_LINKS.issues;
        const SPEC_DOCS_URL = window.SITE_LINKS.spec;

        // Permalinks: #/lib/group/name addresses a node in the URL hash
        // (e.g. #/stdlib/math/add). A name-only hash (#/multiply) also
        // resolves, by exact match then squashed key, with stdlib winning ties.
        const selToHash = (sel) =>
            sel ? '#/' + [sel.lib, sel.group, sel.name].map(encodeURIComponent).join('/') : '';

        // Parses a `?sig=<token>` suffix from a VS Code hover deep link
        // (see vscode_extension's extension.js/nodeSignature.js) into
        // { out, ins } or null — re-validated here since hashes are untrusted.
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

            // Strip a `?sig=...` suffix before splitting into lib/group/
            // name segments — it's an optional signature hint, not part
            // of addressing; no '?' leaves old permalinks resolving unchanged.
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
                // Fall through to the name search rather than giving up. A
                // stale or wrongly-derived lib/group otherwise resolves to
                // nothing, and the page silently shows its default node
                // instead of the one the link asked for.
            }

            // Name-only deep link: #/<name> (a 2-segment hash resolves by its
            // last segment too, tolerating a future #/n/<name> style).
            const want = parts.length >= 3 ? parts.slice(2).join('/') : parts[parts.length - 1];
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
        // Prefers node.info.spec_url when present; otherwise derives it
        // from the hyphenated "node-<name>" anchor convention in the spec
        // MD (e.g. oren_nayar_diffuse_bsdf → #node-oren-nayar-diffuse-bsdf).
        const SPEC_BASE = window.SITE_LINKS.specBlobBase;
        // Library -> spec markdown file mapping; fallback only.
        // specUrlForNode prefers node.info.spec_url (always supplied by
        // js/gen/nodelib.json) and falls through to this when that's missing.
        const specFileForLib = (lib) => {
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

        // ---- Vendored-library implementation deep-links ----
        // repoPath is a resolved 'libraries/...' path from js/gen/nodelib-
        // index.json (built by nodedef-extract.mjs's resolveImplFile).
        // Tag-pinned via libBlobBase, matching that exact vendored checkout.
        const implFileUrl = (repoPath) => repoPath ? window.SITE_LINKS.libBlobBase + repoPath : null;

        // ---- public API ----
        // REPO_URL/SPEC_DOCS_URL/specFileForLib have no outside consumers
        // (repo-wide grep), so they're omitted below; specFileForLib backs
        // specUrlForNode, REPO_URL backs ISSUES_URL's fallback.
        Object.assign(window, {
            ISSUES_URL,
            selToHash, hashToSel,
            specUrlForNode,
            implFileUrl,
        });
