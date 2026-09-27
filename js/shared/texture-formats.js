// js/shared/texture-formats.js: single source of truth for which image
// extensions the app can actually decode. Dual-mode (window global + Node
// require) so vscode_extension host code can require() it directly.
//
// Decodable set per js/mtlx-engine.js bindDroppedTextures (~4773-4806):
// ktx2, exr, hdr, tif/tiff each have a dedicated decoder; the rest go
// through createImageBitmap. TGA has never had a decoder here (some file
// pickers used to accept it and it would just silently fail) so it is
// deliberately excluded.
const MTLX_TEXTURE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'exr', 'hdr', 'tif', 'tiff', 'ktx2'];

// Subset with a dedicated decoder path rather than createImageBitmap;
// mirrors mtlx-engine.js's ext === 'exr'/'hdr'/'tif'/'tiff'/'ktx2' branches.
const MTLX_DEDICATED_DECODER_EXTS = ['exr', 'hdr', 'tif', 'tiff', 'ktx2'];

// Extension -> MIME type, for wrapping raw bytes in a Blob with the right
// type (js/usd-scene-renderer.js canonicalizeSceneTextures).
const MTLX_TEXTURE_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp',
    tif: 'image/tiff', tiff: 'image/tiff', exr: 'image/x-exr', hdr: 'image/vnd.radiance',
    ktx2: 'image/ktx2',
};

// New RegExp each call: cheap, and avoids any lastIndex surprises for
// callers that keep a reference around.
const textureExtRegex = () => new RegExp('\\.(' + MTLX_TEXTURE_EXTS.join('|') + ')$', 'i');

const isTextureFile = (name) => textureExtRegex().test(String(name || ''));

// "<input accept>" string, e.g. ".png,.jpg,.jpeg,...".
const textureAccept = () => MTLX_TEXTURE_EXTS.map((ext) => '.' + ext).join(',');

const MTLX_TEXTURE_FORMATS_EXPORTS = {
    MTLX_TEXTURE_EXTS, MTLX_DEDICATED_DECODER_EXTS, MTLX_TEXTURE_MIME,
    textureExtRegex, isTextureFile, textureAccept,
};

if (typeof window !== 'undefined') {
    Object.assign(window, MTLX_TEXTURE_FORMATS_EXPORTS);
}
if (typeof module !== 'undefined') {
    module.exports = MTLX_TEXTURE_FORMATS_EXPORTS;
}
