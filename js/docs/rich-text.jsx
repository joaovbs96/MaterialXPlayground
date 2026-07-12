// rich-text.jsx — inline markdown/math rendering for node prose: KaTeX
// math spans, footnote references, cross-reference chips, and paragraph/
// sub-heading blocks. Split out of doc-ui.jsx (Phase 3) — pure move, no
// behavior change. Loaded as text/babel; Babel executes each file in its
// own function scope, so the public API is exported onto window at the
// bottom.

        // ------------------------------------------------------------------
        // Rich text: node prose may contain $inline$ / $$display$$ math
        // spans (preserved verbatim by the parser) and footnote references
        // like [^Oren1994]. Math renders via KaTeX; footnote refs render as
        // superscript numbered links into the node's reference list. If
        // KaTeX failed to load or a span doesn't parse, the raw text shows
        // instead so nothing is ever lost.
        // ------------------------------------------------------------------
        // Node prose may also contain simple inline HTML from the spec
        // markdown, e.g. "m<sup>−1</sup>" in anisotropic_vdf's absorption
        // docs. Without explicit handling, the angle-token styler below
        // renders "<sup>" as a node-reference chip and leaves "</sup>" as
        // raw text. Captured here (top priority in the split) and rendered
        // as REAL superscript/subscript elements.
        const RICH_SPLIT_RE = /(\$\$[^$]+\$\$|\$[^$\n]+\$|\[\^[^\]\s]+\]|<sup>[^<]*<\/sup>|<sub>[^<]*<\/sub>)/g;
        const FOOTNOTE_RE = /^\[\^([^\]\s]+)\]$/;

        // Inline styling for plain prose: numeric vectors like
        // [0.001, 0.001, 0.01] and MaterialX node names in angle brackets like
        // <image> render in the monospace table font (a vector needs >=2
        // comma-separated numbers; an angle token must start with a letter, so
        // "a < b" isn't matched).
        const INLINE_STYLE_RE = /(\[\s*[+-]?\d[\d.eE+-]*(?:\s*,\s*[+-]?\d[\d.eE+-]*)+\s*\]|<[A-Za-z_][\w.:-]*>)/g;
        const MONO = 'font-mono text-[0.9em] bg-gray-900/70 border border-gray-700 rounded px-1 py-0.5';
        const styleInlinePlain = (text, kp) => {
            const parts = String(text).split(INLINE_STYLE_RE);
            return parts.map((part, i) => {
                if (!part) return null;
                if (part[0] === '[' && part[part.length - 1] === ']') {
                    return <code key={kp + 'v' + i} className={MONO + ' text-amber-300'}>{part}</code>;
                }
                if (part[0] === '<' && part[part.length - 1] === '>') {
                    // Cross-reference: a <nodename> token that matches a node in
                    // the loaded database navigates to it in-app. Unknown tokens
                    // (ports, placeholders like <geomname>) stay plain chips.
                    const inner = part.slice(1, -1);
                    const idx = window.__mtlxNodeIndex;
                    const key = /^[A-Za-z0-9_-]+$/.test(inner) ? inner.replace(/[-_]/g, '').toLowerCase() : null;
                    if (key && idx && idx[key]) {
                        return (
                            <code
                                key={kp + 'n' + i}
                                onClick={() => window.dispatchEvent(new CustomEvent('mtlx-open-node', { detail: { key } }))}
                                title={'Open node: ' + idx[key].name}
                                className={MONO + ' text-blue-300 underline decoration-blue-500/40 cursor-pointer hover:text-blue-200'}
                            >{part}</code>
                        );
                    }
                    return <code key={kp + 'n' + i} className={MONO + ' text-blue-300'}>{part}</code>;
                }
                return <React.Fragment key={kp + 't' + i}>{part}</React.Fragment>;
            });
        };
        // Markdown links preserved by the parser: [text](https://...).
        // Links into a spec's #node-... anchor open the node IN-APP when we
        // know it (via the mtlx-open-node event the App listens for); anything
        // else opens the official page in a new tab.
        const DOC_LINK_RE = /\[([^\]^][^\]]*)\]\((https?:[^)\s]+)\)/g;
        const SPEC_NODE_ANCHOR_RE = /documents\/Specification\/[^#)\s]*#(node-[A-Za-z0-9_-]+)/;
        const openDocLink = (url) => {
            const m = url.match(SPEC_NODE_ANCHOR_RE);
            if (m) {
                // Anchor conventions vary (hyphenated vs squashed); normalize
                // both sides by dropping separators and let the App resolve it.
                const key = m[1].slice(5).replace(/[-_]/g, '').toLowerCase();
                window.dispatchEvent(new CustomEvent('mtlx-open-node', { detail: { key, url } }));
                return;
            }
            window.open(url, '_blank', 'noopener');
        };
        const styleInline = (text, kp) => {
            const src = String(text);
            const out = [];
            let last = 0, m, i = 0;
            DOC_LINK_RE.lastIndex = 0;
            while ((m = DOC_LINK_RE.exec(src)) !== null) {
                if (m.index > last) out.push(...styleInlinePlain(src.slice(last, m.index), kp + 'p' + i + '-'));
                const url = m[2];
                out.push(
                    <a
                        key={kp + 'l' + i}
                        href={url}
                        onClick={(e) => { e.preventDefault(); openDocLink(url); }}
                        className="text-blue-400 hover:text-blue-300 underline decoration-blue-500/40 cursor-pointer"
                        title={url}
                    >{m[1]}</a>
                );
                last = m.index + m[0].length;
                i++;
            }
            if (last < src.length) out.push(...styleInlinePlain(src.slice(last), kp + 'e-'));
            return out;
        };

        function MathText({ text, refs }) {
            if (text == null || text === '') return null;
            const parts = String(text).split(RICH_SPLIT_RE);
            return (
                <React.Fragment>
                    {parts.map((part, i) => {
                        if (!part) return null;

                        // Inline HTML super/subscript from the spec markdown
                        // (e.g. "m<sup>−1</sup>") -> real <sup>/<sub>.
                        const supSub = part.match(/^<(sup|sub)>([^<]*)<\/\1>$/);
                        if (supSub) {
                            const Tag = supSub[1];
                            return <Tag key={i}>{styleInline(supSub[2], 'ss' + i + '-')}</Tag>;
                        }

                        // Footnote reference -> superscript link [n]
                        const fn = part.match(FOOTNOTE_RE);
                        if (fn) {
                            const ref = refs && refs[fn[1]];
                            if (ref) {
                                const marker = `[${ref.n}]`;
                                return (
                                    <sup key={i} className="text-blue-400">
                                        {ref.url ? (
                                            <a href={ref.url} target="_blank" rel="noreferrer"
                                               title={ref.text || fn[1]}
                                               className="hover:underline">{marker}</a>
                                        ) : (
                                            <span title={ref.text || fn[1]}>{marker}</span>
                                        )}
                                    </sup>
                                );
                            }
                            return <span key={i}>{part}</span>; // unknown key: keep raw
                        }

                        // Math span -> KaTeX
                        const isDisplay = part.length > 4 && part.startsWith('$$') && part.endsWith('$$');
                        const isInline = !isDisplay && part.length > 2 && part.startsWith('$') && part.endsWith('$');
                        if ((isDisplay || isInline) && window.katex) {
                            const src = isDisplay ? part.slice(2, -2) : part.slice(1, -1);
                            try {
                                const html = window.katex.renderToString(src, {
                                    displayMode: isDisplay,
                                    throwOnError: true,
                                });
                                return <span key={i} dangerouslySetInnerHTML={{ __html: html }} />;
                            } catch (err) {
                                return <span key={i}>{part}</span>;
                            }
                        }
                        return <span key={i}>{styleInline(part, i + '-')}</span>;
                    })}
                </React.Fragment>
            );
        }

        // Renders multi-paragraph prose (description / notes): paragraphs
        // are separated by \n\n; a paragraph starting with '#'s is a
        // sub-heading (e.g. "#### Reflectance Equations"); a standalone
        // "$$...$$" paragraph becomes a centered display equation.
        const SUBHEADING_RE = /^#{1,6}\s+(.*)$/;

        function RichBlocks({ text, refs, className }) {
            if (!text) return null;
            return (
                <div className={className}>
                    {text.split('\n\n').map((block, i) => {
                        const h = block.match(SUBHEADING_RE);
                        if (h) {
                            return (
                                <h4 key={i} className="text-sm font-semibold text-gray-200 uppercase tracking-wider mt-5 mb-2">
                                    {h[1]}
                                </h4>
                            );
                        }
                        return (
                            <p key={i} className="mb-3">
                                <MathText text={block} refs={refs} />
                            </p>
                        );
                    })}
                </div>
            );
        }

        // ---- public API ----
        // styleInlinePlain/styleInline/openDocLink have no consumers
        // outside this file (checked repo-wide, word-boundary grep) — kept
        // as declarations (used internally by MathText/styleInline) but
        // omitted from the export list.
        Object.assign(window, {
            MathText, RichBlocks,
        });
