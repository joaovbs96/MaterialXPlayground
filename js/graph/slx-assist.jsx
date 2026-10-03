// js/graph/slx-assist.jsx: the code view's assist popups: the completion
// list, parameter hints and the hover card. Presentational only: what they
// show comes from js/graph/slx-language.jsx, and SlxCodeEditor
// (js/graph/code-view.jsx) decides when they show and where. Each is
// position: fixed, portaled out of the panel and placed through `elRef`.
// Colours are code-view.jsx's .slx-assist-* / .slx-kind-* classes (its
// SLX_SYNTAX_THEME). Self-exports via Object.assign(window, {}); no
// top-level import/export.

        const SLX_ASSIST_BOX = 'fixed left-0 top-0 z-[80] rounded border border-gray-600 bg-gray-800 shadow-xl '
            + 'text-[11px] leading-4 text-gray-300 font-sans';
        // Hover lists this many signatures, then "+N more".
        const SLX_HOVER_MAX_SIGNATURES = 6;

        const slxPortal = (el) => ReactDOM.createPortal(el, fullscreenPortalRoot());

        // A signature in SLX syntax (see slx-language.jsx's slxSignatureText).
        // `active`, a parameter index, is emphasised.
        function SlxSignature({ sig, active = -1 }) {
            const type = (t, cls = 'slx-assist-type') => <span className={cls}>{slxTypeDisplay(t)}</span>;
            return (
                <code className="font-mono text-[12px] leading-[18px] text-gray-300 whitespace-pre-wrap break-words">
                    {type(sig.ret)}{' '}<span className="slx-assist-func">{sig.name}</span>
                    {sig.template && (
                        <React.Fragment>
                            {'<'}
                            {sig.template.map((t, i) => <React.Fragment key={i}>{i ? ', ' : ''}{type(t)}</React.Fragment>)}
                            {'>'}
                        </React.Fragment>
                    )}
                    {'('}
                    {sig.params.map((p, i) => (
                        <React.Fragment key={i}>
                            {i ? ', ' : ''}
                            {i === active
                                ? <span className="slx-assist-active">{type(p.type, '')}{' ' + p.name}</span>
                                : <span>{type(p.type)}{' '}<span className="slx-assist-param">{p.name}</span></span>}
                        </React.Fragment>
                    ))}
                    {')'}
                </code>
            );
        }

        const SLX_KIND_BADGES = { function: 'ƒ', variable: 'x', keyword: 'k', type: 'T', directive: '#' };

        // `label` with the characters at `positions` (what was typed) lit.
        const slxMatchedLabel = (label, positions) => {
            if (!positions.length) return label;
            const lit = new Set(positions);
            const parts = [];
            for (let i = 0; i < label.length;) {
                let j = i;
                while (j < label.length && lit.has(j) === lit.has(i)) j++;
                parts.push(lit.has(i) ? <span key={i} className="slx-assist-match">{label.slice(i, j)}</span> : label.slice(i, j));
                i = j;
            }
            return parts;
        };

        // The completion list: `entries` from slxFilterCompletions, the
        // `index`th selected, with the selected function's first signature
        // and description underneath. Clicking a row picks it; the list
        // never takes focus from the editor.
        function SlxCompletionList({ entries, index, onPick, elRef }) {
            const listRef = React.useRef(null);
            // Keep the selected row in view.
            React.useLayoutEffect(() => {
                const list = listRef.current;
                const row = list && list.children[index];
                if (!row) return;
                if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
                else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
                    list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
                }
            }, [index, entries]);
            const selected = entries[index] ? entries[index].item : null;
            const sigs = selected && selected.sigs && selected.sigs.length ? selected.sigs : null;
            return slxPortal(
                <div
                    ref={elRef}
                    className={SLX_ASSIST_BOX + ' w-[380px] max-w-[calc(100vw-16px)] overflow-hidden'}
                    onMouseDown={(e) => e.preventDefault()}
                >
                    <div ref={listRef} role="listbox" aria-label="Suggestions" className="max-h-[200px] overflow-y-auto custom-scrollbar py-0.5">
                        {entries.map((entry, i) => (
                            <div
                                key={entry.item.kind + ':' + entry.item.label}
                                role="option"
                                aria-selected={i === index}
                                onClick={() => onPick(i)}
                                className={'flex items-center gap-1.5 h-5 px-1.5 cursor-pointer '
                                    + (i === index ? 'slx-assist-selected text-gray-100' : 'hover:bg-white/5')}
                            >
                                <span className={'flex-none w-3 text-center font-mono slx-kind-' + entry.item.kind}>{SLX_KIND_BADGES[entry.item.kind]}</span>
                                <span className="font-mono text-[12px] truncate">{slxMatchedLabel(entry.item.label, entry.positions)}</span>
                                <span className="ml-auto pl-3 flex-none max-w-[50%] truncate text-[10px] text-gray-500">{entry.item.detail}</span>
                            </div>
                        ))}
                        {!entries.length && <div className="px-2 h-5 flex items-center text-gray-500">No suggestions.</div>}
                    </div>
                    {selected && (sigs || selected.description) && (
                        <div className="border-t border-gray-700 px-2 py-1.5">
                            {sigs && <SlxSignature sig={sigs[0]} />}
                            {sigs && sigs.length > 1 && <span className="text-gray-500">{' '}+{sigs.length - 1} more</span>}
                            {selected.description && <div className="mt-1 text-gray-400 line-clamp-3">{selected.description}</div>}
                        </div>
                    )}
                </div>
            );
        }

        // Parameter hints for the call the caret is in: `help` is
        // { sigs, index, active, description }. The arrows (and Up/Down in
        // the editor) step through the signatures when there are several.
        function SlxParameterHints({ help, onCycle, elRef }) {
            const sig = help.sigs[help.index];
            const param = help.active >= 0 ? sig.params[help.active] : null;
            // A long signature (standard_surface) scrolls: keep the active
            // parameter in view.
            React.useLayoutEffect(() => {
                const box = elRef.current;
                const active = box && box.querySelector('.slx-assist-active');
                if (!active) return;
                const a = active.getBoundingClientRect();
                const b = box.getBoundingClientRect();
                if (a.top < b.top || a.bottom > b.bottom) box.scrollTop += a.top - b.top - (b.height - a.height) / 2;
            }, [help.index, help.active]);
            const arrow = (step, label, title) => (
                <button type="button" tabIndex={-1} title={title} onClick={() => onCycle(step)} className="px-0.5 hover:text-gray-200">{label}</button>
            );
            return slxPortal(
                <div
                    ref={elRef}
                    role="tooltip"
                    className={SLX_ASSIST_BOX + ' max-w-[min(560px,calc(100vw-16px))] max-h-[40vh] overflow-y-auto custom-scrollbar px-2 py-1'}
                    onMouseDown={(e) => e.preventDefault()}
                >
                    <div className="flex items-start gap-1.5">
                        {help.sigs.length > 1 && (
                            <span className="flex-none flex items-center font-mono text-[11px] leading-[18px] text-gray-500 select-none">
                                {arrow(-1, '▲', 'Previous signature (Up)')}
                                {help.index + 1}/{help.sigs.length}
                                {arrow(1, '▼', 'Next signature (Down)')}
                            </span>
                        )}
                        <SlxSignature sig={sig} active={help.active} />
                    </div>
                    {param && (param.doc || param.defaultText) && (
                        <div className="mt-0.5">
                            <span className="font-mono slx-assist-param">{param.name}</span>
                            {param.doc && ': ' + param.doc}
                            {param.defaultText && (
                                <span className="text-gray-500">
                                    {param.doc ? ' ' : ': '}Default <code className="font-mono text-gray-400">{param.defaultText}</code>
                                </span>
                            )}
                        </div>
                    )}
                    {help.description && <div className="mt-0.5 text-gray-400 line-clamp-2">{help.description}</div>}
                </div>
            );
        }

        // The hover card for a standard library call: its signatures and
        // description (`fn` from the library, null while it loads), and how
        // to open its documentation.
        function SlxHoverCard({ name, fn, elRef }) {
            const sigs = fn ? fn.sigs.slice(0, SLX_HOVER_MAX_SIGNATURES) : [];
            const more = fn ? fn.sigs.length - sigs.length : 0;
            const body = sigs.length > 0 || !!(fn && fn.description);
            return slxPortal(
                <div
                    ref={elRef}
                    role="tooltip"
                    className={SLX_ASSIST_BOX + ' pointer-events-none max-w-[min(520px,calc(100vw-16px))] max-h-[50vh] overflow-hidden px-2 py-1.5'}
                >
                    {sigs.map((sig, i) => <div key={i}><SlxSignature sig={sig} /></div>)}
                    {more > 0 && <div className="text-gray-500">+{more} more signature{more === 1 ? '' : 's'}</div>}
                    {fn && fn.description && <div className="mt-1 line-clamp-4">{fn.description}</div>}
                    <div className={body ? 'mt-1 text-gray-500' : ''}>
                        {!body && <span className="font-mono text-gray-100">{name}: </span>}
                        Ctrl/Cmd + click to open its documentation
                    </div>
                </div>
            );
        }

Object.assign(window, { SlxSignature, SlxCompletionList, SlxParameterHints, SlxHoverCard });
