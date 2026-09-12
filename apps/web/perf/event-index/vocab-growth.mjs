#!/usr/bin/env node
/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/*
 * Vocabulary growth curve: distinct-token-count vs. total-token-count, walked through a corpus in
 * its natural generation order, using the REAL tokenize() from BrowserEventIndexManager.ts (not a
 * hand-rolled split), so the curve reflects exactly what the manager's inverted index would grow
 * to. Requested by the coordinator to make the "fixed-vocabulary Zipf generator cannot exhibit
 * Heaps' law" caveat (browser-limits-model.md §8) concrete: my corpus.mjs picks a target
 * vocabulary size V once, up front, via Heaps' law for the corpus's FINAL size, then Zipf-samples
 * from that fixed pool - it gets V right per size, but the within-corpus growth curve saturates
 * near V rather than following a smooth power law the way a real, ever-expanding chat vocabulary
 * does. This script measures that saturation directly rather than asserting it.
 *
 * Runs in Node (not the browser): tokenize() is a pure function of its input (fold + Unicode-aware
 * split), with no engine-dependent behaviour worth a browser run, so there is nothing a real
 * Chromium would show here that Node would not - this is a corpus/tokenizer property, not a
 * performance measurement.
 *
 * USAGE: node vocab-growth.mjs [--checkpoints 40]
 * Writes <out>/results/vocab-growth.json (see README.md for the out directory).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateCorpusOld, generateCorpusNew } from "./corpus.mjs";
import { findRepo, buildBundle } from "./event-index-perf.mjs";

const { join, resolve: resolvePath } = path;

const RESULTS_DIR = join(
    resolvePath(process.env.EVENT_INDEX_PERF_OUT ?? join(homedir(), ".cache", "element-web-event-index-perf")),
    "results",
);

function growthCurve(bodies, tokenize, checkpointCount) {
    const seen = new Set();
    let totalTokens = 0;
    const points = [];
    const checkpointEvery = Math.max(1, Math.floor(bodies.length / checkpointCount));
    for (let i = 0; i < bodies.length; i++) {
        for (const tok of tokenize(bodies[i])) {
            seen.add(tok);
            totalTokens++;
        }
        if ((i + 1) % checkpointEvery === 0 || i === bodies.length - 1) {
            points.push({ eventsProcessed: i + 1, totalTokens, distinctTokens: seen.size });
        }
    }
    return points;
}

/** Fit V = K * T^beta by log-log least squares over the curve's points (excluding T=0). */
function fitHeaps(points) {
    const xs = [];
    const ys = [];
    for (const p of points) {
        if (p.totalTokens > 0 && p.distinctTokens > 0) {
            xs.push(Math.log(p.totalTokens));
            ys.push(Math.log(p.distinctTokens));
        }
    }
    const n = xs.length;
    if (n < 2) return null;
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0,
        den = 0;
    for (let i = 0; i < n; i++) {
        num += (xs[i] - meanX) * (ys[i] - meanY);
        den += (xs[i] - meanX) ** 2;
    }
    const beta = den === 0 ? 0 : num / den;
    const logK = meanY - beta * meanX;
    return { K: Math.exp(logK), beta };
}

async function main() {
    const checkpoints = (() => {
        const idx = process.argv.indexOf("--checkpoints");
        return idx >= 0 ? Number(process.argv[idx + 1]) : 40;
    })();

    const repo = findRepo();
    const bundle = await buildBundle(repo);
    const { tokenize } = await import(pathToFileURL(bundle).href);

    const out = { checkpoints, runs: [] };

    for (const events of [20000, 50000, 100000, 200000]) {
        const rooms = Math.max(8, Math.round(events / 500));
        const corpus = generateCorpusNew({ events, rooms });
        const bodies = [];
        for (const roomEvents of corpus.plan) for (const ev of roomEvents) bodies.push(ev.content.body || "");
        const points = growthCurve(bodies, tokenize, checkpoints);
        const fit = fitHeaps(points);
        out.runs.push({
            generator: "new",
            events,
            rooms,
            finalDistinctTokens: points[points.length - 1]?.distinctTokens ?? 0,
            finalTotalTokens: points[points.length - 1]?.totalTokens ?? 0,
            configuredTargetVocab: corpus.stats.vocabSize,
            fittedHeaps: fit,
            points,
        });
        console.log(
            `new  n=${events}: final V=${points.at(-1)?.distinctTokens} / T=${points.at(-1)?.totalTokens}` +
                ` (configured target V=${corpus.stats.vocabSize}), fitted K=${fit?.K.toFixed(2)} beta=${fit?.beta.toFixed(3)}`,
        );
    }

    {
        const events = 20000;
        const rooms = 8;
        const corpus = generateCorpusOld({ events, rooms });
        const bodies = corpus.map((ev) => ev.content.body || "");
        const points = growthCurve(bodies, tokenize, checkpoints);
        const fit = fitHeaps(points);
        out.runs.push({
            generator: "old",
            events,
            rooms,
            finalDistinctTokens: points[points.length - 1]?.distinctTokens ?? 0,
            finalTotalTokens: points[points.length - 1]?.totalTokens ?? 0,
            configuredTargetVocab: null,
            fittedHeaps: fit,
            points,
        });
        console.log(
            `old  n=${events}: final V=${points.at(-1)?.distinctTokens} / T=${points.at(-1)?.totalTokens}` +
                `, fitted K=${fit?.K.toFixed(2)} beta=${fit?.beta.toFixed(3)}`,
        );
    }

    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, "vocab-growth.json"), JSON.stringify(out, null, 2));
    console.log(`Wrote ${join(RESULTS_DIR, "vocab-growth.json")}`);
}

void main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
