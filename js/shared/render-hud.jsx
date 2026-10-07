// js/shared/render-hud.jsx: HUD pill popovers and flat sidebar pieces shared by the
// Viewer, Compare and the Scene Viewer. Loaded through VIEW_DEPS only, never by the embed
// (Tailwind utilities below silently no-op there). Exports window.MtlxRenderHud.

// Popovers over the render: opacity is a theme param (0.95 dark, opaque light).
const HUD_POPOVER_BG = 'rgb(var(--mtlx-surface-raised) / var(--mtlx-alpha-hud-popover))';
const HUD_POPOVER_CLASS = 'absolute z-30 top-11 flex flex-col backdrop-blur border border-line-strong rounded-lg shadow-2xl overflow-hidden';
const ROW_LABEL = 'text-[10px] leading-4 font-semibold uppercase tracking-[0.08em] text-fg-subtle';

// One label/value pair, two cells of an info grid, in the Statistics micro-label idiom.
const InfoRow = ({ label, testId, title, children }) => (
    <React.Fragment>
        <span className={ROW_LABEL}>{label}</span>
        <span data-testid={testId} title={title} className="min-w-0 truncate text-right text-[11px] leading-4 text-fg-secondary">{children}</span>
    </React.Fragment>
);

// Title row of a flat sidebar section, in the Statistics header idiom.
const SidebarSectionHeader = ({ icon, title, summary, testId, pill }) => (
    <div data-testid={testId} className="flex items-center gap-2 min-w-0">
        <MtlxIcon name={icon} className="w-4 h-4 text-fg-muted shrink-0" />
        <span className="text-[13px] font-semibold text-fg shrink-0">{title}</span>
        {pill}
        {summary ? <span className="flex-1 min-w-0 text-right text-xs text-fg-subtle truncate" title={summary}>{summary}</span> : null}
    </div>
);

const popoverHeader = (icon, title, subtitle, onClose, tag, mono) => (
    <div className="flex-none flex items-center gap-2 px-3 py-2 border-b border-line">
        <MtlxIcon name={icon} className="w-4 h-4 text-fg-muted shrink-0" />
        <div className="flex-1 min-w-0 flex flex-col">
            <span className="text-[13px] font-semibold text-fg truncate">{title}</span>
            {subtitle ? <span className={'text-[11px] text-fg-subtle truncate' + (mono ? ' font-mono' : '')} title={subtitle}>{subtitle}</span> : null}
        </div>
        {tag ? <span className="shrink-0 text-[9px] uppercase tracking-wide px-1 py-0.5 rounded border border-line-strong text-fg-muted">{tag}</span> : null}
        <button type="button" aria-label="Close" onClick={onClose} className="shrink-0 p-1 rounded text-fg-secondary hover:text-fg hover:bg-hover">
            <MtlxIcon name="x" className="w-3.5 h-3.5" />
        </button>
    </div>
);

// Open state, refs and dismissal (outside press, Escape) of one HUD popover.
const useHudPopover = () => {
    const [open, setOpen] = React.useState(false);
    const btnRef = React.useRef(null);
    const popRef = React.useRef(null);
    const close = React.useCallback(() => setOpen(false), []);
    useEscapeToClose(close, open);
    React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
            if (popRef.current && popRef.current.contains(e.target)) return;
            if (btnRef.current && btnRef.current.contains(e.target)) return;
            setOpen(false);
        };
        window.addEventListener('pointerdown', onDown);
        return () => window.removeEventListener('pointerdown', onDown);
    }, [open]);
    return { open, setOpen, close, toggle: () => setOpen((o) => !o), btnRef, popRef };
};

// Popover under its pill, clamped inside `containerRef` (the viewport box).
const HudPopover = ({ pop, containerRef, width = 320, testId, keepMounted, children }) => {
    if (!pop.open && !keepMounted) return null;
    const pill = pop.btnRef.current;
    const box = containerRef && containerRef.current;
    const wanted = pill ? 8 + pill.offsetLeft : 8;
    const left = box ? Math.max(8, Math.min(wanted, box.clientWidth - width - 8)) : wanted;
    return (
        <div
            ref={pop.popRef}
            data-testid={testId}
            className={(pop.open ? '' : 'hidden ') + HUD_POPOVER_CLASS}
            style={{ left, width: 'min(' + width + 'px, calc(100% - 16px))', maxHeight: 'calc(100% - 56px)', backgroundColor: HUD_POPOVER_BG }}
        >
            {children}
        </div>
    );
};

const QUALITY_SEGMENT_TONES = {
    hud: {
        wrap: 'inline-flex rounded-lg border border-hud-line/50 overflow-hidden',
        idle: 'bg-hud/70 backdrop-blur text-hud-fg hover:bg-hud-hover hover:text-hud-fg-strong',
        active: 'mtlx-fill-accent-translucent text-on-accent border-accent-base',
    },
    panel: {
        wrap: 'flex flex-1 rounded-lg border border-line-strong/50 overflow-hidden',
        idle: 'bg-control/80 text-fg-secondary hover:bg-hover/80',
        active: 'bg-selection/20 text-accent-fg-strong',
    },
};

// Segmented quality control; `levels` is [{ id, label, icon?, title }].
const QualitySegments = ({ levels, value, onChange, disabled, tone, testIdPrefix }) => {
    const cls = QUALITY_SEGMENT_TONES[tone] || QUALITY_SEGMENT_TONES.hud;
    return (
        <div
            role="group"
            aria-label="Render quality"
            data-testid={testIdPrefix + (tone === 'panel' ? '-popover' : '-toolbar')}
            className={cls.wrap}
        >
            {levels.map((level, i) => {
                const active = value === level.id;
                return (
                    <button
                        key={level.id}
                        type="button"
                        data-testid={testIdPrefix + '-' + level.id}
                        data-active={active ? 'true' : undefined}
                        aria-pressed={active}
                        title={level.title}
                        disabled={disabled}
                        onClick={() => onChange(level.id)}
                        className={'h-7 px-2.5 flex items-center gap-1 text-[11px] font-medium whitespace-nowrap transition-colors '
                            + 'first:rounded-l-[7px] last:rounded-r-[7px] disabled:opacity-60 disabled:cursor-not-allowed '
                            + (tone === 'panel' ? 'flex-1 justify-center ' : '')
                            + (i > 0 ? (tone === 'panel' ? 'border-l border-line-strong/50 ' : 'border-l border-hud-line/50 ') : '')
                            + (active ? cls.active : cls.idle)}
                    >
                        {level.icon && <MtlxIcon name={level.icon} className="w-3.5 h-3.5 flex-none" />}
                        {level.label}
                    </button>
                );
            })}
        </div>
    );
};

// Tab row of a popover panel; `labels` maps tab id to its text.
const TabStrip = ({ tabs, labels, value, onChange }) => (
    <div className="flex-none flex items-center gap-1 px-2 pt-2 border-b border-line overflow-x-auto">
        {tabs.map((tab) => (
            <button
                key={tab}
                type="button"
                data-testid={'hud-tab-' + tab}
                onClick={() => onChange(tab)}
                className={'shrink-0 px-2.5 py-1.5 text-[11px] font-medium rounded-t-md border-b-2 whitespace-nowrap '
                    + (value === tab ? 'border-accent-base text-accent-fg-strong' : 'border-transparent text-fg-muted hover:text-fg-soft')}
            >
                {labels[tab]}
            </button>
        ))}
    </div>
);

// Key that changes when a Viewer or Compare view must rebuild: the quality level,
// every level-governed row, and the rows that regenerate shaders.
const useRenderRebuildKey = (surface) => {
    const RS = window.MtlxRenderSettings;
    const compute = () => {
        if (!RS) return '';
        const rows = RS.ROWS.filter((r) => {
            const P = r.profiles[RS.PROFILE_OF[surface]];
            if (!P || r.surfaces[surface] !== 'yes') return false;
            const lv = P.levels;
            const governed = !!lv && RS.LEVELS.some((l) => JSON.stringify(lv[l] !== undefined ? lv[l] : lv.default) !== JSON.stringify(lv.default));
            return governed || r.apply === 'regenerate';
        });
        return RS.getLevel(surface) + '|' + rows.map((r) => JSON.stringify(RS.get(r.key, { surface }))).join('|');
    };
    const [key, setKey] = React.useState(compute);
    React.useEffect(() => {
        const on = () => setKey(compute());
        window.addEventListener('mtlx-render-setting', on);
        window.addEventListener('mtlx-render-level', on);
        return () => {
            window.removeEventListener('mtlx-render-setting', on);
            window.removeEventListener('mtlx-render-level', on);
        };
    }, []);
    return key;
};

// Viewer and Compare presets: Performance stays an internal level for docs, graph and embeds.
const PREVIEW_QUALITY_LEVELS = [
    { id: 'default', label: 'Default', title: 'Balanced for everyday viewing' },
    { id: 'quality', label: 'Quality', icon: 'sparkles', title: 'Highest settings, slower to build and draw' },
];
// Rows that live in the Environment popover or the sidebar, so the tabs skip them.
const HUD_TAB_EXCLUDE = ['keyLight', 'diffuseEnv', 'envRotation', 'envExposure', 'backdrop', 'geometry'];

// The Environment and Render settings pills (top-left HUD row) with their popovers, for the
// Viewer and Compare. `env` carries the per-view environment state and its setters.
const EnvRenderPills = ({ surface, containerRef, showLabels = true, leading, env, backdropDisabled, backdropTitle }) => {
    const RS = window.MtlxRenderSettings;
    const envPop = useHudPopover();
    const renderPop = useHudPopover();
    const [tab, setTab] = React.useState('display');
    const [level, setLevel] = React.useState(() => RS.getLevel(surface));
    React.useEffect(() => {
        const on = (e) => { if (e.detail && e.detail.surface === surface) setLevel(e.detail.level); };
        window.addEventListener('mtlx-render-level', on);
        return () => window.removeEventListener('mtlx-render-level', on);
    }, [surface]);
    const toggleEnv = () => { renderPop.close(); envPop.toggle(); };
    const toggleRender = () => { envPop.close(); renderPop.toggle(); };
    const meta = (key) => rowMeta(key, surface) || {};
    const rows = RS.rowsFor(surface, { ui: true }).filter((r) => HUD_TAB_EXCLUDE.indexOf(r.key) === -1);
    const tabs = Object.keys(RS.GROUPS).filter((g) => rows.some((r) => r.group === g));
    const activeTab = tabs.indexOf(tab) === -1 ? tabs[0] : tab;
    const tabLabels = {};
    Object.keys(RS.GROUPS).forEach((g) => { tabLabels[g] = RS.GROUPS[g].label; });
    const qualityGain = RS.ROWS.filter((r) => {
        const P = r.profiles[RS.PROFILE_OF[surface]];
        return P && P.levels && r.surfaces[surface] === 'yes' && JSON.stringify(P.levels.quality) !== JSON.stringify(P.levels.default);
    }).map((r) => RS.rowUi(r, surface).label);
    const quality = PREVIEW_QUALITY_LEVELS.some((l) => l.id === level) ? level : null;
    const envSummary = [env.fileName || 'Default environment',
        (env.rotation !== 0 || env.exposure !== 1) ? Math.round(env.rotation) + '°, ' + formatEv(linearToEv(env.exposure)) : ''].filter(Boolean).join(', ');
    const pill = (pop, icon, label, onClick, testId) => (
        <button
            type="button" ref={pop.btnRef} data-testid={testId} title={label} aria-label={label} aria-expanded={pop.open}
            onClick={onClick} className={pop.open ? HUD_PILL_ACTIVE : HUD_PILL}
        >
            <MtlxIcon name={icon} className="w-4 h-4" />
            {showLabels && <span>{label}</span>}
        </button>
    );
    return (
        <React.Fragment>
            <div className="absolute top-2 left-2 z-30 flex items-center gap-2.5 flex-wrap max-w-[calc(100%-5rem)]">
                {leading}
                {pill(envPop, 'sun', 'Environment', toggleEnv, 'hud-env-pill')}
                {pill(renderPop, 'settings-cog', 'Render settings', toggleRender, 'hud-render-pill')}
            </div>
            <HudPopover pop={envPop} containerRef={containerRef} testId="hud-env-popover">
                {popoverHeader('sun', 'Environment', envSummary, envPop.close)}
                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 space-y-3">
                    <FilePickerField
                        value={env.fileName} placeholder="Default environment" accept=".hdr,.exr" icon="file"
                        onFiles={(files) => { if (files && files[0]) env.onFile(files[0]); }}
                        onClear={env.onClear}
                    />
                    {env.error && <div className="text-xs text-error">{env.error}</div>}
                    <SliderField
                        label={meta('envRotation').label || 'Environment rotation'} unit={meta('envRotation').unit || 'deg'}
                        value={env.rotation} min={0} max={360} step={1} defaultValue={0}
                        onSlider={(v) => env.onRotation(Number(v))} onNumber={(v) => env.onRotation(Number(v))}
                    />
                    <SliderField
                        label={meta('envExposure').label || 'Environment exposure'} unit={meta('envExposure').unit || 'EV'}
                        value={linearToEv(env.exposure)} min={EV_MIN} max={EV_MAX} step={EV_STEP} defaultValue={0}
                        onSlider={(v) => env.onExposure(evToLinear(v))} onNumber={(v) => env.onExposure(evToLinear(v))}
                    />
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-fg-secondary">{meta('backdrop').label || 'Backdrop'}</span>
                        <MtlxSelect
                            value={env.backdrop} options={meta('backdrop').options || []} labels={meta('backdrop').optionLabels || {}}
                            onChange={env.onBackdrop} defValue="studio" disabled={backdropDisabled}
                            title={backdropDisabled ? backdropTitle : meta('backdrop').hint} size="sm"
                        />
                    </div>
                    <RenderSettingsSection surface={surface} keys={['keyLight', 'diffuseEnv']} variant="popover" labelClassName="text-xs font-medium text-fg-secondary" />
                    <button
                        type="button" data-testid="hud-env-reset" onClick={env.onReset}
                        title="Also clears an imported .hdr/.exr and restores the default environment"
                        className={BTN_SECONDARY + ' w-full'}
                    >Reset</button>
                </div>
            </HudPopover>
            <HudPopover pop={renderPop} containerRef={containerRef} width={480} testId="hud-render-popover" keepMounted>
                <div className="flex-none px-3 py-2 border-b border-line">
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-fg-secondary">Preset</span>
                        <QualitySegments tone="panel" levels={PREVIEW_QUALITY_LEVELS} value={quality} testIdPrefix={surface + '-quality'}
                            onChange={(id) => RS.setLevel(surface, id)} />
                    </div>
                    {qualityGain.length ? <div className="mt-1 text-[11px] text-fg-muted">{'Quality also turns on: ' + qualityGain.join(', ') + '.'}</div> : null}
                </div>
                <TabStrip tabs={tabs} labels={tabLabels} value={activeTab} onChange={setTab} />
                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 space-y-1">
                    <RenderSettingsSection surface={surface} groups={[activeTab]} exclude={HUD_TAB_EXCLUDE} variant="panel" />
                </div>
            </HudPopover>
        </React.Fragment>
    );
};

window.MtlxRenderHud = {
    HUD_POPOVER_BG, HUD_POPOVER_CLASS, ROW_LABEL, InfoRow, SidebarSectionHeader,
    popoverHeader, useHudPopover, HudPopover, QualitySegments, TabStrip,
    useRenderRebuildKey, EnvRenderPills, PREVIEW_QUALITY_LEVELS,
};
