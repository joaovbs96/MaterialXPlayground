// mtlxNode.js — headless (extension-host) loader for the bundled
// MaterialX WASM build (js/JsMaterialXGenShader.js), plus a semantic
// (parse + validate) check for .mtlx documents. Pure Node: this module
// must NOT require('vscode') anywhere, so it stays independently
// loadable/testable with plain `node` — validator.js (the only caller)
// enforces the same rule for the same reason.
//
// Mirrors (but does not import — js/mtlx-engine.js is a browser
// global-scope script that references `window` and has no
// module.exports) js/mtlx-engine.js's getMxEnv()/mxErr() helpers, and
// js/viewer-app.jsx's loadMtlxDocument() parse sequence, and
// js/graph-app.jsx's "Validate" dialog — including its use of the
// message-holder overload of validate() to recover real diagnostic text
// (see the comment above the validate() call below).
// docScanner.js's own header comment sets the precedent for "mirrors but
// does not import" for exactly this reason (the site's code has no Node
// entry point) — same situation here.
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// Expected byte size of js/JsMaterialXGenShader.data, the packed
// emscripten virtual-FS archive carrying the MaterialX standard
// library. See the KNOWN HAZARD comment in attemptLoad() below.
const EXPECTED_DATA_SIZE = 1481718;

// ---------------------------------------------------------------------
// Local mirrors of js/mtlx-engine.js helpers (lines ~299-351 there).
// Duplicated verbatim rather than required — see the file banner above.

// Emscripten throws C++ exceptions as NUMBERS (raw exception pointers),
// not Error objects — a bare catch that stringifies one shows a raw
// pointer value instead of the real MaterialX message. Decode via
// mx.getExceptionMessage when available; otherwise fall back to normal
// Error/String handling. ALWAYS route caught MaterialX errors through
// this.
function mxErr(mx, e) {
    try {
        if (typeof e === 'number' && mx && typeof mx.getExceptionMessage === 'function') {
            const msg = mx.getExceptionMessage(e);
            // getExceptionMessage may return a string or [type, message]
            if (Array.isArray(msg)) return msg.filter(Boolean).join(': ');
            if (msg) return String(msg);
        }
    } catch (_) { /* fall through to generic handling */ }
    if (e && e.message) return e.message;
    return String(e);
}

// ---------------------------------------------------------------------
// Singleton wasm loader / permanent-degrade state machine.
//
// - loadPromise: the shared in-flight/resolved promise, so concurrent
//   callers never trigger a second wasm load.
// - failed: once true, EVERY subsequent call short-circuits to
//   Promise.resolve(null) without re-attempting anything — a wasm init
//   failure is treated as permanent for the life of the extension host
//   process (retrying on every keystroke's validation pass would be
//   both slow and pointless if the build is genuinely broken/missing).
// - pendingError: the one-shot init-failure string for consumeInitError()
//   below.
//
// On success, the FIRST caller's repoRoot wins forever — later calls
// (even with a different repoRoot) get back the already-resolved env.
// In practice there is exactly one extension host process and exactly
// one repo root, so this is a non-issue, but it's worth documenting
// since silently ignoring a second repoRoot argument could otherwise
// look like a bug.
let loadPromise = null;
let failed = false;
let pendingError = null;

// Loads the bundled MaterialX wasm build the same way js/mtlx-engine.js's
// getMxEnv() does in the browser: EsslShaderGenerator -> GenContext ->
// loadStandardLibraries. This is safe to do headless (no rendering, no
// WebGL/DOM touched) purely to obtain `stdlib` for
// setDataLibrary/importLibrary — constructing a shader-generator object
// does not require a graphics context.
async function attemptLoad(repoRoot) {
    const dataPath = path.join(repoRoot, 'js', 'JsMaterialXGenShader.data');

    // KNOWN HAZARD: js/JsMaterialXGenShader.data is a packed emscripten
    // virtual-FS archive — a BINARY file. A CRLF-smudged checkout (git
    // autocrlf mangling a binary that should have been left alone)
    // silently corrupts it, and wasm init then fails with a cryptic,
    // unhelpful error far downstream (inside stdlib XML parsing, nowhere
    // near this file). Catch it early with an actionable message instead.
    // If the file is missing entirely, don't over-engineer this check —
    // let the natural ENOENT surface later (from the dynamic import /
    // emscripten's own file read), that error is already clear on its
    // own.
    try {
        const stat = fs.statSync(dataPath);
        if (stat.size !== EXPECTED_DATA_SIZE) {
            throw new Error(
                'MaterialX .data archive is ' + stat.size + ' bytes, expected ' + EXPECTED_DATA_SIZE
                + ' — likely CRLF-corrupted by a Windows checkout (this is a binary file; see .gitattributes).'
            );
        }
    } catch (e) {
        if (e && e.code === 'ENOENT') {
            // Missing entirely — fall through, let the natural failure
            // below explain itself.
        } else {
            throw e;
        }
    }

    const jsPath = path.join(repoRoot, 'js', 'JsMaterialXGenShader.js');
    let mx = null;
    try {
        const mod = await import(pathToFileURL(jsPath).href);
        mx = await mod.default({
            // MUST return a plain filesystem path string, NOT a file://
            // URL. Verified via grep of the minified glue
            // (js/JsMaterialXGenShader.js): in the Node (`isNode`)
            // branch, the .data package fetch does
            // `require("fs").readFile(packageName, cb)` with NO file://
            // handling at all — packageName comes straight from
            // Module["locateFile"](REMOTE_PACKAGE_BASE, ""), so a
            // file:// string here would make that readFile call ENOENT.
            // The .wasm path goes through readAsync(filename), which
            // DOES special-case file:// strings (`filename =
            // isFileURI(filename) ? new URL(filename) : filename` before
            // fs.readFileSync), so a bare path works there too. A single
            // plain-path-returning locateFile satisfies both — do NOT
            // "fix" this into a file:// URL later, it will break the
            // .data fetch specifically.
            locateFile: (fileName) => path.join(repoRoot, 'js', fileName),
        });

        if (!mx.EsslShaderGenerator || typeof mx.EsslShaderGenerator.create !== 'function') {
            throw new Error('EsslShaderGenerator.create is not bound in this MaterialX build.');
        }
        if (typeof mx.GenContext !== 'function') {
            throw new Error('GenContext is not bound in this MaterialX build.');
        }
        if (typeof mx.loadStandardLibraries !== 'function') {
            throw new Error('loadStandardLibraries is not bound in this MaterialX build.');
        }

        const gen = mx.EsslShaderGenerator.create();
        const genContext = new mx.GenContext(gen);
        const stdlib = mx.loadStandardLibraries(genContext);

        return { mx, stdlib };
    } catch (e) {
        // mx may or may not be set depending on where the failure
        // happened (module resolved but loadStandardLibraries threw, vs.
        // the dynamic import itself failing) — mxErr handles a null mx
        // gracefully (falls through to generic Error/String handling).
        throw new Error(mxErr(mx, e));
    }
}

// Returns a Promise that resolves to { mx, stdlib } on success, or to
// null if the loader is permanently degraded (including: it just failed
// on THIS call). Never rejects.
function getMxEnv(repoRoot) {
    if (failed) return Promise.resolve(null);
    if (loadPromise) return loadPromise;
    loadPromise = attemptLoad(repoRoot).then(
        (env) => env,
        (e) => {
            failed = true;
            pendingError = e && e.message ? e.message : String(e);
            return null;
        }
    );
    return loadPromise;
}

// ---------------------------------------------------------------------
// Semantic validation — mirrors js/viewer-app.jsx's loadMtlxDocument
// (~lines 31-50) for the parse step, and js/graph-app.jsx's "Validate"
// dialog (~lines 2062-2101) for the validate step, including its use of
// the message-holder overload of validate() (see below) to recover the
// real diagnostic text instead of a bare boolean.

// Parses a holder.message LINE's embedded serialized element (when
// present), e.g. `<input name="surfaceshader" type="surfaceshader"
// value="" nodename="preview_surface" />` -> tag "input" + attrs
// {name, type, value, nodename}. This carries every attribute the
// element has on ITSELF, but never a parent path — validator.js's
// mapSemanticMessageToRange uses `tag` + `attrs` (not just the bare
// `name="..."` value) to disambiguate same-named elements living under
// different parents, by scoring how many OTHER attributes match.
const ELEMENT_TAG_RE = /<([\w:.\-]+)((?:\s+[\w:.\-]+\s*=\s*"[^"]*")*)\s*\/?>/;
const ELEMENT_ATTR_RE = /([\w:.\-]+)\s*=\s*"([^"]*)"/g;

// repoRoot: absolute fs path to the repo root (context.extensionUri.fsPath).
// xmlText: the full document text.
// Resolves (never rejects) to one of:
//   { available: false }                                  — wasm unavailable
//   { available: true, messages: [] }                      — parsed + validated clean
//   { available: true, messages: [{ text, tag, attrs, elementName }] } — parse error OR validate() issues
async function validateSemantic(repoRoot, xmlText) {
    try {
        const env = await getMxEnv(repoRoot);
        if (!env) return { available: false };
        const { mx, stdlib } = env;

        if (typeof mx.createDocument !== 'function') return { available: false };
        const doc = mx.createDocument();

        if (typeof mx.readFromXmlString !== 'function') {
            // Mirrors js/viewer-app.jsx's defensive check (~line 36) —
            // a missing binding is tier-2 unavailability, not a thrown
            // error out of this function.
            return { available: false };
        }
        try {
            // ASYNC — mirrors js/viewer-app.jsx loadMtlxDocument
            // (~line 45): without the await, everything downstream runs
            // against a still-empty document.
            await mx.readFromXmlString(doc, xmlText);
        } catch (e) {
            return {
                available: true,
                messages: [{ text: 'MaterialX could not parse the document: ' + mxErr(mx, e), tag: null, attrs: null, elementName: null }],
            };
        }
        if (typeof doc.setDataLibrary === 'function') doc.setDataLibrary(stdlib);
        else doc.importLibrary(stdlib);

        // The WASM binding's validate() has an overloadTable {'0','1'} —
        // the PREVIOUS "boolean-only" comment here was WRONG (verified
        // headless, and js/graph-app.jsx's matching old comment was
        // wrong for the same reason — see that file's own fix). The
        // 1-arg overload accepts a plain object "holder" and fills
        // holder.message with the full newline-separated MaterialX
        // diagnostic list on failure (each line typically embeds the
        // offending element's serialized XML, including name="..."). No
        // validate() binding at all -> unavailable, same as before.
        if (typeof doc.validate !== 'function') return { available: false };
        const holder = {};
        let ok;
        try {
            ok = doc.validate(holder);
        } catch (e) {
            return {
                available: true,
                messages: [{ text: 'MaterialX document failed validation: ' + mxErr(mx, e), tag: null, attrs: null, elementName: null }],
            };
        }
        if (ok) return { available: true, messages: [] };

        // false result -> one issue per non-empty line of holder.message.
        // Each line typically embeds the offending element's OWN
        // serialized open tag — parsed via ELEMENT_TAG_RE/ELEMENT_ATTR_RE
        // above into `tag` (e.g. "input") and `attrs` (its own attribute
        // map), so validator.js's mapSemanticMessageToRange can
        // disambiguate same-named elements living under different
        // parents by scoring how many attributes match, instead of
        // trusting the first name="..." found anywhere in the line.
        // elementName is kept for backward compatibility with existing
        // consumers that only look at it: attrs.name when the line had a
        // parseable element, else the old first `name="..."` capture in
        // the line, else null.
        const issues = [];
        const rawMessage = String(holder.message || '');
        for (const rawLine of rawMessage.split(/\r\n|\r|\n/)) {
            const line = rawLine.trim();
            if (!line) continue;
            const oldNameMatch = /name="([^"]+)"/.exec(line);
            const oldName = oldNameMatch ? oldNameMatch[1] : null;

            let tag = null;
            let attrs = null;
            const elMatch = ELEMENT_TAG_RE.exec(line);
            if (elMatch) {
                tag = elMatch[1];
                attrs = {};
                const attrBlob = elMatch[2] || '';
                ELEMENT_ATTR_RE.lastIndex = 0;
                let am;
                while ((am = ELEMENT_ATTR_RE.exec(attrBlob)) !== null) {
                    attrs[am[1]] = am[2];
                }
            }
            const elementName = (attrs && attrs.name) || oldName || null;
            issues.push({ text: line, tag, attrs, elementName });
        }
        // holder.message empty despite a false result (build variance,
        // or a failure validate() itself can't attribute to any single
        // line) -> a single generic fallback issue, never zero issues
        // for a failed validation.
        if (!issues.length) {
            issues.push({ text: 'MaterialX document failed validation.', tag: null, attrs: null, elementName: null });
        }
        return { available: true, messages: issues };
    } catch (e) {
        // Tier-2 unavailability must be silent to callers — any
        // unexpected exception anywhere above becomes { available:
        // false }, never a thrown error out of this function.
        return { available: false };
    }
}

// One-shot: returns the pending init-failure string and clears it, or
// null if there's nothing new to report (never failed yet, or already
// consumed by an earlier call). The loader stays permanently degraded
// either way — this only controls whether the caller has already logged
// it once.
function consumeInitError() {
    const err = pendingError;
    pendingError = null;
    return err;
}

module.exports = {
    validateSemantic,
    consumeInitError,
};
