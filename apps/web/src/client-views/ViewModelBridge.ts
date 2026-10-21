/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import {
    type MatrixClient,
    type MatrixEvent,
    type Room,
    type Relations,
    EventType,
    MatrixEventEvent,
    RelationsEvent,
    RoomStateEvent,
} from "matrix-js-sdk/src/matrix";
import { uniqBy } from "lodash";
import { CryptoEvent } from "matrix-js-sdk/src/crypto-api";
import { type TimelineItem, RoomStatusBarState } from "@element-hq/web-shared-components";

import { SDKContextClass } from "../contexts/SDKContextClass";
import { TimelineRenderingType } from "../contexts/RoomContext";
import SettingsStore from "../settings/SettingsStore";
import { OwnProfileStore } from "../stores/OwnProfileStore";
import defaultDispatcher from "../dispatcher/dispatcher";
import { avatarUrlForRoom } from "../Avatar";
import { resolveRoomMemberProfile, roomMemberToMemberInfo } from "../hooks/room/useRoomMemberProfile";
import { RoomListViewModel } from "../viewmodels/room-list/RoomListViewModel";
import { RoomTimelineViewModel } from "../viewmodels/room/timeline/RoomTimelineViewModel";
import { EventTileViewModel } from "../viewmodels/room/timeline/event-tile/EventTileViewModel";
import { EventTileE2eViewModel } from "../viewmodels/room/timeline/event-tile/EventTileE2eViewModel";
import { DecryptionFailureBodyViewModel } from "../viewmodels/room/timeline/event-tile/body/DecryptionFailureBodyViewModel";
import { EventContentBodyViewModel } from "../viewmodels/message-body/EventContentBodyViewModel";
import { ReplyTileViewModel } from "../viewmodels/room/timeline/event-tile/ReplyTileViewModel";
import { getParentEventId, shouldDisplayReply, stripPlainReply } from "../utils/Reply";
import { ReactionsRowButtonViewModel } from "../viewmodels/room/timeline/event-tile/reactions/ReactionsRowButtonViewModel";
import { getEventTileReactionRelations } from "../viewmodels/room/timeline/event-tile/reactions/EventTileReactionState";
import { UserMenuViewModel } from "../viewmodels/menus/UserMenuViewModel";
import { RoomStatusBarViewModel } from "../viewmodels/room/RoomStatusBar";
import { MemberAvatarViewModel } from "../components/viewmodels/avatars/MemberAvatarViewModel";
import { _t } from "../languageHandler";
import { getClientViews, selectClientView } from "./registry";
import { toViewE2e, toViewMessage, toViewRoom } from "./mapping";
import {
    type ClientViewBridge,
    type ViewConnection,
    type ViewE2e,
    type ViewMe,
    type ViewMessage,
    type ViewReaction,
    type ViewReply,
    type ViewRoom,
    STOCK_VIEW,
} from "./types";

type ChangeEvent = Parameters<Parameters<ClientViewBridge["onChange"]>[0]>[0];

const AVATAR_PX = 64;

/** An event, or the replacement it shows, that is still waiting for its key or failed to decrypt. */
const unreadable = (ev: MatrixEvent): boolean =>
    [ev, ev.replacingEvent()].some(
        (e) => !!e && (e.isDecryptionFailure() || (e.isEncrypted() && e.getClearContent() === null)),
    );

/**
 * The tile, body and E2E view-models of one timeline event, built the way EventTile builds them. `changed` runs when
 * a view-model of the row, or a late decryption of its event, changes what the row shows.
 */
class EventRow {
    public readonly tile: EventTileViewModel;
    public readonly body: EventContentBodyViewModel;
    /** The padlock view-model, as EventTile builds it (EventTile.tsx, e2eViewModel). */
    private padlock: EventTileE2eViewModel;
    private padlockUnsubscribe: () => void;
    /** The replacement the row listens on: the SDK applies a bundled encrypted edit before it decrypts. */
    private replacement: MatrixEvent | null = null;
    private decryption?: DecryptionFailureBodyViewModel;
    private decryptionCode?: unknown;
    /** The reply tile view-model of the replied event, as ReplyChain builds it, once that event is loaded. */
    private reply?: ReplyTileViewModel;
    private replyLookup = false;
    private reactionRelations?: Relations;
    private readonly reactionButtons = new Map<string, ReactionsRowButtonViewModel>();
    private disposed = false;
    private readonly unsubscribe: Array<() => void> = [];

    public constructor(
        private readonly client: MatrixClient,
        private readonly ev: MatrixEvent,
        continuation: boolean,
        private readonly changed: () => void,
        /** The room's downgrade-proof encryption flag (what RoomView feeds EventTile as isRoomEncrypted). */
        private readonly isRoomEncrypted: () => boolean,
    ) {
        // EventTile.createViewModelProps reads only two values from the legacy RoomContext:
        // showHiddenEvents and timelineRenderingType. Everything else is EventTile props or utilities.
        this.tile = new EventTileViewModel(
            {
                mxEvent: ev,
                matrixClient: client,
                showHiddenEvents: SettingsStore.getValue("showHiddenEventsInTimeline"),
            },
            {
                event: { isSending: false, isEditing: false },
                display: {
                    timelineRenderingType: TimelineRenderingType.Room,
                    continuation,
                    isProbablyMedia: false,
                    isHighlighted: false,
                    isSelected: false,
                },
                interaction: {
                    hover: false,
                    showActionBarFromFocus: false,
                    focusWithin: false,
                    isActionBarFocused: false,
                    hasContextMenu: false,
                },
                sender: {
                    member: roomMemberToMemberInfo(
                        resolveRoomMemberProfile({
                            room: client.getRoom(ev.getRoomId() ?? ""),
                            userId: ev.getSender() ?? undefined,
                            member: ev.sender,
                            useOnlyCurrentProfiles: SettingsStore.getValue("useOnlyCurrentProfiles"),
                            timelineRenderingType: TimelineRenderingType.Room,
                        }),
                    ),
                },
                timestamp: {},
                footer: {
                    isOwnEvent: ev.getSender() === client.getUserId(),
                    hasReactionsRow: false,
                    hasReactions: false,
                    hasPinnedMessageBadge: false,
                },
            },
        );
        this.body = new EventContentBodyViewModel({
            as: "div",
            includeDir: false,
            mxEvent: ev,
            content: ev.getContent(),
            stripReply: true,
            linkify: false,
            client,
        });
        this.padlock = this.newPadlock();
        this.padlockUnsubscribe = this.padlock.subscribe(changed);
        this.unsubscribe.push(this.tile.subscribe(changed), this.body.subscribe(changed));
        // A late key turns a decryption failure into a message: the body view-model reads its content once, so it is
        // told the new content (the stock EventTile re-renders with it). Edits it follows itself (Event.replaced).
        // Only this event tells it: getContent() of an unreadable replacement is a new {} on every read, so a content
        // check on each read would re-render forever.
        ev.on(MatrixEventEvent.Decrypted, this.onDecrypted);
        this.unsubscribe.push(() => ev.off(MatrixEventEvent.Decrypted, this.onDecrypted));
        // An edit the SDK applies before it decrypts emits nothing on this event when it later decrypts or fails
        // (Event.replaced fires only on a new replacement), so the row listens on the replacement itself.
        ev.on(MatrixEventEvent.Replaced, this.onReplaced);
        this.unsubscribe.push(() => ev.off(MatrixEventEvent.Replaced, this.onReplaced));
        // The first reaction creates the event's relations (EventTile listens the same way).
        ev.on(MatrixEventEvent.RelationsCreated, changed);
        this.unsubscribe.push(() => ev.off(MatrixEventEvent.RelationsCreated, changed));
        this.followReplacement();
        this.padlock.start();
    }

    private newPadlock(): EventTileE2eViewModel {
        return new EventTileE2eViewModel({
            cli: this.client,
            mxEvent: this.ev,
            isRoomEncrypted: this.isRoomEncrypted(),
            eventSendStatus: this.ev.status,
            enableListeners: true,
        });
    }

    private followReplacement(): void {
        const next = this.ev.replacingEvent();
        if (next === this.replacement) return;
        this.replacement?.off(MatrixEventEvent.Decrypted, this.onReplacementDecrypted);
        this.replacement = next;
        this.replacement?.on(MatrixEventEvent.Decrypted, this.onReplacementDecrypted);
    }

    private readonly onDecrypted = (): void => {
        this.body.setEventContent(this.ev, this.ev.getContent());
        this.changed();
    };

    private readonly onReplaced = (): void => {
        this.followReplacement();
        this.changed();
    };

    /**
     * The replacement decrypted or failed: the body reads the new content, and a fresh padlock view-model verifies the
     * replacement (the shipped one re-verifies only on events of the original).
     */
    private readonly onReplacementDecrypted = (): void => {
        this.body.setEventContent(this.ev, this.ev.getContent());
        this.padlockUnsubscribe();
        this.padlock.dispose();
        this.padlock = this.newPadlock();
        this.padlockUnsubscribe = this.padlock.subscribe(this.changed);
        this.padlock.start();
        this.changed();
    };

    /**
     * The row's E2E trust signals (REQ-0007): the decryption failure body view-model for an undecryptable event, the
     * padlock view-model for a decrypted one. `localDeviceVerified` is what the stock UI reads from
     * LocalDeviceVerificationStateContext.
     */
    public e2e(localDeviceVerified: boolean): ViewE2e | undefined {
        this.padlock.setProps({
            isRoomEncrypted: this.isRoomEncrypted(),
            eventSendStatus: this.ev.status,
        });
        const padlock = this.padlock.getSnapshot();
        let sharedByText: string | undefined;
        if (padlock.kind === "messageShared") {
            const shared = this.tile.getE2eMessageSharedIconViewModel({
                client: this.client,
                roomId: padlock.roomId,
                keyForwardingUserId: padlock.keyForwardingUserId,
            });
            shared.setKeyForwardingUserId(padlock.keyForwardingUserId);
            const { displayName, userId } = shared.getSnapshot();
            sharedByText = _t("timeline|message_shared_by", { displayName, userId });
        }
        // The shown content is the replacement's once there is one: its state is the row's while it is unreadable,
        // else its cleartext m.new_content would arrive as decrypted text. Re-followed at every read: the body hears
        // Event.replaced before this row does and a kit reads in that notification, and a redaction drops the
        // replacement without any event.
        this.followReplacement();
        const replacement = this.replacement;
        const ev = this.ev.isDecryptionFailure() || !replacement?.isDecryptionFailure() ? this.ev : replacement;
        let failure;
        if (ev.isDecryptionFailure()) {
            if (!this.decryption) {
                this.decryption = new DecryptionFailureBodyViewModel({
                    decryptionFailureCode: ev.decryptionFailureReason,
                    verificationState: localDeviceVerified,
                });
                this.decryptionCode = ev.decryptionFailureReason;
                this.unsubscribe.push(this.decryption.subscribe(this.changed));
            }
            // The setters merge into the snapshot and notify; call them only on a change, or a kit's read would loop.
            if (this.decryptionCode !== ev.decryptionFailureReason) {
                this.decryptionCode = ev.decryptionFailureReason;
                this.decryption.setDecryptionFailureCode(ev.decryptionFailureReason);
            }
            if (this.decryption.getSnapshot().isLocalDeviceVerified !== localDeviceVerified) {
                this.decryption.setVerificationState(localDeviceVerified);
            }
            const s = this.decryption.getSnapshot();
            failure = { reason: s.decryptionFailureReason, isLocalDeviceVerified: s.isLocalDeviceVerified };
        }
        return toViewE2e({
            pending: [this.ev, replacement].some((e) => e?.isEncrypted() && e.getClearContent() === null),
            failure,
            padlock,
            sharedByText,
            encrypted: this.ev.isEncrypted(),
            t: _t,
        });
    }

    /**
     * The message this row replies to. A replied event outside the loaded timeline is fetched once, as ReplyChain does
     * (a timeline around it); the row changes when it arrives. Its text is the event's body without its own reply
     * fallback, and empty while that event or its edit is unreadable (never an edit's cleartext m.new_content).
     */
    public replyTo(): ViewReply | undefined {
        const ev = this.ev;
        if (!shouldDisplayReply(ev)) return undefined;
        const parentId = getParentEventId(ev);
        const room = this.client.getRoom(ev.getRoomId() ?? "");
        if (!parentId || !room) return undefined;
        const parent = room.findEventById(parentId);
        if (!parent) {
            if (!this.replyLookup) {
                this.replyLookup = true;
                this.client.getEventTimeline(room.getUnfilteredTimelineSet(), parentId).then(
                    () => {
                        if (!this.disposed && room.findEventById(parentId)) this.changed();
                    },
                    () => {},
                );
            }
            return undefined;
        }
        if (!this.reply) {
            this.reply = new ReplyTileViewModel({ mxEvent: parent, cli: this.client });
            this.unsubscribe.push(this.reply.subscribe(this.changed));
        }
        const senderId = parent.getSender() ?? "";
        // An emote quote has no profile view-model (the name is part of its body).
        const senderName =
            this.reply.getSnapshot().sender?.profileViewModel?.getSnapshot().displayName ||
            parent.sender?.rawDisplayName ||
            senderId;
        const body = parent.getContent().body;
        const text = unreadable(parent) || typeof body !== "string" ? "" : stripPlainReply(body);
        return { eventId: parentId, senderId, senderName, text };
    }

    /**
     * The message's reactions as the reactions row shows them: per key, one vote per sender, the count and selection from
     * its button view-model. The buttons are disabled: adding or toggling a reaction is a send, N/A in a client view.
     */
    public reactions(): ViewReaction[] | undefined {
        const room = this.client.getRoom(this.ev.getRoomId() ?? "");
        const relations =
            (room &&
                getEventTileReactionRelations({
                    mxEvent: this.ev,
                    showReactions: true,
                    getRelationsForEvent: (id, relationType, eventType) =>
                        room.getUnfilteredTimelineSet().relations.getChildEventsForEvent(id, relationType, eventType),
                })) ||
            undefined;
        if (relations !== this.reactionRelations) {
            this.bindReactions(this.reactionRelations, "off");
            this.reactionRelations = relations;
            this.bindReactions(relations, "on");
        }
        const me = this.client.getUserId();
        const mine = (me && relations?.getAnnotationsBySender()?.[me]) || new Set<MatrixEvent>();
        const reactions: ViewReaction[] = [];
        for (const [key, events] of relations?.getSortedAnnotationsByKey() ?? []) {
            const senders = uniqBy([...events], (e) => e.getSender());
            if (!senders.length) continue;
            const myReactionEvent = [...mine].find((e) => !e.isRedacted() && e.getRelation()?.key === key);
            let button = this.reactionButtons.get(key);
            if (!button) {
                button = new ReactionsRowButtonViewModel({
                    client: this.client,
                    mxEvent: this.ev,
                    content: key,
                    count: senders.length,
                    reactionEvents: senders,
                    myReactionEvent,
                    disabled: true,
                });
                this.reactionButtons.set(key, button);
            } else {
                button.setReactionData(key, senders);
                button.setCount(senders.length);
                button.setMyReactionEvent(myReactionEvent);
            }
            const { count, isSelected } = button.getSnapshot();
            reactions.push({ key, count, mine: isSelected, senderIds: senders.map((e) => e.getSender() ?? "") });
        }
        for (const [key, button] of this.reactionButtons) {
            if (reactions.some((r) => r.key === key)) continue;
            button.dispose();
            this.reactionButtons.delete(key);
        }
        return reactions.length ? reactions : undefined;
    }

    private bindReactions(relations: Relations | undefined, how: "on" | "off"): void {
        for (const name of [RelationsEvent.Add, RelationsEvent.Remove, RelationsEvent.Redaction]) {
            relations?.[how](name, this.changed);
        }
    }

    public dispose(): void {
        this.disposed = true;
        this.bindReactions(this.reactionRelations, "off");
        this.reactionRelations = undefined;
        this.reactionButtons.forEach((b) => b.dispose());
        this.reactionButtons.clear();
        this.unsubscribe.forEach((u) => u());
        this.unsubscribe.length = 0;
        this.replacement?.off(MatrixEventEvent.Decrypted, this.onReplacementDecrypted);
        this.replacement = null;
        this.padlockUnsubscribe();
        this.tile.dispose();
        this.body.dispose();
        this.padlock.dispose();
        this.decryption?.dispose();
        this.reply?.dispose();
    }
}

/**
 * A ClientViewBridge fed only from shipped view-model snapshots. View-models are built outside their legacy
 * parent components; the matrix-js-sdk objects they need as props are passed through, never read for data.
 */
type EventItem = Extract<TimelineItem, { kind: "event" }>;

export class ViewModelBridge implements ClientViewBridge {
    public readonly version = 1;

    private readonly listeners = new Set<(e: ChangeEvent) => void>();
    private readonly disposers: Array<() => void> = [];
    private readonly roomList: RoomListViewModel;
    private readonly userMenu: UserMenuViewModel;
    private readonly watchedItems = new Set<string>();
    private readonly timelines = new Map<string, RoomTimelineViewModel>();
    private readonly rows = new Map<string, EventRow>();
    private readonly senderAvatars = new Map<string, MemberAvatarViewModel>();
    /** Per room: encrypted once either the room state or the crypto store said so (never back to false). */
    private readonly encrypted = new Map<string, boolean>();
    private statusBar?: RoomStatusBarViewModel;
    private roomCache: ViewRoom[] = [];
    private lastConnection: ViewConnection = "online";
    /** Whether the signed-in user's cross-signing identity is verified: the stock UI's "local device verified" state. */
    private localDeviceVerified = false;
    private isUsed = false;
    /** Called when a kit document first reads the bridge, from inside its scripts (before its DOMContentLoaded). */
    public onUse?: () => void;

    /** Whether a kit has read anything from this bridge yet: the host's sign that the kit started. */
    public get used(): boolean {
        return this.isUsed;
    }

    public set used(value: boolean) {
        const first = value && !this.isUsed;
        this.isUsed = value;
        if (first) this.onUse?.();
    }

    public constructor(private readonly client: MatrixClient) {
        this.roomList = new RoomListViewModel({
            client,
            roomViewStore: SDKContextClass.instance.roomViewStore,
            spaceStore: SDKContextClass.instance.spaceStore,
        });
        this.disposers.push(this.roomList.subscribe(() => this.syncRooms()));
        this.userMenu = new UserMenuViewModel(
            { ownProfileStore: OwnProfileStore.instance },
            defaultDispatcher,
            client,
            false,
        );
        this.disposers.push(this.userMenu.subscribe(() => this.emit({ kind: "me" })));
        this.watchLocalVerification();
        this.watchEncryption();
        this.syncRooms();
    }

    /**
     * Whether a room is encrypted, as RoomView's useIsEncrypted feeds EventTile: the crypto store's flag, which stays
     * true when a server removes m.room.encryption from the room state (downgrade guard). It is async, so the state
     * flag answers until it arrives; either one saying "encrypted" sticks.
     */
    private isRoomEncrypted(roomId: string): boolean {
        let known = this.encrypted.get(roomId);
        if (known === undefined) {
            known = this.client.isRoomEncrypted(roomId);
            this.encrypted.set(roomId, known);
            this.readEncryption(roomId);
        }
        return known;
    }

    private readEncryption(roomId: string): void {
        void this.client
            .getCrypto()
            ?.isEncryptionEnabledInRoom(roomId)
            .then(
                (enabled) => {
                    if (!enabled || this.encrypted.get(roomId)) return;
                    this.encrypted.set(roomId, true);
                    this.emit({ kind: "timeline", roomId });
                },
                () => {},
            );
    }

    /** useIsEncrypted re-reads the flag on every m.room.encryption state event. */
    private watchEncryption(): void {
        const onState = (ev: MatrixEvent): void => {
            const roomId = ev.getRoomId();
            if (ev.getType() !== EventType.RoomEncryption || !roomId || !this.encrypted.has(roomId)) return;
            this.readEncryption(roomId);
        };
        this.client.on(RoomStateEvent.Events, onState);
        this.disposers.push(() => this.client.off(RoomStateEvent.Events, onState));
    }

    /**
     * What MatrixClientContextProvider feeds the stock UI's LocalDeviceVerificationStateContext (the decryption
     * failure body reads it): the user's own cross-signing verification, read once and on every trust change.
     */
    private watchLocalVerification(): void {
        const client = this.client;
        const userId = client.getUserId();
        if (!userId) return;
        const set = (verified: boolean): void => {
            if (verified === this.localDeviceVerified) return;
            this.localDeviceVerified = verified;
            this.timelines.forEach((_, roomId) => this.emit({ kind: "timeline", roomId }));
        };
        void client
            .getCrypto()
            ?.getUserVerificationStatus(userId)
            .then(
                (status) => set(status.isCrossSigningVerified()),
                () => {},
            );
        const onTrust = (id: string, status: { isCrossSigningVerified(): boolean }): void => {
            if (id === userId) set(status.isCrossSigningVerified());
        };
        client.on(CryptoEvent.UserTrustStatusChanged, onTrust);
        this.disposers.push(() => client.off(CryptoEvent.UserTrustStatusChanged, onTrust));
    }

    private emit(e: ChangeEvent): void {
        this.listeners.forEach((cb) => cb(e));
    }

    private syncRooms(): void {
        const ids = this.roomList.getSnapshot().sections.flatMap((s) => s.roomIds);
        // Item view-models exist only for rooms the list was told are visible.
        this.roomList.updateVisibleRooms(0, ids.length);
        const rooms: ViewRoom[] = [];
        for (const id of ids) {
            const item = this.roomList.getRoomItemViewModel(id);
            if (!item) continue;
            if (!this.watchedItems.has(id)) {
                this.watchedItems.add(id);
                this.disposers.push(item.subscribe(() => this.syncRooms()));
            }
            const s = item.getSnapshot();
            const room = this.client.getRoom(id);
            const avatarUrl = room ? (avatarUrlForRoom(room, AVATAR_PX, AVATAR_PX, "crop") ?? undefined) : undefined;
            rooms.push(toViewRoom(s, rooms.length, avatarUrl));
            if (!this.statusBar && room) this.watchConnection(room);
        }
        if (JSON.stringify(rooms) === JSON.stringify(this.roomCache)) return;
        this.roomCache = rooms;
        this.emit({ kind: "rooms" });
    }

    /** The sync state is global; the room status bar view-model exposes it for whichever room it is given. */
    private watchConnection(room: Room): void {
        this.statusBar = new RoomStatusBarViewModel({ room });
        this.disposers.push(
            this.statusBar.subscribe(() => {
                const next = this.connection();
                if (next === this.lastConnection) return;
                this.lastConnection = next;
                this.emit({ kind: "connection" });
            }),
        );
        this.lastConnection = this.connection();
    }

    private ensureTimeline(roomId: string): RoomTimelineViewModel | undefined {
        const existing = this.timelines.get(roomId);
        if (existing) return existing;
        // The snapshot's room is opaque (a preview row holds no Room), so the Room the view-model needs comes from
        // the client; it only wires the view-model, the data still comes from its snapshot.
        if (!this.roomList.getRoomItemViewModel(roomId)) return undefined;
        const room = this.client.getRoom(roomId);
        if (!room) return undefined;
        const vm = new RoomTimelineViewModel({ client: this.client, room });
        this.timelines.set(roomId, vm);
        // start() opens on the reader's saved scroll position in the stock UI, which may be a window without the
        // newest messages. A kit shows a room from its live end, so once the first window has loaded, ask the
        // view-model for the live end the way its "Jump to live" button does (no scroll: the kit has no list view).
        let opened = false;
        this.disposers.push(
            vm.subscribe(() => {
                const s = vm.getSnapshot();
                if (!opened && s.items.length > 0) {
                    opened = true;
                    if (!s.atLiveEnd) vm.onJumpToLive(() => {});
                }
                this.emit({ kind: "timeline", roomId });
            }),
        );
        vm.start();
        return vm;
    }

    private row(item: EventItem, roomId: string): EventRow {
        const ev = item.event as MatrixEvent;
        const key = ev.getId()!;
        let row = this.rows.get(key);
        if (!row) {
            row = new EventRow(
                this.client,
                ev,
                item.continuation,
                () => this.emit({ kind: "timeline", roomId }),
                () => this.isRoomEncrypted(roomId),
            );
            this.rows.set(key, row);
        }
        return row;
    }

    /** The sender's avatar from the member avatar view-model, one per (room, sender), the way EventTile shows it. */
    private senderAvatarUrl(roomId: string, senderId: string): string | undefined {
        const key = `${roomId}\n${senderId}`;
        let vm = this.senderAvatars.get(key);
        if (!vm) {
            const member = this.client.getRoom(roomId)?.getMember(senderId);
            if (!member) return undefined;
            vm = new MemberAvatarViewModel({ member, size: AVATAR_PX, cli: this.client });
            this.senderAvatars.set(key, vm);
            this.disposers.push(vm.subscribe(() => this.emit({ kind: "timeline", roomId })));
        }
        return vm.getSnapshot().url;
    }

    public me(): ViewMe {
        this.used = true;
        const s = this.userMenu.getSnapshot();
        return { userId: s.userId, displayName: s.displayName, avatarUrl: s.avatarUrl };
    }

    public rooms(): ViewRoom[] {
        this.used = true;
        return this.roomCache;
    }

    public timeline(roomId: string): ViewMessage[] {
        this.used = true;
        const vm = this.ensureTimeline(roomId);
        if (!vm) return [];
        const messages: ViewMessage[] = [];
        for (const item of vm.getSnapshot().items) {
            if (item.kind !== "event") continue;
            const eventItem = item;
            if (eventItem.sendState && eventItem.sendState !== "sent") continue;
            const id = (eventItem.event as MatrixEvent).getId();
            if (!id || id.startsWith("~")) continue;
            const row = this.row(eventItem, roomId);
            const tile = row.tile.getSnapshot().snapshot;
            // An event still waiting for its key keeps the SDK type m.room.encrypted (a failed one is m.room.message).
            const isMessage =
                tile.event.eventType === EventType.RoomMessage ||
                tile.event.eventType === EventType.RoomMessageEncrypted;
            if (!isMessage || tile.event.isLocalEcho) continue;
            const senderAvatarUrl = tile.sender.senderId
                ? this.senderAvatarUrl(roomId, tile.sender.senderId)
                : undefined;
            const message = toViewMessage(
                roomId,
                tile,
                row.body.getSnapshot(),
                senderAvatarUrl,
                row.e2e(this.localDeviceVerified),
                row.replyTo(),
                row.reactions(),
            );
            if (message) messages.push(message);
        }
        return messages.sort((a, b) => a.ts - b.ts);
    }

    public markRead(roomId: string): void {
        // The timeline view-model's "mark all as read" = the room list's "Mark as read" path.
        this.ensureTimeline(roomId)?.onMarkAllAsRead();
    }

    public connection(): ViewConnection {
        // The status bar view-model distinguishes only "connection lost"; "connecting" has no view-model source
        // (an N/A row in the kit's capability table).
        return this.statusBar?.getSnapshot().state === RoomStatusBarState.ConnectionLost ? "offline" : "online";
    }

    public views(): { id: string; name: string }[] {
        return [{ id: STOCK_VIEW, name: "Element" }, ...getClientViews().map(({ id, name }) => ({ id, name }))];
    }

    public switchTo(viewId: string): void {
        void selectClientView(viewId);
    }

    public onChange(cb: (e: ChangeEvent) => void): () => void {
        this.used = true;
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    public dispose(): void {
        this.disposers.forEach((d) => d());
        this.rows.forEach((r) => r.dispose());
        this.senderAvatars.forEach((a) => a.dispose());
        this.timelines.forEach((t) => t.dispose());
        this.statusBar?.dispose();
        this.userMenu.dispose();
        this.roomList.dispose();
        this.listeners.clear();
    }
}
