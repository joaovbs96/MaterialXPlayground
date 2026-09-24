// Unit coverage for scripts/lib/vendor/outputs.mjs: marked-block
// splicing, the vendor-deps.js renderer (via vm), and manifest ordering.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { buildManifest, serializeManifest, renderGitignoreBlock, renderVscodeignoreBlock, spliceMarkedBlock, renderVendorDepsJs } from "../../scripts/lib/vendor/outputs.mjs";
import { resolveDeps } from "../../scripts/lib/vendor/registry.mjs";

const DEPS = resolveDeps([
  { id: "b-dep", name: "B", fetchOnly: true, source: { npm: "b", files: { "a.js": "a.js" } }, license: { url: "https://example.com/b" } },
  { id: "a-dep", name: "A", vscode: false, source: { npm: "a", files: { "a.js": "a.js" } }, license: { url: "https://example.com/a" } },
]);

test("buildManifest sorts deps by id and entries by code-unit path", () => {
  const entries = [
    { path: "z/file.js", dep: "b-dep", source: "b@1.0.0", sha256: "0".repeat(64), bytes: 1 },
    { path: "A/file.js", dep: "a-dep", source: "a@1.0.0", sha256: "1".repeat(64), bytes: 2 },
    { path: "a/file.js", dep: "a-dep", source: "a@1.0.0", sha256: "2".repeat(64), bytes: 3 },
  ];
  const manifest = buildManifest(DEPS, entries);
  assert.deepEqual(manifest.deps.map((d) => d.id), ["a-dep", "b-dep"]);
  // "A/file.js" (uppercase, code unit 65) sorts before "a/file.js" (97) and "z/file.js".
  assert.deepEqual(manifest.entries.map((e) => e.path), ["A/file.js", "a/file.js", "z/file.js"]);
  assert.equal(manifest.generatedBy, "scripts/vendor.mjs");
});

test("serializeManifest ends with a trailing newline", () => {
  const text = serializeManifest({ generatedBy: "x", deps: [], entries: [] });
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(JSON.parse(text), { generatedBy: "x", deps: [], entries: [] });
});

test("gitignore block lists only fetchOnly deps", () => {
  const block = renderGitignoreBlock(DEPS);
  assert.match(block, /^# BEGIN vendor-deps:/);
  assert.match(block, /^vendor\/b-dep\/$/m);
  assert.doesNotMatch(block, /a-dep/);
  assert.match(block, /# END vendor-deps$/);
});

test("vscodeignore block lists only vscode:false deps", () => {
  const block = renderVscodeignoreBlock(DEPS);
  assert.match(block, /^vendor\/a-dep\/\*\*$/m);
  assert.doesNotMatch(block, /b-dep/);
});

test("spliceMarkedBlock replaces an existing block in place", () => {
  const original = "before\n# BEGIN vendor-deps: old\nold line\n# END vendor-deps\nafter\n";
  const result = spliceMarkedBlock(original, "# BEGIN vendor-deps: new\nnew line\n# END vendor-deps");
  assert.equal(result, "before\n# BEGIN vendor-deps: new\nnew line\n# END vendor-deps\nafter\n");
});

test("spliceMarkedBlock is idempotent", () => {
  const original = "before\n# BEGIN vendor-deps: x\nold\n# END vendor-deps\nafter\n";
  const block = "# BEGIN vendor-deps: x\nnew\n# END vendor-deps";
  const once = spliceMarkedBlock(original, block);
  const twice = spliceMarkedBlock(once, block);
  assert.equal(once, twice);
});

test("spliceMarkedBlock appends when markers are missing", () => {
  const result = spliceMarkedBlock("existing line\n", "# BEGIN vendor-deps: x\nline\n# END vendor-deps");
  assert.equal(result, "existing line\n# BEGIN vendor-deps: x\nline\n# END vendor-deps\n");
});

test("spliceMarkedBlock normalizes CRLF input to LF", () => {
  const original = "before\r\n# BEGIN vendor-deps: x\r\nold\r\n# END vendor-deps\r\nafter\r\n";
  const result = spliceMarkedBlock(original, "# BEGIN vendor-deps: x\nnew\n# END vendor-deps");
  assert.ok(!result.includes("\r"));
  assert.equal(result, "before\n# BEGIN vendor-deps: x\nnew\n# END vendor-deps\nafter\n");
});

test("vendor-deps.js is deterministic and yields the expected shape", () => {
  const manifestEntries = [
    { path: "a-dep/a.js", dep: "a-dep", source: "a@2.3.4", sha256: "1".repeat(64), bytes: 10 },
    { path: "b-dep/a.js", dep: "b-dep", source: "b@5.6.7", sha256: "2".repeat(64), bytes: 20 },
  ];
  const first = renderVendorDepsJs(DEPS, manifestEntries);
  const second = renderVendorDepsJs(DEPS, manifestEntries);
  assert.equal(first, second);

  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(first, context);
  // Round-tripped through JSON: the vm context is a separate realm, so its
  // plain objects aren't deepStrictEqual-comparable to main-realm literals.
  const deps = JSON.parse(JSON.stringify(context.window.MTLX_VENDOR_DEPS));
  assert.deepEqual(Object.keys(deps), ["a-dep", "b-dep"]);
  assert.deepEqual(deps["a-dep"], { dir: "a-dep", name: "A", version: "2.3.4", licenseUrl: "https://example.com/a", vscode: false });
  assert.deepEqual(deps["b-dep"], { dir: "b-dep", name: "B", version: "5.6.7", licenseUrl: "https://example.com/b" });
});
