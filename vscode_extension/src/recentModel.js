// recentModel.js: pure list op behind the materialxPlayground.recent view
// (recentView.js). No vscode dependency, same split as
// outlineModel.js/outlineView.js.
'use strict';

const MAX_ITEMS = 10;

// pushRecentEntry(list, entry, maxItems): entry moves to the front,
// de-duplicated by uri, capped at maxItems.
function pushRecentEntry(list, entry, maxItems) {
    const next = (list || []).filter((e) => e.uri !== entry.uri);
    next.unshift(entry);
    return next.slice(0, maxItems == null ? MAX_ITEMS : maxItems);
}

const EDITOR_VIEW_TYPE = 'materialxPlayground.editor';
const SCENE_VIEW_TYPE = 'materialxPlayground.sceneViewer';

// recentKindForTab({ input: 'text'|'custom', viewType, scheme, path }): the
// Recent kind a newly opened tab records ('mtlx', 'scene') or null. Tab opens,
// not onDidOpenTextDocument, since a still-cached document reopens silently.
function recentKindForTab(tab) {
    if (!tab || tab.scheme !== 'file') return null;
    if (tab.input === 'custom') {
        if (tab.viewType === SCENE_VIEW_TYPE) return 'scene';
        if (tab.viewType === EDITOR_VIEW_TYPE) return 'mtlx';
        return null;
    }
    if (tab.input === 'text' && /\.mtlx$/i.test(tab.path || '')) return 'mtlx';
    return null;
}

module.exports = { pushRecentEntry, recentKindForTab, MAX_ITEMS };
