// js/roadmap-app.jsx — the Roadmap view (hash route "#!roadmap").
// Fetches ROADMAP.md from the site root at view time and renders it with
// a small in-house Markdown-subset parser (no build step, no generated
// JSON). Editing ROADMAP.md is the only way to change this page's content.
// Shell-injected, no imports; depends only on js/shared/mtlx-ui.jsx.

// Status metadata: order, label, dot color (amber only for "in progress",
// muted for "parked", green for "done", matching the site's tone palette).
const ROADMAP_STATUSES = [
    { id: 'in progress', label: 'In progress', dot: 'bg-amber-400', text: 'text-amber-300', border: 'border-amber-500/40', bg: 'bg-amber-500/10' },
    { id: 'planned', label: 'Planned', dot: 'bg-blue-400', text: 'text-blue-300', border: 'border-blue-500/40', bg: 'bg-blue-500/10' },
    { id: 'idea', label: 'Idea', dot: 'bg-gray-400', text: 'text-gray-300', border: 'border-gray-500/40', bg: 'bg-gray-500/10' },
    { id: 'parked', label: 'Parked', dot: 'bg-gray-600', text: 'text-gray-500', border: 'border-gray-700', bg: 'bg-gray-800/60' },
    { id: 'done', label: 'Done', dot: 'bg-green-400', text: 'text-green-300', border: 'border-green-500/40', bg: 'bg-green-500/10' },
];
const ROADMAP_STATUS_BY_ID = {};
ROADMAP_STATUSES.forEach((s) => { ROADMAP_STATUS_BY_ID[s.id] = s; });

// Stable slug for anchor ids: lowercase, non-alnum runs collapsed to a
// single hyphen, trimmed. Same rule for area headings and item titles so
// "#!roadmap" deep links can be added later without a format change.
function roadmapSlug(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'section';
}

// Renders inline markdown: **bold**, `code`, [text](url). Unmatched
// syntax passes through as plain text — this is a subset parser for our
// own fixed-format file, not a general Markdown engine.
function roadmapInline(text, keyPrefix) {
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
    const parts = String(text).split(re);
    let n = 0;
    return parts.filter((p) => p !== undefined && p !== '').map((part) => {
        const key = keyPrefix + '-' + (n++);
        if (/^\*\*[^*]+\*\*$/.test(part)) {
            return <strong key={key} className="font-semibold text-gray-100">{part.slice(2, -2)}</strong>;
        }
        if (/^`[^`]+`$/.test(part)) {
            return <code key={key} className="font-mono text-[0.9em] text-gray-200 bg-gray-700/50 border border-gray-700 rounded px-1 py-px">{part.slice(1, -1)}</code>;
        }
        const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (linkMatch) {
            return <a key={key} href={linkMatch[2]} className="text-blue-400 hover:text-blue-300 transition-colors" target="_blank" rel="noreferrer">{linkMatch[1]}</a>;
        }
        return part;
    });
}

// Parses the ROADMAP.md subset into { title, intro, sections }. Unknown
// lines fall back to plain paragraphs so the page never goes blank on a
// small format drift.
function parseRoadmap(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    let title = 'Roadmap';
    const introParas = [];
    const sections = [];
    let currentSection = null;
    const itemRe = /^-\s*\[([^\]]+)\]\s*\*\*([^*]+)\*\*:\s*(.*)$/;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.trim();
        if (!line) continue;

        if (line.startsWith('## ')) {
            const heading = line.slice(3).trim();
            currentSection = { heading, id: roadmapSlug(heading), items: [] };
            sections.push(currentSection);
            continue;
        }
        if (line.startsWith('# ')) {
            title = line.slice(2).trim();
            continue;
        }
        const itemMatch = itemRe.exec(line);
        if (itemMatch && currentSection) {
            const status = itemMatch[1].trim().toLowerCase();
            currentSection.items.push({
                status: ROADMAP_STATUS_BY_ID[status] ? status : 'idea',
                title: itemMatch[2].trim(),
                text: itemMatch[3].trim(),
                id: roadmapSlug(itemMatch[2]),
            });
            continue;
        }
        // Plain paragraph: before the first section, it's part of the
        // intro; a stray unmatched line inside a section still renders,
        // just as a paragraph rather than a dropped item.
        if (!currentSection) {
            introParas.push(line);
        } else {
            currentSection.items.push({ status: null, title: null, text: line, id: 'p-' + i });
        }
    }
    return { title, intro: introParas.join(' '), sections };
}

// One status pill in the legend/filter row. `count` renders only in the
// legend usage (filter row omits it via undefined).
function RoadmapStatusPill({ status, active, count, onClick }) {
    const meta = ROADMAP_STATUS_BY_ID[status] || ROADMAP_STATUSES[2];
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={onClick}
            className={'h-8 px-3.5 rounded-full border text-[13px] font-medium transition-colors inline-flex items-center gap-1.5 '
                + (active ? 'border-blue-500 bg-blue-500/[0.12] text-blue-300' : 'border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-gray-100')}
        >
            <span className={'w-1.5 h-1.5 rounded-full ' + meta.dot} aria-hidden="true" />
            {meta.label}
            {typeof count === 'number' && <span className="text-gray-500">{count}</span>}
        </button>
    );
}

// One roadmap item row inside a SectionCard: status badge, bold title,
// description with inline formatting.
function RoadmapItemRow({ item }) {
    if (!item.status) {
        return <p id={item.id} className="text-sm text-gray-400">{roadmapInline(item.text, item.id)}</p>;
    }
    const meta = ROADMAP_STATUS_BY_ID[item.status];
    return (
        <div id={item.id} className="flex flex-col sm:flex-row sm:items-baseline gap-1.5 sm:gap-3 py-2 border-b border-gray-700/40 last:border-b-0">
            <span className={'shrink-0 self-start text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ' + meta.border + ' ' + meta.bg + ' ' + meta.text}>
                {meta.label}
            </span>
            <div className="min-w-0">
                <span className="font-semibold text-gray-100 text-sm">{item.title}</span>
                <span className="text-sm text-gray-400">{item.text ? ': ' : ''}{roadmapInline(item.text, item.id)}</span>
            </div>
        </div>
    );
}

function RoadmapErrorState() {
    return (
        <div className="flex flex-col items-center justify-center gap-3 text-center py-20 px-4 bg-gray-800 border border-gray-800 rounded-xl">
            <MtlxIcon name="alert-triangle" className="w-8 h-8 text-amber-300" />
            <h2 className="text-lg font-semibold text-gray-100">Roadmap not available</h2>
            <p className="text-sm text-gray-400 max-w-md">
                ROADMAP.md could not be fetched. If you are running this locally, make sure the site is
                served from the repository root.
            </p>
        </div>
    );
}

function MtlxRoadmapApp({ active } = {}) {
    const fetchedRef = React.useRef(false);
    const [raw, setRaw] = React.useState(null); // null: loading, 'error': failed, else the text
    const [statusFilter, setStatusFilter] = React.useState('all');

    React.useEffect(() => {
        if (!active || fetchedRef.current) return;
        fetchedRef.current = true;
        fetch('ROADMAP.md', { cache: 'no-cache' })
            .then((r) => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))))
            .then((text) => setRaw(text))
            .catch(() => setRaw('error'));
    }, [active]);

    const parsed = React.useMemo(() => {
        if (!raw || raw === 'error') return null;
        return parseRoadmap(raw);
    }, [raw]);

    const counts = React.useMemo(() => {
        const c = { 'in progress': 0, planned: 0, idea: 0, parked: 0, done: 0 };
        if (parsed) {
            parsed.sections.forEach((s) => s.items.forEach((it) => { if (it.status) c[it.status] = (c[it.status] || 0) + 1; }));
        }
        return c;
    }, [parsed]);

    const totalItems = ROADMAP_STATUSES.reduce((sum, s) => sum + (counts[s.id] || 0), 0);

    return (
        <div className="relative max-w-5xl mx-auto px-2 sm:px-0 py-8 sm:py-14 space-y-6">
            <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-gray-500">
                <a href="#!home" className="hover:text-gray-300 transition-colors">Home</a>
                <MtlxIcon name="chevron-right" className="w-3 h-3" />
                <span>Learn</span>
                <MtlxIcon name="chevron-right" className="w-3 h-3" />
                <span className="text-gray-400">Roadmap</span>
            </nav>

            <div className="space-y-2">
                <h1 className="text-[28px] sm:text-[34px] leading-[1.15] font-bold tracking-[-0.01em] text-gray-100 text-balance">
                    {parsed ? parsed.title : 'Roadmap'}
                </h1>
                {parsed && parsed.intro && (
                    <p className="text-gray-400 text-sm sm:text-base max-w-[60em]">{roadmapInline(parsed.intro, 'intro')}</p>
                )}
            </div>

            {raw === 'error' && <RoadmapErrorState />}
            {raw === null && (
                <div className="flex items-center justify-center h-40 text-gray-400 text-sm animate-pulse">Loading roadmap…</div>
            )}

            {parsed && (
                <>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            aria-pressed={statusFilter === 'all'}
                            onClick={() => setStatusFilter('all')}
                            className={'h-8 px-3.5 rounded-full border text-[13px] font-medium transition-colors '
                                + (statusFilter === 'all' ? 'border-blue-500 bg-blue-500/[0.12] text-blue-300' : 'border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-gray-100')}
                        >
                            All <span className="text-gray-500">{totalItems}</span>
                        </button>
                        {ROADMAP_STATUSES.map((s) => (
                            <RoadmapStatusPill
                                key={s.id}
                                status={s.id}
                                active={statusFilter === s.id}
                                count={counts[s.id] || 0}
                                onClick={() => setStatusFilter((prev) => (prev === s.id ? 'all' : s.id))}
                            />
                        ))}
                    </div>

                    <div className="space-y-4">
                        {parsed.sections.map((section) => {
                            const visibleItems = statusFilter === 'all'
                                ? section.items
                                : section.items.filter((it) => it.status === statusFilter || !it.status);
                            if (!visibleItems.length) return null;
                            return (
                                <div key={section.id} id={section.id}>
                                    <SectionCard icon="article" title={section.heading} defaultOpen dense>
                                        {visibleItems.map((item) => <RoadmapItemRow key={item.id} item={item} />)}
                                    </SectionCard>
                                </div>
                            );
                        })}
                    </div>

                    <p className="text-xs text-gray-500 pt-2 border-t border-gray-700/40">
                        Edit ROADMAP.md in the repository to change this page.
                    </p>
                </>
            )}
        </div>
    );
}

window.MtlxRoadmapApp = MtlxRoadmapApp;
