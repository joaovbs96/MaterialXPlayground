"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParsingError = void 0;
class ParsingError extends Error {
    constructor(message, cause) {
        super(message);
        this.cause = cause;
    }
}
exports.ParsingError = ParsingError;
let parsingState;
function nextChild() {
    return element(false) || text() || comment() || cdata() || processingInstruction();
}
function nextRootChild() {
    match(/\s*/);
    return element(true) || comment() || doctype() || processingInstruction();
}
function parseDocument() {
    const declaration = processingInstruction();
    const children = [];
    let documentRootNode;
    let child = nextRootChild();
    while (child) {
        if (child.node.type === 'Element') {
            if (documentRootNode) {
                throw new Error('Found multiple root nodes');
            }
            documentRootNode = child.node;
        }
        if (!child.excluded) {
            children.push(child.node);
        }
        child = nextRootChild();
    }
    if (!documentRootNode) {
        throw new ParsingError('Failed to parse XML', 'Root Element not found');
    }
    if (parsingState.xml.length !== 0) {
        throw new ParsingError('Failed to parse XML', 'Not Well-Formed XML');
    }
    return {
        declaration: declaration ? declaration.node : null,
        root: documentRootNode,
        children
    };
}
function processingInstruction() {
    const m = match(/^<\?([\w-:.]+)\s*/);
    if (!m)
        return;
    // tag
    const node = {
        name: m[1],
        type: 'ProcessingInstruction',
        content: ''
    };
    const endMarkerIndex = parsingState.xml.indexOf('?>');
    if (endMarkerIndex > -1) {
        node.content = parsingState.xml.substring(0, endMarkerIndex).trim();
        parsingState.xml = parsingState.xml.slice(endMarkerIndex);
    }
    else {
        throw new ParsingError('Failed to parse XML', 'ProcessingInstruction closing tag not found');
    }
    match(/\?>/);
    return {
        excluded: parsingState.options.filter(node) === false,
        node
    };
}
function element(matchRoot) {
    const m = match(/^<([^?!</>\s]+)\s*/);
    if (!m)
        return;
    // name
    const node = {
        type: 'Element',
        name: m[1],
        attributes: {},
        children: []
    };
    const excluded = matchRoot ? false : parsingState.options.filter(node) === false;
    // attributes
    while (!(eos() || is('>') || is('?>') || is('/>'))) {
        const attr = attribute();
        if (attr) {
            node.attributes[attr.name] = attr.value;
        }
        else {
            return;
        }
    }
    // self closing tag
    if (match(/^\s*\/>/)) {
        node.children = null;
        return {
            excluded,
            node
        };
    }
    match(/\??>/);
    // children
    let child = nextChild();
    while (child) {
        if (!child.excluded) {
            node.children.push(child.node);
        }
        child = nextChild();
    }
    // closing
    if (parsingState.options.strictMode) {
        const closingTag = `</${node.name}>`;
        if (parsingState.xml.startsWith(closingTag)) {
            parsingState.xml = parsingState.xml.slice(closingTag.length);
        }
        else {
            throw new ParsingError('Failed to parse XML', `Closing tag not matching "${closingTag}"`);
        }
    }
    else {
        match(/^<\/[\p{L}\p{M}\w\-:.]+\s*>/u);
    }
    return {
        excluded,
        node
    };
}
function doctype() {
    const m = match(/^<!DOCTYPE\s+\S+\s+SYSTEM[^>]*>/) ||
        match(/^<!DOCTYPE\s+\S+\s+PUBLIC[^>]*>/) ||
        match(/^<!DOCTYPE\s+\S+\s*\[[^\]]*]>/) ||
        match(/^<!DOCTYPE\s+\S+\s*>/);
    if (m) {
        const node = {
            type: 'DocumentType',
            content: m[0]
        };
        return {
            excluded: parsingState.options.filter(node) === false,
            node
        };
    }
}
function cdata() {
    if (parsingState.xml.startsWith('<![CDATA[')) {
        const endPositionStart = parsingState.xml.indexOf(']]>');
        if (endPositionStart > -1) {
            const endPositionFinish = endPositionStart + 3;
            const node = {
                type: 'CDATA',
                content: parsingState.xml.substring(0, endPositionFinish)
            };
            parsingState.xml = parsingState.xml.slice(endPositionFinish);
            return {
                excluded: parsingState.options.filter(node) === false,
                node
            };
        }
    }
}
function comment() {
    const m = match(/^<!--[\s\S]*?-->/);
    if (m) {
        const node = {
            type: 'Comment',
            content: m[0]
        };
        return {
            excluded: parsingState.options.filter(node) === false,
            node
        };
    }
}
function text() {
    const m = match(/^([^<]+)/);
    if (m) {
        const node = {
            type: 'Text',
            content: m[1]
        };
        return {
            excluded: parsingState.options.filter(node) === false,
            node
        };
    }
}
function attribute() {
    const m = match(/([^=]+)\s*=\s*("[^"]*"|'[^']*'|[^>\s]+)\s*/);
    if (m) {
        return {
            name: m[1].trim(),
            value: stripQuotes(m[2].trim())
        };
    }
}
function stripQuotes(val) {
    return val.replace(/^['"]|['"]$/g, '');
}
/**
 * Match `re` and advance the string.
 */
function match(re) {
    const m = parsingState.xml.match(re);
    if (m) {
        parsingState.xml = parsingState.xml.slice(m[0].length);
        return m;
    }
}
/**
 * End-of-source.
 */
function eos() {
    return 0 === parsingState.xml.length;
}
/**
 * Check for `prefix`.
 */
function is(prefix) {
    return 0 === parsingState.xml.indexOf(prefix);
}
/**
 * Parse the given XML string into an object.
 */
function parseXml(xml, options = {}) {
    xml = xml.trim();
    const filter = options.filter || (() => true);
    parsingState = {
        xml,
        options: Object.assign(Object.assign({}, options), { filter, strictMode: options.strictMode === true })
    };
    return parseDocument();
}
if (typeof module !== 'undefined' && typeof exports === 'object') {
    module.exports = parseXml;
}
exports.default = parseXml;
//# sourceMappingURL=index.js.map