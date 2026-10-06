// desktop-app.jsx - the "Desktop app" view (hash route "#!desktop"),
// reached from the home card and the Integrate menu. A static, scrollable
// page like vscode-app.jsx; shared blocks come from js/shared/product-page.jsx.

// Download buttons per platform. `key` matches the release facts'
// desktop map (js/site-header.js); `file` builds the fallback asset name.
const DESKTOP_PLATFORMS = [
    {
        os: 'windows',
        label: 'Windows',
        icon: 'brand-windows',
        note: 'The installer adds .mtlx file association and Explorer menu entries. The portable build runs without installing.',
        downloads: [
            { key: 'winSetup', label: 'Installer', file: (v) => 'MaterialX.Playground.Setup.' + v + '.exe' },
            { key: 'winPortable', label: 'Portable', file: (v) => 'MaterialX.Playground.' + v + '.exe' },
        ],
    },
    {
        os: 'mac',
        label: 'macOS',
        icon: 'brand-apple',
        note: 'Apple silicon (M1 or newer) only. The first launch needs one extra step, see below.',
        downloads: [
            { key: 'macDmg', label: 'Disk image (.dmg)', file: (v) => 'MaterialX.Playground-' + v + '-arm64.dmg' },
            { key: 'macZip', label: 'Zip archive', file: (v) => 'MaterialX.Playground-' + v + '-arm64-mac.zip' },
        ],
    },
    {
        os: 'linux',
        label: 'Linux',
        icon: 'brand-ubuntu',
        note: 'AppImage runs on most distributions (it needs libfuse2 on recent ones). The .deb is for Debian, Ubuntu and their derivatives, 64-bit x86.',
        downloads: [
            { key: 'linuxAppImage', label: 'AppImage', file: (v) => 'MaterialX.Playground-' + v + '.AppImage' },
            { key: 'linuxDeb', label: 'Debian package (.deb)', file: (v) => 'materialx-playground-desktop_' + v + '_amd64.deb' },
        ],
    },
];

// "How it works" cards.
const DESKTOP_HOW = [
    {
        icon: 'device-desktop',
        title: 'The whole Playground, in a window',
        desc: (<>The same site you are reading, packaged with <strong className={STRONG_CLASS}>the MaterialX WebAssembly build, libraries and example materials</strong>, and served from inside the app. Every tool works the way it does on the web.</>),
    },
    {
        icon: 'folder',
        title: 'Your files, natively',
        desc: (<>Open .mtlx files from your file manager, the <strong className={STRONG_CLASS}>File menu</strong> or by dropping them on the window. Save writes straight back to the file on disk, and edits made in another program reload automatically.</>),
    },
    {
        icon: 'wifi-off',
        title: 'No network at all',
        desc: (<>The app <strong className={STRONG_CLASS}>blocks every request that leaves your machine</strong>. Links to the website or GitHub open in your normal browser instead, never inside the app.</>),
    },
];

// "Features", split into sub-groups.
const DESKTOP_FEATURE_GROUPS = [
    {
        title: 'Works with your files',
        items: [
            { icon: 'file-code', title: '.mtlx file association', desc: 'Double-click a .mtlx file to open it in the app. It lands in the view you choose in Settings (Graph Editor by default).' },
            { icon: 'list-details', title: 'Windows Explorer submenu', tag: 'Windows', desc: 'Right-click a .mtlx file and pick MaterialX Playground, then Open in Material Viewer, Open in Graph Editor or Open in Compare.' },
            { icon: 'layout-columns', title: 'One app, many windows', desc: 'Opening another file reuses the running app instead of starting a second copy, and routes the file to a new window or the current one, as you prefer.' },
            { icon: 'file-import', title: 'Drop to open', desc: 'Drop a .mtlx file onto the window to open it from its real location, so Save writes back to that same file.' },
            { icon: 'refresh', title: 'Picks up outside edits', desc: 'When the open file changes on disk, for example after editing it in a text editor, the app reloads it.' },
            { icon: 'alert-triangle', title: 'Never loses unsaved work', desc: 'Closing a window with unsaved changes asks whether to save, discard or cancel first.' },
        ],
    },
    {
        title: 'Feels like a desktop app',
        items: [
            { icon: 'layout-navbar', title: 'Native menus and dialogs', desc: 'File, Edit, View, Window and Help menus with the usual shortcuts. Open, Save and Save As use your system file dialogs, and Show in Explorer or Finder reveals the file.' },
            { icon: 'history', title: 'Recent files and jump list', desc: 'File > Open Recent keeps your last ten documents. On Windows, the taskbar jump list shows them too, plus shortcuts to Node Specs, Material Viewer, Compare and Graph Editor.' },
            { icon: 'maximize', title: 'Remembers its window', desc: 'The window reopens at the size and position you left it, and moves back on screen if a monitor was unplugged.' },
            { icon: 'palette', title: 'Title bar follows your theme', desc: 'Pick any theme from the header, including your own, and the window frame and title bar change to match.' },
            { icon: 'settings-cog', title: 'Settings dialog', desc: 'Choose whether files open in a new window, which view documents open into, whether recent files show up in the system, and safe mode.' },
            { icon: 'restore', title: 'Crash recovery', desc: 'If a window crashes, the app offers to reload it from disk with unsaved graph edits restored from the autosave. Repeated graphics crashes offer to turn on safe mode.' },
        ],
    },
];

// Settings dialog rows (the cog at the right end of the header).
const DESKTOP_SETTINGS = [
    {
        setting: 'Open Files in New Window',
        values: (<>On <DefaultMark />, Off</>),
        desc: 'Files opened from the file manager or a second launch get their own window. Turn it off to open them in the window you used last.',
    },
    {
        setting: 'Open Documents Into',
        values: (<>Graph Editor <DefaultMark />, Material Viewer</>),
        desc: 'The view a document lands in when opened by double-click, Open Recent or a drop. An Explorer submenu choice always wins.',
    },
    {
        setting: 'Show Recent Files in System',
        values: (<>On <DefaultMark />, Off</>),
        desc: "Lists your recent files in the Windows jump list and the system's own recent documents. The in-app Open Recent list works either way.",
    },
    {
        setting: 'Safe mode (software rendering)',
        values: (<>Off <DefaultMark />, On</>),
        desc: 'Turns off hardware acceleration: slower, but works on more machines. Takes effect after a relaunch, which the dialog offers right away. You can also start the app with --safe-mode.',
    },
];

// Limitation cards.
const DESKTOP_LIMITS = [
    { title: 'No automatic updates', desc: 'The app never checks for updates (it makes no network requests at all). Download a newer release and install it over the old one.' },
    { title: 'Not signed', desc: 'The builds are not code signed, so Windows SmartScreen and macOS Gatekeeper warn on first launch. The install steps above show how to get past each one.' },
    { title: 'macOS: Apple silicon only', desc: 'There is no build for Intel Macs.' },
    { title: 'One MaterialX version', desc: 'The app bundles only the default MaterialX build (v1.39.5), so Compare cannot load other versions side by side the way the website can.' },
    { title: 'Experimental', desc: 'The desktop builds are new and have had far less testing than the website. Expect rough edges and please report anything broken.' },
    { title: 'Graphics drivers vary', desc: 'Rendering relies on your GPU through WebGL2. If a view stays blank or the app crashes on your machine, try safe mode.' },
];

// "Requirements and privacy" items.
const DESKTOP_REQUIREMENTS = [
    { title: 'Windows, macOS or Linux', desc: 'Windows and Linux on 64-bit x86, macOS on Apple silicon, with a graphics driver that supports WebGL2.' },
    { title: 'Nothing else to install', desc: 'The MaterialX libraries, examples and spec pages ship inside the app. No account, no sign-in.' },
    { title: 'Fully offline, no telemetry', desc: 'Requests to the network are blocked outright. Preferences and recent files stay in a settings folder on your machine.' },
];

// Detects the visitor's desktop OS; null for phones, tablets and anything unknown.
function detectDesktopOs() {
    try {
        const uaData = navigator.userAgentData;
        const platform = (uaData && typeof uaData.platform === 'string') ? uaData.platform : '';
        const ua = navigator.userAgent || '';
        if (/android/i.test(platform) || /android/i.test(ua)) return null;
        if (/iphone|ipad|ipod/i.test(ua)) return null;
        if (platform) {
            if (/^windows/i.test(platform)) return 'windows';
            if (/^mac/i.test(platform)) return 'mac';
            if (/^linux/i.test(platform)) return 'linux';
            return null;
        }
        if (/windows/i.test(ua)) return 'windows';
        // iPadOS reports a Mac user agent; touch points tell them apart.
        if (/macintosh|mac os x/i.test(ua)) return navigator.maxTouchPoints > 1 ? null : 'mac';
        if (/linux|x11/i.test(ua) && !/cros/i.test(ua)) return 'linux';
    } catch (e) {
        // Detection is a convenience only; fall through to no highlight.
    }
    return null;
}

// Resolves one download to { href, name, size, direct } from the release facts.
function resolveDownload(dl, desktop, version, fallback) {
    const asset = desktop && desktop[dl.key];
    if (asset && asset.url) return { href: asset.url, name: asset.name, size: formatAssetSize(asset), direct: true };
    const v = version ? version.replace(/^v/, '') : '<version>';
    return { href: fallback, name: dl.file(v), size: null, direct: false };
}

// One platform card in the download panel; `mine` highlights it.
function DesktopPlatformCard({ p, mine, desktop, version, fallback }) {
    return (
        <div className={'flex flex-col gap-3 rounded-xl border px-4 py-4 min-w-0 '
            + (mine ? 'border-accent-base/60 bg-selection/10' : 'border-line-subtle bg-surface-raised')}>
            <div className="flex items-center gap-2">
                <MtlxIcon name={p.icon} className="w-5 h-5 text-accent-fg" />
                <span className="text-[15px] font-semibold text-fg">{p.label}</span>
                {mine && <span className={TAG_PILL_CLASS + ' ml-auto'}>Your system</span>}
            </div>
            <div className="flex flex-col gap-2">
                {p.downloads.map((dl, i) => {
                    const r = resolveDownload(dl, desktop, version, fallback);
                    const primary = mine && i === 0;
                    return (
                        <a
                            key={dl.key}
                            href={r.href}
                            target={r.direct ? undefined : '_blank'}
                            rel={r.direct ? undefined : 'noopener noreferrer'}
                            title={r.name}
                            className={primary
                                ? 'inline-flex items-center gap-2 h-9 px-3 rounded-lg bg-accent-fill hover:bg-accent-fill-hover text-on-accent text-[13px] font-medium transition-colors min-w-0'
                                : SECONDARY_CTA_CLASS + ' h-9'}
                        >
                            <MtlxIcon name="download" className={'w-[15px] h-[15px] shrink-0' + (primary ? '' : ' text-accent-fg')} />
                            <span className="truncate">{dl.label}</span>
                            {r.size && <span className={'ml-auto text-xs font-normal shrink-0 ' + (primary ? 'text-on-accent/75' : 'text-fg-subtle')}>{r.size}</span>}
                        </a>
                    );
                })}
            </div>
            <p className="text-xs leading-[17px] text-fg-muted">{p.note}</p>
        </div>
    );
}

function DesktopApp() {
    const links = window.SITE_LINKS;
    const inApp = !!window.__MTLX_ELECTRON__;

    // Latest release facts (version, per-platform assets), shared with the header.
    const rel = useReleaseFacts();
    const [os] = React.useState(detectDesktopOs);

    const rootRef = React.useRef(null);
    const fadeRef = React.useRef(null);

    const version = (rel && rel.version) || null;
    const desktop = (rel && rel.desktop) || {};
    const fallback = links.releases;
    const mine = DESKTOP_PLATFORMS.find((p) => p.os === os) || null;
    const mineDownload = mine ? resolveDownload(mine.downloads[0], desktop, version, fallback) : null;
    const v = version ? version.replace(/^v/, '') : '<version>';

    const facts = [
        { k: 'Latest', v: version || 'latest' },
        { k: 'Platforms', v: 'Win · Mac · Linux' },
        { k: 'Network', v: 'Fully offline' },
        { k: 'Updates', v: 'Manual, for now' },
        { k: 'License', v: 'Apache 2.0' },
        {
            k: 'Source',
            v: (
                <a href={links.repo + '/tree/main/electron'} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-fg hover:text-accent-fg-strong">
                    electron/ <MtlxIcon name="external-link" className="w-3 h-3" />
                </a>
            ),
        },
    ];

    const downloadPanel = inApp ? (
        <div className="bg-surface-raised border border-line-subtle rounded-2xl px-5 py-5 flex flex-col gap-3">
            <div className="flex items-center gap-2">
                <MtlxIcon name="check" className="w-5 h-5 text-success" />
                <span className="text-[15px] font-semibold text-fg">You're using the desktop app</span>
            </div>
            <p className="text-sm leading-5 text-fg-muted">
                The app does not update itself. Newer releases, with notes on what changed, are on GitHub; install one over this copy to update.
            </p>
            <div>
                <a href={fallback} target="_blank" rel="noopener noreferrer" className={SECONDARY_CTA_CLASS}>
                    <MtlxIcon name="external-link" className="w-[15px] h-[15px] text-accent-fg shrink-0" />
                    Releases on GitHub
                </a>
            </div>
        </div>
    ) : (
        <div className="bg-surface-raised border border-line-subtle rounded-2xl px-5 py-5 flex flex-col gap-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">Download for your OS</div>
            {mine && mineDownload ? (
                <a
                    href={mineDownload.href}
                    target={mineDownload.direct ? undefined : '_blank'}
                    rel={mineDownload.direct ? undefined : 'noopener noreferrer'}
                    className={PRIMARY_CTA_CLASS + PRIMARY_CTA_HALO + ' justify-center'}
                >
                    <MtlxIcon name={mine.icon} className="w-[18px] h-[18px]" />
                    Download for {mine.label}
                    <span className="font-normal text-on-accent/75 text-xs ml-0.5 pl-2.5 border-l border-on-accent/30">{version || 'latest release'}</span>
                </a>
            ) : (
                <p className="text-sm text-fg-muted">Pick your platform below.</p>
            )}
            {mine && mineDownload && (
                <p className="text-xs text-fg-subtle text-center font-mono truncate" title={mineDownload.name}>{mineDownload.name}{mineDownload.size ? ' · ' + mineDownload.size : ''}</p>
            )}
            <div className="flex items-center justify-center gap-2 flex-wrap text-xs text-fg-subtle">
                <button type="button" onClick={() => { const el = document.getElementById('desktop-downloads'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} className="text-accent-fg hover:text-accent-fg-strong">Other platforms and formats</button>
                <span className="text-fg-faint">·</span>
                <a href={fallback} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-fg hover:text-accent-fg-strong">
                    Release notes <MtlxIcon name="external-link" className="w-3 h-3" />
                </a>
            </div>
        </div>
    );

    return (
        <div ref={rootRef} className="relative">
            <HeroGrid rootRef={rootRef} fadeRef={fadeRef} fadeFrom="top" />
            <div className="relative max-w-5xl mx-auto px-2 sm:px-0 py-8 sm:py-14 space-y-12 sm:space-y-16">

                <ProductBreadcrumb current="Desktop app" />

                {/* Hero */}
                <section aria-labelledby="desktop-h1" className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px] gap-8 items-center">
                    <div className="flex flex-col gap-[18px] min-w-0">
                        <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-fg-strong">
                            <MtlxIcon name="device-desktop" className="w-3.5 h-3.5" />
                            Integrate <span className="text-fg-faint">/</span> <span className="text-fg-muted">Desktop app</span>
                        </div>
                        <div className="flex items-center gap-3 flex-wrap">
                            <h1 id="desktop-h1" className="text-[28px] sm:text-[34px] leading-[1.15] font-bold tracking-[-0.01em] text-fg text-balance">MaterialX Playground for desktop</h1>
                            <span className={EXPERIMENTAL_BADGE_CLASS}>Experimental</span>
                        </div>
                        <p className="text-fg-muted text-base leading-6 max-w-[34em]">
                            The whole Playground as an app for <strong className={STRONG_CLASS}>Windows, macOS and Linux</strong>:
                            Node Specs, Material Viewer, Compare, Graph Editor and Scene Viewer, with the MaterialX libraries and examples built in.
                            It <strong className={STRONG_CLASS}>works fully offline</strong>, opens .mtlx files straight from your file manager,
                            and saves them back to disk.
                        </p>
                        <div className="flex items-center gap-2 flex-wrap text-xs text-fg-subtle">
                            <span>Windows (installer or portable)</span>
                            <span className="text-fg-faint">·</span>
                            <span>macOS on Apple silicon</span>
                            <span className="text-fg-faint">·</span>
                            <span>Linux (AppImage or .deb)</span>
                        </div>
                    </div>
                    <div className="relative min-w-0">
                        <div
                            aria-hidden="true"
                            className="absolute -inset-2 sm:-inset-6 rounded-[28px] pointer-events-none"
                            style={{ backgroundImage: 'radial-gradient(ellipse at 60% 40%, rgb(var(--mtlx-accent-wash) / calc(41 / 255)), transparent 68%)' }}
                        />
                        <div className="relative">{downloadPanel}</div>
                    </div>
                </section>

                <FactsStrip facts={facts} fadeRef={fadeRef} />

                {/* How it works */}
                <section aria-labelledby="desktop-how-h" className="space-y-5">
                    <SectionHead
                        id="desktop-how-h"
                        title="How it works"
                        blurb="The desktop app is the website in its own window, with the parts a browser cannot do: real file access, file association and native menus."
                    />
                    <div className="grid grid-cols-1 [@media(min-width:860px)]:grid-cols-3 gap-4">
                        {DESKTOP_HOW.map((c) => (
                            <div key={c.title} className="bg-surface-raised border border-line-subtle rounded-xl px-5 py-[18px] flex flex-col gap-2">
                                <MtlxIcon name={c.icon} className="w-[26px] h-[26px] text-accent-fg" />
                                <h3 className="text-[15px] font-semibold text-fg">{c.title}</h3>
                                <p className="text-sm leading-5 text-fg-muted">{c.desc}</p>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Features */}
                <section aria-labelledby="desktop-feat-h" className="space-y-5">
                    <SectionHead
                        id="desktop-feat-h"
                        title="Features"
                        blurb="Everything the website does, plus what it means to have the Playground on your own machine."
                    />
                    <FeatureGroups groups={DESKTOP_FEATURE_GROUPS} />
                </section>

                {/* Downloads + install */}
                <section aria-labelledby="desktop-inst-h" className="space-y-9 scroll-mt-4" id="desktop-downloads">
                    <SectionHead
                        id="desktop-inst-h"
                        title="Download and install"
                        blurb={inApp
                            ? 'Every build of the latest release, for reference or for another machine.'
                            : 'Every build of the latest release. Your system is highlighted when it can be detected.'}
                        center
                    />
                    <div className="grid grid-cols-1 [@media(min-width:860px)]:grid-cols-3 gap-3.5">
                        {DESKTOP_PLATFORMS.map((p) => (
                            <DesktopPlatformCard key={p.os} p={p} mine={!inApp && p.os === os} desktop={desktop} version={version} fallback={fallback} />
                        ))}
                    </div>

                    <AsideCards items={[
                        {
                            icon: 'brand-windows',
                            title: 'Windows',
                            body: (
                                <ol className="list-decimal pl-5 space-y-1.5 text-[13.5px] leading-[19px] text-fg-muted">
                                    <li>Run the installer, or just start the portable .exe.</li>
                                    <li>If <strong className={STRONG_CLASS}>Windows protected your PC</strong> appears, choose <strong className={STRONG_CLASS}>More info</strong>, then <strong className={STRONG_CLASS}>Run anyway</strong>. This shows up because the app is not signed.</li>
                                    <li>The installer lets you pick a folder and registers .mtlx files with the app.</li>
                                </ol>
                            ),
                        },
                        {
                            icon: 'brand-apple',
                            title: 'macOS',
                            body: (
                                <ol className="list-decimal pl-5 space-y-1.5 text-[13.5px] leading-[19px] text-fg-muted">
                                    <li>Open the .dmg and drag the app to Applications (or unpack the .zip).</li>
                                    <li>Open the app. macOS refuses it the first time because it cannot verify the developer.</li>
                                    <li>Go to <strong className={STRONG_CLASS}>System Settings &gt; Privacy & Security</strong>, choose <strong className={STRONG_CLASS}>Open Anyway</strong> next to the message about the app, and confirm. Later launches open normally.</li>
                                </ol>
                            ),
                        },
                        {
                            icon: 'brand-ubuntu',
                            title: 'Linux',
                            body: (
                                <>
                                    <p className="text-[13.5px] leading-[19px] text-fg-muted">AppImage: mark it executable, then run it.</p>
                                    <CopyBlock wrap text={'chmod +x MaterialX.Playground-' + v + '.AppImage'} />
                                    <p className="text-[13.5px] leading-[19px] text-fg-muted">Debian or Ubuntu: install the .deb with your package manager.</p>
                                    <CopyBlock wrap text={'sudo apt install ./materialx-playground-desktop_' + v + '_amd64.deb'} />
                                </>
                            ),
                        },
                    ]} />

                    <p className="text-sm leading-[21px] text-fg-muted text-center max-w-[660px] mx-auto">
                        <strong className={STRONG_CLASS}>Updating:</strong> download the newer release and install it over the old one; your settings and recent files are kept.
                        Preferences live in <code className={CODE_CLASS}>mtlx-settings.json</code> in the app's user data folder.
                    </p>
                </section>

                {/* Settings */}
                <section aria-labelledby="desktop-set-h" className="space-y-5">
                    <SectionHead id="desktop-set-h" title="Settings" blurb="Open them from the cog at the right end of the header." />
                    <SettingsTable rows={DESKTOP_SETTINGS} />
                </section>

                {/* Limitations */}
                <section aria-labelledby="desktop-lim-h" className="space-y-5">
                    <SectionHead
                        id="desktop-lim-h"
                        title="Limitations"
                        blurb="The desktop app is an early release and marked Experimental on purpose. Things you should know before relying on it."
                    />
                    <LimitsGrid items={DESKTOP_LIMITS} />
                </section>

                {/* Requirements + privacy */}
                <section aria-labelledby="desktop-req-h" className="space-y-5">
                    <SectionHead id="desktop-req-h" title="Requirements and privacy" />
                    <RequirementsGrid items={DESKTOP_REQUIREMENTS} />
                </section>

                <ProductCta
                    title={inApp ? 'Thanks for trying the desktop app' : 'Try the desktop app'}
                    text={(
                        <>
                            {inApp ? 'Something not working the way it should?' : 'Download it, open a .mtlx file, and work offline. Found a bug?'}{' '}
                            <a href={links.issues} target="_blank" rel="noopener noreferrer" className="text-accent-fg hover:text-accent-fg-strong">Open an issue on GitHub</a>.
                        </>
                    )}
                >
                    {!inApp && mine && mineDownload ? (
                        <a
                            href={mineDownload.href}
                            target={mineDownload.direct ? undefined : '_blank'}
                            rel={mineDownload.direct ? undefined : 'noopener noreferrer'}
                            className={PRIMARY_CTA_CLASS}
                        >
                            <MtlxIcon name={mine.icon} className="w-[18px] h-[18px]" />
                            Download for {mine.label}
                        </a>
                    ) : null}
                    <a href={fallback} target="_blank" rel="noopener noreferrer" className={SECONDARY_CTA_CLASS + ' h-11 px-4 text-sm'}>
                        <MtlxIcon name="external-link" className="w-[16px] h-[16px] text-accent-fg shrink-0" />
                        All releases on GitHub
                    </a>
                </ProductCta>
            </div>
        </div>
    );
}

window.DesktopApp = DesktopApp;
