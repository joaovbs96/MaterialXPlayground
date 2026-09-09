// win-fs-retry-shim.cjs: preloaded around the electron-builder
// subprocess. Windows AV can briefly lock a just-written file, so
// fs/promises chmod/rename/unlink get a retry-with-backoff here.
'use strict';

if (process.platform === 'win32') {
    const fsPromises = require('node:fs/promises');
    const RETRY_CODES = new Set(['EPERM', 'EBUSY']);
    const MAX_ATTEMPTS = 10;
    const DELAY_MS = 300;

    function withRetry(fn) {
        return async function retried(...args) {
            for (let attempt = 1; ; attempt++) {
                try {
                    return await fn.apply(this, args);
                } catch (err) {
                    if (attempt >= MAX_ATTEMPTS || !RETRY_CODES.has(err && err.code)) throw err;
                    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
                }
            }
        };
    }

    fsPromises.chmod = withRetry(fsPromises.chmod);
    fsPromises.rename = withRetry(fsPromises.rename);
    fsPromises.unlink = withRetry(fsPromises.unlink);
}
