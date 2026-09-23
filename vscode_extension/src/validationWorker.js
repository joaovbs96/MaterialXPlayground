// validationWorker.js - worker_threads entry, runs tier 1 + 2 .mtlx
// validation off the extension host thread. Pure Node, must not
// require('vscode'). In: {type:'validate',id,text}. Out: {type:'result',id,items,tier2Warning,parseFailures}.
'use strict';

const { parentPort, workerData } = require('worker_threads');
const validator = require('./validator');
const mtlxNode = require('./mtlxNode');

if (!parentPort) {
    throw new Error('validationWorker.js must be run as a worker_threads Worker');
}

validator.init((workerData && workerData.repoRoot) || null);

parentPort.on('message', async (msg) => {
    if (!msg || msg.type !== 'validate') return;
    const id = msg.id;
    const text = typeof msg.text === 'string' ? msg.text : '';

    let items;
    try {
        items = await validator.validateDocument(text);
    } catch (e) {
        // validateDocument already swallows tier-2 failures internally.
        // This is a last-resort guard so a bug here still answers with
        // tier 1 instead of leaving the host's request unresolved.
        try {
            items = validator.scanXml(text);
        } catch (e2) {
            items = [];
        }
    }
    const tier2Warning = validator.consumeTier2Warning();
    parentPort.postMessage({
        type: 'result',
        id,
        items,
        tier2Warning,
        parseFailures: mtlxNode.getParseFailureCount(),
    });
});
