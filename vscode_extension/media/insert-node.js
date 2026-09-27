// insert-node.js: webview-side script for the materialxPlayground.
// insertNode view. Renders the host's row list (name/library/output
// types), filters it locally by search text and the output-type select,
// and posts {type:'insert', category, outputType} on click/Enter -- the
// host re-validates category against its own known categories, this
// script never inserts text itself. Plain DOM, no frameworks.
(function () {
    const vscode = acquireVsCodeApi();

    const note = document.getElementById('mtlx-insert-note');
    const toolbar = document.getElementById('mtlx-insert-toolbar');
    const searchInput = document.getElementById('mtlx-insert-search');
    const typeSelect = document.getElementById('mtlx-insert-type');
    const list = document.getElementById('mtlx-insert-list');
    const empty = document.getElementById('mtlx-insert-empty');

    let allRows = [];
    let hasEditor = false;

    function matches(row, term, type) {
        if (type && row.outputTypes.indexOf(type) === -1) return false;
        if (!term) return true;
        const hay = (row.name + ' ' + (row.library || '')).toLowerCase();
        return hay.indexOf(term) !== -1;
    }

    function render() {
        const term = searchInput.value.trim().toLowerCase();
        const type = typeSelect.value;
        list.textContent = '';
        let count = 0;
        for (const row of allRows) {
            if (!matches(row, term, type)) continue;
            count++;

            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'mtlx-insert-item';
            item.disabled = !hasEditor;
            item.setAttribute('role', 'listitem');
            item.setAttribute('aria-label', row.name + (row.library ? ', ' + row.library : ''));

            const name = document.createElement('span');
            name.className = 'mtlx-insert-name';
            name.textContent = row.name;
            item.appendChild(name);

            const bits = [];
            if (row.library) bits.push(row.library);
            if (row.outputTypes.length) bits.push('→ ' + row.outputTypes.join(', '));
            if (bits.length) {
                const meta = document.createElement('span');
                meta.className = 'mtlx-insert-meta';
                meta.textContent = bits.join('  •  ');
                item.appendChild(meta);
            }

            const run = () => {
                if (item.disabled) return;
                vscode.postMessage({ type: 'insert', category: row.name, outputType: type });
            };
            item.addEventListener('click', run);
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); run(); }
            });
            list.appendChild(item);
        }
        empty.hidden = count > 0;
    }

    searchInput.addEventListener('input', render);
    typeSelect.addEventListener('change', render);

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || msg.type !== 'state') return;

        hasEditor = !!msg.hasEditor;
        allRows = Array.isArray(msg.rows) ? msg.rows : [];

        note.hidden = hasEditor;
        note.textContent = msg.note || '';
        toolbar.setAttribute('aria-disabled', String(!hasEditor));
        searchInput.disabled = !hasEditor;
        typeSelect.disabled = !hasEditor;

        if (Array.isArray(msg.outputTypes)) {
            const current = typeSelect.value;
            typeSelect.textContent = '';
            const anyOpt = document.createElement('option');
            anyOpt.value = '';
            anyOpt.textContent = 'Any output type';
            typeSelect.appendChild(anyOpt);
            for (const t of msg.outputTypes) {
                const opt = document.createElement('option');
                opt.value = t;
                opt.textContent = t;
                typeSelect.appendChild(opt);
            }
            typeSelect.value = current;
        }
        render();
    });

    vscode.postMessage({ type: 'ready' });
}());
