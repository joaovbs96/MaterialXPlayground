// textureStamp.js: the '?v=' cache-buster on texture webview URLs. The webview
// service worker caches by full URL and revalidates by mtime+size, so the stamp
// must change whenever the bytes do, even when every timestamp is preserved.
'use strict';

const fs = require('fs');
const crypto = require('crypto');

// Bytes hashed from each end of a file for the content fingerprint.
const SAMPLE_BYTES = 64 * 1024;

// mtime-size, plus the change time and content fingerprint when known.
function versionTag(info) {
    const parts = [info.mtime, info.size];
    if (info.ctimeNs != null && info.ctimeNs !== '') parts.push(String(info.ctimeNs));
    if (info.fingerprint) parts.push(info.fingerprint);
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

// SHA-1 (12 hex) of the first and last SAMPLE_BYTES plus the length, or null.
// Windows CopyFile carries mtime AND change time over from the source, so
// only the bytes tell two same-size copies apart. Never reads more than 128KB.
async function contentFingerprint(uri, openImpl) {
    if (!uri || uri.scheme !== 'file') return null;
    let fh = null;
    try {
        fh = await (openImpl || fs.promises.open)(uri.fsPath, 'r');
        const size = Number((await fh.stat()).size);
        const hash = crypto.createHash('sha1').update(String(size) + ':');
        const readAt = async (pos, len) => {
            const buf = Buffer.alloc(len);
            const { bytesRead } = await fh.read(buf, 0, len, pos);
            hash.update(buf.subarray(0, bytesRead));
        };
        await readAt(0, Math.min(size, SAMPLE_BYTES));
        const tail = Math.min(SAMPLE_BYTES, size - SAMPLE_BYTES);
        if (tail > 0) await readAt(size - tail, tail);
        return hash.digest('hex').slice(0, 12);
    } catch (e) {
        return null;
    } finally {
        if (fh) await fh.close().catch(() => {});
    }
}

// Copy of docScanner's textures map with ctimeNs and fingerprint on each entry.
async function withVersions(textures, statImpl, openImpl) {
    const out = {};
    await Promise.all(Object.keys(textures).map(async (key) => {
        const t = textures[key];
        const [ctimeNs, fingerprint] = await Promise.all([changeTimeNs(t.uri, statImpl), contentFingerprint(t.uri, openImpl)]);
        out[key] = Object.assign({}, t, { ctimeNs, fingerprint });
    }));
    return out;
}

module.exports = { versionTag, versionedUrl, changeTimeNs, contentFingerprint, withVersions, SAMPLE_BYTES };
