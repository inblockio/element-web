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

    it("is small when deviceMemory is absent (Firefox, Safari)", () => {
        vi.stubGlobal("navigator", { ...globalThis.navigator, deviceMemory: undefined });
        expect(deviceMemoryTier()).toBe("small");
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
            crawlWindowDays: 90,
            crawlRoomCap: 100,
        });
    });

    it("small tier: 48 MiB hot window, 128 MiB disk budget, 90 days, 20 rooms", () => {
        vi.stubGlobal("navigator", { ...globalThis.navigator, deviceMemory: undefined });
        const bounds = getEventIndexBounds();
        expect(bounds).toEqual({
            tier: "small",
            hotWindowBytes: 48 * 1024 * 1024,
            diskBudgetBytes: 128 * 1024 * 1024,
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
