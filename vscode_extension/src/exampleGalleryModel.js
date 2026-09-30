// exampleGalleryModel.js: pure data shaping for the "New Material from
// Example" gallery webview and the Examples sidebar panel. buildGalleryData
// turns exampleCatalog.js's entries into a flat, filterable card list (one
// card per catalog entry, in catalog order) and resolves each card's
// thumbnail id by reusing newFromExample.js's galleryIdFor. familyChips/
// filterCards mirror the website Material Gallery's own filter semantics
// (js/gallery-app.jsx's `filtered` memo, js/shared/preset-picker.jsx's own
// copy of the same logic): family is single-select exact match, tags are
// multi-select AND, and the search box matches name/family label/shading
// model/license/tags. No vscode dependency, so all of it is unit-testable
// with an inline catalog/manifest fixture (see
// tests/unit/vscode-example-gallery.test.mjs).
'use strict';

const newFromExample = require('./newFromExample');

// Chip order/labels, the Material Gallery's own display order
// (js/gallery-app.jsx's GALLERY_FAMILY_ORDER).
const GALLERY_FAMILY_ORDER = [
    { id: 'StandardSurface', label: 'Standard Surface' },
    { id: 'OpenPbr', label: 'OpenPBR' },
    { id: 'GltfPbr', label: 'glTF PBR' },
    { id: 'UsdPreviewSurface', label: 'USD Preview Surface' },
    { id: 'DisneyPrincipled', label: 'Disney Principled' },
    { id: 'SimpleHair', label: 'Simple Hair' },
    { id: 'Playground', label: 'Playground' },
];

// Multi-select AND tag chips (js/gallery-app.jsx's GALLERY_TAG_FILTERS).
const GALLERY_TAG_FILTERS = [
    { id: 'Textured', label: 'Textured' },
    { id: 'Procedural', label: 'Procedural' },
];

// buildGalleryData(catalog, materials): one card per catalog entry, in
// catalog order. `thumbId` is the gallery/manifest.json id whose
// thumbs/<id>.jpg belongs to this card, or null when there is no matching
// manifest entry (renders as a letter-placeholder tile instead).
function buildGalleryData(catalog, materials) {
    return catalog.map((example) => ({
        id: example.id,
        label: example.label,
        shadingModel: example.shadingModel,
        license: example.license,
        family: example.family,
        familyLabel: example.familyLabel,
        tags: example.tags || [],
        thumbId: newFromExample.galleryIdFor(materials, example),
    }));
}

// familyChips(cards): "All" plus every family actually present among
// `cards`, in GALLERY_FAMILY_ORDER's fixed order.
function familyChips(cards) {
    const present = new Set(cards.map((c) => c.family));
    return [{ id: 'all', label: 'All' }, ...GALLERY_FAMILY_ORDER.filter((f) => present.has(f.id))];
}

// matchesQuery: case-insensitive substring match against a card's label,
// family label, shading model, license, or any of its tags - the fields
// the sidebar/gallery search box documents ("same fields as the website"
// plus shading model/license, which the VS Code catalog carries as plain
// strings the website's own manifest object doesn't expose the same way).
function matchesQuery(card, q) {
    if (!q) return true;
    if ((card.label || '').toLowerCase().indexOf(q) !== -1) return true;
    if ((card.familyLabel || '').toLowerCase().indexOf(q) !== -1) return true;
    if ((card.shadingModel || '').toLowerCase().indexOf(q) !== -1) return true;
    if ((card.license || '').toLowerCase().indexOf(q) !== -1) return true;
    return (card.tags || []).some((t) => t.toLowerCase().indexOf(q) !== -1);
}

// filterCards(cards, { query, family, tags }): family exact-matches (or
// 'all'/falsy keeps everything); tags is AND semantics (every requested tag
// must be present on the card); query is the substring match above. Ported
// 1:1 from js/gallery-app.jsx's `filtered` memo / js/shared/preset-picker.jsx's
// own copy, minus the manifest's paging (this list is small enough not to need it).
function filterCards(cards, opts) {
    const o = opts || {};
    const q = (o.query || '').trim().toLowerCase();
    const family = o.family || 'all';
    const tags = o.tags || [];
    return cards.filter((c) => {
        if (family !== 'all' && c.family !== family) return false;
        if (tags.length && !tags.every((t) => (c.tags || []).indexOf(t) !== -1)) return false;
        return matchesQuery(c, q);
    });
}

// isKnownCardId: message-validation helper -- a webview 'run' message is
// only ever honored when its id is one of the ids this exact card list
// actually sent to that webview, never an arbitrary string.
function isKnownCardId(cards, id) {
    return cards.some((c) => c.id === id);
}

module.exports = { GALLERY_FAMILY_ORDER, GALLERY_TAG_FILTERS, buildGalleryData, familyChips, filterCards, isKnownCardId };
