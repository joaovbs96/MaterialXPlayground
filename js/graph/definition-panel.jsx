// js/graph/definition-panel.jsx: sidebar panel for a definition card
// (nodedef/functional graph): its own metadata, inputs, outputs, and
// implementation graphs. Self-exports via Object.assign(window, {}).

        // GROUP_HEADER_CLASS, ICON_BTN_SM* now live in js/shared/mtlx-ui.jsx;
        // PILL_ACTION_SM lives in js/shared/ui-commons.js.

        // The definition card's scroll body has no side padding (so this
        // header can reach both edges); swap the negative-margin/overflow
        // tokens for a plain full-width one instead.
        const DEF_SECTION_HEADER_CLASS = GROUP_HEADER_CLASS
            .replace('w-[calc(100%+1.25rem)]', 'w-full')
            .replace('-mx-2.5 ', '');

        // Each babelScripts file runs in its own IIFE (see js/shell.jsx),
        // so panels.jsx's module-local splitList isn't reachable here.
        const defSplitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter((x) => x.length);

        // Class for the name/value fields inside add rows (input/output/enum),
        // matching IfaceMetaField's own box but without its flex-1 sizing.
        const DEF_ADD_FIELD = 'flex-1 min-w-0 h-6 py-0 px-1.5 placeholder-gray-600 bg-gray-900 border border-gray-600 rounded '
            + 'text-[11px] font-mono text-gray-200 focus:border-blue-500 focus:outline-none disabled:opacity-50';

        // Label + control row, same idiom as graph-app.jsx's Interface group.
        function DefFieldRow({ label, children }) {
            return (
                <div className="flex items-center gap-1.5">
                    <span className="w-24 flex-none text-[10px] text-gray-500 font-mono truncate" title={label}>{label}</span>
                    {children}
                </div>
            );
        }

        // Multi-line blur/Enter-committing field for `doc` strings, same
        // draft/re-seed idiom as IfaceMetaField but a <textarea>. The native
        // resize corner doesn't match the site, so it's disabled in favor
        // of a custom drag handle (same pointer-capture idiom as ReorderList).
        function DefDocField({ value, placeholder, onCommit, readOnly }) {
            const [draft, setDraft] = React.useState(value || '');
            const [height, setHeight] = React.useState(72);
            const dragRef = React.useRef(null); // { startY, startHeight }
            React.useEffect(() => { setDraft(value || ''); }, [value]);
            const commit = () => { if (draft !== (value || '')) onCommit(draft); };

            const clamp = (h) => Math.max(56, Math.min(256, h));
            const onPointerMove = (e) => {
                const d = dragRef.current;
                if (!d) return;
                setHeight(clamp(d.startHeight + (e.clientY - d.startY)));
            };
            const endDrag = () => {
                dragRef.current = null;
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', endDrag);
            };
            const startDrag = (e) => {
                dragRef.current = { startY: e.clientY, startHeight: height };
                mxSafe(() => { e.currentTarget.setPointerCapture(e.pointerId); return true; }, false);
                window.addEventListener('pointermove', onPointerMove);
                window.addEventListener('pointerup', endDrag);
            };

            return (
                <div className="relative w-full">
                    <textarea
                        className={'block w-full pl-1.5 pr-4 py-0.5 placeholder-gray-600 bg-gray-900 border border-gray-600 rounded '
                            + 'text-[11px] font-mono text-gray-200 focus:border-blue-500 focus:outline-none resize-none custom-scrollbar'
                            + (readOnly ? ' opacity-60' : '')}
                        style={{ height }}
                        value={draft}
                        placeholder={placeholder}
                        spellCheck={false}
                        readOnly={!!readOnly}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commit}
                        onKeyDown={(e) => { if (e.key === 'Escape') { setDraft(value || ''); e.target.blur(); } }}
                    />
                    <span
                        className="absolute right-[3px] bottom-[3px] z-10 cursor-ns-resize text-gray-500 hover:text-gray-300 touch-none select-none leading-none"
                        title="Resize"
                        onPointerDown={startDrag}
                    >
                        <svg viewBox="0 0 10 10" stroke="currentColor" fill="none" strokeWidth="1.25" strokeLinecap="round" className="w-2.5 h-2.5">
                            <path d="M9 1 L1 9" />
                            <path d="M9 5 L5 9" />
                        </svg>
                    </span>
                </div>
            );
        }

        // One collapsible section: chevron + title + optional count, same
        // look as graph-app.jsx's Interface/Downstream Connections groups.
        function DefSection({ title, count, open, onToggle, children }) {
            return (
                <div className="mt-2 first:mt-0">
                    <button type="button" onClick={onToggle} className={DEF_SECTION_HEADER_CLASS}>
                        <MtlxIcon name={open ? 'chevron-down' : 'chevron-right'} className="flex-none w-3.5 h-3.5 text-gray-500" />
                        <span className="truncate">{title}</span>
                        {count !== undefined && <span className="ml-auto flex-none text-[9px] text-gray-500 normal-case tracking-normal">{count}</span>}
                    </button>
                    {open && <div className="pt-1.5 space-y-1.5 px-2.5">{children}</div>}
                </div>
            );
        }

        // Vertical up/down button stack, shared by the input/output reorder
        // controls and the graph-app.jsx Interface order row.
        function MoveStack({ onUp, onDown, upDisabled, downDisabled, size }) {
            const iconSize = size || 'w-3 h-3';
            return (
                <div className="flex-none flex flex-col w-6 h-6 rounded border border-gray-600 bg-gray-800/80 overflow-hidden">
                    <button type="button" title="Move up" disabled={upDisabled}
                        className="flex-1 inline-flex items-center justify-center text-gray-400 hover:bg-gray-700/80 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-400 border-b border-gray-700"
                        onClick={onUp}
                    ><MtlxIcon name="chevron-up" className={iconSize} /></button>
                    <button type="button" title="Move down" disabled={downDisabled}
                        className="flex-1 inline-flex items-center justify-center text-gray-400 hover:bg-gray-700/80 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-400"
                        onClick={onDown}
                    ><MtlxIcon name="chevron-down" className={iconSize} /></button>
                </div>
            );
        }

        // One declared input: name/type/reorder/remove header, plus a
        // disclosure with the default value and every ui* metadata field.
        function DefInputRow({ nodedefName, inp, readOnly, isFirst, isLast, open, onToggle, actions, grip }) {
            const type = inp.type;
            return (
                <div className="py-1.5">
                    <div className={open ? 'rounded border border-gray-700/60 bg-gray-800/40 -mx-1 px-1 pb-1' : ''}>
                        <div className="flex items-center gap-1.5">
                            {grip || <span className="w-3.5 flex-none" />}
                            <button type="button" title="Edit input" aria-pressed={open} onClick={onToggle}
                                className={ICON_BTN_SM + (open ? ' bg-gray-700/80 text-gray-200' : '')}
                            ><MtlxIcon name="pencil" className="w-3.5 h-3.5" /></button>
                            <span className="w-2 h-2 rounded-full flex-none" style={{ background: typeColor(type) }} />
                            <IfaceMetaField
                                value={inp.name}
                                readOnly={readOnly}
                                onCommit={(v) => actions.renameDefinitionInput(nodedefName, inp.name, v)}
                            />
                            <MoveStack
                                upDisabled={readOnly || isFirst}
                                downDisabled={readOnly || isLast}
                                onUp={() => actions.moveDefinitionInput(nodedefName, inp.name, -1)}
                                onDown={() => actions.moveDefinitionInput(nodedefName, inp.name, 1)}
                            />
                            <button type="button" title="Remove input" disabled={readOnly} className={ICON_BTN_SM_DANGER}
                                onClick={() => actions.removeDefinitionInput(nodedefName, inp.name)}
                            ><MtlxIcon name="trash" className="w-3.5 h-3.5" /></button>
                        </div>
                        {open && (
                            <div className="mt-1.5 ml-5 p-2 space-y-1.5 rounded border border-gray-700 bg-gray-900/30">
                                <DefFieldRow label="type">
                                    <TypeSelect
                                        className="flex-1 min-w-0"
                                        value={type}
                                        disabled={readOnly}
                                        onChange={(v) => actions.setDefinitionInputType(nodedefName, inp.name, v)}
                                    />
                                </DefFieldRow>
                                {ifaceLiteralType(type) && (
                                    <DefFieldRow label="default">
                                        <ParamRow
                                            nodeId={'d:' + nodedefName + '/' + inp.name}
                                            inp={inp}
                                            readOnly={readOnly}
                                            hideHeader
                                            onCommit={(v) => actions.setDefinitionInputValue(nodedefName, inp.name, v)}
                                            onSetColorspace={(cs) => actions.applyDefinitionInputMeta(nodedefName, inp.name, { colorspace: cs })}
                                        />
                                    </DefFieldRow>
                                )}
                                <DefFieldRow label="uiname">
                                    <IfaceMetaField value={inp.uiname} placeholder="(none)" readOnly={readOnly}
                                        onCommit={(v) => actions.applyDefinitionInputMeta(nodedefName, inp.name, { uiname: v })} />
                                </DefFieldRow>
                                <DefFieldRow label="uifolder">
                                    <IfaceMetaField value={inp.uifolder} placeholder="(none)" readOnly={readOnly}
                                        onCommit={(v) => actions.applyDefinitionInputMeta(nodedefName, inp.name, { uifolder: v })} />
                                </DefFieldRow>
                                <DefFieldRow label="doc">
                                    <DefDocField value={inp.doc} placeholder="(none)" readOnly={readOnly}
                                        onCommit={(v) => actions.applyDefinitionInputMeta(nodedefName, inp.name, { doc: v })} />
                                </DefFieldRow>
                                {ifaceNumericType(type) && (
                                    <React.Fragment>
                                        <DefFieldRow label="uimin">
                                            <IfaceMetaField value={inp.uimin} placeholder="(none)" readOnly={readOnly}
                                                onCommit={(v) => actions.applyDefinitionInputMeta(nodedefName, inp.name, { uimin: v })} />
                                        </DefFieldRow>
                                        <DefFieldRow label="uimax">
                                            <IfaceMetaField value={inp.uimax} placeholder="(none)" readOnly={readOnly}
                                                onCommit={(v) => actions.applyDefinitionInputMeta(nodedefName, inp.name, { uimax: v })} />
                                        </DefFieldRow>
                                        <DefFieldRow label="uisoftmin">
                                            <IfaceMetaField value={inp.uisoftmin} placeholder="(none)" readOnly={readOnly}
                                                onCommit={(v) => actions.applyDefinitionInputMeta(nodedefName, inp.name, { uisoftmin: v })} />
                                        </DefFieldRow>
                                        <DefFieldRow label="uisoftmax">
                                            <IfaceMetaField value={inp.uisoftmax} placeholder="(none)" readOnly={readOnly}
                                                onCommit={(v) => actions.applyDefinitionInputMeta(nodedefName, inp.name, { uisoftmax: v })} />
                                        </DefFieldRow>
                                    </React.Fragment>
                                )}
                                <DefFieldRow label="uiadvanced">
                                    <input type="checkbox" className="h-3.5 w-3.5 accent-blue-500"
                                        checked={!!inp.uiadvanced} disabled={readOnly}
                                        onChange={(e) => actions.applyDefinitionInputMeta(nodedefName, inp.name, { uiadvanced: e.target.checked })} />
                                </DefFieldRow>
                                {(type === 'vector2' || type === 'vector3') && (
                                    <DefFieldRow label="defaultgeomprop">
                                        <IfaceMetaField value={inp.defaultgeomprop} placeholder="(none)" readOnly={readOnly}
                                            onCommit={(v) => actions.applyDefinitionInputMeta(nodedefName, inp.name, { defaultgeomprop: v })} />
                                    </DefFieldRow>
                                )}
                                {(type === 'string' || type === 'integer' || type === 'float') && (
                                    <DefFieldRow label="enum">
                                        <EnumEditor
                                            type={type}
                                            enumNames={inp.enumNames}
                                            enumValues={inp.enumValues}
                                            readOnly={readOnly}
                                            onCommit={(patch) => actions.applyDefinitionInputMeta(nodedefName, inp.name, patch)}
                                        />
                                    </DefFieldRow>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            );
        }

        // One declared output: name/type/remove. The last output on a
        // nodedef can't be removed (every definition needs at least one).
        function DefOutputRow({ nodedefName, out, readOnly, disableRemove, isFirst, isLast, open, onToggle, actions, grip }) {
            return (
                <div className="py-1.5">
                    <div className={open ? 'rounded border border-gray-700/60 bg-gray-800/40 -mx-1 px-1 pb-1' : ''}>
                        <div className="flex items-center gap-1.5">
                            {grip || <span className="w-3.5 flex-none" />}
                            <button type="button" title="Edit output" aria-pressed={open} onClick={onToggle}
                                className={ICON_BTN_SM + (open ? ' bg-gray-700/80 text-gray-200' : '')}
                            ><MtlxIcon name="pencil" className="w-3.5 h-3.5" /></button>
                            <span className="w-2 h-2 rounded-full flex-none" style={{ background: typeColor(out.type) }} />
                            <IfaceMetaField
                                value={out.name}
                                readOnly={readOnly}
                                onCommit={(v) => actions.renameDefinitionOutput(nodedefName, out.name, v)}
                            />
                            <MoveStack
                                upDisabled={readOnly || isFirst}
                                downDisabled={readOnly || isLast}
                                onUp={() => actions.moveDefinitionOutput(nodedefName, out.name, -1)}
                                onDown={() => actions.moveDefinitionOutput(nodedefName, out.name, 1)}
                            />
                            <button type="button" title="Remove output" disabled={readOnly || disableRemove} className={ICON_BTN_SM_DANGER}
                                onClick={() => actions.removeDefinitionOutput(nodedefName, out.name)}
                            ><MtlxIcon name="trash" className="w-3.5 h-3.5" /></button>
                        </div>
                        {open && (
                            <div className="mt-1.5 ml-5 p-2 space-y-1.5 rounded border border-gray-700 bg-gray-900/30">
                                <DefFieldRow label="type">
                                    <TypeSelect
                                        className="flex-1 min-w-0"
                                        value={out.type}
                                        disabled={readOnly}
                                        onChange={(v) => actions.setDefinitionOutputType(nodedefName, out.name, v)}
                                    />
                                </DefFieldRow>
                            </div>
                        )}
                    </div>
                </div>
            );
        }

        // Editor for `enum`/`enumvalues`: a reorderable name (+ value, for
        // numeric types) list. Rows carry a local id so React keys survive
        // a rename; every mutation re-joins and commits both attributes.
        function EnumEditor({ type, enumNames, enumValues, readOnly, onCommit }) {
            const numeric = type === 'integer' || type === 'float';
            const idRef = React.useRef(0);
            const seed = (names, values) => {
                const ns = defSplitList(names);
                const vs = defSplitList(values);
                return ns.map((nm, i) => ({ id: idRef.current++, name: nm, value: vs[i] || '' }));
            };
            const [rows, setRows] = React.useState(() => seed(enumNames, enumValues));
            React.useEffect(() => { setRows(seed(enumNames, enumValues)); }, [enumNames, enumValues]);
            const [addName, setAddName] = React.useState('');
            const [addValue, setAddValue] = React.useState('');

            const commit = (nextRows) => {
                setRows(nextRows);
                onCommit({
                    enum: nextRows.map((r) => r.name).join(','),
                    enumvalues: numeric ? nextRows.map((r) => r.value).join(',') : '',
                });
            };
            const addRow = () => {
                const name = addName.trim();
                if (!name) return;
                commit(rows.concat([{ id: idRef.current++, name, value: addValue.trim() }]));
                setAddName(''); setAddValue('');
            };

            const nonEmptyValues = rows.filter((r) => r.value !== '').length;
            const showMismatch = numeric && rows.length > 0 && nonEmptyValues !== rows.length;

            return (
                <div className="flex-1 min-w-0 space-y-1">
                    <ReorderList
                        items={rows}
                        keyOf={(r) => r.id}
                        disabled={readOnly}
                        onMove={(from, to) => {
                            const next = rows.slice();
                            const moved = next.splice(from, 1)[0];
                            next.splice(to, 0, moved);
                            commit(next);
                        }}
                        renderRow={(row, i, { grip }) => (
                            <div className="flex items-center gap-1.5 py-1">
                                {grip || <span className="w-3.5 flex-none" />}
                                <IfaceMetaField
                                    value={row.name}
                                    placeholder="name"
                                    readOnly={readOnly}
                                    onCommit={(v) => commit(rows.map((r, j) => (j === i ? Object.assign({}, r, { name: v }) : r)))}
                                />
                                {numeric && (
                                    <IfaceMetaField
                                        className="flex-none w-16"
                                        value={row.value}
                                        placeholder="value"
                                        readOnly={readOnly}
                                        onCommit={(v) => commit(rows.map((r, j) => (j === i ? Object.assign({}, r, { value: v }) : r)))}
                                    />
                                )}
                                <button type="button" title="Remove enum value" disabled={readOnly} className={ICON_BTN_SM_DANGER}
                                    onClick={() => commit(rows.filter((_, j) => j !== i))}
                                ><MtlxIcon name="trash" className="w-3.5 h-3.5" /></button>
                            </div>
                        )}
                    />
                    <div className="flex items-center gap-1.5">
                        <span className="w-3.5 flex-none" />
                        <input
                            className={DEF_ADD_FIELD}
                            placeholder="name"
                            value={addName}
                            spellCheck={false}
                            disabled={readOnly}
                            onChange={(e) => setAddName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') addRow(); }}
                        />
                        {numeric && (
                            <input
                                className={DEF_ADD_FIELD + ' flex-none w-16'}
                                placeholder="value"
                                value={addValue}
                                spellCheck={false}
                                disabled={readOnly}
                                onChange={(e) => setAddValue(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') addRow(); }}
                            />
                        )}
                        <button type="button" title="Add enum value" disabled={readOnly} className={ICON_BTN_SM_PRIMARY}
                            onClick={addRow}
                        ><MtlxIcon name="plus" className="w-3.5 h-3.5" /></button>
                    </div>
                    {showMismatch && (
                        <div className="text-[10px] text-amber-300">enumvalues count differs from enum count; the instance panel falls back to indices.</div>
                    )}
                </div>
            );
        }

        // The Definition panel itself: `entry` is the parsed.definitions
        // row backing the selected card (see js/graph/model.jsx). `def` is
        // resolved once here so every section reads the same element.
        function DefinitionPanel({ parsed, docRev, entry, readOnly: readOnlyProp, actions }) {
            const def = React.useMemo(() => {
                if (!parsed || !entry) return null;
                const gEl = (entry.graphs && entry.graphs[0]) ? docChild(parsed.doc, entry.graphs[0]) : null;
                return docChild(parsed.doc, entry.nodedef) || (gEl ? resolveNodedefFor(parsed.doc, gEl) : null);
            }, [parsed, docRev, entry && entry.nodedef, entry && entry.graphs.join(',')]);

            const [defOpen, setDefOpen] = React.useState(true);
            const [inputsOpen, setInputsOpen] = React.useState(true);
            const [outputsOpen, setOutputsOpen] = React.useState(true);
            const [implOpen, setImplOpen] = React.useState(true);
            const [rowOpen, setRowOpen] = React.useState({});
            const [newInputName, setNewInputName] = React.useState('');
            const [newInputType, setNewInputType] = React.useState('float');
            const [newOutputName, setNewOutputName] = React.useState('');
            const [newOutputType, setNewOutputType] = React.useState('color3');

            React.useEffect(() => {
                setRowOpen({});
                setNewInputName(''); setNewInputType('float');
                setNewOutputName(''); setNewOutputType('color3');
            }, [entry && entry.nodedef, entry && entry.graphs.join(',')]);

            if (!entry) return null;

            const readOnly = !!readOnlyProp || !entry.local || !def;
            const ports = def ? nodedefPorts(def) : { inputs: [], outputs: [] };
            const nodedefName = entry.nodedef || (def ? mxElName(def) : '');
            const toggleRow = (key) => setRowOpen((prev) => Object.assign({}, prev, { [key]: !prev[key] }));

            return (
                <div>
                    {!entry.local && (
                        <div className="px-2.5">
                            <div className="mb-2 p-2 rounded border border-amber-700/50 bg-amber-900/20 text-[10px] text-amber-300 space-y-1.5">
                                <div>This definition comes from the library.</div>
                                {entry.nodedef && (
                                    <button type="button" className={PILL_ACTION_SM}
                                        onClick={() => actions.copyLibraryDefinition(entry.nodedef)}
                                    ><MtlxIcon name="copy" className="w-3.5 h-3.5" />Copy into document</button>
                                )}
                            </div>
                        </div>
                    )}

                    <DefSection title="Definition" open={defOpen} onToggle={() => setDefOpen((o) => !o)}>
                        <DefFieldRow label="name">
                            <IfaceMetaField value={nodedefName} readOnly={readOnly}
                                onCommit={(v) => actions.renameDefinition(nodedefName, v)} />
                        </DefFieldRow>
                        <DefFieldRow label="node">
                            <IfaceMetaField value={def ? mxSafe(() => def.getNodeString(), '') : entry.node} readOnly={readOnly}
                                onCommit={(v) => actions.setDefinitionNode(nodedefName, v)} />
                        </DefFieldRow>
                        <DefFieldRow label="nodegroup">
                            <IfaceMetaField value={def ? mxSafe(() => def.getNodeGroup(), '') : ''} placeholder="(none)" readOnly={readOnly}
                                onCommit={(v) => actions.applyDefinitionMeta(nodedefName, { nodegroup: v })} />
                        </DefFieldRow>
                        <DefFieldRow label="version">
                            <IfaceMetaField value={def ? mxSafe(() => def.getVersionString(), '') : ''} placeholder="(none)" readOnly={readOnly}
                                onCommit={(v) => actions.applyDefinitionMeta(nodedefName, { version: v })} />
                        </DefFieldRow>
                        <DefFieldRow label="default version">
                            <input type="checkbox" className="h-3.5 w-3.5 accent-blue-500"
                                checked={!!(def && mxSafe(() => def.getDefaultVersion(), false))}
                                disabled={readOnly}
                                onChange={(e) => actions.applyDefinitionMeta(nodedefName, { isdefaultversion: e.target.checked })} />
                        </DefFieldRow>
                        <DefFieldRow label="uiname">
                            <IfaceMetaField value={def ? mxElAttr(def, 'uiname') : ''} placeholder="(none)" readOnly={readOnly}
                                onCommit={(v) => actions.applyDefinitionMeta(nodedefName, { uiname: v })} />
                        </DefFieldRow>
                        <DefFieldRow label="doc">
                            <DefDocField value={def ? mxElAttr(def, 'doc') : ''} placeholder="(none)" readOnly={readOnly}
                                onCommit={(v) => actions.applyDefinitionMeta(nodedefName, { doc: v })} />
                        </DefFieldRow>
                    </DefSection>

                    <DefSection title="Inputs" count={ports.inputs.length} open={inputsOpen} onToggle={() => setInputsOpen((o) => !o)}>
                        <ReorderList
                            items={ports.inputs}
                            keyOf={(p) => p.name}
                            disabled={readOnly}
                            divided
                            onMove={(from, to) => actions.moveDefinitionInputTo(nodedefName, ports.inputs[from].name, to)}
                            renderRow={(inp, i, { grip }) => (
                                <DefInputRow
                                    nodedefName={nodedefName}
                                    inp={inp}
                                    readOnly={readOnly}
                                    isFirst={i === 0}
                                    isLast={i === ports.inputs.length - 1}
                                    open={!!rowOpen['in:' + inp.name]}
                                    onToggle={() => toggleRow('in:' + inp.name)}
                                    actions={actions}
                                    grip={grip}
                                />
                            )}
                        />
                        <div className="flex items-center gap-1.5 pt-1.5">
                            <span className="w-3.5 flex-none" />
                            <span className="w-2 h-2 rounded-full flex-none" style={{ background: typeColor(newInputType) }} />
                            <input
                                className={DEF_ADD_FIELD}
                                placeholder="name"
                                value={newInputName}
                                spellCheck={false}
                                disabled={readOnly}
                                onChange={(e) => setNewInputName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') { actions.addDefinitionInput(nodedefName, newInputName, newInputType); setNewInputName(''); } }}
                            />
                            <TypeSelect className="flex-none w-28" value={newInputType} disabled={readOnly} onChange={setNewInputType} />
                            <button type="button" title="Add input" disabled={readOnly} className={ICON_BTN_SM_PRIMARY}
                                onClick={() => { actions.addDefinitionInput(nodedefName, newInputName, newInputType); setNewInputName(''); }}
                            ><MtlxIcon name="plus" className="w-3.5 h-3.5" /></button>
                        </div>
                    </DefSection>

                    <DefSection title="Outputs" count={ports.outputs.length} open={outputsOpen} onToggle={() => setOutputsOpen((o) => !o)}>
                        <ReorderList
                            items={ports.outputs}
                            keyOf={(p) => p.name}
                            disabled={readOnly}
                            divided
                            onMove={(from, to) => actions.moveDefinitionOutputTo(nodedefName, ports.outputs[from].name, to)}
                            renderRow={(out, i, { grip }) => (
                                <DefOutputRow
                                    nodedefName={nodedefName}
                                    out={out}
                                    readOnly={readOnly}
                                    disableRemove={ports.outputs.length <= 1}
                                    isFirst={i === 0}
                                    isLast={i === ports.outputs.length - 1}
                                    open={!!rowOpen['out:' + out.name]}
                                    onToggle={() => toggleRow('out:' + out.name)}
                                    actions={actions}
                                    grip={grip}
                                />
                            )}
                        />
                        <div className="flex items-center gap-1.5 pt-1.5">
                            <span className="w-3.5 flex-none" />
                            <span className="w-2 h-2 rounded-full flex-none" style={{ background: typeColor(newOutputType) }} />
                            <input
                                className={DEF_ADD_FIELD}
                                placeholder="name"
                                value={newOutputName}
                                spellCheck={false}
                                disabled={readOnly}
                                onChange={(e) => setNewOutputName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') { actions.addDefinitionOutput(nodedefName, newOutputName, newOutputType); setNewOutputName(''); } }}
                            />
                            <TypeSelect className="flex-none w-28" value={newOutputType} disabled={readOnly} onChange={setNewOutputType} />
                            <button type="button" title="Add output" disabled={readOnly} className={ICON_BTN_SM_PRIMARY}
                                onClick={() => { actions.addDefinitionOutput(nodedefName, newOutputName, newOutputType); setNewOutputName(''); }}
                            ><MtlxIcon name="plus" className="w-3.5 h-3.5" /></button>
                        </div>
                    </DefSection>

                    <DefSection title="Implementation" open={implOpen} onToggle={() => setImplOpen((o) => !o)}>
                        {(entry.graphs || []).map((gName) => (
                            <div key={gName} className="flex items-center gap-1.5 py-1.5 border-b border-gray-700/60 last:border-b-0">
                                <span className="w-2 h-2 rounded-full flex-none" style={{ background: typeColor('nodegraph') }} />
                                <span className="flex-1 min-w-0 truncate text-[11px] text-gray-300 font-mono">{gName}</span>
                                <button type="button" className={PILL_ACTION_SM + ' ml-auto'} onClick={() => actions.openGraph(gName)}>
                                    Open<MtlxIcon name="arrow-right" className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        ))}
                        {(!entry.graphs || !entry.graphs.length) && (
                            <button type="button" disabled={readOnly} className={PILL_ACTION_SM}
                                onClick={() => actions.createImplementationGraph(nodedefName)}
                            ><MtlxIcon name="plus" className="w-3.5 h-3.5" />Create implementation graph</button>
                        )}
                    </DefSection>
                </div>
            );
        }

Object.assign(window, { DefinitionPanel, MoveStack });
