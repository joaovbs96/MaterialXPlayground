// actions-view.js: webview-side script for the materialxPlayground.actions
// view. Renders actionsModel.js's row list (sent by the host as a 'state'
// message, along with the embedded examples/Insert Node panels' data and
// the About overlay's data) as full-width buttons, posts {type:'run', id}
// back to the host on click/Enter for a row or an examples card -- the
// host maps a row id to its own command itself, this script never runs a
// string built here, and an examples card id / Insert Node category is
// re-validated against the exact data the host last sent. Plain DOM, no
// frameworks.
(function () {
    const vscode = acquireVsCodeApi();
    const cards = window.MtlxGalleryCards;

    // Tabler icon path data, copied from js/shared/ui-commons.js (the
    // repo's own icon set) for the handful of icons this view uses.
    const ICONS = {
        sparkles: '<path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z"/>',
        'file-plus': '<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" /><path d="M12 11l0 6" /><path d="M9 14l6 0" />',
        book: '<path d="M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6l0 13"/><path d="M12 6l0 13"/><path d="M21 6l0 13"/>',
        share: '<path d="M3 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M15 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M15 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M8.7 10.7l6.6 -3.4"/><path d="M8.7 13.3l6.6 3.4"/>',
        eye: '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>',
        'color-filter': '<path d="M13.58 13.79c.27 .68 .42 1.43 .42 2.21c0 1.77 -.77 3.37 -2 4.46a5.93 5.93 0 0 1 -4 1.54c-3.31 0 -6 -2.69 -6 -6c0 -2.76 1.88 -5.1 4.42 -5.79" /><path d="M17.58 10.21c2.54 .69 4.42 3.03 4.42 5.79c0 3.31 -2.69 6 -6 6a5.93 5.93 0 0 1 -4 -1.54" /><path d="M6 8a6 6 0 1 0 12 0a6 6 0 1 0 -12 0" />',
        'external-link': '<path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6"/><path d="M11 13l9 -9"/><path d="M15 4h5v5"/>',
        'alert-triangle': '<path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0"/><path d="M12 16h.01"/>',
        'file-text': '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"/><path d="M9 9l1 0"/><path d="M9 13l6 0"/><path d="M9 17l6 0"/>',
        puzzle: '<path d="M4 7h3a1 1 0 0 0 1 -1v-1a2 2 0 0 1 4 0v1a1 1 0 0 0 1 1h3a1 1 0 0 1 1 1v3a1 1 0 0 0 1 1h1a2 2 0 0 1 0 4h-1a1 1 0 0 0 -1 1v3a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-1a2 2 0 0 0 -4 0v1a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h1a2 2 0 0 0 0 -4h-1a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1"/>',
        sun: '<path d="M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7"/>',
        contrast: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M12 3v18"/><path d="M12 14l7 -7"/><path d="M12 19l8.5 -8.5"/><path d="M12 9l4.2 -4.2"/>',
        vscode: '<path d="M16 3v18l4 -2.5v-13l-4 -2.5"/><path d="M9.165 13.903l-4.165 3.597l-2 -1l4.333 -4.5m1.735 -1.802l6.932 -7.198v5l-4.795 4.141"/><path d="M16 16.5l-11 -10l-2 1l13 13.5"/>',
        palette: '<path d="M12 21a9 9 0 0 1 0 -18c4.97 0 9 3.582 9 8c0 1.06 -.474 2.078 -1.318 2.828c-.844 .75 -1.989 1.172 -3.182 1.172h-2.5a2 2 0 0 0 -1 3.75a1.3 1.3 0 0 1 -1 2.25"/><path d="M8.5 10.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M12.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M16.5 10.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/>',
        moon: '<path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z"/>',
        'device-desktop': '<path d="M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10z"/><path d="M7 20h10"/><path d="M9 16v4"/><path d="M15 16v4"/>',
        check: '<path d="M5 12l5 5l10 -10"/>',
    };
    const CHEVRON_PATH = '<path d="M6 9l6 6l6 -6"/>';
    const CLOSE_PATH = '<path d="M18 6l-12 12" /><path d="M6 6l12 12" />';

    // The header overflow menu's three items: id (posted back to the
    // host), icon key and label. Tutorials is disabled (task G1 item 9):
    // the MkDocs subsite isn't published for this route yet.
    const HELP_LINKS = [
        { id: 'tutorials', icon: 'external-link', label: 'Tutorials', disabled: true },
        { id: 'reportIssue', icon: 'alert-triangle', label: 'Report an Issue' },
        { id: 'whatsNew', icon: 'file-text', label: "What's New" },
    ];

    const root = document.getElementById('root');
    const aboutBtn = document.getElementById('mtlx-about-btn');
    const githubBtn = document.getElementById('mtlx-github-btn');
    const moreBtn = document.getElementById('mtlx-more-btn');
    const moreWrap = document.querySelector('.mtlx-more-wrap');
    const aboutOverlay = document.getElementById('mtlx-about-overlay');

    let latestState = null; // last 'state' message, for the About overlay

    // ---- Expandable groups: Insert Node, New Material from Example -----
    // Mutually exclusive (expanding one collapses the other), remembered
    // via the webview state API. Mirrors actionsModel.js's
    // nextGroupExpansion(current, which, expanded) by hand (a plain
    // browser script here, not requirable there); keep both in sync.
    function nextGroupExpansion(current, which, expanded) {
        if (!expanded) return Object.assign({}, current, { [which]: false });
        const next = { examples: false, insertNode: false };
        next[which] = true;
        return next;
    }

    let groupState = { examples: false, insertNode: false };
    try {
        const saved = vscode.getState();
        if (saved && typeof saved.examples === 'boolean') groupState.examples = saved.examples;
        if (saved && typeof saved.insertNode === 'boolean') groupState.insertNode = saved.insertNode;
    } catch (e) { /* private-window/blocked storage: default to collapsed */ }

    function svg(inner, viewBox) {
        return '<svg viewBox="' + (viewBox || '0 0 24 24') + '" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
    }

    function iconSvg(name) {
        return svg(ICONS[name] || '', '0 0 24 24');
    }

    function updateToggleButton(which, expanded, focus) {
        const toggleBtn = root.querySelector('.mtlx-action-btn[data-toggle="' + which + '"]');
        if (!toggleBtn) return;
        toggleBtn.setAttribute('aria-expanded', String(expanded));
        const chev = toggleBtn.querySelector('.mtlx-action-chevron');
        if (chev) chev.classList.toggle('is-open', expanded);
        if (focus) toggleBtn.focus();
    }

    function persistGroupState() {
        try { vscode.setState({ examples: groupState.examples, insertNode: groupState.insertNode }); } catch (e) { /* ignore */ }
    }

    function setGroupExpanded(which, expanded, focusToggle) {
        groupState = nextGroupExpansion(groupState, which, expanded);
        examplesPanel.hidden = !groupState.examples;
        insertNodePanel.hidden = !groupState.insertNode;
        // The node card is a child of <body>, independent of insertNodePanel
        // being hidden -- close it explicitly whenever Insert Node itself
        // collapses (this toggle, or Example expanding and collapsing it).
        if (!groupState.insertNode && typeof closeCard === 'function') closeCard(false);
        updateToggleButton('examples', groupState.examples, focusToggle === 'examples');
        updateToggleButton('insertNode', groupState.insertNode, focusToggle === 'insertNode');
        persistGroupState();
        vscode.postMessage({ type: 'toggleExamples', expanded: groupState.examples });
        vscode.postMessage({ type: 'toggleInsertNode', expanded: groupState.insertNode });
    }

    // ---- Embedded examples panel (below "New Material from Example") ----
    // Built once and re-attached on every render() so the search input's
    // typed value and the group markup aren't rebuilt from scratch on
    // every unrelated 'state' push (e.g. the active document changing).
    const examplesPanel = document.createElement('div');
    examplesPanel.id = 'mtlx-examples-panel';
    examplesPanel.className = 'mtlx-group-panel';
    examplesPanel.hidden = !groupState.examples;

    const toolbarHost = document.createElement('div');
    toolbarHost.id = 'mtlx-ex-toolbar-host';

    const gridEl = document.createElement('div');
    gridEl.id = 'mtlx-ex-grid';
    gridEl.className = 'mtlx-ex-grid';
    gridEl.setAttribute('role', 'list');
    gridEl.setAttribute('aria-label', 'Example materials');

    const emptyEl = document.createElement('div');
    emptyEl.id = 'mtlx-ex-empty';
    emptyEl.className = 'mtlx-gallery-empty';
    emptyEl.textContent = 'No examples match your filters.';
    emptyEl.hidden = true;

    examplesPanel.appendChild(toolbarHost);
    examplesPanel.appendChild(gridEl);
    examplesPanel.appendChild(emptyEl);

    function runCard(id) {
        vscode.postMessage({ type: 'run', id: id });
    }

    function renderExamples(filtered) {
        gridEl.textContent = '';
        for (const card of filtered) gridEl.appendChild(cards.buildCard(card, runCard));
        emptyEl.hidden = filtered.length > 0;
    }

    // Compact chip sizing (sidebar column is narrow): search + family/tag
    // chips + match count/Clear filters, same toolbar the gallery panel
    // uses (gallery-cards.js's createFilterController).
    const examplesFilter = cards.createFilterController(toolbarHost, [], { compact: true });
    examplesFilter.onChange(renderExamples);

    let reportedCardCount = -1;
    function setExamplesCards(list) {
        examplesFilter.setCards(list);
        // 'rendered' reports the UNFILTERED total (matches the old
        // Examples view's contract: the smoke suite waits for the full
        // catalog, independent of whatever is currently typed/chipped).
        if (list.length !== reportedCardCount) {
            reportedCardCount = list.length;
            vscode.postMessage({ type: 'rendered', cardCount: list.length });
        }
    }

    // ---- Embedded Insert Node panel (above "New Material from Example") -

    // Inline, like any other group: a fixed search row above a TREE
    // (docs order). Only the tree's own scroll area flexes -- the
    // search row and every other action row are never pushed off.

    // Picking a node opens a floating CARD (a child of <body>, anchored
    // to the clicked row) with a "choose a type, then Insert" step;
    // Back/Escape/outside click returns to the tree unchanged.
    const insertNodePanel = document.createElement('div');
    insertNodePanel.id = 'mtlx-insert-panel';
    insertNodePanel.className = 'mtlx-group-panel';
    insertNodePanel.hidden = !groupState.insertNode;

    const insSearchWrap = document.createElement('div');
    insSearchWrap.className = 'mtlx-ex-toolbar';
    const insSearchLabel = document.createElement('label');
    insSearchLabel.className = 'mtlx-gallery-search-label';
    insSearchLabel.setAttribute('for', 'mtlx-insert-search');
    insSearchLabel.textContent = 'Search nodes';
    const insSearchInputWrap = document.createElement('div');
    insSearchInputWrap.className = 'mtlx-insert-search-wrap';
    const insSearchInput = document.createElement('input');
    insSearchInput.id = 'mtlx-insert-search';
    insSearchInput.className = 'mtlx-gallery-search';
    insSearchInput.type = 'text';
    insSearchInput.autocomplete = 'off';
    insSearchInput.placeholder = 'Search by name or library';
    const insClearBtn = document.createElement('button');
    insClearBtn.type = 'button';
    insClearBtn.className = 'mtlx-insert-clear';
    insClearBtn.setAttribute('aria-label', 'Clear search');
    insClearBtn.hidden = true;
    insClearBtn.innerHTML = svg(CLOSE_PATH);
    insSearchInputWrap.appendChild(insSearchInput);
    insSearchInputWrap.appendChild(insClearBtn);
    insSearchWrap.appendChild(insSearchLabel);
    insSearchWrap.appendChild(insSearchInputWrap);
    insertNodePanel.appendChild(insSearchWrap);

    const insTreeScroll = document.createElement('div');
    insTreeScroll.className = 'mtlx-insert-tree-scroll';
    insertNodePanel.appendChild(insTreeScroll);

    const insListEl = document.createElement('div');
    insListEl.id = 'mtlx-insert-list';
    insListEl.setAttribute('role', 'tree');
    insListEl.setAttribute('aria-label', 'Node categories');
    insListEl.__rows = [];

    const insEmptyEl = document.createElement('div');
    insEmptyEl.id = 'mtlx-insert-empty';
    insEmptyEl.className = 'mtlx-gallery-empty';
    insEmptyEl.textContent = 'No nodes match your search.';
    insEmptyEl.hidden = true;

    insTreeScroll.appendChild(insListEl);
    insTreeScroll.appendChild(insEmptyEl);

    // The floating node card: appended to <body> once, positioned in JS
    // (position: fixed) against the clicked row's own bounding rect --
    // see positionCard below.
    const card = document.createElement('div');
    card.id = 'mtlx-insert-card';
    card.className = 'mtlx-insert-card';
    card.setAttribute('role', 'group');
    card.hidden = true;
    document.body.appendChild(card);

    const insTypeHeader = document.createElement('div');
    insTypeHeader.className = 'mtlx-insert-type-header';
    const insSelectedTitleWrap = document.createElement('div');
    insSelectedTitleWrap.className = 'mtlx-insert-selected-title-wrap';
    const insSelectedName = document.createElement('div');
    insSelectedName.className = 'mtlx-insert-selected-name';
    const insSelectedLib = document.createElement('div');
    insSelectedLib.className = 'mtlx-insert-selected-lib';
    insSelectedTitleWrap.appendChild(insSelectedName);
    insSelectedTitleWrap.appendChild(insSelectedLib);
    const insBackBtn = document.createElement('button');
    insBackBtn.type = 'button';
    insBackBtn.className = 'mtlx-insert-back';
    insBackBtn.textContent = '← Back';
    insBackBtn.setAttribute('aria-label', 'Back to search results');
    insTypeHeader.appendChild(insSelectedTitleWrap);
    insTypeHeader.appendChild(insBackBtn);

    const insTypeRow = document.createElement('div');
    insTypeRow.className = 'mtlx-insert-type-row';
    const insTypeSelect = document.createElement('select');
    insTypeSelect.id = 'mtlx-insert-type';
    insTypeSelect.className = 'mtlx-insert-select';
    insTypeSelect.setAttribute('aria-label', 'Output type');
    const insInsertBtn = document.createElement('button');
    insInsertBtn.type = 'button';
    insInsertBtn.id = 'mtlx-insert-btn';
    insInsertBtn.className = 'mtlx-action-btn primary';
    insInsertBtn.textContent = 'Insert';
    insTypeRow.appendChild(insTypeSelect);
    insTypeRow.appendChild(insInsertBtn);

    card.appendChild(insTypeHeader);
    card.appendChild(insTypeRow);

    let insertTree = [];       // the host's insertNodeTree
    let selectedNode = null;   // the chosen node row, while the card shows
    let selectedRowEl = null;  // the clicked row, anchors/refocuses the card
    let manualExpanded = {};   // group key -> expanded, reset on a fresh open
    let focusRowKey = null;    // roving-tabindex target (survives a re-render)

    function nodeMatchesQuery(node, q) {
        const hay = (node.name + ' ' + (node.library || '')).toLowerCase();
        return hay.indexOf(q) !== -1;
    }

    // Mirrors insertNodeModel.js's filterInsertTree by hand (a plain
    // browser script here, not requirable there); keep both in sync.
    function filterTree(tree, term) {
        const q = String(term || '').trim().toLowerCase();
        if (!q) return tree.map((g) => Object.assign({}, g, { nodes: g.nodes.slice(), matched: false }));
        const out = [];
        for (const g of tree) {
            const nodes = g.nodes.filter((n) => nodeMatchesQuery(n, q));
            if (nodes.length) out.push(Object.assign({}, g, { nodes, matched: true }));
        }
        return out;
    }

    function highlightText(el, text, term) {
        el.textContent = '';
        const q = term.trim();
        const idx = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
        if (idx === -1) { el.textContent = text; return; }
        if (idx > 0) el.appendChild(document.createTextNode(text.slice(0, idx)));
        const mark = document.createElement('mark');
        mark.className = 'mtlx-insert-match';
        mark.textContent = text.slice(idx, idx + q.length);
        el.appendChild(mark);
        if (idx + q.length < text.length) el.appendChild(document.createTextNode(text.slice(idx + q.length)));
    }

    function renderTree() {
        const term = insSearchInput.value;
        const q = term.trim();
        const filtered = filterTree(insertTree, term);
        insListEl.textContent = '';
        const focusable = [];
        let lastLibrary = null;
        let libWrap = null;
        let totalNodes = 0;

        for (const g of filtered) {
            totalNodes += g.nodes.length;
            if (g.library !== lastLibrary) {
                lastLibrary = g.library;
                const libRow = document.createElement('div');
                libRow.className = 'mtlx-insert-lib';
                libRow.textContent = String(g.library || '').toUpperCase();
                insListEl.appendChild(libRow);
                libWrap = document.createElement('div');
                libWrap.className = 'mtlx-insert-indent';
                insListEl.appendChild(libWrap);
            }
            const expanded = q ? true : !!manualExpanded[g.key];
            const groupBtn = document.createElement('button');
            groupBtn.type = 'button';
            groupBtn.className = 'mtlx-insert-row mtlx-insert-group';
            groupBtn.setAttribute('role', 'treeitem');
            groupBtn.setAttribute('aria-expanded', String(expanded));
            groupBtn.dataset.rowKey = 'g:' + g.key;
            groupBtn.dataset.groupKey = g.key;
            groupBtn.tabIndex = -1;
            const chev = document.createElement('span');
            chev.className = 'mtlx-insert-chevron' + (expanded ? ' is-open' : '');
            chev.innerHTML = svg(CHEVRON_PATH);
            groupBtn.appendChild(chev);
            const gname = document.createElement('span');
            gname.className = 'mtlx-insert-group-name';
            highlightText(gname, g.group, q);
            groupBtn.appendChild(gname);
            const count = document.createElement('span');
            count.className = 'mtlx-insert-count';
            count.textContent = String(g.nodes.length);
            groupBtn.appendChild(count);
            groupBtn.addEventListener('click', () => toggleGroup(g.key));
            libWrap.appendChild(groupBtn);
            focusable.push(groupBtn);

            if (expanded) {
                const nodeWrap = document.createElement('div');
                nodeWrap.className = 'mtlx-insert-indent';
                for (const n of g.nodes) {
                    const item = document.createElement('button');
                    item.type = 'button';
                    item.className = 'mtlx-insert-row mtlx-insert-node';
                    item.setAttribute('role', 'treeitem');
                    item.setAttribute('aria-label', n.name + (n.library ? ', ' + n.library : ''));
                    item.dataset.rowKey = 'n:' + g.key + ':' + n.name;
                    item.dataset.groupKey = g.key;
                    item.tabIndex = -1;
                    const nname = document.createElement('span');
                    nname.className = 'mtlx-insert-name';
                    highlightText(nname, n.name, q);
                    item.appendChild(nname);
                    item.addEventListener('click', () => selectNode(n, item));
                    nodeWrap.appendChild(item);
                    focusable.push(item);
                }
                libWrap.appendChild(nodeWrap);
            }
        }

        insEmptyEl.hidden = totalNodes > 0 || insertTree.length === 0;
        let target = focusable.filter((el) => el.dataset.rowKey === focusRowKey)[0];
        if (!target) target = focusable[0];
        focusable.forEach((el) => { el.tabIndex = el === target ? 0 : -1; });
        focusRowKey = target ? target.dataset.rowKey : null;
        insListEl.__rows = focusable;
    }

    function focusRow(target) {
        const rows = insListEl.__rows || [];
        const el = typeof target === 'string' ? rows.filter((r) => r.dataset.rowKey === target)[0] : target;
        if (!el) return;
        rows.forEach((r) => { r.tabIndex = -1; });
        el.tabIndex = 0;
        el.focus();
        focusRowKey = el.dataset.rowKey;
    }

    function toggleGroup(key) {
        manualExpanded = Object.assign({}, manualExpanded, { [key]: !manualExpanded[key] });
        focusRowKey = 'g:' + key;
        renderTree();
        focusRow(focusRowKey);
    }

    function handleTreeArrowKeys(e) {
        const rows = insListEl.__rows || [];
        if (!rows.length) return;
        const idx = rows.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusRow(rows[idx === -1 ? 0 : Math.min(rows.length - 1, idx + 1)]);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (idx <= 0) { insSearchInput.focus(); return; }
            focusRow(rows[idx - 1]);
            return;
        }
        if (idx === -1) return;
        const el = rows[idx];
        const isGroup = el.classList.contains('mtlx-insert-group');
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (!isGroup) return;
            const key = el.dataset.groupKey;
            if (!manualExpanded[key]) { toggleGroup(key); return; }
            const next = rows[idx + 1];
            if (next && next.dataset.groupKey === key && !next.classList.contains('mtlx-insert-group')) focusRow(next);
            return;
        }
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (isGroup) {
                if (manualExpanded[el.dataset.groupKey]) toggleGroup(el.dataset.groupKey);
                return;
            }
            const groupKey = el.dataset.groupKey;
            const groupRow = rows.filter((r) => r.dataset.groupKey === groupKey && r.classList.contains('mtlx-insert-group'))[0];
            if (groupRow) focusRow(groupRow);
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            el.click();
        }
    }

    function updateClearButton() {
        insClearBtn.hidden = !insSearchInput.value;
    }

    // Positioned against the clicked row's own box (fixed, so it's never
    // clipped by the tree's own overflow-y:auto); clamped to stay inside
    // the webview's own bounds, floored so it never fully collapses.
    function positionCard(anchorRect) {
        const margin = 8;
        const width = Math.min(300, window.innerWidth - margin * 2);
        card.style.width = width + 'px';
        card.style.left = Math.max(margin, Math.min(anchorRect.left, window.innerWidth - margin - width)) + 'px';
        card.style.maxHeight = Math.max(80, window.innerHeight - margin * 2) + 'px';
        // Two passes: lay it out at the anchor's own top first, then clamp
        // using its now-known real height so it never runs off-screen.
        card.style.visibility = 'hidden';
        card.hidden = false;
        card.style.top = anchorRect.top + 'px';
        const height = card.getBoundingClientRect().height;
        const top = Math.max(margin, Math.min(anchorRect.top, window.innerHeight - margin - height));
        card.style.top = top + 'px';
        card.style.visibility = 'visible';
    }

    // Re-anchors to the SAME row's live rect (not a stale snapshot), so
    // the card tracks it through a tree scroll or a window resize.
    function repositionCard() {
        if (card.hidden || !selectedRowEl) return;
        positionCard(selectedRowEl.getBoundingClientRect());
    }

    function onDocMouseDownForCard(e) {
        if (card.contains(e.target)) return;
        closeCard(true);
    }

    function onCardKeydown(e) {
        if (e.key === 'Escape') { e.preventDefault(); closeCard(true); }
    }

    // closeCard(focusReturn): hides the card and, unless a real insert
    // is about to focus the text editor instead, refocuses the row that
    // opened it (the tree itself was never touched underneath).
    function closeCard(focusReturn) {
        if (card.hidden) return;
        card.hidden = true;
        document.removeEventListener('mousedown', onDocMouseDownForCard, true);
        window.removeEventListener('resize', repositionCard);
        window.removeEventListener('scroll', repositionCard, true);
        const rowEl = selectedRowEl;
        selectedNode = null;
        selectedRowEl = null;
        if (focusReturn && rowEl) focusRow(rowEl);
    }

    function selectNode(n, rowEl) {
        selectedNode = n;
        selectedRowEl = rowEl;
        focusRowKey = rowEl.dataset.rowKey;
        insSelectedName.textContent = n.name;
        insSelectedLib.textContent = n.library || '';
        insTypeSelect.textContent = '';
        const types = n.orderedOutputTypes && n.orderedOutputTypes.length ? n.orderedOutputTypes : [''];
        for (const t of types) {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t || '(none)';
            insTypeSelect.appendChild(opt);
        }
        if (n.defaultOutputType && types.indexOf(n.defaultOutputType) !== -1) insTypeSelect.value = n.defaultOutputType;
        positionCard(rowEl.getBoundingClientRect());
        document.addEventListener('mousedown', onDocMouseDownForCard, true);
        window.addEventListener('resize', repositionCard);
        window.addEventListener('scroll', repositionCard, true);
        insTypeSelect.focus();
    }

    // Card closed, search cleared, tree back to collapsed -- the Insert
    // Node GROUP itself stays expanded either way. `focus` is false after
    // a real insert, which hands focus to the text editor instead.
    function resetInsertPanel(focus) {
        closeCard(false);
        insSearchInput.value = '';
        updateClearButton();
        manualExpanded = {};
        renderTree();
        if (focus) insSearchInput.focus();
    }

    function doInsert() {
        if (!selectedNode) return;
        vscode.postMessage({ type: 'insertNode', category: selectedNode.name, outputType: insTypeSelect.value });
        resetInsertPanel(false);
    }

    insSearchInput.addEventListener('input', () => {
        updateClearButton();
        renderTree();
    });
    insSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && insSearchInput.value) {
            e.preventDefault();
            insSearchInput.value = '';
            updateClearButton();
            renderTree();
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const rows = insListEl.__rows || [];
            if (rows.length) focusRow(rows[0]);
        }
    });
    insClearBtn.addEventListener('click', () => {
        insSearchInput.value = '';
        updateClearButton();
        renderTree();
        insSearchInput.focus();
    });
    insListEl.addEventListener('keydown', handleTreeArrowKeys);
    card.addEventListener('keydown', onCardKeydown);
    insBackBtn.addEventListener('click', () => closeCard(true));
    insInsertBtn.addEventListener('click', doInsert);
    insTypeSelect.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doInsert(); } });

    // ---- Two-column / one-column action grid (task G1 item 3) -----------
    // Replaces a fixed 260px media query: a hidden probe holds a live copy
    // of the current half-width rows, forced into the two-column CSS
    // regardless of which mode is on screen, so scrollWidth/clientWidth on
    // its labels always reflects "would this truncate at two columns,
    // right now". Mirrors actionsModel.js's decideColumnLayout(mode,
    // truncated, streak) by hand; keep both in sync.
    const layoutProbe = document.createElement('div');
    layoutProbe.className = 'mtlx-action-grid mtlx-layout-probe';
    layoutProbe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layoutProbe);

    let columnMode = 'two';
    let columnStreak = 0;
    let columnTimer = 0;

    function decideColumnLayout(mode, truncated, streak) {
        const wants = truncated ? 'single' : 'two';
        if (wants === mode) return { mode: mode, streak: 0 };
        const nextStreak = streak + 1;
        if (nextStreak >= 2) return { mode: wants, streak: 0 };
        return { mode: mode, streak: nextStreak };
    }

    function measureWouldTruncate(gridWrap, width) {
        if (!gridWrap || !width) return false;
        layoutProbe.style.width = width + 'px';
        layoutProbe.innerHTML = gridWrap.innerHTML;
        let truncated = false;
        layoutProbe.querySelectorAll('.mtlx-action-label').forEach((el) => {
            if (el.scrollWidth > el.clientWidth + 0.5) truncated = true;
        });
        return truncated;
    }

    function updateColumnLayout() {
        const gridWrap = root.querySelector('.mtlx-action-grid');
        if (!gridWrap) return;
        const width = gridWrap.clientWidth || root.clientWidth;
        const truncated = measureWouldTruncate(gridWrap, width);
        const next = decideColumnLayout(columnMode, truncated, columnStreak);
        columnStreak = next.streak;
        if (next.mode !== columnMode) columnMode = next.mode;
        gridWrap.classList.toggle('single-col', columnMode === 'single');
        // A pending flip needs a confirming reading; observers only fire on
        // size changes, so schedule one instead of waiting for another resize.
        clearTimeout(columnTimer);
        if (columnStreak > 0) columnTimer = setTimeout(updateColumnLayout, 80);
    }

    if (typeof ResizeObserver !== 'undefined') {
        const resizeObserver = new ResizeObserver(() => updateColumnLayout());
        resizeObserver.observe(root);
    }

    // ---- Action rows -------------------------------------------------
    function render(rows) {
        // insertNode is forced collapsed whenever it's disabled (no
        // visible .mtlx text editor), even if it was left expanded before.
        const insertRow = rows.find((r) => r.id === 'insertNode');
        if (insertRow && insertRow.disabled && groupState.insertNode) {
            groupState = nextGroupExpansion(groupState, 'insertNode', false);
            persistGroupState();
            resetInsertPanel(false);
        }
        insertNodePanel.hidden = !groupState.insertNode;

        root.textContent = '';
        // Consecutive `layout: 'half'` rows share one CSS-grid wrapper (two
        // columns); a non-half row (or the end of the list) closes it. An
        // odd-sized group's last row gets `span-full` so it is never left
        // alone next to an empty grid cell.
        let gridWrap = null;
        let groupRows = [];
        const closeGroup = () => {
            if (groupRows.length % 2 === 1) groupRows[groupRows.length - 1].classList.add('span-full');
            groupRows = [];
        };
        for (const row of rows) {
            if (row.layout === 'half') {
                if (!gridWrap) {
                    gridWrap = document.createElement('div');
                    gridWrap.className = 'mtlx-action-grid' + (columnMode === 'single' ? ' single-col' : '');
                    root.appendChild(gridWrap);
                }
            } else {
                closeGroup();
                gridWrap = null;
            }

            const wrap = document.createElement('div');
            wrap.className = 'mtlx-action-row' + (row.layout === 'half' ? ' half' : '');
            if (row.layout === 'half') groupRows.push(wrap);

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mtlx-action-btn ' + (row.variant || 'default');
            btn.disabled = !!row.disabled;
            btn.setAttribute('aria-label', row.label + (row.description ? '. ' + row.description : ''));
            if (row.description) btn.title = row.description;
            else if (row.shortLabel) btn.title = row.label;

            const icon = document.createElement('span');
            icon.className = 'mtlx-action-icon';
            icon.innerHTML = iconSvg(row.icon);
            btn.appendChild(icon);

            const label = document.createElement('span');
            label.className = 'mtlx-action-label';
            label.textContent = (row.layout === 'half' && row.shortLabel) ? row.shortLabel : row.label;
            btn.appendChild(label);

            if (row.toggle === 'examples' || row.toggle === 'insertNode') {
                const which = row.toggle;
                btn.dataset.toggle = which;
                btn.setAttribute('aria-expanded', String(groupState[which]));
                btn.setAttribute('aria-controls', which === 'examples' ? 'mtlx-examples-panel' : 'mtlx-insert-panel');
                const chevron = document.createElement('span');
                chevron.className = 'mtlx-action-chevron' + (groupState[which] ? ' is-open' : '');
                chevron.innerHTML = svg(CHEVRON_PATH);
                btn.appendChild(chevron);
                btn.addEventListener('click', () => {
                    if (btn.disabled) return;
                    const wasExpanded = groupState[which];
                    setGroupExpanded(which, !wasExpanded);
                    // "with an empty search all groups start collapsed":
                    // a fresh open resets the tree, not a re-toggle of it.
                    if (which === 'insertNode' && !wasExpanded) resetInsertPanel(false);
                });
            } else {
                btn.addEventListener('click', () => {
                    if (btn.disabled) return;
                    vscode.postMessage({ type: 'run', id: row.id });
                });
            }

            wrap.appendChild(btn);
            (gridWrap || root).appendChild(wrap);
            if (row.toggle === 'examples') root.appendChild(examplesPanel);
            if (row.toggle === 'insertNode') root.appendChild(insertNodePanel);
        }
        closeGroup();
        updateColumnLayout();
    }

    // ---- About overlay -------------------------------------------------
    function buildLink(text, href) {
        const a = document.createElement('a');
        a.href = href;
        a.textContent = text;
        a.className = 'mtlx-about-link';
        return a;
    }

    function renderAbout(about) {
        aboutOverlay.textContent = '';
        if (!about) return;
        const panel = document.createElement('div');
        panel.className = 'mtlx-about-panel';

        const header = document.createElement('div');
        header.className = 'mtlx-about-header';
        const title = document.createElement('div');
        title.id = 'mtlx-about-title';
        title.className = 'mtlx-about-title';
        title.textContent = 'About MaterialX Playground';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'mtlx-toolbar-btn';
        closeBtn.title = 'Close';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.innerHTML = svg(CLOSE_PATH);
        closeBtn.addEventListener('click', closeAbout);
        header.appendChild(title);
        header.appendChild(closeBtn);
        panel.appendChild(header);

        const versions = document.createElement('div');
        versions.className = 'mtlx-about-versions';
        const extLine = document.createElement('div');
        extLine.textContent = 'Extension ' + about.extensionVersionText;
        versions.appendChild(extLine);
        const vscLine = document.createElement('div');
        vscLine.textContent = 'VS Code ' + about.vscodeVersion;
        versions.appendChild(vscLine);
        if (about.mtlxVersion) {
            const mtlxLine = document.createElement('div');
            mtlxLine.appendChild(document.createTextNode('MaterialX '));
            mtlxLine.appendChild(buildLink(about.mtlxVersion, about.mtlxReleaseUrl || '#'));
            versions.appendChild(mtlxLine);
        }
        panel.appendChild(versions);

        const links = document.createElement('div');
        links.className = 'mtlx-about-links';
        if (about.repoUrl) links.appendChild(buildLink('GitHub Repository', about.repoUrl));
        if (about.issuesUrl) links.appendChild(buildLink('Issues', about.issuesUrl));
        panel.appendChild(links);

        if (about.disclaimer) {
            const disc = document.createElement('div');
            disc.className = 'mtlx-about-disclaimer';
            const p1 = document.createElement('p');
            p1.textContent = about.disclaimer.experimental;
            const p2 = document.createElement('p');
            p2.textContent = about.disclaimer.affiliation;
            disc.appendChild(p1);
            disc.appendChild(p2);
            panel.appendChild(disc);
        }

        if (about.vendorEntries && about.vendorEntries.length) {
            const credits = document.createElement('div');
            credits.className = 'mtlx-about-credits';
            const label = document.createElement('span');
            label.className = 'mtlx-about-credits-label';
            label.textContent = 'Third-party libraries: ';
            credits.appendChild(label);
            about.vendorEntries.forEach((lib, i) => {
                if (i > 0) credits.appendChild(document.createTextNode(', '));
                if (lib.licenseUrl) credits.appendChild(buildLink(lib.name, lib.licenseUrl));
                else credits.appendChild(document.createTextNode(lib.name));
            });
            panel.appendChild(credits);
        }

        const licenseLabel = document.createElement('div');
        licenseLabel.className = 'mtlx-about-license-label';
        licenseLabel.textContent = 'License';
        panel.appendChild(licenseLabel);

        const licenseBox = document.createElement('div');
        licenseBox.className = 'mtlx-about-license-box';
        const paragraphs = Array.isArray(about.licenseParagraphs) ? about.licenseParagraphs : [];
        if (paragraphs.length) {
            paragraphs.forEach((text) => {
                const p = document.createElement('p');
                p.className = 'mtlx-about-license-text';
                p.textContent = text;
                licenseBox.appendChild(p);
            });
        } else if (about.license) {
            // Fallback for a host payload with the raw string but no
            // pre-split paragraphs (shouldn't happen from a real host).
            const p = document.createElement('p');
            p.className = 'mtlx-about-license-text';
            p.textContent = about.license;
            licenseBox.appendChild(p);
        } else {
            const msg = document.createElement('div');
            msg.className = 'mtlx-about-license-missing';
            msg.textContent = about.licenseError ? 'License text could not be loaded.' : 'Loading license…';
            licenseBox.appendChild(msg);
        }
        panel.appendChild(licenseBox);

        aboutOverlay.appendChild(panel);
        return closeBtn;
    }

    let lastFocused = null;
    function openAbout() {
        if (!latestState || !latestState.about) return;
        lastFocused = document.activeElement;
        // Collapse both expandable groups (task G1 item 10); the OTHER two
        // sidebar sections (Outline, Files) are separate TreeViews the host
        // handles itself once it sees the 'about' message posted below.
        setGroupExpanded('examples', false);
        setGroupExpanded('insertNode', false);
        renderAbout(latestState.about);
        aboutOverlay.hidden = false;
        const closeBtn = aboutOverlay.querySelector('.mtlx-toolbar-btn');
        if (closeBtn) closeBtn.focus();
        document.addEventListener('keydown', onAboutKeydown);
        vscode.postMessage({ type: 'about' });
    }

    function closeAbout() {
        aboutOverlay.hidden = true;
        document.removeEventListener('keydown', onAboutKeydown);
        if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
        else aboutBtn.focus();
    }

    function onAboutKeydown(e) {
        if (e.key === 'Escape') { e.preventDefault(); closeAbout(); return; }
        if (e.key !== 'Tab') return;
        // Focus trap: the overlay currently has exactly one focusable
        // element besides the close button (links inside the panel), so
        // Tab/Shift+Tab cycles within aboutOverlay's own focusables.
        const focusable = aboutOverlay.querySelectorAll('button, a[href]');
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }

    aboutBtn.addEventListener('click', openAbout);
    githubBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'github' });
    });

    // ---- Header overflow menu ("...": Tutorials / Report an Issue /
    // What's New) -- built once, native-menu keyboard behavior (Escape
    // closes and returns focus, Up/Down cycles items, outside click closes).
    const moreMenu = document.createElement('div');
    moreMenu.id = 'mtlx-more-menu';
    moreMenu.className = 'mtlx-more-menu';
    moreMenu.setAttribute('role', 'menu');
    moreMenu.setAttribute('aria-label', 'More Actions');
    moreMenu.hidden = true;
    moreBtn.setAttribute('aria-controls', 'mtlx-more-menu');
    for (const link of HELP_LINKS) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'mtlx-more-item';
        item.setAttribute('role', 'menuitem');
        item.dataset.help = link.id;
        item.disabled = !!link.disabled;
        if (link.disabled) {
            item.title = 'Coming soon';
            item.setAttribute('aria-disabled', 'true');
        }
        const icon = document.createElement('span');
        icon.className = 'mtlx-action-icon';
        icon.innerHTML = iconSvg(link.icon);
        item.appendChild(icon);
        const label = document.createElement('span');
        label.textContent = link.label;
        item.appendChild(label);
        item.addEventListener('click', () => {
            if (item.disabled) return;
            setMoreOpen(false);
            moreBtn.focus();
            vscode.postMessage({ type: 'openHelpLink', id: link.id });
        });
        moreMenu.appendChild(item);
    }
    moreWrap.appendChild(moreMenu);

    let moreOpen = false;
    function onDocClickForMore(e) {
        if (!moreMenu.contains(e.target) && e.target !== moreBtn) setMoreOpen(false);
    }
    function onMoreKeydown(e) {
        const items = Array.from(moreMenu.querySelectorAll('.mtlx-more-item'));
        const idx = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); setMoreOpen(false); moreBtn.focus(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length].focus(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); return; }
    }
    function setMoreOpen(open, focusFirst) {
        moreOpen = open;
        moreMenu.hidden = !open;
        moreBtn.setAttribute('aria-expanded', String(open));
        if (open) {
            document.addEventListener('keydown', onMoreKeydown);
            document.addEventListener('click', onDocClickForMore, true);
            const items = moreMenu.querySelectorAll('.mtlx-more-item');
            if (focusFirst && items.length) items[0].focus();
        } else {
            document.removeEventListener('keydown', onMoreKeydown);
            document.removeEventListener('click', onDocClickForMore, true);
        }
    }
    moreBtn.addEventListener('click', () => setMoreOpen(!moreOpen, true));

    // ---- Theme menu next to About: System, Light/Dark, then labeled
    // Accessibility and Presets groups. The host owns the setting and the
    // choice list, and echoes both back via 'state' / 'theme'.
    let themeChoices = [
        { id: 'vscode', label: 'Match VS Code', group: 'system' },
        { id: 'system', label: 'System', group: 'system' },
        { id: 'light', label: 'Light', group: 'standard' },
        { id: 'dark', label: 'Dark', group: 'standard' },
    ];
    function themeIconName(c) {
        if (c.id === 'vscode') return 'vscode';
        if (c.id === 'system') return 'device-desktop';
        if (c.id === 'light') return 'sun';
        if (c.id === 'dark') return 'moon';
        return c.group === 'accessibility' ? 'contrast' : 'palette';
    }
    const themeBtn = document.getElementById('mtlx-theme-btn');
    const themeWrap = document.querySelector('.mtlx-theme-wrap');
    const themeMenu = document.createElement('div');
    themeMenu.id = 'mtlx-theme-menu';
    themeMenu.className = 'mtlx-more-menu';
    themeMenu.setAttribute('role', 'menu');
    themeMenu.setAttribute('aria-label', 'Theme');
    themeMenu.hidden = true;
    let themePref = 'vscode';
    function buildThemeItem(choice) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'mtlx-more-item';
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', 'false');
        item.dataset.theme = choice.id;
        const icon = document.createElement('span');
        icon.className = 'mtlx-action-icon';
        icon.innerHTML = iconSvg(themeIconName(choice));
        item.appendChild(icon);
        const label = document.createElement('span');
        label.className = 'mtlx-theme-label';
        label.textContent = choice.label;
        item.appendChild(label);
        const check = document.createElement('span');
        check.className = 'mtlx-theme-check';
        check.innerHTML = iconSvg('check');
        item.appendChild(check);
        item.addEventListener('click', () => {
            setThemeOpen(false);
            themeBtn.focus();
            setThemePref(choice.id);
            vscode.postMessage({ type: 'setTheme', value: choice.id });
        });
        return item;
    }
    function themeHeading(text) {
        const h = document.createElement('div');
        h.className = 'mtlx-theme-heading';
        h.setAttribute('role', 'presentation');
        h.textContent = text;
        return h;
    }
    function buildThemeMenu() {
        themeMenu.textContent = '';
        const top = themeChoices.filter((c) => c.group === 'system' || c.group === 'standard');
        for (const c of top) themeMenu.appendChild(buildThemeItem(c));
        const groups = [['accessibility', 'Accessibility'], ['presets', 'Presets']];
        let first = true;
        for (const [g, title] of groups) {
            const list = themeChoices.filter((c) => c.group === g);
            if (!list.length) continue;
            if (first) {
                const sep = document.createElement('div');
                sep.className = 'mtlx-theme-sep';
                sep.setAttribute('role', 'separator');
                themeMenu.appendChild(sep);
                themeMenu.appendChild(themeHeading('More themes'));
                first = false;
            }
            themeMenu.appendChild(themeHeading(title));
            for (const c of list) themeMenu.appendChild(buildThemeItem(c));
        }
        setThemePref(themePref);
    }
    themeWrap.appendChild(themeMenu);

    function setThemePref(value) {
        if (!themeChoices.some((c) => c.id === value)) return;
        themePref = value;
        for (const item of themeMenu.querySelectorAll('.mtlx-more-item')) {
            item.setAttribute('aria-checked', String(item.dataset.theme === value));
        }
    }
    buildThemeMenu();

    let themeOpen = false;
    function onDocClickForTheme(e) {
        if (!themeMenu.contains(e.target) && !themeBtn.contains(e.target)) setThemeOpen(false);
    }
    function onThemeKeydown(e) {
        const items = Array.from(themeMenu.querySelectorAll('.mtlx-more-item'));
        const idx = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); setThemeOpen(false); themeBtn.focus(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length].focus(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); return; }
        if (e.key === 'Tab') setThemeOpen(false);
    }
    function setThemeOpen(open, focusCurrent) {
        themeOpen = open;
        themeMenu.hidden = !open;
        themeBtn.setAttribute('aria-expanded', String(open));
        if (open) {
            setMoreOpen(false);
            document.addEventListener('keydown', onThemeKeydown);
            document.addEventListener('click', onDocClickForTheme, true);
            const checked = themeMenu.querySelector('.mtlx-more-item[aria-checked="true"]') || themeMenu.querySelector('.mtlx-more-item');
            if (focusCurrent && checked) checked.focus();
        } else {
            document.removeEventListener('keydown', onThemeKeydown);
            document.removeEventListener('click', onDocClickForTheme, true);
        }
    }
    themeBtn.addEventListener('click', () => setThemeOpen(!themeOpen, true));

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === 'theme') { setThemePref(msg.value); return; }
        if (msg.type === 'focusInsertNode') {
            const insertRow = latestState && (latestState.rows || []).find((r) => r.id === 'insertNode');
            if (insertRow && insertRow.disabled) return;
            setGroupExpanded('insertNode', true, false);
            resetInsertPanel(true);
            return;
        }
        if (msg.type !== 'state') return;
        latestState = msg;
        if (Array.isArray(msg.themeChoices) && msg.themeChoices.length) { themeChoices = msg.themeChoices; buildThemeMenu(); }
        if (msg.theme) setThemePref(msg.theme);
        if (Array.isArray(msg.rows)) render(msg.rows);
        if (Array.isArray(msg.examplesCards)) setExamplesCards(msg.examplesCards);
        if (Array.isArray(msg.insertNodeTree)) {
            insertTree = msg.insertNodeTree;
            // Never rebuild the tree while the card is open (same scroll
            // position and selection is the whole point of leaving it alone).
            if (card.hidden) renderTree();
        }
        if (!aboutOverlay.hidden && msg.about) renderAbout(msg.about);
    });

    // The host may set the webview's html before this script's own message
    // listener is attached, so an eager host-side post could be dropped;
    // 'ready' lets the host know it's safe to send the first 'state' now.
    vscode.postMessage({ type: 'ready' });
}());
