/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "test-utils-rtl";

import { faceliftClass, useFaceliftClass } from "./facelift";

vi.mock("./facelift.css", () => ({}));

const ROCKETCHAT = "mx_ClientViewFacelift_rocketchat";
const faceliftClasses = (): string[] =>
    [...document.body.classList].filter((c) => c.startsWith("mx_ClientViewFacelift_"));

describe("facelift body class", () => {
    afterEach(() => {
        document.body.className = "";
    });

    it("names a class only for a kit with a look to take", () => {
        expect(faceliftClass("rocketchat")).toBe(ROCKETCHAT);
        expect(faceliftClass("fixture")).toBeUndefined();
        expect(faceliftClass("stock")).toBeUndefined();
    });

    it("is on the body while the rocketchat view is mounted and off when it unmounts", () => {
        const { unmount } = renderHook(() => useFaceliftClass("rocketchat"));
        expect(document.body.classList.contains(ROCKETCHAT)).toBe(true);
        unmount();
        expect(document.body.classList.contains(ROCKETCHAT)).toBe(false);
    });

    it("goes off when the host switches to a view without a look", () => {
        const { rerender, unmount } = renderHook(({ id }) => useFaceliftClass(id), {
            initialProps: { id: "rocketchat" },
        });
        expect(faceliftClasses()).toEqual([ROCKETCHAT]);
        rerender({ id: "fixture" });
        expect(faceliftClasses()).toEqual([]);
        rerender({ id: "rocketchat" });
        expect(faceliftClasses()).toEqual([ROCKETCHAT]);
        unmount();
        expect(faceliftClasses()).toEqual([]);
    });

    it("sets no class for a view that is not rocketchat", () => {
        const { unmount } = renderHook(() => useFaceliftClass("fixture"));
        expect(faceliftClasses()).toEqual([]);
        unmount();
        expect(faceliftClasses()).toEqual([]);
    });

    it("leaves the body's other classes alone", () => {
        document.body.classList.add("cpd-theme-light");
        const { unmount } = renderHook(() => useFaceliftClass("rocketchat"));
        expect([...document.body.classList].sort()).toEqual(["cpd-theme-light", ROCKETCHAT]);
        unmount();
        expect([...document.body.classList]).toEqual(["cpd-theme-light"]);
    });
});
