// validator.js — two-tier .mtlx diagnostics.
//
// Tier 1 (scanXml): a hand-rolled, dependency-free XML well-formedness
// scanner. Runs on every document change, synchronously, with no wasm
// involved — catches the mistakes that actually happen while hand-
// editing a .mtlx file (unclosed tags, mismatched close tags, unescaped
// '&', malformed attributes) fast enough to run on a debounce timer per
// keystroke. This extension ships with ZERO npm dependencies, so this is
// a tokenizer, not a real XML parser.
//
// Tier 2 (validateDocument, when tier 1 is clean): defers to
// mtlxNode.validateSemantic for an actual MaterialX parse + validate()
// pass, then heuristically maps its free-text messages back onto a
// document range (the WASM binding hands back no offsets at all).
//
// Pure Node, same as mtlxNode.js: must NOT require('vscode') anywhere —
// the return shape here is plain objects ({ message, startLine,
// startChar, endLine, endChar, severity }), not vscode.Diagnostic
// instances, precisely so this stays independently loadable/testable
// with plain `node`. extension.js converts to vscode.Diagnostic at the
// boundary.
'use strict';

const mtlxNode = require('./mtlxNode');
const mtlxSymbols = require('./mtlxSymbols');
const { escapeRegExp } = require('./util');

// ---------------------------------------------------------------------
// Shared position mapping: precompute line-start offsets once per scan,
// then binary-search to convert an absolute char offset to {line,
// character} (0-indexed). The regex sweep handles CRLF correctly
// without double-counting a line break: \r\n is consumed as a single
// 2-char match, and offsets are only ever computed at real token
// positions, never AT a break character itself.
function computeLineStarts(text) {
    const starts = [0];
    const re = /\r\n|\r|\n/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        starts.push(m.index + m[0].length);
    }
    return starts;
}

function offsetToPos(lineStarts, offset) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return { line: lo, character: offset - lineStarts[lo] };
}

// ---------------------------------------------------------------------
// Tier 1 — scanXml(text) -> Array<{ message, startLine, startChar,
// endLine, endChar, severity: 'error' }>
//
// A single forward-moving cursor walks the whole text. EVERY branch,
// including every error branch, advances the cursor past whatever it
// just failed to parse — a hand-rolled tokenizer that doesn't guarantee
// this hangs the extension host on every keystroke (this runs on a
// debounce timer per document change; see extension.js). Recovery after
// a malformed tag/attribute skips forward to the next unquoted '>' (or
// EOF) so one bad edit produces one diagnostic, not a cascade of
// spurious ones over the rest of the file.
function scanXml(text) {
    const lineStarts = computeLineStarts(text);
    const errors = [];
    const addError = (startOffset, endOffset, message) => {
        const s = offsetToPos(lineStarts, startOffset);
        const e = offsetToPos(lineStarts, Math.max(endOffset, startOffset));
        errors.push({ message, startLine: s.line, startChar: s.character, endLine: e.line, endChar: e.character, severity: 'error' });
    };

    const len = text.length;
    // Open-tag stack: { name, start, end } — start/end is the tag NAME's
    // own char range within its opening tag (e.g. the "node" in
    // "<node "), used both for a mismatched-close-tag message and for
    // the end-of-document "Unclosed tag" diagnostic, so each unclosed
    // tag squiggles at its OWN opening position rather than all piling
    // up at EOF.
    const stack = [];

    // Excludes '<' too (matching isAttrNameChar below) — without it, a
    // stray '<' typo'd into a tag name (e.g. "<input<name=...") is
    // silently swallowed into a garbage tag name instead of being
    // flagged, which defeats tier 1's whole job on the (explicitly
    // supported) path where tier 2/wasm is unavailable and this scanner
    // is the only thing catching malformed XML at all.
    const isTagNameChar = (ch) => ch !== undefined && !/[\s/><]/.test(ch);
    const isAttrNameChar = (ch) => ch !== undefined && !/[\s=/>"'<]/.test(ch);
    const isWs = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

    const readWhile = (start, pred) => {
        let i = start;
        while (i < len && pred(text[i])) i++;
        return i;
    };
    const skipWs = (start) => readWhile(start, isWs);

    // & entity refs, valid inside both top-level text runs and attribute
    // values: &amp; &lt; &gt; &apos; &quot; or a numeric ref (&#123; /
    // &#x1F;, case-insensitive x).
    const ENTITY_RE = /^(?:amp|lt|gt|apos|quot);|^#[0-9]+;|^#[xX][0-9a-fA-F]+;/;
    function checkEntities(start, end) {
        for (let i = start; i < end; i++) {
            if (text[i] !== '&') continue;
            const rest = text.slice(i + 1, Math.min(end, i + 32));
            if (!ENTITY_RE.test(rest)) {
                addError(i, Math.min(end, i + 6), "Invalid entity reference (unescaped '&' or unknown entity)");
            }
        }
    }

    let cursor = 0;

    outer:
    while (cursor < len) {
        const lt = text.indexOf('<', cursor);
        if (lt === -1) {
            checkEntities(cursor, len);
            break;
        }
        checkEntities(cursor, lt);

        if (text.startsWith('<!--', lt)) {
            const close = text.indexOf('-->', lt + 4);
            if (close === -1) {
                addError(lt, lt + 3, 'Unterminated comment');
                break outer;
            }
            cursor = close + 3;
            continue;
        }

        if (text.startsWith('<![CDATA[', lt)) {
            const close = text.indexOf(']]>', lt + 9);
            if (close === -1) {
                addError(lt, lt + 9, 'Unterminated CDATA section');
                break outer;
            }
            cursor = close + 3;
            continue;
        }

        if (text.startsWith('<?', lt)) {
            const close = text.indexOf('?>', lt + 2);
            if (close === -1) {
                addError(lt, lt + 2, 'Unterminated processing instruction');
                break outer;
            }
            cursor = close + 2;
            continue;
        }

        if (text.startsWith('<!', lt)) {
            // e.g. <!DOCTYPE ...> — scan to the next '>' not inside a
            // quoted span. MaterialX files don't use DOCTYPE internal
            // subsets, so this simplified (no nested '[' ']' tracking)
            // scan is good enough.
            let i = lt + 2;
            let inQuote = null;
            let found = -1;
            while (i < len) {
                const ch = text[i];
                if (inQuote) {
                    if (ch === inQuote) inQuote = null;
                } else if (ch === '"' || ch === "'") {
                    inQuote = ch;
                } else if (ch === '>') {
                    found = i;
                    break;
                }
                i++;
            }
            if (found === -1) {
                addError(lt, lt + 2, 'Unterminated declaration');
                break outer;
            }
            cursor = found + 1;
            continue;
        }

        if (text[lt + 1] === '/') {
            // Closing tag: </name >
            const nameStart = lt + 2;
            const nameEnd = readWhile(nameStart, isTagNameChar);
            const name = text.slice(nameStart, nameEnd);
            if (!name) {
                addError(lt, lt + 1, "Unexpected '<': not a valid tag/comment/CDATA start");
                cursor = lt + 1;
                continue;
            }
            const afterWs = skipWs(nameEnd);
            if (text[afterWs] !== '>') {
                addError(lt, nameEnd, 'Unterminated tag </' + name + '>');
                // Recover in place instead of aborting the whole scan: a
                // closing tag has nothing after its name to skip past, so
                // resume right where the missing '>' would have been and
                // best-effort pop the stack, so one missing '>' yields one
                // diagnostic instead of an "Unclosed tag" per ancestor.
                cursor = afterWs;
                if (stack.length) stack.pop();
                continue;
            }
            cursor = afterWs + 1;
            if (stack.length === 0) {
                addError(nameStart, nameEnd, 'Closing tag </' + name + '> has no matching open tag');
            } else {
                const top = stack[stack.length - 1];
                if (top.name !== name) {
                    addError(nameStart, nameEnd, 'Mismatched closing tag: expected </' + top.name + '> but found </' + name + '>');
                }
                // Pop regardless of match — a single missing/extra tag
                // must not cascade into an error per remaining tag.
                stack.pop();
            }
            continue;
        }

        // Opening / self-closing tag: <name ...> or <name .../>
        {
            const nameStart = lt + 1;
            const nameEnd = readWhile(nameStart, isTagNameChar);
            const name = text.slice(nameStart, nameEnd);
            if (!name) {
                addError(lt, lt + 1, "Unexpected '<': not a valid tag/comment/CDATA start");
                cursor = lt + 1;
                continue;
            }

            let i = nameEnd;
            const seenAttrs = new Set();
            let selfClosing = false;
            let terminated = false;
            let malformed = false;

            const recoverToGt = (from) => {
                const gt = text.indexOf('>', from);
                terminated = gt !== -1;
                return gt === -1 ? len : gt + 1;
            };

            while (i < len) {
                i = skipWs(i);
                if (i >= len) break;
                const ch = text[i];

                if (ch === '/') {
                    if (text[i + 1] === '>') {
                        selfClosing = true;
                        terminated = true;
                        i += 2;
                    } else {
                        addError(i, i + 1, 'Malformed attribute syntax in tag <' + name + '>');
                        malformed = true;
                        i = recoverToGt(i);
                    }
                    break;
                }
                if (ch === '>') {
                    terminated = true;
                    i += 1;
                    break;
                }
                if (!isAttrNameChar(ch)) {
                    addError(i, i + 1, 'Malformed attribute syntax in tag <' + name + '>');
                    malformed = true;
                    i = recoverToGt(i);
                    break;
                }

                // Attribute name.
                const attrNameStart = i;
                const attrNameEnd = readWhile(i, isAttrNameChar);
                const attrName = text.slice(attrNameStart, attrNameEnd);
                if (seenAttrs.has(attrName)) {
                    addError(attrNameStart, attrNameEnd, 'Duplicate attribute "' + attrName + '"');
                } else {
                    seenAttrs.add(attrName);
                }

                i = skipWs(attrNameEnd);
                if (text[i] !== '=') {
                    addError(attrNameStart, attrNameEnd, 'Attribute value for "' + attrName + '" is not properly quoted');
                    malformed = true;
                    i = recoverToGt(i);
                    break;
                }
                i = skipWs(i + 1);
                const quote = text[i];
                if (quote !== '"' && quote !== "'") {
                    addError(attrNameStart, attrNameEnd, 'Attribute value for "' + attrName + '" is not properly quoted');
                    malformed = true;
                    i = recoverToGt(i);
                    break;
                }
                const valueStart = i + 1;
                let j = valueStart;
                let closedAt = -1;
                while (j < len) {
                    if (text[j] === quote) { closedAt = j; break; }
                    if (text[j] === '<') break;
                    j++;
                }
                if (closedAt === -1) {
                    addError(attrNameStart, attrNameEnd, 'Attribute value for "' + attrName + '" is not properly quoted');
                    malformed = true;
                    i = recoverToGt(j);
                    break;
                }
                checkEntities(valueStart, closedAt);
                i = closedAt + 1;
                // Loop back for the next attribute.
            }

            if (!terminated && !malformed) {
                addError(lt, nameEnd, 'Unterminated tag <' + name + '>');
                break outer;
            }

            cursor = i;
            if (malformed) {
                // Still push the tag onto the stack as a best-effort
                // recovery: the malformed-attribute error above already
                // reports this exact tag, so leaving it off the stack only
                // makes its own closing tag (and its ancestors' closing
                // tags) look mismatched/orphaned too; one broken tag
                // producing three diagnostics instead of one.
                stack.push({ name, start: nameStart, end: nameEnd });
                continue;
            }
            if (!selfClosing) {
                stack.push({ name, start: nameStart, end: nameEnd });
            }
            continue;
        }
    }

    // Any names left on the stack at EOF are unclosed — one diagnostic
    // per remaining entry, positioned at that tag's OWN opening range.
    for (const entry of stack) {
        addError(entry.start, entry.end, 'Unclosed tag <' + entry.name + '>');
    }

    return errors;
}

// ---------------------------------------------------------------------
// Tier 2 — best-effort position mapping for mtlxNode.validateSemantic's
// free-text { text, tag, attrs, elementName } messages (the WASM binding
// hands back no character offsets at all). The PRIMARY path
// (findElementNameRange, used when the message line carried a
// serialized element) disambiguates same-named elements living under
// different parents by scoring how many of the offending element's OTHER
// attributes match; the FALLBACK path (findCandidateRange, used only
// when there's no serialized element to key off of) is a cruder
// heuristic that just searches for a bare attribute VALUE anywhere in
// the document, so it can occasionally point at the wrong occurrence of
// a common name. That's an accepted limitation of a boolean-only
// validate() binding, not a bug to chase here.

// Finds `name = "candidate"` (or similar) and returns the char range of
// just the candidate substring between the quotes, or null. FALLBACK
// ONLY — see mapSemanticMessageToRange; used when the message line has
// no serialized element to disambiguate with, so this settles for the
// FIRST occurrence anywhere in the document.
function findCandidateRange(text, candidate) {
    if (!candidate) return null;
    const re = new RegExp('=\\s*"' + escapeRegExp(candidate) + '"');
    const m = re.exec(text);
    if (!m) return null;
    // OPENING quote, not the closing one: the pattern ends `="` right
    // before the value, so the FIRST quote in the match (indexOf) is the
    // opening one. Using lastIndexOf here (the previous bug) grabs the
    // CLOSING quote instead, shifting the reported range one character
    // past the end of the value.
    const quoteAt = m.index + m[0].indexOf('"');
    return { start: quoteAt + 1, end: quoteAt + 1 + candidate.length };
}

// Scores how many of `attrs` (excluding `name`, already used to locate
// the candidate tag) are present verbatim as attr="value" inside
// `tagText` — used by findElementNameRange to disambiguate multiple
// same-tag, same-name elements (e.g. two <input name="in"> under
// different parent nodes) by how well their OTHER attributes match the
// failing element's own serialized form.
function scoreAttrs(tagText, attrs) {
    let score = 0;
    for (const key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key) || key === 'name') continue;
        if (tagText.indexOf(key + '="' + attrs[key] + '"') !== -1) score++;
    }
    return score;
}

// PRIMARY path: finds the best-matching `<tag ... name="NAME" ...>`
// occurrence in the document for a message line that carried a
// serialized element (mtlxNode.js's ELEMENT_TAG_RE). The serialized
// message line has all of the offending element's OWN attributes but no
// parent path, so `name` alone can collide with an unrelated element of
// the same tag/name elsewhere in the document — every occurrence is
// scored by how many of the OTHER attrs (type, nodename, nodegraph,
// interfacename, value, ...) match verbatim, and the highest-scoring hit
// wins (first hit wins ties). Returns the char range of just the `name`
// attribute's VALUE (between its quotes), or null if `tag`/`attrs.name`
// don't match anywhere in the document.
function findElementNameRange(text, tag, attrs) {
    const name = attrs && attrs.name;
    if (!tag || !name) return null;
    const re = new RegExp('<' + escapeRegExp(tag) + '\\b[^>]*?\\bname\\s*=\\s*"' + escapeRegExp(name) + '"', 'g');
    let best = null;
    let bestScore = -1;
    let m;
    while ((m = re.exec(text)) !== null) {
        // Candidate's FULL open tag, from the match start out to the
        // next '>' — the match itself may stop mid-attribute-list (it's
        // non-greedy up to the `name` attribute), so this widens the
        // scored text to include attributes that come AFTER `name` too.
        const gt = text.indexOf('>', m.index);
        const tagText = gt === -1 ? m[0] : text.slice(m.index, gt + 1);
        const score = scoreAttrs(tagText, attrs);
        if (score > bestScore) {
            bestScore = score;
            // The match ends exactly at the `name` value's closing
            // quote (non-greedy up to the literal `name="NAME"`), so the
            // OPENING quote is the first '"' at or after where `name`
            // itself starts in m[0] — found with indexOf (never
            // lastIndexOf), so a `name`-like substring earlier in the
            // tag's other attribute values can't shift the result.
            const nameIdx = m[0].search(/\bname\s*=\s*"/);
            if (nameIdx !== -1) {
                const quoteAt = m.index + m[0].indexOf('"', nameIdx);
                best = { start: quoteAt + 1, end: quoteAt + 1 + name.length };
            }
        }
        if (re.lastIndex === m.index) re.lastIndex++; // guard against a zero-length match
    }
    return best;
}

// ---------------------------------------------------------------------
// MaterialX auto-names an unnamed element on read (bare <multiply>
// becomes "multiply1"), so it is flagged here at its own tag, reusing
// mtlxSymbols.scanElements. Severity 'warning': valid MaterialX, not an error.
function findUnnamedElementDiagnostics(text) {
    const { root } = mtlxSymbols.scanElements(text);
    const diags = [];
    mtlxSymbols.walkAll(root, (el) => {
        if (el.tag === 'materialx' || el.tag === 'xi:include') return;
        if (el.attrs && el.attrs.name) return;
        const s = el.range.start;
        diags.push({
            message: '<' + el.tag + '> has no name attribute',
            startLine: s.line,
            startChar: s.character,
            endLine: s.line,
            endChar: s.character + el.tag.length + 1,
            severity: 'warning',
        });
    });
    return diags;
}

// Finds the Nth unnamed occurrence of `tag` (1-based). MaterialX numbers
// unnamed siblings per parent scope (verified via Node probe): a nested
// scope can reuse "multiply1"; ties pick the first match found (a known limitation).
function findAutoNamedElementRange(text, tag, index) {
    const { root } = mtlxSymbols.scanElements(text);
    const counters = new Map(); // parent element -> count of unnamed `tag` children seen
    let found = null;
    mtlxSymbols.walkAll(root, (el) => {
        if (found || el.tag !== tag) return;
        if (el.attrs && el.attrs.name) return;
        const count = (counters.get(el.parent) || 0) + 1;
        counters.set(el.parent, count);
        if (count === index) found = el;
    });
    if (!found) return null;
    const s = found.range.start;
    return { start: s, end: { line: s.line, character: s.character + tag.length + 1 } };
}

// Rewrites a validate() message that named an auto-generated element
// (e.g. `<multiply name="multiply1">`) so it never claims a name the
// user never wrote: drops the `name="..."` and marks the tag "(unnamed)".
function rewriteAutoNamedMessage(text, tag, elementName) {
    let rewritten = text.replace(' name="' + elementName + '"', '');
    const tagOpenIdx = rewritten.indexOf('<' + tag);
    if (tagOpenIdx === -1) return rewritten;
    const gt = rewritten.indexOf('>', tagOpenIdx);
    if (gt === -1) return rewritten;
    return rewritten.slice(0, gt + 1) + ' (unnamed)' + rewritten.slice(gt + 1);
}

// Bare type/category tokens quoted inside validate() messages, never an
// ELEMENT name. Excluded from findCandidateRange, which previously
// matched the first unrelated type="float" attribute in the document.
const GENERIC_TYPE_TOKENS = new Set([
    'float', 'integer', 'boolean', 'string', 'filename',
    'color3', 'color4', 'vector2', 'vector3', 'vector4',
    'matrix33', 'matrix44',
    'surfaceshader', 'displacementshader', 'volumeshader', 'lightshader',
    'material', 'BSDF', 'EDF', 'VDF', 'none', 'multioutput',
    'floatarray', 'integerarray', 'stringarray',
]);

function mapSemanticMessageToRange(text, lineStarts, item) {
    // Primary: the message line carried a serialized element — scan the
    // document for the best-matching `<tag ... name="...">` (scored
    // against the element's OTHER attributes) rather than trusting the
    // first bare name value found anywhere.
    if (item.tag && item.attrs && item.attrs.name) {
        const range = findElementNameRange(text, item.tag, item.attrs);
        if (range) {
            const s = offsetToPos(lineStarts, range.start);
            const e = offsetToPos(lineStarts, range.end);
            return { message: item.text, startLine: s.line, startChar: s.character, endLine: e.line, endChar: e.character, severity: 'error' };
        }
    }

    // Secondary: the name looks auto-generated (e.g. "multiply1") and
    // wasn't literally in the text, so locate the Nth unnamed occurrence
    // of that tag and rewrite the message to not claim a fake name.
    if (item.tag && item.elementName) {
        const autoMatch = new RegExp('^' + escapeRegExp(item.tag) + '(\\d+)$').exec(item.elementName);
        if (autoMatch) {
            const range = findAutoNamedElementRange(text, item.tag, parseInt(autoMatch[1], 10));
            if (range) {
                const message = rewriteAutoNamedMessage(item.text, item.tag, item.elementName);
                return { message, startLine: range.start.line, startChar: range.start.character, endLine: range.end.line, endChar: range.end.character, severity: 'error' };
            }
        }
    }

    // Fallback: search for any quoted substring from the message text as
    // a bare attribute VALUE anywhere in the document. Generic type
    // tokens (e.g. "float") are excluded so they fall through below.
    const candidates = [];
    if (item.elementName && !GENERIC_TYPE_TOKENS.has(item.elementName)) candidates.push(item.elementName);
    const quoted = item.text.match(/"([^"]+)"/g) || [];
    for (const q of quoted) {
        const val = q.slice(1, -1);
        if (!GENERIC_TYPE_TOKENS.has(val)) candidates.push(val);
    }
    if (item.text.indexOf('/') !== -1) {
        const parts = item.text.split('/');
        const last = parts[parts.length - 1];
        if (!GENERIC_TYPE_TOKENS.has(last)) candidates.push(last);
    }

    for (const candidate of candidates) {
        const range = findCandidateRange(text, candidate);
        if (range) {
            const s = offsetToPos(lineStarts, range.start);
            const e = offsetToPos(lineStarts, range.end);
            return { message: item.text, startLine: s.line, startChar: s.character, endLine: e.line, endChar: e.character, severity: 'error' };
        }
    }

    // No candidate matched anything — fall back to the first
    // <materialx tag's line, or {0,0}-{0,10} if the document doesn't
    // even have one.
    const idx = text.indexOf('<materialx');
    if (idx !== -1) {
        const s = offsetToPos(lineStarts, idx);
        return { message: item.text, startLine: s.line, startChar: 0, endLine: s.line, endChar: 10, severity: 'error' };
    }
    return { message: item.text, startLine: 0, startChar: 0, endLine: 0, endChar: 10, severity: 'error' };
}

// ---------------------------------------------------------------------
// Orchestration.

let repoRoot = null;

// Called once by extension.js at activation.
function init(root) {
    repoRoot = root;
}

// Tier 2 skip thresholds, after a clean tier 1: an xi:include anywhere
// (mtlxNode.js strips these, so it would only ever report a false "file
// not found"), or a document too big for a debounce-timer wasm parse.
const TIER2_MAX_CHARS = 8 * 1024 * 1024;

async function validateDocument(text) {
    const tier1 = scanXml(text);
    if (tier1.length) return tier1; // tier 2 only runs when tier 1 is clean
    if (!repoRoot) return tier1; // not initialized yet — stay silent
    if (text.length > TIER2_MAX_CHARS) return tier1;

    // Unnamed-element pre-pass: pure regex/tree-walk, no wasm involved, so
    // it runs even when tier 2 below is skipped or unavailable.
    const unnamed = findUnnamedElementDiagnostics(text);
    if (text.indexOf('<xi:include') !== -1) return unnamed;

    let tier2;
    try {
        tier2 = await mtlxNode.validateSemantic(repoRoot, text);
    } catch (e) {
        return unnamed; // tier-2 unavailability is ALWAYS silent
    }
    if (!tier2 || !tier2.available || !tier2.messages || !tier2.messages.length) return unnamed;

    const lineStarts = computeLineStarts(text);
    const mapped = tier2.messages.map((m) => mapSemanticMessageToRange(text, lineStarts, m));
    return unnamed.concat(mapped);
}

// One-shot forward of mtlxNode's init-failure string, for extension.js
// to log to the output channel exactly once. Returns null if there's
// nothing new (never failed yet, or already consumed).
function consumeTier2Warning() {
    return mtlxNode.consumeInitError();
}

module.exports = {
    scanXml,
    init,
    validateDocument,
    consumeTier2Warning,
    TIER2_MAX_CHARS,
    findUnnamedElementDiagnostics,
    mapSemanticMessageToRange,
    computeLineStarts,
};
