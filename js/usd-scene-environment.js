// USD scene environment bridge, now a thin adapter over
// js/shared/render-environment.js's createStageEnvironment, which holds
// the actual implementation shared with the material viewer's studio rig.
window.createUsdSceneEnvironment = (o) => window.MtlxRender.createStageEnvironment(o);
window.UsdSceneEnvironment = { create: window.createUsdSceneEnvironment };
