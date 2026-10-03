// js/graph/slx-syntax.jsx: ShadingLanguageX lexical knowledge (keywords,
// types, preprocessor directives) and a pattern-based tokenizer, used by
// the code view's syntax highlighting (js/graph/code-view.jsx) and meant
// to be reused by autocomplete. Lexical rules follow mxslc++'s scanner
// (source/scan.cpp) and the SLX Language Specification. Self-exports via
// Object.assign(window, {}); no top-level import/export.

        // mxslc++ include/TokenType.h `Keywords`. `null` is among them there,
        // but it's highlighted as a literal like `true`/`false`, which
        // TokenType.h scans as Bool literals rather than keywords.
        const SLX_KEYWORDS = new Set([
            'if', 'else', 'for', 'from', 'to', 'return', 'ref', 'out', 'const',
            'mutable', 'consteval', 'global', 'geomprop', 'nodegraph', 'nodedef',
            'inline', 'default', 'comptime', 'using', 'class', 'this', 'uniform',
            'varying', 'namespace', 'print', 'typeof', 'break',
        ]);
        const SLX_CONSTANTS = new Set(['true', 'false', 'null']);

        // The MaterialX data types (the stdlib/pbrlib <typedef>s, minus the
        // *array types SLX doesn't support, `none` and `geomname`), the
        // aliases mxslc++ declares in libraries/stdlib.mxsl, and SLX's own
        // `auto`, `void` and template placeholder `T`.
        const SLX_TYPES = new Set([
            'boolean', 'integer', 'float', 'color3', 'color4', 'vector2', 'vector3',
            'vector4', 'matrix33', 'matrix44', 'string', 'filename',
            'surfaceshader', 'displacementshader', 'volumeshader', 'lightshader',
            'material', 'BSDF', 'EDF', 'VDF',
            'bool', 'int', 'vec2', 'vec3', 'vec4', 'mat3', 'mat4',
            'auto', 'void', 'T',
        ]);

        // mxslc++ include/preprocess/preprocess.h `DIRECTIVES`.
        const SLX_DIRECTIVES = new Set([
            'include', 'library', 'version', 'define', 'undef',
            'if', 'ifdef', 'ifndef', 'elif', 'elifdef', 'elifndef', 'else', 'endif',
        ]);

        // Sticky patterns, each tried at a known start position.
        // The scanner skips whitespace between `#`/`@`/`@@` and the name.
        const SLX_DIRECTIVE_RE = /#[ \t]*([A-Za-z_]\w*)/y;
        const SLX_ATTRIBUTE_RE = /@@?[ \t]*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/y; // @doc, @in.doc, @@colorspace
        // The spec's float forms (0.5, 2., .9, 2.5e6, .9e-3), ints, and the
        // scanner's optional f suffix.
        const SLX_NUMBER_RE = /(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[fF]?/y;
        const SLX_WORD_RE = /[A-Za-z_]\w*/y;
        // What makes an identifier a call: `(`, optionally after template
        // arguments as in `texcoord<vec2>(`.
        const SLX_CALL_RE = /\s*(?:<[ \t]*[A-Za-z_]\w*(?:[ \t]*,[ \t]*[A-Za-z_]\w*)*[ \t]*>\s*)?\(/y;

        const slxIsDigit = (c) => c >= '0' && c <= '9';
        const slxIsWordStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';

        // Tokenize SLX source into [{ type, start, end }] (end exclusive),
        // in order, whitespace omitted. Types:
        //   comment, string, number, constant (true/false/null), keyword,
        //   type, directive (`#include`), attribute (`@doc`, `@@colorspace`),
        //   function (a call; `stdlib: true` when it names a standard
        //   library node), identifier, punctuation (one character each).
        // `stdlibFunctions` is a Set of standard library node names, or null.
        // Unterminated comments and strings run to the end of the text, the
        // way editors show them while they're being typed.
        const tokenizeSlx = (text, stdlibFunctions) => {
            const tokens = [];
            const n = text.length;
            // Last token other than a comment: tells a call from a definition.
            let prev = null;
            const push = (type, start, end) => {
                const token = { type, start, end };
                tokens.push(token);
                if (type !== 'comment') prev = token;
                return token;
            };
            const matchAt = (re, at) => {
                re.lastIndex = at;
                return re.exec(text);
            };

            let i = 0;
            while (i < n) {
                const c = text[i];
                if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
                    i++;
                    continue;
                }
                if (c === '/' && text[i + 1] === '/') {
                    let end = text.indexOf('\n', i);
                    if (end === -1) end = n;
                    push('comment', i, end);
                    i = end;
                    continue;
                }
                if (c === '/' && text[i + 1] === '*') {
                    const close = text.indexOf('*/', i + 2);
                    const end = close === -1 ? n : close + 2;
                    push('comment', i, end);
                    i = end;
                    continue;
                }
                // No escapes, and may span lines: the scanner's "[^"]*".
                if (c === '"') {
                    const close = text.indexOf('"', i + 1);
                    const end = close === -1 ? n : close + 1;
                    push('string', i, end);
                    i = end;
                    continue;
                }
                if (c === '#') {
                    const m = matchAt(SLX_DIRECTIVE_RE, i);
                    if (m && SLX_DIRECTIVES.has(m[1])) {
                        push('directive', i, i + m[0].length);
                        i += m[0].length;
                        continue;
                    }
                }
                if (c === '@') {
                    const m = matchAt(SLX_ATTRIBUTE_RE, i);
                    if (m) {
                        push('attribute', i, i + m[0].length);
                        i += m[0].length;
                        continue;
                    }
                }
                if (slxIsDigit(c) || (c === '.' && slxIsDigit(text[i + 1] || ''))) {
                    const m = matchAt(SLX_NUMBER_RE, i);
                    push('number', i, i + m[0].length);
                    i += m[0].length;
                    continue;
                }
                if (slxIsWordStart(c)) {
                    const word = matchAt(SLX_WORD_RE, i)[0];
                    const end = i + word.length;
                    if (SLX_CONSTANTS.has(word)) push('constant', i, end);
                    else if (SLX_KEYWORDS.has(word)) push('keyword', i, end);
                    else if (SLX_TYPES.has(word)) push('type', i, end);
                    else {
                        // A name followed by `(` is a call, unless a type
                        // or another name precedes it (`float foo(`,
                        // `T min<...>(`): then it's being defined.
                        const defining = prev && (prev.type === 'type' || prev.type === 'identifier');
                        if (!defining && matchAt(SLX_CALL_RE, end)) {
                            // A method (`p.mix(`) is never a library node.
                            const method = prev && prev.type === 'punctuation' && text[prev.start] === '.';
                            push('function', i, end).stdlib = !method && !!stdlibFunctions && stdlibFunctions.has(word);
                        } else {
                            push('identifier', i, end);
                        }
                    }
                    i = end;
                    continue;
                }
                push('punctuation', i, i + 1);
                i++;
            }
            return tokens;
        };

Object.assign(window, { SLX_KEYWORDS, SLX_CONSTANTS, SLX_TYPES, SLX_DIRECTIVES, tokenizeSlx });
