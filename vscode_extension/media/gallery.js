// gallery.js: webview-side script for the "New Material from Example"
// panel. Renders the groups the host sends in an 'init'/'update' message
// as a card grid, filters them client-side by the search box, and posts
// {type:'run', id} back to the host on a card click or Enter -- the host
// re-validates that id against its own current group list before running
// anything (see exampleGallery.js's handleMessage). Plain DOM, no
// frameworks, matches embed/viewer.html's dependency-free style.
(function () {
    const vscode = acquireVsCodeApi();

    const groupsEl = document.getElementById('mtlx-gallery-groups');
    const emptyEl = document.getElementById('mtlx-gallery-empty');
    const searchEl = document.getElementById('mtlx-gallery-search');

    let allGroups = []; // as sent by the host, never mutated

    function filterGroups(groups, query) {
        const q = (query || '').trim().toLowerCase();
        if (!q) return groups;
        const out = [];
        for (const group of groups) {
            const cards = group.cards.filter((c) =>
                c.label.toLowerCase().includes(q) ||
                c.shadingModel.toLowerCase().includes(q) ||
                c.license.toLowerCase().includes(q)
            );
            if (cards.length) out.push({ source: group.source, cards });
        }
        return out;
    }

    function buildCard(card) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mtlx-gallery-card';
        btn.setAttribute('role', 'listitem');
        btn.setAttribute('aria-label', card.label + ', ' + card.shadingModel + ', ' + card.license);

        if (card.thumbUri) {
            const img = document.createElement('img');
            img.className = 'mtlx-gallery-thumb';
            img.src = card.thumbUri;
            img.loading = 'lazy';
            img.alt = '';
            btn.appendChild(img);
        } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'mtlx-gallery-thumb-placeholder';
            placeholder.textContent = (card.label.trim().charAt(0) || '?').toUpperCase();
            placeholder.setAttribute('aria-hidden', 'true');
            btn.appendChild(placeholder);
        }

        const body = document.createElement('div');
        body.className = 'mtlx-gallery-card-body';

        const name = document.createElement('div');
        name.className = 'mtlx-gallery-card-name';
        name.textContent = card.label;
        body.appendChild(name);

        const meta = document.createElement('div');
        meta.className = 'mtlx-gallery-card-meta';
        meta.textContent = card.shadingModel + ' · ' + card.license;
        body.appendChild(meta);

        btn.appendChild(body);

        btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'run', id: card.id });
        });

        return btn;
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
                grid.appendChild(buildCard(card));
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
        render(filterGroups(allGroups, searchEl.value));
    });

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || (msg.type !== 'init' && msg.type !== 'update') || !Array.isArray(msg.groups)) return;
        allGroups = msg.groups;
        render(filterGroups(allGroups, searchEl.value));
    });

    vscode.postMessage({ type: 'ready' });
}());
