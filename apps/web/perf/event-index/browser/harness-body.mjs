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
        idbReadKeysMs: s.idbReadKeysMs || 0,
        idbReadKeysCount: s.idbReadKeysCount || 0,
        longTasks: s.longTasks.map((t) => ({ startTime: t.startTime, duration: t.duration })),
        // Set by page.template.html's installInstrumentation() if `po.observe({type:"longtask"})` threw --
        // Firefox and WebKit do not implement the Long Tasks API, so this is expected (not a harness bug) on
        // those two engines, and run-browser.mjs labels the (necessarily empty) longTasksAttributed list
        // accordingly rather than reporting a bare "none" that would read as "measured and found zero".
        longTaskUnsupported: !!s.longTaskError,
    };
}

async function heapUsage() {
    if (typeof performance.measureUserAgentSpecificMemory === "function") {
        try {
            const r = await performance.measureUserAgentSpecificMemory();
            return { method: "measureUserAgentSpecificMemory", bytes: r.bytes };
        } catch (e) {
            // Falls through to performance.memory - most commonly because the page is not
            // cross-origin-isolated (COOP/COEP), which run-browser.mjs's static server sets, but
            // guard anyway so a heap reading is never fatal to the run.
        }
    }
    if (performance.memory) {
        return { method: "performance.memory", bytes: performance.memory.usedJSHeapSize };
    }
    // Cross-engine extension, Part 2: neither API exists on Firefox or WebKit (both are Chromium-only, one
    // standardized-but-Chromium-only, one a legacy Chromium extension) -- reported honestly as unavailable
    // rather than guessed at. run-browser.mjs's processTreeRssBytes() supplies the coarse OS-level proxy
    // this triggers the README/report to fall back to, labelled by source at every point it is used.
    return { method: "unavailable", bytes: null };
}

/*
 * Cross-engine extension, Part 2: fallback "longest synchronous span" proxy for engines without the Long
 * Tasks API (Firefox, WebKit -- see heapUsage()'s sibling note and page.template.html's try/catch around
 * `po.observe({type:"longtask"})`). A self-rescheduling zero-delay timer: browsers queue timer callbacks on
 * the same main-thread task queue as everything else, so a long synchronous span (e.g. the
 * decrypt+parse+tokenize+insert+sort loop `hydrate()` runs) delays the next tick by roughly its own
 * duration. This is explicitly an UPPER BOUND, not a precise task-boundary measurement the way
 * PerformanceObserver longtask is on Chromium: normal timer-queue/event-loop jitter (typically a few ms per
 * tick, more under this task's CPU throttling) is folded into "longest span" rather than subtracted out, and
 * a very short but genuinely synchronous span shorter than the sampling granularity can be missed entirely.
 * Run unconditionally on all three engines (not just as a Firefox/WebKit fallback) so Chromium's own number
 * can be cross-checked against its real longtask figure -- see measurements-cross-engine.md §2's "surprises"
 * for whether the two agree.
 */
function startSpanWatchdog() {
    const ticks = [performance.now()];
    let running = true;
    function tick() {
        ticks.push(performance.now());
        if (running) setTimeout(tick, 0);
    }
    setTimeout(tick, 0);
    return {
        stop() {
            running = false;
            let maxGap = 0;
            for (let i = 1; i < ticks.length; i++) maxGap = Math.max(maxGap, ticks[i] - ticks[i - 1]);
            return { maxGapMs: maxGap, sampleCount: ticks.length };
        },
    };
}

window.EventIndexHarness = {
    /**
     * Increment C proof support: force the tier/bounds override before constructing a manager in
     * this page. Must be called before ingestAndPersist()/coldRestore*() in this same page load --
     * page state does not survive a new browser process launch, so run-browser.mjs re-applies this
     * at the start of every phase that needs it, not just once per size. Only callable against a
     * checkout that has eventIndexBounds.ts (build.mjs imports it conditionally); unreachable dead
     * code otherwise, since nothing calls this unless --force-tier is passed.
     */
    setBoundsOverride(override) {
        EventIndexBounds.setEventIndexBoundsOverrideForTesting(override);
    },

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
        // Standing measurement (review-pr-b.md B-F2): a prefix query sampled every
        // prefixSampleEvery-th crawler batch, while the batch loop is still running -- the
        // vocabulary is dirty (a new term pending merge) on nearly every batch at this corpus's
        // Heaps'-law rate, so this is "prefix latency while a crawler batch stream is being
        // ingested", not the after-the-fact clean-vocabulary number runQueries() reports.
        const prefixSampleEvery = opts.prefixSampleEvery || 10;
        const prefixDuringIngest = [];
        for (const batch of Corpus.crawlBatches(corpus, opts.eventsPerCrawl || 100)) {
            await manager.addHistoricEvents(batch.events, batch.checkpoint, batch.oldCheckpoint);
            batches++;
            if (batches % prefixSampleEvery === 0) {
                const tq = performance.now();
                const r = await manager.searchEventIndex({ search_term: Corpus.NEW_DEFAULTS.prefixQuery, ...SEARCH_DEFAULTS });
                prefixDuringIngest.push({ atBatch: batches, ms: performance.now() - tq, hits: r.count });
            }
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
            prefixDuringIngest,
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
     * Increment C proof: simulate a pre-manifest (schema v2, this increment's own C-F5) database
     * by opening the raw IndexedDB the just-ingested profile already has on disk and stripping
     * `manifestPageCount`/`diskBytes`/`oldestIndexedTs` off the `meta` row and deleting every
     * `manifest:<page>` row -- exactly the shape a real production v2 database has today. Must run
     * against a profile `ingestAndPersist()` already populated (so there is a real 200k-row corpus
     * to migrate), and before the timed restore call below opens it again. Raw `indexedDB.open()`,
     * not the manager, because the manager's own write paths always keep the manifest consistent;
     * this is deliberately going around that to reconstruct what an old database looks like.
     */
    async stripManifestForMigrationTest() {
        const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open("element-eventindex", 2);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        await new Promise((resolve, reject) => {
            const tx = db.transaction("meta", "readwrite");
            const store = tx.objectStore("meta");
            const getReq = store.get(USER_ID);
            getReq.onsuccess = () => {
                const meta = getReq.result;
                if (meta) {
                    delete meta.manifestPageCount;
                    delete meta.diskBytes;
                    delete meta.oldestIndexedTs;
                    store.put(meta);
                }
                const prefix = `${USER_ID}|manifest:`;
                const keysReq = store.getAllKeys(IDBKeyRange.bound(prefix, prefix + "￿"));
                keysReq.onsuccess = () => {
                    for (const key of keysReq.result) store.delete(key);
                };
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    },

    /**
     * Timed restore against a database {@link stripManifestForMigrationTest} just stripped:
     * `initEventIndex()` itself (must stay flat, same as {@link coldRestoreNonBlocking}'s `initMs`
     * -- the migration pass is started, not awaited, on that same synchronous path), then
     * `waitForManifest()` -- which for a stripped database runs `runManifestMigration`'s full
     * ascending-key scan instead of the fast paged-decrypt `loadManifest` -- timed separately, and
     * finally `waitForHydration()` so the run is left in the same usable state every other restore
     * call leaves it in.
     */
    async coldRestoreWithMigrationTiming() {
        globalThis.__PERF_PICKLE_KEY__ = "perf-pickle-key";
        window.__resetHarnessCounters();
        const t0 = performance.now();
        const manager = new BrowserEventIndexManager();
        await manager.initEventIndex(USER_ID, DEVICE_ID);
        const initMs = performance.now() - t0;

        const tMigration = performance.now();
        await manager.waitForManifest();
        const migrationMs = performance.now() - tMigration;

        const indexStatsAfterMigration = await manager.getStats();

        const tHydration = performance.now();
        await manager.waitForHydration();
        const hydrationMs = performance.now() - tHydration;
        const indexStats = await manager.getStats();

        window.__restoredManager = manager;
        return { initMs, migrationMs, indexStatsAfterMigration, hydrationMs, indexStats };
    },

    /**
     * Increment C proof (review-pr-c.md C2-F3): fill the current manifest page to exactly
     * MANIFEST_PAGE_SIZE first (its own commit, untimed), then add one more event and time the
     * *next* commitLiveEvents() -- the one that re-encrypts the now-full page -- against real
     * IndexedDB and real WebCrypto. Runs against a fresh, throwaway manager/room so it never shares
     * a profile with the sized ingest/restore runs. `pageSize` lets a caller cross-check against a
     * different page size in the same build without changing the constant (accepted, not enforced
     * -- the manager's own MANIFEST_PAGE_SIZE decides where its own pages actually roll over; this
     * is purely how many events this call fills before timing).
     */
    async measureManifestFlushCost({ pageSize = 1000 } = {}) {
        globalThis.__PERF_PICKLE_KEY__ = "perf-pickle-key";
        const manager = new BrowserEventIndexManager();
        await manager.initEventIndex(USER_ID, DEVICE_ID);
        await manager.waitForHydration();
        for (let i = 0; i < pageSize; i++) {
            await manager.addEventToIndex(
                { event_id: `$flush${i}`, room_id: "!flush:example.org", origin_server_ts: 5_000_000 + i, sender: USER_ID, type: "m.room.message", content: { body: `flush cost body ${i}` } },
                {},
            );
        }
        await manager.commitLiveEvents();

        await manager.addEventToIndex(
            { event_id: "$flushDirty", room_id: "!flush:example.org", origin_server_ts: 6_000_000, sender: USER_ID, type: "m.room.message", content: { body: "dirty" } },
            {},
        );
        const t0 = performance.now();
        await manager.commitLiveEvents();
        const flushMs = performance.now() - t0;

        await manager.closeEventIndex();
        return { pageSize, flushMs };
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

    /**
     * `getStats()` latency, called `calls` times against the restored manager. Added for
     * increment B's proof requirement (SYNTHESIS.md §6 row B: "getStats O(1)"): the settings
     * panel calls this roughly every 3s while the Security panel is open, and the old
     * implementation scanned every resident event to build a room `Set`. Reported as
     * median/mean/min/max over `calls` real, unwarmed-up calls (unwarmed deliberately -- an O(1)
     * implementation has no scan to warm up, so a JIT warmup phase would only obscure a
     * regression, not reveal one).
     */
    async getStatsTiming({ calls = 2000 } = {}) {
        const manager = window.__restoredManager;
        const samples = [];
        for (let i = 0; i < calls; i++) {
            const t0 = performance.now();
            await manager.getStats();
            samples.push(performance.now() - t0);
        }
        samples.sort((a, b) => a - b);
        return {
            calls,
            medianMs: samples[Math.floor(samples.length / 2)],
            meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
            minMs: samples[0],
            maxMs: samples[samples.length - 1],
        };
    },

    async closeRestored() {
        if (window.__restoredManager) {
            await window.__restoredManager.closeEventIndex();
            window.__restoredManager = null;
        }
    },

    /**
     * Cold restore against the non-blocking-load manager (PR A): construct a fresh manager and
     * call initEventIndex(), which now returns once meta/keys/checkpoints/identity have loaded --
     * NOT once the whole index has been decrypted, unlike coldRestore() above. Measures, in order:
     *
     *   - initMs: time until initEventIndex() itself resolves. Proof requirement: flat across n.
     *   - a searchEventIndex() call issued exactly 500ms after initEventIndex() returned, while
     *     hydration is (for any n large enough that hydration takes longer than 500ms) still
     *     running in the background -- proof requirement: resolves without throwing.
     *   - hydrationMs / totalMs: time from init-return to waitForHydration() resolving, and from
     *     construction to the same point, respectively -- the "total hydration time" and a sanity
     *     check that initMs + (time spent hydrating) accounts for totalMs.
     *   - longTasks: the PerformanceObserver buffer is never reset between initEventIndex() and
     *     waitForHydration(), so it covers the *entire* restore, not just the fast synchronous part
     *     -- this is what run-browser.mjs's --nonblocking mode reports as "longest main-thread task
     *     during hydration".
     *
     * The manager is left on window.__restoredManager exactly as coldRestore() does, so
     * runQueries()/heapNow() work unmodified against it afterwards.
     */
    async coldRestoreNonBlocking() {
        globalThis.__PERF_PICKLE_KEY__ = "perf-pickle-key";
        window.__resetHarnessCounters();
        const watchdog = startSpanWatchdog(); // Part 2: cross-engine longest-span upper bound, see its own docstring
        const t0 = performance.now();
        const manager = new BrowserEventIndexManager();
        await manager.initEventIndex(USER_ID, DEVICE_ID);
        const initMs = performance.now() - t0;
        const statsAtInit = snapshotStats();
        const indexStatsAtInit = await manager.getStats();

        // Increment C proof: the manifest phase (loadManifest, or runManifestMigration on a
        // pre-manifest database) runs concurrently with the 500ms mid-query sleep below and with
        // hydration itself -- started, like hydration, off initEventIndex()'s synchronous return
        // path, so timing it must never itself perturb the existing measurement points (the
        // mid-query sample stays at exactly +500ms; waitForHydration() below is unaffected). Only
        // present when the manager exposes waitForManifest (increment C+); older checkouts built
        // through this same harness simply never populate manifestTiming.
        const manifestPromise =
            typeof manager.waitForManifest === "function"
                ? (async () => {
                      await manager.waitForManifest();
                      const manifestMs = performance.now() - t0;
                      const heapAfterManifest = await heapUsage();
                      return { manifestMs, heapAfterManifest };
                  })()
                : Promise.resolve(null);

        await new Promise((resolve) => setTimeout(resolve, 500));
        let midQueryError = null;
        let midQueryCount = null;
        try {
            const r = await manager.searchEventIndex({ search_term: Corpus.NEW_DEFAULTS.markerToken, ...SEARCH_DEFAULTS });
            midQueryCount = r.count;
        } catch (e) {
            midQueryError = String(e && e.message ? e.message : e);
        }
        const indexStatsAtMidQuery = await manager.getStats();

        // Standing measurement (review-pr-b.md B-F2): prefix-query latency sampled repeatedly
        // *while hydration is still running*, not only the single after-the-fact number
        // runQueries() reports once waitForHydration() has resolved. Every sample also records
        // getStats().loading, so a sample landing in the brief window after hydration's own last
        // page but before this loop notices is correctly labelled rather than silently counted as
        // "during". Runs from here (500ms after init, same as the existing mid-query above) until
        // hydration ends, sampling every 300ms.
        const prefixDuringHydration = [];
        let hydrating = true;
        const prefixSampleLoop = (async () => {
            while (hydrating) {
                const tq = performance.now();
                const r = await manager.searchEventIndex({ search_term: Corpus.NEW_DEFAULTS.prefixQuery, ...SEARCH_DEFAULTS });
                const loadingNow = (await manager.getStats()).loading;
                prefixDuringHydration.push({ sinceInitReturnMs: performance.now() - t0 - initMs, ms: performance.now() - tq, hits: r.count, loading: loadingNow });
                if (!hydrating) break;
                await new Promise((resolve) => setTimeout(resolve, 300));
            }
        })();

        const t1 = performance.now();
        await manager.waitForHydration();
        hydrating = false;
        await prefixSampleLoop;
        const hydrationMsAfterMidQuery = performance.now() - t1;
        const totalMs = performance.now() - t0;
        const spanWatchdog = watchdog.stop(); // same window as longTasksAttributed: construction through waitForHydration()
        const stats = snapshotStats();
        const indexStats = await manager.getStats();
        // By this point waitForHydration() has already resolved, and the manifest always finishes
        // no later than hydration does (hydrate() itself awaits manifestReadyPromise before its
        // first row), so this is never a wait -- just picking up the result already computed above.
        const manifestTiming = await manifestPromise;

        // Two samples once hydration has genuinely finished (loading: false confirmed):
        // prefixImmediatelyAfterHydrationMs is the *first* query issued once waitForHydration()
        // resolves -- on the old (pre-B-F1) design this can still be a "dirty" sample, because
        // hydrate()'s own last written row can leave the vocabulary flagged dirty with nothing
        // having queried it since, so even the first post-hydration query pays the rebuild.
        // prefixWarmAfterHydrationMs follows two untimed warmup calls (matching runQueries()'s own
        // "3 untimed warmup, then timed" convention) and is the genuinely clean-vocabulary number
        // §5's existing figures are built from -- the two together are what makes the "immediately
        // after hydration is not the same as clean" finding (review-pr-b.md B-F1) visible in this
        // harness's own output rather than only in prose.
        const tImmediate = performance.now();
        const immediateResult = await manager.searchEventIndex({ search_term: Corpus.NEW_DEFAULTS.prefixQuery, ...SEARCH_DEFAULTS });
        const prefixImmediatelyAfterHydrationMs = performance.now() - tImmediate;

        for (let i = 0; i < 2; i++) {
            await manager.searchEventIndex({ search_term: Corpus.NEW_DEFAULTS.prefixQuery, ...SEARCH_DEFAULTS });
        }
        const tWarm = performance.now();
        const warmResult = await manager.searchEventIndex({ search_term: Corpus.NEW_DEFAULTS.prefixQuery, ...SEARCH_DEFAULTS });
        const prefixWarmAfterHydrationMs = performance.now() - tWarm;

        // review-pr-c.md C2-F1's own complaint about measurements-pr-c.md §9: "the proof does not
        // attribute [the long task] it, and contradicts itself" (§9 reported "1" at 200k and "0" at
        // 500k with no explanation for either). The PerformanceObserver buffer covers the *entire*
        // load (construction through waitForHydration()), never reset in between, so every entry's
        // startTime is directly comparable to t0 -- bucket each one into the phase it actually fell
        // in, by ms-since-construction, rather than reporting a bare unattributed list.
        const manifestEndMs = manifestTiming ? manifestTiming.manifestMs : null;
        const longTasksAttributed = stats.longTasks.map((t) => {
            const sinceT0 = t.startTime - t0;
            let phase;
            if (sinceT0 < initMs) phase = "init";
            else if (manifestEndMs !== null && sinceT0 < manifestEndMs) phase = "manifest";
            else if (sinceT0 < totalMs) phase = "hydration";
            else phase = "after-hydration";
            return { ...t, sinceConstructionMs: sinceT0, phase };
        });

        window.__restoredManager = manager;
        return {
            initMs,
            statsAtInit,
            indexStatsAtInit,
            midQueryError,
            midQueryCount,
            indexStatsAtMidQuery,
            prefixDuringHydration,
            prefixImmediatelyAfterHydrationMs,
            prefixImmediatelyAfterHydrationHits: immediateResult.count,
            prefixWarmAfterHydrationMs,
            prefixWarmAfterHydrationHits: warmResult.count,
            hydrationMsAfterMidQuery,
            totalMs,
            manifestTiming,
            ...stats,
            longTasksAttributed,
            spanWatchdog,
            indexStats,
        };
    },
};

window.__eventIndexHarnessReady = true;
