// actionsModel.js: pure row list plus message/about-data helpers for the
// materialxPlayground.actions view. No vscode dependency, same split as
// outlineModel.js/outlineView.js, so all of this stays unit-testable
// without booting the extension host. The webview-based actionsView.js
// renders these rows as full-width buttons; `icon` is a
// js/shared/ui-commons.js icon key (inlined as SVG path data in
// media/actions-view.js, no icon font) and `variant` picks the button's
// visual weight.
'use strict';

// newFromExample no longer runs a command: the button toggles the
// examples card grid embedded directly below it in the same webview
// (media/actions-view.js), remembered via the webview state API. `toggle`
// marks which panel a row shows/hides; every other row keeps its plain
// `command`.
const ROWS = [
    { id: 'newFromExample', label: 'New Material from Example', icon: 'sparkles', variant: 'primary', toggle: 'examples' },
    { id: 'newDocument', label: 'New MaterialX Document', icon: 'file-plus', variant: 'default', command: 'materialxPlayground.newDocument' },
    { id: 'openDocs', label: 'Node Library Documentation', icon: 'book', variant: 'default', command: 'materialxPlayground.openDocs' },
    { id: 'openInGraphEditor', label: 'Open in Graph Editor', icon: 'share', variant: 'default', command: 'materialxPlayground.openInGraphEditor', requiresDocument: true },
    { id: 'openInMaterialViewer', label: 'Open in Material Viewer', icon: 'eye', variant: 'default', command: 'materialxPlayground.openInMaterialViewer', requiresDocument: true },
    { id: 'filterDocsByFile', label: 'Filter Node Docs by Current File', icon: 'color-filter', variant: 'secondary', command: 'materialxPlayground.filterDocsByFile' },
];

// buildActionRows(hasActiveDocument): the two "Open in ..." rows are
// disabled (no command, a description) when no MaterialX document is
// active; everything else is always available.
function buildActionRows(hasActiveDocument) {
    return ROWS.map((row) => {
        const disabled = !!row.requiresDocument && !hasActiveDocument;
        return {
            id: row.id,
            label: row.label,
            icon: row.icon,
            variant: row.variant,
            toggle: row.toggle || null,
            command: disabled ? null : (row.command || null),
            disabled,
            description: disabled ? 'Open a MaterialX file first' : undefined,
        };
    });
}

// Every message type the actions webview may ever send. actionsView.js's
// _handleMessage rejects anything else before any per-type handling runs
// -- 'run' additionally validates its own id against known rows/card ids,
// 'github' never trusts a URL from the message itself.
const MESSAGE_TYPES = new Set(['ready', 'run', 'toggleExamples', 'about', 'github', 'rendered']);
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
        licenseError: !!licenseError,
    };
}

module.exports = { buildActionRows, isValidMessageType, buildAboutData };
