// formatter.js: DocumentFormattingEditProvider / DocumentRangeFormatting-
// EditProvider for the 'mtlx' language, built on the vendored
// xml-formatter package (re-indent only).
//
// Attribute order/values, comments, CDATA, processing instructions and
// self-closing style all pass through unchanged (see the corpus check
// in scratchpad/fmt-spike/gate-results.md).
//
// Pure Node core (formatMtlx + helpers): no require('vscode').
// register() takes vscode as a parameter instead, so the whole file
// (including provider wiring) can be tested without a real host.
//
// xml-formatter isn't in the committed vendor registry yet (a later
// batch adds vendor/xml-formatter/ via scripts/vendor-deps.mjs, per
// the file map in gate-results.md).
//
// Until then, resolveXmlFormatter() also checks
// MTLX_XML_FORMATTER_DIR, which tests point at
// scratchpad/fmt-spike/node_modules.
'use strict';

const path = require('path');

// Resolves the xml-formatter CJS entry point: tries the committed
// vendor path, then an env-var override (test-only, points at the
// spike's scratch install). Returns null, never throws (caller decides).
function resolveXmlFormatter() {
    const candidates = [];
    candidates.push(path.join(__dirname, '..', '..', 'vendor', 'xml-formatter', 'dist', 'cjs', 'index.js'));
    const override = process.env.MTLX_XML_FORMATTER_DIR;
    if (override) candidates.push(path.join(override, 'xml-formatter'));
    for (const candidate of candidates) {
        try {
            return require(candidate);
        } catch (e) { /* try the next candidate */ }
    }
    return null;
}

let xmlFormatterCache;
function getXmlFormatter() {
    if (xmlFormatterCache === undefined) xmlFormatterCache = resolveXmlFormatter();
    return xmlFormatterCache;
}

// Majority-vote EOL detection, same approach as the spike: counts CRLF
// vs. lone-LF line endings and picks whichever is more common.
function detectEol(text) {
    const crlf = (text.match(/\r\n/g) || []).length;
    const lfOnly = (text.match(/[^\r]\n/g) || []).length + (text.startsWith('\n') ? 1 : 0);
    return crlf >= lfOnly ? '\r\n' : '\n';
}

// True if self-closing tags use `<x />` (space before the slash), not
// `<x/>`. Every file checked in the spike uses the spaced form, but
// this stays source-driven rather than assumed.
function detectSelfClosingSpace(text) {
    const withSpace = (text.match(/[^\s]\s\/>/g) || []).length;
    const noSpace = (text.match(/[^\s]\/>/g) || []).length;
    return withSpace >= noSpace;
}

function indentationFor(options) {
    const tabSize = (options && options.tabSize) || 2;
    const insertSpaces = !options || options.insertSpaces !== false;
    return insertSpaces ? ' '.repeat(tabSize) : '\t';
}

// Runs xml-formatter with the re-indent-only options the spike
// validated. `contextText` supplies EOL/self-closing detection (for a
// fragment this is the whole document, matching its surroundings).
function runXmlFormatter(text, contextText, options) {
    const xmlFormatter = getXmlFormatter();
    if (!xmlFormatter) {
        throw new Error('formatter.js: xml-formatter is unavailable (no vendor/xml-formatter and no MTLX_XML_FORMATTER_DIR override)');
    }
    return xmlFormatter(text, {
        indentation: indentationFor(options),
        collapseContent: true,
        lineSeparator: detectEol(contextText),
        whiteSpaceAtEndOfSelfclosingTag: detectSelfClosingSpace(contextText),
        forceSelfClosingEmptyTag: false,
        throwOnFailure: true,
    });
}

// --- Blank-line preservation ---
//
// xml-formatter collapses every blank line between siblings to none
// (not "at most one", always zero), so re-indent-only would otherwise
// erase layout the author chose.
//
// Fix: before formatting, replace each blank-line run between two
// non-blank lines (outside comments/CDATA, where it's real content)
// with a single placeholder comment on its own line.
//
// After formatting, every placeholder-only line becomes empty again.
// It's a real XML comment while xml-formatter runs (so it gets a
// correctly indented line for free), then disappears from the output.
function pickBlankPlaceholder(text) {
    let n = 0;
    let candidate = '<!--__mtlx_blank__-->';
    while (text.includes(candidate)) {
        n++;
        candidate = `<!--__mtlx_blank_${n}__-->`;
    }
    return candidate;
}

function findExcludedSpans(text) {
    const spans = [];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g;
    let m;
    while ((m = re.exec(text)) !== null) spans.push([m.index, m.index + m[0].length]);
    return spans;
}

// One flag per line: true if that line overlaps a comment/CDATA span
// in the ORIGINAL text, meaning a blank-looking line there is real
// content (comment/CDATA), never layout whitespace to collapse.
function lineExcludedFlags(text, lines, eol) {
    const spans = findExcludedSpans(text);
    const flags = [];
    let pos = 0;
    for (const line of lines) {
        const start = pos;
        const end = pos + line.length;
        flags.push(spans.some(([s, e]) => start < e && end > s));
        pos = end + eol.length;
    }
    return flags;
}

// Replaces each blank-line run that has a real (non-excluded) line both
// before and after it with a single placeholder line. Leading/trailing
// blank runs are dropped (xml-formatter trims those anyway).
function collapseBlankRuns(lines, excluded, placeholderLine) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const isBlank = !excluded[i] && lines[i].trim() === '';
        if (!isBlank) { out.push(lines[i]); i++; continue; }
        let j = i;
        while (j < lines.length && !excluded[j] && lines[j].trim() === '') j++;
        if (out.length > 0 && j < lines.length) out.push(placeholderLine);
        i = j;
    }
    return out;
}

function preserveBlankLines(text, eol) {
    const placeholderLine = pickBlankPlaceholder(text);
    const lines = text.split(eol);
    const excluded = lineExcludedFlags(text, lines, eol);
    const collapsed = collapseBlankRuns(lines, excluded, placeholderLine);
    return { text: collapsed.join(eol), placeholderLine };
}

function restoreBlankLines(formattedText, eol, placeholderLine) {
    return formattedText
        .split(eol)
        .map((line) => (line.trim() === placeholderLine ? '' : line))
        .join(eol);
}

// Runs xml-formatter through the blank-line-preserving wrapper above.
// `contextText` is the whole document (see runXmlFormatter) and also
// supplies the EOL used to split `text` into lines.
function formatXmlPreservingBlankLines(text, contextText, options) {
    const eol = detectEol(contextText);
    const { text: preprocessed, placeholderLine } = preserveBlankLines(text, eol);
    const formatted = runXmlFormatter(preprocessed, contextText, options);
    return restoreBlankLines(formatted, eol, placeholderLine);
}

// formatMtlx(text, {tabSize, insertSpaces, eol}) -> formatted text.
// `eol` overrides EOL detection (VS Code's FormattingOptions has none,
// so callers normally omit it and let detectEol read the source).
//
// xml-formatter trims the document and drops a trailing newline
// unconditionally: re-added here when the source had one (the one
// gap the spike found outside checks a-e).
function formatMtlx(text, options) {
    options = options || {};
    const eol = options.eol || detectEol(text);
    const hadTrailingEol = text.endsWith('\n') || text.endsWith('\r');
    const formatted = formatXmlPreservingBlankLines(text, text, options);
    if (hadTrailingEol && !formatted.endsWith(eol)) return formatted + eol;
    return formatted;
}

// --- Range formatting: locate the smallest element fully containing the
// given [startOffset, endOffset) span. ---
//
// Single left-to-right scan matching either a closing tag or an
// opening/self-closing tag. Proper XML nesting means element
// completions occur innermost first.
//
// So the first completed span found that contains the target range
// is already the most deeply nested one (no need to keep scanning
// once one is found).
const SCAN_RE = /<(?:(\/)([\w:.\-]+)\s*>|([\w:.\-]+)(?:\s+[\w:.\-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(\/?)>)/g;

function findEnclosingElement(text, startOffset, endOffset) {
    const stack = [];
    SCAN_RE.lastIndex = 0;
    let m;
    while ((m = SCAN_RE.exec(text)) !== null) {
        const isClosing = m[1] === '/';
        if (isClosing) {
            if (stack.length === 0) continue; // unmatched close, tolerate
            const opened = stack.pop();
            const span = { start: opened.start, end: m.index + m[0].length };
            if (span.start <= startOffset && endOffset <= span.end) return span;
        } else {
            const selfClosing = m[4] === '/';
            if (selfClosing) {
                const span = { start: m.index, end: m.index + m[0].length };
                if (span.start <= startOffset && endOffset <= span.end) return span;
            } else {
                stack.push({ start: m.index });
            }
        }
    }
    return null;
}

function reindentFragment(formatted, baseIndent, eol) {
    return formatted
        .split(eol)
        .map((line, i) => (i === 0 ? line : baseIndent + line))
        .join(eol);
}

function formatWholeDocumentEdits(document, formatOptions, vscode) {
    const text = document.getText();
    let formatted;
    try {
        formatted = formatMtlx(text, { tabSize: formatOptions.tabSize, insertSpaces: formatOptions.insertSpaces });
    } catch (e) {
        return [];
    }
    if (formatted === text) return [];
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
    return [vscode.TextEdit.replace(fullRange, formatted)];
}

function formatRangeEdits(document, range, formatOptions, vscode) {
    const text = document.getText();
    const startOffset = document.offsetAt(range.start);
    const endOffset = document.offsetAt(range.end);

    if (startOffset === 0 && endOffset === text.length) {
        return formatWholeDocumentEdits(document, formatOptions, vscode);
    }

    const enclosing = findEnclosingElement(text, startOffset, endOffset);
    if (!enclosing) return [];

    const elementText = text.slice(enclosing.start, enclosing.end);
    const lineStart = text.lastIndexOf('\n', enclosing.start - 1) + 1;
    const baseIndent = text.slice(lineStart, enclosing.start);

    let formattedFragment;
    try {
        formattedFragment = formatXmlPreservingBlankLines(elementText, text, {
            tabSize: formatOptions.tabSize,
            insertSpaces: formatOptions.insertSpaces,
        });
    } catch (e) {
        return [];
    }

    const eol = detectEol(text);
    const reindented = reindentFragment(formattedFragment, baseIndent, eol);
    if (reindented === elementText) return [];

    const editRange = new vscode.Range(document.positionAt(enclosing.start), document.positionAt(enclosing.end));
    return [vscode.TextEdit.replace(editRange, reindented)];
}

// register(context, vscode): wires the two providers for language 'mtlx'.
// vscode is passed in (not required) so this module loads and can be
// exercised in plain Node without the real extension host.
function register(context, vscode) {
    const documentProvider = {
        provideDocumentFormattingEdits(document, formatOptions) {
            return formatWholeDocumentEdits(document, formatOptions, vscode);
        },
    };
    const rangeProvider = {
        provideDocumentRangeFormattingEdits(document, range, formatOptions) {
            return formatRangeEdits(document, range, formatOptions, vscode);
        },
    };
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider('mtlx', documentProvider),
        vscode.languages.registerDocumentRangeFormattingEditProvider('mtlx', rangeProvider),
    );
    return { documentProvider, rangeProvider };
}

module.exports = {
    formatMtlx,
    register,
    // Exposed for tests only.
    _internal: { detectEol, detectSelfClosingSpace, findEnclosingElement, resolveXmlFormatter, pickBlankPlaceholder },
};
