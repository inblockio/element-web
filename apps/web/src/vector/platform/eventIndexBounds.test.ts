/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { afterEach, describe, expect, it, vi } from "vitest";

import { deviceMemoryTier, getEventIndexBounds, setEventIndexBoundsOverrideForTesting } from "./eventIndexBounds";

afterEach(() => {
    setEventIndexBoundsOverrideForTesting(null);
    vi.unstubAllGlobals();
});

describe("deviceMemoryTier", () => {
    it("is desktop when navigator.deviceMemory is above 4", () => {
        vi.stubGlobal("navigator", { ...globalThis.navigator, deviceMemory: 8 });
        expect(deviceMemoryTier()).toBe("desktop");
    });

    it("is small at exactly 4 (the boundary is inclusive on the small side)", () => {
        vi.stubGlobal("navigator", { ...globalThis.navigator, deviceMemory: 4 });
        expect(deviceMemoryTier()).toBe("small");
    });

    it("is small below 4", () => {
        vi.stubGlobal("navigator", { ...globalThis.navigator, deviceMemory: 2 });
        expect(deviceMemoryTier()).toBe("small");
    });

    // The four cases increment E's tier-heuristic fix cares about: deviceMemory present always
    // wins (covered above); deviceMemory absent falls back to a mobile check, which can now say
    // either "small" (mobile) or "desktop" (not mobile) -- unlike the old code, which answered
    // "small" unconditionally the moment deviceMemory was missing, silently downgrading every
    // Firefox/Safari desktop user (measurements-cross-engine.md §3.3/§3.4).
    describe("deviceMemory absent (Firefox, Safari): falls back to a mobile check", () => {
        it("is small when userAgentData.mobile is true", () => {
            vi.stubGlobal("navigator", {
                ...globalThis.navigator,
                deviceMemory: undefined,
                userAgentData: { mobile: true },
                userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) DesktopUAButOverridden",
            });
            expect(deviceMemoryTier()).toBe("small");
        });

        it("is small when userAgentData is absent but the UA string looks mobile (iPhone)", () => {
            vi.stubGlobal("navigator", {
                ...globalThis.navigator,
                deviceMemory: undefined,
                userAgentData: undefined,
                userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
            });
            expect(deviceMemoryTier()).toBe("small");
        });

        it("is desktop when neither userAgentData nor the UA string indicate mobile (Firefox desktop)", () => {
            vi.stubGlobal("navigator", {
                ...globalThis.navigator,
                deviceMemory: undefined,
                userAgentData: undefined,
                userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0",
            });
            expect(deviceMemoryTier()).toBe("desktop");
        });

        it("is desktop when userAgentData reports non-mobile and the UA string does not look mobile either", () => {
            vi.stubGlobal("navigator", {
                ...globalThis.navigator,
                deviceMemory: undefined,
                userAgentData: { mobile: false },
                userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Safari/605.1.15",
            });
            expect(deviceMemoryTier()).toBe("desktop");
        });

        // E-F4: iPadOS's default "Request Desktop Website" mode (on by default since iPadOS 13)
        // sends a plain desktop-Safari UA with no `iPad`/`Mobile` token, and WebKit exposes neither
        // `deviceMemory` nor `userAgentData` -- so before this fix an iPad landed on the desktop
        // tier (128 MiB hot window, 512 MiB disk budget) on the engine with the tightest per-tab
        // memory limits of the three, a regression E0's own fix introduced.
        it("is small for iPadOS's default desktop-mode UA (maxTouchPoints > 1 with a Macintosh UA)", () => {
            vi.stubGlobal("navigator", {
                ...globalThis.navigator,
                deviceMemory: undefined,
                userAgentData: undefined,
                maxTouchPoints: 5,
                userAgent:
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
            });
            expect(deviceMemoryTier()).toBe("small");
        });

        it("stays desktop for a genuine Mac (Macintosh UA, maxTouchPoints 0)", () => {
            vi.stubGlobal("navigator", {
                ...globalThis.navigator,
                deviceMemory: undefined,
                userAgentData: undefined,
                maxTouchPoints: 0,
                userAgent:
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
            });
            expect(deviceMemoryTier()).toBe("desktop");
        });

        it("stays desktop for maxTouchPoints > 1 on a non-Macintosh UA (a touch laptop is not an iPad)", () => {
            vi.stubGlobal("navigator", {
                ...globalThis.navigator,
                deviceMemory: undefined,
                userAgentData: undefined,
                maxTouchPoints: 10,
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
            });
            expect(deviceMemoryTier()).toBe("desktop");
        });
    });
});

describe("getEventIndexBounds", () => {
    it("desktop tier: 128 MiB hot window, 512 MiB disk budget, 90 days, 100 rooms", () => {
        vi.stubGlobal("navigator", { ...globalThis.navigator, deviceMemory: 8 });
        const bounds = getEventIndexBounds();
        expect(bounds).toEqual({
            tier: "desktop",
            hotWindowBytes: 128 * 1024 * 1024,
            diskBudgetBytes: 512 * 1024 * 1024,
            manifestCeilingBytes: 700_000 * 157,
            crawlWindowDays: 90,
            crawlRoomCap: 100,
        });
    });

    it("small tier: 48 MiB hot window, 128 MiB disk budget, 90 days, 20 rooms", () => {
        // deviceMemory absent alone is no longer sufficient for the small tier (see
        // deviceMemoryTier's own describe block above) -- this must also look mobile.
        vi.stubGlobal("navigator", {
            ...globalThis.navigator,
            deviceMemory: undefined,
            userAgentData: { mobile: true },
        });
        const bounds = getEventIndexBounds();
        expect(bounds).toEqual({
            tier: "small",
            hotWindowBytes: 48 * 1024 * 1024,
            diskBudgetBytes: 128 * 1024 * 1024,
            manifestCeilingBytes: 170_000 * 157,
            crawlWindowDays: 90,
            crawlRoomCap: 20,
        });
    });

    it("an override forces the tier regardless of navigator.deviceMemory", () => {
        vi.stubGlobal("navigator", { ...globalThis.navigator, deviceMemory: 8 }); // would be desktop
        setEventIndexBoundsOverrideForTesting({ tier: "small" });
        expect(getEventIndexBounds().tier).toBe("small");
        expect(getEventIndexBounds().hotWindowBytes).toBe(48 * 1024 * 1024); // the small tier's own default
    });

    it("an override can replace a single bound while leaving the rest of the tier's defaults alone", () => {
        vi.stubGlobal("navigator", { ...globalThis.navigator, deviceMemory: 8 });
        setEventIndexBoundsOverrideForTesting({ hotWindowBytes: 1234 });
        const bounds = getEventIndexBounds();
        expect(bounds.hotWindowBytes).toBe(1234);
        expect(bounds.tier).toBe("desktop");
        expect(bounds.diskBudgetBytes).toBe(512 * 1024 * 1024); // untouched
    });

    it("passing null clears the override and reads navigator again", () => {
        vi.stubGlobal("navigator", { ...globalThis.navigator, deviceMemory: 8 });
        setEventIndexBoundsOverrideForTesting({ tier: "small" });
        setEventIndexBoundsOverrideForTesting(null);
        expect(getEventIndexBounds().tier).toBe("desktop");
    });
});
