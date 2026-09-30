// nextFreeExampleName.js: pure helper for "New Material from Example"'s
// collision handling. No require('vscode'), unit tested directly.
'use strict';

// Smallest free N (candidate = baseName when N===0, else `${baseName}_N`),
// checked in order starting at startAt. existsFn(candidate) is awaited and
// must report whether ANY path that candidate would write already exists.
async function nextFreeExampleName(baseName, existsFn, startAt) {
    for (let n = startAt || 0; ; n++) {
        const candidate = n === 0 ? baseName : baseName + '_' + n;
        if (!(await existsFn(candidate))) return { name: candidate, n };
    }
}

module.exports = { nextFreeExampleName };
