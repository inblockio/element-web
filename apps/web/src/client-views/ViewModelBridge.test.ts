/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import { ViewModelBridge } from "./ViewModelBridge";
import { selectClientView } from "./registry";
import { RoomTimelineViewModel } from "../viewmodels/room/timeline/RoomTimelineViewModel";
import { MemberAvatarViewModel } from "../components/viewmodels/avatars/MemberAvatarViewModel";

/*
 * The bridge only wires view-models together; the view-models themselves are replaced by small fakes here so the
 * test pins what the bridge reads from each snapshot and which shipped action it calls.
 */
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
    const member = { userId: "@bob:example.org", roomId: "!a" };
    const room = { roomId: "!a", getMember: () => member };
    const item = new FakeVm({
        id: "!a",
        name: "General",
        isDm: false,
        room,
        notification: { hasUnreadCount: true, count: 2, isMention: false },
    });
    const timeline = Object.assign(new FakeVm({ items: [] as unknown[], atLiveEnd: false }), {
        start: vi.fn(),
        onMarkAllAsRead: vi.fn(),
        onJumpToLive: vi.fn(),
    });
    const statusBar = new FakeVm<{ state: string | null }>({ state: null });
    const avatar = new FakeVm<{ url?: string }>({ url: "http://avatar/bob" });
    return { FakeVm, room, item, timeline, statusBar, member, avatar };
});

vi.mock("../viewmodels/room-list/RoomListViewModel", () => ({
    RoomListViewModel: class extends h.FakeVm<{ sections: { roomIds: string[] }[] }> {
        public constructor() {
            super({ sections: [{ roomIds: ["!a"] }] });
        }
        public updateVisibleRooms = vi.fn();
        public getRoomItemViewModel = (id: string) => (id === "!a" ? h.item : undefined);
    },
}));
vi.mock("../viewmodels/menus/UserMenuViewModel", () => ({
    UserMenuViewModel: class extends h.FakeVm<object> {
        public constructor() {
            super({ userId: "@me:example.org", displayName: "Me", avatarUrl: "http://avatar/me" });
        }
    },
}));
vi.mock("../viewmodels/room/timeline/RoomTimelineViewModel", () => ({
    RoomTimelineViewModel: vi.fn(function () {
        return h.timeline;
    }),
}));
vi.mock("../viewmodels/room/RoomStatusBar", () => ({
    RoomStatusBarViewModel: vi.fn(function () {
        return h.statusBar;
    }),
}));
vi.mock("../components/viewmodels/avatars/MemberAvatarViewModel", () => ({
    MemberAvatarViewModel: vi.fn(function () {
        return h.avatar;
    }),
}));
vi.mock("../viewmodels/room/timeline/event-tile/EventTileViewModel", () => ({
    EventTileViewModel: class extends h.FakeVm<object> {
        public constructor({ mxEvent }: { mxEvent: { getId: () => string } }) {
            super({
                snapshot: {
                    event: { eventId: mxEvent.getId(), eventType: "m.room.message", msgtype: "m.text" },
                    sender: { senderId: "@bob:example.org" },
                    timestamp: { value: 1 },
                },
            });
        }
    },
}));
vi.mock("../viewmodels/message-body/EventContentBodyViewModel", () => ({
    EventContentBodyViewModel: class extends h.FakeVm<object> {
        public constructor() {
            super({ body: "hi" });
        }
    },
}));
vi.mock("../settings/SettingsStore", () => ({ default: { getValue: () => false } }));
vi.mock("../contexts/SDKContextClass", () => ({ SDKContextClass: { instance: {} } }));
vi.mock("../stores/OwnProfileStore", () => ({ OwnProfileStore: { instance: {} } }));
vi.mock("../Avatar", () => ({ avatarUrlForRoom: () => "http://avatar/room" }));
vi.mock("./registry", () => ({
    getClientViews: () => [{ id: "fixture", name: "Fixture", url: "/kits/fixture/" }],
    selectClientView: vi.fn(async () => {}),
}));

describe("ViewModelBridge", () => {
    let bridge: ViewModelBridge;

    beforeEach(() => {
        vi.clearAllMocks();
        // The fakes outlive each test's bridge; drop the previous bridge's subscriptions.
        h.timeline.listeners.clear();
        bridge = new ViewModelBridge({
            getRoom: (id: string) => (id === "!a" ? h.room : null),
            getUserId: () => "@me:example.org",
        } as unknown as MatrixClient);
    });

    it("maps the room list and the user menu snapshots", () => {
        expect(bridge.rooms()).toEqual([
            {
                id: "!a",
                name: "General",
                avatarUrl: "http://avatar/room",
                unreadCount: 2,
                mentionCount: 0,
                isDirect: false,
                order: 0,
            },
        ]);
        expect(bridge.me()).toEqual({ userId: "@me:example.org", displayName: "Me", avatarUrl: "http://avatar/me" });
    });

    it("emits a rooms change when an item snapshot changes", () => {
        const seen: string[] = [];
        bridge.onChange((e) => seen.push(e.kind));
        h.item.set({ notification: { hasUnreadCount: false, count: 0, isMention: false } });
        expect(seen).toContain("rooms");
        expect(bridge.rooms()[0].unreadCount).toBe(0);
    });

    it("marks a room read through the timeline view-model's mark-all-as-read action", () => {
        bridge.markRead("!a");
        expect(RoomTimelineViewModel).toHaveBeenCalledWith({ client: expect.anything(), room: h.room });
        expect(h.timeline.start).toHaveBeenCalledTimes(1);
        expect(h.timeline.onMarkAllAsRead).toHaveBeenCalledTimes(1);
        bridge.timeline("!a");
        expect(h.timeline.start).toHaveBeenCalledTimes(1);
    });

    it("opens a kit's timeline at the live end once, not on the stock UI's saved scroll window", () => {
        h.timeline.snapshot = { items: [], atLiveEnd: false };
        bridge.timeline("!a");
        expect(h.timeline.onJumpToLive).not.toHaveBeenCalled();
        h.timeline.set({ items: [{ kind: "virtual" }] });
        expect(h.timeline.onJumpToLive).toHaveBeenCalledTimes(1);
        h.timeline.set({ items: [{ kind: "virtual" }, { kind: "virtual" }] });
        expect(h.timeline.onJumpToLive).toHaveBeenCalledTimes(1);
    });

    it("does not reload a timeline that opened at the live end", () => {
        h.timeline.snapshot = { items: [], atLiveEnd: false };
        bridge.timeline("!a");
        h.timeline.set({ items: [{ kind: "virtual" }], atLiveEnd: true });
        expect(h.timeline.onJumpToLive).not.toHaveBeenCalled();
    });

    it("reports offline while the status bar view-model shows a lost connection", () => {
        const seen: string[] = [];
        bridge.onChange((e) => seen.push(e.kind));
        expect(bridge.connection()).toBe("online");
        h.statusBar.set({ state: "ConnectionLost" });
        expect(bridge.connection()).toBe("offline");
        expect(seen).toEqual(["connection"]);
        h.statusBar.set({ state: null });
    });

    it("lists the stock view first and switches through the registry", () => {
        expect(bridge.views()).toEqual([
            { id: "stock", name: "Element" },
            { id: "fixture", name: "Fixture" },
        ]);
        bridge.switchTo("stock");
        expect(selectClientView).toHaveBeenCalledWith("stock");
    });

    it("fills the sender avatar from the member avatar view-model, one per sender, and follows its changes", () => {
        const event = {
            getId: () => "$1",
            getContent: () => ({}),
            getRoomId: () => "!a",
            getSender: () => "@bob:example.org",
        };
        h.timeline.snapshot = {
            items: [
                { kind: "event", event, continuation: false },
                { kind: "event", event: { ...event, getId: () => "$2" }, continuation: true },
            ],
            atLiveEnd: true,
        };
        const seen: string[] = [];
        bridge.onChange((e) => seen.push(e.kind));
        expect(bridge.timeline("!a").map((m) => m.senderAvatarUrl)).toEqual(["http://avatar/bob", "http://avatar/bob"]);
        expect(MemberAvatarViewModel).toHaveBeenCalledTimes(1);
        expect(MemberAvatarViewModel).toHaveBeenCalledWith({ member: h.member, size: 64, cli: expect.anything() });
        h.avatar.set({ url: "http://avatar/bob2" });
        expect(seen).toContain("timeline");
        expect(bridge.timeline("!a")[0].senderAvatarUrl).toBe("http://avatar/bob2");
        bridge.dispose();
        expect(h.avatar.dispose).toHaveBeenCalled();
    });

    it("calls onUse when a kit first reads the bridge, again after a reset, not on later reads", () => {
        const onUse = vi.fn();
        bridge.onUse = onUse;
        bridge.rooms();
        bridge.me();
        expect(onUse).toHaveBeenCalledTimes(1);
        bridge.used = false;
        bridge.onChange(() => {});
        expect(onUse).toHaveBeenCalledTimes(2);
    });

    it("disposes the view-models it built", () => {
        bridge.timeline("!a");
        bridge.dispose();
        expect(h.timeline.dispose).toHaveBeenCalled();
        expect(h.statusBar.dispose).toHaveBeenCalled();
    });
});
