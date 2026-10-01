// Page-side helpers that make module workers and worker imports work in the VS Code
// webview (workers there cannot fetch extension resources). Classic scripts reach this
// ES module with import(new URL('js/shared/worker-module-link.js', document.baseURI).href).
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
// is pinned to the real file URL so new URL(x, import.meta.url) still resolves.
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

// Evaluated first inside the worker: fetches of a redirected URL (any query)
// are answered from the given blob URL, the rest pass through.
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

/**
 * Blob URL for `new Worker(url, { type: "module" })` equivalent to the module at
 * workerUrl. redirects: [[fileUrl, blobUrl], ...] answered by fetch inside the worker.
 */
export async function linkWorkerModule(workerUrl, { redirects } = {}) {
  const workerBlobUrl = await linkModule(workerUrl, new Map(), new Set());
  if (!redirects || !redirects.length) return workerBlobUrl;
  const pairs = redirects.map(([from, to]) => [withoutQuery(from), to]);
  const redirectUrl = moduleBlobUrl(fetchRedirectSource(pairs));
  return moduleBlobUrl(`import ${JSON.stringify(redirectUrl)};\nimport ${JSON.stringify(workerBlobUrl)};\n`);
}

/** Blob URL of a single file for import() inside a worker under VS Code, else url unchanged. */
export async function importableUrl(url) {
  if (!globalThis.__MTLX_VSCODE__) return url;
  const key = withoutQuery(new URL(url, globalThis.document ? document.baseURI : globalThis.location?.href).href);
  const source = (await (await fetchOk(key)).text()).split("import.meta.url").join(JSON.stringify(key));
  return moduleBlobUrl(source);
}
