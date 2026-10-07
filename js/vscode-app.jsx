// vscode-app.jsx - the "VS Code extension" view (hash route "#!vscode"),
// reached from the home card and the Integrate menu. A static, scrollable
// page; shared building blocks come from js/shared/product-page.jsx.

// "How it works" flow-diagram cards, in mockup order.
const VSCODE_HOW = [
    {
        icon: 'layout-columns',
        title: '1. Open a .mtlx file',
        desc: (<>The Playground <strong className={STRONG_CLASS}>opens beside the text editor</strong> automatically (or via right-click, <em>Open With</em>, the sidebar, or the Command Palette). It reuses the right-hand editor group instead of splitting again on every open.</>),
    },
    {
        icon: 'refresh',
        title: '2. Edit on either side',
        desc: (<>Typing in the text editor <strong className={STRONG_CLASS}>live-reloads</strong> the Playground. Graph edits are written <strong className={STRONG_CLASS}>straight into the open .mtlx buffer</strong> as they settle, changing only what you edited, so the text editor updates too and the tab shows unsaved changes. <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd> saves from either side; <Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> / <Kbd>Ctrl</Kbd>+<Kbd>Y</Kbd> in the graph use VS Code's own document undo, so graph and text share one history.</>),
    },
    {
        icon: 'wifi-off',
        title: '3. Nothing leaves your machine',
        desc: (<>The webview loads the <strong className={STRONG_CLASS}>bundled site, libraries, and MaterialX WASM</strong> from the extension itself. The .vsix ships the MaterialX spec and example materials too, so it works with no network at all.</>),
    },
];

// "Features", split into three sub-groups.
const VSCODE_FEATURE_GROUPS = [
    {
        title: 'Playground views',
        items: [
            { icon: 'share', title: 'Node Graph Editor', desc: 'The full graph editor: nested node graphs, live 3D preview, validation, node docs dialog. Every edit lands in the .mtlx buffer as it settles; Ctrl+S saves the file.' },
            { icon: 'file-check', title: 'Keeps your formatting', desc: 'Graph edits change only what you actually edited. Your attribute order, indentation, comments and node order stay exactly as you wrote them.' },
            { icon: 'camera', title: 'Material Viewer', tag: 'Read only', desc: "Image-based lighting, geometry picker, turntable, save as PNG. Switching to it always shows the graph editor's current state, unsaved edits included." },
            { icon: 'cube', title: 'Scene Viewer', tag: 'Read only', desc: 'Open USD (.usd, .usda, .usdc, .usdz), glTF (.gltf, .glb) and OBJ files with their materials and textures. Only the opened file and what it references are loaded; binary USD files fetch their references on demand. A progress bar shows files and MB loaded, with Cancel. Materials open view only in the graph, with Export .mtlx to save an editable copy.' },
            { icon: 'palette', title: 'Themes', desc: (<>The views and the sidebar match your VS Code color theme by default. Pick any Playground theme instead, or build your own with <strong className={STRONG_CLASS}>Customize Theme</strong>; your themes are saved in your settings and travel with Settings Sync.</>) },
            { icon: 'download', title: 'Exports use a native Save dialog', desc: "Screenshots, turntable GIFs, .mtlx and zip exports, and generated shader code all open VS Code's own Save dialog, defaulting to the open document's folder." },
            { icon: 'folder', title: 'Textures load straight from disk', desc: (<>Sibling textures and <code className={CODE_CLASS}>{'xi:include'}</code> documents are found automatically, including large 4K and 8K textures. References must stay inside the workspace folder that contains the document.</>) },
        ],
    },
    {
        title: 'Editing .mtlx text',
        items: [
            { icon: 'file-code', title: 'Syntax highlighting and file icon', desc: (<>.mtlx files get a "MaterialX" language mode with XML highlighting, <code className={CODE_CLASS}>{'<!-- -->'}</code> comment toggling, auto-closing quotes, a matching file icon, and an Open Preview button on the editor toolbar.</>) },
            { icon: 'code', title: 'Auto-complete', desc: "Suggests node categories, an element's inputs with their types, and only the attributes that element actually supports, plus valid attribute values: types, color spaces, units, versions, node definitions, targets and references." },
            { icon: 'sparkles', title: 'Snippets', desc: 'Ready-made snippets for a new document, a standard_surface or OpenPBR material, a texture chain, a normal map chain, a node graph, and a typed input.' },
            { icon: 'file-check', title: 'Live validation', desc: 'Runs off the editor thread as you type: XML well-formedness first, then MaterialX validate() through the bundled WASM build. Documents using xi:include get XML checks only. Results show in the Problems panel and a status bar item.' },
            { icon: 'book', title: 'Hover docs', desc: (<>Hover a node tag like <code className={CODE_CLASS}>{'<standard_surface>'}</code> or a <code className={CODE_CLASS}>{'node="..."'}</code> value to see its description and port table from the MaterialX spec, with links to the Node Library Documentation panel and the official spec.</>) },
            { icon: 'list-details', title: 'Outline and navigation', desc: 'Materials, node graphs, node definitions and their inputs and outputs show up in the Outline, breadcrumbs and Go to Symbol. Go to Definition and Find All References work for node, nodegraph, output, interfacename and nodedef references.' },
            { icon: 'pencil', title: 'Rename symbol', desc: 'Press F2 on a name or a reference to it to rename the element and update every reference to it in the document. Invalid names and names already taken in the same scope are refused.' },
            { icon: 'adjustments', title: 'Format Document and Format Selection', desc: 'Shift+Alt+F re-indents the whole file or just the selection. Attribute order and values, comments and self-closing tags are left exactly as they are.' },
            { icon: 'link', title: 'Document links', desc: 'Texture and include file names become links: Ctrl+click one to open the file. Only files inside the workspace folder get a link.' },
            { icon: 'color-swatch', title: 'Color swatches and picker', desc: "Color3 and color4 values show an inline swatch in the text editor. Opening the picker writes the new color back converted into that value's own color space." },
        ],
    },
    {
        title: 'Sidebar and commands',
        items: [
            { icon: 'layout-navbar', title: 'MaterialX Playground sidebar', desc: (<>An activity bar icon opens three views: <strong className={STRONG_CLASS}>Actions</strong> (open the current file in each view, new documents, examples, and an <strong className={STRONG_CLASS}>Insert Node</strong> panel that searches the node library and adds a node at the cursor), <strong className={STRONG_CLASS}>Textures & Files in Document</strong> (open, replace or reveal each referenced file), and an <strong className={STRONG_CLASS}>Outline</strong> of the current document.</>) },
            { icon: 'layout-grid', title: 'Example gallery', desc: 'New Material from Example opens a gallery of ready-made materials with thumbnails, a search box and filters. Pick one and it is copied into your workspace with the textures it needs, then opened.' },
            { icon: 'file-plus', title: 'New MaterialX Document', desc: 'Starts a new, untitled .mtlx document from a starter skeleton. Also listed under File > New File.' },
            { icon: 'external-link', title: 'Node Library Documentation panel', desc: 'Browse the whole node library without a file open, from the Command Palette, the sidebar or a .mtlx context menu. Hover links land on the exact node and signature. Its 3D previews start switched off to keep the webview light.' },
            { icon: 'color-filter', title: 'Filter Docs by File', desc: 'Narrows the Node Library Documentation panel to just the node categories used in the current .mtlx file.' },
            { icon: 'file-text', title: 'Open in Text Editor', desc: 'From a Playground tab, jump back to the same file in the text editor, from the tab menu or the Command Palette.' },
            { icon: 'lock', title: 'Restricted Mode', desc: 'In a folder you have not trusted, the views do not open on their own. Open them with the Open in Graph Editor, Open in Material Viewer or Open in Scene Viewer commands; validation, hovers and the node library work normally.' },
        ],
    },
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
                <pre className={CODE_BLOCK_CLASS + ' whitespace-pre-wrap break-normal [overflow-wrap:anywhere]'}>code --uninstall-extension MaterialXPlayground.materialx-playground</pre>
                <p className="text-[13.5px] leading-[19px] text-fg-muted">Installed a .vsix from an older release? Its ID was <code className={CODE_CLASS}>local.materialx-playground</code>: uninstall that one first, before installing a new version.</p>
            </>
        ),
    },
    {
        icon: 'settings-cog',
        title: 'Optional: Playground-only mode',
        body: (
            <>
                <p className="text-[13.5px] leading-[19px] text-fg-muted">Nothing to configure for the default split view: .mtlx files open in the text editor and the Playground auto-opens beside them. If you would rather have .mtlx files open <strong className={STRONG_CLASS}>straight into the Playground with no text editor</strong>, make it the default editor in <code className={CODE_CLASS}>settings.json</code> (the text editor stays reachable via Open in Text Editor):</p>
                <pre className={CODE_BLOCK_CLASS + ' whitespace-pre-wrap break-normal [overflow-wrap:anywhere]'}>{'"workbench.editorAssociations": {\n  "*.mtlx": "materialxPlayground.editor"\n}'}</pre>
            </>
        ),
    },
];

// Settings table rows; `values` marks each default inline.
const VSCODE_SETTINGS = [
    {
        setting: 'materialxPlayground.theme',
        values: (<>"vscode" <DefaultMark />, "system", "light", "dark", "hc-dark", "hc-light", "dim", "paper", "custom:&lt;name&gt;"</>),
        desc: 'Color theme of the Playground views and the sidebar. "vscode" matches the current VS Code color theme; "system" follows whether that theme is light or dark; any other value picks that Playground theme, or one of your own.',
    },
    {
        setting: 'materialxPlayground.customThemes',
        values: (<>[] <DefaultMark /></>),
        desc: 'Themes you made with Customize Theme. Edited for you by the theme editor and synced by Settings Sync.',
    },
    {
        setting: 'materialxPlayground.defaultView',
        values: (<>"graph" <DefaultMark />, "viewer"</>),
        desc: 'Which view is visible first when a .mtlx file opens. Both views load the document either way; the header nav switches between them.',
    },
    {
        setting: 'materialxPlayground.openBehavior',
        values: (<>"splitRight" <DefaultMark />, "sameGroup"</>),
        desc: 'Open the Playground beside the text editor, reusing the right-hand group on repeat opens, or in the active editor group.',
    },
    {
        setting: 'materialxPlayground.autoOpenPlayground',
        values: (<>true <DefaultMark />, false</>),
        desc: 'Automatically open the Playground beside the text editor whenever a .mtlx file is opened. Fires once per file open; closing the Playground does not re-trigger it.',
    },
    {
        setting: 'materialxPlayground.pickFileOnFilenameInput',
        values: (<>true <DefaultMark />, false</>),
        desc: 'When a filename input is added from auto-complete, open a file picker right away to choose the file.',
    },
    {
        setting: 'materialxPlayground.syncSelection',
        values: (<>true <DefaultMark />, false</>),
        desc: 'Keep the text cursor, the MaterialX Outline and the Graph Editor selection in sync.',
    },
    {
        setting: 'materialxPlayground.autoOpenSceneViewer',
        values: (<>true <DefaultMark />, false</>),
        desc: 'Automatically open the Scene Viewer whenever a USD, glTF, GLB or OBJ scene file is opened: beside the text editor for a file VS Code opens as text, or replacing the tab for a file VS Code shows as binary. Fires once per file open.',
    },
];

// Limitation cards.
const VSCODE_LIMITS = [
    { title: 'Manual installs and updates', desc: 'Distributed as a .vsix from GitHub Releases for now. Listings on the VS Code Marketplace and Open VSX are coming; until then there are no automatic updates, so check this page or the releases feed for new versions.' },
    { title: 'One MaterialX version, no Compare view', desc: 'The .vsix bundles only the default MaterialX build (v1.39.5). The Material Comparison view, the one feature that needs several versions side by side, stays web-only; the webview nav has just Material Viewer and Graph.' },
    { title: 'References must stay in the workspace folder', desc: 'Textures and included files must be inside the workspace folder that contains the document, or next to the document itself when no folder is open.' },
    { title: 'Some web-app UI is hidden', desc: "Home, New/Import/Presets, drag-and-drop, the Material Viewer's file sidebar, and Send-to buttons do not apply to a single open file, so the webview hides them. The Docs tab is replaced by the separate docs panel." },
    { title: 'Memory scales with open tabs', desc: 'Each open .mtlx tab is its own webview with its own MaterialX WASM instance and WebGL context, kept alive while backgrounded so switching tabs is instant. The first shader compile after opening a file can take a few seconds while the WASM build warms up.' },
    { title: 'Semantic squiggle positions are best-effort', desc: 'MaterialX validate() reports messages without character offsets, so the extension places each squiggle by locating the named element in the text. Very large documents and ones using xi:include get XML checks only.' },
    { title: 'Scene Viewer limits', desc: 'Read only, shows the opened file only, and loads at most 4,000 referenced files up to 4 GiB. A material opened from a scene is view only in the Graph Editor; use Export .mtlx to save an editable copy.' },
];

// "Requirements and privacy" items.
const VSCODE_REQUIREMENTS = [
    { title: 'VS Code 1.100 or newer', desc: 'Desktop VS Code on Windows, macOS, or Linux, with GPU-accelerated webviews (WebGL2) for the 3D views.' },
    { title: 'Nothing else to install', desc: 'Everything the extension needs, including its libraries and the MaterialX WASM build, ships inside the .vsix.' },
    { title: 'Works offline, no telemetry', desc: 'No data leaves your machine. The package includes the MaterialX spec, templates, and example materials.' },
];

// The four breadcrumb-style chips shown for the Extensions view path.
const VSCODE_PATH_CHIPS = ['Extensions', '···', 'Install from VSIX...', 'pick the downloaded file'];

// Disabled "coming soon" store control, shared by the hero and bottom CTA.
function VscodeStoreSoon({ tooltip }) {
    return (
        <span
            role="link"
            aria-disabled="true"
            tabIndex={0}
            className="group relative inline-flex items-center gap-2 h-11 px-4 rounded-[10px] border border-line bg-control/80 text-fg-subtle text-sm font-medium cursor-not-allowed"
        >
            <MtlxIcon name="brand-vscode" className="w-[18px] h-[18px] text-fg-subtle" />
            Coming to the Marketplace and Open VSX
            {tooltip && (
                <span className="pointer-events-none absolute left-1/2 top-[calc(100%+8px)] -translate-x-1/2 translate-y-1 opacity-0 group-hover:opacity-100 group-hover:translate-y-0 group-focus-visible:opacity-100 group-focus-visible:translate-y-0 transition-all bg-surface-raised border border-line-strong text-fg-secondary text-xs font-normal px-2.5 py-1.5 rounded-lg whitespace-nowrap shadow-2xl">
                    Not listed yet. Install from the .vsix for now.
                </span>
            )}
        </span>
    );
}

function VscodeApp({ active } = {}) {
    const links = window.SITE_LINKS;

    // Latest release facts (version, vsix asset), the same promise the header uses.
    const rel = useReleaseFacts();
    const [expanded, setExpanded] = React.useState(false);

    const rootRef = React.useRef(null);
    const fadeRef = React.useRef(null);
    const thumbRef = React.useRef(null);
    const closeRef = React.useRef(null);
    const wasExpandedRef = React.useRef(false);

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
    const sizeLabel = formatAssetSize(vsix);

    const facts = [
        { k: 'Latest', v: version || 'latest' },
        { k: 'Package', v: '.vsix' + (sizeLabel ? ' · ' + sizeLabel : '') },
        { k: 'VS Code', v: '1.100 or newer' },
        { k: 'Distribution', v: '.vsix now, stores soon' },
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

                <ProductBreadcrumb current="VS Code extension" />

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
                            Node Graph Editor, Material Viewer and Scene Viewer as the web app, plus{' '}
                            <strong className={STRONG_CLASS}>live validation</strong>, <strong className={STRONG_CLASS}>hover docs</strong>{' '}
                            and smart completion right in the text editor. Everything runs
                            locally: the extension bundles the site and the MaterialX WebAssembly build, and it works fully offline.
                        </p>

                        <div className="flex flex-wrap gap-3 items-stretch pt-1">
                            <a href={downloadHref} className={PRIMARY_CTA_CLASS + PRIMARY_CTA_HALO}>
                                <MtlxIcon name="download" className="w-[18px] h-[18px]" />
                                Download .vsix
                                <span className="font-normal text-on-accent/75 text-xs ml-0.5 pl-2.5 border-l border-on-accent/30">{version || 'latest release'}</span>
                            </a>
                            <VscodeStoreSoon tooltip />
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

                <FactsStrip facts={facts} fadeRef={fadeRef} />

                {/* How it works */}
                <section aria-labelledby="vscode-how-h" className="space-y-5">
                    <SectionHead
                        id="vscode-how-h"
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
                <section aria-labelledby="vscode-feat-h" className="space-y-5">
                    <SectionHead
                        id="vscode-feat-h"
                        title="Features"
                        blurb="The Playground views in a webview, language features that work in any editor for a .mtlx file, and a sidebar with commands to tie them together."
                    />
                    <FeatureGroups groups={VSCODE_FEATURE_GROUPS} />
                </section>

                {/* Install */}
                <section aria-labelledby="vscode-inst-h" className="space-y-9">
                    <SectionHead
                        id="vscode-inst-h"
                        title="Install from the .vsix"
                        blurb="The extension is not on the VS Code Marketplace or Open VSX yet, so it installs from a downloaded package. It takes about a minute."
                        center
                    />

                    <ol className="list-none m-0 p-0 flex flex-col w-full max-w-[660px] mx-auto">
                        <InstallStep n={1} title="Download the package">
                            <p className="text-sm leading-[21px] text-fg-muted">Grab the latest <code className={CODE_CLASS}>.vsix</code> from the button above. It is a single file that bundles the whole app for offline use.</p>
                            <div>
                                <a href={downloadHref} className={SECONDARY_CTA_CLASS}>
                                    <MtlxIcon name="download" className="w-[15px] h-[15px] text-accent-fg shrink-0" />
                                    <span className="truncate">{fileName}</span>
                                </a>
                            </div>
                        </InstallStep>
                        <InstallStep n={2} title="Install it in VS Code">
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
                            <CopyBlock text={installSnippet} />
                            <p className="text-sm leading-[21px] text-fg-muted">You can also drag the file onto the Extensions view. Reload the window if VS Code asks.</p>
                        </InstallStep>
                        <InstallStep n={3} title="Open a .mtlx file" last>
                            <p className="text-sm leading-[21px] text-fg-muted">
                                Open a folder and choose <strong className={STRONG_CLASS}>Trust</strong> when VS Code asks; the Playground then opens beside the text editor automatically
                                (setting <code className={CODE_CLASS}>materialxPlayground.autoOpenPlayground</code>).
                                If it does not, right-click the file and choose <strong className={STRONG_CLASS}>Open in Graph Editor</strong> or
                                <strong className={STRONG_CLASS}> Open in Material Viewer</strong>, use the MaterialX Playground sidebar,
                                or run the same commands from the Command Palette (<Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>P</Kbd>).
                            </p>
                        </InstallStep>
                    </ol>

                    <AsideCards items={VSCODE_ASIDE} />
                </section>

                {/* Settings */}
                <section aria-labelledby="vscode-set-h" className="space-y-5">
                    <SectionHead id="vscode-set-h" title="Settings" blurb={<>All under <code className={CODE_CLASS}>MaterialX Playground</code> in VS Code's Settings UI. Settings from earlier versions (<code className={CODE_CLASS}>materialx.*</code>) keep working.</>} />
                    <SettingsTable rows={VSCODE_SETTINGS} />
                </section>

                {/* Limitations */}
                <section aria-labelledby="vscode-lim-h" className="space-y-5">
                    <SectionHead
                        id="vscode-lim-h"
                        title="Limitations"
                        blurb="This is an early release and it is marked Experimental on purpose. Things you should know before relying on it."
                    />
                    <LimitsGrid items={VSCODE_LIMITS} />
                </section>

                {/* Requirements + privacy */}
                <section aria-labelledby="vscode-req-h" className="space-y-5">
                    <SectionHead id="vscode-req-h" title="Requirements and privacy" />
                    <RequirementsGrid items={VSCODE_REQUIREMENTS} />
                </section>

                <ProductCta
                    title="Try it in VS Code"
                    text={(
                        <>
                            Download the .vsix, install it from the Extensions view, open a .mtlx file. Found a bug?{' '}
                            <a href={links.issues} target="_blank" rel="noopener noreferrer" className="text-accent-fg hover:text-accent-fg-strong">Open an issue on GitHub</a>.
                        </>
                    )}
                >
                    <a href={downloadHref} className={PRIMARY_CTA_CLASS}>
                        <MtlxIcon name="download" className="w-[18px] h-[18px]" />
                        Download .vsix
                        <span className="font-normal text-on-accent/75 text-xs ml-0.5 pl-2.5 border-l border-on-accent/30">{version || 'latest release'}</span>
                    </a>
                    <VscodeStoreSoon />
                </ProductCta>
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
                        className="absolute top-4 right-4 w-9 h-9 rounded-lg border border-line-strong bg-control/80 text-fg-soft flex items-center justify-center cursor-pointer hover:bg-hover transition-colors"
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
