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
