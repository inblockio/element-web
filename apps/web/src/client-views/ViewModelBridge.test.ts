/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { DecryptionFailureCode } from "matrix-js-sdk/src/crypto-api";

import { ViewModelBridge } from "./ViewModelBridge";
import { selectClientView } from "./registry";
import { RoomTimelineViewModel } from "../viewmodels/room/timeline/RoomTimelineViewModel";
import { MemberAvatarViewModel } from "../components/viewmodels/avatars/MemberAvatarViewModel";
import { _t } from "../languageHandler";

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
    const padlocks: Array<InstanceType<typeof FakeVm<{ kind: string }>> & { start: () => void; setProps: () => void }> =
        [];
    const bodies: Array<{ setEventContent: ReturnType<typeof vi.fn> }> = [];
    return { FakeVm, room, item, timeline, statusBar, member, avatar, padlocks, bodies };
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
        public constructor({ mxEvent }: { mxEvent: { getId: () => string; getType?: () => string } }) {
            super({
                snapshot: {
                    event: {
                        eventId: mxEvent.getId(),
                        eventType: mxEvent.getType?.() ?? "m.room.message",
                        msgtype: "m.text",
                    },
                    sender: { senderId: "@bob:example.org" },
                    timestamp: { value: 1 },
                },
            });
        }
    },
}));
vi.mock("../viewmodels/message-body/EventContentBodyViewModel", () => ({
    EventContentBodyViewModel: class extends h.FakeVm<object> {
        public setEventContent = vi.fn();
        public constructor() {
            super({ body: "hi" });
            h.bodies.push(this);
        }
    },
}));
vi.mock("../viewmodels/room/timeline/event-tile/EventTileE2eViewModel", () => ({
    EventTileE2eViewModel: vi.fn(function () {
        const vm = Object.assign(new h.FakeVm<object>({ kind: "none" }), { start: vi.fn(), setProps: vi.fn() });
        h.padlocks.push(vm as never);
        return vm;
    }),
}));
vi.mock("../settings/SettingsStore", () => ({ default: { getValue: () => false } }));
vi.mock("../contexts/SDKContextClass", () => ({ SDKContextClass: { instance: {} } }));
vi.mock("../stores/OwnProfileStore", () => ({ OwnProfileStore: { instance: {} } }));
vi.mock("../Avatar", () => ({ avatarUrlForRoom: () => "http://avatar/room" }));
vi.mock("./registry", () => ({
    getClientViews: () => [{ id: "fixture", name: "Fixture", url: "/kits/fixture/" }],
    selectClientView: vi.fn(async () => {}),
}));

/** A MatrixEvent stand-in with the methods the bridge and its view-model constructors read. */
const fakeEvent = (id: string, over: Record<string, unknown> = {}) => {
    const content = { msgtype: "m.text", body: "hi" };
    return {
        getId: () => id,
        getContent: () => content,
        getRoomId: () => "!a",
        getSender: () => "@bob:example.org",
        getType: () => "m.room.message",
        isEncrypted: () => false,
        isDecryptionFailure: () => false,
        getClearContent: () => null,
        decryptionFailureReason: null,
        status: null,
        on: vi.fn(),
        off: vi.fn(),
        ...over,
    };
};

describe("ViewModelBridge", () => {
    let bridge: ViewModelBridge;

    beforeEach(() => {
        vi.clearAllMocks();
        // The fakes outlive each test's bridge; drop the previous bridge's subscriptions.
        h.timeline.listeners.clear();
        bridge = new ViewModelBridge({
            getRoom: (id: string) => (id === "!a" ? h.room : null),
            getUserId: () => "@me:example.org",
            isRoomEncrypted: () => true,
            getCrypto: () => undefined,
            on: vi.fn(),
            off: vi.fn(),
        } as unknown as MatrixClient);
        h.padlocks.length = 0;
        h.bodies.length = 0;
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
        const event = fakeEvent("$1");
        h.timeline.snapshot = {
            items: [
                { kind: "event", event, continuation: false },
                { kind: "event", event: fakeEvent("$2"), continuation: true },
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

    describe("E2EE trust signals", () => {
        const timelineOf = (...events: ReturnType<typeof fakeEvent>[]) => {
            h.timeline.snapshot = {
                items: events.map((event) => ({ kind: "event", event, continuation: false })),
                atLiveEnd: true,
            };
            return bridge.timeline("!a");
        };
        const badContent = { msgtype: "m.bad.encrypted", body: "** Unable to decrypt: DecryptionError **" };
        const failure = (id: string, code: DecryptionFailureCode | null) =>
            fakeEvent(id, {
                getContent: () => badContent,
                isEncrypted: () => true,
                isDecryptionFailure: () => true,
                getClearContent: () => ({ msgtype: "m.bad.encrypted" }),
                decryptionFailureReason: code,
            });

        it("never hands over the SDK placeholder of an undecryptable event: it arrives as a failed e2e state", () => {
            const [m] = timelineOf(failure("$f", DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID));
            expect(m.body).toBe("");
            expect(m.formattedBody).toBeUndefined();
            expect(m.e2e).toEqual({ state: "failed", text: _t("timeline|decryption_failure|unable_to_decrypt") });
            expect(JSON.stringify(m)).not.toContain("DecryptionError");
        });

        it("builds the decryption failure body view-model from the event's reason", () => {
            const [a, b] = timelineOf(
                failure("$a", DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED),
                failure("$b", DecryptionFailureCode.SENDER_IDENTITY_PREVIOUSLY_VERIFIED),
            );
            expect(a.e2e).toEqual({
                state: "failed",
                text: _t("timeline|decryption_failure|historical_event_user_not_joined"),
            });
            expect(b.e2e).toEqual({
                state: "failed",
                text: _t("timeline|decryption_failure|sender_identity_previously_verified"),
            });
        });

        it("tells the body view-model the new content when a late key decrypts a failed event", () => {
            let content: Record<string, unknown> = badContent;
            let failed = true;
            const ev = failure("$late", DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID);
            Object.assign(ev, {
                getContent: () => content,
                isDecryptionFailure: () => failed,
            });
            expect(timelineOf(ev)[0].e2e?.state).toBe("failed");
            content = { msgtype: "m.text", body: "now readable" };
            failed = false;
            const seen: string[] = [];
            bridge.onChange((e) => seen.push(e.kind));
            const onDecrypted = ev.on.mock.calls.find(([name]) => name === "Event.decrypted")?.[1] as () => void;
            onDecrypted();
            expect(seen).toContain("timeline");
            expect(timelineOf(ev)[0].e2e).toEqual({ state: "decrypted" });
        });

        it("hands over an event still waiting for its key (type m.room.encrypted) as pending, without a body", () => {
            const [m] = timelineOf(
                fakeEvent("$p", {
                    getType: () => "m.room.encrypted",
                    getContent: () => ({ algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x" }),
                    isEncrypted: () => true,
                }),
            );
            expect(m.e2e).toEqual({ state: "pending", text: "" });
            expect(m.body).toBe("");
        });

        it("adds the padlock warning of a decrypted message and none for an unmarked one", () => {
            const decrypted = { isEncrypted: () => true, getClearContent: () => ({ msgtype: "m.text" }) };
            const marked = fakeEvent("$w", decrypted);
            const plain = fakeEvent("$n", decrypted);
            h.padlocks.length = 0;
            timelineOf(marked, plain);
            h.padlocks[0].snapshot = {
                kind: "icon",
                icon: "warning",
                title: "Encrypted by a device not verified by its owner.",
            } as never;
            const [m, n] = timelineOf(marked, plain);
            expect(m.e2e).toEqual({ state: "decrypted", warning: "Encrypted by a device not verified by its owner." });
            expect(n.e2e).toEqual({ state: "decrypted" });
        });

        it("never re-sets the body of an edit whose content is a fresh object per read (UTD edit, no m.new_content)", () => {
            // The SDK returns a new {} from getContent() for a replacement it cannot read: an undecryptable edit or one
            // without m.new_content. Reading such a row again and again must not tell the body view-model anything.
            const ev = fakeEvent("$edit", { getContent: () => ({}) });
            const seen: string[] = [];
            bridge.onChange((e) => seen.push(e.kind));
            for (let i = 0; i < 5; i++) timelineOf(ev);
            expect(h.bodies[0].setEventContent).not.toHaveBeenCalled();
            expect(seen).toEqual([]);
        });

        it("feeds the padlock the crypto store's room flag, which a removed m.room.encryption state cannot clear", async () => {
            // A server that drops m.room.encryption from the live state makes the deprecated state flag false; the
            // crypto API keeps the room encrypted (downgrade guard), as RoomView's useIsEncrypted reads it.
            const on = vi.fn();
            const isEncryptionEnabledInRoom = vi.fn(async () => true);
            const downgraded = new ViewModelBridge({
                getRoom: (id: string) => (id === "!a" ? h.room : null),
                getUserId: () => "@me:example.org",
                isRoomEncrypted: () => false,
                getCrypto: () => ({
                    isEncryptionEnabledInRoom,
                    getUserVerificationStatus: async () => ({ isCrossSigningVerified: () => false }),
                }),
                on,
                off: vi.fn(),
            } as unknown as MatrixClient);
            h.timeline.snapshot = {
                items: [{ kind: "event", event: fakeEvent("$x"), continuation: false }],
                atLiveEnd: true,
            };
            const seen: string[] = [];
            downgraded.onChange((e) => seen.push(e.kind));
            downgraded.timeline("!a");
            await new Promise((r) => setTimeout(r, 0));
            expect(isEncryptionEnabledInRoom).toHaveBeenCalledWith("!a");
            expect(seen).toContain("timeline");
            downgraded.timeline("!a");
            const setProps = h.padlocks[0].setProps as unknown as ReturnType<typeof vi.fn>;
            expect(setProps).toHaveBeenLastCalledWith(expect.objectContaining({ isRoomEncrypted: true }));
            // An m.room.encryption state change re-reads the flag.
            const onState = on.mock.calls.find(([name]) => name === "RoomState.events")?.[1] as (e: unknown) => void;
            onState({ getType: () => "m.room.encryption", getRoomId: () => "!a" });
            expect(isEncryptionEnabledInRoom).toHaveBeenCalledTimes(2);
            downgraded.dispose();
        });

        it("leaves a plain message in an unencrypted room without an e2e field", () => {
            const [m] = timelineOf(fakeEvent("$u"));
            expect(m).not.toHaveProperty("e2e");
        });

        it("builds one padlock view-model per row, starts it, and disposes it with the row", () => {
            timelineOf(fakeEvent("$1"), fakeEvent("$2"));
            timelineOf(fakeEvent("$1"), fakeEvent("$2"));
            expect(h.padlocks).toHaveLength(2);
            expect(h.padlocks[0].start).toHaveBeenCalledTimes(1);
            bridge.dispose();
            expect(
                h.padlocks.every(
                    (p) =>
                        (p as unknown as { dispose: { mock: { calls: unknown[] } } }).dispose.mock.calls.length === 1,
                ),
            ).toBe(true);
        });

        it("follows the padlock view-model's changes", () => {
            timelineOf(fakeEvent("$1"));
            const seen: string[] = [];
            bridge.onChange((e) => seen.push(e.kind));
            h.padlocks[0].set({ kind: "none" });
            expect(seen).toContain("timeline");
        });
    });
});
