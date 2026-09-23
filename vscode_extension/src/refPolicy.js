// refPolicy.js: pure-Node reference containment policy used by docScanner.js.
// No require('vscode') anywhere, so it stays requireable and testable
// outside the extension host, like util.js.
'use strict';

// A leading URI scheme (RFC 3986 grammar) is never part of a safe relative
// reference. This also catches Windows drive letters ("C:", "d:"), since a
// single letter followed by ':' matches the same grammar.
const SCHEME_RE = /^[a-z][a-z0-9+.\-]*:/i;
const CONTROL_CHAR_RE = /[\x00-\x1f]/;
const DRIVE_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;

function isUnsafeRef(ref) {
    if (!ref) return true;
    if (CONTROL_CHAR_RE.test(ref)) return true;
    if (SCHEME_RE.test(ref)) return true;
    if (ref.startsWith('/') || ref.startsWith('\\')) return true; // POSIX/UNC-rooted
    if (DRIVE_ABSOLUTE_RE.test(ref)) return true; // Windows drive-absolute
    return false;
}

const INCLUDE_EXTENSIONS = new Set(['mtlx']);

// Matches js/mtlx-engine.js bindDroppedTextures's ext switch: explicit
// branches for ktx2 (line 4615) and exr/hdr/tif/tiff (line 4633), plus a
// generic image fallback (lines 4649, 4682) covering png/jpg/jpeg/gif/bmp/webp.
const TEXTURE_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'exr', 'hdr', 'tif', 'tiff', 'ktx2'
]);

function extOf(ref) {
    const clean = String(ref).split(/[?#]/)[0];
    const dot = clean.lastIndexOf('.');
    return dot < 0 ? '' : clean.slice(dot + 1).toLowerCase();
}

function isAllowedRef(ref, kind) {
    const ext = extOf(ref);
    if (kind === 'include') return INCLUDE_EXTENSIONS.has(ext);
    if (kind === 'texture') return TEXTURE_EXTENSIONS.has(ext);
    return false;
}

// child/root are POSIX-style path strings. Segment-aware on purpose: "/ws"
// must not swallow "/ws-evil/x" just because it is a string prefix.
function isPathInside(child, root, caseInsensitive) {
    let c = child;
    let r = root;
    if (caseInsensitive) {
        c = c.toLowerCase();
        r = r.toLowerCase();
    }
    return c === r || c.startsWith(r + '/');
}

module.exports = { isUnsafeRef, isAllowedRef, isPathInside, extOf };
