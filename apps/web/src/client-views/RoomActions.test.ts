/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventStatus, type MatrixClient, type MatrixEvent } from "matrix-js-sdk/src/matrix";

import Modal from "../Modal";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import {
    createRoomViaDialog,
    forwardDialogClient,
    forwardViaDialog,
    viewSourceViaDialog,
    leaveViaDialog,
    startChatViaDialog,
    LEAVE_SETTLE_MS,
    ROOM_ACTION_TIMEOUT_MS,
} from "./RoomActions";
import { ClientViewActionError } from "./types";

vi.mock("../Modal", async () => {
    // A fake ModalManager: an emitter with the three private places Element keeps its dialogs in.
    const { EventEmitter } = await import("events");
    const manager = Object.assign(new EventEmitter(), {
        createDialog: vi.fn(),
        modals: [] as object[],
        priorityModal: null as object | null,
        staticModal: null as object | null,
    });
    return { default: manager, ModalManagerEvent: { Opened: "opened", Closed: "closed" } };
});

/** A dialog the fake Modal opens: `finish` is the dialog's own result (`[]` = closed without an answer). */
function openDialogOnStart(): {
    finish: (...result: unknown[]) => void;
    start: (view?: unknown) => void;
    view: () => unknown;
} {
    let view: unknown;
    let finish: (...result: unknown[]) => void = () => {};
    const finished = new Promise<unknown[]>((resolve) => {
        finish = (...result) => resolve(result);
    });
    const original = vi.fn(() => ({ close: vi.fn(), finished }));
    (Modal as unknown as { createDialog: unknown }).createDialog = original;
    return {
        finish,
        // What MatrixChat does after the view-model's dispatch: Modal.createDialog, read through whatever is installed.
        start: (v) => {
            view = v;
            (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {});
        },
        view: () => view,
    };
}

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
        await p;
    } catch (e) {
        expect(e).toBeInstanceOf(ClientViewActionError);
        return (e as ClientViewActionError).code;
    }
    return undefined;
};

const viewRoom = (room_id: string, metricsTrigger?: string, targets?: unknown[]): void =>
    defaultDispatcher.dispatch({ action: Action.ViewRoom, room_id, metricsTrigger, targets }, true);

describe("A6 create room (RoomListViewModel.createRoom -> Element's dialog)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("is done with the new room's id when Element creates it after the dialog's confirmation", async () => {
        const d = openDialogOnStart();
        const outcome = createRoomViaDialog(d.start);
        d.finish(true, { name: "x" });
        await vi.advanceTimersByTimeAsync(0);
        viewRoom("!new:example.org", "Created");
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!new:example.org" });
    });

    it("ignores a ViewRoom that is not the created room and waits for the Created one", async () => {
        const d = openDialogOnStart();
        const outcome = createRoomViaDialog(d.start);
        d.finish(true, {});
        await vi.advanceTimersByTimeAsync(0);
        viewRoom("!other:example.org", "RoomList");
        viewRoom("!new:example.org", "Created");
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!new:example.org" });
    });

    it("ignores a ViewRoom and a JoinRoomError that came before the confirmation (other rooms, not this create)", async () => {
        const d = openDialogOnStart();
        const outcome = createRoomViaDialog(d.start);
        viewRoom("!notified:example.org", "Created");
        defaultDispatcher.dispatch({ action: Action.JoinRoomError, room_id: "!other:example.org" }, true);
        await vi.advanceTimersByTimeAsync(0);
        d.finish(true, {});
        await vi.advanceTimersByTimeAsync(0);
        viewRoom("!new:example.org", "Created");
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!new:example.org" });
    });

    it("ignores a JoinRoomError of another room's failed join after the confirmation (it carries err), fails on the create's own", async () => {
        const d = openDialogOnStart();
        const outcome = createRoomViaDialog(d.start);
        d.finish(true, {});
        await vi.advanceTimersByTimeAsync(0);
        defaultDispatcher.dispatch(
            { action: Action.JoinRoomError, roomId: "!other:example.org", err: new Error("no") },
            true,
        );
        viewRoom("!new:example.org", "Created");
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!new:example.org" });
        const d2 = openDialogOnStart();
        const own = createRoomViaDialog(d2.start);
        d2.finish(true, {});
        await vi.advanceTimersByTimeAsync(0);
        defaultDispatcher.dispatch({ action: Action.JoinRoomError, roomId: "!x:example.org" }, true);
        expect(await codeOf(own)).toBe("failed");
    });

    it("is cancelled from the dialog's own answer, for a refusal and for a close without an answer", async () => {
        for (const result of [[false], []]) {
            const d = openDialogOnStart();
            const outcome = createRoomViaDialog(d.start);
            d.finish(...result);
            await expect(outcome).resolves.toEqual({ status: "cancelled" });
        }
    });

    it("fails when Element reports the creation failed (its error dialog and JoinRoomError)", async () => {
        const d = openDialogOnStart();
        const outcome = createRoomViaDialog(d.start);
        d.finish(true, {});
        await vi.advanceTimersByTimeAsync(0);
        defaultDispatcher.dispatch({ action: Action.JoinRoomError }, true);
        expect(await codeOf(outcome)).toBe("failed");
    });

    it("fails after 15 s without the created room, never cancelled", async () => {
        const d = openDialogOnStart();
        const outcome = createRoomViaDialog(d.start);
        d.finish(true, {});
        const code = codeOf(outcome);
        await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1);
        expect(await code).toBe("failed");
    });

    it("fails when no dialog opens, and puts Modal.createDialog back", async () => {
        const marker = vi.fn();
        (Modal as unknown as { createDialog: unknown }).createDialog = marker;
        const code = codeOf(createRoomViaDialog(() => {}));
        await vi.advanceTimersByTimeAsync(6000);
        expect(await code).toBe("failed");
        expect((Modal as unknown as { createDialog: unknown }).createDialog).toBe(marker);
    });

    it("puts Modal.createDialog back once the dialog is open, and the dialog still opens as before", async () => {
        const d = openDialogOnStart();
        const installed = (Modal as unknown as { createDialog: unknown }).createDialog;
        const outcome = createRoomViaDialog(d.start);
        expect(installed).toHaveBeenCalledTimes(1);
        expect((Modal as unknown as { createDialog: unknown }).createDialog).toBe(installed);
        d.finish(false);
        await outcome;
    });

    it("runs one dialog action at a time", async () => {
        const d = openDialogOnStart();
        const first = createRoomViaDialog(d.start);
        const second = codeOf(createRoomViaDialog(() => {}));
        expect(await second).toBe("failed");
        d.finish(false);
        await first;
    });
});

describe("A6 start chat (RoomListViewModel.createChatRoom -> Element's invite dialog)", () => {
    it("is done with the room the dialog showed: an existing DM", async () => {
        const d = openDialogOnStart();
        const outcome = startChatViaDialog(() => {
            d.start();
            viewRoom("!dm:example.org", "MessageUser");
        });
        d.finish(true);
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!dm:example.org" });
    });

    it("is done with the local room of a new chat", async () => {
        const d = openDialogOnStart();
        const outcome = startChatViaDialog(() => {
            d.start();
            viewRoom("local+abc:example.org", undefined, [{}]);
        });
        d.finish(true);
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "local+abc:example.org" });
    });

    it("waits for the chat's ViewRoom when Element dispatches it after the dialog's answer (its dispatch is async)", async () => {
        vi.useFakeTimers();
        try {
            const d = openDialogOnStart();
            const outcome = startChatViaDialog(d.start);
            d.finish(true);
            await vi.advanceTimersByTimeAsync(0);
            viewRoom("local+dm", undefined, [{}]);
            await expect(outcome).resolves.toEqual({ status: "done", roomId: "local+dm" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("takes the chat's own ViewRoom, not a notification click or an answered call before Go", async () => {
        const d = openDialogOnStart();
        const outcome = startChatViaDialog(() => {
            d.start();
            viewRoom("!notified:example.org", "Notification");
            defaultDispatcher.dispatch(
                { action: Action.ViewRoom, room_id: "!call:example.org", view_call: true },
                true,
            );
            viewRoom("local+new:example.org", undefined, [{}]);
        });
        d.finish(true);
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "local+new:example.org" });
    });

    it("is done with the room startDm created for a single email invite (trigger Created, a real room id)", async () => {
        const d = openDialogOnStart();
        const outcome = startChatViaDialog(() => {
            d.start();
            viewRoom("!emailroom:example.org", "Created");
        });
        d.finish(true);
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!emailroom:example.org" });
    });

    it("is cancelled when the dialog closes without success", async () => {
        const d = openDialogOnStart();
        const outcome = startChatViaDialog(d.start);
        d.finish(false);
        await expect(outcome).resolves.toEqual({ status: "cancelled" });
    });

    it("fails when the dialog reports success but no room is shown", async () => {
        vi.useFakeTimers();
        try {
            const d = openDialogOnStart();
            const outcome = startChatViaDialog(d.start);
            d.finish(true);
            const code = codeOf(outcome);
            await vi.advanceTimersByTimeAsync(6000);
            expect(await code).toBe("failed");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("A7 leave (RoomListItemViewModel.onLeaveRoom -> Element's confirm)", () => {
    let membership: string;
    const client = { getRoom: () => ({ getMyMembership: () => membership }) } as unknown as MatrixClient;
    const afterLeave = (room_id: string): void =>
        defaultDispatcher.dispatch({ action: Action.AfterLeaveRoom, room_id }, true);

    beforeEach(() => {
        vi.useFakeTimers();
        membership = "join";
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("is done once the confirm said yes, Element left and the membership dropped", async () => {
        const d = openDialogOnStart();
        const outcome = leaveViaDialog(client, "!a:example.org", d.start);
        d.finish(true);
        await vi.advanceTimersByTimeAsync(0);
        membership = "leave";
        afterLeave("!a:example.org");
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!a:example.org" });
    });

    it("is cancelled when the confirm says no", async () => {
        const d = openDialogOnStart();
        const outcome = leaveViaDialog(client, "!a:example.org", d.start);
        d.finish(false);
        await expect(outcome).resolves.toEqual({ status: "cancelled" });
    });

    it("fails when Element reports the leave finished but the user is still in the room (its error dialog)", async () => {
        const d = openDialogOnStart();
        const outcome = leaveViaDialog(client, "!a:example.org", d.start);
        d.finish(true);
        await vi.advanceTimersByTimeAsync(0);
        afterLeave("!a:example.org");
        const code = codeOf(outcome);
        await vi.advanceTimersByTimeAsync(LEAVE_SETTLE_MS + 200);
        expect(await code).toBe("failed");
    });

    it("fails for an invite whose leave failed: it is still an invite, not left", async () => {
        membership = "invite";
        const d = openDialogOnStart();
        const outcome = leaveViaDialog(client, "!a:example.org", d.start);
        d.finish(true);
        await vi.advanceTimersByTimeAsync(0);
        afterLeave("!a:example.org");
        const code = codeOf(outcome);
        await vi.advanceTimersByTimeAsync(LEAVE_SETTLE_MS + 200);
        expect(await code).toBe("failed");
    });

    it("is done for an invite that went to leave, and for a room that is gone", async () => {
        for (const after of ["leave", "ban", undefined]) {
            membership = "invite";
            const gone = after === undefined;
            const c = {
                getRoom: () => (gone && membership === "gone" ? null : { getMyMembership: () => membership }),
            } as unknown as MatrixClient;
            const d = openDialogOnStart();
            const outcome = leaveViaDialog(c, "!a:example.org", d.start);
            d.finish(true);
            await vi.advanceTimersByTimeAsync(0);
            membership = after ?? "gone";
            afterLeave("!a:example.org");
            await expect(outcome).resolves.toEqual({ status: "done", roomId: "!a:example.org" });
        }
    });

    it("ignores another room's AfterLeaveRoom and fails after 15 s", async () => {
        const d = openDialogOnStart();
        const outcome = leaveViaDialog(client, "!a:example.org", d.start);
        d.finish(true);
        await vi.advanceTimersByTimeAsync(0);
        afterLeave("!b:example.org");
        const code = codeOf(outcome);
        await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1);
        expect(await code).toBe("failed");
    });
});

/**
 * A client whose rooms keep a detached pending list, as Element's do: `cancelPendingEvent` removes from it. Its
 * `sendEvent` leaves a NOT_SENT echo with the call's txnId in the target room and rejects, as a failed send does.
 */
function forwardClient(
    rooms: Record<string, MatrixEvent[]> = {},
    sourceType = "m.room.message",
): MatrixClient & { rawSend: ReturnType<typeof vi.fn> } {
    // The forwarded event "$e" sits in the source room "!a:example.org".
    const sourceRoom = {
        roomId: "!a:example.org",
        getPendingEvents: () => [],
        findEventById: (id: string) => (id === "$e" ? { getType: () => sourceType } : undefined),
    };
    let n = 0;
    const rawSend = vi.fn((roomId: string, ...rest: unknown[]) => {
        // Overloads: (roomId, type, content, txnId?) and (roomId, threadId | null, type, content, txnId?).
        const threaded = rest[0] === null || (typeof rest[0] === "string" && rest[0].startsWith("$"));
        rooms[roomId].push(pendingEvent(EventStatus.NOT_SENT, rest[threaded ? 3 : 2] as string | undefined));
        return Promise.reject(new Error("send failed"));
    });
    return {
        rawSend,
        sendEvent: rawSend,
        makeTxnId: () => `txn${++n}`,
        getRoom: (roomId: string) =>
            rooms[roomId]
                ? { roomId, getPendingEvents: () => rooms[roomId] }
                : roomId === sourceRoom.roomId
                  ? sourceRoom
                  : null,
        getRooms: () => Object.keys(rooms).map((roomId) => ({ roomId, getPendingEvents: () => rooms[roomId] })),
        cancelPendingEvent: vi.fn((ev: MatrixEvent) => {
            for (const list of Object.values(rooms)) {
                const i = list.indexOf(ev);
                if (i >= 0) list.splice(i, 1);
            }
        }),
    } as unknown as MatrixClient & { rawSend: ReturnType<typeof vi.fn> };
}

const pendingEvent = (status: EventStatus, txnId?: string): MatrixEvent =>
    ({ status, getTxnId: () => txnId }) as unknown as MatrixEvent;

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("E3 forward (Element's forward dialog over the kit)", () => {
    it("is done with the source room and event when the dialog closes without a jump", async () => {
        const d = openDialogOnStart();
        const outcome = forwardViaDialog(forwardClient(), "!a:example.org", "$e", d.start);
        d.finish();
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!a:example.org", eventId: "$e" });
    });

    it("is done with the jumped-to room when the dialog's room name dispatched ViewRoom (H5)", async () => {
        const d = openDialogOnStart();
        const outcome = forwardViaDialog(forwardClient(), "!a:example.org", "$e", d.start);
        viewRoom("!b:example.org", "WebForwardShortcut");
        d.finish();
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!b:example.org" });
    });

    it("takes a jump dispatched one tick after the dialog closed, and ignores other ViewRoom triggers", async () => {
        const d = openDialogOnStart();
        const outcome = forwardViaDialog(forwardClient(), "!a:example.org", "$e", d.start);
        viewRoom("!other:example.org", "MessageUser");
        d.finish();
        setTimeout(() => viewRoom("!b:example.org", "WebForwardShortcut"), 0);
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!b:example.org" });
        const d2 = openDialogOnStart();
        const second = forwardViaDialog(forwardClient(), "!a:example.org", "$e", d2.start);
        viewRoom("!other:example.org", "MessageUser");
        d2.finish();
        await expect(second).resolves.toEqual({ status: "done", roomId: "!a:example.org", eventId: "$e" });
    });

    describe("cancels exactly the echo of the dialog's own failed send", () => {
        // The dialog's client view when the code under test hands one to `start`; the real client otherwise (the old global wrap).
        const viewOf = (d: { view: () => unknown }, c: MatrixClient): MatrixClient => (d.view() ?? c) as MatrixClient;
        const send = (v: MatrixClient, ...args: unknown[]): Promise<unknown> =>
            (v.sendEvent as unknown as (...a: unknown[]) => Promise<unknown>).apply(v, args).catch((e: Error) => e);

        it("a send failing while the dialog is open: its echo is cancelled, the rejection still reaches the dialog", async () => {
            const rooms: Record<string, MatrixEvent[]> = { "!b:example.org": [] };
            const c = forwardClient(rooms);
            const d = openDialogOnStart();
            const outcome = forwardViaDialog(c, "!a:example.org", "$e", d.start);
            await tick();
            const copy = { body: "x" };
            const result = await send(viewOf(d, c), "!b:example.org", "m.room.message", copy);
            expect(result).toBeInstanceOf(Error);
            expect(c.rawSend).toHaveBeenCalledWith("!b:example.org", "m.room.message", copy, "txn1");
            expect(c.cancelPendingEvent).toHaveBeenCalledTimes(1);
            expect(rooms["!b:example.org"]).toEqual([]);
            d.finish();
            await outcome;
        });

        it("(a) copies with DIFFERENT content objects (ForwardDialog rebuilds `content` on every render) are all cancelled", async () => {
            const rooms: Record<string, MatrixEvent[]> = { "!b:example.org": [], "!c:example.org": [] };
            const c = forwardClient(rooms);
            const d = openDialogOnStart();
            const outcome = forwardViaDialog(c, "!a:example.org", "$e", d.start);
            await tick();
            const v = viewOf(d, c);
            await send(v, "!b:example.org", "m.room.message", { body: "x" });
            await send(v, "!c:example.org", "m.room.message", { body: "x" });
            expect(c.cancelPendingEvent).toHaveBeenCalledTimes(2);
            expect(rooms["!b:example.org"]).toEqual([]);
            expect(rooms["!c:example.org"]).toEqual([]);
            d.finish();
            await outcome;
        });

        it("(b) a beacon-info forward, whose dialog sends the latest pulse as m.room.message, is cancelled on failure", async () => {
            const rooms: Record<string, MatrixEvent[]> = { "!b:example.org": [] };
            const c = forwardClient(rooms, "org.matrix.msc3672.beacon_info");
            const d = openDialogOnStart();
            const outcome = forwardViaDialog(c, "!a:example.org", "$e", d.start);
            await tick();
            await send(viewOf(d, c), "!b:example.org", "m.room.message", { msgtype: "m.location", body: "geo" });
            expect(c.cancelPendingEvent).toHaveBeenCalledTimes(1);
            expect(rooms["!b:example.org"]).toEqual([]);
            d.finish();
            await outcome;
        });

        it("a send failing after the dialog closed: its echo is cancelled", async () => {
            const rooms: Record<string, MatrixEvent[]> = { "!b:example.org": [] };
            const c = forwardClient(rooms);
            let fail: (e: Error) => void = () => {};
            c.rawSend.mockImplementation((roomId: string, _t: string, _c: unknown, txnId?: string) => {
                rooms[roomId].push(pendingEvent(EventStatus.SENDING, txnId));
                return new Promise((_, reject) => (fail = reject));
            });
            const d = openDialogOnStart();
            const outcome = forwardViaDialog(c, "!a:example.org", "$e", d.start);
            await tick();
            const sent = send(viewOf(d, c), "!b:example.org", "m.room.message", { body: "x" });
            d.finish();
            await outcome;
            expect(c.cancelPendingEvent).not.toHaveBeenCalled();
            (rooms["!b:example.org"][0] as { status: EventStatus }).status = EventStatus.NOT_SENT; // the SDK's catch
            fail(new Error("late failure"));
            await sent;
            expect(c.cancelPendingEvent).toHaveBeenCalledTimes(1);
            expect(rooms["!b:example.org"]).toEqual([]);
        });

        it("a NOT_SENT echo the dialog did not send (restored by the store meanwhile) is untouched", async () => {
            const restored = pendingEvent(EventStatus.NOT_SENT, "stored-txn");
            const rooms: Record<string, MatrixEvent[]> = { "!b:example.org": [] };
            const c = forwardClient(rooms);
            const d = openDialogOnStart();
            const outcome = forwardViaDialog(c, "!a:example.org", "$e", d.start);
            await tick();
            rooms["!b:example.org"].push(restored);
            await send(viewOf(d, c), "!b:example.org", "m.room.message", { body: "x" });
            d.finish();
            await outcome;
            expect(c.cancelPendingEvent).toHaveBeenCalledTimes(1);
            expect(c.cancelPendingEvent).not.toHaveBeenCalledWith(restored);
            expect(rooms["!b:example.org"]).toEqual([restored]);
        });

        it("two failed sends in one room: both echoes are cancelled", async () => {
            const rooms: Record<string, MatrixEvent[]> = { "!b:example.org": [] };
            const c = forwardClient(rooms);
            const d = openDialogOnStart();
            const outcome = forwardViaDialog(c, "!a:example.org", "$e", d.start);
            await tick();
            const v = viewOf(d, c);
            await Promise.all([
                send(v, "!b:example.org", "m.room.message", { body: "1" }),
                send(v, "!b:example.org", "m.room.message", { body: "2" }),
            ]);
            expect(c.cancelPendingEvent).toHaveBeenCalledTimes(2);
            expect(rooms["!b:example.org"]).toEqual([]);
            d.finish();
            await outcome;
        });

        it("keeps the txnId of a call that carries one, and gives one in the right slot of both overloads when it has none", async () => {
            const rooms: Record<string, MatrixEvent[]> = { "!b:example.org": [] };
            const c = forwardClient(rooms);
            c.rawSend.mockImplementation(() => Promise.resolve({ event_id: "$ok" }));
            const d = openDialogOnStart();
            const outcome = forwardViaDialog(c, "!a:example.org", "$e", d.start);
            await tick();
            const v = viewOf(d, c);
            const copy = { body: "x" };
            await send(v, "!b:example.org", "m.room.message", copy, "mine");
            await send(v, "!b:example.org", "m.room.message", copy);
            await send(v, "!b:example.org", null, "m.room.message", copy);
            await send(v, "!b:example.org", "$thread", "m.room.message", copy, "mine2");
            expect(c.rawSend.mock.calls).toEqual([
                ["!b:example.org", "m.room.message", copy, "mine"],
                ["!b:example.org", "m.room.message", copy, "txn1"],
                ["!b:example.org", null, "m.room.message", copy, "txn2"],
                ["!b:example.org", "$thread", "m.room.message", copy, "mine2"],
            ]);
            d.finish();
            await outcome;
        });

        describe("leaves every send on the real client alone while the dialog is open", () => {
            // Each rejects like a failed send and leaves a NOT_SENT echo; none may be touched (Element retries them).
            const otherSend = async (args: unknown[]) => {
                const rooms: Record<string, MatrixEvent[]> = { "!b:example.org": [] };
                const c = forwardClient(rooms);
                const d = openDialogOnStart();
                const original = c.sendEvent;
                const outcome = forwardViaDialog(c, "!a:example.org", "$e", d.start);
                await tick();
                expect(c.sendEvent).toBe(original); // never replaced
                await send(c, "!b:example.org", ...args);
                const sent = [...c.rawSend.mock.calls[0]];
                const kept = rooms["!b:example.org"].length;
                d.finish();
                await outcome;
                return { c, sent, kept };
            };

            it("a sendMessage-style 5-arg send (threadId null) with a caller txnId", async () => {
                const args = [null, "m.room.message", { body: "file" }, "upload-txn"];
                const { c, sent, kept } = await otherSend(args);
                expect(c.cancelPendingEvent).not.toHaveBeenCalled();
                expect(kept).toBe(1);
                expect(sent).toEqual(["!b:example.org", ...args]);
            });

            it("the same without a caller txnId gets none injected", async () => {
                const args = [null, "m.room.message", { body: "file" }];
                const { c, sent, kept } = await otherSend(args);
                expect(c.cancelPendingEvent).not.toHaveBeenCalled();
                expect(kept).toBe(1);
                expect(sent).toEqual(["!b:example.org", ...args]);
            });

            it("a threaded send", async () => {
                const args = ["$thread", "m.room.message", { body: "in thread" }];
                const { c, sent, kept } = await otherSend(args);
                expect(c.cancelPendingEvent).not.toHaveBeenCalled();
                expect(kept).toBe(1);
                expect(sent).toEqual(["!b:example.org", ...args]);
            });

            it("a reaction", async () => {
                const args = ["m.reaction", { "m.relates_to": { key: "x" } }];
                const { c, sent, kept } = await otherSend(args);
                expect(c.cancelPendingEvent).not.toHaveBeenCalled();
                expect(kept).toBe(1);
                expect(sent).toEqual(["!b:example.org", ...args]);
            });

            it("(c) a widget's 3-arg send of the same type as the forward: no txnId injected, nothing cancelled", async () => {
                const args = ["m.room.message", { body: "from a widget" }];
                const { c, sent, kept } = await otherSend(args);
                expect(c.cancelPendingEvent).not.toHaveBeenCalled();
                expect(kept).toBe(1);
                expect(sent).toEqual(["!b:example.org", ...args]);
            });
        });

        it("the dialog's client view is the real client for everything but sendEvent", async () => {
            class Real {
                readonly userId = "@me:example.org";
                getSafeUserId(): string {
                    return this.userId;
                }
                sendEvent = vi.fn(() => Promise.resolve({}));
                makeTxnId = () => "t";
                getRoom = () => null;
            }
            const real = new Real() as unknown as MatrixClient;
            const view = forwardDialogClient(real);
            expect(view instanceof Real).toBe(true);
            const { getSafeUserId } = view; // detached: still runs on the real client
            expect(getSafeUserId()).toBe("@me:example.org");
            expect(view.getSafeUserId).toBe(view.getSafeUserId);
            expect((view as unknown as Real).userId).toBe("@me:example.org");
            expect(view.sendEvent).not.toBe(real.sendEvent);
            expect(real.sendEvent).toBeDefined();
        });

        it("fails and opens nothing for the client when the dialog never opens", async () => {
            const c = forwardClient({});
            const original = c.sendEvent;
            vi.useFakeTimers();
            try {
                const never = codeOf(forwardViaDialog(c, "!a:example.org", "$e", () => {}));
                await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1);
                expect(await never).toBe("failed");
            } finally {
                vi.useRealTimers();
            }
            expect(c.sendEvent).toBe(original);
        });
    });

    it("fails when the dialog never opens", async () => {
        vi.useFakeTimers();
        try {
            const outcome = forwardViaDialog(forwardClient(), "!a:example.org", "$e", () => {});
            const code = codeOf(outcome);
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1);
            expect(await code).toBe("failed");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("E5 view source (Element's ViewSource dialog over the kit)", () => {
    it("is done with the message when the dialog closes", async () => {
        const d = openDialogOnStart();
        const outcome = viewSourceViaDialog("!a:example.org", "$e", d.start);
        d.finish();
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!a:example.org", eventId: "$e" });
    });

    it("fails when the dialog never opens", async () => {
        vi.useFakeTimers();
        try {
            const outcome = viewSourceViaDialog("!a:example.org", "$e", () => {});
            const code = codeOf(outcome);
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1);
            expect(await code).toBe("failed");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("E5 view source released when Element drops the dialog (Modal.tsx wipes the stack on a priority close)", () => {
    it("ends done when a priority dialog closes over it, and the next dialog action is not refused", async () => {
        const fake = Modal as unknown as {
            createDialog: unknown;
            modals: object[];
            emit: (e: string) => void;
        };
        // A dialog that never reports `finished`, as ViewSource under a priority dialog that closed.
        fake.createDialog = vi.fn(() => {
            fake.modals.unshift({});
            return { close: vi.fn(), finished: new Promise<unknown[]>(() => {}) };
        });
        const start = () =>
            void (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {});
        const outcome = viewSourceViaDialog("!a:example.org", "$e", start);
        await Promise.resolve();
        // The priority dialog opened over it and was dismissed: Modal.tsx sets `modals = []` and emits `closed`.
        fake.modals = [];
        fake.emit("closed");
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!a:example.org", eventId: "$e" });

        const d = openDialogOnStart();
        const next = viewSourceViaDialog("!a:example.org", "$f", d.start);
        d.finish();
        await expect(next).resolves.toEqual({ status: "done", roomId: "!a:example.org", eventId: "$f" });
    });
});

describe("a confirmed dialog answer wins over the drop signal (Modal.tsx resolves `finished`, then emits `closed`, on one stack)", () => {
    /** A dialog held in the fake modal stack; `confirm` does what ModalManager.getCloseFn does: resolve, remove, emit. */
    function stackedDialog(): { confirm: (...result: unknown[]) => void; start: () => void } {
        const fake = Modal as unknown as { createDialog: unknown; modals: object[]; emit: (e: string) => void };
        const modal = {};
        let resolve: (r: unknown[]) => void = () => {};
        const finished = new Promise<unknown[]>((r) => (resolve = r));
        fake.createDialog = vi.fn(() => {
            fake.modals.unshift(modal);
            return { close: vi.fn(), finished };
        });
        return {
            confirm: (...result) => {
                resolve(result);
                fake.modals = fake.modals.filter((m) => m !== modal);
                fake.emit("closed");
            },
            start: () =>
                void (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {}),
        };
    }

    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("create room: the confirmed dialog is not answered as cancelled", async () => {
        const d = stackedDialog();
        const outcome = createRoomViaDialog(d.start);
        await vi.advanceTimersByTimeAsync(0);
        d.confirm(true, { name: "x" });
        await vi.advanceTimersByTimeAsync(0);
        viewRoom("!new:example.org", "Created");
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!new:example.org" });
    });

    it("start chat: the confirmed dialog is not answered as cancelled", async () => {
        const d = stackedDialog();
        const outcome = startChatViaDialog(() => {
            d.start();
            viewRoom("!dm:example.org", "MessageUser");
        });
        await vi.advanceTimersByTimeAsync(0);
        d.confirm(true);
        await vi.advanceTimersByTimeAsync(0);
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!dm:example.org" });
    });

    it("leave: the confirmed dialog is not answered as cancelled", async () => {
        let membership = "join";
        const client = { getRoom: () => ({ getMyMembership: () => membership }) } as unknown as MatrixClient;
        const d = stackedDialog();
        const outcome = leaveViaDialog(client, "!a:example.org", d.start);
        await vi.advanceTimersByTimeAsync(0);
        d.confirm(true);
        await vi.advanceTimersByTimeAsync(0);
        membership = "leave";
        defaultDispatcher.dispatch({ action: Action.AfterLeaveRoom, room_id: "!a:example.org" }, true);
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!a:example.org" });
    });

    it("a dialog wiped without an answer still ends as closed (the timer is cleared once settled)", async () => {
        const fake = Modal as unknown as { createDialog: unknown; modals: object[]; emit: (e: string) => void };
        const d = stackedDialog();
        const outcome = createRoomViaDialog(d.start);
        await vi.advanceTimersByTimeAsync(0);
        fake.modals = [];
        fake.emit("closed");
        await vi.advanceTimersByTimeAsync(0);
        await expect(outcome).resolves.toEqual({ status: "cancelled" });
        expect(vi.getTimerCount()).toBe(0);
    });
});
