const workerUrl = new URL("./usd-stage-worker.js", import.meta.url);
let nextRequestId = 1;

/**
 * Compose and extract a USD/USDZ stage in a dedicated Worker.
 * Input ArrayBuffers are deliberately structured-cloned; the caller keeps
 * ownership because the same files are subsequently consumed by MaterialX.
 */
export function loadUsdStage({ files, rootPath, onProgress, signal, purposePolicy = "defaultRender" }) {
  if (!Array.isArray(files) || !files.length) return Promise.reject(new Error("USD files are required"));
  if (!rootPath) return Promise.reject(new Error("USD rootPath is required"));
  const worker = new Worker(workerUrl, { type: "module", name: "openusd-stage" });
  const id = nextRequestId++;
  // Do not slice large buffers on the main thread. postMessage without a
  // transfer list preserves caller ownership while the browser performs the
  // structured clone; Blob/File values remain cheap handles until the Worker
  // calls arrayBuffer().
  const requestFiles = files.map(file => ({ path: file?.path, data: file?.data }));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      fn(value);
    };
    const abort = () => finish(reject, new DOMException("USD stage load aborted", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = event => {
      const message = event.data;
      if (message?.id !== id) return;
      if (message.type === "progress") onProgress?.(message.value);
      else if (message.type === "result") finish(resolve, message.result);
      else if (message.type === "error") finish(reject, new Error(message.error));
    };
    worker.onerror = event => finish(reject, new Error(event.message || "OpenUSD worker failed"));
    try {
      worker.postMessage({ id, type: "load", files: requestFiles, rootPath, purposePolicy });
    } catch (error) {
      finish(reject, new Error(`OpenUSD request could not cross Worker boundary: ${error?.message ?? error}`));
    }
  });
}

export function usdRuntimeUrl() {
  return new URL("../../vendor/usd-webview-bindings/", import.meta.url).href;
}
