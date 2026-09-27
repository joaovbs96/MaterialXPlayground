// actions-view.js: webview-side script for the materialxPlayground.actions
// view. Renders actionsModel.js's row list (sent by the host as a 'state'
// message, along with the embedded examples card grid's groups and the
// About overlay's data) as full-width buttons, posts {type:'run', id}
// back to the host on click/Enter for a row or an examples card -- the
// host maps a row id to its own command itself, this script never runs a
// string built here, and an examples card id is re-validated against the
// exact group list the host last sent. Plain DOM, no frameworks.
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
    };
    const CHEVRON_PATH = '<path d="M6 9l6 6l6 -6"/>';
    const CLOSE_PATH = '<path d="M18 6l-12 12" /><path d="M6 6l12 12" />';

    // The header overflow menu's three items: id (posted back to the
    // host), icon key and label. Order here is the render order.
    const HELP_LINKS = [
        { id: 'tutorials', icon: 'external-link', label: 'Tutorials' },
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
    let allGroups = [];
    let examplesExpanded = false;
    try {
        const saved = vscode.getState();
        if (saved && typeof saved.examplesExpanded === 'boolean') examplesExpanded = saved.examplesExpanded;
    } catch (e) { /* private-window/blocked storage: default to collapsed */ }

    function svg(inner, viewBox) {
        return '<svg viewBox="' + (viewBox || '0 0 24 24') + '" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
    }

    function iconSvg(name) {
        return svg(ICONS[name] || '', '0 0 24 24');
    }

    // ---- Embedded examples panel (below "New Material from Example") ----
    // Built once and re-attached on every render() so the search input's
    // typed value and the group markup aren't rebuilt from scratch on
    // every unrelated 'state' push (e.g. the active document changing).
    const examplesPanel = document.createElement('div');
    examplesPanel.id = 'mtlx-examples-panel';
    examplesPanel.className = 'mtlx-examples-panel';
    examplesPanel.hidden = !examplesExpanded;

    const searchWrap = document.createElement('div');
    searchWrap.className = 'mtlx-ex-toolbar';
    const searchLabel = document.createElement('label');
    searchLabel.className = 'mtlx-gallery-search-label';
    searchLabel.setAttribute('for', 'mtlx-ex-search');
    searchLabel.textContent = 'Search examples';
    const searchInput = document.createElement('input');
    searchInput.id = 'mtlx-ex-search';
    searchInput.className = 'mtlx-gallery-search';
    searchInput.type = 'text';
    searchInput.autocomplete = 'off';
    searchInput.placeholder = 'Search by name, shading model or license';
    searchWrap.appendChild(searchLabel);
    searchWrap.appendChild(searchInput);

    const groupsEl = document.createElement('div');
    groupsEl.id = 'mtlx-ex-groups';
    groupsEl.setAttribute('role', 'list');
    groupsEl.setAttribute('aria-label', 'Example materials');

    const emptyEl = document.createElement('div');
    emptyEl.id = 'mtlx-ex-empty';
    emptyEl.className = 'mtlx-gallery-empty';
    emptyEl.textContent = 'No examples match your search.';
    emptyEl.hidden = true;

    examplesPanel.appendChild(searchWrap);
    examplesPanel.appendChild(groupsEl);
    examplesPanel.appendChild(emptyEl);

    function runCard(id) {
        vscode.postMessage({ type: 'run', id: id });
    }

    function buildGroup(group) {
        const section = document.createElement('div');
        section.className = 'mtlx-ex-group';
        const heading = document.createElement('div');
        heading.className = 'mtlx-ex-group-heading';
        heading.textContent = group.source;
        const grid = document.createElement('div');
        grid.className = 'mtlx-ex-grid';
        grid.setAttribute('role', 'list');
        for (const card of group.cards) grid.appendChild(cards.buildCard(card, runCard));
        section.appendChild(heading);
        section.appendChild(grid);
        return section;
    }

    function renderExamples(groups) {
        groupsEl.textContent = '';
        let cardCount = 0;
        for (const group of groups) {
            groupsEl.appendChild(buildGroup(group));
            cardCount += group.cards.length;
        }
        emptyEl.hidden = cardCount > 0;
        return cardCount;
    }

    let reportedCardCount = -1;
    function refreshExamples() {
        const filtered = cards.filterGroups(allGroups, searchInput.value);
        const cardCount = renderExamples(filtered);
        // 'rendered' reports the UNFILTERED total (matches the old
        // Examples view's contract: the smoke suite waits for the full
        // 14-card catalog, independent of whatever is currently typed).
        const totalCount = allGroups.reduce((n, g) => n + g.cards.length, 0);
        if (totalCount !== reportedCardCount) {
            reportedCardCount = totalCount;
            vscode.postMessage({ type: 'rendered', cardCount: totalCount });
        }
        void cardCount;
    }

    searchInput.addEventListener('input', refreshExamples);

    function setExamplesExpanded(expanded, focusToggle) {
        examplesExpanded = expanded;
        examplesPanel.hidden = !expanded;
        const toggleBtn = root.querySelector('.mtlx-action-btn[data-toggle="examples"]');
        if (toggleBtn) {
            toggleBtn.setAttribute('aria-expanded', String(expanded));
            const chev = toggleBtn.querySelector('.mtlx-action-chevron');
            if (chev) chev.classList.toggle('is-open', expanded);
            if (focusToggle) toggleBtn.focus();
        }
        try { vscode.setState({ examplesExpanded: expanded }); } catch (e) { /* ignore */ }
        vscode.postMessage({ type: 'toggleExamples', expanded: expanded });
    }

    // ---- Action rows -------------------------------------------------
    function render(rows) {
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
                    gridWrap.className = 'mtlx-action-grid';
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

            if (row.toggle === 'examples') {
                btn.dataset.toggle = 'examples';
                btn.setAttribute('aria-expanded', String(examplesExpanded));
                btn.setAttribute('aria-controls', 'mtlx-examples-panel');
                const chevron = document.createElement('span');
                chevron.className = 'mtlx-action-chevron' + (examplesExpanded ? ' is-open' : '');
                chevron.innerHTML = svg(CHEVRON_PATH);
                btn.appendChild(chevron);
                btn.addEventListener('click', () => setExamplesExpanded(!examplesExpanded));
            } else {
                btn.addEventListener('click', () => {
                    if (btn.disabled) return;
                    vscode.postMessage({ type: 'run', id: row.id });
                });
            }

            wrap.appendChild(btn);
            if (row.disabled && row.description) {
                const note = document.createElement('div');
                note.className = 'mtlx-action-note';
                note.textContent = row.description;
                wrap.appendChild(note);
            }
            (gridWrap || root).appendChild(wrap);
            if (row.toggle === 'examples') root.appendChild(examplesPanel);
        }
        closeGroup();
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
        const icon = document.createElement('span');
        icon.className = 'mtlx-action-icon';
        icon.innerHTML = iconSvg(link.icon);
        item.appendChild(icon);
        const label = document.createElement('span');
        label.textContent = link.label;
        item.appendChild(label);
        item.addEventListener('click', () => {
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

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || msg.type !== 'state') return;
        latestState = msg;
        if (Array.isArray(msg.rows)) render(msg.rows);
        if (Array.isArray(msg.examplesGroups)) {
            allGroups = msg.examplesGroups;
            refreshExamples();
        }
        if (!aboutOverlay.hidden && msg.about) renderAbout(msg.about);
    });

    // The host may set the webview's html before this script's own message
    // listener is attached, so an eager host-side post could be dropped;
    // 'ready' lets the host know it's safe to send the first 'state' now.
    vscode.postMessage({ type: 'ready' });
}());
