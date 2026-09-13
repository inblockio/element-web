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
 * **Basis.** Two real thresholds bound the *useful range* a candidate has to be picked from:
 * Chromium's IndexedDB backing store keeps a value inline up to the tens of kilobytes before writing
 * it out-of-line as a separate blob file (`research/browser-limits-model.md`'s IndexedDB-value-storage
 * section puts that boundary at 64 KiB -- a target at or past it risks the extra round trip on every
 * read), and AES-GCM's own fixed per-call dispatch cost is mostly amortised by roughly 16 KiB. Neither
 * threshold, on its own, said *where inside* 16-64 KiB to land -- that took a real measurement, and
 * the first one run (a bare `crypto.subtle.encrypt`/`decrypt` of one isolated chunk-sized buffer per
 * candidate, no manager, no repeated flushes) picked 48 KiB and was **wrong**, for a reason it could
 * not see: it never exercised {@link BrowserEventIndexManager.flushLiveWrites}'s real behaviour, which
 * re-encrypts the **entire accumulated open chunk from scratch on every flush that touches it**, not
 * just the newly-added entries (`~/.cache/eventindex-perf-c`'s own review-pr-c.md C2-F3 already found
 * this exact shape of cost for the manifest's own tail page; the open chunk has the same shape). A
 * crawler batch arrives roughly every 100 events, so a *larger* target means *more* flushes touch the
 * same still-filling chunk before it seals, and each of those flushes re-pays for the entries the
 * flush before it already paid for -- real per-event write cost rises with target size instead of
 * falling, the opposite of what a single-encrypt-per-candidate microbenchmark can show.
 *
 * **Measured for real** by `~/.cache/eventindex-perf-d/chunk-size-sweep.mjs`, real Chromium 149 (the
 * `chromium-1228` build this project's harnesses standardise on), driving the actual, unmodified
 * `BrowserEventIndexManager` through `addHistoricEvents()` in real 100-event crawl batches (not an
 * isolated encrypt call) against a 20,000-event corpus shaped like this feature's own `StoredEvent`
 * (~981 B plaintext JSON/event), for every one of the five candidates this constant's own basis asks
 * for. `encrypt`/`decrypt` µs/event divide the harness's own cumulative `encryptMs`/`decryptMs`
 * instrumentation by the event count actually written/restored; `restoreMs` is a full cold
 * `initEventIndex()` + `waitForHydration()`; the point-lookup column is
 * {@link BrowserEventIndexManager.materializeIfPending}'s own bounded read, forced to fire by
 * capping the resident budget to near-zero before asking for one specific, not-yet-hydrated event:
 *
 * | target | write (µs/event) | restore, full (ms) | read (µs/event) | one-chunk point-lookup (ms) | disk (19,603 events) |
 * |---|---|---|---|---|---|
 * | **16 KiB** | **8.59** | 3007 | 8.18 | **136** | 14,426,120 B |
 * | 32 KiB | 10.75 | 3591 | 9.26 | 164 | 14,414,583 B |
 * | 48 KiB (the modelled pick) | 12.57 | 2986 | 8.05 | 131 | 14,409,764 B |
 * | 64 KiB | 12.10 | 4456 | 9.05 | 150 | 14,408,436 B |
 * | 96 KiB | 14.76 | 4699 | 9.70 | 160 | 14,407,809 B |
 *
 * Write cost rises close to monotonically with target size (16 KiB is 32% cheaper per event than
 * 48 KiB, 42% cheaper than 96 KiB) -- exactly the open-chunk-rewrite mechanism above, and the
 * dominant real cost here: a write happens on every crawler batch and every live-buffer flush, for
 * the life of the account, where a restore happens once per session. The point-lookup cost tracks
 * write cost for the same reason (decrypting a chunk this small is cheap regardless of target, so the
 * *count* of entries sharing that one decrypt, which is what varies, is what shows up). Disk size and
 * read cost are close to flat across the whole range (disk varies by under 0.2% end to end; read has
 * no reason to depend on target at all, since a chunk is decrypted exactly once per restore regardless
 * of how many flushes built it, and the small spread here is run-to-run noise, not a trend) -- neither
 * one is a reason to prefer a larger target. **The measured optimum is 16 KiB, not 48 KiB**, the
 * smallest of the five candidates the design brief asked to sweep; nothing in this data rules out an
 * even smaller target doing better still, but 16 KiB is the floor this sweep actually measured, so it
 * is what this constant now carries. Mean chunk population at 16 KiB is `~17` events, well under the
 * "roughly 50-90 events" figure an earlier, unmeasured estimate assumed -- disk size shows that
 * smaller-and-more-numerous chunks cost essentially nothing extra in per-record overhead at this
 * scale, so the 50-90 figure was never load-bearing for anything this constant actually has to satisfy
 * (the two hard thresholds above, both comfortably clear at 16 KiB).
 *
 * **Named limitation, not fixed here**: the real fix for the open-chunk-rewrite cost is packing only
 * the *delta* into the open chunk's ciphertext (an append-friendly encrypted structure, or accepting
 * multiple small ciphertexts per open chunk merged on read) rather than re-encrypting the whole thing
 * per flush; that is a write-path redesign this increment's own review should weigh against simply
 * shipping the smaller measured target, not something this measurement pass should decide unilaterally.
 *
 * @knipignore - exported for tests, that read it directly to size a fixture relative to a chunk
 *     boundary; production code reads {@link getChunkTargetBytes} instead, which is the one that
 *     can actually be overridden ({@link setChunkTargetBytesOverrideForTesting}) -- this constant
 *     itself never changes, so a test cannot cross a chunk boundary with a *small* fixture by
 *     reading this alone, only by overriding what production code reads.
 */
export const CHUNK_TARGET_BYTES = 16 * 1024;

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
