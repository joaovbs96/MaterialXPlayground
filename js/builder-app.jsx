// builder-app.jsx - "Embed Builder" view: configure an embeddable
// <materialx-viewer>, preview it live, and copy a ready-made
// <iframe> or <script>+<materialx-viewer> snippet.

// Mirrors embed/viewer.html's own vocabulary (docs/EMBEDDING.md),
// duplicated locally since each lazy view script is its own scope (see
// compare-app.jsx's loadMtlxDocument comment for the same rationale).
const BUILDER_GEOM_OPTIONS = ['shaderball-scene', 'shaderball', 'shaderball-mtlx', 'sphere', 'cube', 'cloth'];
const BUILDER_DEFAULT_GEOM = 'shaderball-scene';
const BUILDER_CONTROLS = [
    { id: 'geometry', chip: 'Geometry', icon: 'cube' },
    { id: 'material', chip: 'Material selection', icon: 'color-swatch' },
    { id: 'rotate', chip: 'Auto-rotate', icon: 'rotate' },
    { id: 'reset', chip: 'Reset camera', icon: 'focus-2' },
    { id: 'env', chip: 'Environment', icon: 'world' },
    { id: 'screenshot', chip: 'Screenshot', icon: 'camera' },
    { id: 'settings', chip: 'Settings', icon: 'settings-cog' },
    { id: 'fullscreen', chip: 'Fullscreen', icon: 'maximize' },
];
// radius is stored/edited as a bare number (the field is numeric, docs/
// EMBEDDING.md); the "px" suffix is appended wherever it's emitted, since
// embed-boot.js validates with CSS.supports and rejects a bare number.
const BUILDER_THEME_DEFAULTS = { accent: '#3b82f6', surface: '#1f2937', text: '#d1d5db', radius: '4' };
const builderRadiusPx = (v) => { const t = String(v == null ? '' : v).trim(); return t ? t + 'px' : ''; };

// The three documented Look presets (see docs/EMBEDDING.md's Theming
// section). "Card" keeps the dark palette but turns the page transparent
// and rounds corners more, for sitting inside a host card.
const BUILDER_THEME_PRESETS = [
    { id: 'dark', label: 'Dark', accent: '#3b82f6', surface: '#1f2937', text: '#d1d5db', radius: '4', transparent: false },
    { id: 'light', label: 'Light', accent: '#2563eb', surface: '#f9fafb', text: '#374151', radius: '4', transparent: false },
    { id: 'card', label: 'Transparent Card', accent: '#3b82f6', surface: '#1f2937', text: '#d1d5db', radius: '8', transparent: true },
];

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

// Defaults, single source of truth: templates are partial overrides,
// Reset restores this, and isBuilderDefault/isTemplateActive compare
// against it for summaries and template highlighting.
const BUILDER_DEFAULTS = {
    src: '',
    geometry: BUILDER_DEFAULT_GEOM,
    controls: {},
    backdrop: 'studio',
    transparent: false,
    autorotate: false,
    env: '',
    exposure: '',
    envmap: '',
    accent: BUILDER_THEME_DEFAULTS.accent,
    surface: BUILDER_THEME_DEFAULTS.surface,
    text: BUILDER_THEME_DEFAULTS.text,
    radius: BUILDER_THEME_DEFAULTS.radius,
    width: 640,
    height: 480,
    sizing: 'fixed',
    material: '',
    camera: '',
    wheelZoom: false,
    version: BUILDER_DEFAULT_VERSION,
    poster: '',
    eager: false,
};

// Round-trips embed-boot.js's `all` keyword: every box ticked emits it.
// None ticked emits '' - same chromeless default as `none`.
const controlsStrFrom = (controlsObj) => {
    const list = BUILDER_CONTROLS.filter((c) => controlsObj && controlsObj[c.id]).map((c) => c.id);
    return list.length === BUILDER_CONTROLS.length ? 'all' : list.join(',');
};
const controlsObjFromStr = (str) => {
    const s = builderNorm(str);
    if (s === 'all') { const o = {}; BUILDER_CONTROLS.forEach((c) => { o[c.id] = true; }); return o; }
    if (!s || s === 'none') return {};
    const o = {};
    s.split(',').forEach((id) => { const t = id.trim(); if (BUILDER_CONTROLS.some((c) => c.id === t)) o[t] = true; });
    return o;
};
const builderParseBool = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v));

// Normalizes one settings field for equality checks (template highlighting,
// default detection, "Custom" fallbacks) - case/whitespace-insensitive for
// colors, blank-collapses radius to the default, exact match otherwise.
const BUILDER_COLOR_KEYS = ['accent', 'surface', 'text'];
const normForCompare = (key, value) => {
    if (key === 'controls') return controlsStrFrom(value);
    if (BUILDER_COLOR_KEYS.includes(key)) return builderNorm(value);
    if (key === 'radius') { const t = String(value == null ? '' : value).trim(); return builderNorm(t || BUILDER_DEFAULTS.radius); }
    if (typeof value === 'string') return value.trim();
    return value;
};
const isBuilderDefault = (key, value) => normForCompare(key, value) === normForCompare(key, BUILDER_DEFAULTS[key]);

// Templates: partial overrides of BUILDER_DEFAULTS. A card reads as
// selected only when every key it omits is ALSO still at its default.
const BUILDER_TEMPLATES = [
    {
        id: 'defaults', name: 'Defaults', icon: 'restore',
        desc: 'Every setting at its default value. Plain viewer, no HUD, 640 x 480.',
        tags: ['640x480', 'no HUD'], values: {},
    },
    {
        id: 'product-card', name: 'Product card', icon: 'id',
        desc: 'Square, transparent, no HUD. Sits inside your own card.',
        // geometry: transparent can't render the default backdrop room.
        // backdrop: 'studio' is just as opaque, so it's also turned off.
        tags: ['1:1', 'transparent'], values: { width: 480, height: 480, transparent: true, geometry: 'shaderball', backdrop: 'none' },
    },
    {
        id: 'blog', name: 'Inline in a blog', icon: 'article',
        desc: '16:9, geometry picker and fullscreen. Scroll passes through.',
        tags: ['16:9', '2 controls'], values: { width: 640, height: 360, controls: { geometry: true, fullscreen: true } },
    },
    {
        id: 'hero', name: 'Full-width hero', icon: 'layout-navbar',
        desc: 'Responsive 21:9, auto-rotate, chromeless, transparent.',
        // geometry: transparent can't render the default backdrop room.
        // backdrop: 'studio' is just as opaque, so it's also turned off.
        tags: ['responsive', 'auto-rotate'], values: { sizing: 'responsive', width: 21, height: 9, autorotate: true, transparent: true, geometry: 'shaderball', backdrop: 'none' },
    },
];
const isTemplateActive = (t, settings) => Object.keys(BUILDER_DEFAULTS).every((key) => {
    const want = Object.prototype.hasOwnProperty.call(t.values, key) ? t.values[key] : BUILDER_DEFAULTS[key];
    return normForCompare(key, settings[key]) === normForCompare(key, want);
});

const ASPECT_PRESETS = [
    { id: '16:9', w: 16, h: 9 },
    { id: '4:3', w: 4, h: 3 },
    { id: '1:1', w: 1, h: 1 },
    { id: '9:16', w: 9, h: 16 },
    { id: '21:9', w: 21, h: 9 },
];
// Simplified integer ratio via gcd, e.g. 640x480 -> "4:3".
const builderAspectLabel = (w, h) => {
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const g = gcd(Math.round(w) || 1, Math.round(h) || 1) || 1;
    return `${Math.round(w) / g}:${Math.round(h) / g}`;
};
const builderMatchedAspect = (w, h) => ASPECT_PRESETS.find((p) => w * p.h === h * p.w) || null;

// Column count from the masonry container's own measured width, not the
// window - a narrow desktop split-view should behave like a tablet.
const builderColumnsFor = (w) => (w >= 1280 ? 3 : w >= 900 ? 2 : 1);

// Share config hash ("#!builder?key=value..."), same param names as the
// embed query string plus builder-only w/h/sizing. Parsed synchronously
// into the initial settings state so a pasted link restores everything.
const parseBuilderHashSettings = () => {
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    if (qIdx < 0) return {};
    const params = new URLSearchParams(hash.slice(qIdx + 1));
    const patch = {};
    if (params.has('src')) patch.src = params.get('src');
    if (params.has('geometry')) patch.geometry = params.get('geometry');
    if (params.has('material')) patch.material = params.get('material');
    if (params.has('camera')) patch.camera = params.get('camera');
    if (params.has('env')) patch.env = params.get('env');
    if (params.has('exposure')) patch.exposure = params.get('exposure');
    if (params.has('envmap')) patch.envmap = params.get('envmap');
    if (params.has('autorotate')) patch.autorotate = builderParseBool(params.get('autorotate'));
    if (params.has('controls')) patch.controls = controlsObjFromStr(params.get('controls'));
    if (params.has('backdrop') && ['studio', 'studio-dark', 'environment', 'none'].includes(params.get('backdrop'))) {
        patch.backdrop = params.get('backdrop');
    }
    if (params.has('transparent')) patch.transparent = builderParseBool(params.get('transparent'));
    if (params.has('accent')) patch.accent = params.get('accent');
    if (params.has('surface')) patch.surface = params.get('surface');
    if (params.has('text')) patch.text = params.get('text');
    if (params.has('radius')) patch.radius = params.get('radius').replace(/px$/i, '');
    if (params.has('wheel')) patch.wheelZoom = params.get('wheel') === 'zoom';
    if (params.has('version')) patch.version = params.get('version');
    if (params.has('poster')) patch.poster = params.get('poster');
    if (params.has('eager')) patch.eager = builderParseBool(params.get('eager'));
    if (params.has('w')) patch.width = Math.max(1, Number(params.get('w')) || BUILDER_DEFAULTS.width);
    if (params.has('h')) patch.height = Math.max(1, Number(params.get('h')) || BUILDER_DEFAULTS.height);
    if (params.has('sizing')) patch.sizing = params.get('sizing') === 'responsive' ? 'responsive' : 'fixed';
    // Same geometry constraint the Look card enforces interactively: a
    // pasted link can't resurrect the transparent + backdrop-room combo.
    const effectiveGeometry = params.has('geometry') ? patch.geometry : BUILDER_DEFAULTS.geometry;
    if (patch.transparent && effectiveGeometry === 'shaderball-scene') patch.geometry = 'shaderball';
    // Same for transparent vs. an opaque backdrop - the two cancel each
    // other out, so a pasted link can't resurrect that combo.
    const effectiveBackdrop = params.has('backdrop') ? patch.backdrop : BUILDER_DEFAULTS.backdrop;
    if (patch.transparent && effectiveBackdrop !== 'none') patch.backdrop = 'none';
    return patch;
};
const buildShareParams = (s) => {
    const params = new URLSearchParams();
    if (s.src.trim()) params.set('src', s.src.trim());
    if (!isBuilderDefault('geometry', s.geometry)) params.set('geometry', s.geometry);
    if (s.material) params.set('material', s.material);
    if (s.camera.trim()) params.set('camera', s.camera.trim());
    if (s.env.trim() !== '') params.set('env', s.env.trim());
    if (s.exposure.trim() !== '') params.set('exposure', s.exposure.trim());
    if (s.envmap.trim()) params.set('envmap', s.envmap.trim());
    if (s.autorotate) params.set('autorotate', '1');
    const cs = controlsStrFrom(s.controls);
    if (cs) params.set('controls', cs);
    if (!isBuilderDefault('backdrop', s.backdrop)) params.set('backdrop', s.backdrop);
    if (s.transparent) params.set('transparent', '1');
    if (!isBuilderDefault('accent', s.accent)) params.set('accent', s.accent.trim());
    if (!isBuilderDefault('surface', s.surface)) params.set('surface', s.surface.trim());
    if (!isBuilderDefault('text', s.text)) params.set('text', s.text.trim());
    if (!isBuilderDefault('radius', s.radius)) params.set('radius', builderRadiusPx(s.radius));
    if (s.wheelZoom) params.set('wheel', 'zoom');
    if (s.version && s.version !== BUILDER_DEFAULT_VERSION) params.set('version', s.version);
    if (s.poster.trim()) params.set('poster', s.poster.trim());
    if (s.eager) params.set('eager', '1');
    if (s.width !== BUILDER_DEFAULTS.width) params.set('w', String(s.width));
    if (s.height !== BUILDER_DEFAULTS.height) params.set('h', String(s.height));
    if (s.sizing !== BUILDER_DEFAULTS.sizing) params.set('sizing', s.sizing);
    return params;
};

const builderFileNameFromUrl = (url) => {
    try {
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : url;
    } catch (e) {
        const parts = String(url).split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : url;
    }
};

// `exposure` always stores the linear multiplier the embed attribute takes
// ('' = default/1x); the builder's own slider shows it in EV stops instead
// (0 = no change, +1 = double, -1 = half). Thin wrappers over the shared
// linear<->EV helpers, keeping the builder's string and ''-sentinel semantics.
const builderExposureEv = (exposure) => {
    const t = exposure.trim();
    if (t === '') return '0';
    return String(Math.round(linearToEv(t) * 100) / 100);
};
const builderEvToExposure = (ev) => {
    const n = Number(ev);
    if (!Number.isFinite(n) || n === 0) return '';
    return String(Math.round(evToLinear(n) * 1000) / 1000);
};

// ---- Section-card summary lines (right-aligned, collapsed-state hint) ----
const builderLightingSummary = (env, exposure) => {
    const hasEnv = env.trim() !== '' && Number(env) !== 0;
    const hasExp = exposure.trim() !== '' && Number(exposure) !== 1;
    if (!hasEnv && !hasExp) return 'Default environment';
    const parts = [];
    if (hasEnv) parts.push(`Rotated ${env.trim()} deg`);
    if (hasExp) {
        const evText = formatEv(linearToEv(Number(exposure)));
        parts.push(hasEnv ? evText : `Exposure ${evText}`);
    }
    return parts.join(', ');
};
const builderHudSummary = (controls) => {
    const n = BUILDER_CONTROLS.filter((c) => controls[c.id]).length;
    if (n === 0) return 'None';
    if (n === BUILDER_CONTROLS.length) return 'All';
    return `${n} of ${BUILDER_CONTROLS.length}`;
};
const builderBehaviorSummary = (autorotate, wheelZoom) =>
    (autorotate ? 'Auto-rotate' : 'Static') + ', ' + (wheelZoom ? 'direct wheel zoom' : 'Ctrl+wheel zoom');
const builderSizeSummary = (s) => (s.sizing === 'responsive'
    ? `${builderAspectLabel(s.width, s.height)}, responsive`
    : `${s.width} x ${s.height}, fixed`);
const builderActiveThemePreset = (s) => BUILDER_THEME_PRESETS.find((p) =>
    builderNorm(p.accent) === builderNorm(s.accent)
    && builderNorm(p.surface) === builderNorm(s.surface)
    && builderNorm(p.text) === builderNorm(s.text)
    && normForCompare('radius', p.radius) === normForCompare('radius', s.radius)
    && !!p.transparent === !!s.transparent) || null;

// A CSS-color text field paired with a native swatch (hex-only). The
// text field is the source of truth and accepts any CSS color, including
// an invalid one - the error banner below is meant to catch exactly that.
function ColorField({ label, value, onChange, placeholder }) {
    const hex = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
    return (
        <div className="min-w-0">
            <FieldLabel label={label} />
            <div className="flex items-center gap-1.5">
                <input
                    type="color"
                    value={hex}
                    onChange={(e) => onChange(e.target.value)}
                    title="Pick a color (hex only - type any CSS color in the field for anything else)"
                    className="h-[26px] w-[26px] p-0 rounded border border-gray-700 bg-gray-900 shrink-0 cursor-pointer"
                />
                <input
                    type="text"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    className={TEXT_INPUT_CLS + ' min-w-0 px-1.5'}
                />
            </div>
        </div>
    );
}

// Small amber "reloads the frame" pill, reused inline next to a field
// label or a section title (BUILDER's live/reload split, docs/EMBEDDING.md).
function ReloadsPill({ className }) {
    return (
        <span className={'inline-flex items-center gap-1 shrink-0 h-4 leading-none text-[10px] px-1.5 rounded-full border border-amber-300/35 bg-amber-300/10 text-amber-300 ' + (className || '')}>
            <MtlxIcon name="refresh" className="w-2.5 h-2.5" />
            reloads
        </span>
    );
}

// Small neutral "live" pill, ReloadsPill's counterpart for fields that
// update in place. Same markup LegendBlock's own chip already used,
// hoisted here so both places share one definition.
function LivePill({ className }) {
    return (
        <span className={'shrink-0 text-[10px] leading-none px-1.5 py-1 rounded-full border border-gray-600 text-gray-400 ' + (className || '')}>
            live
        </span>
    );
}

// One Look theme preset (58px tall, fills its grid column): three small
// color squares + a label.
function ThemeTile({ preset, active, disabled, title, onClick }) {
    return (
        <button
            type="button"
            disabled={disabled}
            title={title}
            onClick={onClick}
            className={'h-[58px] w-full rounded-lg border flex flex-col items-center justify-center gap-1.5 transition-colors '
                + (disabled ? 'opacity-50 cursor-not-allowed border-gray-700'
                    : active ? 'border-blue-500 ring-1 ring-blue-500/15 bg-blue-500/5' : 'border-gray-700 hover:border-gray-600')}
        >
            <div className="flex gap-1">
                <span className="w-3 h-3 rounded-sm border border-black/25" style={{ background: preset.accent }} />
                <span className="w-3 h-3 rounded-sm border border-black/25" style={{ background: preset.surface }} />
                <span className="w-3 h-3 rounded-sm border border-black/25" style={{ background: preset.text }} />
            </div>
            <span className="text-[10px] text-gray-300">{preset.label}</span>
        </button>
    );
}

// Dashed strip in the Look card: a faithful miniature of the real HUD
// (js/embed-controls.jsx, embed/embed-controls.css) rendered with the
// current accent/surface/text/radius, so the theme previews live even
// with no real HUD controls turned on. Chrome/sizing below is copied
// from .mtlx-ec-select / .mtlx-ec-btn / .mtlx-ec-btn.is-active exactly;
// the border stays the fixed #4b5563 the real HUD uses, since it does
// NOT follow the accent, only the active button and the focus ring do.
function HudMiniPreview({ accent, surface, text, radius }) {
    const radiusPx = (Number(radius) || 0) + 'px';
    const chrome = {
        boxSizing: 'border-box',
        margin: 0,
        fontFamily: 'inherit',
        color: text,
        background: 'color-mix(in srgb, ' + surface + ' 80%, transparent)',
        border: '1px solid #4b5563',
        borderRadius: radiusPx,
    };
    const selectStyle = Object.assign({}, chrome, {
        height: '24px',
        maxWidth: '132px',
        padding: '0 4px',
        fontSize: '11px',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
    });
    const btnStyle = Object.assign({}, chrome, {
        height: '24px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '0 7px',
        fontSize: '11px',
        whiteSpace: 'nowrap',
    });
    const activeBtnStyle = Object.assign({}, btnStyle, {
        background: 'color-mix(in srgb, ' + accent + ' 80%, transparent)',
        border: '1px solid ' + accent,
        color: '#fff',
    });
    return (
        <div className="rounded-lg border border-dashed border-gray-700 p-3 flex items-center justify-between gap-3 flex-wrap">
            <span className="text-[10px] text-gray-500 shrink-0">HUD with these colors</span>
            <div className="flex items-center gap-1">
                <select style={selectStyle} value={BUILDER_DEFAULT_GEOM} onChange={() => {}} title="Preview geometry">
                    <option value={BUILDER_DEFAULT_GEOM}>{window.GEOM_LABELS[BUILDER_DEFAULT_GEOM]}</option>
                </select>
                <button type="button" style={activeBtnStyle}>
                    <MtlxIcon name="environment" className="w-3.5 h-3.5 shrink-0" />
                    <span>Environment</span>
                </button>
                <button type="button" style={btnStyle}>
                    <MtlxIcon name="camera-reset" className="w-3.5 h-3.5 shrink-0" />
                    <span>Reset</span>
                </button>
            </div>
        </div>
    );
}

// One "Start from a template" card: icon box + name + description + tags.
// The icon box is self-stretch so it always matches the text block's height.
// `compact` is the sidebar's full-width-row styling (narrower icon box,
// tighter padding, description clamped to 2 lines) - same content either way.
function TemplateCard({ t, active, onClick, compact }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={'w-full text-left rounded-lg border flex gap-3 transition-colors '
                + (compact ? 'p-2.5' : 'p-3') + ' '
                + (active ? 'border-blue-500/70 bg-gray-800 ring-1 ring-blue-500/20' : 'border-gray-700 bg-gray-800/40 hover:border-gray-600')}
        >
            <div
                className={'self-stretch rounded-md border bg-gray-900 flex items-center justify-center shrink-0 '
                    + (compact ? 'w-11' : 'w-14') + ' '
                    + (active ? 'border-blue-500/60' : 'border-gray-700')}
            >
                <MtlxIcon name={t.icon} className={(compact ? 'w-[18px] h-[18px] ' : 'w-[22px] h-[22px] ') + (active ? 'text-blue-300' : 'text-gray-300')} />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
                <div className="text-[13px] font-semibold text-gray-100">{t.name}</div>
                <p className={'text-[11px] leading-snug text-gray-500' + (compact ? ' line-clamp-2' : '')}>{t.desc}</p>
                <div className="flex flex-wrap gap-1 pt-0.5">
                    {t.tags.map((tag) => (
                        <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-300">{tag}</span>
                    ))}
                </div>
            </div>
        </button>
    );
}

// Both generated snippets behind tabs, one Copy button for whichever
// tab is active. The code area fills whatever the row (see the
// grid-cols-2 wrapper below) leaves under the tab header, so the row's
// own height is the single source of truth instead of a hand-tuned px.
const SNIPPET_TABS = [
    { id: 'iframe', label: 'Plain iframe' },
    { id: 'element', label: 'Custom element' },
];
function SnippetsCard({ tab, onTab, iframeSnippet, elementSnippet, copied, onCopy }) {
    const code = tab === 'iframe' ? iframeSnippet : elementSnippet;
    const highlighted = React.useMemo(() => {
        if (typeof window === 'undefined' || !window.hljs || typeof window.hljs.highlight !== 'function') return null;
        try { return window.hljs.highlight(code, { language: 'xml' }).value; } catch (e) { return null; }
    }, [code]);
    return (
        <div id="builder-snippets" className="rounded-lg border border-gray-700 bg-gray-900 overflow-hidden h-[142px] md:h-full flex flex-col min-w-0">
            <div className="flex items-center justify-between gap-2 py-1 bg-gray-800/60 shrink-0">
                <div className="flex items-stretch">
                    {SNIPPET_TABS.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            onClick={() => onTab(s.id)}
                            className={'h-7 px-3 text-xs border-b-2 transition-colors '
                                + (tab === s.id ? 'border-blue-500 text-gray-100' : 'border-transparent text-gray-400 hover:text-gray-200')}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>
                <button
                    type="button"
                    onClick={onCopy}
                    className={BTN_PRIMARY + ' inline-flex items-center gap-1.5 shrink-0 mr-2'}
                >
                    <MtlxIcon name={copied ? 'copy-check' : 'copy'} className="w-3.5 h-3.5" />
                    {copied ? 'Copied!' : 'Copy'}
                </button>
            </div>
            <pre className="flex-1 min-h-0 min-w-0 p-2 text-xs leading-relaxed text-gray-300 whitespace-pre overflow-auto custom-scrollbar">
                {highlighted ? <code dangerouslySetInnerHTML={{ __html: highlighted }} /> : <code>{code}</code>}
            </pre>
        </div>
    );
}

// The legend block (item d in the masonry): live vs reloads pills plus two
// one-line notes about snippet generation and preview scaling. h-full so
// it always matches SnippetsCard's height (set by the row, see the
// grid-cols-2 wrapper below) instead of a separately hand-tuned px.
function LegendBlock() {
    // bg-gray-900 (not /60): 60% of the ground over the ground is the same
    // colour, but opaque, so the hero grid cannot show through it.
    return (
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-2 h-[142px] md:h-full min-w-0 overflow-auto custom-scrollbar space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] text-gray-500 flex-wrap">
                <LivePill />
                lighting, look, camera, size update in place
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-gray-500 flex-wrap">
                <ReloadsPill />
                geometry, document, version, HUD, auto-rotate, wheel restart the frame
            </div>
            <p className="text-[11px] text-gray-500">Only non-default settings are emitted.</p>
            <p className="text-[11px] text-gray-500">Embeds larger than the preview area are shrunk to fit, keeping their aspect ratio.</p>
        </div>
    );
}

// Masonry: the CSS-grid "1px auto-rows" technique. MasonryGrid sets the
// columns/gap; each MasonryItem measures its height via ResizeObserver
// and converts it to a grid-row span for grid-auto-flow: row dense.
function MasonryGrid({ columns, children }) {
    return (
        <div
            style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, minmax(0,1fr))`,
                gridAutoRows: '1px',
                gridAutoFlow: 'row dense',
                columnGap: '12px',
            }}
        >
            {children}
        </div>
    );
}
function MasonryItem({ span = 1, children }) {
    const measureRef = React.useRef(null);
    const [rows, setRows] = React.useState(1);
    React.useEffect(() => {
        const el = measureRef.current;
        if (!el) return undefined;
        const ro = new ResizeObserver((entries) => {
            setRows(Math.max(1, Math.ceil(entries[0].contentRect.height + 12)));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return (
        <div style={{ gridColumn: `span ${span}`, gridRowEnd: `span ${rows}` }}>
            <div ref={measureRef}>{children}</div>
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

// Renders js/gen/embedding-docs.html (fetched/cached by BuilderApp so it
// survives this component unmounting) inside a DialogFrame. Highlights
// code blocks with highlight.js if it happens to already be loaded.
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

// Live preview stage: toolbar, scaled embed frame, camera overlay chips,
// resize grip, size readout. `compact` swaps in the sticky phone layout
// via siblings only, so the live <materialx-viewer> never unmounts.
const BUILDER_DEVICES = [
    { id: 'desktop', width: 1200, icon: 'device-desktop' },
    { id: 'tablet', width: 768, icon: 'device-tablet' },
    { id: 'phone', width: 390, icon: 'device-mobile' },
];
const BUILDER_STAGE_HEIGHT_CAP = 560;
// Non-frame chrome inside the stage box the fill-height cap subtracts from
// the measured box: p-6 padding (48) + gap-2 (8) + the single-line camera
// controls row (28px), plus a small rounding buffer.
const BUILDER_STAGE_CHROME = 90;

function PreviewStage({
    settings, patch, ready, errors, onClearErrors, onUseCurrentView,
    previewMountRef, iframeUrl, compact, onCopyIframe, onReloadPreview, fadeRef,
}) {
    const [device, setDevice] = React.useState('desktop');
    const stageRef = React.useRef(null);
    const [stageWidth, setStageWidth] = React.useState(0);
    const [stageHeight, setStageHeight] = React.useState(0);
    const dragRef = React.useRef(null);

    React.useEffect(() => {
        const el = stageRef.current;
        if (!el) return undefined;
        // Ignore non-positive readings (e.g. a mid-layout frame while an
        // ancestor's flex height is still resolving) instead of latching
        // a 0 that would scale the embed to nothing and never recover.
        const ro = new ResizeObserver((entries) => {
            const rect = entries[0].contentRect;
            if (rect.width > 0) setStageWidth(rect.width);
            if (rect.height > 0) setStageHeight(rect.height);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const { width, height, sizing, transparent, camera } = settings;
    const deviceWidth = (BUILDER_DEVICES.find((d) => d.id === device) || BUILDER_DEVICES[0]).width;
    const innerW = Math.max(40, (stageWidth || 640) - 48);
    // Both sizing modes clamp to this same device-simulated width; the
    // stage never scrolls, it just narrows its centered "page" backdrop
    // (desktop's 1200 is usually wider than innerW, so it's a no-op there).
    const pageInnerW = Math.max(40, Math.min(innerW, deviceWidth));
    // Compact/phone stage is a fixed 660px box, so its cap stays fixed
    // too; the desktop fill-height stage derives its cap from the box
    // size actually measured above. The floor is a small safety net
    // only (never fully degenerate), not a "comfortable minimum" - a
    // bigger floor would make the chrome want more room than a short
    // box actually has, overflowing its own overflow-hidden bounds.
    const heightCap = compact
        ? BUILDER_STAGE_HEIGHT_CAP
        : Math.max(24, (stageHeight || (BUILDER_STAGE_HEIGHT_CAP + BUILDER_STAGE_CHROME)) - BUILDER_STAGE_CHROME);

    let frameW, frameH, scale;
    if (sizing === 'responsive') {
        frameW = pageInnerW;
        frameH = frameW * ((height / width) || 1);
        scale = Math.min(1, heightCap / frameH);
    } else {
        frameW = width;
        frameH = height;
        scale = Math.min(1, pageInnerW / frameW, heightCap / frameH);
    }
    const scaledW = Math.max(1, Math.round(frameW * scale));
    const scaledH = Math.max(1, Math.round(frameH * scale));
    const shownPct = Math.round(scale * 100);
    const pageBoxWidth = pageInnerW + 48;
    // The camera/size controls row below the frame is normally as wide as
    // the (scaled) embed, but a heavily scaled-down embed would squeeze it
    // into wrapping onto extra lines and overflowing the stage's fixed
    // box. Give it a wider floor (clamped to what actually fits) instead.
    const controlsW = Math.min(pageInnerW, Math.max(scaledW, 620));

    const startDrag = (e) => {
        if (sizing !== 'fixed') return;
        e.preventDefault();
        dragRef.current = { startX: e.clientX, startY: e.clientY, startW: width, startH: height, scale: scale || 1 };
        const onMove = (ev) => {
            const d = dragRef.current;
            if (!d) return;
            const nw = Math.max(160, Math.round(d.startW + (ev.clientX - d.startX) / d.scale));
            const nh = Math.max(120, Math.round(d.startH + (ev.clientY - d.startY) / d.scale));
            patch({ width: nw, height: nh });
        };
        const onUp = () => {
            dragRef.current = null;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    return (
        <div ref={fadeRef} className={compact
            ? 'space-y-2 sticky top-0 z-10 bg-gray-900 pb-2'
            : 'col-start-1 row-start-1 min-h-0 min-w-0 flex flex-col gap-2'}
        >
            {!compact ? (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 text-xs">
                        <span className="font-medium text-gray-300">Live preview</span>
                        <span className={'w-1.5 h-1.5 rounded-full ' + (ready ? 'bg-green-400' : 'bg-gray-500 animate-pulse')} />
                        <span className="text-gray-500">{ready ? 'Ready' : 'Loading...'}</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={onReloadPreview}
                            title="Rebuild the preview frame from scratch with the settings as they stand"
                            className={BTN_SECONDARY + ' inline-flex items-center gap-1.5'}
                        >
                            <MtlxIcon name="refresh" className="w-3.5 h-3.5" />
                            Reload preview
                        </button>
                        <div className="inline-flex rounded-lg border border-gray-700 overflow-hidden">
                            {BUILDER_DEVICES.map((d) => (
                                <button
                                    key={d.id} type="button" title={d.id} onClick={() => setDevice(d.id)}
                                    className={'h-7 w-8 flex items-center justify-center border-l border-gray-700 first:border-l-0 transition-colors '
                                        + (device === d.id ? 'bg-gray-700 text-gray-100' : 'bg-gray-900 text-gray-500 hover:text-gray-300')}
                                >
                                    <MtlxIcon name={d.icon} className="w-3.5 h-3.5" />
                                </button>
                            ))}
                        </div>
                        <a href={iframeUrl} target="_blank" rel="noopener noreferrer" className={BTN_SECONDARY + ' inline-flex items-center gap-1.5'}>
                            <MtlxIcon name="external-link" className="w-3.5 h-3.5" />
                            Open in new tab
                        </a>
                    </div>
                </div>
            ) : (
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs">
                        <span className={'w-1.5 h-1.5 rounded-full ' + (ready ? 'bg-green-400' : 'bg-gray-500 animate-pulse')} />
                        <span className="text-gray-500">{ready ? 'Ready' : 'Loading...'}</span>
                    </div>
                    <a
                        href={iframeUrl} target="_blank" rel="noopener noreferrer" title="Open in new tab"
                        className="h-7 w-7 rounded border border-gray-600 bg-gray-800/80 text-gray-300 flex items-center justify-center shrink-0"
                    >
                        <MtlxIcon name="external-link" className="w-3.5 h-3.5" />
                    </a>
                </div>
            )}

            <div
                ref={stageRef}
                // Compact/phone: fixed 660px, matching the old constant
                // height. Desktop: fills the column's remaining height
                // (heightCap above follows this box's own measured size).
                className={'rounded-lg border border-gray-700 overflow-hidden flex items-center justify-center '
                    + (compact ? 'h-[660px]' : 'flex-1 min-h-0')}
                style={{
                    backgroundColor: '#0b1220',
                    backgroundImage: 'linear-gradient(rgba(107,114,128,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(107,114,128,0.14) 1px, transparent 1px)',
                    backgroundSize: '20px 20px',
                }}
            >
                <div
                    className="flex flex-col items-center gap-2 p-6"
                    style={{ width: pageBoxWidth }}
                >
                    <div
                        className="relative shrink-0"
                        style={{ width: scaledW, height: scaledH, ...(transparent ? BUILDER_CHECKERBOARD_STYLE : {}) }}
                    >
                        <div ref={previewMountRef} style={{ width: frameW, height: frameH, transform: `scale(${scale})`, transformOrigin: 'top left' }} />

                        {sizing === 'fixed' && !compact && (
                            <div
                                onPointerDown={startDrag}
                                title="Drag to resize"
                                className="absolute right-0 bottom-0 w-4 h-4 cursor-nwse-resize flex items-end justify-end p-0.5 text-gray-500 hover:text-gray-300"
                            >
                                <svg viewBox="0 0 10 10" className="w-2.5 h-2.5">
                                    <path d="M9 1L1 9M9 5L5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                                </svg>
                            </div>
                        )}
                    </div>

                    {/* Builder-only camera controls + size readout: kept out of the
                        frame itself so they never read as part of the embed's own HUD. */}
                    <div className="flex items-center justify-between gap-2 flex-wrap" style={{ width: controlsW }}>
                        <div className="flex items-center gap-1.5">
                            <button
                                type="button" title="Use current view" onClick={onUseCurrentView}
                                className={BTN_SECONDARY + ' inline-flex items-center gap-1.5'}
                            >
                                <MtlxIcon name="camera" className="w-3.5 h-3.5" />
                                {!compact && 'Use current view'}
                            </button>
                            <button
                                type="button" title="Reset" disabled={!camera.trim()} onClick={() => patch({ camera: '' })}
                                className={BTN_SECONDARY + ' inline-flex items-center gap-1.5' + (!camera.trim() ? ' opacity-50 cursor-not-allowed' : '')}
                            >
                                <MtlxIcon name="refresh" className="w-3.5 h-3.5" />
                                {!compact && 'Reset'}
                            </button>
                            <span className="text-[11px] text-gray-500 whitespace-nowrap">Start camera: {camera.trim() ? 'custom' : 'default'}</span>
                        </div>
                        <p className="text-[11px] text-gray-500 whitespace-nowrap">
                            {width} x {height} <span className="text-gray-700">|</span> {builderAspectLabel(width, height)}{' '}
                            <span className="text-gray-700">|</span> Shown at {shownPct}% inside a {device}-width page
                        </p>
                    </div>
                </div>
            </div>

            {compact && (
                <div className="flex items-center gap-2">
                    <button type="button" onClick={onCopyIframe} className={BTN_PRIMARY + ' flex-1 h-9 justify-center inline-flex items-center gap-1.5'}>
                        <MtlxIcon name="copy" className="w-3.5 h-3.5" />
                        Copy iframe
                    </button>
                    <button
                        type="button"
                        onClick={() => { const el = document.getElementById('builder-snippets'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                        className={BTN_SECONDARY + ' flex-1 h-9 justify-center inline-flex items-center gap-1.5'}
                    >
                        <MtlxIcon name="code" className="w-3.5 h-3.5" />
                        View snippets
                    </button>
                </div>
            )}

            {errors.length > 0 && (
                <div className="rounded-lg border border-amber-700/50 bg-amber-900/20 text-amber-200 text-xs p-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                        <span className="font-medium flex items-center gap-1.5">
                            <MtlxIcon name="alert-triangle" className="w-4 h-4" />
                            {`Preview reported ${errors.length} issue${errors.length > 1 ? 's' : ''}`}
                        </span>
                        <button type="button" onClick={onClearErrors} className="text-amber-300/80 hover:text-amber-100">Clear</button>
                    </div>
                    <ul className="space-y-1 max-h-32 overflow-y-auto custom-scrollbar">
                        {errors.map((e) => <li key={e.id} className="text-amber-100/90">{e.message}</li>)}
                    </ul>
                </div>
            )}
        </div>
    );
}

function BuilderApp({ active } = {}) {
    const [settings, setSettings] = React.useState(() => ({ ...BUILDER_DEFAULTS, ...parseBuilderHashSettings() }));
    const patch = (values) => setSettings((s) => ({ ...s, ...values }));
    const {
        src, geometry, controls, backdrop, transparent, autorotate, env, exposure, envmap,
        accent, surface, text, radius, width, height, sizing, material, camera, wheelZoom,
        version, poster, eager,
    } = settings;

    const [presetPick, setPresetPick] = React.useState(''); // selected MTLX_PRESETS URL, or '' (placeholder)
    const [renderables, setRenderables] = React.useState([]); // last 'mtlx-renderables' detail

    const [helpOpen, setHelpOpen] = React.useState(false);
    const [helpHtml, setHelpHtml] = React.useState(null);
    const [helpError, setHelpError] = React.useState(false);
    const [helpLoading, setHelpLoading] = React.useState(false);
    const helpFetchStartedRef = React.useRef(false);

    const [ready, setReady] = React.useState(false);
    const [errors, setErrors] = React.useState([]);
    const [copiedKey, setCopiedKey] = React.useState(null);
    const [snippetTab, setSnippetTab] = React.useState('iframe');
    const copyTimerRef = React.useRef(null);

    const previewMountRef = React.useRef(null);
    const previewElRef = React.useRef(null);
    // Bumping this re-runs the mount effect below, which tears the element
    // down and rebuilds it from the settings as they stand right now.
    const [previewNonce, setPreviewNonce] = React.useState(0);

    const rootRef = React.useRef(null);
    const fadeRef = React.useRef(null);
    const contentRef = React.useRef(null);
    const [containerWidth, setContainerWidth] = React.useState(0);
    React.useEffect(() => {
        const el = contentRef.current;
        if (!el) return undefined;
        const ro = new ResizeObserver((entries) => setContainerWidth(entries[0].contentRect.width));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const effectiveWidth = containerWidth || Math.min(window.innerWidth - 32, 1280);
    const columns = builderColumnsFor(effectiveWidth);

    // Pushes an advisory message into the errors banner, deduped against
    // whatever the last entry already says so repeated hints don't stack
    // up back-to-back (a real mtlx-error can still follow/precede it).
    const pushHint = (message) => {
        setErrors((prev) => (prev.length && prev[prev.length - 1].message === message)
            ? prev
            : [...prev.slice(-5), { id: Math.random(), message }]);
    };

    const controlsStr = controlsStrFrom(controls);

    // Full rebuild, not a live property update: the effect re-runs with a
    // fresh closure, so every setting is re-applied before the element is
    // connected, exactly as on first mount.
    const reloadPreview = () => {
        setReady(false);
        setPreviewNonce((n) => n + 1);
    };

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
        el.backdrop = backdrop;
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
            // The Scene/Look cards keep transparent + shaderball-scene
            // unreachable, so this warning would only ever be stale noise.
            if (/^transparent cannot render/i.test(message)) return;
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
    }, [previewNonce]);

    // Live-updating properties (docs/EMBEDDING.md LIVE_ATTRS): applied on
    // every change via the element's own property setters, which handle
    // the postMessage round trip - no reload, so no debounce needed here.
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.geometry = geometry; }, [geometry]);
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.env = env.trim(); }, [env]);
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.exposure = exposure.trim(); }, [exposure]);
    React.useEffect(() => { if (previewElRef.current) previewElRef.current.backdrop = backdrop; }, [backdrop]);
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
        setSettings((s) => (s.material && !renderables.some((r) => r.name === s.material)) ? { ...s, material: '' } : s);
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
    const handlePresetPick = (url) => {
        setPresetPick(url);
        if (!url) return;
        patch({ src: url });
        commitSrcValue(url);
    };

    const handleUseCurrentView = async () => {
        if (!previewElRef.current) return;
        try {
            const pose = await previewElRef.current.getCamera();
            patch({ camera: builderFormatCamera(pose) });
        } catch (err) {
            setErrors((prev) => [...prev.slice(-5), { id: Math.random(), message: errMsg(err) }]);
        }
    };

    // Full reset to BUILDER_DEFAULTS, then layered with `values` - used by
    // both the header Reset button (values = {}) and template picks.
    const applySettings = (values) => {
        const next = { ...BUILDER_DEFAULTS, ...values };
        setSettings(next);
        setPresetPick('');
        commitSrcValue(next.src);
        commitEnvmapValue(next.envmap);
    };
    const handleReset = () => applySettings({});
    const handleTemplate = (t) => applySettings(t.values);

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

    // Serializes the non-default settings into "#!builder?..." (same param
    // names as the embed query string, plus builder-only w/h/sizing),
    // replaces the URL bar hash, and copies the resulting link.
    const handleShareConfig = async () => {
        const qs = buildShareParams(settings).toString();
        const hash = '#!builder' + (qs ? '?' + qs : '');
        try { history.replaceState(null, '', hash); } catch (e) { window.location.hash = hash; }
        const url = window.location.origin + window.location.pathname + window.location.search + hash;
        await copySnippet('share', url);
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
        if (backdrop !== BUILDER_DEFAULTS.backdrop) entries.push(['backdrop', backdrop]);
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
        if (backdrop !== BUILDER_DEFAULTS.backdrop) attrs.push(`backdrop="${backdrop}"`);
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

    // ---- Derived display bits ----
    const defaultOpen = columns !== 1;
    const matchedAspect = builderMatchedAspect(width, height);
    const activeThemePreset = builderActiveThemePreset(settings);
    const themeSummary = activeThemePreset ? activeThemePreset.label : 'Custom';
    const docSummary = src.trim() ? builderFileNameFromUrl(src.trim()) : 'Built-in default material';
    const lightingAtDefault = (env.trim() === '' || Number(env) === 0) && (exposure.trim() === '' || Number(exposure) === 1);
    // Std. Shader Ball w/ Backdrop is an opaque authored room; several
    // controls below are dead against it, all keyed on this condition.
    const roomGeom = geometry === 'shaderball-scene';
    // Room geometry can't render transparent (docs/EMBEDDING.md); a
    // studio or environment backdrop is an equally opaque backdrop.
    // Either cause makes every pixel opaque, so block transparent from both.
    const transparentDisabled = roomGeom || backdrop !== 'none';
    // Same geometry also has no turntable rotation (js/viewer-app.jsx hides
    // the rotate button whenever roomGeomActive) - the HUD control still
    // toggles, but the button it would add never renders. Explain it rather
    // than silently emitting a control that does nothing.
    const rotateHudDisabled = roomGeom;
    // The engine forces autoRotate off unconditionally for this geometry
    // and setAutoRotate returns early - the Behavior toggle is a no-op.
    const autorotateDisabled = roomGeom;
    // Studio/environment are both drawn behind the room's own walls, and
    // with transparent on either would defeat transparent's whole point.
    const backdropPickerDisabled = roomGeom || transparent;
    // Accent/surface/text/radius only ever become CSS vars for the HUD
    // strip's stylesheet - a hint, not a disable (also the default state).
    const noHudControls = !controlsStr;

    // Raw content, unwrapped: placed directly by the JSX below. previewContent
    // is never a MasonryItem (see masonryItems further down); snippets/legend
    // are MasonryItems on phone only, a plain grid row on wider layouts.
    const previewContent = (
        <PreviewStage
            settings={settings}
            patch={patch}
            ready={ready}
            errors={errors}
            onClearErrors={() => setErrors([])}
            onUseCurrentView={handleUseCurrentView}
            previewMountRef={previewMountRef}
            iframeUrl={iframeUrl}
            compact={columns === 1}
            onCopyIframe={() => copySnippet('iframe', iframeSnippet)}
            onReloadPreview={reloadPreview}
            fadeRef={fadeRef}
        />
    );
    const snippetsContent = (
        <SnippetsCard
            tab={snippetTab}
            onTab={setSnippetTab}
            iframeSnippet={iframeSnippet}
            elementSnippet={elementSnippet}
            copied={copiedKey === snippetTab}
            onCopy={() => copySnippet(snippetTab, snippetTab === 'iframe' ? iframeSnippet : elementSnippet)}
        />
    );
    const legendContent = <LegendBlock />;

    // "Start from a template": a SectionCard for the sidebar (columns 2/3,
    // full-width stacked rows, collapsible like every other sidebar card)
    // vs. today's horizontally scrolling strip for the phone path (columns
    // === 1, rendered in the main flow instead - see the return below).
    const activeTemplate = BUILDER_TEMPLATES.find((t) => isTemplateActive(t, settings));
    const templatesSummary = activeTemplate ? activeTemplate.name : 'Custom';
    const templatesCard = (
        <SectionCard key="templates" icon="presets" title="Start from a template" summary={templatesSummary} defaultOpen={defaultOpen}>
            <p className="text-[11px] text-gray-500">Prefills every setting below. You can change anything afterwards.</p>
            <div className="space-y-2">
                {BUILDER_TEMPLATES.map((t) => (
                    <TemplateCard key={t.id} t={t} active={isTemplateActive(t, settings)} onClick={() => handleTemplate(t)} compact />
                ))}
            </div>
        </SectionCard>
    );
    const templatesStrip = (
        <div>
            <div className="flex items-baseline gap-2 flex-wrap mb-2.5">
                <span className="text-[13px] font-semibold text-gray-300">Start from a template</span>
                <span className="text-[11px] text-gray-500">Prefills every setting below. You can change anything afterwards.</span>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-1 custom-scrollbar">
                {BUILDER_TEMPLATES.map((t) => (
                    <div key={t.id} className="w-64 shrink-0">
                        <TemplateCard t={t} active={isTemplateActive(t, settings)} onClick={() => handleTemplate(t)} />
                    </div>
                ))}
            </div>
        </div>
    );

    const cardsContent = [
        <SectionCard key="doc" icon="file-text" title="Document" pill={<ReloadsPill />} summary={docSummary} defaultOpen={defaultOpen}>
            <div>
                <FieldLabel label="Document URL (src)" />
                <input
                    type="text" value={src}
                    onChange={(e) => { patch({ src: e.target.value }); setPresetPick(''); }}
                    onBlur={commitSrc}
                    onKeyDown={(e) => { if (e.key === 'Enter') { commitSrc(); e.currentTarget.blur(); } }}
                    placeholder="https://example.com/materials/brushed_steel.mtlx"
                    className={TEXT_INPUT_CLS}
                />
                <p className="text-[11px] text-gray-500 mt-1">Applies on Enter or when the field loses focus.</p>
            </div>
            {window.MTLX_PRESETS && window.presetDocUrl && (
                <div>
                    <FieldLabel label="Or pick a curated example" />
                    <MtlxSelect
                        value={presetPick}
                        options={window.MTLX_PRESETS.map((p) => ({ value: window.presetDocUrl(p), label: p.label }))}
                        placeholder="Choose a curated example"
                        onChange={handlePresetPick}
                        defValue={null}
                        size="lg"
                        variant="field"
                        block
                    />
                </div>
            )}
            <div className="grid grid-cols-2 gap-3">
                <div>
                    <FieldLabel label="Material" pill={<LivePill />} />
                    <MtlxSelect
                        value={material}
                        options={renderables.map((r) => ({ value: r.name, label: r.name }))}
                        emptyOption="First material"
                        disabled={renderables.length < 2}
                        icon={renderables.length < 2 ? 'lock' : undefined}
                        onChange={(v) => patch({ material: v })}
                        defValue={null}
                        size="lg"
                        variant="field"
                        block
                        className={renderables.length < 2 ? 'border-dashed' : undefined}
                    />
                </div>
                <div>
                    <FieldLabel label="MaterialX version" />
                    {BUILDER_VERSIONS.length > 0 && (
                        <MtlxSelect
                            value={version}
                            options={BUILDER_VERSIONS}
                            onChange={(v) => patch({ version: v })}
                            defValue={BUILDER_DEFAULT_VERSION || null}
                            size="lg"
                            variant="field"
                            block
                        />
                    )}
                </div>
            </div>
            <p className="text-[11px] text-gray-500">Unlocks for documents with 2 or more materials.</p>
        </SectionCard>,

        <SectionCard key="scene" icon="cube" title="Scene" pill={<ReloadsPill />} summary={(window.GEOM_LABELS && window.GEOM_LABELS[geometry]) || geometry} defaultOpen={defaultOpen}>
            <div>
                <FieldLabel label="Geometry" />
                <div className="grid grid-cols-3 gap-2">
                    {BUILDER_GEOM_OPTIONS.map((g) => {
                        const geomDisabled = g === 'shaderball-scene' && transparent;
                        return (
                            <GeometryTile
                                key={g}
                                label={(window.GEOM_LABELS && window.GEOM_LABELS[g]) || g}
                                icon={GEOM_ICONS[g]}
                                selected={geometry === g}
                                disabled={geomDisabled}
                                title={geomDisabled ? 'Not available with a transparent page background' : undefined}
                                onClick={() => patch({ geometry: g })}
                            />
                        );
                    })}
                </div>
            </div>
        </SectionCard>,

        <SectionCard key="lighting" icon="sun" title="Lighting" summary={builderLightingSummary(env, exposure)} defaultOpen={defaultOpen}>
            <div>
                <FieldLabel label="Environment map URL (.hdr / .exr)" />
                <input
                    type="text" value={envmap}
                    onChange={(e) => patch({ envmap: e.target.value })}
                    onBlur={commitEnvmap}
                    onKeyDown={(e) => { if (e.key === 'Enter') { commitEnvmap(); e.currentTarget.blur(); } }}
                    placeholder="(default environment)"
                    className={TEXT_INPUT_CLS}
                />
            </div>
            <SliderField
                label="Environment rotation" unit="deg" value={env} min={0} max={360} step={1} placeholder="0"
                onSlider={(v) => patch({ env: Number(v) === 0 ? '' : v })}
                onNumber={(v) => patch({ env: v })}
            />
            <SliderField
                label="Exposure" unit="EV" value={builderExposureEv(exposure)} min={-3} max={3} step={0.1} placeholder="0"
                onSlider={(v) => patch({ exposure: builderEvToExposure(v) })}
                onNumber={(v) => patch({ exposure: builderEvToExposure(v) })}
            />
            <div className="flex justify-end">
                <button
                    type="button"
                    disabled={lightingAtDefault}
                    onClick={() => patch({ env: '', exposure: '' })}
                    className={BTN_SECONDARY + ' inline-flex items-center gap-1.5' + (lightingAtDefault ? ' opacity-50 cursor-not-allowed' : '')}
                >
                    <MtlxIcon name="refresh" className="w-3.5 h-3.5" />
                    Reset rotation and exposure
                </button>
            </div>
            <div>
                <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-gray-400">Backdrop</span>
                    <MtlxSelect
                        value={backdrop}
                        options={['studio', 'studio-dark', 'environment', 'none']}
                        labels={{ studio: 'Studio', 'studio-dark': 'Studio (Dark)', environment: 'Environment', none: 'None' }}
                        onChange={(v) => patch({ backdrop: v })}
                        defValue={BUILDER_DEFAULTS.backdrop}
                        disabled={backdropPickerDisabled}
                        size="sm"
                    />
                </div>
                {backdropPickerDisabled && (
                    <div className="mt-1.5 flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
                        <MtlxIcon name="alert-triangle" className="w-3.5 h-3.5 shrink-0 mt-px" />
                        <span>{roomGeom
                            ? 'Disabled: Std. Shader Ball w/ Backdrop covers the sky with its own walls. Pick another geometry to enable it.'
                            : 'Disabled: Transparent page background is on, covering every pixel. Turn off Transparent page background to enable it.'}</span>
                    </div>
                )}
            </div>
        </SectionCard>,

        <SectionCard key="look" icon="palette" title="Look" summary={themeSummary} defaultOpen={defaultOpen}>
            <div>
                <FieldLabel label="Theme preset" />
                <div className="grid grid-cols-3 gap-2">
                    {BUILDER_THEME_PRESETS.map((p) => {
                        const presetDisabled = p.id === 'card' && geometry === 'shaderball-scene';
                        return (
                            <ThemeTile
                                key={p.id} preset={p} active={activeThemePreset && activeThemePreset.id === p.id}
                                disabled={presetDisabled}
                                title={presetDisabled ? 'Std. Shader Ball w/ Backdrop cannot be transparent. Pick another geometry to enable this preset.' : undefined}
                                onClick={() => patch({ accent: p.accent, surface: p.surface, text: p.text, radius: p.radius, transparent: p.transparent })}
                            />
                        );
                    })}
                </div>
            </div>
            <div className="grid grid-cols-3 gap-2.5">
                <ColorField label="Accent" value={accent} onChange={(v) => patch({ accent: v })} placeholder={BUILDER_THEME_DEFAULTS.accent} />
                <ColorField label="Surface" value={surface} onChange={(v) => patch({ surface: v })} placeholder={BUILDER_THEME_DEFAULTS.surface} />
                <ColorField label="Text" value={text} onChange={(v) => patch({ text: v })} placeholder={BUILDER_THEME_DEFAULTS.text} />
            </div>
            <SliderField
                label="HUD corner radius" unit="px" value={radius} min={0} max={24} step={1} placeholder={BUILDER_THEME_DEFAULTS.radius}
                onSlider={(v) => patch({ radius: v })}
                onNumber={(v) => patch({ radius: v })}
            />
            {noHudControls && (
                <p className="text-[11px] text-gray-500">Theme colors and corner radius style the HUD strip only. Turn on a HUD control to see them.</p>
            )}
            <div>
                <label className={'flex items-center justify-between gap-3 ' + (transparentDisabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
                    <span className="text-xs font-medium text-gray-400">Transparent page background</span>
                    <Toggle checked={transparent} onChange={(v) => patch({ transparent: v })} disabled={transparentDisabled} />
                </label>
                {transparentDisabled ? (
                    <div className="mt-1.5 flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
                        <MtlxIcon name="alert-triangle" className="w-3.5 h-3.5 shrink-0 mt-px" />
                        <span>{roomGeom
                            ? 'Disabled: Std. Shader Ball w/ Backdrop cannot be transparent. Pick another geometry to enable it.'
                            : 'Disabled: Backdrop is not set to None, covering every pixel. Set Backdrop to None to enable it.'}</span>
                    </div>
                ) : (
                    <p className="text-[11px] mt-1 text-gray-500">Not compatible with Std. Shader Ball w/ Backdrop.</p>
                )}
            </div>
            <HudMiniPreview accent={accent} surface={surface} text={text} radius={radius} />
        </SectionCard>,

        <SectionCard key="hud" icon="layout-grid" title="HUD controls" pill={<ReloadsPill />} summary={builderHudSummary(controls)} defaultOpen={defaultOpen}>
            <div className="flex flex-wrap gap-2">
                {BUILDER_CONTROLS.map((c) => {
                    const materialLocked = c.id === 'material' && renderables.length < 2;
                    const rotateLocked = c.id === 'rotate' && rotateHudDisabled;
                    const locked = materialLocked || rotateLocked;
                    const title = materialLocked
                        ? 'Unlocks for documents with 2 or more materials'
                        : rotateLocked
                            ? 'Std. Shader Ball w/ Backdrop has no turntable rotation. Pick another geometry to enable it.'
                            : undefined;
                    return (
                        <Chip
                            key={c.id} icon={c.icon} active={!!controls[c.id]} disabled={locked} dashed={locked}
                            title={title}
                            onClick={() => patch({ controls: { ...controls, [c.id]: !controls[c.id] } })}
                        >
                            {c.chip}
                        </Chip>
                    );
                })}
            </div>
            <p className="text-[11px] text-gray-500">Material selection unlocks for documents with 2 or more materials.</p>
            {rotateHudDisabled && (
                <div className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
                    <MtlxIcon name="alert-triangle" className="w-3.5 h-3.5 shrink-0 mt-px" />
                    <span>Disabled: Std. Shader Ball w/ Backdrop has no turntable rotation. Pick another geometry to enable it.</span>
                </div>
            )}
            <div className="flex items-center gap-3 text-[11px]">
                <button
                    type="button" className="text-blue-400 hover:text-blue-300"
                    onClick={() => { const o = {}; BUILDER_CONTROLS.forEach((c) => { o[c.id] = true; }); patch({ controls: o }); }}
                >
                    All
                </button>
                <span className="text-gray-700">|</span>
                <button type="button" className="text-blue-400 hover:text-blue-300" onClick={() => patch({ controls: {} })}>None</button>
            </div>
        </SectionCard>,

        <SectionCard key="behavior" icon="adjustments" title="Behavior" summary={builderBehaviorSummary(autorotate, wheelZoom)} defaultOpen={defaultOpen}>
            <label className={'flex items-center justify-between gap-3 ' + (autorotateDisabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
                <span className="flex items-center gap-1.5 text-xs font-medium text-gray-400">Auto-rotate <ReloadsPill /></span>
                <Toggle checked={autorotate} onChange={(v) => patch({ autorotate: v })} disabled={autorotateDisabled} />
            </label>
            {autorotateDisabled && (
                <div className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
                    <MtlxIcon name="alert-triangle" className="w-3.5 h-3.5 shrink-0 mt-px" />
                    <span>Disabled: Std. Shader Ball w/ Backdrop has no turntable rotation. Pick another geometry to enable it.</span>
                </div>
            )}
            <label className="flex items-center justify-between gap-3 cursor-pointer">
                <span className="flex items-center gap-1.5 text-xs font-medium text-gray-400">Direct wheel zoom, no Ctrl needed <ReloadsPill /></span>
                <Toggle checked={wheelZoom} onChange={(v) => patch({ wheelZoom: v })} />
            </label>
            <div className="border-t border-gray-700/60 pt-3.5 space-y-3">
                <div>
                    <div className="text-xs font-medium text-gray-300">Loading</div>
                    <p className="text-[11px] text-gray-500 mt-0.5">Poster shows until the viewer activates, eager skips waiting for it to scroll into view.</p>
                </div>
                <div>
                    <FieldLabel label="Poster image URL" />
                    <input type="text" value={poster} onChange={(e) => patch({ poster: e.target.value })} placeholder="(none)" className={TEXT_INPUT_CLS} />
                </div>
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                    <span className="text-xs font-medium text-gray-400">Eager (skip lazy-loading)</span>
                    <Toggle checked={eager} onChange={(v) => patch({ eager: v })} />
                </label>
            </div>
        </SectionCard>,

        <SectionCard key="size" icon="dimensions" title="Size" summary={builderSizeSummary(settings)} defaultOpen={defaultOpen}>
            <div>
                <FieldLabel label="Sizing" />
                <div className="inline-flex rounded-lg border border-gray-700 overflow-hidden">
                    <button
                        type="button" onClick={() => patch({ sizing: 'fixed' })}
                        className={'h-8 px-3 text-xs font-medium transition-colors '
                            + (sizing === 'fixed' ? 'bg-blue-600/70 text-white' : 'bg-gray-900 text-gray-400 hover:text-gray-200')}
                    >
                        Fixed (px)
                    </button>
                    <button
                        type="button" onClick={() => patch({ sizing: 'responsive' })}
                        className={'h-8 px-3 text-xs font-medium border-l border-gray-700 transition-colors '
                            + (sizing === 'responsive' ? 'bg-blue-600/70 text-white' : 'bg-gray-900 text-gray-400 hover:text-gray-200')}
                    >
                        Responsive
                    </button>
                </div>
            </div>
            <div>
                <FieldLabel label="Aspect presets" />
                <div className="flex flex-wrap gap-1.5">
                    {ASPECT_PRESETS.map((p) => (
                        <Chip
                            key={p.id} active={!!matchedAspect && matchedAspect.id === p.id}
                            onClick={() => patch({ height: Math.max(1, Math.round(width * p.h / p.w)) })}
                        >
                            {p.id}
                        </Chip>
                    ))}
                    <Chip active={!matchedAspect} onClick={() => {}}>Custom</Chip>
                </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
                <div>
                    <FieldLabel label={sizing === 'responsive' ? 'Aspect W' : 'Width (px)'} />
                    <input type="number" min="1" value={width} onChange={(e) => patch({ width: Math.max(1, Number(e.target.value) || 1) })} className={TEXT_INPUT_CLS} />
                </div>
                <div>
                    <FieldLabel label={sizing === 'responsive' ? 'Aspect H' : 'Height (px)'} />
                    <input type="number" min="1" value={height} onChange={(e) => patch({ height: Math.max(1, Number(e.target.value) || 1) })} className={TEXT_INPUT_CLS} />
                </div>
            </div>
            <p className="text-[11px] text-gray-500">Or drag the corner of the preview.</p>
        </SectionCard>,
    ];

    // Phone (1 column) keeps the old masonry stack for the cards, snippets
    // and legend (reachable via the sticky stage's "View snippets" button).
    // previewContent itself is NOT a masonry item (see below).
    const masonryItems = columns === 1
        ? [
            ...cardsContent.map((c) => <MasonryItem key={c.key} span={1}>{c}</MasonryItem>),
            <MasonryItem key="snippets" span={1}>{snippetsContent}</MasonryItem>,
            <MasonryItem key="legend" span={1}>{legendContent}</MasonryItem>,
        ]
        : null;

    return (
        <div ref={rootRef} className="relative md:h-full md:flex md:flex-col md:min-h-0">
            <HeroGrid rootRef={rootRef} fadeRef={fadeRef} fadeFrom="top" />
            {/* w-full: without it, mx-auto's auto margins disable flex stretch and
                this column shrink-to-fits its content instead of clamping at
                max-w-7xl - letting the snippets grid's 1fr track's max-content
                (driven by the active snippet's text) resize the whole page. */}
            <div ref={contentRef} className="relative w-full max-w-7xl mx-auto space-y-3 md:flex-1 md:min-h-0 md:flex md:flex-col">
                <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-gray-500">
                    <a href="#!home" className="hover:text-gray-300 transition-colors">Home</a>
                    <MtlxIcon name="chevron-right" className="w-3 h-3" />
                    <span>Integrate</span>
                    <MtlxIcon name="chevron-right" className="w-3 h-3" />
                    <span className="text-gray-400">Embed Builder</span>
                </nav>

                <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                        <div className="flex items-center gap-2">
                            <h1 className="text-2xl font-bold text-gray-100">Embed Builder</h1>
                            <span className="text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300">
                                Experimental
                            </span>
                        </div>
                        <p className="text-sm text-gray-400 mt-1">
                            Configure an embeddable MaterialX viewer against a live preview, then copy a ready-made snippet.
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <button type="button" onClick={handleShareConfig} className={BTN_SECONDARY + ' inline-flex items-center gap-1.5'}>
                            <MtlxIcon name="share" className="w-3.5 h-3.5" />
                            {copiedKey === 'share' ? 'Link copied' : 'Share config'}
                        </button>
                        <button type="button" onClick={handleReset} className={BTN_SECONDARY + ' inline-flex items-center gap-1.5'}>
                            <MtlxIcon name="refresh" className="w-3.5 h-3.5" />
                            Reset
                        </button>
                        <button type="button" onClick={() => setHelpOpen(true)} title="Embedding reference" className={BTN_SECONDARY + ' inline-flex items-center gap-1.5'}>
                            <MtlxIcon name="help" className="w-3.5 h-3.5" />
                            Help
                        </button>
                    </div>
                </div>

                {/* Templates: phone keeps the old horizontally scrolling strip
                    in the main flow, rendered here at this same fixed source
                    position (columns 2/3 render nothing here - it moves into
                    the sidebar as a SectionCard instead, costing no page
                    height since only the sidebar scrolls there). This stays
                    OUTSIDE the ternary below on purpose: previewContent must
                    stay each branch's own first child so PreviewStage (and
                    the live materialx-viewer it owns) never unmounts when
                    `columns` crosses 1 - see that comment below. */}
                {columns === 1 && templatesStrip}

                {/* previewContent is always this div's first child in both
                    branches, so PreviewStage (and the live materialx-viewer
                    it owns) never unmounts when `columns` crosses 1. */}
                {columns === 1 ? (
                    <div className="space-y-5">
                        {previewContent}
                        <MasonryGrid columns={columns}>
                            {masonryItems}
                        </MasonryGrid>
                    </div>
                ) : (
                    // Two-row left column (preview fills row 1, snippets +
                    // legend sit side by side in row 2) beside a sidebar
                    // that spans both rows and scrolls its cards on its own.
                    <div className="grid grid-cols-[minmax(0,1fr)_360px] grid-rows-[minmax(0,1fr)_auto] gap-3 md:flex-1 md:min-h-0">
                        {previewContent}
                        {/* h-[142px] is the single height both cards fill (h-full)
                            below - matches the snippets card total (36px tab
                            header + 104px code + 2px border) so the preview's
                            "Shown at 100%" cap is unaffected by this change. */}
                        <div className="col-start-1 row-start-2 grid grid-cols-2 gap-5 min-w-0 h-[142px]">
                            {snippetsContent}
                            {legendContent}
                        </div>
                        <div className="col-start-2 row-start-1 row-span-2 space-y-5 overflow-y-auto custom-scrollbar pr-2 min-h-0">
                            {templatesCard}
                            {cardsContent}
                        </div>
                    </div>
                )}
            </div>

            <BuilderHelpDialog
                open={helpOpen}
                onClose={() => setHelpOpen(false)}
                html={helpHtml}
                loading={helpLoading}
                error={helpError}
            />
        </div>
    );
}

window.BuilderApp = BuilderApp;
