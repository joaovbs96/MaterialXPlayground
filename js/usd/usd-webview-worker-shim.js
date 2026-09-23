// VS Code webview only. Workers there cannot fetch or import from the
// extension's resource origin, so the page fetches the worker's module graph,
// relinks it through blob: URLs and serves the runtime .wasm from a blob too.
const WORKER_URL = new URL("./usd-stage-worker.js", import.meta.url).href;
const WASM_URL = new URL("../../vendor/usd-webview-bindings/usdWebViewBindingsModule.wasm", import.meta.url).href;

// Relative specifiers only: bare `import "x"`, `from "x"`, `import("x")` and
// a template import whose `?v=${id}` query is only a cache buster.
const IMPORT_FORMS = [
  { re: /\bimport\s*(["'])(?<spec>\.{1,2}\/[^"'\n]+)\1/g, emit: url => `import ${url}` },
  { re: /\bfrom\s*(["'])(?<spec>\.{1,2}\/[^"'\n]+)\1/g, emit: url => `from ${url}` },
  { re: /\bimport\(\s*(["'])(?<spec>\.{1,2}\/[^"'\n]+)\1\s*\)/g, emit: url => `import(${url})` },
  { re: /\bimport\(\s*`(?<spec>\.{1,2}\/[^`$?\n]+)(?:\?[^`\n]*)?`\s*\)/g, emit: url => `import(${url})` },
];
const LEFTOVER_IMPORT = /\bimport\s*\(?\s*["'`]\.{1,2}\/|\bfrom\s*["']\.{1,2}\//;

function withoutQuery(url) {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

function moduleBlobUrl(source) {
  return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response;
}

// Leaf modules first: relative imports become blob URLs, and import.meta.url
// is pinned to the real file URL so new URL(x, import.meta.url) still
// resolves (the runtime derives its .wasm location that way).
async function linkModule(url, done, visiting) {
  const key = withoutQuery(url);
  if (done.has(key)) return done.get(key);
  if (visiting.has(key)) throw new Error(`import cycle through ${key}`);
  visiting.add(key);
  let source = await (await fetchOk(key)).text();
  const linked = new Map();
  for (const { re } of IMPORT_FORMS) {
    for (const match of source.matchAll(re)) {
      const spec = match.groups.spec;
      if (!linked.has(spec)) linked.set(spec, await linkModule(new URL(spec, key).href, done, visiting));
    }
  }
  for (const { re, emit } of IMPORT_FORMS) {
    source = source.replace(re, (...args) => emit(JSON.stringify(linked.get(args[args.length - 1].spec))));
  }
  if (LEFTOVER_IMPORT.test(source)) throw new Error(`unsupported import form left in ${key}`);
  source = source.split("import.meta.url").join(JSON.stringify(key));
  const blobUrl = moduleBlobUrl(source);
  visiting.delete(key);
  done.set(key, blobUrl);
  return blobUrl;
}

// Evaluated first inside the worker: fetches of the runtime .wasm (any
// query) are answered from the page-made blob, the rest pass through.
function fetchRedirectSource(redirects) {
  return `const redirects = new Map(${JSON.stringify(redirects)});
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  let key = null;
  try {
    const url = new URL(typeof input === "string" ? input : (input && input.url) || String(input));
    url.search = "";
    url.hash = "";
    key = url.href;
  } catch { /* not a URL */ }
  const target = key && redirects.get(key);
  return target ? realFetch(target) : realFetch(input, init);
};
`;
}

let workerUrlPromise = null;

/** Blob URL of a module Worker script equivalent to usd-stage-worker.js. */
export function createUsdWorkerUrl() {
  if (!workerUrlPromise) {
    workerUrlPromise = (async () => {
      const wasm = await (await fetchOk(WASM_URL)).blob();
      const wasmBlobUrl = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
      const workerBlobUrl = await linkModule(WORKER_URL, new Map(), new Set());
      const redirectUrl = moduleBlobUrl(fetchRedirectSource([[withoutQuery(WASM_URL), wasmBlobUrl]]));
      return moduleBlobUrl(`import ${JSON.stringify(redirectUrl)};\nimport ${JSON.stringify(workerBlobUrl)};\n`);
    })();
    workerUrlPromise.catch(() => { workerUrlPromise = null; });
  }
  return workerUrlPromise;
}
