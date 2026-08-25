;(function () {
// js/embed-controls.jsx: compact, portal-free HUD strip for embed/viewer.html.
// Replaces ViewportControls/MtlxSelect/EnvDialog/SettingsDialog (js/shared/
// mtlx-ui.jsx) in chromeless mode; same public `controls` names, own CSS.

// Below EMBED_CTL_ICON_BELOW: icons only, no labels. Below
// EMBED_CTL_HIDE_BELOW: no strip at all (a strip that doesn't fit is
// worse than none). Keeps all seven controls usable down to 200px wide.
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
  const [forceT, setForceT] = React.useState(() => !!(window.getForceTransparency && window.getForceTransparency()));
  const [displayTransform, setDisplayTransformState] = React.useState(() => window.getDisplayTransform ? window.getDisplayTransform() : 'srgb');

  // Adopts a display transform change made elsewhere (e.g. this same
  // embed reloaded in another tab sharing localStorage), same event
  // viewer-app.jsx/compare-app.jsx already listen for.
  React.useEffect(() => {
    const onDisplayTransform = () => {
      if (window.getDisplayTransform) setDisplayTransformState(window.getDisplayTransform());
    };
    window.addEventListener('mtlx-display-transform', onDisplayTransform);
    return () => window.removeEventListener('mtlx-display-transform', onDisplayTransform);
  }, []);

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
  const toggleForceTransparency = () => {
    const next = !forceT;
    setForceT(next);
    if (window.setForceTransparency) window.setForceTransparency(next);
  };
  const pickDisplayTransform = mode => {
    setDisplayTransformState(mode);
    if (window.setDisplayTransform) window.setDisplayTransform(mode);
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
  }), !compact && /*#__PURE__*/React.createElement("span", null, "Screenshot")), showSettings && /*#__PURE__*/React.createElement("button", {
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
  }, /*#__PURE__*/React.createElement("span", null, "Backdrop"), /*#__PURE__*/React.createElement("select", {
    className: "mtlx-ec-select",
    value: backdrop,
    onChange: e => onBackdropChange(e.target.value),
    title: "Studio: a white room. Environment: the HDRI as background. None: a dark void."
  }, /*#__PURE__*/React.createElement("option", {
    value: "studio"
  }, "Studio"), /*#__PURE__*/React.createElement("option", {
    value: "environment"
  }, "Environment"), /*#__PURE__*/React.createElement("option", {
    value: "none"
  }, "None"))), /*#__PURE__*/React.createElement("div", {
    className: "mtlx-ec-panel-row mtlx-ec-panel-row--slider"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mtlx-ec-slider-label"
  }, /*#__PURE__*/React.createElement("span", null, "Rotation"), /*#__PURE__*/React.createElement("span", null, Math.round(envRotation), "\xB0")), /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: "0",
    max: "360",
    step: "1",
    value: envRotation,
    onChange: e => setEnvRotation(Number(e.target.value))
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
    onChange: e => setEnvExposure(evToLinear(e.target.value))
  }))), openPanel === 'settings' && /*#__PURE__*/React.createElement("div", {
    className: "mtlx-ec-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mtlx-ec-panel-row"
  }, /*#__PURE__*/React.createElement("span", null, "View Transform"), /*#__PURE__*/React.createElement("select", {
    className: "mtlx-ec-select",
    value: displayTransform,
    onChange: e => pickDisplayTransform(e.target.value),
    title: "How the linear render is encoded for display. sRGB matches the official MaterialX viewer (no tone mapping)."
  }, /*#__PURE__*/React.createElement("option", {
    value: "srgb"
  }, "sRGB"), /*#__PURE__*/React.createElement("option", {
    value: "aces"
  }, "ACES"), /*#__PURE__*/React.createElement("option", {
    value: "lin_rec709"
  }, "lin_rec709"))), /*#__PURE__*/React.createElement("div", {
    className: "mtlx-ec-panel-row"
  }, /*#__PURE__*/React.createElement("span", null, "Force Transparency"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: 'mtlx-ec-toggle' + (forceT ? ' is-on' : ''),
    onClick: toggleForceTransparency,
    title: forceT ? 'Disable forced transparency' : 'Enable forced transparency'
  }, forceT ? 'On' : 'Off')), /*#__PURE__*/React.createElement("div", {
    className: "mtlx-ec-desc"
  }, "Render opacity/transmission with real alpha blending. When off, the preview matches the standard MaterialX viewer (opaque).")));
};
window.EmbedControls = EmbedControls;
})();