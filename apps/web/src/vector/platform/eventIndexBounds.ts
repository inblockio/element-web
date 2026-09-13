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
 * **How the hot window and the encrypted recency manifest coexist (review-pr-c.md C2-F2).** The
 * manifest ({@link BrowserEventIndexManager}'s own field of that name) tracks every row on *disk*,
 * not just the resident ones, and is never evicted -- so at a tier's own `diskBudgetBytes`-implied
 * population it can reach a real fraction of `hotWindowBytes` on its own:
 *
 * | tier | `hotWindowBytes` | `diskBudgetBytes` | events at that budget | manifest for them | left for actual events |
 * |---|---|---|---|---|---|
 * | small | 48 MiB | 128 MiB | ~170k | ~26 MiB (170k x 160 B) | ~22 MiB (~22k events) |
 * | desktop | 128 MiB | 512 MiB | ~700k | ~107 MiB (700k x 160 B) | ~21 MiB (~21k events) |
 *
 * `BrowserEventIndexManager.residentByteEstimate()` counts *both* terms against the same
 * `hotWindowBytes` (`MANIFEST_BYTES_PER_ENTRY_ESTIMATE * manifest.size`, alongside
 * `RESIDENT_BYTES_PER_EVENT_ESTIMATE * events.size`) rather than exempting the manifest -- an
 * earlier revision of this increment did exempt it, which the review caught as a silent +54%
 * (small tier) / +75% (desktop) overshoot of the documented budget once a long-lived index's
 * manifest actually reached that scale. **The manifest's own share is never shrunk to make room**
 * (it cannot be -- {@link BrowserEventIndexManager}'s `manifest` field docstring explains why it
 * must survive eviction): what shrinks, automatically, as the manifest grows toward this worst
 * case over a session's lifetime, is how many *events* {@link BrowserEventIndexManager.hydrate}
 * keeps resident out of what remains of `hotWindowBytes` -- never the reverse. This is a real,
 * intentional trade-off, not hidden in a "~50k events"/"~140k events" event-count intuition that
 * would otherwise silently stop holding once a manifest this large exists; the numbers above are
 * the honest ones for that state.
 */

/** One of the two platform tiers a bound set is chosen for; see {@link deviceMemoryTier}. */
export type EventIndexTier = "desktop" | "small";

/** The bounds a given tier enforces; see the module docstring for provenance. */
export interface EventIndexBounds {
    readonly tier: EventIndexTier;
    /**
     * Byte budget for the *resident* (hydrated-into-memory) set, checked against
     * `plainTextByteEstimate`. Basis: 3% (desktop) / 5% (small) of Chromium's old-generation heap
     * budget; SYNTHESIS.md §1.6/§3.7. Desktop 128 MiB (~140k events at 0.9 KB/event *when the
     * manifest is small*), small tier 48 MiB (~50k events, same caveat) -- see the module
     * docstring's table for what these numbers shrink to once the manifest itself has grown to a
     * tier's own disk-budget-implied scale (review-pr-c.md C2-F2).
     */
    readonly hotWindowBytes: number;
    /**
     * Byte budget for the *on-disk* ciphertext footprint, checked against `ciphertextBytes` (exact
     * ciphertext accounting, excludes IndexedDB's own per-record/store overhead). Basis: pending
     * V10's on-disk multiplier; SYNTHESIS.md §3.7. Desktop 512 MiB (~700k events), small tier 128
     * MiB (~170k events).
     */
    readonly diskBudgetBytes: number;
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
    crawlWindowDays: 90,
    crawlRoomCap: 100,
};

const SMALL_BOUNDS: EventIndexBounds = {
    tier: "small",
    hotWindowBytes: 48 * 1024 * 1024,
    diskBudgetBytes: 128 * 1024 * 1024,
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
