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

import { editText, redact, sendText } from "./InterimActions";
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

    it("rejects an unknown room and an empty text", async () => {
        expect(await codeOf(sendText(client, "!nope:example.org", "hi"))).toBe("unknown_room");
        expect(await codeOf(sendText(client, "!a:example.org", "  "))).toBe("failed");
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

    it("F1 (A1 follow-up): a retry with the same transaction id sends after a failed send", async () => {
        const detached = new Room("!d:example.org", client, "@me:example.org", {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });
        vi.mocked(client.getRoom).mockImplementation((id?: string) => (id === detached.roomId ? detached : null));
        // A client whose failed send leaves the NOT_SENT echo, and whose cancel keeps `txnToEvent` (as the SDK does).
        vi.mocked(client.sendMessage).mockImplementationOnce(async (_r, _t, content, txn) => {
            const ev = new MatrixEvent({ type: "m.room.message", content });
            ev.setTxnId(txn as string);
            ev.setStatus(EventStatus.NOT_SENT);
            detached.addPendingEvent(ev, txn as string);
            throw new ConnectionError("offline");
        });
        expect(await codeOf(sendText(client, detached.roomId, "hi", { txnId: "rc-9" }))).toBe("network");
        expect(detached.getEventForTxnId("rc-9")).toBeUndefined();
        // The retry reaches the client (the real SDK would otherwise throw "known txnId" from addPendingEvent).
        vi.mocked(client.sendMessage).mockImplementationOnce(async (_r, _t, content, txn) => {
            const ev = new MatrixEvent({ type: "m.room.message", content });
            ev.setTxnId(txn as string);
            ev.setStatus(EventStatus.SENDING);
            detached.addPendingEvent(ev, txn as string);
            return { event_id: "$retried" };
        });
        expect(await sendText(client, detached.roomId, "hi", { txnId: "rc-9" })).toEqual({
            status: "done",
            roomId: detached.roomId,
            eventId: "$retried",
        });
    });

    it("F1 (A1 follow-up): a transaction id that already has a local echo is refused, the echo is never cancelled", async () => {
        const detached = new Room("!d:example.org", client, "@me:example.org", {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });
        vi.mocked(client.getRoom).mockImplementation((id?: string) => (id === detached.roomId ? detached : null));
        const before = new MatrixEvent({ type: "m.room.message", content: { msgtype: "m.text", body: "old" } });
        before.setTxnId("rc-7");
        before.setStatus(EventStatus.NOT_SENT);
        detached.addPendingEvent(before, "rc-7");
        expect(await codeOf(sendText(client, detached.roomId, "new", { txnId: "rc-7" }))).toBe("failed");
        expect(client.sendMessage).not.toHaveBeenCalled();
        expect(client.cancelPendingEvent).not.toHaveBeenCalled();
        expect(detached.getEventForTxnId("rc-7")).toBe(before);
    });
});

describe("A3 reply (sendText with replyTo)", () => {
    let client: MatrixClient;
    let room: Room;
    let dispatch: Mock;
    const target = () =>
        new MatrixEvent({
            type: "m.room.message",
            room_id: "!a:example.org",
            event_id: "$target",
            sender: "@bob:example.org",
            content: { msgtype: "m.text", body: "question" },
        });

    beforeEach(() => {
        vi.clearAllMocks();
        client = createTestClient();
        room = new Room("!a:example.org", client, "@me:example.org");
        vi.mocked(client.getRoom).mockImplementation((id?: string) => (id === room.roomId ? room : null));
        vi.mocked(client.sendMessage).mockResolvedValue({ event_id: "$sent" });
        dispatch = vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => {}) as unknown as Mock;
    });

    it("sends the reply relation and the replied sender's mention as SendMessageComposer builds them", async () => {
        const ev = target();
        vi.spyOn(room, "findEventById").mockReturnValue(ev);
        const onReplyTarget = vi.fn();
        const outcome = await sendText(
            client,
            room.roomId,
            "answer",
            { txnId: "rc-1", replyTo: "$target" },
            { onReplyTarget },
        );
        expect(onReplyTarget).toHaveBeenCalledWith(ev);
        expect(client.sendMessage).toHaveBeenCalledWith(
            room.roomId,
            null,
            {
                "msgtype": "m.text",
                "body": "answer",
                "m.mentions": { user_ids: ["@bob:example.org"] },
                "m.relates_to": { "m.in_reply_to": { event_id: "$target" } },
            },
            "rc-1",
        );
        expect(outcome).toEqual({ status: "done", roomId: room.roomId, eventId: "$sent" });
        // The reply state goes with the queued message.
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "reply_to_event", event: null }));
    });

    it("fetches a target outside the loaded window", async () => {
        vi.spyOn(room, "findEventById").mockReturnValue(undefined);
        vi.mocked(client.fetchRoomEvent).mockResolvedValue({
            type: "m.room.message",
            room_id: room.roomId,
            event_id: "$old",
            sender: "@carol:example.org",
            content: { msgtype: "m.text", body: "old" },
        });
        await sendText(client, room.roomId, "late answer", { replyTo: "$old" });
        expect(client.fetchRoomEvent).toHaveBeenCalledWith(room.roomId, "$old");
        const content = vi.mocked(client.sendMessage).mock.calls[0][2] as Record<string, any>;
        expect(content["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$old" } });
        expect(content["m.mentions"]).toEqual({ user_ids: ["@carol:example.org"] });
    });

    it("is unknown_event, and sends nothing, when the target cannot be loaded", async () => {
        vi.spyOn(room, "findEventById").mockReturnValue(undefined);
        vi.mocked(client.fetchRoomEvent).mockRejectedValue(new MatrixError({ errcode: "M_NOT_FOUND" }, 404));
        const onReplyTarget = vi.fn();
        expect(await codeOf(sendText(client, room.roomId, "x", { replyTo: "$gone" }, { onReplyTarget }))).toBe(
            "unknown_event",
        );
        expect(client.sendMessage).not.toHaveBeenCalled();
        expect(onReplyTarget).not.toHaveBeenCalled();
    });

    it("a refused reply leaves no pending echo and rejects forbidden", async () => {
        vi.spyOn(room, "findEventById").mockReturnValue(target());
        vi.mocked(client.sendMessage).mockRejectedValueOnce(new MatrixError({ errcode: "M_FORBIDDEN" }, 403));
        expect(await codeOf(sendText(client, room.roomId, "x", { replyTo: "$target" }))).toBe("forbidden");
    });
});

describe("A11 editText and A12 redact (interim)", () => {
    let client: MatrixClient;
    let room: Room;
    let dispatch: Mock;
    const own = (content: Record<string, unknown> = { msgtype: "m.text", body: "first" }, id = "$mine") =>
        new MatrixEvent({
            type: "m.room.message",
            room_id: "!a:example.org",
            event_id: id,
            sender: "@me:example.org",
            content,
        });

    beforeEach(() => {
        vi.clearAllMocks();
        client = createTestClient();
        vi.mocked(client.getUserId).mockReturnValue("@me:example.org");
        vi.mocked(client.getSafeUserId).mockReturnValue("@me:example.org");
        room = new Room("!a:example.org", client, "@me:example.org");
        vi.mocked(client.getRoom).mockImplementation((id?: string) => (id === room.roomId ? room : null));
        vi.mocked(client.sendMessage).mockResolvedValue({ event_id: "$replacement" });
        vi.mocked(client.redactEvent).mockResolvedValue({ event_id: "$redaction" });
        dispatch = vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => {}) as unknown as Mock;
    });

    describe("editText", () => {
        it("sends the replacement as Element's plain edit composer builds it and resolves with the ORIGINAL id", async () => {
            vi.spyOn(room, "findEventById").mockReturnValue(own());
            const onEnter = vi.fn();
            const outcome = await editText(client, room.roomId, "$mine", "second", { onEnter });
            expect(outcome).toEqual({ status: "done", roomId: room.roomId, eventId: "$mine" });
            expect(onEnter).toHaveBeenCalledTimes(1);
            expect(client.sendMessage).toHaveBeenCalledWith(
                room.roomId,
                null,
                {
                    "msgtype": "m.text",
                    "body": "* second",
                    "m.new_content": { "msgtype": "m.text", "body": "second", "m.mentions": {} },
                    "m.mentions": {},
                    "m.relates_to": { rel_type: "m.replace", event_id: "$mine" },
                },
                expect.any(String),
            );
        });

        it("keeps an emote an emote and copies an existing link preview bundle onto m.new_content", async () => {
            vi.spyOn(room, "findEventById").mockReturnValue(
                own({
                    "msgtype": "m.emote",
                    "body": "waves",
                    "com.beeper.linkpreviews": [{ matched_url: "https://x.y" }],
                }),
            );
            await editText(client, room.roomId, "$mine", "waves hard");
            const content = vi.mocked(client.sendMessage).mock.calls[0][2] as Record<string, any>;
            expect(content.msgtype).toBe("m.emote");
            expect(content["m.new_content"].msgtype).toBe("m.emote");
            expect(content["m.new_content"]["com.beeper.linkpreviews"]).toEqual([{ matched_url: "https://x.y" }]);
        });

        it("is forbidden for another user's message and for one canEditContent refuses; blank is failed; nothing is sent", async () => {
            vi.spyOn(room, "findEventById").mockReturnValue(
                new MatrixEvent({
                    type: "m.room.message",
                    room_id: room.roomId,
                    event_id: "$theirs",
                    sender: "@bob:example.org",
                    content: { msgtype: "m.text", body: "x" },
                }),
            );
            expect(await codeOf(editText(client, room.roomId, "$theirs", "mine now"))).toBe("forbidden");
            vi.spyOn(room, "findEventById").mockReturnValue(own({ msgtype: "m.image", body: "a.png" }));
            expect(await codeOf(editText(client, room.roomId, "$mine", "x"))).toBe("forbidden");
            vi.spyOn(room, "findEventById").mockReturnValue(own());
            expect(await codeOf(editText(client, room.roomId, "$mine", "   "))).toBe("failed");
            expect(await codeOf(editText(client, "!nope:example.org", "$mine", "x"))).toBe("unknown_room");
            expect(client.sendMessage).not.toHaveBeenCalled();
        });

        it("is unknown_event when the event cannot be loaded", async () => {
            vi.spyOn(room, "findEventById").mockReturnValue(undefined);
            vi.mocked(client.fetchRoomEvent).mockRejectedValue(new MatrixError({ errcode: "M_NOT_FOUND" }, 404));
            expect(await codeOf(editText(client, room.roomId, "$gone", "x"))).toBe("unknown_event");
            expect(client.sendMessage).not.toHaveBeenCalled();
        });

        it("cancels an earlier queued replacement first, and a refused edit leaves no pending echo", async () => {
            const ev = own();
            const queued = new MatrixEvent({ type: "m.room.message", content: {} });
            queued.setStatus(EventStatus.QUEUED);
            vi.spyOn(ev, "replacingEvent").mockReturnValue(queued);
            vi.spyOn(room, "findEventById").mockReturnValue(ev);
            vi.mocked(client.sendMessage).mockRejectedValueOnce(new MatrixError({ errcode: "M_FORBIDDEN" }, 403));
            expect(await codeOf(editText(client, room.roomId, "$mine", "again"))).toBe("forbidden");
            expect(client.cancelPendingEvent).toHaveBeenCalledWith(queued);
            // the edit state is ended either way
            expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "edit_event", event: null }));
        });
    });

    describe("redact", () => {
        it("redacts the user's own event and resolves done once the call resolves", async () => {
            vi.spyOn(room, "findEventById").mockReturnValue(own());
            expect(await redact(client, room.roomId, "$mine")).toEqual({
                status: "done",
                roomId: room.roomId,
                eventId: "$mine",
            });
            expect(client.redactEvent).toHaveBeenCalledWith(room.roomId, "$mine");
        });

        it("is forbidden for another user's event even with redact power, and does not call the client", async () => {
            const theirs = new MatrixEvent({
                type: "m.room.message",
                room_id: room.roomId,
                event_id: "$theirs",
                sender: "@bob:example.org",
                content: { msgtype: "m.text", body: "x" },
            });
            vi.spyOn(room, "findEventById").mockReturnValue(theirs);
            expect(await codeOf(redact(client, room.roomId, "$theirs"))).toBe("forbidden");
            expect(client.redactEvent).not.toHaveBeenCalled();
        });

        it("is unknown_event for an event that cannot be loaded, without calling redactEvent", async () => {
            vi.spyOn(room, "findEventById").mockReturnValue(undefined);
            vi.mocked(client.fetchRoomEvent).mockRejectedValue(new MatrixError({ errcode: "M_NOT_FOUND" }, 404));
            expect(await codeOf(redact(client, room.roomId, "$gone"))).toBe("unknown_event");
            expect(client.redactEvent).not.toHaveBeenCalled();
        });

        it("maps a rejection and cancels the local redaction it left", async () => {
            const ev = own();
            const local = new MatrixEvent({ type: "m.room.redaction", content: {} });
            local.setStatus(EventStatus.NOT_SENT);
            vi.spyOn(ev, "localRedactionEvent").mockReturnValue(local);
            vi.spyOn(room, "findEventById").mockReturnValue(ev);
            vi.mocked(client.redactEvent).mockRejectedValueOnce(new MatrixError({ errcode: "M_FORBIDDEN" }, 403));
            expect(await codeOf(redact(client, room.roomId, "$mine"))).toBe("forbidden");
            expect(client.cancelPendingEvent).toHaveBeenCalledWith(local);
        });
    });
});
