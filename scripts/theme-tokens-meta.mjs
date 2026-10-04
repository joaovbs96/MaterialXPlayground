// Node-only token metadata (never shipped to browsers): per-token notes and contrast pairs.
// Keys must equal the dark theme keys in js/shared/theme-tokens.js (enforced by build-theme.mjs).
export const tokens = {
    "surface-base": {
        "group": "surface",
        "kind": "seed",
        "derive": "background seed",
        "role": "Page ground: body, app roots, ground-level sidebars and rails, flush cards on the ground, footer."
    },
    "surface-raised": {
        "group": "surface",
        "kind": "derivable",
        "derive": "background mixed 7% toward foreground (OKLCH L +6.8)",
        "role": "Cards, panels, dialogs and popovers (/95 with blur), menus, docs detail and tree panels."
    },
    "surface-sunken": {
        "group": "surface",
        "kind": "derivable",
        "derive": "equals background in dark; light themes go 3-4% toward foreground from surface-raised",
        "role": "Inputs, search fields, wells, table heads, inline-code wells, cards nested inside a raised panel."
    },
    "chrome": {
        "group": "surface",
        "kind": "derivable",
        "derive": "equals background in dark (light themes may use surface-raised)",
        "role": "Frame bars: site header and mobile menu (/95), app toolbars, panel and dialog header/footer strips (/70), group-header bars (/40)."
    },
    "control": {
        "group": "surface",
        "kind": "derivable",
        "derive": "equals surface-raised in dark",
        "role": "Buttons, segmented controls, chips and select triggers at rest (/80, /50 when disabled)."
    },
    "chip": {
        "group": "surface",
        "kind": "derivable",
        "derive": "background mixed 18% toward foreground",
        "role": "Neutral static fills on raised surfaces: tags, neutral badges (/40 to /80), inner chips, progress and toggle-off tracks."
    },
    "stage": {
        "group": "surface",
        "kind": "derivable",
        "derive": "equals background in dark (matches the viewport clear literal 0x111827); light equals graph-canvas (empty and idle stages are UI)",
        "role": "DOM containers behind 3D renders and image previews; embed page behind the canvas."
    },
    "stage-fg-muted": {
        "group": "surface",
        "kind": "derivable",
        "derive": "equals fg-muted in dark; light tuned for the light stage",
        "role": "Text drawn directly on the stage (no chip): empty and cancelled viewport messages."
    },
    "stage-fg-subtle": {
        "group": "surface",
        "kind": "derivable",
        "derive": "equals fg-subtle in dark; light tuned for the light stage",
        "role": "Dim hint text drawn directly on the stage (drop hints on empty viewports)."
    },
    "veil": {
        "group": "surface",
        "kind": "derivable",
        "derive": "equals background",
        "role": "Translucent covers over one region (/60 to /85): loading, error and empty-state covers, busy overlays."
    },
    "scrim": {
        "group": "surface",
        "kind": "derivable",
        "derive": "background darkened (OKLCH L -8); stays dark in light themes",
        "role": "Modal backdrops (/70, /85)."
    },
    "hover": {
        "group": "surface",
        "kind": "derivable",
        "derive": "background mixed 18% toward foreground",
        "role": "Hover fill for controls, list rows and menu items (alpha from the class)."
    },
    "hover-subtle": {
        "group": "surface",
        "kind": "derivable",
        "derive": "background mixed 7% toward foreground",
        "role": "Hover on ground-level rows, tabs and sidebar rows (/40 to /100)."
    },
    "hover-strong": {
        "group": "surface",
        "kind": "derivable",
        "derive": "background mixed 27% toward foreground",
        "role": "Hover of chip-level fills (buttons resting on chip), scrollbar thumb hover."
    },
    "pressed": {
        "group": "surface",
        "kind": "derivable",
        "derive": "background mixed 18% toward foreground",
        "role": "Pressed or active segment or tool in a neutral group."
    },
    "line": {
        "group": "line",
        "kind": "derivable",
        "derive": "background mixed 18% toward foreground",
        "role": "Default borders and dividers, 1px dividers drawn as bg, dim separator glyphs."
    },
    "line-control": {
        "group": "line",
        "kind": "derivable",
        "derive": "equals line in dark; light themes need 3:1 (WCAG 1.4.11) against the surface behind",
        "role": "Boundaries that identify a control: text inputs, search fields, icon buttons, select triggers, selectable tile cards, split-button halves. Not dividers or panel outlines (line)."
    },
    "line-subtle": {
        "group": "line",
        "kind": "derivable",
        "derive": "background mixed 7% toward foreground",
        "role": "Subtle rules: header/footer rules, card edges equal to their fill, list row dividers."
    },
    "line-strong": {
        "group": "line",
        "kind": "derivable",
        "derive": "background mixed 27% toward foreground",
        "role": "Control, input, dialog and popover borders; hover target of line; decorative hatch."
    },
    "line-heavy": {
        "group": "line",
        "kind": "derivable",
        "derive": "background mixed 41% toward foreground",
        "role": "Spinner track, neutral badge borders, hover of line-strong, splitter hover, decorative grid lines (/14, /16)."
    },
    "fg-strong": {
        "group": "text",
        "kind": "derivable",
        "derive": "foreground pushed to maximum lightness (inverse: pure black)",
        "role": "Maximum-emphasis text: headings drawn in white, hover:text-white on neutral rows."
    },
    "fg": {
        "group": "text",
        "kind": "seed",
        "derive": "foreground seed",
        "role": "Primary text: titles, body default, active rows, input text in dialogs."
    },
    "fg-soft": {
        "group": "text",
        "kind": "derivable",
        "derive": "foreground mixed 6% toward background",
        "role": "Field values, labels, strong/mono inline text, hover target of secondary text."
    },
    "fg-secondary": {
        "group": "text",
        "kind": "derivable",
        "derive": "foreground mixed 14% toward background",
        "role": "Secondary text: default control text, body copy in dialogs."
    },
    "fg-muted": {
        "group": "text",
        "kind": "derivable",
        "derive": "foreground mixed 37% toward background",
        "role": "Muted text: docs body copy, hints, captions, idle icon buttons."
    },
    "fg-subtle": {
        "group": "text",
        "kind": "derivable",
        "derive": "foreground mixed 59% toward background",
        "role": "Subtle text: labels, captions, empty states, placeholders; neutral idle dots."
    },
    "fg-faint": {
        "group": "text",
        "kind": "derivable",
        "derive": "foreground mixed 73% toward background",
        "role": "Faintest text: separator glyphs, dim placeholders, inactive dots."
    },
    "fg-disabled": {
        "group": "text",
        "kind": "derivable",
        "derive": "foreground mixed 73% toward background",
        "role": "Disabled text (explicit disabled branches that use gray-600)."
    },
    "fg-inverse": {
        "group": "text",
        "kind": "derivable",
        "derive": "equals background seed",
        "role": "Text on light fills (reserved; no current use)."
    },
    "accent-base": {
        "group": "accent",
        "kind": "seed",
        "derive": "accent seed",
        "role": "Accent marks: active/selected borders, toggle-on track, progress fill, accent dots, native accent-color, drop indicator, splitter drag."
    },
    "accent-fill": {
        "group": "accent",
        "kind": "derivable",
        "derive": "accent OKLCH L -7.7, C +0.03",
        "role": "Solid accent fills: primary buttons (/70, /80), active HUD pill, selected tree row, CTA."
    },
    "accent-fill-translucent": {
        "group": "accent",
        "kind": "derivable",
        "derive": "equals accent-fill in dark; light themes pick the value whose /70 composite over the page keeps 4.5 with on-accent",
        "role": "Primary-button and active-toggle fill drawn at /70 over page surfaces (BTN_PRIMARY and its inline copies)."
    },
    "accent-fill-hover": {
        "group": "accent",
        "kind": "derivable",
        "derive": "equals accent in dark (fill lightened toward accent)",
        "role": "Hover of accent fills."
    },
    "accent-fill-translucent-hover": {
        "group": "accent",
        "kind": "derivable",
        "derive": "equals accent-fill-hover in dark; light themes go darker so the /70 hover composite keeps 4.5 with on-accent",
        "role": "Hover fill of the /70 primary button."
    },
    "accent-fill-pressed": {
        "group": "accent",
        "kind": "derivable",
        "derive": "accent OKLCH L -13.5",
        "role": "Pressed/on state of accent controls (toggle-on ground /30)."
    },
    "accent-wash": {
        "group": "accent",
        "kind": "derivable",
        "derive": "equals accent; used only translucent",
        "role": "Accent tints: washes (bg /5 to /25), wash borders and rings (/25 to /40), glows, gradients, halos, underline decoration."
    },
    "accent-fg": {
        "group": "accent",
        "kind": "derivable",
        "derive": "accent OKLCH L +9.1, C x0.76",
        "role": "Accent foreground on neutral surfaces: links, accent icons, accent dots and marks."
    },
    "accent-fg-strong": {
        "group": "accent",
        "kind": "derivable",
        "derive": "accent OKLCH L +18.6, C x0.51",
        "role": "Active tab/chip text, kickers, link hover."
    },
    "accent-fg-bright": {
        "group": "accent",
        "kind": "derivable",
        "derive": "accent OKLCH L +25.9, C x0.30",
        "role": "Text on accent washes and drop targets, hover of accent-fg-strong."
    },
    "on-accent": {
        "group": "accent",
        "kind": "derivable",
        "derive": "white, or fg-inverse when the fill is light",
        "role": "Text and icons on saturated fills (accent, success, danger); toggle knob."
    },
    "on-accent-muted": {
        "group": "accent",
        "kind": "derivable",
        "derive": "accent OKLCH L +30.9, C x0.17",
        "role": "Secondary foreground on solid accent fills: selected-row icons and counts, selected option card title."
    },
    "accent-text-on-tint": {
        "group": "accent",
        "kind": "derivable",
        "derive": "equals on-accent-muted in dark; light themes need a dark accent on the pale tint",
        "role": "Text and icons on faint accent tints (selected tile cards at /5, docs sidebar clear-filter hover). Solid accent fills keep on-accent-muted."
    },
    "selection": {
        "group": "accent",
        "kind": "derivable",
        "derive": "equals accent-fill",
        "role": "Highlighted/selected list rows as a wash (/20, /30), MtlxSelect highlighted row (30%)."
    },
    "focus": {
        "group": "accent",
        "kind": "derivable",
        "derive": "equals accent",
        "role": "Focus borders, rings and outlines."
    },
    "progress": {
        "group": "accent",
        "kind": "derivable",
        "derive": "equals accent-fg",
        "role": "Activity indicators: spinner arc, loading sweep, determinate thin bars, pulse and multi-select dots."
    },
    "drop-target": {
        "group": "accent",
        "kind": "derivable",
        "derive": "accent mixed about 85% toward background",
        "role": "Drag-and-drop target ground (/40)."
    },
    "hover-accent": {
        "group": "accent",
        "kind": "derivable",
        "derive": "accent mixed about 70% toward background",
        "role": "Accent-tinted row hover (/20)."
    },
    "success": {
        "group": "status",
        "kind": "independent",
        "derive": "green hue, OKLCH L about 80",
        "role": "Success foreground: text, icons, ready dots."
    },
    "success-text": {
        "group": "status",
        "kind": "independent",
        "derive": "success lightened",
        "role": "Text on success-tinted grounds (toggle on, validate button)."
    },
    "success-hue": {
        "group": "status",
        "kind": "independent",
        "derive": "saturated green, used translucent or as a strong border",
        "role": "Success wash (/10) and borders (/40, /60, solid)."
    },
    "success-fill": {
        "group": "status",
        "kind": "independent",
        "derive": "success darkened",
        "role": "Solid success fill (Copied button /70), toggle-on border (/60)."
    },
    "success-bg": {
        "group": "status",
        "kind": "independent",
        "derive": "success mixed toward background",
        "role": "Success badge ground (/10, /30)."
    },
    "success-border": {
        "group": "status",
        "kind": "independent",
        "derive": "success darkened",
        "role": "Success badge border (/60)."
    },
    "warning": {
        "group": "status",
        "kind": "independent",
        "derive": "amber hue, OKLCH L about 88",
        "role": "Warning foreground: icons, pill and badge text."
    },
    "warning-text": {
        "group": "status",
        "kind": "independent",
        "derive": "warning lightened",
        "role": "Text in warning banners and callouts; experimental notice links."
    },
    "warning-text-strong": {
        "group": "status",
        "kind": "independent",
        "derive": "warning lightened further",
        "role": "Hover of warning-text, emphasized lines inside warnings, text on warning buttons."
    },
    "warning-marker": {
        "group": "status",
        "kind": "independent",
        "derive": "warning darkened slightly",
        "role": "Warning dots and marker icons (unapplied, undocumented, dirty)."
    },
    "warning-hue": {
        "group": "status",
        "kind": "independent",
        "derive": "saturated amber",
        "role": "Warning callout/pill wash (/10, /20) and borders (/40, /50, /70)."
    },
    "warning-bg": {
        "group": "status",
        "kind": "independent",
        "derive": "warning mixed toward background",
        "role": "Warning banner ground (/20 to /40), undocumented-row hover (/20)."
    },
    "warning-border": {
        "group": "status",
        "kind": "independent",
        "derive": "warning darkened",
        "role": "Warning banner border (/40 to /60)."
    },
    "error": {
        "group": "status",
        "kind": "independent",
        "derive": "red hue, OKLCH L about 71",
        "role": "Error foreground: text, icons, error chips, destructive hover."
    },
    "error-text": {
        "group": "status",
        "kind": "independent",
        "derive": "error lightened",
        "role": "Text inside error tooltips, inline messages, boot error."
    },
    "error-hue": {
        "group": "status",
        "kind": "independent",
        "derive": "saturated red",
        "role": "Invalid-field border, error icon, validate button border (/60)."
    },
    "error-fill": {
        "group": "status",
        "kind": "independent",
        "derive": "error darkened",
        "role": "Solid danger fill and its border."
    },
    "error-fill-hover": {
        "group": "status",
        "kind": "independent",
        "derive": "error darkened further",
        "role": "Hover of danger fill."
    },
    "error-bg": {
        "group": "status",
        "kind": "independent",
        "derive": "error mixed toward background",
        "role": "Error box/toast/tooltip ground (/30 to /95)."
    },
    "error-border": {
        "group": "status",
        "kind": "independent",
        "derive": "error darkened",
        "role": "Error box/toast border (/60)."
    },
    "info": {
        "group": "status",
        "kind": "independent",
        "derive": "sky hue, OKLCH L about 84",
        "role": "Info severity foreground (diagnostics tone)."
    },
    "info-text": {
        "group": "status",
        "kind": "independent",
        "derive": "info lightened",
        "role": "Text in info banners."
    },
    "info-bg": {
        "group": "status",
        "kind": "independent",
        "derive": "info mixed toward background",
        "role": "Info banner and info badge ground (/40)."
    },
    "info-border": {
        "group": "status",
        "kind": "independent",
        "derive": "info darkened",
        "role": "Info banner border (/60)."
    },
    "experimental": {
        "group": "experimental",
        "kind": "independent",
        "derive": "amber, equals warning in dark",
        "role": "Experimental badge text and experimental notice paragraphs."
    },
    "experimental-hue": {
        "group": "experimental",
        "kind": "independent",
        "derive": "saturated amber",
        "role": "Experimental badge border (/40, /50, /70) and pill wash (/10)."
    },
    "hud": {
        "group": "hud",
        "kind": "derivable",
        "derive": "equals background in dark; light themes may keep it dark",
        "role": "HUD pill and chip ground over renders (/70 to /85), PILL_ACTION*, zoom/wheel hints, drop labels."
    },
    "hud-raised": {
        "group": "hud",
        "kind": "derivable",
        "derive": "equals surface-raised in dark",
        "role": "Toolbar buttons and banners over renders (/80, /90)."
    },
    "hud-line": {
        "group": "hud",
        "kind": "derivable",
        "derive": "equals line-strong in dark",
        "role": "HUD pill and control borders (/50, solid on hover)."
    },
    "hud-fg": {
        "group": "hud",
        "kind": "derivable",
        "derive": "equals fg-secondary in dark",
        "role": "HUD pill text."
    },
    "hud-fg-muted": {
        "group": "hud",
        "kind": "derivable",
        "derive": "equals fg-muted in dark",
        "role": "Idle HUD pill and PILL_ACTION text."
    },
    "hud-fg-strong": {
        "group": "hud",
        "kind": "derivable",
        "derive": "equals fg in dark",
        "role": "HUD hover text, hint text."
    },
    "hud-hover": {
        "group": "hud",
        "kind": "derivable",
        "derive": "equals hover in dark",
        "role": "HUD pill hover fill."
    },
    "hud-selection": {
        "group": "hud",
        "kind": "derivable",
        "derive": "accent-fg level, but tuned for render content, not for the page",
        "role": "USD viewport selection outline (GLSL uniform, set from MtlxTheme.get)."
    },
    "shadow": {
        "group": "misc",
        "kind": "independent",
        "derive": "black in every theme; alpha carries strength",
        "role": "Box-shadow color in CSS literals, contact shadow blobs."
    },
    "scrollbar-track": {
        "group": "misc",
        "kind": "derivable",
        "derive": "equals surface-raised",
        "role": "Custom scrollbar track."
    },
    "scrollbar-thumb": {
        "group": "misc",
        "kind": "derivable",
        "derive": "equals chip",
        "role": "Custom scrollbar and KaTeX scrollbar thumb."
    },
    "brand-mark": {
        "group": "misc",
        "kind": "independent",
        "derive": "logo white",
        "role": "Wordmark and logo main shape."
    },
    "brand-accent": {
        "group": "misc",
        "kind": "independent",
        "derive": "equals accent-fg (logo and wordmark follow the accent)",
        "role": "Header brand text, logo crescent."
    },
    "brand-logo-inner": {
        "group": "misc",
        "kind": "independent",
        "derive": "white in every theme (brand logo art)",
        "role": "Inner shape of the Playground logo (site header, home hero, 404)."
    },
    "code-fg": {
        "group": "code",
        "kind": "derivable",
        "derive": "equals fg-secondary",
        "role": "Code base text (hljs base, help-doc pre)."
    },
    "code-muted": {
        "group": "code",
        "kind": "derivable",
        "derive": "equals fg-subtle",
        "role": "hljs tags, punctuation and comments."
    },
    "code-name": {
        "group": "code",
        "kind": "derivable",
        "derive": "equals accent-fg",
        "role": "hljs element names."
    },
    "code-attr": {
        "group": "code",
        "kind": "derivable",
        "derive": "equals fg-muted",
        "role": "hljs attribute names."
    },
    "code-string": {
        "group": "code",
        "kind": "independent",
        "derive": "green, equals success in dark",
        "role": "hljs strings."
    },
    "code-inline-bg": {
        "group": "code",
        "kind": "derivable",
        "derive": "equals chip",
        "role": "Inline code chip ground (/50)."
    },
    "code-inline-fg": {
        "group": "code",
        "kind": "independent",
        "derive": "amber value highlight",
        "role": "Inline code value highlight in docs rich text."
    },
    "code-block-bg": {
        "group": "code",
        "kind": "derivable",
        "derive": "background OKLCH L -3",
        "role": "Code block ground (VS Code page)."
    },
    "code-syntax-text": {
        "group": "code",
        "kind": "independent",
        "derive": "Syntax base text (equals Dark+ text); light is follows the foreground seed (near black)",
        "role": "Code editor base text (the highlighted layer) and the stdlib underline at 50%."
    },
    "code-syntax-comment": {
        "group": "code",
        "kind": "independent",
        "derive": "green (Dark+ / Light+ comment)",
        "role": "Syntax comments."
    },
    "code-syntax-string": {
        "group": "code",
        "kind": "independent",
        "derive": "orange-brown (Dark+) / dark red (Light+)",
        "role": "Syntax strings."
    },
    "code-syntax-number": {
        "group": "code",
        "kind": "independent",
        "derive": "pale green (Dark+) / teal green (Light+)",
        "role": "Syntax numbers and the true, false and null constants."
    },
    "code-syntax-keyword": {
        "group": "code",
        "kind": "independent",
        "derive": "blue (Dark+ / Light+)",
        "role": "Syntax keywords and keyword completion badges."
    },
    "code-syntax-type": {
        "group": "code",
        "kind": "independent",
        "derive": "teal (Dark+ / Light+)",
        "role": "Syntax types, type names in signatures and type badges."
    },
    "code-syntax-directive": {
        "group": "code",
        "kind": "independent",
        "derive": "purple (Dark+ / Light+)",
        "role": "Syntax directives (#include style)."
    },
    "code-syntax-function": {
        "group": "code",
        "kind": "independent",
        "derive": "pale yellow (Dark+) / brown (Light+)",
        "role": "Syntax attributes, function names in signatures and function badges."
    },
    "code-syntax-param": {
        "group": "code",
        "kind": "independent",
        "derive": "light blue (Dark+) / navy (Light+)",
        "role": "Parameter names in assist popups and variable badges."
    },
    "code-syntax-link": {
        "group": "code",
        "kind": "independent",
        "derive": "blue (Dark+ / Light+ link)",
        "role": "Standard library call under Ctrl/Cmd (documentation link)."
    },
    "code-syntax-error": {
        "group": "code",
        "kind": "independent",
        "derive": "red (Dark+ / Light+ error)",
        "role": "Compile error squiggles in the code editor."
    },
    "code-syntax-caret": {
        "group": "code",
        "kind": "derivable",
        "derive": "mix toward foreground (Dark+ caret)",
        "role": "Code editor text caret."
    },
    "code-syntax-selection": {
        "group": "code",
        "kind": "independent",
        "derive": "deep blue (Dark+) / pale blue (Light+) selection ground",
        "role": "Code editor selection ground."
    },
    "code-syntax-highlight": {
        "group": "code",
        "kind": "independent",
        "derive": "bright blue (Dark+) / strong blue (Light+)",
        "role": "Active parameter and matched characters in assist popups (bold)."
    },
    "code-syntax-assist-selected": {
        "group": "code",
        "kind": "independent",
        "derive": "deep blue (Dark+) / pale blue (Light+) row ground",
        "role": "Selected row ground in the assist completion list."
    },
    "graph-canvas": {
        "group": "graph",
        "kind": "derivable",
        "derive": "equals background",
        "role": "Graph editor root/canvas ground, port-handle ring (cutout), attribution chip (/60)."
    },
    "graph-grid": {
        "group": "graph",
        "kind": "derivable",
        "derive": "equals line",
        "role": "React Flow Background dots/lines (resolved hex)."
    },
    "builder-stage": {
        "group": "graph",
        "kind": "derivable",
        "derive": "dark literal #0b1220; light equals graph-canvas",
        "role": "Embed Builder live-preview stage ground behind the embedded viewer."
    },
    "builder-stage-grid": {
        "group": "graph",
        "kind": "derivable",
        "derive": "dark literal #6b7280 (used at alpha 36/255); light equals graph-grid",
        "role": "Embed Builder preview stage grid lines (solid base, alpha in usage)."
    },
    "graph-edge-draft": {
        "group": "graph",
        "kind": "derivable",
        "derive": "equals accent-fg",
        "role": "In-progress connection wire (resolved)."
    },
    "graph-edge-selected": {
        "group": "graph",
        "kind": "derivable",
        "derive": "equals accent",
        "role": "Selected edge stroke."
    },
    "graph-node": {
        "group": "graph",
        "kind": "derivable",
        "derive": "equals surface-raised",
        "role": "Node body."
    },
    "graph-node-header": {
        "group": "graph",
        "kind": "derivable",
        "derive": "equals background",
        "role": "Node header strip (/70) and interface-node body (/70)."
    },
    "graph-node-line": {
        "group": "graph",
        "kind": "derivable",
        "derive": "equals line-strong",
        "role": "Node border (normal nodes)."
    },
    "graph-node-line-iface": {
        "group": "graph",
        "kind": "derivable",
        "derive": "equals line-heavy",
        "role": "Node border for interface/definition nodes, node badge border."
    },
    "graph-node-selected": {
        "group": "graph",
        "kind": "derivable",
        "derive": "equals accent",
        "role": "Selected node border and ring (/50)."
    },
    "graph-minimap-bg": {
        "group": "graph",
        "kind": "derivable",
        "derive": "equals surface-raised",
        "role": "Minimap panel ground."
    },
    "graph-minimap-mask": {
        "group": "graph",
        "kind": "derivable",
        "derive": "equals graph-canvas",
        "role": "Minimap viewport mask; always drawn at 0.75 alpha.",
        "translucent": 0.75
    },
    "graph-minimap-stroke": {
        "group": "graph",
        "kind": "derivable",
        "derive": "equals graph-canvas",
        "role": "Minimap node stroke (resolved)."
    },
    "type-boolean": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "boolean"
    },
    "type-bsdf": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "BSDF"
    },
    "type-color3": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "color3"
    },
    "type-color4": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "color4"
    },
    "type-displacementshader": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "displacementshader"
    },
    "type-edf": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "EDF"
    },
    "type-filename": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "filename"
    },
    "type-float": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "float"
    },
    "type-integer": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "integer"
    },
    "type-lightshader": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "lightshader"
    },
    "type-material": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "material"
    },
    "type-matrix33": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "matrix33"
    },
    "type-matrix44": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "matrix44"
    },
    "type-string": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "string"
    },
    "type-surfaceshader": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "surfaceshader"
    },
    "type-vector2": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "vector2"
    },
    "type-vector3": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "vector3"
    },
    "type-vector4": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "vector4"
    },
    "type-vdf": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "VDF"
    },
    "type-volumeshader": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "volumeshader"
    },
    "type-node": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "node"
    },
    "type-nodegraph": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "nodegraph"
    },
    "type-untyped": {
        "group": "type",
        "kind": "independent",
        "derive": "categorical",
        "role": "untyped port or synthetic item (typeColor() with no type)"
    },
    "native-window-bg": {
        "group": "native",
        "kind": "independent",
        "derive": "window ground shown before the page paints",
        "role": "Electron BrowserWindow backgroundColor."
    },
    "native-titlebar": {
        "group": "native",
        "kind": "independent",
        "derive": "matches the site header over the page ground",
        "role": "Electron title bar overlay color (Windows and Linux)."
    },
    "native-titlebar-symbol": {
        "group": "native",
        "kind": "independent",
        "derive": "matches the header icon color",
        "role": "Electron title bar overlay window-control symbol color."
    },
    "surface-deep": {
        "group": "drift",
        "kind": "derivable",
        "derive": "equals scrim",
        "role": "Deepest wells (/50): error stack pre, kbd-like chips; diff canvas ground.",
        "drift": true,
        "mergeInto": "surface-sunken"
    },
    "scrim-alt": {
        "group": "drift",
        "kind": "independent",
        "derive": "black",
        "role": "Docs sidebar dialog backdrop (/60).",
        "drift": true,
        "mergeInto": "scrim"
    },
    "on-accent-soft": {
        "group": "drift",
        "kind": "derivable",
        "derive": "equals fg",
        "role": "gray-100 text on accent fills.",
        "drift": true,
        "mergeInto": "on-accent"
    },
    "warning-bg-strong": {
        "group": "drift",
        "kind": "independent",
        "derive": "amber",
        "role": "Action button on a warning banner (/60, hover solid).",
        "drift": true,
        "mergeInto": "warning-bg"
    },
    "warning-border-alt": {
        "group": "drift",
        "kind": "independent",
        "derive": "amber",
        "role": "Warning toast/banner border (/50) in shell and site header.",
        "drift": true,
        "mergeInto": "warning-border"
    },
    "notice-bg": {
        "group": "drift",
        "kind": "independent",
        "derive": "slate",
        "role": "Non-warning shell toast ground (/30).",
        "drift": true,
        "mergeInto": "surface-raised"
    },
    "notice-line": {
        "group": "drift",
        "kind": "independent",
        "derive": "slate",
        "role": "Non-warning shell toast border (/50).",
        "drift": true,
        "mergeInto": "line-strong"
    },
    "notice-text": {
        "group": "drift",
        "kind": "independent",
        "derive": "slate",
        "role": "Non-warning shell toast text (and /80 dismiss).",
        "drift": true,
        "mergeInto": "fg-soft"
    },
    "notice-text-strong": {
        "group": "drift",
        "kind": "independent",
        "derive": "slate",
        "role": "Non-warning shell toast dismiss hover.",
        "drift": true,
        "mergeInto": "fg"
    },
    "experimental-fill": {
        "group": "drift",
        "kind": "independent",
        "derive": "amber",
        "role": "Small Experimental badge fill (/30, hover /40).",
        "drift": true,
        "mergeInto": "experimental-hue"
    },
    "code-inline-fg-alt": {
        "group": "drift",
        "kind": "independent",
        "derive": "red",
        "role": "Inline code text in the Embed Builder help doc.",
        "drift": true,
        "mergeInto": "code-inline-fg"
    },
    "code-block-bg-alt": {
        "group": "drift",
        "kind": "derivable",
        "derive": "background, slate tint",
        "role": "Code block ground in the Embed Builder help doc.",
        "drift": true,
        "mergeInto": "code-block-bg"
    }
};

// kind: text (4.5), large (3), ui (3), decorative (reported only). alpha+under: bg is composited at alpha over token `under`.
export const contrast = [
    {
        "fg": "fg",
        "bg": "surface-base",
        "kind": "text"
    },
    {
        "fg": "fg",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "fg-strong",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "fg-soft",
        "bg": "surface-sunken",
        "kind": "text"
    },
    {
        "fg": "fg-secondary",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "fg-secondary",
        "bg": "control",
        "kind": "text"
    },
    {
        "fg": "fg-muted",
        "bg": "surface-base",
        "kind": "text"
    },
    {
        "fg": "fg-muted",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "fg-subtle",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "fg-subtle",
        "bg": "surface-sunken",
        "kind": "text"
    },
    {
        "fg": "fg-faint",
        "bg": "surface-base",
        "kind": "large"
    },
    {
        "fg": "fg-inverse",
        "bg": "fg",
        "kind": "text"
    },
    {
        "fg": "on-accent",
        "bg": "accent-fill",
        "kind": "text"
    },
    {
        "fg": "on-accent-muted",
        "bg": "accent-fill",
        "kind": "text"
    },
    {
        "fg": "on-accent",
        "bg": "success-fill",
        "kind": "text"
    },
    {
        "fg": "on-accent",
        "bg": "error-fill",
        "kind": "text"
    },
    {
        "fg": "accent-fg",
        "bg": "surface-base",
        "kind": "text"
    },
    {
        "fg": "accent-fg",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "accent-fg-strong",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "accent-fg-bright",
        "bg": "drop-target",
        "kind": "text"
    },
    {
        "fg": "hud-fg",
        "bg": "hud",
        "kind": "text"
    },
    {
        "fg": "hud-fg-muted",
        "bg": "hud",
        "kind": "text"
    },
    {
        "fg": "hud-fg-strong",
        "bg": "hud",
        "kind": "text"
    },
    {
        "fg": "warning",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "warning-text",
        "bg": "warning-bg",
        "kind": "text"
    },
    {
        "fg": "error",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "error-text",
        "bg": "error-bg",
        "kind": "text"
    },
    {
        "fg": "success",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "success-text",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "info",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "info-text",
        "bg": "info-bg",
        "kind": "text"
    },
    {
        "fg": "experimental",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "code-fg",
        "bg": "code-block-bg",
        "kind": "text"
    },
    {
        "fg": "code-muted",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "code-name",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "code-attr",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "code-string",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "code-syntax-text",
        "bg": "surface-sunken",
        "kind": "text"
    },
    {
        "fg": "code-syntax-comment",
        "bg": "surface-sunken",
        "kind": "text"
    },
    {
        "fg": "code-syntax-string",
        "bg": "surface-sunken",
        "kind": "text"
    },
    {
        "fg": "code-syntax-number",
        "bg": "surface-sunken",
        "kind": "text"
    },
    {
        "fg": "code-syntax-keyword",
        "bg": "surface-sunken",
        "kind": "text"
    },
    {
        "fg": "code-syntax-type",
        "bg": "surface-sunken",
        "kind": "text"
    },
    {
        "fg": "code-syntax-directive",
        "bg": "surface-sunken",
        "kind": "text"
    },
    {
        "fg": "code-syntax-function",
        "bg": "surface-sunken",
        "kind": "text"
    },
    {
        "fg": "code-syntax-param",
        "bg": "surface-sunken",
        "kind": "text"
    },
    {
        "fg": "code-syntax-link",
        "bg": "surface-sunken",
        "kind": "text"
    },
    {
        "fg": "code-syntax-error",
        "bg": "surface-sunken",
        "kind": "text"
    },
    {
        "fg": "code-syntax-highlight",
        "bg": "code-syntax-assist-selected",
        "kind": "text"
    },
    {
        "fg": "code-syntax-highlight",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "code-syntax-function",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "code-syntax-param",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "code-inline-fg",
        "bg": "surface-sunken",
        "kind": "text"
    },
    {
        "fg": "line-strong",
        "bg": "surface-raised",
        "kind": "ui"
    },
    {
        "fg": "line-strong",
        "bg": "surface-sunken",
        "kind": "ui"
    },
    {
        "fg": "line",
        "bg": "surface-base",
        "kind": "decorative"
    },
    {
        "fg": "hud-line",
        "bg": "hud",
        "kind": "ui"
    },
    {
        "fg": "focus",
        "bg": "surface-base",
        "kind": "ui"
    },
    {
        "fg": "focus",
        "bg": "surface-raised",
        "kind": "ui"
    },
    {
        "fg": "focus",
        "bg": "surface-sunken",
        "kind": "ui"
    },
    {
        "fg": "accent-base",
        "bg": "surface-raised",
        "kind": "ui"
    },
    {
        "fg": "on-accent",
        "bg": "accent-base",
        "kind": "ui"
    },
    {
        "fg": "progress",
        "bg": "surface-raised",
        "kind": "ui"
    },
    {
        "fg": "scrollbar-thumb",
        "bg": "scrollbar-track",
        "kind": "ui"
    },
    {
        "fg": "graph-edge-selected",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "graph-node-selected",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "graph-node-line",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "graph-grid",
        "bg": "graph-canvas",
        "kind": "decorative"
    },
    {
        "fg": "builder-stage-grid",
        "bg": "builder-stage",
        "kind": "decorative"
    },
    {
        "fg": "hud-selection",
        "bg": "stage",
        "kind": "decorative"
    },
    {
        "fg": "stage-fg-muted",
        "bg": "stage",
        "kind": "text"
    },
    {
        "fg": "stage-fg-subtle",
        "bg": "stage",
        "kind": "text"
    },
    {
        "fg": "type-boolean",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-boolean",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-bsdf",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-bsdf",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-color3",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-color3",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-color4",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-color4",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-displacementshader",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-displacementshader",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-edf",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-edf",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-filename",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-filename",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-float",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-float",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-integer",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-integer",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-lightshader",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-lightshader",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-material",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-material",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-matrix33",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-matrix33",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-matrix44",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-matrix44",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-string",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-string",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-surfaceshader",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-surfaceshader",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-vector2",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-vector2",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-vector3",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-vector3",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-vector4",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-vector4",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-vdf",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-vdf",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-volumeshader",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-volumeshader",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-node",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-node",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-nodegraph",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-nodegraph",
        "bg": "graph-canvas",
        "kind": "ui"
    },
    {
        "fg": "type-untyped",
        "bg": "graph-node",
        "kind": "ui"
    },
    {
        "fg": "type-untyped",
        "bg": "graph-canvas",
        "kind": "ui"
    }
,
    {
        "fg": "line-control",
        "bg": "surface-sunken",
        "kind": "ui"
    },
    {
        "fg": "line-control",
        "bg": "surface-raised",
        "kind": "ui"
    },
    {
        "fg": "line-control",
        "bg": "surface-base",
        "kind": "ui"
    },
    {
        "fg": "accent-text-on-tint",
        "bg": "surface-raised",
        "kind": "text"
    },
    {
        "fg": "on-accent",
        "bg": "accent-fill-translucent",
        "kind": "text",
        "alphaParam": ["alpha", "accentFillTranslucent"],
        "under": "surface-raised"
    },
    {
        "fg": "on-accent",
        "bg": "accent-fill-translucent-hover",
        "kind": "text",
        "alphaParam": ["alpha", "accentFillTranslucent"],
        "under": "surface-raised"
    }
];

// Dark-theme failures allowed to remain ("fg|bg"). Empty: dark enforces AA. check-theme-contrast fails on any dark failure not listed.
export const knownDarkFailures = [];

// Presets resolved by scripts/build-theme.mjs through js/shared/theme-engine.js (deriveTheme, then enforceContrast
// at the registry's contrast level) into js/gen/themes/<id>.css and .js. Every non-dark, non-light registry id needs
// one. seeds and overrides are partial: a missing seed comes from the base theme, a missing token from its recipe.
export const presets = {
    "hc-dark": {
        base: "dark",
        seeds: { background: "#000000", foreground: "#ffffff", accent: "#3b82f6" },
        params: { alpha: { hudPopover: 1, accentFillTranslucent: 1 } },
        overrides: {
            "line-subtle": "#525252",
            "line": "#737373",
            "line-control": "#a3a3a3",
            "line-strong": "#a3a3a3",
            "line-heavy": "#d4d4d4",
            "hud-line": "#a3a3a3",
            "notice-line": "#a3a3a3",
            "graph-node-line": "#a3a3a3",
            "graph-node-line-iface": "#d4d4d4",
            "scrollbar-thumb": "#a3a3a3",
            "focus": "#93c5fd",
            "accent-fill": "#1e40af",
            "accent-fill-hover": "#1e3a8a",
            "accent-fill-pressed": "#172554",
            "accent-fill-translucent": "#1e40af",
            "accent-fill-translucent-hover": "#1e3a8a",
            "selection": "#1e40af",
            "success-fill": "#166534",
            "error-fill": "#991b1b",
            "error-fill-hover": "#7f1d1d",
        },
    },
    "hc-light": {
        base: "light",
        seeds: { background: "#ffffff", foreground: "#000000", accent: "#1d4ed8" },
        params: { alpha: { hudPopover: 1, accentFillTranslucent: 1 } },
        overrides: {
            "accent-base": "#1d4ed8",
            "line-subtle": "#a3a3a3",
            "line": "#737373",
            "line-control": "#404040",
            "line-strong": "#404040",
            "line-heavy": "#262626",
            "hud-line": "#404040",
            "notice-line": "#404040",
            "graph-node-line": "#525252",
            "graph-node-line-iface": "#262626",
            "scrollbar-thumb": "#525252",
            "focus": "#1d4ed8",
            "accent-fill": "#1e40af",
            "accent-fill-hover": "#1e3a8a",
            "accent-fill-pressed": "#172554",
            "accent-fill-translucent": "#1e40af",
            "accent-fill-translucent-hover": "#1e3a8a",
            "selection": "#1d4ed8",
            "success-fill": "#166534",
            "error-fill": "#991b1b",
            "error-fill-hover": "#7f1d1d",
        },
    },
    "dim": {
        base: "dark",
        seeds: { background: "#1f2430", foreground: "#e3e7ee", accent: "#4c8df6" },
        overrides: {
            "accent-fill": "#2563eb",
            "accent-fill-translucent": "#2563eb",
            "success-fill": "#15803d",
        },
    },
    "paper": {
        base: "light",
        seeds: { background: "#f4efe6", foreground: "#2a2520", accent: "#2b5bd7" },
        overrides: {},
    },
};

// Runtime sources (registry base auto), resolved in the browser by js/shared/theme-engine.js. build-theme.mjs writes
// js/gen/themes/<id>.js with these overrides (per derived base) and the contrast pairs; the level is the registry's.
// vscode: the editor's colors as seeds (engine VSCODE_VARS); success-fill as in dim so white text keeps AA.
export const sources = {
    "vscode": {
        overrides: {
            dark: { "success-fill": "#15803d" },
            light: {},
        },
    },
};

// Human labels for the custom theme editor (js/gen/theme-groups.js): one per group in menu order, one per token.
// type-* tokens without an entry use their MaterialX type name (the role). build-theme.mjs fails on a missing label.
export const groupLabels = {
    surface: "Surfaces",
    line: "Borders",
    text: "Text",
    accent: "Accent",
    status: "Status",
    experimental: "Experimental",
    hud: "Over renders",
    misc: "Shadow, scrollbars and logo",
    code: "Code",
    graph: "Graph editor",
    type: "Value types",
    native: "Desktop window",
    drift: "Legacy variants",
};

export const labels = {
    "surface-base": "Page background",
    "surface-raised": "Panels and cards",
    "surface-sunken": "Inputs and wells",
    "chrome": "Toolbars and header",
    "control": "Buttons at rest",
    "chip": "Tags and badges",
    "stage": "Behind renders",
    "stage-fg-muted": "Text on the render stage",
    "stage-fg-subtle": "Hints on the render stage",
    "veil": "Loading covers",
    "scrim": "Dialog backdrop",
    "hover": "Hover",
    "hover-subtle": "Hover, subtle",
    "hover-strong": "Hover, strong",
    "pressed": "Pressed",
    "line": "Borders",
    "line-control": "Control outlines",
    "line-subtle": "Dividers",
    "line-strong": "Borders, strong",
    "line-heavy": "Borders, heavy",
    "fg-strong": "Headings",
    "fg": "Text",
    "fg-soft": "Labels and values",
    "fg-secondary": "Secondary text",
    "fg-muted": "Muted text",
    "fg-subtle": "Captions and placeholders",
    "fg-faint": "Faint text",
    "fg-disabled": "Disabled text",
    "fg-inverse": "Text on light fills",
    "accent-base": "Accent",
    "accent-fill": "Primary buttons",
    "accent-fill-translucent": "Primary buttons, translucent",
    "accent-fill-hover": "Primary button hover",
    "accent-fill-translucent-hover": "Translucent button hover",
    "accent-fill-pressed": "Primary button pressed",
    "accent-wash": "Accent tints",
    "accent-fg": "Links",
    "accent-fg-strong": "Active tabs and link hover",
    "accent-fg-bright": "Text on accent tints",
    "on-accent": "Text on accent fills",
    "on-accent-muted": "Secondary text on accent fills",
    "accent-text-on-tint": "Text on faint accent tints",
    "selection": "Selected rows",
    "focus": "Focus ring",
    "progress": "Progress and spinners",
    "drop-target": "Drop target",
    "hover-accent": "Accent row hover",
    "success": "Success",
    "success-text": "Success text on tints",
    "success-hue": "Success tints and borders",
    "success-fill": "Success fill",
    "success-bg": "Success background",
    "success-border": "Success border",
    "warning": "Warning",
    "warning-text": "Warning banner text",
    "warning-text-strong": "Warning text, strong",
    "warning-marker": "Warning markers",
    "warning-hue": "Warning tints and borders",
    "warning-bg": "Warning background",
    "warning-border": "Warning border",
    "error": "Error",
    "error-text": "Error message text",
    "error-hue": "Error borders and icons",
    "error-fill": "Danger button",
    "error-fill-hover": "Danger button hover",
    "error-bg": "Error background",
    "error-border": "Error border",
    "info": "Info",
    "info-text": "Info banner text",
    "info-bg": "Info background",
    "info-border": "Info border",
    "experimental": "Experimental badge text",
    "experimental-hue": "Experimental badge border",
    "hud": "Pill background",
    "hud-raised": "Toolbar buttons",
    "hud-line": "Pill borders",
    "hud-fg": "Pill text",
    "hud-fg-muted": "Pill text, muted",
    "hud-fg-strong": "Pill text, strong",
    "hud-hover": "Pill hover",
    "hud-selection": "Selection outline",
    "shadow": "Shadows",
    "scrollbar-track": "Scrollbar track",
    "scrollbar-thumb": "Scrollbar thumb",
    "brand-mark": "Logo mark",
    "brand-accent": "Logo accent",
    "brand-logo-inner": "Logo inner shape",
    "code-fg": "Code text",
    "code-muted": "Code tags and comments",
    "code-name": "Code element names",
    "code-attr": "Code attributes",
    "code-string": "Code strings",
    "code-inline-bg": "Inline code background",
    "code-inline-fg": "Inline code values",
    "code-block-bg": "Code block background",
    "code-syntax-text": "Syntax text",
    "code-syntax-comment": "Syntax comments",
    "code-syntax-string": "Syntax strings",
    "code-syntax-number": "Syntax numbers",
    "code-syntax-keyword": "Syntax keywords",
    "code-syntax-type": "Syntax types",
    "code-syntax-directive": "Syntax directives",
    "code-syntax-function": "Syntax functions",
    "code-syntax-param": "Syntax parameters",
    "code-syntax-link": "Syntax link",
    "code-syntax-error": "Syntax errors",
    "code-syntax-caret": "Code caret",
    "code-syntax-selection": "Code selection",
    "code-syntax-highlight": "Assist highlight",
    "code-syntax-assist-selected": "Assist selected row",
    "graph-canvas": "Canvas",
    "graph-grid": "Grid",
    "builder-stage": "Embed Builder stage",
    "builder-stage-grid": "Embed Builder grid",
    "graph-edge-draft": "Connection being drawn",
    "graph-edge-selected": "Selected connection",
    "graph-node": "Node body",
    "graph-node-header": "Node header",
    "graph-node-line": "Node border",
    "graph-node-line-iface": "Interface node border",
    "graph-node-selected": "Selected node",
    "graph-minimap-bg": "Minimap background",
    "graph-minimap-mask": "Minimap mask",
    "graph-minimap-stroke": "Minimap node outline",
    "type-untyped": "untyped",
    "native-window-bg": "Window background",
    "native-titlebar": "Title bar",
    "native-titlebar-symbol": "Title bar buttons",
    "surface-deep": "Deep wells",
    "scrim-alt": "Sidebar dialog backdrop",
    "on-accent-soft": "Soft text on accent fills",
    "warning-bg-strong": "Warning action button",
    "warning-border-alt": "Warning toast border",
    "notice-bg": "Notice background",
    "notice-line": "Notice border",
    "notice-text": "Notice text",
    "notice-text-strong": "Notice text, strong",
    "experimental-fill": "Experimental badge fill",
    "code-inline-fg-alt": "Help inline code",
    "code-block-bg-alt": "Help code block background",
};
