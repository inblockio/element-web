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
    const timelineSet = { relations: { getChildEventsForEvent: vi.fn((..._args: unknown[]): unknown => undefined) } };
    const room = {
        roomId: "!a",
        getMember: () => member,
        findEventById: vi.fn((_id: string): unknown => undefined),
        findThreadForEvent: () => null,
        getUnfilteredTimelineSet: () => timelineSet,
        on: vi.fn(),
        off: vi.fn(),
    };
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
    const replies: Array<{ props: unknown; dispose: ReturnType<typeof vi.fn> }> = [];
    const getEventTimeline = vi.fn(async (..._args: unknown[]) => undefined);
    const reactionButtons: Array<{
        props: { content: string; disabled?: boolean };
        dispose: ReturnType<typeof vi.fn>;
    }> = [];
    const threadSummaries: Array<FakeVm<{ isVisible: boolean; previewVm: FakeVm<object> }> & Record<string, unknown>> =
        [];
    const releaseThreadSummary = vi.fn();
    const mediaVms: Array<
        InstanceType<typeof FakeVm<Record<string, unknown>>> & {
            kind: string;
            props: Record<string, unknown>;
            loadInitialMediaIfVisible: ReturnType<typeof vi.fn>;
            setMediaVisible: ReturnType<typeof vi.fn>;
            onPlay: ReturnType<typeof vi.fn>;
        }
    > = [];
    const mediaHelpers: Array<{
        destroy: ReturnType<typeof vi.fn>;
        event?: unknown;
        resolveUrl: (url: string | null) => void;
        rejectUrl: (e: unknown) => void;
    }> = [];
    const settings: Record<string, unknown> = {};
    const roomEncrypted = { value: true };
    const watchers = new Map<string, { name: string; roomId: string | null; cb: () => void }>();
    const urlPreviewVms: Array<
        InstanceType<typeof FakeVm<Record<string, unknown>>> & {
            props: Record<string, unknown>;
            hidden: boolean;
            elements: Array<{ html: string; links: string[] }>;
            updateEventElement: ReturnType<typeof vi.fn>;
            updateUrlPreviewVisible: ReturnType<typeof vi.fn>;
            updateMediaVisible: ReturnType<typeof vi.fn>;
        }
    > = [];
    const mediaVisible = { value: true };
    const mediaVm = (kind: "image" | "video" | "file", state: Record<string, unknown>) =>
        class extends FakeVm<Record<string, unknown>> {
            public kind = kind;
            public loadInitialMediaIfVisible = vi.fn();
            public onPlay = vi.fn(async () => {});
            public setMediaVisible = vi.fn((visible: boolean) => {
                this.props = { ...this.props, mediaVisible: visible };
            });
            public constructor(public props: Record<string, unknown>) {
                super(state);
                mediaVms.push(this as never);
            }
        };
    return {
        mediaVm,
        FakeVm,
        mediaVms,
        mediaHelpers,
        mediaVisible,
        settings,
        roomEncrypted,
        watchers,
        urlPreviewVms,
        threadSummaries,
        releaseThreadSummary,
        room,
        timelineSet,
        item,
        timeline,
        statusBar,
        member,
        avatar,
        padlocks,
        bodies,
        replies,
        reactionButtons,
        getEventTimeline,
    };
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
        public constructor({
            mxEvent,
        }: {
            mxEvent: { getId: () => string; getType?: () => string; getContent?: () => { msgtype?: string } };
        }) {
            super({
                snapshot: {
                    event: {
                        eventId: mxEvent.getId(),
                        eventType: mxEvent.getType?.() ?? "m.room.message",
                        msgtype: mxEvent.getContent?.().msgtype ?? "m.text",
                    },
                    sender: { senderId: "@bob:example.org" },
                    timestamp: { value: 1 },
                },
            });
        }
        /** The tile's lazily created thread summary view-model (one per tile, as the real one). */
        private threadSummary?: unknown;
        public getThreadSummaryViewModel = vi.fn((props: unknown) => {
            if (!this.threadSummary) {
                const vm = Object.assign(new h.FakeVm({ isVisible: true, previewVm: new h.FakeVm<object>({}) }), {
                    props,
                    setThread: vi.fn(),
                });
                h.threadSummaries.push(vm as never);
                this.threadSummary = vm;
            }
            return this.threadSummary as (typeof h.threadSummaries)[number];
        });
        public releaseThreadSummaryViewModel = (): void => {
            h.releaseThreadSummary();
            this.threadSummary = undefined;
        };
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
vi.mock("../viewmodels/room/timeline/event-tile/ReplyTileViewModel", () => ({
    ReplyTileViewModel: class extends h.FakeVm<object> {
        public constructor(public props: unknown) {
            super({
                href: "",
                body: null,
                sender: { profileViewModel: { getSnapshot: () => ({ displayName: "Bob" }) } },
            });
            h.replies.push(this as never);
        }
    },
}));
vi.mock("../viewmodels/room/timeline/event-tile/reactions/ReactionsRowButtonViewModel", () => ({
    ReactionsRowButtonViewModel: class extends h.FakeVm<{ count: number; isSelected: boolean }> {
        public constructor(public props: { content: string; count: number; myReactionEvent?: unknown }) {
            super({ count: props.count, isSelected: !!props.myReactionEvent });
            h.reactionButtons.push(this as never);
        }
        public setReactionData = vi.fn();
        public setCount = (count: number): void => this.set({ count });
        public setMyReactionEvent = (ev?: unknown): void => this.set({ isSelected: !!ev });
    },
}));
vi.mock("../viewmodels/message-body/ImageBodyViewModel", () => ({
    ImageBodyViewModel: h.mediaVm("image", { state: "READY", alt: "cat.png" }),
}));
vi.mock("../viewmodels/message-body/VideoBodyViewModel", () => ({
    VideoBodyViewModel: h.mediaVm("video", { state: "READY", videoTitle: "clip.webm", src: "http://hs/clip" }),
}));
vi.mock("../viewmodels/message-body/FileBodyViewModel", () => ({
    FileBodyViewModel: h.mediaVm("file", {
        state: "UNENCRYPTED",
        infoTooltip: "notes.txt (12 bytes)",
        downloadHref: "http://hs/notes",
    }),
}));
vi.mock("../utils/MediaEventHelper", () => ({
    MediaEventHelper: class {
        public destroy = vi.fn();
        public resolveUrl!: (url: string | null) => void;
        public rejectUrl!: (e: unknown) => void;
        public sourceUrl!: { value: Promise<string | null> };
        public constructor(public event: unknown) {
            const url = new Promise<string | null>((resolve, reject) => {
                this.resolveUrl = resolve;
                this.rejectUrl = reject;
            });
            this.sourceUrl = { value: url };
            h.mediaHelpers.push(this);
        }
    },
}));
vi.mock("../utils/FileUtils", () => ({
    presentableTextForFile: (content: { filename?: string; body?: string }) => content.filename ?? content.body,
}));
vi.mock("../viewmodels/message-body/UrlPreviewGroupViewModel", () => ({
    BUNDLED_LINK_PREVIEWS: "com.beeper.linkpreviews",
    UrlPreviewGroupViewModel: class extends h.FakeVm<Record<string, unknown>> {
        public hidden = false;
        public elements: Array<{ html: string; links: string[] }> = [];
        public updateEventElement = vi.fn(async (el: Element) => {
            this.elements.push({
                html: el.innerHTML,
                links: [...el.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? ""),
            });
        });
        public updateUrlPreviewVisible = vi.fn(async () => {});
        public updateMediaVisible = vi.fn(async () => {});
        public get isPreviewHiddenByUser(): boolean {
            return this.hidden;
        }
        public constructor(public props: Record<string, unknown>) {
            super({ previews: [], totalPreviewCount: 0, previewsLimited: true, overPreviewLimit: false });
            h.urlPreviewVms.push(this as never);
        }
    },
}));
// bodyToNode linkifies through the logged-in client's settings; the fake linkifies a plain URL the way the stock body shows it.
vi.mock("../HtmlUtils", () => ({
    bodyToNode: (content: { body: string; formatted_body?: string }) => ({
        strippedBody: content.body,
        formattedBody: content.formatted_body ?? content.body.replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>'),
    }),
}));
vi.mock("../modules/Api", () => ({ ModuleApi: { instance: { urlPreviews: { module: "url-preview-api" } } } }));
vi.mock("../utils/media/mediaVisibility", () => ({ getMediaVisibility: () => h.mediaVisible.value }));
vi.mock("../settings/SettingsStore", () => ({
    default: {
        getValue: (name: string) => h.settings[name] ?? false,
        watchSetting: vi.fn((name: string, roomId: string | null, cb: () => void) => {
            const id = `w${h.watchers.size}_${name}_${Math.random()}`;
            h.watchers.set(id, { name, roomId, cb });
            return id;
        }),
        unwatchSetting: vi.fn((id: string) => {
            h.watchers.delete(id);
        }),
    },
}));
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
        replacingEvent: () => null,
        isRedacted: () => false,
        getWireContent: () => ({}),
        getTs: () => 1,
        getThread: () => null,
        getRelation: () => null,
        replyEventId: undefined as string | undefined,
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
            isRoomEncrypted: () => h.roomEncrypted.value,
            getCrypto: () => undefined,
            getEventTimeline: h.getEventTimeline,
            on: vi.fn(),
            off: vi.fn(),
        } as unknown as MatrixClient);
        h.padlocks.length = 0;
        h.bodies.length = 0;
        h.replies.length = 0;
        h.reactionButtons.length = 0;
        h.threadSummaries.length = 0;
        h.mediaVms.length = 0;
        h.mediaHelpers.length = 0;
        h.mediaVisible.value = true;
        h.urlPreviewVms.length = 0;
        h.watchers.clear();
        for (const k of Object.keys(h.settings)) delete h.settings[k];
        h.settings.urlPreviewsEnabled = true;
        h.roomEncrypted.value = true;
        h.timelineSet.relations.getChildEventsForEvent.mockReturnValue(undefined);
        h.room.findEventById.mockImplementation(() => undefined);
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

        describe("a bundled encrypted edit (the SDK applies it before it decrypts)", () => {
            const forged = { "m.new_content": { msgtype: "m.text", body: "forged" } };
            /** A decrypted original whose replacement is still m.room.encrypted with a cleartext m.new_content. */
            const editedRow = () => {
                const replacement = fakeEvent("$r", {
                    getType: () => "m.room.encrypted",
                    getContent: () => forged,
                    isEncrypted: () => true,
                });
                const ev = fakeEvent("$o", {
                    isEncrypted: () => true,
                    getClearContent: () => ({ msgtype: "m.text", body: "original" }),
                    getContent: () => (replacement.getContent() as Record<string, unknown>)["m.new_content"] ?? {},
                    replacingEvent: () => replacement,
                });
                return { ev, replacement };
            };
            const handler = (e: ReturnType<typeof fakeEvent>, name: string) =>
                e.on.mock.calls.find(([n]) => n === name)?.[1] as () => void;

            it("never hands over the wire m.new_content of an undecrypted replacement as decrypted text", () => {
                const { ev } = editedRow();
                timelineOf(ev);
                (h.bodies[0] as unknown as { snapshot: object }).snapshot = { body: "forged" };
                const [m] = timelineOf(ev);
                expect(m.e2e).toEqual({ state: "pending", text: "" });
                expect(m.body).toBe("");
                expect(JSON.stringify(m)).not.toContain("forged");
            });

            it("updates the body and re-verifies the padlock when the replacement decrypts", () => {
                const { ev, replacement } = editedRow();
                timelineOf(ev);
                const content = { "m.new_content": { msgtype: "m.text", body: "edited" } };
                Object.assign(replacement, {
                    getType: () => "m.room.message",
                    getContent: () => content,
                    getClearContent: () => content,
                });
                const seen: string[] = [];
                bridge.onChange((e) => seen.push(e.kind));
                handler(replacement, "Event.decrypted")();
                expect(h.bodies[0].setEventContent).toHaveBeenLastCalledWith(ev, content["m.new_content"]);
                expect(seen).toContain("timeline");
                // A fresh padlock view-model runs the verification against the now readable replacement.
                expect(h.padlocks).toHaveLength(2);
                expect(h.padlocks[1].start).toHaveBeenCalledTimes(1);
                expect(
                    (h.padlocks[0] as unknown as { dispose: { mock: { calls: unknown[] } } }).dispose.mock.calls,
                ).toHaveLength(1);
                expect(timelineOf(ev)[0].e2e).toEqual({ state: "decrypted" });
            });

            it("reports the replacement's decryption failure as failed", () => {
                const { ev, replacement } = editedRow();
                timelineOf(ev);
                Object.assign(replacement, {
                    getType: () => "m.room.message",
                    getContent: () => badContent,
                    getClearContent: () => badContent,
                    isDecryptionFailure: () => true,
                    decryptionFailureReason: DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID,
                });
                handler(replacement, "Event.decrypted")();
                const [m] = timelineOf(ev);
                expect(m.e2e).toEqual({ state: "failed", text: _t("timeline|decryption_failure|unable_to_decrypt") });
                expect(m.body).toBe("");
            });

            // grok F1 rerun F1: the body view-model hears Event.replaced before the row does and notifies at once; a kit
            // that reads in that notification must see the new replacement's state, not the row's cached one.
            it("hands over no wire m.new_content when read before the row has heard Event.replaced", () => {
                const { ev, replacement } = editedRow();
                Object.assign(ev, {
                    replacingEvent: () => null,
                    getContent: () => ({ msgtype: "m.text", body: "original" }),
                });
                timelineOf(ev);
                Object.assign(ev, {
                    replacingEvent: () => replacement,
                    getContent: () => (replacement.getContent() as Record<string, unknown>)["m.new_content"],
                });
                (h.bodies[0] as unknown as { snapshot: object }).snapshot = { body: "forged" };
                const [m] = timelineOf(ev);
                expect(m.e2e).toEqual({ state: "pending", text: "" });
                expect(JSON.stringify(m)).not.toContain("forged");
            });

            // grok F1 rerun F3: a redaction drops the replacement without Event.replaced.
            it("lets go of a replacement that a redaction detached", () => {
                const { ev, replacement } = editedRow();
                timelineOf(ev);
                Object.assign(ev, { replacingEvent: () => null, getContent: () => ({}), isRedacted: () => true });
                const [m] = timelineOf(ev);
                expect(m.e2e?.state).not.toBe("pending");
                expect(replacement.off).toHaveBeenCalledWith("Event.decrypted", expect.any(Function));
            });

            it("moves its decryption listener to the new replacement on Event.replaced", () => {
                const { ev, replacement } = editedRow();
                timelineOf(ev);
                const next = fakeEvent("$r2", { isEncrypted: () => true, getClearContent: () => ({}) });
                Object.assign(ev, { replacingEvent: () => next });
                handler(ev, "Event.replaced")();
                expect(replacement.off).toHaveBeenCalledWith("Event.decrypted", expect.any(Function));
                expect(handler(next, "Event.decrypted")).toBeInstanceOf(Function);
                bridge.dispose();
                expect(next.off).toHaveBeenCalledWith("Event.decrypted", expect.any(Function));
            });
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

    describe("replies", () => {
        const replyTo = (parentId: string, body = "Count me in") =>
            fakeEvent("$reply", {
                getContent: () => ({ msgtype: "m.text", body }),
                getWireContent: () => ({ "m.relates_to": { "m.in_reply_to": { event_id: parentId } } }),
                replyEventId: parentId,
            });
        const read = (...events: ReturnType<typeof fakeEvent>[]) => {
            h.timeline.snapshot = {
                items: events.map((event) => ({ kind: "event", event, continuation: false })),
                atLiveEnd: true,
            };
            return bridge.timeline("!a");
        };
        const loaded = (parent: ReturnType<typeof fakeEvent>) =>
            h.room.findEventById.mockImplementation((id: string) => (id === parent.getId() ? parent : undefined));

        it("hands over the replied message from the reply tile view-model: sender and plain text", () => {
            const parent = fakeEvent("$p", { getContent: () => ({ msgtype: "m.text", body: "Lunch at noon" }) });
            loaded(parent);
            const [m] = read(replyTo("$p"));
            expect(m.replyTo).toEqual({
                eventId: "$p",
                senderId: "@bob:example.org",
                senderName: "Bob",
                text: "Lunch at noon",
            });
            expect(h.replies).toHaveLength(1);
            expect(h.replies[0].props).toEqual(expect.objectContaining({ mxEvent: parent }));
            read(replyTo("$p"));
            expect(h.replies).toHaveLength(1);
        });

        it("strips the replied message's own reply fallback", () => {
            loaded(
                fakeEvent("$p", {
                    getContent: () => ({ msgtype: "m.text", body: "> <@x> earlier\n\nanswer" }),
                    getWireContent: () => ({ "m.relates_to": { "m.in_reply_to": { event_id: "$x" } } }),
                    replyEventId: "$x",
                }),
            );
            expect(read(replyTo("$p"))[0].replyTo?.text).toBe("answer");
        });

        // grok inc1 host F3: as the stock body, only a reply's own fallback is stripped, never a quote someone wrote.
        it("keeps leading '> ' lines of a replied message that is not itself a reply", () => {
            loaded(fakeEvent("$p", { getContent: () => ({ msgtype: "m.text", body: "> ship it" }) }));
            expect(read(replyTo("$p"))[0].replyTo?.text).toBe("> ship it");
        });

        // grok inc1 host F1: a bundled edit of the replied message emits nothing on it when it decrypts.
        it("re-reads the quote when the replied message's pending edit decrypts", () => {
            const edit = fakeEvent("$e", { isEncrypted: () => true, getClearContent: () => null });
            loaded(
                fakeEvent("$q", {
                    getContent: () => ({ body: "edited" }),
                    isEncrypted: () => true,
                    getClearContent: () => ({ body: "original" }),
                    replacingEvent: () => edit,
                }),
            );
            expect(read(replyTo("$q"))[0].replyTo?.text).toBe("");
            const seen: string[] = [];
            bridge.onChange((e) => seen.push(e.kind));
            const decrypted = edit.on.mock.calls.find(([n]) => n === "Event.decrypted")?.[1] as () => void;
            expect(decrypted).toBeInstanceOf(Function);
            decrypted();
            expect(seen).toContain("timeline");
            bridge.dispose();
            expect(edit.off).toHaveBeenCalledWith("Event.decrypted", decrypted);
        });

        // grok inc1 host F2: a failed fetch of the replied message is tried again on a later read (not on every read).
        it("tries a failed fetch of the replied message again after a pause", async () => {
            h.getEventTimeline.mockRejectedValueOnce(new Error("offline"));
            const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
            const reply = replyTo("$far");
            read(reply);
            await new Promise((r) => setTimeout(r, 0));
            read(reply);
            expect(h.getEventTimeline).toHaveBeenCalledTimes(1);
            now.mockReturnValue(1_000_000 + 60_000);
            read(reply);
            expect(h.getEventTimeline).toHaveBeenCalledTimes(2);
            now.mockRestore();
        });

        it("hands over no text of a replied message that, or whose edit, is still unreadable", () => {
            const pending = fakeEvent("$p", {
                getType: () => "m.room.encrypted",
                getContent: () => ({ body: "forged" }),
                isEncrypted: () => true,
            });
            loaded(pending);
            expect(read(replyTo("$p"))[0].replyTo?.text).toBe("");
            const edit = fakeEvent("$e", {
                getContent: () => ({ "m.new_content": { body: "forged" } }),
                isEncrypted: () => true,
            });
            const edited = fakeEvent("$q", {
                getContent: () => ({ body: "forged" }),
                isEncrypted: () => true,
                getClearContent: () => ({ body: "original" }),
                replacingEvent: () => edit,
            });
            loaded(edited);
            expect(JSON.stringify(read(replyTo("$q"))[0])).not.toContain("forged");
        });

        it("fetches a replied message outside the loaded timeline once, then hands it over", async () => {
            const parent = fakeEvent("$far", { getContent: () => ({ msgtype: "m.text", body: "Long ago" }) });
            const reply = replyTo("$far");
            const seen: string[] = [];
            bridge.onChange((e) => seen.push(e.kind));
            expect(read(reply)[0]).not.toHaveProperty("replyTo");
            read(reply);
            expect(h.getEventTimeline).toHaveBeenCalledTimes(1);
            expect(h.getEventTimeline).toHaveBeenCalledWith(h.timelineSet, "$far");
            loaded(parent);
            await new Promise((r) => setTimeout(r, 0));
            expect(seen).toContain("timeline");
            expect(read(reply)[0].replyTo?.text).toBe("Long ago");
        });

        it("adds no reply to a message without one and disposes the reply view-model with the row", () => {
            expect(read(fakeEvent("$plain"))[0]).not.toHaveProperty("replyTo");
            loaded(fakeEvent("$p"));
            read(replyTo("$p"));
            bridge.dispose();
            expect(h.replies[0].dispose).toHaveBeenCalledTimes(1);
        });
    });

    describe("reactions", () => {
        const reaction = (sender: string, key: string, over: Record<string, unknown> = {}) =>
            fakeEvent(`$r-${sender}-${key}`, { getSender: () => sender, getRelation: () => ({ key }), ...over });
        const relationsOf = (
            groups: Array<[string, ReturnType<typeof reaction>[]]>,
            me: ReturnType<typeof reaction>[] = [],
        ) => ({
            getSortedAnnotationsByKey: () => groups.map(([key, events]) => [key, new Set(events)]),
            getAnnotationsBySender: () => ({ "@me:example.org": new Set(me) }),
            on: vi.fn(),
            off: vi.fn(),
        });
        const read = (...events: ReturnType<typeof fakeEvent>[]) => {
            h.timeline.snapshot = {
                items: events.map((event) => ({ kind: "event", event, continuation: false })),
                atLiveEnd: true,
            };
            return bridge.timeline("!a");
        };

        it("hands over each reaction key with the button view-model's count and selection, one vote per sender", () => {
            const mine = reaction("@me:example.org", "👍");
            const relations = relationsOf(
                [
                    ["👍", [reaction("@bob:example.org", "👍"), reaction("@bob:example.org", "👍"), mine]],
                    ["🎉", [reaction("@bob:example.org", "🎉")]],
                ],
                [mine],
            );
            h.timelineSet.relations.getChildEventsForEvent.mockReturnValue(relations);
            const [m] = read(fakeEvent("$1"));
            expect(h.timelineSet.relations.getChildEventsForEvent).toHaveBeenCalledWith(
                "$1",
                "m.annotation",
                "m.reaction",
            );
            expect(m.reactions).toEqual([
                { key: "👍", count: 2, mine: true, senderIds: ["@bob:example.org", "@me:example.org"] },
                { key: "🎉", count: 1, mine: false, senderIds: ["@bob:example.org"] },
            ]);
            // Read-only: the buttons never send (adding or toggling a reaction is N/A in a client view).
            expect(h.reactionButtons.every((b) => b.props.disabled === true)).toBe(true);
        });

        it("does not count a redacted own reaction as selected and drops an emptied key", () => {
            const mine = reaction("@me:example.org", "👍", { isRedacted: () => true });
            h.timelineSet.relations.getChildEventsForEvent.mockReturnValue(
                relationsOf(
                    [
                        ["👍", [reaction("@bob:example.org", "👍")]],
                        ["🎉", []],
                    ],
                    [mine],
                ),
            );
            expect(read(fakeEvent("$1"))[0].reactions).toEqual([
                { key: "👍", count: 1, mine: false, senderIds: ["@bob:example.org"] },
            ]);
        });

        it("hands over no reactions where the stock row shows none: redacted, undecryptable, edit not yet decrypted", () => {
            h.timelineSet.relations.getChildEventsForEvent.mockReturnValue(
                relationsOf([["👍", [reaction("@bob:example.org", "👍")]]]),
            );
            const bad = { msgtype: "m.bad.encrypted", body: "** Unable to decrypt **" };
            const items = read(
                fakeEvent("$redacted", { isRedacted: () => true }),
                fakeEvent("$utd", { getContent: () => bad, isDecryptionFailure: () => true }),
                fakeEvent("$edit", { getContent: () => ({}) }),
            );
            expect(items.map((m) => m.reactions)).toEqual([undefined, undefined, undefined]);
        });

        it("adds no reactions to a message without any", () => {
            h.timelineSet.relations.getChildEventsForEvent.mockReturnValue(undefined);
            expect(read(fakeEvent("$1"))[0]).not.toHaveProperty("reactions");
        });

        it("follows the reactions: a first reaction (relations created) and later ones change the timeline", () => {
            h.timelineSet.relations.getChildEventsForEvent.mockReturnValue(undefined);
            const ev = fakeEvent("$1");
            read(ev);
            const seen: string[] = [];
            bridge.onChange((e) => seen.push(e.kind));
            const created = ev.on.mock.calls.find(([name]) => name === "Event.relationsCreated");
            expect(created).toBeDefined();
            const relations = relationsOf([["👍", [reaction("@bob:example.org", "👍")]]]);
            h.timelineSet.relations.getChildEventsForEvent.mockReturnValue(relations);
            created![1]();
            expect(seen).toContain("timeline");
            expect(read(ev)[0].reactions).toHaveLength(1);
            const added = relations.on.mock.calls.find(([name]) => name === "Relations.add");
            expect(added).toBeDefined();
            seen.length = 0;
            added![1]();
            expect(seen).toContain("timeline");
        });

        it("releases the relations listeners and button view-models with the row", () => {
            const relations = relationsOf([["👍", [reaction("@bob:example.org", "👍")]]]);
            h.timelineSet.relations.getChildEventsForEvent.mockReturnValue(relations);
            read(fakeEvent("$1"));
            bridge.dispose();
            expect(relations.off).toHaveBeenCalledWith("Relations.add", expect.any(Function));
            expect(relations.off).toHaveBeenCalledWith("Relations.remove", expect.any(Function));
            expect(relations.off).toHaveBeenCalledWith("Relations.redaction", expect.any(Function));
            expect(h.reactionButtons[0].dispose).toHaveBeenCalledTimes(1);
        });
    });
    describe("thread summary", () => {
        const read = (...events: ReturnType<typeof fakeEvent>[]) => {
            h.timeline.snapshot = {
                items: events.map((event) => ({ kind: "event", event, continuation: false })),
                atLiveEnd: true,
            };
            return bridge.timeline("!a");
        };
        const reply = (id: string, sender: string, over: Record<string, unknown> = {}) =>
            fakeEvent(id, {
                getSender: () => sender,
                getTs: () => 5000,
                getContent: () => ({ msgtype: "m.text", body: `text of ${id}` }),
                isRelation: (type: string) => type === "m.thread",
                ...over,
            });
        /** A thread rooted at `root` with the given replies (the last one is the latest reply). */
        const threadOf = (root: ReturnType<typeof fakeEvent>, replies: ReturnType<typeof reply>[]) => ({
            id: root.getId(),
            room: h.room,
            length: replies.length,
            events: [root, ...replies],
            replyToEvent: replies[replies.length - 1] ?? null,
            on: vi.fn(),
            off: vi.fn(),
        });
        const rootWith = (replies: ReturnType<typeof reply>[], over: Record<string, unknown> = {}) => {
            const root = fakeEvent("$root", { getTs: () => 1000, ...over });
            const thread = threadOf(root, replies);
            Object.assign(root, { getThread: () => thread });
            return { root, thread };
        };

        it("hands over the reply count, the latest reply and the repliers from the thread summary view-model", () => {
            const { root, thread } = rootWith([reply("$r1", "@bob:example.org"), reply("$r2", "@carol:example.org")]);
            const [m] = read(root);
            expect(m.thread).toEqual({
                replyCount: 2,
                lastReplyTs: 5000,
                lastReply: { eventId: "$r2", senderId: "@carol:example.org", text: "text of $r2" },
                participantIds: ["@bob:example.org", "@carol:example.org"],
            });
            // The view-model is the tile's own, fed the thread of the row's event.
            expect(h.threadSummaries).toHaveLength(1);
            expect(h.threadSummaries[0].props).toMatchObject({ mxEvent: root, thread, isCard: false, narrow: false });
            // One view-model per row, however often the timeline is read.
            read(root);
            expect(h.threadSummaries).toHaveLength(1);
        });

        it("lists each replier once", () => {
            const { root } = rootWith([
                reply("$r1", "@bob:example.org"),
                reply("$r2", "@bob:example.org"),
                reply("$r3", "@me:example.org"),
            ]);
            expect(read(root)[0].thread?.participantIds).toEqual(["@bob:example.org", "@me:example.org"]);
        });

        it("adds no thread to a message without replies, a reply inside a thread, or a hidden summary", () => {
            expect(read(fakeEvent("$1"))[0]).not.toHaveProperty("thread");
            const other = threadOf(fakeEvent("$elsewhere"), [reply("$r1", "@bob:example.org")]);
            expect(read(fakeEvent("$2", { getThread: () => other }))[0]).not.toHaveProperty("thread");
            const { root } = rootWith([reply("$r1", "@bob:example.org")]);
            read(root);
            h.threadSummaries[0].set({ isVisible: false });
            expect(read(root)[0]).not.toHaveProperty("thread");
        });

        it("blanks the latest reply's text while that event or its edit is unreadable", () => {
            const undecrypted = reply("$r1", "@bob:example.org", {
                isEncrypted: () => true,
                getClearContent: () => null,
            });
            const { root } = rootWith([undecrypted]);
            const [m] = read(root);
            expect(m.thread?.lastReply).toEqual({ eventId: "$r1", senderId: "@bob:example.org", text: "" });
            expect(JSON.stringify(m)).not.toContain("text of $r1");

            const edited = reply("$r2", "@bob:example.org", {
                replacingEvent: () => ({
                    isDecryptionFailure: () => true,
                    isEncrypted: () => true,
                    getClearContent: () => null,
                }),
            });
            const { root: root2 } = rootWith([edited]);
            expect(read(root2)[0].thread?.lastReply?.text).toBe("");
        });

        it("reads the latest reply again when its edit decrypts, and stops following it with the row", () => {
            const edit = fakeEvent("$e", { isEncrypted: () => true, getClearContent: () => null });
            const { root } = rootWith([reply("$r1", "@bob:example.org", { replacingEvent: () => edit })]);
            expect(read(root)[0].thread?.lastReply?.text).toBe("");
            const seen: string[] = [];
            bridge.onChange((e) => seen.push(e.kind));
            const decrypted = edit.on.mock.calls.find(([name]) => name === "Event.decrypted");
            expect(decrypted).toBeDefined();
            decrypted![1]();
            expect(seen).toContain("timeline");
            bridge.dispose();
            expect(edit.off).toHaveBeenCalledWith("Event.decrypted", decrypted![1]);
        });

        it("lists only repliers: a reaction or an edit in the thread timeline adds no participant", () => {
            const { root, thread } = rootWith([reply("$r1", "@bob:example.org"), reply("$r2", "@carol:example.org")]);
            const notThread = { isRelation: (type: string) => type !== "m.thread" };
            thread.events.push(
                reply("$re", "@dave:example.org", notThread),
                reply("$ed", "@erin:example.org", notThread),
            );
            expect(read(root)[0].thread?.participantIds).toEqual(["@bob:example.org", "@carol:example.org"]);
        });

        it("keeps an edited latest reply's leading quote lines: an edit's body has no reply fallback", () => {
            const edited = reply("$r1", "@bob:example.org", {
                getContent: () => ({ msgtype: "m.text", body: "> typed quote\n\nmy answer" }),
                replacingEvent: () => fakeEvent("$e"),
            });
            const { root } = rootWith([edited]);
            expect(read(root)[0].thread?.lastReply?.text).toBe("> typed quote\n\nmy answer");
        });

        it("strips a reply fallback from the latest reply's text", () => {
            const fallback = reply("$r1", "@bob:example.org", {
                getContent: () => ({ msgtype: "m.text", body: "> <@a:x> quoted\n\nthe answer" }),
            });
            const { root } = rootWith([fallback]);
            expect(read(root)[0].thread?.lastReply?.text).toBe("the answer");
        });

        it("follows the thread: a view-model change, the preview's change, the event's thread update and a new thread", () => {
            const { root, thread } = rootWith([reply("$r1", "@bob:example.org")]);
            read(root);
            const seen: string[] = [];
            bridge.onChange((e) => seen.push(e.kind));
            h.threadSummaries[0].set({});
            expect(seen).toContain("timeline");
            seen.length = 0;
            h.threadSummaries[0].snapshot.previewVm.set({});
            expect(seen).toContain("timeline");
            seen.length = 0;
            const updated = root.on.mock.calls.find(([name]) => name === "Thread.update");
            expect(updated).toBeDefined();
            updated![1]();
            expect(seen).toContain("timeline");

            // A thread created after the root was read: the room announces it.
            const late = fakeEvent("$late");
            read(late);
            seen.length = 0;
            const created = h.room.on.mock.calls.filter(([name]) => name === "Thread.new").map(([, cb]) => cb);
            expect(created.length).toBeGreaterThan(0);
            created.forEach((cb) => cb({ id: "$other" }));
            expect(seen).toHaveLength(0);
            created.forEach((cb) => cb({ id: "$late" }));
            expect(seen).toContain("timeline");
            expect(thread.on).not.toHaveBeenCalled();
        });

        it("releases the summary listeners and view-model with the row", () => {
            const { root } = rootWith([reply("$r1", "@bob:example.org")]);
            read(root);
            const [vm] = h.threadSummaries;
            expect(vm.listeners.size).toBe(1);
            expect(vm.snapshot.previewVm.listeners.size).toBe(1);
            bridge.dispose();
            expect(vm.listeners.size).toBe(0);
            expect(vm.snapshot.previewVm.listeners.size).toBe(0);
            expect(root.off).toHaveBeenCalledWith("Thread.update", expect.any(Function));
            expect(h.room.off).toHaveBeenCalledWith("Thread.new", expect.any(Function));
        });
    });

    describe("media bodies", () => {
        const mediaEvent = (id: string, msgtype: string, over: Record<string, unknown> = {}) =>
            fakeEvent(id, { getContent: () => ({ msgtype, body: "x" }), ...over });
        const read = (...events: ReturnType<typeof fakeEvent>[]) => {
            h.timeline.snapshot = {
                items: events.map((event) => ({ kind: "event", event, continuation: false })),
                atLiveEnd: true,
            };
            return bridge.timeline("!a");
        };

        it("hands over no media for a text message and builds no media view-model", () => {
            const [m] = read(fakeEvent("$1"));
            expect(m).not.toHaveProperty("media");
            expect(h.mediaVms).toHaveLength(0);
        });

        it("builds the image view-model with the event, a media helper and the visibility, then maps its snapshot", () => {
            const ev = mediaEvent("$img", "m.image");
            const [m] = read(ev);
            expect(h.mediaVms).toHaveLength(1);
            const vm = h.mediaVms[0];
            expect(vm.kind).toBe("image");
            expect(vm.props).toMatchObject({ mxEvent: ev, mediaVisible: true });
            expect(vm.props.mediaEventHelper).toBe(h.mediaHelpers[0]);
            expect(h.mediaHelpers[0].event).toBe(ev);
            expect(m.media).toEqual({ kind: "image", state: "loading", name: "cat.png" });
        });

        it("starts the download once, after the read, and emits timeline when the snapshot gets its URL", async () => {
            read(mediaEvent("$img", "m.image"));
            const vm = h.mediaVms[0];
            await Promise.resolve();
            expect(vm.loadInitialMediaIfVisible).toHaveBeenCalledTimes(1);
            read(mediaEvent("$img", "m.image"));
            await Promise.resolve();
            expect(vm.loadInitialMediaIfVisible).toHaveBeenCalledTimes(1);
            const seen: Array<{ kind: string; roomId?: string }> = [];
            bridge.onChange((e) => seen.push(e));
            vm.set({ src: "blob:decrypted", thumbnailSrc: "blob:thumb" });
            expect(seen).toContainEqual({ kind: "timeline", roomId: "!a" });
            expect(bridge.timeline("!a")[0].media).toMatchObject({
                state: "ready",
                url: "blob:decrypted",
                thumbnailUrl: "blob:thumb",
            });
        });

        it("maps a video and an unencrypted file from their own view-models", () => {
            const [video, file] = read(mediaEvent("$v", "m.video"), mediaEvent("$f", "m.file", { getTs: () => 2 }));
            expect(h.mediaVms.map((v) => v.kind)).toEqual(["video", "file"]);
            expect(video.media).toEqual({ kind: "video", state: "ready", url: "http://hs/clip", name: "clip.webm" });
            expect(file.media).toEqual({
                kind: "file",
                state: "ready",
                url: "http://hs/notes",
                name: "notes.txt (12 bytes)",
            });
        });

        it("mirrors Element's media visibility: hidden media is passed to the view-model, and a change is applied once", () => {
            h.mediaVisible.value = false;
            read(mediaEvent("$img", "m.image"));
            const vm = h.mediaVms[0];
            expect(vm.props.mediaVisible).toBe(false);
            h.mediaVisible.value = true;
            read(mediaEvent("$img", "m.image"));
            read(mediaEvent("$img", "m.image"));
            expect(vm.setMediaVisible).toHaveBeenCalledTimes(1);
            expect(vm.setMediaVisible).toHaveBeenCalledWith(true);
        });

        it("follows the live content: a row built while encrypted gets its media once the event decrypts", () => {
            let content: Record<string, unknown> = { msgtype: "m.bad.encrypted", body: "** Unable to decrypt **" };
            const ev = fakeEvent("$late", { getContent: () => content });
            expect(read(ev)[0]).not.toHaveProperty("media");
            expect(h.mediaVms).toHaveLength(0);
            content = { msgtype: "m.image", body: "x", file: { url: "mxc://hs/a" } };
            expect(read(ev)[0].media).toMatchObject({ kind: "image", state: "loading" });
            expect(h.mediaVms).toHaveLength(1);
        });

        it("rebuilds the media view-model when an edit swaps the file, and releases the old one", () => {
            let content: Record<string, unknown> = { msgtype: "m.image", body: "x", url: "mxc://hs/a" };
            const ev = fakeEvent("$e", { getContent: () => content });
            read(ev);
            read(ev);
            expect(h.mediaVms).toHaveLength(1);
            content = { msgtype: "m.image", body: "x", url: "mxc://hs/b" };
            read(ev);
            expect(h.mediaVms).toHaveLength(2);
            expect(h.mediaVms[0].dispose).toHaveBeenCalledTimes(1);
            expect(h.mediaHelpers[0].destroy).toHaveBeenCalledTimes(1);
            expect(h.mediaHelpers[1].destroy).not.toHaveBeenCalled();
        });

        it("drops the media of a redacted message and disposes its view-model", () => {
            let redacted = false;
            const ev = fakeEvent("$r", {
                getContent: () => (redacted ? {} : { msgtype: "m.image", body: "x", url: "mxc://hs/a" }),
                isRedacted: () => redacted,
            });
            expect(read(ev)[0].media).toBeDefined();
            redacted = true;
            expect(read(ev)[0]).not.toHaveProperty("media");
            expect(h.mediaVms[0].dispose).toHaveBeenCalledTimes(1);
            expect(h.mediaHelpers[0].destroy).toHaveBeenCalledTimes(1);
        });

        it("plays an encrypted video that waits on its data: placeholder, once, so it decrypts to a blob URL", async () => {
            const ev = mediaEvent("$enc", "m.video");
            read(ev);
            const vm = h.mediaVms[0];
            vm.onPlay.mockImplementation(async () => vm.set({ src: "blob:decrypted-video" }));
            vm.set({ src: "data:video/mp4," });
            expect(read(ev)[0].media).toMatchObject({ state: "loading" });
            expect(read(ev)[0].media).not.toHaveProperty("url");
            await Promise.resolve();
            expect(vm.onPlay).toHaveBeenCalledTimes(1);
            read(ev);
            await Promise.resolve();
            expect(vm.onPlay).toHaveBeenCalledTimes(1);
            expect(read(ev)[0].media).toMatchObject({ state: "ready", url: "blob:decrypted-video" });
        });

        it("does not play a video that is disposed before the placeholder is acted on", async () => {
            const ev = mediaEvent("$enc2", "m.video");
            read(ev);
            const vm = h.mediaVms[0];
            vm.set({ src: "data:video/mp4," });
            read(ev);
            bridge.dispose();
            await Promise.resolve();
            expect(vm.onPlay).not.toHaveBeenCalled();
        });

        it("keeps one view-model per event and disposes it and its helper with the bridge", () => {
            read(mediaEvent("$img", "m.image"));
            read(mediaEvent("$img", "m.image"));
            expect(h.mediaVms).toHaveLength(1);
            bridge.dispose();
            expect(h.mediaVms[0].dispose).toHaveBeenCalledTimes(1);
            expect(h.mediaHelpers[0].destroy).toHaveBeenCalledTimes(1);
        });
    });

    describe("audio bodies", () => {
        const audioEvent = (id: string, over: Record<string, unknown> = {}, content: Record<string, unknown> = {}) =>
            fakeEvent(id, {
                getContent: () => ({ msgtype: "m.audio", body: "song.ogg", url: "mxc://hs/a", ...content }),
                ...over,
            });
        const read = (...events: ReturnType<typeof fakeEvent>[]) => {
            h.timeline.snapshot = {
                items: events.map((event) => ({ kind: "event", event, continuation: false })),
                atLiveEnd: true,
            };
            return bridge.timeline("!a");
        };
        const settle = () => new Promise((r) => setTimeout(r, 0));

        it("builds no view-model (that would decode the whole file for every row): the helper's URL, the label Element shows", async () => {
            const seen: string[] = [];
            bridge.onChange((e) => seen.push(e.kind));
            const ev = audioEvent("$a");
            expect(read(ev)[0].media).toEqual({ kind: "audio", state: "loading", name: "song.ogg" });
            expect(h.mediaVms).toHaveLength(0);
            expect(h.mediaHelpers).toHaveLength(1);
            h.mediaHelpers[0].resolveUrl("http://hs/media/a");
            await settle();
            expect(seen).toContain("timeline");
            expect(read(ev)[0].media).toEqual({
                kind: "audio",
                state: "ready",
                url: "http://hs/media/a",
                name: "song.ogg",
            });
            // one helper, one URL request per message
            expect(h.mediaHelpers).toHaveLength(1);
        });

        it("a voice message is the same audio body", async () => {
            const ev = audioEvent("$v", {}, { "body": "Voice message", "org.matrix.msc3245.voice": {} });
            read(ev);
            h.mediaHelpers[0].resolveUrl("blob:voice");
            await settle();
            expect(read(ev)[0].media).toMatchObject({ kind: "audio", state: "ready", url: "blob:voice" });
        });

        it("a URL that cannot be fetched or decrypted is Element's error text", async () => {
            const ev = audioEvent("$e");
            read(ev);
            h.mediaHelpers[0].rejectUrl(new Error("decrypt"));
            await settle();
            expect(read(ev)[0].media).toEqual({
                kind: "audio",
                state: "error",
                name: "song.ogg",
                label: _t("timeline|m.audio|error_processing_audio"),
            });
        });

        it("rebuilds for another file, and releases the helper of a redacted message", async () => {
            let content: Record<string, unknown> = { msgtype: "m.audio", body: "a.ogg", url: "mxc://hs/a" };
            let redacted = false;
            const ev = fakeEvent("$r", { getContent: () => (redacted ? {} : content), isRedacted: () => redacted });
            read(ev);
            content = { msgtype: "m.audio", body: "b.ogg", url: "mxc://hs/b" };
            expect(read(ev)[0].media).toMatchObject({ name: "b.ogg", state: "loading" });
            expect(h.mediaHelpers).toHaveLength(2);
            expect(h.mediaHelpers[0].destroy).toHaveBeenCalledTimes(1);
            redacted = true;
            expect(read(ev)[0]).not.toHaveProperty("media");
            expect(h.mediaHelpers[1].destroy).toHaveBeenCalledTimes(1);
        });

        it("a URL that arrives after the message was released is not used, and a blob URL is revoked", async () => {
            const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
            let redacted = false;
            const ev = fakeEvent("$late", {
                getContent: () => (redacted ? {} : { msgtype: "m.audio", body: "a.ogg", url: "mxc://hs/a" }),
                isRedacted: () => redacted,
            });
            read(ev);
            redacted = true;
            read(ev);
            const seen: string[] = [];
            bridge.onChange((e) => seen.push(e.kind));
            h.mediaHelpers[0].resolveUrl("blob:late");
            await settle();
            expect(revoke).toHaveBeenCalledWith("blob:late");
            expect(seen).toEqual([]);
            revoke.mockRestore();
        });
    });

    describe("media visibility follows Element's settings while the room is open (grok F5)", () => {
        const imageEvent = (id: string) =>
            fakeEvent(id, { getContent: () => ({ msgtype: "m.image", body: "x", url: "mxc://hs/a" }) });
        const read = (...events: ReturnType<typeof fakeEvent>[]) => {
            h.timeline.snapshot = {
                items: events.map((event) => ({ kind: "event", event, continuation: false })),
                atLiveEnd: true,
            };
            return bridge.timeline("!a");
        };
        const watching = (name: string) => [...h.watchers.values()].filter((w) => w.name === name);

        it("watches the room's media preview setting and the per-event overrides for a media row, and nothing for a text row", () => {
            read(fakeEvent("$t"));
            expect(h.watchers.size).toBe(0);
            read(imageEvent("$i"));
            expect(watching("mediaPreviewConfig").map((w) => w.roomId)).toEqual(["!a"]);
            expect(watching("showMediaEventIds")).toHaveLength(1);
        });

        it("a change of either setting re-emits the timeline, and the next read applies the new visibility once", () => {
            const ev = imageEvent("$i");
            read(ev);
            const seen: Array<string | undefined> = [];
            bridge.onChange((e) => seen.push(`${e.kind}:${e.roomId}`));
            h.mediaVisible.value = false;
            watching("mediaPreviewConfig")[0].cb();
            expect(seen).toEqual(["timeline:!a"]);
            read(ev);
            read(ev);
            expect(h.mediaVms[0].setMediaVisible).toHaveBeenCalledTimes(1);
            expect(h.mediaVms[0].setMediaVisible).toHaveBeenCalledWith(false);
            h.mediaVisible.value = true;
            watching("showMediaEventIds")[0].cb();
            expect(seen).toEqual(["timeline:!a", "timeline:!a"]);
            read(ev);
            expect(h.mediaVms[0].setMediaVisible).toHaveBeenLastCalledWith(true);
        });

        it("stops watching when the media is released (redacted, another file) and when the bridge goes", () => {
            let redacted = false;
            const ev = fakeEvent("$r", {
                getContent: () => (redacted ? {} : { msgtype: "m.image", body: "x", url: "mxc://hs/a" }),
                isRedacted: () => redacted,
            });
            read(ev);
            expect(h.watchers.size).toBe(2);
            redacted = true;
            read(ev);
            expect(h.watchers.size).toBe(0);
            redacted = false;
            read(ev);
            expect(h.watchers.size).toBe(2);
            bridge.dispose();
            expect(h.watchers.size).toBe(0);
        });
    });

    describe("URL previews", () => {
        const textEvent = (id: string, content: Record<string, unknown>, over: Record<string, unknown> = {}) =>
            fakeEvent(id, { getContent: () => content, ...over });
        const read = (...events: ReturnType<typeof fakeEvent>[]) => {
            h.timeline.snapshot = {
                items: events.map((event) => ({ kind: "event", event, continuation: false })),
                atLiveEnd: true,
            };
            return bridge.timeline("!a");
        };
        const preview = {
            link: "https://example.org/post",
            showTooltipOnLink: false,
            title: "A post",
            siteName: "Example",
            description: "About a post",
            image: {
                imageThumb: "http://hs/thumb",
                imageFull: "http://hs/full",
                mxcImageFull: "mxc://hs/f",
                playable: false,
            },
        };
        const linkText = { msgtype: "m.text", body: "see https://example.org/post now" };

        beforeEach(() => {
            h.roomEncrypted.value = false;
        });

        it("builds the shipped view-model for a message with a link, from its linkified body, and maps its previews", async () => {
            const ev = textEvent("$u", linkText);
            expect(read(ev)[0]).not.toHaveProperty("urlPreviews");
            expect(h.urlPreviewVms).toHaveLength(1);
            const vm = h.urlPreviewVms[0];
            expect(vm.props).toMatchObject({
                client: expect.anything(),
                mxEvent: ev,
                visible: true,
                mediaVisible: true,
                urlPreviewKind: "fetchonly",
                moduleUrlPreviewApi: { module: "url-preview-api" },
            });
            // the view-model finds its links in an element: the body, linkified as the tile shows it, after this read
            expect(vm.updateEventElement).not.toHaveBeenCalled();
            await Promise.resolve();
            expect(vm.updateEventElement).toHaveBeenCalledTimes(1);
            expect(vm.elements[0].links).toEqual(["https://example.org/post"]);
            vm.set({ previews: [preview] });
            expect(read(ev)[0].urlPreviews).toEqual([
                {
                    link: "https://example.org/post",
                    title: "A post",
                    siteName: "Example",
                    description: "About a post",
                    image: { url: "http://hs/thumb" },
                },
            ]);
        });

        it("takes the links of a formatted body from its sanitized HTML", async () => {
            const ev = textEvent("$f", {
                msgtype: "m.text",
                body: "a post",
                format: "org.matrix.custom.html",
                formatted_body: 'a <a href="https://example.org/post">post</a>',
            });
            read(ev);
            await Promise.resolve();
            expect(h.urlPreviewVms[0].elements[0].links).toEqual(["https://example.org/post"]);
        });

        it("builds nothing for a message without a link, a media message or an unreadable one", () => {
            read(
                textEvent("$1", { msgtype: "m.text", body: "no link here" }),
                textEvent("$2", { msgtype: "m.image", body: "https://example.org/x.png", url: "mxc://hs/a" }),
                textEvent("$3", { msgtype: "m.bad.encrypted", body: "https://example.org/" }),
            );
            expect(h.urlPreviewVms).toHaveLength(0);
        });

        it("hidden means none: the room setting off builds no view-model and hands over nothing", () => {
            h.settings.urlPreviewsEnabled = false;
            expect(read(textEvent("$h", linkText))[0]).not.toHaveProperty("urlPreviews");
            expect(h.urlPreviewVms).toHaveLength(0);
        });

        describe("before the crypto answer for the room has settled (grok inc 8/4 F1)", () => {
            // The state flag says "not encrypted" (m.room.encryption removed: a downgrade); the crypto store knows better,
            // but later. Stock Element awaits getIsRoomEncrypted before it computes showUrlPreview.
            const cryptoBridge = (answer: Promise<boolean>) => {
                const isEncryptionEnabledInRoom = vi.fn(() => answer);
                const b = new ViewModelBridge({
                    getRoom: (id: string) => (id === "!a" ? h.room : null),
                    getUserId: () => "@me:example.org",
                    isRoomEncrypted: () => false,
                    getCrypto: () => ({
                        isEncryptionEnabledInRoom,
                        getUserVerificationStatus: async () => ({ isCrossSigningVerified: () => false }),
                    }),
                    on: vi.fn(),
                    off: vi.fn(),
                } as unknown as MatrixClient);
                const readWith = (...events: ReturnType<typeof fakeEvent>[]) => {
                    h.timeline.snapshot = {
                        items: events.map((event) => ({ kind: "event", event, continuation: false })),
                        atLiveEnd: true,
                    };
                    return b.timeline("!a");
                };
                return { b, readWith };
            };
            const settle = () => new Promise((r) => setTimeout(r, 0));

            it("builds nothing and fetches nothing until the room is known to be encrypted, then stays off with the e2ee setting off", async () => {
                h.settings.urlPreviewsEnabled_e2ee = false;
                let resolve!: (v: boolean) => void;
                const { b, readWith } = cryptoBridge(new Promise<boolean>((r) => (resolve = r)));
                const ev = textEvent("$f1", linkText);
                const seen: string[] = [];
                b.onChange((e) => seen.push(e.kind));
                expect(readWith(ev)[0]).not.toHaveProperty("urlPreviews");
                await settle();
                expect(h.urlPreviewVms).toHaveLength(0);
                resolve(true);
                await settle();
                expect(seen).toContain("timeline");
                expect(readWith(ev)[0]).not.toHaveProperty("urlPreviews");
                await settle();
                expect(h.urlPreviewVms).toHaveLength(0);
                b.dispose();
            });

            it("builds the preview of an unencrypted room once the crypto answer says so, and re-emits the timeline for it", async () => {
                let resolve!: (v: boolean) => void;
                const { b, readWith } = cryptoBridge(new Promise<boolean>((r) => (resolve = r)));
                const ev = textEvent("$f2", linkText);
                const seen: string[] = [];
                b.onChange((e) => seen.push(e.kind));
                readWith(ev);
                await settle();
                expect(h.urlPreviewVms).toHaveLength(0);
                expect(seen).not.toContain("timeline");
                resolve(false);
                await settle();
                expect(seen).toContain("timeline");
                readWith(ev);
                expect(h.urlPreviewVms).toHaveLength(1);
                expect(h.urlPreviewVms[0].props).toMatchObject({ visible: true, urlPreviewKind: "fetchonly" });
                b.dispose();
            });

            it("a failed crypto answer settles too: the state flag stands", async () => {
                let reject!: (e: unknown) => void;
                const { b, readWith } = cryptoBridge(new Promise<boolean>((_, r) => (reject = r)));
                const ev = textEvent("$f3", linkText);
                const seen: string[] = [];
                b.onChange((e) => seen.push(e.kind));
                readWith(ev);
                expect(h.urlPreviewVms).toHaveLength(0);
                reject(new Error("no crypto"));
                await settle();
                expect(seen).toContain("timeline");
                readWith(ev);
                expect(h.urlPreviewVms).toHaveLength(1);
                b.dispose();
            });
        });

        it("an encrypted room follows the e2ee setting, off by default", () => {
            h.roomEncrypted.value = true;
            h.settings.urlPreviewsEnabled_e2ee = false;
            read(textEvent("$e", linkText));
            expect(h.urlPreviewVms).toHaveLength(0);
        });

        it("an encrypted room with the e2ee setting on is bundled-only when the bundle feature and its option are on", () => {
            h.roomEncrypted.value = true;
            h.settings.urlPreviewsEnabled_e2ee = true;
            h.settings.feature_msc4095_url_preview_bundle = true;
            h.settings.urlPreviewsEnabled_e2ee_bundled_only = true;
            read(textEvent("$b", linkText));
            expect(h.urlPreviewVms[0].props).toMatchObject({ visible: true, urlPreviewKind: "bundledonly" });
        });

        it("with the bundle feature on, a plain room prefers the bundle", () => {
            h.settings.feature_msc4095_url_preview_bundle = true;
            read(textEvent("$p", linkText));
            expect(h.urlPreviewVms[0].props).toMatchObject({ urlPreviewKind: "preferbundled" });
        });

        it("a preview the user hid is none, even when the snapshot still holds it", () => {
            const ev = textEvent("$x", linkText);
            read(ev);
            const vm = h.urlPreviewVms[0];
            vm.set({ previews: [preview] });
            expect(read(ev)[0].urlPreviews).toHaveLength(1);
            vm.hidden = true;
            expect(read(ev)[0]).not.toHaveProperty("urlPreviews");
        });

        it("tells the view-model about a visibility change once, and re-reads on a setting change", () => {
            const ev = textEvent("$s", linkText);
            read(ev);
            const vm = h.urlPreviewVms[0];
            const seen: string[] = [];
            bridge.onChange((e) => seen.push(e.kind));
            expect(h.watchers.size).toBeGreaterThan(0);
            h.settings.urlPreviewsEnabled = false;
            [...h.watchers.values()].find((w) => w.name === "urlPreviewsEnabled")!.cb();
            expect(seen).toEqual(["timeline"]);
            read(ev);
            read(ev);
            expect(vm.updateUrlPreviewVisible).toHaveBeenCalledTimes(1);
            expect(vm.updateUrlPreviewVisible).toHaveBeenCalledWith(false);
            h.mediaVisible.value = false;
            read(ev);
            read(ev);
            expect(vm.updateMediaVisible).toHaveBeenCalledTimes(1);
            expect(vm.updateMediaVisible).toHaveBeenCalledWith(false);
        });

        it("a setting that was off builds the view-model once it is turned on", () => {
            h.settings.urlPreviewsEnabled = false;
            const ev = textEvent("$o", linkText);
            read(ev);
            expect(h.urlPreviewVms).toHaveLength(0);
            h.settings.urlPreviewsEnabled = true;
            [...h.watchers.values()].find((w) => w.name === "urlPreviewsEnabled")!.cb();
            read(ev);
            expect(h.urlPreviewVms).toHaveLength(1);
        });

        it("follows an edit: new links are handed to the same view-model, an unchanged read is not", async () => {
            let content: Record<string, unknown> = { msgtype: "m.text", body: "no link yet" };
            const ev = textEvent("$ed", {}, { getContent: () => content });
            read(ev);
            expect(h.urlPreviewVms).toHaveLength(0);
            content = linkText;
            read(ev);
            read(ev);
            await Promise.resolve();
            expect(h.urlPreviewVms).toHaveLength(1);
            expect(h.urlPreviewVms[0].updateEventElement).toHaveBeenCalledTimes(1);
            content = { msgtype: "m.text", body: "now https://example.org/other" };
            read(ev);
            await Promise.resolve();
            expect(h.urlPreviewVms).toHaveLength(1);
            expect(h.urlPreviewVms[0].updateEventElement).toHaveBeenCalledTimes(2);
            expect(h.urlPreviewVms[0].elements[1].links).toEqual(["https://example.org/other"]);
        });

        it("drops the previews of a redacted message and releases the view-model and its watchers", () => {
            let redacted = false;
            const ev = textEvent(
                "$rd",
                {},
                { getContent: () => (redacted ? {} : linkText), isRedacted: () => redacted },
            );
            read(ev);
            const vm = h.urlPreviewVms[0];
            vm.set({ previews: [preview] });
            expect(read(ev)[0].urlPreviews).toHaveLength(1);
            redacted = true;
            expect(read(ev)[0]).not.toHaveProperty("urlPreviews");
            expect(vm.dispose).toHaveBeenCalledTimes(1);
            expect(vm.listeners.size).toBe(0);
            expect(h.watchers.size).toBe(0);
        });

        it("disposes the view-model, its subscription and its watchers with the bridge", () => {
            read(textEvent("$d", linkText));
            const vm = h.urlPreviewVms[0];
            expect(vm.listeners.size).toBe(1);
            bridge.dispose();
            expect(vm.dispose).toHaveBeenCalledTimes(1);
            expect(vm.listeners.size).toBe(0);
            expect(h.watchers.size).toBe(0);
        });
    });
});
