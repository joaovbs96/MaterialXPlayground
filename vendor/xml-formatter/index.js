"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const xml_parser_xo_1 = __importDefault(require("xml-parser-xo"));
function newLine(state) {
    if (!state.options.indentation && !state.options.lineSeparator)
        return;
    state.content += state.options.lineSeparator;
    let i;
    for (i = 0; i < state.level; i++) {
        state.content += state.options.indentation;
    }
}
function indent(state) {
    state.content = state.content.replace(/ +$/, '');
    let i;
    for (i = 0; i < state.level; i++) {
        state.content += state.options.indentation;
    }
}
function appendContent(state, content) {
    state.content += content;
}
function processNode(node, state, preserveSpace) {
    if (node.type === 'Element') {
        processElementNode(node, state, preserveSpace);
    }
    else if (node.type === 'ProcessingInstruction') {
        processProcessingIntruction(node, state);
    }
    else if (typeof node.content === 'string') {
        processContent(node.content, state, preserveSpace);
    }
    else {
        throw new Error('Unknown node type: ' + node.type);
    }
}
function processContent(content, state, preserveSpace) {
    if (!preserveSpace) {
        const trimmedContent = content.trim();
        if (state.options.lineSeparator) {
            content = trimmedContent;
        }
        else if (trimmedContent.length === 0) {
            content = trimmedContent;
        }
    }
    if (content.length > 0) {
        if (!preserveSpace && state.content.length > 0) {
            newLine(state);
        }
        appendContent(state, content);
    }
}
function isPathMatchingIgnoredPaths(path, ignoredPaths) {
    const fullPath = '/' + path.join('/');
    const pathLastPart = path[path.length - 1];
    return ignoredPaths.includes(pathLastPart) || ignoredPaths.includes(fullPath);
}
function processElementNode(node, state, preserveSpace) {
    state.path.push(node.name);
    if (!preserveSpace && state.content.length > 0) {
        newLine(state);
    }
    appendContent(state, '<' + node.name);
    processAttributes(state, node.attributes);
    if (node.children === null || (state.options.forceSelfClosingEmptyTag && node.children.length === 0)) {
        const selfClosingNodeClosingTag = state.options.whiteSpaceAtEndOfSelfclosingTag ? ' />' : '/>';
        // self-closing node
        appendContent(state, selfClosingNodeClosingTag);
    }
    else if (node.children.length === 0) {
        // empty node
        appendContent(state, '></' + node.name + '>');
    }
    else {
        const nodeChildren = node.children;
        appendContent(state, '>');
        state.level++;
        let nodePreserveSpace = node.attributes['xml:space'] === 'preserve' || preserveSpace;
        let ignoredPath = false;
        if (!nodePreserveSpace && state.options.ignoredPaths) {
            ignoredPath = isPathMatchingIgnoredPaths(state.path, state.options.ignoredPaths);
            nodePreserveSpace = ignoredPath;
        }
        if (!nodePreserveSpace && state.options.collapseContent) {
            let containsTextNodes = false;
            let containsTextNodesWithLineBreaks = false;
            let containsNonTextNodes = false;
            nodeChildren.forEach(function (child, index) {
                if (child.type === 'Text') {
                    if (child.content.includes('\n')) {
                        containsTextNodesWithLineBreaks = true;
                        child.content = child.content.trim();
                    }
                    else if ((index === 0 || index === nodeChildren.length - 1) && !preserveSpace) {
                        if (child.content.trim().length === 0) {
                            // If the text node is at the start or end and is empty, it should be ignored when formatting
                            child.content = '';
                        }
                    }
                    // If there is some content or whitespaces have been removed and there is no other siblings
                    if (child.content.trim().length > 0 || nodeChildren.length === 1) {
                        containsTextNodes = true;
                    }
                }
                else if (child.type === 'CDATA') {
                    containsTextNodes = true;
                }
                else {
                    containsNonTextNodes = true;
                }
            });
            if (containsTextNodes && (!containsNonTextNodes || !containsTextNodesWithLineBreaks)) {
                nodePreserveSpace = true;
            }
        }
        nodeChildren.forEach(function (child) {
            processNode(child, state, preserveSpace || nodePreserveSpace);
        });
        state.level--;
        if (!preserveSpace && !nodePreserveSpace) {
            newLine(state);
        }
        if (ignoredPath) {
            indent(state);
        }
        appendContent(state, '</' + node.name + '>');
    }
    state.path.pop();
}
function processAttributes(state, attributes) {
    Object.keys(attributes).forEach(function (attr) {
        if (state.options.attributeQuotes === 'single') {
            const escaped = attributes[attr].replace(/'/g, '&apos;');
            appendContent(state, ' ' + attr + '=\'' + escaped + '\'');
        }
        else {
            const escaped = attributes[attr].replace(/"/g, '&quot;');
            appendContent(state, ' ' + attr + '="' + escaped + '"');
        }
    });
}
function processProcessingIntruction(node, state) {
    if (state.content.length > 0) {
        newLine(state);
    }
    appendContent(state, '<?' + node.name);
    appendContent(state, ' ' + node.content.trim());
    appendContent(state, '?>');
}
/**
 * Converts the given XML into human readable format.
 */
function formatXml(xml, options = {}) {
    options.indentation = 'indentation' in options ? options.indentation : '    ';
    options.collapseContent = options.collapseContent === true;
    options.lineSeparator = 'lineSeparator' in options ? options.lineSeparator : '\r\n';
    options.whiteSpaceAtEndOfSelfclosingTag = options.whiteSpaceAtEndOfSelfclosingTag === true;
    options.throwOnFailure = options.throwOnFailure !== false;
    options.attributeQuotes = 'attributeQuotes' in options ? options.attributeQuotes : 'double';
    try {
        const parsedXml = (0, xml_parser_xo_1.default)(xml, { filter: options.filter, strictMode: options.strictMode });
        const state = { content: '', level: 0, options: options, path: [] };
        if (parsedXml.declaration) {
            processProcessingIntruction(parsedXml.declaration, state);
        }
        parsedXml.children.forEach(function (child) {
            processNode(child, state, false);
        });
        if (!options.lineSeparator) {
            return state.content;
        }
        return state.content
            .replace(/\r\n/g, '\n')
            .replace(/\n/g, options.lineSeparator);
    }
    catch (err) {
        if (options.throwOnFailure) {
            throw err;
        }
        return xml;
    }
}
formatXml.minify = (xml, options = {}) => {
    return formatXml(xml, Object.assign(Object.assign({}, options), { indentation: '', lineSeparator: '' }));
};
if (typeof module !== 'undefined' && typeof exports === 'object') {
    module.exports = formatXml;
}
exports.default = formatXml;
//# sourceMappingURL=index.js.map