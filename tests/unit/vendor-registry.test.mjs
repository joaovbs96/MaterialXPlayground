// Unit coverage for scripts/lib/vendor/registry.mjs's validateRegistry:
// the real VENDOR_DEPS registry, plus one bad-registry case per rule.
import assert from "node:assert/strict";
import test from "node:test";

import { validateRegistry } from "../../scripts/lib/vendor/registry.mjs";
import { VENDOR_DEPS } from "../../scripts/vendor-deps.mjs";

const OK_NPM = { id: "ok-npm", name: "OK", source: { npm: "ok", files: { "a.js": "a.js" } }, license: { url: "https://example.com/license" } };
const OK_FILES = {
  id: "ok-files",
  name: "OK",
  version: "1.0.0",
  source: { files: [{ url: "https://example.com/a.js", sha256: "a".repeat(64), as: "a.js" }] },
  license: { url: "https://example.com/license" },
};

function problemsFor(dep) {
  return validateRegistry([dep]);
}

test("the real VENDOR_DEPS validates with zero problems", () => {
  assert.deepEqual(validateRegistry(VENDOR_DEPS), []);
});

test("duplicate id is flagged", () => {
  const problems = validateRegistry([OK_NPM, { ...OK_NPM }]);
  assert.ok(problems.some((p) => p.includes("duplicate id")));
});

test("bad id pattern is flagged", () => {
  const problems = problemsFor({ ...OK_NPM, id: "Bad_ID" });
  assert.ok(problems.some((p) => p.includes("id must match")));
});

test("bad sha256 is flagged", () => {
  const problems = problemsFor({ ...OK_FILES, source: { files: [{ url: "https://example.com/a.js", sha256: "not-hex", as: "a.js" }] } });
  assert.ok(problems.some((p) => p.includes("sha256 must match")));
});

test("http (non-https) url is flagged", () => {
  const problems = problemsFor({ ...OK_FILES, source: { files: [{ url: "http://example.com/a.js", sha256: "a".repeat(64), as: "a.js" }] } });
  assert.ok(problems.some((p) => p.includes("https://")));
});

test("version on an npm dep is forbidden", () => {
  const problems = problemsFor({ ...OK_NPM, version: "1.0.0" });
  assert.ok(problems.some((p) => p.includes("version is forbidden for npm")));
});

test("missing version on a files dep is flagged", () => {
  const { version, ...withoutVersion } = OK_FILES;
  const problems = problemsFor(withoutVersion);
  assert.ok(problems.some((p) => p.includes("version is required for files")));
});

test("unsafe dir is flagged", () => {
  const problems = problemsFor({ ...OK_NPM, dir: "../evil" });
  assert.ok(problems.some((p) => p.includes("unsafe dir")));
});

test("unsafe files 'as' path is flagged", () => {
  const problems = problemsFor({ ...OK_FILES, source: { files: [{ url: "https://example.com/a.js", sha256: "a".repeat(64), as: "../evil.js" }] } });
  assert.ok(problems.some((p) => p.includes('unsafe files "as"')));
});

test("unsafe module.entry is flagged", () => {
  const problems = problemsFor({ ...OK_NPM, module: { kind: "esm", entry: "../evil.js" } });
  assert.ok(problems.some((p) => p.includes("unsafe module.entry")));
});

test("dir under materialx is flagged", () => {
  const problems = problemsFor({ ...OK_NPM, dir: "materialx/sub" });
  assert.ok(problems.some((p) => p.includes('may not be "materialx"')));
});

test("overlapping fetchOnly dir is flagged", () => {
  const a = { ...OK_NPM, id: "dep-a", dir: "shared", fetchOnly: true };
  const b = { ...OK_FILES, id: "dep-b", dir: "shared/sub" };
  const problems = validateRegistry([a, b]);
  assert.ok(problems.some((p) => p.includes("fetchOnly dir") && p.includes("overlaps")));
});

test("overlapping vscode:false dir is flagged", () => {
  const a = { ...OK_NPM, id: "dep-a", dir: "shared", vscode: false };
  const b = { ...OK_FILES, id: "dep-b", dir: "shared" };
  const problems = validateRegistry([a, b]);
  assert.ok(problems.some((p) => p.includes("vscode:false dir") && p.includes("overlaps")));
});

test("bad module.kind is flagged", () => {
  const problems = problemsFor({ ...OK_NPM, module: { kind: "cjs", entry: "a.js" } });
  assert.ok(problems.some((p) => p.includes("module.kind must be one of")));
});

test("script module without global is flagged", () => {
  const problems = problemsFor({ ...OK_NPM, module: { kind: "script", entry: "a.js" } });
  assert.ok(problems.some((p) => p.includes('requires module.global')));
});

test("{version} in an npm dep is forbidden", () => {
  const problems = problemsFor({ ...OK_NPM, source: { npm: "ok", files: { "a-{version}.js": "a.js" } } });
  assert.ok(problems.some((p) => p.includes("{version} is forbidden")));
});

test("module without entry is flagged", () => {
  const problems = problemsFor({ ...OK_NPM, module: { kind: "esm" } });
  assert.ok(problems.some((p) => p.includes("module.entry is required")));
});

test("module.global that is not a JS identifier is flagged", () => {
  const problems = problemsFor({ ...OK_NPM, module: { kind: "script", entry: "a.js", global: "not-an-id" } });
  assert.ok(problems.some((p) => p.includes("module.global must be a JS identifier")));
});

test("a colon anywhere in a path-like value is unsafe", () => {
  const problems = problemsFor({ ...OK_NPM, dir: "a:b" });
  assert.ok(problems.some((p) => p.includes("unsafe dir")));
});
