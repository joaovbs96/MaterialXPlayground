// js/embed-controls.jsx: compact, portal-free HUD strip for embed/viewer.html.
// Replaces ViewportControls/MtlxSelect/EnvDialog/SettingsDialog (js/shared/
// mtlx-ui.jsx) in chromeless mode; same public `controls` names, own CSS.

// Below EMBED_CTL_ICON_BELOW: icons only, no labels. Below
// EMBED_CTL_HIDE_BELOW: no strip at all (a strip that doesn't fit is
// worse than none). Keeps all eight controls usable down to 200px wide.
const EMBED_CTL_HIDE_BELOW = 150;
const EMBED_CTL_ICON_BELOW = 480;

// Tracks a DOM node's border-box width via ResizeObserver. Plain
// useEffect, not useLayoutEffect: `ref` is an ancestor's, and its host
// ref attaches only after our own layout effects already ran.
const useElementWidth = (ref) => {
    const [width, setWidth] = React.useState(0);
    React.useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        setWidth(el.getBoundingClientRect().width);
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) setWidth(entry.contentRect.width);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref]);
    return width;
};

// Manifest entries per 'embed' surface rendered with native <select>/<button>.
// Writes use MtlxRenderSettings.apply(persist:false) so picks never touch
// shared per-origin localStorage; `keys` renders an explicit subset.
const EmbedRenderSettings = ({ keys }) => {
    const RS = window.MtlxRenderSettings;
    const [, forceTick] = React.useState(0);
    React.useEffect(() => {
        const onChange = () => forceTick((n) => n + 1);
        const events = ['mtlx-render-setting', 'mtlx-settings-changed', 'mtlx-display-transform', 'mtlx-display-exposure'];
        events.forEach((ev) => window.addEventListener(ev, onChange));
        return () => events.forEach((ev) => window.removeEventListener(ev, onChange));
    }, []);
    if (!RS) return null;
    let rows = RS.rowsFor('embed', { ui: true });
    if (keys) {
        const keySet = new Set(keys);
        rows = rows.filter((row) => keySet.has(row.key));
    }
    return (
        <React.Fragment>
            {rows.map((row) => {
                const value = RS.get(row.key, { surface: 'embed' });
                const onChange = (next) => RS.apply(row.key, next, { surface: 'embed', persist: false });
                if (row.type === 'bool') {
                    return (
                        <React.Fragment key={row.key}>
                            <div className="mtlx-ec-panel-row">
                                <span>{row.label}</span>
                                <button
                                    type="button"
                                    className={'mtlx-ec-toggle' + (value ? ' is-on' : '')}
                                    onClick={() => onChange(!value)}
                                    title={value ? `Disable ${row.label.toLowerCase()}` : `Enable ${row.label.toLowerCase()}`}
                                >
                                    {value ? 'On' : 'Off'}
                                </button>
                            </div>
                            {row.hint && <div className="mtlx-ec-desc">{row.hint}</div>}
                        </React.Fragment>
                    );
                }
                if (row.type === 'enum' || row.control === 'select') {
                    const coerce = row.type === 'enum' ? (v) => v : Number;
                    return (
                        <div className="mtlx-ec-panel-row" key={row.key}>
                            <span>{row.label}</span>
                            <select
                                className="mtlx-ec-select"
                                value={value}
                                onChange={(e) => onChange(coerce(e.target.value))}
                                title={row.hint}
                            >
                                {row.options.map((opt) => (
                                    <option key={String(opt)} value={opt}>{(row.optionLabels && row.optionLabels[opt]) || opt}</option>
                                ))}
                            </select>
                        </div>
                    );
                }
                // number
                return (
                    <div className="mtlx-ec-panel-row mtlx-ec-panel-row--slider" key={row.key}>
                        <div className="mtlx-ec-slider-label">
                            <span>{row.label}</span>
                            <span>{Number(value).toFixed(row.type === 'int' ? 0 : 2)}{row.unit ? ' ' + row.unit : ''}</span>
                        </div>
                        <input
                            type="range" min={row.min} max={row.max} step={row.step || 1}
                            value={value}
                            onChange={(e) => onChange(Number(e.target.value))}
                        />
                    </div>
                );
            })}
        </React.Fragment>
    );
};

const EmbedControls = ({
    containerRef,
    geom, geomList, onGeomChange, showGeom,
    materialList, chosenMat, onMaterialChange, showMaterial,
    rotating, onToggleRotating, showRotate,
    onCameraReset, showReset,
    backdrop, onBackdropChange, showBackdropPicker, showEnv,
    initialEnvRotation, initialEnvExposure,
    viewRef, viewEpoch,
    onScreenshot, showScreenshot,
    onRecord, showRecord,
    showSettings,
    isFullscreen, onToggleFullscreen, showFullscreen,
}) => {
    const width = useElementWidth(containerRef);
    const hidden = width > 0 && width < EMBED_CTL_HIDE_BELOW;
    const compact = width > 0 && width < EMBED_CTL_ICON_BELOW;

    const [openPanel, setOpenPanel] = React.useState(null); // null | 'env' | 'settings'
    const [envRotation, setEnvRotationState] = React.useState(
        () => (typeof initialEnvRotation === 'number' ? initialEnvRotation : 0));
    const [envExposure, setEnvExposureState] = React.useState(
        () => (typeof initialEnvExposure === 'number' ? initialEnvExposure : 1.0));
    // Backdrop options/labels come from manifest so no second list is needed;
    // value stays the caller's real per-view state via backdrop/onBackdropChange.
    const backdropRow = rowMeta('backdrop', 'embed');

    // Re-apply rotation/exposure whenever the view is rebuilt (geometry or
    // material change), mirroring ViewportControls' identical effect.
    React.useEffect(() => {
        const view = viewRef && viewRef.current;
        if (!view) return;
        if (view.setEnvRotation) view.setEnvRotation(envRotation * Math.PI / 180);
        if (view.setEnvExposure) view.setEnvExposure(envExposure);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewEpoch]);

    useEscapeToClose(() => setOpenPanel(null), openPanel !== null);

    if (hidden) return null;

    const togglePanel = (name) => setOpenPanel((p) => (p === name ? null : name));

    const setEnvRotation = (deg) => {
        setEnvRotationState(deg);
        const view = viewRef && viewRef.current;
        if (view && view.setEnvRotation) view.setEnvRotation(deg * Math.PI / 180);
    };
    const setEnvExposure = (v) => {
        setEnvExposureState(v);
        const view = viewRef && viewRef.current;
        if (view && view.setEnvExposure) view.setEnvExposure(v);
    };

    // Reset camera and, if the host provided preset env values, restore
    // those too. Without host-provided values, behavior is camera-only.
    const handleReset = () => {
        onCameraReset();
        if (typeof initialEnvRotation === 'number') setEnvRotation(initialEnvRotation);
        if (typeof initialEnvExposure === 'number') setEnvExposure(initialEnvExposure);
    };

    return (
        <div className={'mtlx-ec' + (compact ? ' mtlx-ec--compact' : '')}>
            <div className="mtlx-ec-row">
                {showGeom && (
                    <select
                        className="mtlx-ec-select"
                        value={geom}
                        onChange={(e) => onGeomChange(e.target.value)}
                        title="Preview geometry"
                    >
                        {geomList.map((g) => (
                            <option key={g} value={g}>{(window.GEOM_LABELS && window.GEOM_LABELS[g]) || g}</option>
                        ))}
                    </select>
                )}
                {showMaterial && (
                    <select
                        className="mtlx-ec-select"
                        value={chosenMat}
                        onChange={(e) => onMaterialChange(Number(e.target.value))}
                        title="Material"
                    >
                        {materialList.map((name, i) => (
                            <option key={i} value={i}>{name}</option>
                        ))}
                    </select>
                )}
                {showRotate && (
                    <button
                        type="button"
                        className={'mtlx-ec-btn' + (rotating ? ' is-active' : '')}
                        onClick={onToggleRotating}
                        title={rotating ? 'Stop the turntable rotation' : 'Start turntable rotation (drag to orbit, wheel to zoom)'}
                    >
                        <MtlxIcon name="rotate" className="mtlx-ec-icon" />
                        {!compact && <span>Rotate</span>}
                    </button>
                )}
                {showReset && (
                    <button
                        type="button"
                        className="mtlx-ec-btn"
                        onClick={handleReset}
                        title="Reset the camera and any preset environment values"
                    >
                        <MtlxIcon name="camera-reset" className="mtlx-ec-icon" />
                        {!compact && <span>Reset</span>}
                    </button>
                )}
                {showEnv && (
                    <button
                        type="button"
                        className={'mtlx-ec-btn' + (openPanel === 'env' ? ' is-active' : '')}
                        onClick={() => togglePanel('env')}
                        title="Environment"
                    >
                        <MtlxIcon name="environment" className="mtlx-ec-icon" />
                        {!compact && <span>Environment</span>}
                    </button>
                )}
                {showScreenshot && (
                    <button type="button" className="mtlx-ec-btn" onClick={onScreenshot} title="Save a PNG preview of the current view">
                        <MtlxIcon name="camera" className="mtlx-ec-icon" />
                        {!compact && <span>Screenshot</span>}
                    </button>
                )}
                {showRecord && (
                    <button type="button" className="mtlx-ec-btn" onClick={onRecord} title="Record a 360° turntable GIF">
                        <MtlxIcon name="player-record" className="mtlx-ec-icon" />
                        {!compact && <span>Record</span>}
                    </button>
                )}
                {showSettings && (
                    <button
                        type="button"
                        className={'mtlx-ec-btn' + (openPanel === 'settings' ? ' is-active' : '')}
                        onClick={() => togglePanel('settings')}
                        title="Settings"
                    >
                        <MtlxIcon name="settings-cog" className="mtlx-ec-icon" />
                        {!compact && <span>Settings</span>}
                    </button>
                )}
                {showFullscreen && (
                    <button
                        type="button"
                        className="mtlx-ec-btn"
                        onClick={onToggleFullscreen}
                        title={isFullscreen ? 'Exit full screen (Esc)' : 'View full screen'}
                    >
                        <MtlxIcon name="maximize" className="mtlx-ec-icon" />
                        {!compact && <span>{isFullscreen ? 'Exit' : 'Fullscreen'}</span>}
                    </button>
                )}
            </div>
            {openPanel === 'env' && (
                <div className="mtlx-ec-panel">
                    {showBackdropPicker && (
                        <div className="mtlx-ec-panel-row">
                            <span>{(backdropRow && backdropRow.label) || 'Backdrop'}</span>
                            <select
                                className="mtlx-ec-select"
                                value={backdrop}
                                onChange={(e) => onBackdropChange(e.target.value)}
                                title={(backdropRow && backdropRow.hint) || 'Studio: a white room. Environment: the HDRI as background. None: a dark void.'}
                            >
                                {((backdropRow && backdropRow.options) || ['studio', 'environment', 'none']).map((opt) => (
                                    <option key={opt} value={opt}>{(backdropRow && backdropRow.optionLabels && backdropRow.optionLabels[opt]) || opt}</option>
                                ))}
                            </select>
                        </div>
                    )}
                    <div className="mtlx-ec-panel-row mtlx-ec-panel-row--slider">
                        <div className="mtlx-ec-slider-label">
                            <span>Rotation</span>
                            <span>{Math.round(envRotation)}°</span>
                        </div>
                        <input
                            type="range" min="0" max="360" step="1"
                            value={envRotation}
                            title="Right click to reset"
                            onChange={(e) => setEnvRotation(Number(e.target.value))}
                            onContextMenu={rangeResetOnContextMenu({ defaultValue: 0, min: 0, max: 360, commit: (v) => setEnvRotation(Number(v)) })}
                        />
                    </div>
                    <div className="mtlx-ec-panel-row mtlx-ec-panel-row--slider">
                        <div className="mtlx-ec-slider-label">
                            <span>Exposure</span>
                            <span>{formatEv(linearToEv(envExposure))}</span>
                        </div>
                        <input
                            type="range" min={EV_MIN} max={EV_MAX} step={EV_STEP}
                            value={linearToEv(envExposure)}
                            title="Right click to reset"
                            onChange={(e) => setEnvExposure(evToLinear(e.target.value))}
                            onContextMenu={rangeResetOnContextMenu({ defaultValue: 0, min: EV_MIN, max: EV_MAX, commit: (v) => setEnvExposure(evToLinear(v)) })}
                        />
                    </div>
                    {/* New: key light is a true engine-wide global (unlike
                        backdrop/rotation/exposure above), so it round-trips
                        through the manifest store safely. */}
                    <EmbedRenderSettings keys={['keyLight']} />
                </div>
            )}
            {openPanel === 'settings' && (
                <div className="mtlx-ec-panel">
                    <div className="mtlx-ec-desc">
                        These settings apply to this embed only; none of them persist.
                    </div>
                    <EmbedRenderSettings keys={['displayTransform', 'displayExposure', 'transparency', 'displacement', 'previewSubdivision', 'diffuseEnv']} />
                </div>
            )}
        </div>
    );
};

window.EmbedControls = EmbedControls;
window.EmbedRenderSettings = EmbedRenderSettings;
