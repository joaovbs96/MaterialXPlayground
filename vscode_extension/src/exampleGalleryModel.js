// exampleGalleryModel.js: pure data shaping for the "New Material from
// Example" gallery webview. buildGalleryData groups exampleCatalog.js's
// entries the same way the old QuickPick did (insertion order, one group
// per `source`) and resolves each card's thumbnail id by reusing
// newFromExample.js's galleryIdFor -- the ONE place that knows how a
// catalog entry's source document maps to a gallery/manifest.json id.
// filterGroups/isKnownCardId have no vscode dependency either, so all
// three are unit-testable with an inline catalog/manifest fixture (see
// tests/unit/vscode-example-gallery.test.mjs).
'use strict';

const newFromExample = require('./newFromExample');

// buildGalleryData(catalog, materials): one group per `source`, cards in
// catalog order within each group. `thumbId` is the gallery/manifest.json
// id whose thumbs/<id>.jpg belongs to this card, or null when there is no
// matching manifest entry (renders as a letter-placeholder tile instead).
function buildGalleryData(catalog, materials) {
    const groups = [];
    const bySource = new Map();
    for (const example of catalog) {
        let group = bySource.get(example.source);
        if (!group) {
            group = { source: example.source, cards: [] };
            bySource.set(example.source, group);
            groups.push(group);
        }
        group.cards.push({
            id: example.id,
            label: example.label,
            shadingModel: example.shadingModel,
            license: example.license,
            thumbId: newFromExample.galleryIdFor(materials, example),
        });
    }
    return groups;
}

// filterGroups(groups, query): case-insensitive substring match against a
// card's label, shading model and license; a group with no surviving
// cards is dropped entirely (rather than kept with an empty card list).
function filterGroups(groups, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return groups;
    const out = [];
    for (const group of groups) {
        const cards = group.cards.filter((c) =>
            c.label.toLowerCase().includes(q) ||
            c.shadingModel.toLowerCase().includes(q) ||
            c.license.toLowerCase().includes(q)
        );
        if (cards.length) out.push({ source: group.source, cards });
    }
    return out;
}

// isKnownCardId: message-validation helper -- a webview 'run' message is
// only ever honored when its id is one of the ids this exact set of
// groups actually sent to that webview, never an arbitrary string.
function isKnownCardId(groups, id) {
    return groups.some((g) => g.cards.some((c) => c.id === id));
}

module.exports = { buildGalleryData, filterGroups, isKnownCardId };
