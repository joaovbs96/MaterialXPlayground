// mtlx-engine.js, MaterialX WASM environment, shader introspection,
// environment lighting, preview geometry, and the encapsulated
// createMtlxRenderView() pipeline (generate ESSL -> three.js scene ->
// bind defaults/env/lights -> compile-check -> render loop). Shared by
// the app shell (index.html) and the VS Code webview.
// Public API exported onto window at the bottom.
// Load-timeline mark: first executed statement, i.e. right after
// babel-standalone finishes fetching + transforming this file. Gated on
// localStorage directly since window.MTLX_PERF_LOG is not set yet this early.
try{if(localStorage.getItem('mtlxPerfLog'))performance.mark('mtlx-engine-exec-start');}catch(e){/* ignore */}// ------------------------------------------------------------------
// MaterialX 3D Preview Component
// ------------------------------------------------------------------
// Load ONLY JsMaterialXGenShader.js (superset of JsMaterialXCore.js),
// loading both makes embind register shared C++ types twice and throw.
// Runtime is cached per-version, not re-downloaded per node select.
// MTLX_DEFAULT_VERSION is build-stamped, see scripts/lib/version.mjs
// STAMP_TABLE, which fails CI if this literal drifts from
// js/gen/mtlx-version.json.
const MTLX_DEFAULT_VERSION='1.39.5';// The shader-generation core lives in js/shared/mtlx-gen-core.js (plain
// script, loaded before this file) so the thumbnail worker can run it too.
const{LIGHT_TYPE_DIRECTIONAL,LIGHT_TYPE_POINT,LIGHT_TYPE_SPOT,LIGHT_SOURCE_KIND_AREA,STAGE_LIGHT_SLOTS,readLightLimit,STAGE_LIGHT_TIERS,PREVIEW_STAGE_LIGHT_COUNT,readFeatureGated,PREVIEW_FEATURE_OPTIONS,chooseStageLightTier,mxExclusive,mxWarnIfLocked,mtlxWarn,parseUniforms,countFragmentSamplers,estimateFragmentUniformVectors,stripVersion,parseVertexInputs,INT_GEOMPROP_TYPES,isIntGeompropType,patchGeompropVaryings,findGlslCalls,splitGlslArgs,findAllCallStatements,findFunctionDefs,findEnclosingFunction,isIdentityVec2Arg,HEIGHTTONORMAL_TEXEL_FN,HEIGHTTONORMAL_HEXTILE_TEXEL_FN,CHANNEL_EXTRACT_FN_RE,traceHeightSource,applyHeightToNormalTexel,patchUnlitLightingRefs,patchScenePhysicalLightFalloff,TONE_CURVE_GLSL,DISPLAY_TRANSFORM_IDS,displayTransformId,DISPLAY_TRANSFORM_SWITCH_GLSL,ACES_SRGB_GLSL,encodeDisplay,PEEL_REFRACTION_SCALE,patchShadowBounds,SHADOW_FACE_SLOTS,SHADOW_LIGHT_SLOTS_MAX,SHADOW_NORMAL_OFFSET_TEXELS,SHADOW_DEPTH_BIAS_TEXELS,patchShadowLightScope,patchLightSourceKindStruct,patchAreaLightSourceCosine,patchSpecularAA,ensureEnvOcclusionGlobal,patchAmbientOcclusion,patchDiffuseBounceAdd,patchSceneThinWalledTransmission,patchLightTransportPayload,patchTransmissionThickness,patchTransmissionAlpha,patchLocalEnvironmentRadiance,patchScreenSpaceReflection,patchRgbtPayload,injectPeelDiscard,mxErr,mxWriteValue,vecToArray,mxSafe,mxElCat,mxElType,mxElName,mxElAttr,materialPowerNodeNames,materialGeompropDefaults,POWER_NODE_REAL_GLSL,patchMaterialPowerNodes,mxElHasAttr,mxSetAttr,mxRemoveAttr,mxSetColorspace,findConvertChain,ensureTypedInput,readConstInputs,CONST_INPUT_NAMES,CONST_INPUT_DENY,CONST_INPUT_GLSL_TYPES,DISPLACEMENT_CONST_INPUT_NAMES,readDisplacementConstInputs,constInputLiteral,constInputKey,stripGlslForUsage,USAGE_IDENT_RE,addIdents,addComparisonIdents,balancedSpan,ternaryCondition,selectDynamicIndexUniforms,SELECTOR_CONST_INPUTS,constifyInputUniforms,stripValuesFromConnectedInputs,COLORSPACE_ALIASES,applyColorspaceAliases,COLORSPACE_TO_WORKING_NODE,applyColorspaceTransforms,applyMaterialWorkspaceTransforms,normPath,joinRefPath,findFileForRef,findFilesForRef,preferKtx2Sibling,readMtlxXml,isExportAttribution,splitXmlEnvelope,withXmlEnvelope,escapeXmlAttrSpecials,XML_ENTITIES,xmlDecode,xmlTagParts,xmlTokenKey,xmlTokenize,xmlPatchTag,xmlTokenMatches,preserveSourceFormatting,hasBlobIdentity,textureCacheKey,fnv1aBytesHex,BLOB_FINGERPRINT,fingerprintBlob,textureCacheKeyAsync,normalizeSamplerAddressMode,readMxInputValue,collectImageSamplerModes,samplerCacheKey,mxDataToPlainArray,collectMxUniforms,VECTOR_MX_TYPES,plainizeMxUniformData,annotateFilenameSamplerModes,COLOR_VIEWABLE,mxOutputTypeAndNode,mxResolveConnection,MTLX_TYPE_WALK_MAX_DEPTH,findTypeMismatches,describeUnresolvedNodes,unresolvedNodesText,MERGEABLE_IMAGE_CATEGORIES,MERGE_IGNORED_ATTRIBUTES,mxNodeSignature,mergeDuplicateImageNodes,generatePreviewSourcesUnlocked,mxFollowDisplacementInput,resolveDisplacementSource,detectDisplacementMode,fnv1aHex,generateDisplacementSourcesUnlocked,generatePreviewSources,DEFAULT_SAMPLER_BUDGET,joinWithAnd,SAMPLER_BUDGET_DROP_ORDER,SCENE_SAMPLER_DROPS,samplerBudgetNotice,generatePreviewSourcesWithinBudget}=MtlxGenCore;// Host providers for the core: each reads exactly what the code did before
// the extraction, lazily per call (the const names are defined further down).
MtlxGenCore.setHost({lightLimit:()=>{try{return localStorage.getItem(LIGHT_LIMIT_KEY)!=='0';}catch(e){return true;}},featureGated:()=>{try{return localStorage.getItem(FEATURE_GATED_KEY)!=='0';}catch(e){return true;}},constInputs:()=>{try{return localStorage.getItem(CONST_INPUTS_KEY)!=='0';}catch(e){return true;}},displacementConstInputs:()=>{try{return localStorage.getItem(DISPLACEMENT_CONST_INPUTS_KEY)!=='0';}catch(e){return true;}},specularEnvMethod:()=>getSpecularEnvMethod(),heightToNormalTexel:()=>getHeightToNormalTexel(),samplerBudgetOverride:()=>typeof window!=='undefined'?window.__mtlxSamplerBudgetOverride:undefined,perfLog:()=>!!window.MTLX_PERF_LOG,debugShaders:()=>DEBUG_SHADERS});// The three.js side of a material (uniforms, textures, geometry, lights) lives
// in js/shared/mtlx-three-material.js so the thumbnail worker can build it too.
const{getDummyTex,shadowOffMatrix,getDummyTexWhite,getDummyTex3DWhite,loadExrTexture,loadHdrTexture,UTIF_SUPPORTED_COMPRESSION,loadTifTexture,loadBoundedBitmapTexture,readImageDimensions,mxValueToThreeUniform,linToSrgb,srgbToLin,rgbToHex,hexToRgb,DEFAULT_VALUE_TEXTURES,DEFAULT_VALUE_TEXTURE_SET,defaultValueToRgba,getFilenameDefaultTexture,defaultValueTexture,isFilenameDefaultTexture,samplerHoldsDefault,rebindFilenameDefault,configureLoadedTexture,UV_GEOMPROP_ALIASES,aliasUvGeomprops,prepGeometry,GEOMPROP_ITEM_SIZE,bindGeompropAttributes,makeLightEntry,currentLights,activeLightCount,envRadianceForShading,envIrradianceForShading,bindEnvironmentSamplers,createMtlxSceneUniforms,PREVIEW_TRANSFORM_UNIFORM_NAMES,applyIntrospectedUniformDefaults,updateTransformUniforms,createPreviewMaterial}=MtlxThreeMaterial;// Host providers for it: each reads exactly what the code did before the move.
MtlxThreeMaterial.setHost({keyLightRotation:rad=>keyLightRotationMatrix(rad),displayExposureScale:()=>displayExposureScale(),displayTransform:()=>getDisplayTransform(),clock:()=>MTLX_CLOCK,specularEnvMethod:()=>getSpecularEnvMethod(),diffuseEnvMethod:()=>getDiffuseEnvMethod(),sceneTextureFast:()=>sceneTextureFastPathEnabled(),texturePerf:(key,ms)=>addTexturePerf(key,ms)});// Environment preparation (equirect prep, key-light extraction, GGX prefilter,
// irradiance convolution) lives in js/shared/mtlx-scene-assembly.js.
const{makeEnvTexture,padToRGBA,prepareEnv,makeBackgroundTexture,floatToHalf,sanitizeHalfEnvData,halfToFloat,shIrradianceFromEquirect,parseEnvBuffer,KEYLIGHT_MIN_CONTRAST,KEYLIGHT_RADIUS_RAD,dataDirToWorld,extractKeyLight,extractSoftKeyDir,PREFILTER_SAMPLES,PREFILTER_GLSL,ensurePrefilteredEnv,makePrefilteredTexture,IRRADIANCE_CONV_W,IRRADIANCE_CONV_H,IRRADIANCE_OUT_W,IRRADIANCE_OUT_H,IRRADIANCE_GLSL,ensureConvolvedIrradiance,makeConvolvedIrradianceTexture,resolveShadingEnv,buildEnvFromParsedTexture,envWithKeyLight,applyThreeToneMappingChunk,applyPeelMaterialMode,effectiveFullSceneVFov,envRotationMatrix3,instantiateShaderballGltf,adoptSceneCamera,fullSceneFov,configureSceneOrbit,createShaderPrewarmer}=MtlxSceneAssembly;// Evaluated once at load, as before; the provider returns the cached value.
// A caller with no renderer yet must not latch prefilterTried, see ensurePrefilteredEnv.
const legacyPrefilterLatch=(()=>{try{return localStorage.getItem('mtlx_scene_prefilter_fix')==='0';}catch(e){return false;}})();MtlxSceneAssembly.setHost({specularEnvMethod:()=>getSpecularEnvMethod(),diffuseEnvMethod:()=>getDiffuseEnvMethod(),keyLightEnabled:()=>keyLightEnabled,legacyPrefilterLatch:()=>legacyPrefilterLatch,perfLog:()=>!!window.MTLX_PERF_LOG});// Light-limit kill switch, default ON. '0' disables it, read per
// generation (one localStorage hit) so toggling it needs no reload.
const LIGHT_LIMIT_KEY='mtlx_light_limit';// Feature-gated shaders kill switch, default ON. '0' restores the old
// always-generate behaviour (shadow sampling and the occlusion block in
// every material of every tool). Read per generation.
const FEATURE_GATED_KEY='mtlx_feature_gated_shaders';const mxEnvPromises=new Map();// Classic-<script> fallback for UMD builds (e.g. 1.39.4) that have no
// `export` statement and no `root.MaterialX = ...` global fallback, see
// getMxEnv's header comment below for why import() can't reach their
// factory. A classic script makes the build's top-level `var MaterialX =
// ...` land on window, same as any other <script src>. Captures
// window.MaterialX synchronously in onload (before anything else can run),
// restores whatever was there before (both UMD and ESM builds use this
// same global name, so leaving it set risks a later version reading a
// stale factory), then resolves with the captured value.
const loadMxFactoryViaScript=ver=>new Promise((resolve,reject)=>{const url='./js/materialx/'+ver+'/JsMaterialXGenShader.js';const prevGlobal=window.MaterialX;const script=document.createElement('script');script.src=url;script.onload=()=>{const captured=window.MaterialX;// synchronous: capture before restoring
window.MaterialX=prevGlobal;script.remove();if(typeof captured!=='function'){// Fail loud here rather than let the caller hit a confusing
// "captured is not a function" later.
reject(new Error('MaterialX engine script loaded but window.MaterialX is not a factory function (got '+typeof captured+'), url: '+url));return;}resolve(captured);};script.onerror=()=>{window.MaterialX=prevGlobal;script.remove();reject(new Error('Failed to load MaterialX engine script: '+url));};document.head.appendChild(script);});const getMxEnv=version=>{const ver=version||MTLX_DEFAULT_VERSION;if(!mxEnvPromises.has(ver)){// ES-module builds (1.39.5+) export the factory as default. Older
// builds (1.39.4 and earlier) are UMD with no export statement and
// no global fallback, so under import() the factory is unreachable,
// re-load those via a classic <script>, where top-level `var` lands
// on window (see loadMxFactoryViaScript above). Detected by shape
// (whether mod.default is actually a function), not by version
// number, so a future build switching either way keeps working.
// This means a failing version pays for TWO requests (import() then
// the <script> re-fetch of the same URL), deliberate and cheap,
// since the second one is an HTTP cache hit; do not "optimize" this
// into a hardcoded version check.
// Absolute URL on purpose: WebKit resolves import() in a classic
// script against the script URL, not the document base, so the
// embeds (served from embed/gen/ under a base tag) 404 in Safari.
const factoryUrl=new URL('./js/materialx/'+ver+'/JsMaterialXGenShader.js',document.baseURI).href;// Load-timeline marks (perf-gated, zero cost when off): wasm module
// fetch/instantiate, then standard libraries + GenContext below.
const __wasmPerfStart=window.MTLX_PERF_LOG?performance.now():0;const factoryPromise=import(factoryUrl).then(mod=>typeof mod.default==='function'?mod.default:loadMxFactoryViaScript(ver));mxEnvPromises.set(ver,factoryPromise.then(factory=>factory({// .wasm and .data live next to the .js.
locateFile:path=>'./js/materialx/'+ver+'/'+path})).then(mx=>{if(window.MTLX_PERF_LOG){console.log('[mtlx-perf] wasm instantiate: '+(performance.now()-__wasmPerfStart).toFixed(1)+'ms (target: '+ver+')');}// Expose the MaterialX library version (from the JS API)
// for the top-menu badge; broadcast so the UI can update
// whenever the WASM finishes loading. Only the default
// version drives the header badge, a non-default pane
// (e.g. Compare) must not overwrite it.
if(ver===MTLX_DEFAULT_VERSION){try{const verStr=mx.getVersionString&&mx.getVersionString()||null;if(verStr){window.__mtlxVersion=verStr;window.dispatchEvent(new CustomEvent('mtlx-version',{detail:verStr}));}}catch(e){/* version is optional */}}// Generator, GenContext, stdlib and light binding live in the
// shared core; configure waits until the rig below is parsed.
const genEnv=MtlxGenCore.createGenEnv(mx,{configure:false,onPerf:window.MTLX_PERF_LOG?(label,ms)=>console.log('[mtlx-perf] '+label+': '+ms.toFixed(1)+'ms (target: '+ver+')'):null});const{gen,genContext,stdlib}=genEnv;const rigLights=[];return fetch('./environment_map.mtlx').then(r=>r.ok?r.text():null).catch(()=>null).then(rigXml=>{const lightData=[];try{const HwGen=mx.HwShaderGenerator;if(HwGen&&HwGen.bindLightShader&&genEnv.ldef){// Parses <directional_light> via DOMParser,
// which handles self-closing tags unlike
// regex. Parse failure warns, never throws.
if(rigXml){try{const rigDoc=new DOMParser().parseFromString(rigXml,'text/xml');const perr=rigDoc.getElementsByTagName('parsererror');if(perr.length){console.warn('direct-light rig: environment_map.mtlx failed to parse as XML, no rig lights loaded.',perr[0].textContent);}else{const v3=(str,fb)=>{if(!str)return fb;const p=str.split(',').map(x=>parseFloat(x.trim()));return p.length===3&&!p.some(isNaN)?p:fb;};const lightEls=rigDoc.getElementsByTagName('directional_light');for(let i=0;i<lightEls.length;i++){const lightEl=lightEls[i];// Scoped to lightEl's own subtree,
// so this can't pick up a sibling
// light's <input>.
const inputEls=lightEl.getElementsByTagName('input');const inp=nm=>{for(let j=0;j<inputEls.length;j++){if(inputEls[j].getAttribute('name')===nm){return inputEls[j].getAttribute('value');}}return null;// absent (or self-closing light) -> caller's fallback
};rigLights.push({direction:v3(inp('direction'),[0,-1,0]),color:v3(inp('color'),[1,1,1]),intensity:parseFloat(inp('intensity'))||1.0});}}}catch(e){console.warn('direct-light rig: DOMParser failed on environment_map.mtlx, no rig lights loaded.',e);}}// No fallback light: an empty rig leaves
// lightData empty, so u_numActiveLightSources
// is 0 and the light loop is a no-op (pure IBL).
// Official rotates light directions by the
// same +90° Y it applies to the env map.
const rot=new THREE.Matrix4().makeRotationY(Math.PI/2);for(const l of rigLights){const dir=new THREE.Vector3(l.direction[0],l.direction[1],l.direction[2]).normalize().transformDirection(rot);lightData.push({type:1,direction:dir,color:new THREE.Vector3(l.color[0],l.color[1],l.color[2]),intensity:l.intensity});}}}catch(e){console.warn('direct-light registration unavailable:',e);lightData.length=0;}// Unconditional: options apply even with no light rig.
genEnv.rigLightCount=rigLights.length;genEnv.configureGenContext(genContext);return{mx,gen,genContext,stdlib,lightData,version:ver,createGenContext:genEnv.createGenContext};});}).catch(e=>{// Reset this version's memo so a retry re-attempts the load
// instead of replaying this rejection forever, and wrap the
// (often opaque) failure in a message the user can act on.
mxEnvPromises.delete(ver);throw new Error('The MaterialX engine (WASM) failed to load: check your connection and try again, or reload the page. ('+(e&&e.message||e)+')');}));}return mxEnvPromises.get(ver);};// Logs generated GLSL + discovered uniforms, fastest way to diagnose a
// black/non-running shader. Opt in via localStorage 'mtlxDebugShaders'.
// Read once at module load, mirroring MTLX_PERF_LOG (js/graph/model.jsx).
const DEBUG_SHADERS=(()=>{try{return!!localStorage.getItem('mtlxDebugShaders');}catch(e){return false;}})();// Publish the perf-log flag here too, so engine [mtlx-perf] logs fire even
// on views that never load js/graph/model.jsx (#!viewer, #!scene, embeds).
// Never clobbers an already-true value set by another loader.
try{if(!window.MTLX_PERF_LOG&&localStorage.getItem('mtlxPerfLog')){window.MTLX_PERF_LOG=true;}}catch(e){/* ignore */}// "Force Transparency" (Settings dialog, default off). Off = official-
// viewer parity (opaque previews); on = transparent materials render via
// front-to-back depth-peeled order-independent transparency (see the NOTE
// below, and renderFrame()/syncMeshMaterialMode() in createMtlxRenderView
// for the render graph). Persisted by default; setter dispatches
// 'mtlx-settings-changed'. { persist: false } applies the flag to this
// tab only, for a host-driven embed that should not touch the shared
// per-origin preference (see embed-boot.js's two call sites).
let FORCE_TRANSPARENCY=(()=>{try{return!!window.MtlxRenderSettings.get('transparency',{surface:'viewer'});}catch(e){return false;}})();const getForceTransparency=()=>FORCE_TRANSPARENCY;const setForceTransparency=(v,{persist=true}={})=>{FORCE_TRANSPARENCY=!!v;try{window.MtlxRenderSettings.set('transparency',FORCE_TRANSPARENCY,{surface:'viewer',persist});}catch(e){/* best-effort */}// Settings-dialog/Scene-card callers persist (default); embed-boot.js's
// query-param and postMessage paths pass persist:false. Mutates each
// live view's flags in place regardless, see refreshRenderMode.
LIVE_VIEWS.forEach(view=>{try{view.refreshRenderMode&&view.refreshRenderMode();}catch(e){/* view mid-teardown */}});try{window.dispatchEvent(new CustomEvent('mtlx-settings-changed',{detail:{key:'forceTransparency',value:FORCE_TRANSPARENCY}}));}catch(e){/* best-effort */}};// Preview transmission model ('scalar' | 'rgbt', manifest row `transmission`),
// read per material build. The embed page and the docs iframe read their own
// level (Performance), never the Viewer's stored one.
const previewLevelSurface=()=>window.__MTLX_EMBED_PAGE__?'embed':window.__MTLX_EMBED?'docs':'viewer';// Preview Quality codegen (SSAO block, specular AA) for a view's surface; below
// Quality this is PREVIEW_FEATURE_OPTIONS itself, so the sources stay identical.
const previewSetting=(key,surface)=>{try{return window.MtlxRenderSettings.get(key,{surface:surface||previewLevelSurface()});}catch(e){return undefined;}};const previewFeatureOptions=surface=>{const ao=!!previewSetting('ao',surface),specularAA=!!previewSetting('specularAA',surface);if(!ao&&!specularAA)return PREVIEW_FEATURE_OPTIONS;return Object.assign({},PREVIEW_FEATURE_OPTIONS,ao?{skipOcclusion:false,skipSkyVis:true,skipAoVolume:true}:null,specularAA?{specularAA:true}:null);};// A view's own surface (createMtlxRenderView `surface`) when given.
const getPreviewTransmission=surface=>{try{return window.MtlxRenderSettings.get('transmission',{surface:surface||previewLevelSurface()})==='rgbt'?'rgbt':'scalar';}catch(e){return'scalar';}};// NOTE: no separate "depth peeling" setting exists, Force Transparency
// always means front-to-back depth-peeled OIT now (a naive single-pass
// blended mode was collapsed into this one flag). renderFrame()/
// syncMeshMaterialMode() gate the peel graph on FORCE_TRANSPARENCY &&
// (this material's hwTransparency verdict), see PEEL_LAYERS/getDummyTex.
// Accepts the loose boolean spellings the URL query params use (1/0,
// true/false, on/off, yes/no, any case); returns null when unrecognized
// so callers can fall back instead of misreading garbage as false.
const parseBoolFlag=raw=>{const s=String(raw).trim().toLowerCase();if(s==='1'||s==='true'||s==='on'||s==='yes')return true;if(s==='0'||s==='false'||s==='off'||s==='no')return false;return null;};// "Displacement" (Settings dialog, default on). Off skips the CPU-side
// mesh displacement pass (js/shared/mesh-displacement.js) and previews
// the undisplaced mesh. Same persist/{persist:false} contract as above.
let DISPLACEMENT_ENABLED=(()=>{try{return!!window.MtlxRenderSettings.get('displacement',{surface:'viewer'});}catch(e){return true;}})();const getDisplacementEnabled=()=>DISPLACEMENT_ENABLED;const setDisplacementEnabled=(v,{persist=true}={})=>{DISPLACEMENT_ENABLED=!!v;try{window.MtlxRenderSettings.set('displacement',DISPLACEMENT_ENABLED,{surface:'viewer',persist});}catch(e){/* best-effort */}LIVE_VIEWS.forEach(view=>{try{view.refreshDisplacement&&view.refreshDisplacement();}catch(e){/* view mid-teardown */}});try{window.dispatchEvent(new CustomEvent('mtlx-settings-changed',{detail:{key:'displacement',value:DISPLACEMENT_ENABLED}}));}catch(e){/* best-effort */}};// "Texture Anisotropy" (Settings dialog, default 8). Sessions apply this
// live via textureSession.setAnisotropy on every LIVE_VIEWS handle that has
// one; configureLoadedTexture's own default (8) covers callers with no
// session (Scene until P6, the legacy Map path).
let TEXTURE_ANISOTROPY=(()=>{try{return Number(window.MtlxRenderSettings.get('textureAnisotropy',{surface:'viewer'}))||8;}catch(e){return 8;}})();const getTextureAnisotropy=()=>TEXTURE_ANISOTROPY;const setTextureAnisotropy=(v,{persist=true}={})=>{TEXTURE_ANISOTROPY=Number(v)||8;try{window.MtlxRenderSettings.set('textureAnisotropy',TEXTURE_ANISOTROPY,{surface:'viewer',persist});}catch(e){/* best-effort */}LIVE_VIEWS.forEach(view=>{try{view.textureSession&&view.textureSession.setAnisotropy(TEXTURE_ANISOTROPY);}catch(e){/* view mid-teardown */}});};// Displacement shading-normal mode (Settings/test hook): 'analytic' derives
// the normal from two extra tangent-offset evaluations of the displacement
// network per vertex (crisp creases, matches the analytic surface); 'mesh'
// keeps the older angle-weighted recompute over the displaced triangles.
let DISPLACEMENT_NORMALS_MODE=(()=>{// Default to 'mesh' until the analytic path is verified free of the
// terracing seen on egg_normals (readback precision fix pending
// verification); 'analytic' stays selectable via query/localStorage.
try{return window.MtlxRenderSettings.get('displacementNormals',{surface:'viewer'})||'mesh';}catch(e){return'mesh';}})();const getDisplacementNormalsMode=()=>DISPLACEMENT_NORMALS_MODE;const setDisplacementNormalsMode=(v,{persist=true}={})=>{if(v!=='analytic'&&v!=='mesh')return;DISPLACEMENT_NORMALS_MODE=v;try{window.MtlxRenderSettings.set('displacementNormals',DISPLACEMENT_NORMALS_MODE,{surface:'viewer',persist});}catch(e){/* best-effort */}LIVE_VIEWS.forEach(view=>{try{view.refreshDisplacement&&view.refreshDisplacement();}catch(e){/* view mid-teardown */}});try{window.dispatchEvent(new CustomEvent('mtlx-settings-changed',{detail:{key:'displacementNormals',value:DISPLACEMENT_NORMALS_MODE}}));}catch(e){/* best-effort */}};// Preview subdivision level (Settings dialog, default 2, 0..3). Feeds
// mesh-subdivision.js's Loop subdivision ahead of CPU displacement;
// pickSubdivisionLevel below caps it per-mesh against a triangle budget.
let PREVIEW_SUBDIVISION_LEVEL=(()=>{try{const v=window.MtlxRenderSettings.get('previewSubdivision',{surface:'viewer'});return Number.isInteger(v)?v:2;}catch(e){return 2;}})();const getPreviewSubdivisionLevel=()=>PREVIEW_SUBDIVISION_LEVEL;const setPreviewSubdivisionLevel=(level,{persist=true}={})=>{const n=Number(level);if(!Number.isFinite(n))return;// non-numeric input is ignored
const clamped=Math.min(3,Math.max(0,Math.round(n)));PREVIEW_SUBDIVISION_LEVEL=clamped;try{window.MtlxRenderSettings.set('previewSubdivision',PREVIEW_SUBDIVISION_LEVEL,{surface:'viewer',persist});}catch(e){/* best-effort */}LIVE_VIEWS.forEach(view=>{try{view.refreshDisplacement&&view.refreshDisplacement();}catch(e){/* view mid-teardown */}});try{window.dispatchEvent(new CustomEvent('mtlx-settings-changed',{detail:{key:'previewSubdivision',value:PREVIEW_SUBDIVISION_LEVEL}}));}catch(e){/* best-effort */}};// Highest triangle count a preview mesh may reach after subdivision,
// past which the GPU/CPU cost stops being worth the visual gain.
const PREVIEW_TRIANGLE_BUDGET=1500000;// Highest level <= requestedLevel keeping baseTriangles * 4^level under
// budget (level 0 always allowed, even if baseTriangles alone exceeds it).
const pickSubdivisionLevel=(baseTriangles,requestedLevel,budget=PREVIEW_TRIANGLE_BUDGET)=>{let level=0;let triangles=baseTriangles;for(let l=0;l<=requestedLevel;l++){const t=baseTriangles*Math.pow(4,l);if(l===0||t<=budget){level=l;triangles=t;}else{break;}}return{level,capped:level<requestedLevel||triangles>budget,triangles,allowed:triangles<=budget};};// LRU (3 entries) of undisplaced subdivided base geometries, shared by
// every createMtlxRenderView shell; each view takes a CLONE (see
// ensureBaseGeometry below), the cache keeps its own.
const BASE_GEOM_CACHE_LIMIT=3;const BASE_GEOM_CACHE=new Map();// key -> BufferGeometry, insertion order = LRU order
const baseGeomCacheKey=(geomName,sceneModeKey,level)=>geomName+'|'+(geomName==='custom'?CUSTOM_GEOM.epoch:'0')+'|'+(sceneModeKey||'')+'|'+level;const baseGeomCacheGet=key=>{const hit=BASE_GEOM_CACHE.get(key);if(!hit)return null;// Refresh recency: delete + re-set moves it to the end of the Map's
// insertion order, which the eviction loop below treats as newest.
BASE_GEOM_CACHE.delete(key);BASE_GEOM_CACHE.set(key,hit);return hit;};const baseGeomCacheSet=(key,geometry)=>{BASE_GEOM_CACHE.set(key,geometry);while(BASE_GEOM_CACHE.size>BASE_GEOM_CACHE_LIMIT){const oldestKey=BASE_GEOM_CACHE.keys().next().value;const oldest=BASE_GEOM_CACHE.get(oldestKey);BASE_GEOM_CACHE.delete(oldestKey);try{oldest.dispose();}catch(e){/* already disposed/invalid */}}};// Experimental, opt-in: mx_heighttonormal_vector3 (MaterialX 1.39) derives
// its height gradient from screen-space derivatives divided by the UV
// Jacobian, so on a high-resolution height texture a single-texel step
// reads as an enormous per-pixel slope (speckle). When on, call sites
// whose height comes straight from an mx_image_float() sample are
// rewritten to a texel-space finite-difference gradient instead (see
// applyHeightToNormalTexel below). Off by default: DCC parity is
// unverified, this is for side-by-side comparison only. A `?heightToNormalTexel=1`
// URL param seeds the flag for a page load without touching localStorage.
let HEIGHT_TO_NORMAL_TEXEL=(()=>{try{return!!window.MtlxRenderSettings.get('heightToNormalTexel',{surface:'viewer'});}catch(e){return false;}})();// Specular environment method. 'prefilter' is MaterialXView's path: the
// radiance map carries a GGX-prefiltered mip chain and the shader does one
// textureLod, so a rough surface reads a correctly filtered value instead
// of a 16-sample estimate. 'fis' is MaterialX's filtered-importance-
// sampling default, kept for side-by-side comparison; its 16 samples are
// what put per-pixel white specks on low-roughness surfaces under a map
// with a small bright sun.
let SPECULAR_ENV_METHOD=(()=>{try{const qs=new URLSearchParams(window.location.search);if(qs.has('specularEnv'))return qs.get('specularEnv')==='fis'?'fis':'prefilter';return localStorage.getItem('mtlx_specular_env')==='fis'?'fis':'prefilter';}catch(e){return'prefilter';}})();const getSpecularEnvMethod=()=>SPECULAR_ENV_METHOD;// Diffuse environment irradiance method. 'convolve' cosine-convolves the
// radiance map directly on the GPU into a lat-long irradiance map, accurate
// under small bright lights where the SH l<=2 reconstruction below loses
// about 9% of a studio softbox's energy (see
// scratchpad/displacement-verified/color-parity/direct-scale/direct-scale.md).
// 'sh' is the original 9-coefficient spherical-harmonic path, kept as the
// safe-fail target and the one embeds stay pinned to until verified there.
let DIFFUSE_ENV_METHOD=(()=>{try{if(window.MTLX_DIFFUSE_ENV==='sh'||window.MTLX_DIFFUSE_ENV==='convolve')return window.MTLX_DIFFUSE_ENV;return window.MtlxRenderSettings.get('diffuseEnv',{surface:'viewer'})||'convolve';}catch(e){return'convolve';}})();const getDiffuseEnvMethod=()=>DIFFUSE_ENV_METHOD;const setDiffuseEnvMethod=(v,{persist=true}={})=>{DIFFUSE_ENV_METHOD=v==='sh'?'sh':'convolve';try{window.MtlxRenderSettings.set('diffuseEnv',DIFFUSE_ENV_METHOD,{surface:'viewer',persist});}catch(e){/* best-effort */}// Not generation-affecting: same lookup, same uniform, just a rebind,
// so listeners re-run their environment effect, not a recompile.
try{window.dispatchEvent(new CustomEvent('mtlx-settings-changed',{detail:{key:'diffuseEnvMethod',value:DIFFUSE_ENV_METHOD}}));}catch(e){/* best-effort */}};const getHeightToNormalTexel=()=>HEIGHT_TO_NORMAL_TEXEL;const setHeightToNormalTexel=(v,{persist=true}={})=>{HEIGHT_TO_NORMAL_TEXEL=!!v;try{window.MtlxRenderSettings.set('heightToNormalTexel',HEIGHT_TO_NORMAL_TEXEL,{surface:'viewer',persist});}catch(e){/* best-effort */}// Generation-affecting: existing compiled sources bake in the old
// rewrite decision, so every live view must recompile its materials,
// mirroring how forceTransparency's setter above nudges live views.
try{window.dispatchEvent(new CustomEvent('mtlx-settings-changed',{detail:{key:'heightToNormalTexel',value:HEIGHT_TO_NORMAL_TEXEL}}));}catch(e){/* best-effort */}};// Nearest transparent layers the peel loop resolves before giving up on
// farther fragments, ample for the single-mesh shaderball preview this
// targets. Each layer costs a full extra raster+composite pass, so this
// is a fixed small constant rather than "peel until empty".
const PEEL_LAYERS=8;// Driver-noise filter moved to MtlxRender.compileFilteringDriverNoise
// (js/shared/render-session.js); lazy alias so prewarmPreviewTarget and
// every applyMaterialInternal call site below keep working unchanged.
const compileFilteringDriverNoise=(renderer,scene,camera)=>MtlxRender.compileFilteringDriverNoise(renderer,scene,camera,DEBUG_SHADERS);// Shared u_time/u_frame clock, MaterialXView semantics: wall seconds since
// first frame, per-frame counter (uint32 wrap). float32 in the shader, so
// timing gets coarser after ~2 days with the same page open (reload resets).
const MTLX_CLOCK={time:0,frame:0,lastTs:undefined,epoch:undefined};const clockTick=ts=>{if(typeof ts!=='number'||ts===MTLX_CLOCK.lastTs)return;if(MTLX_CLOCK.epoch===undefined)MTLX_CLOCK.epoch=ts;MTLX_CLOCK.lastTs=ts;MTLX_CLOCK.time=(ts-MTLX_CLOCK.epoch)/1000;MTLX_CLOCK.frame=MTLX_CLOCK.frame+1>>>0;};// Const-inputs kill switch, default ON. '0' disables it. Read per
// generation.
const CONST_INPUTS_KEY='mtlx_const_inputs';const DISPLACEMENT_CONST_INPUTS_KEY='mtlx_displacement_const_inputs';// Doc-level renderable scan: returns [{ name, node }], one entry per
// renderable surface, by TYPE rather than getMaterialNodes(). Live-doc
// callers need mxExclusive; opts.synthesizeDefinitions adds a third pass.
const listDocRenderables=(doc,opts)=>{mxWarnIfLocked('listDocRenderables');// exported doc-reading helper, see mxWarnIfLocked's header comment
// The third pass ADDS nodedef/nodegraph/node copies to `doc`, so only
// throwaway documents (the viewer's) may opt in; the editor's live
// document must never be scanned with it.
const synthesizeDefinitions=!!(opts&&opts.synthesizeDefinitions);const renderables=[];const seen=new Set();// Defensive skip of transient __pv_* wrapper nodes: the graph
// preview pipeline creates/destroys these inside its own mxExclusive
// hold, so this guards against a caller somehow racing that hold.
const isPvName=nm=>typeof nm==='string'&&nm.indexOf('__pv_')===0;const pushShader=(displayName,shaderNode)=>{if(!shaderNode)return;let nm=displayName;try{nm=displayName||shaderNode.getName();}catch(e){/* keep */}if(seen.has(nm))return;let shaderName=null;try{shaderName=shaderNode.getName();}catch(e){/* leave null, treated as not __pv_ */}if(isPvName(nm)||isPvName(shaderName))return;seen.add(nm);renderables.push({name:nm,node:shaderNode});};const typeOf=n=>{try{return String(n.getType());}catch(e){return'';}};const nameOf=n=>{try{return n.getName();}catch(e){return null;}};// The shader a material node points at: prefer the binding's own
// connection resolution, fall back to the nodename lookup.
const connectedShader=matNode=>{try{const inp=matNode.getInput&&matNode.getInput('surfaceshader');if(!inp)return null;if(typeof inp.getConnectedNode==='function'){const n=inp.getConnectedNode();if(n)return n;}const nm=inp.getNodeName?inp.getNodeName():null;return nm?doc.getNode(nm):null;}catch(e){return null;}};let allNodes=[];try{allNodes=vecToArray(doc.getNodes?doc.getNodes():null);}catch(e){allNodes=[];}if(!allNodes.length){try{allNodes=vecToArray(doc.getMaterialNodes?doc.getMaterialNodes():null);}catch(e){/* none */}}for(const n of allNodes){if(typeOf(n)==='material')pushShader(nameOf(n),connectedShader(n));}if(!renderables.length){for(const n of allNodes){if(typeOf(n)==='surfaceshader')pushShader(nameOf(n),n);}}if(!renderables.length&&synthesizeDefinitions){// Third pass: no instance renders at all, so surface every
// surfaceshader nodedef/nodegraph DEFINITION the document
// declares, so at least the definition itself can be previewed.
try{const children=vecToArray(doc.getChildren());const nodedefChildren=children.filter(c=>mxElCat(c)==='nodedef');const nodegraphChildren=children.filter(c=>mxElCat(c)==='nodegraph');const localDefNames=new Set(nodedefChildren.map(d=>mxElName(d)));// Single-output nodedefs expose their type via getOutputs();
// a def with no <output> children falls back to its own
// type attribute (mxElType covers both wrapper shapes).
const isSurfaceShaderDef=def=>{const outs=vecToArray(mxSafe(()=>def.getOutputs?def.getOutputs():null,null));if(outs.length)return outs.some(o=>mxElType(o)==='surfaceshader');return mxElType(def)==='surfaceshader';};const entries=[];// { nodedefName, def, graphs }
const seenDefNames=new Set();// (i) local nodedef children whose output is surfaceshader.
for(const def of nodedefChildren){const nodedefName=mxElName(def);if(!nodedefName||seenDefNames.has(nodedefName)||!isSurfaceShaderDef(def))continue;seenDefNames.add(nodedefName);const graphs=nodegraphChildren.filter(g=>mxSafe(()=>g.getNodeDefString(),'')===nodedefName);entries.push({nodedefName,def,graphs});}// (ii) local nodegraphs implementing a LIBRARY-owned (not
// document-local) surfaceshader nodedef.
for(const g of nodegraphChildren){const nodedefName=mxElAttr(g,'nodedef');if(!nodedefName||localDefNames.has(nodedefName)||seenDefNames.has(nodedefName))continue;const def=mxSafe(()=>g.getNodeDef(),null);if(!def||!isSurfaceShaderDef(def))continue;seenDefNames.add(nodedefName);const graphs=nodegraphChildren.filter(gg=>mxSafe(()=>gg.getNodeDefString(),'')===nodedefName);entries.push({nodedefName,def,graphs});}// Materialize each entry as unique document-local copies, so
// shader gen compiles THIS document's nodedef/graph instead
// of a same-named library one (see the GenContext caching
// note above listDocRenderables' caller in viewer-app.jsx).
for(const entry of entries){const nodeString=mxSafe(()=>entry.def.getNodeString(),'');if(!nodeString)continue;const defCopyName=mxSafe(()=>doc.createValidChildName(entry.nodedefName+'_preview'),null);const copyDef=defCopyName&&mxSafe(()=>doc.addNodeDef(defCopyName,'surfaceshader',nodeString),null);if(!copyDef)continue;mxSafe(()=>{copyDef.copyContentFrom(entry.def);return true;},false);mxSafe(()=>{copyDef.setName(defCopyName);return true;},false);for(const g of entry.graphs){const graphCopyName=mxSafe(()=>doc.createValidChildName(mxElName(g)+'_preview'),null);const copyGraph=graphCopyName&&mxSafe(()=>doc.addNodeGraph(graphCopyName),null);if(!copyGraph)continue;mxSafe(()=>{copyGraph.copyContentFrom(g);return true;},false);mxSafe(()=>{copyGraph.setName(graphCopyName);return true;},false);mxSafe(()=>{copyGraph.setNodeDefString(defCopyName);return true;},false);}const instName=mxSafe(()=>doc.createValidChildName(nodeString+'_definition'),null);const inst=instName&&mxSafe(()=>doc.addNode(nodeString,instName,'surfaceshader'),null);if(!inst)continue;mxSafe(()=>{inst.setNodeDefString(defCopyName);return true;},false);renderables.push({name:nodeString+' (definition)',node:inst,definition:true});}}catch(e){/* third pass is best-effort */}}return renderables;};// Resolves on the next paint, callers awaiting this yield to the
// browser instead of blocking it, letting a queued DOM/state update
// actually paint before continuing.
const nextFrame=()=>new Promise(r=>requestAnimationFrame(r));// AppleDouble and Finder metadata entries: never real documents, only
// noise dropped alongside them by a macOS zip/folder export.
const isHiddenSideFile=relPath=>/(^|\/)(__MACOSX\/|\._[^/]*$|\.DS_Store$)/i.test(String(relPath||''));// Directory-aware DataTransfer traversal. Returns { relPath: File }.
const readDroppedItems=async dataTransfer=>{const map={};let skipped=0;const items=dataTransfer.items?Array.from(dataTransfer.items):[];const entries=items.map(it=>it.webkitGetAsEntry?it.webkitGetAsEntry():null).filter(Boolean);if(!entries.length){// Fallback: flat file list (no folder structure available).
for(const f of Array.from(dataTransfer.files||[])){if(isHiddenSideFile(f.name)){skipped++;continue;}map[f.name]=f;}if(skipped)console.info('readDroppedItems: skipped '+skipped+' side file(s)');return map;}const readEntry=(entry,prefix)=>new Promise(resolve=>{const relPath=prefix+entry.name;if(isHiddenSideFile(relPath)){skipped++;resolve();return;}if(entry.isFile){entry.file(f=>{map[relPath]=f;resolve();},()=>resolve());}else if(entry.isDirectory){const reader=entry.createReader();const sub=[];const readBatch=()=>reader.readEntries(batch=>{if(!batch.length){Promise.all(sub.map(e2=>readEntry(e2,relPath+'/'))).then(resolve);return;}sub.push(...batch);readBatch();// readEntries returns results in batches
},()=>resolve());readBatch();}else resolve();});await Promise.all(entries.map(e=>readEntry(e,'')));if(skipped)console.info('readDroppedItems: skipped '+skipped+' side file(s)');return map;};// Expand any .zip files in the map into their contents (in place).
const expandZips=async map=>{let skipped=0;for(const key of Object.keys(map)){if(!/\.zip$/i.test(key))continue;const file=map[key];delete map[key];if(!window.JSZip){throw new Error('The JSZip library is not loaded: .zip files can\'t be expanded. Reload the page and try again.');}const zip=await JSZip.loadAsync(file);const names=Object.keys(zip.files);for(const name of names){const entry=zip.files[name];if(entry.dir)continue;if(isHiddenSideFile(name)){skipped++;continue;}map[name]=await entry.async('blob');}}if(skipped)console.info('expandZips: skipped '+skipped+' side file(s)');return map;};// Inline <xi:include href="..."/> from the dropped files (MaterialX
// documents may be split across files; readFromXmlString can't reach
// our in-memory map). Missing includes are dropped with a warning.
// Exact ({exact:true, warnings, transformChild}): matches the Scene's
// resolveSceneIncludes: only the exact lookup (no bare-href retry), an
// already-visited include is skipped silently (no comment), and an
// unresolved one pushes to `warnings` instead of console.warn.
// transformChild(childXml, key), when given, post-processes each resolved
// child before the wrapper strip (used by the Scene's canonicalization).
const resolveIncludes=async(xml,fileMap,fromDir,visited,opts)=>{visited=visited||new Set();const options=opts||{};const exact=!!options.exact;// href may not be the first attribute and may be single-quoted,
// any tag this regex misses would be handed to MaterialX, which
// would try (and fail) to fetch it over HTTP itself.
const INC=/<xi:include\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*?\/?>(?:\s*<\/xi:include>)?/g;const parts=[];let last=0,m;while((m=INC.exec(xml))!==null){parts.push(xml.slice(last,m.index));last=m.index+m[0].length;const href=m[1]||m[2];if(exact){const hit=findFileForRef(fileMap,href,{exact:true,fromDir});if(!hit){if(options.warnings)options.warnings.push('Unresolved MaterialX include '+href+' from '+(fromDir||'.'));parts.push('<!-- unresolved include: '+href.replace(/--/g,'- -')+' -->');continue;}if(visited.has(hit.key))continue;// already in this document closure, skip silently
visited.add(hit.key);let inc=await fileMap[hit.key].text();const incDir=hit.key.indexOf('/')>=0?hit.key.slice(0,hit.key.lastIndexOf('/')):'';inc=await resolveIncludes(inc,fileMap,incDir,visited,options);if(options.transformChild)inc=options.transformChild(inc,hit.key);inc=inc.replace(/<\?xml[^>]*\?>/,'');inc=inc.replace(/<materialx\b[^>]*>/,'').replace(/<\/materialx>\s*$/,'');parts.push(inc);continue;}const refPath=fromDir?fromDir+'/'+href:href;const hit=findFileForRef(fileMap,refPath)||findFileForRef(fileMap,href);if(!hit||visited.has(hit.key)){console.warn('xi:include not resolvable from dropped files:',href);parts.push('<!-- unresolved include: '+href.replace(/--/g,'- -')+' -->');continue;}visited.add(hit.key);let inc=await fileMap[hit.key].text();const incDir=hit.key.indexOf('/')>=0?hit.key.slice(0,hit.key.lastIndexOf('/')):'';inc=await resolveIncludes(inc,fileMap,incDir,visited);// Strip the XML declaration and the outer <materialx> wrapper,
// keeping only its children.
inc=inc.replace(/<\?xml[^>]*\?>/,'');inc=inc.replace(/<materialx\b[^>]*>/,'').replace(/<\/materialx>\s*$/,'');parts.push(inc);}parts.push(xml.slice(last));return parts.join('');};// Read a dropped file entry, resolving xi:includes against `map`. Callers
// need BOTH strings: the graph editor validates the RAW as-authored text
// while parsing consumes the RESOLVED text.
const readMtlxText=async(entry,path,map)=>{const raw=await entry.text();const dir=path.indexOf('/')>=0?path.slice(0,path.lastIndexOf('/')):'';const resolved=/<xi:include\b/.test(raw)?await resolveIncludes(raw,map,dir):raw;return{raw,resolved};};// Session-lifetime texture cache, keyed by file identity, re-binding the
// same dropped file after a view rebuild reuses the decoded THREE.Texture
// instead of a fresh async load, which let the default color flash.
const TEXTURE_CACHE=new Map();// Shared THREE.KTX2Loader instance (one transcoder worker pool for the
// session). detectSupport() needs a WebGLRenderer to read the GPU's
// supported compressed formats, but only writes them into workerConfig
// (see vendor/three/KTX2Loader.js) and keeps no renderer reference, so the
// result is cached and the probe renderer released, not kept alive.
let _ktx2Loader=null;let _ktx2SupportDetected=false;const getKtx2Loader=view=>{if(!_ktx2Loader){if(typeof THREE.KTX2Loader==='undefined')return null;_ktx2Loader=new THREE.KTX2Loader();_ktx2Loader.setTranscoderPath(new URL('vendor/three/basis/',document.baseURI).href);}if(!_ktx2SupportDetected){const viewRenderer=view&&view.renderer;// No caller renderer yet: a throwaway hidden renderer, never
// attached to the DOM or reused elsewhere, safe to release below.
const renderer=viewRenderer||new THREE.WebGLRenderer();_ktx2Loader.detectSupport(renderer);_ktx2SupportDetected=true;if(!viewRenderer){try{renderer.dispose();}catch(e){/* best-effort */}}}return _ktx2Loader;};// Parses a dropped .ktx2 Blob via THREE.KTX2Loader into a CompressedTexture
// carrying its full mip chain. flipY stays false and no flip is baked at
// encode time (scripts/cook-textures.mjs never flips): our uncompressed
// textures already upload with flipY=false, relying on the MaterialX
// generator to flip UVs in the shader, so KTX2 data must match — top row
// first, same as the source image.
const loadKtx2Texture=async(blob,view,warnPath)=>{const loader=getKtx2Loader(view);if(!loader){console.warn('mtlx-engine: THREE.KTX2Loader unavailable (script blocked/offline); .ktx2 textures keep the node default color.');return null;}try{const buf=await blob.arrayBuffer();const tex=await new Promise((resolve,reject)=>{loader.parse(buf,resolve,reject);});// Block-compressed WebGL formats reject a base level whose width or
// height isn't a multiple of 4 (GL_INVALID_OPERATION), which then
// samples solid black; fall back to the original source instead.
const w=tex&&tex.image?tex.image.width:0;const h=tex&&tex.image?tex.image.height:0;const blockCompressed=!!(tex&&tex.isCompressedTexture);if(blockCompressed&&(w%4!==0||h%4!==0)){tex.dispose&&tex.dispose();mtlxWarn(`mtlx-engine: KTX2 texture ${warnPath||''} has ${w}x${h}, not a multiple of 4; ignoring the .ktx2 sibling`);const err=new Error('ktx2 base level not a multiple of 4');err.ktx2InvalidBaseLevel=true;throw err;}return tex;}catch(e){if(e&&e.ktx2InvalidBaseLevel)throw e;console.warn('mtlx-engine: failed to parse dropped .ktx2 texture, keeping the node default color:',e);return null;}};// Caps a KTX2 CompressedTexture's mip chain to a tier by dropping its
// largest levels (never resampling GPU block data): mipmaps[] is ordered
// largest-first, so this keeps the smallest-side-<=maxSize suffix and
// updates image.width/height to the new top level. Returns the summed byte
// length of the kept levels, for the scene's texture-budget accounting.
const capKtx2MipLevels=(tex,maxSize)=>{if(!tex||!tex.mipmaps||!tex.mipmaps.length)return tex&&tex.image?(tex.image.width||0)*(tex.image.height||0):0;if(!(maxSize>0))return tex.mipmaps.reduce((sum,m)=>sum+(m.data?m.data.byteLength:0),0);let keepFrom=0;while(keepFrom<tex.mipmaps.length-1&&Math.max(tex.mipmaps[keepFrom].width,tex.mipmaps[keepFrom].height)>maxSize)keepFrom+=1;if(keepFrom>0){tex.mipmaps=tex.mipmaps.slice(keepFrom);tex.image.width=tex.mipmaps[0].width;tex.image.height=tex.mipmaps[0].height;tex.needsUpdate=true;}return tex.mipmaps.reduce((sum,m)=>sum+(m.data?m.data.byteLength:0),0);};// Loads the original (non-.ktx2) source for a resolved hit, used when a
// .ktx2 sibling is rejected (e.g. an invalid base level) after having
// already been preferred over this file.
const loadTextureForHit=async(hit,blob,view,samplerModes)=>{const ext=(hit.key.split('.').pop()||'').toLowerCase();if(ext==='exr')return loadExrTexture(blob);if(ext==='hdr')return loadHdrTexture(blob);if(ext==='tif'||ext==='tiff')return loadTifTexture(blob,hit.key);if(view&&view.maxTextureSize&&typeof createImageBitmap==='function'){return loadBoundedBitmapTexture(blob,Number(view.maxTextureSize),samplerModes);}return new Promise(resolve=>{const url=URL.createObjectURL(blob);new THREE.TextureLoader().load(url,tex=>{URL.revokeObjectURL(url);resolve(tex);},undefined,()=>{URL.revokeObjectURL(url);resolve(null);});});};// Perf-only decode/resize/upload split for the Scene texture phase, gated by
// window.MTLX_PERF_LOG; zero cost when off. usd-scene-renderer.js resets this
// once per scene load and folds it into scenePerf when the load finishes.
const resetTexturePerf=()=>{window.__mtlxTexturePerf={decodeMs:0,resizeMs:0,uploadMs:0,count:0};};const addTexturePerf=(key,ms)=>{if(!window.MTLX_PERF_LOG)return;const p=window.__mtlxTexturePerf||(window.__mtlxTexturePerf={decodeMs:0,resizeMs:0,uploadMs:0,count:0});p[key]+=ms;};// localStorage switch for the fast Scene texture decode path below; off only
// when explicitly set to '0' (default on).
const sceneTextureFastPathEnabled=()=>{try{return localStorage.getItem('mtlx_scene_texture_fast')!=='0';}catch(e){return true;}};// .exr/.hdr/.tif decode on the main thread and allocate large float buffers,
// unlike the bounded-bitmap path above which is already pooled per view. This
// pool is shared by every caller of bindDroppedTextures (Viewer, Compare,
// preview, Scene) so a drop with many HDR-ish textures never decodes them all
// at once. mtlx_texture_decode_limit=0 disables it (old fully-parallel start).
const HEAVY_TEXTURE_DECODE_CONCURRENCY=2;const heavyTextureDecodeLimitEnabled=()=>{try{return localStorage.getItem('mtlx_texture_decode_limit')!=='0';}catch(e){return true;}};const heavyTextureDecodeSlots=Array.from({length:HEAVY_TEXTURE_DECODE_CONCURRENCY},()=>Promise.resolve());let heavyTextureDecodeNext=0;const runHeavyTextureDecode=startDecode=>{if(!heavyTextureDecodeLimitEnabled())return startDecode();const slot=heavyTextureDecodeNext%heavyTextureDecodeSlots.length;heavyTextureDecodeNext+=1;const chained=heavyTextureDecodeSlots[slot].catch(()=>{}).then(startDecode);heavyTextureDecodeSlots[slot]=chained.catch(()=>{});return chained;};// Resizes a decoded scene texture that came from an unbounded format loader
// (TIF/EXR/HDR: never resized by createImageBitmap the way PNG/JPEG are) so
// it fits the planner's chosen tier. Returns the same texture unchanged when
// it is already at or below maxSize. TIF (UnsignedByteType RGBA DataTexture)
// is rebuilt through createImageBitmap for real mipmapped trilinear
// filtering, matching PNG/JPEG; EXR/HDR (FloatType) get an integer-factor
// box filter into a new DataTexture, keeping LinearFilter (no mips).
const boundDecodedTexture=async(tex,maxSize)=>{if(!tex||!tex.image)return tex;const w=tex.image.width||0,h=tex.image.height||0;const longest=Math.max(w,h);const needsResize=Number.isFinite(maxSize)&&maxSize>0&&longest>maxSize;if(tex.type===THREE.UnsignedByteType){// Give TIF real mipmaps even when no resize is needed, so it
// filters like PNG/JPEG instead of the DataTexture's LinearFilter.
const scale=needsResize?maxSize/longest:1;const outW=needsResize?Math.max(1,Math.round(w*scale)):w;const outH=needsResize?Math.max(1,Math.round(h*scale)):h;try{const imageData=new ImageData(new Uint8ClampedArray(tex.image.data.buffer.slice(0)),w,h);let bitmap;if(needsResize){bitmap=await createImageBitmap(imageData,{resizeWidth:outW,resizeHeight:outH,resizeQuality:'high'});}else{bitmap=await createImageBitmap(imageData);}const next=new THREE.Texture(bitmap);configureLoadedTexture(next);next.generateMipmaps=true;next.minFilter=THREE.LinearMipmapLinearFilter;next.magFilter=THREE.LinearFilter;tex.dispose&&tex.dispose();return next;}catch(e){// Fallback: canvas drawImage resize, or keep the DataTexture
// with mipmaps if even that fails.
try{const src=document.createElement('canvas');src.width=w;src.height=h;src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(tex.image.data.buffer.slice(0)),w,h),0,0);const dst=document.createElement('canvas');dst.width=outW;dst.height=outH;dst.getContext('2d').drawImage(src,0,0,outW,outH);const next=new THREE.Texture(dst);configureLoadedTexture(next);next.generateMipmaps=true;next.minFilter=THREE.LinearMipmapLinearFilter;next.magFilter=THREE.LinearFilter;tex.dispose&&tex.dispose();return next;}catch(e2){tex.generateMipmaps=true;tex.minFilter=THREE.LinearMipmapLinearFilter;tex.magFilter=THREE.LinearFilter;return tex;}}}if(!needsResize)return tex;// Float data (EXR/HDR): integer-factor box filter into a new DataTexture.
const factor=Math.max(1,Math.round(longest/maxSize));const outW=Math.max(1,Math.floor(w/factor));const outH=Math.max(1,Math.floor(h/factor));const src=tex.image.data;const channels=4;const out=new Float32Array(outW*outH*channels);for(let oy=0;oy<outH;oy+=1){for(let ox=0;ox<outW;ox+=1){const acc=[0,0,0,0];let n=0;for(let fy=0;fy<factor;fy+=1){const sy=oy*factor+fy;if(sy>=h)continue;for(let fx=0;fx<factor;fx+=1){const sx=ox*factor+fx;if(sx>=w)continue;const si=(sy*w+sx)*channels;acc[0]+=src[si];acc[1]+=src[si+1];acc[2]+=src[si+2];acc[3]+=src[si+3];n+=1;}}const di=(oy*outW+ox)*channels;out[di]=acc[0]/n;out[di+1]=acc[1]/n;out[di+2]=acc[2]/n;out[di+3]=acc[3]/n;}}const next=new THREE.DataTexture(out,outW,outH,tex.format,tex.type);next.minFilter=next.magFilter=THREE.LinearFilter;tex.dispose&&tex.dispose();return next;};// Binds dropped textures onto the shader's filename sampler uniforms.
// Cache hits assign synchronously; misses load async (TextureLoader, or
// the .exr/.hdr parsers above). `onBound` fires per texture that lands.
const bindDroppedTextures=(view,fileMap,onBound)=>{if(view&&typeof view.onDisplacementFileMap==='function')view.onDisplacementFileMap(fileMap);if(view&&typeof view.bindTextureFileMap==='function')view.bindTextureFileMap(fileMap);const bound=[],missing=[],udimFirstTile=[];// P4d stage 2: one entry per <UDIM> ref this drop touched, however it
// was resolved (single first-tile bind here, or a full per-mesh split
// via bindTextureFileMap above, which a live view reports separately
// through getUdimTileCount()); a diagnostics-only report field.
const udimTiles=[];const pending=[];const session=view&&view.textureSession;const cache=view.textureCache||TEXTURE_CACHE;const isAlive=()=>typeof view.isAlive!=='function'||view.isAlive();let ktx2Substituted=0;for(const u of view.introspected){if(u.type!=='filename')continue;let ref='';try{if(typeof u.data==='string')ref=u.data;else if(u.data!=null)ref=String(u.data);}catch(e){ref='';}if(!ref)continue;// no file reference recorded
// F3: a preview handle's own textureSession owns decode/refcount/
// dispose instead of the shared TEXTURE_CACHE Map, so a rebuild does
// not leak the previous GL copies. Falls back to the Map path below
// when the view has no session (Scene, legacy callers).
if(session){let sessionHit=session.resolve(fileMap,ref);if(!sessionHit&&/<UDIM>/i.test(ref)){const tiles=session.resolveTiles(fileMap,ref).slice().sort((a,b)=>a.ref.localeCompare(b.ref));if(tiles.length){sessionHit=tiles[0];udimFirstTile.push(ref);udimTiles.push({ref,tiles:tiles.length});}}if(!sessionHit){missing.push(ref);continue;}if(sessionHit.substituted)ktx2Substituted+=1;const samplerModes=u.samplerModes||null;const apply=result=>{if(!result){missing.push(ref);return;}if(!isAlive())return;if(view.uniforms[u.name])view.uniforms[u.name].value=result.texture;if(onBound)onBound();};const acquired=session.acquire(sessionHit,{samplerModes});if(acquired&&typeof acquired.then==='function'){pending.push(acquired.then(apply,error=>{console.warn('mtlx-engine: texture decode failed for '+sessionHit.key+', keeping the node default color:',error);missing.push(ref);}));}else{apply(acquired);}bound.push(ref+'  →  '+sessionHit.key);continue;}let hit=findFileForRef(fileMap,ref);// A UDIM set has no single file; the shaderball's UVs live in the
// first tile, so bind the lowest-numbered tile instead of nothing.
if(!hit&&/<UDIM>/i.test(ref)){const tiles=findFilesForRef(fileMap,ref).sort((a,b)=>a.ref.localeCompare(b.ref));if(tiles.length){hit={key:tiles[0].key,how:'udim-first-tile'};udimFirstTile.push(ref);udimTiles.push({ref,tiles:tiles.length});}}if(!hit){missing.push(ref);continue;}const originalHit=hit;hit=preferKtx2Sibling(fileMap,hit);if(hit.substituted)ktx2Substituted+=1;const blob=fileMap[hit.key];const samplerModes=u.samplerModes||null;// Cache check + load for one uniform, given its resolved raw key.
// Returns the in-flight load promise, or null when it was a cache
// hit (nothing to await) so callers only add real work to `pending`.
const bindWithRawKey=rawKey=>{const cacheKey=samplerCacheKey(rawKey,samplerModes);const cached=cache.get(cacheKey);if(cached){if(isAlive()){if(view.uniforms[u.name])view.uniforms[u.name].value=cached;if(onBound)onBound();}return null;}const ext=(hit.key.split('.').pop()||ref.split('.').pop()||'').toLowerCase();if(ext==='ktx2'){const bindTex=tex=>{if(!tex)return;configureLoadedTexture(tex,samplerModes);if(!isAlive()){tex.dispose&&tex.dispose();return;}cache.set(cacheKey,tex);if(view.uniforms[u.name])view.uniforms[u.name].value=tex;if(onBound)onBound();};return loadKtx2Texture(blob,view,hit.key).then(bindTex,error=>{if(error&&error.ktx2InvalidBaseLevel&&originalHit.key!==hit.key){const notice=`KTX2 texture ${hit.key} is not a multiple of 4; falling back to ${originalHit.key}`;if(view.notices)view.notices.push(notice);return loadTextureForHit(originalHit,fileMap[originalHit.key],view,samplerModes).then(bindTex,e2=>({error:e2}));}return{error};});}else if(ext==='exr'||ext==='hdr'||ext==='tif'||ext==='tiff'){const startDecode=()=>ext==='exr'?loadExrTexture(blob):ext==='hdr'?loadHdrTexture(blob):loadTifTexture(blob,hit.key);const parsePromise=runHeavyTextureDecode(startDecode);return parsePromise.then(tex=>{if(!tex)return;// unsupported/corrupt, the node default color stands
configureLoadedTexture(tex,samplerModes);if(!isAlive()){tex.dispose&&tex.dispose();return;}cache.set(cacheKey,tex);if(view.uniforms[u.name])view.uniforms[u.name].value=tex;if(onBound)onBound();},error=>{console.warn('mtlx-engine: texture decode failed for '+hit.key+', keeping the node default color:',error);missing.push(ref);return{error};});}else if(view.maxTextureSize){const startBoundedLoad=()=>{if(!isAlive())return Promise.resolve(null);return typeof createImageBitmap==='function'?loadBoundedBitmapTexture(blob,Number(view.maxTextureSize),samplerModes):Promise.reject(new Error('createImageBitmap is unavailable for bounded scene texture preview'));};let boundedLoad;// The queue is a small round-robin set of chains (one chain
// per slot) instead of one, so up to that many decodes run
// concurrently; each chain still serializes its own slot so
// memory stays bounded (never more than slot-count bitmaps
// decoding at once). A plain {tail} queue (or none) keeps the
// old fully-serial behaviour.
if(view.textureQueue&&Array.isArray(view.textureQueue.tails)){const q=view.textureQueue;const slot=q.next%q.tails.length;q.next+=1;const previous=q.tails[slot];boundedLoad=previous.catch(()=>{}).then(startBoundedLoad);q.tails[slot]=boundedLoad;}else if(view.textureQueue&&view.textureQueue.tail){const previous=view.textureQueue.tail;boundedLoad=previous.catch(()=>{}).then(startBoundedLoad);view.textureQueue.tail=boundedLoad;}else boundedLoad=startBoundedLoad();return boundedLoad.then(tex=>{if(!tex)return;if(!isAlive()){tex.dispose&&tex.dispose();if(tex.image&&tex.image.close)tex.image.close();return;}cache.set(cacheKey,tex);if(view.uniforms[u.name])view.uniforms[u.name].value=tex;if(onBound)onBound();},error=>({error}));}else{const url=URL.createObjectURL(blob);return new Promise(resolve=>{new THREE.TextureLoader().load(url,tex=>{configureLoadedTexture(tex,samplerModes);if(!isAlive()){tex.dispose&&tex.dispose();URL.revokeObjectURL(url);resolve();return;}cache.set(cacheKey,tex);if(view.uniforms[u.name])view.uniforms[u.name].value=tex;URL.revokeObjectURL(url);if(onBound)onBound();resolve();},undefined,error=>{URL.revokeObjectURL(url);resolve({error});});});}};// Identity-bearing blobs (dragged/dropped Files) resolve the key
// synchronously, unchanged from before. Nameless Blobs (e.g. the VS
// Code webview's fetched texture Blobs) need their bytes sampled
// first, so the whole bind is deferred one microtask via `pending`.
if(hasBlobIdentity(blob)){const loadPromise=bindWithRawKey(textureCacheKey(blob,hit.key));if(loadPromise)pending.push(loadPromise);}else{pending.push(textureCacheKeyAsync(blob,hit.key).then(bindWithRawKey));}bound.push(ref+'  →  '+hit.key);}if(ktx2Substituted>0)console.info('bindDroppedTextures: '+ktx2Substituted+' texture(s) loaded from .ktx2 sibling(s)');if(udimFirstTile.length)console.info('bindDroppedTextures: '+udimFirstTile.length+' UDIM reference(s) bound to their first tile for the preview');return{bound,missing,pending,ktx2Substituted,udimFirstTile,udimTiles};};// ------------------------------------------------------------------
// createTextureSession: decoded CPU prototypes (TEXTURE_SOURCES) are
// refcounted and shared across sessions, kept in an idle LRU up to 256 MiB
// after their last release (no-flash rebind); each session clones a proto
// into one wrapper per (source, samplerModes) via configureLoadedTexture,
// uploaded only on that session's own renderer. TEXTURE_CACHE above stays
// for the legacy Map path (Scene, until P6).
// ------------------------------------------------------------------
const TEXTURE_SOURCE_IDLE_BUDGET=256*1024*1024;const TEXTURE_SOURCES=new Map();// key -> { proto, bytes, refs }
let textureSourceIdleBytes=0;const textureSourceIdleOrder=[];// keys with refs === 0, oldest first
const textureSourceBytes=proto=>{if(!proto||!proto.image)return 0;const w=proto.image.width||0,h=proto.image.height||0;const bpp=proto.isCompressedTexture?1:proto.type===THREE.FloatType?16:4;const mipped=!(proto.type===THREE.FloatType)||proto.isCompressedTexture;return Math.ceil(w*h*bpp*(mipped?4/3:1));};const evictIdleTextureSources=()=>{while(textureSourceIdleBytes>TEXTURE_SOURCE_IDLE_BUDGET&&textureSourceIdleOrder.length){const key=textureSourceIdleOrder.shift();const entry=TEXTURE_SOURCES.get(key);if(!entry)continue;textureSourceIdleBytes-=entry.bytes;TEXTURE_SOURCES.delete(key);if(entry.proto&&entry.proto.image&&typeof entry.proto.image.close==='function')entry.proto.image.close();if(entry.proto&&entry.proto.dispose)entry.proto.dispose();}};const releaseTextureSource=(cache,key)=>{const entry=cache.get(key);if(!entry)return;entry.refs-=1;if(entry.refs>0)return;textureSourceIdleOrder.push(key);textureSourceIdleBytes+=entry.bytes;evictIdleTextureSources();};const acquireTextureSourceRef=(cache,key)=>{const entry=cache.get(key);if(!entry)return null;if(entry.refs===0){const at=textureSourceIdleOrder.indexOf(key);if(at>=0){textureSourceIdleOrder.splice(at,1);textureSourceIdleBytes-=entry.bytes;}}entry.refs+=1;return entry;};// Decode matrix: png/jpg at tier Infinity go through THREE.TextureLoader
// (keeps preview pixels identical to today); ktx2 through loadKtx2Texture
// with capKtx2MipLevels; exr/hdr/tif through the shared heavy-decode
// limiter, then boundDecodedTexture when a finite tier is requested; else
// (png/jpg at a finite tier) the bounded ImageBitmap path.
// bounded (Scene materials): the bounded decoders at every tier, Infinity
// included (TIF gets mipmaps, PNG/JPG through createImageBitmap); a failed
// bound keeps the undecimated texture. bitmapsOnly (Scene displacement):
// only bitmap formats are bounded; KTX2 and float/TIF height maps stay native.
const decodeTextureSource=async(blob,ext,path,tier,renderer,bounded,bitmapsOnly)=>{if(ext==='ktx2'){const tex=await loadKtx2Texture(blob,renderer?{renderer}:null,path);if(tex&&Number.isFinite(tier)&&!bitmapsOnly)capKtx2MipLevels(tex,tier);return tex;}if(ext==='exr'||ext==='hdr'||ext==='tif'||ext==='tiff'){const startDecode=()=>ext==='exr'?loadExrTexture(blob):ext==='hdr'?loadHdrTexture(blob):loadTifTexture(blob,path);let tex=await runHeavyTextureDecode(startDecode);if(tex&&bounded){try{tex=await boundDecodedTexture(tex,tier);}catch(e){/* keep the undecimated texture */}}else if(tex&&Number.isFinite(tier)&&!bitmapsOnly)tex=await boundDecodedTexture(tex,tier);return tex;}if((bounded||bitmapsOnly||Number.isFinite(tier))&&typeof createImageBitmap==='function'){return loadBoundedBitmapTexture(blob,tier,null);}const url=URL.createObjectURL(blob);try{return await new Promise((resolve,reject)=>{new THREE.TextureLoader().load(url,resolve,undefined,reject);});}finally{URL.revokeObjectURL(url);}};// R:2384-2446's ladder/estimate math, generalized over a session's own
// fileMap resolver (exact or fuzzy) instead of the Scene's sceneExactFile.
const planTextureSession=async(session,refs,fileMap)=>{const entries=new Map();// key -> blob
for(const raw of refs||[]){if(raw==null)continue;const ref=String(raw);if(/<UDIM>/i.test(ref)){for(const hit of session.resolveTiles(fileMap,ref)){if(hit&&!entries.has(hit.key))entries.set(hit.key,hit.blob);}continue;}const hit=session.resolve(fileMap,ref);if(hit&&!entries.has(hit.key))entries.set(hit.key,hit.blob);}const dims=await Promise.all(Array.from(entries.entries()).map(async([key,blob])=>{const ext=String(key).split('.').pop().toLowerCase();let dimensions=null;try{dimensions=await readImageDimensions(blob);}catch(e){dimensions=null;}const w=dimensions&&dimensions.width||4096;const h=dimensions&&dimensions.height||4096;const isFloat=ext==='exr'||ext==='hdr';const mipmapped=!isFloat;const bytesPerPixel=ext==='ktx2'?1:isFloat?16:4;return{key,w,h,bytesPerPixel,mipmapped};}));const textureCount=dims.length;const requested=Number.isFinite(session.maxSize)?session.maxSize:Infinity;const ladder=Array.from(new Set([requested].concat(session.tiers).filter(v=>v<=requested))).sort((a,b)=>b-a);if(!ladder.length)ladder.push(session.tiers[session.tiers.length-1]||512);const estimateAt=tier=>dims.reduce((total,d)=>{const w=Math.min(d.w,tier),h=Math.min(d.h,tier);return total+w*h*d.bytesPerPixel*(d.mipmapped?4/3:1);},0);const fullBytes=estimateAt(requested===Infinity?Math.max(4096,...dims.map(d=>Math.max(d.w,d.h)),1):requested);let chosen=ladder[ladder.length-1];let plannedBytes=estimateAt(chosen);for(const tier of ladder){const estimate=estimateAt(tier);if(estimate<=session.budgetBytes){chosen=tier;plannedBytes=estimate;break;}plannedBytes=estimate;}const udimTileCount=dims.filter(d=>/\.(\d{4})\./.test(d.key)||/1[0-9]{3}/.test(d.key)).length;return{tier:chosen,plannedBytes,fullBytes,textureCount,udimTileCount};};const createTextureSession=opts=>{const options=opts||{};const cache=options.cache||TEXTURE_SOURCES;const tiers=options.tiers||[4096,2048,1024,512];const exact=!!options.exact;const maxSize=options.maxSize!=null?options.maxSize:Infinity;const budgetBytes=options.budgetBytes!=null?options.budgetBytes:Infinity;const concurrency=options.concurrency||5;const renderer=options.renderer||null;const isAlive=typeof options.isAlive==='function'?options.isAlive:()=>true;const boundedDecode=!!options.boundedDecode;const boundBitmapsOnly=!!options.boundBitmapsOnly;const sourceRefs=new Map();// sourceKey -> ref count this session holds
const wrappers=new Map();// wrapperKey -> { texture, sourceKey }
const inflight=new Map();// sourceKey -> Promise<entry|null>, dedupes concurrent decodes
const reservations=new Set();let reservedBytes=0;let anisotropy=options.anisotropy!=null?options.anisotropy:8;let disposed=false;const queueTails=Array.from({length:concurrency},()=>Promise.resolve());let queueNext=0;const enqueue=fn=>{const slot=queueNext%queueTails.length;queueNext+=1;const chained=queueTails[slot].catch(()=>{}).then(fn);queueTails[slot]=chained.catch(()=>{});return chained;};const resolve=(fileMap,ref,opts2)=>{const fromDir=opts2&&opts2.fromDir;let hit=exact?findFileForRef(fileMap,ref,{exact:true,fromDir}):findFileForRef(fileMap,ref);if(!hit)return null;hit=preferKtx2Sibling(fileMap,hit);return Object.assign({},hit,{blob:fileMap[hit.key]});};const resolveTiles=(fileMap,ref,opts2)=>{const fromDir=opts2&&opts2.fromDir;const hits=exact?findFilesForRef(fileMap,ref,{exact:true,fromDir}):findFilesForRef(fileMap,ref);return hits.map(hit=>{const subbed=preferKtx2Sibling(fileMap,hit);return Object.assign({},hit,subbed,{blob:fileMap[subbed.key]});});};// acquire()'s body once the raw source key is known.
const acquireKeyed=(hit,opts2,rawKey)=>{const options2=opts2||{};const samplerModes=options2.samplerModes||null;const tier=options2.tier!=null?options2.tier:maxSize;const ext=String(hit.key).split('.').pop().toLowerCase();const sourceKey=rawKey+'|'+(Number.isFinite(tier)?tier:'orig');const wrapperKey=sourceKey+'|'+samplerCacheKey('',samplerModes);const existingWrapper=wrappers.get(wrapperKey);if(existingWrapper)return{texture:existingWrapper.texture};// Idempotent under the concurrent-acquire race below: two
// filename uniforms sharing one (source, samplerModes) both
// resolve past the decode before either has stored a wrapper,
// so the second call here must reuse the first's clone.
const buildWrapper=proto=>{const already=wrappers.get(wrapperKey);if(already)return already.texture;const texture=proto.clone();configureLoadedTexture(texture,samplerModes,anisotropy);wrappers.set(wrapperKey,{texture,sourceKey});return texture;};const existingEntry=cache.get(sourceKey);if(existingEntry){acquireTextureSourceRef(cache,sourceKey);sourceRefs.set(sourceKey,(sourceRefs.get(sourceKey)||0)+1);return{texture:buildWrapper(existingEntry.proto)};}// Two uniforms referencing the same file (same or different
// sampler modes) bound in the same pass call acquire() before
// either await lands; share one in-flight decode instead of
// starting a second one for the same sourceKey.
if(inflight.has(sourceKey)){return inflight.get(sourceKey).then(entry=>{if(!entry)return null;sourceRefs.set(sourceKey,(sourceRefs.get(sourceKey)||0)+1);acquireTextureSourceRef(cache,sourceKey);return{texture:buildWrapper(entry.proto),bytes:entry.bytes};});}const decodePromise=enqueue(()=>decodeTextureSource(hit.blob,ext,hit.key,Number.isFinite(tier)?tier:Infinity,renderer,boundedDecode,boundBitmapsOnly)).then(proto=>{if(!proto)return null;if(disposed||!isAlive()){proto.dispose&&proto.dispose();return null;}let entry=cache.get(sourceKey);if(entry){// Another session raced this decode and stored first.
proto.dispose&&proto.dispose();}else{entry={proto,bytes:textureSourceBytes(proto),refs:0};cache.set(sourceKey,entry);}return entry;});inflight.set(sourceKey,decodePromise);decodePromise.then(()=>inflight.delete(sourceKey),()=>inflight.delete(sourceKey));return decodePromise.then(entry=>{if(!entry)return null;sourceRefs.set(sourceKey,(sourceRefs.get(sourceKey)||0)+1);acquireTextureSourceRef(cache,sourceKey);return{texture:buildWrapper(entry.proto),bytes:entry.bytes};});};// Named `api`, not the handle-builder's own binding name: check-render-
// parity.mjs's guard (g) locates that pair of object literals further
// down this file by a naive first-match regex, which a same-named local
// here anywhere earlier in the file would shadow.
const api={tiers,maxSize,budgetBytes,exact,resolve,resolveTiles,plan:(refs,fileMap)=>planTextureSession(api,refs,fileMap),reserve:(key,opts2)=>{const options2=opts2||{};const k=String(key||'');if(reservations.has(k))return true;if(!Number.isFinite(budgetBytes)){reservations.add(k);return true;}const side=Number.isFinite(maxSize)?maxSize:4096;const estimate=options2.bytes!=null?options2.bytes:Math.ceil(4*side*side*4/3);if(reservedBytes+estimate>budgetBytes)return false;reservations.add(k);reservedBytes+=estimate;return true;},// Identity-bearing Files key synchronously; nameless Blobs (the VS Code webview's
// fetched textures) are fingerprinted first so a texture replaced on disk reloads.
acquire:(hit,opts2)=>{if(!hit||disposed)return null;const blob=hit.blob;const canHash=blob&&typeof blob.slice==='function'&&typeof blob.arrayBuffer==='function';if(hasBlobIdentity(blob)||!canHash)return acquireKeyed(hit,opts2,textureCacheKey(blob,hit.key));return textureCacheKeyAsync(blob,hit.key).then(rawKey=>disposed?null:acquireKeyed(hit,opts2,rawKey));},bind:(target,fileMap,onBound)=>{target.textureSession=api;return bindDroppedTextures(target,fileMap,onBound);},// Drops one wrapper this session handed out (e.g. a texture the
// caller's budget then refused) and releases its source reference.
release:texture=>{for(const[key,w]of wrappers){if(w.texture!==texture)continue;wrappers.delete(key);if(texture.dispose)texture.dispose();const count=sourceRefs.get(w.sourceKey)||0;if(count>1)sourceRefs.set(w.sourceKey,count-1);else sourceRefs.delete(w.sourceKey);if(count>0)releaseTextureSource(cache,w.sourceKey);return true;}return false;},setAnisotropy:value=>{anisotropy=value;wrappers.forEach(w=>{w.texture.anisotropy=value;w.texture.needsUpdate=true;});},stats:()=>({wrapperCount:wrappers.size,sourceCount:sourceRefs.size,reservedBytes,anisotropy}),dispose:()=>{if(disposed)return;disposed=true;wrappers.forEach(w=>{w.texture.dispose&&w.texture.dispose();});wrappers.clear();sourceRefs.forEach((count,key)=>{for(let i=0;i<count;i++)releaseTextureSource(cache,key);});sourceRefs.clear();}};return api;};// ---- Preview geometry ----
// Center a geometry at the origin and scale it to bounding radius 1
// so all preview shapes frame identically.
const normalizeGeometry=geometry=>{geometry.computeBoundingSphere();const bs=geometry.boundingSphere;if(bs&&bs.radius>0){geometry.translate(-bs.center.x,-bs.center.y,-bs.center.z);const s=1/bs.radius;geometry.scale(s,s,s);}return geometry;};// ---- Custom preview geometry (experimental) ----
// Session-wide registry shared by the docs previewer and graph preview, in-memory only.
// The graph editor's DocsDialog iframe has its own separate registry; callers guard for this.
// uvOrigin: 'bottom' (OBJ/UDIM convention, V=0 at the bottom) or 'top'
// (glTF convention, V=0 at the top); feeds classifyTriangle's vFlip so a
// glTF import's UDIM tiles classify the same as an OBJ's would.
const CUSTOM_GEOM={geometry:null,name:'',epoch:0,uvOrigin:'bottom'};// Latest loadCustomPreviewGeomFromFile/Url call wins; bumped by both and by clearCustomPreviewGeom.
let customGeomLoadSeq=0;const getCustomPreviewGeom=()=>CUSTOM_GEOM.geometry?CUSTOM_GEOM:null;// ---- Global geometry selection (shared across every tool) ----
const GLOBAL_GEOM_VALUES=['shaderball-scene','shaderball','shaderball-mtlx','sphere','cube','cloth','buffer2d','custom'];let MTLX_GLOBAL_GEOM=null;// Runs once, on first getGlobalGeom/setGlobalGeom call.
const initGlobalGeom=()=>{try{const stored=window.MtlxRenderSettings.get('geometry',{surface:'viewer'});// Belt-and-suspenders: the store's rejectStored already filters a
// stored/legacy 'custom' out, but 'custom' is session-only, so this
// stays defensive against a future override path returning it anyway.
MTLX_GLOBAL_GEOM=GLOBAL_GEOM_VALUES.includes(stored)&&stored!=='custom'?stored:'shaderball-scene';}catch(e){MTLX_GLOBAL_GEOM='shaderball-scene';}};const getGlobalGeom=()=>{if(MTLX_GLOBAL_GEOM===null)initGlobalGeom();return MTLX_GLOBAL_GEOM;};// Persists only from the top-realm page (embeds must not clobber the host's
// choice) and only for concrete values (custom is registry-local, session-only).
const setGlobalGeom=value=>{if(MTLX_GLOBAL_GEOM===null)initGlobalGeom();if(!GLOBAL_GEOM_VALUES.includes(value)||value===MTLX_GLOBAL_GEOM)return;MTLX_GLOBAL_GEOM=value;try{window.MtlxRenderSettings.set('geometry',value,{surface:'viewer',persist:value!=='custom'});}catch(e){/* privacy mode */}window.dispatchEvent(new CustomEvent('mtlx-global-geom',{detail:{value}}));};// ---- Global display transform selection (shared across every tool) ----
// 'srgb' (default) matches the C++ MaterialXView (no tone mapping). 'aces'
// adds ACES filmic before that curve (this app's original look). 'neutral' is
// Khronos PBR Neutral, which keeps hue and saturation where ACES skews them.
// 'lin_rec709' is raw linear: no OETF, no tone map, no clamp. See ACES_SRGB_GLSL.
const DISPLAY_TRANSFORM_VALUES=['srgb','aces','neutral','lin_rec709'];// Camera exposure in stops, shared by every view. Unlike the transform this is
// a plain uniform (u_displayExposure), so a change costs one uniform write per
// material instead of regenerating every shader.
// Pushes the current transform and exposure onto every live view. Both are
// uniforms now, so this replaces the full material regeneration a transform
// change used to cost, and it reaches the docs node previews too: they are
// LIVE_VIEWS members but have no display listener of their own.
const broadcastDisplaySettings=()=>{LIVE_VIEWS.forEach(v=>{try{v.refreshDisplaySettings&&v.refreshDisplaySettings();}catch(e){/* view mid-teardown */}});};let MTLX_DISPLAY_EXPOSURE=null;const initDisplayExposure=()=>{try{const v=window.MtlxRenderSettings.get('displayExposure',{surface:'viewer'});MTLX_DISPLAY_EXPOSURE=Number.isFinite(v)?v:0;}catch(e){MTLX_DISPLAY_EXPOSURE=0;}};const getDisplayExposure=()=>{if(MTLX_DISPLAY_EXPOSURE===null)initDisplayExposure();return MTLX_DISPLAY_EXPOSURE;};// Linear scale for the uniform. Every seeding site goes through this so the
// stops-to-linear conversion cannot drift between them.
const displayExposureScale=()=>Math.pow(2,getDisplayExposure());const setDisplayExposure=ev=>{if(MTLX_DISPLAY_EXPOSURE===null)initDisplayExposure();const next=Math.max(-8,Math.min(8,Number(ev)||0));if(next===MTLX_DISPLAY_EXPOSURE)return;MTLX_DISPLAY_EXPOSURE=next;try{window.MtlxRenderSettings.set('displayExposure',next,{surface:'viewer'});}catch(e){/* privacy mode */}// Broadcast rather than rely on per-app listeners: every render view is a
// LIVE_VIEWS member, including the docs node previews, which have no
// display listener of their own and would otherwise drift out of sync.
broadcastDisplaySettings();window.dispatchEvent(new CustomEvent('mtlx-display-exposure',{detail:{value:next}}));};let MTLX_DISPLAY_TRANSFORM=null;// Runs once, on first getDisplayTransform/setDisplayTransform call.
const initDisplayTransform=()=>{try{const stored=window.MtlxRenderSettings.get('displayTransform',{surface:'viewer'});MTLX_DISPLAY_TRANSFORM=DISPLAY_TRANSFORM_VALUES.includes(stored)?stored:'srgb';}catch(e){MTLX_DISPLAY_TRANSFORM='srgb';}};// Exposed so a view that keeps its own transform (the Scene) can validate a
// persisted value against the same list the shared picker uses.
const getDisplayTransformValues=()=>DISPLAY_TRANSFORM_VALUES.slice();const getDisplayTransform=()=>{if(MTLX_DISPLAY_TRANSFORM===null)initDisplayTransform();return MTLX_DISPLAY_TRANSFORM;};// Persists only from the top-realm page (same embed guard as setGlobalGeom).
// The mode is a uniform in generated shaders, so every live view can refresh
// it without regenerating material programs.
const setDisplayTransform=value=>{if(MTLX_DISPLAY_TRANSFORM===null)initDisplayTransform();if(!DISPLAY_TRANSFORM_VALUES.includes(value)||value===MTLX_DISPLAY_TRANSFORM)return;MTLX_DISPLAY_TRANSFORM=value;try{window.MtlxRenderSettings.set('displayTransform',value,{surface:'viewer'});}catch(e){/* privacy mode */}broadcastDisplaySettings();window.dispatchEvent(new CustomEvent('mtlx-display-transform',{detail:{value}}));};// Merges every mesh under `root` into one normalized BufferGeometry.
// Extraction must use the accessor API only, never attribute.array.slice
// or toNonIndexed: r128's toNonIndexed corrupts InterleavedBufferAttributes from GLTFLoader.
const buildCustomGeometryFromRoot=(root,fileName)=>{root.updateMatrixWorld(true);const meshes=[];root.traverse(o=>{if(o.isMesh&&o.geometry&&o.geometry.getAttribute('position'))meshes.push(o);});if(!meshes.length){throw new Error('No mesh geometry found in "'+fileName+'".');}const single=meshes.length===1;const parts=meshes.map(mesh=>{const src=mesh.geometry;const posAttr=src.getAttribute('position');const normAttr=src.getAttribute('normal');const uvAttr=src.getAttribute('uv');const hasNormal=!!normAttr;const hasUv=!!uvAttr;const index=src.getIndex();// keepIndex only when single, indexed, and has uv: prepGeometry zero-fills
// a missing uv before its tangent precheck, so an indexed mesh with an
// all-zero uv would reach computeTangents and divide by zero, NaN tangents.
const keepIndex=single&&!!index&&hasUv;const g=new THREE.BufferGeometry();if(keepIndex){const vcount=posAttr.count;const position=new Float32Array(vcount*3);const normal=hasNormal?new Float32Array(vcount*3):null;const uv=new Float32Array(vcount*2);for(let i=0;i<vcount;i++){position[i*3]=posAttr.getX(i);position[i*3+1]=posAttr.getY(i);position[i*3+2]=posAttr.getZ(i);if(normal){normal[i*3]=normAttr.getX(i);normal[i*3+1]=normAttr.getY(i);normal[i*3+2]=normAttr.getZ(i);}uv[i*2]=uvAttr.getX(i);uv[i*2+1]=uvAttr.getY(i);}g.setAttribute('position',new THREE.BufferAttribute(position,3));if(normal)g.setAttribute('normal',new THREE.BufferAttribute(normal,3));g.setAttribute('uv',new THREE.BufferAttribute(uv,2));g.setIndex(index.clone());}else{const vcount=index?index.count:posAttr.count;const position=new Float32Array(vcount*3);const normal=hasNormal?new Float32Array(vcount*3):null;const uv=new Float32Array(vcount*2);// zero-filled when the source has no uv
for(let k=0;k<vcount;k++){const i=index?index.getX(k):k;position[k*3]=posAttr.getX(i);position[k*3+1]=posAttr.getY(i);position[k*3+2]=posAttr.getZ(i);if(normal){normal[k*3]=normAttr.getX(i);normal[k*3+1]=normAttr.getY(i);normal[k*3+2]=normAttr.getZ(i);}if(hasUv){uv[k*2]=uvAttr.getX(i);uv[k*2+1]=uvAttr.getY(i);}}g.setAttribute('position',new THREE.BufferAttribute(position,3));if(normal)g.setAttribute('normal',new THREE.BufferAttribute(normal,3));g.setAttribute('uv',new THREE.BufferAttribute(uv,2));}// r128 BufferGeometry.applyMatrix4 derives the normal matrix from
// this transform internally, so non-uniform scale on `normal` is
// handled correctly without a manual inverse-transpose here.
g.applyMatrix4(mesh.matrixWorld);if(mesh.matrixWorld.determinant()<0){// Winding flip when matrixWorld.determinant() < 0: mirrored transforms
// invert triangle winding, and computeVertexNormals is winding-derived,
// so reverse each triangle here (rendering itself stays DoubleSide).
if(keepIndex){const idx=g.getIndex().array;for(let t=0;t<idx.length;t+=3){const tmp=idx[t+1];idx[t+1]=idx[t+2];idx[t+2]=tmp;}g.getIndex().needsUpdate=true;}else{const swapTriples=attr=>{const arr=attr.array;const n=attr.itemSize;for(let t=0;t+2<attr.count;t+=3){for(let c=0;c<n;c++){const a=(t+1)*n+c,b=(t+2)*n+c;const tmp=arr[a];arr[a]=arr[b];arr[b]=tmp;}}attr.needsUpdate=true;};swapTriples(g.getAttribute('position'));if(g.getAttribute('normal'))swapTriples(g.getAttribute('normal'));swapTriples(g.getAttribute('uv'));}}if(!hasNormal)g.computeVertexNormals();return g;});let merged;if(single){merged=parts[0];}else{// Concatenate the per-mesh non-indexed position/normal/uv arrays
// into one non-indexed BufferGeometry (multi-mesh never keeps an
// index: keepIndex above requires a lone mesh).
let totalVerts=0;parts.forEach(g=>{totalVerts+=g.getAttribute('position').count;});const position=new Float32Array(totalVerts*3);const normal=new Float32Array(totalVerts*3);const uv=new Float32Array(totalVerts*2);let vOff=0;parts.forEach(g=>{const p=g.getAttribute('position');position.set(p.array,vOff*3);normal.set(g.getAttribute('normal').array,vOff*3);uv.set(g.getAttribute('uv').array,vOff*2);vOff+=p.count;});merged=new THREE.BufferGeometry();merged.setAttribute('position',new THREE.BufferAttribute(position,3));merged.setAttribute('normal',new THREE.BufferAttribute(normal,3));merged.setAttribute('uv',new THREE.BufferAttribute(uv,2));}return normalizeGeometry(merged);};// 1x1 transparent PNG, served for every texture request while loading a
// custom preview model: previews are geometry-only by design.
const CUSTOM_GEOM_BLANK_PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';// Lowercased basename of a URL or file name: strips query/fragment, then
// everything up to the last slash.
const lowerBasename=s=>String(s||'').split('?')[0].split('#')[0].split(/[\\/]/).pop().toLowerCase();// Strips every texture reference from a parsed glTF JSON in place, so
// GLTFLoader never requests an image. Leaves KHR_draco_mesh_compression
// alone: nothing here matches "Texture"/"texture".
const stripGltfTextures=json=>{delete json.images;delete json.textures;delete json.samplers;(json.materials||[]).forEach(mat=>{delete mat.normalTexture;delete mat.occlusionTexture;delete mat.emissiveTexture;if(mat.pbrMetallicRoughness){delete mat.pbrMetallicRoughness.baseColorTexture;delete mat.pbrMetallicRoughness.metallicRoughnessTexture;}Object.keys(mat.extensions||{}).forEach(key=>{const ext=mat.extensions[key];if(!ext||typeof ext!=='object')return;Object.keys(ext).forEach(k=>{if(/Texture$/.test(k))delete ext[k];});});});['extensionsUsed','extensionsRequired'].forEach(key=>{if(Array.isArray(json[key]))json[key]=json[key].filter(n=>!/texture/i.test(n));});};// Reads a .glb container's two chunks (parsed JSON, raw BIN bytes or null)
// per the layout in vendor/three/GLTFLoader.js's GLTFBinaryExtension
// (:839-900). Returns null on ANY parse anomaly (bad magic/version,
// truncated chunk, invalid JSON) so callers can fall back safely.
const readGlbChunks=arrayBuffer=>{try{if(!arrayBuffer||typeof arrayBuffer.byteLength!=='number'||arrayBuffer.byteLength<12)return null;const header=new DataView(arrayBuffer,0,12);const magic=String.fromCharCode.apply(null,new Uint8Array(arrayBuffer,0,4));if(magic!=='glTF')return null;const version=header.getUint32(4,true);const totalLength=header.getUint32(8,true);if(version<2||totalLength>arrayBuffer.byteLength)return null;let jsonBytes=null;let binBytes=null;let offset=12;while(offset+8<=totalLength){const chunkHeader=new DataView(arrayBuffer,offset,8);const chunkLength=chunkHeader.getUint32(0,true);const chunkType=chunkHeader.getUint32(4,true);const dataStart=offset+8;if(dataStart+chunkLength>totalLength)return null;if(chunkType===0x4e4f534a)jsonBytes=new Uint8Array(arrayBuffer,dataStart,chunkLength);// 'JSON'
else if(chunkType===0x004e4942)binBytes=arrayBuffer.slice(dataStart,dataStart+chunkLength);// 'BIN\0'
offset=dataStart+chunkLength;}if(!jsonBytes)return null;return{json:JSON.parse(new TextDecoder().decode(jsonBytes)),binBytes};}catch(e){return null;}};// KTX2/Basis (and any texture) tolerance for .glb: strips textures from a
// binary .glb's JSON chunk by reusing stripGltfTextures, then
// re-serializes (JSON chunk padded to a 4-byte boundary with 0x20 spaces,
// BIN chunk byte-verbatim, all lengths recomputed). Also stops .glb
// embedded textures being pointlessly fetched and decoded then discarded.
// Returns the ORIGINAL buffer unchanged on any parse anomaly.
const stripGlbTextures=arrayBuffer=>{const parsed=readGlbChunks(arrayBuffer);if(!parsed)return arrayBuffer;stripGltfTextures(parsed.json);let jsonText=JSON.stringify(parsed.json);while(jsonText.length%4!==0)jsonText+=' ';const jsonBytes=new TextEncoder().encode(jsonText);const binBytes=parsed.binBytes?new Uint8Array(parsed.binBytes):null;const jsonChunkLen=8+jsonBytes.length;const binChunkLen=binBytes?8+binBytes.length:0;const totalLength=12+jsonChunkLen+binChunkLen;const out=new ArrayBuffer(totalLength);const outView=new DataView(out);const outBytes=new Uint8Array(out);outBytes.set([0x67,0x6c,0x54,0x46],0);// 'glTF'
outView.setUint32(4,2,true);outView.setUint32(8,totalLength,true);outView.setUint32(12,jsonBytes.length,true);outView.setUint32(16,0x4e4f534a,true);// 'JSON'
outBytes.set(jsonBytes,20);if(binBytes){const binOffset=12+jsonChunkLen;outView.setUint32(binOffset,binBytes.length,true);outView.setUint32(binOffset+4,0x004e4942,true);// 'BIN\0'
outBytes.set(binBytes,binOffset+8);}return out;};// Lazy DRACOLoader singleton: own default LoadingManager (not
// parseModelRoot's per-call manager) so parseModelRoot's setURLModifier
// (blank-PNG texture swap) never intercepts the decoder wasm/js fetches.
let dracoLoaderInstance=null;const getDracoLoader=()=>{if(!THREE.DRACOLoader)return null;if(!dracoLoaderInstance){dracoLoaderInstance=new THREE.DRACOLoader().setDecoderPath(new URL('vendor/three/draco/',document.baseURI).href);}return dracoLoaderInstance;};// Parses model bytes (string for obj/gltf, ArrayBuffer for glb) into a root
// Object3D. opts.sidecars (File map keyed by lowerBasename) and
// opts.resourcePath resolve .bin/texture references; label is for errors.
const parseModelRoot=async(ext,data,label,opts)=>{opts=opts||{};if(ext==='obj'){if(typeof THREE.OBJLoader==='undefined'){throw new Error('OBJLoader unavailable (script blocked/offline). Cannot load .obj models.');}try{return new THREE.OBJLoader().parse(data);}catch(e){throw new Error('Could not parse "'+label+'": '+e.message);}}if(typeof THREE.GLTFLoader==='undefined'){throw new Error('GLTFLoader unavailable (script blocked/offline). Cannot load .glb/.gltf models.');}const sidecars=opts.sidecars||{};const hasSidecars=Object.keys(sidecars).length>0;const resourcePath=opts.resourcePath||'';const objectUrls=[];const sidecarUrls={};Object.keys(sidecars).forEach(key=>{const u=URL.createObjectURL(sidecars[key]);sidecarUrls[key]=u;objectUrls.push(u);});// createImageBitmap subset of the decodable set (excludes the dedicated
// exr/hdr/tif/tiff/ktx2 decoders). Single source of truth:
// js/shared/texture-formats.js.
const bitmapExts=window.MTLX_TEXTURE_EXTS.filter(e=>window.MTLX_DEDICATED_DECODER_EXTS.indexOf(e)===-1);const bitmapExtRe=new RegExp('\\.('+bitmapExts.join('|')+')$','i');// Redirects sidecar (.bin) requests to their object URL and swallows
// every texture request with a blank PNG; anything else (buffer
// fetches with no sidecar) passes through to fail into the triage below.
const manager=new THREE.LoadingManager();manager.setURLModifier(url=>{const base=lowerBasename(url);let decoded=base;try{decoded=decodeURIComponent(base);}catch(e){/* not percent-encoded */}if(sidecarUrls[base])return sidecarUrls[base];if(sidecarUrls[decoded])return sidecarUrls[decoded];if(bitmapExtRe.test(decoded))return CUSTOM_GEOM_BLANK_PNG;return url;});try{let payload=data;let declaresDraco=false;if(ext==='gltf'){let json;try{json=JSON.parse(data);}catch(e){throw new Error('Could not parse "'+label+'": '+e.message);}declaresDraco=Array.isArray(json.extensionsUsed)&&json.extensionsUsed.indexOf('KHR_draco_mesh_compression')!==-1;stripGltfTextures(json);payload=JSON.stringify(json);}else if(ext==='glb'){payload=stripGlbTextures(data);const parsedGlb=readGlbChunks(payload);declaresDraco=!!(parsedGlb&&Array.isArray(parsedGlb.json.extensionsUsed)&&parsedGlb.json.extensionsUsed.indexOf('KHR_draco_mesh_compression')!==-1);}const dracoLoader=getDracoLoader();if(declaresDraco&&dracoLoader){// decodeDracoFile has no error path at all (see the trap noted
// beside getDracoLoader): preload the decoder files up front so
// a 404/offline decoder rejects catchably here, rather than
// only surfacing 20s later via the timeout race below.
try{await dracoLoader.preload();}catch(e){throw new Error('"'+label+'" uses Draco mesh compression, but the decoder is unavailable (script blocked/offline): '+(e&&e.message||e));}}try{const gltfLoader=new THREE.GLTFLoader(manager);if(dracoLoader)gltfLoader.setDRACOLoader(dracoLoader);// Belt-and-braces: textures (including any KTX2/Basis
// reference) are already stripped above; if one slips through
// anyway, hand back a blank texture instead of leaving
// setKTX2Loader unset, which throws when the extension is
// declared required.
gltfLoader.setKTX2Loader({load:(u,onLoad)=>onLoad(new THREE.Texture())});const parsePromise=new Promise((resolve,reject)=>{try{gltfLoader.parse(payload,resourcePath,resolve,reject);}catch(e){reject(e);}});// DRACOLoader r128 has no error path (decodeDracoFile has no
// .catch and GLTFDracoMeshCompressionExtension wraps it in a
// Promise with no reject), so a corrupt payload or a
// CSP-blocked decoder worker hangs parse() forever without this.
const gltf=declaresDraco?await Promise.race([parsePromise,new Promise((_,reject)=>{setTimeout(()=>reject(new Error('"'+label+'" timed out decoding (possibly a corrupt Draco payload).')),20000);})]):await parsePromise;return gltf.scene||gltf.scenes&&gltf.scenes[0];}catch(e){const msg=e&&e.message||String(e);if(/timed out decoding/.test(msg))throw e;if(/DRACOLoader/i.test(msg)){throw new Error('"'+label+'" uses Draco mesh compression, but the decoder is unavailable (script blocked/offline).');}if(/KTX2|basisu/i.test(msg)){throw new Error('"'+label+'" uses KTX2/Basis texture compression, which is not supported here: re-export without KTX2/Basis textures.');}if(ext==='gltf'){const hint=hasSidecars||!resourcePath?'This .gltf references external data; select its .bin file(s) together with the .gltf.':'A file referenced by this .gltf could not be fetched (CORS or missing).';throw new Error('Could not load "'+label+'": '+msg+'. '+hint);}throw new Error('Could not load "'+label+'": '+msg);}}finally{objectUrls.forEach(u=>{try{URL.revokeObjectURL(u);}catch(e){/* already revoked */}});}};// Builds `root` into a geometry and, if this call is still the latest
// (seqId === customGeomLoadSeq), swaps it into CUSTOM_GEOM and dispatches
// mtlx-custom-geom. A stale winner's geometry is disposed instead.
const commitCustomGeom=(root,label,seqId)=>{const built=buildCustomGeometryFromRoot(root,label);if(seqId!==customGeomLoadSeq){try{built.dispose();}catch(e){/* registry copy is never GPU-uploaded */}return null;}const prev=CUSTOM_GEOM.geometry;CUSTOM_GEOM.geometry=built;CUSTOM_GEOM.name=String(label||'custom');CUSTOM_GEOM.uvOrigin=/\.(glb|gltf)$/i.test(String(label||''))?'top':'bottom';CUSTOM_GEOM.epoch+=1;if(prev){try{prev.dispose();}catch(e){/* registry copy is never GPU-uploaded */}}// Keep-alive hidden preview tools subscribe to this event to mirror the
// registry into their own local state, since their views never unmount
// and so never get a natural remount hook to re-read CUSTOM_GEOM from.
window.dispatchEvent(new CustomEvent('mtlx-custom-geom',{detail:{epoch:CUSTOM_GEOM.epoch,name:CUSTOM_GEOM.name}}));setGlobalGeom('custom');return CUSTOM_GEOM;};// Loads a user-dropped model: input is a File, FileList, or File[]. First
// .obj/.glb/.gltf entry is primary; .bin entries become sidecars; other
// files (textures, etc.) are dropped. Latest call wins (customGeomLoadSeq).
const loadCustomPreviewGeomFromFile=async input=>{const id=++customGeomLoadSeq;const files=input instanceof FileList?Array.from(input):Array.isArray(input)?input:input?[input]:[];const primary=files.find(f=>f&&/\.(obj|glb|gltf)$/i.test(f.name||''));if(!primary){throw new Error('Select a .obj, .glb or .gltf model file.');}const primaryName=primary.name.toLowerCase();const ext=primaryName.slice(primaryName.lastIndexOf('.')+1);const sidecars={};files.forEach(f=>{if(f!==primary&&f&&/\.bin$/i.test(f.name||''))sidecars[lowerBasename(f.name)]=f;});const data=ext==='glb'?await primary.arrayBuffer():await primary.text();const root=await parseModelRoot(ext,data,primary.name,{sidecars});return commitCustomGeom(root,primary.name,id);};// Fetches and loads a model from a URL, same pipeline as the file picker.
// gltf/glb pass the model's directory as resourcePath so GLTFLoader can
// fetch a sibling .bin; extension is sniffed after stripping query/fragment.
const loadCustomPreviewGeomFromUrl=async url=>{const id=++customGeomLoadSeq;const clean=String(url||'').split('?')[0].split('#')[0];const ext=clean.slice(clean.lastIndexOf('.')+1).toLowerCase();if(ext!=='obj'&&ext!=='glb'&&ext!=='gltf'){throw new Error('Unsupported model URL "'+url+'": expected .obj, .glb, or .gltf.');}const r=await fetch(url);if(!r.ok)throw new Error('Failed to fetch model "'+url+'" (HTTP '+r.status+').');const data=ext==='glb'?await r.arrayBuffer():await r.text();const base=clean.slice(clean.lastIndexOf('/')+1)||'custom';const opts=ext==='obj'?undefined:{resourcePath:clean.slice(0,clean.lastIndexOf('/')+1)};const root=await parseModelRoot(ext,data,base,opts);return commitCustomGeom(root,base,id);};// Clears the custom-geometry registry. Bumps customGeomLoadSeq FIRST so an
// in-flight load that resolves after this is discarded, not installed.
const clearCustomPreviewGeom=()=>{++customGeomLoadSeq;const prev=CUSTOM_GEOM.geometry;CUSTOM_GEOM.geometry=null;CUSTOM_GEOM.name='';CUSTOM_GEOM.epoch+=1;window.dispatchEvent(new CustomEvent('mtlx-custom-geom',{detail:{epoch:CUSTOM_GEOM.epoch,name:CUSTOM_GEOM.name}}));if(getGlobalGeom()==='custom')setGlobalGeom('shaderball-scene');if(prev){try{prev.dispose();}catch(e){/* registry copy is never GPU-uploaded */}}if(dracoLoaderInstance){dracoLoaderInstance.dispose();dracoLoaderInstance=null;}};// Shaderball: two GLB exports of the ASWF/USD-WG Standard Shader Ball
// under models/ (see models/LICENSE_shaderball.txt). glbSceneCache holds the raw
// GLTFLoader result per URL; consumers clone() rather than mutate/dispose it.
const glbSceneCache=new Map();const loadGlbScene=url=>{if(!glbSceneCache.has(url)){glbSceneCache.set(url,new Promise(resolve=>{if(!THREE.GLTFLoader){resolve(null);return;}const loader=new THREE.GLTFLoader();const dracoLoader=getDracoLoader();if(dracoLoader)loader.setDRACOLoader(dracoLoader);loader.load(url,gltf=>resolve(gltf),undefined,e=>{console.warn('shaderball scene load failed:',url,e);resolve(null);});}));}return glbSceneCache.get(url);};// Instantiates a PER-VIEW copy of the cached shaderball scene (see
// instantiateShaderballGltf). Returns null on load failure or a missing 'material_surface' mesh.
const instantiateShaderballScene=async(mode/* 'full' | 'simple' */)=>{const url=new URL(mode==='full'?'models/shaderball.glb':'models/shaderball_simple.glb',document.baseURI).href;const gltf=await loadGlbScene(url);if(!gltf)return null;return instantiateShaderballGltf(gltf,mode);};// The MaterialX project's shader ball (models/shaderball_mtlx.glb, see
// models/LICENSE_shaderball_mtlx.txt): fetched once and cached as
// reference geometry alongside the bundled models/*.glb presets.
let shaderballMtlxPromise=null;const getShaderballMtlxGeometry=()=>{if(!shaderballMtlxPromise){shaderballMtlxPromise=(async()=>{if(!THREE.GLTFLoader)return null;const url=new URL('models/shaderball_mtlx.glb',document.baseURI).href;return new Promise(resolve=>{const loader=new THREE.GLTFLoader();const dracoLoader=getDracoLoader();if(dracoLoader)loader.setDRACOLoader(dracoLoader);loader.load(url,gltf=>{try{// Several meshes (ball, base, ...) with node transforms,
// bake each mesh's world matrix and concatenate into one
// BufferGeometry so it shares a single preview material.
const parts=[];gltf.scene.updateMatrixWorld(true);gltf.scene.traverse(obj=>{if(obj.isMesh&&obj.geometry){const g=obj.geometry.clone().toNonIndexed();g.applyMatrix4(obj.matrixWorld);parts.push(g);}});if(!parts.length)return resolve(null);// Manual attribute concat (BufferGeometryUtils isn't loaded).
const total=parts.reduce((n,g)=>n+g.getAttribute('position').count,0);const pos=new Float32Array(total*3);const nrm=new Float32Array(total*3);const uv=new Float32Array(total*2);let off=0;for(const g of parts){const p=g.getAttribute('position');const n=g.getAttribute('normal');const u=g.getAttribute('uv');pos.set(p.array,off*3);if(n)nrm.set(n.array,off*3);if(u)uv.set(u.array,off*2);off+=p.count;}const merged=new THREE.BufferGeometry();merged.setAttribute('position',new THREE.BufferAttribute(pos,3));merged.setAttribute('normal',new THREE.BufferAttribute(nrm,3));merged.setAttribute('uv',new THREE.BufferAttribute(uv,2));// computeTangents (inside prepGeometry) requires an
// index; the merge above is non-indexed, so give it
// a trivial sequential one.
const idx=new Uint32Array(total);for(let ii=0;ii<total;ii++)idx[ii]=ii;merged.setIndex(new THREE.BufferAttribute(idx,1));resolve(prepGeometry(normalizeGeometry(merged)));}catch(e){console.warn('shaderball-mtlx merge failed:',e);resolve(null);}},undefined,e=>{console.warn('shaderball-mtlx load failed:',e);resolve(null);});});})();}return shaderballMtlxPromise;};// Cloth drape preset (models/cloth_base_mesh.glb, see
// models/LICENSE_cloth.txt): a single-mesh GLB, bake its world
// transform, prep once, and clone per view like shaderball-mtlx.
let clothGeometryPromise=null;const getClothGeometry=()=>{if(!clothGeometryPromise){clothGeometryPromise=(async()=>{const url=new URL('models/cloth_base_mesh.glb',document.baseURI).href;const gltf=await loadGlbScene(url);if(!gltf)return null;try{gltf.scene.updateMatrixWorld(true);let geom=null;gltf.scene.traverse(obj=>{if(!geom&&obj.isMesh&&obj.geometry){geom=obj.geometry.clone();geom.applyMatrix4(obj.matrixWorld);}});if(!geom)return null;return prepGeometry(normalizeGeometry(geom));}catch(e){console.warn('cloth geometry load failed:',e);return null;}})();}return clothGeometryPromise;};// Builds cube/sphere/cloth/shaderball-mtlx preview geometry, the shaderball/
// shaderball-scene presets are full GLB scenes handled separately by
// instantiateShaderballScene(). Any unrecognized `which` falls back to
// the sphere (including a shaderball-mtlx fetch failure).
const buildPreviewGeometry=async which=>{if(which==='cube'){return normalizeGeometry(new THREE.BoxGeometry(1.3,1.3,1.3));}if(which==='shaderball-mtlx'){const g=await getShaderballMtlxGeometry();if(g)return g.clone();}if(which==='cloth'){const g=await getClothGeometry();if(g)return g.clone();}if(which==='buffer2d'){// Fullscreen quad for the flat2d ortho frustum: already exactly
// framed, so no normalizeGeometry (it would shrink the quad to
// bounding radius 1, off the viewport edges). +Z normal faces
// the camera; positions and UVs get refit to the canvas aspect
// by fitQuadToAspect (screen-proportional Shadertoy convention).
return new THREE.PlaneGeometry(2,2);}if(which==='custom'&&CUSTOM_GEOM.geometry){// Per-view clone: prepGeometry mutates and disposePartial() disposes the
// view's geometry at teardown; the registry copy must survive both.
return CUSTOM_GEOM.geometry.clone();}return new THREE.SphereGeometry(1,64,64);};// `defFilter` (optional) narrows matching nodedefs, categories aren't
// unique across libraries ('add' is math AND BSDF/EDF/VDF). `preferType`
// picks an output type explicitly; `preferDefName` pins an exact nodedef.
const resolveNodeKind=(doc,nodeName,defFilter,preferType,preferDefName)=>{mxWarnIfLocked('resolveNodeKind');// exported doc-reading helper (per node-selection, not per-frame), see mxWarnIfLocked's header comment
let defs=vecToArray(doc.getMatchingNodeDefs(nodeName));let named=null;if(preferDefName){named=defs.find(d=>d.getName&&d.getName()===preferDefName)||null;}if(named){defs=[named];}else if(defFilter){const kept=defs.filter(defFilter);if(kept.length)defs=kept;}// Flatten every def into candidate outputs.
const candidates=[];// { type, outputName, multiOutput }
const allTypes=[];for(const def of defs){const outs=vecToArray(def.getOutputs?def.getOutputs():null);const multiOutput=def.getType&&def.getType()==='multioutput'||outs.length>1;if(outs.length===0){const t=def.getType();allTypes.push(t);candidates.push({type:t,outputName:null,multiOutput:false});}else{for(const o of outs){const t=o.getType();allTypes.push(t);// With a single output, downstream doesn't need an
// explicit output name; with several, it does.
candidates.push({type:t,outputName:multiOutput?o.getName():null,multiOutput});}}}// Explicit signature selection beats the default priority.
if(preferType){const want=candidates.find(c=>c.type===preferType);if(want){if(want.type==='surfaceshader')return{kind:'surface',...want};if(want.type==='BSDF')return{kind:'bsdf',...want};if(want.type==='EDF')return{kind:'edf',...want};if(COLOR_VIEWABLE.indexOf(want.type)!==-1){return{kind:'color',outType:want.type,outputName:want.outputName,multiOutput:want.multiOutput};}return{kind:null,types:[want.type]};}// No candidate of that type (spec token didn't map to a real
// nodedef): fall through to the automatic priority below.
}// Priority: surface shader > BSDF > EDF > first viewable color/vector.
const surf=candidates.find(c=>c.type==='surfaceshader');if(surf)return{kind:'surface',...surf};const bsdf=candidates.find(c=>c.type==='BSDF');if(bsdf)return{kind:'bsdf',...bsdf};const edf=candidates.find(c=>c.type==='EDF');if(edf)return{kind:'edf',...edf};for(const t of COLOR_VIEWABLE){const hit=candidates.find(c=>c.type===t);if(hit)return{kind:'color',outType:t,outputName:hit.outputName,multiOutput:hit.multiOutput};}return{kind:null,types:allTypes};};// Path to the app's default equirect environment: a studio EXR, parsed
// via EXRLoader and routed through prepareEnv/padToRGBA. No paired
// irradiance file, diffuse irradiance is always SH-synthesized (below).
const ENV_MAP_URL='./env_maps/standard_shader_ball_env_512.exr';// Load the environment ONCE and reuse across previews. Resolves to
// { radiance, irradiance, mips } or null if no file is present, in
// which case the caller uses the synthesized makeEnvTexture sky.
let envPromise=null;// Session-wide user-imported environment override: when set, every
// newly-created render view uses this instead of getEnvironment().
// null = no override; getEnvironment() itself stays the Reset target.
let envOverride=null;// Auto key-light extraction toggle (env dialog UI). Persisted; default on.
let keyLightEnabled=true;try{keyLightEnabled=!!window.MtlxRenderSettings.get('keyLight',{surface:'viewer'});}catch(e){/* localStorage unavailable, default stays on */}// Pristine (pre-extraction) bytes behind the default/override env, so
// the toggle can re-parse + rebuild without a re-fetch/re-drop.
let defaultEnvSource=null,overrideEnvSource=null;// The built default env object and the override counter, for getEnvironmentSource.
let defaultEnvBuilt=null,envOverrideSerial=0;// Registry of live render-view handles, so environment imports/resets
// broadcast to EVERY live view, not just the visible one, otherwise a
// hidden keep-alive view keeps its stale baked-in environment.
const LIVE_VIEWS=new Set();// registerLiveView/unregisterLiveView: window-exported wrappers so a
// handle outside this module (the USD Scene) can join the same
// environment/settings broadcast as createMtlxRenderView's own handles.
const registerLiveView=handle=>{if(handle)LIVE_VIEWS.add(handle);};const unregisterLiveView=handle=>{if(handle)LIVE_VIEWS.delete(handle);};// Engine-wide WebGL context budget. Chromium keeps 16 live contexts per page and
// evicts the oldest silently, so past this cap the least recently rendered idle
// view is suspended (loseContext) and restored by its own render loop on demand.
const MTLX_GL_CONTEXT_CAP=12;const glCapLog=msg=>{if(window.MTLX_PERF_LOG)console.log('[mtlx-gl] '+msg);};// Called right before a view takes a context; `incoming` is its canvas, whose own
// (rebuilt) context is not counted. Never touches active, held or mid-apply views.
const enforceGlContextCap=incoming=>{const live=[];LIVE_VIEWS.forEach(v=>{const c=v.glCtx;if(c&&c.canvas!==incoming&&!c.lost())live.push(v);});const warm=MTLX_WARM_CTX&&MTLX_WARM_CTX.gl&&!MTLX_WARM_CTX.gl.isContextLost()?1:0;let count=live.length+warm+1;if(count<=MTLX_GL_CONTEXT_CAP)return;const idle=live.filter(v=>v.glCtx.suspendable()).sort((a,b)=>a.glCtx.lastRender()-b.glCtx.lastRender());for(const v of idle){if(count<=MTLX_GL_CONTEXT_CAP)break;if(v.glCtx.suspend()){count--;glCapLog('suspended '+v.glCtx.label+' (live '+count+')');}}};// Releases whatever context a discarded canvas still holds; a no-op for one without any.
const releaseGlContext=canvas=>{try{if(!canvas)return;const gl=canvas.getContext('webgl2');const ext=gl&&!gl.isContextLost()&&gl.getExtension('WEBGL_lose_context');if(ext)ext.loseContext();}catch(e){/* canvas has no usable context */}};// Moved to js/shared/render-environment.js; lazy alias, called only at
// runtime, well after that file has loaded.
const keyLightRotationMatrix=rad=>MtlxRender.keyLightRotationMatrix(rad);// Live-updates ONLY the key-light slot (last entry) of an already-bound
// u_lightData array in place, mutates values, never replaces the
// array/uniform object (three r128 caches the struct-array layout).
const updateKeyLightUniformEntry=(uniforms,rigCount,keyLight,rotRad,envScale)=>{const entry=uniforms&&uniforms.u_lightData&&uniforms.u_lightData.value&&uniforms.u_lightData.value[rigCount];if(!entry)return;if(keyLight){entry.direction.copy(keyLight.direction).applyMatrix4(keyLightRotationMatrix(rotRad||0));entry.color.set(keyLight.color[0],keyLight.color[1],keyLight.color[2]);entry.intensity=keyLight.intensity*(Number.isFinite(envScale)?envScale:1);}else{entry.direction.set(0,-1,0);entry.color.set(0,0,0);entry.intensity=0;}if(uniforms.u_numActiveLightSources)uniforms.u_numActiveLightSources.value=rigCount+(keyLight?1:0);};const getEnvironment=()=>{if(!envPromise){// fetch() -> ArrayBuffer -> parseEnvBuffer, mirroring
// loadEnvironmentFromFile's path (same helper, different byte
// source). Any failure resolves null; this promise never rejects.
const ext=ENV_MAP_URL.slice(ENV_MAP_URL.lastIndexOf('.')).toLowerCase();envPromise=fetch(ENV_MAP_URL).then(r=>r.ok?r.arrayBuffer():null).catch(()=>null).then(buf=>{if(!buf)return null;// no file / fetch failed → synthesized sky
const raw=parseEnvBuffer(buf,ext);if(!raw||!raw.image||!raw.image.data)return null;// parse failed → synthesized sky
defaultEnvSource={buf,ext};// pristine bytes, for the key-light toggle rebuild
const built=buildEnvFromParsedTexture(raw,keyLightEnabled,defaultEnvSource);defaultEnvBuilt=built;return built;});}return envPromise;};// Builds an environment from raw bytes into the same shape getEnvironment()
// returns. `label` only names the source in error messages; `remember` caches
// the pristine bytes for the key-light toggle and belongs to the session-wide
// override alone, so a stage's own dome light passes false.
const loadEnvironmentFromBuffer=async(buf,ext,label,remember=true)=>{const lower=String(ext||'').toLowerCase();if(lower!=='.hdr'&&lower!=='.exr'){throw new Error('Unsupported environment file "'+label+'", expected .hdr or .exr.');}// Loader-presence checks run BEFORE parseEnvBuffer purely so the
// dialog can report which specific script is missing, parseEnvBuffer
// itself just returns null on this, with no message.
if(lower==='.hdr'&&typeof THREE.RGBELoader==='undefined'){throw new Error('RGBELoader unavailable (script blocked/offline), cannot load .hdr environments.');}if(lower==='.exr'&&typeof THREE.EXRLoader==='undefined'){throw new Error('EXRLoader unavailable (script blocked/offline), cannot load .exr environments.');}const raw=parseEnvBuffer(buf,lower);if(!raw||!raw.image||!raw.image.data){throw new Error('Failed to parse the environment image "'+label+'".');}if(remember)overrideEnvSource={buf,ext:lower};return buildEnvFromParsedTexture(raw,keyLightEnabled,remember?overrideEnvSource:null);};// Constant-colour environment in the same shape, for a USD dome light that
// carries a colour but no texture. Small on purpose: every texel is equal,
// so resolution buys nothing and the mip chain still builds normally.
const FLAT_ENV_W=32;const FLAT_ENV_H=16;const makeFlatEnvironment=rgb=>{const[r,g,b]=Array.isArray(rgb)&&rgb.length>=3?rgb:[1,1,1];const data=new Uint16Array(FLAT_ENV_W*FLAT_ENV_H*4);const half=[floatToHalf(r),floatToHalf(g),floatToHalf(b),floatToHalf(1)];for(let i=0;i<data.length;i+=4){data[i]=half[0];data[i+1]=half[1];data[i+2]=half[2];data[i+3]=half[3];}const tex=new THREE.DataTexture(data,FLAT_ENV_W,FLAT_ENV_H,THREE.RGBAFormat,THREE.HalfFloatType);tex.flipY=false;return buildEnvFromParsedTexture(tex);};// Loads a user-dropped environment file into the same shape
// getEnvironment() returns, reusing its parse/build helpers. Unlike
// getEnvironment(), throws on failure instead of a silent fallback.
const loadEnvironmentFromFile=async file=>{const name=(file&&file.name||'').toLowerCase();const ext=name.slice(name.lastIndexOf('.'));// Reject by extension before reading the bytes: an unsupported drop
// should not pull a large file into memory first.
if(ext!=='.hdr'&&ext!=='.exr'){throw new Error('Unsupported environment file "'+(file&&file.name)+'", expected .hdr or .exr.');}return loadEnvironmentFromBuffer(await file.arrayBuffer(),ext,file&&file.name||'',true);};// Set/clear the session-wide environment override. null clears it
// (Reset), new views fall back to getEnvironment(). Also broadcasts to
// every live view (LIVE_VIEWS) so hidden keep-alive views update too.
const setEnvOverride=env=>{envOverride=env||null;if(envOverride){envOverrideSerial++;// Import: apply the new environment to every live view right away.
LIVE_VIEWS.forEach(v=>{try{v.setEnvironment(envOverride);}catch(e){/* view has no lighting/env, no-op */}});}else{// Reset: fall back to the default environment, but re-check
// envOverride once it resolves, a newer import that landed while
// this was in flight must win over the stale reset.
getEnvironment().then(def=>{if(!envOverride){LIVE_VIEWS.forEach(v=>{try{v.setEnvironment(def);}catch(e){/* view has no lighting/env, no-op */}});}});}notifyEnvironmentChanged();};const getEnvOverride=()=>envOverride;// Key-light toggle (UI-facing): rebuilds the ACTIVE env from its cached
// pristine bytes with extraction on/off, then rebroadcasts it, reusing
// setEnvOverride for an active import, or the memoized envPromise +
// LIVE_VIEWS broadcast for the default env.
const getKeyLightEnabled=()=>keyLightEnabled;// Where the active environment came from, so a worker can rebuild it: the
// default's URL or the override's bytes, plus the page's prefiltered chains.
const getEnvironmentSource=()=>{const env=envOverride||defaultEnvBuilt;let source;if(envOverride){const o=overrideEnvSource||{};source={id:'override:'+envOverrideSerial,buf:o.buf,ext:o.ext};}else{source={id:'default',url:ENV_MAP_URL,ext:ENV_MAP_URL.slice(ENV_MAP_URL.lastIndexOf('.')).toLowerCase()};}if(env&&(env.radiancePrefiltered||env.irradianceConvolvedData)){source.prefiltered={mipmaps:env.radiancePrefiltered?env.radiancePrefiltered.mipmaps:null,irradiance:env.irradianceConvolvedData||null};}return source;};const notifyEnvironmentChanged=()=>{try{window.dispatchEvent(new CustomEvent('mtlx-environment-changed',{detail:getEnvironmentSource()}));}catch(e){/* no window */}};const setKeyLightEnabled=on=>{keyLightEnabled=!!on;try{window.MtlxRenderSettings.set('keyLight',keyLightEnabled,{surface:'viewer'});}catch(e){/* unavailable */}const src=envOverride?overrideEnvSource:defaultEnvSource;if(!src){notifyEnvironmentChanged();return;}// nothing loaded yet; the next load already honors the flag
const raw=parseEnvBuffer(src.buf,src.ext);if(!raw||!raw.image||!raw.image.data){notifyEnvironmentChanged();return;}const rebuilt=buildEnvFromParsedTexture(raw,keyLightEnabled,src);if(envOverride){setEnvOverride(rebuilt);// re-broadcasts via each view's setEnvironment()
}else{envPromise=Promise.resolve(rebuilt);defaultEnvBuilt=rebuilt;LIVE_VIEWS.forEach(v=>{try{v.setEnvironment(rebuilt);}catch(e){/* view has no lighting/env, no-op */}});notifyEnvironmentChanged();}};// Standard MaterialX color spaces accepted on filename inputs. Changing
// one is a CODEGEN decision (the CMS inserts the shader transform), so
// the picker goes through the regen override path, not a uniform.
const COLORSPACES=['srgb_texture','lin_rec709','g22_rec709','g18_rec709','acescg','lin_ap1','srgb_displayp3','lin_displayp3','adobergb','lin_adobergb','none'];// One persistent hidden WebGL2 context, created lazily and never
// disposed, used ONLY to pre-warm driver shader compiles, a compile
// here makes the display context's later compile a fast driver cache hit.
let MTLX_WARM_CTX=null;const getWarmContext=()=>{if(MTLX_WARM_CTX!==null)return MTLX_WARM_CTX;try{const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const gl=canvas.getContext('webgl2');const ext=gl&&gl.getExtension('KHR_parallel_shader_compile');MTLX_WARM_CTX=gl&&ext?{gl,ext}:false;// A lost warm context stays unusable forever unless we notice: drop
// the cache and the warmed-sources record so the next prewarm call
// recreates a fresh hidden context instead of silently no-op'ing.
if(gl){canvas.addEventListener('webglcontextlost',()=>{MTLX_WARM_CTX=null;warmer.clearWarmed();});}}catch(e){MTLX_WARM_CTX=false;}return MTLX_WARM_CTX;};const warmer=createShaderPrewarmer({getContext:()=>getWarmContext(),perfLog:()=>!!window.MTLX_PERF_LOG});const prewarmShaderCompile=warmer.prewarm;// Submits a generated standalone displacement program to the warm context
// WITHOUT awaiting it, so its compile overlaps the surface compile instead
// of blocking the first evaluateDisplacement. Kill switch
// mtlx_displacement_prewarm=0. Returns the promise (or null).
const DISPLACEMENT_PREWARM_KEY='mtlx_displacement_prewarm';const readDisplacementPrewarm=()=>{try{return localStorage.getItem(DISPLACEMENT_PREWARM_KEY)!=='0';}catch(e){return true;}};const prewarmDisplacementSources=(srcs,isMounted,label)=>{const disp=srcs&&srcs.displacement;if(!disp||!disp.vs||!disp.fs||!readDisplacementPrewarm())return null;const promise=prewarmShaderCompile({vs:disp.vs,fs:disp.fs,isMounted,label:label+' (displacement)'});disp.prewarmPromise=promise;return promise;};// Background driver pre-warm for an off-screen preview target, builds,
// generates, and pre-compiles inside ONE mxExclusive hold (so a transient
// __pv_* wrapper is never observable by a concurrent op). NEVER call from
// inside an existing mxExclusive (deadlock).
const prewarmPreviewTarget=async({mx,gen,genContext,buildRenderable,label,isMounted=()=>true,surface=null})=>{// No warm context (no WebGL2 / no KHR_parallel_shader_compile) means
// generating sources here would only be thrown away, skip the work.
if(!getWarmContext())return'skipped';let srcs=null;try{srcs=await mxExclusive(()=>{const built=buildRenderable();if(!built||!built.renderable)return null;try{return generatePreviewSourcesUnlocked({mx,gen,genContext,renderable:built.renderable,label,isMounted,stageLightCount:PREVIEW_STAGE_LIGHT_COUNT,sceneFeatureOptions:previewFeatureOptions(surface),transmission:getPreviewTransmission(surface)});}finally{// Best-effort, ALWAYS: the transient __pv_* wrappers must
// never survive past this hold (same single-hold rule),
// including when generation itself threw.
try{built.cleanup();}catch(e){/* best-effort */}}});}catch(e){// Silent by design (see the doc comment above): a generation
// failure for an idle-warm target must never bubble up.
return'failed';}if(!srcs||!isMounted())return'bailed';return prewarmShaderCompile({vs:srcs.vs,fs:srcs.fs,isMounted,label});};// ------------------------------------------------------------------
// checkTargetTransparency: fast-uniform-edit transparency re-check,
// same single-hold rule as prewarmPreviewTarget (build->read->
// cleanup in one mxExclusive hold; never call from inside one).
// ------------------------------------------------------------------
const checkTargetTransparency=async({mx,gen,buildRenderable})=>{try{return await mxExclusive(()=>{const built=buildRenderable();if(!built||!built.renderable)return null;try{if(typeof mx.isTransparentSurface!=='function')return null;return!!mx.isTransparentSurface(built.renderable,gen.getTarget());}catch(e){return null;}finally{try{built.cleanup&&built.cleanup();}catch(e){/* best-effort */}}});}catch(e){return null;}};// Scene-view material compiler. This deliberately exposes the preview shader
// generation slice without allocating a renderer, scene, or canvas. Scene
// renderers can compile a unique source once, then create independent uniform
// instances for each object that uses that source.
const DEFAULT_UNIFORM_VECTOR_BUDGET=1024;const compileMtlxSceneMaterial=async({mx,gen,genContext,renderable,label='material',materialName=null,isMounted=()=>true,document:documentArg=null,sceneRgbt=false,lightTransport=false,samplerBudget=null,uniformVectorBudget=null,materialWorkspace='rec709',specularAA=true,stageLightCount=null,featureOptions=null})=>{if(!renderable)throw new Error('MaterialX scene material is missing its renderable surface.');// Test-only override wins over the caller's live GL limit, so a headless
// spec can force a tight budget without a real ANGLE context.
const overrideBudget=typeof window!=='undefined'?window.__mtlxSamplerBudgetOverride:undefined;const budget=Number.isFinite(overrideBudget)?overrideBudget:Number.isFinite(samplerBudget)?samplerBudget:DEFAULT_SAMPLER_BUDGET;const uniformLimit=Number.isFinite(uniformVectorBudget)?uniformVectorBudget:DEFAULT_UNIFORM_VECTOR_BUDGET;const dropped=[];let srcs=null;let samplerInfo=null;let neededInfo=null;// the full-feature count, what the notice reports
let budgetAttempts=0;for(let attempt=0;;attempt++){budgetAttempts=attempt+1;// The scene's live feature set is the base; budget drops add to it.
const sceneFeatureOptions=Object.assign({materialWorkspace,specularAA},featureOptions||null);for(const d of dropped)sceneFeatureOptions[d.key]=true;srcs=await generatePreviewSources({mx,gen,genContext,renderable,label,materialName,isMounted,document:documentArg,sceneRgbt,lightTransport,sceneFeatureOptions,stageLightCount});if(!srcs)return null;samplerInfo=countFragmentSamplers(srcs.fs);if(!neededInfo)neededInfo=samplerInfo;if(samplerInfo.count<=budget)break;if(attempt>=SCENE_SAMPLER_DROPS.length)break;// hooks exhausted, still over
dropped.push(SCENE_SAMPLER_DROPS[attempt]);}const declared=parseUniforms(srcs.vs).concat(parseUniforms(srcs.fs));const overBudget=samplerInfo.count>budget;const uniformInfo=estimateFragmentUniformVectors(srcs.fs);return{...srcs,declared,// Program identity excludes uniforms and object transforms. Source
// text is already fully adapted by generatePreviewSources.
programKey:srcs.vs+'\\n/* scene-fs */\\n'+srcs.fs+'\\n/* displacement */\\n'+(srcs.displacement?srcs.displacement.key:'')+'\\n/* material-workspace */\\n'+materialWorkspace,sceneRgbt,lightTransport:lightTransport===true||lightTransport===4||lightTransport==='transfer'?4:0,lightTransportSupported:!!srcs.lightTransportSupported,payloadSupported:!!srcs.payloadSupported,label,samplerCount:samplerInfo.count,samplerNames:samplerInfo.names,samplerBudget:{limit:budget,count:samplerInfo.count,material:samplerInfo.material,scene:samplerInfo.scene,needed:(neededInfo||samplerInfo).count,dropped:dropped.map(d=>d.label),droppedLabels:dropped.map(d=>d.userLabel),// Ready-made sentence for the scene's warnings list, so the
// count and its material/scene split stay together.
notice:dropped.length?samplerBudgetNotice({needed:neededInfo||samplerInfo,limit:budget,effects:joinWithAnd(dropped.map(d=>d.userLabel)),plural:dropped.length>1}):null},samplerOverBudget:overBudget,budgetAttempts,fragmentUniformVectors:{estimate:uniformInfo.estimate,limit:uniformLimit,largest:uniformInfo.largest},fragmentUniformOverBudget:uniformInfo.estimate>uniformLimit};};// Uniform map for a transfer light-transport variant: texture uniforms are
// shared by reference with the display map so later texture loads reach
// both; record and transform uniforms are seeded fresh.
const createLightTransportUniforms=({compiled,displayUniforms})=>{if(!compiled)throw new Error('Cannot create light transport uniforms without compiled MaterialX source.');const names=new Set();const declRe=/uniform\s+(?:(?:low|medium|high)p\s+)?\w+\s+(\w+)\s*(?:\[\s*\w+\s*\])?\s*;/g;let m;while((m=declRe.exec(compiled.fs||''))!==null)names.add(m[1]);const uniforms={};if(displayUniforms){for(const name of names){if(Object.prototype.hasOwnProperty.call(displayUniforms,name))uniforms[name]=displayUniforms[name];}}uniforms.u_recordEntryDepth={value:getDummyTexWhite()};uniforms.u_recordExitDepth={value:getDummyTexWhite()};uniforms.u_recordCellOrigin={value:new THREE.Vector2()};uniforms.u_recordPass={value:1};uniforms.u_recordDepthPlane={value:new THREE.Vector4(0,0,0,0)};uniforms.u_recordTexel={value:new THREE.Vector2()};uniforms.u_recordDepthSpan={value:1};uniforms.u_recordUnitScale={value:1};// Unused by the transfer variant itself. shadowRenderFaceTransmittance
// owns each active object's onBeforeRender and re-binds the target
// itself (three applies viewport/scissor only in setRenderTarget).
if(uniforms.u_shadowTransmittance)uniforms.u_shadowTransmittance={value:getDummyTexWhite()};if(uniforms.u_shadowRecordCells){uniforms.u_shadowRecordCells={value:Array.from({length:SHADOW_FACE_SLOTS},()=>new THREE.Vector4(0,0,0,0))};}uniforms.u_worldMatrix={value:new THREE.Matrix4()};uniforms.u_viewProjectionMatrix={value:new THREE.Matrix4()};uniforms.u_worldInverseTransposeMatrix={value:new THREE.Matrix4()};uniforms.u_viewPosition={value:new THREE.Vector3()};return uniforms;};// ------------------------------------------------------------------
// Shader EXPORT (vs. PREVIEW above): generates canonical, non-browser-
// adapted shader source in MaterialX's other target languages. Each
// target gets its own generator + GenContext, no light rig, no ACES/
// sRGB encode, and it intentionally differs from the preview shader.
// ------------------------------------------------------------------
// One row per selectable export target. `className` names the embind
// ShaderGenerator class (only Essl's .create() was exercised before
// this, so access below is guarded). `isHw` picks the hardware path.
const EXPORT_TARGETS=[{key:'essl',label:'GLSL ES (WebGL 2)',className:'EsslShaderGenerator',isHw:true,ext:{vertex:'.vert',pixel:'.frag'}},{key:'glsl',label:'GLSL (desktop OpenGL)',className:'GlslShaderGenerator',isHw:true,ext:{vertex:'.vert',pixel:'.frag'}},{key:'vkglsl',label:'GLSL (Vulkan)',className:'VkShaderGenerator',isHw:true,ext:{vertex:'.vert',pixel:'.frag'}},{key:'wgsl',label:'WGSL (WebGPU)',className:'WgslShaderGenerator',isHw:true,ext:{vertex:'.vert.wgsl',pixel:'.frag.wgsl'}},{key:'msl',label:'MSL (Metal)',className:'MslShaderGenerator',isHw:true,ext:{vertex:'.vert.metal',pixel:'.frag.metal'}},{key:'slang',label:'Slang',className:'SlangShaderGenerator',isHw:true,ext:{vertex:'.vert.slang',pixel:'.frag.slang'}},{key:'osl',label:'OSL (Open Shading Language)',className:'OslShaderGenerator',isHw:false,ext:{pixel:'.osl'}},{key:'mdl',label:'MDL (NVIDIA)',className:'MdlShaderGenerator',isHw:false,ext:{pixel:'.mdl'}},{key:'slx',label:'ShadingLanguageX',ext:{original:'.mxsl',decompiled:'.decompiled.mxsl'}}];// Per-target { gen, ctx } cache, building a GenContext + loading
// stdlib isn't free, so each target pays once, lazily. Failed targets
// are deliberately left OUT of the cache so a missing target can retry.
const EXPORT_GEN_CACHE=new Map();// Resolves (lazily create + cache) the { gen, ctx } pair for one export
// target. Deliberately binds no light rig and starts from MaterialX's
// own defaults, not the preview genContext, exported code is canonical.
const getExportGen=(mx,target)=>{const cached=EXPORT_GEN_CACHE.get(target.key);if(cached)return cached;const Cls=mx[target.className];if(!Cls||typeof Cls.create!=='function'){throw new Error(target.label+' is not available in this MaterialX build ('+target.className+').');}const gen=Cls.create();const ctx=new mx.GenContext(gen);// Match the render context's file-texture V flip (see getMxEnv) so
// exported shader source samples images the same way up.
try{ctx.getOptions().fileTextureVerticalFlip=true;}catch(e){/* option absent */}// loadStandardLibraries here only registers the source-code search
// path on `ctx`, its returned stdlib document is discarded, since
// callers' documents already carry the shared stdlib.
mx.loadStandardLibraries(ctx);// Cache ONLY once every step above has succeeded, a target that
// throws (missing class, libraries fail to load) stays retryable on
// the next call instead of being permanently marked unavailable.
const entry={gen,ctx};EXPORT_GEN_CACHE.set(target.key,entry);return entry;};// Unlocked worker for shader EXPORT, see generateTargetSources for the
// public entry point; never call directly outside an mxExclusive hold.
// Skips preview transforms (stripVersion/encodeDisplay), output is canonical.
const generateTargetSourcesUnlocked=({mx,renderable,label,targetKey})=>{const target=EXPORT_TARGETS.find(t=>t.key===targetKey);if(!target)throw new Error('Unknown export target: '+targetKey);let gen,ctx;try{({gen,ctx}=getExportGen(mx,target));}catch(e){throw new Error('Could not initialize the '+target.label+' generator: '+mxErr(mx,e));}try{if(mx.ShaderInterfaceType){ctx.getOptions().shaderInterfaceType=mx.ShaderInterfaceType.SHADER_INTERFACE_COMPLETE;}}catch(e){/* default interface */}if(target.isHw){try{if(typeof mx.isTransparentSurface==='function'){ctx.getOptions().hwTransparency=mx.isTransparentSurface(renderable,gen.getTarget());}}catch(e){/* keep previous value */}}let mxShader;try{mxShader=gen.generate('Shader',renderable,ctx);}catch(genErr){throw new Error('Shader generation ('+target.label+') failed for "'+label+'": '+mxErr(mx,genErr));}// No stage-enumeration API exists; same fallback as the preview
// path: some JS builds don't expose mx.Stage, but getSourceCode
// accepts the "vertex"/"pixel" string constants directly.
const VERTEX_STAGE=mx.Stage&&mx.Stage.VERTEX||'vertex';const PIXEL_STAGE=mx.Stage&&mx.Stage.PIXEL||'pixel';const read=st=>{let code=null;try{code=mxShader.getSourceCode(st);}catch(e){return null;}return code&&code.trim()?code:null;};const stages=[];const vertexCode=read(VERTEX_STAGE);if(vertexCode)stages.push({id:'vertex',label:'Vertex',code:vertexCode});const pixelCode=read(PIXEL_STAGE);if(pixelCode)stages.push({id:'pixel',label:target.isHw?'Pixel':'Shader',code:pixelCode});// Last reference to mxShader, free it here, before the length check,
// so the error path below frees it too. Guarded: see the identical
// delete in generatePreviewSourcesUnlocked above.
try{mxShader.delete();}catch(e){/* already deleted */}if(!stages.length){throw new Error(target.label+' generation produced no source code for "'+label+'".');}return{stages};};// Public entry point for shader EXPORT: serializes
// generateTargetSourcesUnlocked against the shared wasm heap. NEVER
// call this from inside an existing mxExclusive callback (deadlock).
const generateTargetSources=args=>mxExclusive(()=>generateTargetSourcesUnlocked(args));// evaluateDisplacement: draws one THREE.Points per vertex into an RGBA8
// readback grid, one pass per x/y/z component, and decodes the little-endian
// bit pack generateDisplacementSourcesUnlocked spliced into the pixel stage.
// True only for a REAL authored file reference (u.data is a path string),
// not just any 'filename'-typed uniform (library samplers like
// u_shadowMap use that type too, with no data).
const hasDisplacementFileRef=displacement=>!!displacement&&(displacement.introspected||[]).some(u=>u.type==='filename'&&typeof u.data==='string'&&u.data);const evaluateDisplacement=async({renderer,displacement,geometry,worldMatrix,fileMap,textureCache,textureQueue,maxTextureSize,textureSession,isAlive,time=0})=>{if(!renderer||!displacement||!geometry)return null;const notices=[];const mode=displacement.mode||'auto';if(typeof window!=='undefined'&&window.__mtlxForceDisplacementFailure===true){notices.push('Displacement evaluation forced to fail (test hook)');return{offsets:null,mode,notices};}const alive=()=>typeof isAlive!=='function'||isAlive();let evalGeometry=null,material=null,target=null;try{let baseGeometry=geometry;if(!baseGeometry.getAttribute('i_position'))baseGeometry=prepGeometry(baseGeometry);const position=baseGeometry.getAttribute('position');if(!position){notices.push('Displacement evaluation failed: geometry has no position attribute');return{offsets:null,mode,notices};}const N=position.count;const gl=renderer.getContext();const W=Math.min(4096,gl.getParameter(gl.MAX_TEXTURE_SIZE),gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));const H=Math.ceil(N/W);if(H>W){notices.push('Displacement evaluation failed: '+N+' vertices exceed the readback grid limit');return{offsets:null,mode,notices};}const texel=new Float32Array(N*2);for(let i=0;i<N;i++){texel[i*2]=(i%W+0.5)/W*2-1;texel[i*2+1]=(Math.floor(i/W)+0.5)/H*2-1;}evalGeometry=new THREE.BufferGeometry();for(const name of Object.keys(baseGeometry.attributes)){evalGeometry.setAttribute(name,baseGeometry.attributes[name]);}evalGeometry.setAttribute('i_dispTexel',new THREE.BufferAttribute(texel,2));const uniforms={};applyIntrospectedUniformDefaults(uniforms,displacement.introspected||[]);const declared=parseUniforms(displacement.vs).concat(parseUniforms(displacement.fs));const has=n=>declared.some(d=>d.name===n);const wm=worldMatrix||new THREE.Matrix4();if(has('u_worldMatrix'))uniforms.u_worldMatrix={value:wm};const normalMatName=has('u_worldInverseTransposeMatrix')?'u_worldInverseTransposeMatrix':(declared.find(d=>/normal.*matrix|matrix.*normal|inversetranspose/i.test(d.name))||{}).name;if(normalMatName)uniforms[normalMatName]={value:new THREE.Matrix3().getNormalMatrix(wm)};if(has('u_viewProjectionMatrix'))uniforms.u_viewProjectionMatrix={value:new THREE.Matrix4()};if(has('u_time'))uniforms.u_time={value:time};if(has('u_frame'))uniforms.u_frame={value:0};uniforms.u_dispComponent={value:0};if(fileMap&&(displacement.introspected||[]).some(u=>u.type==='filename')){const bindResult=bindDroppedTextures({uniforms,introspected:displacement.introspected,textureCache:textureCache||TEXTURE_CACHE,textureQueue,maxTextureSize,textureSession,isAlive,notices},fileMap);if(bindResult.missing.length){notices.push('Displacement: texture not found for '+bindResult.missing.join(', ')+', using the node default');}if(bindResult.pending.length)await Promise.all(bindResult.pending);}if(!alive())return null;material=new THREE.RawShaderMaterial({vertexShader:displacement.vs,fragmentShader:displacement.fs,glslVersion:THREE.GLSL3,uniforms,depthTest:false,depthWrite:false});const points=new THREE.Points(evalGeometry,material);points.frustumCulled=false;const scene=new THREE.Scene();scene.add(points);const camera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);// The analytic-normal frame differences two displacement evaluations
// eps apart (eps ~0.15mm at level 1, giving deltas ~3e-5 at a 0.2
// slope on egg_normals). The bit-pack readback below reconstructs a
// full float32 from an RGBA8 target's bytes, but those bytes still
// pass through the GPU's UNORM8 write path (clamp+round, and on some
// drivers dithering) before they can be read back; any of that
// rounding noise reads as terracing once amplified by the eps
// division. An RGBA32F target skips the UNORM8 round trip entirely,
// so the analytic path requires it and fails soft to the mesh
// recompute when the extension isn't available.
let wantAnalytic=getDisplacementNormalsMode()!=='mesh'&&mode!=='vector3';const floatReadbackAvailable=!!(gl.getExtension&&(gl.getExtension('EXT_color_buffer_float')||gl.getExtension('WEBGL_color_buffer_float')));if(wantAnalytic&&!floatReadbackAvailable){wantAnalytic=false;notices.push('Analytic displacement normals unavailable: no float render-target readback on this GPU, using the mesh recompute');}const readbackFormat=wantAnalytic?'rgba32f':'rgba8';target=new THREE.WebGLRenderTarget(W,H,{type:readbackFormat==='rgba32f'?THREE.FloatType:THREE.UnsignedByteType,format:THREE.RGBAFormat,depthBuffer:false,magFilter:THREE.NearestFilter,minFilter:THREE.NearestFilter});// Save/restore pattern shared with ensurePrefilteredEnv.
const previousTarget=renderer.getRenderTarget();const previousClearColor=renderer.getClearColor(new THREE.Color());const previousClearAlpha=renderer.getClearAlpha();const previousAutoClear=renderer.autoClear;const previousViewport=renderer.getViewport(new THREE.Vector4());const restore=()=>{renderer.setRenderTarget(previousTarget);renderer.setClearColor(previousClearColor,previousClearAlpha);renderer.autoClear=previousAutoClear;renderer.setViewport(previousViewport);};// Restore on every exit: a throw from compile, render or readback must
// never leave the live view bound to this disposed target.
const perf=window.MTLX_PERF_LOG?{compileMs:0,readbackMs:0}:null;const __compileStart=perf?performance.now():0;try{compileFilteringDriverNoise(renderer,scene,camera);if(perf)perf.compileMs=performance.now()-__compileStart;// Attribute to THIS material's own program, not the first broken
// program anywhere in the shared renderer (an unrelated material
// would otherwise blame every displacement evaluation). Mirrors
// MtlxRender.findUnrunnableMaterials (render-session.js). Falls back to the
// old scan if r128 hasn't recorded a currentProgram yet.
const props=renderer.properties.get(material);const ownProgram=props&&props.currentProgram;const badProg=ownProgram?ownProgram.diagnostics&&ownProgram.diagnostics.runnable===false?ownProgram:null:(renderer.info.programs||[]).find(p=>p.diagnostics&&p.diagnostics.runnable===false);if(badProg){const d=badProg.diagnostics;const log=(d.programLog||'')+(d.vertexShader&&d.vertexShader.log?' VERT: '+d.vertexShader.log:'')+(d.fragmentShader&&d.fragmentShader.log?' FRAG: '+d.fragmentShader.log:'');notices.push('Displacement evaluation failed: '+(log.split('\n')[0]||'program not runnable').slice(0,200));return{offsets:null,mode,notices};}// rgba32f: readRenderTargetPixels wants a Float32Array and hands
// back the exact bytes the shader wrote (0..1, no UNORM8 clamp);
// rgba8: the older Uint8Array path, byte-for-byte as GL wrote it.
const pixels=readbackFormat==='rgba32f'?new Float32Array(W*H*4):new Uint8Array(W*H*4);const byteView=new DataView(new ArrayBuffer(4));renderer.autoClear=false;renderer.setViewport(0,0,W,H);// One pass = 3 draws (x/y/z components) against whatever
// i_position is currently bound on evalGeometry; the analytic-
// normal frame below rebinds i_position twice more to sample
// the same network at two tangent-offset positions.
const runPass=()=>{const passOffsets=new Float32Array(N*3);for(let c=0;c<3;c++){uniforms.u_dispComponent.value=c;renderer.setRenderTarget(target);renderer.setClearColor(0x000000,0);renderer.clear(true,true,true);renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,W,H,pixels);for(let i=0;i<N;i++){const p=i*4;if(readbackFormat==='rgba32f'){byteView.setUint8(0,Math.round(pixels[p]*255)&0xFF);byteView.setUint8(1,Math.round(pixels[p+1]*255)&0xFF);byteView.setUint8(2,Math.round(pixels[p+2]*255)&0xFF);byteView.setUint8(3,Math.round(pixels[p+3]*255)&0xFF);}else{byteView.setUint8(0,pixels[p]);byteView.setUint8(1,pixels[p+1]);byteView.setUint8(2,pixels[p+2]);byteView.setUint8(3,pixels[p+3]);}passOffsets[i*3+c]=byteView.getFloat32(0,true);}}return passOffsets;};const offsets=runPass();let offsetsTangent=null,offsetsBitangent=null,analyticFrame=null;if(wantAnalytic){try{const posAttr2=evalGeometry.getAttribute('i_position')||evalGeometry.getAttribute('position');const normAttr2=evalGeometry.getAttribute('i_normal')||evalGeometry.getAttribute('normal');const tanAttr2=evalGeometry.getAttribute('i_tangent');const bitanAttr2=evalGeometry.getAttribute('i_bitangent');const idx2=baseGeometry.getIndex();if(posAttr2&&normAttr2&&posAttr2.count===N){analyticFrame=MtlxMeshDisplacement.computeAnalyticNormalFrame({positions:posAttr2.array,normals:normAttr2.array,tangents:tanAttr2?tanAttr2.array:null,bitangents:bitanAttr2?bitanAttr2.array:null,indices:idx2?idx2.array:null});const basePos=posAttr2.array;const posName=evalGeometry.getAttribute('i_position')?'i_position':'position';const buildOffsetPositions=dir=>{const out=new Float32Array(N*3);for(let i=0;i<N;i++){const e=analyticFrame.eps[i];out[i*3]=basePos[i*3]+dir[i*3]*e;out[i*3+1]=basePos[i*3+1]+dir[i*3+1]*e;out[i*3+2]=basePos[i*3+2]+dir[i*3+2]*e;}return out;};evalGeometry.setAttribute(posName,new THREE.BufferAttribute(buildOffsetPositions(analyticFrame.tangent),3));offsetsTangent=runPass();evalGeometry.setAttribute(posName,new THREE.BufferAttribute(buildOffsetPositions(analyticFrame.bitangent),3));offsetsBitangent=runPass();evalGeometry.setAttribute(posName,new THREE.BufferAttribute(basePos,3));}}catch(e){offsetsTangent=null;offsetsBitangent=null;analyticFrame=null;notices.push('Analytic displacement normals unavailable, using the mesh recompute: '+(e&&e.message?e.message:String(e)));}}if(perf)perf.readbackMs=performance.now()-__compileStart-perf.compileMs;return{offsets,offsetsTangent,offsetsBitangent,analyticFrame,mode,notices,readbackFormat,perf};}finally{restore();}}catch(error){notices.push('Displacement evaluation failed: '+(error&&error.message?error.message:String(error)));return{offsets:null,mode,notices};}finally{if(target)target.dispose();if(material)material.dispose();if(evalGeometry)evalGeometry.dispose();}};// ------------------------------------------------------------------
// createTriangleBudget / prepareDisplacementBase / buildDisplacedGeometry /
// createDisplacementRunner: displacement pipeline pieces shared out of the
// preview's createMtlxRenderView (P4d stage 1). Stateless helpers first,
// the stateful runner last; a future per-tile evaluate (UDIM, P4d stage 2)
// and the Scene (P6) reuse these instead of their own copies.
// ------------------------------------------------------------------
// Highest level <= requestedLevel keeping baseTriangles*4^level inside a
// per-mesh cap AND a running whole-scene total (mirrors the Scene's
// resolveDisplacementLevel, js/usd-scene-renderer.js ~4006-4022); the
// preview passes total: Infinity, so only perMesh applies. reset() clears
// the running total between rebuilds (a fresh preview or a fresh stage).
const createTriangleBudget=({perMesh=PREVIEW_TRIANGLE_BUDGET,total=Infinity,enabled=true}={})=>{let used=0;const pick=(baseTriangles,requestedLevel)=>{if(!enabled)return pickSubdivisionLevel(baseTriangles,requestedLevel,Infinity);const budget=Math.min(perMesh,total-used);const result=pickSubdivisionLevel(baseTriangles,requestedLevel,budget);if(result.allowed)used+=result.triangles;return result;};const reset=()=>{used=0;};return{pick,reset,perMesh};};// Loop-subdivides `source` (a BufferGeometry: non-indexed corners then
// welded back into an indexed one; other attributes are dropped, reported
// in `dropped`) or a plain { positions, normals, uvs, geomprops } arrays
// object (per-tile UDIM use), at `level`. Returns { geometry, dropped } /
// { arrays, dropped }, or null when there is no position data.
const prepareDisplacementBase=(source,level,{creaseByNormals=true}={})=>{const isGeom=!!(source&&typeof source.getAttribute==='function');let meshIn,sourceAttrNames;if(isGeom){const nonIndexed=source.index?source.toNonIndexed():source;const posAttr=nonIndexed.getAttribute('position');const normAttr=nonIndexed.getAttribute('normal');const uvAttr=nonIndexed.getAttribute('uv');const toArr=attr=>attr?attr.array instanceof Float32Array?attr.array:Float32Array.from(attr.array):null;const geomprops=Object.keys(nonIndexed.attributes).filter(name=>name.startsWith('i_geomprop_')).map(name=>({name:name.slice('i_geomprop_'.length),itemSize:nonIndexed.getAttribute(name).itemSize,data:toArr(nonIndexed.getAttribute(name))}));meshIn={positions:toArr(posAttr),normals:toArr(normAttr),uvs:toArr(uvAttr),geomprops};if(nonIndexed!==source)nonIndexed.dispose();sourceAttrNames=Object.keys(source.attributes);}else{meshIn=source;sourceAttrNames=Object.keys(source&&source.attributes||{});}if(!meshIn.positions)return null;const subdivided=MtlxMeshSubdivision.subdivideMesh(meshIn,level,{creaseByNormals});if(!subdivided)return null;const welded=MtlxMeshSubdivision.weldMesh(subdivided);if(!isGeom)return{arrays:welded,dropped:[]};const out=new THREE.BufferGeometry();out.setAttribute('position',new THREE.BufferAttribute(welded.positions,3));out.setAttribute('normal',new THREE.BufferAttribute(welded.normals,3));if(welded.uvs)out.setAttribute('uv',new THREE.BufferAttribute(welded.uvs,2));for(const stream of welded.geomprops||[]){out.setAttribute('i_geomprop_'+stream.name,new THREE.BufferAttribute(stream.data,stream.itemSize));}out.setIndex(new THREE.BufferAttribute(welded.indices,1));prepGeometry(out);// prepGeometry, aliasUvGeomprops and computeTangents rebuild these on
// the subdivided mesh, so only genuinely lost attributes are reported.
const rebuilt=new Set(['position','normal','uv','i_position','i_normal','i_texcoord_0','tangent','i_tangent','i_bitangent',...UV_GEOMPROP_ALIASES,...(welded.geomprops||[]).map(stream=>'i_geomprop_'+stream.name)]);const dropped=sourceAttrNames.filter(n=>!rebuilt.has(n));return{geometry:out,dropped};};// Computes displaced positions/normals from `base` (an undisplaced,
// subdivided geometry) and an evaluateDisplacement() result, cloning them
// into a fresh geometry; null with no position data.
const buildDisplacedGeometry=(base,result)=>{const posAttr=base.getAttribute('position');if(!posAttr)return null;const normAttr=base.getAttribute('normal');const tanAttr=base.getAttribute('i_tangent');const bitanAttr=base.getAttribute('i_bitangent');const idxAttr=base.getIndex();const computed=MtlxMeshDisplacement.computeDisplacedAttributes({positions:posAttr.array,normals:normAttr?normAttr.array:null,tangents:tanAttr?tanAttr.array:null,bitangents:bitanAttr?bitanAttr.array:null,indices:idxAttr?idxAttr.array:null,offsets:result.offsets,mode:result.mode,offsetsTangent:result.offsetsTangent||null,offsetsBitangent:result.offsetsBitangent||null,analyticFrame:result.analyticFrame||null,displacementNormals:getDisplacementNormalsMode()});const out=base.clone();out.setAttribute('position',new THREE.BufferAttribute(computed.positions,3));out.setAttribute('normal',new THREE.BufferAttribute(computed.normals,3));out.deleteAttribute('i_position');out.deleteAttribute('i_normal');out.deleteAttribute('i_tangent');out.deleteAttribute('i_bitangent');out.deleteAttribute('i_texcoord_0');prepGeometry(out);out.computeBoundingBox();out.computeBoundingSphere();return out;};// Stateful displacement pipeline: subdivide-to-budget (build), evaluate the
// displacement program and land a displaced geometry (evaluate), with the
// same token/debounce/settle bookkeeping the preview used inline before.
// cacheKey(level) -> BASE_GEOM_CACHE key string, matching baseGeomCacheKey.
// onGeometry(builtGeometryOrNull) lands the result (null = fall back to the
// caller's original geometry); onStatus(state, notices) mirrors the old
// dispDispatchStatus/syncHandleNotices pair. Name the settle method
// `settled`, not `whenSettled`: that name is a HANDLE_CONTRACT reserved
// word (guard (g) in scripts/check-render-parity.mjs).
const createDisplacementRunner=({renderer,isAlive,budget,textureSession,cacheKey,creaseByNormals=true,firstBuildTimeoutMs=4000,debounceMs=150,onGeometry,onStatus,getWorldMatrix}={})=>{let source=null,sourceKey=null,fileMap=null;let baseGeometry=null,subdivLevel=null,triangles=0,withinBudget=true;let cappedNotice=null,droppedNotice=null,evalNotices=[];let token=0,state='none',runInFlight=false;let settlePromise=null,settleResolve=null;let debounceGen=0;const currentNotices=()=>[cappedNotice,droppedNotice].filter(Boolean).concat(evalNotices);const emitStatus=()=>{if(onStatus)onStatus(state,currentNotices());};const alive=t=>(typeof isAlive!=='function'||isAlive())&&t===token;const cancel=()=>{token++;debounceGen++;runInFlight=false;if(settleResolve){settleResolve();settleResolve=null;settlePromise=null;}};// Direct state writes, bypassing evaluate: the 'off'/'none' teardown
// paths the preview drives from its own settings toggles.
const setState=s=>{state=s;};const reset=()=>{state='none';sourceKey=null;evalNotices=[];};const pushNotice=text=>{if(!evalNotices.includes(text))evalNotices.push(text);};// Ensures baseGeometry reflects `requestedLevel` capped to `budget`,
// rebuilding (or pulling from BASE_GEOM_CACHE) only when the resolved
// level changed.
const build=(originalGeometry,requestedLevel)=>{const posAttr=originalGeometry.getAttribute('position');const idx=originalGeometry.getIndex();const baseTriangleCount=Math.max(1,Math.round((idx?idx.count:posAttr?posAttr.count:3)/3));const overrideBudget=typeof window!=='undefined'?window.__mtlxTriangleBudgetOverride:undefined;const appliedBudget=Number.isFinite(overrideBudget)?overrideBudget:budget.perMesh;const{level,capped,triangles:t,allowed}=Number.isFinite(overrideBudget)?pickSubdivisionLevel(baseTriangleCount,requestedLevel,overrideBudget):budget.pick(baseTriangleCount,requestedLevel);if(subdivLevel===level&&baseGeometry)return{level,capped,triangles:t,allowed};let built=originalGeometry;let dropped=[];if(level>0){const key=cacheKey(level);const cached=baseGeomCacheGet(key);if(cached){built=cached.clone();}else{const result=prepareDisplacementBase(originalGeometry,level,{creaseByNormals});if(result){dropped=result.dropped;baseGeomCacheSet(key,result.geometry);built=result.geometry.clone();}}}if(baseGeometry&&baseGeometry!==originalGeometry){try{baseGeometry.dispose();}catch(e){/* already disposed/invalid */}}baseGeometry=built;subdivLevel=level;triangles=t;withinBudget=allowed;cappedNotice=!allowed?'Displacement skipped: base mesh has '+t+' triangles, above the '+appliedBudget+' triangle budget':capped?'Subdivision capped at level '+level+' ('+t+' triangles) to stay under the budget':null;droppedNotice=dropped.length?'Subdivision dropped extra vertex attributes: '+dropped.join(', '):null;return{level,capped,triangles:t,allowed};};// Lands one evaluateDisplacement() result: a superseded token stops
// without swapping; a null/failed result falls all the way back to
// the caller's original geometry (onGeometry(null)), never a partial one.
const land=(evalToken,result,failState)=>{if(evalToken!==token||typeof isAlive==='function'&&!isAlive())return;runInFlight=false;if(settleResolve){settleResolve();settleResolve=null;settlePromise=null;}evalNotices=result&&result.notices||[];if(!result||!result.offsets){state=failState||'failed';if(onGeometry)onGeometry(null);emitStatus();return;}const built=baseGeometry?buildDisplacedGeometry(baseGeometry,result):null;if(!built){state='failed';if(onGeometry)onGeometry(null);emitStatus();return;}state='applied';if(onGeometry)onGeometry(built);emitStatus();};// Evaluates the current source/baseGeometry and lands the result;
// shared by settings toggles, a material debounce and an arriving file map.
const evaluate=async()=>{if(!source||!baseGeometry)return;const evalToken=++token;if(!withinBudget){land(evalToken,{offsets:null,notices:[cappedNotice]},'skipped');return;}state='pending';runInFlight=true;if(!settlePromise)settlePromise=new Promise(res=>{settleResolve=res;});emitStatus();const posAttr=baseGeometry.getAttribute('position');if(!posAttr||posAttr.count<3){land(evalToken,{offsets:null,notices:['Displacement skipped: geometry has too few vertices']},'skipped');return;}let result=null;try{result=await evaluateDisplacement({renderer,displacement:source,geometry:baseGeometry,worldMatrix:getWorldMatrix?getWorldMatrix():new THREE.Matrix4(),fileMap,textureCache:undefined,textureSession,isAlive:()=>alive(evalToken)});}catch(e){result={offsets:null,notices:['Displacement evaluation failed: '+(e&&e.message?e.message:String(e))]};}land(evalToken,result,'failed');};// First build only: evaluate before the first apply so the first frame
// shows the final geometry; a filename-driven or slow (> firstBuildTimeoutMs)
// program lands later instead, in the background.
const runFirstBuild=async()=>{if(!source||!baseGeometry)return;if(!withinBudget){const t=++token;land(t,{offsets:null,notices:[cappedNotice]},'skipped');return;}if(hasDisplacementFileRef(source))return;// filename-driven, wait for setFileMap
const t=++token;state='pending';runInFlight=true;if(!settlePromise)settlePromise=new Promise(res=>{settleResolve=res;});const evalPromise=evaluateDisplacement({renderer,displacement:source,geometry:baseGeometry,worldMatrix:getWorldMatrix?getWorldMatrix():new THREE.Matrix4(),fileMap,textureCache:undefined,textureSession,isAlive:()=>alive(t)}).catch(e=>({offsets:null,notices:['Displacement evaluation failed: '+(e&&e.message?e.message:String(e))]}));const timedOut=Symbol('mtlx-disp-timeout');const raced=await Promise.race([evalPromise,new Promise(resolve=>setTimeout(()=>resolve(timedOut),firstBuildTimeoutMs))]);if(raced===timedOut){// Keep waiting in the background; the caller's own setup is
// synchronous, so mesh/handle both exist well before this resolves.
evalPromise.then(result=>land(t,result,'failed'));}else{land(t,raced,'failed');}};// Debounced evaluate: used when the displacement PROGRAM changes (a
// material swap), so a rapid regeneration burst does not re-evaluate
// every intermediate value. `prepare` runs just before evaluate, once
// this call is still the latest debounced call, and may return false
// to skip the evaluate (e.g. displacement got disabled meanwhile).
const debouncedEvaluate=prepare=>{const gen=++debounceGen;return new Promise(resolve=>{setTimeout(()=>{if(gen!==debounceGen){resolve();return;}const proceed=prepare?prepare():true;if(proceed===false){resolve();return;}Promise.resolve(evaluate()).then(resolve);},debounceMs);});};return{setSource:newSource=>{source=newSource||null;sourceKey=source?source.key:null;},getSourceKey:()=>sourceKey,setFileMap:map=>{fileMap=map||null;},setState,reset,off:()=>setState('off'),pushNotice,build,getBaseGeometry:()=>baseGeometry,evaluate,runFirstBuild,debouncedEvaluate,cancel,getState:()=>({state,mode:source?source.mode:null,level:subdivLevel||0,capped:!!cappedNotice,triangles,notices:currentNotices()}),settled:()=>runInFlight?settlePromise||Promise.resolve():Promise.resolve(),dispose:()=>{cancel();},// P4d stage 2: per-call evaluate for a caller-supplied geometry
// (a UDIM tile's vertex subset), independent of build()/evaluate()'s
// own token/state bookkeeping. The caller scatters the returned
// offsets back onto the shared base and runs buildDisplacedGeometry
// once on the whole thing (no cracks). Uses this runner's own
// renderer/textureSession/isAlive.
evaluateGeometry:({geometry,displacement,worldMatrix,fileMap,time}={})=>evaluateDisplacement({renderer,displacement,geometry,worldMatrix,fileMap,textureCache:undefined,textureSession,isAlive,time})};};// findUdimRefs: filename-typed introspected uniforms whose authored path
// contains a <UDIM> marker (case-insensitive), mirroring the Scene's
// sceneUdimRefs (js/usd-scene-renderer.js ~1264) but over a plain
// `introspected` array instead of a `{introspected}` wrapper.
const findUdimRefs=introspected=>(introspected||[]).filter(u=>u.type==='filename'&&typeof u.data==='string'&&/<UDIM>/i.test(u.data));// createUdimVariantUniforms: a per-tile uniforms object derived from
// `base`, overriding only the UDIM sampler name(s) in `tileBindings`
// (name -> texture). shareSlots true (Preview): every OTHER slot object is
// the SAME reference as base's, so setUniforms/env setters/peel/tryRefresh/
// sliders that mutate a slot's `.value` in place reach every variant for
// free. shareSlots false (Scene, P6): sceneCloneUniforms behavior instead
// (js/usd-scene-renderer.js ~1287): value objects cloned, textures shared.
const createUdimVariantUniforms=(base,tileBindings,{shareSlots=true}={})=>{const names=Object.keys(tileBindings||{});const out=shareSlots?Object.assign({},base):Object.fromEntries(Object.entries(base||{}).map(([name,slot])=>{const value=slot&&slot.value;let cloned=value;if(value&&!value.isTexture&&typeof value.clone==='function')cloned=value.clone();else if(Array.isArray(value))cloned=value.slice();return[name,Object.assign({},slot,{value:cloned})];}));for(const name of names)out[name]={value:tileBindings[name]};return out;};// ------------------------------------------------------------------
// tryRefreshRenderView, attempts a cheap in-place refresh of an
// existing view instead of a full rebuild: regenerates sources and, if
// byte-identical to the live view's, re-uploads only uniform defaults.
// Returns { refreshed, srcs } (srcs handed back so a real-mismatch
// caller doesn't need to regenerate again) or { refreshed: true }.
// ------------------------------------------------------------------
const tryRefreshRenderView=async({view,mx,gen,genContext,renderable,label,materialName=null,isMounted=()=>true})=>{const __t=window.MTLX_PERF_LOG?performance.now():0;let srcs;try{// Same generation options the live view was built with, else the
// byte compare below can never match.
srcs=await generatePreviewSourcesWithinBudget({mx,gen,genContext,renderable,label,materialName,isMounted,stageLightCount:PREVIEW_STAGE_LIGHT_COUNT,sceneFeatureOptions:previewFeatureOptions(view&&view.renderSurface),transmission:getPreviewTransmission(view&&view.renderSurface),allowConstInputs:view?view.allowConstInputs!==false:true});}catch(e){return{refreshed:false,srcs:null};}if(!srcs)return{refreshed:false,srcs:null};// Belt-and-suspenders: compare the transparency verdict explicitly
// rather than relying on srcs.vs/fs alone. Gated on FORCE_TRANSPARENCY:
// when off, a verdict flip is irrelevant and forcing rebuild is pointless.
if(srcs.vs!==view.vs||srcs.fs!==view.fs||FORCE_TRANSPARENCY&&!!srcs.transparent!==!!view.isTransparent)return{refreshed:false,srcs};// A filename value can change without the GLSL text changing, so
// the vs/fs check above misses it, and empirically, rebinding a
// texture onto a reused view does NOT render; force a full rebuild instead.
const oldFilenames=new Map();for(const u of view.introspected||[]){if(u.type==='filename')oldFilenames.set(u.name,u.data!=null?u.data:null);}const newFilenames=new Map();for(const u of srcs.introspected||[]){if(u.type==='filename')newFilenames.set(u.name,u.data!=null?u.data:null);}const filenameNames=new Set([...oldFilenames.keys(),...newFilenames.keys()]);for(const name of filenameNames){const oldVal=oldFilenames.has(name)?oldFilenames.get(name):null;const newVal=newFilenames.has(name)?newFilenames.get(name):null;if(oldVal!==newVal)return{refreshed:false,srcs,texChange:true};}// Introspection happens inside generatePreviewSourcesUnlocked under
// the same hold; this function performs no wasm reads.
view.introspected=srcs.introspected;applyIntrospectedUniformDefaults(view.uniforms,srcs.introspected,{overwrite:true});// Displacement is not part of the surface source, so an edit to its values
// reaches the view only through this sync.
if(typeof view.syncDisplacementSources==='function')view.syncDisplacementSources(srcs.displacement||null);if(window.MTLX_PERF_LOG){console.log('[mtlx-perf] preview fast-refresh (source unchanged): '+(performance.now()-__t).toFixed(1)+'ms (target: '+label+')');}return{refreshed:true};};// ------------------------------------------------------------------
// createMtlxRenderView, persistent render-pipeline shell for one
// preview surface: renderer/scene/camera/env/geometry built ONCE;
// every edit calls applyMaterial() to swap materials on the SAME shell.
// ------------------------------------------------------------------
// ------------------------------------------------------------------
// Three keeps a target's configured rectangle separate from the active GL
// rectangle. A peel frame temporarily binds several internal targets, so its
// caller destination must include both rectangles and the cube face/mip.
const snapshotRenderDestination=renderer=>{const gl=renderer.getContext();return{target:renderer.getRenderTarget(),viewport:renderer.getViewport(new THREE.Vector4()),actualViewport:renderer.getCurrentViewport?renderer.getCurrentViewport(new THREE.Vector4()):renderer.getViewport(new THREE.Vector4()),scissor:renderer.getScissor(new THREE.Vector4()),actualScissor:new THREE.Vector4().fromArray(gl.getParameter(gl.SCISSOR_BOX)),scissorTest:renderer.getScissorTest(),actualScissorTest:gl.isEnabled(gl.SCISSOR_TEST),face:renderer.getActiveCubeFace?renderer.getActiveCubeFace():0,mip:renderer.getActiveMipmapLevel?renderer.getActiveMipmapLevel():0};};const restoreRenderDestination=(renderer,state)=>{renderer.setViewport(state.viewport);renderer.setScissor(state.scissor);renderer.setScissorTest(state.scissorTest);if(!state.target){renderer.setRenderTarget(null);return;}const target=state.target;const viewport=target.viewport.clone();const scissor=target.scissor.clone();const scissorTest=target.scissorTest;target.viewport.copy(state.actualViewport);target.scissor.copy(state.actualScissor);target.scissorTest=state.actualScissorTest;try{renderer.setRenderTarget(target,state.face,state.mip);}finally{target.viewport.copy(viewport);target.scissor.copy(scissor);target.scissorTest=scissorTest;}};// Scene-only RGB-transmission compositor.  Three r128 has no public
// WebGLMultipleRenderTargets, so C and T are rendered into separate targets
// and accumulated with fullscreen passes.  This factory is deliberately
// separate from the legacy scalar peel pipeline: callers opt in only after
// compiling a shader with the u_peelRgbtPass output contract.  A shader that
// does not expose that uniform is left untouched by this pipeline and should
// use createPeelPipeline instead.
const createRgbtPeelPipeline=(renderer,{getDisplayTransform:getDisplayTransformOpt,getDisplayExposure:getDisplayExposureOpt,layers=PEEL_LAYERS,opaqueOutput=false}={})=>{const getDT=getDisplayTransformOpt||getDisplayTransform;const getExposure=getDisplayExposureOpt||displayExposureScale;const halfOk=!!renderer.extensions.get('EXT_color_buffer_float');let resources=null;// A grouped USD mesh can contain an authored opaque submaterial beside a
// transmissive RGB-T one. The opaque subgroup is captured once in
// opaqueRT and discarded in every C/T/tail geometry pass; it cannot be
// treated as a missing payload for the complete mesh.
let opaqueDiscardMaterial=null;const disposeTarget=rt=>{if(!rt)return;if(rt.depthTexture)rt.depthTexture.dispose();rt.dispose();};const free=()=>{if(!resources)return;[resources.opaque,resources.layerC0,resources.layerC1,resources.layerT,resources.tail,resources.c0,resources.c1,resources.t0,resources.t1,resources.opaqueMips].forEach(disposeTarget);if(resources.quad&&resources.quad.geometry)resources.quad.geometry.dispose();[resources.initMat,resources.updateCMat,resources.updateTMat,resources.tailFoldMat,resources.tailTMat,resources.finalMat,resources.copyOpaqueMat].forEach(m=>{if(m)m.dispose();});if(opaqueDiscardMaterial){opaqueDiscardMaterial.dispose();opaqueDiscardMaterial=null;}resources=null;};const target=(w,h,depth=false)=>{const rt=new THREE.WebGLRenderTarget(w,h,{minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,format:THREE.RGBAFormat,type:THREE.HalfFloatType,depthBuffer:depth,stencilBuffer:false});if(depth){rt.depthTexture=new THREE.DepthTexture(w,h,THREE.UnsignedIntType);rt.depthTexture.minFilter=THREE.NearestFilter;rt.depthTexture.magFilter=THREE.NearestFilter;}return rt;};const alloc=(w,h)=>{free();const opaque=target(w,h,true);// C depth must ping pong with the color target. Reusing one target
// would make the next peel's previous-depth sampler read the same
// texture currently being cleared/rendered.
const layerC0=target(w,h,true);const layerC1=target(w,h,true);const layerT=target(w,h,true);const tail=target(w,h,false);const c0=target(w,h),c1=target(w,h);const t0=target(w,h),t1=target(w,h);// Opaque colour mips for mx_scene_refraction. No half-float-linear
// means nearest-across-levels instead (still real LOD blur, just
// blockier); refractionLod in debug() reports which one.
// WebGL2 has half-float linear filtering in core and never exposes
// the extension, so querying it only logs a three warning.
const halfLinearOk=!!(renderer.capabilities&&renderer.capabilities.isWebGL2)||!!renderer.extensions.get('OES_texture_half_float_linear');const opaqueMips=new THREE.WebGLRenderTarget(w,h,{minFilter:halfLinearOk?THREE.LinearMipmapLinearFilter:THREE.NearestMipmapNearestFilter,magFilter:THREE.LinearFilter,format:THREE.RGBAFormat,type:THREE.HalfFloatType,depthBuffer:false,stencilBuffer:false,generateMipmaps:true});const opaqueColorLevels=Math.floor(Math.log2(Math.max(w,h,1)));const quadScene=new THREE.Scene();const quadCam=new THREE.OrthographicCamera(-1,1,1,-1,0,1);const quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),null);quadScene.add(quad);const quadVertex='in vec3 position;\n'+'in vec2 uv;\n'+'out vec2 vUv;\n'+'void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}\n';const initMat=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:quadVertex,fragmentShader:'precision highp float; in vec2 vUv; out vec4 o; uniform vec4 u_value; void main(){o=u_value;}\n',uniforms:{u_value:{value:new THREE.Vector4(0,0,0,1)}},depthTest:false,depthWrite:false});const updateCMat=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:quadVertex,fragmentShader:'precision highp float; in vec2 vUv; out vec4 o;\n'+'uniform sampler2D u_c; uniform sampler2D u_t; uniform sampler2D u_layer;\n'+'void main(){vec4 c=texture(u_c,vUv),t=texture(u_t,vUv),l=texture(u_layer,vUv);o=vec4(c.rgb+t.rgb*l.rgb,1.0);}\n',uniforms:{u_c:{value:null},u_t:{value:null},u_layer:{value:null}},depthTest:false,depthWrite:false});const updateTMat=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:quadVertex,fragmentShader:'precision highp float; in vec2 vUv; out vec4 o;\n'+'uniform sampler2D u_t; uniform sampler2D u_layer;\n'+'void main(){vec3 t=texture(u_t,vUv).rgb*texture(u_layer,vUv).rgb;o=vec4(t,1.0);}\n',uniforms:{u_t:{value:null},u_layer:{value:null}},depthTest:false,depthWrite:false});// The tail target uses alpha as scalar residual transmission.  Its
// geometry pass supplies C in RGB and 1-mean(T) in alpha; the blend
// factors retain every deeper fragment in front-to-back order.
const tailFoldMat=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:quadVertex,fragmentShader:'precision highp float; in vec2 vUv; out vec4 o;\n'+'uniform sampler2D u_c; uniform sampler2D u_t; uniform sampler2D u_tail;\n'+'void main(){vec4 c=texture(u_c,vUv),t=texture(u_t,vUv),q=texture(u_tail,vUv);o=vec4(c.rgb+t.rgb*q.rgb,t.a);}\n',uniforms:{u_c:{value:null},u_t:{value:null},u_tail:{value:null}},depthTest:false,depthWrite:false});const tailTMat=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:quadVertex,fragmentShader:'precision highp float; in vec2 vUv; out vec4 o;\n'+'uniform sampler2D u_t; uniform sampler2D u_tail;\n'+'void main(){vec3 t=texture(u_t,vUv).rgb*texture(u_tail,vUv).aaa;o=vec4(t,1.0);}\n',uniforms:{u_t:{value:null},u_tail:{value:null}},depthTest:false,depthWrite:false});const finalMat=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:quadVertex,fragmentShader:'precision highp float; in vec2 vUv; out vec4 o;\n'+'uniform sampler2D u_c; uniform sampler2D u_t; uniform sampler2D u_opaque;\n'+'uniform int u_displayTransform; uniform float u_displayExposure; uniform int u_forceOpaque;\n'+'void main(){vec4 c=texture(u_c,vUv),t=texture(u_t,vUv),b=texture(u_opaque,vUv);\n'+'vec3 lin=c.rgb+t.rgb*b.rgb;\n'+DISPLAY_TRANSFORM_SWITCH_GLSL('lin','encoded','u_displayTransform','u_displayExposure')+'float transA=1.0-min(t.r,min(t.g,t.b));\n'+'float a=u_forceOpaque!=0?1.0:b.a+(1.0-b.a)*transA;o=vec4(encoded,a);}\n',uniforms:{u_c:{value:null},u_t:{value:null},u_opaque:{value:null},u_forceOpaque:{value:opaqueOutput?1:0},u_displayTransform:{value:displayTransformId(getDT())},u_displayExposure:{value:getExposure()}},transparent:!opaqueOutput,blending:THREE.NoBlending,depthTest:false,depthWrite:false});// Fullscreen copy of the opaque colour target into its mip chain,
// run once per render() after the opaque pass (see render() below).
const copyOpaqueMat=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:quadVertex,fragmentShader:'precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D u_src; void main(){o=texture(u_src,vUv);}\n',uniforms:{u_src:{value:null}},depthTest:false,depthWrite:false});resources={w,h,opaque,layerC0,layerC1,layerT,tail,c0,c1,t0,t1,opaqueMips,opaqueColorLevels,halfLinearOk,quadScene,quadCam,quad,initMat,updateCMat,updateTMat,tailFoldMat,tailTMat,finalMat,copyOpaqueMat};quad.material=initMat;renderer.compile(quadScene,quadCam);quad.material=updateCMat;renderer.compile(quadScene,quadCam);quad.material=updateTMat;renderer.compile(quadScene,quadCam);quad.material=tailFoldMat;renderer.compile(quadScene,quadCam);quad.material=tailTMat;renderer.compile(quadScene,quadCam);quad.material=finalMat;renderer.compile(quadScene,quadCam);quad.material=copyOpaqueMat;renderer.compile(quadScene,quadCam);};const renderQuad=(material,targetRT,face=0,mip=0)=>{resources.quad.material=material;renderer.setRenderTarget(targetRT,face,mip);renderer.render(resources.quadScene,resources.quadCam);};const render=(scene,camera,transparentMeshes,opts={})=>{const unsupported=reason=>{if(opts.onUnsupported)opts.onUnsupported(reason);// Direct users of this low-level factory get a visible normal
// render. createPeelPipeline's Scene wrapper passes fallback:false
// and routes the same frame through its scalar legacy pipeline.
if(opts.fallback!==false)renderer.render(scene,camera);return false;};if(!halfOk){return unsupported('RGBT requires EXT_color_buffer_float');}const candidates=(transparentMeshes||[]).filter(m=>m&&m.material);const materialList=[];const materialSet=new Set();candidates.forEach(m=>{const mats=Array.isArray(m.material)?m.material:[m.material];mats.forEach(mat=>{if(mat&&!materialSet.has(mat)){materialSet.add(mat);materialList.push(mat);}});});const meshes=candidates.filter(m=>{const mats=Array.isArray(m.material)?m.material:[m.material];return mats.some(mat=>{if(!mat||!mat.uniforms||!mat.uniforms.u_peelMode)return false;// Scene materials carry a source-qualified peel verdict. A
// low-level caller without that metadata retains the legacy
// uniform-presence contract for backwards compatibility.
const data=mat.userData;return data&&Object.prototype.hasOwnProperty.call(data,'mtlxScenePeel')?!!data.mtlxScenePeel:true;});});// Scene materials carry an explicit source-qualified peel verdict;
// low-level callers without metadata retain the uniform contract.
// Opaque submaterials stay in the C pass and are swapped to a discard
// material for T/tail below.
const payloadMaterials=materialList.filter(mat=>{if(!mat||!mat.uniforms||!mat.uniforms.u_peelMode)return false;const data=mat.userData;return data&&Object.prototype.hasOwnProperty.call(data,'mtlxScenePeel')?!!data.mtlxScenePeel:true;});const missingPayload=payloadMaterials.filter(mat=>!mat.uniforms.u_peelRgbtPass||!mat.uniforms.u_peelRgbt);if(missingPayload.length){return unsupported('RGBT shader payload is unavailable; using legacy renderer');}if(!meshes.length){renderer.render(scene,camera);return true;}const boundTarget=renderer.getRenderTarget();const size=boundTarget?new THREE.Vector2(boundTarget.width,boundTarget.height):renderer.getDrawingBufferSize(new THREE.Vector2());if(!resources||resources.w!==size.x||resources.h!==size.y)alloc(size.x,size.y);const destination=snapshotRenderDestination(renderer);const oldAutoClear=renderer.autoClear;const oldClearColor=renderer.getClearColor(new THREE.Color());const oldClearAlpha=renderer.getClearAlpha();const oldShadowUpdate=renderer.shadowMap.autoUpdate;const materialState=new Map();const visibilityState=new Map();const linearUniforms=new Map();const meshMaterials=new Map();const meshMaterialIdentity=new Map();meshes.forEach(mesh=>{meshMaterials.set(mesh,Array.isArray(mesh.material)?mesh.material.slice():[mesh.material]);meshMaterialIdentity.set(mesh,mesh.material);});const ensureOpaqueDiscardMaterial=()=>{if(opaqueDiscardMaterial)return opaqueDiscardMaterial;opaqueDiscardMaterial=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:'in vec3 position; uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',fragmentShader:'precision highp float; out vec4 outColor; void main(){discard;}',depthTest:false,depthWrite:false,colorWrite:false});return opaqueDiscardMaterial;};const setOpaqueSubmaterials=discard=>meshMaterials.forEach((original,mesh)=>{// Opaque submaterials were already captured by opaqueRT.  They
// must be discarded for every C/T/tail geometry pass, including a
// single opaque material on a mesh that shares the candidate list.
const next=discard?original.map(mat=>payloadMaterials.includes(mat)?mat:ensureOpaqueDiscardMaterial()):original;mesh.material=Array.isArray(mesh.material)?next:next[0];});const setPayloadSubmaterials=discard=>meshMaterials.forEach((original,mesh)=>{const next=discard?original.map(mat=>payloadMaterials.includes(mat)?ensureOpaqueDiscardMaterial():mat):original;mesh.material=Array.isArray(mesh.material)?next:next[0];});scene.traverse(object=>{const materials=object&&object.material?Array.isArray(object.material)?object.material:[object.material]:[];materials.forEach(mat=>{const u=mat&&mat.uniforms&&mat.uniforms.u_peelLinear;if(!u||linearUniforms.has(u))return;linearUniforms.set(u,u.value);u.value=1;});});const rememberMaterial=mat=>{if(!mat||materialState.has(mat))return;materialState.set(mat,{blending:mat.blending,blendEquation:mat.blendEquation,blendEquationAlpha:mat.blendEquationAlpha,blendSrc:mat.blendSrc,blendDst:mat.blendDst,blendSrcAlpha:mat.blendSrcAlpha,blendDstAlpha:mat.blendDstAlpha,depthTest:mat.depthTest,depthWrite:mat.depthWrite,uniformValues:mat.uniforms?new Map(Object.keys(mat.uniforms).map(k=>[k,mat.uniforms[k].value])):null});};const rememberVisible=obj=>{if(obj&&!visibilityState.has(obj))visibilityState.set(obj,obj.visible);};const setPass=pass=>payloadMaterials.forEach(mat=>{rememberMaterial(mat);const mu=mat.uniforms;if(!mu)return;if(mu.u_peelRgbt)mu.u_peelRgbt.value=1;if(mu.u_peelRgbtPass)mu.u_peelRgbtPass.value=pass;if(mu.u_peelMode)mu.u_peelMode.value=pass===2?2:1;// Transmission is independent of direct analytic lights. Avoid
// evaluating the full BRDF and shadow lookups during the RGB-T
// T-only pass, while restoring the authored count for C/tail.
if(mu.u_numActiveLightSources){const saved=materialState.get(mat)?.uniformValues?.get('u_numActiveLightSources');mu.u_numActiveLightSources.value=pass===1?0:saved==null?mu.u_numActiveLightSources.value:saved;}});const hideOtherMeshes=()=>scene.traverse(o=>{if(o.isMesh&&!meshes.includes(o)&&o.visible){rememberVisible(o);o.visible=false;}});const showOthers=()=>visibilityState.forEach((v,o)=>{o.visible=v;});renderer.autoClear=false;renderer.shadowMap.autoUpdate=false;try{if(opts.setSceneLinear)opts.setSceneLinear(true);// Opaque pass is stored in linear half float, then transformed once
// by finalMat. Transparent geometry stays hidden here.
meshes.forEach(m=>{rememberVisible(m);});// Candidate meshes can carry opaque material groups. Capture those
// into opaqueRT while suppressing the RGB-T participants.
setPayloadSubmaterials(true);renderer.setRenderTarget(resources.opaque);renderer.setClearColor(oldClearColor,opts.outputLinear?oldClearAlpha:0);renderer.clear(true,true,true);renderer.render(scene,camera);// A raw quad blit is not a path three.js always regenerates
// mips for, so call gl.generateMipmap() explicitly: an
// incomplete mip chain reads as a solid colour, not an error.
resources.copyOpaqueMat.uniforms.u_src.value=resources.opaque.texture;renderQuad(resources.copyOpaqueMat,resources.opaqueMips);{const gl=renderer.getContext();const glTex=renderer.properties.get(resources.opaqueMips.texture).__webglTexture;if(glTex){const prevTex=gl.getParameter(gl.TEXTURE_BINDING_2D);gl.bindTexture(gl.TEXTURE_2D,glTex);gl.generateMipmap(gl.TEXTURE_2D);gl.bindTexture(gl.TEXTURE_2D,prevTex);}}setPayloadSubmaterials(false);hideOtherMeshes();// C starts at zero; T starts at one.  C/T are kept in distinct
// targets so no blend equation can accidentally premultiply C.
renderQuad(resources.initMat,resources.c0);resources.initMat.uniforms.u_value.value.set(1,1,1,1);renderQuad(resources.initMat,resources.t0);resources.initMat.uniforms.u_value.value.set(0,0,0,1);let cOld=resources.c0,cNew=resources.c1;let tOld=resources.t0,tNew=resources.t1;let prevDepth=null;// SSR on a peel layer reflects the CURRENT frame's opaque colour,
// not the previous-frame history the opaque pass uses below.
camera.updateMatrixWorld();camera.matrixWorldInverse.copy(camera.matrixWorld).invert();const currentVp=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);const currentVpInverse=currentVp.clone().invert();const currentEye=camera.getWorldPosition(new THREE.Vector3());for(let i=0;i<Math.max(0,layers|0);i++){const cLayer=i%2===0?resources.layerC0:resources.layerC1;const tLayer=resources.layerT;payloadMaterials.forEach(mat=>{rememberMaterial(mat);const mu=mat.uniforms;if(!mu)return;if(mu.u_peelHasPrev)mu.u_peelHasPrev.value=prevDepth?1:0;if(mu.u_peelPrevDepth)mu.u_peelPrevDepth.value=prevDepth||getDummyTex();if(mu.u_opaqueDepth)mu.u_opaqueDepth.value=resources.opaque.depthTexture;if(mu.u_opaqueColor)mu.u_opaqueColor.value=resources.opaqueMips.texture;if(mu.u_opaqueColorLevels)mu.u_opaqueColorLevels.value=resources.opaqueColorLevels;if(mu.u_peelRgbtLayer)mu.u_peelRgbtLayer.value=i;if(mu.u_historyViewProjectionMatrix)mu.u_historyViewProjectionMatrix.value.copy(currentVp);if(mu.u_historyViewProjectionInverseMatrix)mu.u_historyViewProjectionInverseMatrix.value.copy(currentVpInverse);if(mu.u_historyViewPosition)mu.u_historyViewPosition.value.copy(currentEye);});setPass(0);setOpaqueSubmaterials(true);renderer.setRenderTarget(cLayer);renderer.setClearColor(0,0);renderer.clear(true,true,true);renderer.render(scene,camera);setPass(1);setOpaqueSubmaterials(true);renderer.setRenderTarget(tLayer);// T is a multiplicative field: an empty layer is white.
renderer.setClearColor(0xffffff,1);renderer.clear(true,true,true);renderer.render(scene,camera);resources.updateCMat.uniforms.u_c.value=cOld.texture;resources.updateCMat.uniforms.u_t.value=tOld.texture;resources.updateCMat.uniforms.u_layer.value=cLayer.texture;renderQuad(resources.updateCMat,cNew);resources.updateTMat.uniforms.u_t.value=tOld.texture;resources.updateTMat.uniforms.u_layer.value=tLayer.texture;renderQuad(resources.updateTMat,tNew);[cOld,cNew]=[cNew,cOld];[tOld,tNew]=[tNew,tOld];prevDepth=cLayer.depthTexture;}// All remaining fragments go through the scalar tail.  This is a
// bounded RGB-T approximation for deeper colored layers, but it
// preserves their full geometry and emissive C contribution.
setPass(2);setOpaqueSubmaterials(true);payloadMaterials.forEach(mat=>{rememberMaterial(mat);mat.blending=THREE.CustomBlending;mat.blendEquation=THREE.AddEquation;mat.blendEquationAlpha=THREE.AddEquation;mat.blendSrc=THREE.DstAlphaFactor;mat.blendDst=THREE.OneFactor;mat.blendSrcAlpha=THREE.ZeroFactor;mat.blendDstAlpha=THREE.OneMinusSrcAlphaFactor;mat.depthTest=false;mat.depthWrite=false;});payloadMaterials.forEach(mat=>{const mu=mat.uniforms;if(!mu)return;if(mu.u_peelHasPrev)mu.u_peelHasPrev.value=prevDepth?1:0;if(mu.u_peelPrevDepth)mu.u_peelPrevDepth.value=prevDepth||getDummyTex();if(mu.u_peelRgbtLayer)mu.u_peelRgbtLayer.value=Math.max(0,layers|0);});renderer.setRenderTarget(resources.tail);renderer.setClearColor(0,1);renderer.clear(true,false,false);renderer.render(scene,camera);resources.tailFoldMat.uniforms.u_c.value=cOld.texture;resources.tailFoldMat.uniforms.u_t.value=tOld.texture;resources.tailFoldMat.uniforms.u_tail.value=resources.tail.texture;renderQuad(resources.tailFoldMat,cNew);// tailFold writes only C; preserve T by multiplying it with the
// scalar residual alpha (never the tail RGB) in a second pass.
resources.tailTMat.uniforms.u_t.value=tOld.texture;resources.tailTMat.uniforms.u_tail.value=resources.tail.texture;renderQuad(resources.tailTMat,tNew);cOld=cNew;tOld=tNew;showOthers();resources.finalMat.uniforms.u_c.value=cOld.texture;resources.finalMat.uniforms.u_t.value=tOld.texture;resources.finalMat.uniforms.u_opaque.value=resources.opaque.texture;// An HDR caller owns exposure and display conversion. Mode 2 is
// the existing unclamped scene-linear inspection transform.
resources.finalMat.uniforms.u_displayTransform.value=opts.outputLinear?2:displayTransformId(getDT());resources.finalMat.uniforms.u_displayExposure.value=opts.outputLinear?1:getExposure();resources.finalMat.uniforms.u_forceOpaque.value=opaqueOutput&&!opts.outputLinear?1:0;// Write into whatever target the caller had bound on entry, not
// hardcoded null, so an offscreen frame wrapper (HDR/bloom) still
// receives the real image instead of the canvas getting it.
restoreRenderDestination(renderer,destination);resources.quad.material=resources.finalMat;renderer.render(resources.quadScene,resources.quadCam);return true;}finally{showOthers();meshMaterials.forEach((_original,mesh)=>{mesh.material=meshMaterialIdentity.get(mesh);});materialState.forEach((state,mat)=>{['blending','blendEquation','blendEquationAlpha','blendSrc','blendDst','blendSrcAlpha','blendDstAlpha','depthTest','depthWrite'].forEach(key=>{mat[key]=state[key];});if(state.uniformValues&&mat.uniforms)state.uniformValues.forEach((value,key)=>{if(mat.uniforms[key])mat.uniforms[key].value=value;});});restoreRenderDestination(renderer,destination);renderer.autoClear=oldAutoClear;renderer.setClearColor(oldClearColor,oldClearAlpha);renderer.shadowMap.autoUpdate=oldShadowUpdate;linearUniforms.forEach((value,uniform)=>{uniform.value=value;});if(opts.setSceneLinear)opts.setSceneLinear(false);}};// debug(): exposes the current opaque render target (with its
// depthTexture) for a headed diagnosis harness. Null before the
// first render() call has allocated resources.
return{render,supported:halfOk,dispose:free,debug:()=>({opaque:resources?resources.opaque:null,opaqueMips:resources?resources.opaqueMips:null,refractionLod:resources?resources.halfLinearOk?'hardware':'manual':null})};};// createPeelPipeline(renderer, { getDisplayTransform, getDisplayExposure }): reusable depth-
// peel order-independent-transparency graph, extracted from
// createMtlxRenderView's original allocPeel/renderFrame so the USD Scene
// (js/usd-scene-renderer.js) can peel its own mesh set with the exact
// same math. See injectPeelDiscard/patchTransmissionAlpha above for the
// shader-side half; each transparent mesh's material must already carry
// u_peelMode/u_peelHasPrev/u_peelPrevDepth/u_opaqueDepth uniforms.
// render(scene, camera, transparentMeshes, opts) hides `transparentMeshes`
// during the opaque pass and every OTHER mesh during the peel/tail
// passes; opts.setSceneLinear(on), if given, is called once with
// peelLinearOk (mirrors the Viewer's own setSceneLinear/sceneLinearOn
// bookkeeping, which callers that manage that transition themselves,
// like the Viewer, should NOT also pass here).
const createPeelPipeline=(renderer,{getDisplayTransform:getDisplayTransformOpt,getDisplayExposure:getDisplayExposureOpt,linearComposite,opaqueOutput,layers,sceneRgbt=false}={})=>{// The RGB-T graph is explicitly Scene opt-in.  Viewer callers and legacy
// Scene callers retain the six-pass scalar implementation below until
// their generated materials expose the matching shader payload.
if(sceneRgbt){const rgbt=createRgbtPeelPipeline(renderer,{getDisplayTransform:getDisplayTransformOpt,getDisplayExposure:getDisplayExposureOpt,opaqueOutput,layers});const legacy=createPeelPipeline(renderer,{getDisplayTransform:getDisplayTransformOpt,getDisplayExposure:getDisplayExposureOpt,linearComposite,opaqueOutput});return{supported:rgbt.supported,peelLinearOk:rgbt.supported,render:(scene,camera,transparentMeshes,opts={})=>{let reason='';const ok=rgbt.render(scene,camera,transparentMeshes,Object.assign({},opts,{fallback:false,onUnsupported:r=>{reason=r;if(opts.onUnsupported)opts.onUnsupported(r);}}));if(!ok)return legacy.render(scene,camera,transparentMeshes,Object.assign({},opts,{onUnsupported:r=>{if(opts.onUnsupported)opts.onUnsupported(reason||r);}}));return ok;},setMeshMode:applyPeelMaterialMode,dispose:()=>{rgbt.dispose();legacy.dispose();},debug:rgbt.debug};}const getDT=getDisplayTransformOpt||getDisplayTransform;const getExposure=getDisplayExposureOpt||displayExposureScale;// Hoisted once: gates half-float peel/accum storage, the merged
// linear-opaque pass, and finalMat's shader choice (see allocPeel).
// linearComposite === false forces the RGBA8 display-space path
// regardless of EXT_color_buffer_float (Scene callers not yet wired
// for a linear merged pass); undefined keeps the auto behaviour.
const peelLinearOk=linearComposite===false?false:!!renderer.extensions.get('EXT_color_buffer_float');let peel=null;// freePeel: releases this pipeline's GPU resources (render targets,
// their depth textures, the composite-quad geometry/materials) and
// nulls `peel`. Idempotent-safe, called by allocPeel before a fresh
// build and by dispose() below.
const freePeel=()=>{if(!peel)return;[peel.opaqueRT,peel.peelA,peel.peelB,peel.accumRT].forEach(rt=>{if(!rt)return;rt.dispose();if(rt.depthTexture)rt.depthTexture.dispose();});if(peel.quadMesh&&peel.quadMesh.geometry)peel.quadMesh.geometry.dispose();if(peel.underMat)peel.underMat.dispose();if(peel.finalMat)peel.finalMat.dispose();peel=null;};// allocPeel(w, h): (re)builds every GPU resource at drawing-buffer
// size (w, h). See the original createMtlxRenderView allocPeel
// comment (still in git history) for the full opaqueRT/peelA/peelB/
// accumRT/blend-factor derivation; unchanged here.
const mkColorDepthTarget=(w,h,half)=>{const rt=new THREE.WebGLRenderTarget(w,h,Object.assign({minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:true,stencilBuffer:false},half?{type:THREE.HalfFloatType}:{}));rt.depthTexture=new THREE.DepthTexture(w,h,THREE.UnsignedIntType);rt.depthTexture.minFilter=THREE.NearestFilter;rt.depthTexture.magFilter=THREE.NearestFilter;return rt;};const allocPeel=(w,h)=>{freePeel();const opaqueRT=mkColorDepthTarget(w,h,peelLinearOk);const peelA=mkColorDepthTarget(w,h,peelLinearOk);const peelB=mkColorDepthTarget(w,h,peelLinearOk);const accumRT=new THREE.WebGLRenderTarget(w,h,Object.assign({minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false,stencilBuffer:false},peelLinearOk?{type:THREE.HalfFloatType}:{}));const quadCam=new THREE.OrthographicCamera(-1,1,1,-1,0,1);const quadScene=new THREE.Scene();const quadMesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),null);quadScene.add(quadMesh);// underMat: under-composites one peeled layer into accum.
// RGB=(DstAlpha,One), ALPHA=(Zero,OneMinusSrcAlpha). Do not
// change these factors without re-deriving the math.
const underMat=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:'in vec3 position;\n'+'in vec2 uv;\n'+'out vec2 vUv;\n'+'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }\n',fragmentShader:'precision highp float;\n'+'in vec2 vUv;\n'+'out vec4 o;\n'+'uniform sampler2D tLayer;\n'+'void main(){ vec4 c = texture(tLayer, vUv); o = vec4(c.rgb * c.a, c.a); }\n',uniforms:{tLayer:{value:null}},transparent:true,depthTest:false,depthWrite:false,blending:THREE.CustomBlending,blendEquation:THREE.AddEquation,blendSrc:THREE.DstAlphaFactor,blendDst:THREE.OneFactor,blendEquationAlpha:THREE.AddEquation,blendSrcAlpha:THREE.ZeroFactor,blendDstAlpha:THREE.OneMinusSrcAlphaFactor});// finalMat: composites accum over whatever is already on screen.
// When peelLinearOk, also folds in opaqueRT and applies the display
// transform exactly once (see DISPLAY_TRANSFORM_SWITCH_GLSL);
// otherwise accum is already display-encoded, plain passthrough
// blend. Transform and exposure are uniforms so live settings do not
// rebuild this quad program.
const finalMat=new THREE.RawShaderMaterial(Object.assign({glslVersion:THREE.GLSL3,vertexShader:'in vec3 position;\n'+'in vec2 uv;\n'+'out vec2 vUv;\n'+'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }\n',fragmentShader:peelLinearOk?'precision highp float;\n'+'in vec2 vUv;\n'+'out vec4 o;\n'+'uniform sampler2D tAccum;\n'+'uniform sampler2D tOpaque;\n'+'uniform int u_displayTransform;\n'+'uniform float u_displayExposure;\n'+'void main(){\n'+'    vec4 a = texture(tAccum, vUv);\n'+'    vec4 op = texture(tOpaque, vUv);\n'+'    vec3 lin = a.rgb + a.a * op.rgb;\n'+'    '+DISPLAY_TRANSFORM_SWITCH_GLSL('lin','encv','u_displayTransform','u_displayExposure').trimStart()+'    float outA = (1.0 - a.a) + a.a * op.a;\n'+'    o = vec4(encv, outA);\n'+'}\n':'precision highp float;\n'+'in vec2 vUv;\n'+'out vec4 o;\n'+'uniform sampler2D tAccum;\n'+'void main(){ vec4 a = texture(tAccum, vUv); o = vec4(a.rgb, a.a); }\n',uniforms:peelLinearOk?{tAccum:{value:null},tOpaque:{value:null},u_displayTransform:{value:displayTransformId(getDT())},u_displayExposure:{value:getExposure()}}:{tAccum:{value:null}},depthTest:false,depthWrite:false},peelLinearOk?{transparent:false,blending:THREE.NoBlending}:{transparent:true,blending:THREE.CustomBlending,blendEquation:THREE.AddEquation,blendSrc:THREE.OneFactor,blendDst:THREE.SrcAlphaFactor,blendEquationAlpha:THREE.AddEquation,// opaqueOutput keeps the destination alpha untouched. The default
// alpha blend drives it toward 0 wherever peeled geometry lands,
// which on an alpha:true canvas shows the page through the object
// and saves a screenshot with black holes. Embeds still want the
// transparent behaviour, so the Scene opts in and they do not.
blendSrcAlpha:opaqueOutput?THREE.ZeroFactor:THREE.OneMinusSrcAlphaFactor,blendDstAlpha:opaqueOutput?THREE.OneFactor:THREE.SrcAlphaFactor}));peel={w,h,opaqueRT,peelA,peelB,accumRT,quadScene,quadCam,quadMesh,underMat,finalMat};// Precompiles both composite-quad programs before the first
// peeling frame needs them.
quadMesh.material=underMat;renderer.compile(quadScene,quadCam);quadMesh.material=finalMat;renderer.compile(quadScene,quadCam);};// render(scene, camera, transparentMeshes, opts): the 6-pass graph
// (see the original createMtlxRenderView renderFrame comment, still
// in git history, for the full pass-by-pass rationale). Falls back
// to a plain renderer.render when `transparentMeshes` is empty, so a
// caller can route every frame through this unconditionally.
const render=(scene,camera,transparentMeshes,opts={})=>{// Neutral fallbacks (e.g. MeshNormalMaterial) have no uniforms
// object at all, so they never carry u_peelMode; they stay in
// the opaque set instead of being treated as peel participants.
const meshes=(transparentMeshes||[]).filter(m=>m&&m.material&&m.material.uniforms&&m.material.uniforms.u_peelMode);if(!meshes.length){renderer.render(scene,camera);return;}if(opts.setSceneLinear)opts.setSceneLinear(peelLinearOk);const boundTarget=renderer.getRenderTarget();const size=boundTarget?new THREE.Vector2(boundTarget.width,boundTarget.height):renderer.getDrawingBufferSize(new THREE.Vector2());if(!peel||peel.w!==size.x||peel.h!==size.y)allocPeel(size.x,size.y);// Every pass below that would otherwise hardcode null must land on
// this instead, so a caller-bound offscreen target (a future HDR/
// bloom wrapper) receives the real image rather than the canvas.
const outputDestination=snapshotRenderDestination(renderer);const prevAutoClear=renderer.autoClear;const prevClearColor=renderer.getClearColor(new THREE.Color());const prevClearAlpha=renderer.getClearAlpha();// The shadow map only needs to be built once for this whole
// multi-pass peel frame, not once per underlying renderer.render
// call (opaque pass plus PEEL_LAYERS peel passes plus the tail).
const prevShadowAutoUpdate=renderer.shadowMap.autoUpdate;renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;renderer.autoClear=false;const hidden=[];// u_peelLinear is an ACTIVE-pass flag, not a capability flag. Keep
// ordinary renders display encoded even on devices that support float
// targets, and restore every material's prior value on all exits.
const linearUniforms=new Map();if(peelLinearOk){scene.traverse(object=>{const materials=object&&object.material?Array.isArray(object.material)?object.material:[object.material]:[];materials.forEach(material=>{const uniform=material&&material.uniforms&&material.uniforms.u_peelLinear;if(!uniform||linearUniforms.has(uniform))return;linearUniforms.set(uniform,uniform.value);uniform.value=1;});});}try{const savedVis=meshes.map(m=>m.visible);meshes.forEach(m=>{m.visible=false;});if(peelLinearOk){// 1+2 merged: opaque -> opaqueRT only (linear HDR color +
// depth); finalMat composites it onto the screen in step 5.
renderer.setRenderTarget(peel.opaqueRT);renderer.setClearColor(prevClearColor,opts.outputLinear?prevClearAlpha:0);renderer.clear(true,true,true);renderer.render(scene,camera);}else{// 1. opaque -> caller's target (MSAA), transparent meshes hidden.
restoreRenderDestination(renderer,outputDestination);renderer.setClearColor(prevClearColor,prevClearAlpha);renderer.clear(true,true,true);renderer.render(scene,camera);// 2. opaque depth -> opaqueRT (only .depthTexture is used later).
renderer.setRenderTarget(peel.opaqueRT);renderer.setClearColor(0x000000,1);renderer.clear(true,true,true);renderer.render(scene,camera);}meshes.forEach((m,i)=>{m.visible=savedVis[i];});// 3. clear accum to (0,0,0,1): rgb = premultiplied color, a = running transmittance T.
renderer.setRenderTarget(peel.accumRT);renderer.setClearColor(0x000000,1);renderer.clear(true,false,false);// 4. peel PEEL_LAYERS nearest layers of the transparent SET
// only, isolated by hiding every other mesh.
const meshSet=new Set(meshes);scene.traverse(o=>{if(o.isMesh&&!meshSet.has(o)&&o.visible){o.visible=false;hidden.push(o);}});meshes.forEach(m=>{const mu=m.material.uniforms;mu.u_peelMode.value=1;mu.u_opaqueDepth.value=peel.opaqueRT.depthTexture;});let prev=null;for(let i=0;i<PEEL_LAYERS;i++){const curr=i%2===0?peel.peelA:peel.peelB;meshes.forEach(m=>{const mu=m.material.uniforms;mu.u_peelHasPrev.value=i>0?1:0;mu.u_peelPrevDepth.value=prev?prev.depthTexture:getDummyTex();});renderer.setRenderTarget(curr);renderer.setClearColor(0x000000,0);renderer.clear(true,true,true);renderer.render(scene,camera);peel.quadMesh.material=peel.underMat;peel.underMat.uniforms.tLayer.value=curr.texture;renderer.setRenderTarget(peel.accumRT);renderer.render(peel.quadScene,peel.quadCam);prev=curr;}// 4.5 tail pass: everything deeper than the last peel layer,
// captured directly into accumRT via the shader's own mode-2
// premultiply epilogue, each mesh's blend state temporarily
// switched to underMat's exact under-blend factors.
// Keyed by MATERIAL, not by mesh: a USD stage binds one compiled
// material to many prims, so saving per mesh would capture the
// already-mutated state on the second mesh and leave the material
// stuck in tail-pass blending (depthTest off) forever after.
const saved=new Map();for(const m of meshes){const mat=m.material;if(saved.has(mat))continue;const mu=mat.uniforms;mu.u_peelMode.value=2;mu.u_peelHasPrev.value=1;mu.u_peelPrevDepth.value=prev?prev.depthTexture:getDummyTex();saved.set(mat,{blending:mat.blending,blendEquation:mat.blendEquation,blendEquationAlpha:mat.blendEquationAlpha,blendSrc:mat.blendSrc,blendDst:mat.blendDst,blendSrcAlpha:mat.blendSrcAlpha,blendDstAlpha:mat.blendDstAlpha,depthTest:mat.depthTest});mat.blending=THREE.CustomBlending;mat.blendEquation=THREE.AddEquation;mat.blendEquationAlpha=THREE.AddEquation;mat.blendSrc=THREE.DstAlphaFactor;mat.blendDst=THREE.OneFactor;mat.blendSrcAlpha=THREE.ZeroFactor;mat.blendDstAlpha=THREE.OneMinusSrcAlphaFactor;// accumRT has no depth attachment (depthBuffer:false
// above), disabled explicitly anyway for defensiveness.
mat.depthTest=false;}renderer.setRenderTarget(peel.accumRT);renderer.render(scene,camera);saved.forEach((state,mat)=>{Object.assign(mat,state);mat.uniforms.u_peelMode.value=0;});hidden.forEach(o=>{o.visible=true;});hidden.length=0;// 5. composite accum (+opaqueRT, linear mode) onto the caller's target.
restoreRenderDestination(renderer,outputDestination);peel.quadMesh.material=peel.finalMat;peel.finalMat.uniforms.tAccum.value=peel.accumRT.texture;if(peelLinearOk){peel.finalMat.uniforms.tOpaque.value=peel.opaqueRT.texture;peel.finalMat.uniforms.u_displayTransform.value=opts.outputLinear?2:displayTransformId(getDT());peel.finalMat.uniforms.u_displayExposure.value=opts.outputLinear?1:getExposure();}renderer.render(peel.quadScene,peel.quadCam);}finally{// restore GL state even if a pass above threw
restoreRenderDestination(renderer,outputDestination);renderer.autoClear=prevAutoClear;renderer.setClearColor(prevClearColor,prevClearAlpha);renderer.shadowMap.autoUpdate=prevShadowAutoUpdate;meshes.forEach(m=>{if(m.material.uniforms&&m.material.uniforms.u_peelMode)m.material.uniforms.u_peelMode.value=0;});linearUniforms.forEach((value,uniform)=>{uniform.value=value;});if(hidden.length){hidden.forEach(o=>{o.visible=true;});hidden.length=0;}}};return{render,setMeshMode:applyPeelMaterialMode,peelLinearOk,dispose:()=>{freePeel();}};};// ------------------------------------------------------------------
// createPreviewContent: the preview content adapter driven by
// MtlxRender.createRenderSession (js/shared/render-session.js, P6-CONTRACT.md):
// codegen, the GLB shaderball scene, framing, geometry, displacement, UDIM, material binding.
// ------------------------------------------------------------------
const createPreviewContent=({canvas,mx,gen,genContext,renderable,lightData,label,needsLighting,geomName,isMounted=()=>true,debugKind='',// Opt-out for views whose sliders write uniforms with no regeneration
// path (the docs node preview); see constifyInputUniforms.
allowConstInputs=true,// false (default) = fixed, non-interactive authored GLB camera (graph
// editor); true (docs/viewer) = OrbitControls with pivot/zoom/polar
// clamp and Box3 containment. Ignored outside full-scene mode.
sceneOrbit=false,// Names the <material> element whose displacementshader input to
// follow (see resolveDisplacementSource); null scans the document.
materialName=null,// Highest triangle count this view's subdivided preview mesh may reach;
// window.__mtlxTriangleBudgetOverride (test hook) wins at each use.
triangleBudget=PREVIEW_TRIANGLE_BUDGET,// Settings surface whose quality level this view follows (viewer, compare,
// docs, graph, embed); defaults from the host.
surface=null})=>{const renderSurface=surface||previewLevelSurface();// 'shaderball-scene' -> full authored GLB scene with its detached camera;
// 'shaderball' -> ball-only GLB; anything else -> sphere/cube path.
const sceneMode=geomName==='shaderball-scene'?'full':geomName==='shaderball'?'simple':null;// 'buffer2d': Shadertoy-style fullscreen quad, fixed ortho camera,
// no controls/spin, no visible backdrop.
const flat2d=geomName==='buffer2d';// Known before the renderer exists, so the session can configure the
// shadow map up front (flipping it later blacked out scene.environment).
const wantsStudio=!flat2d&&sceneMode!=='full';// Session objects, handed over by the lifecycle hooks below.
let host=null,renderer=null,scene=null,camera=null,controls=null;let orbitDragging=false,orbitEndedAt=-Infinity;let stopped=false;// First-build sources from prepare(); build() applies them.
let firstSrcs=null;// Reassigned by applyMaterialInternal() on every swap; `uniforms` MUST be
// `let`: every closure below shares this binding.
let mesh=null,material=null,geometry=null,uniforms=null;// Displacement: originalGeometry as built (kept until teardown),
// baseGeometry subdivided-but-undisplaced, displacedGeometry on `mesh`.
let originalGeometry=null,baseGeometry=null,displacedGeometry=null;let displacementSources=null;let materialNotices=[];let dispRunner=null;// Custom-geometry UDIM split: child meshes per tile beyond the lowest,
// the original index, partitionTriangles() cached per (epoch, ref), and
// the one notice covering crossing/missing/over-cap tiles.
let udimParts=[],udimFullIndex=null,udimSplitActive=false;let udimBucketsKey=null,udimBuckets=null,udimFileMap=null;let udimNoticeText=null,udimTileCount=0;const PREVIEW_UDIM_MAX_TILES=64;// This view's refcounted texture session (F3); disposed before the renderer.
let textureSession=null;let unsubTextureAnisotropy=null;// Scene-mode state: instantiated GLB root and its per-view material clones.
let sceneInst=null,sceneGroup=null,sceneOwnedMaterials=[];let fullScene=false;// Raw srcs.transparent of the live material (peel verdict input).
let viewIsTransparent=false;// Full-scene framing: authored fov/aspect/pose, fullscreen fit, cached
// ball sphere, scene-orbit containment box and fit distance/radius.
let fullSceneAuthoredFov=null,fullSceneAuthoredAspect=null,sceneAuthoredPose=null;let fullscreenFit=false,ballBoundingSphere=null,sceneOrbitClampBox=null;let sceneOrbitFitDist=null,sceneOrbitFitRadius=null;const rigCount=lightData&&lightData.length||0;const handleRef=()=>host?host.handle():null;// Finds (and caches) the ball assembly's world bounding
// sphere: 'shader_ball' by name, falling back to
// material_surface's parent, then sceneGroup (never throws).
// Framing always measures the undisplaced mesh, so displacement
// (sync on the first build or landing later) never moves the camera.
const withFramingGeometry=fn=>{if(!mesh||!originalGeometry||mesh.geometry===originalGeometry)return fn();const current=mesh.geometry;mesh.geometry=originalGeometry;try{return fn();}finally{mesh.geometry=current;}};const getBallBoundingSphere=()=>{if(ballBoundingSphere)return ballBoundingSphere;if(!sceneGroup)return null;ballBoundingSphere=MtlxSceneAssembly.ballBoundingSphere(sceneGroup,mesh,withFramingGeometry);return ballBoundingSphere;};// Single entry point for every fov-affecting event so they
// never disagree: starts from effectiveFullSceneVFov, then
// widens further only while fullscreenFit is on.
const recomputeCameraFov=()=>{if(fullSceneAuthoredFov==null)return;// non-fullScene modes keep their fixed fov untouched
camera.fov=fullSceneFov({authoredFov:fullSceneAuthoredFov,authoredAspect:fullSceneAuthoredAspect,aspect:camera.aspect,fitDist:sceneOrbitFitDist,fitRadius:sceneOrbitFitRadius,fullscreenFit,getSphere:getBallBoundingSphere,cameraPosition:camera.position});};// flat2d screen-proportional fit (Shadertoy's
// fragCoord/iResolution.y convention): one unit of UV or
// object-space position covers the same pixel count on
// both axes, so resizing the canvas REVEALS more pattern
// instead of stretching it. Height keeps v 0..1 / y
// -1..1; the frustum, quad positions (x ±aspect), and
// UVs (u 0..aspect) all track the width. This must touch
// POSITION too, not just UV, 3D-procedural nodes (noise/
// fractal) sample i_position and would stretch otherwise.
// prepGeometry aliases i_position/i_texcoord_0 to the
// SAME BufferAttributes as position/uv, so these writes
// update what the MaterialX shader reads. The 4-vert
// quad's x/u values are strictly signed/zero-or-positive,
// so re-fitting at any previous aspect is idempotent.
const fitQuadToAspect=aspect=>{camera.left=-aspect;camera.right=aspect;camera.updateProjectionMatrix();if(!geometry)return;const pos=geometry.getAttribute('position');const uv=geometry.getAttribute('uv');if(!pos||!uv)return;for(let i=0;i<pos.count;i++){pos.setX(i,pos.getX(i)>0?aspect:-aspect);uv.setX(i,uv.getX(i)>0?aspect:0);}pos.needsUpdate=true;uv.needsUpdate=true;// Frustum culling reads the bounding sphere; keep it
// in sync with the rewritten positions.
geometry.computeBoundingSphere();};// Silhouette-bottom floor placement, factored out so a
// later geometry swap can re-run it too.
const updateStudioFloor=()=>host.boundsChanged();// Current, complete set of displacement-derived notices
// (subdivision cap/drop, plus the latest evaluation run's
// own notices), for getDisplacementState() and the status
// event; owned by dispRunner (P4d stage 1).
const currentDispNotices=()=>dispRunner.getState().notices;// Rebuilt, never appended, so re-runs cannot stack stale copies.
const syncHandleNotices=()=>{const handle=handleRef();if(handle)handle.notices=materialNotices.concat(currentDispNotices(),udimNoticeText?[udimNoticeText]:[]);};const dispDispatchStatus=()=>{const handle=handleRef();if(!handle)return;try{window.dispatchEvent(new CustomEvent('mtlx-displacement-status',{detail:{view:handle,state:dispRunner.getState().state,notices:currentDispNotices()}}));}catch(e){/* best-effort */}};// Sets `mesh.geometry`/`geometry` to `g`; a genuine
// displaced result is disposed on the NEXT swap, the base/
// original is left alone. Safe pre-`mesh` too (first build).
// dispRunner's onGeometry calls this with the built geometry
// (or null, meaning "fall back to originalGeometry").
const swapMeshGeometry=g=>{const prevDisplaced=displacedGeometry;displacedGeometry=g!==originalGeometry&&g!==baseGeometry?g:null;geometry=g;if(mesh){mesh.geometry=g;updateStudioFloor();}if(prevDisplaced&&prevDisplaced!==g){try{prevDisplaced.dispose();}catch(e){/* already disposed/invalid */}}};const bindDisplacementGeomprops=()=>{if(!baseGeometry||!displacementSources||!displacementSources.geomprops)return;bindGeompropAttributes(baseGeometry,displacementSources.geomprops,text=>{dispRunner.pushNotice(text);});};// Ensures baseGeometry reflects the current preview
// subdivision setting (capped to the triangle budget),
// rebuilding only when the resolved level changed; delegates
// to dispRunner.build (BASE_GEOM_CACHE lookup, subdivision
// via prepareDisplacementBase, notice strings).
const ensureBaseGeometry=()=>{const result=dispRunner.build(originalGeometry,getPreviewSubdivisionLevel());baseGeometry=dispRunner.getBaseGeometry();syncHandleNotices();return result;};// Evaluates the current displacementSources/baseGeometry
// and lands the result; shared by settings toggles, a
// material debounce and an arriving file map.
const runDisplacement=async()=>{if(stopped||flat2d||!displacementSources||!baseGeometry)return;bindDisplacementGeomprops();await dispRunner.evaluate();};// P4d stage 2: custom-geometry UDIM split. Removes any
// previous split's child meshes and restores mesh.geometry's
// full index; a no-op when there is nothing to tear down.
const teardownUdimParts=()=>{if(udimParts.length){udimParts.forEach(p=>{try{mesh.remove(p);}catch(e){/* mesh mid-teardown */}try{p.geometry.dispose();}catch(e){/* shares base attrs, index-only */}try{p.material.dispose();}catch(e){/* already disposed/invalid */}});udimParts=[];}if(udimSplitActive&&mesh&&mesh.geometry){if(udimFullIndex)mesh.geometry.setIndex(udimFullIndex);udimSplitActive=false;}if(udimNoticeText){udimNoticeText=null;syncHandleNotices();}};// A fresh BufferGeometry sharing baseGeom's attribute
// OBJECTS (no data copy) with its own index over `triangles`
// (design: "sub-geometry sharing the base BufferAttributes
// with its own index"); .dispose() on it only frees that
// OWN index buffer, never the shared attributes.
const buildUdimPartGeometry=(baseGeom,triangles)=>{const g=new THREE.BufferGeometry();for(const name of Object.keys(baseGeom.attributes))g.setAttribute(name,baseGeom.attributes[name]);const flat=new Uint32Array(triangles.length*3);let w=0;for(const tri of triangles){flat[w]=tri[0];flat[w+1]=tri[1];flat[w+2]=tri[2];w+=3;}g.setIndex(new THREE.BufferAttribute(flat,1));g.boundingSphere=baseGeom.boundingSphere;g.boundingBox=baseGeom.boundingBox;return g;};// Called whenever a file map arrives (bindDroppedTextures,
// for every live view) and whenever the material changes
// (applyMaterialInternal below); splits `mesh` into one
// sub-geometry per resolved UDIM tile when the CURRENT
// material has UDIM refs and more than one tile is present
// in the mesh's UVs. Built-in geometry (sceneMode/flat2d/
// non-'custom') is unaffected: bindDroppedTextures's
// existing first-tile binding still covers it.
const applyUdimSplit=(introspected,fileMap)=>{if(stopped||flat2d||sceneMode||geomName!=='custom'||!mesh||!originalGeometry||!window.MtlxMeshUdim||!textureSession||displacementSources){teardownUdimParts();return;}const udimRefs=findUdimRefs(introspected);if(!udimRefs.length){teardownUdimParts();return;}const ref=udimRefs[0].data,uName=udimRefs[0].name;const baseGeom=mesh.geometry;const posAttr=baseGeom.getAttribute('position');if(!posAttr){teardownUdimParts();return;}const idxAttr=baseGeom.getIndex();const indices=idxAttr?idxAttr.array:Array.from({length:posAttr.count},(_,i)=>i);const uvAttr=baseGeom.getAttribute('uv');const cacheKey=CUSTOM_GEOM.epoch+'|'+ref;if(udimBucketsKey!==cacheKey){udimBuckets=window.MtlxMeshUdim.partitionTriangles({uvs:uvAttr?uvAttr.array:null,indices,vFlip:CUSTOM_GEOM.uvOrigin==='top'});udimBucketsKey=cacheKey;}const{buckets,crossingCount}=udimBuckets;const numericKeys=Array.from(buckets.keys()).filter(k=>k!=='crossing').sort((a,b)=>Number(a)-Number(b));if(numericKeys.length<2){teardownUdimParts();return;}const tileHits=textureSession.resolveTiles(fileMap,ref);if(!tileHits.length){teardownUdimParts();return;}const tileByCode=new Map(tileHits.map(h=>[h.code,h]));const lowestKey=numericKeys[0];teardownUdimParts();if(!udimFullIndex&&idxAttr)udimFullIndex=idxAttr.clone();// Everything that isn't a cleanly resolved higher tile
// (the lowest bucket itself, UV-crossing triangles,
// missing tiles, tiles past the cap) renders through
// `mesh`'s own default/lowest-tile texture: no cracks,
// degraded to the default look with one notice.
const defaultTriangles=buckets.get(lowestKey).triangles.slice();const crossingBucket=buckets.get('crossing');if(crossingBucket)defaultTriangles.push(...crossingBucket.triangles);let overflowCount=0,missingCount=0,placed=0;for(const key of numericKeys){if(key===lowestKey)continue;const bucket=buckets.get(key);if(placed>=PREVIEW_UDIM_MAX_TILES-1){defaultTriangles.push(...bucket.triangles);overflowCount+=bucket.triangles.length;continue;}const hit=tileByCode.get(Number(key));if(!hit){defaultTriangles.push(...bucket.triangles);missingCount+=bucket.triangles.length;continue;}const acquired=textureSession.acquire(hit,{samplerModes:udimRefs[0].samplerModes||null});const bindVariant=result=>{if(!result||!result.texture||stopped||!mesh)return;const variantUniforms=createUdimVariantUniforms(uniforms,{[uName]:result.texture},{shareSlots:true});const variantMaterial=material.clone();variantMaterial.uniforms=variantUniforms;const partMesh=new THREE.Mesh(buildUdimPartGeometry(baseGeom,bucket.triangles),variantMaterial);partMesh.castShadow=mesh.castShadow;partMesh.receiveShadow=mesh.receiveShadow;partMesh.frustumCulled=false;mesh.add(partMesh);udimParts.push(partMesh);};if(acquired&&typeof acquired.then==='function')acquired.then(bindVariant);else bindVariant(acquired);placed+=1;}mesh.geometry=buildUdimPartGeometry(baseGeom,defaultTriangles);geometry=mesh.geometry;udimSplitActive=true;udimTileCount=placed+1;const badTriangles=crossingCount+overflowCount+missingCount;udimNoticeText=badTriangles>0?'UDIM: '+badTriangles+' triangle(s) had a crossing or unresolved tile and use the default tile':null;syncHandleNotices();};// Scene-orbit framing: pivot, distance limits, containment box and the
// fit-to-ball fov, configured once the session has built the controls.
const configureOrbit=()=>{if(fullScene&&sceneOrbit&&controls){const orbit=configureSceneOrbit({camera,controls,sceneGroup,mesh,authoredPose:sceneAuthoredPose,withFramingGeometry,sphere:getBallBoundingSphere()});sceneOrbitClampBox=orbit.clampBox;sceneOrbitFitRadius=orbit.fitRadius;sceneOrbitFitDist=orbit.fitDist;recomputeCameraFov();camera.updateProjectionMatrix();// Snapshot for resetCamera(): position0/target0 now
// hold the authored pose + derived pivot, so
// controls.reset() restores this exact framing.
controls.saveState();}};// Hoisted above the first material apply: applyMaterialInternal
// calls this after every swap, and animate() calls it every
// frame. The guard is defensive only.
const setUniforms=()=>{if(!mesh||!uniforms)return;updateTransformUniforms(uniforms,mesh,camera);if(uniforms.u_time)uniforms.u_time.value=MTLX_CLOCK.time;if(uniforms.u_frame)uniforms.u_frame.value=MTLX_CLOCK.frame;};// Session env state in the shape createMtlxSceneUniforms expects; no
// radiancePrefiltered/irradianceConvolved fields, so it binds as-is.
const shadingEnv=()=>{const e=host.env();return{radiance:e.radiance,irradiance:e.irradiance,mips:e.mips,keyLight:e.keyLight};};// DEBUG_SHADERS logging the old bindMaterialUniforms fork
// used to print inline; kept as its own helper so
// createMtlxSceneUniforms stays free of console noise.
const logPreviewUniformDebug=(srcs,newUniforms)=>{if(!DEBUG_SHADERS)return;const introspected=srcs.introspected||[];console.log('introspected uniforms:',introspected.map(u=>`${u.type} ${u.name}${u.data!=null?' (default uploaded)':''}`));if(!introspected.length){console.warn('Shader introspection found NO uniform blocks, defaults not uploaded; expect black. (Binding API mismatch, report the mxShader/stage method names used by generatePreviewSourcesUnlocked.)');}const declared=srcs.declared||parseUniforms(srcs.fs||'').concat(parseUniforms(srcs.vs||''));console.group(`MaterialX preview: ${label}`);console.log('kind:',debugKind,'needsLighting:',needsLighting);console.log('declared uniforms:',declared.map(u=>`${u.type} ${u.name}`));console.log('VERTEX SHADER\n',srcs.vs);console.log('PIXEL SHADER\n',srcs.fs);console.groupEnd();if(needsLighting){const{keyLight:envKeyLight,hasFile:envHasFile,prefilteredIrr:envPrefilteredIrr}=host.env();const nLights=activeLightCount(lightData,envKeyLight,null,srcs.maxLights);console.log('env bound →',envHasFile?envPrefilteredIrr?'(radiance + prefiltered irradiance files)':'(radiance file; irradiance SH-synthesized)':'(synthesized)','| direct lights:',nLights,'(rig '+rigCount+' + key '+(envKeyLight?1:0)+')');const envUnbound=declared.filter(u=>/sampler/i.test(u.type)&&/env/i.test(u.name)&&!newUniforms[u.name]);if(envUnbound.length)mtlxWarn('UNBOUND env samplers (likely cause of black):',envUnbound.map(u=>u.name));}};// syncMeshMaterialMode, derives the mesh material's
// blend/depth flags from viewIsTransparent/
// FORCE_TRANSPARENCY, in place (no shader rebuild, the
// peel discard block is baked into every shader
// unconditionally, see injectPeelDiscard). Called at the
// end of every applyMaterialInternal and from the
// handle's refreshRenderMode. `material.transparent`
// stays FALSE either way: Force Transparency ON drives
// translucency entirely through renderFrame()'s
// peel/composite passes, never three.js's own blend
// state (mixing the two would double-blend and corrupt
// the peel discard's depth comparisons). u_peelMode is
// left at 0 here; renderFrame() raises it only for the
// duration of its peel loop.
const syncMeshMaterialMode=()=>{if(!material)return;const peelOn=viewIsTransparent&&FORCE_TRANSPARENCY;// Idempotent transition (renderFrame's own check below is
// the other call site), flips scene built-ins' toneMapped.
host.syncLinear(peelOn);applyPeelMaterialMode(material,peelOn);};// ------------------------------------------------------
// applyMaterialInternal: builds a new RawShaderMaterial
// from `srcs` and swaps it onto the shell's mesh IN PLACE
// (no renderer/scene/camera recreation). On a compile
// error, restores the OLD material/uniforms and disposes
// the bad one BEFORE throwing, see the badProg branch below.
// ------------------------------------------------------
const applyMaterialInternal=(srcs,applyLabel)=>{if(geometry&&srcs.geomprops&&srcs.geomprops.length){bindGeompropAttributes(geometry,srcs.geomprops,text=>{if(!srcs.notices)srcs.notices=[];if(!srcs.notices.includes(text))srcs.notices.push(text);});}const{rotation:envRotationRad,exposure:envExposure}=host.env();const newUniforms=createMtlxSceneUniforms({compiled:srcs,env:needsLighting?shadingEnv():null,lightData:needsLighting?lightData:null,envRotationRad,envExposure});logPreviewUniformDebug(srcs,newUniforms);// Transparency verdict is srcs.transparent, gated on
// FORCE_TRANSPARENCY. When on, translucency is produced
// by renderFrame()'s depth-peel passes (syncMeshMaterialMode,
// above), not three.js blend state, STRAIGHT alpha
// (MaterialX's own epilogue) either way, so do NOT set
// premultipliedAlpha here.
// Mirror the raw (pre-FORCE_TRANSPARENCY-gated) verdict
// onto the shell, see viewIsTransparent's declaration
// above for why renderFrame() needs this shell-local
// copy rather than reading handle.isTransparent.
viewIsTransparent=!!srcs.transparent;// Neutral literals inside: syncMeshMaterialMode() below is the
// real source of truth and overwrites both immediately.
const newMaterial=createPreviewMaterial(srcs,newUniforms);// Stash the outgoing material/uniforms so a compile
// failure below can restore them, making the swap a
// no-op from the outside. Both are null on the first build.
const oldMaterial=material;const oldUniforms=uniforms;material=newMaterial;uniforms=newUniforms;if(!mesh){// First call for this shell: create the mesh and
// add it to the shell-level scene. Every later
// call just reassigns mesh.material below.
mesh=new THREE.Mesh(geometry,material);scene.add(mesh);}else{mesh.material=material;}// Compile now and surface any GLSL error to the UI
// instead of a silent black canvas. Filters benign
// ANGLE/fxc X4008 warnings, see compileFilteringDriverNoise.
setUniforms();// [mtlx-perf] timing for renderer.compile() alone.
// With the pre-warm completed beforehand, this is
// typically an ANGLE cache hit (~15-25ms) vs. 2.5-2.9s cold.
const __compilePerfStart=window.MTLX_PERF_LOG?performance.now():0;// host.compile(): driver-noise filtered compile plus the
// bad-program detection; the rollback below stays here.
const badProg=host.compile();if(window.MTLX_PERF_LOG){console.log('[mtlx-perf] GL compile: '+(performance.now()-__compilePerfStart).toFixed(1)+'ms (target: '+applyLabel+')');}if(badProg){// LOAD-BEARING ORDER: restore OLD material/uniforms
// FIRST, then dispose the BAD one, reordering this
// leaves the bad program in renderer.info.programs forever.
mesh.material=oldMaterial;material=oldMaterial;uniforms=oldUniforms;newMaterial.dispose();const d=badProg.diagnostics;const log=(d.programLog||'')+'\n'+(d.fragmentShader&&d.fragmentShader.log?'FRAG: '+d.fragmentShader.log:'')+(d.vertexShader&&d.vertexShader.log?' VERT: '+d.vertexShader.log:'');console.error('MaterialX shader compile error:',log);throw new Error(`Shader compile error for "${applyLabel}". See console. ${log.slice(0,160)}`);}// Success: the swap stuck; the OLD material/program
// is no longer needed (null on the very first build,
// when there's nothing to dispose).
if(oldMaterial)oldMaterial.dispose();// Land the new material in the correct render mode
// (opaque vs. depth-peel raw-write) right away, this
// runs on the VERY FIRST build too (see this
// function's header comment on why first-build and
// every later edit share this one code path), which
// is what makes an already-persisted Force
// Transparency setting take effect immediately
// without waiting for a toggle event from the
// Settings dialog.
syncMeshMaterialMode();};const content={// studio is read before the renderer exists; the rest after instantiate().
capabilities:()=>({lit:!!needsLighting,threeD:!flat2d,studio:wantsStudio,sceneEnvironment:!!sceneInst,autoRotate:!fullScene&&!flat2d,camera:flat2d?'ortho':fullScene&&!sceneOrbit?'fixed':'orbit',// Settings surface the session reads its preview Quality effects from.
surface:renderSurface}),// Codegen, then the driver pre-warm BEFORE the display renderer
// exists (the old after-renderer placement stalled WebGLRenderer init).
prepare:async h=>{host=h;const srcs=await generatePreviewSourcesWithinBudget({mx,gen,genContext,renderable,label,materialName,isMounted,stageLightCount:PREVIEW_STAGE_LIGHT_COUNT,sceneFeatureOptions:previewFeatureOptions(renderSurface),allowConstInputs,transmission:getPreviewTransmission(renderSurface)});if(!srcs)return false;firstSrcs=srcs;prewarmDisplacementSources(srcs,isMounted,label);const warmResult=await prewarmShaderCompile({vs:srcs.vs,fs:srcs.fs,isMounted,label});if(warmResult==='bailed'||!isMounted())return false;return true;},attach:h=>{renderer=h.renderer;// F3: one texture session per preview handle (unbounded, like
// today's preview loads); tiers/exact are the Scene's knobs.
textureSession=createTextureSession({renderer,isAlive:()=>!stopped,anisotropy:getTextureAnisotropy()});unsubTextureAnisotropy=window.MtlxRenderSettings&&window.MtlxRenderSettings.subscribe?window.MtlxRenderSettings.subscribe(detail=>{// Stage-profile writes belong to the Scene's own sessions.
if(detail&&detail.key==='textureAnisotropy'&&detail.profile!=='stage'&&textureSession)textureSession.setAnisotropy(detail.value);}):null;dispRunner=createDisplacementRunner({renderer,isAlive:()=>!stopped,budget:createTriangleBudget({perMesh:triangleBudget,total:Infinity,enabled:true}),textureSession,cacheKey:level=>baseGeomCacheKey(geomName,sceneMode,level),creaseByNormals:true,firstBuildTimeoutMs:4000,debounceMs:150,onGeometry:built=>swapMeshGeometry(built||originalGeometry),onStatus:()=>{syncHandleNotices();dispDispatchStatus();},getWorldMatrix:()=>mesh?mesh.matrixWorld:new THREE.Matrix4()});},// Instantiates the scene-mode GLB BEFORE the camera: full-scene mode
// builds the camera from the GLB's embedded one.
instantiate:h=>{scene=h.scene;const finish=inst=>{sceneInst=inst;if(!isMounted())return false;if(sceneMode&&!sceneInst){// Missing/corrupt GLB: plain sphere fallback with a warning.
console.warn('shaderball scene unavailable, falling back to sphere:',geomName);}if(sceneInst){sceneGroup=sceneInst.group;sceneOwnedMaterials=sceneInst.ownedMaterials;// Env-rotation patch on every neutral glTF PBR material
// except the backplanes' MeshBasicMaterial clones (no envMap).
sceneOwnedMaterials.forEach(m=>{if('envMapIntensity'in m&&!wantsStudio)MtlxSceneAssembly.patchNeutralMaterialEnvRotation(m,()=>host.env().rotation);});}fullScene=!!(sceneInst&&sceneMode==='full');return true;};if(!sceneMode)return finish(null);return instantiateShaderballScene(sceneMode).then(finish);},adoptCamera:(cam,{width:cw,height:ch})=>{camera=cam;if(fullScene&&sceneInst.glbCamera){const adopted=adoptSceneCamera(camera,sceneInst,cw/ch);sceneAuthoredPose=adopted.authoredPose;fullSceneAuthoredFov=adopted.authoredFov;fullSceneAuthoredAspect=adopted.authoredAspect;}},// flat2d refits the quad (fitQuadToAspect owns its projection);
// everything else re-aims the perspective camera.
layout:(w,h)=>{if(flat2d){fitQuadToAspect(w/h);return;}camera.aspect=w/h;// fullScene: a resize can flip the authored-aspect comparison.
recomputeCameraFov();camera.updateProjectionMatrix();},clampBox:()=>sceneOrbitClampBox,build:async h=>{controls=h.controls;// Feeds isInteracting(): a drag, plus the damping tail after it.
if(controls){controls.addEventListener('start',()=>{orbitDragging=true;});controls.addEventListener('end',()=>{orbitDragging=false;orbitEndedAt=performance.now();});}// Scene mode pre-assigns `mesh`/`geometry` to material_surface, so
// the first applyMaterialInternal() reuses it, not a fresh Mesh.
if(sceneInst){scene.add(sceneGroup);mesh=sceneInst.surfaceMesh;geometry=mesh.geometry;// The first frame reads mesh.matrixWorld before render() syncs it.
sceneGroup.updateMatrixWorld(true);}else{geometry=prepGeometry(await buildPreviewGeometry(geomName));// Initial 2D fit; don't rely on the ResizeObserver's first fire.
if(flat2d)fitQuadToAspect((canvas.clientWidth||h.width)/(canvas.clientHeight||h.height));}if(!isMounted())return false;// Kept until teardown; every displaced geometry derives from it.
originalGeometry=geometry;// First build: subdivide + evaluate before the first apply so the
// first frame shows the final geometry; filename-driven or slow
// (>4s) programs land later (dispRunner.runFirstBuild).
displacementSources=firstSrcs.displacement;dispRunner.setSource(displacementSources);if(!flat2d&&displacementSources&&getDisplacementEnabled()){ensureBaseGeometry();bindDisplacementGeomprops();geometry=baseGeometry;if(mesh)mesh.geometry=baseGeometry;await dispRunner.runFirstBuild();}configureOrbit();// Same helper every later applyMaterial() uses, same styled Error.
// payloadSupported seeds the RGB-T selectors (false below preview Quality).
const{vs,fs,introspected,transparent,geomprops,notices,maxLights,payloadSupported}=firstSrcs;applyMaterialInternal({vs,fs,introspected,transparent,geomprops,notices,maxLights,payloadSupported},label);return true;},// Spin target and floor bounds: the whole assembled scene when present.
root:()=>sceneGroup||mesh,// The MaterialX surface plus, in scene mode, the neutral glTF parts.
casters:()=>{const list=[];if(mesh)list.push(mesh);if(sceneGroup){sceneGroup.traverse(obj=>{if(!obj.isMesh||!obj.material)return;const mats=Array.isArray(obj.material)?obj.material:[obj.material];if(mats.some(m=>'envMapIntensity'in m))list.push(obj);});}return list;},builtinMaterials:()=>sceneOwnedMaterials,transparentMeshes:()=>viewIsTransparent&&mesh?[mesh]:[],beforeRender:()=>setUniforms(),// The session owns the env values; this rebinds what the material
// and the neutral glTF parts read from them, in place.
envChanged:(what,env)=>{const e=host.env();if(what==='rotation'){if(uniforms.u_envMatrix){uniforms.u_envMatrix.value=new THREE.Matrix4().makeRotationY(Math.PI/2+e.rotation);}// The extracted key light tracks the (clamped) sun; rig lights don't.
updateKeyLightUniformEntry(uniforms,rigCount,e.keyLight,e.rotation,e.exposure);sceneOwnedMaterials.forEach(m=>{const u=m.userData.envRotationUniform;if(u)u.value=envRotationMatrix3(e.rotation);});}else if(what==='exposure'){// IBL-only multiplier; the key light is energy split out of the
// env map (D5), so its bound intensity tracks it too.
if(uniforms.u_envLightIntensity)uniforms.u_envLightIntensity.value=e.exposure;updateKeyLightUniformEntry(uniforms,rigCount,e.keyLight,e.rotation,e.exposure);if(sceneGroup){sceneGroup.traverse(obj=>{if(obj.isMesh&&obj!==mesh&&obj.material&&'envMapIntensity'in obj.material){obj.material.envMapIntensity=e.exposure;}});}}else if(what==='environment'){// Same shader source createMtlxSceneUniforms parsed at bind time.
const declared=material?parseUniforms(material.fragmentShader).concat(parseUniforms(material.vertexShader)):[];bindEnvironmentSamplers(uniforms,declared,env);if(uniforms.u_envRadianceMips)uniforms.u_envRadianceMips.value=env.mips;updateKeyLightUniformEntry(uniforms,rigCount,e.keyLight,e.rotation,e.exposure);}},// Camera exposure and the transform id are uniforms: one write each.
displayChanged:({scale,id})=>{const push=u=>{if(!u)return;if(u.u_displayExposure)u.u_displayExposure.value=scale;if(u.u_displayTransform)u.u_displayTransform.value=id;};push(uniforms);sceneOwnedMaterials.forEach(m=>push(m.uniforms));},// Re-derives blend/depth flags in place; returns the peel verdict.
renderModeChanged:()=>{syncMeshMaterialMode();return viewIsTransparent&&FORCE_TRANSPARENCY;},// Called by the P3 setters through LIVE_VIEWS on every live
// view; a no-op for flat2d or a material with no displacement.
refreshDisplacement:()=>{if(flat2d||!displacementSources)return;if(!getDisplacementEnabled()){dispRunner.cancel();if(dispRunner.getState().state!=='off'){swapMeshGeometry(originalGeometry);dispRunner.off();dispDispatchStatus();}return;}const prevLevel=dispRunner.getState().level;const wasOff=dispRunner.getState().state==='off'||dispRunner.getState().state==='none';ensureBaseGeometry();if(wasOff||prevLevel!==dispRunner.getState().level)runDisplacement();},extras:{// True while OrbitControls is dragged and for 600 ms after (damping).
// False without controls and for autorotate.
isInteracting:()=>!!controls&&(orbitDragging||performance.now()-orbitEndedAt<600),// Texture session stats (wrapper/source counts, reserved bytes,
// current anisotropy). Not a core handle-contract name; the
// Textures card UI itself is deferred (P4-DESIGN.md section 3).
getTextureStats:()=>textureSession?textureSession.stats():null,// Fullscreen "fit to ball" toggle: keeps the whole shaderball
// visible while fullscreen, FOV-only (camera position/
// orientation untouched). No-op outside full-scene mode.
setFullscreenFit:on=>{if(!fullScene)return;fullscreenFit=!!on;recomputeCameraFov();camera.updateProjectionMatrix();},// Applies a new (or already-generated) material into this
// SAME shell, instead of calling createMtlxRenderView() again.
// Returns null when superseded/bailed; throws on real compile failure.
applyMaterial:async({mx,gen,genContext,renderable,srcs=null,label,materialName:applyMaterialName,isMounted=()=>true})=>{const __applyPerfStart=window.MTLX_PERF_LOG?performance.now():0;// `stopped` is disposePartial's flag, an apply arriving
// after teardown must do nothing, not resurrect GL state
// on an already-disposed renderer/context.
if(stopped||!isMounted())return null;if(!srcs){// A caller switching materials passes the new material's name.
const genMaterialName=applyMaterialName!==undefined?applyMaterialName:materialName;srcs=await generatePreviewSourcesWithinBudget({mx,gen,genContext,renderable,label,materialName:genMaterialName,isMounted,stageLightCount:PREVIEW_STAGE_LIGHT_COUNT,sceneFeatureOptions:previewFeatureOptions(renderSurface),allowConstInputs,transmission:getPreviewTransmission(renderSurface)});}// A thrown generation error is NOT caught here, it
// propagates like a first-build failure, so the UI shows
// the same overlay while the old material keeps rendering.
if(!srcs||!isMounted()||stopped)return null;prewarmDisplacementSources(srcs,isMounted,label);const warmResult=await prewarmShaderCompile({vs:srcs.vs,fs:srcs.fs,isMounted,label});// 'bailed' or a lost isMounted(): must not touch the
// still-rendering live material, leave it as-is; the
// superseding call owns the next apply.
if(warmResult==='bailed'||!isMounted()||stopped)return null;applyMaterialInternal(srcs,label);// Updates the handle's public fields IN PLACE: the
// object-literal shorthand below captures a snapshot,
// not a live binding, so every swap must re-assign these.
const handle=handleRef();handle.uniforms=uniforms;handle.introspected=srcs.introspected;handle.vs=srcs.vs;handle.fs=srcs.fs;materialNotices=srcs.notices||[];syncHandleNotices();handle.isTransparent=!!srcs.transparent;handle.syncDisplacementSources(srcs.displacement||null);// P4d stage 2: a material swap can change which (if any)
// UDIM refs are present; rebuild the split against the last
// file map this view saw, if any.
if(udimFileMap)applyUdimSplit(srcs.introspected,udimFileMap);if(window.MTLX_PERF_LOG){console.log('[mtlx-perf] applyMaterial total: '+(performance.now()-__applyPerfStart).toFixed(1)+'ms (target: '+label+')');}return handle;},// Syncs geometry to a (possibly unchanged) displacement program. Called by
// applyMaterial and by tryRefreshRenderView's in-place path; a changed key
// is debounced so a slider drag does not re-evaluate every value.
syncDisplacementSources:newDisplacement=>{if(stopped)return;displacementSources=newDisplacement||null;if(!displacementSources){dispRunner.cancel();if(dispRunner.getState().state!=='none'){swapMeshGeometry(originalGeometry);dispRunner.setSource(null);dispRunner.reset();syncHandleNotices();dispDispatchStatus();}return;}if(displacementSources.key===dispRunner.getSourceKey())return;dispRunner.cancel();dispRunner.setSource(displacementSources);// 150ms debounce so a slider-driven regeneration burst
// doesn't re-evaluate every intermediate value; mirrors the
// old inline setTimeout's guard order exactly.
dispRunner.debouncedEvaluate(()=>{if(stopped)return false;if(flat2d||!getDisplacementEnabled())return false;if(!baseGeometry)ensureBaseGeometry();bindDisplacementGeomprops();return true;});},// Reads the live `uniforms` closure binding (same one setUniforms
// uses), so a material swap is reflected without a stale copy.
isAnimated:()=>!!(uniforms&&(uniforms.u_time||uniforms.u_frame)),// Status snapshot: level/triangles/capped describe the current
// baseGeometry (0 until one is built); notices merges the
// subdivision and latest-evaluation notices.
getDisplacementState:()=>dispRunner.getState(),// Resolves once no evaluation is actively in flight (merely
// waiting on a file map does NOT count, that could hang forever).
whenDisplacementSettled:()=>dispRunner.settled(),// bindDroppedTextures calls this once per drop for every live
// view (see its header comment below); re-runs only when the
// displacement program actually samples a file.
onDisplacementFileMap:fileMap=>{dispRunner.setFileMap(fileMap);if(!flat2d&&getDisplacementEnabled()&&hasDisplacementFileRef(displacementSources)){runDisplacement();}},// P4d stage 2: bindDroppedTextures calls this once per drop for
// every live view (same pattern as onDisplacementFileMap above);
// splits custom geometry into per-UDIM-tile sub-meshes when the
// current material has UDIM refs. Not a core handle-contract
// name (guard (g) only reserves the HANDLE_CONTRACT list).
bindTextureFileMap:fileMap=>{udimFileMap=fileMap;applyUdimSplit(handleRef().introspected,fileMap);},getUdimTileCount:()=>udimTileCount},// end extras
// Handle data fields at publish time; the first-build displacement
// notices ran before the handle existed, so fold them in now.
fields:()=>({uniforms,introspected:firstSrcs.introspected,vs:firstSrcs.vs,fs:firstSrcs.fs,allowConstInputs,renderSurface,isTransparent:!!firstSrcs.transparent,notices:(materialNotices=firstSrcs.notices||[]).concat(currentDispNotices()),// bindDroppedTextures routes through the view's own session.
textureSession}),// Debug hook: raw GPU state for a headed diagnosis harness.
__debug:()=>({material:mesh?mesh.material:material,mesh,geometry,renderer}),// Content teardown; the session disposes the renderer afterwards.
dispose:()=>{stopped=true;if(dispRunner)dispRunner.cancel();try{if(material)material.dispose();}catch(e){/* already disposed/invalid */}try{if(geometry)geometry.dispose();}catch(e){/* ditto */}// `geometry` is whichever of these is active; the Set disposes the
// other two exactly once.
try{const dispGeoms=new Set([originalGeometry,baseGeometry,displacedGeometry].filter(Boolean));dispGeoms.delete(geometry);dispGeoms.forEach(g=>{try{g.dispose();}catch(e2){/* already disposed/invalid */}});}catch(e){/* best-effort */}// UDIM part meshes own their material clones; their geometries
// only own an index over shared attributes.
try{udimParts.forEach(p=>{try{if(p.material)p.material.dispose();}catch(e2){/* already disposed/invalid */}});udimParts=[];}catch(e){/* best-effort */}// Per-view GLB material clones; geometries are shared with other views.
try{if(sceneGroup){if(scene)scene.remove(sceneGroup);sceneOwnedMaterials.forEach(m=>{try{m.dispose();}catch(e){/* already disposed/invalid */}});}}catch(e){/* already disposed/invalid */}// F3: wrapper clones BEFORE the renderer (renderer.dispose clears
// the properties map onTextureDispose needs).
if(unsubTextureAnisotropy){unsubTextureAnisotropy();unsubTextureAnisotropy=null;}try{if(textureSession)textureSession.dispose();}catch(e){/* already disposed/invalid */}}};return content;};// createMtlxRenderView: persistent render-pipeline shell for one preview
// surface (renderer/scene/camera/env built ONCE; applyMaterial() swaps
// materials on the same shell) = render session + preview content.
const createMtlxRenderView=async opts=>MtlxRender.createRenderSession(Object.assign({},opts,{content:createPreviewContent(opts)})).start();// ---- public API ----
// ------------------------------------------------------------------
// Fullscreen helpers: native requestFullscreen when available; else a
// CSS-maximize fallback (position:fixed + synthesized 'fullscreenchange')
// for hosts that never grant it (VS Code webviews, iframes).
// ------------------------------------------------------------------
// True only when the platform will actually grant a requestFullscreen()
// call. False in VS Code webviews and in iframes lacking allowfullscreen.
const nativeFullscreenAvailable=()=>!!(document.fullscreenEnabled||document.webkitFullscreenEnabled);// Module-level state for the CSS-maximize fallback. null = nothing
// maximized; only one element can be maximized at a time (mirrors
// native semantics, keeps exit() unambiguous).
let cssMaxState=null;// Saves an element's literal `style` ATTRIBUTE, distinguishing "no
// attribute" from "style=''", so enter/exit can restore it exactly
// without clobbering framework-authored inline styles (React, etc.).
const cssMaxSaveStyleAttr=node=>({node,hadAttr:node.hasAttribute('style'),value:node.getAttribute('style')});const cssMaxRestoreStyleAttr=rec=>{try{if(rec.hadAttr)rec.node.setAttribute('style',rec.value);else rec.node.removeAttribute('style');}catch(e){/* node may have been removed from the DOM meanwhile */}};// Whether `cs` would make its element a containing block for, or
// clip, a `position:fixed` descendant: checked per the CSS spec
// (backdrop-filter/transform/filter/perspective/will-change/contain).
const cssMaxComputedIsTrap=cs=>{try{if(cs.backdropFilter&&cs.backdropFilter!=='none')return true;if(cs.webkitBackdropFilter&&cs.webkitBackdropFilter!=='none')return true;if(cs.transform&&cs.transform!=='none')return true;if(cs.filter&&cs.filter!=='none')return true;if(cs.perspective&&cs.perspective!=='none')return true;if(/transform|filter|perspective/.test(cs.willChange||''))return true;if(/paint|layout|strict|content/.test(cs.contain||''))return true;return false;}catch(e){return false;}};// Exit the current CSS-maximize, restoring everything it touched.
// Called both from toggleFullscreen (user-initiated exit) and from
// the MutationObserver below (auto-exit when el is disconnected).
const exitCssMaximize=()=>{const state=cssMaxState;if(!state)return;// Null the module state FIRST, before any teardown below, a
// re-entrant call (MutationObserver, rapid double toggle) then
// sees null and is a harmless no-op instead of double-restoring.
cssMaxState=null;try{state.domObserver.disconnect();}catch(e){/* already gone */}try{document.removeEventListener('keydown',state.keyHandler);}catch(e){/* ignore */}cssMaxRestoreStyleAttr(state.savedStyle);for(const rec of state.savedNeutralized)cssMaxRestoreStyleAttr(rec);try{document.body.style.overflow=state.savedBodyOverflow;}catch(e){/* ignore */}try{document.documentElement.style.overflow=state.savedHtmlOverflow;}catch(e){/* ignore */}// Same notification channel the native path uses, so watchFullscreen
// subscribers see this exit exactly like a native fullscreenchange.
try{document.dispatchEvent(new Event('fullscreenchange'));}catch(e){/* ignore */}};// Enter CSS-maximize on `el`. Caller (toggleFullscreen) guarantees
// cssMaxState is currently null, only one element maximizes at a time.
const enterCssMaximize=el=>{try{const savedStyle=cssMaxSaveStyleAttr(el);// Ancestor neutralization walk: anything between el and <body>
// that would trap a fixed-position descendant gets its trapping
// properties inlined away (style attribute saved first, reversible).
const savedNeutralized=[];for(let node=el.parentElement;node;node=node.parentElement){let trap=false;try{trap=cssMaxComputedIsTrap(getComputedStyle(node));}catch(e){trap=false;}if(!trap)continue;savedNeutralized.push(cssMaxSaveStyleAttr(node));try{node.style.backdropFilter='none';node.style.webkitBackdropFilter='none';node.style.transform='none';node.style.filter='none';node.style.perspective='none';node.style.willChange='auto';node.style.contain='none';}catch(e){/* stay defensive even though inline writes rarely throw */}if(node===document.body)break;}// Pins el over the viewport. zIndex 9990 stays below 9999 (body-
// portaled overlays). Starts below the sticky site header so it
// stays visible; collapses to full-viewport when the header is hidden.
try{const hdr=document.querySelector('#site-header header');const topPx=hdr?Math.max(0,hdr.getBoundingClientRect().bottom):0;el.style.position='fixed';el.style.top=topPx+'px';el.style.left='0';el.style.right='0';el.style.bottom='0';el.style.width='100%';// auto, not 100%: with top offset by topPx AND bottom pinned
// to 0, height:100% would overflow past the viewport bottom
// by topPx, auto lets top+bottom do the sizing instead.
el.style.height='auto';el.style.maxWidth='none';el.style.maxHeight='none';el.style.margin='0';el.style.zIndex='9990';el.style.backgroundColor=MtlxTheme.var('stage');}catch(e){// Couldn't style el at all, nothing was actually maximized,
// so undo the ancestor neutralization and bail rather than
// leaving cssMaxState pointing at a half-applied maximize.
for(const rec of savedNeutralized)cssMaxRestoreStyleAttr(rec);return;}const savedBodyOverflow=document.body.style.overflow;const savedHtmlOverflow=document.documentElement.style.overflow;document.body.style.overflow='hidden';document.documentElement.style.overflow='hidden';// Esc parity with native fullscreen. Bubble phase + document
// target so it doesn't need to compete with per-widget handlers.
const keyHandler=e=>{if(e.key==='Escape')exitCssMaximize();};document.addEventListener('keydown',keyHandler);// Native fullscreen auto-exits when the element leaves the
// document; CSS-maximize has no built-in equivalent, so a
// MutationObserver stands in, else body/html get stuck hidden.
const domObserver=new MutationObserver(()=>{if(!document.body.contains(el))exitCssMaximize();});domObserver.observe(document.body,{childList:true,subtree:true});cssMaxState={el,savedStyle,savedNeutralized,savedBodyOverflow,savedHtmlOverflow,keyHandler,domObserver};try{document.dispatchEvent(new Event('fullscreenchange'));}catch(e){/* ignore */}}catch(e){/* CSS maximize is best-effort; never throw into the caller */}};const fullscreenElement=()=>document.fullscreenElement||document.webkitFullscreenElement||(cssMaxState?cssMaxState.el:null);// Enter fullscreen on `el`, or exit if anything is fullscreen now.
const toggleFullscreen=el=>{try{if(!nativeFullscreenAvailable()){// CSS-maximize fallback (VS Code webview / no-allowfullscreen
// iframe). Same "exit whatever's active, else enter on el"
// shape as the native branch, native parity: never swaps targets.
if(cssMaxState)exitCssMaximize();else if(el)enterCssMaximize(el);return;}if(fullscreenElement()){const exit=document.exitFullscreen||document.webkitExitFullscreen;if(exit){const p=exit.call(document);if(p&&p.catch)p.catch(()=>{});}}else if(el){const req=el.requestFullscreen||el.webkitRequestFullscreen;if(req){const p=req.call(el);if(p&&p.catch)p.catch(()=>{});}}}catch(e){/* fullscreen can be denied (iframe policy, user gesture) */}};// Subscribe to fullscreen changes; cb receives the current fullscreen
// element (or null). Returns an unsubscribe function.
const watchFullscreen=cb=>{const h=()=>cb(fullscreenElement());document.addEventListener('fullscreenchange',h);document.addEventListener('webkitfullscreenchange',h);return()=>{document.removeEventListener('fullscreenchange',h);document.removeEventListener('webkitfullscreenchange',h);};};// Shared indeterminate loading bar used by the viewer/graph/preview
// views while a shader generates/compiles; injected once from the engine.
(()=>{if(typeof document==='undefined'||document.getElementById('mtlx-shared-css'))return;const st=document.createElement('style');st.id='mtlx-shared-css';st.textContent=['.mtlx-loading-bar{position:relative;overflow:hidden;height:6px;border-radius:9999px;background:rgb(var(--mtlx-chip));}','.mtlx-loading-bar::after{content:"";position:absolute;top:0;bottom:0;left:0;width:40%;border-radius:9999px;','background:linear-gradient(90deg,transparent,rgb(var(--mtlx-progress)),transparent);animation:mtlx-loading-slide 1.1s ease-in-out infinite;}',':root[data-theme-base="light"] .mtlx-loading-overlay{background-color:rgb(var(--mtlx-veil));}','@keyframes mtlx-loading-slide{from{transform:translateX(-100%);}to{transform:translateX(350%);}}'].join('');document.head.appendChild(st);})();// Custom highlight.js theme for the XML "Document" dialog, matching the
// site's dark gray-900/800 + blue-400 palette. Background is explicitly
// transparent so it doesn't paint over the dialog's own panel.
(()=>{if(typeof document==='undefined'||document.getElementById('mtlx-hljs-theme'))return;const st=document.createElement('style');st.id='mtlx-hljs-theme';st.textContent=['.hljs{color:rgb(var(--mtlx-code-fg));background:transparent;}','.hljs-tag,.hljs-punctuation{color:rgb(var(--mtlx-code-muted));}','.hljs-name{color:rgb(var(--mtlx-code-name));}','.hljs-attr{color:rgb(var(--mtlx-code-attr));}','.hljs-string{color:rgb(var(--mtlx-code-string));}','.hljs-comment{color:rgb(var(--mtlx-code-muted));font-style:italic;}','.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:rgb(var(--mtlx-code-syntax-keyword));}','.hljs-number,.hljs-symbol{color:rgb(var(--mtlx-code-syntax-number));}','.hljs-built_in,.hljs-type,.hljs-class .hljs-title,.hljs-title.class_{color:rgb(var(--mtlx-code-syntax-type));}','.hljs-title,.hljs-title.function_,.hljs-selector-id,.hljs-selector-class{color:rgb(var(--mtlx-code-syntax-function));}','.hljs-property,.hljs-variable,.hljs-params,.hljs-subst{color:rgb(var(--mtlx-code-syntax-param));}','.hljs-meta,.hljs-meta .hljs-keyword{color:rgb(var(--mtlx-code-syntax-directive));}'].join('');document.head.appendChild(st);})();Object.assign(window,{getMxEnv,DEBUG_SHADERS,mtlxWarn,mxExclusive,MTLX_CLOCK,clockTick,getForceTransparency,setForceTransparency,getPreviewTransmission,getDisplacementEnabled,setDisplacementEnabled,getTextureAnisotropy,setTextureAnisotropy,getDisplacementNormalsMode,setDisplacementNormalsMode,getPreviewSubdivisionLevel,setPreviewSubdivisionLevel,PREVIEW_TRIANGLE_BUDGET,pickSubdivisionLevel,createTriangleBudget,prepareDisplacementBase,createDisplacementRunner,getHeightToNormalTexel,setHeightToNormalTexel,parseUniforms,parseVertexInputs,stripVersion,encodeDisplay,countFragmentSamplers,mergeDuplicateImageNodes,mxNodeSignature,mxErr,mxWriteValue,vecToArray,mxSafe,mxElName,mxElCat,mxElType,mxElAttr,mxSetAttr,mxRemoveAttr,mxSetColorspace,nextFrame,findConvertChain,ensureTypedInput,stripValuesFromConnectedInputs,listDocRenderables,normPath,joinRefPath,readDroppedItems,expandZips,isHiddenSideFile,findFileForRef,findFilesForRef,preferKtx2Sibling,resolveIncludes,readMtlxText,readMtlxXml,isExportAttribution,splitXmlEnvelope,withXmlEnvelope,escapeXmlAttrSpecials,preserveSourceFormatting,TEXTURE_CACHE,TEXTURE_SOURCES,textureCacheKey,textureCacheKeyAsync,hasBlobIdentity,samplerCacheKey,normalizeSamplerAddressMode,collectImageSamplerModes,annotateFilenameSamplerModes,bindDroppedTextures,createTextureSession,createUdimVariantUniforms,loadExrTexture,loadHdrTexture,loadTifTexture,loadKtx2Texture,capKtx2MipLevels,runHeavyTextureDecode,loadBoundedBitmapTexture,resetTexturePerf,sceneTextureFastPathEnabled,readImageDimensions,boundDecodedTexture,collectMxUniforms,mxValueToThreeUniform,linToSrgb,srgbToLin,rgbToHex,hexToRgb,getFilenameDefaultTexture,rebindFilenameDefault,configureLoadedTexture,samplerHoldsDefault,prepGeometry,normalizeGeometry,buildPreviewGeometry,bindGeompropAttributes,loadCustomPreviewGeomFromFile,loadCustomPreviewGeomFromUrl,getCustomPreviewGeom,clearCustomPreviewGeom,getGlobalGeom,setGlobalGeom,getDisplayTransform,setDisplayTransform,getDisplayExposure,setDisplayExposure,displayExposureScale,applyThreeToneMappingChunk,getDisplayTransformValues,displayTransformId,sceneDisplayTransformGLSL:DISPLAY_TRANSFORM_SWITCH_GLSL,COLOR_VIEWABLE,resolveNodeKind,makeEnvTexture,getEnvironment,COLORSPACES,loadEnvironmentFromFile,loadEnvironmentFromBuffer,makeFlatEnvironment,setEnvOverride,getEnvOverride,getEnvironmentSource,getKeyLightEnabled,setKeyLightEnabled,envWithKeyLight,prewarmShaderCompile,createMtlxRenderView,compileMtlxSceneMaterial,createMtlxSceneUniforms,bindEnvironmentSamplers,createLightTransportUniforms,generatePreviewSources,generatePreviewSourcesWithinBudget,evaluateDisplacement,generateDisplacementSourcesUnlocked,detectDisplacementMode,ensurePrefilteredEnv,resolveShadingEnv,getSpecularEnvMethod,ensureConvolvedIrradiance,envIrradianceForShading,getDiffuseEnvMethod,setDiffuseEnvMethod,getDummyTexWhite,getDummyTex3DWhite,SHADOW_FACE_SLOTS,SHADOW_LIGHT_SLOTS_MAX,SHADOW_NORMAL_OFFSET_TEXELS,SHADOW_DEPTH_BIAS_TEXELS,createPeelPipeline,createRgbtPeelPipeline,applyPeelMaterialMode,registerLiveView,unregisterLiveView,releaseGlContext,snapshotRenderDestination,restoreRenderDestination,tryRefreshRenderView,prewarmPreviewTarget,checkTargetTransparency,EXPORT_TARGETS,generateTargetSources,fullscreenElement,toggleFullscreen,watchFullscreen});// Hands the render-session module (js/shared/render-session.js) the
// engine internals it needs at call time; must run after every const
// above is defined, so this stays the file's last line.
MtlxRender.bindEngine({getDisplayTransform,applyThreeToneMappingChunk,displayExposureScale,clockTick,createPeelPipeline,getForceTransparency,getEnvironment,getEnvOverride,resolveShadingEnv,makeEnvTexture,makeBackgroundTexture,parseEnvBuffer,buildEnvFromParsedTexture,displayTransformId,fullscreenElement,registerLiveView,unregisterLiveView,compileFilteringDriverNoise,enforceGlContextCap});