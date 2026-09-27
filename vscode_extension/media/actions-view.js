// actions-view.js: webview-side script for the materialxPlayground.actions
// view. Renders actionsModel.js's row list (sent by the host as a 'state'
// message) as full-width buttons, and posts {type:'run', id} back to the
// host on click/Enter -- the host maps id -> command itself, this script
// never runs a string built here. Plain DOM, no frameworks.
(function () {
    const vscode = acquireVsCodeApi();

    // Tabler icon path data, copied from js/shared/ui-commons.js (the
    // repo's own icon set) for the handful of icons this view uses.
    const ICONS = {
        sparkles: '<path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z"/>',
        'file-plus': '<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" /><path d="M12 11l0 6" /><path d="M9 14l6 0" />',
        book: '<path d="M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6l0 13"/><path d="M12 6l0 13"/><path d="M21 6l0 13"/>',
        share: '<path d="M3 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M15 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M15 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M8.7 10.7l6.6 -3.4"/><path d="M8.7 13.3l6.6 3.4"/>',
        eye: '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>',
        'color-filter': '<path d="M13.58 13.79c.27 .68 .42 1.43 .42 2.21c0 1.77 -.77 3.37 -2 4.46a5.93 5.93 0 0 1 -4 1.54c-3.31 0 -6 -2.69 -6 -6c0 -2.76 1.88 -5.1 4.42 -5.79" /><path d="M17.58 10.21c2.54 .69 4.42 3.03 4.42 5.79c0 3.31 -2.69 6 -6 6a5.93 5.93 0 0 1 -4 -1.54" /><path d="M6 8a6 6 0 1 0 12 0a6 6 0 1 0 -12 0" />',
    };

    const root = document.getElementById('root');

    function iconSvg(name) {
        const inner = ICONS[name] || '';
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
    }

    function render(rows) {
        root.textContent = '';
        for (const row of rows) {
            const wrap = document.createElement('div');
            wrap.className = 'mtlx-action-row';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mtlx-action-btn ' + (row.variant || 'default');
            btn.disabled = !!row.disabled;
            btn.setAttribute('aria-label', row.label + (row.description ? '. ' + row.description : ''));
            if (row.description) btn.title = row.description;

            const icon = document.createElement('span');
            icon.className = 'mtlx-action-icon';
            icon.innerHTML = iconSvg(row.icon);
            btn.appendChild(icon);

            const label = document.createElement('span');
            label.className = 'mtlx-action-label';
            label.textContent = row.label;
            btn.appendChild(label);

            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                vscode.postMessage({ type: 'run', id: row.id });
            });

            wrap.appendChild(btn);
            if (row.disabled && row.description) {
                const note = document.createElement('div');
                note.className = 'mtlx-action-note';
                note.textContent = row.description;
                wrap.appendChild(note);
            }
            root.appendChild(wrap);
        }
    }

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg && msg.type === 'state' && Array.isArray(msg.rows)) render(msg.rows);
    });

    // The host may set the webview's html before this script's own message
    // listener is attached, so an eager host-side post could be dropped;
    // 'ready' lets the host know it's safe to send the first 'state' now.
    vscode.postMessage({ type: 'ready' });
}());
