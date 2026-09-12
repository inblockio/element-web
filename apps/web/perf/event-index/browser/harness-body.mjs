/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/*
 * Appended (by build.mjs) after `import { BrowserEventIndexManager } from ...` and
 * `import * as Corpus from ...`. Exposes `window.EventIndexHarness`, driven from Node via
 * `page.evaluate()` in `../run-browser.mjs`. Everything here runs inside the real Chromium page:
 * real IndexedDB, real WebCrypto, the actual unmodified BrowserEventIndexManager.ts.
 *
 * Instrumentation (IndexedDB transaction counting, decrypt/read timing, long-task capture) is
 * installed by an inline classic <script> in page.html BEFORE this module loads, so every
 * prototype patch is in place before the manager ever touches indexedDB/crypto.subtle. See
 * page.template.html for that script and window.__harnessStats/__resetHarnessCounters.
 */

const SEARCH_DEFAULTS = { before_limit: 0, after_limit: 0, order_by_recency: true, limit: 10 };
const USER_ID = "@perfuser:example.org";
const DEVICE_ID = "PERFDEVICE";

function snapshotStats() {
    const s = window.__harnessStats;
    return {
        idbTxCount: s.idbTxCount,
        idbTxByStore: { ...s.idbTxByStore },
        decryptMs: s.decryptMs,
        decryptCount: s.decryptCount,
        encryptMs: s.encryptMs || 0,
        encryptCount: s.encryptCount || 0,
        idbReadMs: s.idbReadMs,
        idbReadCount: s.idbReadCount,
        longTasks: s.longTasks.map((t) => ({ startTime: t.startTime, duration: t.duration })),
    };
}

async function heapUsage() {
    if (typeof performance.measureUserAgentSpecificMemory === "function") {
        try {
            const r = await performance.measureUserAgentSpecificMemory();
            return { method: "measureUserAgentSpecificMemory", bytes: r.bytes };
        } catch {
            // Falls through to performance.memory - most commonly because the page is not
            // cross-origin-isolated (COOP/COEP), which run-browser.mjs's static server sets, but
            // guard anyway so a heap reading is never fatal to the run.
        }
    }
    if (performance.memory) {
        return { method: "performance.memory", bytes: performance.memory.usedJSHeapSize };
    }
    return { method: "unavailable", bytes: null };
}

window.EventIndexHarness = {
    /**
     * Generate the corpus and run it through addHistoricEvents() in real crawl order (see
     * corpus.mjs's crawlBatches), then drain the write queue with commitLiveEvents(). Returns
     * timing, IndexedDB transaction counts split by ingest-loop vs. drain, and corpus stats.
     */
    async ingestAndPersist(opts) {
        globalThis.__PERF_PICKLE_KEY__ = "perf-pickle-key";
        const corpus = Corpus.generateCorpusNew(opts);
        const manager = new BrowserEventIndexManager();
        await manager.initEventIndex(USER_ID, DEVICE_ID);

        window.__resetHarnessCounters();
        const t0 = performance.now();
        let batches = 0;
        for (const batch of Corpus.crawlBatches(corpus, opts.eventsPerCrawl || 100)) {
            await manager.addHistoricEvents(batch.events, batch.checkpoint, batch.oldCheckpoint);
            batches++;
        }
        const ingestMs = performance.now() - t0;
        const afterIngest = snapshotStats();

        const t1 = performance.now();
        await manager.commitLiveEvents();
        const persistDrainMs = performance.now() - t1;
        const afterDrain = snapshotStats();

        const indexStats = await manager.getStats();
        await manager.closeEventIndex();

        return {
            ingestMs,
            persistDrainMs,
            batches,
            idbTxDuringIngest: afterIngest.idbTxCount,
            idbTxDuringDrain: afterDrain.idbTxCount - afterIngest.idbTxCount,
            idbTxTotal: afterDrain.idbTxCount,
            idbTxByStore: afterDrain.idbTxByStore,
            corpusStats: corpus.stats,
            indexStats,
        };
    },

    /**
     * Cold restore: construct a fresh manager and call initEventIndex(), which internally runs
     * loadAllForUser() - one getAll() per store, then a decrypt+tokenise+insert loop, then one
     * sort per room. The manager is stashed on `window.__restoredManager` so `runQueries()` and
     * `heapAfterRestore()` can use the exact same in-memory index without re-restoring.
     */
    async coldRestore() {
        globalThis.__PERF_PICKLE_KEY__ = "perf-pickle-key";
        window.__resetHarnessCounters();
        const t0 = performance.now();
        const manager = new BrowserEventIndexManager();
        await manager.initEventIndex(USER_ID, DEVICE_ID);
        const restoreMs = performance.now() - t0;
        const stats = snapshotStats();
        const indexStats = await manager.getStats();
        window.__restoredManager = manager;
        return { restoreMs, ...stats, indexStats };
    },

    /**
     * JS heap right now. Called three times per size by run-browser.mjs: immediately after page
     * load (before any harness call - the "empty page" baseline the coordinator asked for),
     * right after coldRestore(), and right after runQueries(). "Real-shape heap bytes/event" is
     * computed in Node as (afterRestore - emptyPage) / n, never as a raw total, because the empty
     * page itself (this bundle, its stubs, the instrumentation script, V8's own startup heap) is
     * not zero and must not be attributed to the index.
     */
    async heapNow() {
        return heapUsage();
    },

    /**
     * Per-query latency for the four categories the corpus seeds deterministically (see
     * corpus.mjs's NEW_DEFAULTS: markerToken/prefixQuery/substringQuery/missQuery). `warmup`
     * untimed calls precede the `queries` timed ones per category, per the "median of 20, warm"
     * instruction; the timed samples are returned (sorted ascending) plus the median.
     */
    async runQueries({ queries = 20, warmup = 3 } = {}) {
        const manager = window.__restoredManager;
        const categories = {
            token: Corpus.NEW_DEFAULTS.markerToken,
            prefix: Corpus.NEW_DEFAULTS.prefixQuery,
            substring: Corpus.NEW_DEFAULTS.substringQuery,
            miss: Corpus.NEW_DEFAULTS.missQuery,
        };
        const out = {};
        for (const [name, term] of Object.entries(categories)) {
            for (let i = 0; i < warmup; i++) {
                await manager.searchEventIndex({ search_term: term, ...SEARCH_DEFAULTS });
            }
            const samples = [];
            let hits = 0;
            for (let i = 0; i < queries; i++) {
                const t0 = performance.now();
                const r = await manager.searchEventIndex({ search_term: term, ...SEARCH_DEFAULTS });
                samples.push(performance.now() - t0);
                hits = r.count;
            }
            samples.sort((a, b) => a - b);
            out[name] = {
                term,
                hits,
                medianMs: samples[Math.floor(samples.length / 2)],
                minMs: samples[0],
                maxMs: samples[samples.length - 1],
                samples,
            };
        }
        return out;
    },

    async closeRestored() {
        if (window.__restoredManager) {
            await window.__restoredManager.closeEventIndex();
            window.__restoredManager = null;
        }
    },
};

window.__eventIndexHarnessReady = true;
