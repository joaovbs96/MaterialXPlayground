// slow-worker.cjs - fixture worker_threads entry for
// tests/unit/vscode-validation-client.test.mjs. Mimics validationWorker.js's
// protocol with test-controlled timing/crash behavior instead of real
// MaterialX. Config rides inside workerData.repoRoot as a JSON string:
//   { delayMs, crashOnStart, crashOnMessage, hang, parseFailures }
'use strict';

const { parentPort, workerData } = require('worker_threads');

let cfg = {};
try {
    cfg = JSON.parse((workerData && workerData.repoRoot) || '{}');
} catch (e) { cfg = {}; }

if (cfg.crashOnStart) {
    process.exit(1);
}

parentPort.on('message', (msg) => {
    if (!msg || msg.type !== 'validate') return;
    if (cfg.hang) return; // never reply, exercises the client's timeout path
    if (cfg.crashOnMessage) {
        process.exit(1);
    }
    const reply = () => {
        parentPort.postMessage({
            type: 'result',
            id: msg.id,
            items: [],
            tier2Warning: null,
            parseFailures: typeof cfg.parseFailures === 'number' ? cfg.parseFailures : 0,
        });
    };
    if (typeof cfg.delayMs === 'number' && cfg.delayMs > 0) setTimeout(reply, cfg.delayMs);
    else reply();
});
