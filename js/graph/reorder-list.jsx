// js/graph/reorder-list.jsx: drag-to-reorder list primitive shared by
// the definition panel's input/output rows. Self-exports via
// Object.assign(window, {}); no top-level import/export.

        function ReorderList({ items, keyOf, renderRow, onMove, disabled, className, divided }) {
            const containerRef = React.useRef(null);
            const rectsRef = React.useRef([]);
            const pointerIdRef = React.useRef(null);
            const [drag, setDrag] = React.useState(null); // { from, over }
            const dragRef = React.useRef(null); // mirrors `drag`, read in onPointerUp

            const endDrag = () => {
                pointerIdRef.current = null;
                dragRef.current = null;
                setDrag(null);
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
                window.removeEventListener('keydown', onKeyDown);
            };

            const onPointerMove = (e) => {
                const rects = rectsRef.current;
                if (!rects.length) return;
                let over = rects.length;
                for (let i = 0; i < rects.length; i++) {
                    const mid = rects[i].top + rects[i].height / 2;
                    if (e.clientY < mid) { over = i; break; }
                }
                setDrag((d) => {
                    const next = d ? Object.assign({}, d, { over }) : d;
                    dragRef.current = next;
                    return next;
                });
            };

            const onPointerUp = () => {
                const d = dragRef.current;
                dragRef.current = null;
                setDrag(null);
                pointerIdRef.current = null;
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
                window.removeEventListener('keydown', onKeyDown);
                if (d) {
                    const toIndex = d.over > d.from ? d.over - 1 : d.over;
                    if (toIndex !== d.from) onMove(d.from, toIndex);
                }
            };

            const onKeyDown = (e) => { if (e.key === 'Escape') endDrag(); };

            const startDrag = (e, i) => {
                const container = containerRef.current;
                if (!container) return;
                rectsRef.current = Array.from(container.children).map((el) => el.getBoundingClientRect());
                pointerIdRef.current = e.pointerId;
                mxSafe(() => { e.currentTarget.setPointerCapture(e.pointerId); return true; }, false);
                dragRef.current = { from: i, over: i };
                setDrag(dragRef.current);
                window.addEventListener('pointermove', onPointerMove);
                window.addEventListener('pointerup', onPointerUp);
                window.addEventListener('keydown', onKeyDown);
            };

            const dropLineTop = drag && rectsRef.current.length
                ? (drag.over < rectsRef.current.length
                    ? rectsRef.current[drag.over].top - rectsRef.current[0].top
                    : rectsRef.current[rectsRef.current.length - 1].bottom - rectsRef.current[0].top)
                : null;

            return (
                <div ref={containerRef} className={'relative' + (className ? ' ' + className : '') + (drag ? ' select-none' : '')}>
                    {items.map((item, i) => {
                        const grip = (disabled || items.length < 2) ? null : (
                            <span
                                className="flex-none w-3.5 h-3.5 inline-flex items-center justify-center cursor-grab text-gray-600 hover:text-gray-300 touch-none"
                                title="Drag to reorder"
                                onPointerDown={(e) => startDrag(e, i)}
                            >
                                <MtlxIcon name="grip-vertical" className="w-3.5 h-3.5" />
                            </span>
                        );
                        return (
                            <div
                                key={keyOf(item)}
                                data-idx={i}
                                className={
                                    (divided ? 'border-b border-gray-700/60 last:border-b-0 ' : '') +
                                    (drag && i === drag.from ? 'opacity-60' : '')
                                }
                            >
                                {renderRow(item, i, { grip })}
                            </div>
                        );
                    })}
                    {drag && dropLineTop != null && (
                        <div className="absolute left-0 right-0 h-0.5 bg-blue-500 pointer-events-none" style={{ top: dropLineTop }} />
                    )}
                </div>
            );
        }

Object.assign(window, { ReorderList });
