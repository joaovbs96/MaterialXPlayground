;(function () {
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
const useElementWidth = ref => {
  const [width, setWidth] = React.useState(0);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(entries => {
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
const EmbedRenderSettings = ({
  keys
}) => {
  const RS = window.MtlxRenderSettings;
  const [, forceTick] = React.useState(0);
  React.useEffect(() => {
    const onChange = () => forceTick(n => n + 1);
    const events = ['mtlx-render-setting', 'mtlx-settings-changed', 'mtlx-display-transform', 'mtlx-display-exposure'];
    events.forEach(ev => window.addEventListener(ev, onChange));
    return () => events.forEach(ev => window.removeEventListener(ev, onChange));
  }, []);
  if (!RS) return null;
  let rows = RS.rowsFor('embed', {
    ui: true
  });
  if (keys) {
    const keySet = new Set(keys);
    rows = rows.filter(row => keySet.has(row.key));
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, rows.map(row => {
    const value = RS.get(row.key, {
      surface: 'embed'
    });
    const onChange = next => RS.apply(row.key, next, {
      surface: 'embed',
      persist: false
    });
    if (row.type === 'bool') {
      return /*#__PURE__*/React.createElement(React.Fragment, {
        key: row.key
      }, /*#__PURE__*/React.createElement("div", {
        className: "mtlx-ec-panel-row"
      }, /*#__PURE__*/React.createElement("span", null, row.label), /*#__PURE__*/React.createElement("button", {
        type: "button",
        className: 'mtlx-ec-toggle' + (value ? ' is-on' : ''),
        onClick: () => onChange(!value),
        title: value ? `Disable ${row.label.toLowerCase()}` : `Enable ${row.label.toLowerCase()}`
      }, value ? 'On' : 'Off')), row.hint && /*#__PURE__*/React.createElement("div", {
        className: "mtlx-ec-desc"
      }, row.hint));
    }
    if (row.type === 'enum' || row.control === 'select') {
      const coerce = row.type === 'enum' ? v => v : Number;
      return /*#__PURE__*/React.createElement("div", {
        className: "mtlx-ec-panel-row",
        key: row.key
      }, /*#__PURE__*/React.createElement("span", null, row.label), /*#__PURE__*/React.createElement("select", {
        className: "mtlx-ec-select",
        value: value,
        onChange: e => onChange(coerce(e.target.value)),
        title: row.hint
      }, row.options.map(opt => /*#__PURE__*/React.createElement("option", {
        key: String(opt),
        value: opt
      }, row.optionLabels && row.optionLabels[opt] || opt))));
    }
    // number
    return /*#__PURE__*/React.createElement("div", {
      className: "mtlx-ec-panel-row mtlx-ec-panel-row--slider",
      key: row.key
    }, /*#__PURE__*/React.createElement("div", {
      className: "mtlx-ec-slider-label"
    }, /*#__PURE__*/React.createElement("span", null, row.label), /*#__PURE__*/React.createElement("span", null, Number(value).toFixed(row.type === 'int' ? 0 : 2), row.unit ? ' ' + row.unit : '')), /*#__PURE__*/React.createElement("input", {
      type: "range",
      min: row.min,
      max: row.max,
      step: row.step || 1,
      value: value,
      onChange: e => onChange(Number(e.target.value))
    }));
  }));
};
const EmbedControls = ({
  containerRef,
  geom,
  geomList,
  onGeomChange,
  showGeom,
  materialList,
  chosenMat,
  onMaterialChange,
  showMaterial,
  rotating,
  onToggleRotating,
  showRotate,
  onCameraReset,
  showReset,
  backdrop,
  onBackdropChange,
  showBackdropPicker,
  showEnv,
  initialEnvRotation,
  initialEnvExposure,
  viewRef,
  viewEpoch,
  onScreenshot,
  showScreenshot,
  onRecord,
  showRecord,
  showSettings,
  isFullscreen,
  onToggleFullscreen,
  showFullscreen
}) => {
  const width = useElementWidth(containerRef);
  const hidden = width > 0 && width < EMBED_CTL_HIDE_BELOW;
  const compact = width > 0 && width < EMBED_CTL_ICON_BELOW;
  const [openPanel, setOpenPanel] = React.useState(null); // null | 'env' | 'settings'
  const [envRotation, setEnvRotationState] = React.useState(() => typeof initialEnvRotation === 'number' ? initialEnvRotation : 0);
  const [envExposure, setEnvExposureState] = React.useState(() => typeof initialEnvExposure === 'number' ? initialEnvExposure : 1.0);
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
  const togglePanel = name => setOpenPanel(p => p === name ? null : name);
  const setEnvRotation = deg => {
    setEnvRotationState(deg);
    const view = viewRef && viewRef.current;
    if (view && view.setEnvRotation) view.setEnvRotation(deg * Math.PI / 180);
  };
  const setEnvExposure = v => {
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
  return /*#__PURE__*/React.createElement("div", {
    className: 'mtlx-ec' + (compact ? ' mtlx-ec--compact' : '')
  }, /*#__PURE__*/React.createElement("div", {
    className: "mtlx-ec-row"
  }, showGeom && /*#__PURE__*/React.createElement("select", {
    className: "mtlx-ec-select",
    value: geom,
    onChange: e => onGeomChange(e.target.value),
    title: "Preview geometry"
  }, geomList.map(g => /*#__PURE__*/React.createElement("option", {
    key: g,
    value: g
  }, window.GEOM_LABELS && window.GEOM_LABELS[g] || g))), showMaterial && /*#__PURE__*/React.createElement("select", {
    className: "mtlx-ec-select",
    value: chosenMat,
    onChange: e => onMaterialChange(Number(e.target.value)),
    title: "Material"
  }, materialList.map((name, i) => /*#__PURE__*/React.createElement("option", {
    key: i,
    value: i
  }, name))), showRotate && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: 'mtlx-ec-btn' + (rotating ? ' is-active' : ''),
    onClick: onToggleRotating,
    title: rotating ? 'Stop the turntable rotation' : 'Start turntable rotation (drag to orbit, wheel to zoom)'
  }, /*#__PURE__*/React.createElement(MtlxIcon, {
    name: "rotate",
    className: "mtlx-ec-icon"
  }), !compact && /*#__PURE__*/React.createElement("span", null, "Rotate")), showReset && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "mtlx-ec-btn",
    onClick: handleReset,
    title: "Reset the camera and any preset environment values"
  }, /*#__PURE__*/React.createElement(MtlxIcon, {
    name: "camera-reset",
    className: "mtlx-ec-icon"
  }), !compact && /*#__PURE__*/React.createElement("span", null, "Reset")), showEnv && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: 'mtlx-ec-btn' + (openPanel === 'env' ? ' is-active' : ''),
    onClick: () => togglePanel('env'),
    title: "Environment"
  }, /*#__PURE__*/React.createElement(MtlxIcon, {
    name: "environment",
    className: "mtlx-ec-icon"
  }), !compact && /*#__PURE__*/React.createElement("span", null, "Environment")), showScreenshot && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "mtlx-ec-btn",
    onClick: onScreenshot,
    title: "Save a PNG preview of the current view"
  }, /*#__PURE__*/React.createElement(MtlxIcon, {
    name: "camera",
    className: "mtlx-ec-icon"
  }), !compact && /*#__PURE__*/React.createElement("span", null, "Screenshot")), showRecord && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "mtlx-ec-btn",
    onClick: onRecord,
    title: "Record a 360\xB0 turntable GIF"
  }, /*#__PURE__*/React.createElement(MtlxIcon, {
    name: "player-record",
    className: "mtlx-ec-icon"
  }), !compact && /*#__PURE__*/React.createElement("span", null, "Record")), showSettings && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: 'mtlx-ec-btn' + (openPanel === 'settings' ? ' is-active' : ''),
    onClick: () => togglePanel('settings'),
    title: "Settings"
  }, /*#__PURE__*/React.createElement(MtlxIcon, {
    name: "settings-cog",
    className: "mtlx-ec-icon"
  }), !compact && /*#__PURE__*/React.createElement("span", null, "Settings")), showFullscreen && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "mtlx-ec-btn",
    onClick: onToggleFullscreen,
    title: isFullscreen ? 'Exit full screen (Esc)' : 'View full screen'
  }, /*#__PURE__*/React.createElement(MtlxIcon, {
    name: "maximize",
    className: "mtlx-ec-icon"
  }), !compact && /*#__PURE__*/React.createElement("span", null, isFullscreen ? 'Exit' : 'Fullscreen'))), openPanel === 'env' && /*#__PURE__*/React.createElement("div", {
    className: "mtlx-ec-panel"
  }, showBackdropPicker && /*#__PURE__*/React.createElement("div", {
    className: "mtlx-ec-panel-row"
  }, /*#__PURE__*/React.createElement("span", null, backdropRow && backdropRow.label || 'Backdrop'), /*#__PURE__*/React.createElement("select", {
    className: "mtlx-ec-select",
    value: backdrop,
    onChange: e => onBackdropChange(e.target.value),
    title: backdropRow && backdropRow.hint || 'Studio: a white room. Environment: the HDRI as background. None: a dark void.'
  }, (backdropRow && backdropRow.options || ['studio', 'environment', 'none']).map(opt => /*#__PURE__*/React.createElement("option", {
    key: opt,
    value: opt
  }, backdropRow && backdropRow.optionLabels && backdropRow.optionLabels[opt] || opt)))), /*#__PURE__*/React.createElement("div", {
    className: "mtlx-ec-panel-row mtlx-ec-panel-row--slider"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mtlx-ec-slider-label"
  }, /*#__PURE__*/React.createElement("span", null, "Rotation"), /*#__PURE__*/React.createElement("span", null, Math.round(envRotation), "\xB0")), /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: "0",
    max: "360",
    step: "1",
    value: envRotation,
    title: "Right click to reset",
    onChange: e => setEnvRotation(Number(e.target.value)),
    onContextMenu: rangeResetOnContextMenu({
      defaultValue: 0,
      min: 0,
      max: 360,
      commit: v => setEnvRotation(Number(v))
    })
  })), /*#__PURE__*/React.createElement("div", {
    className: "mtlx-ec-panel-row mtlx-ec-panel-row--slider"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mtlx-ec-slider-label"
  }, /*#__PURE__*/React.createElement("span", null, "Exposure"), /*#__PURE__*/React.createElement("span", null, formatEv(linearToEv(envExposure)))), /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: EV_MIN,
    max: EV_MAX,
    step: EV_STEP,
    value: linearToEv(envExposure),
    title: "Right click to reset",
    onChange: e => setEnvExposure(evToLinear(e.target.value)),
    onContextMenu: rangeResetOnContextMenu({
      defaultValue: 0,
      min: EV_MIN,
      max: EV_MAX,
      commit: v => setEnvExposure(evToLinear(v))
    })
  })), /*#__PURE__*/React.createElement(EmbedRenderSettings, {
    keys: ['keyLight']
  })), openPanel === 'settings' && /*#__PURE__*/React.createElement("div", {
    className: "mtlx-ec-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mtlx-ec-desc"
  }, "These settings apply to this embed only; none of them persist."), /*#__PURE__*/React.createElement(EmbedRenderSettings, {
    keys: ['displayTransform', 'displayExposure', 'transparency', 'displacement', 'previewSubdivision', 'diffuseEnv']
  })));
};
window.EmbedControls = EmbedControls;
window.EmbedRenderSettings = EmbedRenderSettings;
})();