// vscode-app.jsx - the "VS Code extension" view (hash route "#!vscode"),
// reached from the home card and the Integrate menu. A static, scrollable
// page like home-app.jsx: hero, facts strip, how-it-works through bottom CTA.

// Amber "Experimental" pill, byte-identical to home-app.jsx's
// badgeClassFor('Experimental') string.
const EXPERIMENTAL_BADGE_CLASS = 'text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full border border-experimental-hue/40 bg-experimental-hue/10 text-experimental';
// Small uppercase pill used for feature/soon tags ("Read only", "Soon"...).
const TAG_PILL_CLASS = 'text-[10px] font-medium uppercase tracking-wide px-[7px] py-px rounded-full border border-line-strong text-fg-muted';
const STRONG_CLASS = 'text-fg-soft font-medium';
const CODE_BLOCK_CLASS = 'bg-code-block-bg border border-line rounded-[10px] px-3.5 py-3 font-mono text-[12.5px] leading-[18px] text-fg-soft';
// Inline `<code>` styling: the site has no global rule for bare <code>.
const CODE_CLASS = 'font-mono text-[0.9em] text-fg-soft bg-code-inline-bg/50 border border-line rounded px-1 py-px';

// "How it works" flow-diagram cards, in mockup order.
const VSCODE_HOW = [
    {
        icon: 'layout-columns',
        title: '1. Open a .mtlx file',
        desc: (<>The Playground <strong className={STRONG_CLASS}>opens beside the text editor</strong> automatically (or via right-click, <em>Open With</em>, or the Command Palette). It reuses the right-hand editor group instead of splitting again on every open.</>),
    },
    {
        icon: 'refresh',
        title: '2. Edit on either side',
        desc: (<>Typing in the text editor <strong className={STRONG_CLASS}>live-reloads</strong> the Playground. Graph edits are written <strong className={STRONG_CLASS}>straight into the open .mtlx buffer</strong> as they settle (a slider lands once, shortly after you release it), so the text editor updates too and the tab shows unsaved changes. <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd> saves to disk from either side; <Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> / <Kbd>Ctrl</Kbd>+<Kbd>Y</Kbd> in the graph use VS Code's own document undo, so graph and text share one history.</>),
    },
    {
        icon: 'wifi-off',
        title: '3. Nothing leaves your machine',
        desc: (<>The webview loads the <strong className={STRONG_CLASS}>bundled site, libraries, and MaterialX WASM</strong> from the extension itself. The .vsix ships an offline snapshot of the MaterialX spec and examples, so it works with no network at all.</>),
    },
];

// "Features" items, two columns on desktop, in mockup order.
const VSCODE_FEATURES = [
    { icon: 'share', title: 'Node Graph Editor', desc: 'The full graph editor: nested nodegraphs, live 3D preview, validation, node docs dialog. Every edit lands in the .mtlx buffer immediately; Ctrl+S saves the file.' },
    { icon: 'camera', title: 'Material Viewer', tag: 'Read only', desc: (<>Image-based lighting, geometry picker, turntable, save as PNG. Switching to it always shows the graph editor's current state, unsaved edits included.</>) },
    { icon: 'download', title: 'Exports use a native Save dialog', desc: "Screenshots, turntable GIFs, .mtlx and zip exports, and generated shader code all open VS Code's own Save dialog, defaulting to the open document's folder." },
    { icon: 'file-code', title: 'Syntax highlighting and file icon', desc: (<>.mtlx files get a "MaterialX" language mode with XML highlighting, <code className={CODE_CLASS}>{'<!-- -->'}</code> comment toggling, auto-closing quotes, a matching file icon, and an Open Preview button on the editor toolbar.</>) },
    { icon: 'list-details', title: 'Outline and navigation', desc: 'Materials, node graphs, node definitions and their inputs and outputs show up in the Outline, breadcrumbs and Go to Symbol. Go to Definition and Find All References work for node, nodegraph, output, interfacename and nodedef references.' },
    { icon: 'color-swatch', title: 'Color swatches and picker', desc: "Color3 and color4 values show an inline swatch in the text editor. Opening the picker writes the new color back converted into that value's own color space." },
    { icon: 'sparkles', title: 'Snippets', desc: 'Ready-made snippets for a new document, a standard_surface or OpenPBR material, a texture chain, a normal map chain, a node graph, and a typed input.' },
    { icon: 'code', title: 'Auto-complete', desc: "Suggests node categories, an element's inputs with their types, and only the attributes that element actually supports, plus valid attribute values: types, color spaces, units, versions, node definitions, targets and references." },
    { icon: 'file-check', title: 'Live validation', desc: 'Runs off the editor thread as you type: XML well-formedness first, then MaterialX validate() through the bundled WASM build. Documents using xi:include get XML checks only. Results show in the Problems panel and a status bar item.' },
    { icon: 'book', title: 'Hover docs', tag: 'In the text editor', desc: (<>In the .mtlx text editor, hover a node tag like <code className={CODE_CLASS}>{'<standard_surface>'}</code> or a <code className={CODE_CLASS}>{'node="..."'}</code> value to see its description and port table from the MaterialX spec, with links to the Interactive Documentation panel and the official spec.</>) },
    { icon: 'external-link', title: 'Node Library Documentation panel', desc: 'Browse the whole node library without a file open, from the Command Palette or a .mtlx context menu. Hover deep-links land on the exact node and signature. Its 3D previews start switched off to keep the webview light.' },
    { icon: 'folder', title: 'Textures load straight from disk', desc: (<>Sibling textures and <code className={CODE_CLASS}>{'xi:include'}</code> documents are found automatically, including large 4K and 8K textures. References must stay inside the workspace folder that contains the document.</>) },
    { icon: 'file-plus', title: 'New Material from Example', desc: 'Copies one of 14 ready-made materials, four from the Playground and ten from the MaterialX examples, into your workspace along with any textures it needs, then opens it.' },
    { icon: 'cube', title: 'Scene Viewer', tag: 'Read only', desc: 'Open .usd, .usda, .usdc, .usdz, .gltf, .glb and .obj files: sublayers, references, payloads, buffers, materials, and the MaterialX materials and textures they use load straight from the workspace.' },
];

// Three equal-width cards below the install steps.
const VSCODE_ASIDE = [
    {
        icon: 'refresh',
        title: 'Updating',
        body: (<p className="text-[13.5px] leading-[19px] text-fg-muted">A .vsix install <strong className={STRONG_CLASS}>does not update itself</strong>. When a new release is out, download the new file and install it the same way; VS Code replaces the installed version in place. Your settings are kept.</p>),
    },
    {
        icon: 'trash',
        title: 'Uninstalling',
        body: (
            <>
                <p className="text-[13.5px] leading-[19px] text-fg-muted">In the Extensions view, find <strong className={STRONG_CLASS}>MaterialX Playground</strong>, open its gear menu, and choose <strong className={STRONG_CLASS}>Uninstall</strong>. Or from a terminal:</p>
                <pre className={CODE_BLOCK_CLASS + ' whitespace-pre-wrap break-normal [overflow-wrap:anywhere]'}>code --uninstall-extension local.materialx-playground</pre>
            </>
        ),
    },
    {
        icon: 'settings-cog',
        title: 'Optional: Playground-only mode',
        body: (
            <>
                <p className="text-[13.5px] leading-[19px] text-fg-muted">Nothing to configure for the default split view: .mtlx files open in the text editor and the Playground auto-opens beside them. If you would rather have .mtlx files open <strong className={STRONG_CLASS}>straight into the Playground with no text editor</strong>, make it the default editor in <code className={CODE_CLASS}>settings.json</code> (the text editor stays reachable via Open With...):</p>
                <pre className={CODE_BLOCK_CLASS + ' whitespace-pre-wrap break-normal [overflow-wrap:anywhere]'}>{'"workbench.editorAssociations": {\n  "*.mtlx": "materialxPlayground.editor"\n}'}</pre>
            </>
        ),
    },
];

// Settings table rows, in mockup order. `values` marks each default inline.
const VSCODE_SETTINGS = [
    {
        setting: 'materialxPlayground.defaultView',
        values: (<>"graph" <span className="text-fg-subtle text-xs font-mono">(default)</span>, "viewer"</>),
        desc: 'Which view is visible first when a .mtlx file opens. Both views load the document either way; the header nav switches between them.',
    },
    {
        setting: 'materialxPlayground.openBehavior',
        values: (<>"splitRight" <span className="text-fg-subtle text-xs font-mono">(default)</span>, "sameGroup"</>),
        desc: 'Open the Playground beside the text editor, reusing the right-hand group on repeat opens, or in the active editor group.',
    },
    {
        setting: 'materialxPlayground.autoOpenPlayground',
        values: (<>true <span className="text-fg-subtle text-xs font-mono">(default)</span>, false</>),
        desc: 'Automatically open the Playground beside the text editor whenever a .mtlx file is opened. Fires once per file open; closing the Playground does not re-trigger it.',
    },
    {
        setting: 'materialxPlayground.pickFileOnFilenameInput',
        values: (<>true <span className="text-fg-subtle text-xs font-mono">(default)</span>, false</>),
        desc: 'When a filename input is added from auto-complete, open a file picker right away to choose the file.',
    },
    {
        setting: 'materialxPlayground.syncSelection',
        values: (<>true <span className="text-fg-subtle text-xs font-mono">(default)</span>, false</>),
        desc: 'Keep the text cursor, the MaterialX Outline and the Graph Editor selection in sync.',
    },
    {
        setting: 'materialxPlayground.autoOpenSceneViewer',
        values: (<>true <span className="text-fg-subtle text-xs font-mono">(default)</span>, false</>),
        desc: 'Automatically open the Scene Viewer whenever a USD, glTF, GLB or OBJ scene file is opened: beside the text editor for a file VS Code opens as text, or replacing the tab for a file VS Code shows as binary. Fires once per file open.',
    },
];

// Six limitation cards, all sharing the amber alert-triangle icon.
const VSCODE_LIMITS = [
    { title: 'Manual installs and updates', desc: 'Distributed as a .vsix from GitHub Releases only. No Marketplace listing yet, so no automatic updates: check this page or the releases feed for new versions.' },
    { title: 'Graph edits re-serialize the document', desc: (<>Only the Node Graph Editor edits the file; the Material Viewer is read-only. Any graph edit replaces the buffer with the app's own serialization of the whole document, so attribute order and formatting can differ from what you typed by hand.</>) },
    { title: 'One MaterialX version, no Compare view', desc: 'The .vsix bundles only the default MaterialX build (v1.39.5). The Material Comparison view, the one feature that needs several versions side by side, stays web-only; the webview nav has just Material Viewer and Graph.' },
    { title: 'References must stay in the workspace folder', desc: 'Textures and included files must be inside the workspace folder that contains the document, or next to the document itself when no folder is open.' },
    { title: 'Some web-app UI is hidden', desc: 'Home, New/Import/Presets, drag-and-drop, the Material Viewer\'s file sidebar, and Send-to buttons do not apply to a single open file, so the webview hides them. The Docs tab is replaced by the separate docs command.' },
    { title: 'Memory scales with open tabs', desc: 'Each open .mtlx tab is its own webview with its own MaterialX WASM instance and WebGL context, kept alive while backgrounded so switching tabs is instant. The first shader compile after opening a file can take a few seconds while the WASM build warms up.' },
    { title: 'Semantic squiggle positions are best-effort', desc: 'MaterialX validate() reports messages without character offsets, so the extension places each squiggle by locating the named element in the text. Very large documents and ones using xi:include get XML checks only.' },
    { title: 'Scene Viewer limits', desc: 'Read only, shows the opened file only, and loads at most 4,000 referenced files up to 4 GiB. Graph edits to a material from a scene cannot be saved back into the scene file; use Export .mtlx instead.' },
];

// "Requirements and privacy" items, all sharing the green check icon.
const VSCODE_REQUIREMENTS = [
    { title: 'VS Code 1.100 or newer', desc: 'Desktop VS Code on Windows, macOS, or Linux, with GPU-accelerated webviews (WebGL2) for the 3D views.' },
    { title: 'No dependencies, no build step', desc: 'Plain JavaScript with zero npm dependencies. Everything the webview needs ships inside the .vsix.' },
    { title: 'Works offline, no telemetry', desc: 'No data leaves your machine. The package includes an offline snapshot of the MaterialX spec, templates, and examples.' },
];

// The four breadcrumb-style chips shown for the Extensions view path.
const VSCODE_PATH_CHIPS = ['Extensions', '···', 'Install from VSIX...', 'pick the downloaded file'];

// One key combo, e.g. <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd>.
function Kbd({ children }) {
    return <kbd className="font-mono text-[12px] text-fg-soft bg-surface-raised border border-line-strong border-b-2 rounded px-1.5">{children}</kbd>;
}

// Section heading, matching home's section-header look; `center` is used
// only by the Install section, which the mockup centers.
function SectionHead({ id, title, blurb, center }) {
    return (
        <div className={'space-y-0.5' + (center ? ' text-center' : '')}>
            <h2 id={id} className="text-xl sm:text-2xl font-semibold text-fg">{title}</h2>
            {blurb && <p className={'text-sm text-fg-subtle max-w-[40em]' + (center ? ' mx-auto' : '')}>{blurb}</p>}
        </div>
    );
}

// One "Features" grid entry: icon tile, title (+ optional tag pill), desc.
function FeatureItem({ f }) {
    return (
        <div className="grid grid-cols-[36px_minmax(0,1fr)] gap-3 py-3.5 border-t border-line-subtle">
            <div className="w-9 h-9 rounded-[9px] bg-accent-wash/10 border border-accent-wash/25 flex items-center justify-center text-accent-fg">
                <MtlxIcon name={f.icon} className="w-[18px] h-[18px]" />
            </div>
            <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap text-[15px] font-semibold text-fg mb-0.5">
                    {f.title}
                    {f.tag && <span className={TAG_PILL_CLASS}>{f.tag}</span>}
                </div>
                <p className="text-[13.5px] leading-[19px] text-fg-muted">{f.desc}</p>
            </div>
        </div>
    );
}

// Small icon-only clipboard button; flips to a checkmark for ~1.5s after a
// successful (or attempted) copy. Silently no-ops without Clipboard API.
function CopyButton({ text, className }) {
    const [copied, setCopied] = React.useState(false);
    const timerRef = React.useRef(null);

    React.useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

    const onCopy = () => {
        try {
            if (navigator.clipboard) navigator.clipboard.writeText(text);
        } catch (e) {
            // Clipboard unavailable (permissions, insecure context); ignore.
        }
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
    };

    return (
        <button
            type="button"
            onClick={onCopy}
            aria-label="Copy to clipboard"
            className={'w-[26px] h-[26px] rounded-md border border-line-control bg-control text-fg-secondary hover:text-fg flex items-center justify-center transition-colors ' + (className || '')}
        >
            <MtlxIcon name={copied ? 'copy-check' : 'copy'} className="w-3.5 h-3.5" />
        </button>
    );
}

function VscodeApp({ active } = {}) {
    const links = window.SITE_LINKS;

    const [rel, setRel] = React.useState(null);
    const [expanded, setExpanded] = React.useState(false);

    const rootRef = React.useRef(null);
    const fadeRef = React.useRef(null);
    const thumbRef = React.useRef(null);
    const closeRef = React.useRef(null);
    const wasExpandedRef = React.useRef(false);

    // Resolves the latest release facts (version, stars, forks, vsix asset)
    // once, the same promise the header uses for its GitHub widget.
    React.useEffect(() => {
        let alive = true;
        if (window.mtlxSourceFacts) {
            window.mtlxSourceFacts.then((f) => { if (alive) setRel(f); });
        }
        return () => { alive = false; };
    }, []);

    // Esc closes the lightbox while it's open.
    React.useEffect(() => {
        if (!expanded) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') setExpanded(false); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [expanded]);

    // Leaving this view (e.g. via the header nav) also closes the lightbox.
    React.useEffect(() => {
        if (!active && expanded) setExpanded(false);
    }, [active, expanded]);

    // Focus the close button on open; return focus to the thumbnail on
    // close, but only when we actually just closed it (not on first mount).
    React.useEffect(() => {
        if (expanded) {
            wasExpandedRef.current = true;
            if (closeRef.current) closeRef.current.focus();
        } else if (wasExpandedRef.current) {
            wasExpandedRef.current = false;
            if (thumbRef.current) thumbRef.current.focus();
        }
    }, [expanded]);

    const vsix = rel && rel.vsix;
    const version = (rel && rel.version) || null;
    const downloadHref = vsix ? vsix.url : links.releases;
    const fileName = vsix ? vsix.name : (version ? 'materialx-playground-vscode-' + version + '.vsix' : 'materialx-playground-vscode-<version>.vsix');
    const sizeLabel = vsix && typeof vsix.size === 'number' ? (vsix.size / 1048576).toFixed(1) + ' MB' : null;

    const facts = [
        { k: 'Latest', v: version || 'latest' },
        { k: 'Package', v: '.vsix' + (sizeLabel ? ' · ' + sizeLabel : '') },
        { k: 'VS Code', v: '1.100 or newer' },
        { k: 'Distribution', v: '.vsix only, for now' },
        { k: 'License', v: 'Apache 2.0' },
        {
            k: 'Source',
            v: (
                <a href={links.repo + '/tree/main/vscode_extension'} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-fg hover:text-accent-fg-strong">
                    vscode_extension/ <MtlxIcon name="external-link" className="w-3 h-3" />
                </a>
            ),
        },
    ];

    const installSnippet = 'code --install-extension ' + fileName;

    return (
        <div ref={rootRef} className="relative">
            <HeroGrid rootRef={rootRef} fadeRef={fadeRef} fadeFrom="top" />
            <div className="relative max-w-5xl mx-auto px-2 sm:px-0 py-8 sm:py-14 space-y-12 sm:space-y-16">

                {/* Breadcrumb */}
                <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-fg-subtle">
                    <a href="#!home" className="hover:text-fg-secondary transition-colors">Home</a>
                    <MtlxIcon name="chevron-right" className="w-3 h-3" />
                    <span>Integrate</span>
                    <MtlxIcon name="chevron-right" className="w-3 h-3" />
                    <span className="text-fg-muted">VS Code extension</span>
                </nav>

                {/* Hero */}
                <section aria-labelledby="vscode-h1" className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px] gap-8 items-center">
                    <div className="flex flex-col gap-[18px] min-w-0">
                        <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-fg-strong">
                            <MtlxIcon name="brand-vscode" className="w-3.5 h-3.5" />
                            Integrate <span className="text-fg-faint">/</span> <span className="text-fg-muted">VS Code extension</span>
                        </div>
                        <div className="flex items-center gap-3 flex-wrap">
                            <h1 id="vscode-h1" className="text-[28px] sm:text-[34px] leading-[1.15] font-bold tracking-[-0.01em] text-fg text-balance">MaterialX Playground for VS Code</h1>
                            <span className={EXPERIMENTAL_BADGE_CLASS}>Experimental</span>
                        </div>
                        <p className="text-fg-muted text-base leading-6 max-w-[34em]">
                            Open <strong className={STRONG_CLASS}>.mtlx</strong> files inside VS Code with the same
                            Material Viewer and Node Graph Editor as the web app, plus <strong className={STRONG_CLASS}>live validation</strong> and{' '}
                            <strong className={STRONG_CLASS}>hover docs</strong> right in the text editor. Everything runs
                            locally: the extension bundles the site and the MaterialX WebAssembly build, and it works fully offline.
                        </p>

                        <div className="flex flex-wrap gap-3 items-stretch pt-1">
                            <a href={downloadHref} className="inline-flex items-center gap-2 h-11 px-4 rounded-[10px] bg-accent-fill hover:bg-accent-fill-hover text-on-accent text-sm font-medium shadow-[0_0_0_4px_rgb(var(--mtlx-accent-wash)_/_calc(26_/_255))] transition-colors">
                                <MtlxIcon name="download" className="w-[18px] h-[18px]" />
                                Download .vsix
                                <span className="font-normal text-on-accent/75 text-xs ml-0.5 pl-2.5 border-l border-on-accent/30">{version || 'latest release'}</span>
                            </a>
                            <span
                                role="link"
                                aria-disabled="true"
                                tabIndex={0}
                                className="group relative inline-flex items-center gap-2 h-11 px-4 rounded-[10px] border border-line bg-control/50 text-fg-subtle text-sm font-medium cursor-not-allowed"
                            >
                                <MtlxIcon name="brand-vscode" className="w-[18px] h-[18px] text-fg-subtle" />
                                VS Code Marketplace
                                <span className="text-[10px] font-semibold uppercase tracking-wide px-[7px] py-px rounded-full border border-line text-fg-subtle bg-surface-sunken/60">Soon</span>
                                <span className="pointer-events-none absolute left-1/2 top-[calc(100%+8px)] -translate-x-1/2 translate-y-1 opacity-0 group-hover:opacity-100 group-hover:translate-y-0 group-focus-visible:opacity-100 group-focus-visible:translate-y-0 transition-all bg-surface-raised border border-line-strong text-fg-secondary text-xs font-normal px-2.5 py-1.5 rounded-lg whitespace-nowrap shadow-2xl">
                                    Not published to the Marketplace yet. Install from the .vsix for now.
                                </span>
                            </span>
                        </div>

                        <div className="flex items-center gap-2 flex-wrap text-xs text-fg-subtle">
                            <span className="font-mono text-fg-muted">{fileName}</span>
                            {sizeLabel && (<><span className="text-fg-faint">·</span><span>{sizeLabel}</span></>)}
                            <span className="text-fg-faint">·</span>
                            <span>Requires VS Code 1.100+</span>
                            <span className="text-fg-faint">·</span>
                            <span>Windows, macOS, Linux</span>
                            <span className="text-fg-faint">·</span>
                            <a href={links.releases} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-fg hover:text-accent-fg-strong">
                                Release notes <MtlxIcon name="external-link" className="w-3 h-3" />
                            </a>
                        </div>
                    </div>

                    <div className="relative min-w-0">
                        <div
                            aria-hidden="true"
                            className="absolute -inset-2 sm:-inset-6 rounded-[28px] pointer-events-none"
                            style={{ backgroundImage: 'radial-gradient(ellipse at 60% 40%, rgb(var(--mtlx-accent-wash) / calc(41 / 255)), transparent 68%)' }}
                        />
                        <button
                            ref={thumbRef}
                            type="button"
                            aria-label="Expand screenshot"
                            onClick={() => setExpanded(true)}
                            className="group relative block w-full p-0 m-0 border-0 bg-transparent cursor-zoom-in rounded-2xl"
                        >
                            <img
                                src="images/preview-vscode.jpg"
                                alt="VS Code with a .mtlx text editor on the left and the MaterialX Playground Node Graph Editor with a live 3D preview on the right."
                                className="w-full h-auto rounded-2xl border border-line shadow-2xl group-hover:border-line-strong transition-colors"
                            />
                            <span className="absolute right-2.5 bottom-2.5 w-7 h-7 rounded-lg bg-hud/80 border border-hud-line text-hud-fg flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity pointer-events-none">
                                <MtlxIcon name="maximize" className="w-[15px] h-[15px]" />
                            </span>
                        </button>
                        <p className="mt-2.5 text-xs text-fg-subtle text-center">The Playground opens beside the text editor. Edits on either side stay in sync.</p>
                    </div>
                </section>

                {/* Facts strip */}
                <div ref={fadeRef} aria-label="At a glance" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-line border border-line-subtle rounded-xl overflow-hidden">
                    {facts.map((f) => (
                        <div key={f.k} className="bg-surface-raised p-3.5 sm:p-4 flex flex-col gap-0.5 min-w-0">
                            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">{f.k}</span>
                            <span className="text-sm font-medium text-fg truncate">{f.v}</span>
                        </div>
                    ))}
                </div>

                {/* How it works */}
                <section aria-labelledby="how-h" className="space-y-5">
                    <SectionHead
                        id="how-h"
                        title="How it works"
                        blurb="The extension is the web app running in a VS Code webview, bound to the .mtlx document you have open. Text editor and Playground edit the same document buffer, so there is one source of truth and one undo history."
                    />

                    <div className="grid grid-cols-1 [@media(min-width:720px)]:grid-cols-[1fr_auto_1fr] gap-3 items-center bg-surface-raised border border-line-subtle rounded-xl px-5 py-[18px]" aria-label="Data flow between the text editor and the Playground">
                        <div className="flex items-center gap-3 min-w-0 border border-line rounded-[10px] bg-surface-sunken/60 px-3.5 py-3">
                            <MtlxIcon name="file-code" className="w-[22px] h-[22px] text-accent-fg shrink-0" />
                            <div className="min-w-0">
                                <div className="text-sm font-semibold text-fg">Text editor</div>
                                <div className="text-xs text-fg-muted">Your .mtlx file, with syntax highlighting, validation squiggles, and hover docs.</div>
                            </div>
                        </div>
                        <div className="flex flex-col items-center gap-1.5 text-[11px] font-mono text-fg-muted justify-self-center">
                            <div className="flex items-center gap-1.5">
                                <span>text edits, live</span>
                                <svg viewBox="0 0 40 14" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-10 h-3.5 [@media(max-width:719px)]:h-10 [@media(max-width:719px)]:rotate-90"><path d="M2 7h34" /><path d="M31 3l5 4l-5 4" /></svg>
                            </div>
                            <div className="flex items-center gap-1.5">
                                <svg viewBox="0 0 40 14" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-10 h-3.5 [@media(max-width:719px)]:h-10 [@media(max-width:719px)]:rotate-90"><path d="M38 7h-34" /><path d="M9 3l-5 4l5 4" /></svg>
                                <span>graph edits, live</span>
                            </div>
                            <div className="mt-1 font-sans text-[11px] text-fg-subtle text-center max-w-[150px]">Ctrl+S on either side writes the file to disk</div>
                        </div>
                        <div className="flex items-center gap-3 min-w-0 border border-line rounded-[10px] bg-surface-sunken/60 px-3.5 py-3">
                            <MtlxIcon name="share" className="w-[22px] h-[22px] text-accent-fg shrink-0" />
                            <div className="min-w-0">
                                <div className="text-sm font-semibold text-fg">Playground webview</div>
                                <div className="text-xs text-fg-muted">Node Graph Editor (editable) and Material Viewer (read-only), both loaded with the same document.</div>
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 [@media(min-width:860px)]:grid-cols-3 gap-4">
                        {VSCODE_HOW.map((c) => (
                            <div key={c.title} className="bg-surface-raised border border-line-subtle rounded-xl px-5 py-[18px] flex flex-col gap-2">
                                <MtlxIcon name={c.icon} className="w-[26px] h-[26px] text-accent-fg" />
                                <h3 className="text-[15px] font-semibold text-fg">{c.title}</h3>
                                <p className="text-sm leading-5 text-fg-muted">{c.desc}</p>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Features */}
                <section aria-labelledby="feat-h" className="space-y-5">
                    <SectionHead
                        id="feat-h"
                        title="Features"
                        blurb="Two halves: the Playground views in a webview, and language features that work in any editor for a .mtlx file, custom editor or not."
                    />
                    <div className="grid grid-cols-1 [@media(min-width:720px)]:grid-cols-2 gap-x-6 gap-y-0">
                        {VSCODE_FEATURES.map((f) => <FeatureItem key={f.title} f={f} />)}
                    </div>
                </section>

                {/* Install */}
                <section aria-labelledby="inst-h" className="space-y-9">
                    <SectionHead
                        id="inst-h"
                        title="Install from the .vsix"
                        blurb="The extension is not on the VS Code Marketplace yet, so it installs from a downloaded package. It takes about a minute."
                        center
                    />

                    <ol className="list-none m-0 p-0 flex flex-col w-full max-w-[660px] mx-auto">
                        <li className="relative grid grid-cols-[32px_minmax(0,1fr)] gap-4 pb-6">
                            <span className="absolute left-[15px] top-[34px] bottom-0 w-0.5 bg-line-subtle" aria-hidden="true" />
                            <span className="w-8 h-8 rounded-full bg-surface-raised border border-line-strong text-accent-fg-strong text-[13px] font-semibold flex items-center justify-center tabular-nums">1</span>
                            <div className="flex flex-col gap-2 pt-1 min-w-0">
                                <h3 className="text-[15px] font-semibold text-fg">Download the package</h3>
                                <p className="text-sm leading-[21px] text-fg-muted">Grab the latest <code className={CODE_CLASS}>.vsix</code> from the button above. It is a single file that bundles the whole app for offline use.</p>
                                <div>
                                    <a href={downloadHref} className="inline-flex items-center gap-1.5 h-[34px] px-3 rounded-lg border border-line-strong bg-control hover:bg-hover text-[13px] font-medium text-fg max-w-full transition-colors">
                                        <MtlxIcon name="download" className="w-[15px] h-[15px] text-accent-fg shrink-0" />
                                        <span className="truncate">{fileName}</span>
                                    </a>
                                </div>
                            </div>
                        </li>
                        <li className="relative grid grid-cols-[32px_minmax(0,1fr)] gap-4 pb-6">
                            <span className="absolute left-[15px] top-[34px] bottom-0 w-0.5 bg-line-subtle" aria-hidden="true" />
                            <span className="w-8 h-8 rounded-full bg-surface-raised border border-line-strong text-accent-fg-strong text-[13px] font-semibold flex items-center justify-center tabular-nums">2</span>
                            <div className="flex flex-col gap-2 pt-1 min-w-0">
                                <h3 className="text-[15px] font-semibold text-fg">Install it in VS Code</h3>
                                <p className="text-sm leading-[21px] text-fg-muted">Open the Extensions view, then use the <strong className={STRONG_CLASS}>...</strong> menu in its title bar:</p>
                                <div className="flex items-center flex-wrap gap-1.5 text-[13px] text-fg-secondary">
                                    {VSCODE_PATH_CHIPS.map((label, i) => (
                                        <React.Fragment key={label}>
                                            <span className="px-2 py-0.5 rounded-md bg-surface-raised border border-line text-xs">{label}</span>
                                            {i < VSCODE_PATH_CHIPS.length - 1 && <MtlxIcon name="chevron-right" className="w-3 h-3 text-fg-faint" />}
                                        </React.Fragment>
                                    ))}
                                </div>
                                <div className="flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
                                    <span className="h-px flex-1 bg-line-subtle" aria-hidden="true" />
                                    or from a terminal
                                    <span className="h-px flex-1 bg-line-subtle" aria-hidden="true" />
                                </div>
                                <div className="relative">
                                    <div className={CODE_BLOCK_CLASS + ' pr-11 overflow-x-auto whitespace-nowrap'}>{installSnippet}</div>
                                    <CopyButton text={installSnippet} className="absolute top-2 right-2" />
                                </div>
                                <p className="text-sm leading-[21px] text-fg-muted">You can also drag the file onto the Extensions view. Reload the window if VS Code asks.</p>
                            </div>
                        </li>
                        <li className="relative grid grid-cols-[32px_minmax(0,1fr)] gap-4">
                            <span className="w-8 h-8 rounded-full bg-surface-raised border border-line-strong text-accent-fg-strong text-[13px] font-semibold flex items-center justify-center tabular-nums">3</span>
                            <div className="flex flex-col gap-2 pt-1 min-w-0">
                                <h3 className="text-[15px] font-semibold text-fg">Open a .mtlx file</h3>
                                <p className="text-sm leading-[21px] text-fg-muted">
                                    The Playground opens beside the text editor automatically (setting <code className={CODE_CLASS}>materialxPlayground.autoOpenPlayground</code>).
                                    If it does not, right-click the file and choose <strong className={STRONG_CLASS}>Open With... {'→'} MaterialX Playground</strong>,
                                    or run <strong className={STRONG_CLASS}>MaterialX Playground: Open in Graph Editor</strong> or
                                    <strong className={STRONG_CLASS}> Open in Material Viewer</strong> from the Command
                                    Palette (<Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>P</Kbd>).
                                </p>
                            </div>
                        </li>
                    </ol>

                    <div className="grid grid-cols-1 [@media(min-width:860px)]:grid-cols-3 gap-3.5">
                        {VSCODE_ASIDE.map((a) => (
                            <div key={a.title} className="bg-surface-raised border border-line-subtle rounded-xl px-[18px] py-4 flex flex-col gap-2 min-w-0">
                                <h3 className="flex items-center gap-2 text-[15px] font-semibold text-fg">
                                    <MtlxIcon name={a.icon} className="w-4 h-4 text-accent-fg" />
                                    {a.title}
                                </h3>
                                {a.body}
                            </div>
                        ))}
                    </div>
                </section>

                {/* Settings */}
                <section aria-labelledby="set-h" className="space-y-5">
                    <SectionHead id="set-h" title="Settings" blurb={<>All under <code className={CODE_CLASS}>MaterialX Playground</code> in VS Code's Settings UI.</>} />
                    <div className="overflow-x-auto border border-line-subtle rounded-xl">
                        <table className="border-collapse w-full min-w-[640px] text-[13.5px] leading-[19px]">
                            <thead>
                                <tr>
                                    <th className="text-left text-[10px] uppercase tracking-wide text-fg-subtle font-semibold px-3.5 py-2.5 bg-surface-raised border-b border-line">Setting</th>
                                    <th className="text-left text-[10px] uppercase tracking-wide text-fg-subtle font-semibold px-3.5 py-2.5 bg-surface-raised border-b border-line">Values</th>
                                    <th className="text-left text-[10px] uppercase tracking-wide text-fg-subtle font-semibold px-3.5 py-2.5 bg-surface-raised border-b border-line">What it does</th>
                                </tr>
                            </thead>
                            <tbody>
                                {VSCODE_SETTINGS.map((row, i) => {
                                    const borderCls = i === VSCODE_SETTINGS.length - 1 ? '' : ' border-b border-line-subtle';
                                    return (
                                        <tr key={row.setting}>
                                            <td className={'px-3.5 py-3 align-top font-mono text-[12.5px] text-fg-soft whitespace-nowrap' + borderCls}>{row.setting}</td>
                                            <td className={'px-3.5 py-3 align-top text-fg-muted' + borderCls}>{row.values}</td>
                                            <td className={'px-3.5 py-3 align-top text-fg-muted' + borderCls}>{row.desc}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </section>

                {/* Limitations */}
                <section aria-labelledby="lim-h" className="space-y-5">
                    <SectionHead
                        id="lim-h"
                        title="Limitations"
                        blurb="This is a v1 and it is marked Experimental on purpose. Things you should know before relying on it."
                    />
                    <div className="grid grid-cols-1 [@media(min-width:720px)]:grid-cols-2 gap-3">
                        {VSCODE_LIMITS.map((l) => (
                            <div key={l.title} className="grid grid-cols-[20px_minmax(0,1fr)] gap-3 bg-surface-raised border border-line-subtle rounded-xl px-4 py-3.5">
                                <MtlxIcon name="alert-triangle" className="w-[18px] h-[18px] text-warning mt-0.5" />
                                <div className="min-w-0">
                                    <div className="text-sm font-semibold text-fg mb-0.5">{l.title}</div>
                                    <p className="text-[13.5px] leading-[19px] text-fg-muted">{l.desc}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Requirements + privacy */}
                <section aria-labelledby="req-h" className="space-y-5">
                    <SectionHead id="req-h" title="Requirements and privacy" />
                    <div className="grid grid-cols-1 [@media(min-width:720px)]:grid-cols-3 gap-3">
                        {VSCODE_REQUIREMENTS.map((r) => (
                            <div key={r.title} className="flex gap-2.5 items-start border border-line-subtle rounded-xl px-3.5 py-3">
                                <MtlxIcon name="check" className="w-[18px] h-[18px] text-success mt-0.5" />
                                <div className="min-w-0">
                                    <div className="text-sm font-semibold text-fg">{r.title}</div>
                                    <p className="text-xs leading-[18px] text-fg-muted">{r.desc}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Bottom CTA */}
                <div className="border border-accent-wash/35 bg-surface-raised rounded-2xl px-6 sm:px-7 py-6 flex flex-wrap items-center justify-between gap-5 shadow-[0_0_0_4px_rgb(var(--mtlx-accent-wash)_/_calc(15_/_255))]">
                    <div>
                        <div className="text-lg font-semibold text-fg">Try it in VS Code</div>
                        <div className="text-[13.5px] text-fg-muted mt-0.5">
                            Download the .vsix, install it from the Extensions view, open a .mtlx file. Found a bug?{' '}
                            <a href={links.issues} target="_blank" rel="noopener noreferrer" className="text-accent-fg hover:text-accent-fg-strong">Open an issue on GitHub</a>.
                        </div>
                    </div>
                    <div className="flex gap-2.5 flex-wrap items-center">
                        <a href={downloadHref} className="inline-flex items-center gap-2 h-11 px-4 rounded-[10px] bg-accent-fill hover:bg-accent-fill-hover text-on-accent text-sm font-medium transition-colors">
                            <MtlxIcon name="download" className="w-[18px] h-[18px]" />
                            Download .vsix
                            <span className="font-normal text-on-accent/75 text-xs ml-0.5 pl-2.5 border-l border-on-accent/30">{version || 'latest release'}</span>
                        </a>
                        <span role="link" aria-disabled="true" tabIndex={0} className="inline-flex items-center gap-2 h-11 px-4 rounded-[10px] border border-line bg-control/50 text-fg-disabled text-sm font-medium cursor-not-allowed">
                            <MtlxIcon name="brand-vscode" className="w-[18px] h-[18px] text-fg-subtle" />
                            VS Code Marketplace
                            <span className="text-[10px] font-semibold uppercase tracking-wide px-[7px] py-px rounded-full border border-line text-fg-subtle bg-surface-sunken/60">Soon</span>
                        </span>
                    </div>
                </div>
            </div>

            {/* Lightbox: clicking anywhere inside (image, close button, or the
                backdrop) closes it, matching the mockup's single click handler. */}
            {expanded && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-label="Screenshot, expanded"
                    className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-scrim/85 backdrop-blur-sm cursor-zoom-out"
                    onClick={() => setExpanded(false)}
                >
                    <button
                        ref={closeRef}
                        type="button"
                        aria-label="Close"
                        onClick={() => setExpanded(false)}
                        className="absolute top-4 right-4 w-9 h-9 rounded-lg border border-line-strong bg-control text-fg-soft flex items-center justify-center cursor-pointer hover:bg-hover transition-colors"
                    >
                        <MtlxIcon name="x" className="w-[18px] h-[18px]" />
                    </button>
                    <img
                        src="images/preview-vscode.jpg"
                        alt="VS Code with a .mtlx text editor on the left and the MaterialX Playground Node Graph Editor with a live 3D preview on the right."
                        className="max-w-[min(96vw,1800px)] max-h-[92vh] w-auto h-auto rounded-lg border border-line shadow-2xl"
                    />
                    <p className="absolute left-0 right-0 bottom-3.5 text-center text-xs text-fg-muted pointer-events-none">Click anywhere or press Esc to close</p>
                </div>
            )}
        </div>
    );
}

window.VscodeApp = VscodeApp;
