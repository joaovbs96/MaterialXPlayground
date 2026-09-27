// gallery-cards.js: shared card-grid rendering and search filter for the
// "New Material from Example" gallery panel (gallery.js) and the Examples
// sidebar view (examples-view.js) -- one place for the card markup so the
// two webviews don't diverge. Exposes window.MtlxGalleryCards; loaded as
// a plain script before either view's own script.
(function () {
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

    // buildCard(card, onRun): onRun(card.id) is called on click or Enter
    // (native <button> activation); the caller posts the validated message
    // back to its own host, this file never talks to the extension host.
    function buildCard(card, onRun) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mtlx-gallery-card';
        btn.setAttribute('role', 'listitem');
        btn.setAttribute('aria-label', card.label + ', ' + card.shadingModel + ', ' + card.license);
        btn.title = card.label + ' – ' + card.shadingModel + ' – ' + card.license;

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
        btn.addEventListener('click', () => onRun(card.id));
        return btn;
    }

    window.MtlxGalleryCards = { filterGroups: filterGroups, buildCard: buildCard };
}());
