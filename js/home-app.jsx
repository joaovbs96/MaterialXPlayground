// home-app.jsx — the shell's landing view (hash route "#!home", and the
// default when no route is present). A self-contained, static React
// component: no data loading, no render loop, nothing to pause via
// `active`. Written in classic JSX like the other view apps (see
// js/viewer-app.jsx) — the shell Babel-transforms it on first activation.

// The three feature cards, in nav order (mirrors js/site-header.js's NAV
// entries for docs/viewer/graph).
const HOME_CARDS = [
    {
        href: '#!docs',
        icon: 'file-code',
        title: 'Node Library & Documentation',
        desc: 'Browse every standard MaterialX node with per-signature docs, port tables, live 3D previews, an implementation-target matrix, and shareable permalinks.',
    },
    {
        href: '#!viewer',
        icon: 'camera',
        title: 'Material Viewer',
        desc: 'Load and preview materials on a shaderball with real-time shader generation, HDR environments, and .mtlx export.',
    },
    {
        href: '#!graph',
        icon: 'share',
        title: 'Node Graph Editor',
        desc: 'Visually build MaterialX graphs with nested nodegraphs, a live 3D preview, validation, and XML view/export.',
    },
];

function HomeApp({ active } = {}) {
    const title = window.SITE_TITLE || 'MaterialX Playground';
    const links = window.SITE_LINKS || { repo: 'https://github.com/joaovbs96/MaterialXNodeDocs' };
    const version = window.__mtlxVersion;

    return (
        <div className="max-w-5xl mx-auto px-2 sm:px-0 py-8 sm:py-14 space-y-10 sm:space-y-14">
            {/* Hero */}
            <div className="text-center space-y-4">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="icon icon-tabler icons-tabler-filled icon-tabler-inner-shadow-bottom-right w-16 h-16 mx-auto text-blue-400">
                    <path d="M7.113213314864547,17.836439757602623 C3.962962545544091,14.629149767071237 4.00919965907034,9.475663485904064 7.216489095788643,6.325413260547549 C10.423779086320033,3.1751624912270877 15.577264823523263,3.221399050940242 18.72751559284372,6.428689041471628 C21.87776581820023,9.635978478189926 21.831529802451016,14.789464769206242 18.624239811919622,17.939715538526702 C15.416950375201322,21.08996576388322 10.26346354022106,21.04372919432092 7.113213314864547,17.836439757602623 C7.113213314864547,17.836439757602623 7.113213314864547,17.836439757602623 7.113213314864547,17.836439757602623 ZM8.91732412511588,9.218661251949928 C9.232340172246467,9.539381057705786 9.747706415252441,9.544005421136866 10.068426774821386,9.228988830042336 C11.67202746503994,7.653906962497572 14.248858155804163,7.677026030285823 15.823940023348927,9.280626720504376 C16.138956614443458,9.601347080073324 16.654322867298575,9.605970345727371 16.975042673054432,9.290954298596784 C17.29576247881029,8.975938251466197 17.300386842241373,8.460572008460225 16.985370251146843,8.139851648891277 C14.780255745376962,5.894810793347922 11.172692558751647,5.86244409647454 8.92765170320829,8.067558602244421 C8.606931343639342,8.382575193338951 8.602308077985294,8.897941446194071 8.91732412511588,9.218661251949928 C8.91732412511588,9.218661251949928 8.91732412511588,9.218661251949928 8.91732412511588,9.218661251949928 Z" fill="#ffffff" />
                    <path d="M12,2 C17.523000717163086,2 22,6.4770002365112305 22,12 C22,17.523000717163086 17.523000717163086,22 12,22 C6.4770002365112305,22 2,17.523000717163086 2,12 C2,6.4770002365112305 6.4770002365112305,2 12,2 C12,2 12,2 12,2 ZM18,11 C17.447715759277344,11 17,11.447714805603027 17,12 C17,14.76142406463623 14.76142406463623,17 12,17 C11.447714805603027,17 11,17.447715759277344 11,18 C11,18.552284240722656 11.447714805603027,19 12,19 C15.86599349975586,19 19,15.86599349975586 19,12 C19,11.447714805603027 18.552284240722656,11 18,11 C18,11 18,11 18,11 Z" fill="currentColor" />
                </svg>
                <h1 className="text-3xl sm:text-4xl font-bold text-gray-100">{title}</h1>
                <p className="text-gray-400 text-sm sm:text-base max-w-2xl mx-auto">
                    An interactive, open-source, in-browser playground — powered by the official MaterialX WASM
                    build — to browse the standard MaterialX node library, preview materials in real-time 3D, and
                    build node graphs visually.
                </p>
            </div>

            {/* Feature cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
                {HOME_CARDS.map((card) => (
                    <a
                        key={card.href}
                        href={card.href}
                        className="group flex flex-col bg-gray-800 border border-gray-800 rounded-xl p-5 transition-colors hover:border-blue-500/50 hover:bg-gray-800/80"
                    >
                        <MtlxIcon name={card.icon} className="w-8 h-8 text-blue-400" />
                        <div className="mt-3 text-lg font-semibold text-gray-100">{card.title}</div>
                        <p className="mt-1.5 text-sm text-gray-400 flex-1">{card.desc}</p>
                        <div className="mt-4 text-sm font-medium text-blue-400 group-hover:text-blue-300 transition-colors">
                            {'Open →'}
                        </div>
                    </a>
                ))}
            </div>

            {/* Footer strip */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-4 text-sm text-gray-500 border-t border-gray-800 pt-6">
                <span>Powered by MaterialX{version ? ' v' + version : ''}</span>
                <span className="hidden sm:inline text-gray-700">|</span>
                <a
                    href={links.repo}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gray-400 hover:text-gray-200 underline transition-colors"
                >
                    Open source on GitHub
                </a>
            </div>
        </div>
    );
}

window.HomeApp = HomeApp;
