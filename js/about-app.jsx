// about-app.jsx - "The MaterialX Playground" view (hash route "#!about"),
// reached from the header's About menu: a horizontal slide deck around one
// live render, where the visitor writes a material and takes it through every tool.

// Untextured MaterialX examples the Find slide can put on the stage, paths
// under resources/Materials/Examples/ (resolved through MtlxAssets.repoUrl).
// pair is Compare's partner; edit names the two inputs the Change slide exposes.
const ABOUT_MATERIALS = [
    {
        label: 'Jade', path: 'StandardSurface/standard_surface_jade.mtlx', shader: 'standard_surface', pair: 2, tint: [0.12, 0.42, 0.22],
        edit: {
            color: { label: 'Base color', targets: [['SR_jade', 'base_color'], ['SR_jade', 'subsurface_color']] },
            rough: { label: 'Specular roughness', targets: [['SR_jade', 'specular_roughness']] },
        },
    },
    {
        label: 'Copper', path: 'StandardSurface/standard_surface_copper.mtlx', shader: 'standard_surface', pair: 3, tint: [0.93, 0.38, 0.18],
        edit: {
            color: { label: 'Coat color', targets: [['SR_copper', 'coat_color']] },
            rough: { label: 'Specular roughness', targets: [['SR_copper', 'specular_roughness']] },
        },
    },
    {
        label: 'Marble', path: 'StandardSurface/standard_surface_marble_solid.mtlx', shader: 'standard_surface', pair: 0, tint: [0.78, 0.78, 0.75],
        edit: {
            color: { label: 'Vein color', targets: [['NG_marble1', 'base_color_2']] },
            rough: { label: 'Specular roughness', targets: [['SR_marble1', 'specular_roughness']] },
        },
    },
    {
        label: 'Car paint', path: 'OpenPbr/open_pbr_carpaint.mtlx', shader: 'open_pbr_surface', pair: 1, tint: [0.55, 0.03, 0.03],
        edit: {
            color: { label: 'Base color', targets: [['open_pbr_surface_surfaceshader', 'base_color']] },
            rough: { label: 'Coat roughness', targets: [['open_pbr_surface_surfaceshader', 'coat_roughness']] },
        },
    },
    {
        label: 'Velvet', path: 'OpenPbr/open_pbr_velvet.mtlx', shader: 'open_pbr_surface', pair: 3, tint: [0.22, 0.05, 0.36],
        edit: {
            color: { label: 'Fuzz color', targets: [['open_pbr_surface_surfaceshader', 'fuzz_color']] },
            rough: { label: 'Fuzz roughness', targets: [['open_pbr_surface_surfaceshader', 'fuzz_roughness']] },
        },
    },
];
const ABOUT_SHADER_LABELS = { standard_surface: 'Standard Surface', open_pbr_surface: 'OpenPBR Surface' };
const ABOUT_SHADER_TEXT = {
    standard_surface: 'One node that layers a base, specular, coat, sheen, subsurface, thin film and emission. Each layer has its own inputs, and an input you leave alone keeps the default the standard defines.',
    open_pbr_surface: 'One node that stacks a base, specular, coat, fuzz, thin film and emission over each other. Each layer has its own inputs, and an input you leave alone keeps the default the standard defines.',
};

// ---- The material the page writes -------------------------------------
// Every input the page animates is authored in the compiled document so it
// becomes a uniform; beat null inputs exist only there (the spec rows probe them).
const ABOUT_MINE_SHADER = 'SR_mine';
const ABOUT_MINE_FILE = 'my_material';
const ABOUT_INPUTS = [
    { name: 'base_color', type: 'color3', beat: 1 },
    { name: 'metalness', type: 'float', beat: 2 },
    { name: 'specular_roughness', type: 'float', beat: 3 },
    { name: 'coat', type: 'float', beat: 4 },
    { name: 'coat_color', type: 'color3', beat: 4 },
    { name: 'base', type: 'float', beat: null },
    { name: 'specular_IOR', type: 'float', beat: null },
    { name: 'coat_roughness', type: 'float', beat: null },
];
// Standard Surface defaults for those inputs (the 1.0.1 nodedef).
const ABOUT_DEFAULTS = {
    base_color: [0.8, 0.8, 0.8], metalness: 0, specular_roughness: 0.2, coat: 0, coat_color: [1, 1, 1],
    base: 1, specular_IOR: 1.5, coat_roughness: 0.1,
};
// What a spec row flips to when the visitor's value is the default.
const ABOUT_PROBE_DEMO = {
    base: 0.15, base_color: [0.05, 0.3, 0.85], metalness: 1, specular_roughness: 0.75, specular_IOR: 3,
    coat: 1, coat_color: [0.25, 0.55, 1], coat_roughness: 0.6,
};
// Linear rec709 picks for the color slide, and the coat's warm tint.
const ABOUT_SWATCHES = [
    { label: 'Coral', lin: [0.86, 0.16, 0.07] },
    { label: 'Gold', lin: [0.9, 0.55, 0.12] },
    { label: 'Teal', lin: [0.03, 0.42, 0.37] },
    { label: 'Blue', lin: [0.06, 0.24, 0.85] },
    { label: 'Violet', lin: [0.3, 0.09, 0.72] },
    { label: 'Graphite', lin: [0.05, 0.05, 0.06] },
];
const ABOUT_COAT_COLOR = [1, 0.9, 0.74];
const ABOUT_MINE_START = { color: ABOUT_SWATCHES[0].lin, metal: 1, rough: 0.35, coat: 1 };
const ABOUT_STUDIO_ENV = 'env_maps/studio_kontrast_04_1k.exr';
// Go further's shapes: engine preview geometry names (GLOBAL_GEOM_VALUES), or a
// per-view model URL (models/LICENSE_dragon.txt) that leaves the Viewer's model alone.
const ABOUT_SHAPES = [
    { id: 'dragon', label: 'Dragon', model: 'models/dragon.glb' },
    { id: 'cube', label: 'Cube' },
    { id: 'sphere', label: 'Sphere' },
    { id: 'cloth', label: 'Cloth' },
    { id: 'shaderball', label: 'Standard Shader Ball' },
    { id: 'shaderball-mtlx', label: 'MaterialX Shader Ball' },
];
// The visitor's light: env changes only on a light button; spin is the Look slide's Play.
const ABOUT_LIGHT_START = { env: 'default', rot: null, exposure: 1, spin: false };
const ABOUT_SHAPE_START = 'dragon';
const ABOUT_DRAGON_LINKS = {
    stanford: 'http://www.graphics.stanford.edu/data/3Dscanrep/',
    mcguire: 'https://casual-effects.com/data',
    khronos: 'https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/DragonAttenuation',
};
const ABOUT_CREDIT_LINK = 'underline underline-offset-2 hover:text-fg';
const ABOUT_LIGHTS = [
    { id: 'default', label: 'Soft studio' },
    { id: 'studio', label: 'Contrast studio' },
];

const aboutMtlxVersion = () => {
    const m = /(\d+)\.(\d+)/.exec(typeof MTLX_DEFAULT_VERSION === 'string' ? MTLX_DEFAULT_VERSION : '');
    return m ? m[1] + '.' + m[2] : '1.39';
};
const aboutNum = (x) => String(Number(x.toFixed(4)));
const aboutFmt = (v) => (Array.isArray(v) ? v.map((x) => String(Number(x.toFixed(3)))).join(', ') : String(Number(v.toFixed(3))));
const aboutClamp01 = (x) => Math.min(1, Math.max(0, x));
const aboutSmooth = (a, b, x) => { const t = aboutClamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const aboutLerp = (a, b, t) => (Array.isArray(a) ? a.map((c, i) => c + (b[i] - c) * t) : a + (b - a) * t);
const aboutSame = (a, b) => (Array.isArray(a) ? a.every((c, i) => Math.abs(c - b[i]) < 1e-4) : Math.abs(a - b) < 1e-4);

// The input values at a write beat (99 = finished) for the visitor's picks.
const aboutTargets = (beat, mine) => {
    const v = { ...ABOUT_DEFAULTS };
    if (beat >= 1) v.base_color = mine.color;
    if (beat >= 2) v.metalness = mine.metal;
    if (beat >= 3) v.specular_roughness = mine.rough;
    if (beat >= 4) { v.coat = mine.coat; v.coat_color = ABOUT_COAT_COLOR; }
    return v;
};

// The .mtlx text: `upTo` limits the authored inputs to those written by
// that beat; `all` authors every input (the compiled document).
const aboutMineXml = (vals, upTo, all) => {
    const lines = ['<?xml version="1.0"?>', '<materialx version="' + aboutMtlxVersion() + '">'];
    lines.push('  <standard_surface name="' + ABOUT_MINE_SHADER + '" type="surfaceshader">');
    ABOUT_INPUTS.forEach((inp) => {
        if (!all && (inp.beat == null || inp.beat > upTo)) return;
        const v = vals[inp.name];
        lines.push('    <input name="' + inp.name + '" type="' + inp.type + '" value="' + (Array.isArray(v) ? v.map(aboutNum).join(', ') : aboutNum(v)) + '" />');
    });
    lines.push('  </standard_surface>');
    lines.push('  <surfacematerial name="M_mine" type="material">');
    lines.push('    <input name="surfaceshader" type="surfaceshader" nodename="' + ABOUT_MINE_SHADER + '" />');
    lines.push('  </surfacematerial>');
    lines.push('</materialx>');
    return lines.join('\n') + '\n';
};
const ABOUT_MINE_COMPILE_XML = aboutMineXml(ABOUT_DEFAULTS, 99, true);
const ABOUT_START_XML = aboutMineXml(ABOUT_DEFAULTS, 0, false);

// ---- Slides -------------------------------------------------------------

// beat: the stage material's state; pose: wide-screen [center x, center y,
// size] in deck fractions; area: the wide content column; cam: azimuth (daz
// or abs), elevation, distance in framing units, target, spin and easing.
const ABOUT_SLIDES = [
    {
        id: 'intro', group: 0, title: 'Welcome', beat: 99, pose: [0.73, 0.46, 0.9], area: { left: '6%', right: '43%' },
        cam: { daz: 0, el: 0.16, dist: 1.02, spin: 0.3, tau: 0.8 },
    },
    {
        id: 'doc', group: 1, title: 'Start with a document', beat: 0, pose: [0.28, 0.46, 0.86], area: { left: '54%', right: '5%' },
        cam: { daz: 0, el: 0.08, dist: 1.06, spin: 0.08, tau: 0.9 },
    },
    {
        id: 'color', group: 1, title: 'Give it a color', beat: 1, pose: [0.28, 0.46, 0.86], area: { left: '54%', right: '5%' },
        cam: { daz: 1.1, el: 0.3, dist: 1.02, spin: 0.35, tau: 0.9 },
    },
    {
        id: 'metal', group: 1, title: 'Make it metal', beat: 2, pose: [0.28, 0.46, 0.86], area: { left: '54%', right: '5%' },
        cam: { abs: 2.8, el: 0.42, dist: 0.92, t: [0.03, 0.06, -0.04], spin: 0, tau: 0.9 },
    },
    {
        id: 'rough', group: 1, title: 'Blur the reflections', beat: 3, pose: [0.28, 0.46, 0.86], area: { left: '54%', right: '5%' },
        cam: { abs: 0.4, el: -0.04, dist: 0.9, t: [0, -0.05, 0], spin: 0, tau: 0.8 },
    },
    {
        id: 'coat', group: 1, title: 'Add a clear coat', beat: 4, pose: [0.28, 0.46, 0.86], area: { left: '54%', right: '5%' },
        cam: { daz: 2.5, el: 0.3, dist: 1.02, spin: 0.14, tau: 0.6 },
    },
    {
        id: 'graph', group: 1, title: 'The file is the graph', beat: 5, pose: [0.15, 0.47, 0.5], area: { left: '29%', right: '4%' },
        cam: { daz: 0.4, el: 0.22, dist: 1.05, spin: 0.16, tau: 1 },
    },
    {
        id: 'find', group: 2, title: 'Find', tool: 'Material Gallery', icon: 'layout-grid', beat: 99, pose: [0.29, 0.46, 0.84], area: { left: '55%', right: '5%' },
        cam: { daz: 0.8, el: 0.45, dist: 1.1, spin: 0.6, tau: 0.9 },
    },
    {
        id: 'look', group: 2, title: 'Look', tool: 'Material Viewer', icon: 'camera', beat: 99, pose: [0.35, 0.46, 0.92], area: { left: '66%', right: '5%' },
        cam: { abs: 0.3, el: 0.06, dist: 1.02, spin: 0, tau: 0.7 },
    },
    {
        id: 'compare', group: 2, title: 'Compare', tool: 'Material Compare', icon: 'compare', beat: 99, pose: [0.64, 0.46, 0.9], area: { left: '5%', right: '67%' },
        cam: { abs: 0.35, el: 0.16, dist: 1.04, spin: 0, tau: 0.45 },
    },
    {
        id: 'change', group: 2, title: 'Change', tool: 'Node Graph Editor', icon: 'share', beat: 99, pose: [0.23, 0.46, 0.76], area: { left: '45%', right: '4%' },
        cam: { daz: -0.6, el: 0.22, dist: 1, spin: 0.2, tau: 0.8 },
    },
    {
        id: 'understand', group: 2, title: 'Understand', tool: 'Node Specs', icon: 'file-code', beat: 99, pose: [0.78, 0.46, 0.76], area: { left: '5%', right: '42%' },
        cam: { daz: 0.5, el: 0.5, dist: 1.04, spin: 0.2, tau: 0.9 },
    },
    {
        id: 'further', group: 2, title: 'Go further', tool: 'Scene Viewer', icon: 'cube', experimental: true, beat: 99, pose: [0.34, 0.46, 0.86], area: { left: '64%', right: '5%' },
        cam: { daz: 0, el: 0.32, dist: 1.18, spin: 0.25, tau: 0.6 },
    },
    {
        id: 'share', group: 2, title: 'Share', tool: 'Embed Builder', icon: 'code', experimental: true, beat: 99, pose: [0.715, 0.5, 0.5], area: { left: '5%', right: '58%' },
        cam: { daz: 0.3, el: 0.14, dist: 1, spin: 0.3, tau: 0.8 },
    },
    {
        id: 'anywhere', group: 3, title: 'Anywhere', beat: 99, hidden: true, pose: [0.5, 0.45, 0.5], area: { left: '5%', right: '5%' },
        cam: { daz: 0, el: 0.14, dist: 1, spin: 0.3, tau: 0.8 },
    },
    {
        id: 'principles', group: 3, title: 'The choices behind it', beat: 99, narrowHidden: true, pose: [0.86, 0.17, 0.26], area: { left: '6%', right: '6%' },
        cam: { daz: 0, el: 0.14, dist: 1, spin: 0.3, tau: 0.8 },
    },
];
const ABOUT_SLIDE_INDEX = Object.fromEntries(ABOUT_SLIDES.map((s, i) => [s.id, i]));
const ABOUT_FURTHER_AT = ABOUT_SLIDE_INDEX.further;
// The Anywhere frames: three angles of the finished material.
const ABOUT_SHOT_POSES = [
    { az: 0.6, el: 0.22, dist: 1.15 },
    { az: -0.9, el: 0.08, dist: 1.1 },
    { az: 2.8, el: 0.45, dist: 1.1 },
];

const aboutPoseToCamera = (az, el, dist, t) => ({
    position: [t[0] + dist * Math.cos(el) * Math.sin(az), t[1] + dist * Math.sin(el), t[2] + dist * Math.cos(el) * Math.cos(az)],
    target: t.slice(),
});
// The stage box is an H x H square at the deck's top left; a slide's pose
// is a translate and a scale of it (transform only, the canvas never resizes).
const aboutStageTransform = (slide, wide, W, H) => {
    if (!W || !H) return { transform: 'none', opacity: 0, side: 0 };
    let cx, cy, side;
    if (wide) {
        [cx, cy] = slide.pose;
        side = slide.pose[2] * H;
    } else {
        cx = 0.5; cy = slide.hidden || slide.narrowHidden ? 0.3 : 0.19;
        side = Math.min(H * 0.38, W * 0.92);
    }
    const hidden = slide.hidden || (!wide && slide.narrowHidden);
    if (hidden) side *= 0.6;
    const x = cx * W - side / 2;
    const y = cy * H - side / 2;
    return { transform: 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) scale(' + (side / H).toFixed(4) + ')', opacity: hidden ? 0 : 1, side, scale: +(side / H).toFixed(4) };
};

const aboutDocName = (m) => m.path.split('/').pop().replace(/\.mtlx$/i, '');

// One fetch per example for the page's lifetime; a failure clears the entry.
const aboutXmlCache = new Map();
const fetchAboutXml = (m) => {
    if (!aboutXmlCache.has(m.path)) {
        const p = fetch(window.MtlxAssets.repoUrl('resources/Materials/Examples/' + m.path)).then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
        });
        aboutXmlCache.set(m.path, p);
        p.catch(() => aboutXmlCache.delete(m.path));
    }
    return aboutXmlCache.get(m.path);
};

const aboutParseXml = (xml) => {
    try {
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        return doc.getElementsByTagName('parsererror').length ? null : doc;
    } catch (e) {
        return null;
    }
};
const aboutFindPort = (doc, elName, inputName) => {
    const host = Array.from(doc.documentElement.getElementsByTagName('*'))
        .find((n) => n.tagName !== 'input' && n.getAttribute('name') === elName);
    return host ? Array.from(host.children).find((c) => c.tagName === 'input' && c.getAttribute('name') === inputName) || null : null;
};

// Plain-language structure of a single-file document, read with DOMParser.
const aboutOutline = (xml) => {
    const doc = aboutParseXml(xml);
    if (!doc) return null;
    const kids = Array.from(doc.documentElement.children);
    const shader = kids.find((e) => e.getAttribute('type') === 'surfaceshader');
    const inputs = shader ? Array.from(shader.children).filter((c) => c.tagName === 'input').map((c) => ({
        name: c.getAttribute('name'),
        value: c.getAttribute('value') != null ? c.getAttribute('value')
            : 'from ' + (c.getAttribute('nodegraph') || c.getAttribute('nodename') || 'a connection'),
    })) : [];
    return {
        shaderLabel: shader ? (ABOUT_SHADER_LABELS[shader.tagName] || shader.tagName) : null,
        shaderName: shader ? shader.getAttribute('name') : null,
        inputs,
    };
};

// sRGB hex (color picker) <-> linear values (the documents are lin_rec709).
const aboutToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const aboutToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const aboutHexToLin = (hex) => [1, 3, 5].map((i) => aboutToLin(parseInt(hex.slice(i, i + 2), 16) / 255));
const aboutLinToHex = (rgb) => '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, aboutToSrgb(c))) * 255).toString(16).padStart(2, '0')).join('');
// A small lit-sphere look for a material dot, from its linear color.
const aboutDotStyle = (lin) => ({
    backgroundColor: aboutLinToHex(lin),
    backgroundImage: 'radial-gradient(circle at 34% 30%, ' + aboutLinToHex(lin.map((c) => Math.min(1, c * 2.2 + 0.08))) + ', transparent 58%)',
});

// An example's own values for its two editable inputs.
const aboutEditDefaults = (m, xml) => {
    const doc = xml && aboutParseXml(xml);
    if (!doc) return null;
    const colorPort = aboutFindPort(doc, m.edit.color.targets[0][0], m.edit.color.targets[0][1]);
    const roughPort = aboutFindPort(doc, m.edit.rough.targets[0][0], m.edit.rough.targets[0][1]);
    const rgb = colorPort && colorPort.getAttribute('value') ? colorPort.getAttribute('value').split(',').map(parseFloat) : null;
    const rough = roughPort && roughPort.getAttribute('value') != null ? parseFloat(roughPort.getAttribute('value')) : null;
    return {
        color: rgb && rgb.length === 3 && rgb.every(isFinite) ? aboutLinToHex(rgb) : null,
        rough: isFinite(rough) ? rough : null,
    };
};

// An example's source with the Change slide's edits written in.
const aboutEditXml = (xml, m, e) => {
    if (!xml || !e) return xml;
    const doc = aboutParseXml(xml);
    if (!doc) return xml;
    const set = (targets, value) => targets.forEach(([el, inp]) => {
        const port = aboutFindPort(doc, el, inp);
        if (port && port.hasAttribute('value')) port.setAttribute('value', value);
    });
    if (e.color) set(m.edit.color.targets, aboutHexToLin(e.color).map(aboutNum).join(', '));
    if (e.rough != null) set(m.edit.rough.targets, aboutNum(e.rough));
    let out = new XMLSerializer().serializeToString(doc);
    if (/^<\?xml/.test(xml) && !/^<\?xml/.test(out)) out = '<?xml version="1.0"?>\n' + out;
    return out.replace(/^(<\?xml[^>]*\?>)(?=<)/, '$1\n');
};

// Live uniforms behind an [element, input] target, matched on the
// introspected path like the Graph Editor's fast value path.
const aboutUniformsFor = (view, el, input) => {
    const intro = view.introspected || [];
    const U = view.uniforms || {};
    const full = el + '/' + input;
    let hits = intro.filter((u) => u.path && U[u.name] && (u.path === full || u.path.slice(-(full.length + 1)) === '/' + full));
    if (!hits.length) {
        const loose = intro.filter((u) => u.path && U[u.name] && u.path.split('/').pop() === input);
        if (new Set(loose.map((u) => u.name)).size === 1) hits = loose;
    }
    return hits.map((u) => U[u.name]);
};
const aboutSetUniform = (u, v) => {
    if (Array.isArray(v)) { if (u.value && u.value.set) u.value.set(v[0], v[1], v[2]); } else u.value = v;
};
// Writes the written material's values into the live view, no recompile.
const aboutPushMine = (view, vals) => {
    if (!view || view.__aboutKey !== 'mine') return 0;
    if (!view.__aboutU || view.__aboutU.src !== view.uniforms) {
        const map = { src: view.uniforms };
        ABOUT_INPUTS.forEach((inp) => { map[inp.name] = aboutUniformsFor(view, ABOUT_MINE_SHADER, inp.name); });
        view.__aboutU = map;
    }
    let n = 0;
    ABOUT_INPUTS.forEach((inp) => view.__aboutU[inp.name].forEach((u) => { aboutSetUniform(u, vals[inp.name]); n++; }));
    return n;
};
const aboutPushEdits = (view, m, values) => {
    if (!view || !values || !m) return 0;
    let n = 0;
    if (values.color) {
        const lin = aboutHexToLin(values.color);
        m.edit.color.targets.forEach(([el, inp]) => aboutUniformsFor(view, el, inp).forEach((u) => { aboutSetUniform(u, lin); n++; }));
    }
    if (values.rough != null) {
        m.edit.rough.targets.forEach(([el, inp]) => aboutUniformsFor(view, el, inp).forEach((u) => { u.value = values.rough; n++; }));
    }
    return n;
};

// Hand-offs into other views, the same payload contracts as mtlx-ui.jsx's
// openInViewer/openInGraphEditor: a pending global the view reads on mount,
// plus an event for a view that is already mounted.
const aboutHandoff = (globalName, eventName, hash, payload) => {
    window[globalName] = payload;
    window.dispatchEvent(new CustomEvent(eventName, { detail: payload }));
    window.location.hash = hash;
};
const aboutOpenInViewer = (c) => aboutHandoff('__mtlxPendingViewerImport', 'mtlx-view-document', '#!viewer',
    { xml: c.xml, name: c.name, files: null, geometry: null, mxsl: null });
const aboutOpenInGraph = (c) => aboutHandoff('__mtlxPendingImport', 'mtlx-load-document', '#!graph',
    { xml: c.xml, name: c.name, files: null, select: null, implOf: null, readOnly: false, readOnlySource: null, mxsl: null });
const aboutOpenInBuilder = (c) => aboutHandoff('__mtlxPendingBuilderImport', 'mtlx-builder-document', '#!builder', { xml: c.xml, name: c.name });
const aboutOpenInCompare = async (c) => {
    let b = { xml: ABOUT_START_XML, name: 'standard_surface_default' };
    if (c.kind === 'example') {
        const other = ABOUT_MATERIALS[c.m.pair];
        const otherXml = await fetchAboutXml(other).catch(() => null);
        b = otherXml ? { xml: otherXml, name: aboutDocName(other) } : null;
    }
    aboutHandoff('__mtlxPendingCompareImport', 'mtlx-compare-documents', '#!compare', { a: { xml: c.xml, name: c.name }, b });
};
// Saves the carried .mtlx; the VS Code webview routes it through the host.
const aboutDownload = (xml, filename) => {
    const blob = new Blob([xml], { type: 'application/xml' });
    if (window.__MTLX_VSCODE__ && window.__mtlxHostSave) { window.__mtlxHostSave(blob, filename); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// Standard Surface rows for the Understand slide (defaults from the nodedef).
const ABOUT_SPEC_ROWS = [
    { name: 'base', type: 'float', def: '1', text: 'How much of the base color shows.' },
    { name: 'base_color', type: 'color3', def: '0.8, 0.8, 0.8', text: 'The color of the surface.' },
    { name: 'metalness', type: 'float', def: '0', text: '0 is a dielectric like paint or plastic, 1 is a metal.' },
    { name: 'specular_roughness', type: 'float', def: '0.2', text: 'How blurred the reflections are.' },
    { name: 'specular_IOR', type: 'float', def: '1.5', text: 'Index of refraction of the specular layer.' },
    { name: 'coat', type: 'float', def: '0', text: 'Weight of a clear coat over everything else.' },
    { name: 'coat_color', type: 'color3', def: '1, 1, 1', text: 'Tint of the coat.' },
    { name: 'coat_roughness', type: 'float', def: '0.1', text: 'How blurred the coat reflections are.' },
];

const ABOUT_CHIP = 'inline-flex items-center gap-2 h-9 rounded-full border text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-base';
const ABOUT_CHIP_ON = 'border-accent-base bg-selection/25 text-accent-fg-strong';
const ABOUT_CHIP_OFF = 'border-line-strong bg-control/70 text-fg-secondary hover:bg-hover hover:text-fg';
const ABOUT_LINK = 'text-accent-fg hover:text-accent-fg-strong underline decoration-accent-base/40 underline-offset-4 hover:decoration-accent-base transition-colors';
const ABOUT_CTA_LINK = 'inline-flex items-center gap-1.5 text-sm font-medium text-accent-fg hover:text-accent-fg-strong transition-colors';
const ABOUT_SECONDARY = 'inline-flex items-center gap-1.5 h-10 px-3.5 rounded-[10px] border border-line-strong bg-control/70 hover:bg-hover text-sm font-medium text-fg transition-colors';

// Deck layout, scoped to #about-deck. The track slides by transform, the
// stage box moves by transform; nothing animates layout.
const ABOUT_DECK_CSS = `
#about-deck { position: absolute; inset: 0; overflow: hidden; background: rgb(var(--mtlx-surface-base)); touch-action: pan-y; overscroll-behavior: contain; }
#about-deck .about-stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; transition: transform 900ms cubic-bezier(.65,0,.25,1), opacity 500ms ease; z-index: 1; }
#about-deck .about-stage canvas { touch-action: none; }
#about-deck .about-track { position: absolute; inset: 0; display: flex; z-index: 2; pointer-events: none; will-change: transform; transition: transform 760ms cubic-bezier(.65,0,.25,1); }
#about-deck .about-slide { position: relative; flex: 0 0 100%; height: 100%; min-width: 0; }
#about-deck .about-pe { pointer-events: auto; }
#about-deck .about-area { position: absolute; left: 16px; right: 16px; top: 40%; bottom: 76px; display: flex; flex-direction: column; overflow-y: auto; overscroll-behavior: contain; padding: 4px 2px 16px; }
#about-deck .about-slide[data-full] .about-area { top: 12px; }
#about-deck .about-slide[data-current] .about-rise { animation: about-rise 640ms cubic-bezier(.2,.8,.2,1) both; animation-delay: calc(var(--i, 0) * 70ms + 160ms); }
@keyframes about-rise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
#about-deck .about-line-new { animation: about-line-in 620ms steps(28, end) both; }
@keyframes about-line-in { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
#about-deck .about-host { opacity: 0; transform: translateY(40px) perspective(1400px) rotateX(12deg) scale(.96); transition: opacity 600ms ease, transform 900ms cubic-bezier(.2,.8,.2,1); transition-delay: var(--d); }
#about-deck .about-slide[data-current] .about-host { opacity: 1; transform: none; }
#about-deck .about-cue { animation: about-cue 2.4s ease-in-out 1.2s 2; }
@keyframes about-cue { 0%, 100% { transform: none; } 50% { transform: translateX(4px); } }
#about-deck .about-pulse-row { animation: about-row 1.8s ease-in-out infinite; }
@keyframes about-row { 0%, 100% { background-color: rgb(var(--mtlx-selection) / calc(38 / 255)); } 50% { background-color: rgb(var(--mtlx-selection) / calc(90 / 255)); } }
#about-deck .about-turning { animation: about-turn 2.4s linear infinite; }
@keyframes about-turn { to { transform: rotate(360deg); } }
#about-deck .about-swatch-input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; border: 0; padding: 0; }
@media (min-width: 1024px) {
  #about-deck .about-area { left: var(--al); right: var(--ar); top: 28px; bottom: 92px; justify-content: center; padding: 8px 4px; }
  #about-deck .about-slide[data-full] .about-area { top: 28px; }
}
@media (prefers-reduced-motion: reduce) {
  #about-deck .about-stage, #about-deck .about-host { transition: none !important; }
  #about-deck .about-track { transition: opacity 160ms ease; }
  #about-deck .about-slide[data-current] .about-rise, #about-deck .about-line-new, #about-deck .about-cue, #about-deck .about-pulse-row, #about-deck .about-turning { animation: none; }
}
`;

const aboutReducedMotion = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
};
function useAboutMedia(query, initial) {
    const [hit, setHit] = React.useState(() => { try { return window.matchMedia(query).matches; } catch (e) { return initial; } });
    React.useEffect(() => {
        let mql = null;
        try { mql = window.matchMedia(query); } catch (e) { return undefined; }
        const onChange = () => setHit(mql.matches);
        onChange();
        if (mql.addEventListener) mql.addEventListener('change', onChange);
        return () => { if (mql.removeEventListener) mql.removeEventListener('change', onChange); };
    }, [query]);
    return hit;
}
const aboutFrames = (n) => new Promise((resolve) => {
    let left = n;
    const tick = () => { if (--left <= 0) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
});
const aboutWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Plain clicks run the hand-off; modified clicks keep the link's default.
const aboutOnLinkClick = (go) => (e) => {
    if (!go || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    Promise.resolve(go()).catch((err) => console.error('[about] hand-off failed', err));
};

// Contains a render throw in the lazily loaded graph so the page survives.
class AboutInsideBoundary extends React.Component {
    constructor(props) { super(props); this.state = { failed: false }; }
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch(e) { console.warn('[about] node graph preview failed', e); }
    render() {
        if (this.state.failed) return <p className="p-4 text-sm text-fg-muted">The node graph could not be drawn.</p>;
        return this.props.children;
    }
}

// MtlxGraphPreview and highlight.js, loaded once on first use.
function useAboutGraphDeps(enabled = true) {
    const [graphDeps, setGraphDeps] = React.useState(() => (window.MtlxGraphPreview ? 'ready' : 'loading'));
    const [hlReady, setHlReady] = React.useState(() => !!window.hljs);
    React.useEffect(() => {
        if (!enabled) return undefined;
        let cancelled = false;
        if (!window.MtlxGraphPreview) {
            window.mtlxLoadViewDeps('galleryDetail').then(
                () => { if (!cancelled) setGraphDeps('ready'); },
                (e) => { console.warn('[about] node graph dependencies failed to load', e); if (!cancelled) setGraphDeps('failed'); },
            );
        }
        if (!window.hljs) {
            window.mtlxLoadViewDeps('xmlHighlight').then(() => { if (!cancelled) setHlReady(true); }, () => { /* plain text fallback */ });
        }
        return () => { cancelled = true; };
    }, [enabled]);
    return { graphDeps, hlReady };
}

function AboutGraph({ xml, label, height, deps }) {
    if (deps === 'failed') return <p className="p-4 text-sm text-fg-muted">The node graph could not be loaded.</p>;
    if (deps !== 'ready' || !xml) {
        return <div className="absolute inset-0 flex items-center justify-center text-sm text-fg-muted motion-safe:animate-pulse">Loading the node graph</div>;
    }
    return (
        <AboutInsideBoundary>
            <window.MtlxGraphPreview xml={xml} controls={['zoom']} autoFocus="fit" chrome="none" lazy={false} height={height} label={'Node graph of ' + label} />
        </AboutInsideBoundary>
    );
}

// The written .mtlx, drawn line by line. `live` registers a ticker the
// stage calls every frame, so morphing numbers change without a re-render.
const ABOUT_TOK = { p: 'text-code-muted', n: 'text-code-name', a: 'text-code-attr', s: 'text-code-string' };
function aboutTag(name, attrs, end, valueEl) {
    const out = [<span key="o" className={ABOUT_TOK.p}>{end === 'close' ? '</' : '<'}</span>, <span key="n" className={ABOUT_TOK.n}>{name}</span>];
    attrs.forEach(([k, v], i) => {
        out.push(' ', <span key={'k' + i} className={ABOUT_TOK.a}>{k}</span>, <span key={'e' + i} className={ABOUT_TOK.p}>=</span>);
        out.push(<span key={'v' + i} className={ABOUT_TOK.s}>"{k === 'value' && valueEl ? valueEl : v}"</span>);
    });
    out.push(<span key="c" className={ABOUT_TOK.p}>{end === 'self' ? ' />' : '>'}</span>);
    return out;
}
function AboutSource({ beat, vals, live, tickersRef, className, label, hover, onHover, newBeat }) {
    const ref = React.useRef(null);
    React.useEffect(() => {
        if (!live || !tickersRef) return undefined;
        const spans = () => Array.from(ref.current ? ref.current.querySelectorAll('[data-in]') : []);
        let cache = spans();
        const tick = (cur) => {
            if (cache.length && !cache[0].isConnected) cache = spans();
            cache.forEach((s) => {
                const t = aboutFmt(cur[s.getAttribute('data-in')]);
                const n = s.firstChild;
                if (n && n.nodeType === 3) { if (n.nodeValue !== t) n.nodeValue = t; } else if (s.textContent !== t) s.textContent = t;
            });
        };
        tickersRef.current.add(tick);
        return () => { tickersRef.current.delete(tick); };
    }, [live, tickersRef, beat]);
    const shown = ABOUT_INPUTS.filter((inp) => inp.beat != null && inp.beat <= beat);
    const lines = [
        { k: 'x', i: 0, b: 0, el: <span className={ABOUT_TOK.p}>&lt;?xml version="1.0"?&gt;</span> },
        { k: 'm', i: 0, b: 0, el: aboutTag('materialx', [['version', aboutMtlxVersion()]]) },
        { k: 's', i: 1, b: 0, el: aboutTag('standard_surface', [['name', ABOUT_MINE_SHADER], ['type', 'surfaceshader']]) },
        ...shown.map((inp) => ({
            k: 'i-' + inp.name, i: 2, b: inp.beat, input: inp.name,
            el: aboutTag('input', [['name', inp.name], ['type', inp.type], ['value', '']], 'self', <span data-in={inp.name}>{aboutFmt(vals[inp.name])}</span>),
        })),
        { k: 's2', i: 1, b: 0, el: aboutTag('standard_surface', [], 'close') },
        { k: 'mt', i: 1, b: 0, el: aboutTag('surfacematerial', [['name', 'M_mine'], ['type', 'material']]) },
        { k: 'mi', i: 2, b: 0, el: aboutTag('input', [['name', 'surfaceshader'], ['type', 'surfaceshader'], ['nodename', ABOUT_MINE_SHADER]], 'self') },
        { k: 'mt2', i: 1, b: 0, el: aboutTag('surfacematerial', [], 'close') },
        { k: 'm2', i: 0, b: 0, el: aboutTag('materialx', [], 'close') },
    ];
    return (
        <pre ref={ref} data-testid="about-source" aria-label={label || 'The document so far'} className={'m-0 py-3 font-mono text-[11.5px] sm:text-[12px] leading-[19px] text-code-fg ' + (className || '')}>
            {lines.map((l) => {
                const isNew = newBeat != null && l.b === newBeat && l.b > 0;
                const lit = l.input && hover === l.input;
                return (
                    <div
                        key={l.k + (isNew ? '-n' + newBeat : '')}
                        data-line={l.input || undefined}
                        onMouseEnter={l.input && onHover ? () => onHover(l.input) : undefined}
                        onMouseLeave={l.input && onHover ? () => onHover(null) : undefined}
                        tabIndex={l.input && onHover ? 0 : undefined}
                        onFocus={l.input && onHover ? () => onHover(l.input) : undefined}
                        onBlur={l.input && onHover ? () => onHover(null) : undefined}
                        className={'pr-3 whitespace-pre-wrap break-words transition-colors '
                            + (isNew ? 'about-line-new ' : '')
                            + (lit ? 'bg-selection/40 shadow-[inset_2px_0_0_rgb(var(--mtlx-accent-base))] ' : isNew ? 'bg-selection/20 shadow-[inset_2px_0_0_rgb(var(--mtlx-accent-base))] ' : '')
                            + (l.input && onHover ? 'cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-base ' : '')}
                        style={{ paddingLeft: 'calc(14px + ' + (l.i * 2 + 4) + 'ch)', textIndent: '-4ch' }}
                    >
                        {l.el}
                    </div>
                );
            })}
        </pre>
    );
}

// The file panel around the source: a file name strip and the lines.
function AboutFilePanel({ children, className, name }) {
    return (
        <div className={'rounded-2xl border border-line-subtle bg-code-block-bg overflow-hidden ' + (className || '')}>
            <div className="h-8 flex items-center gap-2 px-4 border-b border-line-subtle text-[11px] font-mono text-fg-subtle">
                <MtlxIcon name="file-code" className="w-3.5 h-3.5" /> {name || ABOUT_MINE_FILE + '.mtlx'}
            </div>
            {children}
        </div>
    );
}

// The per-slide "try this" cue next to its control.
function AboutCue({ children, i }) {
    return (
        <p className="about-rise flex items-start gap-2 text-[13px] leading-5 text-accent-fg-strong" style={{ '--i': i || 0 }}>
            <MtlxIcon name="sparkles" className="about-cue w-4 h-4 mt-0.5 shrink-0 text-accent-fg" />
            <span>{children}</span>
        </p>
    );
}

function AboutSwatches({ color, onPick, idPrefix }) {
    const hex = aboutLinToHex(color);
    const isPreset = ABOUT_SWATCHES.some((s) => aboutSame(s.lin, color));
    return (
        <div role="group" aria-label="Base color" className="flex flex-wrap items-center gap-2">
            {ABOUT_SWATCHES.map((s) => {
                const on = aboutSame(s.lin, color);
                return (
                    <button key={s.label} type="button" aria-pressed={on} onClick={() => onPick(s.lin)}
                        className={ABOUT_CHIP + ' pl-1.5 pr-3.5 ' + (on ? ABOUT_CHIP_ON : ABOUT_CHIP_OFF)}>
                        <span aria-hidden="true" className="w-6 h-6 rounded-full shrink-0 ring-1 ring-inset ring-line-strong" style={{ backgroundColor: aboutLinToHex(s.lin) }} />
                        <span className="leading-none">{s.label}</span>
                    </button>
                );
            })}
            <label className={'relative cursor-pointer focus-within:ring-2 focus-within:ring-accent-base ' + ABOUT_CHIP + ' pl-1.5 pr-3.5 ' + (!isPreset ? ABOUT_CHIP_ON : ABOUT_CHIP_OFF)}>
                <span aria-hidden="true" className={'w-6 h-6 rounded-full shrink-0 ring-1 ring-inset ring-line-strong flex items-center justify-center ' + (isPreset ? 'bg-surface-sunken text-fg-muted' : '')}
                    style={isPreset ? undefined : { backgroundColor: hex }}>
                    {isPreset && <MtlxIcon name="plus" className="w-3.5 h-3.5" />}
                </span>
                <span className="leading-none">Your own</span>
                <input id={idPrefix + '-custom-color'} type="color" value={hex} aria-label="Mix your own base color"
                    onChange={(e) => onPick(aboutHexToLin(e.target.value))} className="about-swatch-input" />
            </label>
        </div>
    );
}

function AboutSlider({ id, label, code, value, min = 0, max = 1, step = 0.01, onChange, format, hint }) {
    return (
        <label htmlFor={id} className="flex flex-col gap-2 text-sm text-fg-secondary">
            <span className="flex items-baseline justify-between gap-3">
                <span>{label} {code && <code className="text-xs text-fg-subtle">{code}</code>}</span>
                <span className="tabular-nums font-mono text-[13px] text-fg">{format ? format(value) : value.toFixed(2)}</span>
            </span>
            <input id={id} type="range" min={min} max={max} step={step} value={value}
                onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full h-6 accent-accent-base cursor-pointer" />
            {hint && <span className="flex justify-between text-[11px] text-fg-subtle"><span>{hint[0]}</span><span>{hint[1]}</span></span>}
        </label>
    );
}

function AboutSegmented({ label, options, value, onChange }) {
    return (
        <div role="group" aria-label={label} className="inline-flex self-start items-center gap-1 rounded-full border border-line-strong bg-control/60 p-1">
            {options.map((o) => (
                <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}
                    className={'h-9 px-4 rounded-full text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-base '
                        + (value === o.id ? 'bg-accent-fill text-on-accent' : 'text-fg-secondary hover:text-fg hover:bg-hover')}>
                    {o.label}
                </button>
            ))}
        </div>
    );
}

// The document in the real read-only graph (MtlxGraphPreview). Pointing at
// an input row or source line lights both up (scoped :has() rules on React
// Flow's handle ids) and pulses that input on the render.
const aboutPortCss = (name) => (!name || !/^[A-Za-z_][\w]*$/.test(name) ? '' : `
#about-graph-host .react-flow__node div:has(> .react-flow__handle[data-handleid="in:${name}"]) { background-color: rgb(var(--mtlx-selection) / calc(102 / 255)); box-shadow: inset 2px 0 0 rgb(var(--mtlx-accent-base)); }
#about-graph-host .react-flow__node div:has(> .react-flow__handle[data-handleid="in:${name}"]) span { color: rgb(var(--mtlx-fg)); }
#about-graph-host .react-flow__handle[data-handleid="in:${name}"] { box-shadow: 0 0 0 3px rgb(var(--mtlx-accent-base) / calc(140 / 255)); }
`);
function AboutLiveGraph({ xml, hover, onHover, enabled }) {
    const { graphDeps } = useAboutGraphDeps(enabled);
    const portAt = (target) => {
        const node = target && target.closest && target.closest('.react-flow__node');
        if (!node) return null;
        const handles = node.querySelectorAll('.react-flow__handle[data-handleid^="in:"]');
        for (const h of handles) {
            if (h === target || (h.parentElement && h.parentElement.contains(target))) return h.getAttribute('data-handleid').slice(3);
        }
        return null;
    };
    const known = (name) => ABOUT_INPUTS.some((inp) => inp.beat != null && inp.name === name);
    const onOver = (e) => { const name = portAt(e.target); onHover(name && known(name) ? name : null); };
    return (
        <div id="about-graph-host" data-hover={hover || undefined} className="relative min-w-0 h-[260px] lg:h-[300px]"
            onMouseOver={onOver} onMouseLeave={() => onHover(null)}>
            <style>{aboutPortCss(hover)}</style>
            {graphDeps === 'failed' ? (
                <p className="p-4 text-sm text-fg-muted">The node graph could not be loaded.</p>
            ) : graphDeps !== 'ready' || !enabled ? (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-fg-muted motion-safe:animate-pulse">Loading the node graph</div>
            ) : (
                <AboutInsideBoundary>
                    <window.MtlxGraphPreview xml={xml} chrome="card" transparent={false} controls={[]} autoFocus="fit" focusZoom={1.15}
                        lazy={false} height="100%" wheel="none" pan={false} drill={false} label="Your document as a node graph" />
                </AboutInsideBoundary>
            )}
        </div>
    );
}

// The Change slide's material view for an example: graph or highlighted source.
function AboutInside({ label, xml, enabled }) {
    const [tab, setTab] = React.useState('graph');
    const { graphDeps, hlReady } = useAboutGraphDeps(enabled);
    const highlighted = React.useMemo(() => {
        if (!xml || !hlReady || !window.hljs || typeof window.hljs.highlight !== 'function') return null;
        try { return window.hljs.highlight(xml, { language: 'xml' }).value; } catch (e) { return null; }
    }, [xml, hlReady]);
    const tabs = [{ id: 'graph', label: 'Node graph' }, { id: 'source', label: '.mtlx source' }];
    return (
        <div className="min-w-0 flex flex-col rounded-2xl border border-line-subtle bg-surface-raised/70 overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2.5">
                <h3 className="text-sm font-semibold text-fg truncate">{label}, as a document</h3>
                <div role="tablist" aria-label="View" className="flex items-center gap-1 rounded-lg border border-line-subtle p-0.5 shrink-0">
                    {tabs.map((t) => (
                        <button key={t.id} id={'about-inside-tab-' + t.id} type="button" role="tab" aria-selected={tab === t.id} aria-controls="about-inside-panel"
                            onClick={() => setTab(t.id)}
                            className={'h-7 px-2.5 rounded-md text-xs font-medium transition-colors ' + (tab === t.id ? 'bg-selection/25 text-accent-fg-strong' : 'text-fg-muted hover:text-fg hover:bg-hover')}>
                            {t.label}
                        </button>
                    ))}
                </div>
            </div>
            <div id="about-inside-panel" role="tabpanel" className="relative mx-3 mb-3 rounded-xl border border-line-subtle bg-surface-base overflow-hidden h-[230px] lg:h-[260px]">
                {!xml ? (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-fg-muted motion-safe:animate-pulse">Loading {label}</div>
                ) : tab === 'source' ? (
                    <pre data-testid="about-inside-source" data-about-scroll="" className="h-full overflow-auto custom-scrollbar m-0 px-4 py-3 font-mono text-[12px] leading-[18px] text-fg-soft">
                        {highlighted ? <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /> : <code>{xml}</code>}
                    </pre>
                ) : (
                    <div className="h-full">{enabled && <AboutGraph xml={xml} label={label} height="100%" deps={graphDeps} />}</div>
                )}
            </div>
        </div>
    );
}

// The Understand slide for the written material: the spec rows, with the
// inputs it sets marked; pointing at a row pulses that input on the render.
function AboutSpecTable({ mineVals, probe, setProbe }) {
    const used = new Set(ABOUT_INPUTS.filter((i) => i.beat != null).map((i) => i.name));
    return (
        <div className="rounded-2xl border border-line-subtle bg-surface-raised/70 overflow-hidden">
            <div className="px-4 pt-3 pb-2 flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold text-fg"><span className="text-accent-fg">Standard Surface</span> inputs</h3>
                <span className="text-[11px] text-fg-subtle">Yours are marked</span>
            </div>
            <table className="w-full text-left text-[12.5px]">
                <thead>
                    <tr className="text-[11px] uppercase tracking-[0.08em] text-fg-subtle">
                        <th scope="col" className="px-4 py-1.5 font-semibold">Input</th>
                        <th scope="col" className="px-2 py-1.5 font-semibold">Default</th>
                        <th scope="col" className="px-4 py-1.5 font-semibold">Yours</th>
                    </tr>
                </thead>
                <tbody>
                    {ABOUT_SPEC_ROWS.map((r) => {
                        const mineHas = used.has(r.name);
                        const on = probe === r.name;
                        return (
                            <tr key={r.name} data-spec-row={r.name}
                                onMouseEnter={() => setProbe(r.name)} onMouseLeave={() => setProbe(null)}
                                className={'border-t border-line-subtle align-top transition-colors ' + (on ? 'about-pulse-row' : mineHas ? 'bg-selection/10' : '')}>
                                <th scope="row" className={'px-4 py-1.5 font-normal ' + (mineHas ? 'shadow-[inset_2px_0_0_rgb(var(--mtlx-accent-base))]' : '')}>
                                    <button type="button" aria-pressed={on} onClick={() => setProbe(on ? null : r.name)}
                                        onFocus={() => setProbe(r.name)} onBlur={() => setProbe(null)}
                                        className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-base rounded">
                                        <code className={'font-mono ' + (mineHas ? 'text-accent-fg-strong' : 'text-fg-secondary')}>{r.name}</code>
                                        <span className="ml-1.5 text-[11px] text-fg-subtle">{r.type}</span>
                                        <span className="block xl:inline xl:ml-2 text-[12px] leading-4 mt-0.5 text-fg-muted font-sans">{r.text}</span>
                                    </button>
                                </th>
                                <td className="px-2 py-1.5 font-mono text-fg-subtle whitespace-nowrap">{r.def}</td>
                                <td className="px-4 py-1.5 font-mono whitespace-nowrap text-fg">{mineHas ? aboutFmt(mineVals[r.name]) : <span className="text-fg-faint">-</span>}</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

// The Understand slide for an example: what its shader node does and the
// inputs the document sets on it.
function AboutNodeCard({ material, xml }) {
    const outline = React.useMemo(() => (xml ? aboutOutline(xml) : null), [xml]);
    return (
        <div className="flex flex-col gap-2 rounded-2xl border border-line-subtle bg-surface-raised/70 px-4 py-3.5">
            <h3 className="text-sm font-semibold text-fg">
                <span className="text-accent-fg">{(outline && outline.shaderLabel) || ABOUT_SHADER_LABELS[material.shader]}</span>
                {outline && outline.shaderName && <span className="text-fg-subtle font-normal">, named {outline.shaderName} here</span>}
            </h3>
            <p className="text-[13.5px] leading-5 text-fg-muted">{ABOUT_SHADER_TEXT[material.shader]}</p>
            {outline && outline.inputs.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                    {outline.inputs.map((p) => (
                        <li key={p.name} className="text-[12px] font-mono rounded-md border border-line-subtle bg-surface-base px-1.5 py-0.5 text-fg-secondary">
                            {p.name} <span className="text-fg-subtle">{p.value}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

// The Share slide's snippet, the same element the Embed Builder emits.
function AboutSnippet({ carried }) {
    const [copied, setCopied] = React.useState(false);
    const site = (window.SITE_LINKS && window.SITE_LINKS.site) || '';
    const src = carried.kind === 'example'
        ? window.MtlxAssets.publicRepoUrl('resources/Materials/Examples/' + carried.m.path)
        : ABOUT_MINE_FILE + '.mtlx';
    const code = '<script src="' + site + 'embed/mtlx-viewer.js"></script>\n<materialx-viewer src="' + src + '"></materialx-viewer>';
    const copy = () => {
        try {
            navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
        } catch (e) { /* clipboard unavailable */ }
    };
    return (
        <div className="relative rounded-2xl border border-line-subtle bg-code-block-bg overflow-hidden">
            <pre data-testid="about-snippet" className="m-0 px-4 py-3 pr-12 font-mono text-[12px] leading-[18px] text-fg-soft whitespace-pre-wrap break-all">{code}</pre>
            <button type="button" onClick={copy} aria-label={copied ? 'Copied' : 'Copy the snippet'}
                className="absolute top-2 right-2 w-8 h-8 inline-flex items-center justify-center rounded-md text-fg-muted hover:text-fg hover:bg-hover transition-colors">
                <MtlxIcon name={copied ? 'check' : 'copy'} className="w-4 h-4" />
            </button>
        </div>
    );
}

// The one live render. Builds on first activation, sleeps while the view is
// hidden, rebuilds after a context restore, and runs one rAF director that
// drives the written material's uniforms, the camera and the light per slide.
function AboutStage({ active, idx, slide, geom: wantGeom, mine, light, probe, touchedRef, editValues, onFailed, apiRef, tickersRef, poseStyle, carried, wide }) {
    const canvasRef = React.useRef(null);
    const viewRef = React.useRef(null);
    const docsRef = React.useRef(new Map());
    const queueRef = React.useRef(Promise.resolve());
    const tokenRef = React.useRef(0);
    const mountedRef = React.useRef(true);
    const activeRef = React.useRef(active);
    activeRef.current = active;
    const slideRef = React.useRef(slide);
    slideRef.current = slide;
    const mineRef = React.useRef(mine);
    mineRef.current = mine;
    const lightRef = React.useRef(light);
    lightRef.current = light;
    const probeRef = React.useRef(null);
    const editRef = React.useRef(editValues);
    editRef.current = editValues;
    const busyRef = React.useRef(false);
    // Compare: the camera freezes at the pose the still was captured from,
    // or the easing keeps moving the live half a pixel away from it.
    const holdCamRef = React.useRef(false);
    const studioRef = React.useRef(null);
    const envNowRef = React.useRef('default');
    const statsRef = React.useRef({ builds: 0, applies: 0, envSwaps: 0 });
    const dirRef = React.useRef({ vals: aboutTargets(99, mine), live: {} });
    const [epoch, setEpoch] = React.useState(0);
    const [viewRev, setViewRev] = React.useState(0);
    const [status, setStatus] = React.useState(() => ((window.mtlxHasWebGL2 ? window.mtlxHasWebGL2() : true) ? 'loading' : 'failed'));
    const [swapError, setSwapError] = React.useState(null);
    const [pending, setPending] = React.useState(null);
    const [shownIdx, setShownIdx] = React.useState(idx);
    const shownIdxRef = React.useRef(shownIdx);
    shownIdxRef.current = shownIdx;
    const [reduced, setReduced] = React.useState(aboutReducedMotion);
    const reducedRef = React.useRef(reduced);
    reducedRef.current = reduced;
    // Heavy reactions (a geometry rebuild, a light swap, a capture) wait until a slide settles.
    const [settled, setSettled] = React.useState(slide.id);
    const [compare, setCompare] = React.useState(null);
    const [split, setSplit] = React.useState(50);
    const [splitTouched, setSplitTouched] = React.useState(false);
    const readyRef = React.useRef(false);
    const failed = status === 'failed';
    // A shape change rebuilds the view, so it waits until the deck rests.
    const [geom, setGeom] = React.useState(wantGeom);
    React.useEffect(() => {
        if (wantGeom === geom) return undefined;
        const t = setTimeout(() => setGeom(wantGeom), 450);
        return () => clearTimeout(t);
    }, [wantGeom, geom]);
    const keyOf = (i) => (i < 0 ? 'mine' : ABOUT_MATERIALS[i].path);
    const labelOf = (i) => (i < 0 ? 'Your material' : ABOUT_MATERIALS[i].label);

    React.useEffect(() => {
        if (probe !== (probeRef.current && probeRef.current.name)) probeRef.current = probe ? { name: probe, t0: performance.now() } : null;
    }, [probe]);

    React.useEffect(() => { if (failed && onFailed) onFailed(); }, [failed]);

    React.useEffect(() => {
        if (slide.id === settled) return undefined;
        const t = setTimeout(() => setSettled(slide.id), 420);
        return () => clearTimeout(t);
    }, [slide.id, settled]);

    // Parsed documents, one per material, kept for instant swaps back.
    const loadDoc = async (key) => {
        const cached = docsRef.current.get(key);
        if (cached) return cached;
        const env = await getMxEnv();
        const text = key === 'mine' ? ABOUT_MINE_COMPILE_XML : await fetchAboutXml(ABOUT_MATERIALS.find((m) => m.path === key));
        const doc = env.mx.createDocument();
        await readMtlxXml(env.mx, doc, text);
        if (typeof doc.setDataLibrary === 'function') doc.setDataLibrary(env.stdlib);
        else doc.importLibrary(env.stdlib);
        const renderables = listDocRenderables(doc);
        if (!renderables.length) throw new Error('No renderable material in ' + key);
        const entry = { env, doc, renderable: renderables[0] };
        docsRef.current.set(key, entry);
        return entry;
    };
    const applyDoc = async (view, key) => {
        const { env, renderable } = await loadDoc(key);
        statsRef.current.applies++;
        const done = await view.applyMaterial({
            mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: renderable.node,
            label: 'about-stage', materialName: renderable.name, isMounted: () => mountedRef.current,
        });
        if (done !== null) { view.__aboutKey = key; view.__aboutU = null; dirRef.current.forcePush = true; }
        return done !== null;
    };
    const defaultEnv = async () => (window.getEnvOverride && window.getEnvOverride()) || window.getEnvironment();
    const loadStudio = () => {
        if (!studioRef.current) {
            studioRef.current = fetch(ABOUT_STUDIO_ENV)
                .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
                .then((buf) => window.loadEnvironmentFromBuffer(buf, '.exr', 'studio light', false));
            studioRef.current.catch((e) => { console.warn('[about] studio light failed', e); });
        }
        return studioRef.current;
    };
    const applyEnv = async (view, want) => {
        if (!view || !view.setEnvironment) return;
        const env = want === 'studio' ? await loadStudio().catch(() => null) : await defaultEnv();
        if (!env || viewRef.current !== view || !mountedRef.current) return;
        view.setEnvironment(env);
        view.__aboutEnv = want;
        envNowRef.current = want;
        dirRef.current.live.env = want;
        statsRef.current.envSwaps++;
    };

    // Serialized builds: each request runs after the previous one and is
    // skipped when a newer request (a pick, a restore, a shape) superseded it.
    React.useEffect(() => {
        if (failed || !active) return;
        const token = ++tokenRef.current;
        const key = keyOf(idx);
        const latest = () => mountedRef.current && token === tokenRef.current;
        const live0 = viewRef.current;
        const fresh = (v) => v && v.__aboutEpoch === epoch && v.__aboutGeom === geom;
        const needsWork = !(fresh(live0) && live0.__aboutKey === key);
        if (needsWork) setPending({ label: labelOf(idx), phase: docsRef.current.has(key) || key === 'mine' ? 'build' : 'fetch' });
        queueRef.current = queueRef.current.then(async () => {
            if (!latest()) return;
            try {
                const { env, renderable } = await loadDoc(key);
                if (!latest()) return;
                if (needsWork) setPending({ label: labelOf(idx), phase: 'build' });
                const live = viewRef.current;
                if (fresh(live)) {
                    if (live.__aboutKey !== key) await applyDoc(live, key);
                } else {
                    if (live) { live.release(); viewRef.current = null; window.__mtlxAboutHandle = null; }
                    statsRef.current.builds++;
                    const shapeDef = ABOUT_SHAPES.find((sh) => sh.id === geom);
                    const shapeModel = (shapeDef && shapeDef.model) || null;
                    const view = await createMtlxRenderView({
                        canvas: canvasRef.current,
                        mx: env.mx, gen: env.gen, genContext: env.genContext,
                        renderable: renderable.node, lightData: env.lightData,
                        label: 'about-stage', materialName: renderable.name,
                        needsLighting: true, geomName: shapeModel ? 'sphere' : geom, modelUrl: shapeModel,
                        autoRotate: false, backdrop: 'none', wheelMode: 'none',
                        maxPixelRatio: 1.5,
                        isMounted: () => mountedRef.current,
                        isActive: () => activeRef.current,
                    });
                    if (!view) return;
                    if (!mountedRef.current) { view.release(); return; }
                    view.__aboutEpoch = epoch;
                    view.__aboutGeom = geom;
                    view.__aboutKey = key;
                    view.__aboutEnv = 'default';
                    // The slide cameras are tuned on the shader ball; other shapes use the engine's own framing distance.
                    const c0 = view.getCamera && view.getCamera();
                    view.__aboutD = geom !== 'shaderball' && c0 ? Math.hypot(c0.position[0] - c0.target[0], c0.position[1] - c0.target[1], c0.position[2] - c0.target[2]) || 2.072 : 2.072;
                    // The director flies the camera closer than the viewer's own floor.
                    if (view.controls) { view.controls.minDistance = 0.3; view.controls.maxDistance = 12; }
                    view.setAutoRotate(false);
                    view.setActive(activeRef.current);
                    viewRef.current = view;
                    dirRef.current.forcePush = true;
                    dirRef.current.camInit = false;
                    dirRef.current.envA = null;
                    dirRef.current.envX = null;
                    // Test seam, like the viewer's __mtlxViewerHandle.
                    window.__mtlxAboutHandle = view;
                }
                if (key !== 'mine' && ABOUT_MATERIALS[idx] && ABOUT_MATERIALS[idx].path === key) aboutPushEdits(viewRef.current, ABOUT_MATERIALS[idx], editRef.current);
                readyRef.current = true;
                if (latest()) setShownIdx(idx);
                setSwapError(null);
                setStatus('ready');
                setViewRev((n) => n + 1);
                if (latest()) setPending(null);
            } catch (e) {
                console.warn('[about] live stage failed', e);
                if (!mountedRef.current) return;
                if (latest()) setPending(null);
                if (readyRef.current) {
                    setSwapError(labelOf(idx));
                } else {
                    if (viewRef.current) { viewRef.current.release(); viewRef.current = null; }
                    setStatus('failed');
                }
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, idx, epoch, failed, geom]);

    // The contrast light loads once, in idle time after the first frame.
    React.useEffect(() => {
        if (status !== 'ready') return undefined;
        const t = setTimeout(() => loadStudio(), 1200);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status]);

    // The light is the visitor's pick on every slide: it changes only when they press a light button.
    const wantEnv = light.env;
    React.useEffect(() => {
        const v = viewRef.current;
        if (!active || !v || v.__aboutEnv === wantEnv) return;
        applyEnv(v, wantEnv);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wantEnv, viewRev, active]);

    // Hidden view: the explicit sleep stops the render loop and parks the
    // drawing buffer; the engine's context cap may then reclaim the context.
    React.useEffect(() => {
        if (viewRef.current) viewRef.current.setActive(!!active);
    }, [active]);

    // A restored context keeps GL state but not render targets: rebuild.
    React.useEffect(() => {
        const onGl = (e) => {
            const d = e.detail || {};
            if (d.canvas && d.canvas === canvasRef.current && d.state === 'restored') setEpoch((n) => n + 1);
        };
        window.addEventListener('mtlx-gl-context', onGl);
        return () => window.removeEventListener('mtlx-gl-context', onGl);
    }, []);

    React.useEffect(() => {
        let mql = null;
        try { mql = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { return undefined; }
        const onChange = () => setReduced(mql.matches);
        if (mql.addEventListener) mql.addEventListener('change', onChange);
        return () => { if (mql.removeEventListener) mql.removeEventListener('change', onChange); };
    }, []);

    // The director: one rAF loop that writes uniforms, the camera, the
    // light and the source tickers; it reads no layout.
    React.useEffect(() => {
        if (!active || failed) return undefined;
        let raf = 0;
        const d = dirRef.current;
        d.last = 0;
        const ease = (dt, tau) => (reducedRef.current || tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));
        const tick = (t) => {
            raf = requestAnimationFrame(tick);
            const dt = d.last ? Math.min(0.05, (t - d.last) / 1000) : 1 / 60;
            d.last = t;
            const view = viewRef.current;
            const S = slideRef.current;
            const red = reducedRef.current;
            if (d.sid !== S.id) {
                d.sid = S.id;
                d.base = d.az != null ? d.az : 0;
                d.sceneT = 0;
            }
            d.sceneT += dt;
            const pr = probeRef.current;
            // Values: the written material eases toward this slide's targets.
            if (view && view.__aboutKey === 'mine' && !busyRef.current) {
                const tgt = aboutTargets(S.beat, mineRef.current);
                const direct = {};
                // First visit to roughness: sweep mirror -> brushed -> the visitor's value.
                if (S.id === 'rough' && !touchedRef.current.rough && !red) {
                    const u = d.sceneT - 0.5;
                    const r = mineRef.current.rough;
                    if (u > 0 && u < 3.4) {
                        direct.specular_roughness = u < 0.5 ? aboutLerp(0.2, 0, aboutSmooth(0, 0.5, u))
                            : u < 2 ? aboutLerp(0, 0.85, aboutSmooth(0.5, 2, u)) : aboutLerp(0.85, r, aboutSmooth(2, 3.4, u));
                    }
                }
                if (pr) {
                    const cur = tgt[pr.name];
                    const alt = aboutSame(cur, ABOUT_DEFAULTS[pr.name]) ? ABOUT_PROBE_DEMO[pr.name] : ABOUT_DEFAULTS[pr.name];
                    const w = red ? 1 : 0.5 - 0.5 * Math.cos(((t - pr.t0) / 1800) * Math.PI * 2);
                    direct[pr.name] = aboutLerp(cur, alt, w);
                    if (pr.name === 'coat_roughness' && tgt.coat < 0.5) direct.coat = 1;
                }
                const k = ease(dt, 0.18);
                let changed = !!d.forcePush;
                ABOUT_INPUTS.forEach(({ name }) => {
                    const cur = d.vals[name];
                    const goal = tgt[name];
                    if (direct[name] != null) {
                        d.vals[name] = direct[name];
                        changed = true;
                    } else if (Array.isArray(goal)) {
                        const next = cur.map((c, i) => c + (goal[i] - c) * k);
                        if (next.some((c, i) => Math.abs(c - cur[i]) > 1e-5)) { d.vals[name] = next; changed = true; }
                    } else {
                        const next = cur + (goal - cur) * k;
                        if (Math.abs(next - cur) > 1e-5) { d.vals[name] = next; changed = true; }
                    }
                });
                if (changed) {
                    aboutPushMine(view, d.vals);
                    d.forcePush = false;
                    if (tickersRef) tickersRef.current.forEach((fn) => fn(d.vals));
                }
            }
            // Camera: spherical pose around a target, eased per slide.
            if (view && view.setCamera && !busyRef.current && !holdCamRef.current) {
                if (view.isInteracting && view.isInteracting()) {
                    d.held = true;
                } else {
                    if (d.held || !d.camInit) {
                        const c = view.getCamera && view.getCamera();
                        if (c) {
                            const dx = c.position[0] - c.target[0], dy = c.position[1] - c.target[1], dz = c.position[2] - c.target[2];
                            d.dist = Math.max(0.3, Math.hypot(dx, dy, dz));
                            d.el = Math.asin(Math.max(-1, Math.min(1, dy / d.dist)));
                            d.az = Math.atan2(dx, dz);
                            d.t = c.target.slice();
                            d.base = d.az;
                        }
                        d.held = false;
                        d.camInit = true;
                    }
                    const c = S.cam;
                    const comparing = S.id === 'compare';
                    const spin = red || comparing ? 0 : c.spin;
                    d.spinV = (d.spinV || 0) + (spin - (d.spinV || 0)) * ease(dt, 0.8);
                    d.base += d.spinV * dt;
                    let azGoal = d.base + (c.daz || 0);
                    if (c.abs != null) {
                        azGoal = c.abs + Math.round((d.az - c.abs) / (Math.PI * 2)) * Math.PI * 2;
                        d.base = d.az;
                    }
                    const dist = Math.max(c.minDist || 0, (view.__aboutD || 2.072) * c.dist);
                    const tgt = c.t || [0, 0, 0];
                    const k = ease(dt, c.tau);
                    d.az += (azGoal - d.az) * k;
                    d.el += (c.el - d.el) * k;
                    d.dist += (dist - d.dist) * k;
                    d.t = d.t.map((x, i) => x + (tgt[i] - x) * k);
                    view.setCamera(aboutPoseToCamera(d.az, d.el, d.dist, d.t));
                }
            }
            // Light: it turns only while the visitor plays it on Look, and otherwise
            // holds the angle and brightness they last set, on every slide.
            if (view && view.setEnvRotation && !busyRef.current) {
                const L = lightRef.current;
                const a0 = d.envA == null ? 0 : d.envA;
                let a = a0;
                if (L.spin && S.id === 'look') a = a0 + 0.35 * dt;
                else {
                    const want = L.rot == null ? 0 : L.rot;
                    const goal = want + Math.round((a0 - want) / (Math.PI * 2)) * Math.PI * 2;
                    a = a0 + (goal - a0) * ease(dt, 0.12);
                }
                if (d.envA == null || Math.abs(a - a0) > 1e-5) { d.envA = a; view.setEnvRotation(a); }
                const xGoal = L.exposure;
                const x0 = d.envX == null ? 1 : d.envX;
                const x = x0 + (xGoal - x0) * ease(dt, 0.15);
                if (d.envX == null || Math.abs(x - x0) > 1e-5) { d.envX = x; if (view.setEnvExposure) view.setEnvExposure(x); }
            }
            const Lv = d.live;
            Lv.slide = S.id;
            Lv.beat = S.beat;
            Lv.camera = d.az != null ? { az: +d.az.toFixed(3), el: +d.el.toFixed(3), dist: +d.dist.toFixed(3), target: d.t.map((c) => +c.toFixed(3)), spin: +(d.spinV || 0).toFixed(3) } : null;
            Lv.envAngle = d.envA != null ? +d.envA.toFixed(3) : null;
            Lv.exposure = d.envX != null ? +d.envX.toFixed(3) : null;
            Lv.values = d.vals;
            Lv.probe = pr ? pr.name : null;
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, failed]);

    // An example's Change edits go straight into its uniforms.
    React.useEffect(() => {
        if (idx >= 0 && shownIdx === idx) aboutPushEdits(viewRef.current, ABOUT_MATERIALS[idx], editValues);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editValues, viewRev, shownIdx]);

    // Compare: once the camera holds still, capture the other side on this
    // same view and lay it over the live render behind a split line. The
    // written material's other side is its own defaults: no recompile.
    const compareReady = settled === 'compare' && slide.id === 'compare' && active && status === 'ready' && !pending && shownIdx === idx;
    React.useEffect(() => {
        if (!compareReady) { holdCamRef.current = false; setCompare(null); return undefined; }
        let cancelled = false;
        queueRef.current = queueRef.current.then(async () => {
            const view = viewRef.current;
            if (cancelled || !view || !view.snapshot) return;
            const i = shownIdxRef.current;
            try {
                await aboutWait(reducedRef.current ? 50 : 700);
                if (cancelled) return;
                let still = null;
                let names = null;
                busyRef.current = true;
                holdCamRef.current = true;
                try {
                    if (i < 0) {
                        aboutPushMine(view, ABOUT_DEFAULTS);
                        still = view.snapshot();
                        names = ['Yours', 'Where you started'];
                    } else {
                        const m = ABOUT_MATERIALS[i];
                        const p = ABOUT_MATERIALS[m.pair];
                        setCompare({ phase: 'prep', freeze: view.snapshot() });
                        try {
                            if (await applyDoc(view, p.path)) { await aboutFrames(2); still = view.snapshot(); }
                        } finally {
                            if (viewRef.current === view && view.__aboutKey !== m.path) await applyDoc(view, m.path);
                            aboutPushEdits(view, m, editRef.current);
                            await aboutFrames(2);
                        }
                        names = [m.label, p.label];
                    }
                } finally {
                    if (i < 0) aboutPushMine(view, dirRef.current.vals);
                    busyRef.current = false;
                }
                if (cancelled) return;
                setSplit(reducedRef.current ? 50 : 100);
                setSplitTouched(false);
                setCompare(still ? { phase: 'ready', still, a: names[0], b: names[1] } : null);
                if (!reducedRef.current && still) requestAnimationFrame(() => requestAnimationFrame(() => setSplit(50)));
            } catch (e) {
                console.warn('[about] compare capture failed', e);
                holdCamRef.current = false;
                if (!cancelled) setCompare(null);
            }
        });
        return () => { cancelled = true; holdCamRef.current = false; setCompare(null); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [compareReady, idx]);

    // Stills for the Anywhere frames: three set angles, captured in one go.
    React.useEffect(() => {
        if (!apiRef) return undefined;
        apiRef.current = {
            capture: async () => {
                const view = viewRef.current;
                if (!view || !view.snapshot || status !== 'ready' || busyRef.current) return null;
                busyRef.current = true;
                const saved = view.getCamera && view.getCamera();
                try {
                    if (view.__aboutKey === 'mine') aboutPushMine(view, aboutTargets(99, mineRef.current));
                    return ABOUT_SHOT_POSES.map((s) => {
                        view.setCamera(aboutPoseToCamera(s.az, s.el, (view.__aboutD || 2.072) * s.dist, [0, 0, 0]));
                        return view.snapshot();
                    });
                } catch (e) {
                    console.warn('[about] stills failed', e);
                    return null;
                } finally {
                    if (saved) view.setCamera(saved);
                    if (view.__aboutKey === 'mine') aboutPushMine(view, dirRef.current.vals);
                    busyRef.current = false;
                }
            },
            ready: () => status === 'ready' && !pending,
            // The light's current angle in [0, 2pi), for pausing the turn where it is.
            envAngle: () => {
                const a = dirRef.current.envA || 0;
                const t = Math.PI * 2;
                return ((a % t) + t) % t;
            },
        };
        return () => { apiRef.current = null; };
    }, [apiRef, status, pending]);

    React.useEffect(() => () => {
        mountedRef.current = false;
        if (viewRef.current) { viewRef.current.release(); viewRef.current = null; }
        if (window.__mtlxAboutHandle) window.__mtlxAboutHandle = null;
        if (studioRef.current) studioRef.current.then((env) => window.MtlxRender && window.MtlxRender.disposeFetchedEnv(env), () => {});
    }, []);

    const shownLabel = labelOf(shownIdx);
    const firstLoad = status !== 'ready';
    const pendingText = pending ? (pending.phase === 'fetch' ? 'Fetching ' + pending.label : 'Building the ' + pending.label + ' shader') : '';
    const comparing = compare && compare.phase === 'ready' && slide.id === 'compare';

    // Test seam: the deck's state next to the live handle.
    window.__mtlxAboutState = {
        slide: slide.id, settled, material: shownLabel, requested: labelOf(idx),
        geom, compare: compare ? compare.phase : null, split, status, reduced, env: envNowRef.current,
        live: dirRef.current.live, stats: statsRef.current, pending: !!pending,
    };

    return (
        <div className="about-stage" data-testid="about-stage" style={{ width: 'var(--about-h)', height: 'var(--about-h)', '--about-s': poseStyle.scale || 1, transform: poseStyle.transform, opacity: poseStyle.opacity, pointerEvents: poseStyle.opacity ? 'auto' : 'none' }}>
            {/* A soft glow behind the ball; no frame, the page is the backdrop */}
            <div aria-hidden="true" className="absolute inset-0 pointer-events-none"
                style={{ backgroundImage: 'radial-gradient(circle at 50% 50%, rgb(var(--mtlx-accent-wash) / calc(44 / 255)), transparent 62%)' }} />
            <div className="absolute inset-0" role={failed ? undefined : 'img'}
                aria-label={failed ? undefined : 'Live 3D preview of ' + (shownIdx < 0 ? 'your material' : shownLabel) + '. Drag to turn it.'}>
                {failed ? (
                    <img src="images/preview-material.jpg" alt="The Material Viewer rendering a material on a shader ball"
                        className="absolute inset-[12%] w-[76%] h-[76%] object-cover rounded-full"
                        style={{ WebkitMaskImage: 'radial-gradient(circle, black 46%, transparent 66%)', maskImage: 'radial-gradient(circle, black 46%, transparent 66%)' }} />
                ) : (
                    <>
                        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block cursor-grab active:cursor-grabbing" />
                        {compare && compare.phase === 'prep' && compare.freeze && slide.id === 'compare' && (
                            <img src={compare.freeze} alt="" aria-hidden="true" className="absolute inset-0 w-full h-full" />
                        )}
                        {comparing && (
                            <div data-testid="about-compare" className="absolute inset-0">
                                <img src={compare.still} alt="" aria-hidden="true" className="absolute inset-0 w-full h-full pointer-events-none"
                                    style={{ clipPath: 'inset(0 0 0 ' + split + '%)', transition: reduced || splitTouched ? 'none' : 'clip-path 900ms cubic-bezier(.2,.7,.2,1)' }} />
                                <div aria-hidden="true" className="absolute top-[8%] bottom-[8%] w-0.5 -ml-px bg-accent-base pointer-events-none"
                                    style={{ left: split + '%', transition: reduced || splitTouched ? 'none' : 'left 900ms cubic-bezier(.2,.7,.2,1)' }}>
                                    <span style={{ transform: 'translate(-50%, -50%) scale(calc(1 / var(--about-s)))' }} className="absolute top-1/2 left-1/2 w-10 h-10 rounded-full border-2 border-accent-base bg-surface-base text-accent-fg flex items-center justify-center shadow-lg shadow-shadow/30">
                                        <MtlxIcon name="switch-horizontal" className="w-4 h-4" />
                                    </span>
                                </div>
                                <span className="absolute top-[9%] left-[10%] font-semibold text-fg pointer-events-none" style={{ fontSize: 'calc(14px / var(--about-s))' }}>{compare.a}</span>
                                <span className="absolute top-[9%] right-[10%] font-semibold text-fg pointer-events-none" style={{ fontSize: 'calc(14px / var(--about-s))' }}>{compare.b}</span>
                                <input id="about-compare-split" type="range" min="0" max="100" step="1" value={split}
                                    onChange={(e) => { setSplitTouched(true); setSplit(parseFloat(e.target.value)); }}
                                    aria-label={'Split between ' + compare.a + ' and ' + compare.b}
                                    className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize" />
                            </div>
                        )}
                        {pending && (
                            <div data-testid="about-stage-loading" className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center gap-2.5">
                                <span aria-hidden="true" className={'rounded-full border-2 border-fg-subtle/30 border-t-accent-base motion-safe:animate-spin ' + (firstLoad ? 'w-9 h-9' : 'w-5 h-5')} />
                                <span className="text-fg-muted" style={{ fontSize: 'calc(12px / var(--about-s))' }}>{pendingText}</span>
                            </div>
                        )}
                    </>
                )}
            </div>
            <p className="sr-only" aria-live="polite">{failed ? '' : pendingText}</p>
            {swapError && <p role="status" className="absolute left-[10%] right-[10%] bottom-[6%] text-xs text-fg-muted text-center">{swapError} could not be loaded, so the previous material stays on the stage.</p>}
        </div>
    );
}

// The finale: the finished material inside three hosts, drawn with CSS.
function AboutHost({ kind, shot, d, carried }) {
    const img = shot
        ? <img src={shot} alt="" className="absolute inset-0 w-full h-full object-contain" />
        : <img src="images/preview-material.jpg" alt="" className="absolute inset-0 w-full h-full object-cover opacity-80" />;
    const dots = (
        <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-line-strong" />
            <span className="w-2.5 h-2.5 rounded-full bg-line-strong" />
            <span className="w-2.5 h-2.5 rounded-full bg-line-strong" />
        </span>
    );
    const fileName = (carried.kind === 'mine' ? ABOUT_MINE_FILE : carried.name) + '.mtlx';
    const hosts = {
        web: {
            href: '#!builder', title: 'In the browser', icon: 'world',
            text: 'Any WebGL2 browser, nothing to install. The Embed Builder puts it on your own pages too.',
            cta: 'Embed it on a page', go: () => aboutOpenInBuilder(carried),
            frame: (
                <>
                    <div className="h-8 flex items-center gap-3 px-3 border-b border-line-subtle bg-surface-raised">
                        {dots}
                        <span className="h-5 flex-1 rounded-md bg-surface-sunken text-[10px] leading-5 px-2 text-fg-subtle truncate">your-site.example/materials</span>
                    </div>
                    <div className="relative flex-1 bg-surface-base">{img}</div>
                </>
            ),
        },
        vscode: {
            href: '#!vscode', title: 'In VS Code', icon: 'brand-vscode',
            text: 'Open a .mtlx file and the preview sits beside the text, with hover docs and validation.',
            cta: 'Get the extension',
            frame: (
                <>
                    <div className="h-8 flex items-center gap-3 px-3 border-b border-line-subtle bg-surface-raised">
                        {dots}
                        <span className="h-6 mt-2 px-2.5 rounded-t-md bg-surface-base border border-b-0 border-line-subtle text-[10px] leading-6 font-mono text-fg-secondary truncate">{fileName}</span>
                    </div>
                    <div className="flex-1 grid grid-cols-[42%_minmax(0,1fr)] min-h-0">
                        <div className="bg-code-block-bg border-r border-line-subtle px-2.5 py-2 flex flex-col gap-1.5 overflow-hidden" aria-hidden="true">
                            {[70, 88, 64, 92, 80, 58, 86, 52].map((w, i) => (
                                <span key={i} className={'h-1.5 rounded ' + (i % 3 === 1 ? 'bg-accent-fg/50' : 'bg-line-strong')} style={{ width: w + '%', marginLeft: (i > 1 && i < 7 ? 10 : 0) + '%' }} />
                            ))}
                        </div>
                        <div className="relative bg-surface-base">{img}</div>
                    </div>
                </>
            ),
        },
        desktop: {
            href: '#!desktop', title: 'On the desktop', icon: 'device-desktop',
            text: 'An app for Windows, macOS and Linux that makes no network requests at all.',
            cta: 'Download the app',
            frame: (
                <>
                    <div className="h-8 flex items-center justify-between gap-3 px-3 border-b border-line-subtle bg-surface-raised">
                        <span className="text-[11px] font-medium text-fg-secondary truncate">MaterialX Playground</span>
                        <span aria-hidden="true" className="flex items-center gap-2.5 text-fg-subtle">
                            <span className="w-2.5 h-px bg-fg-subtle" />
                            <span className="w-2.5 h-2.5 border border-fg-subtle" />
                            <MtlxIcon name="x" className="w-3 h-3" />
                        </span>
                    </div>
                    <div className="flex-1 grid grid-cols-[24%_minmax(0,1fr)] min-h-0">
                        <div className="bg-surface-raised border-r border-line-subtle px-2 py-2 flex flex-col gap-1.5" aria-hidden="true">
                            {[80, 64, 72, 56].map((w, i) => <span key={i} className={'h-1.5 rounded ' + (i === 0 ? 'bg-accent-fg/50' : 'bg-line-strong')} style={{ width: w + '%' }} />)}
                        </div>
                        <div className="relative bg-surface-base">{img}</div>
                    </div>
                </>
            ),
        },
    };
    const h = hosts[kind];
    return (
        <li className="about-host min-w-0 flex flex-col gap-3" style={{ '--d': d + 'ms' }}>
            <a href={h.href} onClick={aboutOnLinkClick(h.go)} data-about-link={'host-' + kind}
                className="group block rounded-2xl border border-line-strong bg-surface-base overflow-hidden shadow-xl shadow-shadow/30 hover:border-accent-base transition-colors"
                aria-label={h.title + ': ' + h.cta}>
                <div className="flex flex-col aspect-[16/10]">{h.frame}</div>
            </a>
            <div className="flex flex-col gap-1">
                <h3 className="flex items-center gap-2 text-[13px] sm:text-base font-semibold text-fg">
                    <MtlxIcon name={h.icon} className="hidden sm:block w-5 h-5 text-accent-fg" /> {h.title}
                </h3>
                <p className="hidden md:block text-[14px] leading-6 text-fg-muted">{h.text}</p>
                <a href={h.href} onClick={aboutOnLinkClick(h.go)} data-about-link={'host-' + kind + '-cta'} className="self-start inline-flex items-center gap-1.5 text-[12px] sm:text-sm font-medium text-accent-fg hover:text-accent-fg-strong transition-colors">
                    {h.cta} <MtlxIcon name="arrow-right" className="w-3.5 h-3.5" />
                </a>
            </div>
        </li>
    );
}

const ABOUT_EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.12em] text-accent-fg-strong';
const ABOUT_H2 = 'text-[28px] sm:text-[34px] lg:text-[40px] leading-[1.08] font-bold tracking-[-0.02em] text-fg focus:outline-none';
const ABOUT_BODY = 'text-[15px] sm:text-base leading-7 text-fg-muted max-w-[36em]';

// A slide heading: the focus target on arrival.
function AboutHeading({ s, children, className }) {
    return <h2 id={'about-s-' + s.id + '-h'} tabIndex={-1} className={'about-rise ' + (className || ABOUT_H2)} style={{ '--i': 0 }}>{children}</h2>;
}
// The eyebrow over a tool slide: the tour's part, the tool's name.
function AboutToolHead({ s }) {
    return (
        <div className="about-rise flex flex-wrap items-center gap-x-3 gap-y-2" style={{ '--i': 0 }}>
            <span className="w-10 h-10 rounded-2xl border border-accent-base/50 bg-selection/20 text-accent-fg-strong flex items-center justify-center shrink-0" aria-hidden="true">
                <MtlxIcon name={s.icon} className="w-5 h-5" />
            </span>
            <span className="flex flex-col">
                <span className={ABOUT_EYEBROW}>What you can do with it</span>
                <span className="text-sm font-medium text-fg-secondary">{s.tool}</span>
            </span>
            {s.experimental && <span className={EXPERIMENTAL_BADGE_CLASS}>Experimental</span>}
        </div>
    );
}
function AboutWriteHead({ step }) {
    return <span className={'about-rise ' + ABOUT_EYEBROW} style={{ '--i': 0 }}>Write a material · {step} of 6</span>;
}
function AboutRise({ i, children, className }) {
    return <div className={'about-rise ' + (className || '')} style={{ '--i': i }}>{children}</div>;
}
function AboutToolLink({ href, go, children, id }) {
    return (
        <a href={href} onClick={aboutOnLinkClick(go)} data-about-link={id} className={'self-start ' + ABOUT_CTA_LINK}>
            {children} <MtlxIcon name="arrow-right" className="w-3.5 h-3.5" />
        </a>
    );
}

// Navigation: Back, Restart, the progress bar (one button per slide), Next.
function AboutNav({ index, go, hoverTitle, setHoverTitle, touch, onRestart }) {
    const n = ABOUT_SLIDES.length;
    const cur = ABOUT_SLIDES[index];
    const label = hoverTitle != null ? hoverTitle : cur.title;
    return (
        <nav aria-label="Tour" className="about-pe absolute left-0 right-0 bottom-0 z-20 h-[68px] lg:h-[80px] px-3 sm:px-6 flex items-center gap-3 sm:gap-5 bg-surface-base/85 lg:bg-transparent">
            <button type="button" onClick={() => go(index - 1)} disabled={index === 0} data-about-nav="prev" aria-label="Previous slide"
                className="shrink-0 inline-flex items-center justify-center gap-1.5 h-10 w-10 sm:w-auto sm:px-3.5 rounded-[10px] border border-line-strong bg-control/70 hover:bg-hover text-sm font-medium text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <MtlxIcon name="arrow-left" className="w-4 h-4" /> <span className="hidden sm:inline">Back</span>
            </button>
            <button type="button" onClick={onRestart} data-about-nav="restart" aria-label="Restart the tour" title="Back to the first slide, with everything you changed undone"
                className="shrink-0 -ml-1 sm:ml-0 inline-flex items-center justify-center gap-1.5 h-10 w-10 sm:w-auto sm:px-3 rounded-[10px] text-sm font-medium text-fg-muted hover:text-fg hover:bg-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-base">
                <MtlxIcon name="refresh" className="w-4 h-4" /> <span className="hidden sm:inline">Restart</span>
            </button>
            <div className="flex-1 min-w-0 flex flex-col items-center gap-1.5">
                <div className="flex items-center gap-0.5 sm:gap-1.5" onMouseLeave={() => setHoverTitle(null)}>
                    {ABOUT_SLIDES.map((s, i) => (
                        <button key={s.id} type="button" onClick={() => go(i)} data-about-dot={s.id}
                            aria-label={'Go to slide ' + (i + 1) + ': ' + s.title} aria-current={i === index ? 'step' : undefined}
                            onMouseEnter={() => setHoverTitle(s.title)} onFocus={() => setHoverTitle(s.title)} onBlur={() => setHoverTitle(null)}
                            className={'group h-6 flex items-center focus-visible:outline-none ' + (s.group !== (ABOUT_SLIDES[i - 1] || s).group ? 'ml-1 sm:ml-2.5' : '')}>
                            <span className={'block h-1.5 rounded-full transition-all duration-300 group-focus-visible:ring-2 group-focus-visible:ring-accent-base '
                                + (i === index ? 'w-5 sm:w-8 bg-accent-base' : i < index ? 'w-2 sm:w-4 bg-accent-fg/55 group-hover:bg-accent-fg' : 'w-2 sm:w-4 bg-line-strong group-hover:bg-fg-subtle')} />
                        </button>
                    ))}
                </div>
                <div className="text-[11.5px] leading-4 text-fg-subtle truncate max-w-full" aria-hidden="true">
                    <span className="tabular-nums">{index + 1} / {n}</span>
                    <span className="mx-1.5">·</span>
                    <span className={hoverTitle != null ? 'text-fg' : 'text-fg-muted'}>{label}</span>
                    {index === 0 && hoverTitle == null && <span className="hidden sm:inline"><span className="mx-1.5">·</span>{touch ? 'Swipe or press Next' : 'Scroll, press Next or use the arrow keys'}</span>}
                </div>
            </div>
            <button type="button" onClick={() => go(index + 1)} disabled={index === n - 1} data-about-nav="next" aria-label="Next slide"
                className="shrink-0 inline-flex items-center justify-center gap-1.5 h-10 w-10 sm:w-auto sm:px-4 rounded-[10px] bg-accent-fill hover:bg-accent-fill-hover text-on-accent text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <span className="hidden sm:inline">Next</span> <MtlxIcon name="arrow-right" className="w-4 h-4" />
            </button>
        </nav>
    );
}

function AboutApp({ active = true } = {}) {
    const links = window.SITE_LINKS;
    // The blog is web only: its pages are not shipped in the desktop app or VS Code.
    const isWeb = !window.__MTLX_ELECTRON__ && !window.__MTLX_VSCODE__;
    const mtlxVersion = window.MTLX_HEADER_VERSION || (window.MtlxAssets && window.MtlxAssets.MTLX_TAG) || null;
    const ext = { target: '_blank', rel: 'noopener noreferrer' };
    const wide = useAboutMedia('(min-width: 1024px)', true);
    const touch = useAboutMedia('(pointer: coarse)', false);
    // Below md the page body is not viewport-tall, so the deck sizes itself.
    const mdUp = useAboutMedia('(min-width: 768px)', true);
    const [narrowH, setNarrowH] = React.useState(0);

    const slideFromHash = () => {
        const m = /^#!about\?(.*)$/.exec(window.location.hash || '');
        if (!m) return null;
        const id = new URLSearchParams(m[1]).get('s');
        return id && ABOUT_SLIDE_INDEX[id] != null ? ABOUT_SLIDE_INDEX[id] : null;
    };
    const [index, setIndex] = React.useState(() => slideFromHash() || 0);
    // -1 is the written material; 0..4 put an example on the stage.
    const [idx, setIdx] = React.useState(-1);
    const [mine, setMine] = React.useState(ABOUT_MINE_START);
    const [light, setLight] = React.useState(ABOUT_LIGHT_START);
    const [shape, setShape] = React.useState(ABOUT_SHAPE_START);
    const [xmls, setXmls] = React.useState({});
    const [stageFailed, setStageFailed] = React.useState(false);
    const [probe, setProbe] = React.useState(null);
    const [hoverTitle, setHoverTitle] = React.useState(null);
    // Change-slide edits per example path: { color: sRGB hex, rough }.
    const [edits, setEdits] = React.useState({});
    const [shots, setShots] = React.useState(null);
    const [deck, setDeck] = React.useState({ w: 0, h: 0 });
    const [announce, setAnnounce] = React.useState('');
    const deckRef = React.useRef(null);
    const gridFadeRef = React.useRef(null);
    const stageApiRef = React.useRef(null);
    const tickersRef = React.useRef(new Set());
    const touchedRef = React.useRef({});
    const shotKeyRef = React.useRef('');
    const activeRef = React.useRef(active);
    activeRef.current = active;
    const indexRef = React.useRef(index);
    indexRef.current = index;
    const navFromRef = React.useRef(null);
    const movedAtRef = React.useRef(-1e9);
    const slide = ABOUT_SLIDES[index];
    const example = idx >= 0 ? ABOUT_MATERIALS[idx] : null;
    const exXml = example ? xmls[example.path] || null : null;
    const n = ABOUT_SLIDES.length;

    const go = React.useCallback((to, how) => {
        const next = Math.max(0, Math.min(n - 1, to));
        if (next === indexRef.current) return;
        navFromRef.current = how || 'button';
        movedAtRef.current = performance.now();
        setProbe(null);
        setIndex(next);
    }, [n]);

    // The writing slides always show the written material.
    React.useEffect(() => { if (slide.beat < 99 && idx !== -1) setIdx(-1); }, [slide.beat]);

    React.useEffect(() => {
        if (!active || !example || xmls[example.path]) return undefined;
        let cancelled = false;
        fetchAboutXml(example).then((text) => {
            if (!cancelled) setXmls((prev) => ({ ...prev, [example.path]: text }));
        }, (e) => console.warn('[about] could not fetch ' + example.path, e));
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, idx]);

    const exDefaults = React.useMemo(() => (example ? aboutEditDefaults(example, exXml) : null), [example, exXml]);
    const exEdit = example ? edits[example.path] || null : null;
    const exValues = exDefaults ? { color: exDefaults.color, rough: exDefaults.rough, ...(exEdit || {}) } : null;
    const mineVals = React.useMemo(() => aboutTargets(99, mine), [mine]);
    // The edited documents lag the controls a little, so a slider drag
    // does not re-lay-out the node graph on every input event.
    const mineXmlNow = React.useMemo(() => aboutMineXml(mineVals, 99, false), [mineVals]);
    const exXmlNow = React.useMemo(() => (example && exEdit ? aboutEditXml(exXml, example, exEdit) : exXml), [example, exXml, exEdit]);
    const target = example ? exXmlNow : mineXmlNow;
    const docKey = example ? example.path : 'mine';
    const [lag, setLag] = React.useState({ key: docKey, xml: target });
    React.useEffect(() => {
        const t = setTimeout(() => setLag({ key: docKey, xml: target }), 220);
        return () => clearTimeout(t);
    }, [target, docKey]);
    const docXml = lag.key === docKey && lag.xml ? lag.xml : target;
    const carried = example
        ? { kind: 'example', m: example, label: example.label, name: aboutDocName(example), xml: example && exXmlNow ? exXmlNow : null }
        : { kind: 'mine', label: 'your material', name: ABOUT_MINE_FILE, xml: mineXmlNow };

    // Deck size: the stage's pose math and the stage box's base square.
    React.useEffect(() => {
        const el = deckRef.current;
        if (!el) return undefined;
        const measure = () => {
            const w = el.clientWidth, h = el.clientHeight;
            if (w && h) setDeck((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
        };
        measure();
        if (!window.ResizeObserver) return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    React.useEffect(() => {
        if (mdUp || !active) return undefined;
        const measure = () => {
            const el = deckRef.current;
            if (!el) return;
            const top = el.getBoundingClientRect().top + window.scrollY;
            const foot = document.getElementById('mtlx-footer');
            setNarrowH(Math.max(480, Math.round(window.innerHeight - top - (foot ? foot.offsetHeight : 0))));
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [mdUp, active]);

    // Slide changes: announce, move focus to the heading, mirror the hash.
    const firstRunRef = React.useRef(true);
    React.useEffect(() => {
        setAnnounce('Slide ' + (index + 1) + ' of ' + n + ': ' + slide.title);
        if (firstRunRef.current) { firstRunRef.current = false; return; }
        if (!activeRef.current) return;
        const h = document.getElementById('about-s-' + slide.id + '-h');
        if (h && navFromRef.current !== 'pointer-dot') h.focus({ preventScroll: true });
        const deckEl = deckRef.current;
        if (deckEl) { deckEl.scrollLeft = 0; deckEl.scrollTop = 0; }
        const hash = index === 0 ? '#!about' : '#!about?s=' + slide.id;
        if (window.location.hash !== hash) { try { history.replaceState(null, '', hash); } catch (e) { /* best-effort */ } }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [index]);

    // A pasted deep link while the view is alive.
    React.useEffect(() => {
        const onHash = () => {
            const at = slideFromHash();
            if (at != null) go(at, 'hash');
        };
        window.addEventListener('hashchange', onHash);
        return () => window.removeEventListener('hashchange', onHash);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Wheel and trackpad: one gesture moves one slide. Deltas accumulate to a
    // threshold; after a move the deck waits for the gesture's tail to end.
    React.useEffect(() => {
        const el = deckRef.current;
        if (!el) return undefined;
        const w = { acc: 0, last: 0, movedAt: -1e9, locked: false };
        const scrollsInside = (target, dy) => {
            for (let node = target; node && node !== el; node = node.parentElement) {
                if (node.scrollHeight > node.clientHeight + 1) {
                    const oy = getComputedStyle(node).overflowY;
                    if (oy === 'auto' || oy === 'scroll') {
                        if (dy > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
                        if (dy < 0 && node.scrollTop > 0) return true;
                    }
                }
            }
            return false;
        };
        const onWheel = (e) => {
            if (!activeRef.current || e.ctrlKey) return;
            const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
            const dx = e.deltaX * scale, dy = e.deltaY * scale;
            const dmain = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
            if (Math.abs(dy) >= Math.abs(dx) && scrollsInside(e.target, dy)) return;
            e.preventDefault();
            const now = performance.now();
            const gap = now - w.last;
            w.last = now;
            if (w.locked) {
                if (gap > 240 && now - w.movedAt > 450) w.locked = false;
                else return;
            }
            if (gap > 240) w.acc = 0;
            w.acc += dmain;
            if (Math.abs(w.acc) >= 40) {
                const dir = w.acc > 0 ? 1 : -1;
                w.acc = 0;
                w.locked = true;
                w.movedAt = now;
                go(indexRef.current + dir, 'wheel');
            }
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [go]);

    // Keyboard, only while this view is the active one and no dialog is open.
    React.useEffect(() => {
        const onKey = (e) => {
            if (!activeRef.current || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
            const t = e.target;
            const tag = t && t.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
            if (t && t.closest && (t.closest('[role="dialog"]') || t.closest('[aria-modal="true"]') || t.closest('[role="tablist"]'))) return;
            if (document.querySelector('[aria-modal="true"]')) return;
            if (t && t.closest && t.closest('#site-header')) return;
            const sc = t && t.closest && t.closest('[data-about-scroll]');
            const inScroll = !!sc && sc.scrollHeight > sc.clientHeight + 1;
            const onControl = tag === 'BUTTON' || tag === 'A';
            let to = null;
            switch (e.key) {
                case 'ArrowRight': case 'PageDown': to = indexRef.current + 1; break;
                case 'ArrowLeft': case 'PageUp': to = indexRef.current - 1; break;
                case 'ArrowDown': if (!inScroll) to = indexRef.current + 1; break;
                case 'ArrowUp': if (!inScroll) to = indexRef.current - 1; break;
                case ' ': if (!onControl && !inScroll) to = indexRef.current + (e.shiftKey ? -1 : 1); break;
                case 'Home': to = 0; break;
                case 'End': to = n - 1; break;
                default: break;
            }
            if (to == null) return;
            e.preventDefault();
            go(to, 'key');
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [go, n]);

    // Touch: a horizontal swipe outside the render and the sliders.
    React.useEffect(() => {
        const el = deckRef.current;
        if (!el) return undefined;
        let s = null;
        const onStart = (e) => {
            if (!activeRef.current || e.touches.length !== 1) { s = null; return; }
            const t = e.target;
            // Mid-transition the outgoing slide is inert, so a touch falls through to the render.
            const sliding = performance.now() - movedAtRef.current < 900;
            if (t && t.closest && ((t.closest('canvas') && !sliding) || t.closest('input[type="range"]') || t.closest('.react-flow'))) { s = null; return; }
            s = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now() };
        };
        // A horizontal drag belongs to the deck, not to the browser's back gesture.
        const onMove = (e) => {
            if (!s || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - s.x, dy = e.touches[0].clientY - s.y;
            if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) && e.cancelable) e.preventDefault();
        };
        const onEnd = (e) => {
            if (!s) return;
            const c = e.changedTouches[0];
            const dx = c.clientX - s.x, dy = c.clientY - s.y;
            const quick = performance.now() - s.t < 1500;
            s = null;
            if (quick && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) go(indexRef.current + (dx < 0 ? 1 : -1), 'swipe');
        };
        el.addEventListener('touchstart', onStart, { passive: true });
        el.addEventListener('touchmove', onMove, { passive: false });
        el.addEventListener('touchend', onEnd, { passive: true });
        return () => { el.removeEventListener('touchstart', onStart); el.removeEventListener('touchmove', onMove); el.removeEventListener('touchend', onEnd); };
    }, [go]);

    // The Anywhere stills, taken once the stage settles there (again if the material changed).
    React.useEffect(() => {
        if (slide.id !== 'anywhere' || !active) return undefined;
        const key = idx + '|' + JSON.stringify(mine) + '|' + (exEdit ? JSON.stringify(exEdit) : '') + '|' + shape;
        if (shotKeyRef.current === key) return undefined;
        let cancelled = false;
        let tries = 0;
        const attempt = () => {
            if (cancelled) return;
            const api = stageApiRef.current;
            if (!api || !api.ready()) { if (++tries < 40) setTimeout(attempt, 250); return; }
            api.capture().then((s) => { if (!cancelled && s) { shotKeyRef.current = key; setShots(s); } });
        };
        const t = setTimeout(attempt, 500);
        return () => { cancelled = true; clearTimeout(t); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slide.id, active, idx, mine, exEdit, shape]);

    const touch1 = (k) => { touchedRef.current[k] = true; };
    const setMineKey = (k, v) => { touch1(k); setMine((prev) => ({ ...prev, [k]: v })); };
    // Restart: back to slide 1 with everything the visitor changed undone.
    const onRestart = () => {
        setMine(ABOUT_MINE_START);
        setIdx(-1);
        setEdits({});
        setLight(ABOUT_LIGHT_START);
        setShape(ABOUT_SHAPE_START);
        setProbe(null);
        setShots(null);
        shotKeyRef.current = '';
        touchedRef.current = {};
        if (indexRef.current === 0) {
            if (window.location.hash !== '#!about') { try { history.replaceState(null, '', '#!about'); } catch (e) { /* best-effort */ } }
        } else go(0);
    };
    // Play / pause the light's turn; a pause keeps the angle it reached.
    const pauseLight = () => setLight((p) => {
        if (!p.spin) return p;
        const api = stageApiRef.current;
        return { ...p, spin: false, rot: api && api.envAngle ? api.envAngle() : (p.rot || 0) };
    });
    const toggleLight = () => {
        if (light.spin) pauseLight();
        else setLight((p) => ({ ...p, spin: true }));
    };
    // The turn belongs to the Look slide: leaving it pauses the light where it is.
    React.useEffect(() => { if (slide.id !== 'look') pauseLight(); }, [slide.id]);
    const onExEdit = (patch) => setEdits((prev) => ({ ...prev, [example.path]: { ...(prev[example.path] || {}), ...patch } }));
    const onExReset = () => setEdits((prev) => { const next = { ...prev }; delete next[example.path]; return next; });

    const live = !stageFailed;
    const geom = index >= ABOUT_FURTHER_AT && index <= ABOUT_SLIDE_INDEX.anywhere ? shape : 'shaderball';
    const poseStyle = aboutStageTransform(slide, wide, deck.w, deck.h);
    const near = (i) => Math.abs(i - index) <= 1;

    const principles = [
        {
            title: 'It runs in your browser.',
            body: (<>Shaders are generated and compiled live by the official <strong className={STRONG_CLASS}>MaterialX WebAssembly build</strong>{mtlxVersion ? ' (' + mtlxVersion + ')' : ''}.</>),
        },
        { title: 'Nothing to install, unless you want to.', body: 'No account needed: open the page and start working. Prefer an app? Get the VS Code extension or the desktop app.' },
        { title: 'Your files stay on your machine.', body: 'Documents and textures you open are read locally and never uploaded.' },
        { title: 'The spec comes first.', body: 'Node docs are generated from the MaterialX libraries themselves. Where the Playground and the specification disagree, the specification is the source of truth.' },
        {
            title: 'Open source, Apache 2.0.',
            body: (<>The code, the build and the roadmap are public on <a href={links.repo} {...ext} data-about-link="principles-repo" className={ABOUT_LINK}>GitHub</a>.</>),
        },
        { title: 'Free to use.', body: 'No ads, no analytics and no paid tier: every tool on this site is open to everyone.' },
    ];


    const slideBody = (s, i) => {
        const isCur = i === index;
        switch (s.id) {
            case 'intro': return (
                <div className="flex flex-col gap-5 lg:gap-6">
                    <div data-testid="about-brand" className="about-rise inline-flex items-center gap-2.5 text-brand-accent" style={{ '--i': 0 }}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
                            className="w-6 h-6" dangerouslySetInnerHTML={{ __html: window.SITE_LOGO_PATHS }} />
                        <span className="text-lg sm:text-xl font-bold tracking-[-0.01em]">The MaterialX Playground</span>
                    </div>
                    <h1 id="about-h1" className="about-rise text-[36px] sm:text-[52px] lg:text-[56px] xl:text-[62px] leading-[1.02] font-bold tracking-[-0.035em] text-fg text-balance" style={{ '--i': 1 }}>
                        <span className="block">Render and Learn MaterialX</span>{' '}
                        <span className="block">Easily <span className="text-accent-fg">Anywhere</span></span>
                    </h1>
                    <h2 id="about-s-intro-h" tabIndex={-1} className="sr-only">Welcome</h2>
                    <AboutRise i={2}>
                        <p className={ABOUT_BODY + ' sm:text-lg sm:leading-8'}>
                            This page is an interactive tour. You will write a small material, then take it through each tool:
                            the Material Viewer, Material Compare, the Graph Editor, Node Specs, the Scene Viewer and the Embed Builder.
                        </p>
                    </AboutRise>
                    <AboutRise i={3} className="flex flex-wrap items-center gap-x-5 gap-y-3">
                        <button type="button" onClick={() => go(1)} data-about-link="start" className={PRIMARY_CTA_CLASS + ' h-12 px-5 text-[15px]'}>
                            Start the tour <MtlxIcon name="arrow-right" className="w-4 h-4" />
                        </button>
                        <button type="button" onClick={() => go(n - 1)} data-about-link="skip" className={ABOUT_CTA_LINK}>
                            Skip to the principles
                        </button>
                    </AboutRise>
                    <AboutRise i={4}>
                        <p className="text-[13px] text-fg-subtle">
                            {touch ? 'Swipe left or press Next to move on.' : 'Scroll, press Next or use the arrow keys to move on. Drag the ball to turn it.'}
                        </p>
                    </AboutRise>
                </div>
            );
            case 'doc': return (
                <div className="flex flex-col gap-4">
                    <AboutWriteHead step={1} />
                    <AboutHeading s={s}>Start with a document</AboutHeading>
                    <AboutRise i={1}><p className={ABOUT_BODY}>A MaterialX material is a small XML file. This one holds a Standard Surface shader and a material that uses it. Nothing is set yet, so every input keeps the default the standard defines: a plain, light grey.</p></AboutRise>
                    <AboutCue i={2}>Drag the ball to look around it. Next writes the first line.</AboutCue>
                    <AboutRise i={3}><AboutFilePanel><AboutSource beat={0} vals={mineVals} live={isCur} tickersRef={tickersRef} /></AboutFilePanel></AboutRise>
                </div>
            );
            case 'color': return (
                <div className="flex flex-col gap-4">
                    <AboutWriteHead step={2} />
                    <AboutHeading s={s}>Give it a color</AboutHeading>
                    <AboutRise i={1}><p className={ABOUT_BODY}>base_color is the color of the surface. The render and the line in the file change together.</p></AboutRise>
                    <AboutCue i={2}>Pick a swatch, or mix your own.</AboutCue>
                    <AboutRise i={2}><AboutSwatches color={mine.color} onPick={(lin) => setMineKey('color', lin)} idPrefix="about-color" /></AboutRise>
                    <AboutRise i={3}><AboutFilePanel><AboutSource beat={1} newBeat={1} vals={mineVals} live={isCur} tickersRef={tickersRef} /></AboutFilePanel></AboutRise>
                </div>
            );
            case 'metal': return (
                <div className="flex flex-col gap-4">
                    <AboutWriteHead step={3} />
                    <AboutHeading s={s}>Make it metal</AboutHeading>
                    <AboutRise i={1}><p className={ABOUT_BODY}>metalness at 1 turns the surface into a conductor: its color stops being paint and starts tinting the reflections. Watch the highlight.</p></AboutRise>
                    <AboutCue i={2}>Flip between paint and metal, or drag anywhere in between.</AboutCue>
                    <AboutRise i={2} className="flex flex-col gap-3">
                        <AboutSegmented label="Surface" value={mine.metal >= 0.999 ? 'metal' : mine.metal <= 0.001 ? 'paint' : null}
                            options={[{ id: 'paint', label: 'Paint (0)' }, { id: 'metal', label: 'Metal (1)' }]}
                            onChange={(v) => setMineKey('metal', v === 'metal' ? 1 : 0)} />
                        <AboutSlider id="about-metal" label="metalness" value={mine.metal} onChange={(v) => setMineKey('metal', v)} hint={['dielectric', 'metal']} />
                    </AboutRise>
                    <AboutRise i={3}><AboutFilePanel><AboutSource beat={2} newBeat={2} vals={mineVals} live={isCur} tickersRef={tickersRef} /></AboutFilePanel></AboutRise>
                </div>
            );
            case 'rough': return (
                <div className="flex flex-col gap-4">
                    <AboutWriteHead step={4} />
                    <AboutHeading s={s}>Blur the reflections</AboutHeading>
                    <AboutRise i={1}><p className={ABOUT_BODY}>specular_roughness spreads every reflection. At 0 the ball is a mirror; toward 1 it turns into brushed metal.</p></AboutRise>
                    <AboutCue i={2}>Drag the slider and watch the highlight spread.</AboutCue>
                    <AboutRise i={2}><AboutSlider id="about-rough" label="specular_roughness" value={mine.rough} onChange={(v) => setMineKey('rough', v)} hint={['mirror', 'brushed']} /></AboutRise>
                    <AboutRise i={3}><AboutFilePanel><AboutSource beat={3} newBeat={3} vals={mineVals} live={isCur} tickersRef={tickersRef} /></AboutFilePanel></AboutRise>
                </div>
            );
            case 'coat': return (
                <div className="flex flex-col gap-4">
                    <AboutWriteHead step={5} />
                    <AboutHeading s={s}>Add a clear coat</AboutHeading>
                    <AboutRise i={1}><p className={ABOUT_BODY}>coat puts a second, glossy layer on top and coat_color tints it. You can see both layers: sharp reflections on the coat, soft ones on the metal below.</p></AboutRise>
                    <AboutCue i={2}>Fade the coat in and out, and watch the sharp reflections come and go.</AboutCue>
                    <AboutRise i={2}>
                        <AboutSlider id="about-coat" label="coat" value={mine.coat} onChange={(v) => setMineKey('coat', v)} hint={['no coat', 'full coat']} />
                    </AboutRise>
                    <AboutRise i={3}><AboutFilePanel><AboutSource beat={4} newBeat={4} vals={mineVals} live={isCur} tickersRef={tickersRef} /></AboutFilePanel></AboutRise>
                </div>
            );
            case 'graph': return (
                <div className="flex flex-col gap-4">
                    <AboutWriteHead step={6} />
                    <AboutHeading s={s}>The file is the graph</AboutHeading>
                    <AboutRise i={1}><p className={ABOUT_BODY + ' max-w-[52em]'}>The same document drawn as nodes: a shader node and the material that uses it. Every tool in the Playground reads and writes this file, so what you just wrote goes everywhere next.</p></AboutRise>
                    <AboutCue i={2}>Point at a line or a node input: both light up, and the ball shows what that input does.</AboutCue>
                    <AboutRise i={3} className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)] items-center">
                        <AboutFilePanel>
                            <div data-about-scroll="" className="overflow-x-auto custom-scrollbar">
                                <AboutSource beat={5} vals={mineVals} live={isCur} tickersRef={tickersRef} hover={probe} onHover={setProbe} label="Your document" />
                            </div>
                        </AboutFilePanel>
                        <AboutLiveGraph xml={mineXmlNow} hover={probe} onHover={setProbe} enabled={near(i) && active} />
                    </AboutRise>
                    <AboutRise i={4}>
                        <AboutToolLink href="#!graph" go={() => aboutOpenInGraph(carried)} id="graph-open">Open it in the Graph Editor</AboutToolLink>
                    </AboutRise>
                </div>
            );
            case 'find': return (
                <div className="flex flex-col gap-4">
                    <AboutToolHead s={s} />
                    <AboutHeading s={s}>Find</AboutHeading>
                    <AboutRise i={1}><p className={ABOUT_BODY}>Writing your own is one way in. The other is the gallery: every example that ships with MaterialX, plus the Playground's own showcase pieces, ready to search, preview and reopen.</p></AboutRise>
                    <AboutCue i={2}>Put an example on the stage, or keep yours. The rest of the tour carries whichever you pick.</AboutCue>
                    <AboutRise i={2}>
                        <div role="group" aria-label="On the stage" className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                            {[{ i: -1, label: 'Yours', sub: 'Standard Surface', tint: mine.color }].concat(ABOUT_MATERIALS.map((m, k) => ({ i: k, label: m.label, sub: ABOUT_SHADER_LABELS[m.shader], tint: m.tint }))).map((o) => {
                                const on = o.i === idx;
                                return (
                                    <button key={o.i} type="button" aria-pressed={on} onClick={() => setIdx(o.i)} data-about-pick={o.label}
                                        className={'flex items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-base '
                                            + (on ? 'border-accent-base bg-selection/25' : 'border-line-subtle bg-surface-raised/70 hover:border-line-strong hover:bg-hover')}>
                                        <span aria-hidden="true" className="w-9 h-9 rounded-full shrink-0 ring-1 ring-inset ring-line-strong" style={aboutDotStyle(o.tint)} />
                                        <span className="min-w-0 flex flex-col">
                                            <span className="text-sm font-semibold text-fg truncate">{o.label}</span>
                                            <span className="text-[11px] text-fg-subtle truncate">{o.sub}</span>
                                        </span>
                                        {on && <MtlxIcon name="check" className="w-4 h-4 ml-auto text-accent-fg shrink-0" />}
                                    </button>
                                );
                            })}
                        </div>
                    </AboutRise>
                    <AboutRise i={3}>
                        <AboutToolLink href={example ? '#!gallery?m=' + encodeURIComponent(aboutDocName(example)) : '#!gallery'} id="gallery">
                            {example ? 'Find ' + example.label + ' in the gallery' : 'Browse the gallery'}
                        </AboutToolLink>
                    </AboutRise>
                </div>
            );
            case 'look': return (
                <div className="flex flex-col gap-4">
                    <AboutToolHead s={s} />
                    <AboutHeading s={s}>Look</AboutHeading>
                    <AboutRise i={1}><p className={ABOUT_BODY}>Render any .mtlx in real time under image-based lighting, with its textures, a folder or a .zip. Swap the light, rotate it, then save a PNG or a turntable GIF.</p></AboutRise>
                    <AboutCue i={2}>Pick a light, rotate it or set its angle, and drag the ball to orbit.</AboutCue>
                    <AboutRise i={2} className="flex flex-col gap-4">
                        {/* The play control doubles as the indicator: a spinning icon and
                            "Rotating" while it runs, with a pause glyph to stop it. */}
                        <div className="flex flex-wrap items-center gap-3">
                            <AboutSegmented label="Light" value={light.env} options={ABOUT_LIGHTS} onChange={(v) => setLight((p) => ({ ...p, env: v }))} />
                            <button type="button" id="about-light-play" onClick={toggleLight} aria-pressed={light.spin} data-about-light-spin={light.spin ? 'on' : 'off'}
                                aria-label={light.spin ? 'Pause the light' : 'Rotate the light'}
                                className={ABOUT_CHIP + ' px-3.5 whitespace-nowrap ' + (light.spin ? ABOUT_CHIP_ON : ABOUT_CHIP_OFF)}>
                                <MtlxIcon name="rotate" className={'w-4 h-4' + (light.spin ? ' about-turning' : '')} />
                                {light.spin ? 'Rotating' : 'Rotate the light'}
                                {light.spin && <span aria-hidden="true" className="ml-1 w-3 h-3 inline-flex items-center justify-center gap-[3px]"><span className="w-[3px] h-3 rounded-sm bg-current" /><span className="w-[3px] h-3 rounded-sm bg-current" /></span>}
                            </button>
                            <span role="status" data-testid="about-light-turning" className="sr-only">{light.spin ? 'Light rotating' : ''}</span>
                        </div>
                        <AboutSlider id="about-light-rot" label="Light angle" value={light.spin ? 0 : Math.round(((light.rot || 0) * 180) / Math.PI) % 360} min={0} max={360} step={1}
                            format={(v) => (light.spin ? 'rotating' : v + '°')} onChange={(v) => setLight((p) => ({ ...p, spin: false, rot: (v * Math.PI) / 180 }))} />
                        <AboutSlider id="about-light-exp" label="Brightness" value={light.exposure} min={0.25} max={2.5} step={0.05}
                            format={(v) => v.toFixed(2) + '×'} onChange={(v) => setLight((p) => ({ ...p, exposure: v }))} />
                    </AboutRise>
                    <AboutRise i={3}>
                        <AboutToolLink href="#!viewer" go={carried.xml ? () => aboutOpenInViewer(carried) : null} id="viewer">
                            {carried.xml ? 'Open ' + carried.label + ' in the Material Viewer' : 'Open the Material Viewer'}
                        </AboutToolLink>
                    </AboutRise>
                </div>
            );
            case 'compare': return (
                <div className="flex flex-col gap-4">
                    <AboutToolHead s={s} />
                    <AboutHeading s={s}>Compare</AboutHeading>
                    <AboutRise i={1}><p className={ABOUT_BODY}>Two documents, one camera, the same light. Swipe across them or switch to a difference heatmap with SSIM and RMSE, and render each side with its own MaterialX version.</p></AboutRise>
                    <AboutCue i={2}>{live ? (example ? 'Drag the line across the ball: ' + example.label + ' on the left, ' + ABOUT_MATERIALS[example.pair].label + ' on the right.' : 'Drag the line across the ball: yours on the left, where you started on the right.') : 'Open both sides in the real tool below.'}</AboutCue>
                    <AboutRise i={3}>
                        <AboutToolLink href="#!compare" go={carried.xml ? () => aboutOpenInCompare(carried) : null} id="compare">
                            {example ? 'Compare ' + example.label + ' with ' + ABOUT_MATERIALS[example.pair].label : 'Compare yours with where you started'}
                        </AboutToolLink>
                    </AboutRise>
                </div>
            );
            case 'change': return (
                <div className="flex flex-col gap-4">
                    <AboutToolHead s={s} />
                    <AboutHeading s={s}>Change</AboutHeading>
                    <AboutRise i={1}><p className={ABOUT_BODY}>Rewire a material by hand, with nested node graphs, undo and a live 3D preview of the node you pick. Validate it, then export a .mtlx, or a .zip with its textures.</p></AboutRise>
                    <AboutCue i={2}>Edit the values: the render, the graph and every link on this page follow.</AboutCue>
                    <AboutRise i={2} className="grid gap-4 xl:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] items-start">
                        {example ? (
                            <div className="flex flex-col gap-3">
                                {exValues && exValues.color != null && (
                                    <label className="flex items-center justify-between gap-3 text-sm text-fg-secondary">
                                        <span>{example.edit.color.label} <code className="text-xs text-fg-subtle">{example.edit.color.targets[0][1]}</code></span>
                                        <span className="relative w-9 h-9 rounded-full ring-1 ring-inset ring-line-strong shrink-0" style={{ backgroundColor: exValues.color }}>
                                            <input id="about-edit-color" type="color" value={exValues.color} onChange={(e) => onExEdit({ color: e.target.value })} className="about-swatch-input rounded-full" aria-label={example.edit.color.label} />
                                        </span>
                                    </label>
                                )}
                                {exValues && exValues.rough != null && (
                                    <AboutSlider id="about-edit-rough" label={example.edit.rough.label} value={exValues.rough} onChange={(v) => onExEdit({ rough: v })} />
                                )}
                                {!exValues && <p className="text-sm text-fg-muted">Loading {example.label}</p>}
                                <button type="button" onClick={onExReset} disabled={!exEdit} className="self-start inline-flex items-center gap-1 h-8 px-2 rounded-md text-xs font-medium text-fg-muted hover:text-fg hover:bg-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                                    <MtlxIcon name="restore" className="w-3.5 h-3.5" /> Reset
                                </button>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-3">
                                <label className="flex items-center justify-between gap-3 text-sm text-fg-secondary">
                                    <span>base_color</span>
                                    <span className="relative w-9 h-9 rounded-full ring-1 ring-inset ring-line-strong shrink-0" style={{ backgroundColor: aboutLinToHex(mine.color) }}>
                                        <input id="about-edit-color" type="color" value={aboutLinToHex(mine.color)} onChange={(e) => setMineKey('color', aboutHexToLin(e.target.value))} className="about-swatch-input rounded-full" aria-label="base_color" />
                                    </span>
                                </label>
                                <AboutSlider id="about-edit-metal" label="metalness" value={mine.metal} onChange={(v) => setMineKey('metal', v)} />
                                <AboutSlider id="about-edit-rough" label="specular_roughness" value={mine.rough} onChange={(v) => setMineKey('rough', v)} />
                                <AboutSlider id="about-edit-coat" label="coat" value={mine.coat} onChange={(v) => setMineKey('coat', v)} />
                            </div>
                        )}
                        <AboutInside label={example ? example.label : 'Your material'} xml={docXml} enabled={near(i) && active} />
                    </AboutRise>
                    <AboutRise i={3}>
                        <AboutToolLink href="#!graph" go={carried.xml ? () => aboutOpenInGraph(carried) : null} id="change">
                            {'Open ' + carried.label + ' in the Graph Editor'}
                        </AboutToolLink>
                    </AboutRise>
                </div>
            );
            case 'understand': return (
                <div className="flex flex-col gap-4">
                    <AboutToolHead s={s} />
                    <AboutHeading s={s}>Understand</AboutHeading>
                    <AboutRise i={1}><p className={ABOUT_BODY}>{example ? example.label + ' is built on the ' + ABOUT_SHADER_LABELS[example.shader] + ' node. ' : 'Every input you wrote is defined by the Standard Surface spec, with a type and a default. '}Every standard node has its own page, with port tables, defaults, a live preview you can tweak, and a permalink to share.</p></AboutRise>
                    {example ? (
                        <>
                            <AboutRise i={2}><AboutNodeCard material={example} xml={docXml} /></AboutRise>
                            <AboutRise i={3}>
                                <button type="button" onClick={() => setIdx(-1)} className={ABOUT_SECONDARY}>Put yours back on the stage to try the spec rows</button>
                            </AboutRise>
                        </>
                    ) : (
                        <>
                            <AboutCue i={2}>{live ? 'Point at a row to see that input at work on the ball.' : 'Point at a row to mark it.'}</AboutCue>
                            <AboutRise i={2}><div><AboutSpecTable mineVals={mineVals} probe={probe} setProbe={setProbe} /></div></AboutRise>
                        </>
                    )}
                    <AboutRise i={3}>
                        <AboutToolLink href={'#/bxdf/pbr/' + (example ? example.shader : 'standard_surface')} id="specs">
                            {'Read the ' + ABOUT_SHADER_LABELS[example ? example.shader : 'standard_surface'] + ' page'}
                        </AboutToolLink>
                    </AboutRise>
                </div>
            );
            case 'further': return (
                <div className="flex flex-col gap-4">
                    <AboutToolHead s={s} />
                    <AboutHeading s={s}>Go further</AboutHeading>
                    <AboutRise i={1}><p className={ABOUT_BODY}>A material is not tied to a ball. Try it on other shapes here, then on a whole scene in the Scene Viewer: drop a USD, glTF or OBJ file and render it with its lights, shadows and ambient occlusion.</p></AboutRise>
                    <AboutCue i={2}>Try {example ? example.label : 'your material'} on another shape.</AboutCue>
                    <AboutRise i={2}>
                        <div role="group" aria-label="Shape" className="flex flex-wrap gap-2">
                            {ABOUT_SHAPES.map((sh) => (
                                <button key={sh.id} type="button" aria-pressed={shape === sh.id} onClick={() => setShape(sh.id)} data-about-shape={sh.id}
                                    className={ABOUT_CHIP + ' px-3.5 ' + (shape === sh.id ? ABOUT_CHIP_ON : ABOUT_CHIP_OFF)}>
                                    {sh.label}
                                </button>
                            ))}
                        </div>
                        {/* Always laid out, only hidden: the chips and link below keep their place. */}
                        <p data-about-credit="dragon" aria-hidden={shape !== 'dragon'}
                            className={'mt-2 text-[12px] leading-snug text-fg-subtle' + (shape === 'dragon' ? '' : ' invisible')}>
                                Dragon: <a href={ABOUT_DRAGON_LINKS.stanford} target="_blank" rel="noopener noreferrer" className={ABOUT_CREDIT_LINK}>Stanford scan</a> (© 1996 Stanford University) via <a href={ABOUT_DRAGON_LINKS.mcguire} target="_blank" rel="noopener noreferrer" className={ABOUT_CREDIT_LINK}>Morgan McGuire's archive</a> and the <a href={ABOUT_DRAGON_LINKS.khronos} target="_blank" rel="noopener noreferrer" className={ABOUT_CREDIT_LINK}>Khronos glTF Sample Assets</a>.
                        </p>
                    </AboutRise>
                    <AboutRise i={3}><AboutToolLink href="#!scene" id="scene">Open the Scene Viewer</AboutToolLink></AboutRise>
                </div>
            );
            case 'share': return (
                <div className="flex flex-col gap-4">
                    <AboutToolHead s={s} />
                    <AboutHeading s={s}>Share</AboutHeading>
                    <AboutRise i={1}><p className={ABOUT_BODY}>Put {carried.label} on your own web page as a lightweight viewer, like embedding a video. Tune it against a live preview in the Embed Builder, then copy an &lt;iframe&gt; or custom-element snippet.</p></AboutRise>
                    <AboutCue i={2}>Download the file, or open it in the Embed Builder and fine-tune the viewer.</AboutCue>
                    <AboutRise i={2}><AboutSnippet carried={carried} /></AboutRise>
                    <AboutRise i={3} className="flex flex-wrap items-center gap-3">
                        <button type="button" disabled={!carried.xml} data-about-link="download"
                            onClick={() => aboutDownload(carried.xml, (carried.kind === 'mine' ? ABOUT_MINE_FILE : carried.name) + '.mtlx')}
                            className={PRIMARY_CTA_CLASS + ' disabled:opacity-50'}>
                            <MtlxIcon name="download" className="w-4 h-4" /> Download {(carried.kind === 'mine' ? ABOUT_MINE_FILE : carried.name) + '.mtlx'}
                        </button>
                        <a href="#!builder" data-about-link="builder" onClick={aboutOnLinkClick(carried.xml ? () => aboutOpenInBuilder(carried) : null)} className={ABOUT_SECONDARY}>
                            Open it in the Embed Builder <MtlxIcon name="arrow-right" className="w-4 h-4" />
                        </a>
                    </AboutRise>
                    {carried.kind === 'mine' && <AboutRise i={4}><p className="text-[13px] text-fg-subtle">Host the file next to your page, and the snippet above shows it.</p></AboutRise>}
                </div>
            );
            case 'anywhere': return (
                <div className="flex flex-col gap-6 lg:gap-8">
                    <div className="text-center flex flex-col items-center gap-3">
                        <AboutHeading s={s} className="text-[48px] sm:text-[72px] lg:text-[88px] leading-none font-bold tracking-[-0.045em] text-fg focus:outline-none">
                            Anywhere<span className="text-accent-fg">.</span>
                        </AboutHeading>
                        <AboutRise i={1}><p className="max-w-[38em] text-base sm:text-lg leading-7 text-fg-muted text-balance">
                            The same Playground on the same engine, wherever you work. Here is {carried.kind === 'mine' ? 'what you wrote' : carried.label} in each of them.
                        </p></AboutRise>
                    </div>
                    <ul className="grid grid-cols-3 gap-3 md:gap-6 max-w-6xl w-full mx-auto">
                        <AboutHost kind="web" shot={shots && shots[0]} d={100} carried={carried} />
                        <AboutHost kind="vscode" shot={shots && shots[1]} d={220} carried={carried} />
                        <AboutHost kind="desktop" shot={shots && shots[2]} d={340} carried={carried} />
                    </ul>
                </div>
            );
            case 'principles': return (
                <div className="flex flex-col gap-5 lg:gap-6 max-w-6xl w-full mx-auto">
                    <div className="flex flex-col gap-2">
                        <span className={'about-rise ' + ABOUT_EYEBROW} style={{ '--i': 0 }}>Principles</span>
                        <AboutHeading s={s}>The choices behind it</AboutHeading>
                    </div>
                    <AboutRise i={1}>
                        <ol className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-8">
                            {principles.map((p, k) => (
                                <li key={p.title} className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-2 py-3.5 border-t border-line-subtle">
                                    <span aria-hidden="true" className="text-[26px] leading-none font-bold tracking-[-0.04em] text-fg-faint tabular-nums">{String(k + 1).padStart(2, '0')}</span>
                                    <div className="flex flex-col gap-1 min-w-0">
                                        <h3 className="text-[15px] font-semibold text-fg">{p.title}</h3>
                                        <p className="text-[13.5px] leading-[1.55] text-fg-muted">{p.body}</p>
                                    </div>
                                </li>
                            ))}
                        </ol>
                    </AboutRise>
                    <AboutRise i={2} className="grid gap-5 md:grid-cols-2 pt-1">
                        <section aria-labelledby="about-next-h" className="flex flex-col gap-2">
                            <h3 id="about-next-h" className="text-lg font-semibold text-fg">Out in the open</h3>
                            <p className="text-[14px] leading-6 text-fg-muted">The roadmap is open for discussion, including the order of items and whether an item belongs at all.</p>
                            <ul className="flex flex-wrap gap-x-6 gap-y-2 text-[15px] font-medium">
                                <li><a href="#!roadmap" data-about-link="roadmap" className={ABOUT_CTA_LINK + ' text-[15px]'}>Roadmap <MtlxIcon name="arrow-right" className="w-4 h-4" /></a></li>
                                {isWeb && <li><a href="blog/" data-about-link="blog" className={ABOUT_CTA_LINK + ' text-[15px]'}>Blog <MtlxIcon name="arrow-right" className="w-4 h-4" /></a></li>}
                                <li><a href={links.releaseNotes} {...ext} data-about-link="release-notes" className={ABOUT_CTA_LINK + ' text-[15px]'}>Release notes <MtlxIcon name="external-link" className="w-4 h-4" /></a></li>
                            </ul>
                        </section>
                        <section aria-labelledby="about-help-h" className="flex flex-col gap-2">
                            <h3 id="about-help-h" className="text-lg font-semibold text-fg">Want to help?</h3>
                            <p className="text-[14px] leading-6 text-fg-muted">
                                Report a bug, ask for a feature or back a roadmap item by{' '}
                                <a href={links.issues} {...ext} data-about-link="issues" className={ABOUT_LINK}>opening an issue</a>, or read the{' '}
                                <a href={links.repo} {...ext} data-about-link="repo" className={ABOUT_LINK}>source on GitHub</a>. Pull requests are welcome too.
                            </p>
                            <button type="button" onClick={onRestart} data-about-link="again" className={'self-start ' + ABOUT_CTA_LINK}>
                                <MtlxIcon name="refresh" className="w-3.5 h-3.5" /> Take the tour again
                            </button>
                        </section>
                    </AboutRise>
                </div>
            );
            default: return null;
        }
    };

    return (
        <section id="about-deck" ref={deckRef} aria-roledescription="carousel" aria-label="A tour of the MaterialX Playground"
            data-slide={slide.id} data-index={index} data-wide={wide ? '1' : '0'}
            style={mdUp ? { '--about-h': deck.h + 'px' } : { '--about-h': deck.h + 'px', position: 'relative', height: (narrowH || 600) + 'px' }}>
            <style>{ABOUT_DECK_CSS}</style>
            {/* The site's hero grid, fixed behind the whole deck (it never moves with the track) */}
            {window.HeroGrid && <window.HeroGrid rootRef={deckRef} fadeRef={gridFadeRef} fadeFrom="top" />}
            <div ref={gridFadeRef} aria-hidden="true" className="absolute left-0 right-0 bottom-0 h-[45%] pointer-events-none" />
            {deck.h > 0 && (
                <AboutStage
                    active={active} idx={idx} slide={slide} geom={geom} mine={mine} light={light} probe={probe} touchedRef={touchedRef}
                    editValues={exValues} onFailed={() => setStageFailed(true)} apiRef={stageApiRef} tickersRef={tickersRef}
                    poseStyle={poseStyle} carried={carried} wide={wide}
                />
            )}
            {/* Share: a mock web page around the stage's resting place */}
            {wide && (
                <div aria-hidden="true" className="absolute z-0 rounded-2xl border border-line-strong bg-surface-raised/40 overflow-hidden transition-opacity duration-500"
                    style={{ left: '47%', right: '4%', top: '9%', bottom: '17%', opacity: slide.id === 'share' ? 1 : 0 }}>
                    <div className="h-9 flex items-center gap-1.5 px-3.5 border-b border-line-subtle bg-surface-raised">
                        <span className="w-2.5 h-2.5 rounded-full bg-line-strong" />
                        <span className="w-2.5 h-2.5 rounded-full bg-line-strong" />
                        <span className="w-2.5 h-2.5 rounded-full bg-line-strong" />
                        <span className="ml-3 h-5 flex-1 max-w-[18rem] rounded-md bg-surface-sunken text-[10px] leading-5 px-2 text-fg-subtle truncate">your-site.example/materials</span>
                    </div>
                    <div className="absolute left-5 top-14 w-[22%] flex flex-col gap-2">
                        <span className="h-3 w-4/5 rounded bg-line-strong" />
                        <span className="h-2 w-full rounded bg-line" />
                        <span className="h-2 w-11/12 rounded bg-line" />
                        <span className="h-2 w-3/4 rounded bg-line" />
                        <span className="mt-2 h-2 w-full rounded bg-line" />
                        <span className="h-2 w-2/3 rounded bg-line" />
                    </div>
                    <span className="absolute left-5 bottom-4 font-mono text-[10.5px] text-fg-subtle truncate max-w-[60%]">&lt;materialx-viewer src="{carried.kind === 'mine' ? ABOUT_MINE_FILE + '.mtlx' : carried.name + '.mtlx'}"&gt;</span>
                </div>
            )}
            <div className="about-track" style={{ transform: 'translate3d(' + (-index * 100) + '%,0,0)' }}>
                {ABOUT_SLIDES.map((s, i) => {
                    const isCur = i === index;
                    return (
                        <div key={s.id} className="about-slide" role="group" aria-roledescription="slide" aria-label={(i + 1) + ' of ' + n + ': ' + s.title}
                            data-about-slide={s.id} data-current={isCur ? '' : undefined} data-full={s.hidden || (s.narrowHidden && !wide) ? '' : undefined}
                            aria-hidden={isCur ? undefined : 'true'} inert={isCur ? undefined : ''}>
                            <div className="about-area about-pe custom-scrollbar" data-about-scroll="" style={{ '--al': s.area.left, '--ar': s.area.right }}>
                                <div className="my-auto w-full min-w-0">{near(i) || isCur ? slideBody(s, i) : null}</div>
                            </div>
                        </div>
                    );
                })}
            </div>
            {stageFailed && (
                <p className="absolute z-10 left-4 right-4 top-2 text-[12px] text-fg-subtle text-center pointer-events-none">A still from the Material Viewer. The live preview needs WebGL2.</p>
            )}
            <AboutNav index={index} go={go} hoverTitle={hoverTitle} setHoverTitle={setHoverTitle} touch={touch} onRestart={onRestart} />
            <p className="sr-only" aria-live="polite">{announce}</p>
        </section>
    );
}

window.AboutApp = AboutApp;
