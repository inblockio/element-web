/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventTimeline, EventType, type MatrixClient, MatrixError, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";
import { createTestClient } from "test-utils";

import PinningUtils from "../utils/PinningUtils";
import { setPinned, type PinTarget } from "./PinAction";

/* M6 B2 fix round 2: `setPinned` over the REAL `PinningUtils.pinOrUnpinEvent` against a simulated homeserver. The pin's
 * outcome is the state write's outcome; the paired read-pins account-data write fails on its own timing and must neither
 * fail a landed pin nor release the room's queue early (grok r2: host F1, track F1, track F2). */
describe("setPinned over pinOrUnpinEvent: the state write decides", () => {
    const roomId = "!room:example.org";
    const userId = "@alice:example.org";
    let client: MatrixClient;
    let server: string[];
    let local: string[];

    const message = (id: string): MatrixEvent =>
        new MatrixEvent({
            type: EventType.RoomMessage,
            sender: userId,
            content: { body: "hello", msgtype: "m.text" },
            room_id: roomId,
            origin_server_ts: 0,
            event_id: id,
        });
    const target = (id: string): PinTarget => {
        const ev = message(id);
        return {
            pinned: () => local.includes(id),
            canPin: () => true,
            press: () => PinningUtils.pinOrUnpinEvent(client, ev),
        };
    };
    /** The state PUT: accepted (or refused) after `putMs`, the sync that carries it follows `syncMs` later. */
    const homeserver = (putMs: number, syncMs: number, refuseFirst?: Error): void => {
        let calls = 0;
        vi.mocked(client.sendStateEvent).mockImplementation(
            ((_r: string, _t: string, content: { pinned: string[] }) =>
                new Promise((resolve, reject) =>
                    setTimeout(() => {
                        if (refuseFirst && calls++ === 0) return reject(refuseFirst);
                        server = [...content.pinned];
                        setTimeout(() => (local = [...server]), syncMs);
                        resolve({ event_id: "$state" });
                    }, putMs),
                )) as never,
        );
    };
    const accountData = (ms: number, error: Error): void => {
        vi.mocked(client.setRoomAccountData).mockImplementation(
            (() => new Promise((_res, rej) => setTimeout(() => rej(error), ms))) as never,
        );
    };

    beforeEach(() => {
        vi.useFakeTimers();
        client = createTestClient();
        const room = new Room(roomId, client, userId);
        client.getRoom = vi.fn().mockReturnValue(room);
        server = [];
        local = [];
        vi.spyOn(room.getLiveTimeline().getState(EventTimeline.FORWARDS)!, "getStateEvents").mockReturnValue({
            // @ts-ignore a state event as far as pinOrUnpinEvent reads it
            getContent: () => ({ pinned: local }),
        });
    });
    afterEach(() => vi.useRealTimers());

    // host F1 / track F2: the sibling write fails at once, the state PUT is slow; the next pin must wait for it.
    it("a pin behind a failing account-data write and a slow state PUT is not dropped by the next pin", async () => {
        accountData(200, new Error("500"));
        homeserver(8000, 500);
        const a = setPinned(roomId, target("$a"), true);
        const b = setPinned(roomId, target("$b"), true);
        await vi.advanceTimersByTimeAsync(40000);
        await expect(a).resolves.toMatchObject({ status: "done" });
        await expect(b).resolves.toMatchObject({ status: "done" });
        expect([...server].sort()).toEqual(["$a", "$b"]);
    });

    // track F1: the state write landed, then the account-data write is refused with M_FORBIDDEN.
    it("a pin that landed is done when only the account-data write is forbidden", async () => {
        accountData(400, new MatrixError({ errcode: "M_FORBIDDEN", error: "no" }, 403));
        homeserver(100, 200);
        const a = setPinned(roomId, target("$a"), true);
        await vi.advanceTimersByTimeAsync(40000);
        await expect(a).resolves.toMatchObject({ status: "done" });
        expect(server).toEqual(["$a"]);
    });

    it("a refused state PUT is a failed pin, the next one in the room still runs", async () => {
        accountData(100, new Error("500"));
        homeserver(300, 100, new Error("state 500"));
        const a = setPinned(roomId, target("$a"), true);
        const b = setPinned(roomId, target("$b"), true);
        const ra = a.catch((e) => e);
        await vi.advanceTimersByTimeAsync(40000);
        expect(await ra).toMatchObject({ code: "failed" });
        await expect(b).resolves.toMatchObject({ status: "done" });
    });
});
