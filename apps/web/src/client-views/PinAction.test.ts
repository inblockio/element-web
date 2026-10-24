/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { describe, it, expect, vi } from "vitest";
import { ConnectionError, MatrixError } from "matrix-js-sdk/src/matrix";

import { setPinned, type PinTarget } from "./PinAction";
import { ROOM_ACTION_TIMEOUT_MS } from "./RoomActions";

/* M6 B2: the pin press is the homeserver's answer, `done` needs the state to show it, calls for a room run in turn. */
function target(
    over: Partial<PinTarget> & { state?: { pinned: boolean } } = {},
): PinTarget & { state: { pinned: boolean } } {
    const state = over.state ?? { pinned: false };
    return {
        state,
        pinned: () => state.pinned,
        canPin: () => true,
        press: vi.fn(async () => {
            state.pinned = !state.pinned;
        }),
        ...over,
    } as PinTarget & { state: { pinned: boolean } };
}

describe("setPinned", () => {
    it("presses once when the state differs and is done when the state shows it", async () => {
        const t = target();
        await expect(setPinned("!a", t, true)).resolves.toEqual({ status: "done", roomId: "!a" });
        expect(t.press).toHaveBeenCalledTimes(1);
    });

    it("does not press when the message is already as asked", async () => {
        const t = target({ state: { pinned: true } });
        await expect(setPinned("!a", t, true)).resolves.toMatchObject({ status: "done" });
        expect(t.press).not.toHaveBeenCalled();
    });

    it("is forbidden, without a press, where Element offers no pin", async () => {
        const t = target({ canPin: () => false });
        await expect(setPinned("!a", t, true)).rejects.toMatchObject({ code: "forbidden" });
        expect(t.press).not.toHaveBeenCalled();
    });

    it("maps a refused press: M_FORBIDDEN is forbidden, a 4xx answer failed, a lost answer network", async () => {
        const refuse = (e: unknown) => target({ press: vi.fn(async () => Promise.reject(e)) });
        await expect(
            setPinned("!a", refuse(new MatrixError({ errcode: "M_FORBIDDEN", error: "no" }, 403)), true),
        ).rejects.toMatchObject({ code: "forbidden" });
        await expect(
            setPinned("!a", refuse(new MatrixError({ errcode: "M_BAD_JSON", error: "no" }, 400)), true),
        ).rejects.toMatchObject({ code: "failed" });
        vi.useFakeTimers();
        try {
            for (const lost of [new ConnectionError("down"), new Error("500")]) {
                const seen = setPinned("!a", refuse(lost), true).then(
                    () => "done",
                    (e: unknown) => e,
                );
                await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 200);
                expect(await seen).toMatchObject({ code: "network" });
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it("a definite refusal (M_FORBIDDEN) is reported at once, without the wait", async () => {
        const t = target({
            press: vi.fn(async () => Promise.reject(new MatrixError({ errcode: "M_FORBIDDEN", error: "no" }, 403))),
        });
        await expect(setPinned("!a", t, true)).rejects.toMatchObject({ code: "forbidden" });
    });

    // r3: an answer that is not a definite refusal (lost connection, timeout, 5xx) can hide an accepted write, so it is
    // held for the 15 s list wait and reported as "may still apply" (network), never as a clean failure.
    it("an ambiguous rejection is held for the list wait, then reported as network", async () => {
        vi.useFakeTimers();
        try {
            const t = target({ press: vi.fn(async () => Promise.reject(new Error("500"))) });
            const seen = setPinned("!a", t, true).then(
                () => "done",
                (e: unknown) => e,
            );
            let settled = false;
            void seen.then(() => (settled = true));
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS - 1000);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(2000);
            expect(await seen).toMatchObject({ code: "network" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("a press that rejects with a lost connection is done when the list already shows the change", async () => {
        const state = { pinned: false };
        const t = target({
            state,
            press: vi.fn(async () => {
                state.pinned = true;
                throw new ConnectionError("down after the write");
            }),
        });
        await expect(setPinned("!a", t, true)).resolves.toEqual({ status: "done", roomId: "!a" });
    });

    // grok track F1 (second half): the list flips in the last sleep before the wait ends.
    it("looks once more when the wait ends: a change that arrived in the last sleep is done", async () => {
        vi.useFakeTimers();
        try {
            const state = { pinned: false };
            const t = target({
                state,
                press: vi.fn(async () => {
                    setTimeout(() => (state.pinned = true), ROOM_ACTION_TIMEOUT_MS - 20);
                }),
            });
            const p = setPinned("!a", t, true);
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 200);
            await expect(p).resolves.toMatchObject({ status: "done" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("waits for the state: done only once it shows the change", async () => {
        vi.useFakeTimers();
        try {
            const t = target({ press: vi.fn(async () => {}) });
            let settled = false;
            const p = setPinned("!a", t, true).then((r) => {
                settled = true;
                return r;
            });
            await vi.advanceTimersByTimeAsync(500);
            expect(settled).toBe(false);
            t.state.pinned = true;
            await vi.advanceTimersByTimeAsync(100);
            await expect(p).resolves.toMatchObject({ status: "done" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("is network when the state never shows the change", async () => {
        vi.useFakeTimers();
        try {
            const t = target({ press: vi.fn(async () => {}) });
            const p = setPinned("!a", t, true);
            const seen = p.then(
                () => undefined,
                (e: unknown) => e,
            );
            await vi.advanceTimersByTimeAsync(20_000);
            expect(await seen).toMatchObject({ code: "network" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("runs the calls of one room in turn: the second reads the state the first left", async () => {
        const order: string[] = [];
        const state = { pinned: false };
        let release!: () => void;
        const first = target({
            state,
            press: vi.fn(async () => {
                order.push("first start");
                await new Promise<void>((r) => (release = r));
                state.pinned = true;
                order.push("first end");
            }),
        });
        const second = target({
            state,
            press: vi.fn(async () => {
                order.push("second");
                state.pinned = false;
            }),
        });
        const a = setPinned("!a", first, true);
        const b = setPinned("!a", second, false);
        await vi.waitFor(() => expect(order).toEqual(["first start"]));
        release();
        await Promise.all([a, b]);
        expect(order).toEqual(["first start", "first end", "second"]);
    });

    it("does not hold one room's call behind another room's", async () => {
        let release!: () => void;
        const slow = target({
            press: vi.fn(
                () =>
                    new Promise<void>((r) => {
                        release = () => {
                            slow.state.pinned = true;
                            r();
                        };
                    }),
            ),
        });
        const quick = target();
        const held = setPinned("!slow", slow, true);
        await expect(setPinned("!b", quick, true)).resolves.toMatchObject({ roomId: "!b" });
        release();
        await held;
    });

    it("stops waiting when the bridge is disposed", async () => {
        const t = target({ press: vi.fn(async () => {}) });
        await expect(setPinned("!a", t, true, () => true)).rejects.toMatchObject({ code: "failed" });
    });
});
