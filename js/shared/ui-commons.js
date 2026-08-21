// ------------------------------------------------------------------
// Shared UI commons (icon registry) — Tabler outline path data keyed
// by name, consumed everywhere via window.MtlxIcon. Loaded eagerly as
// a plain script before the engine so every later script can use it.
// site-header.js deliberately keeps its own tiny separate copies
// since it runs before React loads.
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Tabler icons (https://tabler.io/icons, MIT), inlined for currentColor;
// no extra asset files to deploy. `filled` picks fill vs stroke; `inner`
// is the path markup with the 24x24 placeholder rect already stripped.
// ------------------------------------------------------------------
const MTLX_ICON_PATHS = {
    'file-upload': { filled: true, inner: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /><path d="M2 6c0 -.796 .316 -1.558 .879 -2.121c.563 -.563 1.325 -.879 2.121 -.879h4l.099 .005c.229 .023 .444 .124 .608 .288l2.707 2.707h6.586c.796 0 1.558 .316 2.121 .879c.319 .319 .559 .703 .707 1.121l-14.523 0c-.407 0 -.805 .125 -1.14 .356c-.292 .203 -.525 .48 -.674 .801l-.058 .141l-1.379 3.676c-.194 .517 .068 1.093 .585 1.287c.517 .194 1.094 -.068 1.288 -.585l1.134 -3.027c.146 -.39 .519 -.649 .937 -.649h13.002l.217 .012c.216 .024 .426 .082 .624 .173c.054 .025 .107 .053 .159 .083c.199 .115 .377 .263 .525 .439c.188 .222 .325 .482 .403 .762c.077 .28 .092 .573 .045 .859c-.001 .008 -.003 .016 -.005 .024l-.995 5.21c-.131 .686 -.497 1.304 -1.036 1.749c-.47 .389 -1.046 .624 -1.65 .677l-.261 .012h-14.026c-.796 0 -1.558 -.316 -2.121 -.879c-.563 -.563 -.879 -1.325 -.879 -2.121v-11z" />' },
    'rotate': { filled: false, inner: '<path d="M19.95 11a8 8 0 1 0 -.5 4m.5 5v-5h-5"/>' },
    'restore': { filled: false, inner: '<path d="M4 4v5h5"/><path d="M4.05 13a8 8 0 1 0 2.12 -6.74l-2.17 1.74"/><path d="M12 9v3l1.5 1.5"/>' },
    'environment': { filled: false, inner: '<path d="M15 8h.01"/><path d="M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12"/><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5"/><path d="M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3"/>' },
    'environment-off': { filled: false, inner: '<path d="M15 8h.01"/><path d="M7 3h11a3 3 0 0 1 3 3v11m-.856 3.099a2.991 2.991 0 0 1 -2.144 .901h-12a3 3 0 0 1 -3 -3v-12c0 -.845 .349 -1.608 .91 -2.153"/><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5"/><path d="M16.33 12.338c.574 -.054 1.155 .166 1.67 .662l3 3"/><path d="M3 3l18 18"/>' },
    'camera': { filled: true, inner: '<path d="M15 3a2 2 0 0 1 1.995 1.85l.005 .15a1 1 0 0 0 .883 .993l.117 .007h1a3 3 0 0 1 2.995 2.824l.005 .176v9a3 3 0 0 1 -2.824 2.995l-.176 .005h-14a3 3 0 0 1 -2.995 -2.824l-.005 -.176v-9a3 3 0 0 1 2.824 -2.995l.176 -.005h1a1 1 0 0 0 1 -1a2 2 0 0 1 1.85 -1.995l.15 -.005h6zm-3 7a3 3 0 0 0 -2.985 2.698l-.011 .152l-.004 .15l.004 .15a3 3 0 1 0 2.996 -3.15z"/>' },
    'maximize': { filled: false, inner: '<path d="M4 8v-2a2 2 0 0 1 2 -2h2"/><path d="M4 16v2a2 2 0 0 0 2 2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M16 20h2a2 2 0 0 0 2 -2v-2"/>' },
    'zoom-in': { filled: false, inner: '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M7 10l6 0"/><path d="M10 7l0 6"/><path d="M21 21l-6 -6"/>' },
    'zoom-out': { filled: false, inner: '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M7 10l6 0"/><path d="M21 21l-6 -6"/>' },
    'zoom-in-area': { filled: false, inner: '<path d="M15 13v4"/><path d="M13 15h4"/><path d="M10 15a5 5 0 1 0 10 0a5 5 0 1 0 -10 0"/><path d="M22 22l-3 -3"/><path d="M6 18h-1a2 2 0 0 1 -2 -2v-1"/><path d="M3 11v-1"/><path d="M3 6v-1a2 2 0 0 1 2 -2h1"/><path d="M10 3h1"/><path d="M15 3h1a2 2 0 0 1 2 2v1"/>' },
    'code': { filled: false, inner: '<path d="M7 8l-4 4l4 4"/><path d="M17 8l4 4l-4 4"/><path d="M14 4l-4 16"/>' },
    'share': { filled: false, inner: '<path d="M3 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M15 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M15 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M8.7 10.7l6.6 -3.4"/><path d="M8.7 13.3l6.6 3.4"/>' },
    'compare': { filled: false, inner: '<path d="M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M12 4l0 16"/>' },
    'transfer': { filled: false, inner: '<path d="M20 10h-16l5.5 -6" /><path d="M4 14h16l-5.5 6" />' },
    'switch-horizontal': { filled: false, inner: '<path d="M16 3l4 4l-4 4"/><path d="M10 7l10 0"/><path d="M8 13l-4 4l4 4"/><path d="M4 17l10 0"/>' },
    'reorder': { filled: false, inner: '<path d="M3 16a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -2"/><path d="M10 16a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -2"/><path d="M17 16a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -2"/><path d="M5 11v-3a3 3 0 0 1 3 -3h8a3 3 0 0 1 3 3v3"/><path d="M16.5 8.5l2.5 2.5l2.5 -2.5"/>' },
    'trash': { filled: false, inner: '<path d="M4 7l16 0" /><path d="M10 11l0 6" /><path d="M14 11l0 6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" /><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" />' },
    'file-download': { filled: true, inner: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /><path d="M16 3a1 1 0 0 1 .707 .293l4 4a1 1 0 0 1 .293 .707v10a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h1v4a1 1 0 0 0 .883 .993l.117 .007h6a1 1 0 0 0 1 -1v-4zm-4 8a2.995 2.995 0 0 0 -2.995 2.898a1 1 0 0 0 -.005 .102a3 3 0 1 0 3 -3m1 -8v3h-4v-3z" />' },
    'arrow-back-up': { filled: false, inner: '<path d="M9 14l-4 -4l4 -4" /><path d="M5 10h11a4 4 0 1 1 0 8h-1" />' },
    'arrow-forward-up': { filled: false, inner: '<path d="M15 14l4 -4l-4 -4" /><path d="M19 10h-11a4 4 0 1 0 0 8h1" />' },
    'file-plus': { filled: false, inner: '<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" /><path d="M12 11l0 6" /><path d="M9 14l6 0" />' },
    'file-code': { filled: false, inner: '<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" /><path d="M10 13l-1 2l1 2" /><path d="M14 13l1 2l-1 2" />' },
    'clipboard': { filled: false, inner: '<path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2" /><path d="M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v0a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z" />' },
    'copy': { filled: false, inner: '<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z" /><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1" />' },
    'copy-check': { filled: false, inner: '<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z" /><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1" /><path d="M11 14l1.5 1.5l3 -3" />' },
    'pin': { filled: false, inner: '<path d="M9 4v6l-2 4v2h10v-2l-2 -4v-6" /><path d="M12 16l0 5" /><path d="M8 4l8 0" />' },
    'pin-filled': { filled: true, inner: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /><path d="M8 4a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a1 1 0 0 1 -1 1v5.532l2.629 5.256a1 1 0 0 1 -.895 1.212l-.099 0h-4.635l0 4a1 1 0 0 1 -.883 .993l-.117 .007a1 1 0 0 1 -.993 -.883l-.007 -.117l0 -4h-4.635a1 1 0 0 1 -.99 -1.141l.017 -.088l2.628 -5.239v-5.532a1 1 0 0 1 -1 -1z" />' },
    'chevron-right': { filled: false, inner: '<path d="M9 6l6 6l-6 6"/>' },
    'chevron-down': { filled: false, inner: '<path d="M6 9l6 6l6 -6"/>' },
    'check': { filled: false, inner: '<path d="M5 12l5 5l10 -10"/>' },
    x: { filled: false, inner: '<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>' },
    'settings-cog': { filled: false, inner: '<path d="M12.003 21c-.732 .001 -1.465 -.438 -1.678 -1.317a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c.886 .215 1.325 .957 1.318 1.694" /><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /><path d="M17.001 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M19.001 15.5v1.5" /><path d="M19.001 21v1.5" /><path d="M22.032 17.25l-1.299 .75" /><path d="M17.27 20l-1.3 .75" /><path d="M15.97 17.25l1.3 .75" /><path d="M20.733 20l1.3 .75" />' },
    'presets': { filled: false, inner: '<path d="M12 21a9 9 0 1 1 0 -18a9 9 0 0 1 0 18" /><path d="M18 12a6 6 0 0 1 -6 6" />' },
    'camera-reset': { filled: false, inner: '<path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M4 8v-2a2 2 0 0 1 2 -2h2" /><path d="M4 16v2a2 2 0 0 0 2 2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v2" /><path d="M16 20h2a2 2 0 0 0 2 -2v-2" />' },
    'alert-triangle': { filled: false, inner: '<path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0"/><path d="M12 16h.01"/>' },
    'info-circle': { filled: false, inner: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 9h.01"/><path d="M11 12h1v4h1"/>' },
    'external-link': { filled: false, inner: '<path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6"/><path d="M11 13l9 -9"/><path d="M15 4h5v5"/>' },
    'corner-down-left': { filled: false, inner: '<path d="M18 6v6a3 3 0 0 1 -3 3h-10l4 -4m0 8l-4 -4"/>' },
    'arrow-right': { filled: false, inner: '<path d="M5 12l14 0"/><path d="M13 18l6 -6"/><path d="M13 6l6 6"/>' },
    'arrow-left': { filled: false, inner: '<path d="M5 12l14 0"/><path d="M5 12l6 6"/><path d="M5 12l6 -6"/>' },
    'chevrons-left': { filled: false, inner: '<path d="M11 7l-5 5l5 5"/><path d="M17 7l-5 5l5 5"/>' },
    'chevrons-right': { filled: false, inner: '<path d="M7 7l5 5l-5 5"/><path d="M13 7l5 5l-5 5"/>' },
    minus: { filled: false, inner: '<path d="M5 12l14 0"/>' },
    plus: { filled: false, inner: '<path d="M12 5l0 14"/><path d="M5 12l14 0"/>' },
    'color-filter': { filled: false, inner: '<path d="M13.58 13.79c.27 .68 .42 1.43 .42 2.21c0 1.77 -.77 3.37 -2 4.46a5.93 5.93 0 0 1 -4 1.54c-3.31 0 -6 -2.69 -6 -6c0 -2.76 1.88 -5.1 4.42 -5.79" /><path d="M17.58 10.21c2.54 .69 4.42 3.03 4.42 5.79c0 3.31 -2.69 6 -6 6a5.93 5.93 0 0 1 -4 -1.54" /><path d="M6 8a6 6 0 1 0 12 0a6 6 0 1 0 -12 0" />' },
    help: { filled: false, inner: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /><path d="M12 17l0 .01" /><path d="M12 13.5a1.5 1.5 0 0 1 1 -1.5a2.6 2.6 0 1 0 -3 -4" />' },
    'cube': { filled: false, inner: '<path d="M21 16.008v-8.018a1.98 1.98 0 0 0 -1 -1.717l-7 -4.008a2.016 2.016 0 0 0 -2 0l-7 4.008c-.619 .355 -1 1.01 -1 1.718v8.018c0 .709 .381 1.363 1 1.717l7 4.008a2.016 2.016 0 0 0 2 0l7 -4.008c.619 -.355 1 -1.01 1 -1.718z" /><path d="M12 22v-10" /><path d="M12 12l8.73 -5.04" /><path d="M3.27 6.96l8.73 5.04" />' },
    'cube-off': { filled: false, inner: '<path d="M20.83 16.809c.11 -.248 .17 -.52 .17 -.801v-8.018a1.98 1.98 0 0 0 -1 -1.717l-7 -4.008a2.016 2.016 0 0 0 -2 0l-3.012 1.725m-2.547 1.458l-1.441 .825c-.619 .355 -1 1.01 -1 1.718v8.018c0 .709 .381 1.363 1 1.717l7 4.008a2.016 2.016 0 0 0 2 0l5.544 -3.174" /><path d="M12 22v-10" /><path d="M14.532 10.538l6.198 -3.578" /><path d="M3.27 6.96l8.73 5.04" /><path d="M3 3l18 18" />' },
    'file-check': { filled: false, inner: '<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" /><path d="M9 15l2 2l4 -4" />' },
    'file-x': { filled: false, inner: '<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" /><path d="M10 12l4 4m0 -4l-4 4" />' },
    'file-infinity': { filled: false, inner: '<path d="M15.536 17.586a2.123 2.123 0 0 0 -2.929 0a1.951 1.951 0 0 0 0 2.828c.809 .781 2.12 .781 2.929 0c.809 -.781 -.805 .778 0 0l1.46 -1.41l1.46 -1.419" /><path d="M15.54 17.582l1.46 1.42l1.46 1.41c.809 .78 -.805 -.779 0 0s2.12 .781 2.929 0a1.951 1.951 0 0 0 0 -2.828a2.123 2.123 0 0 0 -2.929 0" /><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M9.5 21h-2.5a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v6" />' },
    'book': { filled: false, inner: '<path d="M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6l0 13"/><path d="M12 6l0 13"/><path d="M21 6l0 13"/>' },
    'plug': { filled: false, inner: '<path d="M9.785 6l8.215 8.215l-2.054 2.054a5.81 5.81 0 1 1 -8.215 -8.215l2.054 -2.054z"/><path d="M4 20l3.5 -3.5"/><path d="M15 4l-3.5 3.5"/><path d="M20 9l-3.5 3.5"/>' },
    'puzzle': { filled: false, inner: '<path d="M4 7h3a1 1 0 0 0 1 -1v-1a2 2 0 0 1 4 0v1a1 1 0 0 0 1 1h3a1 1 0 0 1 1 1v3a1 1 0 0 0 1 1h1a2 2 0 0 1 0 4h-1a1 1 0 0 0 -1 1v3a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-1a2 2 0 0 0 -4 0v1a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h1a2 2 0 0 0 0 -4h-1a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1"/>' },
    'sparkles': { filled: false, inner: '<path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z"/>' },
    'brand-vscode': { filled: false, inner: '<path d="M16 3v18l4 -2.5v-13l-4 -2.5"/><path d="M9.165 13.903l-4.165 3.597l-2 -1l4.333 -4.5m1.735 -1.802l6.932 -7.198v5l-4.795 4.141"/><path d="M16 16.5l-11 -10l-2 1l13 13.5"/>' },
    'download': { filled: false, inner: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/>' },
    'refresh': { filled: false, inner: '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>' },
    'folder': { filled: false, inner: '<path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/>' },
    'wifi-off': { filled: false, inner: '<path d="M12 18h.01"/><path d="M9.172 15.172a4 4 0 0 1 5.656 0"/><path d="M6.343 12.343a8 8 0 0 1 11.314 0"/><path d="M3.515 9.515c4.686 -4.687 12.284 -4.687 17 0"/><path d="M3 3l18 18"/>' },
    'layout-columns': { filled: false, inner: '<path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M12 4l0 16"/>' },

    // ---- Added for the Embed Builder redesign (js/builder-app.jsx) ----
    'inner-shadow-bottom-right': { filled: false, inner: '<path d="M12 21a9 9 0 1 1 0 -18a9 9 0 0 1 0 18z"/><path d="M18 12a6 6 0 0 1 -6 6"/>' },
    circle: { filled: false, inner: '<path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/>' },
    sun: { filled: false, inner: '<path d="M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7"/>' },
    palette: { filled: false, inner: '<path d="M12 21a9 9 0 0 1 0 -18c4.97 0 9 3.582 9 8c0 1.06 -.474 2.078 -1.318 2.828c-.844 .75 -1.989 1.172 -3.182 1.172h-2.5a2 2 0 0 0 -1 3.75a1.3 1.3 0 0 1 -1 2.25"/><path d="M8.5 10.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M12.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M16.5 10.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/>' },
    'layout-grid': { filled: false, inner: '<path d="M4 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M14 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M4 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M14 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/>' },
    adjustments: { filled: false, inner: '<path d="M4 10a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M6 4v4"/><path d="M6 12v8"/><path d="M10 16a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M12 4v10"/><path d="M12 18v2"/><path d="M16 7a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M18 4v1"/><path d="M18 9v11"/>' },
    dimensions: { filled: false, inner: '<path d="M3 5h11"/><path d="M12 7l2 -2l-2 -2"/><path d="M5 3l-2 2l2 2"/><path d="M19 10v11"/><path d="M17 19l2 2l2 -2"/><path d="M21 12l-2 -2l-2 2"/><path d="M3 10m0 2a2 2 0 0 1 2 -2h7a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-7a2 2 0 0 1 -2 -2z"/>' },
    'file-text': { filled: false, inner: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"/><path d="M9 9l1 0"/><path d="M9 13l6 0"/><path d="M9 17l6 0"/>' },
    'device-desktop': { filled: false, inner: '<path d="M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10z"/><path d="M7 20h10"/><path d="M9 16v4"/><path d="M15 16v4"/>' },
    'device-tablet': { filled: false, inner: '<path d="M5 4a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v16a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1v-16z"/><path d="M11 17a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"/>' },
    'device-mobile': { filled: false, inner: '<path d="M6 5a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2v-14z"/><path d="M11 4h2"/><path d="M12 17v.01"/>' },
    world: { filled: false, inner: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M3.6 9h16.8"/><path d="M3.6 15h16.8"/><path d="M11.5 3a17 17 0 0 0 0 18"/><path d="M12.5 3a17 17 0 0 1 0 18"/>' },
    droplet: { filled: false, inner: '<path d="M7.502 19.423c2.602 2.105 6.395 2.105 8.996 0c2.602 -2.105 3.262 -5.708 1.566 -8.546l-4.89 -7.26c-.42 -.625 -1.287 -.803 -1.936 -.397a1.376 1.376 0 0 0 -.41 .397l-4.893 7.26c-1.695 2.838 -1.035 6.441 1.567 8.546z"/>' },
    'focus-2': { filled: false, inner: '<circle cx="12" cy="12" r=".5" fill="currentColor"/><path d="M12 12m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M12 3l0 2"/><path d="M3 12l2 0"/><path d="M12 19l0 2"/><path d="M19 12l2 0"/>' },
    lock: { filled: false, inner: '<path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z"/><path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"/><path d="M8 11v-4a4 4 0 1 1 8 0v4"/>' },
    link: { filled: false, inner: '<path d="M9 15l6 -6"/><path d="M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464"/><path d="M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463"/>' },
    wave: { filled: false, inner: '<path d="M21 12h-2c-.894 0 -1.662 -.857 -1.761 -2c-.296 -3.45 -.749 -6 -2.749 -6s-2.5 3.582 -2.5 8s-.5 8 -2.5 8s-2.452 -2.547 -2.749 -6c-.1 -1.147 -.867 -2 -1.763 -2h-2"/>' },
    id: { filled: false, inner: '<path d="M3 4m0 3a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v10a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z"/><path d="M9 10m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M15 8l2 0"/><path d="M15 12l2 0"/><path d="M7 16l10 0"/>' },
    article: { filled: false, inner: '<path d="M3 4m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/><path d="M7 8h10"/><path d="M7 12h10"/><path d="M7 16h10"/>' },
    'layout-navbar': { filled: false, inner: '<path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M4 9l16 0"/>' },
    'color-swatch': { filled: false, inner: '<path d="M19 3h-4a2 2 0 0 0 -2 2v12a4 4 0 0 0 8 0v-12a2 2 0 0 0 -2 -2"/><path d="M13 7.35l-2 -2a2 2 0 0 0 -2.828 0l-2.828 2.828a2 2 0 0 0 0 2.828l9 9"/><path d="M7.3 13h-2.3a2 2 0 0 0 -2 2v4a2 2 0 0 0 2 2h12"/><path d="M17 17l0 .01"/>' },
};

// React component (plain createElement — this file stays JSX-free).
// React is loaded by the pages before any Babel script executes, and
// the reference is resolved at RENDER time anyway.
const MtlxIcon = (props) => {
    const ic = MTLX_ICON_PATHS[props.name];
    if (!ic || typeof React === 'undefined') return null;
    return React.createElement('svg', {
        viewBox: '0 0 24 24',
        className: props.className || 'w-4 h-4',
        fill: ic.filled ? 'currentColor' : 'none',
        stroke: ic.filled ? 'none' : 'currentColor',
        strokeWidth: ic.filled ? undefined : 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        dangerouslySetInnerHTML: { __html: ic.inner },
    });
};

Object.assign(window, { MtlxIcon, MTLX_ICON_PATHS });

// ------------------------------------------------------------------
// Global error capture (browser-side). Until now there was no
// window 'error'/'unhandledrejection' listener anywhere in js/ — the
// only precedent is vscode_extension/media/bootstrap.js's postError(),
// which forwards capped/truncated text to the extension host. This is
// the same shape (a small cap, per-entry truncation), but LOCAL ONLY:
// no network call, no telemetry — just an in-memory ring buffer that
// js/shell.jsx's per-view error boundary (and anything else) can read
// via mtlxDiagnosticsText() for its "Copy diagnostics" button. Always
// also console.error, so nothing is hidden from normal devtools use.
//
// Lives here (not shell.jsx) because ui-commons.js is the first script
// after React/Babel to run on every page (index.html, the tutorials
// subsite's vendored copy, and the VS Code webview) — it must be
// listening before mtlx-engine.js or shell.jsx even start loading.
// ------------------------------------------------------------------
const MTLX_ERROR_LOG_MAX = 20;
const MTLX_ERROR_CHARS_MAX = 500;
const __mtlxErrorLog = [];
function mtlxRecordError(text) {
    __mtlxErrorLog.push({
        time: new Date().toISOString(),
        text: String(text).slice(0, MTLX_ERROR_CHARS_MAX),
    });
    if (__mtlxErrorLog.length > MTLX_ERROR_LOG_MAX) __mtlxErrorLog.shift();
}
window.addEventListener('error', (event) => {
    const where = event && event.filename ? ' (' + event.filename + ':' + event.lineno + ')' : '';
    const err = event && event.error;
    mtlxRecordError('Uncaught error: ' + ((err && (err.stack || err.message)) || (event && event.message) || 'Unknown error') + where);
    console.error('[mtlx] Uncaught error:', err || (event && event.message));
});
window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason;
    mtlxRecordError('Unhandled rejection: ' + String((reason && (reason.stack || reason.message)) || reason));
    console.error('[mtlx] Unhandled rejection:', reason);
});

// Formats the ring buffer (plus live page context) as plain text for a
// "Copy diagnostics" button. `extra` is caller-supplied context, e.g. the
// specific error/component stack an error boundary just caught — put
// first since it's almost always the most relevant line.
function mtlxDiagnosticsText(extra) {
    const lines = ['MaterialX Playground diagnostics', 'Time: ' + new Date().toISOString()];
    if (extra) lines.push('', String(extra));
    lines.push(
        '',
        'URL: ' + location.href,
        'Hash: ' + (location.hash || '(none)'),
        'User agent: ' + navigator.userAgent,
        'Viewport: ' + window.innerWidth + 'x' + window.innerHeight,
    );
    if (window.__mtlxVersion) lines.push('MaterialX version: ' + window.__mtlxVersion);
    if (__mtlxErrorLog.length) {
        lines.push('', 'Recent captured errors (' + __mtlxErrorLog.length + '):');
        __mtlxErrorLog.forEach((e) => lines.push('[' + e.time + '] ' + e.text));
    } else {
        lines.push('', 'No other errors captured this session.');
    }
    return lines.join('\n');
}

Object.assign(window, {
    mtlxRecordError, mtlxDiagnosticsText,
    mtlxGetErrorLog: () => __mtlxErrorLog.slice(),
});
