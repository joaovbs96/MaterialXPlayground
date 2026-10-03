// js/shared/theme-editor.jsx: the Theme editor side panel (custom themes, live preview, sharing).
// Lazily loaded by js/shell.jsx (VIEW_DEPS.themeEditor) on the first 'mtlx-open-theme-editor'
// event, then kept mounted. Exports window.MtlxThemeEditor; talks to the page only via window.MtlxTheme.

const TE_ID = 'mtlx-te';
const TE_MICRO = 'text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle';
const TE_HEX_RE = /^#?([0-9a-fA-F]{6})$/;
const TE_MAX_LABEL = 40;
const TE_MAX_IMPORT_BYTES = 64 * 1024;
const TE_MAX_CODE_CHARS = 8192;
const TE_PREVIEW_DEBOUNCE_MS = 100;
const TE_CURRENT = '__current';
// The three seeds, with the token each one reads from a built-in theme.
const TE_SEEDS = [
    { key: 'background', label: 'Background', token: 'surface-base' },
    { key: 'foreground', label: 'Text', token: 'fg' },
    { key: 'accent', label: 'Accent', token: 'accent-base' },
];
// Spec modifiers (contract amendment): defaults are no-ops; codes quantize to 0.05 steps.
const TE_MODS = [
    { key: 'contrast', label: 'Contrast', min: -1, max: 1, def: 0, lo: 'Softer', hi: 'Crisper' },
    { key: 'tint', label: 'Tint', min: 0, max: 1, def: 0, lo: 'Neutral', hi: 'Tinted' },
];
const teMods = (m) => ({
    contrast: Math.max(-1, Math.min(1, Number(m && m.contrast) || 0)),
    tint: Math.max(0, Math.min(1, Number(m && m.tint) || 0)),
});
const TE_INPUT_CLS = 'w-full h-7 bg-surface-sunken border border-line-control rounded px-2 text-[12px] text-fg-soft placeholder-fg-subtle focus:outline-none focus:border-focus';
const TE_FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-focus';

const teHex = (v) => {
    const m = TE_HEX_RE.exec(String(v == null ? '' : v).trim());
    return m ? '#' + m[1].toLowerCase() : null;
};
const teToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const teFromRgb = (rgb) => '#' + rgb.slice(0, 3).map((c) => {
    const h = Math.round(Math.max(0, Math.min(1, Number(c) || 0)) * 255).toString(16);
    return h.length === 1 ? '0' + h : h;
}).join('');
const teSlug = (label) => String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'theme';
const teHumanize = (id) => {
    const s = String(id || '').replace(/-/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
};
const teErrText = (e, fallback) => String((e && e.message) || (typeof e === 'string' ? e : '') || fallback).slice(0, 240);

function teUniqueId(label, taken) {
    const base = teSlug(label);
    let id = 'custom:' + base;
    for (let n = 2; taken.has(id); n++) {
        const suffix = '-' + n;
        id = 'custom:' + base.slice(0, 40 - suffix.length).replace(/-+$/, '') + suffix;
    }
    return id;
}

// Canonical key of the color part of a draft (base, seeds, sorted overrides).
function teColorKey(d) {
    const o = d.overrides || {};
    const ov = Object.keys(o).sort().map((k) => k + '=' + o[k]).join(',');
    const m = teMods(d.modifiers);
    return [d.base, d.seeds.background, d.seeds.foreground, d.seeds.accent, m.contrast, m.tint, ov].join('|');
}
const teKey = (d) => JSON.stringify([teColorKey(d), d.label]);

// Live value of a token on the page, read from its CSS variable (works for drafts too).
function teLiveHex(cs, token) {
    try {
        const parts = cs.getPropertyValue('--mtlx-' + token).trim().split(/[\s,/]+/).map(Number);
        if (parts.length >= 3 && parts.slice(0, 3).every((n) => n >= 0 && n <= 255)) return teFromRgb(parts.slice(0, 3).map((n) => n / 255));
    } catch (e) { /* no computed style */ }
    return teHex(window.MtlxTheme.get(token));
}

// A portaled popover (ColorSwatch, MtlxSelect) owns focus and Escape while it is open.
function teInPopover(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.getAttribute && n.getAttribute('role') === 'listbox') return true;
        if (n.style && n.style.position === 'fixed' && n.style.zIndex === '9999') return true;
    }
    return false;
}
function tePopoverOpen() {
    const root = (window.fullscreenPortalRoot && window.fullscreenPortalRoot()) || document.body;
    return Array.prototype.some.call(root.children, (n) => n.style && n.style.position === 'fixed' && n.style.zIndex === '9999');
}

// Unloaded presets: the preset file only registers its token map (it never applies itself).
const tePresetLoads = {};
function teEnsurePreset(id) {
    const D = window.MTLX_THEME_TOKENS || {};
    if (D.themes && D.themes[id]) return Promise.resolve(true);
    if (!/^[a-z0-9-]{1,40}$/.test(id)) return Promise.resolve(false);
    if (tePresetLoads[id]) return tePresetLoads[id];
    const p = new Promise((resolve) => {
        const me = document.querySelector('script[src*="js/shared/theme.js"]');
        const dir = me && me.src ? me.src.replace(/js\/shared\/theme\.js([?#].*)?$/, 'js/gen/themes/') : 'js/gen/themes/';
        const s = document.createElement('script');
        s.onload = () => resolve(!!(D.themes && D.themes[id]));
        s.onerror = () => { delete tePresetLoads[id]; resolve(false); };
        s.src = dir + id + '.js';
        document.head.appendChild(s);
    });
    tePresetLoads[id] = p;
    return p;
}

function teCustomSpec(id) {
    const T = window.MtlxTheme;
    const list = typeof T.listCustom === 'function' ? T.listCustom() || [] : [];
    return list.filter((s) => s && s.id === id)[0] || null;
}

// Draft (label, base, seeds, overrides) for a theme list entry.
async function teDraftFor(entry) {
    const T = window.MtlxTheme;
    const D = window.MTLX_THEME_TOKENS || {};
    if (entry.group === 'custom' || String(entry.id).indexOf('custom:') === 0) {
        const s = teCustomSpec(entry.id);
        if (s) return { label: s.label, base: s.base, seeds: Object.assign({}, s.seeds), overrides: Object.assign({}, s.overrides || {}), modifiers: teMods(s.modifiers) };
    }
    const base = entry.base === 'light' || entry.base === 'dark' ? entry.base : T.currentBase();
    const S = D.seeds || {};
    const fromTokens = (get) => {
        const out = {};
        for (const s of TE_SEEDS) { const h = teHex(get(s.token)); if (!h) return null; out[s.key] = h; }
        return out;
    };
    const fromSeeds = (src) => (src ? fromTokens((t) => src[TE_SEEDS.filter((s) => s.token === t)[0].key]) : null);
    let seeds = entry.id === T.current() ? fromTokens((t) => T.get(t)) : null;
    if (!seeds) seeds = fromSeeds(S[entry.id]);
    if (!seeds && await teEnsurePreset(entry.id)) seeds = fromTokens((t) => D.themes[entry.id][t]);
    if (!seeds) seeds = fromSeeds(S[base]) || fromTokens((t) => T.get(t));
    const label = ('My ' + (entry.label || 'theme')).slice(0, TE_MAX_LABEL);
    return { label, base, seeds, overrides: {}, modifiers: teMods(null) };
}

// Editable list entries: every theme in MtlxTheme.list() except the host-following VS Code entry.
const teEntries = () => (window.MtlxTheme.list() || []).filter((e) => e.id !== 'vscode');

// The entry the page shows right now: the custom preference, else the applied theme.
function teCurrentEntry() {
    const T = window.MtlxTheme;
    const pref = T.getPreference();
    const id = typeof pref === 'string' && pref.indexOf('custom:') === 0 ? pref : T.current();
    return teEntries().filter((e) => e.id === id)[0] || { id: T.current(), label: 'Current theme', base: T.currentBase(), group: 'standard' };
}

function teNormalizeReport(r) {
    const adjusted = r && Array.isArray(r.adjusted) ? r.adjusted : [];
    let errors = r && Array.isArray(r.errors) ? r.errors.slice() : [];
    if (r && r.error) errors.push(r.error);
    if (r && r.ok === false && !errors.length) errors = ['Some colors cannot reach the required contrast.'];
    return { adjusted, errors };
}

// Hex text field: commits each valid #rrggbb as it is typed, reverts on blur when invalid.
function TeHexInput({ id, value, onCommit, ariaLabel }) {
    const [text, setText] = React.useState(value);
    const ref = React.useRef(null);
    React.useEffect(() => {
        if (document.activeElement !== ref.current) setText(value);
    }, [value]);
    const valid = !!teHex(text);
    return (
        <input
            ref={ref}
            id={id}
            type="text"
            value={text}
            maxLength={7}
            spellCheck={false}
            aria-label={ariaLabel}
            aria-invalid={!valid}
            onChange={(e) => {
                setText(e.target.value);
                const h = teHex(e.target.value);
                if (h) onCommit(h);
            }}
            onBlur={() => setText(value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { const h = teHex(text); if (h) onCommit(h); setText(h || value); } }}
            className={'w-[84px] h-7 bg-surface-sunken border rounded px-2 text-[11px] font-mono text-fg-soft focus:outline-none '
                + (valid ? 'border-line-control focus:border-focus' : 'border-error-border text-error-text')}
        />
    );
}

function TeSwatch({ hex, onChange, title }) {
    return (
        <ColorSwatch
            rgb={teToRgb(hex)}
            onChange={(rgb) => onChange(teFromRgb(rgb))}
            title={title}
            className={'h-7 w-10 bg-transparent border border-line-strong rounded cursor-pointer flex-none ' + TE_FOCUS}
        />
    );
}

function TeSegmented({ value, options, onChange, label }) {
    const refs = React.useRef([]);
    const idx = options.findIndex((o) => o.value === value);
    const onKey = (e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const n = (idx + d + options.length) % options.length;
        onChange(options[n].value);
        if (refs.current[n]) refs.current[n].focus();
    };
    return (
        <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line-strong overflow-hidden" onKeyDown={onKey}>
            {options.map((o, i) => {
                const on = o.value === value;
                return (
                    <button
                        key={o.value}
                        ref={(el) => { refs.current[i] = el; }}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        tabIndex={on ? 0 : -1}
                        onClick={() => onChange(o.value)}
                        className={'h-7 inline-flex items-center gap-1.5 px-3 text-[11px] transition-colors ' + TE_FOCUS
                            + (i ? ' border-l border-line-strong' : '')
                            + (on ? ' bg-accent-wash/[0.12] text-accent-fg-strong' : ' text-fg-secondary hover:bg-hover/60')}
                    >
                        {o.icon && <MtlxIcon name={o.icon} className="w-3.5 h-3.5" />}
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}

// Compact range row (SliderField's range idiom): label, value, reset; labeled ends below.
function TeSlider({ mod, value, onChange }) {
    const id = TE_ID + '-mod-' + mod.key;
    const atDefault = Math.abs(value - mod.def) < 1e-9;
    const set = (v) => onChange(Math.round(Math.max(mod.min, Math.min(mod.max, Number(v) || 0)) * 20) / 20);
    return (
        <div>
            <div className="h-5 flex items-center gap-2">
                <label htmlFor={id} className="flex-1 text-[12px] text-fg-soft">{mod.label}</label>
                <span className="text-[11px] font-mono text-fg-muted tabular-nums">{(value > 0 && mod.min < 0 ? '+' : '') + value.toFixed(2)}</span>
                <button type="button" onClick={() => set(mod.def)} disabled={atDefault}
                    title={'Reset ' + mod.label.toLowerCase()} aria-label={'Reset ' + mod.label.toLowerCase()}
                    className={'w-5 h-5 inline-flex items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-hover/60 disabled:opacity-30 disabled:pointer-events-none ' + TE_FOCUS}>
                    <MtlxIcon name="restore" className="w-3.5 h-3.5" />
                </button>
            </div>
            <input
                id={id}
                type="range" min={mod.min} max={mod.max} step={0.05} value={value}
                onChange={(e) => set(e.target.value)}
                onContextMenu={(e) => { e.preventDefault(); set(mod.def); }}
                title="Right click to reset"
                aria-valuetext={value.toFixed(2) + (value === mod.def ? ' (default)' : '')}
                className="w-full accent-accent-base h-1.5"
            />
            <div className="flex justify-between text-[10px] text-fg-subtle" aria-hidden="true">
                <span>{mod.lo}</span><span>{mod.hi}</span>
            </div>
        </div>
    );
}

// Contrast report line list: adjusted pairs (info) and blocking errors.
function TeReport({ report, labelOf, title }) {
    if (!report) return null;
    const { adjusted, errors } = report;
    if (!adjusted.length && !errors.length) {
        return (
            <div className="flex items-center gap-1.5 text-[11px] text-success-text" role="status">
                <MtlxIcon name="check" className="w-3.5 h-3.5" />{title || 'All colors pass'}
            </div>
        );
    }
    return (
        <div className="space-y-1" role="status">
            {title && <div className="text-[11px] text-fg-muted">{title}</div>}
            {errors.map((e, i) => (
                <div key={'e' + i} className="flex items-start gap-1.5 text-[11px] text-error-text">
                    <MtlxIcon name="alert-triangle" className="w-3.5 h-3.5 mt-px flex-none" />
                    <span>{typeof e === 'object' && e && e.fg
                        ? labelOf(e.fg) + ' on ' + labelOf(e.bg) + ' cannot reach the required contrast'
                        : teErrText(e, 'Contrast check failed')}</span>
                </div>
            ))}
            {adjusted.map((a, i) => {
                const from = teHex(a && a.from), to = teHex(a && a.to);
                return (
                    <div key={'a' + i} className="flex items-center gap-1.5 text-[11px] text-fg-muted"
                        title={a && a.bg ? 'On ' + labelOf(a.bg) : undefined}>
                        <MtlxIcon name="info-circle" className="w-3.5 h-3.5 flex-none" />
                        <span className="flex-1 min-w-0 truncate">{labelOf(a && a.fg) + ' adjusted for contrast'}</span>
                        {from && to && (
                            <span className="flex items-center gap-0.5 flex-none" aria-hidden="true">
                                <span className="w-3 h-3 rounded-sm border border-line" style={{ background: from }} />
                                <MtlxIcon name="arrow-right" className="w-3 h-3" />
                                <span className="w-3 h-3 rounded-sm border border-line" style={{ background: to }} />
                            </span>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// Header pill showing the contrast state; hover or click opens the report popover (click pins it).
function TeContrastPill({ report, labelOf, showSeq }) {
    const [hover, setHover] = React.useState(false);
    const [pinned, setPinned] = React.useState(false);
    const wrapRef = React.useRef(null);
    const timer = React.useRef(0);
    const popId = TE_ID + '-contrast-pop';
    const open = hover || pinned;
    React.useEffect(() => () => clearTimeout(timer.current), []);
    React.useEffect(() => { if (showSeq) setPinned(true); }, [showSeq]);
    React.useEffect(() => {
        if (!pinned) return undefined;
        const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) { setPinned(false); setHover(false); } };
        window.addEventListener('pointerdown', onDown);
        return () => window.removeEventListener('pointerdown', onDown);
    }, [pinned]);
    if (!report) return null;
    const n = report.adjusted.length;
    const bad = report.errors.length > 0;
    const enter = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setHover(true), 150); };
    const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setHover(false), 200); };
    const onKeyDown = (e) => {
        if (e.key === 'Escape' && open) { e.stopPropagation(); e.preventDefault(); setPinned(false); setHover(false); }
    };
    const tone = bad
        ? 'bg-warning-bg/30 border-warning-border/60 text-warning-text hover:bg-warning-bg/40'
        : n ? 'bg-hover/40 border-line text-fg-soft hover:bg-hover/60' : 'border-line-subtle text-fg-muted hover:text-fg-soft';
    return (
        <div ref={wrapRef} className="relative flex-none" onMouseEnter={enter} onMouseLeave={leave} onKeyDown={onKeyDown}>
            <button type="button" aria-expanded={open} aria-controls={popId} aria-haspopup="dialog"
                onClick={() => { clearTimeout(timer.current); setPinned((p) => !p); setHover(false); }}
                className={'inline-flex items-center gap-1 h-6 px-2 rounded-full border text-[10px] whitespace-nowrap ' + tone + ' ' + TE_FOCUS}>
                <MtlxIcon name={bad ? 'alert-triangle' : n ? 'info-circle' : 'check'} className="w-3 h-3" />
                {bad ? 'Contrast issue' : n ? n + ' adjusted' : 'Contrast OK'}
            </button>
            {open && (
                <div id={popId} role="dialog" aria-label="Contrast report"
                    className="absolute right-0 top-full pt-1.5 z-10 w-[300px] max-w-[80vw]">
                    <div className="max-h-60 overflow-y-auto custom-scrollbar rounded-lg border border-line-strong bg-surface-raised shadow-2xl px-3 py-2.5">
                        <TeReport report={report} labelOf={labelOf} />
                    </div>
                </div>
            )}
        </div>
    );
}

function TeTokenRow({ token, hex, overridden, onSet, onClear }) {
    return (
        <div className="flex items-center gap-2 py-1">
            <TeSwatch hex={hex} onChange={onSet} title={token.label} />
            <div className="flex-1 min-w-0" title={token.role || undefined}>
                <div className={'text-[11px] truncate ' + (overridden ? 'text-accent-fg-strong' : 'text-fg-soft')}>{token.label}</div>
                <div className="text-[10px] font-mono text-fg-subtle truncate">{token.id}</div>
            </div>
            <span className="text-[10px] font-mono text-fg-muted flex-none">{hex}</span>
            <input
                type="checkbox"
                checked={overridden}
                onChange={(e) => (e.target.checked ? onSet(hex) : onClear())}
                aria-label={'Override ' + token.label}
                title={overridden ? 'Clear override' : 'Override'}
                className={'flex-none accent-accent-base ' + TE_FOCUS}
            />
        </div>
    );
}

function MtlxThemeEditor({ open, openSeq, onClose }) {
    const T = window.MtlxTheme;
    const panelRef = React.useRef(null);
    const fileRef = React.useRef(null);
    const codeRef = React.useRef(null);
    const confirmRef = React.useRef(null);
    const previewActive = React.useRef(false);
    const previewSeq = React.useRef(0);
    const [draft, setDraft] = React.useState(null);
    const [editingId, setEditingId] = React.useState(null);
    const [baseline, setBaseline] = React.useState('');
    const [startFrom, setStartFrom] = React.useState(TE_CURRENT);
    const [report, setReport] = React.useState(null);
    const [groups, setGroups] = React.useState(null);
    const [groupsError, setGroupsError] = React.useState('');
    const [advOpen, setAdvOpen] = React.useState(false);
    const [filter, setFilter] = React.useState('');
    const [status, setStatus] = React.useState(null);
    const [confirm, setConfirm] = React.useState(null);
    const [importOpen, setImportOpen] = React.useState(false);
    const [importText, setImportText] = React.useState('');
    const [importError, setImportError] = React.useState('');
    const [code, setCode] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [listTick, setListTick] = React.useState(0);
    const [liveTick, setLiveTick] = React.useState(0);
    const [showSeq, setShowSeq] = React.useState(0);
    const outsideRef = React.useRef(null);
    const nameEdited = React.useRef(false);

    const apiOk = !!(T && typeof T.previewDraft === 'function' && typeof T.saveCustom === 'function');

    // Token labels for reports and the Advanced list; loaded once, on first open.
    React.useEffect(() => {
        if (!open || groups || !T || typeof T.getTokenGroups !== 'function') return;
        Promise.resolve(T.getTokenGroups()).then(
            (g) => setGroups(Array.isArray(g) ? g : []),
            (e) => { setGroups([]); setGroupsError(teErrText(e, 'Token list unavailable')); });
    }, [open, groups]);
    const labels = React.useMemo(() => {
        const m = {};
        (groups || []).forEach((g) => (g.tokens || []).forEach((t) => { m[t.id] = t.label; }));
        return m;
    }, [groups]);
    const labelOf = (id) => labels[id] || teHumanize(id);

    React.useEffect(() => {
        const bump = () => { setListTick((t) => t + 1); setLiveTick((t) => t + 1); };
        window.addEventListener('mtlx-custom-themes-change', bump);
        const off = T && T.onChange ? T.onChange(() => setLiveTick((t) => t + 1)) : null;
        return () => { window.removeEventListener('mtlx-custom-themes-change', bump); if (off) off(); };
    }, []);

    const resetUi = () => {
        setStatus(null); setConfirm(null); setImportOpen(false); setImportError('');
        setImportText(''); setCode(null); setReport(null);
    };

    const loadEntry = async (entry, asBaseline) => {
        const d = await teDraftFor(entry);
        nameEdited.current = false;
        setDraft(d);
        setEditingId(entry.group === 'custom' && teCustomSpec(entry.id) ? entry.id : null);
        if (asBaseline) setBaseline(teKey(d));
    };

    // Each open starts from what the page currently shows.
    React.useEffect(() => {
        if (!open || !T) return;
        resetUi();
        setStartFrom(TE_CURRENT);
        loadEntry(teCurrentEntry(), true);
    }, [openSeq]);

    const dirty = !!draft && teKey(draft) !== baseline;
    const colorKey = draft ? teColorKey(draft) : '';
    const baseColorKey = baseline ? JSON.parse(baseline)[0] : '';

    const takenIds = () => new Set((T.list() || []).map((e) => e.id));
    const makeSpec = (id, label) => {
        const spec = {
            v: 1,
            id: id || editingId || 'custom:' + teSlug(draft.label),
            label: (label || draft.label || '').trim().slice(0, TE_MAX_LABEL) || 'My theme',
            base: draft.base,
            seeds: Object.assign({}, draft.seeds),
            overrides: Object.assign({}, draft.overrides),
        };
        // Optional in the spec: omitted at the defaults so plain themes keep the short code.
        const m = teMods(draft.modifiers);
        if (m.contrast || m.tint) spec.modifiers = m;
        return spec;
    };

    // Live preview: debounced previewDraft; back to the real theme when the colors match it again.
    React.useEffect(() => {
        if (!open || !draft || !apiOk) return undefined;
        if (colorKey === baseColorKey) {
            previewSeq.current++;
            if (previewActive.current) { T.clearDraft(); previewActive.current = false; setLiveTick((t) => t + 1); }
            setReport(null);
            return undefined;
        }
        const seq = ++previewSeq.current;
        const timer = setTimeout(() => {
            previewActive.current = true;
            Promise.resolve(T.previewDraft(makeSpec())).then(
                (r) => {
                    // A preview that lands after close/save/delete must not stick.
                    if (seq !== previewSeq.current) { if (!previewActive.current) T.clearDraft(); return; }
                    setReport(teNormalizeReport(r));
                    setLiveTick((t) => t + 1);
                },
                (e) => { if (seq === previewSeq.current) setReport({ adjusted: [], errors: [teErrText(e, 'Preview failed')] }); });
        }, TE_PREVIEW_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [open, colorKey, baseColorKey]);

    // A shown theme code describes the draft it was made from; drop it once the draft changes.
    const draftKey = draft ? teKey(draft) : '';
    React.useEffect(() => { setCode(null); }, [draftKey]);

    const close = () => {
        previewSeq.current++;
        if (previewActive.current) { T.clearDraft(); previewActive.current = false; }
        setConfirm(null);
        setDraft(null);
        setBaseline('');
        onClose();
    };
    const requestClose = () => { if (dirty) setConfirm('discard'); else close(); };

    // Escape: cancel a pending confirm, else close (asking first when there are unsaved changes).
    React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
            if (e.key !== 'Escape' || e.defaultPrevented || tePopoverOpen()) return;
            e.preventDefault();
            if (confirm) setConfirm(null);
            else requestClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    // Focus: into the panel on open, kept there (portaled popovers excepted).
    React.useEffect(() => {
        if (!open) return undefined;
        const raf = requestAnimationFrame(() => { if (panelRef.current) panelRef.current.focus(); });
        const onFocusIn = (e) => {
            const p = panelRef.current;
            if (!p || p.contains(e.target) || teInPopover(e.target)) return;
            p.focus();
        };
        document.addEventListener('focusin', onFocusIn);
        return () => { cancelAnimationFrame(raf); document.removeEventListener('focusin', onFocusIn); };
    }, [open, openSeq, !!draft]);
    React.useEffect(() => { if (confirm && confirmRef.current) confirmRef.current.focus(); }, [confirm]);

    const onPanelKeyDown = (e) => {
        const p = panelRef.current;
        if (e.key !== 'Tab' || !p || !p.contains(document.activeElement)) return;
        const items = Array.prototype.filter.call(
            p.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])'),
            (el) => !el.disabled && el.offsetParent !== null && el.getAttribute('tabindex') !== '-1');
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === p)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    const update = (patch) => { setDraft((d) => Object.assign({}, d, patch)); setStatus(null); setCode(null); };
    const setSeed = (key, hex) => setDraft((d) => Object.assign({}, d, { seeds: Object.assign({}, d.seeds, { [key]: hex }) }));
    const setOverride = (id, hex) => setDraft((d) => Object.assign({}, d, { overrides: Object.assign({}, d.overrides, { [id]: hex }) }));
    const setMod = (key, v) => setDraft((d) => Object.assign({}, d, { modifiers: Object.assign(teMods(d.modifiers), { [key]: v }) }));
    const clearOverride = (id) => setDraft((d) => { const o = Object.assign({}, d.overrides); delete o[id]; return Object.assign({}, d, { overrides: o }); });
    const setBase = (base) => setDraft((d) => {
        const D = window.MTLX_THEME_TOKENS || {};
        const old = D.seeds && D.seeds[d.base], next = D.seeds && D.seeds[base];
        const untouched = old && next && TE_SEEDS.every((s) => teHex(old[s.key]) === d.seeds[s.key]);
        const seeds = untouched ? { background: teHex(next.background), foreground: teHex(next.foreground), accent: teHex(next.accent) } : d.seeds;
        return Object.assign({}, d, { base, seeds });
    });

    const onStartFrom = (v) => {
        setStartFrom(v);
        setStatus(null); setCode(null);
        const entry = v === TE_CURRENT ? teCurrentEntry() : teEntries().filter((e) => e.id === v)[0];
        if (entry) loadEntry(entry, false);
    };

    const save = async (asNew) => {
        if (!apiOk || !draft) return false;
        let label = '';
        if (!nameEdited.current && !(editingId && !asNew)) {
            const used = new Set((T.list() || []).map((e) => String(e.label || '').toLowerCase()));
            let n = 1;
            while (used.has(n > 1 ? 'custom theme ' + n : 'custom theme')) n++;
            label = n > 1 ? 'Custom theme ' + n : 'Custom theme';
        }
        const id = !asNew && editingId ? editingId : teUniqueId(label || draft.label, takenIds());
        setBusy(true);
        let res;
        try { res = await T.saveCustom(makeSpec(id, label)); } catch (e) { res = { ok: false, error: teErrText(e, 'Could not save this theme.') }; }
        setBusy(false);
        if (!res || !res.ok) {
            const text = teErrText(res && res.error, 'Could not save this theme.');
            setStatus({ tone: 'error', text });
            return { ok: false, text };
        }
        const saved = res.spec || makeSpec(id, label);
        previewSeq.current++;
        if (previewActive.current) { T.clearDraft(); previewActive.current = false; }
        T.setPreference(saved.id);
        const d = { label: saved.label, base: saved.base, seeds: Object.assign({}, saved.seeds), overrides: Object.assign({}, saved.overrides || {}), modifiers: teMods(saved.modifiers) };
        setDraft(d);
        setEditingId(saved.id);
        setBaseline(teKey(d));
        setStartFrom(TE_CURRENT);
        setReport(null);
        setStatus({ tone: 'ok', text: 'Saved "' + saved.label + '".', adjusted: Array.isArray(res.adjusted) ? res.adjusted : [] });
        return { ok: true };
    };

    // Outside click: close without saving when unchanged, else save then close; a blocked save keeps it open.
    outsideRef.current = async () => {
        if (!draft || busy || confirm || !apiOk) return;
        if (!dirty) { close(); return; }
        if (blocking) { setShowSeq((n) => n + 1); return; }
        const r = await save(false);
        if (r && r.ok) { close(); return; }
        if (r) setReport({ adjusted: [], errors: [r.text] });
        setShowSeq((n) => n + 1);
    };
    React.useEffect(() => {
        if (!open) return undefined;
        let off = null;
        const onDown = (e) => {
            const p = panelRef.current;
            if (!p || p.contains(e.target) || teInPopover(e.target) || tePopoverOpen()) return;
            if (outsideRef.current) outsideRef.current();
        };
        const t = setTimeout(() => { off = true; window.addEventListener('pointerdown', onDown); }, 0);
        return () => { clearTimeout(t); if (off) window.removeEventListener('pointerdown', onDown); };
    }, [open, openSeq]);

    const del = async () => {
        if (!editingId || typeof T.deleteCustom !== 'function') return;
        const label = draft.label;
        setConfirm(null);
        previewSeq.current++;
        if (previewActive.current) { T.clearDraft(); previewActive.current = false; }
        try { await T.deleteCustom(editingId); } catch (e) {
            setStatus({ tone: 'error', text: teErrText(e, 'Could not delete this theme.') });
            return;
        }
        setStartFrom(TE_CURRENT);
        await loadEntry(teCurrentEntry(), true);
        setStatus({ tone: 'ok', text: 'Deleted "' + label + '".' });
    };

    const copyCode = async () => {
        let c;
        try { c = T.encodeTheme(makeSpec()); } catch (e) { setStatus({ tone: 'error', text: teErrText(e, 'Could not encode this theme.') }); return; }
        const ok = typeof copyTextToClipboard === 'function' ? await copyTextToClipboard(c) : false;
        setCode({ text: c, copied: ok });
        if (!ok) requestAnimationFrame(() => { if (codeRef.current) { codeRef.current.focus(); codeRef.current.select(); } });
    };

    const downloadJson = () => {
        const spec = makeSpec();
        const blob = new Blob([JSON.stringify(spec, null, 2) + '\n'], { type: 'application/json' });
        const name = teSlug(spec.label) + '.theme.json';
        if (typeof downloadBlob === 'function') { downloadBlob(blob, name); return; }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };

    // Codes and files are untrusted: everything goes through decodeTheme's strict validation.
    const importFromText = (raw) => {
        const t = String(raw || '').trim();
        if (!t) { setImportError('Paste a theme code or choose a JSON file.'); return; }
        const notTheme = 'That is not a theme code or a theme JSON file.';
        try {
            let spec;
            if (/^mtlx1\./.test(t)) spec = T.decodeTheme(t);
            else {
                let parsed;
                try { parsed = JSON.parse(t); } catch (e) { throw new Error(notTheme); }
                if (typeof parsed === 'string') spec = T.decodeTheme(parsed.trim());
                else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) spec = T.decodeTheme(T.encodeTheme(parsed));
                else throw new Error(notTheme);
            }
            setDraft({ label: spec.label, base: spec.base, seeds: Object.assign({}, spec.seeds), overrides: Object.assign({}, spec.overrides || {}), modifiers: teMods(spec.modifiers) });
            nameEdited.current = true;
            setEditingId(null);
            setStartFrom(null);
            setImportOpen(false); setImportText(''); setImportError(''); setCode(null);
            setStatus({ tone: 'info', text: 'Imported "' + spec.label + '" as a draft. Save to keep it.' });
        } catch (e) {
            setImportError(teErrText(e, notTheme));
        }
    };
    const importFile = (file) => {
        if (!file) return;
        if (file.size > TE_MAX_IMPORT_BYTES) { setImportOpen(true); setImportError('That file is too large to be a theme.'); return; }
        const reader = new FileReader();
        reader.onload = () => { setImportOpen(true); importFromText(String(reader.result || '')); };
        reader.onerror = () => { setImportOpen(true); setImportError('Could not read that file.'); };
        reader.readAsText(file);
    };
    // File drags over the panel are ours: never let them reach a view's page-wide drop handler.
    const hasFiles = (e) => !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0);
    const onDragAny = (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); if (e.type === 'dragover') e.dataTransfer.dropEffect = 'copy'; };
    const onDrop = (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); e.stopPropagation();
        e.nativeEvent.__mtlxHandled = true;
        importFile(e.dataTransfer.files && e.dataTransfer.files[0]);
    };

    // Live token values for the Advanced list (recomputed after each preview or theme change).
    const live = React.useMemo(() => {
        if (!advOpen || !groups) return {};
        const cs = getComputedStyle(document.documentElement);
        const m = {};
        groups.forEach((g) => (g.tokens || []).forEach((t) => { const h = teLiveHex(cs, t.id); if (h) m[t.id] = h; }));
        return m;
    }, [advOpen, groups, liveTick]);

    const startOptions = React.useMemo(() => {
        if (!T) return [];
        const cur = teCurrentEntry();
        return [{ value: TE_CURRENT, label: 'Current theme (' + (cur.label || cur.id) + ')' }].concat(
            teEntries().map((e) => ({ value: e.id, label: e.label, badge: e.group === 'custom' ? 'Custom' : undefined })));
    }, [listTick, liveTick, open]);

    if (!draft) {
        return open ? (
            <div id={TE_ID} className="fixed right-0 bottom-0 z-[55] w-[360px] max-w-full bg-surface-raised border-l border-line"
                style={{ top: 'var(--mtlx-header-h, 0px)' }} />
        ) : null;
    }

    const q = filter.trim().toLowerCase();
    const overrideCount = Object.keys(draft.overrides).length;
    const blocking = !!(report && report.errors.length);
    const micro = (text, id) => <div id={id} className={TE_MICRO + ' mb-2'}>{text}</div>;

    return (
        <div
            ref={panelRef}
            id={TE_ID}
            role="dialog"
            aria-modal="true"
            aria-labelledby={TE_ID + '-title'}
            tabIndex={-1}
            hidden={!open}
            onKeyDown={onPanelKeyDown}
            onDragEnter={onDragAny}
            onDragOver={onDragAny}
            onDragLeave={onDragAny}
            onDrop={onDrop}
            className="fixed right-0 bottom-0 z-[55] w-[360px] max-w-full flex flex-col bg-surface-raised border-l border-line text-fg outline-none"
            style={{ top: 'var(--mtlx-header-h, 0px)', boxShadow: '-12px 0 32px ' + T.rgba('shadow', 0.45), display: open ? undefined : 'none' }}
        >
            {/* Header: title, close, theme name. */}
            <div className="flex-none px-4 pt-3 pb-3 border-b border-line bg-chrome/40">
                <div className="flex items-center gap-2 mb-2.5">
                    <MtlxIcon name="palette" className="w-4 h-4 text-fg-muted" />
                    <h2 id={TE_ID + '-title'} className="flex-1 text-[13px] font-semibold text-fg">Theme editor</h2>
                    <TeContrastPill report={report} labelOf={labelOf} showSeq={showSeq} />
                    <button type="button" onClick={requestClose} title="Close" aria-label="Close theme editor"
                        className={'w-7 h-7 inline-flex items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-hover/60 ' + TE_FOCUS}>
                        <MtlxIcon name="x" className="w-4 h-4" />
                    </button>
                </div>
                <label htmlFor={TE_ID + '-name'} className={TE_MICRO + ' block mb-1'}>Name</label>
                <input
                    id={TE_ID + '-name'}
                    type="text"
                    value={draft.label}
                    maxLength={TE_MAX_LABEL}
                    placeholder="My theme"
                    onChange={(e) => { nameEdited.current = true; update({ label: e.target.value.slice(0, TE_MAX_LABEL) }); }}
                    className={TE_INPUT_CLS}
                />
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-3 space-y-5">
                {!apiOk && (
                    <div className="text-[11px] text-error-text" role="alert">The theme engine is unavailable, so changes cannot be previewed or saved.</div>
                )}

                <section aria-labelledby={TE_ID + '-start'}>
                    {micro('Start from', TE_ID + '-start')}
                    <MtlxSelect
                        value={startFrom}
                        options={startOptions}
                        defValue={null}
                        placeholder="Imported theme"
                        onChange={onStartFrom}
                        ariaLabel="Start from"
                        size="md"
                        variant="field"
                        block
                    />
                </section>

                <section aria-labelledby={TE_ID + '-colors'}>
                    {micro('Colors', TE_ID + '-colors')}
                    <div className="flex items-center justify-between gap-2 mb-3">
                        <span className="text-[12px] text-fg-soft">Base</span>
                        <TeSegmented
                            label="Base"
                            value={draft.base}
                            onChange={setBase}
                            options={[{ value: 'light', label: 'Light', icon: 'sun' }, { value: 'dark', label: 'Dark', icon: 'inner-shadow-bottom-right' }]}
                        />
                    </div>
                    <div className="space-y-2">
                        {TE_SEEDS.map((s) => (
                            <div key={s.key} className="flex items-center gap-2">
                                <TeSwatch hex={draft.seeds[s.key]} onChange={(h) => setSeed(s.key, h)} title={s.label} />
                                <label htmlFor={TE_ID + '-seed-' + s.key} className="flex-1 text-[12px] text-fg-soft">{s.label}</label>
                                <TeHexInput id={TE_ID + '-seed-' + s.key} value={draft.seeds[s.key]} onCommit={(h) => setSeed(s.key, h)} ariaLabel={s.label + ' color, hex'} />
                            </div>
                        ))}
                    </div>
                    <div className="mt-3 space-y-2.5">
                        {TE_MODS.map((m) => (
                            <TeSlider key={m.key} mod={m} value={teMods(draft.modifiers)[m.key]} onChange={(v) => setMod(m.key, v)} />
                        ))}
                    </div>
                    {!report && <div className="mt-3 min-h-[18px] text-[11px] text-fg-subtle">{dirty ? 'Previewing…' : 'Changes preview live on this page.'}</div>}
                </section>

                <section>
                    <button
                        type="button"
                        aria-expanded={advOpen}
                        aria-controls={TE_ID + '-adv'}
                        onClick={() => setAdvOpen((o) => !o)}
                        className={'w-full flex items-center gap-1.5 text-left ' + TE_MICRO + ' hover:text-fg-soft ' + TE_FOCUS}
                    >
                        <MtlxIcon name={advOpen ? 'chevron-down' : 'chevron-right'} className="w-3.5 h-3.5" />
                        <span className="flex-1">Advanced</span>
                        {overrideCount > 0 && <span className="normal-case tracking-normal font-normal text-accent-fg-strong">{overrideCount + (overrideCount === 1 ? ' override' : ' overrides')}</span>}
                    </button>
                    {advOpen && (
                        <div id={TE_ID + '-adv'} className="mt-2">
                            <div className="flex items-center gap-2 mb-2">
                                <div className="relative flex-1">
                                    <MtlxIcon name="search" className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none" />
                                    <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)}
                                        placeholder="Filter tokens" aria-label="Filter tokens" className={TE_INPUT_CLS + ' pl-7'} />
                                </div>
                                <button type="button" className={BTN_SECONDARY} disabled={!overrideCount}
                                    onClick={() => setDraft((d) => Object.assign({}, d, { overrides: {} }))}>Reset all</button>
                            </div>
                            {!groups && <div className="text-[11px] text-fg-subtle">Loading tokens&hellip;</div>}
                            {groupsError && <div className="text-[11px] text-error-text">{groupsError}</div>}
                            {(groups || []).map((g) => {
                                const toks = (g.tokens || []).filter((t) => !q || t.id.toLowerCase().indexOf(q) >= 0 || String(t.label).toLowerCase().indexOf(q) >= 0);
                                if (!toks.length) return null;
                                return (
                                    <div key={g.group} className="mb-3">
                                        <div className={TE_MICRO + ' py-1 border-b border-line-subtle mb-1'}>{g.label || teHumanize(g.group)}</div>
                                        {toks.map((t) => {
                                            const ov = draft.overrides[t.id];
                                            return (
                                                <TeTokenRow
                                                    key={t.id}
                                                    token={t}
                                                    hex={ov || live[t.id] || draft.seeds.background}
                                                    overridden={!!ov}
                                                    onSet={(h) => setOverride(t.id, h)}
                                                    onClear={() => clearOverride(t.id)}
                                                />
                                            );
                                        })}
                                    </div>
                                );
                            })}
                            {groups && q && !groups.some((g) => (g.tokens || []).some((t) => t.id.toLowerCase().indexOf(q) >= 0 || String(t.label).toLowerCase().indexOf(q) >= 0)) && (
                                <div className="text-[11px] text-fg-subtle">No tokens match.</div>
                            )}
                        </div>
                    )}
                </section>
            </div>

            {/* Fixed footer: status, share tools, then the actions or a pending confirmation. */}
            <div className="flex-none border-t border-line px-4 py-3 bg-chrome/40 space-y-2">
                {status && (
                    status.tone === 'ok' && status.adjusted
                        ? <TeReport report={{ adjusted: status.adjusted, errors: [] }} labelOf={labelOf} title={status.text + (status.adjusted.length ? ' Adjusted for contrast:' : ' All colors pass.')} />
                        : <div role={status.tone === 'error' ? 'alert' : 'status'}
                            className={'text-[11px] ' + (status.tone === 'error' ? 'text-error-text' : status.tone === 'ok' ? 'text-success-text' : 'text-fg-muted')}>{status.text}</div>
                )}
                <section role="group" aria-label="Share">
                    <div className="flex flex-wrap gap-1.5">
                        <button type="button" className={BTN_SECONDARY + ' gap-1.5'} onClick={copyCode} disabled={!apiOk}>
                            <MtlxIcon name="copy" className="w-3.5 h-3.5" />Copy theme code
                        </button>
                        <button type="button" className={BTN_SECONDARY + ' gap-1.5'} onClick={downloadJson}>
                            <MtlxIcon name="download" className="w-3.5 h-3.5" />Download JSON
                        </button>
                        <button type="button" className={BTN_SECONDARY + ' gap-1.5'} aria-expanded={importOpen} aria-controls={TE_ID + '-import'}
                            onClick={() => { setImportOpen((o) => !o); setImportError(''); }} disabled={!apiOk}>
                            <MtlxIcon name="file-import" className="w-3.5 h-3.5" />Import
                        </button>
                    </div>
                    {code && (
                        <div className="mt-2">
                            <input ref={codeRef} type="text" readOnly value={code.text} aria-label="Theme code"
                                onFocus={(e) => e.target.select()} className={TE_INPUT_CLS + ' font-mono text-[11px]'} />
                            <div className="mt-1 text-[11px] text-fg-muted" role="status">
                                {code.copied ? 'Copied to clipboard.' : 'Select the code and copy it (Ctrl+C).'}
                            </div>
                        </div>
                    )}
                    {importOpen && (
                        <div id={TE_ID + '-import'} className="mt-2 rounded-md border border-dashed border-line-strong p-2 space-y-1.5">
                            <label htmlFor={TE_ID + '-import-code'} className={TE_MICRO + ' block'}>Theme code</label>
                            <textarea
                                id={TE_ID + '-import-code'}
                                value={importText}
                                maxLength={TE_MAX_CODE_CHARS}
                                rows={2}
                                spellCheck={false}
                                placeholder="mtlx1..."
                                onChange={(e) => { setImportText(e.target.value); setImportError(''); }}
                                className="w-full bg-surface-sunken border border-line-control rounded px-2 py-1.5 text-[11px] font-mono text-fg-soft placeholder-fg-subtle focus:outline-none focus:border-focus resize-none"
                            />
                            <div className="flex flex-wrap items-center gap-2">
                                <button type="button" className={BTN_PRIMARY} onClick={() => importFromText(importText)}>Load code</button>
                                <button type="button" className={BTN_SECONDARY} onClick={() => fileRef.current && fileRef.current.click()}>Choose JSON file</button>
                                <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" tabIndex={-1}
                                    onChange={(e) => { importFile(e.target.files && e.target.files[0]); e.target.value = ''; }} />
                            </div>
                            <div className="text-[11px] text-fg-subtle">Or drop a theme .json file on this panel. Imports open as a draft.</div>
                            {importError && <div className="text-[11px] text-error-text" role="alert">{importError}</div>}
                        </div>
                    )}
                </section>
                {confirm ? (
                    <div className="flex items-center gap-2" role="alertdialog" aria-label={confirm === 'delete' ? 'Confirm delete' : 'Discard changes'}>
                        <span className="flex-1 text-[11px] text-fg-soft">
                            {confirm === 'delete' ? 'Delete "' + draft.label + '"? This cannot be undone.' : 'Discard unsaved changes?'}
                        </span>
                        <button type="button" className={BTN_SECONDARY} onClick={() => setConfirm(null)}>
                            {confirm === 'delete' ? 'Cancel' : 'Keep editing'}
                        </button>
                        <button ref={confirmRef} type="button" className={BTN_PRIMARY} onClick={confirm === 'delete' ? del : close}>
                            {confirm === 'delete' ? 'Delete' : 'Discard'}
                        </button>
                    </div>
                ) : (
                    <div className="flex items-center gap-2">
                        {editingId && (
                            <button type="button" className={BTN_SECONDARY + ' gap-1 hover:text-error-text'} onClick={() => setConfirm('delete')} title="Delete this theme">
                                <MtlxIcon name="trash" className="w-3.5 h-3.5" />Delete
                            </button>
                        )}
                        <span className="flex-1" />
                        <button type="button" className={BTN_SECONDARY} onClick={requestClose}>Cancel</button>
                        {editingId && (
                            <button type="button" className={BTN_SECONDARY} onClick={() => save(true)} disabled={busy || blocking || !apiOk}>Save as new</button>
                        )}
                        <button type="button" className={BTN_PRIMARY + ' disabled:opacity-50 disabled:cursor-not-allowed'} onClick={() => save(false)}
                            disabled={busy || blocking || !apiOk || (!!editingId && !dirty)}>
                            {busy ? 'Saving…' : 'Save'}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

window.MtlxThemeEditor = MtlxThemeEditor;
