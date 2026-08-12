// js/mtlx-assets.js — MaterialX asset resolver: probes once at load
// whether MaterialX files ship locally in vendor/materialx/ (offline
// build) or must be fetched from the upstream GitHub repo (web build).
// Every consumer resolves repo URLs through this module, keeping that
// split in one place.
//
// Plain script (not JSX/ESM) loaded before Babel/React init, so it must
// run as untranspiled JS. Local mode NEVER falls back to a remote URL —
// the guarantee that keeps an offline build off the network.

(function () {
    'use strict';

    // Single source of truth for the upstream repo + default spec tag.
    // Mirrors js/spec-parser.js's REPO/SPEC_TAG but kept separate so
    // this file has no load-order dependency on spec-parser.js.
    var REPO = 'AcademySoftwareFoundation/MaterialX';
    var DEFAULT_TAG = 'v1.39.5';

    // Local vendor mirror root + the probe marker inside it.
    var LOCAL_ROOT = 'vendor/materialx/';
    var MANIFEST_PATH = LOCAL_ROOT + 'manifest.json';

    // js/gen/mtlx-versions.json (scripts/extract-mtlx-version.mjs) is
    // the generated MaterialX version registry for the Compare view's
    // per-pane dropdown. Always committed (unlike vendor/materialx/,
    // which only exists in an offline build), so it's fetched the same
    // way in every context: web build, offline build, and the VS Code
    // webview (which only intercepts js/materialx/<version>/ payload
    // fetches — this path falls through to a plain fetch there too).
    var VERSIONS_PATH = 'js/gen/mtlx-versions.json';

    // Set once when `ready` settles; read only through isLocal(). Starts
    // `false` so a caller that ignores `ready` and calls isLocal() early
    // gets safe remote behavior, not a false claim of a local build.
    var localMode = false;

    // MTLX_VERSIONS/MTLX_DEFAULT_VERSION start as this single-entry
    // fallback (derived from DEFAULT_TAG above, which is itself stamped
    // in lockstep with js/mtlx-engine.js's MTLX_DEFAULT_VERSION via the
    // same STAMP_TABLE run) so the Compare view is never left with an
    // empty list if js/gen/mtlx-versions.json can't be fetched.
    var fallbackDefaultVersion = DEFAULT_TAG.replace(/^v/, '');
    var mtlxVersions = [fallbackDefaultVersion];
    var mtlxDefaultVersion = fallbackDefaultVersion;

    // Kicked off immediately at parse time — by the time any consumer
    // could plausibly await `ready`, both fetches are likely already
    // in-flight or resolved.
    var ready = Promise.all([
        fetch(MANIFEST_PATH, { cache: 'no-store' })
            .then(function (res) {
                localMode = !!(res && res.ok);
            })
            .catch(function () {
                // Network error, offline, CSP block, whatever — no local
                // manifest reachable means remote mode, exactly like a 404.
                localMode = false;
            }),
        fetch(VERSIONS_PATH, { cache: 'no-store' })
            .then(function (res) {
                if (!res || !res.ok) throw new Error('mtlx-versions.json fetch failed');
                return res.json();
            })
            .then(function (data) {
                if (
                    data && typeof data.default === 'string' &&
                    Array.isArray(data.versions) && data.versions.length > 0
                ) {
                    mtlxVersions = data.versions.map(function (v) { return v.version; });
                    mtlxDefaultVersion = data.default;
                }
                // Malformed payload: silently keep the single-entry fallback
                // above rather than throwing — same degrade-gracefully
                // policy as a fetch/network failure.
            })
            .catch(function () {
                // Leave mtlxVersions/mtlxDefaultVersion at the fallback.
            }),
    ]);

    function isLocal() {
        return localMode;
    }

    // Absolute-ifies a vendor-relative path against document.baseURI
    // (not a hardcoded origin) so this also works inside the VS Code
    // webview, which sets its own <base href> to vscode-resource root.
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
        // MaterialX version list for the Compare view's per-pane WASM
        // dropdown (js/gen/mtlx-versions.json, generated by
        // scripts/extract-mtlx-version.mjs from scripts/lib/mtlx-versions.mjs).
        // Getters, not plain fields: they read the module-scope vars above,
        // which `ready` may still update after this object is constructed.
        get MTLX_VERSIONS() { return mtlxVersions; },
        get MTLX_DEFAULT_VERSION() { return mtlxDefaultVersion; },
    };
})();
