// textureStamp.js: the '?v=' cache-buster on texture webview URLs. VS Code's
// webview resource cache revalidates by mtime+size, so a replaced file that
// keeps both (a copy that preserves the timestamp) would be served stale.
'use strict';

const fs = require('fs');

// mtime-size, plus the change time when known: ctime moves on every write,
// replace or utimes call and cannot be set back by a copy.
function versionTag(info) {
    const parts = [info.mtime, info.size];
    if (info.ctimeNs != null && info.ctimeNs !== '') parts.push(String(info.ctimeNs));
    return parts.join('-');
}

function versionedUrl(baseUrl, info) {
    return baseUrl + '?v=' + versionTag(info);
}

// Change time in ns (a decimal string) for a local file, or null.
async function changeTimeNs(uri, statImpl) {
    if (!uri || uri.scheme !== 'file') return null;
    try {
        const st = await (statImpl || fs.promises.stat)(uri.fsPath, { bigint: true });
        return st && st.ctimeNs != null ? String(st.ctimeNs) : null;
    } catch (e) {
        return null;
    }
}

// Copy of docScanner's textures map with ctimeNs added to each entry.
async function withChangeTimes(textures, statImpl) {
    const out = {};
    await Promise.all(Object.keys(textures).map(async (key) => {
        const t = textures[key];
        out[key] = Object.assign({}, t, { ctimeNs: await changeTimeNs(t.uri, statImpl) });
    }));
    return out;
}

module.exports = { versionTag, versionedUrl, changeTimeNs, withChangeTimes };
