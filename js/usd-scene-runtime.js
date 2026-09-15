// Browser bridge for the module based USD stage loader.
// The shell loads this classic script lazily with the Scene Viewer route.
(() => {
    let pending;
    const load = () => {
        if (!pending) pending = import('./usd/usd-stage-loader.js');
        return pending;
    };
    window.loadUsdStage = (options) => load().then((module) => module.loadUsdStage(options));
    window.usdRuntimeUrl = () => load().then((module) => module.usdRuntimeUrl());
})();