// js/graph/slx-language.jsx: what the code view's assists (completion,
// parameter hints, hover) know about ShadingLanguageX beyond its lexical
// rules (js/graph/slx-syntax.jsx): the function library (the standard
// library nodes from the node catalog, their descriptions from
// js/gen/nodelib.json, and SLX's own library functions), the symbols the
// code being edited declares, where the caret sits in a call, and
// completion matching. Pure functions over tokenizeSlx() tokens, apart
// from loadSlxLibrary(); the popups are in js/graph/slx-assist.jsx.
// Self-exports via Object.assign(window, {}); no top-level import/export.

        // How SLX code writes MaterialX types: mxslc++ libraries/stdlib.mxsl's
        // `using` aliases, which the decompiler writes too.
        const SLX_TYPE_ALIASES = {
            boolean: 'bool', integer: 'int', vector2: 'vec2', vector3: 'vec3', vector4: 'vec4',
            matrix33: 'mat3', matrix44: 'mat4',
        };
        const SLX_TYPE_CANONICAL = Object.fromEntries(Object.entries(SLX_TYPE_ALIASES).map(([name, alias]) => [alias, name]));
        const slxTypeName = (type) => SLX_TYPE_ALIASES[type] || type;
        const slxCanonicalType = (type) => SLX_TYPE_CANONICAL[type] || type;
        // A type as shown: aliased, including inside a multi-output node's
        // field list ('{vector3, float}' -> '{vec3, float}').
        const slxTypeDisplay = (type) => (type.charAt(0) === '{'
            ? '{' + type.slice(1, -1).split(/\s*,\s*/).map(slxTypeName).join(', ') + '}'
            : slxTypeName(type));
        // The order types are listed in inside a template's <...>.
        const SLX_TYPE_ORDER = [
            'float', 'integer', 'boolean', 'color3', 'color4', 'vector2', 'vector3', 'vector4',
            'matrix33', 'matrix44', 'string', 'filename', 'BSDF', 'EDF', 'VDF',
            'surfaceshader', 'displacementshader', 'volumeshader', 'lightshader', 'material',
        ];
        const slxTypeRank = (type) => {
            const i = SLX_TYPE_ORDER.indexOf(type);
            return i === -1 ? SLX_TYPE_ORDER.length : i;
        };

        // A function signature, as the assists show it:
        //   { name, ret, template, params: [{ name, type, defaultText, doc }] }
        // Types are MaterialX names (shown through slxTypeDisplay), or 'T'
        // for the template type when `template` lists what T can be, the
        // way libraries/stdlib.mxsl writes its own templated functions.
        // `ret` may be a multi-output node's fields, e.g. '{float, float}'
        // (how mxslc names that type). `defaultText` is SLX source text.
        const slxSignatureText = (sig) => slxTypeDisplay(sig.ret) + ' ' + sig.name
            + (sig.template ? '<' + sig.template.map(slxTypeName).join(', ') + '>' : '')
            + '(' + sig.params.map((p) => slxTypeDisplay(p.type) + ' ' + p.name).join(', ') + ')';

        // SLX's own library functions: mxslc++ libraries/stdlib.mxsl, less
        // its operator overloads. No nodedef describes them. Parsed like the
        // code in the editor.
        const SLX_LIBRARY_EXTENSIONS = [
            'inline T min<vector2, vector3, vector4, color3, color4>(float in1, T in2);',
            'inline T min<float, vector2, vector3, vector4, color3, color4>(T in1, T in2, T in3);',
            'inline T min<float, vector2, vector3, vector4, color3, color4>(T in1, T in2, T in3, T in4);',
            'inline T min<float, vector2, vector3, vector4, color3, color4>(T in1, T in2, T in3, T in4, T in5);',
            'inline T max<vector2, vector3, vector4, color3, color4>(float in1, T in2);',
            'inline T max<float, vector2, vector3, vector4, color3, color4>(T in1, T in2, T in3);',
            'inline T max<float, vector2, vector3, vector4, color3, color4>(T in1, T in2, T in3, T in4);',
            'inline T max<float, vector2, vector3, vector4, color3, color4>(T in1, T in2, T in3, T in4, T in5);',
            'inline float combine(float x);',
            'inline vector2 combine(float x, float y);',
            'inline vector3 combine(float x, float y, float z);',
            'inline vector4 combine(float x, float y, float z, float w);',
            'inline color3 combine(float r, float g, float b);',
            'inline color4 combine(float r, float g, float b, float a);',
        ].join('\n');
        const SLX_LIBRARY_EXTENSION_DOCS = {
            combine: 'Builds a float, vector or color from float channels. A ShadingLanguageX library function rather than a MaterialX node.',
        };

        // ---- Standard library nodes -----------------------------------------

        // A node's entry in js/gen/nodelib.json ({ lib: { group: { node } } }),
        // the standard library first, the way the docs resolve a bare name.
        const slxNodeDoc = (docs, name) => {
            if (!docs) return null;
            const libs = Object.keys(docs).sort((a, b) => (a === 'stdlib' ? -1 : b === 'stdlib' ? 1 : a.localeCompare(b)));
            for (const lib of libs) {
                for (const group of Object.keys(docs[lib]).sort()) {
                    const entry = docs[lib][group] && docs[lib][group][name];
                    if (entry) return entry;
                }
            }
            return null;
        };
        // The docs are Markdown: keep link text, drop emphasis markers.
        const slxPlainText = (md) => String(md || '')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\*\*|__/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const slxDocDescription = (entry) => {
            const text = entry ? slxPlainText(entry.description) : '';
            return /^No documentation available/i.test(text) ? '' : text;
        };
        // Port name -> { doc, defaultText }, from the first port table
        // listing it (a node's variants can have a table each).
        const slxPortDocs = (entry) => {
            const ports = {};
            for (const table of (entry && entry.port_tables) || []) {
                for (const [name, port] of Object.entries(table.ports || {})) {
                    if (!ports[name]) ports[name] = { doc: slxPlainText(port.description), defaultText: slxPlainText(port.default) };
                }
            }
            return ports;
        };
        // A nodedef input's value as an SLX literal.
        const slxValueText = (type, value) => {
            if (value == null || value === '') return '';
            if (/^(color[34]|vector[234]|matrix(33|44))$/.test(type)) return slxTypeName(type) + '{' + value + '}';
            if (type === 'string' || type === 'filename') return '"' + value + '"';
            return value;
        };

        // A node's signatures from its catalog entry (js/graph/catalog.jsx
        // groupSignatures: one per type signature, the default version's
        // ports, which is also what mxslc makes a function of), merged into
        // templated signatures wherever only the type varies: first over
        // the return type (`T mix<float, color3, ...>(T fg, T bg, float
        // mix)`), then, for the rest, over the first input's (`float
        // dotproduct<vector2, vector3, vector4>(T in1, T in2)`).
        const slxNodeSignatures = (name, groups, ports) => {
            const concrete = groups.map((g, order) => ({
                name, order, template: null,
                ret: g.type === 'multioutput' ? '{' + String(g.outLabel || '').split(' + ').join(', ') + '}' : g.type,
                params: g.inputs.map((i) => ({ name: i.name, type: i.type, value: i.value })),
            }));
            const merge = (sigs, pickT) => {
                const byShape = new Map();
                const rest = [];
                for (const s of sigs) {
                    const t = pickT(s);
                    if (!t) {
                        rest.push(s);
                        continue;
                    }
                    const shape = [s.ret === t ? 'T' : s.ret]
                        .concat(s.params.map((p) => p.name + ':' + (p.type === t ? 'T' : p.type)))
                        .join('|');
                    if (!byShape.has(shape)) byShape.set(shape, []);
                    byShape.get(shape).push({ s, t });
                }
                const merged = [];
                for (const members of byShape.values()) {
                    if (members.length === 1) {
                        rest.push(members[0].s);
                        continue;
                    }
                    const { s, t } = members[0];
                    merged.push({
                        name, order: s.order,
                        ret: s.ret === t ? 'T' : s.ret,
                        template: [...new Set(members.map((m) => m.t))].sort((a, b) => slxTypeRank(a) - slxTypeRank(b)),
                        // T's default differs per type: the docs give the generic one.
                        params: s.params.map((p) => (p.type === t ? { name: p.name, type: 'T', value: '' } : p)),
                    });
                }
                return { merged, rest };
            };
            const byRet = merge(concrete, (s) => (s.ret.charAt(0) === '{' ? null : s.ret));
            const byFirstInput = merge(byRet.rest, (s) => (s.params.length ? s.params[0].type : null));
            const merged = byRet.merged.concat(byFirstInput.merged);
            // A leftover that is one of the templated signatures with T
            // bound to a type (`float fractal3d(float amplitude, ...)` in
            // `T fractal3d<...>(float amplitude, ...)`) joins its list.
            const bindsT = (m, s) => {
                let t = null;
                const fits = (shapeType, type) => {
                    if (shapeType !== 'T') return shapeType === type;
                    if (t == null) t = type;
                    return t === type;
                };
                if (m.params.length !== s.params.length || !fits(m.ret, s.ret)) return null;
                for (let i = 0; i < m.params.length; i++) {
                    if (m.params[i].name !== s.params[i].name || !fits(m.params[i].type, s.params[i].type)) return null;
                }
                return t;
            };
            const rest = byFirstInput.rest.filter((s) => {
                for (const m of merged) {
                    const t = bindsT(m, s);
                    if (!t) continue;
                    if (!m.template.includes(t)) m.template = m.template.concat(t).sort((a, b) => slxTypeRank(a) - slxTypeRank(b));
                    return false;
                }
                return true;
            });
            return merged.concat(rest)
                .sort((a, b) => a.order - b.order)
                .map((sig) => ({
                    name: sig.name, ret: sig.ret, template: sig.template,
                    params: sig.params.map((p) => {
                        const port = ports[p.name] || {};
                        return {
                            name: p.name, type: p.type, doc: port.doc || '',
                            defaultText: slxValueText(p.type, p.value) || port.defaultText || '',
                        };
                    }),
                }));
        };

        // ---- Parsing the code being edited -------------------------------------

        const slxPunct = (text, token, ch) => !!token && token.type === 'punctuation' && text[token.start] === ch;

        // The functions `text` defines or declares, as signatures: an
        // optional list of keywords, a return type (a type, or a user type's
        // name), the name, optional `<...>` template types and a parameter
        // list, each parameter `[@attributes] [modifiers] type name [= default]`.
        // Each also has `start`, its name's offset.
        const slxParseFunctions = (text, tokens) => {
            const toks = tokens.filter((t) => t.type !== 'comment');
            const word = (t) => text.slice(t.start, t.end);
            const parseParam = (seg) => {
                let eq = -1;
                for (let n = 0; n < seg.length; n++) {
                    // `=`, not part of `==`, `<=`, `>=` or `!=`.
                    if (slxPunct(text, seg[n], '=') && !slxPunct(text, seg[n + 1], '=')
                        && !(n > 0 && /[=<>!]/.test(text[seg[n].start - 1]))) {
                        eq = n;
                        break;
                    }
                }
                const head = eq === -1 ? seg : seg.slice(0, eq);
                const nameT = head[head.length - 1];
                const typeT = head[head.length - 2];
                if (!nameT || nameT.type !== 'identifier' || !typeT || (typeT.type !== 'type' && typeT.type !== 'identifier')) return null;
                const defaultText = eq === -1 || eq === seg.length - 1 ? '' : text.slice(seg[eq + 1].start, seg[seg.length - 1].end).trim();
                return { name: word(nameT), type: slxCanonicalType(word(typeT)), defaultText, doc: '' };
            };
            const out = [];
            for (let i = 1; i < toks.length; i++) {
                const nameT = toks[i];
                const retT = toks[i - 1];
                // A name being defined is scanned as an identifier (a call's
                // is a function token), right after its return type.
                if (nameT.type !== 'identifier' || (retT.type !== 'type' && retT.type !== 'identifier')) continue;
                let j = i + 1;
                let template = null;
                if (slxPunct(text, toks[j], '<')) {
                    template = [];
                    for (j++; j < toks.length && !slxPunct(text, toks[j], '>'); j++) {
                        if (toks[j].type === 'type' || toks[j].type === 'identifier') template.push(slxCanonicalType(word(toks[j])));
                    }
                    j++;
                }
                if (!slxPunct(text, toks[j], '(')) continue;
                // Parameters: split at depth-0 commas up to the matching `)`.
                const params = [];
                let seg = [];
                let depth = 0;
                let closed = false;
                let k = j + 1;
                for (; k < toks.length; k++) {
                    const t = toks[k];
                    const ch = t.type === 'punctuation' ? text[t.start] : '';
                    if (ch === '(' || ch === '{' || ch === '[') depth++;
                    else if (ch === ')' || ch === '}' || ch === ']') {
                        if (depth === 0) {
                            closed = ch === ')';
                            break;
                        }
                        depth--;
                    } else if (ch === ';') break;
                    else if (ch === ',' && depth === 0) {
                        const p = parseParam(seg);
                        if (p) params.push(p);
                        seg = [];
                        continue;
                    }
                    seg.push(t);
                }
                if (!closed) continue;
                if (seg.length) {
                    const p = parseParam(seg);
                    if (p) params.push(p);
                }
                out.push({
                    name: word(nameT), ret: slxCanonicalType(word(retT)),
                    template: template && template.length ? template : null,
                    params, start: nameT.start,
                });
                i = k;
            }
            return out;
        };

        // The variables `text` declares, parameters included: a type (or a
        // user type's name) followed by a name that isn't a function's.
        // Name -> type, the first declaration winning. Not scope-aware.
        const slxParseVariables = (text, tokens) => {
            const toks = tokens.filter((t) => t.type !== 'comment');
            const vars = new Map();
            for (let i = 1; i < toks.length; i++) {
                const t = toks[i];
                const prev = toks[i - 1];
                if (t.type !== 'identifier' || (prev.type !== 'type' && prev.type !== 'identifier')) continue;
                if (slxPunct(text, toks[i + 1], '(') || slxPunct(text, toks[i + 1], '<')) continue;
                const name = text.slice(t.start, t.end);
                if (!vars.has(name)) vars.set(name, slxCanonicalType(text.slice(prev.start, prev.end)));
            }
            return vars;
        };

        // { variables: Map name -> type, functions: Map name -> [signature] }
        const slxFileSymbols = (text, tokens) => {
            const functions = new Map();
            for (const sig of slxParseFunctions(text, tokens)) {
                if (!functions.has(sig.name)) functions.set(sig.name, []);
                functions.get(sig.name).push(sig);
            }
            return { variables: slxParseVariables(text, tokens), functions };
        };

        // ---- Where the caret is ------------------------------------------------

        // Whether `pos` is inside `token` (a comment, string or attribute).
        // Its end counts as inside when the token is still open there: a
        // line comment, an unterminated block comment or string, a name.
        const slxInsideToken = (text, token, pos) => {
            if (pos <= token.start) return false;
            if (pos < token.end) return true;
            if (pos > token.end) return false;
            const s = text.slice(token.start, token.end);
            if (token.type === 'comment') return s.startsWith('//') || s.length < 4 || !s.endsWith('*/');
            if (token.type === 'string') return s.length < 2 || !s.endsWith('"');
            return token.type === 'attribute';
        };

        // What completion offers for the word starting at `wordStart`:
        // 'directive' after `#`, 'code' elsewhere, and null inside a
        // comment, string or attribute name, after `.` (members aren't
        // known) and, unless `explicit`, where a new name is being declared
        // (`float |`).
        const slxCompletionContext = (text, tokens, wordStart, explicit) => {
            let prev = null;
            for (const t of tokens) {
                if (t.start >= wordStart) break;
                if ((t.type === 'comment' || t.type === 'string' || t.type === 'attribute') && slxInsideToken(text, t, wordStart)) return null;
                if (t.type === 'directive' && wordStart <= t.end) return 'directive'; // `#if|`, a directive already
                if (t.type !== 'comment') prev = t;
            }
            if (slxPunct(text, prev, '.')) return null;
            if (slxPunct(text, prev, '#')) return 'directive';
            if (!explicit && prev && (prev.type === 'type'
                || (prev.type === 'keyword' && /^(class|namespace|using)$/.test(text.slice(prev.start, prev.end))))) return null;
            return 'code';
        };

        // The call the caret at `offset` is in, the innermost one:
        //   { name, nameStart, template, argIndex, argName, method }
        // `template` is the first `<...>` type (MaterialX name); `argName`
        // is set when the current argument is named (`octaves = |`);
        // `method` when it's called as `x.name(`. Null outside any call.
        // Brackets and braces nest; `;` ends whatever's open.
        const slxCallContext = (text, tokens, offset) => {
            const stack = [];
            let pending = null; // a call's name, until its `(` (after any <...>)
            for (let i = 0; i < tokens.length && tokens[i].start < offset; i++) {
                const t = tokens[i];
                if (t.type === 'comment') continue;
                const ch = t.type === 'punctuation' ? text[t.start] : '';
                if (pending) {
                    if (ch === '<' && pending.angle === 0 && pending.template == null) {
                        pending.angle = 1;
                        pending.templateStart = t.end;
                        continue;
                    }
                    if (pending.angle > 0) {
                        if (ch === '>') {
                            pending.angle = 0;
                            pending.template = text.slice(pending.templateStart, t.start);
                        }
                        continue; // its commas aren't argument separators
                    }
                    if (ch === '(') {
                        const first = pending.template ? pending.template.split(',')[0].trim() : '';
                        stack.push({
                            call: pending.token, method: pending.method,
                            template: first ? slxCanonicalType(first) : null,
                            argIndex: 0, argStart: i + 1,
                        });
                        pending = null;
                        continue;
                    }
                    pending = null;
                }
                if (t.type === 'function') {
                    let p = i - 1;
                    while (p >= 0 && tokens[p].type === 'comment') p--;
                    pending = { token: t, angle: 0, template: null, method: p >= 0 && slxPunct(text, tokens[p], '.') };
                } else if (ch === '(' || ch === '{' || ch === '[') {
                    stack.push({ call: null, argIndex: 0, argStart: i + 1 });
                } else if (ch === ')' || ch === '}' || ch === ']') {
                    stack.pop();
                } else if (ch === ',' && stack.length) {
                    const top = stack[stack.length - 1];
                    top.argIndex++;
                    top.argStart = i + 1;
                } else if (ch === ';') {
                    stack.length = 0;
                }
            }
            let entry = null;
            for (let k = stack.length - 1; k >= 0 && !entry; k--) if (stack[k].call) entry = stack[k];
            if (!entry) return null;
            // A named argument: the current one starts `name =` (not `==`).
            const arg = [];
            for (let i = entry.argStart; i < tokens.length && tokens[i].start < offset && arg.length < 2; i++) {
                if (tokens[i].type !== 'comment') arg.push(tokens[i]);
            }
            const argName = arg.length === 2 && arg[0].type === 'identifier'
                && slxPunct(text, arg[1], '=') && text[arg[1].start + 1] !== '='
                ? text.slice(arg[0].start, arg[0].end) : null;
            return {
                name: text.slice(entry.call.start, entry.call.end), nameStart: entry.call.start,
                template: entry.template, argIndex: entry.argIndex, argName, method: entry.method,
            };
        };

        // Which of `sigs` a call most likely means: the first that takes its
        // template type, its named argument and as many arguments as it
        // has so far, relaxing those in turn.
        const slxPickSignature = (sigs, ctx) => {
            const fitsTemplate = (s) => !ctx.template || (s.template ? s.template.includes(ctx.template) : s.ret === ctx.template);
            const fitsName = (s) => !ctx.argName || s.params.some((p) => p.name === ctx.argName);
            const fitsCount = (s) => !!ctx.argName || s.params.length > ctx.argIndex;
            const tests = [[fitsTemplate, fitsName, fitsCount], [fitsName, fitsCount], [fitsName], [fitsTemplate]];
            for (const test of tests) {
                const i = sigs.findIndex((s) => test.every((fits) => fits(s)));
                if (i !== -1) return i;
            }
            return 0;
        };
        // The parameter the current argument fills, or -1.
        const slxActiveParam = (sig, ctx) => (ctx.argName
            ? sig.params.findIndex((p) => p.name === ctx.argName)
            : (ctx.argIndex < sig.params.length ? ctx.argIndex : -1));

        // ---- Completion ------------------------------------------------------------

        // Everything completion can offer in `context` (see
        // slxCompletionContext): { label, kind, detail, sigs?, description?,
        // local? }, kinds being variable, function, keyword, type and
        // directive. The code's own names come first; a name is offered once.
        const slxCompletionItems = (context, library, symbols) => {
            if (context === 'directive') return [...SLX_DIRECTIVES].map((label) => ({ label, kind: 'directive', detail: 'directive' }));
            const items = [];
            const seen = new Set();
            const add = (item) => {
                if (seen.has(item.label)) return;
                seen.add(item.label);
                items.push(item);
            };
            if (symbols) {
                for (const [label, sigs] of symbols.functions) add({ label, kind: 'function', detail: slxSignatureText(sigs[0]), sigs, local: true });
                for (const [label, type] of symbols.variables) add({ label, kind: 'variable', detail: slxTypeDisplay(type), local: true });
            }
            if (library) {
                for (const fn of library.functions.values()) {
                    add({ label: fn.name, kind: 'function', detail: fn.group || 'ShadingLanguageX', sigs: fn.sigs, description: fn.description });
                }
            }
            for (const label of SLX_CONSTANTS) add({ label, kind: 'keyword', detail: 'literal' });
            for (const label of SLX_KEYWORDS) add({ label, kind: 'keyword', detail: 'keyword' });
            for (const label of SLX_TYPES) {
                add({ label, kind: 'type', detail: SLX_TYPE_CANONICAL[label] ? 'alias of ' + SLX_TYPE_CANONICAL[label] : 'type' });
            }
            return items;
        };

        // How `label` matches what's been typed, or null: { rank, positions }
        // with the matched character indexes. Case-insensitive; the typed
        // text's first character must land on a word start (the label's
        // start, or just after a `_`). Ranks: 0 prefix (same case), 1
        // prefix, 2 a later word's prefix (`surf` -> standard_surface),
        // 3 scattered (`stdsurf` -> standard_surface).
        const slxMatch = (label, typed) => {
            const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);
            if (!typed) return { rank: 0, positions: [] };
            if (label.startsWith(typed)) return { rank: 0, positions: range(0, typed.length) };
            const l = label.toLowerCase();
            const p = typed.toLowerCase();
            if (l.startsWith(p)) return { rank: 1, positions: range(0, p.length) };
            const wordStart = (i) => i === 0 || label[i - 1] === '_';
            for (let at = l.indexOf(p); at !== -1; at = l.indexOf(p, at + 1)) {
                if (wordStart(at)) return { rank: 2, positions: range(at, p.length) };
            }
            for (let s = 0; s < l.length; s++) {
                if (l[s] !== p[0] || !wordStart(s)) continue;
                const positions = [s];
                for (let i = s + 1, j = 1; i < l.length && j < p.length; i++) {
                    if (l[i] === p[j]) {
                        positions.push(i);
                        j++;
                    }
                }
                if (positions.length === p.length) return { rank: 3, positions };
            }
            return null;
        };

        // The items matching `typed`, best first: by rank, the code's own
        // names before the rest, then alphabetically. [{ item, positions }]
        const slxFilterCompletions = (items, typed) => {
            const out = [];
            for (const item of items) {
                const m = slxMatch(item.label, typed);
                if (m) out.push({ item, rank: m.rank, positions: m.positions });
            }
            out.sort((a, b) => a.rank - b.rank
                || (a.item.local ? 0 : 1) - (b.item.local ? 0 : 1)
                || a.item.label.localeCompare(b.item.label, undefined, { sensitivity: 'base' }));
            return out;
        };

        // ---- The library -------------------------------------------------------------

        // { names: Set of node names (the calls underlined, with docs),
        //   functions: Map name -> { name, group, node, description, sigs } }
        // from the node catalog (buildNodeCatalog) and js/gen/nodelib.json
        // (null: no descriptions), plus SLX_LIBRARY_EXTENSIONS.
        const buildSlxLibrary = (catalog, docs) => {
            const functions = new Map();
            const portDocs = new Map();
            for (const entry of catalog || []) {
                const doc = slxNodeDoc(docs, entry.category);
                const ports = slxPortDocs(doc);
                portDocs.set(entry.category, ports);
                functions.set(entry.category, {
                    name: entry.category, group: entry.group || '', node: true,
                    description: slxDocDescription(doc),
                    sigs: slxNodeSignatures(entry.category, entry.signatures || [], ports),
                });
            }
            const extensions = slxParseFunctions(SLX_LIBRARY_EXTENSIONS, tokenizeSlx(SLX_LIBRARY_EXTENSIONS, null));
            for (const { start, ...sig } of extensions) {
                let fn = functions.get(sig.name);
                if (!fn) {
                    fn = { name: sig.name, group: '', node: false, description: SLX_LIBRARY_EXTENSION_DOCS[sig.name] || '', sigs: [] };
                    functions.set(sig.name, fn);
                }
                // An extra overload of a node (min, max) borrows its port docs.
                const ports = portDocs.get(sig.name) || {};
                fn.sigs.push({ ...sig, params: sig.params.map((p) => ({ ...p, doc: (ports[p.name] && ports[p.name].doc) || '' })) });
            }
            return { names: new Set((catalog || []).map((c) => c.category)), functions };
        };

        // Cached like buildNodeCatalog; a failed load isn't, so it can be
        // retried. The docs are optional: without them there are just no
        // descriptions.
        let slxLibraryPromise = null;
        const loadSlxLibrary = () => {
            if (!slxLibraryPromise) {
                const docs = fetch('js/gen/nodelib.json')
                    .then((r) => (r.ok ? r.json() : null))
                    .catch(() => null);
                slxLibraryPromise = Promise.all([buildNodeCatalog(), docs])
                    .then(([catalog, nodeDocs]) => buildSlxLibrary(catalog, nodeDocs));
                slxLibraryPromise.catch(() => { slxLibraryPromise = null; });
            }
            return slxLibraryPromise;
        };

Object.assign(window, {
    slxTypeName, slxTypeDisplay, slxSignatureText, slxFileSymbols, slxCompletionContext, slxCallContext,
    slxPickSignature, slxActiveParam, slxCompletionItems, slxFilterCompletions, slxMatch,
    buildSlxLibrary, loadSlxLibrary,
});
