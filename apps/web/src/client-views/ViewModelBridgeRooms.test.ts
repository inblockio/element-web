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
            isFavourite: true,
            canMarkAsUnread: false,
            canMarkAsRead: true,
            roomNotifState: "mentions_only",
        }),
        { onLeaveRoom: vi.fn(), onMarkAsUnread: vi.fn(), onToggleFavorite: vi.fn(), onSetRoomNotifState: vi.fn() },
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
    const store = { listeners: new Set<() => void>() };
    return { FakeVm, item, invited, list, current, lists, headers, store, ids: ["!a:example.org", "!inv:example.org"] };
});

vi.mock("../viewmodels/room-list/RoomListViewModel", () => ({
    RoomListViewModel: class extends h.FakeVm<{ sections: { id: string; roomIds: string[] }[] }> {
        public constructor() {
            super({ sections: [{ id: "recent", roomIds: h.ids }] });
            h.lists.push(this);
        }
        public updateVisibleRooms = vi.fn();
        // The list's own full room ids: a collapsed section's rooms are in it, not in the snapshot's sections.
        public get roomIds(): string[] {
            return h.ids;
        }
        public getSectionHeaderViewModel = (id: string) => (h.headers[id] ??= { isExpanded: true });
        public createRoom = h.list.createRoom;
        public createChatRoom = h.list.createChatRoom;
        public getRoomItemViewModel = (id: string) =>
            id === "!a:example.org" ? h.current.a : id === "!inv:example.org" ? h.invited : undefined;
    },
}));
vi.mock("../stores/room-list-v3/RoomListStoreV3", () => ({
    RoomListStoreV3Event: { ListsUpdate: "ListsUpdate" },
    default: {
        instance: {
            on: (_e: string, cb: () => void) => h.store.listeners.add(cb),
            off: (_e: string, cb: () => void) => h.store.listeners.delete(cb),
        },
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
const echo = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const chamber = {
        notificationVolume: undefined as string | undefined,
        on: (_e: string, cb: () => void) => listeners.add(cb),
        off: (_e: string, cb: () => void) => listeners.delete(cb),
    };
    return { chamber, listeners };
});
vi.mock("../stores/local-echo/EchoChamber", () => ({ EchoChamber: { forRoom: () => echo.chamber } }));
const itemActions = vi.hoisted(() => ({ markUnread: vi.fn(), setFavourite: vi.fn(), setNotificationLevel: vi.fn() }));
vi.mock("./RoomItemActions", () => itemActions);

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

    it("lists the rooms of a collapsed section (Invites) without expanding anything or writing the user's section state", () => {
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => {});
        const list = h.lists[h.lists.length - 1];
        h.headers.invites = { isExpanded: false };
        // The snapshot holds no room ids for the collapsed Invites section; the room is still listed, from the list's ids.
        list.set({
            sections: [
                { id: "invites", roomIds: [] },
                { id: "recent", roomIds: ["!a:example.org"] },
            ],
        });
        expect(bridge.rooms().map((r) => r.id)).toContain("!inv:example.org");
        expect(dispatch).not.toHaveBeenCalledWith({ action: Action.RoomListExpandAllSections });
        expect(h.headers.invites.isExpanded).toBe(false);
        dispatch.mockRestore();
    });

    it("lists a room that joined a collapsed section on the store's list update, though no snapshot changed", () => {
        const onChange = vi.fn();
        bridge.onChange(onChange);
        const before = h.ids;
        h.ids = ["!a:example.org"];
        h.store.listeners.forEach((cb) => cb());
        expect(bridge.rooms().map((r) => r.id)).toEqual(["!a:example.org"]);
        onChange.mockClear();
        h.ids = before;
        h.store.listeners.forEach((cb) => cb());
        expect(bridge.rooms().map((r) => r.id)).toContain("!inv:example.org");
        expect(onChange).toHaveBeenCalledWith({ kind: "rooms" });
    });

    it("tells the kit to read a room's timeline again when its invite became a join", () => {
        const onChange = vi.fn();
        bridge.onChange(onChange);
        h.invited.set({ notification: { hasUnreadCount: false, count: 0, isMention: false, invited: false } });
        expect(onChange.mock.calls.map((c) => c[0])).toContainEqual({ kind: "timeline", roomId: "!inv:example.org" });
        h.invited.set({ notification: { hasUnreadCount: false, count: 0, isMention: false, invited: true } });
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

    it("A10: rooms() carries the favourite flag, the unread offer and the notification level of the item's snapshot", () => {
        const room = bridge.rooms().find((r) => r.id === "!a:example.org");
        expect(room).toMatchObject({
            isFavourite: true,
            canMarkAsUnread: false,
            showsUnread: true,
            notificationLevel: "mentions_only",
        });
    });

    it("A10: markUnread, setFavourite and setNotificationLevel run the room item's view-model actions", async () => {
        itemActions.markUnread.mockResolvedValue({ status: "done", roomId: "!a:example.org" });
        itemActions.setFavourite.mockResolvedValue({ status: "done", roomId: "!a:example.org" });
        itemActions.setNotificationLevel.mockResolvedValue({ status: "done", roomId: "!a:example.org" });
        await bridge.markUnread("!a:example.org");
        await bridge.setFavourite("!a:example.org", false);
        await bridge.setNotificationLevel("!a:example.org", "mute");
        expect(itemActions.markUnread).toHaveBeenCalledWith(h.item, rooms["!a:example.org"]);
        expect(itemActions.setFavourite).toHaveBeenCalledWith(h.item, rooms["!a:example.org"], false);
        expect(itemActions.setNotificationLevel).toHaveBeenCalledWith(h.item, rooms["!a:example.org"], client, "mute");
    });

    it("A10: a room the list does not hold is unknown_room", async () => {
        await expect(bridge.markUnread("!nope:example.org")).rejects.toBeInstanceOf(ClientViewActionError);
        await expect(bridge.setFavourite("!inv:example.org", true)).rejects.toBeInstanceOf(ClientViewActionError);
        expect(itemActions.markUnread).not.toHaveBeenCalled();
    });

    it("A8: upload into a room the client does not hold is unknown_room (no picker opens)", async () => {
        await expect(bridge.upload("!nope:example.org")).rejects.toBeInstanceOf(ClientViewActionError);
        expect(document.querySelector("input[type=file]")).toBeNull();
    });

    it("A8: upload into a new chat's local room is unsupported before any picker or dialog (the first message creates the room)", async () => {
        const local = { roomId: LOCAL_ROOM_ID_PREFIX + "dm2", name: "Bob", state: LocalRoomState.NEW, tags: {} };
        rooms[local.roomId] = local;
        const error = await bridge.upload(local.roomId).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ClientViewActionError);
        expect((error as ClientViewActionError).code).toBe("unsupported");
        expect(document.querySelector("input[type=file]")).toBeNull();
    });

    it("A10: the notification level is the echo's (the item snapshot stays stale after a change), and a change of the echo updates the list", () => {
        const seen: string[] = [];
        bridge.onChange((e) => seen.push(e.kind));
        expect(bridge.rooms().find((r) => r.id === "!a:example.org")?.notificationLevel).toBe("mentions_only");
        echo.chamber.notificationVolume = "mute";
        echo.listeners.forEach((cb) => cb());
        expect(bridge.rooms().find((r) => r.id === "!a:example.org")?.notificationLevel).toBe("mute");
        expect(seen).toContain("rooms");
        echo.chamber.notificationVolume = undefined;
    });
});
