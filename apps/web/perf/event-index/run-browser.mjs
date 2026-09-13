#!/usr/bin/env node
/*
 * Part 2 runner: drives the real-Chromium harness (browser/) through Playwright, one size at a
 * time, sequentially, each in its own fresh persistent-context profile under
 * ~/.cache/eventindex-perf/profiles/ so restore is genuinely cold (a real process launch reading
 * a real on-disk IndexedDB, not just a page reload). NEVER writes to /tmp (RAM-backed tmpfs on
 * this box) - profiles, results and the served bundle all live under ~/.cache, real disk.
 *
 * Playwright/Chromium: uses playwright-core (already in the element-web checkout's node_modules)
 * against the Chromium build matching that exact playwright-core version's browsers.json
 * (revision 1228 = Chrome for Testing 149.0.7827.55), launched directly by executablePath so there
 * is no version-mismatch risk between the driver and the browser.
 *
 * Sequencing per size, matching the task's metric list:
 *   Phase A (ingest):  fresh context+page -> generateCorpusNew + crawlBatches() ->
 *                       addHistoricEvents() in real crawl order -> commitLiveEvents() drain.
 *                       Records ingest/persist-drain time and IndexedDB transaction counts.
 *                       Context closed (flushes IndexedDB to disk) before disk-size is read.
 *   (disk size read directly from the profile directory's IndexedDB backing store)
 *   Phase B (restore):  a SECOND, separate context launch against the SAME user-data-dir - a real
 *                       process start reading real on-disk state, not a same-process reload -
 *                       times initEventIndex() (IndexedDB read + decrypt + index build, split via
 *                       the instrumentation in page.template.html), captures long tasks >=50ms,
 *                       reads heap before/after, then runs the four query categories and reads
 *                       heap again.
 *
 * Resource gating: sizes strictly sequential, never parallel. 100k/200k are gated on
 * `~/bin/resource-guard.sh verdict` reporting GREEN immediately before that size's phase A; 20k/50k
 * always run (they are below the "above 50k" threshold the task sets for gating) but the verdict
 * is still logged for every size for a complete record.
 *
 * USAGE: node run-browser.mjs [--sizes 20000,50000,100000,200000] [--queries 20]
 *        [--engine chromium|firefox|webkit] [--throttle 4]
 *
 * --engine (cross-engine extension, Part 2): selects the Playwright BrowserType. Chromium keeps its original
 * explicit-executablePath behaviour (CHROMIUM_PATH below, chosen specifically so there is no driver/browser
 * version-mismatch risk — see the module docstring). Firefox/WebKit deliberately do NOT pin an explicit
 * executablePath: they were installed via `playwright install firefox webkit` against this exact
 * playwright-core version (see measurements-cross-engine.md §0), so Playwright's own registry resolution
 * already finds the matching-revision binary; WebKit in particular is not a single self-contained executable
 * (playwright-core launches it through its own driver/launcher script), so hand-constructing a path the way
 * CHROMIUM_PATH does is not a like-for-like option.
 *
 * --throttle N (Part 3, Chromium only): applies `Emulation.setCPUThrottlingRate` via a CDP session,
 * immediately after each phase's page is created and before any harness call — CDP sessions do not exist on
 * Firefox/WebKit (`newCDPSession` throws "only available in Chromium"), so this is refused with an explicit
 * error rather than silently ignored if passed with a non-Chromium engine.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = join(HERE, "profiles");
const RESULTS_DIR = join(HERE, "results");
const DIST_DIR = join(HERE, "browser", "dist");
const CHROMIUM_PATH = "/home/waldknoten-01/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"; // matches playwright-core@1.61.1's browsers.json revision 1228

mkdirSync(PROFILES_DIR, { recursive: true });
mkdirSync(RESULTS_DIR, { recursive: true });

/* ------------------------------------------------------------------ RSS-based memory (Part 2) */

/**
 * Coarse OS-level memory proxy for engines with no in-page JS-heap API (Firefox, WebKit — see
 * heapUsage()'s per-engine notes in harness-body.mjs and README.md's "what each metric measures"
 * section). Sums RSS (kB, from `ps`) across every process whose command line contains `profileDir`
 * — reliable across all three engines because Playwright always passes the user-data-dir as a
 * literal path argument to every process it spawns for that context (verified for Chromium,
 * Firefox and WebKit's multi-process launch, including WebKit's separate network process — see
 * measurements-cross-engine.md §0). This is deliberately NOT the manager's own JS heap: it is the
 * *whole browser engine's* resident memory (renderer + any helper processes), a strictly coarser
 * and higher number, reported as `rssBytes` alongside (never instead of) whatever heapUsage()
 * itself returns, and always labelled by source in the results/report — never conflated with the
 * Chromium `measureUserAgentSpecificMemory`/`performance.memory` figures it stands in for.
 */
function processTreeRssBytes(profileDir) {
    try {
        const out = execSync(`ps -eo pid,rss,args`, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
        let totalKb = 0;
        for (const line of out.split("\n")) {
            if (!line.includes(profileDir)) continue;
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+/);
            if (m) totalKb += Number(m[2]);
        }
        return totalKb * 1024;
    } catch {
        return null;
    }
}

const ENGINE_NAMES = ["chromium", "firefox", "webkit"];

function resolveElementWebRoot() {
    const root = process.env.ELEMENT_WEB || "/home/waldknoten-01/.cache/ew-pr34718/element-web";
    if (!existsSync(join(root, "apps/web/src/vector/platform/BrowserEventIndexManager.ts"))) {
        throw new Error(`ELEMENT_WEB (${root}) does not look like an element-web checkout`);
    }
    return root;
}

async function loadPlaywright(elementWebRoot) {
    const pwCorePath = join(elementWebRoot, "node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/index.mjs");
    return import(pathToFileURL(pwCorePath).href);
}

/** { browserType, launchOptions } for the named engine — see the module docstring for why only Chromium pins executablePath. */
function engineConfig(pw, engineName) {
    if (!ENGINE_NAMES.includes(engineName)) throw new Error(`--engine must be one of ${ENGINE_NAMES.join(", ")}, got ${engineName}`);
    if (engineName === "chromium") return { browserType: pw.chromium, launchOptions: { executablePath: CHROMIUM_PATH, headless: true, args: ["--no-sandbox"] } };
    if (engineName === "firefox") return { browserType: pw.firefox, launchOptions: { headless: true } };
    return { browserType: pw.webkit, launchOptions: { headless: true } };
}

function parseArgs(argv) {
    const opts = {
        sizes: [20000, 50000, 100000, 200000],
        queries: 20,
        nonblocking: false,
        accentedShare: undefined,
        profileTag: undefined,
        forceTier: undefined,
        engine: "chromium",
        throttle: undefined,
        vocabMode: undefined,
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--sizes") opts.sizes = argv[++i].split(",").map(Number);
        else if (argv[i] === "--queries") opts.queries = Number(argv[++i]);
        else if (argv[i] === "--nonblocking") opts.nonblocking = true;
        // Cross-engine extension, Part 2/3: --engine selects the Playwright BrowserType (see engineConfig());
        // --throttle N applies Emulation.setCPUThrottlingRate via CDP (Chromium only, refused otherwise).
        else if (argv[i] === "--engine") opts.engine = argv[++i];
        else if (argv[i] === "--throttle") opts.throttle = Number(argv[++i]);
        // Part 1: route the corpus generator to corpus.mjs's sustained-Heaps'-law streaming vocabulary
        // (buildStreamingVocabulary) instead of the default fixed-pool one. Passed straight through to
        // Corpus.generateCorpusNew's opts.
        else if (argv[i] === "--vocab-mode") opts.vocabMode = argv[++i];
        // Passed straight through to Corpus.generateCorpusNew's opts (corpus.mjs NEW_DEFAULTS.accentedShare
        // is 0.1); added for increment B's folded-text-on-demand proof, which needs a heap reading at a
        // raised accented-Latin share alongside the default corpus. profileTag keeps such a run's profile
        // directory (and result file) from colliding with a same-size default-corpus run.
        else if (argv[i] === "--accented-share") opts.accentedShare = Number(argv[++i]);
        else if (argv[i] === "--profile-tag") opts.profileTag = argv[++i];
        // Increment C proof: force EventIndexBounds' tier ("desktop"|"small") via
        // window.EventIndexHarness.setBoundsOverride(), re-applied at the start of BOTH phases --
        // page state (including this override) does not survive phase A's context closing and
        // phase B's separate process launch, so it must be set again on that fresh page too.
        else if (argv[i] === "--force-tier") opts.forceTier = argv[++i];
        // Increment C proof (C-F5): time runManifestMigration's one-time self-healing scan at real
        // scale. Ingests its own fresh corpus (this many events) into a dedicated profile, strips
        // the manifest back to "pre-manifest" (schema v2) shape, then times a restore against it --
        // all within this one process invocation, deliberately, because IndexedDB is partitioned by
        // origin (scheme+host+port) and startServer() binds an ephemeral port per invocation: a
        // profile ingested by a *separate* run-browser.mjs process is invisible from a later
        // invocation's different origin even though the same on-disk profile directory is named,
        // which is exactly the failure mode this comment exists to warn the next person off (it
        // cost this task one silently-empty measurement -- migrationMs 0.02ms, eventCount 0 -- to
        // discover; see measurements-pr-c.md's addendum).
        else if (argv[i] === "--migration-timing") opts.migrationTimingEvents = Number(argv[++i]);
        // review-pr-c.md C2-F3: time one commitLiveEvents() that re-encrypts a full manifest page,
        // against real IndexedDB/WebCrypto, in a fresh throwaway profile.
        else if (argv[i] === "--flush-cost") opts.flushCostPageSize = Number(argv[++i]);
    }
    return opts;
}

function resourceGuardVerdict() {
    try {
        const out = execFileSync("/home/waldknoten-01/bin/resource-guard.sh", ["verdict"], { encoding: "utf8" }).trim();
        const color = out.split(/\s+/)[0];
        return { raw: out, color };
    } catch (e) {
        return { raw: `error: ${e.message}`, color: "UNKNOWN" };
    }
}

/* ------------------------------------------------------------------ static server (real HTTP origin, not file://) */

const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

function startServer(dir) {
    return new Promise((resolvePromise) => {
        const server = createServer((req, res) => {
            const urlPath = req.url === "/" ? "/page.html" : req.url;
            const filePath = join(dir, urlPath);
            if (!existsSync(filePath)) {
                res.writeHead(404);
                res.end("not found");
                return;
            }
            const body = readFileSync(filePath);
            res.writeHead(200, {
                "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
                // COOP+COEP so performance.measureUserAgentSpecificMemory() can work; CORP on every
                // response since COEP:require-corp blocks same-origin subresources without it.
                "Cross-Origin-Opener-Policy": "same-origin",
                "Cross-Origin-Embedder-Policy": "require-corp",
                "Cross-Origin-Resource-Policy": "same-origin",
            });
            res.end(body);
        });
        server.listen(0, "127.0.0.1", () => resolvePromise(server));
    });
}

/* ------------------------------------------------------------------ disk size */

function du(dir) {
    if (!existsSync(dir)) return 0;
    try {
        const out = execFileSync("du", ["-sb", dir], { encoding: "utf8" });
        return Number(out.split(/\s+/)[0]);
    } catch {
        return -1;
    }
}

/*
 * Cross-engine extension, Part 2: IndexedDB backing-store directory naming differs per engine, discovered
 * by inspecting a real ingested profile of each (see measurements-cross-engine.md §0):
 *   - Chromium: `.../IndexedDB/...` (LevelDB) -- matched by the original `*indexeddb*` glob.
 *   - WebKit:   `.../storage/<hash>/<hash>/IndexedDB/<hash>/IndexedDB.sqlite3` -- also matched by that
 *     same glob (WebKit's own directory really is named "IndexedDB").
 *   - Firefox:  `.../storage/default/<origin>/idb/*.sqlite(-wal|-shm)?` and `.../idb/<n>.files/` -- NOT
 *     matched by `*indexeddb*` (the directory is literally named "idb", no "indexeddb" substring anywhere).
 *     Restricted to `storage/default/` specifically (never `storage/permanent/chrome`, which is Firefox's
 *     own internal browser-chrome IndexedDB usage, unrelated to the page under test and would silently
 *     inflate every Firefox measurement if included).
 */
function indexedDbDiskBytes(userDataDir) {
    try {
        const chromiumWebkitOut = execFileSync("find", [userDataDir, "-type", "d", "-iname", "*indexeddb*"], { encoding: "utf8" }).trim();
        const firefoxOut = execFileSync("find", [userDataDir, "-type", "d", "-path", "*/storage/default/*/idb"], { encoding: "utf8" }).trim();
        const dirs = [...chromiumWebkitOut.split("\n"), ...firefoxOut.split("\n")].filter(Boolean);
        if (dirs.length === 0) return 0;
        let total = 0;
        for (const dir of dirs) total += du(dir);
        return total;
    } catch {
        return -1;
    }
}

/* ------------------------------------------------------------------ one size, two phases */

const TIMEOUT_MS = 15 * 60 * 1000;

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runPhase(engineCfg, { userDataDir, baseUrl, label, run, throttle, engineName }) {
    const context = await engineCfg.browserType.launchPersistentContext(userDataDir, engineCfg.launchOptions);
    let crashed = false;
    let result;
    // BrowserEventIndexManager.hydrate()'s own field instrumentation (duration/count/longest-slice,
    // per SYNTHESIS.md's requirement that a real user's browser can be asked for these numbers) is a
    // log.info() call, which reaches this page's console -- capture it verbatim as a cross-check on
    // the PerformanceObserver longtask data above (which only ever reports tasks >= 50ms and so
    // cannot itself state an exact "longest task" figure when nothing crossed that floor).
    const consoleLines = [];
    try {
        const page = await context.newPage();
        page.on("crash", () => {
            crashed = true;
        });
        page.on("console", (msg) => {
            const text = msg.text();
            if (text.includes("hydration finished")) consoleLines.push(text);
        });
        // Part 3: CPU throttling, Chromium only -- applied before navigation so it covers page load too,
        // and definitely before any harness call. Not silently skipped for other engines: engineConfig()'s
        // caller (main()) already refuses --throttle for a non-Chromium --engine before we ever get here.
        if (throttle) {
            const cdp = await context.newCDPSession(page);
            await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
        }
        await page.goto(baseUrl, { waitUntil: "load" });
        await page.waitForFunction(() => window.__eventIndexHarnessReady === true, { timeout: 60000 });
        result = await withTimeout(run(page), TIMEOUT_MS, label);
    } catch (e) {
        result = { error: String(e && e.message ? e.message : e), crashed: crashed || /crash/i.test(String(e)) };
    } finally {
        try {
            await context.close();
        } catch {
            /* already gone if the renderer crashed */
        }
    }
    return { crashed, consoleLines, engine: engineName, ...result };
}

/**
 * Heap reading enriched with the RSS proxy (Part 2): always calls the page's own heapNow() (real JS-heap
 * bytes on Chromium via measureUserAgentSpecificMemory/performance.memory, `{method:"unavailable",
 * bytes:null}` on Firefox/WebKit — see harness-body.mjs), and ALWAYS also attaches processTreeRssBytes()
 * (never conditionally, so Chromium's two signals can be cross-checked against each other too, not just
 * used as an either/or per engine).
 */
async function heapNowWithRss(page, userDataDir) {
    const heap = await page.evaluate(() => window.EventIndexHarness.heapNow());
    const rssBytes = processTreeRssBytes(userDataDir);
    return { ...heap, rssBytes };
}

async function runSize(engineCfg, engineName, throttle, baseUrl, events, queries, nonblocking, accentedShare, profileTag, forceTier, vocabMode) {
    const rooms = Math.max(8, Math.round(events / 500));
    // A separate profile subdirectory for --nonblocking runs, so PR A's measurements never share
    // (and never overwrite) a profile with a same-size blocking-load run of the unmodified checkout.
    // profileTag does the same for any other corpus-option variant (e.g. --accented-share).
    const dirBase = nonblocking ? `nb-n${events}` : `n${events}`;
    const userDataDir = join(PROFILES_DIR, profileTag ? `${dirBase}-${profileTag}` : dirBase);
    rmSync(userDataDir, { recursive: true, force: true }); // each size starts from a clean profile

    const verdict = resourceGuardVerdict();
    console.log(`[n=${events}] resource-guard verdict: ${verdict.raw}`);
    if (events > 50000 && verdict.color !== "GREEN") {
        return { events, rooms, skipped: true, reason: `resource-guard not GREEN (${verdict.color})`, verdict: verdict.raw };
    }

    const corpusOpts = { events, rooms, ...(accentedShare !== undefined ? { accentedShare } : {}), ...(vocabMode ? { vocabMode } : {}) };
    console.log(
        `[n=${events}] engine=${engineName}${throttle ? ` throttle=${throttle}x` : ""} phase A: ingest + persist (rooms=${rooms})` +
            `${accentedShare !== undefined ? ` accentedShare=${accentedShare}` : ""}${forceTier ? ` forceTier=${forceTier}` : ""}${vocabMode ? ` vocabMode=${vocabMode}` : ""}`,
    );
    const ingest = await runPhase(engineCfg, {
        userDataDir,
        baseUrl,
        label: `ingest n=${events}`,
        throttle,
        engineName,
        run: async (page) => {
            if (forceTier) await page.evaluate((t) => window.EventIndexHarness.setBoundsOverride({ tier: t }), forceTier);
            return page.evaluate((opts) => window.EventIndexHarness.ingestAndPersist(opts), corpusOpts);
        },
    });

    const diskBytesAfterIngest = indexedDbDiskBytes(userDataDir);
    console.log(`[n=${events}] IndexedDB on-disk size after ingest: ${(diskBytesAfterIngest / 1024 / 1024).toFixed(2)} MiB`);

    if (ingest.crashed || ingest.error) {
        return { events, rooms, engine: engineName, throttle: throttle || null, verdict: verdict.raw, ingest, diskBytesAfterIngest };
    }

    console.log(`[n=${events}] phase B: cold restore + queries${nonblocking ? " (non-blocking load)" : ""}`);
    const restorePhase = await runPhase(engineCfg, {
        userDataDir,
        baseUrl,
        label: `restore n=${events}`,
        throttle,
        engineName,
        run: async (page) => {
            if (forceTier) await page.evaluate((t) => window.EventIndexHarness.setBoundsOverride({ tier: t }), forceTier);
            const heapEmptyPage = await heapNowWithRss(page, userDataDir);
            const restore = await page.evaluate((nb) => (nb ? window.EventIndexHarness.coldRestoreNonBlocking() : window.EventIndexHarness.coldRestore()), nonblocking);
            const heapAfterRestore = await heapNowWithRss(page, userDataDir);
            const queryResults = await page.evaluate((q) => window.EventIndexHarness.runQueries(q), { queries });
            const getStatsTiming = await page.evaluate(() => window.EventIndexHarness.getStatsTiming({ calls: 2000 }));
            const heapAfterQueries = await heapNowWithRss(page, userDataDir);
            await page.evaluate(() => window.EventIndexHarness.closeRestored());
            return { heapEmptyPage, restore, heapAfterRestore, queries: queryResults, getStatsTiming, heapAfterQueries };
        },
    });

    return { events, rooms, engine: engineName, throttle: throttle || null, verdict: verdict.raw, ingest, diskBytesAfterIngest, restorePhase };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.throttle && opts.engine !== "chromium") {
        throw new Error(`--throttle is Chromium-only (CDP sessions do not exist on ${opts.engine}); got --engine ${opts.engine} --throttle ${opts.throttle}`);
    }

    const elementWebRoot = resolveElementWebRoot();
    const pw = await loadPlaywright(elementWebRoot);
    const chromiumCfg = engineConfig(pw, "chromium"); // flush-cost/migration-timing modes below are Chromium-only, unaffected by --engine
    const selectedCfg = engineConfig(pw, opts.engine);

    const server = await startServer(DIST_DIR);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/page.html`;
    console.log(`Serving ${DIST_DIR} at ${baseUrl}`);

    if (opts.flushCostPageSize) {
        const pageSize = opts.flushCostPageSize;
        const userDataDir = join(PROFILES_DIR, `flush-cost-n${pageSize}`);
        rmSync(userDataDir, { recursive: true, force: true });
        console.log(`[flush-cost] timing one commitLiveEvents() touching a full ${pageSize}-entry manifest page`);
        const result = await runPhase(chromiumCfg, {
        engineName: "chromium",
            userDataDir,
            baseUrl,
            label: "flush cost",
            run: async (page) => page.evaluate((ps) => window.EventIndexHarness.measureManifestFlushCost({ pageSize: ps }), pageSize),
        });
        writeFileSync(join(RESULTS_DIR, `flush-cost-n${pageSize}.json`), JSON.stringify(result, null, 2));
        console.log(`[flush-cost] done. pageSize=${result.pageSize} flushMs=${result.flushMs?.toFixed(2)}`);
        server.close();
        return;
    }

    if (opts.migrationTimingEvents) {
        const events = opts.migrationTimingEvents;
        const rooms = Math.max(8, Math.round(events / 500));
        const userDataDir = join(PROFILES_DIR, `migration-timing-n${events}`);
        rmSync(userDataDir, { recursive: true, force: true });

        const verdict = resourceGuardVerdict();
        console.log(`[migration-timing] resource-guard verdict: ${verdict.raw}`);
        if (events > 50000 && verdict.color !== "GREEN") {
            console.log(`[migration-timing] SKIPPED: resource-guard not GREEN (${verdict.color})`);
            server.close();
            return;
        }

        console.log(`[migration-timing] phase A: fresh ingest (n=${events}, rooms=${rooms}), same origin as the phases below`);
        const ingest = await runPhase(chromiumCfg, {
        engineName: "chromium",
            userDataDir,
            baseUrl,
            label: `migration-timing ingest n=${events}`,
            run: async (page) => page.evaluate((opts) => window.EventIndexHarness.ingestAndPersist(opts), { events, rooms }),
        });
        if (ingest.crashed || ingest.error) {
            console.log(`[migration-timing] INGEST FAILED/CRASHED: ${JSON.stringify(ingest)}`);
            server.close();
            return;
        }

        console.log(`[migration-timing] phase B: stripping the manifest back to pre-manifest (schema v2) shape`);
        const strip = await runPhase(chromiumCfg, {
        engineName: "chromium",
            userDataDir,
            baseUrl,
            label: "strip manifest",
            run: async (page) => page.evaluate(() => window.EventIndexHarness.stripManifestForMigrationTest()),
        });
        if (strip.crashed || strip.error) {
            console.log(`[migration-timing] STRIP FAILED/CRASHED: ${JSON.stringify(strip)}`);
            server.close();
            return;
        }

        console.log(`[migration-timing] phase C: timed restore (runManifestMigration) against the stripped profile`);
        const result = await runPhase(chromiumCfg, {
        engineName: "chromium",
            userDataDir,
            baseUrl,
            label: "migration timing restore",
            run: async (page) => {
                const restore = await page.evaluate(() => window.EventIndexHarness.coldRestoreWithMigrationTiming());
                return { restore };
            },
        });
        writeFileSync(join(RESULTS_DIR, `migration-timing-n${events}.json`), JSON.stringify({ ingest, result }, null, 2));
        console.log(
            `[migration-timing] done. initMs=${result.restore?.initMs?.toFixed(1)} ` +
                `migrationMs=${result.restore?.migrationMs?.toFixed(1)} ` +
                `eventCountAfterMigration=${result.restore?.indexStatsAfterMigration?.eventCount} ` +
                `sizeAfterMigration=${result.restore?.indexStatsAfterMigration?.size} ` +
                `oldestIndexedTsAfterMigration=${result.restore?.indexStatsAfterMigration?.oldestIndexedTs} ` +
                `hydrationMs=${result.restore?.hydrationMs?.toFixed(1)}`,
        );
        server.close();
        return;
    }

    const prefix = opts.nonblocking ? "browser-nonblocking" : "browser";
    const engineTag = opts.engine !== "chromium" ? `-${opts.engine}` : "";
    const throttleTag = opts.throttle ? `-throttle${opts.throttle}x` : "";
    const fileTag = (opts.profileTag ? `-${opts.profileTag}` : "") + engineTag + throttleTag;
    const allResults = [];
    for (const events of opts.sizes) {
        console.log(
            `\n=== n=${events} engine=${opts.engine}${opts.throttle ? ` throttle=${opts.throttle}x` : ""}${opts.nonblocking ? " [non-blocking load]" : ""}${opts.profileTag ? ` [${opts.profileTag}]` : ""} ===`,
        );
        const result = await runSize(
            selectedCfg,
            opts.engine,
            opts.throttle,
            baseUrl,
            events,
            opts.queries,
            opts.nonblocking,
            opts.accentedShare,
            opts.profileTag ? `${opts.profileTag}${engineTag}${throttleTag}` : opts.profileTag,
            opts.forceTier,
            opts.vocabMode,
        );
        allResults.push(result);
        writeFileSync(join(RESULTS_DIR, `${prefix}-n${events}${fileTag}.json`), JSON.stringify(result, null, 2));
        if (result.skipped) console.log(`[n=${events}] SKIPPED: ${result.reason}`);
        else if (result.ingest?.crashed || result.ingest?.error) console.log(`[n=${events}] INGEST FAILED/CRASHED: ${JSON.stringify(result.ingest)}`);
        else if (opts.nonblocking) {
            const r = result.restorePhase?.restore;
            const mt = r?.manifestTiming;
            const emptyHeap = result.restorePhase?.heapEmptyPage;
            const afterHeap = result.restorePhase?.heapAfterRestore;
            const emptyBytes = emptyHeap?.bytes;
            const manifestBytesPerEvent =
                mt && typeof mt.heapAfterManifest?.bytes === "number" && typeof emptyBytes === "number"
                    ? (mt.heapAfterManifest.bytes - emptyBytes) / events
                    : undefined;
            const heapBytesPerEvent = typeof afterHeap?.bytes === "number" && typeof emptyBytes === "number" ? (afterHeap.bytes - emptyBytes) / events : undefined;
            const rssBytesPerEvent = typeof afterHeap?.rssBytes === "number" && typeof emptyHeap?.rssBytes === "number" ? (afterHeap.rssBytes - emptyHeap.rssBytes) / events : undefined;
            console.log(
                `[n=${events}] done. initMs=${r?.initMs?.toFixed(1)} ` +
                    `manifestMs=${mt?.manifestMs?.toFixed(1)} ` +
                    `manifestBytesPerEvent=${manifestBytesPerEvent?.toFixed(1)} ` +
                    `totalHydrationMs=${r?.totalMs?.toFixed(1)} ` +
                    `midQueryError=${r?.midQueryError} ` +
                    `heapMethod=${afterHeap?.method} heapBytesPerEvent=${heapBytesPerEvent?.toFixed(1)} ` +
                    `rssBytesPerEvent=${rssBytesPerEvent?.toFixed(1)}`,
            );
            // review-pr-c.md C2-F1: every long task during load, attributed to the phase it fell
            // in (init/manifest/hydration/after-hydration) -- never an unattributed bare count.
            // Chromium only (PerformanceObserver longtask is unsupported on Firefox/WebKit -- see
            // page.template.html's try/catch and README.md's per-engine notes); the watchdog span
            // below is the cross-engine upper-bound substitute (Part 2).
            const longTasks = r?.longTasksAttributed ?? [];
            if (longTasks.length === 0) {
                console.log(`[n=${events}] load long tasks (>=50ms): none${r?.longTaskUnsupported ? " (API unsupported on this engine)" : ""}`);
            } else {
                for (const t of longTasks) {
                    console.log(
                        `[n=${events}] load long task: phase=${t.phase} sinceConstructionMs=${t.sinceConstructionMs.toFixed(1)} durationMs=${t.duration.toFixed(1)}`,
                    );
                }
            }
            if (r?.spanWatchdog) {
                console.log(
                    `[n=${events}] longest synchronous span (watchdog upper bound): ${r.spanWatchdog.maxGapMs?.toFixed(1)}ms over ${r.spanWatchdog.sampleCount} samples`,
                );
            }
        } else console.log(`[n=${events}] done. ingestMs=${result.ingest.ingestMs?.toFixed(1)} restoreMs=${result.restorePhase?.restore?.restoreMs?.toFixed(1)}`);
    }

    writeFileSync(join(RESULTS_DIR, `${prefix}-all${fileTag}.json`), JSON.stringify(allResults, null, 2));
    server.close();
    console.log(`\nAll sizes done. Results in results/${prefix}-n*${fileTag}.json and results/${prefix}-all${fileTag}.json`);
}

await main();
