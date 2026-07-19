// js/mtlx-assets.js — MaterialX asset resolver: local-first probe that
// decides, once per page load, whether MaterialX spec/template files ship
// inside vendor/materialx/ (a future offline/packaged build) or must be
// fetched live from the upstream GitHub repo (the web build, as it works
// today). Every consumer that needs a URL into the MaterialX repo — the
// spec parser, the viewer/graph default documents, the graph editor's
// curated presets — goes through this module instead of hardcoding
// raw.githubusercontent.com itself, so the offline/online split lives in
// exactly one place.
//
// PLAIN SCRIPT — deliberately NOT JSX, NOT an ES module. Loaded via a
// normal <script src="js/mtlx-assets.js"> tag in BOTH entry HTMLs
// (index.html and vscode_extension/media/webview.html), placed AFTER the
// vendored core libs but BEFORE every type="text/babel" tag — including
// js/mtlx-engine.js's own eager text/babel load — and before Babel has
// necessarily finished initializing. So this file must run as plain,
// untranspiled JS with zero dependency on Babel or React having loaded
// yet. Its only external dependency is the browser's native fetch API.
//
// ------------------------------------------------------------------
// THE PROBE — runs exactly once, starting at PARSE time of this script
// (not lazily on first use):
// ------------------------------------------------------------------
//   fetch('vendor/materialx/manifest.json', { cache: 'no-store' })
//     res.ok            -> LOCAL mode  (offline/packaged build)
//     anything else
//     (404, network error, ...) -> REMOTE mode (today's web build)
//
// The probe's result is FINAL for the lifetime of the page: there is no
// re-probing, no per-file fallback, no retry-against-remote. See HARD
// MODE ISOLATION below.
//
// Why a probe instead of a build-time flag: the web app and a future
// packaged/offline build share the exact same index.html + js/*.js —
// there is no build step (Babel runs in-browser, on the original
// sources, at page load). The only difference between "today's web
// build" and "a future offline package" is whether vendor/materialx/ was
// populated by a CI step before shipping. Probing for
// vendor/materialx/manifest.json's presence lets that distinction be
// made purely from what files exist on disk, with ZERO code changes
// required when a future CI job starts dropping MaterialX repo content
// into vendor/materialx/ (see "FUTURE CI DROP-IN ZONE" below).
//
// ------------------------------------------------------------------
// HARD MODE ISOLATION (the offline-build guarantee):
// ------------------------------------------------------------------
// In LOCAL mode this module NEVER constructs a raw.githubusercontent.com
// (or any other remote-host) URL — not as a fallback, not per-file, not
// under any error condition, not even for a relPath the local vendor
// tree happens to be missing. A MaterialX asset absent from
// vendor/materialx/ in local mode surfaces as an ordinary LOCAL 404,
// which every consumer already has an error path for (the spec-docs
// "could not load spec text" console warning in js/spec-parser.js,
// js/graph-app.jsx's "Could not load preset" error, and
// js/viewer-app.jsx's default-material load catch). There is no code
// path anywhere in this file — nor in any consumer, since every remote
// MaterialX URL in the codebase is required to be produced EXCLUSIVELY
// by this module — that retries a local miss against GitHub. This is
// what makes a future packaged/offline build (vendor/materialx/
// manifest.json present) structurally unable to reach the network for
// MaterialX content, even when some files are missing from the vendored
// tree and the machine has live internet access.
//
// isSafePresetUrl-style prefix guards elsewhere in the app (currently
// js/graph-app.jsx, guarding a preset document's xi:include/texture
// crawl) key off resourcesRoot() below, so even a maliciously crafted
// href inside a MaterialX document can only ever resolve to a path under
// the ACTIVE mode's own resources root — never across modes, never to an
// arbitrary host.
//
// ------------------------------------------------------------------
// PUBLIC API — window.MtlxAssets:
// ------------------------------------------------------------------
//   .ready                  Promise, resolves once the probe above
//                            settles (never rejects — network/parse
//                            errors just resolve to remote mode). Every
//                            consumer that has a choice of WHEN to run
//                            must await this before calling anything
//                            else here. js/shell.jsx's loadViewDeps does
//                            this exactly once, before any view's deps
//                            load, so every lazily-loaded view (docs,
//                            viewer, graph) can treat the rest of this
//                            API as synchronous.
//   .isLocal()               boolean. Meaningful only after `ready`
//                            resolves; before that it reflects the
//                            not-yet-final pre-probe default (remote) —
//                            don't call it early.
//   .repoUrl(relPath, tag)   Absolute URL to `relPath` inside the
//                            MaterialX repo (e.g.
//                            'resources/Materials/Examples/OpenPbr/
//                            open_pbr_default.mtlx', or a spec directory
//                            like 'documents/Specification/'). `tag`
//                            (a git tag/branch, e.g. 'v1.39.5') is used
//                            ONLY in remote mode; local mode ignores it
//                            outright — the vendored tree is a single
//                            fixed snapshot, there's no such thing as
//                            picking a tag offline.
//   .resourcesRoot()         Absolute URL to the repo's resources/
//                            directory for the ACTIVE mode — the prefix
//                            consumers should use to sanity-check that a
//                            derived URL (e.g. a preset's xi:include
//                            target) didn't escape outside the resources
//                            tree.
//
// All returned URLs are ABSOLUTE (never relative) in both modes: local
// URLs are resolved with `new URL(..., document.baseURI).href` so this
// module behaves identically in index.html (page origin) and inside the
// VS Code webview, where `document.baseURI` is the extension's
// vscode-resource root rather than a normal page origin.
//
// ------------------------------------------------------------------
// FUTURE CI DROP-IN ZONE (not built yet — see WP-A's scripts/vendor.mjs
// header comment for the vendoring pipeline this plugs into):
// ------------------------------------------------------------------
// A future GitHub Actions job (packaging an offline release) is expected
// to populate vendor/materialx/ with:
//   vendor/materialx/manifest.json                    <- presence = the probe marker (content unused, just needs to exist + 2xx)
//   vendor/materialx/documents/Specification/*.md
//   vendor/materialx/resources/Materials/Examples/**   <- presets + default docs (+ their xi:include deps)
//   vendor/materialx/resources/Images/**               <- textures reached via ../../../Images/ path math
// Dropping those files in requires ZERO changes to this file, or to any
// consumer of it — the probe above picks up local mode automatically the
// next time the page loads.
// ------------------------------------------------------------------

(function () {
    'use strict';

    // Single source of truth for the upstream repo + default spec tag —
    // mirrors js/spec-parser.js's own REPO/SPEC_TAG constants (kept
    // separate rather than shared, since this file must stay a
    // standalone plain script with no dependency on load order relative
    // to spec-parser.js).
    var REPO = 'AcademySoftwareFoundation/MaterialX';
    var DEFAULT_TAG = 'v1.39.5';

    // Local vendor mirror root + the probe marker inside it.
    var LOCAL_ROOT = 'vendor/materialx/';
    var MANIFEST_PATH = LOCAL_ROOT + 'manifest.json';

    // Set exactly once, when `ready` settles below. Read only through
    // isLocal() so every read funnels through one place. Starts `false`
    // (remote) — nothing in this codebase is supposed to call
    // isLocal()/repoUrl()/resourcesRoot() before `ready`
    // resolves, but should a caller do it anyway, this default keeps
    // that early call on today's already-safe remote behavior instead of
    // silently pretending to be an (unverified) local build.
    var localMode = false;

    // Kicked off immediately at parse time — by the time any consumer
    // could plausibly await `ready`, the fetch is likely already
    // in-flight or resolved.
    var ready = fetch(MANIFEST_PATH, { cache: 'no-store' })
        .then(function (res) {
            localMode = !!(res && res.ok);
        })
        .catch(function () {
            // Network error, offline, CSP block, whatever — no local
            // manifest reachable means remote mode, exactly like a 404.
            localMode = false;
        });

    function isLocal() {
        return localMode;
    }

    // Absolute-ify a vendor/materialx/-relative path against the page's
    // own base URL. Using `document.baseURI` (rather than a hand-rolled
    // origin string) is what makes this correct both in index.html and
    // inside the VS Code webview, where the page has a `<base href="...">`
    // pointing at the extension's vscode-resource root.
    function localUrl(relPath) {
        return new URL(LOCAL_ROOT + relPath, document.baseURI).href;
    }

    function repoUrl(relPath, tag) {
        if (localMode) return localUrl(relPath);
        return 'https://raw.githubusercontent.com/' + REPO + '/' +
            (tag || DEFAULT_TAG) + '/' + relPath;
    }

    function resourcesRoot() {
        return repoUrl('resources/');
    }

    window.MtlxAssets = {
        ready: ready,
        isLocal: isLocal,
        repoUrl: repoUrl,
        resourcesRoot: resourcesRoot,
        // Pinned MaterialX repo tag, exposed so other single-file scripts
        // (js/spec-parser.js, js/site-header.js) can default to this
        // module's DEFAULT_TAG instead of duplicating the literal.
        MTLX_TAG: DEFAULT_TAG,
    };
})();
