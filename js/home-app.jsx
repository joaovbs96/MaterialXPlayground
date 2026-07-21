// home-app.jsx - the shell's landing view (hash route "#!home", the
// default route). Hero live preview, grouped feature cards, a featured
// band, and a group filter. Classic JSX like the other view apps, no
// imports - the shell Babel-transforms it on first activation.

// Nav groups for the chip filter and each section's heading below.
const HOME_GROUPS = [
    { id: 'tools', label: 'Tools', blurb: 'Preview, compare, and build MaterialX materials in the browser.' },
    { id: 'learn', label: 'Learn', blurb: 'Reference and guided material for the MaterialX standard.' },
    { id: 'integrate', label: 'Integrate', blurb: 'Take the Playground into your own pages and tools.' },
];
// All home page cards; `group` matches a HOME_GROUPS id. Cards without
// `href` render as non-interactive "coming soon" placeholders.
const HOME_CARDS = [
    { id: 'viewer', group: 'tools', href: '#!viewer', icon: 'camera', title: 'Material Viewer', desc: 'Drop in a .mtlx (with textures, a folder, or a .zip) or pick a preset, and see it rendered in real time with image-based lighting.', img: 'images/preview-material.jpg', cta: 'Open Material Viewer' },
    { id: 'compare', group: 'tools', href: '#!compare', icon: 'compare', title: 'Material Comparison', desc: 'Render two MaterialX documents side by side, with a swipe slider or a difference heatmap and SSIM/RMSE stats.', img: 'images/preview-compare.jpg', cta: 'Open Material Comparison' },
    { id: 'graph', group: 'tools', href: '#!graph', icon: 'share', title: 'Node Graph Editor', desc: 'Build MaterialX graphs visually, with nested nodegraphs, a live 3D preview, validation, and .mtlx export.', img: 'images/preview-nodegraph.jpg', cta: 'Open Node Graph Editor' },
    { id: 'whatIsMaterialx', group: 'learn', href: '#!what-is-materialx', icon: 'world', iconImg: 'images/materialx-logo.svg', title: 'What is MaterialX?', desc: 'A guided introduction to the MaterialX standard: what it is, why it exists, and how its node graphs describe a material.', img: 'images/preview-what.jpg', cta: 'Read the introduction' },
    { id: 'gallery', group: 'learn', href: '#!gallery', icon: 'layout-grid', title: 'Material Gallery', desc: 'Browse, search, and preview every example material shipped with MaterialX plus our own showcase pieces, then reopen any of them in the Viewer or Graph Editor.', img: 'images/preview-gallery.jpg', cta: 'Browse materials' },
    { id: 'docs', group: 'learn', href: '#!docs', icon: 'file-code', title: 'Node Specs', desc: 'Every standard MaterialX node, with per-signature docs, port tables, live 3D previews, and shareable permalinks.', img: 'images/preview-docs.jpg', cta: 'Browse Node Specs' },
    { id: 'tutorials', group: 'learn', href: 'tutorials/', icon: 'book', title: 'Tutorials', desc: 'Guided, hands-on MaterialX tutorials, from what MaterialX is to your first node graph, served alongside the app.', img: 'images/preview-nodegraph.jpg', cta: 'Browse tutorials' },
    { id: 'builder', group: 'integrate', href: '#!builder', icon: 'code', title: 'Embed Builder', badge: 'Experimental', desc: 'Configure an embeddable viewer, preview it live, and copy an <iframe> or custom-element snippet for any web page.', img: 'images/preview-builder.jpg', cta: 'Open Embed Builder' },
    { id: 'vscode', group: 'integrate', href: '#!vscode', icon: 'brand-vscode', title: 'VS Code extension', badge: 'Experimental', desc: 'Edit .mtlx files in VS Code with live preview, validation, and hover docs, built on the same engine as the web app.', img: 'images/preview-vscode.jpg', cta: 'Get the extension' },
];
// Featured gallery: 3 to 5 card ids, each with a free-text kicker (e.g.
// 'New in v2026.9.0'). Cycles every FEATURED_MS; an empty list hides the band.
const HOME_FEATURED = [
    { card: 'whatIsMaterialx', kicker: 'Start here' },
    { card: 'gallery', kicker: 'New: browse every MaterialX example' },
    { card: 'graph', kicker: 'Build visually' },
    { card: 'builder', kicker: 'Embed anywhere' },
];
const FEATURED_MS = 10000;
// Hero whitelist: untextured single-material presets, MaterialX ones by
// `path` and this repo's own by `src` (see MTLX_PRESETS in
// js/shared/mtlx-ui.jsx).
const HERO_PRESETS = [
    { label: 'Marble (solid)', path: 'StandardSurface/standard_surface_marble_solid.mtlx' },
    { label: 'Jade', path: 'StandardSurface/standard_surface_jade.mtlx' },
    { label: 'Gold', path: 'StandardSurface/standard_surface_gold.mtlx' },
    { label: 'Plastic', path: 'StandardSurface/standard_surface_plastic.mtlx' },
    { label: 'Copper', path: 'StandardSurface/standard_surface_copper.mtlx' },
    { label: 'Car paint', path: 'StandardSurface/standard_surface_carpaint.mtlx' },
    { label: 'Velvet', path: 'StandardSurface/standard_surface_velvet.mtlx' },
    { label: 'Chrome', path: 'StandardSurface/standard_surface_chrome.mtlx' },
    { label: 'OpenPBR default', path: 'OpenPbr/open_pbr_default.mtlx' },
    { label: 'OpenPBR car paint', path: 'OpenPbr/open_pbr_carpaint.mtlx' },
    { label: 'OpenPBR honey', path: 'OpenPbr/open_pbr_honey.mtlx' },
    { label: 'OpenPBR velvet', path: 'OpenPbr/open_pbr_velvet.mtlx' },
    { label: 'OpenPBR pearl', path: 'OpenPbr/open_pbr_pearl.mtlx' },
    { label: 'Animated noise', src: 'examples/animated_noise.mtlx' },
];
const HERO_PRESET = HERO_PRESETS[Math.floor(Math.random() * HERO_PRESETS.length)]; // one pick per page load
const HERO_CAMERA = '0,0.35,2.5,0,0,0'; // px,py,pz,tx,ty,tz, see docs/EMBEDDING.md

// 1x1 transparent PNG data URI, used as the hero element's poster so
// there's no placeholder flash before the first real frame renders.
const TRANSPARENT_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Shared badge tone: 'Experimental' gets the amber treatment, anything
// else (e.g. 'In progress') gets a neutral gray one.
const badgeClassFor = (badge) => (badge === 'Experimental'
    ? 'text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300'
    : 'text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full border border-gray-600/60 bg-gray-700/40 text-gray-400');

// Diagonal-stripe placeholder for a card with no screenshot yet.
function ComingSoonMedia() {
    return (
        <div
            className="w-full aspect-video border-b border-gray-700 flex items-center justify-center"
            style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgba(75,85,99,0.18) 0 10px, transparent 10px 20px)' }}
        >
            <span className="text-xs text-gray-500">Coming soon</span>
        </div>
    );
}

// One grid card. Link cards (internal or external) get the hover
// treatment; a card with no `href` renders as a static placeholder.
// A wordmark with a baked-in fill cannot inherit currentColor as an <img>,
// so it is masked and tinted instead. Same w-8 h-8 box as MtlxIcon, and
// self-start keeps the flex column from stretching it out of alignment.
const maskIconStyle = (url) => ({
    WebkitMaskImage: 'url(' + url + ')', maskImage: 'url(' + url + ')',
    WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center', maskPosition: 'center',
    WebkitMaskSize: 'contain', maskSize: 'contain',
});

function HomeCard({ card }) {
    const isLink = !!card.href;
    const media = card.img ? (
        <img src={card.img} alt="" loading="lazy" className="w-full aspect-video object-cover border-b border-gray-700" />
    ) : (
        <ComingSoonMedia />
    );
    const body = (
        <div className="flex flex-col flex-1 p-5">
            {card.iconImg
                ? <span aria-hidden="true" className="w-8 h-8 self-start bg-current text-blue-400"
                    style={maskIconStyle(card.iconImg)} />
                : <MtlxIcon name={card.icon} className="w-8 h-8 text-blue-400" />}
            <div className="mt-3 flex items-center flex-wrap gap-2">
                <span className="text-lg font-semibold text-gray-100">{card.title}</span>
                {card.badge && <span className={badgeClassFor(card.badge)}>{card.badge}</span>}
            </div>
            <p className="mt-1.5 text-sm text-gray-400 flex-1">{card.desc}</p>
            {isLink ? (
                <div className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-blue-400 group-hover:text-blue-300 transition-colors">
                    {card.cta} <MtlxIcon name={card.external ? 'external-link' : 'arrow-right'} className="w-3.5 h-3.5" />
                </div>
            ) : (
                <div className="mt-4 text-sm font-medium text-gray-500">{card.cta}</div>
            )}
        </div>
    );
    const linkClass = 'group flex flex-col bg-gray-800 border border-gray-800 rounded-xl overflow-hidden transition-colors hover:border-blue-500/50 hover:bg-gray-800/80';

    if (isLink && card.external) {
        return (
            <a href={card.href} target="_blank" rel="noopener noreferrer" className={linkClass}>
                {media}
                {body}
            </a>
        );
    }
    if (isLink) {
        return (
            <a href={card.href} className={linkClass}>
                {media}
                {body}
            </a>
        );
    }
    return (
        <div className="flex flex-col bg-gray-800 border border-gray-800 rounded-xl overflow-hidden">
            {media}
            {body}
        </div>
    );
}

// Crossfade for a swap. Injected here rather than in index.html so the
// whole band stays in one file.
const FEATURED_STYLE = '@keyframes mtlxFeatureIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}'
    + '.mtlx-feature-in{animation:mtlxFeatureIn 320ms ease-out}'
    + '@keyframes mtlxFeatureProgress{from{transform:scaleX(0)}to{transform:scaleX(1)}}'
    + '.mtlx-feature-progress{transform-origin:left;animation:mtlxFeatureProgress ' + FEATURED_MS + 'ms linear forwards}'
    + '@media (prefers-reduced-motion: reduce){.mtlx-feature-in{animation:none}}';

// Featured band, cycling through HOME_FEATURED every FEATURED_MS. The dots
// are siblings of the card anchor, not children: a button inside an anchor
// is invalid HTML and would swallow the click.
function FeaturedGallery({ items, active, fadeRef }) {
    const [idx, setIdx] = React.useState(0);
    const [held, setHeld] = React.useState(false);
    const [reduce] = React.useState(() => {
        try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
    });

    const count = items.length;
    const at = Math.min(idx, count - 1);
    const entry = items[at];
    const card = HOME_CARDS.find((c) => c.id === entry.card);

    // Held while the view is hidden (the shell keeps every view mounted) and
    // while a pointer or focus is inside, so the card cannot swap out from
    // under a click. `at` in the deps gives a hand-picked card a full turn.
    React.useEffect(() => {
        if (!active || held || reduce || count < 2) return undefined;
        const t = setTimeout(() => setIdx((i) => (i + 1) % count), FEATURED_MS);
        return () => clearTimeout(t);
    }, [active, held, reduce, count, at]);

    if (!card) return null;

    return (
        <div
            ref={fadeRef}
            className="relative"
            onMouseEnter={() => setHeld(true)}
            onMouseLeave={() => setHeld(false)}
            onFocus={() => setHeld(true)}
            onBlur={() => setHeld(false)}
        >
            <style>{FEATURED_STYLE}</style>
            <a
                href={card.href}
                className="relative block overflow-hidden rounded-2xl border border-blue-500/35 bg-gray-800 ring-4 ring-blue-500/[0.06] p-6 sm:p-8 hover:border-blue-500/60 transition-colors"
            >
                <div key={card.id} className="mtlx-feature-in flex flex-col lg:flex-row lg:items-center gap-6 lg:gap-8">
                    <div className="flex-1 min-w-0 space-y-2.5">
                        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-blue-300">
                            <MtlxIcon name="sparkles" className="w-3.5 h-3.5" />
                            Featured
                            <span className="text-gray-600">/</span>
                            <span className="text-gray-400">{entry.kicker}</span>
                        </div>
                        <div className="flex items-center flex-wrap gap-2.5">
                            <span className="text-2xl font-bold text-gray-100">{card.title}</span>
                            {card.badge && <span className={badgeClassFor(card.badge)}>{card.badge}</span>}
                        </div>
                        <p className="text-[15px] leading-[22px] text-gray-400 max-w-[520px]">{card.desc}</p>
                        <span className="inline-flex items-center gap-2 h-10 px-[18px] rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium mt-1.5">
                            {card.cta} <MtlxIcon name="arrow-right" className="w-4 h-4" />
                        </span>
                    </div>
                    {card.img ? (
                        <img
                            src={card.img}
                            alt=""
                            className="w-full lg:w-[440px] shrink-0 aspect-video object-cover rounded-[10px] border border-gray-700"
                        />
                    ) : (
                        <div className="w-full lg:w-[440px] shrink-0 rounded-[10px] overflow-hidden border border-gray-700">
                            <ComingSoonMedia />
                        </div>
                    )}
                </div>
                {/* Countdown to the next auto-advance, pinned inside the card's
                    bottom edge. Keyed on the run state too: the advance timer
                    re-arms from zero after a hold, so the bar restarts with it. */}
                {count > 1 && !reduce && (
                    <div className="absolute inset-x-0 bottom-0 h-0.5 bg-gray-700/40">
                        <div
                            key={at + ((active && !held) ? '-run' : '-hold')}
                            className="h-full bg-blue-500 mtlx-feature-progress"
                            style={{ animationPlayState: (active && !held) ? 'running' : 'paused' }}
                        />
                    </div>
                )}
            </a>
            {count > 1 && (
                <div className="mt-2 flex justify-center gap-1">
                    {items.map((it, i) => {
                        const c = HOME_CARDS.find((x) => x.id === it.card);
                        const on = i === at;
                        return (
                            <button
                                key={it.card}
                                type="button"
                                aria-label={'Show ' + (c ? c.title : it.card)}
                                aria-current={on ? 'true' : undefined}
                                onClick={() => setIdx(i)}
                                className={'p-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 '
                                    + (on ? '' : '[&:hover>span]:bg-gray-400')}
                            >
                                <span className={'block h-1.5 rounded-full transition-all duration-200 '
                                    + (on ? 'w-6 bg-blue-500' : 'w-1.5 bg-gray-600')} />
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// Hero's live <materialx-viewer>, built off-DOM like builder-app.jsx's
// preview so eager/src/geometry are set before it connects. Falls back to
// a static screenshot without WebGL2 or on an error before the first frame.
function HeroStage({ active, busy, onOpen }) {
    const mountRef = React.useRef(null);
    const elRef = React.useRef(null);
    const loadedRef = React.useRef(false);
    const [failed, setFailed] = React.useState(() => !(window.mtlxHasWebGL2 ? window.mtlxHasWebGL2() : true));
    const [loaded, setLoaded] = React.useState(false);

    // Created lazily on first activation, then LEFT in the DOM for good.
    // It used to be removed whenever the view went inactive, on the theory
    // that re-appending reuses the instance — but this element is backed by
    // an iframe, and re-appending an iframe reloads its document, so every
    // return to the home view flashed the iframe's white ground before the
    // first frame arrived. The shell hides this view with display:none,
    // which already stops it rendering, so removal bought nothing.
    React.useEffect(() => {
        if (failed || !active) return;
        if (!elRef.current) {
            if (!customElements.get('materialx-viewer')) {
                setFailed(true);
                return;
            }
            const el = document.createElement('materialx-viewer');
            el.eager = true;
            el.transparent = true;
            el.autorotate = true;
            el.geometry = 'shaderball';
            el.wheel = 'none';
            // Slightly closer than the engine's default framing (0,0.5,3.6)
            // so the shaderball fills the stage without clipping while turning.
            el.camera = HERO_CAMERA;
            el.poster = TRANSPARENT_PIXEL;
            // Absolute on purpose: the embed iframe resolves src against /embed/.
            el.src = HERO_PRESET.src
                ? new URL(HERO_PRESET.src, document.baseURI).href
                : window.MtlxAssets.repoUrl('resources/Materials/Examples/' + HERO_PRESET.path);
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
        // Append only when it isn't already parented here: an unconditional
        // appendChild of an attached iframe still counts as a re-insertion,
        // and reloads it.
        if (elRef.current.parentElement !== mountRef.current) {
            mountRef.current.appendChild(elRef.current);
        }
    }, [active, failed]);

    // Belt-and-braces: an error reported mid-session also tears the
    // element down immediately, not just on the next active/failed run.
    React.useEffect(() => {
        if (failed && elRef.current) elRef.current.remove();
    }, [failed]);

    const basename = (HERO_PRESET.src || HERO_PRESET.path).split('/').pop();

    return (
        <div className="relative group h-[320px] lg:h-[400px] w-full">
            <div
                className="absolute inset-0 rounded-3xl pointer-events-none"
                style={{ backgroundImage: 'radial-gradient(ellipse at center, rgba(59,130,246,0.16), transparent 66%)' }}
            />
            <div className="absolute left-1/2 -translate-x-1/2 bottom-10 w-56 h-6 rounded-[100%] bg-black/50 blur-xl pointer-events-none" />
            {failed ? (
                <img
                    src="images/preview-material.jpg"
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover rounded-2xl border border-gray-700"
                />
            ) : (
                <>
                    <div ref={mountRef} className="absolute inset-0" />
                    {!loaded && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <span className="text-xs text-gray-500">Loading material</span>
                        </div>
                    )}
                </>
            )}
            {!failed && (
                <div className="absolute top-3 left-3 flex items-center gap-2 text-[11px] leading-[14px] pointer-events-none">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                    <span className="text-gray-400">{HERO_PRESET.label}</span>
                    <span className="text-gray-600">/</span>
                    <span className="font-mono text-gray-500">{basename}</span>
                </div>
            )}
            <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-2 transition-all duration-150 opacity-0 translate-y-1 pointer-events-none group-hover:opacity-100 group-hover:translate-y-0 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:translate-y-0 focus-within:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:pointer-events-auto">
                <button type="button" disabled={!!busy} onClick={() => onOpen('viewer')} className={PILL_ACTION}>
                    <MtlxIcon name="camera" className="w-3.5 h-3.5 text-gray-500 transition-colors" />
                    {busy === 'viewer' ? 'Loading' : 'Open in Viewer'}
                </button>
                <button type="button" disabled={!!busy} onClick={() => onOpen('graph')} className={PILL_ACTION}>
                    <MtlxIcon name="share" className="w-3.5 h-3.5 text-gray-500 transition-colors" />
                    {busy === 'graph' ? 'Loading' : 'Open in Graph Editor'}
                </button>
            </div>
        </div>
    );
}

function HomeApp({ active } = {}) {
    const title = window.SITE_TITLE || 'MaterialX Playground';
    // js/site-header.js sets window.SITE_LINKS synchronously before any app
    // JSX runs (in both the browser shell and the VS Code webview).
    const links = window.SITE_LINKS;

    const [filter, setFilter] = React.useState('all');
    const [busy, setBusy] = React.useState(null);

    // Loads the target view's deps (mtlx-ui.jsx + the app itself), then
    // hands the hero's preset off to it via the same session-stash path
    // the presets dialog uses, so "Open in ..." lands on a live document.
    const openHeroIn = async (target) => {
        if (busy) return;
        setBusy(target);
        try {
            await window.mtlxLoadViewDeps(target);
            const { map, rootKey } = await window.fetchPresetFiles(HERO_PRESET);
            const xml = await map[rootKey].text();
            const files = window.looseFilesFrom(map);
            const name = rootKey.replace(/\.mtlx$/i, '');
            (target === 'viewer' ? window.openInViewer : window.openInGraphEditor)({ xml, name, files });
        } catch (e) {
            console.error('[home] hero hand-off failed', e);
        } finally {
            setBusy(null);
        }
    };

    // Linked cards only: the band is one big anchor, so a "coming soon" card
    // with no href has nowhere to go.
    const featured = HOME_FEATURED.filter((f) => HOME_CARDS.some((c) => c.id === f.card && c.href));
    const chips = [{ id: 'all', label: 'All' }, ...HOME_GROUPS];

    // Grid extent: spans the shell's scroll wrapper edge to edge (two
    // levels up, see shell.jsx's home wrapper) and fades from the
    // featured band's top to its bottom (or across the hero's lower half).
    const rootRef = React.useRef(null);
    const fadeRef = React.useRef(null);

    return (
        <div ref={rootRef} className="relative">
            <HeroGrid rootRef={rootRef} fadeRef={fadeRef} fadeFrom={featured.length ? 'top' : 'middle'} />
        <div className="relative max-w-5xl mx-auto px-2 sm:px-0 py-8 sm:py-14 space-y-10 sm:space-y-14">
            {/* Hero */}
            <div ref={featured.length ? null : fadeRef} className="flex flex-col lg:flex-row lg:items-center gap-8">
                <div className="flex-1 min-w-0 space-y-4">
                    <div className="flex items-center gap-3">
                        <svg
                            xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"
                            className="icon icon-tabler icons-tabler-filled icon-tabler-inner-shadow-bottom-right w-10 h-10 text-blue-400"
                            dangerouslySetInnerHTML={{ __html: window.SITE_LOGO_PATHS }}
                        />
                        <h1 className="text-3xl sm:text-4xl font-bold text-gray-100">{title}</h1>
                    </div>
                    <p className="text-gray-400 text-sm sm:text-base max-w-xl">
                        An interactive, open-source, in-browser playground to browse the standard
                        MaterialX node library, preview materials in real-time 3D, and
                        build node graphs visually.
                    </p>
                    <div className="flex flex-wrap gap-3 pt-1">
                        <a href="#!viewer" className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-gray-600 bg-gray-800 hover:bg-gray-700 text-sm font-medium text-gray-100 transition-colors">
                            <MtlxIcon name="camera" className="w-[18px] h-[18px] text-blue-400" />
                            Open Viewer
                        </a>
                        <a href="#!graph" className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-gray-600 bg-gray-800 hover:bg-gray-700 text-sm font-medium text-gray-100 transition-colors">
                            <MtlxIcon name="share" className="w-[18px] h-[18px] text-blue-400" />
                            Open Graph Editor
                        </a>
                        <a href="#!docs" className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-gray-600 bg-gray-800 hover:bg-gray-700 text-sm font-medium text-gray-100 transition-colors">
                            <MtlxIcon name="file-code" className="w-[18px] h-[18px] text-blue-400" />
                            Browse Node Specs
                        </a>
                    </div>
                    <p className="text-gray-500 text-xs">
                        <a
                            href={links.repo}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 underline decoration-blue-500/40"
                        >View the source on GitHub</a>.
                    </p>
                </div>
                <div className="w-full max-w-[440px] mx-auto lg:mx-0 shrink-0">
                    <HeroStage active={active} busy={busy} onOpen={openHeroIn} />
                </div>
            </div>

            {/* Featured gallery */}
            {featured.length > 0 && <FeaturedGallery items={featured} active={active} fadeRef={fadeRef} />}

            {/* Group filter */}
            <div className="flex justify-center gap-2 flex-wrap">
                {chips.map((g) => {
                    const isActive = filter === g.id;
                    return (
                        <button
                            key={g.id}
                            type="button"
                            aria-pressed={isActive}
                            onClick={() => setFilter(g.id)}
                            className={'h-8 px-3.5 rounded-full border text-[13px] font-medium transition-colors '
                                + (isActive
                                    ? 'border-blue-500 bg-blue-500/[0.12] text-blue-300'
                                    : 'border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-gray-100')}
                        >
                            {g.label}
                        </button>
                    );
                })}
            </div>

            {/* Sections */}
            {HOME_GROUPS.filter((g) => filter === 'all' || g.id === filter).map((group) => (
                <section key={group.id} className="space-y-4">
                    <div className="space-y-0.5">
                        <h2 className="text-xl font-semibold text-gray-100">{group.label}</h2>
                        <p className="text-sm text-gray-500">{group.blurb}</p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 sm:gap-6">
                        {HOME_CARDS.filter((c) => c.group === group.id).map((c) => (
                            <HomeCard key={c.id} card={c} />
                        ))}
                    </div>
                </section>
            ))}
        </div>
        </div>
    );
}

window.HomeApp = HomeApp;
