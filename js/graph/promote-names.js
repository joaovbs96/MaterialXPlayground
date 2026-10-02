// js/graph/promote-names.js: pure naming and validation rules for Convert to
// Node Def, shared by the preview panel and promoteNodegraph in graph-app.jsx.
// Plain JS (no JSX), so tests/unit can eval it directly in Node.

// MaterialX Document::incrementName: bump trailing digits, else append "2".
const promoteIncrementName = (name) => {
    let split = name.length;
    while (split > 0 && name.charCodeAt(split - 1) >= 48 && name.charCodeAt(split - 1) <= 57) split--;
    if (split < name.length) return name.slice(0, split) + (parseInt(name.slice(split), 10) + 1);
    return name + '2';
};

// Mirrors the order promoteNodegraph mutates the document: nodedef first,
// then the graph is renamed, then the instance takes the freed old name.
// childNames: every root child name; outputTypes: the graph's real outputs.
const computePromotionNames = ({ nodeName, gName, outputTypes, childNames }) => {
    const taken = new Set(childNames || []);
    const valid = (base) => {
        let n = base;
        while (taken.has(n)) n = promoteIncrementName(n);
        return n;
    };
    const types = outputTypes || [];
    const outType = types.length > 1 ? 'multioutput' : (types[0] || 'color3');
    const suffix = outType === 'multioutput' ? 'multi' : outType;
    const ndName = valid('ND_' + nodeName + '_' + suffix);
    taken.add(ndName);
    const ngName = valid('NG_' + nodeName + '_' + suffix);
    taken.delete(gName);
    taken.add(ngName);
    const instName = valid(gName);
    return { outType, ndName, ngName, instName };
};

// Syntax issue for a proposed node name, or '' when fine. isValid and
// describe are injected because the binding's checker lives in the app.
const promoteNameError = (name, isValid, describe) => (isValid(name) ? '' : describe(name));

// Warning (never an error) when the new definition would shadow a node of
// the same name: a standard-library one or one defined in this document.
const promoteShadowWarning = (name, libraryNodes, localNodes) => {
    const has = (list) => !!list && (list.has ? list.has(name) : list.indexOf(name) !== -1);
    if (has(localNodes)) return '"' + name + '" is already defined in this document. The new definition will sit beside it.';
    if (has(libraryNodes)) return '"' + name + '" is a standard library node. The new definition will shadow it in this document.';
    return '';
};

// One line: "Exposes 6 inputs and 1 output (color3)".
const promoteInterfaceSummary = (inputCount, outputTypes) => {
    const outs = outputTypes || [];
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    return 'Exposes ' + plural(inputCount, 'input') + ' and ' + plural(outs.length, 'output')
        + (outs.length ? ' (' + outs.join(', ') + ')' : '');
};

if (typeof window !== 'undefined') {
    Object.assign(window, {
        promoteIncrementName, computePromotionNames, promoteNameError,
        promoteShadowWarning, promoteInterfaceSummary,
    });
}
