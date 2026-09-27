// actionsModel.js: pure row list for the materialxPlayground.actions view.
// No vscode dependency, same split as outlineModel.js/outlineView.js, so
// the row shape is unit-testable without booting the extension host.
// The webview-based actionsView.js renders these rows as full-width
// buttons; `icon` is a js/shared/ui-commons.js icon key (inlined as SVG
// path data in media/actions-view.js, no icon font) and `variant` picks
// the button's visual weight.
'use strict';

// newFromExample runs the auto-generated "reveal and focus" command for
// the Examples sidebar view (materialxPlayground.examples) instead of the
// materialxPlayground.newFromExample command -- the Command Palette entry
// and the Explorer folder context menu still run that command directly,
// since only they know the target folder to hand the gallery tab.
const ROWS = [
    { id: 'newFromExample', label: 'New Material from Example', icon: 'sparkles', variant: 'primary', command: 'materialxPlayground.examples.focus' },
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
            command: disabled ? null : row.command,
            disabled,
            description: disabled ? 'Open a MaterialX file first' : undefined,
        };
    });
}

module.exports = { buildActionRows };
