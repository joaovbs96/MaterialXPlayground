// Back-face thickness pass for transmissive solids (moved out of the Scene
// renderer in render parity P7): one exit-distance target per closed volume,
// budgeted, bound per object draw. Exports MtlxRender.createThicknessEffect.
(function () {
    'use strict';

    // Back-face distance for transmissive prims, the path length MaterialX's
    // volume absorption needs (see patchTransmissionThickness in
    // js/mtlx-engine.js). Renders only the far side of each transmissive mesh,
    // so a fragment can measure how much medium is still in front of it.
    // Layer the thickness pass draws, so it selects its meshes with a camera
    // mask instead of walking the scene graph every frame.
    const THICKNESS_LAYER = 1;
    // A thickness target is full drawing-buffer resolution and carries RGBA
    // distance plus a depth attachment. Keep the per-volume correction bounded:
    // crowded stages get an explicit material-reference fallback instead of one
    // volume borrowing another's exit distance. The accounting conservatively
    // reserves four bytes/pixel for the depth attachment; color is measured from
    // the selected Float/Half type.
    const THICKNESS_TARGET_MAX_ACTIVE = 4;
    const THICKNESS_TARGET_BUDGET_BYTES = 128 * 1024 * 1024;
    const THICKNESS_DEPTH_BYTES_PER_PIXEL = 4;
    const createThicknessMaterial = () => new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: [
            'in vec3 position;',
            'uniform mat4 modelMatrix;',
            'uniform mat4 modelViewMatrix;',
            'uniform mat4 projectionMatrix;',
            'out vec3 vWorld;',
            'void main() {',
            '    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;',
            '    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
            '}',
        ].join('\n'),
        fragmentShader: [
            'precision highp float;',
            'in vec3 vWorld;',
            'uniform vec3 uEye;',
            'uniform float uThicknessHandedness;',
            'out vec4 fragColor;',
            'void main() {',
            // Negative object determinants reverse gl_FrontFacing. Select the
            // physical exit face for both winding conventions without switching
            // the shared material/program between per-object target renders.
            '    bool exitFace = uThicknessHandedness >= 0.0 ? !gl_FrontFacing : gl_FrontFacing;',
            '    if (!exitFace) discard;',
            '    float d = distance(vWorld, uEye); fragColor = vec4(d, d, d, 1.0);',
            '}',
        ].join('\n'),
        // Far side only, nearest first: for a convex solid the nearest back face
        // IS where the ray leaves the medium, which is the segment Beer-Lambert
        // wants. A concave or multi-shell prop underestimates the path, which
        // errs toward clear rather than toward black.
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: true,
    });

    // host: renderer(), scene(), camera(), materials() (live material list),
    // warnings (array the plan warnings go into), scale() (world metres to
    // source scene units). Volumes are materials with userData.mtlxSceneVolume.
    const createThicknessEffect = (host) => {
        const THREE = window.THREE;
        const warnings = host.warnings;
        let thicknessMeshCache = null;
        let thicknessTopologyCache = new WeakMap();
        // `thicknessTarget` remains the first allocated target for the existing
        // diagnostic hook. Rendering and binding use the per-object map below.
        let thicknessTarget = null;
        const thicknessTargets = new Map();
        let thicknessInfo = {
            activeVolumes: 0, allocatedVolumes: 0, overflowVolumes: 0,
            bytesPerTarget: 0, bytesAllocated: 0, budgetBytes: THICKNESS_TARGET_BUDGET_BYTES,
            maxTargets: THICKNESS_TARGET_MAX_ACTIVE, targetType: null, targetFormat: 'RGBA',
            fallback: 'material-reference-distance', overflowPrims: [], unsupportedFallbackPrims: [], unsupportedTopologyPrims: [],
        };
        let thicknessDiagnosticPlanKey = null;
        let thicknessDiagnosticPlanRevision = 0;
        let thicknessUnsupportedFallbackPrims = [];
        let thicknessUnsupportedTopologyPrims = [];
        let thicknessBudgetWarning = null;
        let thicknessUnsupportedWarning = null;
        let thicknessTopologyWarning = null;
        const replaceThicknessWarning = (previous, next) => {
            if (previous && previous !== next) {
                const index = warnings.indexOf(previous);
                if (index >= 0) warnings.splice(index, 1);
            }
            if (next && warnings.indexOf(next) < 0) warnings.push(next);
            return next || null;
        };
        // Set after the per-volume maps are rendered. Each mesh's established
        // callback invokes this after its object matrices have been updated, so
        // shared material instances cannot retain a previous mesh's target.
        let applyObjectThickness = null;
        let thicknessMaterial = null;
        let thicknessDiscardMaterial = null;
        let thicknessCamera = null;
        const disposeThicknessResources = () => {
            thicknessTargets.forEach((target) => { try { target.dispose(); } catch (e) {} });
            thicknessTargets.clear();
            thicknessTarget = null;
            thicknessInfo = {
                activeVolumes: 0, allocatedVolumes: 0, overflowVolumes: 0,
                bytesPerTarget: 0, bytesAllocated: 0, budgetBytes: THICKNESS_TARGET_BUDGET_BYTES,
                maxTargets: THICKNESS_TARGET_MAX_ACTIVE, targetType: null, targetFormat: 'RGBA',
                fallback: 'material-reference-distance', overflowPrims: [], unsupportedFallbackPrims: [], unsupportedTopologyPrims: [],
            };
            applyObjectThickness = null;
            thicknessDiagnosticPlanKey = null;
            thicknessDiagnosticPlanRevision = 0;
            thicknessUnsupportedFallbackPrims = [];
            thicknessUnsupportedTopologyPrims = [];
            thicknessBudgetWarning = replaceThicknessWarning(thicknessBudgetWarning, null);
            thicknessUnsupportedWarning = replaceThicknessWarning(thicknessUnsupportedWarning, null);
            thicknessTopologyWarning = replaceThicknessWarning(thicknessTopologyWarning, null);
            if (thicknessMaterial) { thicknessMaterial.dispose(); thicknessMaterial = null; }
            if (thicknessDiscardMaterial) { thicknessDiscardMaterial.dispose(); thicknessDiscardMaterial = null; }
            thicknessCamera = null;
        };
        // Thickness is a separate volume participant set. In particular, the
        // shader injector reserves u_thicknessScale on opaque programs too;
        // that uniform is not evidence that a mesh belongs in this capture.
        const collectThicknessMeshes = (sceneRoot) => {
            if (thicknessMeshCache) return thicknessMeshCache;
            const list = [];
            sceneRoot.traverse((object) => {
                if (!object || !object.isMesh || !object.material) return;
                object.layers.disable(THICKNESS_LAYER);
                const mats = Array.isArray(object.material) ? object.material : [object.material];
                if (mats.some((m) => m && m.userData && m.userData.mtlxSceneVolume)) {
                    object.layers.enable(THICKNESS_LAYER);
                    list.push(object);
                }
            });
            thicknessMeshCache = list;
            return list;
        };
        // Determines whether this mesh can safely use one nearest-exit map.
        // Coordinate welding is intentional: BufferGeometry commonly splits
        // shared positions along UV or normal seams, which is still one shell.
        // Separate shells in one Mesh do not have an object-qualified exit at
        // every ray, so route those to the documented reference fallback.
        const thicknessTopology = (object) => {
            const cached = thicknessTopologyCache.get(object);
            const geometry = object && object.geometry;
            const position = geometry && geometry.getAttribute && geometry.getAttribute('position');
            const usesMaterialArray = Array.isArray(object && object.material);
            const materialsForObject = usesMaterialArray ? object.material : [object && object.material];
            const indexAttribute = geometry && geometry.index;
            const index = indexAttribute && indexAttribute.array;
            // BufferAttribute.count is Three's draw-count authority. Keep
            // the typed-array bound as a defensive cap for a partially
            // replaced attribute, but never traverse stale tail indices.
            const indexedCount = index && indexAttribute && Number.isFinite(indexAttribute.count)
                ? Math.min(index.length, indexAttribute.count)
                : (index ? index.length : 0);
            const vertexLimit = index ? indexedCount : (position ? position.count : 0);
            const drawRange = geometry && geometry.drawRange;
            const drawStart = Math.max(0, Math.min(vertexLimit, Math.floor(Number(drawRange && drawRange.start) || 0)));
            const requestedCount = Number(drawRange && drawRange.count);
            const drawEnd = Math.max(drawStart, Math.min(vertexLimit,
                Number.isFinite(requestedCount) ? drawStart + Math.max(0, Math.floor(requestedCount)) : vertexLimit));
            const signature = [position && position.version, position && position.count, indexAttribute && indexAttribute.version, indexAttribute && indexAttribute.count, index && index.length,
                drawStart, drawEnd, usesMaterialArray ? 1 : 0,
                geometry && geometry.groups ? geometry.groups.map((group) => [group.start, group.count, group.materialIndex].join(',')).join('|') : '',
                materialsForObject.map((material) => String(material && material.uuid || '') + ':' + Number(!!(material && material.userData && material.userData.mtlxSceneVolume))).join('|')].join(';');
            if (cached && cached.geometry === geometry && cached.position === position && cached.indexAttribute === indexAttribute && cached.signature === signature) return cached.result;
            const remember = (result) => {
                thicknessTopologyCache.set(object, { geometry, position, indexAttribute, signature, result });
                return result;
            };
            if (!geometry || !position || !position.count) {
                const invalid = { supported: false, reason: 'missing-position' };
                return remember(invalid);
            }
            const selectedRanges = (usesMaterialArray
                // Three renders no triangles for a material array when there
                // are no groups. Do not synthesize a slot-zero range here:
                // that would allocate an exit map for geometry absent from
                // the actual draw.
                ? (geometry.groups || [])
                    .map((group) => {
                        const start = Math.max(drawStart, Math.floor(Number(group.start) || 0));
                        const end = Math.min(drawEnd, Math.max(start, Math.floor(Number(group.start) || 0) + Math.max(0, Math.floor(Number(group.count) || 0))));
                        return { start, count: end - start, materialIndex: Number.isInteger(group.materialIndex) ? group.materialIndex : 0 };
                    })
                // A single Material renders the entire effective draw range;
                // group indices only choose slots for material arrays.
                : [{ start: drawStart, count: drawEnd - drawStart, materialIndex: 0 }])
                .filter((group) => {
                    // Three renders every group with a single Material even
                    // when BoxGeometry labels its faces 0..5. A material
                    // array, in contrast, makes group materialIndex an
                    // actual selection and invalid slots must stay absent.
                    const material = usesMaterialArray && group.materialIndex >= 0
                        ? materialsForObject[group.materialIndex]
                        : (!usesMaterialArray ? materialsForObject[0] : null);
                    return !!(material && material.userData && material.userData.mtlxSceneVolume);
                });
            const triangleVertexCount = selectedRanges.reduce((sum, group) => sum + Math.floor((group.count || 0) / 3) * 3, 0);
            if (!triangleVertexCount) {
                return remember({ supported: false, reason: 'no-volume-triangles' });
            }
            // Never allocate a target after inspecting only a prefix of a
            // large solid. Its omitted faces could make the apparent shell
            // closed while the rendered draw range is not.
            if (triangleVertexCount > 1500000) {
                return remember({ supported: false, reason: 'topology-unverified' });
            }
            const parent = new Int32Array(position.count);
            // Edge multiplicity needs a stable welded vertex identity. This
            // is deliberately separate from `parent`: after connectivity is
            // resolved every vertex in a closed shell has one component root,
            // which is not an edge endpoint identity.
            const weldedCoordinate = new Int32Array(position.count);
            for (let i = 0; i < parent.length; i++) parent[i] = i;
            const find = (value) => {
                let root = value;
                while (parent[root] !== root) root = parent[root];
                while (parent[value] !== value) { const next = parent[value]; parent[value] = root; value = next; }
                return root;
            };
            const join = (a, b) => {
                const left = find(a), right = find(b);
                if (left !== right) parent[right] = left;
            };
            const coordinateOwner = new Map();
            for (let vertex = 0; vertex < position.count; vertex++) {
                const key = [position.getX(vertex), position.getY(vertex), position.getZ(vertex)]
                    .map((value) => Math.round(value * 1e6)).join(',');
                const prior = coordinateOwner.get(key);
                if (prior == null) {
                    coordinateOwner.set(key, vertex);
                    weldedCoordinate[vertex] = vertex;
                } else {
                    weldedCoordinate[vertex] = prior;
                    join(vertex, prior);
                }
            }
            const used = new Set();
            const edges = new Map();
            const recordEdge = (a, b) => {
                const left = Math.min(a, b), right = Math.max(a, b), key = left + ':' + right;
                edges.set(key, (edges.get(key) || 0) + 1);
            };
            for (const group of selectedRanges) {
                const start = Math.max(0, Math.floor(group.start || 0));
                const end = Math.min(index ? index.length : position.count, start + Math.floor(group.count || 0));
                for (let offset = start; offset + 2 < end; offset += 3) {
                    const a = index ? index[offset] : offset;
                    const b = index ? index[offset + 1] : offset + 1;
                    const c = index ? index[offset + 2] : offset + 2;
                    if (a >= position.count || b >= position.count || c >= position.count) continue;
                    join(a, b); join(b, c); used.add(a); used.add(b); used.add(c);
                }
            }
            // Complete all coordinate/triangle unions before recording edge
            // ownership. A seam can join two roots later in the traversal;
            // recording before that would turn a closed BoxGeometry into six
            // apparent open faces.
            for (const group of selectedRanges) {
                const start = Math.max(0, Math.floor(group.start || 0));
                const end = Math.min(index ? index.length : position.count, start + Math.floor(group.count || 0));
                for (let offset = start; offset + 2 < end; offset += 3) {
                    const a = index ? index[offset] : offset;
                    const b = index ? index[offset + 1] : offset + 1;
                    const c = index ? index[offset + 2] : offset + 2;
                    if (a >= position.count || b >= position.count || c >= position.count) continue;
                    recordEdge(weldedCoordinate[a], weldedCoordinate[b]);
                    recordEdge(weldedCoordinate[b], weldedCoordinate[c]);
                    recordEdge(weldedCoordinate[c], weldedCoordinate[a]);
                }
            }
            const components = new Set(Array.from(used, find));
            const openEdges = Array.from(edges.values()).filter((count) => count !== 2).length;
            const result = components.size > 1
                ? { supported: false, reason: 'disconnected-shell-components', components: components.size, openEdges }
                : openEdges > 0
                    ? { supported: false, reason: 'non-watertight-volume', components: components.size, openEdges }
                    : { supported: true, reason: 'single-closed-shell', components: components.size, openEdges };
            return remember(result);
        };
        // Renders one back-face distance map per active solid. A shared map
        // cannot identify the entry surface: a disjoint projected volume can
        // otherwise replace another solid's exit distance. This intentionally
        // remains a single nearest exit per mesh, so concave/disconnected and
        // nested shells stay a documented clear-path limitation.
        const updateThickness = (sceneRoot) => {
            const renderer = host.renderer(), camera = host.camera(), scene = host.scene();
            const snapshotRendererDestination = () => window.snapshotRenderDestination(renderer);
            const restoreRendererDestination = (state) => window.restoreRenderDestination(renderer, state);
            const candidates = collectThicknessMeshes(sceneRoot).filter((object) => object.visible);
            const topology = candidates.map((object) => ({ object, topology: thicknessTopology(object) }));
            const topologyUnsupported = topology.filter((entry) => !entry.topology.supported);
            const list = topology.filter((entry) => entry.topology.supported).map((entry) => entry.object);
            // Geometry is rendered into the HDR presentation target when a
            // caller destination is bound. gl_FragCoord therefore indexes
            // that target, not the canvas drawing buffer.
            const destination = renderer.getRenderTarget();
            const size = destination
                ? new THREE.Vector2(destination.width, destination.height)
                : renderer.getDrawingBufferSize(new THREE.Vector2());
            const tw = Math.max(1, Math.floor(size.x));
            const th = Math.max(1, Math.floor(size.y));
            const floatOk = !!(renderer.capabilities && renderer.capabilities.isWebGL2)
                && !!renderer.extensions.get('EXT_color_buffer_float');
            const targetType = floatOk ? THREE.FloatType : THREE.HalfFloatType;
            const colorBytes = floatOk ? 16 : 8;
            const bytesPerTarget = tw * th * (colorBytes + THICKNESS_DEPTH_BYTES_PER_PIXEL);
            const ordered = list.slice().sort((a, b) => {
                const ak = String(a.userData?.primPath || a.name || '') + '|' + Number(a.userData?.instanceIndex ?? -1);
                const bk = String(b.userData?.primPath || b.name || '') + '|' + Number(b.userData?.instanceIndex ?? -1);
                return ak.localeCompare(bk);
            });
            // Select this frame's stable priority set before looking at the
            // cache. Retaining old entries first would make visibility churn
            // decide which volume overflows instead of the documented order.
            const capacity = Math.min(THICKNESS_TARGET_MAX_ACTIVE,
                Math.floor(THICKNESS_TARGET_BUDGET_BYTES / Math.max(1, bytesPerTarget)));
            // Consistency rule: a material with more volumes than fit the
            // budget uses the reference distance for all of them, so identical
            // pieces never split into two looks (thin shells measure near zero).
            const materialKeyOf = (object) => (Array.isArray(object.material) ? object.material : [object.material])
                .map((m) => (m && m.userData && m.userData.mtlxSceneMaterialPath) || '').join('|');
            const perMaterial = new Map();
            ordered.forEach((object) => { const k = materialKeyOf(object); perMaterial.set(k, (perMaterial.get(k) || 0) + 1); });
            const consistencyFallback = ordered.filter((object) => perMaterial.get(materialKeyOf(object)) > capacity);
            const selected = ordered.filter((object) => perMaterial.get(materialKeyOf(object)) <= capacity).slice(0, capacity);
            const active = new Set(selected);
            thicknessTargets.forEach((target, object) => {
                if (!active.has(object) || target.width !== tw || target.height !== th || target.texture.type !== targetType) {
                    try { target.dispose(); } catch (e) {}
                    thicknessTargets.delete(object);
                }
            });
            const allocated = [];
            const overflow = ordered.filter((object) => !active.has(object));
            for (const object of selected) {
                let target = thicknessTargets.get(object);
                if (!target) {
                    target = new THREE.WebGLRenderTarget(tw, th, {
                        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
                        format: THREE.RGBAFormat, type: targetType,
                        depthBuffer: true, stencilBuffer: false,
                    });
                    thicknessTargets.set(object, target);
                }
                allocated.push({ object, target });
            }
            thicknessTarget = allocated.length ? allocated[0].target : null;
            thicknessInfo = {
                activeVolumes: candidates.length, eligibleVolumes: ordered.length, allocatedVolumes: allocated.length, overflowVolumes: overflow.length,
                bytesPerTarget, bytesAllocated: allocated.length * bytesPerTarget,
                budgetBytes: THICKNESS_TARGET_BUDGET_BYTES, maxTargets: THICKNESS_TARGET_MAX_ACTIVE,
                targetType: floatOk ? 'FloatType' : 'HalfFloatType', targetFormat: 'RGBA + depth',
                fallback: 'material-reference-distance',
                overflowPrims: overflow.slice(0, 32).map((object) => String(object.userData?.primPath || object.name || 'unknown')),
                consistencyFallbackVolumes: consistencyFallback.length,
                unsupportedFallbackPrims: [],
                unsupportedTopologyPrims: topologyUnsupported.slice(0, 32).map(({ object, topology: info }) => ({
                    prim: String(object.userData?.primPath || object.name || 'unknown'), reason: info.reason,
                })),
            };
            // Warning collection is a plan diagnostic, not a draw operation.
            // Rebuilding/sorting it in each mesh callback made an overflowed
            // scene quadratic in its fallback count. Keep the complete report
            // current when the allocation/material plan changes, while every
            // draw below still writes its own live material binding.
            const fallbackMaterialState = overflow.map((object) => {
                const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
                const unsupported = objectMaterials.some((material) => {
                    if (!material || !material.uniforms || !material.uniforms.u_thicknessMap
                        || !material.uniforms.u_thicknessReferencePath) return false;
                    const reference = Number(material.uniforms.transmission_depth && material.uniforms.transmission_depth.value);
                    return !(Number.isFinite(reference) && reference > 0);
                });
                return {
                    prim: String(object.userData?.primPath || object.name || 'unknown'),
                    unsupported,
                    materials: objectMaterials.map((material) => {
                        const reference = Number(material?.uniforms?.transmission_depth?.value);
                        return String(material?.uuid || '') + ':' + (Number.isFinite(reference) && reference > 0 ? reference : 0);
                    }).join(','),
                };
            });
            const diagnosticPlanKey = [tw, th, targetType, capacity,
                ordered.map((object) => String(object.uuid || '') + ':' + String(object.userData?.primPath || object.name || '')).join('|'),
                fallbackMaterialState.map((entry) => entry.prim + ':' + entry.materials).join('|'),
                thicknessInfo.unsupportedTopologyPrims.map((entry) => entry.prim + ':' + entry.reason).join('|')].join(';');
            if (diagnosticPlanKey !== thicknessDiagnosticPlanKey) {
                thicknessDiagnosticPlanKey = diagnosticPlanKey;
                thicknessDiagnosticPlanRevision += 1;
                thicknessUnsupportedFallbackPrims = fallbackMaterialState
                    .filter((entry) => entry.unsupported).map((entry) => entry.prim).sort();
                thicknessUnsupportedTopologyPrims = thicknessInfo.unsupportedTopologyPrims.slice();
                const budgetWarning = overflow.length
                    ? '[info] Thickness target budget: ' + overflow.length + ' of ' + ordered.length
                        + ' volume instances use material-reference-distance fallback (' + thicknessInfo.bytesAllocated + ' / '
                        + THICKNESS_TARGET_BUDGET_BYTES + ' bytes; max ' + THICKNESS_TARGET_MAX_ACTIVE + ' targets)'
                    : null;
                const unsupportedWarning = thicknessUnsupportedFallbackPrims.length
                    ? '[info] Thickness target fallback has no scalar transmission_depth for '
                        + thicknessUnsupportedFallbackPrims.join(', ') + '; using clear path for unsupported graph'
                    : null;
                const topologyWarning = thicknessUnsupportedTopologyPrims.length
                    ? '[info] Thickness target fallback uses material-reference-distance for unsupported shell topology: '
                        + thicknessUnsupportedTopologyPrims.map((entry) => entry.prim + ' (' + entry.reason + ')').join(', ')
                    : null;
                thicknessBudgetWarning = replaceThicknessWarning(thicknessBudgetWarning, budgetWarning);
                thicknessUnsupportedWarning = replaceThicknessWarning(thicknessUnsupportedWarning, unsupportedWarning);
                thicknessTopologyWarning = replaceThicknessWarning(thicknessTopologyWarning, topologyWarning);
            }
            thicknessInfo.unsupportedFallbackPrims = thicknessUnsupportedFallbackPrims.slice(0, 32);
            thicknessInfo.unsupportedTopologyPrims = thicknessUnsupportedTopologyPrims.slice(0, 32);
            thicknessInfo.diagnosticPlanRevision = thicknessDiagnosticPlanRevision;
            if (!allocated.length) return { targets: thicknessTargets, width: tw, height: th };
            if (!thicknessMaterial) thicknessMaterial = createThicknessMaterial();
            if (!thicknessDiscardMaterial) {
                thicknessDiscardMaterial = new THREE.MeshBasicMaterial({
                    colorWrite: false, depthWrite: false, depthTest: false,
                });
            }
            thicknessMaterial.uniforms = thicknessMaterial.uniforms || {};
            thicknessMaterial.uniforms.uEye = thicknessMaterial.uniforms.uEye || { value: new THREE.Vector3() };
            thicknessMaterial.uniforms.uThicknessHandedness = thicknessMaterial.uniforms.uThicknessHandedness || { value: 1 };
            thicknessMaterial.uniforms.uEye.value.copy(camera.position);

            if (!thicknessCamera) thicknessCamera = camera.clone();
            thicknessCamera.copy(camera);
            thicknessCamera.layers.set(THICKNESS_LAYER);
            const previousDestination = snapshotRendererDestination();
            const previousClearColor = renderer.getClearColor(new THREE.Color());
            const previousClearAlpha = renderer.getClearAlpha();
            const previousOverrideMaterial = scene.overrideMaterial;
            const materialState = new Map();
            const visibleState = new Map();
            try {
                // Override material ignores geometry groups, so replace each
                // candidate mesh's slots explicitly. This keeps opaque
                // subgroups out of the map while retaining the transmissive
                // subgroup on a mixed USD mesh.
                ordered.forEach((object) => {
                    const original = object.material;
                    const mats = Array.isArray(original) ? original : [original];
                    materialState.set(object, original);
                    visibleState.set(object, object.visible);
                    const replacement = mats.map((material) => material && material.userData
                        && material.userData.mtlxSceneVolume ? thicknessMaterial : thicknessDiscardMaterial);
                    object.material = Array.isArray(original) ? replacement : replacement[0];
                });
                scene.overrideMaterial = null;
                renderer.setClearColor(0x000000, 1); // 0 distance means "no medium"
                for (const entry of allocated) {
                    ordered.forEach((object) => { object.visible = object === entry.object && visibleState.get(object); });
                    entry.object.updateMatrixWorld(true);
                    thicknessMaterial.uniforms.uThicknessHandedness.value = entry.object.matrixWorld.determinant() < 0 ? -1 : 1;
                    entry.target.viewport.set(0, 0, tw, th);
                    entry.target.scissorTest = false;
                    renderer.setRenderTarget(entry.target);
                    renderer.clear();
                    renderer.render(scene, thicknessCamera);
                }
                return { targets: thicknessTargets, width: tw, height: th };
            } finally {
                materialState.forEach((original, object) => { object.material = original; });
                visibleState.forEach((visible, object) => { object.visible = visible; });
                scene.overrideMaterial = previousOverrideMaterial;
                restoreRendererDestination(previousDestination);
                renderer.setClearColor(previousClearColor, previousClearAlpha);
            }
        };
        // Set a safe default for every generated material, then bind the
        // object-specific map from its draw callback. The callback runs after
        // object matrices and preserves shared material/instance correctness.
        const applyThickness = (state, width, height) => {
            const materials = host.materials(), thicknessScale = host.scale();
            const dummy = (window.getDummyTexWhite && window.getDummyTexWhite()) || null;
            const setMaterial = (material, target) => {
                if (!material || !material.uniforms) return;
                const reference = Number(material.uniforms.transmission_depth && material.uniforms.transmission_depth.value);
                const referencePath = target ? 0 : (Number.isFinite(reference) && reference > 0 ? reference : 0);
                // A classified volume with a real thickness source; require
                // u_opaqueColor too since the sampler budget can drop the
                // feature from the shader independently of thickness.
                if (material.uniforms.u_peelRefractsScene) {
                    const validThickness = !!target || referencePath > 0;
                    const wantsRefraction = !!material.uniforms.u_opaqueColor
                        && !!(material.userData && material.userData.mtlxSceneVolume) && validThickness;
                    material.uniforms.u_peelRefractsScene.value = wantsRefraction ? 1 : 0;
                }
                if (!material.uniforms.u_thicknessMap) return;
                material.uniforms.u_thicknessMap.value = target ? target.texture : dummy;
                if (material.uniforms.u_thicknessTexel && width && height) {
                    material.uniforms.u_thicknessTexel.value.set(1 / width, 1 / height);
                }
                if (material.uniforms.u_thicknessScale) material.uniforms.u_thicknessScale.value = target ? thicknessScale : 0;
                if (material.uniforms.u_thicknessTargetValid) material.uniforms.u_thicknessTargetValid.value = target ? 1 : 0;
                if (material.uniforms.u_thicknessReferencePath) {
                    material.uniforms.u_thicknessReferencePath.value = referencePath;
                }
            };
            // A helper/prepass can replace material uniforms. Restore the
            // safe fallback every frame before an actual object draw supplies
            // its object-qualified target below.
            for (const material of materials) setMaterial(material, null);
            applyObjectThickness = (object, objectMaterials) => {
                const target = state && state.targets ? state.targets.get(object) : null;
                objectMaterials.forEach((material) => setMaterial(material, target));
            };
        };
        return {
            layer: THICKNESS_LAYER,
            // Drops the mesh list and the topology verdicts (material create/replace).
            invalidate: () => {
                thicknessMeshCache = null;
                thicknessTopologyCache = new WeakMap();
            },
            topology: thicknessTopology,
            update: updateThickness,
            apply: applyThickness,
            applyObject: (object, objectMaterials) => {
                if (applyObjectThickness) applyObjectThickness(object, objectMaterials);
            },
            dispose: disposeThicknessResources,
            target: () => thicknessTarget,
            info: () => Object.assign({}, thicknessInfo),
        };
    };

    window.MtlxRender = Object.assign(window.MtlxRender || {}, { createThicknessEffect });
})();
