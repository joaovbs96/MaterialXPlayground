// actionsModel.js: pure row list plus message/about-data helpers for the
// materialxPlayground.actions view. No vscode dependency, same split as
// outlineModel.js/outlineView.js, so all of this stays unit-testable
// without booting the extension host. The webview-based actionsView.js
// renders these rows as full-width buttons; `icon` is a
// js/shared/ui-commons.js icon key (inlined as SVG path data in
// media/actions-view.js, no icon font) and `variant` picks the button's
// visual weight.
'use strict';

// newFromExample and insertNode no longer run a command: each button
// toggles its own group panel embedded directly below it in the same
// webview (media/actions-view.js), remembered via the webview state API.
// `toggle` marks which panel a row shows/hides; every other row keeps its
// plain `command`. insertNode sits directly above newFromExample (task
// batch G1 item 4), both last in the list so opening either group never
// pushes the other action buttons around -- they're all above it already.
// `layout: 'half'` rows render two per row in a CSS grid (actions-view.js/
// css); everything else (the two toggle rows, full width so their panels
// below never fight a neighbor for width) renders full width, unchanged.
// `shortLabel` is what a half-width row shows in the button itself (the
// half column is too narrow for the full label without wrapping); `label`
// stays the full text and is always what aria-label/title expose.
const ROWS = [
    { id: 'newDocument', label: 'New MaterialX Document', shortLabel: 'New Document', icon: 'file-plus', variant: 'default', command: 'materialxPlayground.newDocument', layout: 'half' },
    { id: 'openDocs', label: 'Node Library Documentation', shortLabel: 'Node Docs', icon: 'book', variant: 'default', command: 'materialxPlayground.openDocs', layout: 'half' },
    { id: 'openInMaterialViewer', label: 'Open in Material Viewer', shortLabel: 'Material Viewer', icon: 'eye', variant: 'default', command: 'materialxPlayground.openInMaterialViewer', requiresDocument: true, layout: 'half' },
    { id: 'openInGraphEditor', label: 'Open in Graph Editor', shortLabel: 'Graph Editor', icon: 'share', variant: 'default', command: 'materialxPlayground.openInGraphEditor', requiresDocument: true, layout: 'half' },
    { id: 'filterDocsByFile', label: 'Filter Node Docs by Current File', shortLabel: 'Filter Docs by File', icon: 'color-filter', variant: 'secondary', command: 'materialxPlayground.filterDocsByFile', requiresDocument: true, layout: 'half' },
    {
        id: 'insertNode', label: 'Insert Node', icon: 'puzzle', variant: 'primary', toggle: 'insertNode',
        requiresTextEditor: true, disabledDescription: 'Open a .mtlx file in the text editor to insert nodes.',
    },
    { id: 'newFromExample', label: 'New Material from Example', icon: 'sparkles', variant: 'primary', toggle: 'examples' },
];

// buildActionRows(hasActiveDocument, hasMtlxTextEditor): rows marked
// requiresDocument are disabled (no command, a tooltip) when no MaterialX
// document is active (a text editor OR our own custom editor tab);
// insertNode is instead gated on hasMtlxTextEditor alone -- inserting at a
// cursor needs an actual visible .mtlx TEXT editor, our custom editor tab
// has no text cursor to insert at. Everything else is always available.
// The disabled tooltip text is row-specific (disabledDescription) or the
// shared default.
function buildActionRows(hasActiveDocument, hasMtlxTextEditor) {
    return ROWS.map((row) => {
        const disabled = row.requiresTextEditor
            ? !hasMtlxTextEditor
            : (!!row.requiresDocument && !hasActiveDocument);
        return {
            id: row.id,
            label: row.label,
            shortLabel: row.shortLabel || null,
            icon: row.icon,
            variant: row.variant,
            layout: row.layout || null,
            toggle: row.toggle || null,
            command: disabled ? null : (row.command || null),
            disabled,
            description: disabled ? (row.disabledDescription || 'Open a MaterialX file first') : undefined,
        };
    });
}

// Every message type the actions webview may ever send. actionsView.js's
// _handleMessage rejects anything else before any per-type handling runs
// -- 'run' additionally validates its own id against known rows/card ids,
// 'github'/'openHelpLink' never trust a URL from the message itself,
// 'insertNode' never trusts a category beyond the host's own known set.
const MESSAGE_TYPES = new Set([
    'ready', 'run', 'toggleExamples', 'toggleInsertNode', 'insertNode',
    'about', 'github', 'rendered', 'openHelpLink', 'setTheme',
]);

// nextGroupExpansion(current, which, expanded): pure reducer for the two
// mutually exclusive expandable groups (Insert Node, New Material from
// Example) -- expanding one always collapses the other; collapsing one
// never expands the other. `current` is {examples, insertNode} booleans,
// `which` is 'examples'|'insertNode'. Mirrored by hand in
// media/actions-view.js (a plain browser script, not requirable here);
// keep both in sync.
function nextGroupExpansion(current, which, expanded) {
    if (!expanded) return Object.assign({}, current, { [which]: false });
    const next = { examples: false, insertNode: false };
    next[which] = true;
    return next;
}

// decideColumnLayout(mode, truncated, streak): pure hysteresis step for the
// action grid's two-column/one-column decision (task batch G1 item 3,
// replacing the old fixed 260px media query). `mode` is the CURRENT layout
// ('two'|'single'), `truncated` is whether media/actions-view.js just
// measured a half-width label's scrollWidth exceeding its clientWidth in a
// two-column layout at the current width, `streak` counts consecutive
// readings that disagree with `mode`. Only flips once that disagreement has
// held for STREAK_THRESHOLD readings in a row, so one boundary-jitter
// measurement (e.g. a scrollbar appearing/disappearing) can't flap the
// layout back and forth. Mirrored by hand in media/actions-view.js; keep
// both in sync.
const LAYOUT_STREAK_THRESHOLD = 2;
function decideColumnLayout(mode, truncated, streak) {
    const wants = truncated ? 'single' : 'two';
    if (wants === mode) return { mode, streak: 0 };
    const nextStreak = (streak || 0) + 1;
    if (nextStreak >= LAYOUT_STREAK_THRESHOLD) return { mode: wants, streak: 0 };
    return { mode, streak: nextStreak };
}

// The three header overflow-menu items (Tutorials, Report an Issue,
// What's New); actionsView.js's _handleMessage rejects any other id.
const HELP_LINK_IDS = new Set(['tutorials', 'reportIssue', 'whatsNew']);
function isValidHelpLinkId(id) {
    return typeof id === 'string' && HELP_LINK_IDS.has(id);
}

// A readable OS name for the "Report an issue" prefilled body, from
// Node's process.platform. Pure so it's directly unit-testable.
function platformLabel(nodePlatform) {
    if (nodePlatform === 'win32') return 'Windows';
    if (nodePlatform === 'darwin') return 'macOS';
    if (nodePlatform === 'linux') return 'Linux';
    return nodePlatform || 'unknown';
}

// buildIssueUrl: a GitHub "new issue" URL with a title/body prefilled
// from the same version facts the About overlay shows, everything
// URL-encoded. `platform` is already a readable label (platformLabel).
function buildIssueUrl({ repoUrl, extensionVersionText, vscodeVersion, mtlxVersion, platform }) {
    const title = 'Issue with MaterialX Playground ' + (extensionVersionText || '');
    const body = [
        '**Describe the issue**',
        '',
        '',
        '---',
        'Extension: ' + (extensionVersionText || 'n/a'),
        'VS Code: ' + (vscodeVersion || 'n/a'),
        'MaterialX: ' + (mtlxVersion || 'n/a'),
        'OS: ' + (platform || 'n/a'),
    ].join('\n');
    return repoUrl + '/issues/new?title=' + encodeURIComponent(title.trim()) + '&body=' + encodeURIComponent(body);
}
function isValidMessageType(type) {
    return typeof type === 'string' && MESSAGE_TYPES.has(type);
}

// Hand-vendored assets not tracked in js/gen/vendor-deps.js. Mirrors (by
// hand -- js/shell.jsx is a browser file, not requirable here) the
// relevant entries of js/shell.jsx's STATIC_LIBRARIES; keep both in sync.
const STATIC_LIBRARIES = [
    { name: 'MaterialX', licenseUrl: 'https://github.com/AcademySoftwareFoundation/MaterialX/blob/HEAD/LICENSE' },
    { name: 'Tabler Icons', licenseUrl: 'https://github.com/tabler/tabler-icons/blob/HEAD/LICENSE' },
    { name: 'MaterialX logo (Academy Software Foundation)', licenseUrl: 'https://github.com/AcademySoftwareFoundation/artwork' },
];

// reflowLicenseText: turns a hard-wrapped license file's text into an
// array of paragraph strings, so the About overlay can render it as
// normal wrapping text instead of the file's own ~80-column line breaks.
// Paragraphs are separated by blank lines; the lines within one are
// joined with a single space (collapsing the file's leading indent),
// which already keeps every numbered section ("1. Definitions.") and
// list item ("(a) ...") on its own line in a well-formed license file --
// they're blank-line-separated in the source too. The one case blank
// lines alone don't cover is a centered title block (e.g. "Apache
// License" / "Version 2.0, January 2004" / a URL, stacked with no blank
// lines between them): a line indented past TITLE_INDENT is treated as
// its own paragraph even without a blank line around it.
const TITLE_INDENT = 15;
function reflowLicenseText(text) {
    if (!text) return [];
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    const paragraphs = [];
    let current = [];
    const flush = () => {
        if (current.length) {
            paragraphs.push(current.join(' ').replace(/\s+/g, ' ').trim());
            current = [];
        }
    };
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) { flush(); continue; }
        const indent = rawLine.length - rawLine.trimStart().length;
        if (indent >= TITLE_INDENT) {
            flush();
            paragraphs.push(trimmed);
            continue;
        }
        current.push(trimmed);
    }
    flush();
    return paragraphs.filter(Boolean);
}

// buildAboutData: pure assembly of the About overlay's payload from
// already-resolved inputs -- actionsView.js reads the extension/vscode/
// MaterialX versions and the vendor-deps registry from disk, this stays
// testable without vscode. Mirrors js/shell.jsx's AboutDialog: entries
// marked vscode:false in vendor-deps.js are skipped, exactly as the app
// does inside VS Code (buildVendorEntries there).
function buildAboutData({ extensionVersion, vscodeVersion, mtlxTag, vendorDeps, repoUrl, issuesUrl, license, licenseError }) {
    const deps = vendorDeps || {};
    const vendorEntries = Object.keys(deps)
        .filter((id) => deps[id].vscode !== false)
        .map((id) => ({ name: deps[id].name, licenseUrl: deps[id].licenseUrl }))
        .concat(STATIC_LIBRARIES)
        .reduce((out, lib) => {
            if (!out.some((l) => l.name === lib.name)) out.push(lib);
            return out;
        }, [])
        .sort((a, b) => a.name.localeCompare(b.name));

    return {
        extensionVersionText: extensionVersion ? 'v' + extensionVersion : 'n/a',
        vscodeVersion: vscodeVersion || 'n/a',
        mtlxVersion: mtlxTag || null,
        mtlxReleaseUrl: mtlxTag
            ? 'https://github.com/AcademySoftwareFoundation/MaterialX/releases/tag/' + mtlxTag
            : null,
        vendorEntries,
        repoUrl: repoUrl || null,
        issuesUrl: issuesUrl || null,
        // Plain text (no embedded links): the app's HTML disclaimer isn't
        // reusable outside a DOM-injection path this CSP disallows; the
        // link row above already surfaces the repository link.
        disclaimer: {
            experimental: 'Experimental preview: this extension is under active development, 3D previews and parameter values may not match reference renders. Spotted a problem? Report it in the project repository.',
            affiliation: 'This extension is an independent, open-source project and is not officially affiliated with MaterialX or the Academy Software Foundation. In the event of any discrepancies, the specification in the official MaterialX repository remains the definitive source of truth.',
        },
        license: license || null,
        licenseParagraphs: license ? reflowLicenseText(license) : [],
        licenseError: !!licenseError,
    };
}

module.exports = {
    buildActionRows, isValidMessageType, buildAboutData, reflowLicenseText,
    isValidHelpLinkId, platformLabel, buildIssueUrl,
    nextGroupExpansion, decideColumnLayout,
};
