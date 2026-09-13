# EventIndex perf harness

## 2026-09-13 update: cross-engine, CPU-throttled and sustained-Heaps'-law runs

This commit does two things at once, because splitting them would leave this branch's harness in a
non-functional intermediate state:

1. **Catches this branch up** to the private `~/.cache/eventindex-perf-*` lineage that PR B/C/D
   measurement sessions accumulated but never committed back here (manifest/migration timing,
   flush-cost measurement, `--force-tier`, the non-blocking-load `coldRestoreNonBlocking()` path,
   and `page.template.html`'s expanded instrumentation - `getAllKeys` timing, encrypt timing).
   Without this, the additions below would not even parse against what was here before (e.g. the
   new watchdog code is wired into `coldRestoreNonBlocking()`, which this branch didn't have yet).
2. **Adds the three validation-plan items** the design document's own methodology section named as
   missing (a Heaps'-law-sustaining corpus generator, Firefox/WebKit support, a CPU-throttled
   Chromium mode): `corpus.mjs`'s `buildStreamingVocabulary()` (a streaming Pitman-Yor process,
   opt-in via `vocabMode: "sustained"`, default unchanged), `run-browser.mjs`'s
   `--engine chromium|firefox|webkit` and `--throttle N` (Chromium-only CDP
   `Emulation.setCPUThrottlingRate`), an OS-level RSS proxy (`processTreeRssBytes()`) for the two
   engines with no in-page JS-heap API, an IndexedDB-disk-size fix for Firefox's `storage/default/
   */idb` layout, and `browser/harness-body.mjs`'s `startSpanWatchdog()` (a cross-engine
   longest-synchronous-span upper bound, since the Long Tasks API is Chromium-only). Full
   methodology, results and caveats (WebKit-on-Linux vs. Safari, RSS noise at small `n`, Firefox's
   Long Tasks observer silently no-oping instead of throwing): `research/measurements-cross-engine.md`
   in the `2026-09-12-element-web-eventindex` handover. A full, runnable copy of this same harness
   state also lives there under `perf/v2/cross-engine/` for anyone without access to this branch.

Everything below this point is the pre-existing README, describing the harness as of the PR-A/B
proof pass; it has not been rewritten for the additions above except where it stated something
now false (the "Not attempted" list's multi-engine/throttling bullet).

---

Performance measurement tooling for `apps/web/src/vector/platform/BrowserEventIndexManager.ts`
(element-web PR [#34718](https://github.com/element-hq/element-web/pull/34718)). It measures the
manager **as checked out**, unmodified: the harness bundles it, drives it, and never patches it.

The design document these numbers belong to is [`docs/web-event-index.md`](../../../../docs/web-event-index.md)
on the `feat/web-event-index` branch. Its §5 (methodology, limitations, results) is the reader-facing
version of this README; the results table is reproduced below so this directory stands alone.

This is developer tooling, not application code: it is not built, not bundled, not imported by the app
and not run by CI. It lives on its own branch for that reason, and it is excluded from knip's file graph
by `"!perf/**"` in `knip.ts`'s `apps/web` `project` list.

Two harnesses live here:

1. **`browser/` + `run-browser.mjs`** - a Playwright runner that loads the real, unmodified
   `BrowserEventIndexManager.ts` into a real headless Chromium page, so IndexedDB and WebCrypto are the
   genuine engine implementations. **This is the trustworthy one**, and its output is the results table
   below.
2. **`event-index-perf.mjs`** - a Node + fake-indexeddb harness over the same corpus generator
   (`corpus.mjs`). Fast, useful for quick before/after checks and for the old-vs-new corpus bias
   comparison, but **fake-indexeddb and Node's WebCrypto are not the real thing**: Node is also built
   without pointer compression, so its heap figures overstate Chrome's by 1.4x to 1.7x. Do not cite
   absolute numbers from this harness as browser numbers.

## What changed and why (read before comparing to old numbers)

An earlier version of this harness measured a best case in four ways. `corpus.mjs` fixes all four; see
its module docstring for the full reasoning and the exact line references into
`BrowserEventIndexManager.ts` and `EventIndex.ts`.

1. **Real crawl order.** Events are generated per room, oldest-to-newest, then delivered
   newest-first in batches of 100 (`EVENTS_PER_CRAWL`), rooms visited round-robin - exactly what
   `EventIndex.ts`'s crawler does - via `crawlBatches()` + `addHistoricEvents()`, instead of an
   ascending-timestamp array fed through the live-timeline `addEventToIndex()` API. **This is a
   change to what is measured, not just to the corpus**: `addEventToIndex()` never exercises the
   backward-insert cost that `addHistoricEvents()`'s real callers do.
2. **Zipfian room sizes** (`planRoomSizes()`, default exponent 1.0) instead of an even split.
3. **The real encrypted-event shape**: `curve25519Key`, `ed25519Key`, `algorithm`,
   `forwardingCurve25519KeyChain` on top of `unsigned` - the exact fields `EventIndex.ts`'s
   `eventToJson()` adds for an encrypted event. Note that the wire-content fields
   (`sender_key`/`session_id`/`device_id`) are already stripped by the time an event reaches the index,
   so those are deliberately not in the corpus.
4. **Realistic vocabulary and text**: Heaps'-law-sized vocabulary (`buildVocabulary()`), Zipfian
   word frequency, a lognormal message-length distribution (median ~10 words, long tail), and
   configurable accented-Latin (default 10%) and CJK (default 5%) message shares.

Beyond the four required fixes, `corpus.mjs` also adds (all at modest default rates, all
documented in `NEW_DEFAULTS`, all quick to disable via the constructor options): message edits
(2%), file attachments (3%), and reply relations (5%) - because these are real shapes the manager
stores, they cost little to add, and they exercise code paths (`effectiveEventForIndex`,
`eventHasFile`) the old corpus never touched. **Redactions are not
modeled** - out of scope for a corpus-bias fix, left as a named gap rather than added speculatively.

The old generator (`generateCorpusOld()`) is preserved byte-for-byte and remains selectable
(`--generator old`) specifically so the bias fix itself can be measured, not just asserted. The largest
effect is on the write path: real crawl order plus concentrated rooms costs +237% on persist at 20k, while restore
barely moves (+8.5%), because `loadAllForUser` appends in key order and sorts each room once at the end.

**Known limitation, stated rather than fixed:** `corpus.mjs` picks one target vocabulary size `V`
via Heaps' law for the corpus's _final_ size, then Zipf-samples every message from that fixed pool.
That gets `V` right _across_ runs of different sizes, but a fixed-pool Zipf sampler cannot exhibit
Heaps'-law growth _within_ one run - it saturates near its target `V` once total tokens exceed a
few multiples of it, rather than following a smooth unbounded power law the way a real,
ever-expanding chat vocabulary does. `vocab-growth.mjs` measures this directly (see the results below) rather than leaving it as an
assumption.

## Layout

```
corpus.mjs                 - the corpus generator, platform-neutral (no Node built-ins),
                              used by both the Node harness and the browser bundle.
event-index-perf.mjs       - Node + fake-indexeddb harness. --generator old|new (default new).
vocab-growth.mjs           - distinct-token-count vs. total-token-count curves, old vs. new
                              generator, using the real tokenize() from BrowserEventIndexManager.ts.
stubs/                     - leaf-module stubs so esbuild can bundle the manager without dragging
                              in the whole app graph. matrix.mjs (Node, Buffer-based) and
                              matrix.browser.mjs (browser, btoa/atob-based) are separate because
                              Buffer does not exist in a real page.
browser/
  build.mjs                - esbuild bundle: BrowserEventIndexManager.ts + corpus.mjs +
                              harness-body.mjs -> <out>/dist/bundle.js (one self-contained ESM
                              file), plus <out>/dist/page.html (copied from page.template.html).
  harness-body.mjs         - appended into the bundle; exposes window.EventIndexHarness, called
                              from Node via page.evaluate().
  page.template.html       - the static page: an inline classic <script> installs instrumentation
                              (IndexedDB transaction counting, decrypt/read timing, PerformanceObserver
                              for long tasks) BEFORE the module bundle loads, then loads bundle.js.
run-browser.mjs            - the runner: Playwright + real Chromium, one size at a time.
```

## Running it

Requirements: a checkout with `pnpm install` done, and a Chromium installed for its Playwright
(`pnpm exec playwright install chromium`). The runner resolves both from the checkout it lives in, so
the driver and the browser can never be a version apart. Nothing is read from a hard-coded path, and
nothing is written into the repository.

```sh
cd apps/web/perf/event-index

# bundle the unmodified manager + corpus generator + harness body into one page
node browser/build.mjs

# the real-Chromium sweep: sizes run sequentially, one browser at a time, never in parallel
node run-browser.mjs --sizes 20000,50000,100000,200000 --queries 20

# vocabulary growth curve (Node; a pure corpus/tokenizer property, no browser needed)
node vocab-growth.mjs --checkpoints 30

# Node + fake-indexeddb harness (a floor, not a browser number)
node event-index-perf.mjs --events 20000 --rooms 40 --queries 20 --generator new --json
```

`--generator old` reproduces the pre-fix harness exactly (see `corpus.mjs`'s `generateCorpusOld`);
`--seed` and `--zipf-room-exponent` are also exposed for the new generator.

Output locations, all outside the repository and never under `/tmp` (which is RAM-backed on some
machines):

| Path                                                      | Contents                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `~/.cache/element-web-event-index-perf/dist/`             | `bundle.js` + `page.html`, served by the runner's own static HTTP server |
| `~/.cache/element-web-event-index-perf/profiles/n<size>/` | one persistent Chromium user-data-dir per size                           |
| `~/.cache/element-web-event-index-perf/results/`          | `browser-n<size>.json`, `browser-all.json`, `vocab-growth.json`          |

Environment variables, all optional:

| Variable                    | Effect                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVENT_INDEX_PERF_OUT`      | move the three directories above somewhere else                                                                                                                                                               |
| `EVENT_INDEX_PERF_TOOLING`  | the checkout whose `node_modules` provide esbuild, playwright-core and the installed browsers. Needed when running from a **git worktree**, which has no install of its own: point it at a checkout that does |
| `EVENT_INDEX_PERF_CHROMIUM` | use a specific Chromium binary instead of `chromium.executablePath()`                                                                                                                                         |
| `EVENT_INDEX_PERF_GUARD`    | path to a memory-headroom script printing `GREEN`/`AMBER`/`RED` first; sizes above 50k are skipped when it is not GREEN. Absent means no gating                                                               |
| `ELEMENT_WEB`               | measure the manager from a different checkout than the one this file lives in                                                                                                                                 |

Each size gets a fresh profile and runs in two separate Chromium process launches against it: phase A
(ingest through `addHistoricEvents()` in real crawl order, then `commitLiveEvents()` to drain the write
queue) and phase B (a **second, separate** browser process, not a page reload, which is what makes phase
B's `initEventIndex()` a genuinely cold restore of real on-disk state; it also runs the four query
categories and reads the heap before and after).

A 200k run writes about 500 MB of profile and spends minutes writing continuously, so run the large
sizes when the machine is quiet. To re-run only those, pass `--sizes 100000,200000`.

## Results (Chromium 149, one fast desktop)

Chrome for Testing 149.0.7827.55, headless, WSL2 on Linux x86_64, 12 cores, 47 GiB RAM. Corpus:
`rooms = max(8, round(events/500))`, `eventsPerCrawl` 100, Zipf room exponent 1.0, Heaps' K 21 and beta
0.55, word Zipf exponent 1.05, median message 10 words, 10% accented Latin, 5% CJK, 2% edits, 3% files,
5% replies. `records` is below the requested size because edits update a record instead of adding one.

| Requested | Records | Ingest (ms) | Persist drain (ms) | IDB tx ingest / drain | Cold restore (ms) | Disk after ingest (MiB) |
| --------- | ------- | ----------- | ------------------ | --------------------- | ----------------- | ----------------------- |
| 20,000    | 19,598  | 493         | 40,127             | 1 / 20,399            | 1,460             | 87.9                    |
| 50,000    | 48,956  | 457         | 93,355             | 1 / 51,013            | 3,330             | 156.8                   |
| 100,000   | 97,982  | 1,090       | 74,395             | 1 / 102,001           | 7,072             | 276.7                   |
| 200,000   | 196,113 | 2,244       | 148,614            | 1 / 203,971           | 15,393            | 471.9                   |

Cold restore, split by prototype-patching `getAll` and `crypto.subtle.decrypt`; the remainder is
base64 decode + `JSON.parse` + `tokenize` + `insertRoomOrder` + one sort per room:

| Records | Restore (ms) | `getAll` wait (ms) | decrypt (ms) | JS rebuild (ms) | Rebuild share | Longest task (ms) | Share of restore |
| ------- | ------------ | ------------------ | ------------ | --------------- | ------------- | ----------------- | ---------------- |
| 19,598  | 1,460        | 395                | 268          | 798             | 54.6%         | 959               | 65.7%            |
| 48,956  | 3,330        | 898                | 604          | 1,827           | 54.9%         | 2,269             | 68.1%            |
| 97,982  | 7,072        | 2,027              | 1,366        | 3,679           | 52.0%         | 4,718             | 66.7%            |
| 196,113 | 15,393       | 4,005              | 2,938        | 8,451           | 54.9%         | 10,740            | 69.8%            |

Heap after a cold restore, measured against an empty page carrying the same bundle, and the median of
20 warm queries per category:

| Records | Heap (MB) | Bytes/event | Token (ms) | Prefix (ms) | Substring (ms) | Miss (ms) |
| ------- | --------- | ----------- | ---------- | ----------- | -------------- | --------- |
| 19,598  | 20.2      | 913.7       | 1.15       | 0.88        | 6.14           | 4.69      |
| 48,956  | 45.6      | 885.1       | 1.50       | 1.05        | 10.76          | 8.00      |
| 97,982  | 88.5      | 879.4       | 4.00       | 2.78        | 24.56          | 20.33     |
| 196,113 | 172.7     | 869.1       | 8.79       | 6.16        | 48.81          | 36.70     |

On-disk size is 3.4x (200k) to 6.4x (20k) the manager's own `ciphertextBytes` accounting, measured right
after a write burst with no idle time for LevelDB compaction, so it is not a steady state.

Vocabulary growth, using the manager's real `tokenize()`, fitted as `V = K * T^beta` over 30 checkpoints:

| Generator | Events  | Final distinct tokens | Total tokens | Heaps' target       | Fitted beta |
| --------- | ------- | --------------------- | ------------ | ------------------- | ----------- |
| new       | 20,000  | 15,095                | 209,275      | 17,290              | 0.542       |
| new       | 50,000  | 27,363                | 520,062      | 28,619              | 0.497       |
| new       | 100,000 | 41,939                | 1,037,912    | 41,901              | 0.449       |
| new       | 200,000 | 62,767                | 2,067,636    | 61,346              | 0.398       |
| old       | 20,000  | 20,046                | 121,118      | not sized by Heaps' | 0.987       |

The final vocabulary is correctly sized **across** runs (within 2 to 13% of target) but the fitted
within-run exponent falls as the corpus grows, because a fixed-pool Zipf sampler saturates. That is the
known limitation named above, measured rather than assumed, and it means the token and prefix columns
above are underestimates at scale. Substring and memory do not depend on vocabulary.

**Reproducibility note.** The slopes and the disk figures reproduce closely; the **persist drain is the
least reproducible number in the table** (a 20k re-run on the same machine has come in at 13.2 s against
the 40.1 s above), which is consistent with the unexplained drain-throughput change between 50k and 100k
in the sweep itself. Treat the drain as an order of magnitude, and the restore and heap slopes as the
measurements.

## What each metric actually measures, and one gotcha

- **`ingest.ingestMs`** times the loop of awaited `addHistoricEvents()` calls only.
  `enqueuePersist()` chains writes as fire-and-forget promises (`BrowserEventIndexManager.ts:1642`),
  so **almost none of the actual IndexedDB writes happen during this loop** - see
  the results above. `ingest.persistDrainMs` (the following
  `await commitLiveEvents()`) is where nearly all the write cost actually lands, and
  `idbTxDuringIngest` vs `idbTxDuringDrain` shows the split numerically.
- **`restorePhase.restore.restoreMs`** is `initEventIndex()` end to end: `loadMeta` +
  `loadAllForUser` (one `getAll` for `events`, decrypt+tokenize+insert loop, one sort per room,
  one `getAll` for `checkpoints`, decrypt loop). The sub-splits (`idbReadMs`, `decryptMs`) come from
  prototype-patching `IDBIndex/IDBObjectStore.getAll` and `crypto.subtle.decrypt` in
  `page.template.html`'s instrumentation script, installed before the module bundle ever runs;
  the remainder (`restoreMs - idbReadMs - decryptMs`) is JSON.parse + tokenize + `insertRoomOrder`
    - the per-room sort, lumped together and not split further.
- **Time-to-first-searchable = restore time.** The code has no staged or incremental load (that is
  increment A in the design document's roadmap, not yet built); `initEventIndex()` fully awaits
  everything before the manager answers any query, so there is nothing to measure separately.
- **JS heap.** `performance.measureUserAgentSpecificMemory()` where available (this runner serves
  the page with `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
require-corp` specifically so it is available), else `performance.memory.usedJSHeapSize`.
  Real-shape bytes/event is always `(heap after restore - heap of an empty page) / n`, never a raw
  total, because the bundle + instrumentation + V8 startup heap are not zero. **No explicit GC
  bracketing** - a known lower-rigor point, named rather than
  hidden.
- **IndexedDB on-disk size** is read directly from the profile directory
  (`profiles/n<size>/**/*IndexedDB*`, `du -sb`) after phase A's browser context closes (so LevelDB
  has flushed) - never from `navigator.storage.estimate()`, which pads its answer.
- **Long tasks** come from a `PerformanceObserver({type: "longtask"})` reset immediately before
  `coldRestore()` runs, so the buffered array is scoped to the restore window without extra
  timestamp filtering.

## Not attempted

**Update 2026-09-13**: multi-engine runs and CPU throttling, listed below as untouched at the time
this section was written, are now covered by `--engine`/`--throttle` (see the top-of-file section)
- Firefox and Chromium-throttled-4x against real Chromium/Firefox/WebKit; Safari on iOS specifically
is still not attempted (Playwright's Linux WebKit build is not Safari - see the update section and
`research/measurements-cross-engine.md`'s caveats for exactly what that does and does not cover).

Still out of scope here, and untouched: Web Worker offload variants, a chunk-size or schema sweep, a
transaction-size sweep, a live-Synapse crawl-rate measurement, Element's own baseline heap with the flag
off, and a planted-defect negative control. The design document's §9 lists these as the validation runs
that gate the roadmap.
