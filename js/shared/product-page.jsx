// js/shared/product-page.jsx: building blocks shared by the product pages
// (vscode-app.jsx, desktop-app.jsx, about-app.jsx). No imports; self-exports via
// Object.assign(window, {}) like the other lazy-loaded shared files.

// Amber "Experimental" pill, byte-identical to home-app.jsx's
// badgeClassFor('Experimental') string.
const EXPERIMENTAL_BADGE_CLASS = 'text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full border border-experimental-hue/40 bg-experimental-hue/10 text-experimental';
// Small uppercase pill used for feature/soon tags ("Read only", "Soon"...).
const TAG_PILL_CLASS = 'text-[10px] font-medium uppercase tracking-wide px-[7px] py-px rounded-full border border-line-strong text-fg-muted';
const STRONG_CLASS = 'text-fg-soft font-medium';
const CODE_BLOCK_CLASS = 'bg-code-block-bg border border-line rounded-[10px] px-3.5 py-3 font-mono text-[12.5px] leading-[18px] text-fg-soft';
// Inline `<code>` styling: the site has no global rule for bare <code>.
const CODE_CLASS = 'font-mono text-[0.9em] text-code-inline-fg bg-code-inline-bg/50 border border-line rounded px-1 py-px';
// Primary download button, with the accent halo used in both heroes.
const PRIMARY_CTA_CLASS = 'inline-flex items-center gap-2 h-11 px-4 rounded-[10px] bg-accent-fill hover:bg-accent-fill-hover text-on-accent text-sm font-medium transition-colors';
const PRIMARY_CTA_HALO = ' shadow-[0_0_0_4px_rgb(var(--mtlx-accent-wash)_/_calc(26_/_255))]';
// Secondary outlined button (smaller, used for alternate downloads).
const SECONDARY_CTA_CLASS = 'inline-flex items-center gap-1.5 h-[34px] px-3 rounded-lg border border-line-strong bg-control/80 hover:bg-hover text-[13px] font-medium text-fg max-w-full transition-colors';

// One key combo, e.g. <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd>.
function Kbd({ children }) {
    return <kbd className="font-mono text-[12px] text-fg-soft bg-surface-raised border border-line-strong border-b-2 rounded px-1.5">{children}</kbd>;
}

// Section heading, matching home's section-header look; `center` is used
// by the Install sections, which the mockup centers.
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

// Features split into labelled sub-groups ({ title, items }), two columns
// on wide screens. A single untitled group renders as a plain grid.
function FeatureGroups({ groups }) {
    return (
        <div className="space-y-7">
            {groups.map((g) => (
                <div key={g.title || 'all'} className="space-y-1">
                    {g.title && <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-fg-strong pb-1.5">{g.title}</h3>}
                    <div className="grid grid-cols-1 [@media(min-width:720px)]:grid-cols-2 gap-x-6 gap-y-0">
                        {g.items.map((f) => <FeatureItem key={f.title} f={f} />)}
                    </div>
                </div>
            ))}
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
            className={'w-[26px] h-[26px] rounded-md border border-line-control bg-control/80 text-fg-secondary hover:text-fg flex items-center justify-center transition-colors ' + (className || '')}
        >
            <MtlxIcon name={copied ? 'copy-check' : 'copy'} className="w-3.5 h-3.5" />
        </button>
    );
}

// A copyable one-line (or wrapped) command block.
function CopyBlock({ text, wrap }) {
    return (
        <div className="relative">
            <div className={CODE_BLOCK_CLASS + ' pr-11 ' + (wrap ? 'whitespace-pre-wrap break-normal [overflow-wrap:anywhere]' : 'overflow-x-auto whitespace-nowrap')}>{text}</div>
            <CopyButton text={text} className="absolute top-2 right-2" />
        </div>
    );
}

// "Home / <section> / <current>" trail at the top of each product page.
function ProductBreadcrumb({ current, section = 'Integrate' }) {
    return (
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-fg-subtle">
            <a href="#!home" className="hover:text-fg-secondary transition-colors">Home</a>
            <MtlxIcon name="chevron-right" className="w-3 h-3" />
            <span>{section}</span>
            <MtlxIcon name="chevron-right" className="w-3 h-3" />
            <span className="text-fg-muted">{current}</span>
        </nav>
    );
}

// "At a glance" strip: { k, v } cells; fadeRef ends the hero grid fade here.
function FactsStrip({ facts, fadeRef }) {
    return (
        <div ref={fadeRef} aria-label="At a glance" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-line border border-line-subtle rounded-xl overflow-hidden">
            {facts.map((f) => (
                <div key={f.k} className="bg-surface-raised p-3.5 sm:p-4 flex flex-col gap-0.5 min-w-0">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">{f.k}</span>
                    <span className="text-sm font-medium text-fg truncate">{f.v}</span>
                </div>
            ))}
        </div>
    );
}

// One numbered install step; `last` drops the connector line below it.
function InstallStep({ n, title, last, children }) {
    return (
        <li className={'relative grid grid-cols-[32px_minmax(0,1fr)] gap-4' + (last ? '' : ' pb-6')}>
            {!last && <span className="absolute left-[15px] top-[34px] bottom-0 w-0.5 bg-line-subtle" aria-hidden="true" />}
            <span className="w-8 h-8 rounded-full bg-surface-raised border border-line-strong text-accent-fg-strong text-[13px] font-semibold flex items-center justify-center tabular-nums">{n}</span>
            <div className="flex flex-col gap-2 pt-1 min-w-0">
                <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
                {children}
            </div>
        </li>
    );
}

// Equal-width side cards ({ icon, title, body }) below an install section.
function AsideCards({ items }) {
    return (
        <div className="grid grid-cols-1 [@media(min-width:860px)]:grid-cols-3 gap-3.5">
            {items.map((a) => (
                <div key={a.title} className="bg-surface-raised border border-line-subtle rounded-xl px-[18px] py-4 flex flex-col gap-2 min-w-0">
                    <h3 className="flex items-center gap-2 text-[15px] font-semibold text-fg">
                        <MtlxIcon name={a.icon} className="w-4 h-4 text-accent-fg" />
                        {a.title}
                    </h3>
                    {a.body}
                </div>
            ))}
        </div>
    );
}

// Settings table: rows of { setting, values, desc }; `head` renames the first column.
function SettingsTable({ rows, head }) {
    const thClass = 'text-left text-[10px] uppercase tracking-wide text-fg-subtle font-semibold px-3.5 py-2.5 bg-surface-raised border-b border-line';
    return (
        <div className="overflow-x-auto border border-line-subtle rounded-xl">
            <table className="border-collapse w-full min-w-[640px] text-[13.5px] leading-[19px]">
                <thead>
                    <tr>
                        <th className={thClass}>{head || 'Setting'}</th>
                        <th className={thClass}>Values</th>
                        <th className={thClass}>What it does</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, i) => {
                        const borderCls = i === rows.length - 1 ? '' : ' border-b border-line-subtle';
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
    );
}

// Marks a settings value as the default, inline in the Values column.
function DefaultMark() {
    return <span className="text-fg-subtle text-xs font-mono">(default)</span>;
}

// Limitation cards, all sharing the amber alert-triangle (a status signal).
function LimitsGrid({ items }) {
    return (
        <div className="grid grid-cols-1 [@media(min-width:720px)]:grid-cols-2 gap-3">
            {items.map((l) => (
                <div key={l.title} className="grid grid-cols-[20px_minmax(0,1fr)] gap-3 bg-surface-raised border border-line-subtle rounded-xl px-4 py-3.5">
                    <MtlxIcon name="alert-triangle" className="w-[18px] h-[18px] text-warning mt-0.5" />
                    <div className="min-w-0">
                        <div className="text-sm font-semibold text-fg mb-0.5">{l.title}</div>
                        <p className="text-[13.5px] leading-[19px] text-fg-muted">{l.desc}</p>
                    </div>
                </div>
            ))}
        </div>
    );
}

// "Requirements and privacy" items, all sharing the green check icon.
function RequirementsGrid({ items }) {
    return (
        <div className="grid grid-cols-1 [@media(min-width:720px)]:grid-cols-3 gap-3">
            {items.map((r) => (
                <div key={r.title} className="flex gap-2.5 items-start border border-line-subtle rounded-xl px-3.5 py-3">
                    <MtlxIcon name="check" className="w-[18px] h-[18px] text-success mt-0.5" />
                    <div className="min-w-0">
                        <div className="text-sm font-semibold text-fg">{r.title}</div>
                        <p className="text-xs leading-[18px] text-fg-muted">{r.desc}</p>
                    </div>
                </div>
            ))}
        </div>
    );
}

// Bottom call to action card: title, text, and the action buttons.
function ProductCta({ title, text, children }) {
    return (
        <div className="border border-accent-wash/35 bg-surface-raised rounded-2xl px-6 sm:px-7 py-6 flex flex-wrap items-center justify-between gap-5 shadow-[0_0_0_4px_rgb(var(--mtlx-accent-wash)_/_calc(15_/_255))]">
            <div>
                <div className="text-lg font-semibold text-fg">{title}</div>
                <div className="text-[13.5px] text-fg-muted mt-0.5">{text}</div>
            </div>
            <div className="flex gap-2.5 flex-wrap items-center">{children}</div>
        </div>
    );
}

// Release-asset size in MB, or null when the size is unknown.
function formatAssetSize(asset) {
    return asset && typeof asset.size === 'number' ? (asset.size / 1048576).toFixed(1) + ' MB' : null;
}

// Resolves window.mtlxSourceFacts (site-header.js) once; null until settled.
function useReleaseFacts() {
    const [rel, setRel] = React.useState(null);
    React.useEffect(() => {
        let alive = true;
        if (window.mtlxSourceFacts) {
            window.mtlxSourceFacts.then((f) => { if (alive) setRel(f); });
        }
        return () => { alive = false; };
    }, []);
    return rel;
}

Object.assign(window, {
    EXPERIMENTAL_BADGE_CLASS, TAG_PILL_CLASS, STRONG_CLASS, CODE_BLOCK_CLASS, CODE_CLASS,
    PRIMARY_CTA_CLASS, PRIMARY_CTA_HALO, SECONDARY_CTA_CLASS,
    Kbd, SectionHead, FeatureItem, FeatureGroups, CopyButton, CopyBlock, ProductBreadcrumb, FactsStrip,
    InstallStep, AsideCards, SettingsTable, DefaultMark, LimitsGrid, RequirementsGrid, ProductCta,
    formatAssetSize, useReleaseFacts,
});
