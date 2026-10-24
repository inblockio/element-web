/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest";
import { EventTimeline, EventType, type MatrixClient, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";
import { createTestClient } from "test-utils";

import PinningUtils from "./PinningUtils";

/* Client views (M6 B2, hook-set patch in PinningUtils.pinOrUnpinEvent): the pinned list sent is a copy. The stock code
 * spliced / pushed the live state content array before the send, so a refused send left the event shown as pinned
 * (or unpinned) in Element's own state. */
describe("PinningUtils.pinOrUnpinEvent leaves the live state alone", () => {
    const roomId = "!room:example.org";
    const userId = "@alice:example.org";
    let client: MatrixClient;
    let live: string[];

    const message = (id: string): MatrixEvent =>
        new MatrixEvent({
            type: EventType.RoomMessage,
            sender: userId,
            content: { body: "hello", msgtype: "m.text" },
            room_id: roomId,
            origin_server_ts: 0,
            event_id: id,
        });

    beforeEach(() => {
        client = createTestClient();
        const room = new Room(roomId, client, userId);
        client.getRoom = vi.fn().mockReturnValue(room);
        live = ["$other"];
        vi.spyOn(room.getLiveTimeline().getState(EventTimeline.FORWARDS)!, "getStateEvents").mockReturnValue({
            // @ts-ignore a state event as far as pinOrUnpinEvent reads it
            getContent: () => ({ pinned: live }),
        });
    });

    it("a refused pin does not add the event to the state content", async () => {
        vi.mocked(client.sendStateEvent).mockRejectedValue(new Error("500"));
        await expect(PinningUtils.pinOrUnpinEvent(client, message("$new"))).rejects.toThrow("500");
        expect(live).toEqual(["$other"]);
    });

    it("a refused unpin does not remove the event from the state content", async () => {
        live = ["$new", "$other"];
        vi.mocked(client.sendStateEvent).mockRejectedValue(new Error("500"));
        await expect(PinningUtils.pinOrUnpinEvent(client, message("$new"))).rejects.toThrow("500");
        expect(live).toEqual(["$new", "$other"]);
    });

    it("an accepted pin still sends the new list", async () => {
        await PinningUtils.pinOrUnpinEvent(client, message("$new"));
        expect(client.sendStateEvent).toHaveBeenCalledWith(
            roomId,
            EventType.RoomPinnedEvents,
            { pinned: ["$other", "$new"] },
            "",
        );
        expect(live).toEqual(["$other"]);
    });

    // grok host F3: a non-array value is invalid (`isPinned` and usePinnedEvents ignore it); spreading a string wrote
    // its characters as the room's list.
    it("a non-array pinned value is replaced, not spread into characters", async () => {
        // @ts-ignore deliberately invalid state content
        live = "$existing";
        await PinningUtils.pinOrUnpinEvent(client, message("$new"));
        expect(client.sendStateEvent).toHaveBeenCalledWith(
            roomId,
            EventType.RoomPinnedEvents,
            { pinned: ["$new"] },
            "",
        );
    });
    // grok r2 (host F1, track F1/F2, one root): the pin is the state write; the paired read-pins account-data write is a
    // side effect. Stock `Promise.all` followed whichever write failed first.
    describe("the read-pins account-data write is a side effect", () => {
        const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
            let resolve!: (v: T) => void;
            let reject!: (e: unknown) => void;
            const promise = new Promise<T>((res, rej) => {
                resolve = res;
                reject = rej;
            });
            return { promise, resolve, reject };
        };

        it("a failing account-data write does not fail a pin whose state write is accepted", async () => {
            vi.mocked(client.setRoomAccountData).mockRejectedValue(new Error("403 M_FORBIDDEN"));
            await expect(PinningUtils.pinOrUnpinEvent(client, message("$new"))).resolves.toBeUndefined();
            expect(client.sendStateEvent).toHaveBeenCalled();
        });

        it("the outcome waits for the state write although the account-data write failed long before", async () => {
            vi.mocked(client.setRoomAccountData).mockRejectedValue(new Error("500"));
            const state = deferred<{ event_id: string }>();
            vi.mocked(client.sendStateEvent).mockReturnValue(state.promise);
            let settled = false;
            const p = PinningUtils.pinOrUnpinEvent(client, message("$new")).finally(() => (settled = true));
            await new Promise((r) => setTimeout(r, 20));
            expect(settled).toBe(false);
            state.resolve({ event_id: "$state" });
            await expect(p).resolves.toBeUndefined();
        });

        it("a failing state write fails the pin, whatever the account-data write does", async () => {
            vi.mocked(client.sendStateEvent).mockRejectedValue(new Error("state 500"));
            await expect(PinningUtils.pinOrUnpinEvent(client, message("$new"))).rejects.toThrow("state 500");
        });
    });
});
