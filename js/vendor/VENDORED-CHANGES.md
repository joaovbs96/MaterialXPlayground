# Vendored file changes

Local modifications to files under `js/vendor/`, one entry per change. If a
file listed here is re-vendored from upstream, its patch must be reapplied.

## js/vendor/EXRLoader.js

Upstream origin: three.js `examples/js/loaders/EXRLoader.js` (legacy UMD
build), pinned to three@0.147.0.

### 2026-07-14: DWA decode crash on layer-prefixed channel names

What: ported the channel-rule matching used by three's current ES-module
loader (`examples/jsm/loaders/EXRLoader.js`, pulled from three@0.185.1) into
this UMD file's `uncompressDWA()`. The match now compares the channel-name
suffix after the last `.` plus pixel type, instead of the whole name, guards
the `lossyDctDecode()` call on a complete RGB CSC triplet, and adds a ported
`lossyDctChannelDecode()` for LOSSY_DCT channels outside that triplet.

Why: r147's naive `cd.name == rule.name` equality never matched layer-prefixed
channel names (e.g. `RGBA.R`, the default naming used by Blender/Nuke
exporters), so `lossyDctDecode()` ran with an unset CSC slot and threw
`Cannot read properties of undefined (reading 'width')`.

How to verify: decode a DWAA/DWAB-compressed EXR with layer-prefixed channel
names through `loadExrTexture` (js/mtlx-engine.js) and confirm it decodes
without throwing.

Full detail is preserved in the file's own header comment (js/vendor/EXRLoader.js:1-45).

### 2026-09-20: single-channel (non-RGBA) output wrote 3 floats too far right

Where: `js/vendor/EXRLoader.js`, the scanline decode loop around line 2136-2140
(`channelOffsets` lookup / `cOff` computation), inside `EXRLoader.parse()`.

What changed: `cOff` (the channel's offset within one pixel's output slot)
was unconditionally taken from a hardcoded `{R:0,G:1,B:2,A:3,Y:0}` table, even
when the decoded output was not 4-channel RGBA. The fix makes that table apply
only when `EXRDecoder.outputChannels === 4` (the RGB-promoted-to-RGBA case);
otherwise `cOff` is the channel's own loop index, i.e. its position in the
actual output channel set.

Why: a real-world asset (an emboss/displacement height map) is a single-channel
float EXR whose one channel is named `"A"`. For that file `outputChannels` is
1 (`RedFormat`), but the old table still mapped channel `"A"` to slot 3. Every
scanline write landed 3 floats past its correct position: interior pixels
smeared into the next row's first 3 slots, and the last scanline's last 3
samples were written past the end of the output `Float32Array` and silently
dropped by JS typed-array semantics, leaving those 3 slots at the buffer's
default 0. After the engine's row flip those 3 zero texels ended up at the
image's bottom-left corner. Downstream, the displacement material's `remap`/
`multiply` chain turns a texel value of 0 into a small negative offset (about
-0.0003) instead of the authored ~0 (texel value 1.0), producing a visible
crease. This was fully diagnosed by hand-decoding the affected EXR's header
and pixel data and by simulating the loader's exact index arithmetic; no
scratch files are cited here since the write-up lived in a scratchpad, but the
reasoning is reproduced above and in the fix's own code comment.

How to verify: `node --test tests/unit/exr-loader-single-channel.test.mjs`
decodes a synthetic single-channel `"A"` float EXR and asserts every output
texel matches its authored value with none left at 0, and separately asserts
a 3-channel RGB EXR still promotes to RGBA unchanged. For a visual check,
re-decode the affected asset's EXR height map and confirm its border texels
are no longer 0-valued.

Must be reapplied if `js/vendor/EXRLoader.js` is re-vendored from a newer
three.js release.
