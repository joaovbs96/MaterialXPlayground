// rich-text.jsx — inline markdown/math rendering for node prose: KaTeX
// math spans, footnote refs, cross-reference chips, and paragraph/
// sub-heading blocks. Loaded as text/babel, so each file runs in its
// own function scope — the public API is exported onto window below.

        // $inline$/$$display$$ math and [^footnote] refs render via
        // KaTeX; unrendered/failed spans fall back to raw text so
        // nothing is lost.
        // Spec markdown may embed raw <sup>/<sub> HTML, e.g. "m<sup>−1</sup>"
        // — captured here at top priority so the angle-token styler
        // below doesn't mis-render it as a node-reference chip.
        const RICH_SPLIT_RE = /(\$\$[^$]+\$\$|\$[^$\n]+\$|\[\^[^\]\s]+\]|<sup>[^<]*<\/sup>|<sub>[^<]*<\/sub>)/g;
        const FOOTNOTE_RE = /^\[\^([^\]\s]+)\]$/;

        // Plain-prose styling: vectors like [0.001, 0.001, 0.01] and
        // <nodename> tokens render in monospace. Vector needs >=2
        // comma-sep numbers; token must start with a letter ("a < b" is safe).
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
                    // Cross-reference: <nodename> tokens that match a loaded
                    // node navigate to it in-app; unknown tokens (ports,
                    // placeholders like <geomname>) stay plain chips.
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
        // Markdown links [text](https://...): a spec's #node-... anchor
        // opens the node in-app (via mtlx-open-node) when known;
        // anything else opens the official page in a new tab.
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

        // Cache: renderToString is synchronous and re-parses every call,
        // so without it every math span re-renders on every App render
        // (e.g. each keystroke). Never touch it while window.katex is absent.
        const KATEX_CACHE = new Map();
        const renderKatex = (src, displayMode) => {
            const key = (displayMode ? 'D:' : 'I:') + src;
            if (KATEX_CACHE.has(key)) return KATEX_CACHE.get(key);
            let html = null;
            try {
                html = window.katex.renderToString(src, { displayMode, throwOnError: true });
            } catch (err) {
                html = null;
            }
            KATEX_CACHE.set(key, html);
            return html;
        };

        // KaTeX loads via `defer`, so it may not exist on first render
        // (math shows raw until then). One shared module-level poll
        // notifies all useKatexReady() subscribers once it arrives.
        const katexSubs = new Set();
        let katexPollTimer = null;
        const startKatexPoll = () => {
            if (katexPollTimer || window.katex) return;
            katexPollTimer = setInterval(() => {
                if (!window.katex) return;
                clearInterval(katexPollTimer);
                katexPollTimer = null;
                katexSubs.forEach((fn) => fn());
            }, 200);
        };
        function useKatexReady() {
            const [ready, setReady] = React.useState(!!window.katex);
            React.useEffect(() => {
                if (ready) return undefined;
                const onReady = () => setReady(true);
                katexSubs.add(onReady);
                startKatexPoll();
                return () => { katexSubs.delete(onReady); };
            }, [ready]);
            return ready;
        }

        const MathText = React.memo(function MathText({ text, refs }) {
            // Return value unused: subscribing here re-renders MathText
            // once KaTeX loads. Without it, React.memo (props unchanged)
            // would skip that re-render and raw-text spans would stick.
            useKatexReady();
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
                            const html = renderKatex(src, isDisplay);
                            if (html != null) {
                                return <span key={i} dangerouslySetInnerHTML={{ __html: html }} />;
                            }
                            return <span key={i}>{part}</span>; // parse failure: raw text
                        }
                        return <span key={i}>{styleInline(part, i + '-')}</span>;
                    })}
                </React.Fragment>
            );
        });

        // Renders multi-paragraph prose: split on \n\n; a paragraph
        // starting with '#'s becomes a sub-heading; a standalone
        // "$$...$$" paragraph becomes a centered display equation.
        const SUBHEADING_RE = /^#{1,6}\s+(.*)$/;

        const RichBlocks = React.memo(function RichBlocks({ text, refs, className }) {
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
        });

        // ---- public API ----
        // styleInlinePlain/styleInline/openDocLink have no consumers
        // outside this file (repo-wide grep checked) — used internally
        // only, so they're omitted from the export below.
        Object.assign(window, {
            MathText, RichBlocks,
        });
