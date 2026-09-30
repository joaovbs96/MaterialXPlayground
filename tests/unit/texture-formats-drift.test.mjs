import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Drift guard: js/shared/texture-formats.js is the single source of truth
// for decodable image extensions. This scans for any OTHER hard-coded list
// of two or more of them (a regex alternation, an array/Set literal, or an
// <input accept> string) so a future edit can't silently reintroduce a
// second, drifting copy of the list (e.g. TGA sneaking back in).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const EXCLUDED_DIRS = [
    path.join(root, 'js', 'gen'),
    path.join(root, 'js', 'vendor'),
    path.join(root, 'js', 'materialx'),
];
const EXCLUDED_FILES = [
    path.join(root, 'js', 'shared', 'texture-formats.js'),
];

// refPolicy.js, sceneProvider.js, extension.js and mtlx-engine.js's image
// regex all now derive from js/shared/texture-formats.js (host batch), so
// the guard covers them too. No offenders left.
const KNOWN_OFFENDERS = [];

// Includes the literal regex-shorthand spellings ("jpe?g", "tiff?") some
// existing regex literals use, so the '?' inside them (a literal character
// in the SOURCE TEXT this scanner reads, not scanner syntax) is matched too
// instead of silently breaking the alternation chain around it.
const EXT_ALT = 'jpe\\?g|png|jpeg|jpg|exr|hdr|tiff\\?|tiff|tif|ktx2|webp|bmp|gif|tga';
const TOKEN_SRC = `[.'"]?\\b(?:${EXT_ALT})\\b['"]?`;
const LIST_RE_SRC = `(?:${TOKEN_SRC})(?:\\s*[,|]\\s*(?:${TOKEN_SRC})){1,}`;

// A run of 2-3 of these also shows up in deliberately narrow, unrelated
// lists (e.g. accept=".hdr,.exr" for environment maps, or a texture-export
// format picker) that are not the decodable-texture list this module owns.
// Real drift of the FULL list always reintroduces many more than that, so
// only flag runs covering at least this many DISTINCT extension groups.
const MIN_DISTINCT_GROUPS = 4;

const GROUP_OF = (token) => {
    const t = token.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (t === 'jpg' || t === 'jpeg') return 'jpeg';
    if (t === 'tif' || t === 'tiff') return 'tiff';
    return t;
};

function walk(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (EXCLUDED_DIRS.includes(full)) continue;
            walk(full, out);
        } else if (/\.(js|jsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
}

function collectFiles() {
    const files = [];
    walk(path.join(root, 'js'), files);
    walk(path.join(root, 'vscode_extension', 'src'), files);
    return files.filter((f) => !EXCLUDED_FILES.includes(f));
}

function scanFile(file) {
    const hits = [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const tokenRe = new RegExp(TOKEN_SRC, 'gi');
    lines.forEach((line, i) => {
        const listRe = new RegExp(LIST_RE_SRC, 'gi');
        let m;
        while ((m = listRe.exec(line))) {
            tokenRe.lastIndex = 0;
            const groups = new Set();
            let tm;
            while ((tm = tokenRe.exec(m[0]))) groups.add(GROUP_OF(tm[0]));
            if (groups.size >= MIN_DISTINCT_GROUPS) hits.push({ line: i + 1, text: m[0] });
        }
    });
    return hits;
}

test('no hard-coded image-extension list drifts from js/shared/texture-formats.js', () => {
    const offenders = [];
    for (const file of collectFiles()) {
        const hits = scanFile(file);
        if (!hits.length) continue;
        if (KNOWN_OFFENDERS.includes(file)) continue; // reported, not enforced yet
        for (const hit of hits) offenders.push(`${path.relative(root, file)}:${hit.line}  ${hit.text}`);
    }
    assert.deepEqual(offenders, [], 'hard-coded extension list(s) found:\n' + offenders.join('\n'));
});
