// hoverProvider.js — registers a vscode.languages.HoverProvider for the
// 'mtlx' language: hovering a node CATEGORY (an element tag name that
// isn't one of MaterialX's structural/document elements, or the value of
// a node="X" attribute) shows its spec description (via specDocs.js) plus
// a command link that opens/reuses the docs panel at that node
// (materialxPlayground.openDocs, extended in extension.js to accept a
// category argument). Structural elements and anything else that isn't a
// recognizable category hover to nothing — never noisy.
//
// This file DOES require('vscode') (unlike specDocs.js/validator.js/
// mtlxNode.js/docScanner.js) — it's UI-only glue, not part of the
// pure-Node validation/doc-extraction core those files intentionally stay
// independent of.
'use strict';

const vscode = require('vscode');
const specDocs = require('./specDocs');

// Structural/document elements — i.e. every non-node MaterialX element
// that can appear as a tag name in a .mtlx file. Nodes are just elements
// named by category (<standard_surface>, <mix>, <image>, ...), so
// anything NOT in this set that looks like an element name is treated as
// a node category. Built from the plan's explicit minimum list, cross-
// checked against the MaterialX.*.md spec files committed at the repo
// root (none of these names appear as a `### \`name\`` node heading in
// any of the three) and against docScanner.js (which already treats
// <nodegraph>/<input>/<xi:include> as structural for its own include/
// texture-ref walk). 'comment' is MaterialX's XML <comment> element (an
// explicit doc/comment node in the schema, distinct from `<!-- -->`).
const STRUCTURAL_ELEMENTS = new Set([
    'materialx', 'nodegraph', 'input', 'output', 'token', 'nodedef',
    'implementation', 'typedef', 'member', 'unit', 'unittype', 'look',
    'lookgroup', 'materialassign', 'visibility', 'collection', 'geominfo',
    'geomprop', 'geompropdef', 'property', 'propertyset', 'propertyassign',
    'variant', 'variantset', 'variantassign', 'backdrop', 'comment',
    'xi:include',
]);

// Attribute-value detection: `node="X"` / `node='X'` (nodedef refs,
// materialassign refs) — group 1 captures the WHOLE quoted token
// (quotes included) so its position within the match can be located
// unambiguously regardless of which quote character was used.
const ATTR_NODE_RE = /\bnode\s*=\s*("[^"]*"|'[^']*')/g;

// Word characters for a tag-name/attribute-value token: matches the
// `\w[\w:.-]*` shape used throughout the MaterialX schema (namespaced
// names like xi:include, dotted/hyphenated categories). Also used
// (fully anchored, see CATEGORY_SHAPE_RE below) to validate a node="..."
// attribute's raw value before ever treating it as a category — unlike a
// tag name (already constrained to this shape by getWordRangeAtPosition
// itself), an attribute value is arbitrary quoted text straight out of
// the open document, which may be an untrusted/hand-crafted .mtlx file.
const TOKEN_RE = /[\w:.\-]+/;
const CATEGORY_SHAPE_RE = /^[\w:.\-]+$/;

function buildHoverMarkdown(category, repoRootFsPath) {
    const doc = specDocs.getNodeDoc(repoRootFsPath, category);

    const md = new vscode.MarkdownString();
    // Scoped trust, not `isTrusted = true`: a plain boolean would let ANY
    // command: link execute, including one smuggled in through
    // `doc.description` or (before the CATEGORY_SHAPE_RE guard below) a
    // crafted node="..." attribute value — this hover only ever needs
    // ONE command clickable, so only that one is enabled. `category`
    // itself is validated by the caller to match CATEGORY_SHAPE_RE before
    // this function is ever reached, so it's already injection-safe for
    // the plain string concatenation below, but the restricted trust is
    // kept anyway as defense in depth against anything the assumption
    // above misses (e.g. a future caller).
    md.isTrusted = { enabledCommands: ['materialxPlayground.openDocs'] };
    md.appendMarkdown('**`<' + category + '>`** — MaterialX node\n\n');

    if (doc && doc.description) {
        md.appendMarkdown(doc.description + '\n\n');
    }

    // Command link args must be a JSON array (executeCommand-style),
    // URI-encoded into the command: URI per VS Code's command-link
    // convention (see e.g. workbench.action.openWalkthrough docs for the
    // same encoding).
    const commandArgs = encodeURIComponent(JSON.stringify([category]));
    md.appendMarkdown('[Open documentation](command:materialxPlayground.openDocs?' + commandArgs + ')');

    if (doc && doc.specUrl) {
        md.appendMarkdown(' &nbsp;|&nbsp; [Spec](' + doc.specUrl + ')');
    }

    return md;
}

// Returns the word range at `position` ONLY if it's a tag-name token
// directly preceded by '<' (mirrors `<(\w[\w:.-]*)` — the '<' is checked
// as the literal character immediately before the matched token rather
// than folded into the word-range regex, since '<' isn't itself a token
// character and getWordRangeAtPosition needs a single contiguous
// character class).
function tagNameRangeAt(document, position) {
    const range = document.getWordRangeAtPosition(position, TOKEN_RE);
    if (!range || range.start.character === 0) return null;
    const before = new vscode.Range(range.start.translate(0, -1), range.start);
    if (document.getText(before) !== '<') return null;
    return range;
}

// Returns the category string when `position` is inside the quoted value
// of a node="..." attribute on the same line AND that value looks like a
// plausible category identifier, else null.
function nodeAttrValueAt(document, position) {
    const line = document.lineAt(position.line).text;
    const char = position.character;
    ATTR_NODE_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_NODE_RE.exec(line)) !== null) {
        const quoted = m[1]; // e.g. '"standard_surface"', quotes included
        const value = quoted.slice(1, -1);
        // `quoted` is the trailing part of m[0] (the whole `node = "..."`
        // match), so locating it within m[0] gives the quote's own
        // position without assuming a fixed amount of whitespace around
        // '='.
        const quotedStart = m.index + m[0].lastIndexOf(quoted);
        const valueStart = quotedStart + 1;
        const valueEnd = valueStart + value.length;
        if (char >= valueStart && char <= valueEnd) {
            // The cursor is inside THIS attribute's value — whether or
            // not it validates, no other match on the line could also
            // contain this same position, so resolve (or reject) right
            // here rather than continuing the loop. A value that doesn't
            // look like a bare identifier (spaces, markup, quotes, ...)
            // is both not a real MaterialX category AND not safe to
            // splice into the trusted hover markdown built downstream —
            // reject it rather than passing it through.
            return CATEGORY_SHAPE_RE.test(value) ? value : null;
        }
    }
    return null;
}

function provideHover(document, position, repoRootFsPath) {
    const tagRange = tagNameRangeAt(document, position);
    if (tagRange) {
        const name = document.getText(tagRange);
        if (STRUCTURAL_ELEMENTS.has(name.toLowerCase())) return null;
        return new vscode.Hover(buildHoverMarkdown(name, repoRootFsPath), tagRange);
    }

    const attrValue = nodeAttrValueAt(document, position);
    if (attrValue) {
        return new vscode.Hover(buildHoverMarkdown(attrValue, repoRootFsPath));
    }

    return null;
}

// Registers the hover provider for 'mtlx' documents and pushes its
// disposable onto context.subscriptions. repoRootFsPath (context.
// extensionUri.fsPath) is captured once here and threaded through to
// specDocs.getNodeDoc on every hover — specDocs.js caches its own parse
// after the first call, so this is cheap.
function register(context) {
    const repoRootFsPath = context.extensionUri.fsPath;
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('mtlx', {
            provideHover(document, position) {
                return provideHover(document, position, repoRootFsPath);
            },
        })
    );
}

module.exports = { register };
