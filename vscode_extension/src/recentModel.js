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

module.exports = { pushRecentEntry, MAX_ITEMS };
