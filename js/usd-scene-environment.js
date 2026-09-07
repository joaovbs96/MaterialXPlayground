// USD scene environment bridge. The studio geometry/material is exported by
// mtlx-engine.js so this view shares the material viewer's exact appearance.
(() => {
    const modes = new Set(['studio', 'studio-dark', 'environment', 'none']);

    const createUsdSceneEnvironment = ({ scene, renderer, camera, contentRoot, THREE = window.THREE } = {}) => {
        if (!scene || !renderer || !THREE) throw new Error('USD scene environment requires a Three.js scene and renderer.');
        const studio = window.MtlxStudio;
        if (!studio || typeof studio.createUsdSceneStudioMaterial !== 'function'
            || typeof studio.createUsdSceneStudioLight !== 'function' || typeof studio.placeUsdSceneStudioLight !== 'function') {
            throw new Error('MaterialX studio environment is unavailable in this build.');
        }
        if (renderer.shadowMap) {
            renderer.shadowMap.enabled = true;
            renderer.shadowMap.type = THREE.VSMShadowMap;
        }
        const root = new THREE.Group();
        root.name = '__usd-scene-environment';
        root.userData.usdSceneEnvironment = true;
        root.userData.excludeFromFrame = true;
        const geometry = typeof studio.getUsdSceneStudioGeometry === 'function' ? studio.getUsdSceneStudioGeometry() : null;
        const studioMesh = geometry ? new THREE.Mesh(geometry, studio.createUsdSceneStudioMaterial(false)) : null;
        const catcherGeometry = typeof studio.getUsdSceneStudioCatcherGeometry === 'function' ? studio.getUsdSceneStudioCatcherGeometry() : null;
        const catcherMaterial = catcherGeometry && THREE.ShadowMaterial ? new THREE.ShadowMaterial({ opacity: 0.28, side: THREE.BackSide }) : null;
        const studioCatcher = catcherGeometry && catcherMaterial ? new THREE.Mesh(catcherGeometry, catcherMaterial) : null;
        if (studioMesh) {
            studioMesh.name = '__usd-scene-studio-cyclorama';
            studioMesh.userData.usdSceneEnvironment = true;
            studioMesh.userData.excludeFromFrame = true;
            studioMesh.renderOrder = -900;
            root.add(studioMesh);
        }
        if (studioCatcher) {
            studioCatcher.name = '__usd-scene-studio-shadow-catcher';
            studioCatcher.userData.usdSceneEnvironment = true;
            studioCatcher.userData.excludeFromFrame = true;
            studioCatcher.receiveShadow = true;
            studioCatcher.material.depthWrite = false;
            studioCatcher.renderOrder = -800;
            root.add(studioCatcher);
        }

        // Shared with the material viewer's studio backdrop so the cast
        // shadow gets the engine's VSM softness and depth bracket instead
        // of a hand copy (js/mtlx-engine.js createUsdSceneStudioLight).
        const { light: studioLight, target: studioLightTarget } = studio.createUsdSceneStudioLight(1);
        studioLight.name = '__usd-scene-studio-key';
        studioLight.userData.usdSceneEnvironment = true;
        studioLight.userData.excludeFromFrame = true;
        studioLightTarget.name = '__usd-scene-studio-key-target';
        studioLightTarget.userData.usdSceneEnvironment = true;
        root.add(studioLight, studioLightTarget);

        // The engine's prepared background texture has the correct flipY and
        // color setup. A mirrored sphere preserves its equirect orientation.
        const skyGeometry = new THREE.SphereGeometry(1, 64, 32);
        skyGeometry.scale(-1, 1, 1);
        const skyMaterial = new THREE.MeshBasicMaterial({ side: THREE.FrontSide, depthWrite: false, depthTest: false, toneMapped: true });
        const environmentSky = new THREE.Mesh(skyGeometry, skyMaterial);
        environmentSky.name = '__usd-scene-environment-sky';
        environmentSky.userData.usdSceneEnvironment = true;
        environmentSky.userData.excludeFromFrame = true;
        environmentSky.renderOrder = -1000;
        environmentSky.visible = false;
        root.add(environmentSky);
        scene.add(root);

        let currentEnv = null;
        let mode = 'studio';
        let rotation = 0;
        let exposure = 1;
        let disposed = false;
        let bounds = null;
        let studioScale = 1;
        const baseRotation = Number(studio.backdropBaseRotation) || Math.PI;
        const rotationSign = Number(studio.backdropRotationSign) || -1;

        let envDirection = null;
        const isStudio = () => mode === 'studio' || mode === 'studio-dark';
        const rotatedEnvDirection = () => {
            const source = envDirection;
            if (!source) return null;
            const direction = source.clone ? source.clone() : new THREE.Vector3(Number(source[0]) || 0, Number(source[1]) || 0, Number(source[2]) || -1);
            if (typeof studio.keyLightRotationMatrix === 'function') direction.applyMatrix4(studio.keyLightRotationMatrix(rotation));
            return direction.normalize();
        };
        const updateLight = () => {
            if (!bounds) return;
            const center = bounds.getCenter(new THREE.Vector3());
            const direction = rotatedEnvDirection() || new THREE.Vector3(-0.4, -1.0, 0.7).normalize();
            studio.placeUsdSceneStudioLight(studioLight, center, direction, studioScale);
        };
        const applyVisibility = () => {
            if (studioMesh) studioMesh.visible = isStudio();
            if (studioCatcher) studioCatcher.visible = isStudio();
            studioLight.visible = isStudio();
            // Shadow only: MaterialX RawShaderMaterials ignore three lights.
            studioLight.intensity = 0;
            environmentSky.visible = mode === 'environment' && !!skyMaterial.map;
            if (renderer.setClearColor) renderer.setClearColor(0x111827, mode === 'none' ? 0 : 1);
        };
        const setBackdrop = (nextMode) => {
            mode = modes.has(nextMode) ? nextMode : 'studio';
            if (studioMesh) {
                if (typeof studio.applyUsdSceneStudioVariant === 'function') studio.applyUsdSceneStudioVariant(studioMesh.material, mode === 'studio-dark');
            }
            if (studioCatcher) studioCatcher.material.opacity = mode === 'studio-dark' ? 0.4 : 0.28;
            applyVisibility();
            return mode;
        };
        const setEnvironment = (env) => {
            if (!env || disposed) return false;
            currentEnv = env;
            envDirection = env.keyLight && env.keyLight.direction || env.softKeyDir || null;
            updateLight();
            skyMaterial.map = env.background || env.radiance || null;
            skyMaterial.needsUpdate = true;
            // Do not assign the shared equirect to scene.environment: r128's
            // WebGLCubeMaps uploads it via fromEquirectangularTexture, which
            // swaps minFilter to LinearFilter for that first upload and never
            // re-uploads, permanently stripping the mip chain FIS needs.
            applyVisibility();
            return true;
        };
        const setRotation = (radians) => {
            rotation = Number.isFinite(Number(radians)) ? Number(radians) : 0;
            environmentSky.rotation.y = baseRotation + rotationSign * rotation;
            updateLight();
            return rotation;
        };
        const setExposure = (value) => {
            exposure = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 1;
            if ('toneMappingExposure' in renderer) renderer.toneMappingExposure = exposure;
            return exposure;
        };
        const refreshDisplayTransform = () => {
            if (studioMesh && studio && typeof studio.refreshUsdSceneStudioMaterial === 'function') {
                studio.refreshUsdSceneStudioMaterial(studioMesh.material, mode === 'studio-dark');
            }
        };
        const updateBounds = (box) => {
            if (!box || !box.isBox3) return;
            bounds = box.clone ? box.clone() : box;
            const size = bounds.getSize(new THREE.Vector3());
            const radius = Math.max(size.x, size.y, size.z) || 1;
            const center = bounds.getCenter(new THREE.Vector3());
            // The Viewer's studio surrounds a shaderball of diameter about 2 at
            // scale 1, so treat the scene's largest extent as that diameter
            // (radius / 2) instead of radius / 8, matching the Viewer's ratio.
            studioScale = radius / 2;
            if (studioMesh) {
                studioMesh.scale.setScalar(studioScale);
                studioMesh.position.set(center.x, bounds.min.y - radius * 0.03, center.z);
            }
            if (studioCatcher) {
                studioCatcher.scale.setScalar(studioScale);
                studioCatcher.position.set(center.x, bounds.min.y - radius * 0.03, center.z);
            }
            updateLight();
            environmentSky.position.copy(center);
        };
        const update = () => {
            if (disposed || !camera) return;
            const far = Number(camera.far) || 100;
            const distance = Math.max(10, far * 0.45);
            environmentSky.scale.setScalar(distance);
            environmentSky.position.copy(camera.position);
            if (studioMesh && bounds) studioMesh.position.y = bounds.min.y - Math.max(0.01, Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z) * 0.003);
            if (studioCatcher && bounds) studioCatcher.position.y = bounds.min.y - Math.max(0.01, Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z) * 0.003);
        };
        // Both updateBounds and update keep studioMesh/studioCatcher in sync
        // at the same world Y, so reading either back gives the floor's
        // current position without duplicating the offset math here.
        const getFloorY = () => {
            if (!bounds) return null;
            if (studioMesh) return studioMesh.position.y;
            if (studioCatcher) return studioCatcher.position.y;
            return null;
        };
        const getFloorClearance = () => (Number(studio.studioFloorClearance) || 0) * studioScale;
        const reset = async () => {
            const getter = window.getEnvironment;
            if (typeof getter === 'function') {
                const env = await getter();
                if (env && !disposed) setEnvironment(env);
            }
            setRotation(0);
            setExposure(1);
            setBackdrop('studio');
            return currentEnv;
        };
        setRotation(0);
        setExposure(1);
        applyVisibility();

        return {
            root,
            contentRoot,
            setBackdrop,
            getBackdrop: () => mode,
            isStudio,
            getFloorY,
            getFloorClearance,
            setEnvironment,
            getEnvironment: () => currentEnv,
            setEnvRotation: setRotation,
            getEnvRotation: () => rotation,
            setEnvExposure: setExposure,
            refreshDisplayTransform,
            getEnvExposure: () => exposure,
            updateBounds,
            update,
            getStudioScale: () => studioScale,
            reset,
            dispose: () => {
                if (disposed) return;
                disposed = true;
                scene.remove(root);
                if (studioMesh) { studioMesh.geometry.dispose(); studioMesh.material.dispose(); }
                if (studioCatcher) { studioCatcher.geometry.dispose(); studioCatcher.material.dispose(); }
                studioLight.shadow.map && studioLight.shadow.map.dispose();
                skyGeometry.dispose();
                skyMaterial.dispose();
            },
        };
    };

    window.createUsdSceneEnvironment = createUsdSceneEnvironment;
    window.UsdSceneEnvironment = { create: createUsdSceneEnvironment };
})();
