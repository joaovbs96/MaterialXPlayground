// VS Code webview only. Workers there cannot fetch or import from the
// extension's resource origin, so the page relinks the worker's module graph
// through blob: URLs (js/shared/worker-module-link.js) and serves the .wasm from a blob.
import { linkWorkerModule } from "../shared/worker-module-link.js";

const WORKER_URL = new URL("./usd-stage-worker.js", import.meta.url).href;
const WASM_URL = new URL("../../vendor/usd-webview-bindings/usdWebViewBindingsModule.wasm", import.meta.url).href;

let workerUrlPromise = null;

/** Blob URL of a module Worker script equivalent to usd-stage-worker.js. */
export function createUsdWorkerUrl() {
  if (!workerUrlPromise) {
    workerUrlPromise = (async () => {
      const response = await fetch(WASM_URL);
      if (!response.ok) throw new Error(`${WASM_URL} returned HTTP ${response.status}`);
      const wasmBlobUrl = URL.createObjectURL(new Blob([await response.blob()], { type: "application/wasm" }));
      return linkWorkerModule(WORKER_URL, { redirects: [[WASM_URL, wasmBlobUrl]] });
    })();
    workerUrlPromise.catch(() => { workerUrlPromise = null; });
  }
  return workerUrlPromise;
}
