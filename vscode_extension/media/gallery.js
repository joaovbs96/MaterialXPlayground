// gallery.js: webview-side script for the "New Material from Example"
// panel. Renders the card list the host sends in an 'init'/'update' message
// as a filterable grid (search box + family/tag chips, via gallery-cards.js's
// createFilterController), and posts {type:'run', id} back to the host on a
// card click or Enter -- the host re-validates that id against its own
// current card list before running anything (see exampleGallery.js's
// handleMessage). Card markup and the filter toolbar live in gallery-
// cards.js, shared with the Examples sidebar view; this file only owns the
// panel's own DOM ids.
(function () {
    const vscode = acquireVsCodeApi();
    const cardsApi = window.MtlxGalleryCards;

    const toolbarHost = document.getElementById('mtlx-gallery-toolbar-host');
    const gridEl = document.getElementById('mtlx-gallery-grid');
    const emptyEl = document.getElementById('mtlx-gallery-empty');

    function runCard(id) {
        vscode.postMessage({ type: 'run', id: id });
    }

    function renderGrid(filtered) {
        gridEl.textContent = '';
        for (const card of filtered) gridEl.appendChild(cardsApi.buildCard(card, runCard));
        emptyEl.hidden = filtered.length > 0;
    }

    const controller = cardsApi.createFilterController(toolbarHost, [], { compact: false });
    controller.onChange((filtered) => renderGrid(filtered));

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || (msg.type !== 'init' && msg.type !== 'update') || !Array.isArray(msg.cards)) return;
        controller.setCards(msg.cards);
        // Test seam only: a real user session ignores this message, but
        // the packaged-extension smoke run listens for it to confirm the
        // panel actually rendered N cards (see exampleGallery.js's testApi).
        vscode.postMessage({ type: 'rendered', cardCount: msg.cards.length });
    });

    vscode.postMessage({ type: 'ready' });
}());
