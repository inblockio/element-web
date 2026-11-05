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
import { startDmOnFirstMessage } from "../utils/direct-messages";
import {
    createRoomViaDialog,
    forwardDialogClient,
    forwardViaDialog,
    viewSourceViaDialog,
    leaveViaDialog,
    startChatViaDialog,
    directoryViaDialog,
    startDmWithUser,
    DM_LOCK_CAP_MS,
    LEAVE_SETTLE_MS,
    ROOM_ACTION_TIMEOUT_MS,
} from "./RoomActions";
import { ClientViewActionError } from "./types";

vi.mock("../utils/direct-messages", () => ({
    startDmOnFirstMessage: vi.fn(),
    DirectoryMember: class {
        public constructor(private readonly result: { user_id: string; display_name?: string; avatar_url?: string }) {}
        public get userId(): string {
            return this.result.user_id;
        }
        public get name(): string {
            return this.result.display_name || this.result.user_id;
        }
        public getMxcAvatarUrl(): string | undefined {
            return this.result.avatar_url;
        }
    },
}));

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

describe("W1 / W5 directory and server search (Element's Spotlight over the kit)", () => {
    /** The bridge's room list as the directory sees it: `list` adds a room and tells the listeners. */
    const roomList = (
        listed: string[] = [],
        invited: string[] = [],
    ): {
        isListed: (id: string) => boolean;
        isInvited: (id: string) => boolean;
        onRooms: (cb: () => void) => () => void;
        list: (id: string) => void;
    } => {
        const ids = new Set(listed);
        const cbs = new Set<() => void>();
        return {
            isListed: (id) => ids.has(id),
            isInvited: (id) => invited.includes(id) && !ids.has(id),
            onRooms: (cb) => (cbs.add(cb), () => cbs.delete(cb)),
            list: (id) => (ids.add(id), cbs.forEach((cb) => cb())),
        };
    };
    /** What Spotlight's `viewRoom` dispatches for a public room row. */
    const pickRoom = (extra: Record<string, unknown>): void =>
        defaultDispatcher.dispatch(
            { action: Action.ViewRoom, metricsTrigger: "WebUnifiedSearch", room_alias: "#r:example.org", ...extra },
            true,
        );

    it("joins the picked public room: done once the room is listed", async () => {
        const rooms = roomList();
        const d = openDialogOnStart();
        const outcome = directoryViaDialog(
            "rooms",
            () => {
                d.start();
                pickRoom({ room_id: "!pub:example.org", auto_join: true });
            },
            rooms,
        );
        d.finish();
        await tick();
        await tick();
        rooms.list("!pub:example.org");
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!pub:example.org" });
    });

    it("is done at once for a room that is already listed, joined or not peeked", async () => {
        const d = openDialogOnStart();
        const outcome = directoryViaDialog(
            "rooms",
            () => {
                d.start();
                pickRoom({ room_id: "!mine:example.org", should_peek: true });
            },
            roomList(["!mine:example.org"]),
        );
        d.finish();
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!mine:example.org" });
    });

    it("is failed when the join fails (JoinRoomError for that room), and ignores another room's error", async () => {
        const d = openDialogOnStart();
        const outcome = directoryViaDialog(
            "rooms",
            () => {
                d.start();
                pickRoom({ room_id: "!pub:example.org", auto_join: true });
            },
            roomList(),
        );
        d.finish();
        await tick();
        await tick();
        defaultDispatcher.dispatch(
            { action: Action.JoinRoomError, roomId: "!other:example.org", err: new Error("other") },
            true,
        );
        defaultDispatcher.dispatch(
            { action: Action.JoinRoomError, roomId: "!pub:example.org", err: new Error("no") },
            true,
        );
        expect(await codeOf(outcome)).toBe("failed");
    });

    it("is failed when the joined room is not listed within 15 s", async () => {
        vi.useFakeTimers();
        try {
            const d = openDialogOnStart();
            const outcome = directoryViaDialog(
                "rooms",
                () => {
                    d.start();
                    pickRoom({ room_id: "!pub:example.org", auto_join: true });
                },
                roomList(),
            );
            const code = codeOf(outcome);
            d.finish();
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1);
            expect(await code).toBe("failed");
        } finally {
            vi.useRealTimers();
        }
    });

    it("waits for the re-dispatch that carries the id when only an alias was picked", async () => {
        const rooms = roomList();
        const d = openDialogOnStart();
        const outcome = directoryViaDialog(
            "rooms",
            () => {
                d.start();
                pickRoom({ auto_join: true });
            },
            rooms,
        );
        d.finish();
        await tick();
        await tick();
        // RoomViewStore resolved the alias and fires the payload again with the id.
        pickRoom({ room_id: "!pub:example.org", auto_join: true });
        await tick();
        rooms.list("!pub:example.org");
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!pub:example.org" });
    });

    it("is failed when the alias cannot be resolved (ViewRoomError)", async () => {
        const d = openDialogOnStart();
        const outcome = directoryViaDialog(
            "rooms",
            () => {
                d.start();
                pickRoom({ auto_join: true });
            },
            roomList(),
        );
        d.finish();
        await tick();
        await tick();
        defaultDispatcher.dispatch({ action: Action.ViewRoomError, room_id: null, room_alias: "#r:example.org" }, true);
        expect(await codeOf(outcome)).toBe("failed");
    });

    it("answers a world-readable room Element only peeks with peek: true", async () => {
        const d = openDialogOnStart();
        const outcome = directoryViaDialog(
            "rooms",
            () => {
                d.start();
                pickRoom({ room_id: "!open:example.org", should_peek: true });
            },
            roomList(),
        );
        d.finish();
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "!open:example.org", peek: true });
    });

    describe("an invited room picked from a plain Spotlight row (F1 round 2)", () => {
        it("is done with that room: the invitation is the room Element opened (no auto_join, no peek)", async () => {
            const d = openDialogOnStart();
            const outcome = directoryViaDialog(
                "rooms",
                () => {
                    d.start();
                    pickRoom({ room_id: "!inv:example.org" });
                },
                roomList([], ["!inv:example.org"]),
            );
            d.finish();
            await expect(outcome).resolves.toEqual({ status: "done", roomId: "!inv:example.org" });
        });

        it("still waits for the join when the row has auto_join: done only after the room is listed", async () => {
            const rooms = roomList([], ["!inv:example.org"]);
            const d = openDialogOnStart();
            let settled = false;
            const outcome = directoryViaDialog(
                "rooms",
                () => {
                    d.start();
                    pickRoom({ room_id: "!inv:example.org", auto_join: true });
                },
                rooms,
            ).finally(() => (settled = true));
            d.finish();
            await tick();
            await tick();
            expect(settled).toBe(false);
            rooms.list("!inv:example.org");
            await expect(outcome).resolves.toEqual({ status: "done", roomId: "!inv:example.org" });
        });

        it("keeps a room the user is not in (ask to join) failed", async () => {
            const d = openDialogOnStart();
            const outcome = directoryViaDialog(
                "rooms",
                () => {
                    d.start();
                    pickRoom({ room_id: "!knock:example.org" });
                },
                roomList([], ["!inv:example.org"]),
            );
            d.finish();
            expect(await codeOf(outcome)).toBe("failed");
        });
    });

    it("is failed for a room Element opens without joining or peeking it (ask to join)", async () => {
        const d = openDialogOnStart();
        const outcome = directoryViaDialog(
            "rooms",
            () => {
                d.start();
                pickRoom({ room_id: "!knock:example.org" });
            },
            roomList(),
        );
        d.finish();
        expect(await codeOf(outcome)).toBe("failed");
    });

    it("is cancelled when the dialog closes without a pick (an earlier or foreign ViewRoom is not one)", async () => {
        vi.useFakeTimers();
        try {
            const d = openDialogOnStart();
            const outcome = directoryViaDialog(
                "rooms",
                () => {
                    d.start();
                    viewRoom("!notification:example.org", "Notification");
                },
                roomList(),
            );
            d.finish();
            await vi.advanceTimersByTimeAsync(5_001);
            await expect(outcome).resolves.toEqual({ status: "cancelled" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("rooms: a person row's new chat, dispatched 2 s after the dialog closed, is awaited (the rooms filter lists people too)", async () => {
        vi.useFakeTimers();
        try {
            const d = openDialogOnStart();
            const outcome = directoryViaDialog("rooms", d.start, roomList());
            d.finish();
            await vi.advanceTimersByTimeAsync(2_000);
            viewRoom("local+late:example.org", undefined, [{}]);
            await expect(outcome).resolves.toEqual({ status: "done", roomId: "local+late:example.org" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("people: waits for the chat's ViewRoom after the dialog closed (startDmOnFirstMessage dispatches after resolveThreePids)", async () => {
        vi.useFakeTimers();
        try {
            const d = openDialogOnStart();
            const outcome = directoryViaDialog("people", d.start, roomList());
            d.finish();
            await vi.advanceTimersByTimeAsync(2_000);
            viewRoom("!dm:example.org", "MessageUser");
            await expect(outcome).resolves.toEqual({ status: "done", roomId: "!dm:example.org" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("people: a new chat is its local room", async () => {
        const d = openDialogOnStart();
        const outcome = directoryViaDialog(
            "people",
            () => {
                d.start();
                viewRoom("local+abc:example.org", undefined, [{}]);
            },
            roomList(),
        );
        d.finish();
        await expect(outcome).resolves.toEqual({ status: "done", roomId: "local+abc:example.org" });
    });

    it("people: closed with no chat within the wait is cancelled", async () => {
        vi.useFakeTimers();
        try {
            const d = openDialogOnStart();
            const outcome = directoryViaDialog("people", d.start, roomList());
            d.finish();
            await vi.advanceTimersByTimeAsync(5_001);
            await expect(outcome).resolves.toEqual({ status: "cancelled" });
        } finally {
            vi.useRealTimers();
        }
    });

    describe("a chat that Element opens after the wait gave up (resolveThreePids can be slow)", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });
        /** Closed with no pick, the wait over: the action has answered cancelled. */
        const cancelledDirectory = async (onLateChat: (id: string) => void): Promise<void> => {
            const d = openDialogOnStart();
            const outcome = directoryViaDialog("people", d.start, { ...roomList(), onLateChat });
            d.finish();
            await vi.advanceTimersByTimeAsync(5_001);
            await expect(outcome).resolves.toEqual({ status: "cancelled" });
        };

        it("tells the bridge the new chat's local room (only that, only within the window), so the kit can list it", async () => {
            const late = vi.fn();
            await cancelledDirectory(late);
            expect(late).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(3_000);
            viewRoom("!dm:example.org", "MessageUser");
            viewRoom("!n:example.org", "Notification");
            expect(late).not.toHaveBeenCalled();
            viewRoom("local+late:example.org", undefined, [{}]);
            await vi.advanceTimersByTimeAsync(0);
            expect(late).toHaveBeenCalledExactlyOnceWith("local+late:example.org");
            await vi.advanceTimersByTimeAsync(15_001);
            viewRoom("local+toolate:example.org", undefined, [{}]);
            await vi.advanceTimersByTimeAsync(0);
            expect(late).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
        });
    });

    describe("only a ViewRoom after the dialog opened is its pick", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it("ignores a room or person ViewRoom dispatched while `start` ran, before the dialog opened", async () => {
            const d = openDialogOnStart();
            const outcome = directoryViaDialog(
                "rooms",
                () => {
                    pickRoom({ room_id: "!old:example.org", auto_join: true });
                    viewRoom("!olddm:example.org", "MessageUser");
                    d.start();
                },
                roomList(),
            );
            d.finish();
            await vi.advanceTimersByTimeAsync(5_001);
            await expect(outcome).resolves.toEqual({ status: "cancelled" });
        });

        it("still takes the person pick dispatched after the dialog opened", async () => {
            const d = openDialogOnStart();
            const outcome = directoryViaDialog(
                "people",
                () => {
                    viewRoom("!olddm:example.org", "MessageUser");
                    d.start();
                    viewRoom("!newdm:example.org", "MessageUser");
                },
                roomList(),
            );
            d.finish();
            await vi.advanceTimersByTimeAsync(0);
            await expect(outcome).resolves.toEqual({ status: "done", roomId: "!newdm:example.org" });
        });

        it("does not take a Created ViewRoom (another room's creation) as a pick without a followed replacement", async () => {
            const d = openDialogOnStart();
            const outcome = directoryViaDialog(
                "rooms",
                () => {
                    d.start();
                    viewRoom("!other:example.org", "Created");
                },
                roomList(),
            );
            d.finish();
            await vi.advanceTimersByTimeAsync(5_001);
            await expect(outcome).resolves.toEqual({ status: "cancelled" });
        });
    });

    describe("Spotlight's Create new room button (F2 round 2: CreateRoom, then the Created ViewRoom)", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });
        const created = (roomId: string): void =>
            defaultDispatcher.dispatch(
                { action: Action.ViewRoom, room_id: roomId, metricsTrigger: "Created", joining: true },
                true,
            );

        it("is done with the room the dialog's Create new room made", async () => {
            const d = openDialogOnStart();
            const outcome = directoryViaDialog(
                "rooms",
                () => {
                    d.start();
                    defaultDispatcher.dispatch({ action: Action.CreateRoom, public: true }, true);
                    created("!new:example.org");
                },
                roomList(),
            );
            d.finish();
            await vi.advanceTimersByTimeAsync(0);
            await expect(outcome).resolves.toEqual({ status: "done", roomId: "!new:example.org" });
        });

        it("is done when the room is created up to 5 s after the user closed Spotlight during the create", async () => {
            const d = openDialogOnStart();
            const outcome = directoryViaDialog(
                "rooms",
                () => {
                    d.start();
                    defaultDispatcher.dispatch({ action: Action.CreateRoom, public: true }, true);
                },
                roomList(),
            );
            d.finish();
            await vi.advanceTimersByTimeAsync(4_000);
            created("!late:example.org");
            await vi.advanceTimersByTimeAsync(0);
            await expect(outcome).resolves.toEqual({ status: "done", roomId: "!late:example.org" });
        });

        it("does not take a Created ViewRoom as the pick when no CreateRoom was dispatched after the dialog opened", async () => {
            const d = openDialogOnStart();
            const outcome = directoryViaDialog(
                "rooms",
                () => {
                    // dispatched while `start` ran, before the dialog opened: not the dialog's create
                    defaultDispatcher.dispatch({ action: Action.CreateRoom, public: true }, true);
                    d.start();
                    created("!other:example.org");
                },
                roomList(),
            );
            d.finish();
            await vi.advanceTimersByTimeAsync(5_001);
            await expect(outcome).resolves.toEqual({ status: "cancelled" });
        });
    });

    it("clears the join-error timer once the picked room is listed (no 15 s timer is left behind)", async () => {
        vi.useFakeTimers();
        try {
            const rooms = roomList();
            const d = openDialogOnStart();
            const outcome = directoryViaDialog(
                "rooms",
                () => {
                    d.start();
                    pickRoom({ room_id: "!pub:example.org", auto_join: true });
                },
                rooms,
            );
            d.finish();
            await vi.advanceTimersByTimeAsync(1_000);
            rooms.list("!pub:example.org");
            await expect(outcome).resolves.toEqual({ status: "done", roomId: "!pub:example.org" });
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    describe("follows the group-chat dialog that replaces Spotlight (a static modal over a static modal)", () => {
        const fake = Modal as unknown as {
            createDialog: unknown;
            modals: object[];
            staticModal: object | null;
            emit: (e: string) => void;
        };
        const spotlight = {};
        const invite = {};
        /** Spotlight is static and its `finished` never resolves once the group-chat dialog overwrites it. */
        const spotlightOnStart = (): (() => void) => {
            fake.createDialog = vi.fn(() => {
                fake.staticModal = spotlight;
                return { close: vi.fn(), finished: new Promise<unknown[]>(() => {}) };
            });
            return () =>
                void (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {});
        };
        const replaceWithInvite = (): void => {
            fake.staticModal = invite;
            fake.emit("closed");
        };
        const closeInvite = (): void => {
            fake.staticModal = null;
            fake.emit("closed");
        };

        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            fake.staticModal = null;
            fake.modals = [];
            vi.useRealTimers();
        });

        it("holds the lock while the invite dialog is open, then awaits the new chat's ViewRoom", async () => {
            const outcome = directoryViaDialog("rooms", spotlightOnStart(), roomList());
            let settled = false;
            void outcome.then(
                () => (settled = true),
                () => (settled = true),
            );
            await vi.advanceTimersByTimeAsync(0);
            replaceWithInvite();
            // Past the post-close wait: Element still shows the invite dialog, so nothing is answered and the lock is held.
            await vi.advanceTimersByTimeAsync(6_000);
            expect(settled).toBe(false);
            expect(await codeOf(directoryViaDialog("rooms", () => {}, roomList()))).toBe("failed");
            // Go closes the dialog; `startDmOnFirstMessage` dispatches the chat after `resolveThreePids`.
            closeInvite();
            await vi.advanceTimersByTimeAsync(2_000);
            viewRoom("local+grp:example.org", undefined, [{}]);
            await expect(outcome).resolves.toEqual({ status: "done", roomId: "local+grp:example.org" });
        });

        it("a single threepid invite ends in the real room (trigger Created): done", async () => {
            const outcome = directoryViaDialog("rooms", spotlightOnStart(), roomList());
            await vi.advanceTimersByTimeAsync(0);
            replaceWithInvite();
            await vi.advanceTimersByTimeAsync(6_000);
            closeInvite();
            await vi.advanceTimersByTimeAsync(1_000);
            viewRoom("!made:example.org", "Created");
            await expect(outcome).resolves.toEqual({ status: "done", roomId: "!made:example.org" });
        });

        it("the invite dialog closed with no chat is cancelled, and frees the lock", async () => {
            const outcome = directoryViaDialog("rooms", spotlightOnStart(), roomList());
            let settled = false;
            void outcome.then(
                () => (settled = true),
                () => (settled = true),
            );
            await vi.advanceTimersByTimeAsync(0);
            replaceWithInvite();
            await vi.advanceTimersByTimeAsync(6_000);
            expect(settled).toBe(false);
            closeInvite();
            await vi.advanceTimersByTimeAsync(5_001);
            await expect(outcome).resolves.toEqual({ status: "cancelled" });
            const d = openDialogOnStart();
            const next = directoryViaDialog("rooms", d.start, roomList());
            d.finish();
            await vi.advanceTimersByTimeAsync(5_001);
            await expect(next).resolves.toEqual({ status: "cancelled" });
        });
    });

    it("runs one dialog action at a time and frees the lock after a cancel", async () => {
        vi.useFakeTimers();
        try {
            const d = openDialogOnStart();
            const first = directoryViaDialog("rooms", d.start, roomList());
            expect(await codeOf(directoryViaDialog("rooms", () => {}, roomList()))).toBe("failed");
            d.finish();
            await vi.advanceTimersByTimeAsync(5_001);
            await expect(first).resolves.toEqual({ status: "cancelled" });
            const d2 = openDialogOnStart();
            const second = directoryViaDialog("rooms", d2.start, roomList());
            d2.finish();
            await vi.advanceTimersByTimeAsync(5_001);
            await expect(second).resolves.toEqual({ status: "cancelled" });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("M11 Y4 start a DM with a user (Element's startDmOnFirstMessage, the message menu's Reply directly)", () => {
    // The client holds no rooms and no users unless a test says so (`rooms`, `users`).
    let rooms: unknown[] = [];
    let users: Record<string, unknown> = {};
    const client = {
        getUserId: () => "@me:example.org",
        getRooms: () => rooms,
        getUser: (id: string) => users[id] ?? null,
    } as unknown as MatrixClient;
    const startDm = vi.mocked(startDmOnFirstMessage);
    const targetsOf = (call: number): string[] =>
        (startDm.mock.calls[call][1] as unknown as Array<{ userId: string }>).map((t) => t.userId);
    const targetOf = (call: number): { userId: string; name: string; getMxcAvatarUrl: () => string | undefined } =>
        (startDm.mock.calls[call][1] as unknown as Array<ReturnType<typeof targetOf>>)[0];
    const member = (membership: string, rawDisplayName: string, mxc: string | null = null): unknown => ({
        membership,
        rawDisplayName,
        getMxcAvatarUrl: () => mxc,
    });
    /** A room of ours in which `userId` is the given member. */
    const roomWith = (userId: string, m: unknown): unknown => ({
        getMember: (id: string) => (id === userId ? m : null),
    });

    beforeEach(() => {
        startDm.mockReset();
        rooms = [];
        users = {};
    });

    it("is done with the room of an existing DM that Element returns", async () => {
        startDm.mockResolvedValue("!dm:example.org");
        await expect(startDmWithUser(client, "@bob:example.org")).resolves.toEqual({
            status: "done",
            roomId: "!dm:example.org",
        });
        expect(startDm).toHaveBeenCalledTimes(1);
        expect(startDm.mock.calls[0][0]).toBe(client);
        expect(targetsOf(0)).toEqual(["@bob:example.org"]);
    });

    it("is done with the local room of a new DM that Element returns (nothing sent yet)", async () => {
        startDm.mockResolvedValue("local+abc:example.org");
        await expect(startDmWithUser(client, "@carol:example.org")).resolves.toEqual({
            status: "done",
            roomId: "local+abc:example.org",
        });
    });

    describe("M12 Z2 the new chat is titled with the person's name (stock passes display_name + avatar_url)", () => {
        beforeEach(() => startDm.mockResolvedValue("local+abc:example.org"));

        it("hands over the display name and avatar of the joined member of a shared room, as stock does", async () => {
            rooms = [roomWith("@bob:example.org", member("join", "Bob Builder", "mxc://example.org/bob"))];
            await startDmWithUser(client, "@bob:example.org");
            expect(targetOf(0).userId).toBe("@bob:example.org");
            expect(targetOf(0).name).toBe("Bob Builder");
            expect(targetOf(0).getMxcAvatarUrl()).toBe("mxc://example.org/bob");
        });

        it("takes the first room that names the user, skipping rooms where they are unknown, left, or only the id", async () => {
            rooms = [
                { getMember: () => null },
                roomWith("@bob:example.org", member("leave", "Bob Left", "mxc://example.org/left")),
                roomWith("@bob:example.org", member("join", "@bob:example.org")),
                roomWith("@bob:example.org", member("join", "Bob Builder", "mxc://example.org/bob")),
                roomWith("@bob:example.org", member("join", "Bobby", "mxc://example.org/other")),
            ];
            await startDmWithUser(client, "@bob:example.org");
            expect(targetOf(0).name).toBe("Bob Builder");
            expect(targetOf(0).getMxcAvatarUrl()).toBe("mxc://example.org/bob");
        });

        it("falls back to the client's own User when no shared room names them", async () => {
            rooms = [roomWith("@bob:example.org", member("join", "@bob:example.org"))];
            users = { "@bob:example.org": { rawDisplayName: "Bob Builder", avatarUrl: "mxc://example.org/user" } };
            await startDmWithUser(client, "@bob:example.org");
            expect(targetOf(0).name).toBe("Bob Builder");
            expect(targetOf(0).getMxcAvatarUrl()).toBe("mxc://example.org/user");
        });

        it("keeps an avatar the member has when only the id is known as a name", async () => {
            rooms = [roomWith("@bob:example.org", member("join", "@bob:example.org", "mxc://example.org/bob"))];
            await startDmWithUser(client, "@bob:example.org");
            expect(targetOf(0).name).toBe("@bob:example.org");
            expect(targetOf(0).getMxcAvatarUrl()).toBe("mxc://example.org/bob");
        });

        it("an unknown user still starts with the id as the name and no avatar", async () => {
            rooms = [roomWith("@dave:example.org", member("join", "Dave"))];
            await expect(startDmWithUser(client, "@bob:example.org")).resolves.toEqual({
                status: "done",
                roomId: "local+abc:example.org",
            });
            expect(targetsOf(0)).toEqual(["@bob:example.org"]);
            expect(targetOf(0).name).toBe("@bob:example.org");
            expect(targetOf(0).getMxcAvatarUrl()).toBeUndefined();
        });

        it("makes no server call: only the rooms and users the client already holds are read", async () => {
            const getProfileInfo = vi.fn();
            const spy = { ...client, getProfileInfo } as unknown as MatrixClient;
            rooms = [roomWith("@bob:example.org", member("join", "Bob Builder"))];
            await startDmWithUser(spy, "@bob:example.org");
            expect(getProfileInfo).not.toHaveBeenCalled();
        });
    });

    it("fails at once for the own user id: no Element call, no self-DM", async () => {
        expect(await codeOf(startDmWithUser(client, "@me:example.org"))).toBe("failed");
        expect(startDm).not.toHaveBeenCalled();
    });

    it("fails at once for a malformed user id (empty, a display name, no server part, whitespace, not a string)", async () => {
        for (const bad of [
            "",
            "bob",
            "@bob",
            "@:example.org",
            "@bob :example.org",
            "!room:example.org",
            undefined,
            7,
        ]) {
            expect(await codeOf(startDmWithUser(client, bad as unknown as string))).toBe("failed");
        }
        expect(startDm).not.toHaveBeenCalled();
    });

    it("fails when Element gives no room", async () => {
        startDm.mockResolvedValue(null);
        expect(await codeOf(startDmWithUser(client, "@bob:example.org"))).toBe("failed");
    });

    it("runs one dialog action at a time: an overlapping call fails busy, the first still finishes, the lock is freed", async () => {
        let resolveFirst: (roomId: string | null) => void = () => {};
        startDm.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
        const first = startDmWithUser(client, "@bob:example.org");
        expect(await codeOf(startDmWithUser(client, "@carol:example.org"))).toBe("failed");
        expect(startDm).toHaveBeenCalledTimes(1);
        resolveFirst("!dm:example.org");
        await expect(first).resolves.toEqual({ status: "done", roomId: "!dm:example.org" });
        startDm.mockResolvedValue("!dm2:example.org");
        await expect(startDmWithUser(client, "@carol:example.org")).resolves.toEqual({
            status: "done",
            roomId: "!dm2:example.org",
        });
    });

    describe("a start that outlasts the 15 s answer (F1: the late ViewRoom must not meet an unlocked host)", () => {
        const nativeTimeout = setTimeout;
        const flushNode = (): Promise<void> => new Promise((resolve) => nativeTimeout(resolve, 0));
        const messageOf = async (p: Promise<unknown>): Promise<string> => {
            try {
                await p;
            } catch (e) {
                return (e as Error).message;
            }
            return "";
        };
        let unhandled: unknown[];
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };
        beforeEach(() => {
            unhandled = [];
            process.on("unhandledRejection", onUnhandled);
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
            process.off("unhandledRejection", onUnhandled);
        });

        it("fails a rejecting start with a plain sentence, not Element's error, and frees the lock", async () => {
            startDm.mockRejectedValueOnce(new Error("M_UNKNOWN: boom at /_matrix/client/v3/createRoom"));
            expect(await codeOf(startDmWithUser(client, "@bob:example.org"))).toBe("failed");
            startDm.mockRejectedValueOnce(new Error("secret internals"));
            const message = await messageOf(startDmWithUser(client, "@bob:example.org"));
            expect(message).toBe("Element could not open a chat with @bob:example.org");
            expect(message).not.toContain("secret internals");
            startDm.mockImplementationOnce(() => {
                throw new Error("sync internals");
            });
            expect(await messageOf(startDmWithUser(client, "@bob:example.org"))).toBe(
                "Element could not open a chat with @bob:example.org",
            );
            startDm.mockResolvedValue("!dm:example.org");
            await expect(startDmWithUser(client, "@bob:example.org")).resolves.toEqual({
                status: "done",
                roomId: "!dm:example.org",
            });
            await flushNode();
            expect(unhandled).toEqual([]);
        });

        it("answers failed at 15 s, holds the lock until the start settles, then lists the late local room and frees the lock", async () => {
            let resolveStart: (roomId: string | null) => void = () => {};
            startDm.mockImplementationOnce(() => new Promise((resolve) => (resolveStart = resolve)));
            const onLateChat = vi.fn();
            const first = startDmWithUser(client, "@bob:example.org", onLateChat);
            const firstMessage = messageOf(first);
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1);
            expect(await firstMessage).toBe("Element did not open the chat in time");
            expect(onLateChat).not.toHaveBeenCalled();

            // Held: every dialog action (a second DM, the start-chat dialog) answers the busy failure and starts nothing.
            await vi.advanceTimersByTimeAsync(20_000);
            const start = vi.fn();
            expect(await messageOf(startDmWithUser(client, "@carol:example.org"))).toBe(
                "another Element dialog action is running",
            );
            expect(await messageOf(startChatViaDialog(start))).toBe("another Element dialog action is running");
            expect(start).not.toHaveBeenCalled();
            expect(startDm).toHaveBeenCalledTimes(1);

            // The late room: listed through the late-chat path, the caller is not told; the lock is freed.
            resolveStart("local+late:example.org");
            await vi.advanceTimersByTimeAsync(0);
            expect(onLateChat).toHaveBeenCalledTimes(1);
            expect(onLateChat).toHaveBeenCalledWith("local+late:example.org");
            startDm.mockResolvedValue("!dm2:example.org");
            await expect(startDmWithUser(client, "@carol:example.org")).resolves.toEqual({
                status: "done",
                roomId: "!dm2:example.org",
            });
            await flushNode();
            expect(unhandled).toEqual([]);
        });

        it("does not list a late room that is not a local one (an existing DM is listed already)", async () => {
            let resolveStart: (roomId: string | null) => void = () => {};
            startDm.mockImplementationOnce(() => new Promise((resolve) => (resolveStart = resolve)));
            const onLateChat = vi.fn();
            const late = messageOf(startDmWithUser(client, "@bob:example.org", onLateChat));
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1);
            await late;
            resolveStart("!existing:example.org");
            await vi.advanceTimersByTimeAsync(0);
            expect(onLateChat).not.toHaveBeenCalled();
        });

        it("a late rejection frees the lock and is not an unhandled rejection", async () => {
            let rejectStart: (e: unknown) => void = () => {};
            startDm.mockImplementationOnce(() => new Promise((_, reject) => (rejectStart = reject)));
            const onLateChat = vi.fn();
            const late = messageOf(startDmWithUser(client, "@bob:example.org", onLateChat));
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1);
            expect(await late).toBe("Element did not open the chat in time");
            expect(await messageOf(startDmWithUser(client, "@carol:example.org"))).toBe(
                "another Element dialog action is running",
            );
            rejectStart(new Error("device lookup failed"));
            await vi.advanceTimersByTimeAsync(0);
            await flushNode();
            expect(unhandled).toEqual([]);
            expect(onLateChat).not.toHaveBeenCalled();
            startDm.mockResolvedValue("!dm:example.org");
            await expect(startDmWithUser(client, "@carol:example.org")).resolves.toEqual({
                status: "done",
                roomId: "!dm:example.org",
            });
        });

        it("frees the lock at the 60 s cap for a start that never settles, and lists a room that arrives after it", async () => {
            let resolveStart: (roomId: string | null) => void = () => {};
            startDm.mockImplementationOnce(() => new Promise((resolve) => (resolveStart = resolve)));
            const onLateChat = vi.fn();
            const hung = messageOf(startDmWithUser(client, "@bob:example.org", onLateChat));
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1);
            expect(await hung).toBe("Element did not open the chat in time");
            await vi.advanceTimersByTimeAsync(DM_LOCK_CAP_MS - ROOM_ACTION_TIMEOUT_MS - 2);
            expect(await messageOf(startDmWithUser(client, "@carol:example.org"))).toBe(
                "another Element dialog action is running",
            );
            await vi.advanceTimersByTimeAsync(2);
            startDm.mockResolvedValue("!dm:example.org");
            await expect(startDmWithUser(client, "@carol:example.org")).resolves.toEqual({
                status: "done",
                roomId: "!dm:example.org",
            });
            // Released at the cap does not mean forgotten: the room that still arrives is listed.
            resolveStart("local+verylate:example.org");
            await vi.advanceTimersByTimeAsync(0);
            expect(onLateChat).toHaveBeenCalledWith("local+verylate:example.org");
        });

        it("a late release never frees a later holder's lock", async () => {
            let resolveFirst: (roomId: string | null) => void = () => {};
            startDm.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
            const first = messageOf(startDmWithUser(client, "@bob:example.org"));
            await vi.advanceTimersByTimeAsync(DM_LOCK_CAP_MS + 1);
            await first;
            let resolveSecond: (roomId: string | null) => void = () => {};
            startDm.mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
            const second = startDmWithUser(client, "@carol:example.org");
            await vi.advanceTimersByTimeAsync(0);
            resolveFirst("local+first:example.org");
            await vi.advanceTimersByTimeAsync(0);
            expect(await messageOf(startDmWithUser(client, "@dave:example.org"))).toBe(
                "another Element dialog action is running",
            );
            resolveSecond("!dm:example.org");
            await expect(second).resolves.toEqual({ status: "done", roomId: "!dm:example.org" });
        });
    });
});
