// builder-app.jsx - "Embed Builder" view: configure an embeddable
// <materialx-viewer>, preview it live, and copy a ready-made
// <iframe> or <script>+<materialx-viewer> snippet.

// Mirrors embed/viewer.html's own vocabulary (docs/EMBEDDING.md),
// duplicated locally since each lazy view script is its own scope (see
// compare-app.jsx's loadMtlxDocument comment for the same rationale).
const BUILDER_GEOM_OPTIONS = ['shaderball-scene', 'shaderball', 'shaderball-mtlx', 'sphere', 'cube', 'cloth'];
const BUILDER_DEFAULT_GEOM = 'shaderball-scene';
const BUILDER_CONTROLS = [
    { id: 'geometry', label: 'Geometry picker' },
    { id: 'material', label: 'Material picker' },
    { id: 'rotate', label: 'Auto-rotate toggle' },
    { id: 'reset', label: 'Reset camera button' },
    { id: 'env', label: 'Environment panel' },
    { id: 'screenshot', label: 'Screenshot button' },
    { id: 'settings', label: 'Settings panel' },
    { id: 'fullscreen', label: 'Fullscreen toggle' },
];
// radius is stored/edited as a bare number (the field is numeric, docs/
// EMBEDDING.md); the "px" suffix is appended wherever it's emitted, since
// embed-boot.js validates with CSS.supports and rejects a bare number.
const BUILDER_THEME_DEFAULTS = { accent: '#3b82f6', surface: '#1f2937', text: '#d1d5db', radius: '4' };
const builderRadiusPx = (v) => { const t = String(v == null ? '' : v).trim(); return t ? t + 'px' : ''; };

// Checkerboard backdrop shown behind the preview element while Transparent
// is checked, so an actually-transparent render is visible (the
// image-editor alpha convention) instead of blending into the page.
const BUILDER_CHECKERBOARD_STYLE = {
    backgroundImage:
        'linear-gradient(45deg, #3f3f46 25%, transparent 25%, transparent 75%, #3f3f46 75%, #3f3f46), '
        + 'linear-gradient(45deg, #3f3f46 25%, transparent 25%, transparent 75%, #3f3f46 75%, #3f3f46)',
    backgroundSize: '24px 24px',
    backgroundPosition: '0 0, 12px 12px',
    backgroundColor: '#27272a',
};

// The directory index.html lives in, e.g. "https://host/MaterialXPlayground/".
// Both snippet types resolve embed/* against this, same as a real host page.
const BUILDER_SITE_BASE = new URL('.', window.location.href).href;

const builderNorm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const builderEscAttr = (s) => String(s).replace(/"/g, '&quot;');

// MaterialX version list for the "MaterialX version" select, mirroring
// js/mtlx-assets.js's getters. Falls back to a single-entry list if the
// module or its fetched version registry isn't available yet.
const BUILDER_DEFAULT_VERSION = (window.MtlxAssets && window.MtlxAssets.MTLX_DEFAULT_VERSION) || '';
const BUILDER_VERSIONS = (window.MtlxAssets && Array.isArray(window.MtlxAssets.MTLX_VERSIONS) && window.MtlxAssets.MTLX_VERSIONS.length)
    ? window.MtlxAssets.MTLX_VERSIONS
    : (BUILDER_DEFAULT_VERSION ? [BUILDER_DEFAULT_VERSION] : []);

// Detects a GitHub "blob" page URL (an HTML page, not raw file content) so
// commitSrcValue can hint at the raw.githubusercontent.com equivalent.
const BUILDER_GITHUB_BLOB_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i;
const builderGithubBlobHint = (url) => {
    const m = BUILDER_GITHUB_BLOB_RE.exec(url);
    if (!m) return null;
    return `This is a GitHub "blob" page URL, not raw file content. Try https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]} instead.`;
};

const BUILDER_CORS_HINT = `This document's host may not send CORS headers, so the iframe may be blocked from fetching it directly. See the Help dialog's "Loading a document without CORS" section.`;

// Rounds to 3 decimals and lets Number -> String trim any trailing zeros.
// `|| 0` also folds a rounded -0 back to a plain 0 for display.
const builderFormatCamera = (pose) => {
    const nums = [...(pose.position || []), ...(pose.target || [])];
    return nums.map((n) => String(Math.round(Number(n) * 1000) / 1000 || 0)).join(',');
};

const FIELD_LABEL_CLS = 'block text-xs font-medium text-gray-400 mb-1';
const TEXT_INPUT_CLS = 'w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500';

// A CSS-color text field paired with a native swatch (hex-only). The
// text field is the source of truth and accepts any CSS color, including
// an invalid one - the error banner below is meant to catch exactly that.
function ColorField({ label, value, onChange, placeholder }) {
    const hex = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
    return (
        <div>
            <label className={FIELD_LABEL_CLS}>{label}</label>
            <div className="flex items-center gap-2">
                <input
                    type="color"
                    value={hex}
                    onChange={(e) => onChange(e.target.value)}
                    title="Pick a color (hex only - type any CSS color in the field for anything else)"
                    className="h-8 w-8 rounded border border-gray-700 bg-gray-900 shrink-0 cursor-pointer"
                />
                <input
                    type="text"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    className={TEXT_INPUT_CLS}
                />
            </div>
        </div>
    );
}

// One snippet output: a header with a copy button, plus a code block.
// Highlights under "xml" only if highlight.js already happens to be
// loaded (see js/graph/dialogs.jsx's XmlDialog for the same fallback).
function SnippetPanel({ title, code, copied, onCopy }) {
    const highlighted = React.useMemo(() => {
        if (typeof window === 'undefined' || !window.hljs || typeof window.hljs.highlight !== 'function') return null;
        try { return window.hljs.highlight(code, { language: 'xml' }).value; } catch (e) { return null; }
    }, [code]);
    return (
        <div className="rounded-lg border border-gray-700 bg-gray-900 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 bg-gray-800/60">
                <span className="text-sm font-medium text-gray-200">{title}</span>
                <button
                    type="button"
                    onClick={onCopy}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border bg-gray-800 border-gray-600 text-gray-200 hover:bg-gray-700 transition-colors"
                >
                    <MtlxIcon name={copied ? 'check' : 'copy'} className="w-3.5 h-3.5" />
                    {copied ? 'Copied!' : 'Copy'}
                </button>
            </div>
            <pre className="p-3 text-xs leading-relaxed overflow-x-auto text-gray-300 max-h-72 custom-scrollbar">
                {highlighted ? <code dangerouslySetInnerHTML={{ __html: highlighted }} /> : <code>{code}</code>}
            </pre>
        </div>
    );
}

// Scoped styling for the Help dialog's rendered markdown fragment
// (js/gen/embedding-docs.html, GitHub-style HTML generated from
// docs/EMBEDDING.md by scripts/build-embed-docs.mjs).
const BUILDER_HELP_DOC_CSS = `
.embed-help-doc { color: #d1d5db; font-size: 13px; line-height: 1.65; }
.embed-help-doc h1 { font-size: 1.3rem; font-weight: 700; color: #f3f4f6; margin: 0 0 0.75rem; }
.embed-help-doc h2 { font-size: 1.05rem; font-weight: 700; color: #f3f4f6; margin: 1.75rem 0 0.6rem; padding-top: 0.75rem; border-top: 1px solid #374151; }
.embed-help-doc h2:first-of-type { margin-top: 0; padding-top: 0; border-top: 0; }
.embed-help-doc h3 { font-size: 0.92rem; font-weight: 700; color: #e5e7eb; margin: 1.25rem 0 0.5rem; }
.embed-help-doc p { margin: 0.6rem 0; }
.embed-help-doc ul, .embed-help-doc ol { margin: 0.6rem 0; padding-left: 1.4rem; }
.embed-help-doc li { margin: 0.25rem 0; }
.embed-help-doc a { color: #60a5fa; text-decoration: underline; }
.embed-help-doc a:hover { color: #93c5fd; }
.embed-help-doc code { background: #111827; color: #fca5a5; padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.85em; }
.embed-help-doc pre { background: #0f172a; border: 1px solid #374151; border-radius: 6px; padding: 0.75rem; overflow-x: auto; margin: 0.75rem 0; }
.embed-help-doc pre code { background: none; color: #d1d5db; padding: 0; border-radius: 0; font-size: 0.85em; }
.embed-help-doc table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; font-size: 0.85em; }
.embed-help-doc th, .embed-help-doc td { border: 1px solid #374151; padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }
.embed-help-doc th { background: #1f2937; color: #e5e7eb; }
.embed-help-doc hr { border: none; border-top: 1px solid #374151; margin: 1.25rem 0; }
`;

// Renders js/gen/embedding-docs.html (fetched/cached by BuilderApp itself,
// so the cache survives this component unmounting on close) inside a
// DialogFrame. Highlights code blocks with highlight.js if it happens to
// be loaded, same optional-dependency fallback as SnippetPanel above.
function BuilderHelpDialog({ open, onClose, html, loading, error }) {
    const bodyRef = React.useRef(null);
    useEscapeToClose(onClose, open);

    React.useEffect(() => {
        if (!open || !html || !bodyRef.current) return;
        if (!window.hljs || typeof window.hljs.highlightElement !== 'function') return;
        bodyRef.current.querySelectorAll('pre code').forEach((el) => {
            try { window.hljs.highlightElement(el); } catch (e) { /* leave it unhighlighted */ }
        });
    }, [open, html]);

    // Intercepts in-page "#anchor" links so they scroll within the dialog
    // instead of changing location.hash, which the site's hash router
    // would otherwise read as a navigation away from the Builder view.
    const handleBodyClick = (e) => {
        const a = e.target.closest && e.target.closest('a[href^="#"]');
        if (!a || !bodyRef.current) return;
        e.preventDefault();
        const id = a.getAttribute('href').slice(1);
        const target = Array.from(bodyRef.current.querySelectorAll('[id]')).find((el) => el.id === id);
        if (target) target.scrollIntoView({ block: 'start' });
    };

    if (!open) return null;
    return (
        <DialogFrame
            open={open}
            title="Embedding reference"
            onClose={onClose}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/70"
            panelClassName="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-[46rem] max-w-[92%] max-h-[85vh] overflow-hidden flex flex-col"
        >
            <style>{BUILDER_HELP_DOC_CSS}</style>
            <div ref={bodyRef} onClick={handleBodyClick} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 py-4">
                {loading && <div className="text-gray-400 text-sm animate-pulse">Loading...</div>}
                {!loading && error && (
                    <div className="text-amber-200 text-sm space-y-2">
                        <p>Could not load the embedding reference.</p>
                        <a
                            href="https://github.com/joaovbs96/MaterialXPlayground/blob/main/docs/EMBEDDING.md"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 underline"
                        >
                            View docs/EMBEDDING.md on GitHub
                        </a>
                    </div>
                )}
                {!loading && !error && html != null && <div dangerouslySetInnerHTML={{ __html: html }} />}
            </div>
        </DialogFrame>
    );
}

function BuilderApp({ active } = {}) {
    const [src, setSrc] = React.useState('');
    const [geometry, setGeometry] = React.useState(BUILDER_DEFAULT_GEOM);
    const [controls, setControls] = React.useState({});
    const [background, setBackground] = React.useState(false);
    const [transparent, setTransparent] = React.useState(false);
    const [autorotate, setAutorotate] = React.useState(false);
    const [env, setEnv] = React.useState('');
    const [exposure, setExposure] = React.useState('');
    const [envmap, setEnvmap] = React.useState('');
    const [accent, setAccent] = React.useState(BUILDER_THEME_DEFAULTS.accent);
    const [surface, setSurface] = React.useState(BUILDER_THEME_DEFAULTS.surface);
    const [text, setText] = React.useState(BUILDER_THEME_DEFAULTS.text);
    const [radius, setRadius] = React.useState(BUILDER_THEME_DEFAULTS.radius);
    const [width, setWidth] = React.useState(640);
    const [height, setHeight] = React.useState(480);
    const [sizing, setSizing] = React.useState('fixed'); // 'fixed' | 'responsive'

    const [presetPick, setPresetPick] = React.useState(''); // selected MTLX_PRESETS URL, or '' (placeholder)
    const [renderables, setRenderables] = React.useState([]); // last 'mtlx-renderables' detail
    const [material, setMaterial] = React.useState(''); // '' = unset (first material)
    const [camera, setCamera] = React.useState(''); // "px,py,pz,tx,ty,tz", or '' (default)
    const [wheelZoom, setWheelZoom] = React.useState(false);
    const [version, setVersion] = React.useState(BUILDER_DEFAULT_VERSION);
    const [poster, setPoster] = React.useState('');
    const [eager, setEager] = React.useState(false);

    const [helpOpen, setHelpOpen] = React.useState(false);
    const [helpHtml, setHelpHtml] = React.useState(null);
    const [helpError, setHelpError] = React.useState(false);
    const [helpLoading, setHelpLoading] = React.useState(false);
    const helpFetchStartedRef = React.useRef(false);

    const [ready, setReady] = React.useState(false);
    const [errors, setErrors] = React.useState([]);
    const [copiedKey, setCopiedKey] = React.useState(null);
    const copyTimerRef = React.useRef(null);

    const previewMountRef = React.useRef(null);
    const previewElRef = React.useRef(null);

    // Pushes an advisory message into the errors banner, deduped against
    // whatever the last entry already says so repeated hints don't stack
    // up back-to-back (a real mtlx-error can still follow/precede it).
    const pushHint = (message) => {
        setErrors((prev) => (prev.length && prev[prev.length - 1].message === message)
            ? prev
            : [...prev.slice(-5), { id: Math.random(), message }]);
    };

    const controlsList = BUILDER_CONTROLS.filter((c) => controls[c.id]).map((c) => c.id);
    // Round trips embed-boot.js's `all` keyword: every box ticked emits it.
    // None ticked emits '' - omitted below, same chromeless default as `none`.
    const controlsStr = controlsList.length === BUILDER_CONTROLS.length ? 'all' : controlsList.join(',');

    // Builds the real <materialx-viewer> element off-DOM (not via JSX),
    // so `eager` and the initial src/geometry/controls are all set before
    // connectedCallback runs, instead of racing a later attribute update.
    React.useEffect(() => {
        const el = document.createElement('materialx-viewer');
        el.eager = true;
        el.style.width = '100%';
        el.style.height = '100%';
        if (src.trim()) el.src = src.trim();
        el.geometry = geometry;
        if (env.trim() !== '') el.env = env.trim();
        if (exposure.trim() !== '') el.exposure = exposure.trim();
        el.autorotate = autorotate;
        el.controls = controlsStr;
        el.background = background;
        el.transparent = transparent;
        el.accent = accent;
        el.surface = surface;
        el.text = text;
        el.radius = builderRadiusPx(radius);
        if (material) el.material = material;
        if (camera.trim()) el.camera = camera.trim();
        if (wheelZoom) el.wheel = 'zoom';
        if (version) el.version = version;
        if (poster.trim()) el.poster = poster.trim();
        if (envmap.trim()) el.envmap = envmap.trim();
        const handleError = (e) => {
            const message = (e && e.detail && e.detail.message) || 'Unknown error';
            setErrors((prev) => [...prev.slice(-5), { id: Math.random(), message }]);
            if (/fetch|network|cors/i.test(message)) pushHint(BUILDER_CORS_HINT);
        };
        const handleReady = () => setReady(true);
        const handleRenderables = (e) => setRenderables(Array.isArray(e.detail) ? e.detail : []);
        el.addEventListener('mtlx-error', handleError);
        el.addEventListener('mtlx-ready', handleReady);
        el.addEventListener('mtlx-renderables', handleRenderables);
        previewElRef.current = el;
        if (previewMountRef.current) previewMountRef.current.appendChild(el);
        return () => {
            el.removeEventListener('mtlx-error', handleError);
            el.removeEventListener('mtlx-ready', handleReady);
            el.removeEventListener('mtlx-renderables', handleRenderables);
            el.remove();
            previewElRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Live-updating properties (docs/EMBEDDING.md LIVE_ATTRS): applied on
    // every change via the element's own property setters, which handle
    // the postMessage round trip - no reload, so no debounce needed here.
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.geometry = geometry; }, [geometry]);
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.env = env.trim(); }, [env]);
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.exposure = exposure.trim(); }, [exposure]);
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.background = background; }, [background]);
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.transparent = transparent; }, [transparent]);
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.accent = accent; }, [accent]);
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.surface = surface; }, [surface]);
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.text = text; }, [text]);
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.radius = builderRadiusPx(radius); }, [radius]);
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.material = material; }, [material]);
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.camera = camera.trim(); }, [camera]);
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.poster = poster.trim(); }, [poster]);

    // Drops the current material selection once a newly parsed document's
    // renderables no longer include it (e.g. a different src was loaded).
    React.useEffect(() => {
        setMaterial((prev) => (prev && !renderables.some((r) => r.name === prev)) ? '' : prev);
    }, [renderables]);

    // Reload-triggering properties: controls and autorotate are discrete
    // clicks (not typed text), so applying them immediately is fine - the
    // reload they cause is the documented, expected behavior.
    React.useEffect(() => {
        if (!previewElRef.current) return;
        setReady(false);
        previewElRef.current.controls = controlsStr;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [controlsStr]);
    React.useEffect(() => {
        if (!previewElRef.current) return;
        setReady(false);
        previewElRef.current.autorotate = autorotate;
    }, [autorotate]);
    React.useEffect(() => {
        if (!previewElRef.current) return;
        setReady(false);
        previewElRef.current.wheel = wheelZoom ? 'zoom' : '';
    }, [wheelZoom]);
    React.useEffect(() => {
        if (!previewElRef.current) return;
        setReady(false);
        previewElRef.current.version = version;
    }, [version]);

    // `src` is free-typed text - applying it on every keystroke would
    // reload the iframe per character. Commit only on blur/Enter, and only
    // if it actually changed, or "loading" sticks for a reload that never comes.
    const commitSrcValue = (raw) => {
        if (!previewElRef.current) return;
        const next = String(raw == null ? '' : raw).trim();
        if (previewElRef.current.src === next) return;
        setReady(false);
        previewElRef.current.src = next;
        const blobHint = builderGithubBlobHint(next);
        if (blobHint) pushHint(blobHint);
    };
    const commitSrc = () => commitSrcValue(src);

    // envmap is LIVE but every change fetches/decodes inside the iframe, so
    // commit on blur/Enter only, same as src. Empty commits a removal via
    // the element's own reflection, restoring the default environment.
    const commitEnvmapValue = (raw) => {
        if (!previewElRef.current) return;
        const next = String(raw == null ? '' : raw).trim();
        if (previewElRef.current.envmap === next) return;
        previewElRef.current.envmap = next;
    };
    const commitEnvmap = () => commitEnvmapValue(envmap);

    // Picking a preset fills the src field and commits it immediately,
    // same as typing a URL then pressing Enter. Typing in the src field
    // afterwards resets this select back to its placeholder (see below).
    const handlePresetPick = (e) => {
        const url = e.target.value;
        setPresetPick(url);
        if (!url) return;
        setSrc(url);
        commitSrcValue(url);
    };

    const handleUseCurrentView = async () => {
        if (!previewElRef.current) return;
        try {
            const pose = await previewElRef.current.getCamera();
            setCamera(builderFormatCamera(pose));
        } catch (err) {
            setErrors((prev) => [...prev.slice(-5), { id: Math.random(), message: errMsg(err) }]);
        }
    };

    // Fetches js/gen/embedding-docs.html once, the first time the Help
    // dialog opens; the result is cached here so reopening it is instant.
    React.useEffect(() => {
        if (!helpOpen || helpFetchStartedRef.current) return;
        helpFetchStartedRef.current = true;
        setHelpLoading(true);
        fetch(BUILDER_SITE_BASE + 'js/gen/embedding-docs.html')
            .then((res) => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); })
            .then((html) => setHelpHtml(html))
            .catch(() => setHelpError(true))
            .finally(() => setHelpLoading(false));
    }, [helpOpen]);

    React.useEffect(() => () => clearTimeout(copyTimerRef.current), []);
    const copySnippet = async (key, code) => {
        const copy = window.copyTextToClipboard;
        const ok = copy ? await copy(code) : false;
        if (!ok) return;
        setCopiedKey(key);
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopiedKey(null), 1500);
    };

    // ---- Snippet generation: omit anything at its documented default ----
    const queryEntries = () => {
        const entries = [];
        if (src.trim()) entries.push(['src', src.trim()]);
        if (geometry !== BUILDER_DEFAULT_GEOM) entries.push(['geometry', geometry]);
        if (env.trim() !== '') entries.push(['env', env.trim()]);
        if (exposure.trim() !== '') entries.push(['exposure', exposure.trim()]);
        if (envmap.trim()) entries.push(['envmap', envmap.trim()]);
        if (autorotate) entries.push(['autorotate', '1']);
        if (controlsStr) entries.push(['controls', controlsStr]);
        if (background) entries.push(['background', '1']);
        if (transparent) entries.push(['transparent', '1']);
        if (builderNorm(accent) !== builderNorm(BUILDER_THEME_DEFAULTS.accent)) entries.push(['accent', accent.trim()]);
        if (builderNorm(surface) !== builderNorm(BUILDER_THEME_DEFAULTS.surface)) entries.push(['surface', surface.trim()]);
        if (builderNorm(text) !== builderNorm(BUILDER_THEME_DEFAULTS.text)) entries.push(['text', text.trim()]);
        if (radius.trim() && builderNorm(radius) !== builderNorm(BUILDER_THEME_DEFAULTS.radius)) entries.push(['radius', builderRadiusPx(radius)]);
        if (material) entries.push(['material', material]);
        if (camera.trim()) entries.push(['camera', camera.trim()]);
        if (wheelZoom) entries.push(['wheel', 'zoom']);
        if (version && version !== BUILDER_DEFAULT_VERSION) entries.push(['version', version]);
        return entries;
    };

    const iframeUrl = (() => {
        const entries = queryEntries();
        const qs = entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        return BUILDER_SITE_BASE + 'embed/viewer.html' + (qs ? '?' + qs : '');
    })();

    // Responsive drops width/height for a CSS aspect-ratio instead; eager
    // drops `loading="lazy"` either way, since there's nothing left to defer.
    const iframeSnippet = (() => {
        const lines = [`src="${builderEscAttr(iframeUrl)}"`];
        lines.push(sizing === 'responsive'
            ? `style="width:100%;aspect-ratio:${width}/${height};height:auto;border:0"`
            : `width="${width}" height="${height}" style="border:0"`);
        const flags = [];
        if (!eager) flags.push('loading="lazy"');
        flags.push('allow="fullscreen"', 'allowfullscreen');
        lines.push(flags.join(' '));
        lines.push('title="MaterialX material preview"');
        return `<iframe\n` + lines.map((l) => '  ' + l).join('\n') + `>\n</iframe>`;
    })();

    const elementSnippet = (() => {
        const attrs = [];
        if (src.trim()) attrs.push(`src="${builderEscAttr(src.trim())}"`);
        if (geometry !== BUILDER_DEFAULT_GEOM) attrs.push(`geometry="${geometry}"`);
        if (env.trim() !== '') attrs.push(`env="${env.trim()}"`);
        if (exposure.trim() !== '') attrs.push(`exposure="${exposure.trim()}"`);
        if (envmap.trim()) attrs.push(`envmap="${builderEscAttr(envmap.trim())}"`);
        if (autorotate) attrs.push('autorotate');
        if (controlsStr) attrs.push(`controls="${controlsStr}"`);
        if (background) attrs.push('background');
        if (transparent) attrs.push('transparent');
        if (builderNorm(accent) !== builderNorm(BUILDER_THEME_DEFAULTS.accent)) attrs.push(`accent="${builderEscAttr(accent.trim())}"`);
        if (builderNorm(surface) !== builderNorm(BUILDER_THEME_DEFAULTS.surface)) attrs.push(`surface="${builderEscAttr(surface.trim())}"`);
        if (builderNorm(text) !== builderNorm(BUILDER_THEME_DEFAULTS.text)) attrs.push(`text="${builderEscAttr(text.trim())}"`);
        if (radius.trim() && builderNorm(radius) !== builderNorm(BUILDER_THEME_DEFAULTS.radius)) attrs.push(`radius="${builderEscAttr(builderRadiusPx(radius))}"`);
        if (material) attrs.push(`material="${builderEscAttr(material)}"`);
        if (camera.trim()) attrs.push(`camera="${builderEscAttr(camera.trim())}"`);
        if (wheelZoom) attrs.push('wheel="zoom"');
        if (version && version !== BUILDER_DEFAULT_VERSION) attrs.push(`version="${builderEscAttr(version)}"`);
        if (poster.trim()) attrs.push(`poster="${builderEscAttr(poster.trim())}"`);
        if (eager) attrs.push('eager');
        attrs.push(sizing === 'responsive'
            ? `style="width:100%;aspect-ratio:${width}/${height}"`
            : `style="width: ${width}px; height: ${height}px;"`);
        const attrLines = attrs.map((a) => '  ' + a).join('\n');
        return `<script src="${builderEscAttr(BUILDER_SITE_BASE + 'embed/mtlx-viewer.js')}"></script>\n\n` +
            `<materialx-viewer\n${attrLines}>\n</materialx-viewer>`;
    })();

    return (
        <div className="max-w-6xl mx-auto space-y-6">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <div className="flex items-center gap-2">
                        <h1 className="text-2xl font-bold text-gray-100">Embed Builder</h1>
                        <span className="text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300">
                            Experimental
                        </span>
                    </div>
                    <p className="text-sm text-gray-400 mt-1">
                        Configure an embeddable MaterialX viewer, preview it live, and copy a ready-made snippet.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => setHelpOpen(true)}
                    title="Embedding reference"
                    className={BTN_SECONDARY + ' inline-flex items-center gap-1.5 shrink-0'}
                >
                    <MtlxIcon name="help" className="w-3.5 h-3.5" />
                    Help
                </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
                {/* Left: configuration form */}
                <div className="space-y-5">
                    <div className="space-y-3">
                        <div>
                            <label className={FIELD_LABEL_CLS}>Document URL (src)</label>
                            <input
                                type="text"
                                value={src}
                                onChange={(e) => { setSrc(e.target.value); setPresetPick(''); }}
                                onBlur={commitSrc}
                                onKeyDown={(e) => { if (e.key === 'Enter') { commitSrc(); e.currentTarget.blur(); } }}
                                placeholder="(built-in default material)"
                                className={TEXT_INPUT_CLS}
                            />
                            <p className="text-[11px] text-gray-500 mt-1">Applies on blur or Enter (this one reloads the preview).</p>
                        </div>
                        {window.MTLX_PRESETS && window.MTLX_PRESETS_BASE && (
                            <div>
                                <label className={FIELD_LABEL_CLS}>Or pick an example</label>
                                <select value={presetPick} onChange={handlePresetPick} className={TEXT_INPUT_CLS}>
                                    <option value="">(choose a preset)</option>
                                    {window.MTLX_PRESETS.map((p) => (
                                        <option key={p.path} value={window.MTLX_PRESETS_BASE + p.path}>{p.label}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                    </div>

                    <div className="space-y-3 border-t border-gray-800 pt-4">
                        <div>
                            <label className={FIELD_LABEL_CLS}>Geometry</label>
                            <select value={geometry} onChange={(e) => setGeometry(e.target.value)} className={TEXT_INPUT_CLS}>
                                {BUILDER_GEOM_OPTIONS.map((g) => (
                                    <option key={g} value={g}>{(window.GEOM_LABELS && window.GEOM_LABELS[g]) || g}</option>
                                ))}
                            </select>
                        </div>
                        {renderables.length >= 2 && (
                            <div>
                                <label className={FIELD_LABEL_CLS}>Material</label>
                                <select value={material} onChange={(e) => setMaterial(e.target.value)} className={TEXT_INPUT_CLS}>
                                    <option value="">(first material)</option>
                                    {renderables.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
                                </select>
                            </div>
                        )}
                    </div>

                    {BUILDER_VERSIONS.length > 0 && (
                        <div className="border-t border-gray-800 pt-4">
                            <label className={FIELD_LABEL_CLS}>MaterialX version</label>
                            <select value={version} onChange={(e) => setVersion(e.target.value)} className={TEXT_INPUT_CLS}>
                                {BUILDER_VERSIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                            </select>
                        </div>
                    )}

                    <div className="space-y-2 border-t border-gray-800 pt-4">
                        <label className={FIELD_LABEL_CLS}>Controls (HUD buttons)</label>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                            {BUILDER_CONTROLS.map((c) => {
                                const materialLocked = c.id === 'material' && renderables.length < 2;
                                return (
                                    <label
                                        key={c.id}
                                        title={materialLocked ? 'Only applies to documents with 2 or more materials' : undefined}
                                        className={'flex items-center gap-2 text-sm cursor-pointer '
                                            + (materialLocked ? 'text-gray-600 cursor-not-allowed' : 'text-gray-300')}
                                    >
                                        <input
                                            type="checkbox"
                                            disabled={materialLocked}
                                            className="h-3.5 w-3.5 accent-blue-500"
                                            checked={!!controls[c.id]}
                                            onChange={(e) => setControls((prev) => ({ ...prev, [c.id]: e.target.checked }))}
                                        />
                                        {c.label}
                                    </label>
                                );
                            })}
                        </div>
                    </div>

                    <div className="space-y-2 border-t border-gray-800 pt-4">
                        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                            <input type="checkbox" className="h-3.5 w-3.5 accent-blue-500" checked={background} onChange={(e) => setBackground(e.target.checked)} />
                            Show environment as background
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                            <input type="checkbox" className="h-3.5 w-3.5 accent-blue-500" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} />
                            Transparent page background
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                            <input type="checkbox" className="h-3.5 w-3.5 accent-blue-500" checked={autorotate} onChange={(e) => setAutorotate(e.target.checked)} />
                            Auto-rotate (reloads the preview)
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                            <input type="checkbox" className="h-3.5 w-3.5 accent-blue-500" checked={wheelZoom} onChange={(e) => setWheelZoom(e.target.checked)} />
                            Direct wheel zoom (no Ctrl needed), reloads the preview
                        </label>
                    </div>

                    <div className="space-y-3 border-t border-gray-800 pt-4">
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className={FIELD_LABEL_CLS}>Env rotation (deg)</label>
                                <input type="number" step="1" value={env} onChange={(e) => setEnv(e.target.value)} placeholder="default" className={TEXT_INPUT_CLS} />
                            </div>
                            <div>
                                <label className={FIELD_LABEL_CLS}>Exposure</label>
                                <input type="number" step="0.05" value={exposure} onChange={(e) => setExposure(e.target.value)} placeholder="default" className={TEXT_INPUT_CLS} />
                            </div>
                        </div>
                        <div>
                            <label className={FIELD_LABEL_CLS}>Environment map URL (.hdr / .exr)</label>
                            <input
                                type="text"
                                value={envmap}
                                onChange={(e) => setEnvmap(e.target.value)}
                                onBlur={commitEnvmap}
                                onKeyDown={(e) => { if (e.key === 'Enter') { commitEnvmap(); e.currentTarget.blur(); } }}
                                placeholder="(default environment)"
                                className={TEXT_INPUT_CLS}
                            />
                            <p className="text-[11px] text-gray-500 mt-1">Applies on blur or Enter (this one does not reload the preview).</p>
                        </div>
                    </div>

                    <div className="space-y-3 border-t border-gray-800 pt-4">
                        <ColorField label="Accent" value={accent} onChange={setAccent} placeholder={BUILDER_THEME_DEFAULTS.accent} />
                        <ColorField label="Surface" value={surface} onChange={setSurface} placeholder={BUILDER_THEME_DEFAULTS.surface} />
                        <ColorField label="Text" value={text} onChange={setText} placeholder={BUILDER_THEME_DEFAULTS.text} />
                        <div>
                            <label className={FIELD_LABEL_CLS}>Radius</label>
                            <div className="flex items-center gap-2">
                                <input
                                    type="number"
                                    min="0"
                                    step="1"
                                    value={radius}
                                    onChange={(e) => setRadius(e.target.value)}
                                    placeholder={BUILDER_THEME_DEFAULTS.radius}
                                    className={TEXT_INPUT_CLS}
                                />
                                <span className="text-sm text-gray-400 shrink-0">px</span>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-2 border-t border-gray-800 pt-4">
                        <div>
                            <label className={FIELD_LABEL_CLS}>Poster image URL</label>
                            <input type="text" value={poster} onChange={(e) => setPoster(e.target.value)} placeholder="(none)" className={TEXT_INPUT_CLS} />
                        </div>
                        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                            <input type="checkbox" className="h-3.5 w-3.5 accent-blue-500" checked={eager} onChange={(e) => setEager(e.target.checked)} />
                            Eager (skip lazy-loading)
                        </label>
                        <p className="text-[11px] text-gray-500">
                            Only matter once this embed sits alongside others on a page: poster shows before it
                            activates, eager skips waiting for it to scroll into view.
                        </p>
                    </div>

                    <div className="space-y-3 border-t border-gray-800 pt-4">
                        <div>
                            <label className={FIELD_LABEL_CLS}>Sizing</label>
                            <div className="flex items-center gap-4">
                                <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                                    <input type="radio" name="builder-sizing" className="accent-blue-500" checked={sizing === 'fixed'} onChange={() => setSizing('fixed')} />
                                    Fixed (px)
                                </label>
                                <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                                    <input type="radio" name="builder-sizing" className="accent-blue-500" checked={sizing === 'responsive'} onChange={() => setSizing('responsive')} />
                                    Responsive
                                </label>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className={FIELD_LABEL_CLS}>{sizing === 'responsive' ? 'Aspect W' : 'Width (px)'}</label>
                                <input type="number" min="1" value={width} onChange={(e) => setWidth(Math.max(1, Number(e.target.value) || 1))} className={TEXT_INPUT_CLS} />
                            </div>
                            <div>
                                <label className={FIELD_LABEL_CLS}>{sizing === 'responsive' ? 'Aspect H' : 'Height (px)'}</label>
                                <input type="number" min="1" value={height} onChange={(e) => setHeight(Math.max(1, Number(e.target.value) || 1))} className={TEXT_INPUT_CLS} />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right: live preview via the real custom element */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <label className={FIELD_LABEL_CLS + ' mb-0'}>Live preview</label>
                        <span className="text-[11px] text-gray-500">{ready ? 'Preview ready' : 'Preview loading...'}</span>
                    </div>
                    <div
                        ref={previewMountRef}
                        style={{
                            width: '100%', maxWidth: width, aspectRatio: `${width} / ${height}`,
                            ...(transparent ? BUILDER_CHECKERBOARD_STYLE : {}),
                        }}
                        className={'rounded-lg overflow-hidden mx-auto lg:mx-0 '
                            + (transparent ? '' : 'border border-gray-700 bg-gray-950')}
                    />
                    <div>
                        <label className={FIELD_LABEL_CLS}>Camera</label>
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                value={camera}
                                onChange={(e) => setCamera(e.target.value)}
                                placeholder="default"
                                className={TEXT_INPUT_CLS}
                            />
                            <button type="button" onClick={handleUseCurrentView} className={BTN_SECONDARY + ' shrink-0'}>Use current view</button>
                            <button type="button" onClick={() => setCamera('')} className={BTN_SECONDARY + ' shrink-0'}>Clear</button>
                        </div>
                        <p className="text-[11px] text-gray-500 mt-1">The HUD Reset button returns to this captured view.</p>
                    </div>
                    {errors.length > 0 && (
                        <div className="rounded-lg border border-amber-700/50 bg-amber-900/20 text-amber-200 text-xs p-3 space-y-1.5">
                            <div className="flex items-center justify-between">
                                <span className="font-medium flex items-center gap-1.5">
                                    <MtlxIcon name="alert-triangle" className="w-4 h-4" />
                                    {`Preview reported ${errors.length} issue${errors.length > 1 ? 's' : ''}`}
                                </span>
                                <button type="button" onClick={() => setErrors([])} className="text-amber-300/80 hover:text-amber-100">Clear</button>
                            </div>
                            <ul className="space-y-1 max-h-32 overflow-y-auto custom-scrollbar">
                                {errors.map((e) => <li key={e.id} className="text-amber-100/90">{e.message}</li>)}
                            </ul>
                        </div>
                    )}
                    <p className="text-[11px] text-gray-500">
                        Geometry, env, exposure, background, transparent, the theme colors, material and camera
                        update instantly. Document URL, auto-rotate, controls, wheel and version reload the preview frame.
                        The environment map applies on commit (blur or Enter) without reloading the preview.
                    </p>
                </div>
            </div>

            <BuilderHelpDialog
                open={helpOpen}
                onClose={() => setHelpOpen(false)}
                html={helpHtml}
                loading={helpLoading}
                error={helpError}
            />

            <div className="space-y-4 border-t border-gray-800 pt-6">
                <SnippetPanel
                    title="Plain <iframe> (no script tag needed)"
                    code={iframeSnippet}
                    copied={copiedKey === 'iframe'}
                    onCopy={() => copySnippet('iframe', iframeSnippet)}
                />
                <SnippetPanel
                    title="<script> + <materialx-viewer>"
                    code={elementSnippet}
                    copied={copiedKey === 'element'}
                    onCopy={() => copySnippet('element', elementSnippet)}
                />
            </div>
        </div>
    );
}

window.BuilderApp = BuilderApp;
