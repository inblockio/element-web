/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * The bounds {@link BrowserEventIndexManager} enforces on the crawl, the resident (hydrated) set
 * and the on-disk footprint, per `research/SYNTHESIS.md` §3.5-§3.7 of the increment-C handover
 * (`~/handovers/2026-09-12-element-web-eventindex`). Provisional and revisable (SYNTHESIS.md §3.7
 * calls the numbers below "provisional... all revisable by V-plan and decision #4"); Tim's decision
 * #4 (2026-09-13) adopted them anyway rather than block on V14, which was itself dropped. Every
 * number here is a *count of bytes or days*, never a count of events: the resident-set budgets are
 * checked against {@link BrowserEventIndexManager}'s own running byte estimates
 * (`plainTextByteEstimate`, `ciphertextBytes`), and the event counts in the basis column below are
 * approximations for intuition only, not the actual gate.
 *
 * **How the hot window and the encrypted recency manifest coexist (review-pr-c.md C2-F2, corrected
 * in the third pass).** The manifest ({@link BrowserEventIndexManager}'s own field of that name)
 * tracks every row on *disk*, not just the resident ones, and is never evicted. It is its own
 * resident tier, next to the hot window, **not** a tax on it: `hotWindowBytes` gates hydrated
 * *events* alone (`RESIDENT_BYTES_PER_EVENT_ESTIMATE * events.size`, checked by
 * `BrowserEventIndexManager.residentByteEstimate()`), so 200k events at the small tier still admit
 * roughly the same ~49k hydrated events as before the manifest existed, and 500k at the desktop
 * tier roughly ~131k. The manifest gets a separate, explicit ceiling instead
 * (`manifestCeilingBytes` below), derived from `diskBudgetBytes`: **the manifest cannot exceed the
 * events the disk budget admits**, so its worst case is exactly that event count times {@link
 * MANIFEST_BYTES_PER_ENTRY_ESTIMATE}, self-enforcing via {@link
 * BrowserEventIndexManager.enforceDiskBudget} rather than a runtime check of its own:
 *
 * | tier | `hotWindowBytes` (events) | `diskBudgetBytes` | events at that budget | `manifestCeilingBytes` (worst case, ~157 B/entry) | tier's total resident (hot window + manifest ceiling) |
 * |---|---|---|---|---|---|
 * | small | 48 MiB | 128 MiB | ~170k | ~25.5 MiB (170k x 157 B) | ~73.5 MiB |
 * | desktop | 128 MiB | 512 MiB | ~700k | ~104.8 MiB (700k x 157 B) | ~232.8 MiB |
 *
 * (An intermediate revision of this fix summed the manifest's cost *into* `hotWindowBytes`'s own
 * check instead of giving it this separate ceiling; that shrank admitted events to ~21k/~54k at the
 * two proof sizes measured -- correct that the memory cost must not be invisible, wrong that hot,
 * instantly-searchable content should be what pays for it. See `measurements-pr-c.md` §10.2/§11.)
 *
 * **The manifest's own share is never shrunk to make room** (it cannot be -- {@link
 * BrowserEventIndexManager}'s `manifest` field docstring explains why it must survive eviction):
 * `manifestCeilingBytes` is a documented worst-case figure the manifest's own growth is bounded by
 * through `diskBudgetBytes`, not a second budget `enforceResidentBudget` separately checks or
 * evicts against.
 */

/** One of the two platform tiers a bound set is chosen for; see {@link deviceMemoryTier}. */
export type EventIndexTier = "desktop" | "small";

/** The bounds a given tier enforces; see the module docstring for provenance. */
export interface EventIndexBounds {
    readonly tier: EventIndexTier;
    /**
     * Byte budget for the *resident* (hydrated-into-memory) set of **events**, checked against
     * `BrowserEventIndexManager.residentByteEstimate()` (`RESIDENT_BYTES_PER_EVENT_ESTIMATE *
     * events.size` -- events alone, not the manifest; see {@link manifestCeilingBytes} and the
     * module docstring's own section on why the two are separate tiers, review-pr-c.md C2-F2's
     * corrected reading). Basis: 3% (desktop) / 5% (small) of Chromium's old-generation heap
     * budget; SYNTHESIS.md §1.6/§3.7. Desktop 128 MiB (~140k events at 0.9 KB/event), small tier
     * 48 MiB (~50k events).
     */
    readonly hotWindowBytes: number;
    /**
     * Byte budget for the *on-disk* ciphertext footprint, checked against `ciphertextBytes` (exact
     * ciphertext accounting, excludes IndexedDB's own per-record/store overhead). Basis: pending
     * V10's on-disk multiplier; SYNTHESIS.md §3.7. Desktop 512 MiB (~700k events), small tier 128
     * MiB (~170k events). Also the basis {@link manifestCeilingBytes} is derived from: the manifest
     * cannot exceed the events this budget admits.
     */
    readonly diskBudgetBytes: number;
    /**
     * Documented worst-case byte figure for the encrypted recency manifest's own resident cost
     * (review-pr-c.md C2-F2, corrected) -- the events `diskBudgetBytes` admits for this tier, times
     * `MANIFEST_BYTES_PER_ENTRY_ESTIMATE`'s own ~157 B/entry worst case (`BrowserEventIndexManager`
     * measured 136.7-171.1 B/event across proof sizes and page sizes; see that constant's own
     * docstring). **Not enforced by a runtime check of its own** -- the manifest's growth is
     * already self-bounded by `diskBudgetBytes` via `enforceDiskBudget` (one manifest entry per
     * disk row; a row leaving disk removes its entry too), so this field exists to make the
     * resulting worst case *visible* rather than to gate anything a second time. Add this to
     * `hotWindowBytes` for a tier's total worst-case resident figure (see the module docstring's
     * table). Desktop ~104.8 MiB (700k x 157 B), small tier ~25.5 MiB (170k x 157 B).
     */
    readonly manifestCeilingBytes: number;
    /**
     * How far back, in days from the current wall-clock time, the crawler is allowed to fetch
     * history for one room; see {@link BrowserEventIndexManager.shouldCrawl}. Same for both tiers:
     * element-meta#3252; matches Keybase's 100-room/10-day precedent's spirit if not its exact
     * numbers (SYNTHESIS.md §3.5).
     */
    readonly crawlWindowDays: number;
    /**
     * How many rooms, ranked by most recent indexed activity, the crawler is allowed to hold a
     * checkpoint for at once; see {@link BrowserEventIndexManager.shouldCrawl}. Desktop 100, small
     * tier 20 (SYNTHESIS.md §3.5, §3.7; Element's own 90-day/100-room default on desktop).
     */
    readonly crawlRoomCap: number;
}

/** One day, in milliseconds; the unit {@link EventIndexBounds.crawlWindowDays} is expressed in. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Target plaintext size, in bytes, of one packed chunk of events (schema v3; see
 * `BrowserEventIndexManager.ts`'s own "Storage layout" section) before it is sealed and a new one is
 * started. A chunk's plaintext is JSON, so this is a target on the serialised `[eventId, StoredEvent]`
 * array's own byte length, checked against as entries are packed in -- the sealed chunk usually ends
 * up a little over this figure (whatever single entry pushed it past the target stays in), never
 * under it except for the very last, still-open chunk.
 *
 * **Basis.** Two real thresholds bound the useful range, both independent of this feature's own
 * choices:
 *
 * 1. Chromium's IndexedDB backing store keeps a value inline in its own record up to a size in the
 *    tens of kilobytes, past which it is written out-of-line as a separate blob file on disk with an
 *    extra filesystem round trip per read -- `research/browser-limits-model.md`'s IndexedDB-value-
 *    storage section (increment-D handover) puts that boundary at 64&nbsp;KiB. A chunk sized *at* or
 *    *above* that line risks paying the extra round trip on every read; this increment stays clear of
 *    it rather than depend on where exactly a given Chromium version draws it.
 * 2. AES-GCM's own per-call cost is dominated by a small fixed dispatch overhead at very small inputs
 *    and becomes throughput-bound above roughly 16&nbsp;KiB -- so a target much below that amortises
 *    poorly, and past the several-tens-of-KiB range the amortisation is mostly already spent.
 *
 * **Measured, not merely modelled**, by `~/.cache/eventindex-perf-d/chunk-size-sweep.mjs` (real
 * Node WebCrypto, the same AES-GCM implementation family Chromium uses, over a 50,000-event synthetic
 * corpus shaped like this feature's own `StoredEvent` -- encrypted-room fields included -- averaging
 * 981&nbsp;B of plaintext JSON per event) sweeping exactly the candidates this constant's own basis
 * asks for, 16/32/48/64/96&nbsp;KiB:
 *
 * | target | events/chunk | ciphertext overhead | encrypt (µs/event) | decrypt (µs/event) | one-chunk point-lookup |
 * |---|---|---|---|---|---|
 * | 16 KiB | 15.3 | 0.18% | 12.62 | 12.32 | 0.19 ms |
 * | 32 KiB | 31.2 | 0.09% | 8.48 | 8.09 | 0.25 ms |
 * | **48 KiB** | **47.1** | **0.06%** | **7.06** | **6.58** | **0.31 ms** |
 * | 64 KiB | 63.0 | 0.04% | 5.93 | 6.79 | 0.41 ms |
 * | 96 KiB | 94.7 | 0.03% | 5.18 | 5.54 | 0.48 ms |
 *
 * Throughput keeps improving past 48&nbsp;KiB (as amortisation theory predicts), but the gains are
 * small and, past 48 KiB, noisy in the wrong direction for decrypt (64 KiB measures *worse* than 48
 * KiB there, run-to-run GC jitter on a difference this small) -- while every candidate at or past
 * 64&nbsp;KiB sits at or over threshold 1 above (a sealed chunk is target-plus-one-entry, so a 64 KiB
 * *target* produces chunks that measure slightly *over* 64 KiB on disk, i.e. squarely in the
 * externalised-blob range that number 1 warns about). The one-chunk point-lookup cost ({@link
 * BrowserEventIndexManager.materializeIfPending}'s own bounded read) rises monotonically with target
 * size as expected, but every candidate measured is well under a millisecond -- two orders of
 * magnitude inside the 50 ms long-task ceiling -- so it does not meaningfully constrain the choice
 * either way at these sizes. Net: the measured optimum **matches the original 48 KiB estimate** (the
 * point where most of the throughput gain has already been captured, comfortably clear of the
 * externalisation threshold, mean chunk population 47 events -- within the "roughly 50-90 events"
 * estimate the increment's own design brief gave), so it is kept as the default rather than moved.
 *
 * **Re-swept with the real manager end to end (review-pr-d.md D10), not just intrinsic crypto
 * cost.** The table above is Node WebCrypto in isolation and cannot see two costs that dominate in
 * practice: `flushLiveWrites` re-encrypts the *entire open chunk* on every flush that touches it, so
 * write cost per event rises with the target (a live path flushing a handful of events pays close
 * to the whole chunk's re-encrypt each time); and, before the D5 hydration fix, restore cost was
 * dominated by *read amplification* proportional to events per chunk, the opposite sign from what
 * this table implies. `~/.cache/eventindex-perf-d/chunk-size-sweep.mjs --events 100000`, re-run
 * against the fixed (chunk-once) hydration, driving the real manager's write, cold-restore and
 * point-lookup path rather than isolated crypto:
 *
 * | target | encrypt µs/event (write) | decrypt µs/event (read) | restore ms | disk bytes |
 * |---|---|---|---|---|
 * | 16 KiB | 4.51 | 1.87 | 3,390.1 | 72,288,547 |
 * | 32 KiB | 4.57 | 1.43 | 3,277.5 | 72,228,020 |
 * | **48 KiB (HEAD)** | **4.84** | **1.11** | **2,792.0** | **72,207,288** |
 * | 64 KiB | 5.21 | 1.03 | 3,139.4 | 72,198,375 |
 * | 96 KiB | 6.11 | 0.93 | 2,654.0 | 72,187,906 |
 *
 * Write cost rises monotonically with target (+35% from 16 to 96 KiB), read cost falls
 * monotonically (-50%), on-disk size is flat (0.13% across the whole range), and restore time is
 * **not monotone** and spans only ±13% -- once hydration reads each chunk exactly once, restore is
 * dominated by the per-event resident-insertion cost (`insertRoomOrder`/D-R6), not by chunk size.
 * **Honest conclusion: 48 KiB is defensible and is the best of 16/32/48/64 on restore in this sweep,
 * but the data does not identify it as a unique optimum** -- any value in 32-64 KiB is within noise
 * on restore, and the real trade is simply write cost against read cost. What the data does settle
 * is that 16 KiB (briefly landed, then reverted, in this increment's history) is wrong in both
 * directions: worst on restore *and* on decrypt, no better on write. Kept at 48 KiB: no value in
 * this range is clearly better, and it is the value already measured, deployed and gated on.
 *
 * @knipignore - exported for tests, that read it directly to size a fixture relative to a chunk
 *     boundary; production code reads {@link getChunkTargetBytes} instead, which is the one that
 *     can actually be overridden ({@link setChunkTargetBytesOverrideForTesting}) -- this constant
 *     itself never changes, so a test cannot cross a chunk boundary with a *small* fixture by
 *     reading this alone, only by overriding what production code reads.
 */
export const CHUNK_TARGET_BYTES = 48 * 1024;

/**
 * Test-only override for {@link getChunkTargetBytes}, the same shape as {@link
 * setEventIndexBoundsOverrideForTesting}: `null` (the default) means "use {@link
 * CHUNK_TARGET_BYTES}", any other number shrinks (or grows) the target a test's fixture seals
 * against, so a chunk-boundary-crossing scenario (a redaction/disk-budget-eviction test needing two
 * *different* chunks, say) can use a handful of records instead of enough to fill a real 48 KiB
 * chunk. Production code never calls the setter.
 */
let chunkTargetBytesOverrideForTesting: number | null = null;

/**
 * The chunk-sealing target in effect right now: {@link CHUNK_TARGET_BYTES} unless a test has
 * overridden it. Called fresh every time rather than cached, the same convention {@link
 * getEventIndexBounds} follows and for the same reason: every call site already treats this as
 * cheap.
 */
export function getChunkTargetBytes(): number {
    return chunkTargetBytesOverrideForTesting ?? CHUNK_TARGET_BYTES;
}

/**
 * Test-only hook: force {@link getChunkTargetBytes} to a specific value, or pass `null` to clear
 * the override and go back to {@link CHUNK_TARGET_BYTES}. Never called from production code.
 * @knipignore - exported for tests
 */
export function setChunkTargetBytesOverrideForTesting(override: number | null): void {
    chunkTargetBytesOverrideForTesting = override;
}

const DESKTOP_BOUNDS: EventIndexBounds = {
    tier: "desktop",
    hotWindowBytes: 128 * 1024 * 1024,
    diskBudgetBytes: 512 * 1024 * 1024,
    // ~700k events (this tier's own diskBudgetBytes-implied population) x ~157 B/entry worst case.
    manifestCeilingBytes: 700_000 * 157,
    crawlWindowDays: 90,
    crawlRoomCap: 100,
};

const SMALL_BOUNDS: EventIndexBounds = {
    tier: "small",
    hotWindowBytes: 48 * 1024 * 1024,
    diskBudgetBytes: 128 * 1024 * 1024,
    // ~170k events (this tier's own diskBudgetBytes-implied population) x ~157 B/entry worst case.
    manifestCeilingBytes: 170_000 * 157,
    crawlWindowDays: 90,
    crawlRoomCap: 20,
};

/**
 * Which tier this browser falls into: `navigator.deviceMemory` (Chromium-only; Firefox and Safari
 * do not expose it, per the Device Memory API spec, and its absence is deliberately not treated as
 * "must be a beefy desktop" -- a browser that hides the signal gets the *more conservative* bound)
 * of 4 GiB or less, or the property being absent altogether, is the small tier; anything reporting
 * more than 4 is the desktop tier. `deviceMemory` is a rounded, coarse figure (a power of two) by
 * design, so no finer-grained tiering is attempted.
 */
export function deviceMemoryTier(): EventIndexTier {
    const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
    const mem = nav?.deviceMemory;
    return typeof mem === "number" && mem > 4 ? "desktop" : "small";
}

/**
 * Overrides applied on top of a tier's defaults, or a full replacement tier; see {@link
 * setEventIndexBoundsOverrideForTesting}. Production code never calls the setter, so this stays
 * `null` outside tests.
 */
let overrideForTesting: Partial<EventIndexBounds> | null = null;

/**
 * The bounds in effect right now: {@link deviceMemoryTier}'s defaults, with any test override
 * layered on top. Called fresh every time rather than cached, so a test's override -- or, in
 * principle, a `deviceMemory` that changes between calls -- always takes effect immediately; every
 * call site in {@link BrowserEventIndexManager} already treats this as cheap (a couple of property
 * reads and an object spread), never as something to memoize.
 */
export function getEventIndexBounds(): EventIndexBounds {
    const tier = overrideForTesting?.tier ?? deviceMemoryTier();
    const base = tier === "desktop" ? DESKTOP_BOUNDS : SMALL_BOUNDS;
    return overrideForTesting ? { ...base, ...overrideForTesting } : base;
}

/**
 * Test-only hook: force a tier and/or override individual bounds, so a test can exercise the small
 * tier's numbers without faking `navigator.deviceMemory`, or shrink a bound to a size a unit test
 * can actually cross. Pass `null` to clear the override and go back to reading `navigator` for real.
 * Never called from production code.
 *
 * @knipignore - exported for tests
 */
export function setEventIndexBoundsOverrideForTesting(override: Partial<EventIndexBounds> | null): void {
    overrideForTesting = override;
}
