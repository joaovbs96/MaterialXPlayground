// tests/vscode/lib/harness.mjs: substitutes webview.html's placeholders
// like editorProvider.js's buildHtml() does, plus an addInitScript that
// fakes the VS Code webview API bootstrap.js expects.

/** Mirrors editorProvider.js's buildHtml() substitution exactly:
 * split/join per placeholder (never regex - the fragments can contain
 * literal '$' sequences a replace() callback would mangle). */
export function substitutePlaceholders(template, { cspSource, baseUri, bootstrapUri, initialHash, docsOnly, sceneOnly }) {
  let html = template;
  html = html.split('${cspSource}').join(cspSource);
  html = html.split('${baseUri}').join(baseUri);
  html = html.split('${bootstrapUri}').join(bootstrapUri);
  html = html.split('${initialHash}').join(initialHash);
  html = html.split('${docsOnly}').join(docsOnly ? '1' : '');
  html = html.split('${sceneOnly}').join(sceneOnly ? '1' : '');
  return html;
}

// Installed via page.addInitScript, before any page script. Fakes
// acquireVsCodeApi() -- bootstrap.js no longer wraps window.fetch, so
// the WASM/texture payloads load through the test server like any other
// static asset; this only needs to catch forwarded 'mtlx-error' posts.
export function installFakeVsCodeApi() {
  let acquired = false;
  window.__mtlxHarness = { errors: [] };
  window.acquireVsCodeApi = function () {
    if (acquired) throw new Error('acquireVsCodeApi() called more than once');
    acquired = true;
    return {
      postMessage(msg) {
        if (!msg) return;
        if (msg.type === 'mtlx-error') {
          window.__mtlxHarness.errors.push(msg.text);
          return;
        }
        // 'ready'/'mtlx-save'/'mtlx-sync'/'mtlx-native-undo'/'redo': no-ops, no document loaded here.
      },
      getState() { return undefined; },
      setState() {},
    };
  };
}
