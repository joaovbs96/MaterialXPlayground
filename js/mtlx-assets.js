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

    // Set once when `ready` settles; read only through isLocal(). Starts
    // `false` so a caller that ignores `ready` and calls isLocal() early
    // gets safe remote behavior, not a false claim of a local build.
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
    };
})();
