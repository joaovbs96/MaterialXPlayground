// js/shared/vendor-runtime.js: plain JS (not Babel), since preset-env
// would lower the emscripten-esm dynamic import() below to require(),
// which does not exist in the browser (see index.html).

(function () {
    'use strict';

    var loadCache = {};

    function depFor(id) {
        var deps = window.MTLX_VENDOR_DEPS || {};
        return deps[id] || null;
    }

    function url(id, relPath) {
        var dep = depFor(id);
        if (!dep) throw new Error('unknown vendor dependency "' + id + '"');
        return new URL('vendor/' + dep.dir + '/' + (relPath || ''), document.baseURI).href;
    }

    function injectScript(src, globalName) {
        return new Promise(function (resolve, reject) {
            var tag = document.createElement('script');
            tag.src = src;
            tag.onload = function () {
                tag.remove();
                if (window[globalName] === undefined) {
                    reject(new Error('vendor script "' + src + '" did not define window.' + globalName));
                } else {
                    resolve(window[globalName]);
                }
            };
            tag.onerror = function () {
                tag.remove();
                reject(new Error('failed to load vendor script "' + src + '"'));
            };
            document.head.appendChild(tag);
        });
    }

    function doLoad(id) {
        var dep = depFor(id);
        if (!dep) return Promise.reject(new Error('unknown vendor dependency "' + id + '"'));
        var mod = dep.module;
        if (!mod) return Promise.reject(new Error('vendor dependency "' + id + '" has no module entry'));
        if (dep.vscode === false && window.__MTLX_VSCODE__) {
            return Promise.reject(new Error('vendor dependency "' + id + '" is not packaged in the VS Code extension'));
        }
        var entryUrl = url(id, mod.entry);
        if (mod.kind === 'emscripten-esm') {
            return import(entryUrl).then(function (ns) {
                var factory = ns.default;
                if (typeof factory !== 'function') {
                    throw new Error('vendor dependency "' + id + '" default export is not a function');
                }
                return factory({ locateFile: function (p) { return url(id, p); } });
            });
        }
        if (mod.kind === 'esm') {
            return import(entryUrl);
        }
        if (mod.kind === 'script') {
            return injectScript(entryUrl, mod.global);
        }
        return Promise.reject(new Error('vendor dependency "' + id + '" has an unknown module kind'));
    }

    function load(id) {
        if (!loadCache[id]) {
            loadCache[id] = doLoad(id).catch(function (err) {
                delete loadCache[id];
                throw err;
            });
        }
        return loadCache[id];
    }

    function has(id) {
        return !!depFor(id);
    }

    window.MtlxVendor = { url: url, load: load, has: has };
})();
