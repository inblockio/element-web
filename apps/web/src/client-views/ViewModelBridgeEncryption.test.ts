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
import { LocalRoomState } from "../models/LocalRoom";

/*
 * M12 Z4: `ViewMessage.encryption` on the entry of an `m.room.encryption` state event. The bridge asks Element's
 * EncryptionEventViewModel (faked here) and hands over the state it says, lower-cased; it reads no crypto state itself.
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
    /** The encryption view-models the bridge built, newest last, with the props it gave them. */
    const cards: Array<InstanceType<typeof FakeVm<{ state: string; userName?: string }>> & { props: any }> = [];
    return { FakeVm, item, timeline, cards };
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
vi.mock("../viewmodels/room/timeline/event-tile/EncryptionEventViewModel", () => ({
    EncryptionEventViewModel: vi.fn(function (props: unknown) {
        const card = Object.assign(new h.FakeVm({ state: "ENABLED" } as { state: string; userName?: string }), {
            props,
        });
        h.cards.push(card as never);
        return card;
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

const LOCAL = "local+bob.txn1";

const encryptionEvent = (
    id: string,
    over: { sender?: string; ts?: number; stateKey?: string; roomId?: string; type?: string } = {},
) => ({
    getId: () => id,
    getType: () => over.type ?? "m.room.encryption",
    getStateKey: () => over.stateKey ?? "",
    getRoomId: () => over.roomId ?? "!a:example.org",
    getSender: () => over.sender ?? "@me:example.org",
    getTs: () => over.ts ?? 4000,
    status: null,
    sender: { name: "Me" },
});

const items = (...events: unknown[]) =>
    events.map((event, i) => ({ kind: "event" as const, key: `k${i}`, event, sendState: "sent" as const }));

describe("ViewModelBridge: ViewMessage.encryption (M12 Z4, the encryption event line)", () => {
    let bridge: ViewModelBridge;
    let localEvents: unknown[];
    let localRoomKnown: boolean;
    let localRoomState: LocalRoomState;
    let emitted: unknown[];

    beforeEach(() => {
        vi.clearAllMocks();
        h.cards.length = 0;
        h.timeline.set({ items: [] });
        localEvents = [];
        localRoomKnown = true;
        localRoomState = LocalRoomState.NEW;
        const room = {
            roomId: "!a:example.org",
            getMyMembership: () => "join",
            getMember: () => ({ userId: "@me:example.org", roomId: "!a:example.org" }),
            getUnfilteredTimelineSet: () => ({ relations: { getChildEventsForEvent: vi.fn(() => "relations") } }),
            on: vi.fn(),
            off: vi.fn(),
        };
        const localRoom = {
            roomId: LOCAL,
            get state() {
                return localRoomState;
            },
            getMember: () => ({ userId: "@me:example.org", roomId: LOCAL }),
            currentState: { getStateEvents: vi.fn(() => localEvents) },
        };
        const client = {
            getRoom: (id: string) => (id === LOCAL ? (localRoomKnown ? localRoom : null) : room),
            getUserId: () => "@me:example.org",
            getCrypto: () => undefined,
            isRoomEncrypted: () => false,
            on: vi.fn(),
            off: vi.fn(),
        } as unknown as MatrixClient;
        bridge = new ViewModelBridge(client);
        emitted = [];
        bridge.onChange((event) => emitted.push(event));
    });

    it("hands over the encryption event as a message of kind other with the state `enabled`, built the way Element's tile builds it", () => {
        const event = encryptionEvent("$enc");
        h.timeline.set({ items: items(event) });
        const messages = bridge.timeline("!a:example.org");
        expect(h.cards).toHaveLength(1);
        expect(h.cards[0].props).toMatchObject({ cli: expect.anything(), mxEvent: event });
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            id: "$enc",
            roomId: "!a:example.org",
            senderId: "@me:example.org",
            senderName: "Me",
            ts: 4000,
            body: "",
            kind: "other",
            encryption: { state: "enabled" },
        });
        expect(messages[0].encryption).not.toHaveProperty("userName");
    });

    it("enabled_dm carries the partner's name; the other states carry none", () => {
        h.timeline.set({ items: items(encryptionEvent("$enc")) });
        bridge.timeline("!a:example.org");
        h.cards[0].set({ state: "ENABLED_DM", userName: "Bob" });
        expect(bridge.timeline("!a:example.org")[0].encryption).toEqual({ state: "enabled_dm", userName: "Bob" });
        h.cards[0].set({ state: "ENABLED", userName: "Bob" });
        expect(bridge.timeline("!a:example.org")[0].encryption).toEqual({ state: "enabled" });
    });

    it.each([
        ["CHANGED", "changed"],
        ["DISABLE_ATTEMPT", "disable_attempt"],
        ["UNSUPPORTED", "unsupported"],
        ["ENABLED_LOCAL", "enabled_local"],
    ])("Element's state %s reaches the kit as `%s`", (elementState, kitState) => {
        h.timeline.set({ items: items(encryptionEvent("$enc")) });
        bridge.timeline("!a:example.org");
        h.cards[0].set({ state: elementState });
        expect(bridge.timeline("!a:example.org")[0].encryption).toEqual({ state: kitState });
    });

    it("FN3: an async ENABLED -> UNSUPPORTED flip of the view-model is a timeline change of the room and the entry carries `unsupported`", () => {
        h.timeline.set({ items: items(encryptionEvent("$enc")) });
        expect(bridge.timeline("!a:example.org")[0].encryption).toEqual({ state: "enabled" });
        emitted.length = 0;
        h.cards[0].set({ state: "UNSUPPORTED" });
        expect(emitted).toEqual([{ kind: "timeline", roomId: "!a:example.org" }]);
        expect(bridge.timeline("!a:example.org")[0].encryption).toEqual({ state: "unsupported" });
    });

    it("builds one view-model per event (a repeated read reuses it), and the entry sorts among the messages by time", () => {
        h.timeline.set({ items: items(encryptionEvent("$enc", { ts: 4000 })) });
        bridge.timeline("!a:example.org");
        bridge.timeline("!a:example.org");
        expect(h.cards).toHaveLength(1);
        h.timeline.set({ items: items(encryptionEvent("$enc", { ts: 4000 }), encryptionEvent("$enc2", { ts: 3000 })) });
        const messages = bridge.timeline("!a:example.org");
        expect(h.cards).toHaveLength(2);
        expect(messages.map((m) => m.id)).toEqual(["$enc2", "$enc"]);
    });

    it("an encryption event with a non-empty state key, a local echo and an unsent event have no entry", () => {
        h.timeline.set({
            items: [
                ...items(encryptionEvent("$odd", { stateKey: "x" }), encryptionEvent("~local-echo")),
                { kind: "event" as const, key: "u", event: encryptionEvent("$unsent"), sendState: "sending" as const },
            ],
        });
        expect(bridge.timeline("!a:example.org")).toEqual([]);
        expect(h.cards).toHaveLength(0);
    });

    it("an event that leaves the room's timeline window is disposed and unfollowed, and built again if it comes back", () => {
        h.timeline.set({ items: items(encryptionEvent("$enc")) });
        bridge.timeline("!a:example.org");
        const first = h.cards[0];
        expect(first.listeners.size).toBe(1);
        h.timeline.set({ items: [] });
        expect(bridge.timeline("!a:example.org")).toEqual([]);
        expect(first.dispose).toHaveBeenCalledTimes(1);
        expect(first.listeners.size).toBe(0);
        h.timeline.set({ items: items(encryptionEvent("$enc")) });
        expect(bridge.timeline("!a:example.org")).toHaveLength(1);
        expect(h.cards).toHaveLength(2);
    });

    it("disposes every view-model and unsubscribes with the bridge", () => {
        h.timeline.set({ items: items(encryptionEvent("$enc")) });
        bridge.timeline("!a:example.org");
        bridge.dispose();
        expect(h.cards[0].dispose).toHaveBeenCalledTimes(1);
        expect(h.cards[0].listeners.size).toBe(0);
    });

    describe("FN2: the local room (a chat started from the kit, no server room yet)", () => {
        it("has one entry from the room's m.room.encryption state event, with the local event id", () => {
            localEvents = [encryptionEvent("~!local+bob:txn", { roomId: LOCAL, ts: 7000 })];
            const messages = bridge.timeline(LOCAL);
            expect(messages).toHaveLength(1);
            expect(messages[0]).toMatchObject({
                id: "~!local+bob:txn",
                roomId: LOCAL,
                senderId: "@me:example.org",
                ts: 7000,
                body: "",
                kind: "other",
                encryption: { state: "enabled" },
            });
            h.cards[0].set({ state: "ENABLED_LOCAL" });
            expect(bridge.timeline(LOCAL)[0].encryption).toEqual({ state: "enabled_local" });
            expect(h.cards).toHaveLength(1);
        });

        it("is empty without the state event, without the room, and for a state event with a non-empty key", () => {
            expect(bridge.timeline(LOCAL)).toEqual([]);
            localEvents = [encryptionEvent("~!local+bob:txn", { roomId: LOCAL, stateKey: "x" })];
            expect(bridge.timeline(LOCAL)).toEqual([]);
            localRoomKnown = false;
            expect(bridge.timeline(LOCAL)).toEqual([]);
            expect(h.cards).toHaveLength(0);
        });

        it("a change of the view-model is a timeline change of the local room", () => {
            localEvents = [encryptionEvent("~!local+bob:txn", { roomId: LOCAL })];
            bridge.timeline(LOCAL);
            emitted.length = 0;
            h.cards[0].set({ state: "ENABLED_DM", userName: "Bob" });
            expect(emitted).toEqual([{ kind: "timeline", roomId: LOCAL }]);
        });

        it("a local room in state CREATED that is still in the client store has no entry, its view-model is disposed, and a later read builds none", () => {
            localEvents = [encryptionEvent("~!local+bob:txn", { roomId: LOCAL })];
            expect(bridge.timeline(LOCAL)).toHaveLength(1);
            const card = h.cards[0];
            // the real flow: createRoomFromLocalRoom only sets the state and emits ClientEvent.Room, the room stays in the store
            localRoomState = LocalRoomState.CREATED;
            expect(localRoomKnown).toBe(true);
            expect(bridge.timeline(LOCAL)).toEqual([]);
            expect(card.dispose).toHaveBeenCalledTimes(1);
            expect(card.listeners.size).toBe(0);
            expect(h.cards).toHaveLength(1);
            expect(bridge.timeline(LOCAL)).toEqual([]);
            expect(h.cards).toHaveLength(1);
        });

        it("the view-model is disposed once the local room is gone (the server room replaced it), and with the bridge", () => {
            localEvents = [encryptionEvent("~!local+bob:txn", { roomId: LOCAL })];
            bridge.timeline(LOCAL);
            const card = h.cards[0];
            localRoomKnown = false;
            expect(bridge.timeline(LOCAL)).toEqual([]);
            expect(card.dispose).toHaveBeenCalledTimes(1);
            expect(card.listeners.size).toBe(0);
            localRoomKnown = true;
            bridge.timeline(LOCAL);
            const second = h.cards[1];
            bridge.dispose();
            expect(second.dispose).toHaveBeenCalledTimes(1);
        });
    });
});
