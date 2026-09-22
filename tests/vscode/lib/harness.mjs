// tests/vscode/lib/harness.mjs: substitutes webview.html's placeholders
// like editorProvider.js's buildHtml() does, plus an addInitScript that
// fakes the VS Code webview API bootstrap.js expects.

/** Mirrors editorProvider.js's buildHtml() substitution exactly:
 * split/join per placeholder (never regex - the fragments can contain
 * literal '$' sequences a replace() callback would mangle). */
export function substitutePlaceholders(template, { cspSource, baseUri, bootstrapUri, initialHash, docsOnly, extensionVersion, vscodeVersion }) {
  let html = template;
  html = html.split('${cspSource}').join(cspSource);
  html = html.split('${baseUri}').join(baseUri);
  html = html.split('${bootstrapUri}').join(bootstrapUri);
  html = html.split('${initialHash}').join(initialHash);
  html = html.split('${docsOnly}').join(docsOnly ? '1' : '');
  html = html.split('${extensionVersion}').join(extensionVersion || '');
  html = html.split('${vscodeVersion}').join(vscodeVersion || '');
  return html;
}

// Installed via page.addInitScript, before any page script. Fakes
// acquireVsCodeApi() and answers 'mtlx-fetch' (bootstrap.js) with real,
// base64-encoded fetch()es; does NOT reproduce the webview-resource corruption bootstrap.js works around.
export function installFakeVsCodeApi() {
  let acquired = false;
  window.__mtlxHarness = { errors: [], fetchLog: [] };
  // Captured before bootstrap.js rewrites window.fetch, or this relay's
  // own fetch would recurse into that same wrapper.
  const nativeFetch = window.fetch.bind(window);
  window.acquireVsCodeApi = function () {
    if (acquired) throw new Error('acquireVsCodeApi() called more than once');
    acquired = true;
    return {
      postMessage(msg) {
        if (!msg) return;
        if (msg.type === 'mtlx-fetch') {
          window.__mtlxHarness.fetchLog.push(msg.path);
          nativeFetch('/' + msg.path)
            .then((res) => {
              if (!res.ok) throw new Error('status ' + res.status);
              return res.arrayBuffer();
            })
            .then((buf) => {
              const bytes = new Uint8Array(buf);
              let binary = '';
              for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
              window.postMessage({ type: 'mtlx-fetch-result', id: msg.id, ok: true, bytesB64: btoa(binary) }, '*');
            })
            .catch((err) => {
              window.postMessage({ type: 'mtlx-fetch-result', id: msg.id, ok: false, error: String(err) }, '*');
            });
          return;
        }
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
