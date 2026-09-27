// gallery.js: webview-side script for the "New Material from Example"
// panel. Renders the groups the host sends in an 'init'/'update' message
// as a card grid, filters them client-side by the search box, and posts
// {type:'run', id} back to the host on a card click or Enter -- the host
// re-validates that id against its own current group list before running
// anything (see exampleGallery.js's handleMessage). Card markup and the
// filter itself live in gallery-cards.js, shared with the Examples
// sidebar view; this file only owns the panel's own DOM ids.
(function () {
    const vscode = acquireVsCodeApi();
    const cards = window.MtlxGalleryCards;

    const groupsEl = document.getElementById('mtlx-gallery-groups');
    const emptyEl = document.getElementById('mtlx-gallery-empty');
    const searchEl = document.getElementById('mtlx-gallery-search');

    let allGroups = []; // as sent by the host, never mutated

    function runCard(id) {
        vscode.postMessage({ type: 'run', id: id });
    }

    function render(groups) {
        groupsEl.textContent = '';
        let cardCount = 0;
        for (const group of groups) {
            const section = document.createElement('div');
            section.className = 'mtlx-gallery-group';

            const title = document.createElement('h2');
            title.className = 'mtlx-gallery-group-title';
            title.textContent = group.source;
            section.appendChild(title);

            const grid = document.createElement('div');
            grid.className = 'mtlx-gallery-grid';
            for (const card of group.cards) {
                grid.appendChild(cards.buildCard(card, runCard));
                cardCount++;
            }
            section.appendChild(grid);
            groupsEl.appendChild(section);
        }
        emptyEl.hidden = cardCount > 0;
        // Test seam only: a real user session ignores this message, but
        // the packaged-extension smoke run listens for it to confirm the
        // panel actually rendered N cards (see exampleGallery.js's testApi).
        vscode.postMessage({ type: 'rendered', cardCount: cardCount });
    }

    searchEl.addEventListener('input', () => {
        render(cards.filterGroups(allGroups, searchEl.value));
    });

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || (msg.type !== 'init' && msg.type !== 'update') || !Array.isArray(msg.groups)) return;
        allGroups = msg.groups;
        render(cards.filterGroups(allGroups, searchEl.value));
    });

    vscode.postMessage({ type: 'ready' });
}());
