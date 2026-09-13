#!/usr/bin/env node
/*
 * Reproducible performance harness for BrowserEventIndexManager (element-web PR #34718).
 *
 * WHY THIS LIVES OUTSIDE THE REPOSITORY
 * -------------------------------------
 * element-web has no benchmark convention: no `bench`/`perf` npm script, no `*.bench.ts` files,
 * no vitest `bench` usage anywhere in the tree (`apps/web/src/performance/` is the runtime
 * performance-mark module, not a benchmark harness). Adding the first one inside a feature PR
 * would be scope the reviewers did not ask for, so this sits beside the checkout instead.
 *
 * WHAT IT MEASURES
 * ----------------
 *   index build       - addEventToIndex() over a synthetic corpus, memory-only (no pickle key,
 *                       so no AES-GCM), which isolates tokenising + insertRoomOrder.
 *   warm start        - initEventIndex() over rows already in IndexedDB: decrypt + re-tokenise +
 *                       one sort per room.
 *   token search      - searchEventIndex() on terms the inverted index answers.
 *   substring         - searchEventIndex() on fragments the token path misses, so every query
 *                       falls through to substringHits()'s linear scan over folded text.
 *   memory            - heapUsed delta across the build, plus process maxRSS.
 *
 * HOW IT WORKS
 * ------------
 * The manager is bundled with esbuild from the checkout (so `node_modules` resolves), with four
 * leaf modules stubbed: `matrix-js-sdk/src/logger`, `matrix-js-sdk/src/matrix` (only base64
 * helpers are used at value level), `../../PlatformPeg` and `../../settings/SettingsStore`.
 * Everything under test - tokenise, fold, invert, order, encrypt, persist - is the real code.
 * fake-indexeddb provides the storage layer, as it does in the unit suite.
 *
 * USAGE
 * -----
 *   node event-index-perf.mjs [--events 3000] [--rooms 8] [--queries 20] [--json]
 *   node event-index-perf.mjs --generator old      # 2026-09-12 harness, for the bias-check comparison
 *   node event-index-perf.mjs --generator new ...   # default: all four corpus bias fixes, real crawl order
 *   ELEMENT_WEB=/path/to/element-web node event-index-perf.mjs
 *
 * 2026-09-13 UPDATE - CORPUS BIAS FIXES
 * --------------------------------------
 * `--generator old` reproduces the original harness byte-for-byte: ascending timestamps, even room spread, a
 * thin event shape, and addEventToIndex()'s live-timeline API (always appends, never pays the backward-insert
 * cost). `--generator new` (the default) is a different, more realistic measurement, not just a different
 * corpus: it drives the corpus through `addHistoricEvents()` in `EVENTS_PER_CRAWL`-sized (100), newest-first,
 * round-robin batches, exactly as the real crawler does (see `corpus.mjs`'s module docstring). This changes
 * *what is measured* under "index build" and "persist", which is why both remain selectable and why the
 * bias-check in measurements-v1.md runs both at the same size.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateCorpusOld, generateCorpusNew, crawlBatches, OLD_FRAGMENT, NEW_DEFAULTS } from "./corpus.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
    const opts = {
        events: 3000,
        rooms: 8,
        queries: 20,
        json: false,
        generator: "new",
        seed: NEW_DEFAULTS.seed,
        zipfRoomExponent: NEW_DEFAULTS.zipfRoomExponent,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--json") opts.json = true;
        else if (arg === "--events") opts.events = Number(argv[++i]);
        else if (arg === "--rooms") opts.rooms = Number(argv[++i]);
        else if (arg === "--queries") opts.queries = Number(argv[++i]);
        else if (arg === "--generator") opts.generator = argv[++i];
        else if (arg === "--seed") opts.seed = Number(argv[++i]);
        else if (arg === "--zipf-room-exponent") opts.zipfRoomExponent = Number(argv[++i]);
        else throw new Error(`unknown argument: ${arg}`);
    }
    if (opts.generator !== "old" && opts.generator !== "new") {
        throw new Error(`--generator must be "old" or "new", got ${JSON.stringify(opts.generator)}`);
    }
    return opts;
}

/** The checkout to measure. */
export function findRepo() {
    const candidates = [process.env.ELEMENT_WEB, join(HERE, "..", "element-web")].filter(Boolean);
    for (const candidate of candidates) {
        if (existsSync(join(candidate, "apps/web/src/vector/platform/BrowserEventIndexManager.ts"))) {
            return resolvePath(candidate);
        }
    }
    throw new Error(`element-web checkout not found (tried: ${candidates.join(", ")}). Set ELEMENT_WEB.`);
}

/** esbuild is a transitive dependency of vite, so it is in the pnpm store rather than hoisted. */
function findEsbuildPackage(repo) {
    const direct = join(repo, "node_modules/esbuild");
    if (existsSync(join(direct, "lib/main.js"))) return direct;
    const store = join(repo, "node_modules/.pnpm");
    if (existsSync(store)) {
        for (const entry of readdirSync(store)) {
            if (!entry.startsWith("esbuild@")) continue;
            const pkg = join(store, entry, "node_modules/esbuild");
            if (existsSync(join(pkg, "lib/main.js"))) return pkg;
        }
    }
    throw new Error("esbuild not found under the checkout's node_modules; run `pnpm install` there first.");
}

/**
 * Bundle the manager together with fake-indexeddb. `resolveDir` points at the manager's own
 * directory so bare specifiers resolve exactly as they do for the real module, and the plugin
 * redirects the four leaf modules that would otherwise drag in the whole application graph.
 */
export async function buildBundle(repo) {
    const outdir = join(HERE, ".build");
    mkdirSync(outdir, { recursive: true });
    const outfile = join(outdir, "bundle.mjs");
    const platformDir = join(repo, "apps/web/src/vector/platform");
    const stubs = join(HERE, "stubs");
    const esbuild = await import(pathToFileURL(join(findEsbuildPackage(repo), "lib/main.js")).href);

    const redirects = [
        [/^matrix-js-sdk\/src\/logger$/, join(stubs, "logger.mjs")],
        [/^matrix-js-sdk\/src\/matrix$/, join(stubs, "matrix.mjs")],
        [/(^|\/)PlatformPeg$/, join(stubs, "platform-peg.mjs")],
        [/(^|\/)settings\/SettingsStore$/, join(stubs, "settings-store.mjs")],
    ];

    await esbuild.build({
        stdin: {
            contents: ['import "fake-indexeddb/auto";', 'export * from "./BrowserEventIndexManager";', ""].join("\n"),
            resolveDir: platformDir,
            sourcefile: "perf-entry.ts",
            loader: "ts",
        },
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        outfile,
        logLevel: "error",
        // sanitize-html is CommonJS and reaches for node builtins through `require`, which an ESM
        // bundle has no binding for. esbuild's own shim defers to a `require` already in scope.
        banner: {
            js: ['import { createRequire as __perfCreateRequire } from "node:module";', "const require = __perfCreateRequire(import.meta.url);", ""].join("\n"),
        },
        plugins: [
            {
                name: "perf-stubs",
                setup(build) {
                    for (const [filter, path] of redirects) {
                        build.onResolve({ filter }, () => ({ path }));
                    }
                },
            },
        ],
    });
    return outfile;
}

/* ------------------------------------------------------------------ corpus */

// Legacy (--generator old) query terms, unchanged from the 2026-09-12 harness.
const MARKER = "zqmarker";
const FRAGMENT = OLD_FRAGMENT;

/* ----------------------------------------------------------------- measure */

const ms = (t) => `${t.toFixed(1)} ms`;
const now = () => Number(process.hrtime.bigint()) / 1e6;

async function timed(fn) {
    const start = now();
    const value = await fn();
    return { ms: now() - start, value };
}

const SEARCH = { before_limit: 0, after_limit: 0, order_by_recency: true, limit: 10 };

/** Run one query `queries` times and report total/per-query ms plus the hit count. */
async function measureQuery(manager, term, queries) {
    const r = await timed(async () => {
        let count = 0;
        for (let q = 0; q < queries; q++) {
            const res = await manager.searchEventIndex({ search_term: term, ...SEARCH });
            count = res.count;
        }
        return count;
    });
    return { totalMs: r.ms, perQueryMs: r.ms / queries, hits: r.value };
}

/** --generator old: byte-for-byte the 2026-09-12 harness (ascending ts, even rooms, thin shape, addEventToIndex). */
async function runLegacy(BrowserEventIndexManager, opts) {
    const corpus = generateCorpusOld(opts);
    const results = { generator: "old", events: opts.events, rooms: opts.rooms, queries: opts.queries };

    globalThis.__PERF_PICKLE_KEY__ = null;
    if (globalThis.gc) globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const cold = new BrowserEventIndexManager();
    await cold.initEventIndex("@perf:example.org", "PERFDEVICE");
    const build = await timed(async () => {
        for (const event of corpus) await cold.addEventToIndex(event, { displayname: "Perf" });
    });
    results.indexBuildMs = build.ms;
    results.heapAfterBuildMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

    const tokenSearch = await measureQuery(cold, MARKER, opts.queries);
    results.tokenSearchTotalMs = tokenSearch.totalMs;
    results.tokenSearchPerQueryMs = tokenSearch.perQueryMs;
    results.tokenSearchHits = tokenSearch.hits;

    const substring = await measureQuery(cold, FRAGMENT, opts.queries);
    results.substringTotalMs = substring.totalMs;
    results.substringPerQueryMs = substring.perQueryMs;
    results.substringHits = substring.hits;
    await cold.closeEventIndex();

    globalThis.__PERF_PICKLE_KEY__ = "perf-pickle-key";
    const writer = new BrowserEventIndexManager();
    await writer.initEventIndex("@perf:example.org", "PERFDEVICE");
    const persist = await timed(async () => {
        for (const event of corpus) await writer.addEventToIndex(event, { displayname: "Perf" });
        await writer.commitLiveEvents();
    });
    results.persistMs = persist.ms;
    results.storedBytes = (await writer.getStats()).size;
    await writer.closeEventIndex();

    const reader = new BrowserEventIndexManager();
    const warm = await timed(() => reader.initEventIndex("@perf:example.org", "PERFDEVICE"));
    results.warmStartMs = warm.ms;
    results.warmStartEvents = (await reader.getStats()).eventCount;
    await reader.closeEventIndex();

    results.maxRssMb = process.resourceUsage().maxRSS / 1024;
    return results;
}

/**
 * --generator new (default): all four corpus bias fixes, and ingest driven through `addHistoricEvents()` in
 * real crawl order (`crawlBatches()`) rather than the live-timeline `addEventToIndex()` API. See the module
 * docstring and corpus.mjs for what and why this changes relative to `runLegacy`.
 */
async function runNew(BrowserEventIndexManager, opts) {
    const corpus = generateCorpusNew({
        events: opts.events,
        rooms: opts.rooms,
        seed: opts.seed,
        zipfRoomExponent: opts.zipfRoomExponent,
    });
    const results = { generator: "new", events: opts.events, rooms: opts.rooms, queries: opts.queries, corpusStats: corpus.stats };

    // --- ingest, memory-only so nothing is encrypted on the way in; real crawl order via addHistoricEvents.
    globalThis.__PERF_PICKLE_KEY__ = null;
    if (globalThis.gc) globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const cold = new BrowserEventIndexManager();
    await cold.initEventIndex("@perf:example.org", "PERFDEVICE");
    const build = await timed(async () => {
        for (const batch of crawlBatches(corpus, NEW_DEFAULTS.eventsPerCrawl)) {
            await cold.addHistoricEvents(batch.events, batch.checkpoint, batch.oldCheckpoint);
        }
    });
    results.indexBuildMs = build.ms;
    results.heapAfterBuildMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

    const token = await measureQuery(cold, corpus.opts.markerToken, opts.queries);
    results.tokenSearchTotalMs = token.totalMs;
    results.tokenSearchPerQueryMs = token.perQueryMs;
    results.tokenSearchHits = token.hits;

    const prefix = await measureQuery(cold, corpus.opts.prefixQuery, opts.queries);
    results.prefixSearchTotalMs = prefix.totalMs;
    results.prefixSearchPerQueryMs = prefix.perQueryMs;
    results.prefixSearchHits = prefix.hits;

    const substring = await measureQuery(cold, corpus.opts.substringQuery, opts.queries);
    results.substringTotalMs = substring.totalMs;
    results.substringPerQueryMs = substring.perQueryMs;
    results.substringHits = substring.hits;

    const miss = await measureQuery(cold, corpus.opts.missQuery, opts.queries);
    results.missSearchTotalMs = miss.totalMs;
    results.missSearchPerQueryMs = miss.perQueryMs;
    results.missSearchHits = miss.hits;
    await cold.closeEventIndex();

    // --- warm start: persist the same corpus (same crawl-order batches), then time reading it back.
    globalThis.__PERF_PICKLE_KEY__ = "perf-pickle-key";
    const writer = new BrowserEventIndexManager();
    await writer.initEventIndex("@perf:example.org", "PERFDEVICE");
    const persist = await timed(async () => {
        for (const batch of crawlBatches(corpus, NEW_DEFAULTS.eventsPerCrawl)) {
            await writer.addHistoricEvents(batch.events, batch.checkpoint, batch.oldCheckpoint);
        }
        await writer.commitLiveEvents();
    });
    results.persistMs = persist.ms;
    results.storedBytes = (await writer.getStats()).size;
    await writer.closeEventIndex();

    const reader = new BrowserEventIndexManager();
    const warm = await timed(() => reader.initEventIndex("@perf:example.org", "PERFDEVICE"));
    results.warmStartMs = warm.ms;
    results.warmStartEvents = (await reader.getStats()).eventCount;
    await reader.closeEventIndex();

    results.maxRssMb = process.resourceUsage().maxRSS / 1024;
    return results;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const repo = findRepo();
    const bundle = await buildBundle(repo);
    const { BrowserEventIndexManager } = await import(pathToFileURL(bundle).href);

    const results = opts.generator === "old" ? await runLegacy(BrowserEventIndexManager, opts) : await runNew(BrowserEventIndexManager, opts);

    if (opts.json) {
        process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
        return;
    }

    const line = (label, value) => process.stdout.write(`  ${label.padEnd(34)}${value}\n`);
    process.stdout.write(`\nBrowserEventIndexManager perf [--generator ${results.generator}] - ${opts.events} events / ${opts.rooms} rooms\n\n`);
    if (results.corpusStats) {
        process.stdout.write(`  corpus: V=${results.corpusStats.vocabSize} largestRoomShare=${(results.corpusStats.largestRoomShare * 100).toFixed(1)}% accented=${results.corpusStats.accentedCount} cjk=${results.corpusStats.cjkCount} edits=${results.corpusStats.editCount} files=${results.corpusStats.fileCount}\n\n`);
    }
    line("index build (memory-only)", ms(results.indexBuildMs));
    line("index build + persist (AES-GCM)", ms(results.persistMs));
    line("warm start (initEventIndex)", `${ms(results.warmStartMs)}  (${results.warmStartEvents} events)`);
    line(
        `token search x${opts.queries}`,
        `${ms(results.tokenSearchTotalMs)}  (${ms(results.tokenSearchPerQueryMs)}/query, ${results.tokenSearchHits} hits)`,
    );
    if (results.prefixSearchTotalMs !== undefined) {
        line(
            `prefix search x${opts.queries}`,
            `${ms(results.prefixSearchTotalMs)}  (${ms(results.prefixSearchPerQueryMs)}/query, ${results.prefixSearchHits} hits)`,
        );
    }
    line(
        `substring fallback x${opts.queries}`,
        `${ms(results.substringTotalMs)}  (${ms(results.substringPerQueryMs)}/query, ${results.substringHits} hits)`,
    );
    if (results.missSearchTotalMs !== undefined) {
        line(
            `miss (no hits) x${opts.queries}`,
            `${ms(results.missSearchTotalMs)}  (${ms(results.missSearchPerQueryMs)}/query, ${results.missSearchHits} hits)`,
        );
    }
    line("heap growth over build", `${results.heapAfterBuildMb.toFixed(1)} MiB`);
    line("process maxRSS", `${results.maxRssMb.toFixed(1)} MiB`);
    line("ciphertext on disk", `${(results.storedBytes / 1024 / 1024).toFixed(2)} MiB`);
    process.stdout.write("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    await main();
}
