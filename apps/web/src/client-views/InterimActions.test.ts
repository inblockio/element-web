/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import {
    ClientEvent,
    ConnectionError,
    EventStatus,
    HTTPError,
    MatrixError,
    MatrixEvent,
    PendingEventOrdering,
    type MatrixClient,
    Room,
} from "matrix-js-sdk/src/matrix";
import { createTestClient } from "test-utils";

import { acceptInvite, declineInvite, joinRoom, sendText } from "./InterimActions";
import { ClientViewActionError } from "./types";
import { LocalRoom, LocalRoomState, LOCAL_ROOM_ID_PREFIX } from "../models/LocalRoom";
import defaultDispatcher from "../dispatcher/dispatcher";
import { createRoomFromLocalRoom } from "../utils/direct-messages";

vi.mock("../utils/direct-messages", () => ({ createRoomFromLocalRoom: vi.fn() }));

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
        await p;
    } catch (e) {
        expect(e).toBeInstanceOf(ClientViewActionError);
        return (e as ClientViewActionError).code;
    }
    return undefined;
};

describe("sendText (interim action, D16)", () => {
    let client: MatrixClient;
    let room: Room;
    let localRoom: LocalRoom;
    let dispatch: Mock;

    beforeEach(() => {
        vi.clearAllMocks();
        client = createTestClient();
        room = new Room("!a:example.org", client, "@me:example.org");
        localRoom = new LocalRoom(LOCAL_ROOM_ID_PREFIX + "dm", client, "@me:example.org");
        vi.mocked(client.getRoom).mockImplementation((id?: string) =>
            id === room.roomId ? room : id === localRoom.roomId ? localRoom : null,
        );
        vi.mocked(client.sendMessage).mockResolvedValue({ event_id: "$sent" });
        dispatch = vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => {}) as unknown as Mock;
    });

    it("sends a plain m.text with the kit's transaction id and resolves done with the event id", async () => {
        const outcome = await sendText(client, "!a:example.org", "**hello**", { txnId: "rc-id" });
        expect(client.sendMessage).toHaveBeenCalledWith(
            "!a:example.org",
            null,
            { msgtype: "m.text", body: "**hello**" },
            "rc-id",
        );
        expect(dispatch).toHaveBeenCalledWith({ action: "message_sent" });
        expect(outcome).toEqual({ status: "done", roomId: "!a:example.org", eventId: "$sent" });
    });

    it("rejects an unknown room, an empty text and a reply (A3 not implemented yet)", async () => {
        expect(await codeOf(sendText(client, "!nope:example.org", "hi"))).toBe("unknown_room");
        expect(await codeOf(sendText(client, "!a:example.org", "  "))).toBe("failed");
        expect(await codeOf(sendText(client, "!a:example.org", "hi", { replyTo: "$x" }))).toBe("unsupported");
        expect(client.sendMessage).not.toHaveBeenCalled();
    });

    it("maps client errors to the contract codes", async () => {
        const mx = vi.mocked(client.sendMessage);
        mx.mockRejectedValueOnce(new MatrixError({ errcode: "M_FORBIDDEN", error: "no" }, 403));
        expect(await codeOf(sendText(client, "!a:example.org", "hi"))).toBe("forbidden");
        mx.mockRejectedValueOnce(new ConnectionError("offline"));
        expect(await codeOf(sendText(client, "!a:example.org", "hi"))).toBe("network");
        mx.mockRejectedValueOnce(new HTTPError("boom", 500));
        expect(await codeOf(sendText(client, "!a:example.org", "hi"))).toBe("failed");
    });

    describe("local room (a new DM)", () => {
        it("creates the real room, sends there and resolves with the real room id", async () => {
            vi.mocked(createRoomFromLocalRoom).mockImplementation(async (_c, local) => {
                local.state = LocalRoomState.CREATED;
                local.actualRoomId = "!real:example.org";
                local.afterCreateCallbacks.forEach((cb) => cb("!real:example.org"));
                return "!real:example.org";
            });
            const outcome = await sendText(client, localRoom.roomId, "first", { txnId: "t1" });
            expect(createRoomFromLocalRoom).toHaveBeenCalledWith(client, localRoom);
            expect(client.sendMessage).toHaveBeenCalledWith(
                "!real:example.org",
                null,
                { msgtype: "m.text", body: "first" },
                "t1",
            );
            expect(outcome).toEqual({ status: "done", roomId: "!real:example.org", eventId: "$sent" });
        });

        it("rejects `failed` when the room cannot be created, instead of waiting forever", async () => {
            vi.mocked(createRoomFromLocalRoom).mockImplementation(async (_c, local) => {
                local.state = LocalRoomState.ERROR;
            });
            expect(await codeOf(sendText(client, localRoom.roomId, "first"))).toBe("failed");
            expect(client.sendMessage).not.toHaveBeenCalled();
        });

        // `createRoomFromLocalRoom` as Element has it: acts on a NEW room only, emits the state it sets.
        const fakeCreation = (): { fail: () => void; succeed: () => void; calls: () => number } => {
            let calls = 0;
            let settle: () => void = () => {};
            vi.mocked(createRoomFromLocalRoom).mockImplementation(async (c, local) => {
                if (!local.isNew) return;
                calls++;
                local.state = LocalRoomState.CREATING;
                c.emit(ClientEvent.Room, local);
                await new Promise<void>((r) => (settle = r));
            });
            return {
                calls: () => calls,
                fail: () => {
                    localRoom.state = LocalRoomState.ERROR;
                    client.emit(ClientEvent.Room, localRoom);
                    settle();
                },
                succeed: () => {
                    localRoom.state = LocalRoomState.CREATED;
                    localRoom.actualRoomId = "!real:example.org";
                    const cbs = localRoom.afterCreateCallbacks;
                    localRoom.afterCreateCallbacks = [];
                    cbs.forEach((cb) => cb("!real:example.org"));
                    client.emit(ClientEvent.Room, localRoom);
                    settle();
                },
            };
        };

        it("F1: a creation that settles without CREATED or ERROR is a failure for every waiter, and the room can be retried", async () => {
            // The stock handler throws past its own rejection handler: the room stays CREATING, the promise rejects.
            let rejectCreation: (e: Error) => void = () => {};
            vi.mocked(createRoomFromLocalRoom).mockImplementation(async (c, local) => {
                if (!local.isNew) return;
                local.state = LocalRoomState.CREATING;
                c.emit(ClientEvent.Room, local);
                await new Promise<void>((_, rej) => (rejectCreation = rej));
            });
            const first = codeOf(sendText(client, localRoom.roomId, "one"));
            const second = codeOf(sendText(client, localRoom.roomId, "two"));
            rejectCreation(new Error("startDm for local room did not return a room id"));
            expect(await first).toBe("failed");
            expect(await second).toBe("failed");
            expect(localRoom.state).toBe(LocalRoomState.ERROR);
            expect(localRoom.afterCreateCallbacks).toHaveLength(0);
            expect(client.sendMessage).not.toHaveBeenCalled();
        });

        it("H1: a second send while the room is being created rejects too when the creation fails", async () => {
            const creation = fakeCreation();
            const first = codeOf(sendText(client, localRoom.roomId, "one"));
            const second = codeOf(sendText(client, localRoom.roomId, "two"));
            expect(localRoom.state).toBe(LocalRoomState.CREATING);
            creation.fail();
            expect(await first).toBe("failed");
            expect(await second).toBe("failed");
            expect(creation.calls()).toBe(1);
            expect(client.sendMessage).not.toHaveBeenCalled();
        });

        it("H2: a rejected text leaves no queued callback; the next send retries the creation and sends only itself", async () => {
            const creation = fakeCreation();
            const first = codeOf(sendText(client, localRoom.roomId, "rejected"));
            creation.fail();
            expect(await first).toBe("failed");
            expect(localRoom.afterCreateCallbacks).toHaveLength(0);

            const retry = sendText(client, localRoom.roomId, "retried", { txnId: "t2" });
            expect(localRoom.state).toBe(LocalRoomState.CREATING);
            expect(creation.calls()).toBe(2);
            creation.succeed();
            expect(await retry).toEqual({ status: "done", roomId: "!real:example.org", eventId: "$sent" });
            expect(client.sendMessage).toHaveBeenCalledTimes(1);
            expect(client.sendMessage).toHaveBeenCalledWith(
                "!real:example.org",
                null,
                { msgtype: "m.text", body: "retried" },
                "t2",
            );
        });
    });

    it("H3: a failed sendMessage cancels its NOT_SENT pending event so the next send is not blocked", async () => {
        const detached = new Room("!d:example.org", client, "@me:example.org", {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });
        vi.mocked(client.getRoom).mockImplementation((id?: string) => (id === detached.roomId ? detached : null));
        const other = new MatrixEvent({ type: "m.room.message", content: { msgtype: "m.text", body: "hi" } });
        other.setStatus(EventStatus.NOT_SENT);
        detached.addPendingEvent(other, "unrelated");
        vi.mocked(client.sendMessage).mockImplementationOnce(async () => {
            const ev = new MatrixEvent({ type: "m.room.message", content: { msgtype: "m.text", body: "hi" } });
            ev.setTxnId("rc-1");
            ev.setStatus(EventStatus.NOT_SENT);
            detached.addPendingEvent(ev, "rc-1");
            throw new HTTPError("boom", 500);
        });
        expect(await codeOf(sendText(client, detached.roomId, "hi", { txnId: "rc-1" }))).toBe("failed");
        const cancelled = vi.mocked(client.cancelPendingEvent).mock.calls.map(([ev]) => ev.getTxnId());
        expect(cancelled).toEqual(["rc-1"]);
    });

    it("F2: sends with its own transaction id when none is given, and cancels only that pending event", async () => {
        const detached = new Room("!d:example.org", client, "@me:example.org", {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });
        vi.mocked(client.getRoom).mockImplementation((id?: string) => (id === detached.roomId ? detached : null));
        // A restored pending event with the same body, and one a rehydration adds while the send is in flight.
        const restored = new MatrixEvent({ type: "m.room.message", content: { msgtype: "m.text", body: "hi" } });
        restored.setTxnId("restored");
        restored.setStatus(EventStatus.NOT_SENT);
        detached.addPendingEvent(restored, "restored");
        vi.mocked(client.sendMessage).mockImplementationOnce(async (_room, _thread, content, txn) => {
            const ev = new MatrixEvent({ type: "m.room.message", content });
            ev.setTxnId(txn as string);
            ev.setStatus(EventStatus.NOT_SENT);
            detached.addPendingEvent(ev, txn as string);
            const late = new MatrixEvent({ type: "m.room.message", content });
            late.setTxnId("late");
            late.setStatus(EventStatus.NOT_SENT);
            detached.addPendingEvent(late, "late");
            throw new HTTPError("boom", 500);
        });
        expect(await codeOf(sendText(client, detached.roomId, "hi"))).toBe("failed");
        const sentTxn = vi.mocked(client.sendMessage).mock.calls[0][3];
        expect(sentTxn).toEqual(expect.any(String));
        expect(vi.mocked(client.cancelPendingEvent).mock.calls.map(([ev]) => ev.getTxnId())).toEqual([sentTxn]);
    });
});

describe("join, accept and decline (interim actions, D16)", () => {
    let client: MatrixClient;

    beforeEach(() => {
        client = createTestClient();
        vi.mocked(client.joinRoom).mockImplementation(async (id: string) => ({ roomId: id }) as unknown as Room);
        vi.mocked(client.getRoomIdForAlias).mockResolvedValue({ room_id: "!r:example.org", servers: ["example.org"] });
        vi.mocked(client.getRoom).mockImplementation((id?: string) =>
            id === "!inv:example.org" ? ({ roomId: id } as unknown as Room) : null,
        );
        vi.mocked(client.leave).mockResolvedValue({});
    });

    it("joins a room id, done with the joined room's id", async () => {
        await expect(joinRoom(client, "!r:example.org")).resolves.toEqual({ status: "done", roomId: "!r:example.org" });
        expect(client.joinRoom).toHaveBeenCalledWith("!r:example.org", undefined);
        expect(client.getRoomIdForAlias).not.toHaveBeenCalled();
    });

    it("resolves an alias first and joins through the servers that came with it, without a ViewRoom", async () => {
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
        await expect(joinRoom(client, " #lobby:example.org ")).resolves.toEqual({
            status: "done",
            roomId: "!r:example.org",
        });
        expect(client.getRoomIdForAlias).toHaveBeenCalledWith("#lobby:example.org");
        expect(client.joinRoom).toHaveBeenCalledWith("!r:example.org", { viaServers: ["example.org"] });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("maps a missing alias or room to unknown_room, a refusal to forbidden, a lost connection to network", async () => {
        vi.mocked(client.getRoomIdForAlias).mockRejectedValue(
            new MatrixError({ errcode: "M_NOT_FOUND", error: "no" }, 404),
        );
        expect(await codeOf(joinRoom(client, "#nope:example.org"))).toBe("unknown_room");
        vi.mocked(client.joinRoom).mockRejectedValue(new MatrixError({ errcode: "M_NOT_FOUND", error: "no" }, 404));
        expect(await codeOf(joinRoom(client, "!gone:example.org"))).toBe("unknown_room");
        vi.mocked(client.joinRoom).mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN", error: "no" }, 403));
        expect(await codeOf(joinRoom(client, "!priv:example.org"))).toBe("forbidden");
        vi.mocked(client.joinRoom).mockRejectedValue(new ConnectionError("offline"));
        expect(await codeOf(joinRoom(client, "!r:example.org"))).toBe("network");
    });

    it("refuses an address that is neither a room id nor an alias, without calling the client", async () => {
        expect(await codeOf(joinRoom(client, "lobby"))).toBe("unknown_room");
        expect(await codeOf(joinRoom(client, "   "))).toBe("unknown_room");
        expect(client.joinRoom).not.toHaveBeenCalled();
    });

    it("accepts an invite as the join of that room", async () => {
        await expect(acceptInvite(client, "!inv:example.org")).resolves.toEqual({
            status: "done",
            roomId: "!inv:example.org",
        });
        expect(client.joinRoom).toHaveBeenCalledWith("!inv:example.org", undefined);
    });

    it("declines an invite by leaving the room, unknown_room for a room the client does not have", async () => {
        await expect(declineInvite(client, "!inv:example.org")).resolves.toEqual({
            status: "done",
            roomId: "!inv:example.org",
        });
        expect(client.leave).toHaveBeenCalledWith("!inv:example.org");
        expect(await codeOf(declineInvite(client, "!none:example.org"))).toBe("unknown_room");
        vi.mocked(client.leave).mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN", error: "no" }, 403));
        expect(await codeOf(declineInvite(client, "!inv:example.org"))).toBe("forbidden");
    });
});
