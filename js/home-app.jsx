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
        img: 'images/preview-docs.jpg',
    },
    {
        href: '#!viewer',
        icon: 'camera',
        title: 'Material Viewer',
        desc: 'Load and preview materials with real-time rendering.',
        img: 'images/preview-material.jpg',
    },
    {
        href: '#!graph',
        icon: 'share',
        title: 'Node Graph Editor',
        desc: 'Visually build MaterialX graphs with nested nodegraphs, a live 3D preview, validation, and XML view/export.',
        img: 'images/preview-nodegraph.jpg',
    },
];

function HomeApp({ active } = {}) {
    const title = window.SITE_TITLE || 'MaterialX Playground';
    const links = window.SITE_LINKS || { repo: 'https://github.com/joaovbs96/MaterialXNodeDocs' };

    return (
        <div className="max-w-5xl mx-auto px-2 sm:px-0 py-8 sm:py-14 space-y-10 sm:space-y-14">
            {/* Hero */}
            <div className="text-center space-y-4">
                <svg
                    xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"
                    className="icon icon-tabler icons-tabler-filled icon-tabler-inner-shadow-bottom-right w-16 h-16 mx-auto text-blue-400"
                    dangerouslySetInnerHTML={{ __html: window.SITE_LOGO_PATHS }}
                />
                <h1 className="text-3xl sm:text-4xl font-bold text-gray-100">{title}</h1>
                <p className="text-gray-400 text-sm sm:text-base max-w-2xl mx-auto">
                    An interactive, open-source, in-browser playground to browse the standard
                    MaterialX node library, preview materials in real-time 3D, and
                    build node graphs visually.
                </p>
            </div>

            {/* Feature cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
                {HOME_CARDS.map((card) => (
                    <a
                        key={card.href}
                        href={card.href}
                        className="group flex flex-col bg-gray-800 border border-gray-800 rounded-xl overflow-hidden transition-colors hover:border-blue-500/50 hover:bg-gray-800/80"
                    >
                        <img
                            src={card.img}
                            alt={card.title}
                            loading="lazy"
                            className="w-full aspect-video object-cover border-b border-gray-700"
                        />
                        <div className="flex flex-col flex-1 p-5">
                            <MtlxIcon name={card.icon} className="w-8 h-8 text-blue-400" />
                            <div className="mt-3 text-lg font-semibold text-gray-100">{card.title}</div>
                            <p className="mt-1.5 text-sm text-gray-400 flex-1">{card.desc}</p>
                            <div className="mt-4 text-sm font-medium text-blue-400 group-hover:text-blue-300 transition-colors">
                                {'Open →'}
                            </div>
                        </div>
                    </a>
                ))}
            </div>
        </div>
    );
}

window.HomeApp = HomeApp;
