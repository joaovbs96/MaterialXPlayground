// actionsModel.js: pure row list for the materialxPlayground.actions view.
// No vscode dependency, same split as outlineModel.js/outlineView.js, so
// the row shape is unit-testable without booting the extension host.
'use strict';

const ROWS = [
    { id: 'newFromExample', label: 'New Material from Example', icon: 'sparkle', command: 'materialxPlayground.newFromExample' },
    { id: 'newDocument', label: 'New MaterialX Document', icon: 'new-file', command: 'materialxPlayground.newDocument' },
    { id: 'openDocs', label: 'Node Library Documentation', icon: 'book', command: 'materialxPlayground.openDocs' },
    { id: 'openInGraphEditor', label: 'Open in Graph Editor', icon: 'type-hierarchy-sub', command: 'materialxPlayground.openInGraphEditor', requiresDocument: true },
    { id: 'openInMaterialViewer', label: 'Open in Material Viewer', icon: 'eye', command: 'materialxPlayground.openInMaterialViewer', requiresDocument: true },
    { id: 'filterDocsByFile', label: 'Filter Node Docs by Current File', icon: 'filter', command: 'materialxPlayground.filterDocsByFile' },
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
            command: disabled ? null : row.command,
            disabled,
            description: disabled ? 'no MaterialX file open' : undefined,
        };
    });
}

module.exports = { buildActionRows };
