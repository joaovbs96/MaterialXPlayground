// js/graph/definition-panel.jsx: sidebar panel for a definition card
// (nodedef/functional graph): its own metadata, inputs, outputs, and
// implementation graphs. Self-exports via Object.assign(window, {}).

        // Mirrors graph-app.jsx's own GROUP_HEADER_CLASS, not exported,
        // so this is a deliberate duplicate (see that file's comment).
        const DEF_GROUP_HEADER_CLASS = 'w-[calc(100%+1.25rem)] flex items-center gap-1.5 -mx-2.5 px-2.5 py-1.5 border-t border-b '
            + 'border-gray-700 bg-gray-900/40 text-[10px] font-semibold uppercase tracking-wider text-gray-400 '
            + 'hover:bg-gray-900/70 hover:text-gray-200 transition-colors';

        const DEF_BTN_SM = 'h-6 text-[10px] px-2 rounded border bg-gray-800/80 border-gray-600 text-gray-300 '
            + 'hover:bg-gray-700/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-gray-800/80';
        const DEF_BTN_SM_PRIMARY = 'h-6 flex-none px-2 rounded border bg-blue-600/80 border-blue-500 text-gray-100 '
            + 'hover:bg-blue-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-blue-600/80';
        const DEF_SMALL_INPUT = 'flex-1 min-w-0 px-1.5 py-0.5 bg-gray-900 border border-gray-600 rounded text-[11px] '
            + 'font-mono text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:outline-none disabled:opacity-50';
        const DEF_SMALL_SELECT = 'flex-none w-24 bg-gray-900 border border-gray-600 rounded px-1 py-0.5 text-[10px] '
            + 'font-mono text-gray-200 focus:border-blue-500 focus:outline-none disabled:opacity-50';

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
        // draft/re-seed idiom as IfaceMetaField but a <textarea>.
        function DefDocField({ value, placeholder, onCommit, readOnly }) {
            const [draft, setDraft] = React.useState(value || '');
            React.useEffect(() => { setDraft(value || ''); }, [value]);
            const commit = () => { if (draft !== (value || '')) onCommit(draft); };
            return (
                <textarea
                    rows={3}
                    className={'w-full px-1.5 py-1 placeholder-gray-600 bg-gray-900 border border-gray-600 rounded '
                        + 'text-[11px] font-mono text-gray-200 focus:border-blue-500 focus:outline-none resize-none'
                        + (readOnly ? ' opacity-60' : '')}
                    value={draft}
                    placeholder={placeholder}
                    spellCheck={false}
                    readOnly={!!readOnly}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => { if (e.key === 'Escape') { setDraft(value || ''); e.target.blur(); } }}
                />
            );
        }

        // One collapsible section: chevron + title + optional count, same
        // look as graph-app.jsx's Interface/Downstream Connections groups.
        function DefSection({ title, count, open, onToggle, children }) {
            return (
                <div className="mt-2 first:mt-0">
                    <button type="button" onClick={onToggle} className={DEF_GROUP_HEADER_CLASS}>
                        <MtlxIcon name={open ? 'chevron-down' : 'chevron-right'} className="flex-none w-3.5 h-3.5 text-gray-500" />
                        <span className="truncate">{title}</span>
                        {count !== undefined && <span className="ml-auto flex-none text-[9px] text-gray-500 normal-case tracking-normal">{count}</span>}
                    </button>
                    {open && <div className="pt-1.5 space-y-1.5">{children}</div>}
                </div>
            );
        }

        // One declared input: name/type/reorder/remove header, plus a
        // disclosure with the default value and every ui* metadata field.
        function DefInputRow({ nodedefName, inp, readOnly, isFirst, isLast, open, onToggle, actions }) {
            const type = inp.type;
            return (
                <div className="py-1.5 border-b border-gray-700/60 last:border-b-0">
                    <div className="flex items-center gap-1">
                        <button type="button" onClick={onToggle} className="flex-none text-gray-500 hover:text-gray-300">
                            <MtlxIcon name={open ? 'chevron-down' : 'chevron-right'} className="w-3 h-3" />
                        </button>
                        <IfaceMetaField
                            value={inp.name}
                            readOnly={readOnly}
                            onCommit={(v) => actions.renameDefinitionInput(nodedefName, inp.name, v)}
                        />
                        <select
                            className={DEF_SMALL_SELECT}
                            value={type}
                            disabled={readOnly}
                            onChange={(e) => actions.setDefinitionInputType(nodedefName, inp.name, e.target.value)}
                        >
                            {IFACE_VALUE_TYPES.map((t) => (
                                <option key={t} value={t} style={{ color: typeColor(t) }}>{t}</option>
                            ))}
                        </select>
                        <button type="button" title="Move up" disabled={readOnly || isFirst}
                            onClick={() => actions.moveDefinitionInput(nodedefName, inp.name, -1)}
                            className="flex-none text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:hover:text-gray-500"
                        ><MtlxIcon name="chevron-down" className="w-3 h-3 rotate-180" /></button>
                        <button type="button" title="Move down" disabled={readOnly || isLast}
                            onClick={() => actions.moveDefinitionInput(nodedefName, inp.name, 1)}
                            className="flex-none text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:hover:text-gray-500"
                        ><MtlxIcon name="chevron-down" className="w-3 h-3" /></button>
                        <button type="button" title="Remove input" disabled={readOnly}
                            onClick={() => actions.removeDefinitionInput(nodedefName, inp.name)}
                            className="flex-none text-gray-500 hover:text-red-400 disabled:opacity-30 disabled:hover:text-gray-500"
                        ><MtlxIcon name="trash" className="w-3 h-3" /></button>
                    </div>
                    {open && (
                        <div className="pl-5 pt-1.5 space-y-1.5">
                            {ifaceLiteralType(type) && (
                                <ParamRow
                                    nodeId={'d:' + nodedefName + '/' + inp.name}
                                    inp={inp}
                                    readOnly={readOnly}
                                    onCommit={(v) => actions.setDefinitionInputValue(nodedefName, inp.name, v)}
                                    onSetColorspace={(cs) => actions.applyDefinitionInputMeta(nodedefName, inp.name, { colorspace: cs })}
                                />
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
                            <label className="flex items-center gap-1.5 text-[10px] text-gray-500 font-mono">
                                <input type="checkbox" className="h-3.5 w-3.5 accent-blue-500"
                                    checked={!!inp.uiadvanced} disabled={readOnly}
                                    onChange={(e) => actions.applyDefinitionInputMeta(nodedefName, inp.name, { uiadvanced: e.target.checked })} />
                                uiadvanced
                            </label>
                            {(type === 'vector2' || type === 'vector3') && (
                                <DefFieldRow label="defaultgeomprop">
                                    <IfaceMetaField value={inp.defaultgeomprop} placeholder="(none)" readOnly={readOnly}
                                        onCommit={(v) => actions.applyDefinitionInputMeta(nodedefName, inp.name, { defaultgeomprop: v })} />
                                </DefFieldRow>
                            )}
                            {(type === 'string' || type === 'integer' || type === 'float') && (
                                <React.Fragment>
                                    <DefFieldRow label="enum">
                                        <IfaceMetaField value={inp.enumNames} placeholder="(none)" readOnly={readOnly}
                                            onCommit={(v) => actions.applyDefinitionInputMeta(nodedefName, inp.name, { enum: v })} />
                                    </DefFieldRow>
                                    <DefFieldRow label="enumvalues">
                                        <IfaceMetaField value={inp.enumValues} placeholder="(none)" readOnly={readOnly}
                                            onCommit={(v) => actions.applyDefinitionInputMeta(nodedefName, inp.name, { enumvalues: v })} />
                                    </DefFieldRow>
                                </React.Fragment>
                            )}
                        </div>
                    )}
                </div>
            );
        }

        // One declared output: name/type/remove. The last output on a
        // nodedef can't be removed (every definition needs at least one).
        function DefOutputRow({ nodedefName, out, readOnly, disableRemove, actions }) {
            return (
                <div className="flex items-center gap-1 py-1">
                    <IfaceMetaField
                        value={out.name}
                        readOnly={readOnly}
                        onCommit={(v) => actions.renameDefinitionOutput(nodedefName, out.name, v)}
                    />
                    <select
                        className={DEF_SMALL_SELECT}
                        value={out.type}
                        disabled={readOnly}
                        onChange={(e) => actions.setDefinitionOutputType(nodedefName, out.name, e.target.value)}
                    >
                        {IFACE_VALUE_TYPES.map((t) => (
                            <option key={t} value={t} style={{ color: typeColor(t) }}>{t}</option>
                        ))}
                    </select>
                    <button type="button" title="Remove output" disabled={readOnly || disableRemove}
                        onClick={() => actions.removeDefinitionOutput(nodedefName, out.name)}
                        className="flex-none text-gray-500 hover:text-red-400 disabled:opacity-30 disabled:hover:text-gray-500"
                    ><MtlxIcon name="trash" className="w-3 h-3" /></button>
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
                        <div className="mb-2 p-2 rounded border border-amber-700/50 bg-amber-900/20 text-[10px] text-amber-300 space-y-1.5">
                            <div>This definition comes from the library.</div>
                            {entry.nodedef && (
                                <button type="button" className={DEF_BTN_SM}
                                    onClick={() => actions.copyLibraryDefinition(entry.nodedef)}
                                >Copy into document</button>
                            )}
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
                        <label className="flex items-center gap-1.5 text-[10px] text-gray-500 font-mono">
                            <input type="checkbox" className="h-3.5 w-3.5 accent-blue-500"
                                checked={!!(def && mxSafe(() => def.getDefaultVersion(), false))}
                                disabled={readOnly}
                                onChange={(e) => actions.applyDefinitionMeta(nodedefName, { isdefaultversion: e.target.checked })} />
                            default version
                        </label>
                        <DefFieldRow label="uiname">
                            <IfaceMetaField value={def ? mxElAttr(def, 'uiname') : ''} placeholder="(none)" readOnly={readOnly}
                                onCommit={(v) => actions.applyDefinitionMeta(nodedefName, { uiname: v })} />
                        </DefFieldRow>
                        <DefFieldRow label="doc">
                            <DefDocField value={def ? mxElAttr(def, 'doc') : ''} placeholder="(none)" readOnly={readOnly}
                                onCommit={(v) => actions.applyDefinitionMeta(nodedefName, { doc: v })} />
                        </DefFieldRow>
                    </DefSection>

                    <DefSection title={'Inputs (' + ports.inputs.length + ')'} open={inputsOpen} onToggle={() => setInputsOpen((o) => !o)}>
                        {ports.inputs.map((inp, i) => (
                            <DefInputRow
                                key={inp.name}
                                nodedefName={nodedefName}
                                inp={inp}
                                readOnly={readOnly}
                                isFirst={i === 0}
                                isLast={i === ports.inputs.length - 1}
                                open={!!rowOpen['in:' + inp.name]}
                                onToggle={() => toggleRow('in:' + inp.name)}
                                actions={actions}
                            />
                        ))}
                        <div className="flex items-center gap-1 pt-1">
                            <input
                                className={DEF_SMALL_INPUT}
                                placeholder="name"
                                value={newInputName}
                                spellCheck={false}
                                disabled={readOnly}
                                onChange={(e) => setNewInputName(e.target.value)}
                            />
                            <select
                                className={DEF_SMALL_SELECT}
                                value={newInputType}
                                disabled={readOnly}
                                onChange={(e) => setNewInputType(e.target.value)}
                            >
                                {IFACE_VALUE_TYPES.map((t) => (
                                    <option key={t} value={t} style={{ color: typeColor(t) }}>{t}</option>
                                ))}
                            </select>
                            <button type="button" title="Add input" disabled={readOnly} className={DEF_BTN_SM_PRIMARY}
                                onClick={() => { actions.addDefinitionInput(nodedefName, newInputName, newInputType); setNewInputName(''); }}
                            ><MtlxIcon name="plus" className="w-3 h-3" /></button>
                        </div>
                    </DefSection>

                    <DefSection title={'Outputs (' + ports.outputs.length + ')'} open={outputsOpen} onToggle={() => setOutputsOpen((o) => !o)}>
                        {ports.outputs.map((out) => (
                            <DefOutputRow
                                key={out.name}
                                nodedefName={nodedefName}
                                out={out}
                                readOnly={readOnly}
                                disableRemove={ports.outputs.length <= 1}
                                actions={actions}
                            />
                        ))}
                        <div className="flex items-center gap-1 pt-1">
                            <input
                                className={DEF_SMALL_INPUT}
                                placeholder="name"
                                value={newOutputName}
                                spellCheck={false}
                                disabled={readOnly}
                                onChange={(e) => setNewOutputName(e.target.value)}
                            />
                            <select
                                className={DEF_SMALL_SELECT}
                                value={newOutputType}
                                disabled={readOnly}
                                onChange={(e) => setNewOutputType(e.target.value)}
                            >
                                {IFACE_VALUE_TYPES.map((t) => (
                                    <option key={t} value={t} style={{ color: typeColor(t) }}>{t}</option>
                                ))}
                            </select>
                            <button type="button" title="Add output" disabled={readOnly} className={DEF_BTN_SM_PRIMARY}
                                onClick={() => { actions.addDefinitionOutput(nodedefName, newOutputName, newOutputType); setNewOutputName(''); }}
                            ><MtlxIcon name="plus" className="w-3 h-3" /></button>
                        </div>
                    </DefSection>

                    <DefSection title="Implementation" open={implOpen} onToggle={() => setImplOpen((o) => !o)}>
                        {(entry.graphs || []).map((gName) => (
                            <div key={gName} className="flex items-center gap-1.5">
                                <span className="flex-1 min-w-0 truncate text-[11px] text-gray-300 font-mono">{gName}</span>
                                <button type="button" className={DEF_BTN_SM} onClick={() => actions.openGraph(gName)}>Open</button>
                            </div>
                        ))}
                        {(!entry.graphs || !entry.graphs.length) && (
                            <button type="button" disabled={readOnly} className={DEF_BTN_SM}
                                onClick={() => actions.createImplementationGraph(nodedefName)}
                            >Create implementation graph</button>
                        )}
                    </DefSection>
                </div>
            );
        }

Object.assign(window, { DefinitionPanel });
