// gallery-cards.js: shared card-grid rendering and the search/family/tag
// filter toolbar for the "New Material from Example" gallery panel
// (gallery.js) and the Examples sidebar view (actions-view.js) -- one
// place for the card markup and filter logic so the two webviews don't
// diverge. Mirrors exampleGalleryModel.js's filter semantics (that Node
// module is what tests/unit exercises; this is its browser-side twin,
// same idiom as actions-view.js's own nextGroupExpansion duplication).
// Exposes window.MtlxGalleryCards; loaded as a plain script before either
// view's own script.
(function () {
    // Chip order/labels, the Material Gallery's own display order
    // (js/gallery-app.jsx's GALLERY_FAMILY_ORDER/GALLERY_TAG_FILTERS).
    const GALLERY_FAMILY_ORDER = [
        { id: 'StandardSurface', label: 'Standard Surface' },
        { id: 'OpenPbr', label: 'OpenPBR' },
        { id: 'GltfPbr', label: 'glTF PBR' },
        { id: 'UsdPreviewSurface', label: 'USD Preview Surface' },
        { id: 'DisneyPrincipled', label: 'Disney Principled' },
        { id: 'SimpleHair', label: 'Simple Hair' },
        { id: 'Playground', label: 'Playground' },
    ];
    const GALLERY_TAG_FILTERS = [
        { id: 'Textured', label: 'Textured' },
        { id: 'Procedural', label: 'Procedural' },
    ];

    function familyChipsFor(cardList) {
        const present = new Set(cardList.map((c) => c.family));
        return [{ id: 'all', label: 'All' }].concat(GALLERY_FAMILY_ORDER.filter((f) => present.has(f.id)));
    }

    function matchesQuery(card, q) {
        if (!q) return true;
        if ((card.label || '').toLowerCase().indexOf(q) !== -1) return true;
        if ((card.familyLabel || '').toLowerCase().indexOf(q) !== -1) return true;
        if ((card.shadingModel || '').toLowerCase().indexOf(q) !== -1) return true;
        if ((card.license || '').toLowerCase().indexOf(q) !== -1) return true;
        return (card.tags || []).some((t) => t.toLowerCase().indexOf(q) !== -1);
    }

    function filterCards(cardList, opts) {
        const o = opts || {};
        const q = (o.query || '').trim().toLowerCase();
        const family = o.family || 'all';
        const tags = o.tags || [];
        return cardList.filter((c) => {
            if (family !== 'all' && c.family !== family) return false;
            if (tags.length && !tags.every((t) => (c.tags || []).indexOf(t) !== -1)) return false;
            return matchesQuery(c, q);
        });
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
        meta.textContent = (card.familyLabel ? card.familyLabel + ' · ' : '') + card.shadingModel;
        body.appendChild(meta);

        btn.appendChild(body);
        btn.addEventListener('click', () => onRun(card.id));
        return btn;
    }

    function buildChip(label, active, isToggle, onClick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mtlx-gallery-chip' + (active ? ' is-active' : '');
        btn.setAttribute(isToggle ? 'aria-pressed' : 'aria-checked', String(active));
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        return btn;
    }

    // createFilterController(container, cardList, { compact }): builds a
    // search box, a single-select family chip row, a multi-select tag chip
    // row and a "N of M materials"/"Clear filters" status line inside
    // `container`. Call .onChange(fn) to receive the filtered list (fn also
    // fires once immediately); .setCards(next) replaces the source list
    // (e.g. once the host posts a later 'state'/'init' message) and
    // re-filters with the current search/chip state kept.
    function createFilterController(container, cardList, opts) {
        const state = { query: '', family: 'all', tags: [] };
        let cards = cardList || [];
        let onChangeFn = function () {};

        const toolbar = document.createElement('div');
        toolbar.className = 'mtlx-gallery-toolbar' + ((opts && opts.compact) ? ' mtlx-gallery-toolbar--compact' : '');

        const searchWrap = document.createElement('div');
        searchWrap.className = 'mtlx-ex-toolbar';
        const uid = 'mtlx-gallery-search-' + Math.random().toString(36).slice(2);
        const searchLabel = document.createElement('label');
        searchLabel.className = 'mtlx-gallery-search-label';
        searchLabel.setAttribute('for', uid);
        searchLabel.textContent = 'Search examples';
        const searchInput = document.createElement('input');
        searchInput.id = uid;
        searchInput.className = 'mtlx-gallery-search';
        searchInput.type = 'text';
        searchInput.autocomplete = 'off';
        searchInput.placeholder = 'Search materials';
        searchInput.title = 'Search by name, family, shading model, license or tag';
        searchWrap.appendChild(searchLabel);
        searchWrap.appendChild(searchInput);

        const familyRow = document.createElement('div');
        familyRow.className = 'mtlx-gallery-chips';
        familyRow.setAttribute('role', 'radiogroup');
        familyRow.setAttribute('aria-label', 'Filter by family');

        const tagRow = document.createElement('div');
        tagRow.className = 'mtlx-gallery-chips';
        tagRow.setAttribute('role', 'group');
        tagRow.setAttribute('aria-label', 'Filter by tag');

        const statusRow = document.createElement('div');
        statusRow.className = 'mtlx-gallery-status';
        const countEl = document.createElement('span');
        countEl.className = 'mtlx-gallery-count';
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'mtlx-gallery-clear';
        clearBtn.textContent = 'Clear filters';
        clearBtn.hidden = true;
        statusRow.appendChild(countEl);
        statusRow.appendChild(clearBtn);

        toolbar.appendChild(searchWrap);
        toolbar.appendChild(familyRow);
        toolbar.appendChild(tagRow);
        toolbar.appendChild(statusRow);
        container.appendChild(toolbar);

        function renderChips() {
            familyRow.textContent = '';
            for (const item of familyChipsFor(cards)) {
                const active = state.family === item.id;
                familyRow.appendChild(buildChip(item.label, active, false, () => {
                    state.family = item.id;
                    update();
                }));
            }
            tagRow.textContent = '';
            for (const item of GALLERY_TAG_FILTERS) {
                const active = state.tags.indexOf(item.id) !== -1;
                tagRow.appendChild(buildChip(item.label, active, true, () => {
                    state.tags = active ? state.tags.filter((t) => t !== item.id) : state.tags.concat([item.id]);
                    update();
                }));
            }
        }

        function update() {
            renderChips();
            const filtered = filterCards(cards, state);
            const isFiltered = state.family !== 'all' || state.tags.length > 0 || state.query.trim() !== '';
            clearBtn.hidden = !isFiltered;
            countEl.textContent = isFiltered
                ? filtered.length + ' of ' + cards.length + ' match' + (filtered.length === 1 ? '' : 'es')
                : cards.length + ' material' + (cards.length === 1 ? '' : 's');
            onChangeFn(filtered, state);
        }

        searchInput.addEventListener('input', () => { state.query = searchInput.value; update(); });
        clearBtn.addEventListener('click', () => {
            state.query = ''; state.family = 'all'; state.tags = [];
            searchInput.value = '';
            update();
        });

        return {
            setCards(next) { cards = next || []; update(); },
            onChange(fn) { onChangeFn = fn; update(); },
        };
    }

    window.MtlxGalleryCards = {
        buildCard,
        familyChipsFor,
        filterCards,
        createFilterController,
        GALLERY_FAMILY_ORDER,
        GALLERY_TAG_FILTERS,
    };
}());
