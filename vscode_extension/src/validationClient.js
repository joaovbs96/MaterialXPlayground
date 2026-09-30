// validationClient.js - host-side owner of the validationWorker.js
// worker_threads Worker. Pure Node, must not require('vscode'). One
// job runs at a time; see validate() and dispose() for the contract.
'use strict';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_MAX_JOBS_PER_WORKER = 500;
const DEFAULT_MAX_PARSE_FAILURES_PER_WORKER = 50;

class ValidationClient {
    constructor(options) {
        const opts = options || {};
        this._repoRoot = opts.repoRoot;
        this._workerPath = opts.workerPath;
        this._timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
        this._maxRestarts = typeof opts.maxRestarts === 'number' ? opts.maxRestarts : DEFAULT_MAX_RESTARTS;
        this._maxJobsPerWorker = typeof opts.maxJobsPerWorker === 'number' ? opts.maxJobsPerWorker : DEFAULT_MAX_JOBS_PER_WORKER;
        this._maxParseFailuresPerWorker = typeof opts.maxParseFailuresPerWorker === 'number'
            ? opts.maxParseFailuresPerWorker : DEFAULT_MAX_PARSE_FAILURES_PER_WORKER;

        this._worker = null;
        this._jobsOnWorker = 0;
        this._failureCount = 0; // crashes + timeouts, checked against maxRestarts
        this._unavailable = false;
        this._disposed = false;
        this._disposePromise = null;
        this._nextId = 1;

        this._current = null; // { id, resolve, timer } or null: the one in-flight job
        this._queue = new Map(); // key -> { text, resolve }, latest pending request per key
        this._queueOrder = []; // key FIFO; a key appears once, re-used in place on supersede
    }

    // Resolves (never rejects) to { status: 'ok', items, tier2Warning } |
    // { status: 'superseded' } | { status: 'failed', reason: 'timeout' |
    // 'crashed' | 'unavailable' | 'disposed' }.
    validate(key, text) {
        if (this._disposed) return Promise.resolve({ status: 'failed', reason: 'disposed' });
        if (this._unavailable) return Promise.resolve({ status: 'failed', reason: 'unavailable' });

        return new Promise((resolve) => {
            const existing = this._queue.get(key);
            if (existing) {
                existing.resolve({ status: 'superseded' });
            } else {
                this._queueOrder.push(key);
            }
            this._queue.set(key, { text, resolve });
            this._pump();
        });
    }

    // Idempotent: resolves every pending/in-flight job as 'disposed' and
    // tears down the worker. Safe to call more than once; later calls
    // get back the same promise.
    dispose() {
        if (this._disposePromise) return this._disposePromise;
        this._disposed = true;

        if (this._current) {
            const { resolve, timer } = this._current;
            clearTimeout(timer);
            this._current = null;
            resolve({ status: 'failed', reason: 'disposed' });
        }
        this._failAllQueued('disposed');

        const worker = this._worker;
        this._worker = null;
        this._disposePromise = worker
            ? Promise.resolve(worker.terminate()).catch(() => {}).then(() => undefined)
            : Promise.resolve();
        return this._disposePromise;
    }

    // ------------------------------------------------------------------
    // Internals.

    _pump() {
        if (this._current || this._disposed || this._unavailable) return;
        while (this._queueOrder.length) {
            const key = this._queueOrder.shift();
            const job = this._queue.get(key);
            if (!job) continue; // shouldn't happen, every pushed key has an entry until run
            this._queue.delete(key);
            this._runJob(job.text, job.resolve);
            return;
        }
    }

    _runJob(text, resolve) {
        if (!this._ensureWorker()) {
            resolve({ status: 'failed', reason: 'unavailable' });
            this._failAllQueued('unavailable');
            return;
        }
        const id = this._nextId++;
        const timer = setTimeout(() => this._onTimeout(id), this._timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        this._current = { id, resolve, timer };
        this._worker.postMessage({ type: 'validate', id, text });
    }

    // Spawns the worker on first use, or after a crash/timeout/recycle
    // cleared it (never proactively). Returns false, and permanently
    // degrades, if the Worker constructor itself throws.
    _ensureWorker() {
        if (this._worker) return true;
        if (this._unavailable) return false;

        let worker;
        try {
            const { Worker } = require('worker_threads');
            worker = new Worker(this._workerPath, { workerData: { repoRoot: this._repoRoot } });
        } catch (e) {
            this._unavailable = true;
            return false;
        }

        this._worker = worker;
        this._jobsOnWorker = 0;
        worker.unref();

        worker.on('message', (msg) => {
            if (worker !== this._worker) return; // stale message from an already-replaced worker
            this._onMessage(msg);
        });
        // Identity-checked so a genuine crash's 'error'+'exit' pair (or a
        // deliberate terminate() for a timeout/recycle, which already
        // cleared this._worker itself) is only ever handled once.
        const onExitLike = () => {
            if (worker !== this._worker) return;
            this._worker = null;
            if (this._current) {
                const { resolve, timer } = this._current;
                clearTimeout(timer);
                this._current = null;
                resolve({ status: 'failed', reason: 'crashed' });
            }
            this._registerFailure();
        };
        worker.on('error', onExitLike);
        worker.on('exit', onExitLike);
        return true;
    }

    _onMessage(msg) {
        if (!msg || msg.type !== 'result') return;
        if (!this._current || this._current.id !== msg.id) return; // stale reply
        const { resolve, timer } = this._current;
        clearTimeout(timer);
        this._current = null;
        this._jobsOnWorker++;
        resolve({ status: 'ok', items: msg.items, tier2Warning: msg.tier2Warning });

        const parseFailures = typeof msg.parseFailures === 'number' ? msg.parseFailures : 0;
        if (this._jobsOnWorker >= this._maxJobsPerWorker || parseFailures >= this._maxParseFailuresPerWorker) {
            this._terminateWorker(); // graceful recycle, not a failure; doesn't count toward maxRestarts
        }
        this._pump();
    }

    _onTimeout(id) {
        if (!this._current || this._current.id !== id) return; // already resolved/cleared
        const { resolve } = this._current;
        this._current = null;
        resolve({ status: 'failed', reason: 'timeout' });
        this._terminateWorker();
        this._registerFailure();
    }

    _terminateWorker() {
        if (!this._worker) return;
        const worker = this._worker;
        this._worker = null;
        try { worker.terminate(); } catch (e) { /* already gone, ignore */ }
    }

    _registerFailure() {
        this._failureCount++;
        if (this._failureCount > this._maxRestarts) {
            this._unavailable = true;
            this._failAllQueued('unavailable');
            return;
        }
        this._pump(); // respawns lazily, only if a job is actually waiting
    }

    _failAllQueued(reason) {
        for (const key of this._queueOrder) {
            const job = this._queue.get(key);
            if (job) job.resolve({ status: 'failed', reason });
        }
        this._queue.clear();
        this._queueOrder = [];
    }
}

module.exports = { ValidationClient };
