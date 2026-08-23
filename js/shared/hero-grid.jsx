// js/shared/hero-grid.jsx: fading grid background behind a page hero,
// shared by home-app.jsx and vscode-app.jsx. No imports; self-exports
// via Object.assign(window, {}) like the other lazy-loaded files.

// 40px cells, faint gray-500 lines, faded into the page background across
// the fade element's own height (see HeroGrid below for the exact extent).
const HERO_GRID_IMAGE = 'linear-gradient(to right, rgba(107,114,128,0.16) 1px, transparent 1px), linear-gradient(to bottom, rgba(107,114,128,0.16) 1px, transparent 1px)';

// Render as the FIRST child of a `relative` rootRef element. Measures
// against the shell's tagged view wrapper (data-mtlx-view-wrap) and
// fades across fadeRef from its top or middle.
function HeroGrid({ rootRef, fadeRef, fadeFrom }) {
    const [grid, setGrid] = React.useState(null);
    React.useEffect(() => {
        const root = rootRef.current;
        const el = fadeRef.current;
        // The shell tags its view wrappers, so nesting depth no longer has
        // to be guessed: docs sits a level deeper than home. Falls back to
        // the old two-levels-up hop for any host without the marker.
        const wrap = root && (root.closest('[data-mtlx-view-wrap]')
            || (root.parentElement && root.parentElement.parentElement));
        if (!root || !el || !wrap) return undefined;
        const measure = () => {
            const rr = root.getBoundingClientRect();
            const wr = wrap.getBoundingClientRect();
            const fr = el.getBoundingClientRect();
            const top = wr.top - rr.top - wrap.scrollTop;
            const fadeStart = (fadeFrom === 'middle' ? fr.top + fr.height * 0.5 : fr.top) - rr.top - top;
            setGrid({
                top: Math.round(top),
                // floor, not round: rounding a fractional offset up shifts the
                // grid half a pixel past the wrapper edge, and Chrome renders a
                // horizontal scrollbar for that half pixel (1px scrollWidth overflow).
                left: Math.floor(wr.left - rr.left),
                width: wrap.clientWidth,
                height: Math.round(fr.bottom - rr.top - top),
                fadeStart: Math.round(fadeStart),
            });
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(root);
        ro.observe(wrap);
        return () => ro.disconnect();
    }, [fadeFrom]);
    const gridMask = grid ? `linear-gradient(to bottom, rgba(0,0,0,1) 0px, rgba(0,0,0,1) ${grid.fadeStart}px, rgba(0,0,0,0) ${grid.height}px)` : 'none';

    if (!grid) return null;
    return (
        <div
            aria-hidden="true"
            className="pointer-events-none absolute"
            style={{ top: grid.top, left: grid.left, width: grid.width, height: grid.height, backgroundImage: HERO_GRID_IMAGE, backgroundSize: '40px 40px', backgroundPosition: 'center top', maskImage: gridMask, WebkitMaskImage: gridMask }}
        />
    );
}

Object.assign(window, { HeroGrid });
