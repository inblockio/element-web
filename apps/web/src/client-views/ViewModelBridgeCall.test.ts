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

/*
 * Lane CALL, step 2: `ViewMessage.call` on the root event of a call. The bridge asks Element's RootCallTileViewModel
 * (faked here, with the tile view-models it holds) and hands over what they say; it reads no MatrixRTC state itself.
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
    const item = new FakeVm({
        id: "!a:example.org",
        name: "General",
        isDm: false,
        notification: { hasUnreadCount: false, count: 0, isMention: false, invited: false },
    });
    const timeline = Object.assign(new FakeVm({ items: [] as unknown[], atLiveEnd: true }), {
        start: vi.fn(),
        onJumpToLive: vi.fn(),
    });
    /** The root view-models the bridge built, newest last, with the props it gave them. */
    const roots: Array<InstanceType<typeof FakeVm<{ tileType: string; tileViewModel: unknown }>> & { props: any }> = [];
    return { FakeVm, item, timeline, roots };
});

vi.mock("../viewmodels/room-list/RoomListViewModel", () => ({
    RoomListViewModel: class extends h.FakeVm<{ sections: { id: string; roomIds: string[] }[] }> {
        public constructor() {
            super({ sections: [{ id: "recent", roomIds: ["!a:example.org"] }] });
        }
        public updateVisibleRooms = vi.fn();
        public get roomIds(): string[] {
            return ["!a:example.org"];
        }
        public getSectionHeaderViewModel = () => ({ isExpanded: true });
        public getRoomItemViewModel = (id: string) => (id === "!a:example.org" ? h.item : undefined);
    },
}));
vi.mock("../stores/room-list-v3/RoomListStoreV3", () => ({
    RoomListStoreV3Event: { ListsUpdate: "ListsUpdate" },
    default: { instance: { on: vi.fn(), off: vi.fn() } },
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
vi.mock("../viewmodels/room/timeline/RoomTimelineViewModel", () => ({
    RoomTimelineViewModel: vi.fn(function () {
        return h.timeline;
    }),
}));
vi.mock("../components/viewmodels/avatars/MemberAvatarViewModel", () => ({
    MemberAvatarViewModel: vi.fn(function () {
        return new h.FakeVm({ url: "http://avatar/bob" });
    }),
}));
vi.mock("../viewmodels/room/timeline/event-tile/call/RootCallTileViewModel", () => ({
    RootCallTileViewModel: vi.fn(function (props: unknown) {
        const root = Object.assign(new h.FakeVm({ tileType: "tombstone-call-room", tileViewModel: new h.FakeVm({}) }), {
            props,
        });
        h.roots.push(root as never);
        return root;
    }),
}));
vi.mock("../contexts/SDKContextClass", () => ({
    SDKContextClass: {
        instance: {
            roomViewStore: { getRoomId: () => null },
            callStore: { name: "callStore" },
            latestRtcNotificationEventStore: { name: "latest" },
            legacyCallHandler: { name: "legacy" },
        },
    },
}));
vi.mock("../Avatar", () => ({ avatarUrlForRoom: () => null }));
vi.mock("./registry", () => ({ getClientViews: () => [], getMeetUrl: () => undefined, selectClientView: vi.fn() }));

const member = (userId: string, name: string, url?: string) =>
    new h.FakeVm({ id: userId, name, url, size: "20px", title: userId });

const callEvent = (
    id: string,
    over: { sender?: string; ts?: number; status?: unknown; type?: string; intent?: string } = {},
) => ({
    getId: () => id,
    getType: () => over.type ?? "org.matrix.msc4075.rtc.notification",
    getRoomId: () => "!a:example.org",
    getSender: () => over.sender ?? "@bob:example.org",
    getTs: () => over.ts ?? 5000,
    getContent: () => ({ "m.call.intent": over.intent ?? "video" }),
    status: over.status ?? null,
    sender: { name: "Bob" },
});

const items = (...events: unknown[]) =>
    events.map((event, i) => ({ kind: "event" as const, key: `k${i}`, event, sendState: "sent" as const }));

describe("ViewModelBridge: ViewMessage.call (lane CALL, the call card)", () => {
    let bridge: ViewModelBridge;

    beforeEach(() => {
        vi.clearAllMocks();
        h.roots.length = 0;
        h.timeline.set({ items: [] });
        const room = {
            roomId: "!a:example.org",
            getMyMembership: () => "join",
            getMember: () => ({ userId: "@bob:example.org", roomId: "!a:example.org" }),
            getUnfilteredTimelineSet: () => ({ relations: { getChildEventsForEvent: vi.fn(() => "relations") } }),
            on: vi.fn(),
            off: vi.fn(),
        };
        const client = {
            getRoom: () => room,
            getUserId: () => "@me:example.org",
            getCrypto: () => undefined,
            isRoomEncrypted: () => false,
            on: vi.fn(),
            off: vi.fn(),
        } as unknown as MatrixClient;
        bridge = new ViewModelBridge(client);
    });

    const ongoingRoom = (): unknown => {
        const tile = new h.FakeVm({
            startedByDisplayName: "Bob",
            facePileViewModel: new h.FakeVm({
                memberAvatarViewModels: [member("@bob:example.org", "Bob", "http://hs/bob")],
            }),
            durationViewModel: new h.FakeVm({ duration: 42 }),
            totalParticipants: 4,
        });
        return tile;
    };

    it("hands over the call root as a message of kind other with the ongoing room tile's participants, count and duration", () => {
        h.timeline.set({ items: items(callEvent("$call")) });
        const [message] = bridge.timeline("!a:example.org");
        const root = h.roots[0];
        // Built the way Element's own timeline builds it: the event, the stores of the SDK context.
        expect(root.props).toMatchObject({
            callStore: { name: "callStore" },
            latestRtcNotificationEventStore: { name: "latest" },
            legacyCallHandler: { name: "legacy" },
        });
        root.set({ tileType: "ongoing-call-room", tileViewModel: ongoingRoom() });
        const [ongoing] = bridge.timeline("!a:example.org");
        expect(message.kind).toBe("other");
        expect(ongoing).toMatchObject({
            id: "$call",
            roomId: "!a:example.org",
            senderId: "@bob:example.org",
            senderName: "Bob",
            body: "",
            ts: 5000,
        });
        expect(ongoing.call).toEqual({
            callId: "$call",
            state: "ongoing",
            callType: "video",
            isDm: false,
            participants: [{ userId: "@bob:example.org", name: "Bob", avatarUrl: "http://hs/bob" }],
            participantCount: 4,
            startedTs: 5000,
            durationSeconds: 42,
        });
    });

    it("a DM ongoing tile gives the call type; the tombstone tiles give ended, and the DM one the decline", () => {
        h.timeline.set({ items: items(callEvent("$call")) });
        bridge.timeline("!a:example.org");
        const root = h.roots[0];
        const dmTile = new h.FakeVm({
            callType: "voice",
            facePileViewModel: new h.FakeVm({ memberAvatarViewModels: [] }),
        });
        root.set({ tileType: "ongoing-call-dm", tileViewModel: dmTile });
        expect(bridge.timeline("!a:example.org")[0].call).toMatchObject({
            state: "ongoing",
            isDm: true,
            callType: "voice",
            participants: [],
        });

        root.set({
            tileType: "tombstone-call-dm",
            tileViewModel: new h.FakeVm({ timestamp: "17:11", type: "voice", isCallDeclined: true }),
        });
        expect(bridge.timeline("!a:example.org")[0].call).toEqual({
            callId: "$call",
            state: "ended",
            callType: "voice",
            isDm: true,
            participants: [],
            startedTs: 5000,
            declined: true,
        });

        root.set({ tileType: "tombstone-call-room", tileViewModel: new h.FakeVm({ timestamp: "17:11" }) });
        const ended = bridge.timeline("!a:example.org")[0].call!;
        expect(ended).toMatchObject({ state: "ended", isDm: false, callType: "video", participants: [] });
        expect(ended).not.toHaveProperty("declined");
        expect(ended).not.toHaveProperty("durationSeconds");
    });

    it("a room tile names no call type: the intent of the notification event is read, as the tile view-models read it", () => {
        h.timeline.set({ items: items(callEvent("$call", { intent: "audio" })) });
        bridge.timeline("!a:example.org");
        h.roots[0].set({ tileType: "tombstone-call-room", tileViewModel: new h.FakeVm({ timestamp: "17:11" }) });
        expect(bridge.timeline("!a:example.org")[0].call?.callType).toBe("voice");
    });

    it("a change of the root's tile or of the tile it holds is a timeline change of the room; the ticking duration is none", () => {
        h.timeline.set({ items: items(callEvent("$call")) });
        bridge.timeline("!a:example.org");
        const root = h.roots[0];
        const tile = ongoingRoom() as InstanceType<typeof h.FakeVm<any>>;
        root.set({ tileType: "ongoing-call-room", tileViewModel: tile });
        const onChange = vi.fn();
        bridge.onChange(onChange);
        tile.set({ totalParticipants: 5 });
        expect(onChange).toHaveBeenCalledWith({ kind: "timeline", roomId: "!a:example.org" });
        onChange.mockClear();
        (tile.getSnapshot().durationViewModel as InstanceType<typeof h.FakeVm<any>>).set({ duration: 43 });
        expect(onChange).not.toHaveBeenCalled();
        // The root swaps ongoing for the tombstone: the old tile is no longer followed, the new one is.
        const tomb = new h.FakeVm({ timestamp: "17:11" });
        root.set({ tileType: "tombstone-call-room", tileViewModel: tomb });
        expect(tile.listeners.size).toBe(0);
        expect(tomb.listeners.size).toBe(1);
    });

    it("builds one card per call event (a repeated read reuses it), skips local echoes and disposes with the bridge", () => {
        h.timeline.set({ items: items(callEvent("$call"), callEvent("$echo", { status: "sending" })) });
        bridge.timeline("!a:example.org");
        bridge.timeline("!a:example.org");
        expect(h.roots).toHaveLength(1);
        expect(bridge.timeline("!a:example.org").map((m) => m.id)).toEqual(["$call"]);
        bridge.dispose();
        expect(h.roots[0].dispose).toHaveBeenCalledTimes(1);
    });

    it("a call event whose view-model cannot be built has no message", async () => {
        const { RootCallTileViewModel } =
            await import("../viewmodels/room/timeline/event-tile/call/RootCallTileViewModel");
        vi.mocked(RootCallTileViewModel).mockImplementationOnce(function () {
            throw new Error("Notification event does not have associated room-id");
        });
        h.timeline.set({ items: items(callEvent("$broken")) });
        expect(bridge.timeline("!a:example.org")).toEqual([]);
    });
    describe("what the card follows and releases", () => {
        const ongoing = (avatars: unknown[]) => {
            const pile = new h.FakeVm({ memberAvatarViewModels: avatars });
            const duration = new h.FakeVm({ duration: 1 });
            const tile = new h.FakeVm({
                startedByDisplayName: "Bob",
                facePileViewModel: pile,
                durationViewModel: duration,
                totalParticipants: 2,
            });
            return { pile, duration, tile };
        };
        const start = (avatars: unknown[]) => {
            h.timeline.set({ items: items(callEvent("$call")) });
            bridge.timeline("!a:example.org");
            const parts = ongoing(avatars);
            h.roots[0].set({ tileType: "ongoing-call-room", tileViewModel: parts.tile });
            return parts;
        };

        it("a swapped participant with the same count reaches the kit: the face pile is followed, and its new avatars", () => {
            const bob = member("@bob:example.org", "Bob");
            const carol = member("@carol:example.org", "Carol");
            const { pile } = start([bob]);
            const onChange = vi.fn();
            bridge.onChange(onChange);
            pile.set({ memberAvatarViewModels: [carol] });
            expect(onChange).toHaveBeenCalledWith({ kind: "timeline", roomId: "!a:example.org" });
            expect(bridge.timeline("!a:example.org")[0].call?.participants.map((p) => p.userId)).toEqual([
                "@carol:example.org",
            ]);
            // The avatar view-model that left the list is no longer followed, the new one is.
            expect(bob.listeners.size).toBe(0);
            expect(carol.listeners.size).toBe(1);
            onChange.mockClear();
            carol.set({ name: "Carol B.", url: "http://hs/carol" });
            expect(onChange).toHaveBeenCalledWith({ kind: "timeline", roomId: "!a:example.org" });
            expect(bridge.timeline("!a:example.org")[0].call?.participants).toEqual([
                { userId: "@carol:example.org", name: "Carol B.", avatarUrl: "http://hs/carol" },
            ]);
        });

        it("the ongoing tile the root replaces is disposed with its duration view-model, and nothing it followed stays followed", () => {
            const bob = member("@bob:example.org", "Bob");
            const { pile, duration, tile } = start([bob]);
            expect(pile.listeners.size).toBe(1);
            h.roots[0].set({ tileType: "tombstone-call-room", tileViewModel: new h.FakeVm({ timestamp: "17:11" }) });
            expect(duration.dispose).toHaveBeenCalledTimes(1);
            expect(tile.dispose).toHaveBeenCalledTimes(1);
            expect([tile, pile, bob].map((vm) => vm.listeners.size)).toEqual([0, 0, 0]);
        });

        it("disposing the card disposes the duration view-model of the tile it holds, so no interval outlives it", () => {
            const { duration } = start([member("@bob:example.org", "Bob")]);
            bridge.dispose();
            expect(duration.dispose).toHaveBeenCalledTimes(1);
            expect(h.roots[0].dispose).toHaveBeenCalledTimes(1);
        });

        it("a card is disposed and dropped when its event leaves the room's timeline window, and built again if it comes back", () => {
            const { duration } = start([member("@bob:example.org", "Bob")]);
            h.timeline.set({ items: [] });
            expect(bridge.timeline("!a:example.org").some((m) => m.call)).toBe(false);
            expect(h.roots[0].dispose).toHaveBeenCalledTimes(1);
            expect(duration.dispose).toHaveBeenCalledTimes(1);
            h.timeline.set({ items: items(callEvent("$call")) });
            bridge.timeline("!a:example.org");
            expect(h.roots).toHaveLength(2);
        });
    });
});
