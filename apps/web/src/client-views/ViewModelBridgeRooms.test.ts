/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ClientEvent, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { ViewModelBridge } from "./ViewModelBridge";
import { ClientViewActionError } from "./types";
import { LOCAL_ROOM_ID_PREFIX, LocalRoomState } from "../models/LocalRoom";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";

/* A6 / A7 / A5 on the bridge: which view-model action each method calls and what the room list shows around it. */
const h = vi.hoisted(() => {
    class FakeVm<S> {
        public listeners = new Set<() => void>();
        public constructor(public snapshot: S) {}
        public getSnapshot = (): S => this.snapshot;
        public subscribe = (cb: () => void): (() => void) => {
            this.listeners.add(cb);
            return () => this.listeners.delete(cb);
        };
        public set(s: Partial<S>): void {
            this.snapshot = { ...this.snapshot, ...s };
            this.listeners.forEach((cb) => cb());
        }
        public dispose = vi.fn();
    }
    const item = Object.assign(
        new FakeVm({
            id: "!a:example.org",
            name: "General",
            isDm: false,
            notification: { hasUnreadCount: false, count: 0, isMention: false, invited: false },
        }),
        { onLeaveRoom: vi.fn() },
    );
    const invited = new FakeVm({
        id: "!inv:example.org",
        name: "Invited",
        isDm: false,
        notification: { hasUnreadCount: false, count: 0, isMention: false, invited: true },
    });
    const list = { createRoom: vi.fn(), createChatRoom: vi.fn() };
    const current = { a: item as unknown as { getSnapshot: () => object; subscribe: (cb: () => void) => () => void } };
    const lists: Array<{ set: (s: object) => void }> = [];
    const headers: Record<string, { isExpanded: boolean }> = {};
    return { FakeVm, item, invited, list, current, lists, headers, ids: ["!a:example.org", "!inv:example.org"] };
});

vi.mock("../viewmodels/room-list/RoomListViewModel", () => ({
    RoomListViewModel: class extends h.FakeVm<{ sections: { roomIds: string[] }[] }> {
        public constructor() {
            super({ sections: [{ id: "recent", roomIds: h.ids }] });
            h.lists.push(this);
        }
        public updateVisibleRooms = vi.fn();
        public getSectionHeaderViewModel = (id: string) => (h.headers[id] ??= { isExpanded: true });
        public createRoom = h.list.createRoom;
        public createChatRoom = h.list.createChatRoom;
        public getRoomItemViewModel = (id: string) =>
            id === "!a:example.org" ? h.current.a : id === "!inv:example.org" ? h.invited : undefined;
    },
}));
vi.mock("../viewmodels/menus/UserMenuViewModel", () => ({
    UserMenuViewModel: class extends h.FakeVm<object> {
        public constructor() {
            super({ userId: "@me:example.org", displayName: "Me" });
        }
    },
}));
vi.mock("../viewmodels/room/RoomStatusBar", () => ({
    RoomStatusBarViewModel: vi.fn(function () {
        return new h.FakeVm<{ state: string | null }>({ state: null });
    }),
}));
vi.mock("../viewmodels/room/timeline/RoomTimelineViewModel", () => ({ RoomTimelineViewModel: vi.fn() }));
vi.mock("../Avatar", () => ({ avatarUrlForRoom: () => null }));

const actions = vi.hoisted(() => ({
    createRoomViaDialog: vi.fn(),
    startChatViaDialog: vi.fn(),
    leaveViaDialog: vi.fn(),
}));
vi.mock("./RoomActions", () => actions);

describe("ViewModelBridge rooms: create, start chat, leave, invites (A5-A7)", () => {
    let bridge: ViewModelBridge;
    let rooms: Record<string, unknown>;
    let handlers: Array<(room: Room) => void>;
    let client: MatrixClient;

    beforeEach(() => {
        vi.clearAllMocks();
        rooms = {
            "!a:example.org": { roomId: "!a:example.org", tags: {}, getMyMembership: () => "join" },
        };
        handlers = [];
        client = {
            getRoom: (id: string) => rooms[id] ?? null,
            getUserId: () => "@me:example.org",
            getCrypto: () => undefined,
            isRoomEncrypted: () => false,
            on: vi.fn((event: string, cb: (room: Room) => void) => {
                if (event === ClientEvent.Room) handlers.push(cb);
            }),
            off: vi.fn(),
        } as unknown as MatrixClient;
        bridge = new ViewModelBridge(client);
    });

    it("marks an invited room in the room list and a joined one as joined", () => {
        expect(bridge.rooms().map((r) => [r.id, r.membership])).toEqual([
            ["!a:example.org", "join"],
            ["!inv:example.org", "invite"],
        ]);
    });

    it("follows the room's new item view-model when the list builds another one (a rename re-sorts the room)", () => {
        const replacement = new h.FakeVm({ ...h.item.getSnapshot(), name: "Renamed" });
        h.current.a = replacement as never;
        const onChange = vi.fn();
        bridge.onChange(onChange);
        h.invited.set({}); // any change makes the bridge look at the list again, and see the new view-model
        replacement.set({ name: "Renamed again" });
        expect(bridge.rooms().find((r) => r.id === "!a:example.org")?.name).toBe("Renamed again");
        expect(onChange).toHaveBeenCalledWith({ kind: "rooms" });
        h.current.a = h.item as never;
    });

    it("expands a collapsed section (the Invites section appears collapsed and hides its rooms) through the list's expand all", () => {
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => {});
        const list = h.lists[h.lists.length - 1];
        dispatch.mockClear();
        list.set({ sections: [{ id: "recent", roomIds: h.ids }] });
        expect(dispatch).not.toHaveBeenCalled();
        h.headers.invites = { isExpanded: false };
        list.set({
            sections: [
                { id: "invites", roomIds: [] },
                { id: "recent", roomIds: h.ids },
            ],
        });
        expect(dispatch).toHaveBeenCalledWith({ action: Action.RoomListExpandAllSections });
        // Expanded (or an empty section that is expanded): nothing to ask.
        dispatch.mockClear();
        h.headers.invites = { isExpanded: true };
        list.set({
            sections: [
                { id: "invites", roomIds: [] },
                { id: "recent", roomIds: h.ids },
            ],
        });
        expect(dispatch).not.toHaveBeenCalled();
        dispatch.mockRestore();
    });

    it("creates a room through the room list view-model's createRoom (Element's dialog)", async () => {
        actions.createRoomViaDialog.mockImplementation(async (start: () => void) => {
            start();
            return { status: "done", roomId: "!new:example.org" };
        });
        await expect(bridge.createRoom()).resolves.toEqual({ status: "done", roomId: "!new:example.org" });
        expect(h.list.createRoom).toHaveBeenCalledTimes(1);
        expect(h.list.createChatRoom).not.toHaveBeenCalled();
    });

    it("starts a chat through createChatRoom and lists the local room of a new chat first, until Element created it", async () => {
        const local = {
            roomId: LOCAL_ROOM_ID_PREFIX + "dm",
            name: "Bob",
            state: LocalRoomState.NEW,
            tags: {},
        };
        rooms[local.roomId] = local;
        actions.startChatViaDialog.mockImplementation(async (start: () => void) => {
            start();
            return { status: "done", roomId: local.roomId };
        });
        const onChange = vi.fn();
        bridge.onChange(onChange);
        await bridge.createChat();
        expect(h.list.createChatRoom).toHaveBeenCalledTimes(1);
        expect(bridge.rooms().map((r) => [r.id, r.name, r.isDirect, r.order])).toEqual([
            [local.roomId, "Bob", true, 0],
            ["!a:example.org", "General", false, 1],
            ["!inv:example.org", "Invited", false, 2],
        ]);
        expect(onChange).toHaveBeenCalledWith({ kind: "rooms" });
        // Element creates the real room: the local one leaves the list, the real one is the list view-model's.
        local.state = LocalRoomState.CREATED;
        handlers.forEach((cb) => cb(local as unknown as Room));
        expect(bridge.rooms().map((r) => r.id)).toEqual(["!a:example.org", "!inv:example.org"]);
    });

    it("does not list the room of a chat that was cancelled or that is an existing DM", async () => {
        actions.startChatViaDialog.mockResolvedValue({ status: "cancelled" });
        await bridge.createChat();
        actions.startChatViaDialog.mockResolvedValue({ status: "done", roomId: "!dm:example.org" });
        await bridge.createChat();
        expect(bridge.rooms().map((r) => r.id)).toEqual(["!a:example.org", "!inv:example.org"]);
    });

    it("leaves through the room list item view-model's onLeaveRoom (Element's confirm)", async () => {
        actions.leaveViaDialog.mockImplementation(async (_c: unknown, id: string, start: () => void) => {
            start();
            return { status: "done", roomId: id };
        });
        await expect(bridge.leave("!a:example.org")).resolves.toEqual({ status: "done", roomId: "!a:example.org" });
        expect(h.item.onLeaveRoom).toHaveBeenCalledTimes(1);
    });

    it("rejects a leave of an unknown room, of a room outside the list and of an archived room (unsupported)", async () => {
        const code = async (p: Promise<unknown>): Promise<string | undefined> => {
            try {
                await p;
            } catch (e) {
                return (e as ClientViewActionError).code;
            }
        };
        expect(await code(bridge.leave("!none:example.org"))).toBe("unknown_room");
        rooms["!out:example.org"] = { roomId: "!out:example.org", tags: {} };
        expect(await code(bridge.leave("!out:example.org"))).toBe("unknown_room");
        rooms["!a:example.org"] = { roomId: "!a:example.org", tags: { "im.vector.fake.archived": {} } };
        expect(await code(bridge.leave("!a:example.org"))).toBe("unsupported");
        expect(actions.leaveViaDialog).not.toHaveBeenCalled();
    });
});
