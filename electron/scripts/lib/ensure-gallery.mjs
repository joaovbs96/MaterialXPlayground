// electron/scripts/lib/ensure-gallery.mjs: generates gallery/manifest.json
// and its thumbnails for local desktop builds via --reuse-only (download
// only, no rendering), mirroring release CI's "Populate gallery data" step.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const DEFAULT_REUSE_FROM = 'https://joaovbs96.github.io/MaterialXPlayground';

function runNode(scriptPath, args, repoRoot) {
    const result = spawnSync(process.execPath, [scriptPath, ...args], { cwd: repoRoot, stdio: 'inherit' });
    if (result.error) return { ok: false, message: String(result.error) };
    if (result.status !== 0) return { ok: false, message: 'exit code ' + result.status };
    return { ok: true };
}

// Generates gallery data at repoRoot unless skipped. mode 'pack' always
// regenerates; mode 'dev' skips when gallery/manifest.json already exists
// (pass --refresh-gallery to force), so ordinary dev launches stay fast.
export function ensureGalleryData({ repoRoot, mode, argv, env }) {
    if (argv.includes('--skip-gallery') || env.MTLX_SKIP_GALLERY === '1') {
        console.log('[gallery] --skip-gallery/MTLX_SKIP_GALLERY=1 set, skipping gallery generation.');
        return;
    }

    const manifestPath = path.join(repoRoot, 'gallery', 'manifest.json');
    if (mode === 'dev' && existsSync(manifestPath) && !argv.includes('--refresh-gallery')) {
        console.log('[gallery] gallery/manifest.json already exists, skipping (pass --refresh-gallery to regenerate).');
        return;
    }

    console.log('[gallery] building gallery manifest...');
    const manifestResult = runNode(path.join(repoRoot, 'scripts', 'build-gallery.mjs'), [], repoRoot);
    if (!manifestResult.ok) {
        console.error('[gallery] node scripts/build-gallery.mjs failed: ' + manifestResult.message);
        process.exit(1);
    }

    const reuseFrom = env.MTLX_GALLERY_REUSE_FROM || DEFAULT_REUSE_FROM;
    console.log('[gallery] downloading published thumbnails from ' + reuseFrom + ' ...');
    const shotsResult = runNode(path.join(repoRoot, 'scripts', 'gallery-shots.mjs'), ['--reuse-from', reuseFrom, '--reuse-only'], repoRoot);
    if (!shotsResult.ok) {
        console.warn('[gallery] ============================================================');
        console.warn('[gallery] WARNING: gallery-shots.mjs failed (' + shotsResult.message + ').');
        console.warn('[gallery] Some or all thumbnails are missing (offline machine, or');
        console.warn('[gallery] ' + reuseFrom + ' unreachable). The manifest was still');
        console.warn('[gallery] generated: the gallery view degrades gracefully, showing a');
        console.warn('[gallery] placeholder tile for any material with no thumbnail (see');
        console.warn('[gallery] GalleryCard in js/gallery-app.jsx:224-248). Continuing.');
        console.warn('[gallery] ============================================================');
    }
}
