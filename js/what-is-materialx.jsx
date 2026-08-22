// js/what-is-materialx.jsx - the "What is MaterialX?" conceptual overview
// (hash route "#!what-is-materialx", reached from the home Learn group). A
// static, scrollable page like vscode-app.jsx; no imports, self-registers.

const STRONG_CLASS = 'text-gray-200 font-medium';
const CODE_CLASS = 'font-mono text-[0.9em] text-gray-200 bg-gray-700/50 border border-gray-700 rounded px-1 py-px';

// 1x1 transparent PNG data URI, copied from home-app.jsx's HeroStage so a
// <materialx-viewer> never flashes its placeholder before the first frame.
const TRANSPARENT_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Hero-only camera override. fov 45deg, shaderball bounding radius 1:
// tangent-fit distance is 1 / sin(22.5deg) = 2.613. 2.8 keeps ~7% margin
// so a portrait pane on narrow screens still can't clip, well inside 3.6.
const HERO_CAMERA = '0,0.35,2.8,0,0,0';

// "What it actually is", four pillar cards in reading order.
const WHAT_PILLARS = [
    { icon: 'article', title: 'An open standard', desc: (<>MaterialX is an open standard, with <code className={CODE_CLASS}>.mtlx</code> as its XML file format for writing a look down and moving it between applications.</>) },
    { icon: 'share', title: 'A node graph', desc: 'The look itself is a node graph: a directed acyclic graph of pattern nodes feeding a shader. Wired together, they form a material.' },
    { icon: 'puzzle', title: 'A large standard node library', desc: 'A big library of node definitions ships with the standard: math and pattern nodes, textures, and full shading building blocks, behaving the same way in every compliant implementation.' },
    { icon: 'code', title: 'Shader generation', desc: 'The same graph compiles to different shading languages through ShaderGen, so one graph can target very different renderers.' },
];

// "What it is not", all sharing the amber alert-triangle treatment.
const WHAT_NOT = [
    { title: 'Not a renderer', desc: 'MaterialX does not render anything itself. It describes a look; a renderer or engine turns that description into pixels.' },
    { title: 'Not a DCC or authoring app', desc: 'There is no MaterialX modeling or animation tool. Artists build looks inside a DCC, or a tool like this Playground, then save the result as .mtlx.' },
    { title: 'Not a single fixed shading model', desc: (<><code className={CODE_CLASS}>standard_surface</code>, OpenPBR Surface, glTF PBR and the others are all node graphs built from the standard library, not hardcoded modes.</>) },
    { title: 'No promise of identical pixels', desc: 'The spec asks implementations to support standard nodes "to the degree their architecture and capabilities allow." A look transfers without being rebuilt; rendering it in two engines is not guaranteed to look pixel-identical.' },
];

// Glossary cards: an artist-readable line first, a precise one second.
const GLOSSARY = [
    { term: 'Node', artist: 'One step in a look: a color, a texture lookup, a math operation, a blend.', precise: "An instance of a nodedef, wired to other nodes' outputs by name." },
    { term: 'Node graph', artist: 'The whole wiring diagram behind a look.', precise: 'A directed acyclic graph of nodes. A node graph can itself be used as a node inside a bigger one.' },
    { term: 'Nodedef', artist: 'The "kind" of node, before you place one.', precise: 'A node definition: its name, inputs, outputs and default values, one per type signature.' },
    { term: 'Shader', artist: 'The node at the end of the graph that knows how to shade a surface.', precise: (<>A node category. The common one is a surface shader, like <code className={CODE_CLASS}>standard_surface</code>: it outputs the <code className={CODE_CLASS}>surfaceshader</code> type and describes how light reflects, scatters and emits at the surface.</>) },
    { term: 'Material', artist: 'What actually gets put on geometry.', precise: 'A material node references one or more shaders. It does not contain shading logic itself.' },
];

// "By the numbers" facts strip: labels plus how to read each value off
// js/gen/nodelib-stats.json (fetched once by WhatIsMaterialXApp below).
// `wide` marks the two "halves" cells in the sm: 6-column layout further down.
const WHAT_FACTS = [
    { k: 'Node definitions', get: (s) => s.nodedefs },
    { k: 'Documented nodes', get: (s) => s.documented },
    { k: 'Shading models', get: (s) => s.shadingModels.length },
    { k: 'Shader targets', get: (s) => s.targets, wide: true },
    { k: 'Library Version', get: (s) => s.libraryVersion, wide: true },
];

// "A few materials": visually distinct examples, none reused from "See it".
// Each entry is either a `path` (resolved through MtlxAssets.repoUrl against
// the upstream examples tree) or a direct local `src`, which wins if set.
const SHOWCASE_MATERIALS = [
    { path: 'StandardSurface/standard_surface_chrome.mtlx', label: 'Chrome' },
    { path: 'StandardSurface/standard_surface_wood_tiled.mtlx', label: 'Wood (tiled)' },
    { src: 'materials/Motley_Patchwork_Rug/Motley_Patchwork_Rug.mtlx', label: 'Patchwork rug', note: true },
    { path: 'OpenPbr/open_pbr_pearl.mtlx', label: 'OpenPBR pearl' },
];

// "Who stewards it": Academy Software Foundation narrative cards, in
// reading order (joint launch, what it provides, MaterialX's place in it).
const STEWARD_CARDS = [
    {
        icon: 'world',
        title: 'Jointly launched in 2018',
        desc: 'The Academy Software Foundation was jointly launched by the Academy of Motion Picture Arts and Sciences and the Linux Foundation in August 2018. It provides a neutral forum for developers across the motion picture and broader media industries to collaborate on tools for image creation, visual effects, animation and sound.',
    },
    {
        icon: 'id',
        title: 'What the Foundation provides',
        desc: 'Shared continuous integration and build infrastructure, a clear contribution path, and consistent licensing. Each hosted project, including MaterialX, keeps its own governance, committer policies and release cadence.',
    },
    {
        icon: 'share',
        title: "MaterialX's place in the Foundation",
        desc: 'MaterialX has been hosted by the Academy Software Foundation since 2021, and reached its Graduated stage in 2024. It is Apache-2.0 licensed. Sibling projects include OpenEXR, OpenColorIO, OpenVDB, Open Shading Language and OpenTimelineIO.',
    },
];

// "A short history" timeline, oldest first. The bullet shows the year
// instead of a step number, adapting vscode-app.jsx's numbered <ol>.
const HISTORY = [
    {
        year: '2012',
        title: 'Originated at Lucasfilm',
        desc: 'MaterialX describes its own start as "Launched at Industrial Light and Magic in 2012." That year was a proposal; funded development began in 2013.',
    },
    {
        year: '2015',
        title: 'First production use',
        desc: (<>First used in production on <em>Star Wars: The Force Awakens</em>. It has been the central format for material description at ILM since.</>),
    },
    {
        year: '2017',
        title: 'Released as open source',
        desc: (<>Released as open source on 11 July 2017. The first public release, <code className={CODE_CLASS}>v1.35.2</code>, was tagged later that month.</>),
    },
    {
        year: '2019',
        title: 'Autodesk collaboration',
        desc: (<>MaterialX v1.36.3 (2 August 2019) merged Autodesk's shader code generation and physically based shading nodes, adding the <code className={CODE_CLASS}>MaterialXGenShader</code> library with GLSL and OSL support.</>),
    },
    {
        year: '2021',
        title: 'Joins the Academy Software Foundation',
        desc: 'Joined the Academy Software Foundation on 14 July 2021 as its seventh hosted project.',
    },
    {
        year: '2023',
        title: 'OpenPBR announced',
        desc: 'OpenPBR announced on 2 August 2023: a shading model built by Autodesk and Adobe as a MaterialX subproject, succeeding Autodesk Standard Surface and Adobe Standard Material.',
    },
    {
        year: '2024',
        title: 'OpenPBR 1.0, and Graduated stage',
        desc: "OpenPBR 1.0 released on 4 June 2024. MaterialX itself reached the Foundation's Graduated stage that September.",
    },
];

// "Getting involved": where the process is public and how to join in.
const INVOLVED_CARDS = [
    {
        icon: 'link',
        title: 'TSC meetings are open to everyone',
        desc: (<>MaterialX is run by a Technical Steering Committee. Meetings are open to anyone interested in getting involved; see the ASWF's <a href="https://www.aswf.io/meeting-calendar/" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1">meeting calendar<MtlxIcon name="external-link" className="w-3 h-3" /></a>.</>),
    },
    {
        icon: 'sparkles',
        title: 'Dev Days: a 24-hour hackathon',
        desc: (<>An ASWF-wide hackathon with tasks doable in a day, open to every experience level. It runs twice a year; MaterialX takes part. See the <a href="https://www.aswf.io/dev-days/" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1">Dev Days<MtlxIcon name="external-link" className="w-3 h-3" /></a> page.</>),
    },
    {
        icon: 'plug',
        title: 'Ask in the open',
        desc: (<>Reach the community on the <code className={CODE_CLASS}>#materialx</code> channel on the{' '}
            <a href="https://slack.aswf.io" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1">ASWF Slack<MtlxIcon name="external-link" className="w-3 h-3" /></a>, or the{' '}
            <a href="https://lists.aswf.io/g/materialx-discussion" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1">materialx-discussion<MtlxIcon name="external-link" className="w-3 h-3" /></a> mailing list.</>),
    },
    {
        icon: 'book',
        title: 'Read the contribution guide',
        desc: (<>Read <a href="https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/CONTRIBUTING.md" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1">CONTRIBUTING.md<MtlxIcon name="external-link" className="w-3 h-3" /></a> for the workflow. Contributors sign a CLA through EasyCLA, and bugs or feature requests go through{' '}
            <a href="https://github.com/AcademySoftwareFoundation/MaterialX/issues" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1">GitHub issues<MtlxIcon name="external-link" className="w-3 h-3" /></a>.</>),
    },
];

// "Learn more": this site's own pages, in mockup order.
const LEARN_SITE_LINKS = [
    { href: '#!docs', icon: 'file-code', title: 'Node Specs', desc: 'Every standard node, with port tables and live previews.' },
    { href: '#!graph', icon: 'share', title: 'Graph Editor', desc: 'Build a node graph visually and preview it in real time.' },
    { href: '#!viewer', icon: 'camera', title: 'Material Viewer', desc: 'Drop in a .mtlx and see it rendered with image-based lighting.' },
    { href: '#!vscode', icon: 'brand-vscode', title: 'VS Code extension', desc: 'Edit .mtlx files with live preview and hover docs.' },
];

// Section heading, matching vscode-app.jsx's SectionHead look.
function SectionHead({ id, title, blurb }) {
    return (
        <div className="space-y-0.5">
            <h2 id={id} className="text-xl sm:text-2xl font-semibold text-gray-100">{title}</h2>
            {blurb && <p className="text-sm text-gray-500 max-w-[40em]">{blurb}</p>}
        </div>
    );
}

// One live <materialx-viewer>, following home-app.jsx's HeroStage recipe:
// created off-DOM, never re-appended. No `eager`: only non-eager panes
// ever get an observer, so the hero can recover after an LRU eviction.
function ViewerPane({ src, label, glow, className, geometry, transparent, autorotate, camera, frame = true }) {
    const mountRef = React.useRef(null);
    const elRef = React.useRef(null);
    const loadedRef = React.useRef(false);
    const [failed, setFailed] = React.useState(() => !(window.mtlxHasWebGL2 ? window.mtlxHasWebGL2() : true));
    const [loaded, setLoaded] = React.useState(false);
    // Only the orbitable 'shaderball-scene' backdrop needs a reset button.
    const showReset = geometry === 'shaderball-scene';

    React.useEffect(() => {
        if (failed) return;
        if (!elRef.current) {
            if (!customElements.get('materialx-viewer')) {
                setFailed(true);
                return;
            }
            const el = document.createElement('materialx-viewer');
            el.transparent = !!transparent;
            el.autorotate = !!autorotate;
            el.geometry = geometry;
            el.wheel = 'none';
            if (camera) el.camera = camera;
            // Experimental depth-peeled alpha blending for opacity and
            // transmission, forced on for every viewer on this page.
            // Unrelated to `transparent` above (that's the iframe page background).
            el.forceTransparency = true;
            el.poster = TRANSPARENT_PIXEL;
            el.src = src;
            el.style.width = '100%';
            el.style.height = '100%';
            el.addEventListener('mtlx-renderables', (e) => {
                if (Array.isArray(e.detail) && e.detail.length) {
                    loadedRef.current = true;
                    setLoaded(true);
                }
            });
            el.addEventListener('mtlx-error', () => {
                if (!loadedRef.current) setFailed(true);
            });
            elRef.current = el;
        }
        // Append only when it isn't already parented here, matching
        // HeroStage: an unconditional appendChild of an attached iframe
        // still counts as a re-insertion, and reloads it.
        if (elRef.current.parentElement !== mountRef.current) {
            mountRef.current.appendChild(elRef.current);
        }
    }, [failed, src, geometry, transparent, autorotate, camera]);

    React.useEffect(() => {
        if (failed && elRef.current) elRef.current.remove();
    }, [failed]);

    return (
        <div className="flex flex-col gap-2 min-w-0">
            <div className={'relative ' + (className || 'h-64')}>
                {glow && (
                    <div
                        aria-hidden="true"
                        className="absolute -inset-y-16 inset-x-0 rounded-[28px] pointer-events-none"
                        style={{ backgroundImage: 'radial-gradient(ellipse closest-side at 55% 45%, rgba(59,130,246,0.22), rgba(59,130,246,0.08) 55%, transparent 100%)' }}
                    />
                )}
                <div className={'group relative w-full h-full overflow-hidden' + (frame ? ' rounded-xl border border-gray-700 bg-gray-900/60' : '')}>
                    {failed ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-4">
                            <MtlxIcon name="cube" className="w-6 h-6 text-gray-600" />
                            <span className="text-xs text-gray-500">3D preview needs WebGL2</span>
                        </div>
                    ) : (
                        <>
                            <div ref={mountRef} className="absolute inset-0" />
                            {!loaded && (
                                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                    <span className="text-xs text-gray-500">Loading material</span>
                                </div>
                            )}
                            {showReset && (
                                <button
                                    type="button"
                                    onClick={() => elRef.current && elRef.current.resetCamera()}
                                    title="Reset camera"
                                    aria-label="Reset camera"
                                    className="absolute bottom-2 right-2 inline-flex items-center justify-center w-7 h-7 rounded-md border border-gray-600/50 bg-gray-900/70 text-gray-400 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-gray-700 hover:border-gray-600 hover:text-gray-100 [@media(hover:none)]:opacity-100"
                                >
                                    <MtlxIcon name="camera-reset" className="w-4 h-4" />
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>
            {label && <p className="text-xs text-gray-500 text-center">{label}</p>}
        </div>
    );
}

// Footnote marker for the vendored material. An href="#id" would rewrite
// the shell's hash route and navigate away, so this scrolls to the note
// instead. The note carries tabIndex -1 so focus can follow the scroll.
function LicenseRef() {
    const go = () => {
        const el = document.getElementById('rug-license');
        if (!el) return;
        let smooth = true;
        try { smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* default to smooth */ }
        el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
        el.focus();
    };
    return (
        <button
            type="button"
            onClick={go}
            title="See the licensing note"
            aria-label="See the licensing note for this material"
            className="align-super text-[9px] leading-none text-blue-400 hover:text-blue-300 transition-colors"
        >1</button>
    );
}

// Inline "by the numbers" value: an animated ellipsis (matching the
// 'Generating…' loading style elsewhere on this site) until `value` is
// available, so a stale number is never shown, not even briefly.
function Stat({ value }) {
    if (value == null) return <span className="text-gray-600 animate-pulse">…</span>;
    return <>{value}</>;
}

// Renders the curated shading-model names (js/gen/nodelib-stats.json's
// shadingModels) as a comma-and-and joined <code> list, so the prose and
// the facts strip's count can never disagree. Same loading treatment as Stat.
function ShadingModelNames({ names }) {
    if (!names) return <span className="text-gray-600 animate-pulse">…</span>;
    return names.map((name, i) => (
        <React.Fragment key={name}>
            <code className={CODE_CLASS}>{name}</code>
            {i < names.length - 2 ? ', ' : i === names.length - 2 ? ' and ' : ''}
        </React.Fragment>
    ));
}

function WhatIsMaterialXApp({ active } = {}) {
    const links = window.SITE_LINKS;

    const rootRef = React.useRef(null);
    const fadeRef = React.useRef(null);

    // "By the numbers" stats, fetched once; stays null (placeholders show)
    // on any failure so a fetch error can never surface as a page error.
    const [stats, setStats] = React.useState(null);
    React.useEffect(() => {
        let cancelled = false;
        fetch('js/gen/nodelib-stats.json')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
            .then((data) => { if (!cancelled) setStats(data); })
            .catch(() => { /* keep placeholders; never let this reach the console */ });
        return () => { cancelled = true; };
    }, []);

    const heroSrc = window.MtlxAssets.repoUrl('resources/Materials/Examples/StandardSurface/standard_surface_gold.mtlx');
    const marbleSrc = window.MtlxAssets.repoUrl('resources/Materials/Examples/StandardSurface/standard_surface_marble_solid.mtlx');

    const officialLinks = [
        { href: links.spec, title: 'Specification (v1.39, pinned build)' },
        { href: links.specMain, title: 'Specification source (latest)' },
        { href: links.repo, title: 'MaterialX on GitHub' },
        { href: 'https://materialx.org/', title: 'materialx.org' },
        { href: 'https://academysoftwarefoundation.github.io/OpenPBR/', title: 'OpenPBR specification' },
        { href: 'https://academysoftwarefdn.slack.com/archives/C0230LWBE2X', title: 'MaterialX on ASWF Slack' },
    ];

    // The hero glow spreads vertically only (-inset-y-16, inset-x-0). Horizontal
    // spread would either widen the page or need a clip, and a clip cuts the
    // gradient while it is still tinted, which is the visible hard edge.
    return (
        <div ref={rootRef} className="relative">
            <HeroGrid rootRef={rootRef} fadeRef={fadeRef} fadeFrom="top" />
            <div className="relative max-w-5xl mx-auto px-2 sm:px-0 py-8 sm:py-14 space-y-12 sm:space-y-16">

                {/* Breadcrumb */}
                <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-gray-500">
                    <a href="#!home" className="hover:text-gray-300 transition-colors">Home</a>
                    <MtlxIcon name="chevron-right" className="w-3 h-3" />
                    <span>Learn</span>
                    <MtlxIcon name="chevron-right" className="w-3 h-3" />
                    <span className="text-gray-400">What is MaterialX?</span>
                </nav>

                {/* Hero */}
                <section aria-labelledby="whatis-h1" className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px] gap-8 items-center">
                    <div className="flex flex-col gap-[18px] min-w-0">
                        <img src="images/materialx-logo.svg" alt="MaterialX" className="w-28 sm:w-32 h-auto" />
                        <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-blue-300">
                            Learn <span className="text-gray-600">/</span> <span className="text-gray-400">What is MaterialX?</span>
                        </div>
                        <h1 id="whatis-h1" className="text-[28px] sm:text-[34px] leading-[1.15] font-bold tracking-[-0.01em] text-gray-100 text-balance">What is MaterialX?</h1>
                        <p className="text-gray-400 text-base leading-6 max-w-[34em]">
                            MaterialX is an open standard for describing how a surface looks: the pattern network, the
                            shader it feeds, and the material that puts it on geometry. Write it once as one{' '}
                            <code className={CODE_CLASS}>.mtlx</code> file, and take it into a different renderer or DCC{' '}
                            <strong className={STRONG_CLASS}>without rebuilding it by hand</strong>.
                        </p>
                        <div className="flex flex-wrap gap-3 items-stretch pt-1">
                            <a href="#!graph" className="inline-flex items-center gap-2 h-11 px-4 rounded-[10px] bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium shadow-[0_0_0_4px_rgba(59,130,246,0.10)] transition-colors">
                                <MtlxIcon name="share" className="w-[18px] h-[18px]" />
                                Open the Graph Editor
                            </a>
                            <a href={links.spec} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 h-11 px-4 rounded-[10px] border border-gray-600 bg-gray-800 hover:bg-gray-700 text-sm font-medium text-gray-100 transition-colors">
                                <MtlxIcon name="external-link" className="w-[18px] h-[18px] text-blue-400" />
                                Read the specification
                            </a>
                        </div>
                    </div>
                    <div className="min-w-0">
                        <ViewerPane src={heroSrc} label="Gold, rendered live" geometry="shaderball" transparent autorotate camera={HERO_CAMERA} frame={false} glow className="h-[280px] sm:h-[340px] lg:h-[380px]" />
                    </div>
                </section>

                {/* The problem it solves */}
                <section aria-labelledby="problem-h" className="space-y-3">
                    <SectionHead id="problem-h" title="The problem it solves" />
                    <p className="text-sm leading-6 text-gray-400 max-w-[60em]">
                        A look built in one application usually has to be rebuilt by hand for the next renderer or DCC.
                        MaterialX exists to carry the whole picture across that move: the pattern network that generates
                        a surface's colors and roughness, the geometry-specific detail that network can read, which
                        shader that pattern feeds on which piece of geometry, and how a whole scene's materials get
                        assigned together as a look. All four travel in the same file, so the look survives the move
                        instead of being rebuilt from scratch.
                    </p>
                </section>

                {/* What it actually is */}
                {/* fadeRef lives here, not on a paragraph: HeroGrid fades across
                   this element's own height, so a short block makes the grid stop
                   abruptly instead of dissolving the way it does on home. */}
                <section ref={fadeRef} aria-labelledby="what-h" className="space-y-5">
                    <SectionHead id="what-h" title="What it actually is" />
                    <div className="grid grid-cols-1 [@media(min-width:720px)]:grid-cols-2 [@media(min-width:860px)]:grid-cols-4 gap-4">
                        {WHAT_PILLARS.map((p) => (
                            <div key={p.title} className="bg-gray-800 border border-gray-800 rounded-xl px-5 py-[18px] flex flex-col gap-2">
                                <div className="w-9 h-9 rounded-[9px] bg-blue-500/10 border border-blue-500/25 flex items-center justify-center text-blue-400">
                                    <MtlxIcon name={p.icon} className="w-[18px] h-[18px]" />
                                </div>
                                <h3 className="text-[15px] font-semibold text-gray-100">{p.title}</h3>
                                <p className="text-sm leading-5 text-gray-400">{p.desc}</p>
                            </div>
                        ))}
                    </div>
                </section>

                {/* What it is not */}
                <section aria-labelledby="notwhat-h" className="space-y-5">
                    <SectionHead id="notwhat-h" title="What it is not" blurb="Just as useful to know as what it is." />
                    <div className="grid grid-cols-1 [@media(min-width:720px)]:grid-cols-2 gap-3">
                        {WHAT_NOT.map((n) => (
                            <div key={n.title} className="grid grid-cols-[20px_minmax(0,1fr)] gap-3 bg-gray-800 border border-gray-800 rounded-xl px-4 py-3.5">
                                <MtlxIcon name="alert-triangle" className="w-[18px] h-[18px] text-amber-300 mt-0.5" />
                                <div className="min-w-0">
                                    <div className="text-sm font-semibold text-gray-100 mb-0.5">{n.title}</div>
                                    <p className="text-[13.5px] leading-[19px] text-gray-400">{n.desc}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                {/* See it */}
                <section aria-labelledby="seeit-h" className="space-y-4">
                    <SectionHead id="seeit-h" title="See it" blurb="The node graph and the material it renders, in one panel." />
                    <MtlxGraphPreview
                        src={marbleSrc}
                        chrome="card"
                        height={380}
                        autoFocus="fit"
                        label="Node graph of the marble material"
                        preview="right"
                    />
                    <p className="text-xs text-gray-500 text-center">
                        <code className={CODE_CLASS}>standard_surface_marble_solid.mtlx</code>: the node graph that builds
                        the pattern (built around NG_marble1), with a live preview of the rendered material attached
                        alongside it.
                    </p>
                </section>

                {/* The vocabulary */}
                <section aria-labelledby="vocab-h" className="space-y-5">
                    <SectionHead id="vocab-h" title="The vocabulary" blurb="Five words that come up constantly." />
                    {/* Six columns, not three: the first three cards take two each
                        (thirds) and the last two take three each (halves), so the
                        five cards fill both rows instead of leaving a gap. */}
                    <div className="grid grid-cols-1 [@media(min-width:720px)]:grid-cols-2 [@media(min-width:860px)]:grid-cols-6 gap-4">
                        {GLOSSARY.map((g, i) => (
                            <div key={g.term} className={'bg-gray-800 border border-gray-800 rounded-xl px-5 py-[18px] flex flex-col gap-1.5 '
                                + (i < 3 ? '[@media(min-width:860px)]:col-span-2' : '[@media(min-width:860px)]:col-span-3')
                                + (i === GLOSSARY.length - 1 ? ' [@media(min-width:720px)_and_(max-width:859px)]:col-span-2' : '')}>
                                <h3 className="text-[15px] font-semibold text-gray-100">{g.term}</h3>
                                <p className="text-sm leading-5 text-gray-400">{g.artist}</p>
                                <p className="text-sm leading-5 text-gray-500">{g.precise}</p>
                            </div>
                        ))}
                    </div>
                </section>

                {/* By the numbers */}
                <section aria-labelledby="numbers-h" className="space-y-5">
                    <SectionHead id="numbers-h" title="By the numbers" />
                    <div aria-label="MaterialX by the numbers" className="grid grid-cols-2 sm:grid-cols-6 lg:grid-cols-5 gap-px bg-gray-700 border border-gray-800 rounded-xl overflow-hidden">
                        {WHAT_FACTS.map((f, i) => (
                            <div key={f.k} className={'bg-gray-800 p-3.5 sm:p-4 flex flex-col gap-0.5 min-w-0 '
                                + (i === WHAT_FACTS.length - 1 ? 'col-span-2 ' : '')
                                + (f.wide ? 'sm:col-span-3 ' : 'sm:col-span-2 ') + 'lg:col-span-1'}>
                                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-500">{f.k}</span>
                                <span className="text-sm font-medium text-gray-100 truncate">
                                    {stats ? f.get(stats) : <span className="text-gray-600 animate-pulse">…</span>}
                                </span>
                            </div>
                        ))}
                    </div>
                    <p className="text-xs text-gray-500">
                        <Stat value={stats && stats.nodedefs} /> node definitions sit behind the <Stat value={stats && stats.documented} />{' '}
                        nodes in Node Specs: one node can have many definitions, one per type signature{' '}
                        (<code className={CODE_CLASS}>convert</code> alone has 47).
                        All <Stat value={stats && stats.shadingModels && stats.shadingModels.length} /> shading models,{' '}
                        <ShadingModelNames names={stats && stats.shadingModels} />, are node graphs built from standard BSDF
                        nodes rather than per-renderer native code, alongside 13 MaterialX Lama nodes and 4 translation
                        graphs between models such as <code className={CODE_CLASS}>standard_surface_to_gltf_pbr</code>.
                        Of the <Stat value={stats && stats.targets} /> shader targets, genglsl, genosl and genmdl are
                        independent roots; essl, genmsl and genslang build on the GLSL implementations.
                    </p>
                </section>

                {/* A few materials */}
                <section aria-labelledby="materials-h" className="space-y-5">
                    <SectionHead id="materials-h" title="A few materials" blurb="Different looks, the same node system underneath." />
                    <div className="grid grid-cols-1 [@media(min-width:720px)]:grid-cols-2 [@media(min-width:860px)]:grid-cols-4 gap-4">
                        {SHOWCASE_MATERIALS.map((m) => (
                            <ViewerPane
                                key={m.src || m.path}
                                src={m.src || window.MtlxAssets.repoUrl('resources/Materials/Examples/' + m.path)}
                                label={m.note ? (<>{m.label} <LicenseRef /></>) : m.label}
                                geometry="shaderball-scene"
                                className="h-56 sm:h-64"
                            />
                        ))}
                    </div>
                </section>

                {/* Who stewards it */}
                <section aria-labelledby="steward-h" className="space-y-5">
                    <SectionHead id="steward-h" title="Who stewards it" blurb="MaterialX is hosted by the Academy Software Foundation, alongside sibling open source projects for film and media production." />
                    <div className="grid grid-cols-1 [@media(min-width:720px)]:grid-cols-3 gap-4">
                        {STEWARD_CARDS.map((c) => (
                            <div key={c.title} className="bg-gray-800 border border-gray-800 rounded-xl px-5 py-[18px] flex flex-col gap-2">
                                <div className="w-9 h-9 rounded-[9px] bg-blue-500/10 border border-blue-500/25 flex items-center justify-center text-blue-400">
                                    <MtlxIcon name={c.icon} className="w-[18px] h-[18px]" />
                                </div>
                                <h3 className="text-[15px] font-semibold text-gray-100">{c.title}</h3>
                                <p className="text-sm leading-5 text-gray-400">{c.desc}</p>
                            </div>
                        ))}
                    </div>
                </section>

                {/* A short history */}
                <section aria-labelledby="history-h" className="space-y-5">
                    <SectionHead id="history-h" title="A short history" blurb="From a proposal at Lucasfilm to a Graduated project of the Academy Software Foundation." />
                    <ol className="relative list-none m-0 p-0 mx-auto max-w-3xl">
                        {/* One continuous spine for the whole list: centred on wide
                           screens, left gutter below 720px. Badges have a solid
                           background so it appears to pass behind them. */}
                        <span aria-hidden="true" className="absolute top-4 bottom-4 w-0.5 bg-gray-800 left-[22px] [@media(min-width:720px)]:left-1/2 [@media(min-width:720px)]:-translate-x-1/2" />
                        {HISTORY.map((h, i) => (
                            <li key={h.year} className={'relative grid grid-cols-[auto_minmax(0,1fr)] [@media(min-width:720px)]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-x-4 sm:gap-x-6' + (i < HISTORY.length - 1 ? ' pb-8' : '')}>
                                <span className="w-11 h-8 rounded-full bg-gray-800 border border-gray-600 text-blue-300 text-[13px] font-semibold flex items-center justify-center tabular-nums [@media(min-width:720px)]:col-start-2 [@media(min-width:720px)]:justify-self-center">{h.year}</span>
                                <div className={'flex flex-col gap-1 pt-1 min-w-0'
                                    + (i % 2 === 1 ? ' [@media(min-width:720px)]:col-start-3' : ' [@media(min-width:720px)]:col-start-1 [@media(min-width:720px)]:text-right')}>
                                    <h3 className="text-[15px] font-semibold text-gray-100">{h.title}</h3>
                                    <p className="text-sm leading-[21px] text-gray-400">{h.desc}</p>
                                </div>
                            </li>
                        ))}
                    </ol>
                </section>

                {/* Getting involved */}
                <section aria-labelledby="involved-h" className="space-y-5">
                    <SectionHead id="involved-h" title="Getting involved" blurb="The process is public, and there are several low-friction ways in." />
                    <div className="grid grid-cols-1 [@media(min-width:720px)]:grid-cols-2 [@media(min-width:860px)]:grid-cols-4 gap-4">
                        {INVOLVED_CARDS.map((c) => (
                            <div key={c.title} className="bg-gray-800 border border-gray-800 rounded-xl px-5 py-[18px] flex flex-col gap-2">
                                <div className="w-9 h-9 rounded-[9px] bg-blue-500/10 border border-blue-500/25 flex items-center justify-center text-blue-400">
                                    <MtlxIcon name={c.icon} className="w-[18px] h-[18px]" />
                                </div>
                                <h3 className="text-[15px] font-semibold text-gray-100">{c.title}</h3>
                                <p className="text-sm leading-5 text-gray-400">{c.desc}</p>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Learn more */}
                <section aria-labelledby="more-h" className="space-y-5">
                    <SectionHead id="more-h" title="Learn more" />
                    <div className="grid grid-cols-1 [@media(min-width:720px)]:grid-cols-2 gap-4">
                        <div className="bg-gray-800 border border-gray-800 rounded-xl px-5 py-[18px] flex flex-col gap-1">
                            <h3 className="text-[15px] font-semibold text-gray-100 mb-1.5">On this site</h3>
                            {LEARN_SITE_LINKS.map((l) => (
                                <a key={l.href} href={l.href} className="group flex items-start gap-2.5 py-1.5 transition-colors">
                                    <MtlxIcon name={l.icon} className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                                    <span className="flex-1 min-w-0">
                                        <span className="block text-sm text-gray-100 group-hover:text-white transition-colors">{l.title}</span>
                                        <span className="block text-xs text-gray-500">{l.desc}</span>
                                    </span>
                                    <MtlxIcon name="arrow-right" className="w-3.5 h-3.5 text-gray-600 group-hover:text-gray-400 transition-colors mt-0.5 shrink-0" />
                                </a>
                            ))}
                        </div>
                        <div className="bg-gray-800 border border-gray-800 rounded-xl px-5 py-[18px] flex flex-col gap-1">
                            <h3 className="text-[15px] font-semibold text-gray-100 mb-1.5">Official sources</h3>
                            {officialLinks.map((l) => (
                                <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className="group flex items-center gap-2.5 py-1.5 text-sm text-gray-300 hover:text-gray-100 transition-colors">
                                    <span className="flex-1 min-w-0">{l.title}</span>
                                    <MtlxIcon name="external-link" className="w-3.5 h-3.5 text-gray-600 group-hover:text-gray-400 transition-colors" />
                                </a>
                            ))}
                        </div>
                    </div>
                </section>

                {/* Disclaimer */}
                <div className="pt-6 border-t border-gray-800 space-y-2">
                    <p id="rug-license" tabIndex={-1} className="text-xs text-gray-500 scroll-mt-24 focus:outline-none">
                        <span className="text-gray-600">1.</span> The Patchwork rug material shown above is from the AMD GPU Open material library, used under
                        the{' '}
                        <a
                            href="materials/Motley_Patchwork_Rug/LICENSE.txt"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 underline decoration-blue-500/40"
                        >MIT License</a>, copyright 2022 AMD.
                    </p>
                    <p className="text-xs text-gray-500">
                        This is an independent community project. It is not affiliated with, endorsed by, or sponsored
                        by the MaterialX project, the Academy Software Foundation, or the Linux Foundation. MaterialX is
                        a trademark of the Academy Software Foundation. The MaterialX specification is the definitive
                        source of truth.
                    </p>
                </div>
            </div>
        </div>
    );
}

window.WhatIsMaterialXApp = WhatIsMaterialXApp;
