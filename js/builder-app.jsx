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

// The directory index.html lives in, e.g. "https://host/MaterialXPlayground/".
// Both snippet types resolve embed/* against this, same as a real host page.
const BUILDER_SITE_BASE = new URL('.', window.location.href).href;

const builderNorm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const builderEscAttr = (s) => String(s).replace(/"/g, '&quot;');

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

function BuilderApp({ active } = {}) {
    const [src, setSrc] = React.useState('');
    const [geometry, setGeometry] = React.useState(BUILDER_DEFAULT_GEOM);
    const [controls, setControls] = React.useState({});
    const [background, setBackground] = React.useState(false);
    const [transparent, setTransparent] = React.useState(false);
    const [autorotate, setAutorotate] = React.useState(false);
    const [env, setEnv] = React.useState('');
    const [exposure, setExposure] = React.useState('');
    const [accent, setAccent] = React.useState(BUILDER_THEME_DEFAULTS.accent);
    const [surface, setSurface] = React.useState(BUILDER_THEME_DEFAULTS.surface);
    const [text, setText] = React.useState(BUILDER_THEME_DEFAULTS.text);
    const [radius, setRadius] = React.useState(BUILDER_THEME_DEFAULTS.radius);
    const [width, setWidth] = React.useState(640);
    const [height, setHeight] = React.useState(480);

    const [ready, setReady] = React.useState(false);
    const [errors, setErrors] = React.useState([]);
    const [copiedKey, setCopiedKey] = React.useState(null);
    const copyTimerRef = React.useRef(null);

    const previewMountRef = React.useRef(null);
    const previewElRef = React.useRef(null);

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
        const handleError = (e) => {
            const message = (e && e.detail && e.detail.message) || 'Unknown error';
            setErrors((prev) => [...prev.slice(-5), { id: Math.random(), message }]);
        };
        const handleReady = () => setReady(true);
        el.addEventListener('mtlx-error', handleError);
        el.addEventListener('mtlx-ready', handleReady);
        previewElRef.current = el;
        if (previewMountRef.current) previewMountRef.current.appendChild(el);
        return () => {
            el.removeEventListener('mtlx-error', handleError);
            el.removeEventListener('mtlx-ready', handleReady);
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

    // `src` is free-typed text - applying it on every keystroke would
    // reload the iframe per character. Commit only on blur/Enter, and only
    // if it actually changed, or "loading" sticks for a reload that never comes.
    const commitSrc = () => {
        if (!previewElRef.current) return;
        const next = src.trim();
        if (previewElRef.current.src === next) return;
        setReady(false);
        previewElRef.current.src = next;
    };

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
        if (autorotate) entries.push(['autorotate', '1']);
        if (controlsStr) entries.push(['controls', controlsStr]);
        if (background) entries.push(['background', '1']);
        if (transparent) entries.push(['transparent', '1']);
        if (builderNorm(accent) !== builderNorm(BUILDER_THEME_DEFAULTS.accent)) entries.push(['accent', accent.trim()]);
        if (builderNorm(surface) !== builderNorm(BUILDER_THEME_DEFAULTS.surface)) entries.push(['surface', surface.trim()]);
        if (builderNorm(text) !== builderNorm(BUILDER_THEME_DEFAULTS.text)) entries.push(['text', text.trim()]);
        if (radius.trim() && builderNorm(radius) !== builderNorm(BUILDER_THEME_DEFAULTS.radius)) entries.push(['radius', builderRadiusPx(radius)]);
        return entries;
    };

    const iframeUrl = (() => {
        const entries = queryEntries();
        const qs = entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        return BUILDER_SITE_BASE + 'embed/viewer.html' + (qs ? '?' + qs : '');
    })();

    const iframeSnippet =
        `<iframe\n` +
        `  src="${builderEscAttr(iframeUrl)}"\n` +
        `  width="${width}" height="${height}"\n` +
        `  loading="lazy" allow="fullscreen" allowfullscreen\n` +
        `  title="MaterialX material preview">\n` +
        `</iframe>`;

    const elementSnippet = (() => {
        const attrs = [];
        if (src.trim()) attrs.push(`src="${builderEscAttr(src.trim())}"`);
        if (geometry !== BUILDER_DEFAULT_GEOM) attrs.push(`geometry="${geometry}"`);
        if (env.trim() !== '') attrs.push(`env="${env.trim()}"`);
        if (exposure.trim() !== '') attrs.push(`exposure="${exposure.trim()}"`);
        if (autorotate) attrs.push('autorotate');
        if (controlsStr) attrs.push(`controls="${controlsStr}"`);
        if (background) attrs.push('background');
        if (transparent) attrs.push('transparent');
        if (builderNorm(accent) !== builderNorm(BUILDER_THEME_DEFAULTS.accent)) attrs.push(`accent="${builderEscAttr(accent.trim())}"`);
        if (builderNorm(surface) !== builderNorm(BUILDER_THEME_DEFAULTS.surface)) attrs.push(`surface="${builderEscAttr(surface.trim())}"`);
        if (builderNorm(text) !== builderNorm(BUILDER_THEME_DEFAULTS.text)) attrs.push(`text="${builderEscAttr(text.trim())}"`);
        if (radius.trim() && builderNorm(radius) !== builderNorm(BUILDER_THEME_DEFAULTS.radius)) attrs.push(`radius="${builderEscAttr(builderRadiusPx(radius))}"`);
        attrs.push(`style="width: ${width}px; height: ${height}px;"`);
        const attrLines = attrs.map((a) => '  ' + a).join('\n');
        return `<script src="${builderEscAttr(BUILDER_SITE_BASE + 'embed/mtlx-viewer.js')}"></script>\n\n` +
            `<materialx-viewer\n${attrLines}>\n</materialx-viewer>`;
    })();

    return (
        <div className="max-w-6xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-100">Embed Builder</h1>
                <p className="text-sm text-gray-400 mt-1">
                    Configure an embeddable MaterialX viewer, preview it live, and copy a ready-made snippet.
                </p>
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
                                onChange={(e) => setSrc(e.target.value)}
                                onBlur={commitSrc}
                                onKeyDown={(e) => { if (e.key === 'Enter') { commitSrc(); e.currentTarget.blur(); } }}
                                placeholder="(built-in default material)"
                                className={TEXT_INPUT_CLS}
                            />
                            <p className="text-[11px] text-gray-500 mt-1">Applies on blur or Enter (this one reloads the preview).</p>
                        </div>
                        <div>
                            <label className={FIELD_LABEL_CLS}>Geometry</label>
                            <select value={geometry} onChange={(e) => setGeometry(e.target.value)} className={TEXT_INPUT_CLS}>
                                {BUILDER_GEOM_OPTIONS.map((g) => (
                                    <option key={g} value={g}>{(window.GEOM_LABELS && window.GEOM_LABELS[g]) || g}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div className="space-y-2 border-t border-gray-800 pt-4">
                        <label className={FIELD_LABEL_CLS}>Controls (HUD buttons)</label>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                            {BUILDER_CONTROLS.map((c) => (
                                <label key={c.id} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        className="h-3.5 w-3.5 accent-blue-500"
                                        checked={!!controls[c.id]}
                                        onChange={(e) => setControls((prev) => ({ ...prev, [c.id]: e.target.checked }))}
                                    />
                                    {c.label}
                                </label>
                            ))}
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
                    </div>

                    <div className="grid grid-cols-2 gap-3 border-t border-gray-800 pt-4">
                        <div>
                            <label className={FIELD_LABEL_CLS}>Env rotation (deg)</label>
                            <input type="number" step="1" value={env} onChange={(e) => setEnv(e.target.value)} placeholder="default" className={TEXT_INPUT_CLS} />
                        </div>
                        <div>
                            <label className={FIELD_LABEL_CLS}>Exposure</label>
                            <input type="number" step="0.05" value={exposure} onChange={(e) => setExposure(e.target.value)} placeholder="default" className={TEXT_INPUT_CLS} />
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

                    <div className="grid grid-cols-2 gap-3 border-t border-gray-800 pt-4">
                        <div>
                            <label className={FIELD_LABEL_CLS}>Width (px)</label>
                            <input type="number" min="1" value={width} onChange={(e) => setWidth(Math.max(1, Number(e.target.value) || 1))} className={TEXT_INPUT_CLS} />
                        </div>
                        <div>
                            <label className={FIELD_LABEL_CLS}>Height (px)</label>
                            <input type="number" min="1" value={height} onChange={(e) => setHeight(Math.max(1, Number(e.target.value) || 1))} className={TEXT_INPUT_CLS} />
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
                        style={{ width: '100%', maxWidth: width, aspectRatio: `${width} / ${height}` }}
                        className="rounded-lg overflow-hidden border border-gray-700 bg-gray-950 mx-auto lg:mx-0"
                    />
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
                        Geometry, env, exposure, background, transparent and the theme colors update instantly.
                        Document URL, auto-rotate and controls reload the preview frame.
                    </p>
                </div>
            </div>

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
