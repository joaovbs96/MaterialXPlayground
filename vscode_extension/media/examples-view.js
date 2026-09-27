// examples-view.js: webview-side script for the materialxPlayground.examples
// sidebar view. Renders exampleGalleryModel's groups (sent by the host as
// an 'init'/'update' message) as collapsible sections of cards, using the
// shared card builder from gallery-cards.js, and posts {type:'run', id}
// back to the host on a card click or Enter -- same validated contract as
// gallery.js. Plain DOM, no frameworks.
(function () {
    const vscode = acquireVsCodeApi();
    const cards = window.MtlxGalleryCards;

    const groupsEl = document.getElementById('mtlx-ex-groups');
    const emptyEl = document.getElementById('mtlx-ex-empty');
    const searchEl = document.getElementById('mtlx-ex-search');

    let allGroups = []; // as sent by the host, never mutated
    const collapsedSources = new Set(); // group headings the user collapsed

    function chevronSvg() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6l6 -6"/></svg>';
    }

    function runCard(id) {
        vscode.postMessage({ type: 'run', id: id });
    }

    function buildGroup(group) {
        const section = document.createElement('div');
        section.className = 'mtlx-ex-group';

        const gridId = 'mtlx-ex-grid-' + group.source.replace(/[^a-z0-9]+/gi, '-');
        const expanded = !collapsedSources.has(group.source);

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'mtlx-ex-group-toggle';
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.setAttribute('aria-controls', gridId);

        const chevron = document.createElement('span');
        chevron.className = 'mtlx-ex-chevron';
        chevron.innerHTML = chevronSvg();
        toggle.appendChild(chevron);

        const label = document.createElement('span');
        label.textContent = group.source;
        toggle.appendChild(label);

        const grid = document.createElement('div');
        grid.className = 'mtlx-ex-grid';
        grid.id = gridId;
        grid.setAttribute('role', 'list');
        grid.hidden = !expanded;
        for (const card of group.cards) grid.appendChild(cards.buildCard(card, runCard));

        toggle.addEventListener('click', () => {
            const willExpand = grid.hidden;
            grid.hidden = !willExpand;
            toggle.setAttribute('aria-expanded', String(willExpand));
            if (willExpand) collapsedSources.delete(group.source);
            else collapsedSources.add(group.source);
        });

        section.appendChild(toggle);
        section.appendChild(grid);
        return section;
    }

    function render(groups) {
        groupsEl.textContent = '';
        let cardCount = 0;
        for (const group of groups) {
            groupsEl.appendChild(buildGroup(group));
            cardCount += group.cards.length;
        }
        emptyEl.hidden = cardCount > 0;
        // Test seam only: a real user session ignores this message, but
        // the packaged-extension smoke run listens for it to confirm the
        // view actually rendered N cards (see examplesView.js's testApi).
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
