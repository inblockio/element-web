/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { describe, it, expect, vi } from "vitest";
import { ConnectionError, MatrixError } from "matrix-js-sdk/src/matrix";

import { PIN_SETTLE_MS, setPinned, type PinTarget } from "./PinAction";
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

    it("maps a refused press: M_FORBIDDEN is forbidden, a lost connection network, anything else failed", async () => {
        vi.useFakeTimers();
        try {
            const refuse = (e: unknown) => target({ press: vi.fn(async () => Promise.reject(e)) });
            const settle = async (p: Promise<unknown>): Promise<unknown> => {
                const seen = p.then(
                    () => undefined,
                    (e: unknown) => e,
                );
                await vi.advanceTimersByTimeAsync(PIN_SETTLE_MS + 100);
                return seen;
            };
            expect(
                await settle(
                    setPinned("!a", refuse(new MatrixError({ errcode: "M_FORBIDDEN", error: "no" }, 403)), true),
                ),
            ).toMatchObject({ code: "forbidden" });
            expect(await settle(setPinned("!a", refuse(new ConnectionError("down")), true))).toMatchObject({
                code: "network",
            });
            expect(await settle(setPinned("!a", refuse(new Error("500")), true))).toMatchObject({ code: "failed" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("a definite refusal (M_FORBIDDEN) is reported at once, without the settle wait", async () => {
        const t = target({
            press: vi.fn(async () => Promise.reject(new MatrixError({ errcode: "M_FORBIDDEN", error: "no" }, 403))),
        });
        await expect(setPinned("!a", t, true)).rejects.toMatchObject({ code: "forbidden" });
    });

    // grok track F1 (high): the state write landed and the list shows it, then the paired read-pins account-data write
    // rejects: the pin is on the homeserver, so it is reported done (stock `pinOrUnpinEvent` rejects on either write).
    it("a press that rejects after its write landed is done when the list shows the change", async () => {
        vi.useFakeTimers();
        try {
            const state = { pinned: false };
            const t = target({
                state,
                press: vi.fn(async () => {
                    setTimeout(() => (state.pinned = true), 300); // the sync that carries the new list
                    throw new Error("account data 429");
                }),
            });
            const p = setPinned("!a", t, true);
            await vi.advanceTimersByTimeAsync(PIN_SETTLE_MS + 100);
            await expect(p).resolves.toEqual({ status: "done", roomId: "!a" });
        } finally {
            vi.useRealTimers();
        }
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

    // grok host F1 (high): a press that reported failure although its write landed must not release the room's queue
    // before the local list shows the write; the next pin builds its list from the local state and would drop it.
    it("the next call in the room builds on a write that landed behind a rejected press", async () => {
        vi.useFakeTimers();
        try {
            let server: string[] = [];
            let local: string[] = [];
            const sync = (): void => {
                setTimeout(() => (local = [...server]), 400);
            };
            const press = (id: string, fail: boolean) => async (): Promise<void> => {
                server = [...local, id]; // `pinOrUnpinEvent`: the new list is built from the local state
                sync();
                if (fail) throw new Error("account data 500");
            };
            const mk = (id: string, fail: boolean): PinTarget => ({
                pinned: () => local.includes(id),
                canPin: () => true,
                press: press(id, fail),
            });
            const a = setPinned("!q", mk("$a", true), true);
            const b = setPinned("!q", mk("$b", false), true);
            await vi.advanceTimersByTimeAsync(PIN_SETTLE_MS + 2000);
            await a.catch(() => undefined);
            await b;
            expect(server.sort()).toEqual(["$a", "$b"]);
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
