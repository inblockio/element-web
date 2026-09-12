#!/usr/bin/env node
/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/*
 * Part 2 runner: drives the real-Chromium harness (browser/) through Playwright, one size at a
 * time, sequentially, each in its own fresh persistent-context profile under the out directory
 * (see OUT_DIR below) so restore is genuinely cold (a real process launch reading a real on-disk
 * IndexedDB, not just a page reload). Profiles, results and the served bundle all live outside the
 * repository and never in /tmp, which is RAM-backed on some machines.
 *
 * Playwright/Chromium: uses the checkout's own playwright-core and the browser it has installed
 * (`chromium.executablePath()`), launched directly by executablePath so the driver and the browser
 * can never be a version apart. Run `pnpm exec playwright install chromium` in the checkout first
 * if no browser is installed. The published numbers were taken with playwright-core 1.61.1 and
 * Chrome for Testing 149.0.7827.55 (registry revision 1228).
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
 *        (run `node browser/build.mjs` first; see README.md)
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { dirname, extname, join, resolve: resolvePath } = path;

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/web/perf/event-index -> the repository root. The manager under test is always this checkout's.
const REPO = resolvePath(HERE, "../../../..");
// Where esbuild, playwright-core and the installed browsers are looked up: normally this same
// checkout after `pnpm install`, but a git worktree has no install of its own, so point
// EVENT_INDEX_PERF_TOOLING at a checkout that has one.
const TOOLING = resolvePath(process.env.EVENT_INDEX_PERF_TOOLING ?? REPO);
// Profiles, results and the built bundle stay out of the repository, and out of /tmp.
const OUT_DIR = resolvePath(
    process.env.EVENT_INDEX_PERF_OUT ?? join(homedir(), ".cache", "element-web-event-index-perf"),
);
const PROFILES_DIR = join(OUT_DIR, "profiles");
const RESULTS_DIR = join(OUT_DIR, "results");
const DIST_DIR = join(OUT_DIR, "dist");

mkdirSync(PROFILES_DIR, { recursive: true });
mkdirSync(RESULTS_DIR, { recursive: true });

/**
 * The checkout's own playwright-core, and the Chromium it has installed. Resolved from
 * apps/web/package.json because that is the workspace that depends on Playwright.
 */
async function loadPlaywright() {
    const require = createRequire(join(TOOLING, "apps/web/package.json"));
    let entry;
    try {
        entry = require.resolve("playwright-core");
    } catch {
        throw new Error(
            `playwright-core not found under ${TOOLING}. Run \`pnpm install\` there, or set EVENT_INDEX_PERF_TOOLING to a checkout that has one.`,
        );
    }
    const esm = entry.replace(/index\.js$/, "index.mjs");
    const mod = await import(pathToFileURL(existsSync(esm) ? esm : entry).href);
    const chromium = mod.chromium ?? mod.default?.chromium;
    const executablePath = process.env.EVENT_INDEX_PERF_CHROMIUM ?? chromium.executablePath();
    if (!existsSync(executablePath)) {
        throw new Error(
            `Chromium not installed at ${executablePath}. Run \`pnpm exec playwright install chromium\` in ${TOOLING}.`,
        );
    }
    return { chromium, executablePath };
}

function parseArgs(argv) {
    const opts = { sizes: [20000, 50000, 100000, 200000], queries: 20 };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--sizes") opts.sizes = argv[++i].split(",").map(Number);
        else if (argv[i] === "--queries") opts.queries = Number(argv[++i]);
    }
    return opts;
}

// Optional memory-headroom gate: a script that prints a verdict word (GREEN / AMBER / RED) first.
// Absent on most machines, in which case the large sizes simply run.
const RESOURCE_GUARD = process.env.EVENT_INDEX_PERF_GUARD ?? join(homedir(), "bin", "resource-guard.sh");

function resourceGuardVerdict() {
    if (!existsSync(RESOURCE_GUARD)) return { raw: "no resource guard configured", color: "GREEN" };
    try {
        const out = execFileSync(RESOURCE_GUARD, ["verdict"], { encoding: "utf8" }).trim();
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

function indexedDbDiskBytes(userDataDir) {
    try {
        const out = execFileSync("find", [userDataDir, "-type", "d", "-iname", "*indexeddb*"], {
            encoding: "utf8",
        }).trim();
        if (!out) return 0;
        let total = 0;
        for (const dir of out.split("\n").filter(Boolean)) total += du(dir);
        return total;
    } catch {
        return -1;
    }
}

/* ------------------------------------------------------------------ one size, two phases */

let CHROMIUM_EXECUTABLE; // set by main() from loadPlaywright()
const TIMEOUT_MS = 15 * 60 * 1000;

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runPhase(chromium, { userDataDir, baseUrl, label, run }) {
    const context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: CHROMIUM_EXECUTABLE,
        headless: true,
        args: ["--no-sandbox"], // WSL2 container-adjacent environment; no other flags needed for these measurements
    });
    let crashed = false;
    let result;
    try {
        const page = await context.newPage();
        page.on("crash", () => {
            crashed = true;
        });
        await page.goto(baseUrl, { waitUntil: "load" });
        await page.waitForFunction(() => window.__eventIndexHarnessReady === true, { timeout: 30000 });
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
    return { crashed, ...result };
}

async function runSize(chromium, baseUrl, events, queries) {
    const rooms = Math.max(8, Math.round(events / 500));
    const userDataDir = join(PROFILES_DIR, `n${events}`);
    rmSync(userDataDir, { recursive: true, force: true }); // each size starts from a clean profile

    const verdict = resourceGuardVerdict();
    console.log(`[n=${events}] resource-guard verdict: ${verdict.raw}`);
    if (events > 50000 && verdict.color !== "GREEN") {
        return {
            events,
            rooms,
            skipped: true,
            reason: `resource-guard not GREEN (${verdict.color})`,
            verdict: verdict.raw,
        };
    }

    console.log(`[n=${events}] phase A: ingest + persist (rooms=${rooms})`);
    const ingest = await runPhase(chromium, {
        userDataDir,
        baseUrl,
        label: `ingest n=${events}`,
        run: (page) => page.evaluate((opts) => window.EventIndexHarness.ingestAndPersist(opts), { events, rooms }),
    });

    const diskBytesAfterIngest = indexedDbDiskBytes(userDataDir);
    console.log(
        `[n=${events}] IndexedDB on-disk size after ingest: ${(diskBytesAfterIngest / 1024 / 1024).toFixed(2)} MiB`,
    );

    if (ingest.crashed || ingest.error) {
        return { events, rooms, verdict: verdict.raw, ingest, diskBytesAfterIngest };
    }

    console.log(`[n=${events}] phase B: cold restore + queries`);
    const restorePhase = await runPhase(chromium, {
        userDataDir,
        baseUrl,
        label: `restore n=${events}`,
        run: async (page) => {
            const heapEmptyPage = await page.evaluate(() => window.EventIndexHarness.heapNow());
            const restore = await page.evaluate(() => window.EventIndexHarness.coldRestore());
            const heapAfterRestore = await page.evaluate(() => window.EventIndexHarness.heapNow());
            const queryResults = await page.evaluate((q) => window.EventIndexHarness.runQueries(q), { queries });
            const heapAfterQueries = await page.evaluate(() => window.EventIndexHarness.heapNow());
            await page.evaluate(() => window.EventIndexHarness.closeRestored());
            return { heapEmptyPage, restore, heapAfterRestore, queries: queryResults, heapAfterQueries };
        },
    });

    return { events, rooms, verdict: verdict.raw, ingest, diskBytesAfterIngest, restorePhase };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    const { chromium, executablePath } = await loadPlaywright();
    CHROMIUM_EXECUTABLE = executablePath;
    console.log(`Chromium: ${executablePath}`);

    if (!existsSync(join(DIST_DIR, "page.html"))) {
        throw new Error(`No built bundle at ${DIST_DIR}. Run \`node browser/build.mjs\` first.`);
    }
    const server = await startServer(DIST_DIR);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/page.html`;
    console.log(`Serving ${DIST_DIR} at ${baseUrl}`);

    const allResults = [];
    for (const events of opts.sizes) {
        console.log(`\n=== n=${events} ===`);
        const result = await runSize(chromium, baseUrl, events, opts.queries);
        allResults.push(result);
        writeFileSync(join(RESULTS_DIR, `browser-n${events}.json`), JSON.stringify(result, null, 2));
        if (result.skipped) console.log(`[n=${events}] SKIPPED: ${result.reason}`);
        else if (result.ingest?.crashed || result.ingest?.error)
            console.log(`[n=${events}] INGEST FAILED/CRASHED: ${JSON.stringify(result.ingest)}`);
        else
            console.log(
                `[n=${events}] done. ingestMs=${result.ingest.ingestMs?.toFixed(1)} restoreMs=${result.restorePhase?.restore?.restoreMs?.toFixed(1)}`,
            );
    }

    writeFileSync(join(RESULTS_DIR, "browser-all.json"), JSON.stringify(allResults, null, 2));
    server.close();
    console.log(`\nAll sizes done. Results in ${RESULTS_DIR}/browser-n*.json and browser-all.json`);
}

void main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
