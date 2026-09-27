// mtlxSymbols.js  -  tolerant .mtlx element-tree scanner, shared by the
// DocumentSymbolProvider, DefinitionProvider, ReferenceProvider and
// mtlxColors.js. Pure Node: must NOT require('vscode') anywhere, same
// rule as validator.js/mtlxNode.js  -  a thin vscode wrapper
// (symbolProviders.js) does the vscode.* conversion at the boundary.
//
// Reuses validator.js's scanXml approach (a line-start offset table plus
// a forward-moving tag/attribute tokenizer) but builds an ELEMENT TREE
// instead of diagnostics: every open/self-closing tag becomes a node
// with its own attribute map (name -> { value, range }) and children,
// tolerant of unclosed tags (closed implicitly at the parent's own close
// or at EOF) exactly like scanXml's own stack-popping recovery.
'use strict';

function computeLineStarts(text) {
    const starts = [0];
    const re = /\r\n|\r|\n/g;
    let m;
    while ((m = re.exec(text)) !== null) starts.push(m.index + m[0].length);
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

function rangeFor(lineStarts, start, end) {
    return { start: offsetToPos(lineStarts, start), end: offsetToPos(lineStarts, Math.max(end, start)) };
}

const isWs = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
const isTagNameChar = (ch) => ch !== undefined && !/[\s/><]/.test(ch);
const isAttrNameChar = (ch) => ch !== undefined && !/[\s=/>"'<]/.test(ch);

// ---------------------------------------------------------------------
// scanElements(text) -> { root, lineStarts }
//
// root is a pseudo-element (tag: null) whose children are the document's
// top-level elements (normally just <materialx>, but a bare fragment
// with no wrapper is tolerated too  -  callers fall back to root.children
// directly). Every element node has the shape:
//   { tag, attrs: { [name]: { value, range } }, range: {start,end},
//     children: [...], parent }
function scanElements(text) {
    const lineStarts = computeLineStarts(text);
    const len = text.length;
    const root = { tag: null, attrs: {}, range: rangeFor(lineStarts, 0, len), children: [], parent: null };
    const stack = [root];
    let cursor = 0;

    const readWhile = (start, pred) => { let i = start; while (i < len && pred(text[i])) i++; return i; };
    const skipWs = (start) => readWhile(start, isWs);

    while (cursor < len) {
        const lt = text.indexOf('<', cursor);
        if (lt === -1) break;

        if (text.startsWith('<!--', lt)) {
            const close = text.indexOf('-->', lt + 4);
            cursor = close === -1 ? len : close + 3;
            continue;
        }
        if (text.startsWith('<![CDATA[', lt)) {
            const close = text.indexOf(']]>', lt + 9);
            cursor = close === -1 ? len : close + 3;
            continue;
        }
        if (text.startsWith('<?', lt)) {
            const close = text.indexOf('?>', lt + 2);
            cursor = close === -1 ? len : close + 2;
            continue;
        }
        if (text.startsWith('<!', lt)) {
            const gt = text.indexOf('>', lt + 2);
            cursor = gt === -1 ? len : gt + 1;
            continue;
        }

        if (text[lt + 1] === '/') {
            // Closing tag: </name>  -  pop the matching ancestor (searching
            // up the stack, tolerant of a stray/extra close), else just
            // pop the innermost open element so one bad close tag can't
            // wedge the scan.
            const nameStart = lt + 2;
            const nameEnd = readWhile(nameStart, isTagNameChar);
            const name = text.slice(nameStart, nameEnd);
            const gt = text.indexOf('>', nameEnd);
            cursor = gt === -1 ? len : gt + 1;
            if (!name) continue;
            if (stack.length > 1) {
                let idx = -1;
                for (let i = stack.length - 1; i >= 1; i--) {
                    if (stack[i].tag === name) { idx = i; break; }
                }
                if (idx === -1) idx = stack.length - 1;
                while (stack.length > idx) {
                    const closed = stack.pop();
                    closed.range.end = offsetToPos(lineStarts, cursor);
                }
            }
            continue;
        }

        // Open / self-closing tag: <name ...> or <name .../>
        const nameStart = lt + 1;
        const nameEnd = readWhile(nameStart, isTagNameChar);
        const name = text.slice(nameStart, nameEnd);
        if (!name) { cursor = lt + 1; continue; }

        const node = {
            tag: name,
            attrs: {},
            range: { start: offsetToPos(lineStarts, lt), end: null },
            children: [],
            parent: stack[stack.length - 1],
        };

        let i = nameEnd;
        let selfClosing = false;
        while (i < len) {
            i = skipWs(i);
            if (i >= len) break;
            const ch = text[i];
            if (ch === '/') {
                if (text[i + 1] === '>') { selfClosing = true; i += 2; }
                else { i += 1; }
                break;
            }
            if (ch === '>') { i += 1; break; }
            // An unclosed start tag ends where the next element begins:
            // stop here (without consuming '<') so its attributes are
            // never read as this tag's own. The outer loop then re-reads
            // this same '<' as the next element/comment/close tag.
            if (ch === '<') break;
            if (!isAttrNameChar(ch)) { i += 1; continue; } // tolerate stray junk

            const attrNameStart = i;
            const attrNameEnd = readWhile(i, isAttrNameChar);
            const attrName = text.slice(attrNameStart, attrNameEnd);
            i = skipWs(attrNameEnd);
            if (text[i] !== '=') { i = attrNameEnd; continue; } // valueless/malformed  -  skip token, keep scanning
            i = skipWs(i + 1);
            const quote = text[i];
            if (quote !== '"' && quote !== "'") { i = attrNameEnd; continue; }
            const valueStart = i + 1;
            let j = valueStart;
            while (j < len && text[j] !== quote && text[j] !== '<') j++;
            const closedAt = (j < len && text[j] === quote) ? j : -1;
            if (closedAt === -1) { i = valueStart; continue; } // unterminated value  -  bail on this attribute, keep scanning
            if (!(attrName in node.attrs)) {
                node.attrs[attrName] = {
                    value: text.slice(valueStart, closedAt),
                    range: rangeFor(lineStarts, valueStart, closedAt),
                };
            }
            i = closedAt + 1;
        }

        cursor = i;
        node.parent.children.push(node);
        if (selfClosing) {
            node.range.end = offsetToPos(lineStarts, cursor);
        } else {
            stack.push(node);
        }
    }

    // Anything left open at EOF (tolerance for unclosed tags) closes at
    // the end of the document.
    const eof = offsetToPos(lineStarts, len);
    while (stack.length > 1) {
        const closed = stack.pop();
        closed.range.end = eof;
    }
    root.range.end = eof;

    return { root, lineStarts };
}

// ---------------------------------------------------------------------
// Tree helpers.

// Depth-first walk of every descendant (not including `node` itself).
function walkAll(node, visit) {
    for (const child of node.children) {
        visit(child);
        walkAll(child, visit);
    }
}

// The document's <materialx> root element, or the pseudo-root itself
// when the document has no wrapper (a bare fragment)  -  its `.children`
// are then treated as the top-level scope directly, for tolerance.
function materialxRoot(root) {
    return root.children.find((c) => c.tag === 'materialx') || root;
}

// Nearest ancestor of `element` (exclusive) with the given tag, or null.
function nearestAncestor(element, tag) {
    let cur = element.parent;
    while (cur) {
        if (cur.tag === tag) return cur;
        cur = cur.parent;
    }
    return null;
}

function isPos(a, b) { return a.line === b.line ? a.character - b.character : a.line - b.line; }
function inRange(range, pos) {
    return isPos(range.start, pos) <= 0 && isPos(pos, range.end) <= 0;
}

// Returns { element, attrName, value, range } for the attribute value
// whose range contains `pos`, or null. Attribute value ranges never
// overlap each other (each lives inside its own element's own opening
// tag), so the first hit found is the only possible one.
function attributeValueAt(root, pos) {
    let hit = null;
    const scan = (node) => {
        if (hit) return;
        if (node.tag !== null) {
            for (const name in node.attrs) {
                const attr = node.attrs[name];
                if (inRange(attr.range, pos)) {
                    hit = { element: node, attrName: name, value: attr.value, range: attr.range };
                    return;
                }
            }
        }
        for (const child of node.children) {
            scan(child);
            if (hit) return;
        }
    };
    scan(root);
    return hit;
}

// Returns the element whose OWN `name` attribute value range contains
// `pos` (i.e. `pos` is on a declaration, not a reference), or null.
function nameElementAt(root, pos) {
    const hit = attributeValueAt(root, pos);
    if (hit && hit.attrName === 'name') return hit.element;
    return null;
}

// ---------------------------------------------------------------------
// Reference resolution  -  nodename/nodegraph/output/interfacename/nodedef.
// Mirrors MaterialX's own reference-attribute semantics (see the spec's
// "Connections" section): each attribute resolves within a specific
// scope, never across document boundaries, and a nodedef reference only
// ever resolves to a nodedef declared in THIS document (library nodedefs
// are not visible here at all).

const REF_ATTRS = ['nodename', 'nodegraph', 'output', 'interfacename', 'nodedef'];
const NON_NODE_TAGS = new Set(['input', 'output', 'token', 'nodedef']);

function findNamedChild(scope, value, tagFilter) {
    if (!scope) return null;
    for (const child of scope.children) {
        if (tagFilter && !tagFilter(child.tag)) continue;
        if (child.attrs.name && child.attrs.name.value === value) return child;
    }
    return null;
}

function resolveReference(root, element, attrName, value) {
    switch (attrName) {
        case 'nodename': {
            const scope = nearestAncestor(element, 'nodegraph') || materialxRoot(root);
            return findNamedChild(scope, value, (tag) => !NON_NODE_TAGS.has(tag));
        }
        case 'nodegraph': {
            return findNamedChild(materialxRoot(root), value, (tag) => tag === 'nodegraph');
        }
        case 'nodedef': {
            return findNamedChild(materialxRoot(root), value, (tag) => tag === 'nodedef');
        }
        case 'interfacename': {
            const scope = nearestAncestor(element, 'nodegraph');
            if (!scope) return null;
            const local = findNamedChild(scope, value, (tag) => tag === 'input');
            if (local) return local;
            // Not a compound nodegraph interface input: when the nodegraph
            // is functional (has its own nodedef=), interfacename resolves
            // to that nodedef's own <input> instead (spec: interfacename
            // references "the enclosing nodegraph/nodedef interface").
            if (scope.attrs.nodedef) {
                const nodedefEl = findNamedChild(materialxRoot(root), scope.attrs.nodedef.value, (tag) => tag === 'nodedef');
                if (nodedefEl) return findNamedChild(nodedefEl, value, (tag) => tag === 'input');
            }
            return null;
        }
        case 'output': {
            let scope;
            if (element.attrs.nodegraph) {
                scope = findNamedChild(materialxRoot(root), element.attrs.nodegraph.value, (tag) => tag === 'nodegraph');
            } else {
                scope = nearestAncestor(element, 'nodegraph');
            }
            return scope ? findNamedChild(scope, value, (tag) => tag === 'output') : null;
        }
        default:
            return null;
    }
}

// Every reference-carrying attribute occurrence in the document, as
// { element, attrName, value, range }.
function collectReferences(root) {
    const out = [];
    walkAll(root, (node) => {
        for (const attrName of REF_ATTRS) {
            const attr = node.attrs[attrName];
            if (attr) out.push({ element: node, attrName, value: attr.value, range: attr.range });
        }
    });
    return out;
}

// Every occurrence in the document that resolves to `target`.
function findReferencesTo(root, target) {
    return collectReferences(root).filter((r) => resolveReference(root, r.element, r.attrName, r.value) === target);
}

// Document symbols: top-level nodes, nodegraphs (nodes, interface
// inputs, outputs), nodedefs (inputs, outputs), looks, and now every
// input/output child too, so the Outline nests down to a single port.

// Caps how much of a long value literal shows up in a port's detail
// string, so a huge value list can't make one Outline row unreadable.
const DETAIL_VALUE_MAX_LEN = 40;

function shortenDetailValue(v) {
    const s = String(v).replace(/\s+/g, ' ').trim();
    return s.length > DETAIL_VALUE_MAX_LEN ? s.slice(0, DETAIL_VALUE_MAX_LEN) + '…' : s;
}

// The "how this port gets its value" half of a port's detail string:
// nodename/nodegraph, interfacename, output, or a literal value=, in
// that precedence order. Null when the port has none of these.
function connectionSuffix(el) {
    if (el.attrs.nodename) return '<- ' + el.attrs.nodename.value;
    if (el.attrs.nodegraph) {
        const out = el.attrs.output ? ':' + el.attrs.output.value : '';
        return '<- ' + el.attrs.nodegraph.value + out;
    }
    if (el.attrs.interfacename) return '<- ' + el.attrs.interfacename.value;
    if (el.attrs.output) return '<- ' + el.attrs.output.value;
    if (el.attrs.value) return '= ' + shortenDetailValue(el.attrs.value.value);
    return null;
}

// A port's Outline detail: "<type> <connection>", e.g. "color3 <- base"
// (nodename) or "= 0.8, 0.2, 0.1" (literal value).
function portDetail(el) {
    const type = el.attrs.type ? el.attrs.type.value : null;
    const conn = connectionSuffix(el);
    if (type && conn) return type + ' ' + conn;
    if (type) return type;
    if (conn) return conn;
    return el.tag;
}

function symbolNameRange(el) {
    return el.attrs.name ? el.attrs.name.range : el.range;
}

function toSymbol(el) {
    const name = (el.attrs.name && el.attrs.name.value) || el.tag;
    const type = el.attrs.type ? el.attrs.type.value : null;

    let kind = 'node';
    let children = [];
    let detail;
    if (el.tag === 'nodegraph') {
        kind = 'nodegraph';
        detail = el.tag;
        // Everything but <token> becomes a child: nodes, interface
        // <input>s, and <output>s, so "follow cursor" can land on any.
        children = el.children
            .filter((c) => c.tag && c.tag !== 'token')
            .map(toSymbol);
    } else if (el.tag === 'nodedef') {
        kind = 'nodedef';
        detail = el.tag;
        children = el.children
            .filter((c) => c.tag === 'input' || c.tag === 'output')
            .map(toSymbol);
    } else if (el.tag === 'look') {
        kind = 'look';
        detail = el.tag;
    } else if (el.tag === 'input') {
        kind = 'input';
        detail = portDetail(el);
    } else if (el.tag === 'output') {
        kind = 'output';
        detail = portDetail(el);
    } else {
        detail = type ? (el.tag + ' : ' + type) : el.tag;
        // A plain node's own <input>/<output> children (mix's fg/bg,
        // a shader's inputs, ...), previously never shown at all.
        children = el.children
            .filter((c) => c.tag === 'input' || c.tag === 'output')
            .map(toSymbol);
    }

    return { name, detail, kind, tag: el.tag, range: el.range, selectionRange: symbolNameRange(el), children };
}

function buildDocumentSymbols(root) {
    const top = materialxRoot(root).children;
    return top.filter((el) => el.tag).map(toSymbol);
}

// Rename (F2): pure logic, no vscode. Renames one declaration's `name`
// plus every reference that resolves to it, reusing findReferencesTo
// (already scoped per REF_ATTRS kind, so one path covers every case).

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isValidIdentifier(name) {
    return typeof name === 'string' && IDENTIFIER_RE.test(name);
}

// The element a rename at `pos` would act on, plus the exact range of
// the token under the cursor, or null when `pos` isn't renamable.
function renameTargetAt(root, pos) {
    const hit = attributeValueAt(root, pos);
    if (!hit) return null;
    if (hit.attrName === 'name') {
        return { target: hit.element, range: hit.range };
    }
    if (REF_ATTRS.includes(hit.attrName)) {
        const target = resolveReference(root, hit.element, hit.attrName, hit.value);
        if (!target) return null;
        return { target, range: hit.range };
    }
    return null;
}

// Same-scope collision check: does another child of target's own
// parent already use `newName`? "Scope" is just that parent's own
// children, the same notion used everywhere else in this file.
function siblingCollision(target, newName) {
    if (!target.parent) return false;
    return target.parent.children.some(
        (c) => c !== target && c.attrs && c.attrs.name && c.attrs.name.value === newName
    );
}

// Throws with a user-facing message when `pos` isn't renamable, else
// returns { range, placeholder } for VS Code's prepareRename.
function prepareRename(root, pos) {
    const found = renameTargetAt(root, pos);
    if (!found) throw new Error('This is not a MaterialX name or reference that can be renamed.');
    if (!found.target.attrs.name) throw new Error('This element has no name to rename.');
    return { range: found.range, placeholder: found.target.attrs.name.value };
}

// Throws for an invalid new name, a non-renamable position, or a
// collision; else returns the { range, newText } edits to apply.
function computeRenameEdits(root, pos, newName) {
    if (!isValidIdentifier(newName)) {
        throw new Error(
            '"' + newName + '" is not a valid MaterialX name (letters, digits and underscore only, must not start with a digit).'
        );
    }
    const found = renameTargetAt(root, pos);
    if (!found) throw new Error('This is not a MaterialX name or reference that can be renamed.');
    const target = found.target;
    if (!target.attrs.name) throw new Error('This element has no name to rename.');

    if (target.attrs.name.value !== newName && siblingCollision(target, newName)) {
        throw new Error('"' + newName + '" is already used by another element in this scope.');
    }

    const edits = [{ range: target.attrs.name.range, newText: newName }];
    for (const ref of findReferencesTo(root, target)) {
        edits.push({ range: ref.range, newText: newName });
    }
    return edits;
}

// Document links (E9): every <input type="filename" value="..."> with
// its fileprefix-resolved ref (mirrors docScanner.js's own logic) and
// value range, for symbolProviders.js to resolve into a link. Pure.

// A filename value containing '<' is a template like <UDIM>/<FRAME>,
// never a literal path, so it's never a candidate for a real link.
function isTemplatedFilenameValue(value) {
    return !value || value.indexOf('<') !== -1;
}

function collectFilenameRefs(root) {
    const mtlxRoot = materialxRoot(root);
    const rootPrefix = (mtlxRoot.attrs.fileprefix && mtlxRoot.attrs.fileprefix.value) || '';
    const out = [];

    const scan = (node, prefix) => {
        const nodePrefix = node.tag === 'nodegraph'
            ? prefix + ((node.attrs.fileprefix && node.attrs.fileprefix.value) || '')
            : prefix;
        for (const child of node.children) {
            if (
                child.tag === 'input' &&
                child.attrs.type && child.attrs.type.value === 'filename' &&
                child.attrs.value && !isTemplatedFilenameValue(child.attrs.value.value)
            ) {
                out.push({
                    element: child,
                    value: child.attrs.value.value,
                    range: child.attrs.value.range,
                    ref: nodePrefix + child.attrs.value.value,
                });
            }
            scan(child, nodePrefix);
        }
    };
    scan(mtlxRoot, rootPrefix);
    return out;
}

module.exports = {
    scanElements,
    computeLineStarts,
    offsetToPos,
    walkAll,
    materialxRoot,
    nearestAncestor,
    attributeValueAt,
    nameElementAt,
    resolveReference,
    collectReferences,
    findReferencesTo,
    buildDocumentSymbols,
    REF_ATTRS,
    IDENTIFIER_RE,
    isValidIdentifier,
    renameTargetAt,
    prepareRename,
    computeRenameEdits,
    isTemplatedFilenameValue,
    collectFilenameRefs,
};
