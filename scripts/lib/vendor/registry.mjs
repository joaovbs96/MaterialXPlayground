// scripts/lib/vendor/registry.mjs
//
// Validates and resolves scripts/vendor-deps.mjs's VENDOR_DEPS: pure
// functions, unit-tested directly against the real registry.

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DRIVE_LETTER_RE = /^[A-Za-z]:/;
const MODULE_KINDS = ["emscripten-esm", "esm", "script"];
const JS_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

// An npm source is `{ npm, files }` where `files` is its own path map,
// so "files" only counts as the files-kind marker when npm is absent.
function sourceKind(dep) {
  const src = dep && dep.source;
  if (!src || typeof src !== "object") return null;
  const kinds = [];
  if (src.npm !== undefined) kinds.push("npm");
  if (src.zip !== undefined) kinds.push("zip");
  if (src.npm === undefined && src.files !== undefined) kinds.push("files");
  return kinds.length === 1 ? kinds[0] : null;
}

/** Safe relative POSIX path: no backslash, no leading "/", no drive
 * letter, no control chars, no ":" (NTFS alternate data streams), no
 * empty/"."/".." segment. A trailing "/" is allowed only when
 * `allowTrailingSlash` is set. */
function isSafeRelPath(value, allowTrailingSlash) {
  if (typeof value !== "string" || value === "") return false;
  if (/[\x00-\x1f]/.test(value)) return false;
  if (value.includes("\\")) return false;
  if (value.startsWith("/")) return false;
  if (DRIVE_LETTER_RE.test(value)) return false;
  if (value.includes(":")) return false;
  let v = value;
  if (v.endsWith("/")) {
    if (!allowTrailingSlash) return false;
    v = v.slice(0, -1);
  }
  if (v === "") return false;
  return v.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function dirsOverlap(a, b) {
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

/** Returns an array of problem strings; empty means the registry is valid. */
export function validateRegistry(deps) {
  if (!Array.isArray(deps)) return ["VENDOR_DEPS must be an array"];

  const problems = [];
  const seenIds = new Set();
  const exclusiveOwners = [];

  for (const dep of deps) {
    const tag = dep && typeof dep.id === "string" ? dep.id : "<unknown>";

    if (!dep || typeof dep.id !== "string" || !ID_RE.test(dep.id)) {
      problems.push(`${tag}: id must match ${ID_RE} (got ${JSON.stringify(dep && dep.id)})`);
    } else if (seenIds.has(dep.id)) {
      problems.push(`${dep.id}: duplicate id`);
    } else {
      seenIds.add(dep.id);
    }

    if (!dep.name || typeof dep.name !== "string") {
      problems.push(`${tag}: name is required`);
    }

    const kind = sourceKind(dep);
    if (!kind) {
      problems.push(`${tag}: source must have exactly one of npm, files, zip`);
      continue;
    }

    if (kind === "npm") {
      if (dep.version !== undefined) problems.push(`${tag}: version is forbidden for npm deps`);
      if (JSON.stringify(dep.source).includes("{version}")) problems.push(`${tag}: {version} is forbidden in npm deps`);
      for (const [key, value] of Object.entries(dep.source.files || {})) {
        const isGlob = key.includes("*");
        if (!isSafeRelPath(key, false)) problems.push(`${tag}: unsafe npm source path ${JSON.stringify(key)}`);
        if (isGlob && (typeof value !== "string" || !value.endsWith("/"))) {
          problems.push(`${tag}: npm glob dest for ${JSON.stringify(key)} must end with "/"`);
        }
        if (!isSafeRelPath(value, isGlob)) problems.push(`${tag}: unsafe npm dest ${JSON.stringify(value)}`);
      }
    } else {
      if (!dep.version || typeof dep.version !== "string") problems.push(`${tag}: version is required for ${kind} deps`);

      if (kind === "zip") {
        if (!dep.source.sha256 || !SHA256_RE.test(dep.source.sha256)) problems.push(`${tag}: zip sha256 must match ${SHA256_RE}`);
        if (!dep.source.zip || !dep.source.zip.startsWith("https://")) problems.push(`${tag}: zip url must start with https://`);
        for (const g of dep.source.include || []) {
          if (!isSafeRelPath(g, false)) problems.push(`${tag}: unsafe include glob ${JSON.stringify(g)}`);
        }
      } else {
        for (const f of dep.source.files || []) {
          if (!f.sha256 || !SHA256_RE.test(f.sha256)) problems.push(`${tag}: files entry sha256 must match ${SHA256_RE} (${f.as})`);
          if (!f.url || !f.url.startsWith("https://")) problems.push(`${tag}: files entry url must start with https:// (${f.as})`);
          if (!isSafeRelPath(f.as, false)) problems.push(`${tag}: unsafe files "as" path ${JSON.stringify(f.as)}`);
        }
      }
    }

    if (!dep.license || !dep.license.url || !dep.license.url.startsWith("https://")) {
      problems.push(`${tag}: license.url must start with https://`);
    }
    if (dep.license && dep.license.file !== undefined && !isSafeRelPath(dep.license.file, false)) {
      problems.push(`${tag}: unsafe license.file ${JSON.stringify(dep.license.file)}`);
    }

    if (dep.dir !== undefined) {
      if (!isSafeRelPath(dep.dir, false)) problems.push(`${tag}: unsafe dir ${JSON.stringify(dep.dir)}`);
      if (dep.dir === "materialx" || dep.dir.startsWith("materialx/")) problems.push(`${tag}: dir may not be "materialx" or under it`);
      if (dep.dir === "vendor-manifest.json") problems.push(`${tag}: dir may not be "vendor-manifest.json"`);
    }

    if (dep.module) {
      if (!MODULE_KINDS.includes(dep.module.kind)) problems.push(`${tag}: module.kind must be one of ${MODULE_KINDS.join(", ")}`);
      if (dep.module.kind === "script" && !dep.module.global) problems.push(`${tag}: module.kind "script" requires module.global`);
      if (dep.module.kind !== "script" && dep.module.global) problems.push(`${tag}: module.global is only allowed for kind "script"`);
      if (dep.module.global !== undefined && !JS_IDENTIFIER_RE.test(dep.module.global)) problems.push(`${tag}: module.global must be a JS identifier (got ${JSON.stringify(dep.module.global)})`);
      if (!dep.module.entry) problems.push(`${tag}: module.entry is required when module is set`);
      else if (!isSafeRelPath(dep.module.entry, false)) problems.push(`${tag}: unsafe module.entry ${JSON.stringify(dep.module.entry)}`);
    }

    if (dep.fetchOnly || dep.vscode === false) {
      exclusiveOwners.push({ id: dep.id, dir: dep.dir || dep.id, reason: dep.fetchOnly ? "fetchOnly" : "vscode:false" });
    }
  }

  const allDirs = deps.filter((d) => d && typeof d.id === "string").map((d) => ({ id: d.id, dir: d.dir || d.id }));
  for (const owner of exclusiveOwners) {
    for (const other of allDirs) {
      if (other.id === owner.id) continue;
      if (dirsOverlap(owner.dir, other.dir)) {
        problems.push(`${owner.id}: ${owner.reason} dir "${owner.dir}" overlaps "${other.dir}" (${other.id}): must own its dir exclusively`);
      }
    }
  }

  return problems;
}

/** Applies defaults (dir, fetchOnly, vscode) and substitutes {version}
 * into files/zip source urls and license.url. Assumes a valid registry. */
export function resolveDeps(deps) {
  return deps.map((dep) => {
    const dir = dep.dir || dep.id;
    const version = dep.version;
    const sub = (value) => (typeof value === "string" && version ? value.split("{version}").join(version) : value);

    let source = dep.source;
    if (source.zip !== undefined) {
      source = { ...source, zip: sub(source.zip) };
    } else if (source.files && Array.isArray(source.files)) {
      source = { ...source, files: source.files.map((f) => ({ ...f, url: sub(f.url) })) };
    }

    return {
      ...dep,
      dir,
      fetchOnly: !!dep.fetchOnly,
      vscode: dep.vscode !== false,
      source,
      license: { ...dep.license, url: sub(dep.license.url) },
    };
  });
}

/** Imports scripts/vendor-deps.mjs, validates it, and resolves it.
 * Throws (naming every problem) if the registry is invalid. */
export async function loadResolvedDeps() {
  const { VENDOR_DEPS } = await import("../../vendor-deps.mjs");
  const problems = validateRegistry(VENDOR_DEPS);
  if (problems.length > 0) {
    throw new Error(["scripts/vendor-deps.mjs is invalid:", ...problems.map((p) => `  - ${p}`)].join("\n"));
  }
  return resolveDeps(VENDOR_DEPS);
}
