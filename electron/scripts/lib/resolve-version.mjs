// resolve-version.mjs: resolves the desktop app version without relying
// on any tracked file's committed number, since that number drifts from
// the release tags that actually define a version (see pack.mjs).
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function stripV(tag) {
    return tag.startsWith('v') ? tag.slice(1) : tag;
}

function tagFromEnv(env) {
    if (env.MTLX_RELEASE_TAG) return stripV(env.MTLX_RELEASE_TAG);
    if (env.GITHUB_REF_TYPE === 'tag' && env.GITHUB_REF_NAME) return stripV(env.GITHUB_REF_NAME);
    const ref = env.GITHUB_REF;
    if (ref && ref.startsWith('refs/tags/')) return stripV(ref.slice('refs/tags/'.length));
    return null;
}

// Runs git and returns trimmed stdout, or null on any failure (missing
// git binary, not a repo, shallow clone with no tags, etc). Never throws.
function tryGit(args, cwd) {
    try {
        const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
        if (result.error || result.status !== 0) return null;
        const out = (result.stdout || '').trim();
        return out.length ? out : null;
    } catch {
        return null;
    }
}

function versionFromGit(repoRoot) {
    const describeTag = tryGit(['describe', '--tags', '--abbrev=0'], repoRoot);
    if (!describeTag) return null;
    const version = stripV(describeTag);
    const countOut = tryGit(['rev-list', describeTag + '..HEAD', '--count'], repoRoot);
    const count = countOut ? parseInt(countOut, 10) : 0;
    if (count > 0) return version + '-dev.' + count;
    return version;
}

function versionFromPackageJson(repoRoot) {
    try {
        const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
        return pkg.version || null;
    } catch {
        return null;
    }
}

// Resolves the version in priority order: explicit release tag from the
// environment, git describe relative to HEAD, then the committed
// package.json as a last resort. Never throws; always returns a string.
export function resolveVersion(repoRoot, env) {
    env = env || process.env;

    const envTag = tagFromEnv(env);
    if (envTag) return { version: envTag, source: 'env-release-tag' };

    const gitVersion = versionFromGit(repoRoot);
    if (gitVersion) return { version: gitVersion, source: 'git-describe' };

    const pkgVersion = versionFromPackageJson(repoRoot);
    if (pkgVersion) return { version: pkgVersion, source: 'package.json' };

    return { version: '0.0.0', source: 'fallback' };
}
