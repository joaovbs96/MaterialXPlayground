// js/graph/panels.jsx — the Tab quick-add search palette and the
// parameter-panel input row (typed controls: color/vector spinners,
// enums, sliders, filename picker, text). Split out of js/graph-app.jsx
// (pure move, no behavior change) as part of the graph view's file split.
// Loaded after js/graph/style.jsx (consumes its typeColor window global)
// in the graph view's babelScripts manifest (see js/shell.jsx's
// VIEW_DEPS.graph). Like every other lazy-loaded file in this app, this
// file has NO top-level import/export — it self-exports via a single
// Object.assign(window, {}) at the bottom.

        // The Tab search palette: type-to-filter over the catalog,
        // arrows + Enter to add, Esc (or Tab again, or clicking away)
        // to close.
        // Value types offered for a new interface input/output — every
        // scalar/aggregate MaterialX data type plus the shader-ish ones a
        // nodegraph's boundary can carry.
        const IFACE_VALUE_TYPES = ['boolean', 'color3', 'color4', 'filename', 'float', 'integer',
            'matrix33', 'matrix44', 'string', 'vector2', 'vector3', 'vector4',
            'surfaceshader', 'displacementshader', 'volumeshader', 'BSDF', 'EDF', 'VDF', 'lightshader', 'material'];

        // filterMode/filterType power the port-dot double-click flow (item
        // 4): filterMode 'in' means the new node must be able to FEED the
        // port that was double-clicked (match on OUTPUT type, same as the
        // plain type-filter dropdown); 'out' means the new node must be able
        // to CONSUME it (match on some INPUT's type instead). null/'' is the
        // normal Tab/button-triggered flow, where the user drives the
        // dropdown themselves.
        function AddNodeSearch({ catalog, ifaceMode, onAddInterface, onPick, onClose, filterMode = null, filterType = '' }) {
            const [q, setQ] = React.useState('');
            const [typeFilter, setTypeFilter] = React.useState(filterType || '');
            const [hi, setHi] = React.useState(0);
            const inputRef = React.useRef(null);
            const listRef = React.useRef(null);
            // Second step for the two synthetic "interface input"/"output"
            // rows below — picking one doesn't add anything yet, it swaps
            // the palette body to this small name+type form.
            const [ifaceDraft, setIfaceDraft] = React.useState(null); // { kind, name, type }
            const nameRef = React.useRef(null);
            React.useEffect(() => {
                const t = setTimeout(() => { if (inputRef.current) inputRef.current.focus(); }, 0);
                return () => clearTimeout(t);
            }, []);
            React.useEffect(() => {
                if (!ifaceDraft) return;
                const t = setTimeout(() => { if (nameRef.current) nameRef.current.focus(); }, 0);
                return () => clearTimeout(t);
            }, [!!ifaceDraft]);
            // Distinct output types present across the whole catalog, for
            // the type-filter dropdown next to the search box.
            const typeOptions = React.useMemo(() => {
                const s = new Set();
                (catalog || []).forEach((c) => (c.signatures || []).forEach((sig) => { if (sig.type) s.add(sig.type); }));
                return Array.from(s).sort();
            }, [catalog]);
            const items = React.useMemo(() => {
                const s = q.trim().toLowerCase();
                const synth = [];
                if (ifaceMode) {
                    if (!s || 'interface input'.indexOf(s) !== -1 || 'input'.indexOf(s) !== -1) {
                        synth.push({ synthetic: 'iface-input', category: 'interface input' });
                    }
                    if (!s || 'output'.indexOf(s) !== -1) {
                        synth.push({ synthetic: 'iface-output', category: 'output' });
                    }
                }
                if (!catalog) return synth;
                let pool = catalog;
                if (typeFilter) {
                    pool = filterMode === 'out'
                        // The double-clicked port is an OUTPUT: the new node
                        // must be able to consume it, i.e. have some INPUT
                        // of that type.
                        ? pool.filter((c) => (c.signatures || []).some((sig) => (sig.inputs || []).some((i) => i.type === typeFilter)))
                        // Default (including filterMode 'in'): the new node
                        // must produce that type as its OUTPUT.
                        : pool.filter((c) => (c.signatures || []).some((sig) => sig.type === typeFilter));
                }
                const match = s ? pool.filter((c) =>
                    c.category.toLowerCase().indexOf(s) !== -1 ||
                    (c.group || '').toLowerCase().indexOf(s) !== -1) : pool;
                const rank = (c) => {
                    if (!s) return 2;
                    const n = c.category.toLowerCase();
                    if (n === s) return 0;
                    if (n.indexOf(s) === 0) return 1;
                    if (n.indexOf(s) !== -1) return 2;
                    return 3; // matched on the group only
                };
                return synth.concat(match.slice()
                    .sort((a, b) => rank(a) - rank(b) || a.category.localeCompare(b.category))
                    .slice(0, 60));
            }, [catalog, q, ifaceMode, typeFilter, filterMode]);
            React.useEffect(() => { setHi(0); }, [q]);
            React.useEffect(() => { // keep the highlighted row in view
                const el = listRef.current && listRef.current.children[hi];
                if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
            }, [hi, items]);
            const pick = (c) => {
                if (c.synthetic) setIfaceDraft({ kind: c.synthetic, name: '', type: 'color3' });
                else onPick(c, typeFilter);
            };
            const confirmIface = () => {
                if (!ifaceDraft) return;
                onAddInterface(ifaceDraft.kind, ifaceDraft.name, ifaceDraft.type);
                onClose();
            };
            const onKeyDown = (e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, Math.max(items.length - 1, 0))); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
                else if (e.key === 'Enter') { e.preventDefault(); if (items[hi]) pick(items[hi]); }
                else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); onClose(); }
            };
            const onDraftKeyDown = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); confirmIface(); }
                else if (e.key === 'Escape') { e.preventDefault(); setIfaceDraft(null); }
            };
            return (
                <div className="absolute inset-0 z-40" onMouseDown={onClose}>
                    <div
                        className="absolute left-1/2 -translate-x-1/2 top-16 w-[22rem] max-w-[90%] bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl overflow-hidden"
                        onMouseDown={(e) => e.stopPropagation()}
                    >
                        {ifaceDraft ? (
                            <div onKeyDown={onDraftKeyDown}>
                                <div className="px-3 py-2 border-b border-gray-700 text-[11px] text-gray-400 italic">
                                    New {ifaceDraft.kind === 'iface-input' ? 'interface input' : 'output'}
                                </div>
                                <div className="px-3 py-2.5 space-y-2">
                                    <input
                                        ref={nameRef}
                                        className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-[12px] font-mono text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
                                        placeholder={'name (optional — auto)'}
                                        value={ifaceDraft.name}
                                        spellCheck={false}
                                        onChange={(e) => setIfaceDraft(Object.assign({}, ifaceDraft, { name: e.target.value }))}
                                    />
                                    <select
                                        className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-[12px] font-mono text-gray-200 focus:border-blue-500 focus:outline-none"
                                        value={ifaceDraft.type}
                                        onChange={(e) => setIfaceDraft(Object.assign({}, ifaceDraft, { type: e.target.value }))}
                                    >
                                        {IFACE_VALUE_TYPES.map((t) => (
                                            <option key={t} value={t} style={{ color: typeColor(t) }}>{t}</option>
                                        ))}
                                    </select>
                                    <div className="flex items-center gap-2 pt-0.5">
                                        <button
                                            onClick={confirmIface}
                                            className="h-7 text-[11px] px-2.5 rounded border bg-blue-600/80 border-blue-500 text-gray-100 hover:bg-blue-600 transition-colors"
                                        >Add</button>
                                        <button
                                            onClick={() => setIfaceDraft(null)}
                                            className="h-7 text-[11px] px-2.5 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                                        >Back</button>
                                    </div>
                                </div>
                                <div className="px-3 py-1.5 border-t border-gray-700 text-[10px] text-gray-500">
                                    Enter add {'·'} Esc back
                                </div>
                            </div>
                        ) : (<React.Fragment>
                        <div className="flex items-stretch border-b border-gray-700">
                            <input
                                ref={inputRef}
                                className="flex-1 min-w-0 bg-gray-900 px-3 py-2 text-sm font-mono text-gray-100 placeholder-gray-500 focus:outline-none"
                                placeholder={filterMode ? 'Add a connected node…' : 'Add a node — type to search…'}
                                value={q}
                                spellCheck={false}
                                onChange={(e) => setQ(e.target.value)}
                                onKeyDown={onKeyDown}
                            />
                            <select
                                className="flex-none w-24 bg-gray-900 border-l border-gray-700 px-1.5 text-[11px] font-mono text-gray-300 rounded-none focus:outline-none focus:border-blue-500 disabled:opacity-70"
                                value={typeFilter}
                                title={filterMode
                                    ? ('Locked to the port you double-clicked (' + typeFilter + ')')
                                    : 'Filter by output type'}
                                disabled={!!filterMode}
                                onChange={(e) => setTypeFilter(e.target.value)}
                            >
                                <option value="">Any type</option>
                                {typeOptions.map((t) => (
                                    <option key={t} value={t} style={{ color: typeColor(t) }}>{t}</option>
                                ))}
                            </select>
                        </div>
                        <div ref={listRef} className="max-h-72 overflow-y-auto custom-scrollbar">
                            {!catalog && !items.length && (
                                <div className="px-3 py-3 text-[11px] text-gray-500 animate-pulse">Loading the node library {'…'}</div>
                            )}
                            {catalog && !items.length && (
                                <div className="px-3 py-3 text-[11px] text-gray-500">No node matches {'“'}{q}{'”'}.</div>
                            )}
                            {items.map((c, i) => (
                                <button
                                    key={(c.synthetic || 'n') + ':' + c.category}
                                    onMouseEnter={() => setHi(i)}
                                    onClick={() => pick(c)}
                                    className={'w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] font-mono transition-colors '
                                        + (i === hi ? 'bg-blue-600/30 text-gray-100' : 'text-gray-300 hover:bg-gray-700/60')}
                                >
                                    {c.synthetic ? (
                                        <React.Fragment>
                                            <span className="w-2 h-2 rotate-45 flex-none border" style={{ background: 'transparent', borderColor: '#94a3b8' }} />
                                            <span className="truncate italic">{c.category}</span>
                                            <span className="ml-auto flex-none text-[8px] uppercase tracking-wider text-gray-500 border border-gray-600 border-dashed rounded px-1">interface</span>
                                        </React.Fragment>
                                    ) : (
                                        <React.Fragment>
                                            <span className="w-2 h-2 rounded-full flex-none" style={{ background: typeColor(typeFilter || (c.signatures[0] || {}).type || '') }} />
                                            <span className="truncate">{c.category}</span>
                                            {c.signatures.length > 1 && (
                                                <span className="ml-auto flex-none text-[9px] text-gray-500" title="This category has several signatures — pick one in the properties panel after adding">{c.signatures.length} sigs</span>
                                            )}
                                            {c.group && <span className={(c.signatures.length > 1 ? '' : 'ml-auto ') + 'flex-none text-[9px] text-gray-500 uppercase tracking-wider'}>{c.group}</span>}
                                        </React.Fragment>
                                    )}
                                </button>
                            ))}
                        </div>
                        <div className="px-3 py-1.5 border-t border-gray-700 text-[10px] text-gray-500">
                            {'↑↓'} select {'·'} Enter add {'·'} Esc close
                        </div>
                        </React.Fragment>)}
                    </div>
                </div>
            );
        }

        // "0.8, 0.8, 0.8" (color3/color4) → CSS color for a preview swatch;
        // null when the value doesn't parse.
        // ---- Typed parameter controls --------------------------------------
        // Mirrors the docs-page node previewer: color3/4 → color picker +
        // per-channel spinners (both speak LINEAR 0-1; rgbToHex/hexToRgb are
        // a plain byte↔float map, no sRGB transfer); vectorN → per-component
        // spinners; float/integer → spinner (+ slider when the nodedef
        // declares a UI range); enums → dropdowns; boolean → checkbox;
        // strings/filenames → text committed on blur/Enter.
        const VEC_SIZE = { color3: 3, color4: 4, vector2: 2, vector3: 3, vector4: 4 };
        const parseComps = (s, n) => {
            const parts = String(s || '').split(',').map((x) => parseFloat(x));
            const out = [];
            for (let i = 0; i < n; i++) out.push(isFinite(parts[i]) ? parts[i] : 0);
            return out;
        };
        const numStr = (x) => {
            const n = Number(x);
            return isFinite(n) ? String(parseFloat(n.toFixed(6))) : '0';
        };
        const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter((x) => x.length);

        // One parameter row. Connected inputs show — and jump to — the node
        // feeding them. Unconnected ones edit the literal value. Text-ish
        // fields commit on blur or Enter; the structured controls (picker,
        // spinners, sliders) commit through a short debounce, because every
        // commit writes the document and recompiles the shader — per-tick
        // commits while dragging a slider would thrash the generator.
        // Continuous controls also fire onLive per input tick for a GPU-side
        // live preview, while the debounced commit owns the document write.
        function ParamRow({ nodeId, inp, readOnly, sourceId, onJump, onCommit, onLive, onPickFile, onSetColorspace }) {
            const [draft, setDraft] = React.useState(inp.value || '');
            React.useEffect(() => { setDraft(inp.value || ''); }, [nodeId, inp.name, inp.value]);
            // Raw per-component TEXT for vector/color inputs — kept separate
            // from the numeric `comps` derived below so the <input>'s value
            // is always exactly what the user typed (see commentary at the
            // vecN branch of control() for why this matters for caret pos).
            const [compText, setCompText] = React.useState(
                () => parseComps(inp.value || '', VEC_SIZE[inp.type] || 0).map(numStr)
            );
            React.useEffect(() => {
                setCompText(parseComps(inp.value || '', VEC_SIZE[inp.type] || 0).map(numStr));
            }, [nodeId, inp.name, inp.value]);
            const onCommitRef = React.useRef(onCommit);
            onCommitRef.current = onCommit;
            const inpValRef = React.useRef(inp.value || '');
            inpValRef.current = inp.value || '';
            const timerRef = React.useRef(null);
            const pendingRef = React.useRef(null);
            const flush = () => {
                if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
                if (pendingRef.current !== null && pendingRef.current !== inpValRef.current) {
                    onCommitRef.current(pendingRef.current);
                }
                pendingRef.current = null;
            };
            const commitSoon = (v) => {
                setDraft(v);
                if (onLive) onLive(v);
                pendingRef.current = v;
                if (timerRef.current) clearTimeout(timerRef.current);
                timerRef.current = setTimeout(flush, 300);
            };
            // Like commitSoon, but the DRAFT shown to the user (`raw`, e.g.
            // the exact text just typed, possibly "-", "1.", "") can differ
            // from the VALUE that gets committed to the document (`v`, a
            // canonicalized number string) — controlled numeric <input>s
            // reset their caret to the end whenever `.value` is reassigned
            // to something other than what's currently displayed, so
            // reformatting on every keystroke makes backspace unusable.
            const commitSoonRaw = (raw, v) => {
                setDraft(raw);
                if (onLive) onLive(v);
                pendingRef.current = v;
                if (timerRef.current) clearTimeout(timerRef.current);
                timerRef.current = setTimeout(flush, 300);
            };
            const commitNow = (v) => { setDraft(v); pendingRef.current = v; flush(); };
            React.useEffect(() => flush, []); // unmount: don't drop a pending edit
            const commit = () => { flush(); if (draft !== (inp.value || '')) onCommit(draft); };

            const vecN = VEC_SIZE[inp.type] || 0;
            const isColor = inp.type === 'color3' || inp.type === 'color4';
            const enumNames = splitList(inp.enumNames);
            const enumValues = splitList(inp.enumValues);
            const boxCls = 'bg-gray-900 border border-gray-600 rounded text-[11px] font-mono text-gray-200 focus:border-blue-500 focus:outline-none';

            // color3/color4 VALUE inputs can also carry a colorspace, but
            // it's rarely touched — the picker starts collapsed and only
            // auto-expands when the instance (or a signature/version swap)
            // already authors one, so it doesn't compete for space with
            // the swatch on every color row.
            const [csOpen, setCsOpen] = React.useState(!!inp.colorspace);
            React.useEffect(() => { setCsOpen(!!inp.colorspace); }, [nodeId, inp.name, inp.colorspace]);

            // Shared colorspace <select> row — used by the filename branch
            // (always) and the color3/color4 branch (behind the collapse
            // toggle) so the two don't drift apart.
            const colorspaceRow = () => (
                <div className="flex items-center gap-1.5">
                    <span className="flex-none text-[9px] text-gray-500" title="Color space of the image — baked into the generated shader">colorspace</span>
                    <select
                        className={'flex-1 min-w-0 px-1 py-0.5 ' + boxCls}
                        value={inp.colorspace || ''}
                        onChange={(e) => { if (onSetColorspace) onSetColorspace(e.target.value); }}
                    >
                        <option value="">{'(default' + (inp.defColorspace ? ': ' + inp.defColorspace : '') + ')'}</option>
                        {COLORSPACES.map((cs) => <option key={cs} value={cs}>{cs}</option>)}
                    </select>
                </div>
            );

            const textField = () => (
                <input
                    className={'flex-1 min-w-0 px-1.5 py-0.5 placeholder-gray-600 ' + boxCls}
                    value={draft}
                    placeholder="(no value)"
                    spellCheck={false}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { commit(); e.target.blur(); }
                        if (e.key === 'Escape') { setDraft(inp.value || ''); e.target.blur(); }
                    }}
                />
            );

            const control = () => {
                // Enum → dropdown. Numeric enums map names onto enumvalues
                // (or the index); string enums: the name IS the value.
                if (enumNames.length) {
                    const isNum = inp.type === 'integer' || inp.type === 'float';
                    const useValues = isNum && enumValues.length === enumNames.length;
                    const valOf = (i) => useValues ? enumValues[i] : (isNum ? String(i) : enumNames[i]);
                    let sel = -1;
                    for (let i = 0; i < enumNames.length; i++) {
                        if (isNum ? parseFloat(valOf(i)) === parseFloat(draft) : valOf(i) === draft) { sel = i; break; }
                    }
                    return (
                        <select
                            className={'w-full px-1.5 py-0.5 ' + boxCls}
                            value={sel === -1 ? '' : String(sel)}
                            onChange={(e) => {
                                const i = parseInt(e.target.value, 10);
                                if (!isNaN(i)) commitNow(valOf(i));
                            }}
                        >
                            {sel === -1 && <option value="">({draft === '' ? 'unset' : draft})</option>}
                            {enumNames.map((nm, i) => <option key={i} value={String(i)}>{nm}</option>)}
                        </select>
                    );
                }
                if (inp.type === 'boolean') {
                    return (
                        <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-blue-500"
                            checked={draft === 'true'}
                            onChange={(e) => commitNow(e.target.checked ? 'true' : 'false')}
                        />
                    );
                }
                // color3/4 and vector2/3/4: per-component spinners; colors
                // additionally get the native picker on the RGB part.
                if (vecN) {
                    // Numeric components (for the color picker + committing)
                    // derive from the RAW per-component text, not the other
                    // way around — see compText's declaration up top.
                    const comps = compText.map((s) => {
                        const n = parseFloat(s);
                        return isFinite(n) ? n : 0;
                    });
                    const setComp = (i, raw) => {
                        const nv = compText.slice();
                        nv[i] = raw;
                        setCompText(nv);
                        const n = parseFloat(raw);
                        if (isNaN(n)) return; // e.g. "", "-", "1." — keep displaying, don't commit yet
                        const clamped = isColor ? Math.max(0, Math.min(1, n)) : n;
                        const nums = nv.map((s2, j) => {
                            if (j === i) return clamped;
                            const n2 = parseFloat(s2);
                            return isFinite(n2) ? n2 : 0;
                        });
                        // `draft` (the whole-vector string) isn't bound to
                        // any input's value directly anymore — it only
                        // needs to hold the canonical committed value.
                        commitSoon(nums.map(numStr).join(', '));
                    };
                    const chan = isColor ? 'RGBA' : 'XYZW';
                    const fmt = (n) => Math.round(Number(n) * 1000) / 1000; // display only
                    return (
                        <div>
                            <div className="flex items-center gap-1">
                                {isColor && (
                                    <button
                                        type="button"
                                        onClick={() => setCsOpen((v) => !v)}
                                        title="Colorspace…"
                                        className="flex-none flex items-center text-gray-400 hover:text-gray-200 px-0.5 self-stretch"
                                    ><MtlxIcon name={csOpen ? 'chevron-down' : 'chevron-right'} className="w-3.5 h-3.5" /></button>
                                )}
                                {isColor && (
                                    <ColorSwatch
                                        rgb={comps.slice(0, 3)}
                                        className="w-full self-stretch h-6 min-w-0 p-0 bg-transparent border border-gray-600 rounded cursor-pointer"
                                        title="Linear RGB — hex bytes map 1:1 onto the 0-1 values to the right"
                                        onChange={(nv) => {
                                            if (vecN === 4) nv.push(comps[3]);
                                            setCompText(nv.map(numStr));
                                            commitSoon(nv.map(numStr).join(', '));
                                        }}
                                    />
                                )}
                                {compText.map((s, i) => (
                                    <input
                                        key={i} type="number"
                                        min={isColor ? 0 : undefined} max={isColor ? 1 : undefined}
                                        step={0.01}
                                        title={chan[i] + (isColor ? ' (linear, 0-1)' : '')}
                                        className={'w-full min-w-0 px-1 py-0.5 ' + boxCls}
                                        value={s}
                                        onChange={(e) => setComp(i, e.target.value)}
                                        onBlur={(e) => {
                                            const v = String(fmt(comps[i]));
                                            e.target.value = v;
                                            const nv = compText.slice();
                                            nv[i] = v;
                                            setCompText(nv);
                                        }}
                                    />
                                ))}
                            </div>
                            {isColor && csOpen && (
                                <div className="mt-1">{colorspaceRow()}</div>
                            )}
                        </div>
                    );
                }
                if (inp.type === 'float' || inp.type === 'integer') {
                    const lo = parseFloat(inp.uisoftmin !== '' && inp.uisoftmin != null ? inp.uisoftmin : inp.uimin);
                    const hi = parseFloat(inp.uisoftmax !== '' && inp.uisoftmax != null ? inp.uisoftmax : inp.uimax);
                    const hasRange = isFinite(lo) && isFinite(hi) && hi > lo;
                    const step = inp.type === 'integer' ? 1 : (hasRange ? Math.max((hi - lo) / 200, 0.001) : 0.01);
                    const parse = (s) => (inp.type === 'integer' ? parseInt(s, 10) : parseFloat(s));
                    const cur = parseFloat(draft);
                    const curN = isFinite(cur) ? cur : 0;
                    return (
                        <div className="flex items-center gap-1.5">
                            {hasRange && (
                                <input
                                    type="range" className="flex-1 min-w-0 accent-blue-500"
                                    min={lo} max={hi} step={step}
                                    value={Math.max(lo, Math.min(hi, curN))}
                                    onChange={(e) => commitSoon(numStr(parse(e.target.value)))}
                                />
                            )}
                            <input
                                type="number"
                                className={(hasRange ? 'w-16 flex-none' : 'w-full min-w-0') + ' px-1 py-0.5 ' + boxCls}
                                step={step} value={draft}
                                onChange={(e) => {
                                    const raw = e.target.value;
                                    const n = parse(raw);
                                    // Bind to the raw typed text, not a
                                    // reparsed/reformatted number — see
                                    // commitSoonRaw's comment. Intermediate
                                    // states like "", "-", "1." stay
                                    // displayed but don't commit.
                                    if (!isNaN(n)) commitSoonRaw(raw, numStr(n));
                                    else setDraft(raw);
                                }}
                                onBlur={() => setDraft(numStr(curN))}
                            />
                        </div>
                    );
                }
                // Filename → image picker (joins the session's file map,
                // bound onto the shader like a dropped file) + editable
                // name field, with the COLORSPACE select right underneath.
                // Colorspace is a codegen decision (the CMS bakes the
                // transform into the shader), so picking one recompiles.
                if (inp.type === 'filename') {
                    return (
                        <div className="space-y-1">
                            <div className="flex items-center gap-1.5">
                                <label
                                    className="flex-none text-[10px] px-1.5 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 cursor-pointer"
                                    title="Load an image file — it joins the session files and binds by name"
                                >
                                    Choose{'\u2026'}
                                    <input
                                        type="file" accept="image/png,image/jpeg,image/webp,image/gif"
                                        className="hidden"
                                        onChange={(e) => {
                                            const f = e.target.files && e.target.files[0];
                                            if (f && onPickFile) onPickFile(f);
                                            // Clear so re-picking the SAME file
                                            // still fires a change event.
                                            e.target.value = '';
                                        }}
                                    />
                                </label>
                                {textField()}
                            </div>
                            {/* Colorspace is only meaningful when the node's
                                resolved output is color3/color4 — never hide
                                it, though, when the instance already
                                authors one (e.g. after a signature/version
                                swap that no longer resolves to a color
                                output but left the attribute in place). */}
                            {(inp.colorManaged || inp.colorspace) && colorspaceRow()}
                        </div>
                    );
                }
                // string / matrices / everything else.
                return <div className="flex items-center gap-1.5">{textField()}</div>;
            };

            return (
                <div className="py-1.5 border-b border-gray-700/60 last:border-b-0">
                    <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="w-2 h-2 rounded-full flex-none" style={{ background: typeColor(inp.type) }} />
                        <span className="text-gray-300 truncate">{inp.name}</span>
                        <span className="ml-auto flex-none text-[9px]" style={{ color: typeColor(inp.type) }}>{inp.type}</span>
                    </div>
                    {inp.connected ? (
                        sourceId ? (
                            <button
                                onClick={() => onJump(sourceId)}
                                title="Select and show the node this input is connected to"
                                className="mt-1 ml-3.5 max-w-[calc(100%-0.875rem)] text-left text-[10px] text-blue-300 hover:text-blue-200 font-mono underline decoration-dotted truncate block"
                            >{'\u2190'} from {sourceId.slice(2)}</button>
                        ) : (
                            <div className="mt-1 ml-3.5 text-[10px] text-gray-500 font-mono">{'\u2190'} set by connection</div>
                        )
                    ) : readOnly ? (
                        <div className="mt-1 ml-3.5 text-[11px] text-gray-400 font-mono truncate" title={inp.value}>
                            {inp.value !== '' ? inp.value : '\u2014'}
                        </div>
                    ) : (
                        <div className="mt-1 ml-3.5">{control()}</div>
                    )}
                </div>
            );
        }

Object.assign(window, { AddNodeSearch, ParamRow, VEC_SIZE });
