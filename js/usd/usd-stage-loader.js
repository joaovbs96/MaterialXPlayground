const workerUrl = new URL("./usd-stage-worker.js", import.meta.url);
let nextRequestId = 1;

// The native usd-wg-webview runtime is an Emscripten wasm module that boots
// slowly; this worker is now a persistent singleton reused across loads
// instead of one Worker per call. It holds exactly one native stage, so
// loads are queued strictly FIFO (see queueTail below).
const IDLE_TIMEOUT_MS = 60000;
const MAX_LOADS_PER_WORKER = 8;
// The wasm heap only grows for the life of the worker. A load that pushes it
// past this size is treated as a one-off: discard the worker right after
// delivering the result instead of pinning that memory for the rest of the
// session. Small/medium scenes stay under this and keep the persistent worker
// (and its input cache) across settings changes.
const DISCARD_HEAP_BYTES = 768 * 1024 * 1024;

let worker = null;
const pending = new Map(); // id -> { resolve, reject, onResult, onError, abort, onProgress, signal }
let queueTail = Promise.resolve();
let idleTimer = null;
let loadsSinceBoot = 0;
// path -> "size|lastModified" for the files used in the most recent load,
// tracked from the caller's own file metadata (no I/O). A path that
// reappears with a different identity means MEMFS or the worker's input
// cache could otherwise serve stale bytes for it.
let lastIdentity = new Map();
const stats = { created: 0, discards: 0, loadsSinceBoot: 0 };
// Root layer of the most recently completed load. The wasm heap only grows,
// so a switch to a different root (e.g. a small auto-picked default root
// followed by a much bigger scene) restarts the worker instead of letting
// the new load's peak sit on top of the old one's resident heap.
let lastLoadedRootPath = null;

function normalizePathForIdentity(path) {
  return String(path ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
}

function identityOf(file) {
  return `${file?.size ?? -1}|${file?.lastModified ?? -1}`;
}

function clearIdleTimer() {
  if (idleTimer === null) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function armIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => discardWorker("idle timeout"), IDLE_TIMEOUT_MS);
}

// Terminates the worker (if any), clears state and rejects anything still
// pending. Safe to call at any time, including with nothing in flight.
function discardWorker(reason) {
  clearIdleTimer();
  const failed = worker;
  worker = null;
  if (failed) {
    try { failed.terminate(); } catch { /* already gone */ }
    stats.discards++;
  }
  loadsSinceBoot = 0;
  stats.loadsSinceBoot = 0;
  lastIdentity = new Map();
  lastLoadedRootPath = null;
  if (!pending.size) return;
  const error = reason instanceof Error ? reason : new Error(`OpenUSD worker was discarded: ${reason}`);
  const entries = Array.from(pending.values());
  pending.clear();
  for (const entry of entries) {
    entry.signal?.removeEventListener("abort", entry.abort);
    entry.reject(error);
  }
}

export function resetUsdWorker() {
  discardWorker("resetUsdWorker() was called");
}

export function usdWorkerStats() {
  return { created: stats.created, discards: stats.discards, loadsSinceBoot: stats.loadsSinceBoot };
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(workerUrl, { type: "module", name: "openusd-stage" });
  stats.created++;
  worker.onmessage = event => {
    const message = event.data;
    const entry = message?.id != null ? pending.get(message.id) : undefined;
    if (!entry) return;
    if (message.type === "progress") entry.onProgress?.(message.value);
    else if (message.type === "result") entry.onResult(message.result);
    else if (message.type === "error") entry.onError(message.error);
  };
  // Any of these means the native runtime is in an unknown state; a fresh
  // worker (and a fresh wasm boot) is the only safe recovery.
  worker.onerror = event => discardWorker(event?.message || "OpenUSD worker failed");
  worker.onmessageerror = () => discardWorker("OpenUSD worker message could not be deserialized");
  return worker;
}

function runLoad(requestFiles, rootPath, onProgress, signal, purposePolicy, subdivisionLevel, triangleLimits) {
  if (signal?.aborted) return Promise.reject(new DOMException("USD stage load aborted", "AbortError"));

  for (const file of requestFiles) {
    if (!file?.path) continue;
    const previous = lastIdentity.get(normalizePathForIdentity(file.path));
    if (previous !== undefined && previous !== identityOf(file)) {
      discardWorker("input file identity changed since the last load");
      break;
    }
  }

  const normalizedRoot = normalizePathForIdentity(rootPath);
  if (worker && lastLoadedRootPath !== null && lastLoadedRootPath !== normalizedRoot) {
    discardWorker("root layer switched to a different scene");
  }

  clearIdleTimer();
  const activeWorker = ensureWorker();
  const id = nextRequestId++;

  return new Promise((resolve, reject) => {
    const entry = { onProgress, signal, resolve, reject };
    const finish = (fn, value) => {
      if (!pending.has(id)) return false;
      pending.delete(id);
      signal?.removeEventListener("abort", entry.abort);
      if (!pending.size) armIdleTimer();
      fn(value);
      return true;
    };
    entry.abort = () => {
      if (!finish(reject, new DOMException("USD stage load aborted", "AbortError"))) return;
      // A native call cannot be interrupted, so an aborted load leaves a
      // half-composed stage behind; the worker must be rebuilt.
      discardWorker("load aborted");
    };
    entry.onResult = value => {
      loadsSinceBoot++;
      stats.loadsSinceBoot = loadsSinceBoot;
      for (const file of requestFiles) {
        if (file?.path) lastIdentity.set(normalizePathForIdentity(file.path), identityOf(file));
      }
      lastLoadedRootPath = normalizedRoot;
      const heapBytes = Number(value?.wasmHeapBytes);
      if (!finish(resolve, value)) return;
      if (loadsSinceBoot >= MAX_LOADS_PER_WORKER) discardWorker("load budget reached");
      else if (Number.isFinite(heapBytes) && heapBytes > DISCARD_HEAP_BYTES) discardWorker("wasm heap grew past the discard threshold");
    };
    entry.onError = message => {
      if (finish(reject, new Error(message))) discardWorker("worker reported an error");
    };
    pending.set(id, entry);
    if (signal?.aborted) { entry.abort(); return; }
    signal?.addEventListener("abort", entry.abort, { once: true });
    try {
      // No transfer list: the caller keeps ownership of its buffers, since
      // the same files are subsequently consumed by MaterialX.
      activeWorker.postMessage({ id, type: "load", files: requestFiles, rootPath, purposePolicy, subdivisionLevel, triangleLimits });
    } catch (error) {
      if (finish(reject, new Error(`OpenUSD request could not cross Worker boundary: ${error?.message ?? error}`))) {
        discardWorker("postMessage failed");
      }
    }
  });
}

/**
 * Compose and extract a USD/USDZ stage in a persistent, shared Worker.
 * Input ArrayBuffers are deliberately structured-cloned; the caller keeps
 * ownership because the same files are subsequently consumed by MaterialX.
 */
export function loadUsdStage({ files, rootPath, onProgress, signal, purposePolicy = "defaultRender", subdivisionLevel = 0, triangleLimits = true }) {
  if (!Array.isArray(files) || !files.length) return Promise.reject(new Error("USD files are required"));
  if (!rootPath) return Promise.reject(new Error("USD rootPath is required"));

  const requestFiles = files.map(file => {
    const data = file?.data;
    return {
      path: file?.path,
      data,
      size: typeof data?.size === "number" ? data.size : (typeof data?.byteLength === "number" ? data.byteLength : undefined),
      lastModified: typeof data?.lastModified === "number" ? data.lastModified : undefined,
    };
  });

  // Strict FIFO: the worker holds exactly one native stage, so this request
  // waits for every previously queued one to settle before it starts.
  const runThisLoad = () => runLoad(requestFiles, rootPath, onProgress, signal, purposePolicy, subdivisionLevel, triangleLimits);
  const result = queueTail.then(runThisLoad, runThisLoad);
  queueTail = result.then(() => {}, () => {});
  return result;
}

export function usdRuntimeUrl() {
  return new URL("../../vendor/usd-webview-bindings/", import.meta.url).href;
}
