import { test, expect } from './lib/test-base.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function stageFixture() {
  const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
  return ['root.usda', 'nested/nested.usda', 'nested/materials/red.mtlx', 'nested/materials/blue.mtlx']
    .map(filePath => {
      const bytes = fs.readFileSync(path.join(fixtureRoot, filePath));
      return {
        path: filePath,
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    });
}

function instancedFixture() {
  const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
  return ['instanced-root.usda', 'nested/instanced.usda', 'nested/prototype.usda', 'nested/materials/red.mtlx', 'nested/materials/blue.mtlx']
    .map(filePath => {
      const bytes = fs.readFileSync(path.join(fixtureRoot, filePath));
      return {
        path: filePath,
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    });
}

function curvedPrototypeFixture() {
  const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
  return ['curved-reference-root.usda', 'nested/curved-instanced.usda', 'nested/curved-prototype.usda']
    .map(filePath => {
      const bytes = fs.readFileSync(path.join(fixtureRoot, filePath));
      return {
        path: filePath,
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    });
}

function directMeshPrototypeFixture() {
  const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
  return ['direct-mesh-reference-root.usda', 'nested/direct-mesh-instanced.usda']
    .map(filePath => {
      const bytes = fs.readFileSync(path.join(fixtureRoot, filePath));
      return {
        path: filePath,
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    });
}

test('@scene loadUsdStage extracts composed geometry and MaterialX in its Worker', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html');
  // Playwright serializes the fixture bytes as number arrays; the page then
  // creates its own ArrayBuffers, matching the browser File/ArrayBuffer API.
  const files = stageFixture().map(file => ({
    path: file.path,
    data: Array.from(new Uint8Array(file.data)),
  }));
  const result = await page.evaluate(async (serializedFiles) => {
    const files = serializedFiles.map(file => ({
      path: file.path,
      data: Uint8Array.from(file.data).buffer,
    }));
    const { loadUsdStage } = await import(`${location.origin}/js/usd/index.js`);
    const sizes = files.map(file => file.data.byteLength);
    const progress = [];
    const stage = await loadUsdStage({
      files,
      rootPath: 'root.usda',
      onProgress: value => progress.push(value),
    });
    return {
      meshes: stage.meshes.map(mesh => ({
        primPath: mesh.primPath,
        matrix: Array.from(mesh.matrix ?? []),
        materialPath: mesh.materialPath,
        indexCount: mesh.indices?.length ?? null,
        vertexCount: mesh.positions?.length ?? 0,
        groups: (mesh.groups ?? []).map(group => ({
          start: group.start,
          count: group.count,
          materialPath: group.materialPath ?? mesh.materialPath,
        })),
      })),
      materials: stage.materials.map(material => ({
        path: material.path,
        sourceAsset: material.sourceAsset,
        byteLength: material.materialX?.data?.byteLength ?? 0,
      })),
      sizes,
      sizesAfter: files.map(file => file.data.byteLength),
      progress,
    };
  }, files);

  expect(result.meshes).toHaveLength(2);
  expect(result.materials).toHaveLength(2);
  expect(result.meshes.map(mesh => mesh.primPath)).toEqual([
    '/Scene/RootTransform/NestedAsset/QuadWithSubset/Quad',
    '/Scene/RootTransform/NestedAsset/SharedMaterialTriangle/Triangle',
  ]);
  expect(result.materials.map(material => material.path)).toEqual([
    '/Scene/RootTransform/NestedAsset/Looks/RedMaterial',
    '/Scene/RootTransform/NestedAsset/Looks/BlueMaterial',
  ]);
  expect(result.meshes.some(mesh => Math.abs(mesh.matrix[12]) > 0.1 || Math.abs(mesh.matrix[13]) > 0.1)).toBe(true);
  for (const mesh of result.meshes) {
    const indexCount = mesh.indexCount ?? mesh.vertexCount / 3;
    if (mesh.groups?.length) {
      expect(mesh.groups.reduce((sum, group) => sum + group.count, 0)).toBe(indexCount);
    }
  }
  const quadGroups = result.meshes[0].groups;
  expect(quadGroups).toHaveLength(2);
  expect(quadGroups.map(group => group.materialPath).sort()).toEqual([
    '/Scene/RootTransform/NestedAsset/Looks/BlueMaterial',
    '/Scene/RootTransform/NestedAsset/Looks/RedMaterial',
  ]);
  expect(quadGroups.map(group => [group.start, group.count]).sort((a, b) => a[0] - b[0])).toEqual([
    [0, 6],
    [6, 6],
  ]);
  expect(result.materials.every(material => material.byteLength > 0)).toBe(true);
  expect(result.materials.map(material => material.sourceAsset)).toEqual([
    'nested/materials/red.mtlx',
    'nested/materials/blue.mtlx',
  ]);
  expect(result.sizesAfter).toEqual(result.sizes);
  expect(result.progress.length).toBeGreaterThanOrEqual(4);
  expect(result.progress[0]).toMatchObject({ phase: 'worker', done: 0, total: 4 });
  const fractions = result.progress.map(value => value.fraction);
  expect(fractions.every(value => Number.isFinite(value))).toBe(true);
  for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
  const fileProgress = result.progress.filter(value => value.phase === 'worker');
  expect(fileProgress.at(-1)).toMatchObject({ done: 4, total: 4 });
  expect(result.progress.some(value => value.phase === 'geometry' && value.done === value.total && value.total === 2)).toBe(true);
  expect(result.progress.at(-1)).toMatchObject({ phase: 'material', done: 1, total: 1 });
});

test('@scene loadUsdStage rejects an already cancelled request', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html');
  const files = stageFixture().map(file => ({
    path: file.path,
    data: Array.from(new Uint8Array(file.data)),
  }));
  const errorName = await page.evaluate(async (serializedFiles) => {
    const { loadUsdStage } = await import(`${location.origin}/js/usd/index.js`);
    const controller = new AbortController();
    controller.abort();
    try {
      await loadUsdStage({
        files: serializedFiles.map(file => ({ path: file.path, data: Uint8Array.from(file.data).buffer })),
        rootPath: 'root.usda',
        signal: controller.signal,
      });
      return null;
    } catch (error) {
      return error.name;
    }
  }, files);
  expect(errorName).toBe('AbortError');
});

test('@scene extracts nested PointInstancer matrices and prototype material bindings', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html');
  const files = instancedFixture().map(file => ({
    path: file.path,
    data: Array.from(new Uint8Array(file.data)),
  }));
  const result = await page.evaluate(async (serializedFiles) => {
    const { loadUsdStage } = await import(`${location.origin}/js/usd/index.js`);
    const stage = await loadUsdStage({
      files: serializedFiles.map(file => ({ path: file.path, data: Uint8Array.from(file.data).buffer })),
      rootPath: 'instanced-root.usda',
    });
    return {
      meshes: stage.meshes.map(mesh => ({
        path: mesh.primPath,
        owner: mesh.instanceOwnerPath ?? null,
        matrix: Array.from(mesh.matrix ?? []),
        instances: (mesh.instanceMatrices ?? []).map(matrix => Array.from(matrix)),
        materialPath: mesh.materialPath ?? null,
        positions: Array.from(mesh.positions ?? []),
        indices: Array.from(mesh.indices ?? []),
        groups: (mesh.groups ?? []).map(group => ({
          start: group.start,
          count: group.count,
          materialPath: group.materialPath ?? mesh.materialPath,
        })),
      })),
      materials: stage.materials.map(material => material.path),
      warnings: stage.warnings,
    };
  }, files);

  const instanceMeshes = result.meshes.filter(mesh => mesh.instances.length);
  expect(instanceMeshes.length).toBeGreaterThan(0);
  expect(result.materials.filter(path => /(?:Red|Blue)Material$/.test(path))).toHaveLength(2);
  expect(result.warnings.filter(warning => /PointInstancer/i.test(warning))).toEqual([]);
  expect(instanceMeshes.map(mesh => mesh.materialPath).sort()).toEqual([
    expect.stringMatching(/\/BlueMaterial$/),
    expect.stringMatching(/\/RedMaterial$/),
  ]);
  const instanceTranslations = instanceMeshes[0].instances.map(matrix => matrix.slice(12, 15).join(','));
  expect(new Set(instanceTranslations).size).toBe(2);
  for (const mesh of instanceMeshes) {
    expect(mesh.owner).toBe('/Scene/ParentTransform/Instances');
    expect(mesh.instances).toHaveLength(2);
    expect(mesh.instances.every(matrix => matrix.length === 16 && matrix.every(Number.isFinite))).toBe(true);
    expect(mesh.matrix).toHaveLength(16);
    // The referenced asset has a nonidentity translate/rotate/scale transform.
    expect(Math.abs(mesh.matrix[12]) + Math.abs(mesh.matrix[13]) + Math.abs(mesh.matrix[14])).toBeGreaterThan(0.1);
    expect(mesh.positions.some(value => Math.abs(value) > 0.01)).toBe(true);
    const indexCount = mesh.indices.length;
    if (mesh.groups.length) {
      expect(mesh.groups.every(group => group.materialPath === mesh.materialPath)).toBe(true);
      expect(mesh.groups.reduce((sum, group) => sum + group.count, 0)).toBe(indexCount);
    }
  }
});

test('@scene exposes composed prototype normals for safe instance recovery', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html');
  const files = curvedPrototypeFixture().map(file => ({
    path: file.path,
    data: Array.from(new Uint8Array(file.data)),
  }));
  const result = await page.evaluate(async serializedFiles => {
    const { loadUsdStage } = await import(`${location.origin}/js/usd/index.js`);
    const stage = await loadUsdStage({
      files: serializedFiles.map(file => ({ path: file.path, data: Uint8Array.from(file.data).buffer })),
      rootPath: 'curved-reference-root.usda',
    });
    return {
      warnings: stage.warnings,
      meshes: stage.meshes.map(mesh => ({
        path: mesh.primPath,
        positions: Array.from(mesh.positions ?? []),
        normals: Array.from(mesh.normals ?? []),
        uvs: Array.from(mesh.uvs ?? []),
        indices: Array.from(mesh.indices ?? []),
        instances: mesh.instanceMatrices?.length ?? 0,
        owner: mesh.instanceOwnerPath ?? null,
      })),
    };
  }, files);

  expect(result.warnings).toEqual([]);
  const ordinary = result.meshes.find(mesh => mesh.path === '/Scene/OrdinaryPrototype/Curved');
  const instanced = result.meshes.find(mesh => mesh.path === '/Scene/Instanced/Instances/__instances__/Prototype/Curved');
  expect(ordinary).toBeTruthy();
  expect(instanced).toBeTruthy();
  expect(ordinary.positions.some(value => Math.abs(value - 1.25) < 1e-6)).toBe(true);
  expect(ordinary.normals.length).toBe(ordinary.positions.length);
  expect(instanced.normals).toEqual(ordinary.normals);
  expect(instanced.instances).toBe(2);
  expect(instanced.positions).toEqual(ordinary.positions);
  expect(instanced.uvs).toEqual(ordinary.uvs);
  expect(instanced.indices.length).toBe(instanced.positions.length / 3);
  expect(instanced.indices.every((value, index) => value === index)).toBe(true);

  // The duplicated U seam has distinct UVs, while the authored cap/body
  // normals at coincident boundary positions remain a deliberate hard edge.
  const seamIndices = [];
  for (let i = 0; i < ordinary.positions.length / 3; i++) {
    if (ordinary.positions[i * 3] === 1 && ordinary.positions[i * 3 + 2] === 0) seamIndices.push(i);
  }
  expect(seamIndices.length).toBeGreaterThanOrEqual(2);
  expect(new Set(seamIndices.map(i => ordinary.uvs[i * 2])).size).toBeGreaterThan(1);
  const edgeNormals = [];
  for (let i = 0; i < ordinary.positions.length / 3; i++) {
    if (ordinary.positions[i * 3] === 1 && ordinary.positions[i * 3 + 1] === -1 && ordinary.positions[i * 3 + 2] === 0) {
      edgeNormals.push(ordinary.normals.slice(i * 3, i * 3 + 3));
    }
  }
  expect(edgeNormals.some(normal => normal[0] > 0.9 && Math.abs(normal[1]) < 0.1)).toBe(true);
  expect(edgeNormals.some(normal => normal[1] < -0.9)).toBe(true);
});

test('@scene recovers normals when a PointInstancer targets a Mesh directly', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html');
  const files = directMeshPrototypeFixture().map(file => ({
    path: file.path,
    data: Array.from(new Uint8Array(file.data)),
  }));
  const result = await page.evaluate(async serializedFiles => {
    const { loadUsdStage } = await import(`${location.origin}/js/usd/index.js`);
    const stage = await loadUsdStage({
      files: serializedFiles.map(file => ({ path: file.path, data: Uint8Array.from(file.data).buffer })),
      rootPath: 'direct-mesh-reference-root.usda',
    });
    return {
      warnings: stage.warnings,
      meshes: stage.meshes.map(mesh => ({
        path: mesh.primPath,
        positions: Array.from(mesh.positions ?? []),
        normals: Array.from(mesh.normals ?? []),
        instances: mesh.instanceMatrices?.length ?? 0,
      })),
    };
  }, files);
  expect(result.warnings).toEqual([]);
  const ordinary = result.meshes.find(mesh => mesh.path === '/Scene/OrdinaryPrototype');
  const instanced = result.meshes.find(mesh => /\/__instances__\/PrototypeMesh\/?$/.test(mesh.path));
  expect(ordinary).toBeTruthy();
  expect(instanced).toBeTruthy();
  expect(ordinary.normals).toHaveLength(9);
  ordinary.normals.forEach((value, index) => expect(value).toBeCloseTo([0, 0.6, 0.8][index % 3], 5));
  expect(instanced.normals).toEqual(ordinary.normals);
  expect(instanced.instances).toBe(2);
});

test('@scene keeps large native mesh views valid (optional Lion asset)', async ({ page, embedURL }) => {
  const lionRoot = process.env.USD_LION_ROOT || '';
  test.skip(!lionRoot || !fs.existsSync(lionRoot), 'Set USD_LION_ROOT to the supplied Lion lion.usda to run the large-stage lifetime check.');
  const rootDir = path.dirname(lionRoot);
  const relative = ['lion.usda', 'Geometry/lion_statue_lq.usd', 'Looks/lion_ldX.mtlx'];
  const files = relative.map(filePath => ({
    name: filePath,
    mimeType: filePath.endsWith('.mtlx') ? 'text/xml' : 'application/octet-stream',
    buffer: fs.readFileSync(path.join(rootDir, filePath)),
  }));
  await page.goto(embedURL + '/index.html#!scene');
  await page.locator('input[type=file]').first().setInputFiles(files);
  const result = await page.evaluate(async () => {
    const { loadUsdStage } = await import('/js/usd/index.js');
    const input = document.querySelector('input[type=file]');
    const stage = await loadUsdStage({
      files: Array.from(input.files).map(data => ({ path: data.name, data })),
      rootPath: 'lion.usda',
    });
    return {
      meshes: stage.meshes.map(mesh => ({ path: mesh.primPath, positions: mesh.positions?.length ?? 0, normals: mesh.normals?.length ?? 0 })),
      materials: stage.materials.length,
    };
  });
  expect(result.meshes.map(mesh => mesh.path)).toEqual(['/Statue/statue/statue', '/Statue/base/base']);
  expect(result.meshes.every(mesh => mesh.positions > 0 && mesh.normals === mesh.positions)).toBe(true);
  expect(result.materials).toBeGreaterThan(0);
});
