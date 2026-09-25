// js/graph/code-view.jsx: left-docked ShadingLanguageX code view: the
// current document decompiled to SLX, editable, with Decompile (graph ->
// code) and Compile (code -> graph) along the bottom. graph-app.jsx owns
// the code text and both operations (see its "code view" state); this
// file is just the panel (SlxCodeView) and its text surface
// (SlxCodeEditor). Self-exports via Object.assign(window, {}); no
// top-level import/export.

        // Resize range and localStorage key, same shape as graph-app.jsx's
        // two sidebars. Being the third docked panel, it's also the one
        // that gives way: never wider than leaves the canvas
        // CODE_VIEW_MIN_CANVAS, whatever the other panels take.
        const CODE_VIEW_MIN_WIDTH = 280;
        const CODE_VIEW_MAX_WIDTH = 960;
        const CODE_VIEW_DEFAULT_WIDTH = 440;
        const CODE_VIEW_MIN_CANVAS = 240;
        const CODE_VIEW_WIDTH_STORAGE_KEY = 'mtlxGraphCodeViewWidth';
        // `shared`: the px this panel and the canvas split between them
        // (0 = not measured yet).
        const clampCodeViewWidth = (w, shared) => {
            let max = CODE_VIEW_MAX_WIDTH;
            if (shared) max = Math.min(max, Math.round(shared - CODE_VIEW_MIN_CANVAS));
            if (max < CODE_VIEW_MIN_WIDTH) max = CODE_VIEW_MIN_WIDTH;
            const n = isFinite(w) ? w : CODE_VIEW_DEFAULT_WIDTH;
            return Math.min(max, Math.max(CODE_VIEW_MIN_WIDTH, n));
        };

        // Text metrics shared by every layer of the editor: the textarea,
        // the line-number gutter, the current-line band under the textarea
        // and the highlighted code over it. They must agree exactly or
        // lines drift apart.
        const CODE_LINE_HEIGHT = 18; // px
        const CODE_PAD_Y = 8; // px, top padding of every layer
        const CODE_TEXT_CLASS = 'font-mono text-[12px] leading-[18px]';
        // The decompiler indents with tabs.
        const CODE_TAB_SIZE = 4;
        // VS Code-style current-line band and line number.
        const CODE_CURRENT_LINE_CLASS = 'bg-white/[0.04] border-y border-white/[0.07]';
        const CODE_CURRENT_NUMBER_CLASS = 'text-gray-300';
        // How long the pointer rests on a standard library call before its
        // tooltip shows: VS Code's default hover delay. (A native `title`
        // tooltip waits longer, and a page can't change that.)
        const CODE_HOVER_DELAY_MS = 300;

        // Syntax colours (VS Code Dark+), keyed by js/graph/slx-syntax.jsx
        // token type; types not listed (identifiers, punctuation, user
        // function calls) stay plain text. Colour only, never bold or
        // italic: the highlighted layer must keep the textarea's glyph
        // widths exactly.
        const SLX_SYNTAX_THEME = {
            text: '#d4d4d4',
            comment: '#6a9955',
            string: '#ce9178',
            number: '#b5cea8',
            constant: '#b5cea8', // true, false, null: the literal colour
            keyword: '#569cd6',
            type: '#4ec9b0',
            directive: '#c586c0',
            attribute: '#dcdcaa',
            // Standard library calls are underlined rather than coloured:
            // Ctrl/Cmd+click opens the node's documentation, and while
            // Ctrl/Cmd is held the one under the pointer takes the link
            // colour.
            stdlibUnderline: 'rgba(212, 212, 212, 0.5)',
            link: '#4e94ce',
            error: '#f14c4c', // compile error squiggles
            caret: '#aeafad',
            selection: '#264f78',
            // The assist popups (js/graph/slx-assist.jsx): function and
            // parameter names in signatures, the active parameter and the
            // typed characters in a suggestion, the selected suggestion.
            func: '#dcdcaa',
            param: '#9cdcfe',
            highlight: '#2aaaff',
            assistSelected: '#04395e',
        };
        (() => {
            if (typeof document === 'undefined' || document.getElementById('slx-syntax-theme')) return;
            const t = SLX_SYNTAX_THEME;
            const tokenRules = ['comment', 'string', 'number', 'constant', 'keyword', 'type', 'directive', 'attribute']
                .map((type) => '.slx-code .slx-' + type + '{color:' + t[type] + ';}');
            const st = document.createElement('style');
            st.id = 'slx-syntax-theme';
            st.textContent = [
                // Every layer: no ligatures, so a token boundary (a span
                // edge in .slx-code only) can never shape glyphs differently.
                '.slx-code,.slx-input,.slx-marks{font-variant-ligatures:none;font-kerning:none;}',
                '.slx-code{color:' + t.text + ';}',
                ...tokenRules,
                '.slx-code .slx-stdlib{text-decoration:underline;text-decoration-color:' + t.stdlibUnderline + ';text-underline-offset:2px;}',
                '.slx-code .slx-stdlib.slx-link{color:' + t.link + ';text-decoration-color:currentColor;}',
                // The squiggle layer's text is invisible, only its wavy
                // underlines show; offset a little further than the stdlib
                // underline so the two don't run into each other.
                '.slx-marks{color:transparent;}',
                '.slx-marks .slx-error{text-decoration:underline wavy;text-decoration-color:' + t.error + ';text-decoration-thickness:1px;text-decoration-skip-ink:none;text-underline-offset:3px;}',
                // The textarea keeps the caret and selection; its text is
                // invisible, the highlighted layer drawn over it shows it.
                '.slx-input{color:transparent;caret-color:' + t.caret + ';}',
                '.slx-input::selection{background:' + t.selection + ';}',
                '.slx-assist-type{color:' + t.type + ';}',
                '.slx-assist-func{color:' + t.func + ';}',
                '.slx-assist-param{color:' + t.param + ';}',
                '.slx-assist-active{color:' + t.highlight + ';font-weight:700;}',
                '.slx-assist-match{color:' + t.highlight + ';font-weight:700;}',
                '.slx-assist-selected{background:' + t.assistSelected + ';}',
                '.slx-kind-function{color:' + t.func + ';}',
                '.slx-kind-variable{color:' + t.param + ';}',
                '.slx-kind-keyword{color:' + t.keyword + ';}',
                '.slx-kind-type{color:' + t.type + ';}',
                '.slx-kind-directive{color:' + t.directive + ';}',
            ].join('');
            document.head.appendChild(st);
        })();

        const escapeCodeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // tokenizeSlx() output as HTML for the highlighted layer: a span
        // per coloured token, plain text between them.
        const highlightSlx = (text, tokens) => {
            let html = '';
            let at = 0;
            for (const token of tokens) {
                let cls = null;
                let attrs = '';
                if (token.type === 'function') {
                    if (token.stdlib) {
                        cls = 'slx-stdlib';
                        attrs = ' data-node="' + text.slice(token.start, token.end) + '"';
                    }
                } else if (token.type !== 'identifier' && token.type !== 'punctuation') {
                    cls = 'slx-' + token.type;
                }
                if (!cls) continue;
                html += escapeCodeHtml(text.slice(at, token.start))
                    + '<span class="' + cls + '"' + attrs + '>' + escapeCodeHtml(text.slice(token.start, token.end)) + '</span>';
                at = token.end;
            }
            return html + escapeCodeHtml(text.slice(at));
        };

        // mxslc diagnostics start a line with "line N: <message>" or
        // "Scanning error on line N, ..." (1-based). Not "<file>, line N:",
        // which is a line in some other file.
        const slxErrorLine = (message) => {
            const m = /(?:^|\n)(?:Scanning error on )?line (\d+)\b/.exec(message || '');
            return m ? parseInt(m[1], 10) : null;
        };

        // Character offset of the start of 1-based `line` in `text`,
        // clamped to the last line.
        const lineStartOffset = (text, line) => {
            let offset = 0;
            for (let i = 1; i < line; i++) {
                const next = text.indexOf('\n', offset);
                if (next === -1) break;
                offset = next + 1;
            }
            return offset;
        };

        // 1-based `line` of `text` without its leading and trailing
        // whitespace, as { start, end } (end exclusive); null if the line
        // doesn't exist or is blank. mxslc reports lines, not columns, so
        // this is what a squiggle underlines.
        const lineContentRange = (text, line) => {
            if (!(line >= 1)) return null;
            let start = 0;
            for (let i = 1; i < line; i++) {
                const next = text.indexOf('\n', start);
                if (next === -1) return null;
                start = next + 1;
            }
            let end = text.indexOf('\n', start);
            if (end === -1) end = text.length;
            while (start < end && /\s/.test(text[start])) start++;
            while (end > start && /\s/.test(text[end - 1])) end--;
            return start < end ? { start, end } : null;
        };

        // `after` taken as an edit of `before`: the single span that
        // differs between their common prefix and suffix, as
        // before[start, oldEnd) becoming after[start, newEnd).
        const editSpan = (before, after) => {
            const max = Math.min(before.length, after.length);
            let start = 0;
            while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
            let suffix = 0;
            while (suffix < max - start
                && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
            return { start, oldEnd: before.length - suffix, newEnd: after.length - suffix };
        };

        // Carry ranges ({ start, end, ... }) in `before` over to `after`,
        // an edit of it (editSpan). Ranges clear of the edit shift; one it
        // cuts into grows or shrinks, but text typed right at either edge
        // stays outside; one it deletes outright is dropped.
        const remapRanges = (ranges, before, after) => {
            if (before === after || !ranges.length) return ranges;
            const { start: prefix, oldEnd, newEnd } = editSpan(before, after);
            const delta = newEnd - oldEnd;
            const out = [];
            for (const r of ranges) {
                const start = r.start < prefix ? r.start : r.start >= oldEnd ? r.start + delta : prefix;
                const end = r.end <= prefix ? r.end : r.end > oldEnd ? r.end + delta : newEnd;
                if (start < end) out.push({ ...r, start, end });
            }
            return out;
        };

        // The squiggle layer's HTML: the text up to the last mark, with
        // each mark wrapped in a .slx-error span. Null when there's none.
        const markupSquiggles = (text, marks) => {
            if (!marks.length) return null;
            let html = '';
            let at = 0;
            for (const m of [...marks].sort((a, b) => a.start - b.start)) {
                if (m.start < at) continue; // overlaps the previous one
                html += escapeCodeHtml(text.slice(at, m.start))
                    + '<span class="slx-error">' + escapeCodeHtml(text.slice(m.start, m.end)) + '</span>';
                at = m.end;
            }
            return { __html: html };
        };

        // The text surface: a <textarea> whose own text is invisible, with
        // the syntax-highlighted copy drawn over it and the current-line
        // band under it. Editor features such as completion belong HERE so
        // that neither SlxCodeView nor graph-app.jsx has to change. Keep
        // this contract:
        //   value, onChange(text)  controlled text
        //   onSubmit()             Ctrl/Cmd+Enter
        //   readOnly, placeholder
        //   library                js/graph/slx-language.jsx's function
        //                          library (loadSlxLibrary), or null while
        //                          it loads: its node names are underlined
        //                          when called, and it feeds completion,
        //                          parameter hints and the hover card
        //   onOpenNodeDocs(name)   Ctrl/Cmd+click on an underlined call
        //   diagnostics            { source, items: [{ line, message }] }
        //                          or null: errors in `source` (the code
        //                          as compiled), squiggled under their
        //                          1-based line and carried through any
        //                          edits made since, until the next
        //                          diagnostics object replaces them
        //   apiRef                 filled with { focus(), revealLine(n),
        //                          revealDiagnostic(i), replaceText(text),
        //                          undo() }
        function SlxCodeEditor({ value, onChange, onSubmit, readOnly, placeholder, library, onOpenNodeDocs, diagnostics, apiRef }) {
            const taRef = React.useRef(null);
            const gutterRef = React.useRef(null);
            const backdropRef = React.useRef(null);
            const codeClipRef = React.useRef(null);
            const codeRef = React.useRef(null);

            const stdlibNames = library ? library.names : null;
            const tokens = React.useMemo(() => tokenizeSlx(value, stdlibNames), [value, stdlibNames]);
            const tokensRef = React.useRef(null);
            tokensRef.current = { text: value, tokens };
            const highlighted = React.useMemo(() => ({ __html: highlightSlx(value, tokens) }), [value, tokens]);

            // Where each diagnostic sits in the current text, as
            // { start, end, item } character ranges: placed on its line in
            // the source it was reported for, then remapped through every
            // edit since (so a squiggle stays on its code as lines are
            // added above it). Keeps the last result to remap from; safe
            // to run twice for the same inputs.
            const marksStateRef = React.useRef({ diagnostics: null, text: '', marks: [] });
            const marks = React.useMemo(() => {
                const last = marksStateRef.current;
                let next;
                if (last.diagnostics !== diagnostics) {
                    next = [];
                    if (diagnostics) {
                        for (const item of diagnostics.items) {
                            const range = lineContentRange(diagnostics.source, item.line);
                            if (range) next.push({ ...range, item });
                        }
                        next = remapRanges(next, diagnostics.source, value);
                    }
                } else if (last.text !== value) {
                    next = remapRanges(last.marks, last.text, value);
                } else {
                    return last.marks;
                }
                marksStateRef.current = { diagnostics, text: value, marks: next };
                return next;
            }, [value, diagnostics]);
            const squiggles = React.useMemo(() => markupSquiggles(value, marks), [value, marks]);

            const lineCount = React.useMemo(() => {
                let n = 1;
                for (let i = value.indexOf('\n'); i !== -1; i = value.indexOf('\n', i + 1)) n++;
                return n;
            }, [value]);

            // Where the caret is: its 0-based line, and whether the
            // selection is empty (the current-line band hides while a range
            // is selected, as in VS Code; the line number stays lit).
            const [caret, setCaret] = React.useState({ line: 0, collapsed: true });
            // Last known selection, restored when the text is replaced from
            // outside (Decompile), which would otherwise throw the caret to
            // the end of the file.
            const selectionRef = React.useRef({ start: 0, end: 0 });
            // The text this editor last reported through onChange: any other
            // incoming `value` was replaced from outside.
            const emittedRef = React.useRef(value);
            const updateCaret = () => {
                const ta = taRef.current;
                if (!ta) return;
                selectionRef.current = { start: ta.selectionStart, end: ta.selectionEnd };
                const pos = ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd;
                let line = 0;
                for (let i = ta.value.indexOf('\n'); i !== -1 && i < pos; i = ta.value.indexOf('\n', i + 1)) line++;
                const collapsed = ta.selectionStart === ta.selectionEnd;
                setCaret((c) => (c.line === line && c.collapsed === collapsed ? c : { line, collapsed }));
            };
            // Native selectionchange rather than React's onSelect, which
            // skips some caret moves (e.g. setSelectionRange). Newer engines
            // fire it on the textarea itself, older ones only on document.
            // Only while focused: the caret can't move otherwise, and Chrome
            // can collapse an unfocused textarea's selection to 0 some time
            // after its text is replaced (Decompile clicked with the mouse),
            // which would drag the band to line 1.
            React.useEffect(() => {
                const ta = taRef.current;
                if (!ta) return;
                const onSelection = () => {
                    if (document.activeElement !== ta) return;
                    updateCaret();
                    refreshAssistRef.current({ kind: 'caret' });
                };
                ta.addEventListener('selectionchange', onSelection);
                document.addEventListener('selectionchange', onSelection);
                return () => {
                    ta.removeEventListener('selectionchange', onSelection);
                    document.removeEventListener('selectionchange', onSelection);
                };
            }, []);

            const activeLine = Math.min(caret.line, lineCount - 1);
            const gutterNumbers = React.useMemo(
                () => Array.from({ length: lineCount }, (_, i) => String(i + 1)),
                [lineCount]);
            const gutterBefore = React.useMemo(
                () => gutterNumbers.slice(0, activeLine).map((n) => n + '\n').join(''),
                [gutterNumbers, activeLine]);
            const gutterAfter = React.useMemo(
                () => gutterNumbers.slice(activeLine + 1).map((n) => '\n' + n).join(''),
                [gutterNumbers, activeLine]);

            // Select [start, end) and scroll its first line to mid-view.
            const revealRange = (start, end) => {
                const ta = taRef.current;
                if (!ta) return;
                let line = 0;
                for (let i = ta.value.indexOf('\n'); i !== -1 && i < start; i = ta.value.indexOf('\n', i + 1)) line++;
                ta.focus();
                ta.setSelectionRange(start, end);
                ta.scrollTop = Math.max(0, line * CODE_LINE_HEIGHT - ta.clientHeight / 2);
                updateCaret();
            };
            const revealLine = (line) => {
                const ta = taRef.current;
                if (!ta) return;
                const start = lineStartOffset(ta.value, line);
                let end = ta.value.indexOf('\n', start);
                if (end === -1) end = ta.value.length;
                revealRange(start, end);
            };
            if (apiRef) {
                apiRef.current = {
                    focus: () => { if (taRef.current) taRef.current.focus(); },
                    // Select the whole line.
                    revealLine,
                    // Select diagnostics.items[index]'s squiggled code
                    // wherever edits have moved it; its reported line if
                    // that code has since been deleted.
                    revealDiagnostic: (index) => {
                        const item = diagnostics && diagnostics.items[index];
                        if (!item) return;
                        const mark = marks.find((m) => m.item === item);
                        if (mark) revealRange(mark.start, mark.end);
                        else revealLine(item.line);
                    },
                    // Replace the text with `text` as one step in the
                    // textarea's own undo history, so Ctrl+Z puts the old
                    // text back (execCommand; a new `value` would wipe the
                    // history). onChange reports it as usual. Only the
                    // changed lines are replaced, which is what an undo
                    // selects; the caret is carried over the edit and the
                    // scroll kept. Focuses the editor, which execCommand
                    // needs, and leaves it there unless another text field
                    // had focus. False if it couldn't (not mounted,
                    // read-only, unsupported): set `value` instead.
                    replaceText: (text) => {
                        const ta = taRef.current;
                        if (!ta || !ta.isConnected || ta.readOnly) return false;
                        const before = ta.value;
                        if (before === text) return true;
                        const span = editSpan(before, text);
                        // Whole lines: a span edge inside a character
                        // (a surrogate pair, a combining mark) could be
                        // moved by the browser, and never is at a line.
                        span.start = before.lastIndexOf('\n', span.start - 1) + 1;
                        const lineEnd = before.indexOf('\n', span.oldEnd);
                        const extend = (lineEnd === -1 ? before.length : lineEnd) - span.oldEnd;
                        span.oldEnd += extend;
                        span.newEnd += extend;
                        const delta = span.newEnd - span.oldEnd;
                        const carry = (o) => (o <= span.start ? o : o >= span.oldEnd ? o + delta : Math.min(o, span.newEnd));
                        const sel = selectionRef.current;
                        const { scrollTop, scrollLeft } = ta;
                        const prevFocus = document.activeElement;
                        ta.focus({ preventScroll: true });
                        ta.setSelectionRange(span.start, span.oldEnd);
                        const inserted = text.slice(span.start, span.newEnd);
                        programmaticRef.current = { kind: 'external' };
                        let ok = false;
                        try {
                            ok = document.execCommand(inserted ? 'insertText' : 'delete', false, inserted);
                        } finally {
                            programmaticRef.current = null;
                        }
                        if (!ok || ta.value !== text) {
                            // Unsupported (or not what was asked): undo
                            // whatever it did, and let the caller set it.
                            if (ta.value !== before) document.execCommand('undo');
                            ta.setSelectionRange(Math.min(sel.start, ta.value.length), Math.min(sel.end, ta.value.length));
                            return false;
                        }
                        ta.setSelectionRange(carry(sel.start), carry(sel.end));
                        ta.scrollTop = scrollTop;
                        ta.scrollLeft = scrollLeft;
                        syncScroll();
                        updateCaret();
                        if (prevFocus && prevFocus !== ta && prevFocus.isConnected
                            && (/^(input|textarea|select)$/i.test(prevFocus.tagName) || prevFocus.isContentEditable)) {
                            prevFocus.focus({ preventScroll: true });
                        }
                        return true;
                    },
                    // Undo the last edit in the textarea's own history, as
                    // Ctrl+Z in it would.
                    undo: () => {
                        const ta = taRef.current;
                        if (!ta || ta.readOnly) return;
                        ta.focus({ preventScroll: true });
                        document.execCommand('undo');
                    },
                };
            }

            // The other layers follow the textarea's scroll: the gutter by
            // scrollTop (it only scrolls vertically), the band by a
            // vertical transform (it spans the full width regardless of
            // horizontal scroll) and the highlighted code (with its
            // squiggles) by a transform in both axes. The code layer is
            // also clipped to the textarea's client area so it never paints
            // over the scrollbars.
            const syncScroll = () => {
                const ta = taRef.current;
                if (!ta) return;
                if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
                if (backdropRef.current) backdropRef.current.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
                if (codeRef.current) codeRef.current.style.transform = 'translate(' + (-ta.scrollLeft) + 'px,' + (-ta.scrollTop) + 'px)';
                if (codeClipRef.current) {
                    codeClipRef.current.style.width = ta.clientWidth + 'px';
                    codeClipRef.current.style.height = ta.clientHeight + 'px';
                }
            };
            // Panel resizes change the client area (and can move scroll)
            // without a scroll event.
            React.useEffect(() => {
                const ta = taRef.current;
                if (!ta) return;
                const ro = new ResizeObserver(() => {
                    syncScroll();
                    placeAssistRef.current();
                });
                ro.observe(ta);
                return () => ro.disconnect();
            }, []);
            React.useLayoutEffect(() => {
                const ta = taRef.current;
                if (ta && value !== emittedRef.current) {
                    emittedRef.current = value;
                    const sel = selectionRef.current;
                    ta.setSelectionRange(Math.min(sel.start, value.length), Math.min(sel.end, value.length));
                }
                updateCaret();
                // A value swap can also move scrollTop without a scroll
                // event reaching the other layers.
                syncScroll();
                // How the text changed, noted by onChange; nothing noted
                // means it was replaced from outside.
                refreshAssist(pendingAssistRef.current || { kind: 'external' });
                pendingAssistRef.current = null;
            }, [value]);

            const emitChange = (text) => {
                emittedRef.current = text;
                onChange(text);
            };

            // ---- Completion and parameter hints (VS Code style) ----------
            // completion: the open suggestion list, for the word starting at
            //   wordStart: { wordStart, typed, context, explicit, items (all
            //   offered), entries (matching, best first), index }
            // hints: parameter hints for the call around the caret:
            //   { ctx (slxCallContext), sigs, index, manual (stepped to by
            //   hand, so kept), active, description }
            // Both are recomputed from the text and caret (refreshAssist)
            // after every edit and caret move, and mirrored in refs for the
            // event handlers in between renders.
            const [completion, setCompletion] = React.useState(null);
            const [hints, setHints] = React.useState(null);
            const completionRef = React.useRef(null);
            const hintsRef = React.useRef(null);
            const setAssist = (nextCompletion, nextHints) => {
                completionRef.current = nextCompletion;
                hintsRef.current = nextHints;
                setCompletion(nextCompletion);
                setHints(nextHints);
            };
            // How onChange saw the text change, for the layout effect
            // above to act on; programmaticRef holds the trigger for this
            // editor's own insertions while they're made: 'edit' (nothing
            // new) for a picked suggestion, 'external' for replaceText.
            const pendingAssistRef = React.useRef(null);
            const programmaticRef = React.useRef(null);
            // Tokens and declared symbols of the text the assists last
            // looked at (the render's tokens when the text is the same).
            const assistDataRef = React.useRef({ text: null, tokens: null, symbols: null });
            const assistData = (text) => {
                if (assistDataRef.current.text !== text) {
                    const rendered = tokensRef.current;
                    assistDataRef.current = {
                        text, symbols: null,
                        tokens: rendered.text === text ? rendered.tokens : tokenizeSlx(text, stdlibNames),
                    };
                }
                return assistDataRef.current;
            };
            const symbolsOf = (data) => data.symbols || (data.symbols = slxFileSymbols(data.text, data.tokens));
            // A function's signatures: the code's own definitions, then the
            // library's. Null if neither knows it.
            const lookupFunction = (name, data) => {
                const own = symbolsOf(data).functions.get(name) || [];
                const lib = library ? library.functions.get(name) : null;
                const sigs = own.concat(lib ? lib.sigs : []);
                return sigs.length ? { sigs, description: lib ? lib.description : '' } : null;
            };
            const filterCompletion = (base, typed) => ({
                ...base, typed, index: 0,
                entries: slxFilterCompletions(base.items, typed).slice(0, 200),
            });

            // trigger.kind: 'word' (typed a letter, digit or _), 'char'
            // (typed trigger.char), 'delete', 'edit' (anything else),
            // 'caret' (moved), 'external' (text replaced from outside),
            // 'complete' (Ctrl+Space), 'hints' (Ctrl+Shift+Space).
            const refreshAssist = (trigger) => {
                const ta = taRef.current;
                if (!ta || readOnly || trigger.kind === 'external' || document.activeElement !== ta) {
                    if (completionRef.current || hintsRef.current) setAssist(null, null);
                    return;
                }
                const text = ta.value;
                const caret = ta.selectionStart;
                const collapsed = caret === ta.selectionEnd;
                const data = assistData(text);

                // Suggestions open as a word is typed (or on Ctrl+Space),
                // follow it as it grows or shrinks, and close once the caret
                // leaves it or nothing matches.
                let comp = completionRef.current;
                const explicit = trigger.kind === 'complete';
                let wordStart = caret;
                while (wordStart > 0 && /\w/.test(text[wordStart - 1])) wordStart--;
                const typed = text.slice(wordStart, caret);
                if (!collapsed || /^\d/.test(typed)) {
                    comp = null;
                } else if (comp && !explicit) {
                    if (wordStart !== comp.wordStart || (!typed && !comp.explicit)) comp = null;
                    else if (typed !== comp.typed) comp = filterCompletion(comp, typed);
                } else if (explicit || (trigger.kind === 'word' && typed)) {
                    const context = slxCompletionContext(text, data.tokens, wordStart, explicit);
                    comp = context ? filterCompletion({
                        wordStart, context, explicit,
                        items: slxCompletionItems(context, library, context === 'code' ? symbolsOf(data) : null),
                    }, typed) : null;
                }
                if (comp && !comp.entries.length && !comp.explicit) comp = null;

                // Hints open on `(` or `,` in a known call (or on
                // Ctrl+Shift+Space) and follow the caret until it leaves
                // every known call.
                let help = hintsRef.current;
                const wantHints = trigger.kind === 'hints'
                    || (trigger.kind === 'char' && (trigger.char === '(' || trigger.char === ','));
                if (help || wantHints) {
                    const ctx = collapsed ? slxCallContext(text, data.tokens, caret) : null;
                    const fn = ctx && !ctx.method ? lookupFunction(ctx.name, data) : null;
                    if (!fn) {
                        help = null;
                    } else {
                        const same = !!help && help.ctx.nameStart === ctx.nameStart && help.ctx.name === ctx.name;
                        const manual = same && help.manual && help.sigs.length === fn.sigs.length;
                        const index = manual ? help.index : slxPickSignature(fn.sigs, ctx);
                        const active = slxActiveParam(fn.sigs[index], ctx);
                        const unchanged = same && help.index === index && help.active === active
                            && help.ctx.argIndex === ctx.argIndex && help.ctx.argName === ctx.argName
                            && help.ctx.template === ctx.template
                            && help.sigs.length === fn.sigs.length && help.description === fn.description;
                        if (!unchanged) help = { ctx, sigs: fn.sigs, index, manual, active, description: fn.description };
                    }
                }
                if (comp !== completionRef.current || help !== hintsRef.current) setAssist(comp, help);
            };
            const refreshAssistRef = React.useRef(refreshAssist);
            refreshAssistRef.current = refreshAssist;

            const acceptCompletion = (item) => {
                const ta = taRef.current;
                const comp = completionRef.current;
                if (!ta || !comp) return;
                setAssist(null, hintsRef.current);
                ta.setSelectionRange(comp.wordStart, ta.selectionStart);
                programmaticRef.current = { kind: 'edit' };
                insertText(item.label);
                programmaticRef.current = null;
            };
            const cycleHints = (step) => {
                const help = hintsRef.current;
                if (!help) return;
                const n = help.sigs.length;
                const index = (help.index + step + n) % n;
                setAssist(completionRef.current, { ...help, index, manual: true, active: slxActiveParam(help.sigs[index], help.ctx) });
            };

            // Where the popups go, in viewport pixels: the list under the
            // word being completed, the hints above the caret's line (or
            // under it, near the top of the screen, with the list below
            // them). Hidden while their line is scrolled out of view.
            // Recomputed on every change, scroll and resize.
            const completionElRef = React.useRef(null);
            const hintsElRef = React.useRef(null);
            const charWidthRef = React.useRef(0);
            const offsetPoint = (text, offset) => {
                const ta = taRef.current;
                if (!charWidthRef.current) {
                    const probe = document.createElement('span');
                    probe.className = CODE_TEXT_CLASS + ' slx-input';
                    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
                    probe.textContent = 'x'.repeat(100);
                    ta.parentNode.appendChild(probe);
                    charWidthRef.current = probe.getBoundingClientRect().width / 100 || 7;
                    probe.remove();
                }
                let line = 0;
                for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++;
                let col = 0;
                for (let i = text.lastIndexOf('\n', offset - 1) + 1; i < offset; i++) {
                    col = text[i] === '\t' ? (Math.floor(col / CODE_TAB_SIZE) + 1) * CODE_TAB_SIZE : col + 1;
                }
                const box = ta.getBoundingClientRect();
                const areaTop = box.top + ta.clientTop;
                const top = areaTop + CODE_PAD_Y + line * CODE_LINE_HEIGHT - ta.scrollTop;
                return {
                    left: box.left + ta.clientLeft + parseFloat(getComputedStyle(ta).paddingLeft) + col * charWidthRef.current - ta.scrollLeft,
                    top, bottom: top + CODE_LINE_HEIGHT,
                    visible: top >= areaTop - 1 && top + CODE_LINE_HEIGHT <= areaTop + ta.clientHeight + 1,
                };
            };
            const placeAssist = () => {
                const ta = taRef.current;
                const comp = completionRef.current;
                const help = hintsRef.current;
                if (!ta || (!comp && !help)) return;
                const margin = 8;
                const place = (el, left, top, visible) => {
                    el.style.left = Math.max(margin, Math.min(left, window.innerWidth - margin - el.offsetWidth)) + 'px';
                    el.style.top = top + 'px';
                    el.style.visibility = visible ? '' : 'hidden';
                };
                const caretPt = offsetPoint(ta.value, ta.selectionStart);
                let hintsBelow = null; // the hints' bottom edge, when they're under the line
                const hintsEl = hintsElRef.current;
                if (help && hintsEl) {
                    let top = caretPt.top - 2 - hintsEl.offsetHeight;
                    if (top < margin) {
                        top = caretPt.bottom + 2;
                        hintsBelow = top + hintsEl.offsetHeight;
                    }
                    place(hintsEl, offsetPoint(ta.value, help.ctx.nameStart).left, top, caretPt.visible);
                }
                const listEl = completionElRef.current;
                if (comp && listEl) {
                    let top = hintsBelow != null ? hintsBelow + 2 : caretPt.bottom + 2;
                    if (top + listEl.offsetHeight > window.innerHeight - margin && hintsBelow == null) {
                        top = Math.max(margin, caretPt.top - 2 - listEl.offsetHeight);
                    }
                    // Line the labels up with the word (past the kind badge).
                    place(listEl, offsetPoint(ta.value, comp.wordStart).left - 25, top, caretPt.visible);
                }
            };
            const placeAssistRef = React.useRef(placeAssist);
            placeAssistRef.current = placeAssist;
            // Placed again whenever they change size: their content changes,
            // and the Tailwind CDN styles a class it hasn't seen before
            // only after the element shows (a first measurement can be
            // before its max-width applies).
            React.useLayoutEffect(() => {
                placeAssist();
                const els = [completionElRef.current, hintsElRef.current].filter(Boolean);
                if (!els.length) return undefined;
                const ro = new ResizeObserver(() => placeAssistRef.current());
                els.forEach((el) => ro.observe(el));
                return () => ro.disconnect();
            }, [completion, hints]);

            // The underlined standard library call under a viewport point:
            // its span in the highlighted layer, or null. The textarea
            // takes the pointer, so this goes by the spans' boxes, each
            // grown to its full line height (no dead gap between lines).
            // Spans come in text order and never wrap, so their tops never
            // decrease: binary search for the first one not above the point.
            const stdlibSpanAt = (x, y) => {
                const clip = codeClipRef.current;
                const code = codeRef.current;
                if (!clip || !code) return null;
                const box = clip.getBoundingClientRect();
                if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) return null;
                const spans = code.querySelectorAll('.slx-stdlib');
                const lineBox = (span) => {
                    const r = span.getBoundingClientRect();
                    const pad = (CODE_LINE_HEIGHT - r.height) / 2;
                    return { left: r.left, right: r.right, top: r.top - pad, bottom: r.bottom + pad };
                };
                let lo = 0;
                let hi = spans.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (lineBox(spans[mid]).bottom <= y) lo = mid + 1;
                    else hi = mid;
                }
                for (let i = lo; i < spans.length; i++) {
                    const r = lineBox(spans[i]);
                    if (r.top > y) break;
                    if (x >= r.left && x < r.right) return spans[i];
                }
                return null;
            };

            // Link hover, VS Code style: while Ctrl/Cmd is held, the call
            // under the pointer takes the link colour and the pointer
            // cursor; resting on one shows its hover card (signatures,
            // description, how to open its docs). Plain DOM on the
            // highlighted layer, no re-render: it tracks every mouse move.
            // The card is state, set only as it shows or hides.
            const hoverRef = React.useRef({
                x: 0, y: 0, inside: false, modifier: false, link: null,
                // The call the card is for (pending or shown), its delay
                // timer, whether it's showing, and whether it's held back
                // until the pointer moves (after a click or a keystroke,
                // like native tooltips).
                tipSpan: null, tipTimer: null, tipShown: false, tipSuppressed: false,
            });
            const [tip, setTip] = React.useState(null); // { name, left, lineTop, lineBottom }
            const tipRef = React.useRef(null);
            const hideTip = () => {
                const h = hoverRef.current;
                clearTimeout(h.tipTimer);
                h.tipTimer = null;
                h.tipSpan = null;
                if (h.tipShown) {
                    h.tipShown = false;
                    setTip(null);
                }
            };
            // Anchored to the call's line box (placed by the layout effect
            // below, once its size is known).
            const showTip = (span) => {
                if (!span.isConnected) return;
                const r = span.getBoundingClientRect();
                const pad = (CODE_LINE_HEIGHT - r.height) / 2;
                hoverRef.current.tipShown = true;
                setTip({ name: span.dataset.node, left: r.left, lineTop: r.top - pad, lineBottom: r.bottom + pad });
            };
            // Pointer now over `span` (or none). Once a tooltip is showing,
            // moving straight onto another call switches it at once.
            const scheduleTip = (span) => {
                const h = hoverRef.current;
                if (h.tipSuppressed) span = null;
                if (span === h.tipSpan) return;
                const warm = h.tipShown;
                hideTip();
                if (!span) return;
                h.tipSpan = span;
                if (warm) showTip(span);
                else h.tipTimer = setTimeout(() => showTip(span), CODE_HOVER_DELAY_MS);
            };
            // Over the call's line (under it when there's no room above),
            // left-aligned with the call, kept on screen; placed again as
            // it changes size, like the other popups (placeAssist).
            React.useLayoutEffect(() => {
                const el = tipRef.current;
                if (!el || !tip) return undefined;
                const place = () => {
                    let top = tip.lineTop - 2 - el.offsetHeight;
                    if (top < 8) top = tip.lineBottom + 2;
                    el.style.left = Math.max(8, Math.min(tip.left, window.innerWidth - 8 - el.offsetWidth)) + 'px';
                    el.style.top = top + 'px';
                };
                place();
                const ro = new ResizeObserver(place);
                ro.observe(el);
                return () => ro.disconnect();
            }, [tip]);
            const updateHover = () => {
                const h = hoverRef.current;
                const ta = taRef.current;
                const span = onOpenNodeDocs && h.inside ? stdlibSpanAt(h.x, h.y) : null;
                const link = span && h.modifier ? span : null;
                if (h.link !== link) {
                    if (h.link) h.link.classList.remove('slx-link');
                    if (link) link.classList.add('slx-link');
                    h.link = link;
                }
                if (ta) {
                    const cursor = link ? 'pointer' : '';
                    if (ta.style.cursor !== cursor) ta.style.cursor = cursor;
                }
                scheduleTip(span);
            };
            const updateHoverRef = React.useRef(updateHover);
            updateHoverRef.current = updateHover;
            const onMouseMove = (e) => {
                const h = hoverRef.current;
                if (e.clientX !== h.x || e.clientY !== h.y) h.tipSuppressed = false;
                Object.assign(h, { x: e.clientX, y: e.clientY, inside: true, modifier: e.ctrlKey || e.metaKey });
                updateHover();
            };
            const onMouseLeave = () => {
                hoverRef.current.inside = false;
                updateHover();
            };
            // Hide the tooltip until the pointer next moves.
            const suppressTip = () => {
                hoverRef.current.tipSuppressed = true;
                hideTip();
            };
            // Pressing or releasing Ctrl/Cmd over a call (focused or not),
            // and leaving the window with it held.
            React.useEffect(() => {
                const onKey = (e) => {
                    if (e.key !== 'Control' && e.key !== 'Meta') return;
                    hoverRef.current.modifier = e.ctrlKey || e.metaKey;
                    if (hoverRef.current.inside) updateHoverRef.current();
                };
                const onBlur = () => {
                    hoverRef.current.modifier = false;
                    updateHoverRef.current();
                };
                window.addEventListener('keydown', onKey);
                window.addEventListener('keyup', onKey);
                window.addEventListener('blur', onBlur);
                return () => {
                    window.removeEventListener('keydown', onKey);
                    window.removeEventListener('keyup', onKey);
                    window.removeEventListener('blur', onBlur);
                    clearTimeout(hoverRef.current.tipTimer);
                };
            }, []);
            // New highlighted HTML replaces the spans: find the one under
            // the pointer again. (onScroll does the same as they move.)
            React.useLayoutEffect(() => {
                hoverRef.current.link = null;
                updateHover();
            }, [highlighted]);

            // Ctrl/Cmd+click on a call opens its documentation. The
            // mousedown is swallowed so the caret and selection stay put.
            // (On macOS Ctrl+click is a right click, so it's Cmd+click.)
            const linkUnder = (e) => ((e.ctrlKey || e.metaKey) && onOpenNodeDocs ? stdlibSpanAt(e.clientX, e.clientY) : null);
            const onMouseDown = (e) => {
                suppressTip();
                if (e.button === 0 && linkUnder(e)) e.preventDefault();
            };
            const onClick = (e) => {
                const span = e.button === 0 ? linkUnder(e) : null;
                if (!span) return;
                e.preventDefault();
                onOpenNodeDocs(span.dataset.node);
            };

            // execCommand keeps the browser's own undo stack intact (a
            // direct .value write would wipe it) and still fires the input
            // event React's onChange listens for.
            const insertText = (text) => {
                const ta = taRef.current;
                if (!ta) return;
                if (!document.execCommand('insertText', false, text)) {
                    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
                    emitChange(ta.value);
                }
            };

            // Keys for the open suggestion list and parameter hints, first.
            // True when the key was theirs.
            const assistKeyDown = (e) => {
                const comp = completionRef.current;
                const help = hintsRef.current;
                const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
                if (e.key === ' ' && e.ctrlKey && !e.altKey && !e.metaKey) {
                    refreshAssist({ kind: e.shiftKey ? 'hints' : 'complete' });
                    return true;
                }
                if (comp) {
                    const steps = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 };
                    if (plain && steps[e.key]) {
                        const n = comp.entries.length;
                        if (n) {
                            const step = steps[e.key];
                            const index = Math.abs(step) === 1
                                ? (comp.index + step + n) % n
                                : Math.max(0, Math.min(n - 1, comp.index + step));
                            setAssist({ ...comp, index }, help);
                        }
                        return true;
                    }
                    if (plain && (e.key === 'Enter' || e.key === 'Tab')) {
                        const entry = comp.entries[comp.index];
                        // Enter after a word typed out in full is a new line.
                        if (entry && !(e.key === 'Enter' && entry.item.label === comp.typed)) {
                            acceptCompletion(entry.item);
                            return true;
                        }
                        setAssist(null, help);
                        return false; // on to the new line / tab
                    }
                    if (e.key === 'Escape') {
                        setAssist(null, help);
                        return true;
                    }
                }
                if (help) {
                    if (plain && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && help.sigs.length > 1) {
                        cycleHints(e.key === 'ArrowDown' ? 1 : -1);
                        return true;
                    }
                    if (e.key === 'Escape') {
                        setAssist(completionRef.current, null);
                        return true;
                    }
                }
                return false;
            };

            const onKeyDown = (e) => {
                // Typing hides the tooltip; Ctrl/Cmd (the link modifier)
                // and the other modifiers on their own don't.
                if (e.key !== 'Control' && e.key !== 'Meta' && e.key !== 'Shift' && e.key !== 'Alt') suppressTip();
                if (e.nativeEvent.isComposing) return;
                if (!readOnly && assistKeyDown(e)) {
                    e.preventDefault();
                    return;
                }
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    if (onSubmit) onSubmit();
                    return;
                }
                if (e.key === 'Escape') {
                    // Tab indents in here, so Esc is the keyboard way out.
                    e.currentTarget.blur();
                    return;
                }
                if (readOnly) return;
                if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
                    e.preventDefault();
                    insertText('\t');
                } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
                    // Carry the current line's indentation onto the new one.
                    const ta = e.currentTarget;
                    const lineStart = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
                    const indent = /^[ \t]*/.exec(ta.value.slice(lineStart, ta.selectionStart))[0];
                    e.preventDefault();
                    insertText('\n' + indent);
                }
            };

            return (
                <div className="flex flex-1 min-w-0 min-h-0 bg-gray-900/60">
                    {/* Line numbers: scrolled in lockstep with the textarea
                        (overflow hidden, never scrolled by the user). The
                        extra bottom padding covers the textarea's
                        horizontal scrollbar, so both can reach the same
                        scrollTop at the very end of the file. */}
                    <pre
                        ref={gutterRef}
                        aria-hidden="true"
                        className={CODE_TEXT_CLASS + ' flex-none m-0 overflow-hidden select-none text-right text-gray-500 pl-2 pr-2 border-r border-gray-800'}
                        style={{ paddingTop: CODE_PAD_Y, paddingBottom: CODE_PAD_Y + 24, minWidth: (String(lineCount).length + 2) + 'ch' }}
                    >{gutterBefore}<span className={CODE_CURRENT_NUMBER_CLASS}>{gutterNumbers[activeLine]}</span>{gutterAfter}</pre>
                    <div className="relative flex-1 min-w-0 flex overflow-hidden">
                        {/* Three layers, bottom to top, all following the
                            textarea's scroll (syncScroll): the current-line
                            band; the textarea itself, which draws only the
                            caret and selection (.slx-input); and the
                            highlighted code (.slx-code), which takes no
                            pointer events. The code sits over the selection
                            so selected text keeps its colours, as in VS Code. */}
                        <div aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-none">
                            <div ref={backdropRef} className="relative">
                                {caret.collapsed && (
                                    <div
                                        className={CODE_CURRENT_LINE_CLASS + ' absolute left-0 right-0'}
                                        style={{ top: CODE_PAD_Y + activeLine * CODE_LINE_HEIGHT, height: CODE_LINE_HEIGHT }}
                                    />
                                )}
                            </div>
                        </div>
                        {/* `relative` so it paints above the (positioned)
                            band layer. */}
                        <textarea
                            ref={taRef}
                            value={value}
                            onChange={(e) => {
                                // Note what kind of edit this was for the
                                // assists (refreshAssist, after the render).
                                const ne = e.nativeEvent || {};
                                let trigger = { kind: 'edit' };
                                if (programmaticRef.current) {
                                    trigger = programmaticRef.current;
                                } else if (ne.inputType === 'insertText' && typeof ne.data === 'string' && ne.data.length === 1) {
                                    trigger = /\w/.test(ne.data) ? { kind: 'word' } : { kind: 'char', char: ne.data };
                                } else if (/^delete/.test(ne.inputType || '')) {
                                    trigger = { kind: 'delete' };
                                }
                                pendingAssistRef.current = trigger;
                                emitChange(e.target.value);
                            }}
                            onKeyDown={onKeyDown}
                            onBlur={() => setAssist(null, null)}
                            onScroll={() => { syncScroll(); hideTip(); updateHover(); placeAssist(); }}
                            onMouseMove={onMouseMove}
                            onMouseLeave={onMouseLeave}
                            onMouseDown={onMouseDown}
                            onClick={onClick}
                            readOnly={readOnly}
                            placeholder={placeholder}
                            aria-label="ShadingLanguageX code"
                            wrap="off"
                            spellCheck={false}
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="off"
                            className={CODE_TEXT_CLASS + ' slx-input relative flex-1 min-w-0 m-0 px-2 resize-none overflow-auto custom-scrollbar bg-transparent placeholder-gray-600 whitespace-pre focus:outline-none'}
                            style={{ paddingTop: CODE_PAD_Y, paddingBottom: CODE_PAD_Y, tabSize: CODE_TAB_SIZE }}
                        />
                        <div ref={codeClipRef} aria-hidden="true" className="absolute left-0 top-0 overflow-hidden pointer-events-none">
                            {/* The highlighted code, and over it the error
                                squiggles: the same text laid out the same
                                way, invisible but for its wavy underlines.
                                A layer of its own so a squiggle never has
                                to split or nest in the token spans. */}
                            <div ref={codeRef} className="relative">
                                <pre
                                    className={CODE_TEXT_CLASS + ' slx-code m-0 px-2 whitespace-pre'}
                                    style={{ paddingTop: CODE_PAD_Y, tabSize: CODE_TAB_SIZE }}
                                    dangerouslySetInnerHTML={highlighted}
                                />
                                {squiggles && (
                                    <pre
                                        className={CODE_TEXT_CLASS + ' slx-marks absolute left-0 top-0 m-0 px-2 whitespace-pre'}
                                        style={{ paddingTop: CODE_PAD_Y, tabSize: CODE_TAB_SIZE }}
                                        dangerouslySetInnerHTML={squiggles}
                                    />
                                )}
                            </div>
                        </div>
                    </div>
                    {/* The popups (js/graph/slx-assist.jsx), portaled out of
                        the panel and placed by placeAssist and the hover
                        card's layout effect. */}
                    {tip && <SlxHoverCard name={tip.name} fn={library ? library.functions.get(tip.name) : null} elRef={tipRef} />}
                    {hints && <SlxParameterHints help={hints} onCycle={cycleHints} elRef={hintsElRef} />}
                    {completion && (
                        <SlxCompletionList
                            entries={completion.entries}
                            index={completion.index}
                            onPick={(i) => acceptCompletion(completion.entries[i].item)}
                            elRef={completionElRef}
                        />
                    )}
                </div>
            );
        }

        // The docked panel: header, editor, status line and the two
        // actions. `code` is null until the first decompile lands.
        // `busy` is 'compile' | 'decompile' | null; `message` is
        // { kind: 'ok' | 'error', text, source } | null, `source` being set
        // on errors whose line numbers are into that code (mxslc's own
        // compile errors): those get squiggled. `library` (the function
        // library, or null while it loads) and `onOpenNodeDocs` are passed
        // through to SlxCodeEditor. `canvasRef` is the graph canvas beside
        // the panel, measured so the panel never crowds it out.
        function SlxCodeView({
            code, modified, busy, message, library,
            onCodeChange, onCompile, onDecompile, onCollapse, onOpenNodeDocs, canvasRef, editorRef,
        }) {
            // The editor's apiRef (SlxCodeEditor), shared with the caller
            // through `editorRef` when it passes one.
            const ownEditorApiRef = React.useRef(null);
            const editorApiRef = editorRef || ownEditorApiRef;
            const loading = code == null;
            // A new object only when the message changes: the editor keeps
            // carrying the squiggle through edits until then.
            const diagnostics = React.useMemo(() => {
                if (!message || message.kind !== 'error' || message.source == null) return null;
                const line = slxErrorLine(message.text);
                return line != null ? { source: message.source, items: [{ line, message: message.text }] } : null;
            }, [message]);
            const errorLine = diagnostics ? diagnostics.items[0].line : null;

            // Width: the user's preferred width (seeded from localStorage,
            // set by dragging the handle on the panel's right edge, one
            // setState per animation frame like graph-app.jsx's sidebars),
            // clamped to what the canvas can spare right now. Opening
            // another panel squeezes this one; closing it gives the
            // preferred width back.
            const [preferredWidth, setPreferredWidth] = React.useState(() => {
                let stored = NaN;
                try {
                    stored = parseFloat(window.localStorage.getItem(CODE_VIEW_WIDTH_STORAGE_KEY));
                } catch (e) { /* private mode / storage disabled */ }
                return clampCodeViewWidth(stored);
            });
            const [shared, setShared] = React.useState(0);
            const width = clampCodeViewWidth(preferredWidth, shared);
            const widthRef = React.useRef(width);
            widthRef.current = width;
            // This panel plus the canvas: constant however the two split it,
            // so re-measuring after this panel resizes can't feed back.
            const measureShared = () => {
                const canvas = canvasRef && canvasRef.current;
                return canvas ? widthRef.current + canvas.getBoundingClientRect().width : 0;
            };
            const dragRef = React.useRef(null); // { startX, startWidth, lastWidth, shared } while dragging
            const [dragging, setDragging] = React.useState(false);
            const onHandleMouseDown = (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                dragRef.current = { startX: e.clientX, startWidth: widthRef.current, lastWidth: widthRef.current, shared: measureShared() };
                setDragging(true);
            };
            React.useEffect(() => {
                if (!dragging) return;
                let rafId = null;
                const applyPending = () => {
                    rafId = null;
                    if (dragRef.current) setPreferredWidth(dragRef.current.lastWidth);
                };
                const onMove = (e) => {
                    const drag = dragRef.current;
                    if (!drag) return;
                    drag.lastWidth = clampCodeViewWidth(drag.startWidth + (e.clientX - drag.startX), drag.shared);
                    if (rafId == null) rafId = requestAnimationFrame(applyPending);
                };
                const onUp = () => {
                    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
                    const drag = dragRef.current;
                    if (drag) {
                        setPreferredWidth(drag.lastWidth);
                        try { window.localStorage.setItem(CODE_VIEW_WIDTH_STORAGE_KEY, String(Math.round(drag.lastWidth))); } catch (e) { /* private mode / storage disabled */ }
                    }
                    dragRef.current = null;
                    setDragging(false);
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
                return () => {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    if (rafId != null) cancelAnimationFrame(rafId);
                };
            }, [dragging]);
            // Track the shared space as the window or the other panels
            // change the canvas's width.
            React.useEffect(() => {
                const canvas = canvasRef && canvasRef.current;
                if (!canvas) return;
                const measure = () => {
                    const s = measureShared();
                    if (s) setShared(Math.round(s));
                };
                measure();
                const ro = new ResizeObserver(measure);
                ro.observe(canvas);
                return () => ro.disconnect();
            }, []);

            return (
                <React.Fragment>
                    <aside
                        style={{ width }}
                        className="flex-none flex flex-col bg-gray-800/95 border-r border-gray-600 overflow-hidden font-mono">
                        <div className="flex items-center gap-2 px-3 py-2 min-h-[45px] border-b border-gray-700 bg-gray-900/70">
                            <MtlxIcon name="code" className="w-3.5 h-3.5 text-gray-500" />
                            <span className="text-[13px] font-bold text-gray-100 truncate flex-1">ShadingLanguageX</span>
                            {modified && (
                                <span className="flex-none text-[10px] text-amber-300" title="The code has edits that haven't been compiled into the node graph yet">
                                    modified
                                </span>
                            )}
                            <button
                                type="button"
                                title="Collapse the code view"
                                className="flex-none w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700/80 transition-colors"
                                onClick={onCollapse}
                            >
                                <MtlxIcon name="chevrons-left" className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="relative flex-1 min-h-0 flex">
                            <SlxCodeEditor
                                value={loading ? '' : code}
                                onChange={onCodeChange}
                                onSubmit={() => { if (!busy && !loading) onCompile(); }}
                                readOnly={loading}
                                placeholder={loading ? '' : 'Write your ShadingLanguageX code then click Compile to build the node graph.'}
                                library={library}
                                onOpenNodeDocs={onOpenNodeDocs}
                                diagnostics={diagnostics}
                                apiRef={editorApiRef}
                            />
                            {loading && (
                                <div className="absolute inset-0 flex items-center justify-center text-[11px] text-gray-500 animate-pulse pointer-events-none">
                                    {'Decompiling…'}
                                </div>
                            )}
                        </div>
                        <div className="flex-none flex flex-col gap-2 p-2 border-t border-gray-700 bg-gray-900/70">
                            {message && message.kind === 'error' && (
                                <div className="max-h-40 overflow-y-auto custom-scrollbar px-2 py-1.5 rounded border border-red-800/60 bg-red-950/60 text-red-300 text-[11px] whitespace-pre-wrap break-words">
                                    {message.text}
                                    {errorLine != null && (
                                        <button
                                            type="button"
                                            onClick={() => editorApiRef.current && editorApiRef.current.revealDiagnostic(0)}
                                            className="block mt-1 underline decoration-dotted underline-offset-2 hover:text-red-200"
                                        >
                                            Go to line {errorLine}
                                        </button>
                                    )}
                                </div>
                            )}
                            {message && message.kind === 'ok' && (
                                <div className="flex items-center gap-1.5 px-0.5 text-[11px] text-green-300">
                                    <MtlxIcon name="check" className="w-3.5 h-3.5 flex-none" />
                                    <span className="truncate">{message.text}</span>
                                    {message.undoable && (
                                        <button
                                            type="button"
                                            onClick={() => editorApiRef.current && editorApiRef.current.undo()}
                                            title="Put back the code this replaced (Ctrl+Z in the code)"
                                            className="flex-none underline decoration-dotted underline-offset-2 hover:text-green-200"
                                        >
                                            Undo
                                        </button>
                                    )}
                                </div>
                            )}
                            <div className="flex items-center gap-2 font-sans">
                                <button
                                    type="button"
                                    onClick={onDecompile}
                                    disabled={!!busy}
                                    title="Replace the code with the current node graph, decompiled to ShadingLanguageX"
                                    className={BTN_SECONDARY + ' flex-1 gap-1.5'}
                                >
                                    <MtlxIcon name="arrow-left" className="w-3.5 h-3.5" />
                                    <span>{busy === 'decompile' ? 'Decompiling…' : 'Decompile'}</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={onCompile}
                                    disabled={!!busy || loading}
                                    title="Compile the code and regenerate the node graph from it (Ctrl+Enter)"
                                    className={BTN_PRIMARY + ' flex-1 gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none'}
                                >
                                    <span>{busy === 'compile' ? 'Compiling…' : 'Compile'}</span>
                                    <MtlxIcon name="arrow-right" className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                    </aside>
                    <div
                        onMouseDown={onHandleMouseDown}
                        title="Drag to resize"
                        className={'flex-none w-1.5 cursor-col-resize transition-colors '
                            + (dragging ? 'bg-blue-500/70' : 'bg-transparent hover:bg-blue-500/50')}
                    />
                </React.Fragment>
            );
        }

Object.assign(window, { SlxCodeView, SlxCodeEditor });
