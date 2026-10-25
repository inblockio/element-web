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
    Direction,
    type Relations,
    type Thread,
    EventType,
    KnownMembership,
    ClientEvent,
    MatrixEventEvent,
    MsgType,
    RelationsEvent,
    RoomStateEvent,
    THREAD_RELATION_TYPE,
    ThreadEvent,
} from "matrix-js-sdk/src/matrix";
import { uniq, uniqBy } from "lodash";
import { CryptoEvent } from "matrix-js-sdk/src/crypto-api";
import { type MediaEventContent } from "matrix-js-sdk/src/types";
import { logger } from "matrix-js-sdk/src/logger";
import type { RefObject } from "react";
import {
    type FileBodyViewSnapshot,
    type ImageBodyViewSnapshot,
    type TimelineItem,
    type VideoBodyViewSnapshot,
    ActionBarAction,
    RoomStatusBarState,
} from "@element-hq/web-shared-components";

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
import { ImageBodyViewModel } from "../viewmodels/message-body/ImageBodyViewModel";
import { VideoBodyViewModel } from "../viewmodels/message-body/VideoBodyViewModel";
import { FileBodyViewModel } from "../viewmodels/message-body/FileBodyViewModel";
import {
    BUNDLED_LINK_PREVIEWS,
    UrlPreviewGroupViewModel,
    type UrlPreviewKind,
} from "../viewmodels/message-body/UrlPreviewGroupViewModel";
import { ModuleApi } from "../modules/Api";
import { bodyToNode } from "../HtmlUtils";
import { presentableTextForFile } from "../utils/FileUtils";
import { type SettingKey } from "../settings/Settings";
import { MediaEventHelper } from "../utils/MediaEventHelper";
import { getMediaVisibility } from "../utils/media/mediaVisibility";
import { ReplyTileViewModel } from "../viewmodels/room/timeline/event-tile/ReplyTileViewModel";
import { getParentEventId, shouldDisplayReply, stripPlainReply } from "../utils/Reply";
import { ReactionsRowButtonViewModel } from "../viewmodels/room/timeline/event-tile/reactions/ReactionsRowButtonViewModel";
import { getEventTileReactionRelations } from "../viewmodels/room/timeline/event-tile/reactions/EventTileReactionState";
import { canEditContent, isContentActionable } from "../utils/EventUtils";
import PinningUtils from "../utils/PinningUtils";
import { RoomPermalinkCreator } from "../utils/permalinks/Permalinks";
import { EventTileActionBarViewModel } from "../viewmodels/room/EventTileActionBarViewModel";
import { RedactedBodyViewModel } from "../viewmodels/message-body/RedactedBodyViewModel";
import { getRedactedBodyViewModelProps } from "../viewmodels/room/timeline/event-tile/EventTileRedactedBodyState";
import { getEventTileThread } from "../viewmodels/room/timeline/event-tile/EventTileThreadState";
import { UserMenuViewModel } from "../viewmodels/menus/UserMenuViewModel";
import { RoomStatusBarViewModel } from "../viewmodels/room/RoomStatusBar";
import { MemberAvatarViewModel } from "../components/viewmodels/avatars/MemberAvatarViewModel";
import { _t } from "../languageHandler";
import { CallCard } from "./CallCard";
import { getClientViews, getMeetUrl, selectClientView } from "./registry";
import { toViewAudio, toViewE2e, toViewMedia, toViewMessage, toViewRoom, toViewUrlPreviews } from "./mapping";
import { canDownloadMedia, downloadMedia } from "./DownloadAction";
import UserProvider from "../autocomplete/UserProvider";
import { acceptInvite, declineInvite, editText, joinRoom, logout, redact, sendText } from "./InterimActions";
import { createRoomViaDialog, leaveViaDialog, startChatViaDialog, viewSourceViaDialog } from "./RoomActions";
import Modal from "../Modal";
import ViewSource from "../components/structures/ViewSource";
import { openFilePicker, rewrapFiles, uploadFiles } from "./UploadAction";
import { RoomUploadViewModel } from "../viewmodels/room/RoomUploadViewModel";
import { EchoChamber } from "../stores/local-echo/EchoChamber";
import { PROPERTY_UPDATED } from "../stores/local-echo/GenericEchoChamber";
import { markUnread, type RoomItemActionsVm, setFavourite, setNotificationLevel } from "./RoomItemActions";
import { setPinned } from "./PinAction";
import { openReport } from "./ReportAction";
import { createSection, type RoomSectionVm, setSection } from "./RoomSectionActions";
import { isLocalRoom } from "../utils/localRoom/isLocalRoom";
import { type LocalRoom, LocalRoomState } from "../models/LocalRoom";
import { DefaultTagID } from "../stores/room-list-v3/skip-list/tag";
import RoomListStoreV3, { RoomListStoreV3Event } from "../stores/room-list-v3/RoomListStoreV3";
import { toActionError } from "./actions";
import {
    type ActionOutcome,
    type ClientViewBridge,
    type LoadOlderResult,
    type ViewAnchor,
    type ViewConnection,
    type ViewE2e,
    type ViewMe,
    type ViewMedia,
    type ViewMessage,
    type ViewReaction,
    type ViewReply,
    type ViewNotificationLevel,
    type ViewRoom,
    type ViewSection,
    type ViewThread,
    type ViewUrlPreview,
    ClientViewActionError,
    STOCK_VIEW,
} from "./types";

type ChangeEvent = Parameters<Parameters<ClientViewBridge["onChange"]>[0]>[0];

const AVATAR_PX = 64;
/**
 * The timeline view-model's window size and page size (`WINDOW_LIMIT` and `PAGINATE_SIZE`, not exported). A window
 * within one page of its limit cannot take another page without dropping events at the live end.
 */
const WINDOW_LIMIT = 1000;
const PAGE_SIZE = 100;
/** How often `loadOlder` looks at the view-model while it waits for it, and how long it waits at most. */
const LOAD_OLDER_POLL_MS = 25;
const LOAD_OLDER_TIMEOUT_MS = 30_000;
/** The pause before a failed fetch of a replied event outside the timeline is tried again. */
const REPLY_RETRY_MS = 30_000;
/** How long a reaction press waits for the snapshot to show it before it is reported failed. */
export const REACTION_TIMEOUT_MS = 15_000;
/** How often a waiting reaction press re-reads the row (a first reaction on a message emits nothing of its own). */
const REACTION_POLL_MS = 200;

/** What ReactionsRowAdapter reads from RoomContext for the disabled rule of its buttons (RoomView.updatePermissions). */
export interface ReactionPermissions {
    canReact: boolean;
    canSelfRedact: boolean;
}

/** Element's reaction picker over the kit: what the host renders (ReactionPickerOverlay) until `finish`. */
export interface ReactionPickerRequest {
    /** Unique per request (event id plus a counter): the host keys the picker by it so a replacement remounts. */
    key: string;
    room: Room;
    mxEvent: MatrixEvent;
    reactions: Relations | null | undefined;
    permissions: ReactionPermissions;
    anchor: ViewAnchor;
    finish: () => void;
}

/** An event, or the replacement it shows, that is still waiting for its key or failed to decrypt. */
const unreadable = (ev: MatrixEvent): boolean =>
    [ev, ev.replacingEvent()].some(
        (e) => !!e && (e.isDecryptionFailure() || (e.isEncrypted() && e.getClearContent() === null)),
    );

interface MediaBodyBase {
    helper: MediaEventHelper;
    /** The file the body was built for (content `url` / `file.url`): another file, as an edit brings, rebuilds it. */
    identity: string;
    unsubscribe: () => void;
}
/** An audio message: the media helper's URL once it is there, `failed` if it could not be fetched or decrypted. */
type AudioMediaBody = MediaBodyBase & { kind: "audio"; url?: string; failed: boolean };
/** An image, video or file message: its body view-model. */
type ViewModelMediaBody = MediaBodyBase & {
    kind: "image" | "video" | "file";
    vm: ImageBodyViewModel | VideoBodyViewModel | FileBodyViewModel;
    visible: boolean;
    /** Whether `onPlay` was asked for: an encrypted video decrypts only on play, and it must not be asked twice. */
    played: boolean;
};
type MediaBody = AudioMediaBody | ViewModelMediaBody;

/**
 * The tile, body and E2E view-models of one timeline event, built the way EventTile builds them. `changed` runs when
 * a view-model of the row, or a late decryption of its event, changes what the row shows.
 */
class EventRow {
    public readonly tile: EventTileViewModel;
    public readonly body: EventContentBodyViewModel;
    public readonly roomId: string;
    /** The Matrix event this row shows. */
    public get event(): MatrixEvent {
        return this.ev;
    }
    /** The padlock view-model, as EventTile builds it (EventTile.tsx, e2eViewModel). */
    private padlock: EventTileE2eViewModel;
    private padlockUnsubscribe: () => void;
    /** The replacement the row listens on: the SDK applies a bundled encrypted edit before it decrypts. */
    private replacement: MatrixEvent | null = null;
    private decryption?: DecryptionFailureBodyViewModel;
    private decryptionCode?: unknown;
    /** The reply tile view-model of the replied event, as ReplyChain builds it, once that event is loaded. */
    private reply?: ReplyTileViewModel;
    /** When the replied event may be fetched (again): a failed fetch waits REPLY_RETRY_MS before the next read tries. */
    private replyFetchAt = 0;
    private replyFetching = false;
    /** The replied event's edit, followed: a bundled edit emits nothing on the replied event when it decrypts. */
    private replyEdit: MatrixEvent | null = null;
    private reactionRelations?: Relations;
    private readonly reactionButtons = new Map<string, ReactionsRowButtonViewModel>();
    /** Releases the listeners of the thread summary view-model, which the tile owns and disposes with the row. */
    private threadSummaryRelease?: () => void;
    /** The latest thread reply's edit, followed: the preview listens on the reply, which a bundled edit leaves silent. */
    private lastReplyEdit: MatrixEvent | null = null;
    /** The image, video, file or audio body of a media message, as MBodyFactory builds it, built on first read. */
    private mediaBody?: MediaBody;
    /** The link previews of a text message that has a link, built on first read (see `urlPreviews`). */
    private urlPreview?: {
        kind: UrlPreviewKind;
        vm?: UrlPreviewGroupViewModel;
        /** What the view-model was last told, so a read tells it only a change. */
        visible: boolean;
        mediaVisible: boolean;
        contentKey: string;
        unsubscribe?: () => void;
        unwatch: () => void;
    };
    /** Element's redacted body view-model, built on the first read of a redacted event. */
    private redactedBody?: RedactedBodyViewModel;
    private disposed = false;
    private readonly unsubscribe: Array<() => void> = [];

    public constructor(
        private readonly client: MatrixClient,
        private readonly ev: MatrixEvent,
        continuation: boolean,
        private readonly changed: () => void,
        /** The room's downgrade-proof encryption flag (what RoomView feeds EventTile as isRoomEncrypted). */
        private readonly isRoomEncrypted: () => boolean,
        /** Whether the crypto answer for the room has settled (RoomView awaits it before it computes showUrlPreview). */
        private readonly isEncryptionSettled: () => boolean,
        /** The user's power in the room, for the disabled rule of the reaction buttons (re-read on every use). */
        private readonly permissions: () => ReactionPermissions,
    ) {
        this.roomId = ev.getRoomId() ?? "";
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
        // The root of a thread learns its thread from the event, or from the room when the thread is created later
        // (EventTile listens the same way).
        ev.on(ThreadEvent.Update, changed);
        this.unsubscribe.push(() => ev.off(ThreadEvent.Update, changed));
        const room = client.getRoom(ev.getRoomId() ?? "");
        room?.on(ThreadEvent.New, this.onNewThread);
        this.unsubscribe.push(() => room?.off(ThreadEvent.New, this.onNewThread));
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

    private readonly onNewThread = (thread: Thread): void => {
        if (thread.id === this.ev.getId()) this.changed();
    };

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
     * Element's redacted body text ("Message deleted", `getRedactedBodyViewModelProps` through the redacted body
     * view-model) when the event is redacted, else undefined.
     */
    public redactedText(): string | undefined {
        if (!this.ev.isRedacted()) return undefined;
        const props = getRedactedBodyViewModelProps(this.ev, SettingsStore.getValue("showTwelveHourTimestamps"));
        if (!this.redactedBody) this.redactedBody = new RedactedBodyViewModel(props);
        else if (this.redactedBody.getSnapshot().text !== props.text) this.redactedBody.setProps(props);
        return this.redactedBody.getSnapshot().text;
    }

    /** Element's edit rule for this event (`canEditContent`), the rule the edit action bar button follows. */
    public canEdit(): boolean {
        return canEditContent(this.client, this.ev);
    }

    /** M6 B2: the event is in the room's `m.room.pinned_events` (the action bar view-model's own source). */
    public pinned(): boolean {
        return PinningUtils.isPinned(this.client, this.ev);
    }

    /** M6 B2: Element offers Unpin on a pinned event and Pin on an unpinned one (`PinningUtils`, as the action bar reads them). */
    public canPin(): boolean {
        return this.pinned() ? PinningUtils.canUnpin(this.client, this.ev) : PinningUtils.canPin(this.client, this.ev);
    }

    /** Element's rule for the Download action bar button (no view-model per row), see {@link canDownloadMedia}. */
    public canDownload(): boolean {
        return canDownloadMedia(this.ev);
    }

    /** The edited marker's rule (`TextualBodyViewModel`): a replacement event exists. */
    public edited(): boolean {
        return !!this.ev.replacingEventId();
    }

    /** When the latest replacement was sent (its `origin_server_ts`), else undefined. */
    public editedTs(): number | undefined {
        // The server aggregation the edited marker uses, else the replacement held in memory.
        return this.ev.replacingEventDate()?.getTime() ?? this.ev.replacingEvent()?.getTs();
    }

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
            if (!this.replyFetching && Date.now() >= this.replyFetchAt) {
                this.replyFetching = true;
                this.replyFetchAt = Infinity;
                this.client.getEventTimeline(room.getUnfilteredTimelineSet(), parentId).then(
                    () => {
                        this.replyFetching = false;
                        if (!this.disposed && room.findEventById(parentId)) this.changed();
                    },
                    () => {
                        this.replyFetching = false;
                        this.replyFetchAt = Date.now() + REPLY_RETRY_MS;
                    },
                );
            }
            return undefined;
        }
        const edit = parent.replacingEvent();
        if (edit !== this.replyEdit) {
            this.replyEdit?.off(MatrixEventEvent.Decrypted, this.changed);
            this.replyEdit = edit;
            this.replyEdit?.on(MatrixEventEvent.Decrypted, this.changed);
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
        // As the stock body: only a reply's own fallback is stripped, and an edit's body has none.
        const isReply = !parent.replacingEvent() && !!getParentEventId(parent);
        const text = unreadable(parent) || typeof body !== "string" ? "" : isReply ? stripPlainReply(body) : body;
        return { eventId: parentId, senderId, senderName, text };
    }

    /** The message's reaction relations now; rebinds the change listeners when the Relations object changed. */
    private currentReactionRelations(): Relations | undefined {
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
        return relations;
    }

    /**
     * The message's reactions as the reactions row shows them: per key, one vote per sender, the count and selection from
     * its button view-model. The buttons carry the stock disabled rule (ReactionsRowAdapter: can react, and can redact
     * for a reaction of the user's own), so `pressReaction` can call their click.
     */
    public reactions(): ViewReaction[] | undefined {
        const relations = this.currentReactionRelations();
        // The stock row shows no chips where the content is not actionable (redacted, undecryptable, an edit not yet
        // decrypted): neither does the view. The listeners stay bound, so a later decryption re-reads them.
        if (!isContentActionable(this.ev)) return undefined;
        const me = this.client.getUserId();
        const mine = (me && relations?.getAnnotationsBySender()?.[me]) || new Set<MatrixEvent>();
        const { canReact, canSelfRedact } = this.permissions();
        const reactions: ViewReaction[] = [];
        for (const [key, events] of relations?.getSortedAnnotationsByKey() ?? []) {
            const senders = uniqBy([...events], (e) => e.getSender());
            if (!senders.length) continue;
            const myReactionEvent = [...mine].find((e) => !e.isRedacted() && e.getRelation()?.key === key);
            const disabled = !canReact || (!!myReactionEvent && !myReactionEvent.isRedacted() && !canSelfRedact);
            let button = this.reactionButtons.get(key);
            if (!button) {
                button = new ReactionsRowButtonViewModel({
                    client: this.client,
                    mxEvent: this.ev,
                    content: key,
                    count: senders.length,
                    reactionEvents: senders,
                    myReactionEvent,
                    disabled,
                });
                this.reactionButtons.set(key, button);
            } else {
                button.setReactionData(key, senders);
                button.setCount(senders.length);
                button.setMyReactionEvent(myReactionEvent);
                button.setDisabled(disabled);
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

    /** The relations the picker follows to mark the user's reactions (null when the message has none yet). */
    public relations(): Relations | undefined {
        this.reactions();
        return this.reactionRelations;
    }

    /** Whether the stock row would show this message's reactions and add button (the content is actionable). */
    public actionable(): boolean {
        return isContentActionable(this.ev);
    }

    /**
     * Presses the chip of `key` the way the stock row does: the button view-model's own click sends the annotation or
     * redacts the user's own (D1: nothing re-implemented here). A key without a chip gets a fresh button view-model for
     * it. Returns the user's state of that key before the press, or undefined when the disabled rule blocks it.
     */
    public pressReaction(key: string): { wasMine: boolean } | undefined {
        if (!isContentActionable(this.ev)) return undefined;
        const shown = this.reactions() ?? [];
        const existing = this.reactionButtons.get(key);
        const button =
            existing ??
            new ReactionsRowButtonViewModel({
                client: this.client,
                mxEvent: this.ev,
                content: key,
                count: 0,
                reactionEvents: [],
                disabled: !this.permissions().canReact,
            });
        try {
            if (button.getSnapshot().isDisabled) return undefined;
            const wasMine = shown.find((r) => r.key === key)?.mine ?? false;
            button.onClick();
            return { wasMine };
        } finally {
            if (!existing) button.dispose();
        }
    }

    /**
     * Whether the user has a live (not redacted) reaction `key` in the room's relations now. Read from the relations
     * directly: unlike the snapshot it does not depend on the content being actionable, so an undecryptable edit in
     * between cannot make a reaction that is still there look gone.
     */
    public isMine(key: string): boolean {
        const me = this.client.getUserId();
        const mine = me ? this.currentReactionRelations()?.getAnnotationsBySender()?.[me] : undefined;
        return [...(mine ?? [])].some((e) => !e.isRedacted() && e.getRelation()?.key === key);
    }

    /**
     * The thread this message roots, as the thread summary under it shows it: the reply count the summary view-model
     * counts (it is visible only for a thread with replies), the latest reply and the repliers. The view-model is the
     * tile's own; opening the thread is the summary's click action, N/A in a client view. The latest reply's text is
     * blank while that event or its edit is unreadable (the summary view-model shows its own placeholder instead).
     */
    public threadSummary(): ViewThread | undefined {
        const thread = getEventTileThread(this.ev, this.client.getRoom(this.ev.getRoomId() ?? ""));
        if (!thread || thread.id !== this.ev.getId()) {
            this.releaseThreadSummary();
            return undefined;
        }
        const first = !this.threadSummaryRelease;
        const vm = this.tile.getThreadSummaryViewModel({
            cli: this.client,
            mxEvent: this.ev,
            thread,
            narrow: false,
            isCard: false,
            room: thread.room,
            timelineRenderingType: TimelineRenderingType.Room,
            lowBandwidth: SettingsStore.getValue("lowBandwidth"),
            useOnlyCurrentProfiles: SettingsStore.getValue("useOnlyCurrentProfiles"),
        });
        vm.setThread(thread);
        const snapshot = vm.getSnapshot();
        if (first) {
            // The preview view-model follows the latest reply's decryption and edits; the summary's own snapshot
            // follows the thread (count) and its notifications.
            const unsubscribes = [vm.subscribe(this.changed), snapshot.previewVm.subscribe(this.changed)];
            this.threadSummaryRelease = () => unsubscribes.forEach((u) => u());
        }
        if (!snapshot.isVisible) return undefined;
        const last = thread.replyToEvent;
        this.followLastReplyEdit(last?.replacingEvent() ?? null);
        const body = last?.getContent().body;
        // An edit's body has no reply fallback to strip (as replyTo).
        const text =
            !last || unreadable(last) || typeof body !== "string"
                ? ""
                : last.replacingEvent()
                  ? body
                  : stripPlainReply(body);
        const lastReply =
            last && last.getId() ? { eventId: last.getId()!, senderId: last.getSender() ?? "", text } : undefined;
        // The thread timeline also holds reactions and edits once fetched; only replies count (as Thread.length).
        const repliers = thread.events
            .filter((e) => e.getId() !== thread.id && e.isRelation(THREAD_RELATION_TYPE.name))
            .map((e) => e.getSender() ?? "");
        return {
            replyCount: thread.length,
            lastReplyTs: (last ?? this.ev).getTs(),
            ...(lastReply ? { lastReply } : {}),
            participantIds: uniq([...repliers, ...(lastReply ? [lastReply.senderId] : [])].filter(Boolean)),
        };
    }

    private followLastReplyEdit(edit: MatrixEvent | null): void {
        if (edit === this.lastReplyEdit) return;
        this.lastReplyEdit?.off(MatrixEventEvent.Decrypted, this.changed);
        this.lastReplyEdit = edit;
        this.lastReplyEdit?.on(MatrixEventEvent.Decrypted, this.changed);
    }

    private releaseThreadSummary(): void {
        this.followLastReplyEdit(null);
        if (!this.threadSummaryRelease) return;
        this.threadSummaryRelease();
        this.threadSummaryRelease = undefined;
        this.tile.releaseThreadSummaryViewModel();
    }

    private bindReactions(relations: Relations | undefined, how: "on" | "off"): void {
        for (const name of [RelationsEvent.Add, RelationsEvent.Remove, RelationsEvent.Redaction]) {
            relations?.[how](name, this.changed);
        }
    }

    /**
     * The media body of an image, video or file message. The view-model decrypts or fetches on its own and notifies
     * `changed` when its snapshot gets the URL. Element's media-visibility setting is mirrored: hidden stays hidden.
     */
    public media(): ViewMedia | undefined {
        // The live content, not the tile snapshot (built once): it is the replacement's after an edit, `{}` once
        // redacted, and the clear content once decrypted.
        const content: { msgtype?: string; url?: string; file?: { url?: string } } = this.ev.isRedacted()
            ? {}
            : this.ev.getContent();
        const kind =
            content.msgtype === MsgType.Image
                ? "image"
                : content.msgtype === MsgType.Video
                  ? "video"
                  : content.msgtype === MsgType.File
                    ? "file"
                    : content.msgtype === MsgType.Audio
                      ? "audio"
                      : undefined;
        const identity = `${content.url ?? ""}|${content.file?.url ?? ""}`;
        if (this.disposed || kind !== this.mediaBody?.kind || identity !== this.mediaBody?.identity) {
            this.releaseMedia();
        }
        if (this.disposed || !kind) return undefined;
        const visible = getMediaVisibility(this.ev, this.client);
        if (!this.mediaBody) this.mediaBody = this.newMedia(kind, identity, visible);
        const body = this.mediaBody;
        if (body.kind === "audio") {
            // The label the audio player shows (a voice message is the same body); nothing here decodes the file.
            const name = presentableTextForFile(this.ev.getContent<MediaEventContent>(), undefined, false);
            return toViewAudio(name, body.url, body.failed ? _t("timeline|m.audio|error_processing_audio") : undefined);
        }
        // Called only on a change: the setters notify, and a kit's read must not loop.
        if (body.kind !== "file" && body.visible !== visible) {
            body.visible = visible;
            (body.vm as ImageBodyViewModel | VideoBodyViewModel).setMediaVisible(visible);
        }
        const snapshot = body.vm.getSnapshot();
        // An encrypted video with autoplay off carries a data: placeholder until played; nobody clicks play here.
        if (kind === "video" && !body.played && (snapshot as VideoBodyViewSnapshot).src?.startsWith("data:")) {
            body.played = true;
            const player = body.vm as VideoBodyViewModel;
            queueMicrotask(() => {
                if (!this.disposed && this.mediaVm() === player) void player.onPlay();
            });
        }
        switch (kind) {
            case "image":
                return toViewMedia("image", snapshot as ImageBodyViewSnapshot);
            case "video":
                return toViewMedia("video", snapshot as VideoBodyViewSnapshot);
            default:
                return toViewMedia("file", snapshot as FileBodyViewSnapshot);
        }
    }

    private newMedia(kind: ViewMedia["kind"], identity: string, visible: boolean): MediaBody {
        const helper = new MediaEventHelper(this.ev);
        if (kind === "audio") return this.newAudio(helper, identity);
        let vm: ImageBodyViewModel | VideoBodyViewModel | FileBodyViewModel;
        if (kind === "image") {
            vm = new ImageBodyViewModel({
                mxEvent: this.ev,
                mediaEventHelper: helper,
                mediaVisible: visible,
                timelineRenderingType: TimelineRenderingType.Room,
                imageRef: { current: null },
            });
        } else if (kind === "video") {
            vm = new VideoBodyViewModel({
                mxEvent: this.ev,
                mediaEventHelper: helper,
                mediaVisible: visible,
                videoRef: { current: null },
            });
        } else {
            vm = new FileBodyViewModel({
                mxEvent: this.ev,
                mediaEventHelper: helper,
                timelineRenderingType: TimelineRenderingType.Room,
                refIFrame: { current: null } as unknown as RefObject<HTMLIFrameElement>,
                refLink: { current: null } as unknown as RefObject<HTMLAnchorElement>,
                documentPreviewsEnabled: false,
            });
        }
        const unsubscribeVm = vm.subscribe(this.changed);
        // The media-visibility setting and the per-event reveals: the view-model is told on the next read.
        const unwatch =
            kind === "file"
                ? () => {}
                : this.watchSettings([
                      ["mediaPreviewConfig", this.ev.getRoomId() ?? null],
                      ["showMediaEventIds", null],
                  ]);
        const unsubscribe = (): void => {
            unsubscribeVm();
            unwatch();
        };
        if (kind !== "file") {
            // Start after the read that built it: the first snapshot may land synchronously.
            const loader = vm as ImageBodyViewModel | VideoBodyViewModel;
            queueMicrotask(() => {
                if (!this.disposed && this.mediaVm() === loader) loader.loadInitialMediaIfVisible();
            });
        }
        return { kind, vm, helper, identity, visible, played: false, unsubscribe };
    }

    /** The view-model of the current image, video or file body. */
    private mediaVm(): ViewModelMediaBody["vm"] | undefined {
        const body = this.mediaBody;
        return body && body.kind !== "audio" ? body.vm : undefined;
    }

    /**
     * An audio body has no view-model here: Element's audio player view-model needs the decoded file (a Playback),
     * which would decode every audio message of the room just to list it. The URL is the media helper's, as MAudioBody
     * reads its source: the homeserver URL, or the decrypted blob URL.
     */
    private newAudio(helper: MediaEventHelper, identity: string): AudioMediaBody {
        const body: AudioMediaBody = { kind: "audio", helper, identity, failed: false, unsubscribe: () => {} };
        const current = (): boolean => !this.disposed && this.mediaBody === body;
        helper.sourceUrl.value.then(
            (url) => {
                if (!current()) {
                    // Released while it was fetched or decrypted: the helper's cleanup ran before this blob existed.
                    if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
                    return;
                }
                if (url) body.url = url;
                else body.failed = true;
                this.changed();
            },
            () => {
                if (!current()) return;
                body.failed = true;
                this.changed();
            },
        );
        return body;
    }

    private releaseMedia(): void {
        const body = this.mediaBody;
        if (!body) return;
        this.mediaBody = undefined;
        body.unsubscribe();
        if (body.kind !== "audio") body.vm.dispose();
        body.helper.destroy();
    }

    /** Watches settings; `changed` runs when one of them does, and the returned function stops it. */
    private watchSettings(settings: Array<[SettingKey, string | null]>): () => void {
        const refs = settings.map(([name, roomId]) => SettingsStore.watchSetting(name, roomId, () => this.changed()));
        return () => refs.forEach((ref) => SettingsStore.unwatchSetting(ref));
    }

    /**
     * The link previews of a text message, from the URL preview group view-model as TextualBodyFactory builds it. The
     * view-model finds its links in an element, which the stock body supplies: here it is built from the body's own
     * linkified, sanitized HTML (what `bodyToNode` gives the stock body), in an inert document. Nothing is built or
     * fetched while Element hides previews (the setting of the room, or of an encrypted room, off), and a preview the
     * user hid stays hidden: both hand over nothing. The row follows the settings and an edit; an unchanged read
     * tells the view-model nothing.
     */
    public urlPreviews(): ViewUrlPreview[] | undefined {
        const content: Record<string, unknown> = this.ev.isRedacted() ? {} : this.ev.getContent();
        const bundle = content[BUNDLED_LINK_PREVIEWS];
        const str = (value: unknown): string => (typeof value === "string" ? value : "");
        const text = `${str(content.body)}\n${str(content.formatted_body)}`;
        const textual = [MsgType.Text, MsgType.Notice, MsgType.Emote].includes(content.msgtype as MsgType);
        const candidate =
            !this.disposed && textual && (/https?:\/\//i.test(text) || (Array.isArray(bundle) && bundle.length > 0));
        if (!candidate) {
            this.releaseUrlPreview();
            return undefined;
        }
        const encrypted = this.isRoomEncrypted();
        // Until the crypto answer is in, the state flag may be a downgrade's: no view-model, no fetch (the bridge
        // re-emits the timeline when the answer settles).
        if (!this.isEncryptionSettled()) return undefined;
        const visible = !!SettingsStore.getValue(encrypted ? "urlPreviewsEnabled_e2ee" : "urlPreviewsEnabled");
        const kind: UrlPreviewKind = SettingsStore.getValue("feature_msc4095_url_preview_bundle")
            ? encrypted && SettingsStore.getValue("urlPreviewsEnabled_e2ee_bundled_only")
                ? "bundledonly"
                : "preferbundled"
            : "fetchonly";
        const mediaVisible = getMediaVisibility(this.ev, this.client);
        // The kind is a prop the view-model cannot change.
        if (this.urlPreview && this.urlPreview.kind !== kind) this.releaseUrlPreview();
        const state = (this.urlPreview ??= {
            kind,
            visible,
            mediaVisible,
            contentKey: "",
            unwatch: this.watchSettings([
                ["urlPreviewsEnabled", null],
                ["urlPreviewsEnabled_e2ee", null],
                ["urlPreviewsEnabled_e2ee_bundled_only", null],
                ["feature_msc4095_url_preview_bundle", null],
                ["mediaPreviewConfig", this.ev.getRoomId() ?? null],
                ["showMediaEventIds", null],
            ]),
        });
        if (visible && !state.vm) {
            const vm = new UrlPreviewGroupViewModel({
                client: this.client,
                mxEvent: this.ev,
                visible,
                mediaVisible,
                showTooltips: false,
                onImageClicked: () => {},
                urlPreviewKind: kind,
                moduleUrlPreviewApi: ModuleApi.instance.urlPreviews,
            });
            state.vm = vm;
            state.visible = visible;
            state.mediaVisible = mediaVisible;
            state.unsubscribe = vm.subscribe(this.changed);
        }
        const vm = state.vm;
        if (!vm) return undefined;
        // Called only on a change: the updaters recompute (and may fetch), and a kit's read must not loop.
        const warn =
            (what: string) =>
            (error: unknown): void =>
                logger.warn(`Client views: URL preview ${what} failed`, error);
        if (state.visible !== visible) {
            state.visible = visible;
            void vm.updateUrlPreviewVisible(visible).catch(warn("visibility"));
        }
        if (state.mediaVisible !== mediaVisible) {
            state.mediaVisible = mediaVisible;
            void vm.updateMediaVisible(mediaVisible).catch(warn("media visibility"));
        }
        const contentKey = `${text}\n${JSON.stringify(bundle ?? null)}`;
        if (visible && state.contentKey !== contentKey) {
            state.contentKey = contentKey;
            const element = this.previewElement(content);
            // After the read that built it: the first snapshot may land synchronously.
            queueMicrotask(() => {
                if (this.disposed || this.urlPreview?.vm !== vm) return;
                void vm.updateEventElement(element).catch(warn("links"));
            });
        }
        if (!visible || vm.isPreviewHiddenByUser) return undefined;
        return toViewUrlPreviews(vm.getSnapshot().previews);
    }

    /** The body as an element of its linkified, sanitized HTML, for the view-model to read the links from. */
    private previewElement(content: Record<string, unknown>): HTMLDivElement {
        const { formattedBody, strippedBody } = bodyToNode(content, undefined, {
            stripReplyFallback: true,
            disableBigEmoji: true,
            linkify: true,
        });
        // An inert document: the sanitized HTML is parsed, but its images and other resources are not loaded.
        const element = new DOMParser().parseFromString("", "text/html").createElement("div");
        if (formattedBody !== undefined) element.innerHTML = formattedBody;
        else element.textContent = strippedBody;
        return element;
    }

    private releaseUrlPreview(): void {
        const state = this.urlPreview;
        if (!state) return;
        this.urlPreview = undefined;
        state.unsubscribe?.();
        state.vm?.dispose();
        state.unwatch();
    }

    public dispose(): void {
        this.disposed = true;
        this.releaseMedia();
        this.releaseUrlPreview();
        this.bindReactions(this.reactionRelations, "off");
        this.reactionRelations = undefined;
        this.reactionButtons.forEach((b) => b.dispose());
        this.reactionButtons.clear();
        this.threadSummaryRelease?.();
        this.threadSummaryRelease = undefined;
        this.followLastReplyEdit(null);
        this.unsubscribe.forEach((u) => u());
        this.unsubscribe.length = 0;
        this.replacement?.off(MatrixEventEvent.Decrypted, this.onReplacementDecrypted);
        this.replacement = null;
        this.replyEdit?.off(MatrixEventEvent.Decrypted, this.changed);
        this.replyEdit = null;
        this.padlockUnsubscribe();
        this.tile.dispose();
        this.body.dispose();
        this.padlock.dispose();
        this.decryption?.dispose();
        this.reply?.dispose();
        this.redactedBody?.dispose();
    }
}

/**
 * A ClientViewBridge fed only from shipped view-model snapshots. View-models are built outside their legacy
 * parent components; the matrix-js-sdk objects they need as props are passed through, never read for data.
 */
type EventItem = Extract<TimelineItem, { kind: "event" }>;

export class ViewModelBridge implements ClientViewBridge {
    public readonly version = 2;

    private readonly listeners = new Set<(e: ChangeEvent) => void>();
    private readonly disposers: Array<() => void> = [];
    private readonly roomList: RoomListViewModel;
    /** The open A8 file picker, if any. */
    private filePicker: { cancel: () => void } | undefined;
    private readonly userMenu: UserMenuViewModel;
    /** The item view-model each room's subscription follows: the list may build a new one for a room (a rename re-sorts it). */
    private readonly watchedItems = new Map<string, { item: object; off: () => void }>();
    private readonly timelines = new Map<string, RoomTimelineViewModel>();
    /** One started permalink creator per room (its `via` servers follow the room state); stopped when the room leaves the bridge. */
    private readonly permalinkCreators = new Map<string, RoomPermalinkCreator>();
    /** M7 E2: one autocomplete user provider per room (it listens to the client), destroyed when the room leaves the bridge. */
    private readonly userProviders = new Map<string, UserProvider>();
    /** The rooms the bridge lists (set by `syncRooms`): a room that left it gets no permalink creator again. */
    private listedRoomIds = new Set<string>();
    /** Per room, how often it left the list: a mention lookup whose member load spans a leave keeps no provider. */
    private readonly roomLeftCount = new Map<string, number>();
    /** Rooms read while not listed (messages handed over without a permalink): the kit reads them again once they are listed. */
    private readUnlisted = new Set<string>();
    /** Rooms whose member load for the via servers failed: the next read tries it again (the SDK allows a retry). */
    private memberLoadFailed = new Set<string>();
    /** A `loadOlder` in flight per room: a concurrent call gets the same answer. */
    private readonly olderLoads = new Map<string, Promise<LoadOlderResult>>();
    private disposed = false;
    private readonly rows = new Map<string, EventRow>();
    /** The call card (Element's RootCallTileViewModel) of each call notification the kit was handed, by event id. */
    private readonly callCards = new Map<string, CallCard>();
    private readonly senderAvatars = new Map<string, MemberAvatarViewModel>();
    /** Per room: encrypted once either the room state or the crypto store said so (never back to false). */
    private readonly encrypted = new Map<string, boolean>();
    /** Rooms whose crypto answer (or its failure, or the lack of crypto) is in; the URL previews wait for it. */
    private readonly encryptionSettled = new Set<string>();
    /** Rooms where a row was held back for that answer: the timeline is re-emitted when it settles. */
    private readonly heldForEncryption = new Set<string>();
    private statusBar?: RoomStatusBarViewModel;
    private roomCache: ViewRoom[] = [];
    private sectionCache: ViewSection[] = [];
    /** The rooms that were invites at the last look. */
    private invitedRooms = new Set<string>();
    /** Local rooms of the chats started here (A6) that Element has not created yet; listed until they are. */
    private readonly localChats = new Set<string>();
    private lastConnection: ViewConnection = "online";
    /** Whether the signed-in user's cross-signing identity is verified: the stock UI's "local device verified" state. */
    private localDeviceVerified = false;
    /** Reaction presses waiting for their snapshot change, per (event, key): a repeat joins the pending one. */
    private readonly reacting = new Map<string, Promise<ActionOutcome>>();
    /** B7: the downloads in flight, by room and event. */
    private readonly downloading = new Map<string, Promise<ActionOutcome>>();
    private readonly reactionWaits = new Set<() => void>();
    /** The reaction picker the host shows over the kit, with the call that waits for its close. */
    private pickerCount = 0;
    private picker?: { request: ReactionPickerRequest; resolve: (o: ActionOutcome) => void };
    private readonly pickerListeners = new Set<(request: ReactionPickerRequest | null) => void>();
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
        // A room joining or leaving a collapsed section changes no snapshot (collapsed sections hold no room ids there);
        // the list's own listener ran first on this event, so its room ids are current.
        const onListsUpdate = (): void => this.syncRooms();
        RoomListStoreV3.instance.on(RoomListStoreV3Event.ListsUpdate, onListsUpdate);
        this.disposers.push(() => RoomListStoreV3.instance.off(RoomListStoreV3Event.ListsUpdate, onListsUpdate));
        this.userMenu = new UserMenuViewModel(
            { ownProfileStore: OwnProfileStore.instance },
            defaultDispatcher,
            client,
            false,
        );
        this.disposers.push(this.userMenu.subscribe(() => this.emit({ kind: "me" })));
        this.watchLocalVerification();
        this.watchEncryption();
        this.watchPins();
        // A local chat room changes state (creating, created, error) through client room events.
        const onLocalRoom = (room: Room): void => {
            if (this.localChats.has(room.roomId)) this.syncRooms();
        };
        client.on(ClientEvent.Room, onLocalRoom);
        this.disposers.push(() => client.off(ClientEvent.Room, onLocalRoom));
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

    private isEncryptionSettled(roomId: string): boolean {
        if (this.encryptionSettled.has(roomId)) return true;
        this.heldForEncryption.add(roomId);
        return false;
    }

    private readEncryption(roomId: string): void {
        const pending = this.client.getCrypto()?.isEncryptionEnabledInRoom(roomId);
        // Without crypto the state flag stands.
        if (!pending) {
            this.encryptionSettled.add(roomId);
            return;
        }
        const settle = (enabled: boolean): void => {
            this.encryptionSettled.add(roomId);
            const flipped = enabled && !this.encrypted.get(roomId);
            if (flipped) this.encrypted.set(roomId, true);
            if (flipped || this.heldForEncryption.delete(roomId)) this.emit({ kind: "timeline", roomId });
        };
        void pending.then(settle, () => settle(false));
    }

    /**
     * The pinned flag of a row is read live (`PinningUtils.isPinned`): the room's rows are handed over again when its
     * `m.room.pinned_events` (or the power levels behind `canPin`) change, also by another client.
     */
    private watchPins(): void {
        const onPinsState = (ev: MatrixEvent): void => {
            const roomId = ev.getRoomId();
            // The power levels decide the offer (`canPin`), so a change of them hands the rows over again too.
            const type = ev.getType();
            if (
                (type !== EventType.RoomPinnedEvents && type !== EventType.RoomPowerLevels) ||
                !roomId ||
                !this.timelines.has(roomId)
            )
                return;
            this.emit({ kind: "timeline", roomId });
        };
        this.client.on(RoomStateEvent.Events, onPinsState);
        this.disposers.push(() => this.client.off(RoomStateEvent.Events, onPinsState));
        // matrix-js-sdk emits RoomStateEvent.Events while it stores the event and applies `RoomMember.powerLevel` only
        // afterwards (RoomState.setStateEvents), so `canPin` read on that first emission still sees the old level. The
        // members emission follows the applied level: the rows are handed over once more then.
        const onPowerApplied = (ev: MatrixEvent): void => onPinsState(ev);
        this.client.on(RoomStateEvent.Members, onPowerApplied);
        this.disposers.push(() => this.client.off(RoomStateEvent.Members, onPowerApplied));
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
        // A kit lists every room, collapsed section or not: the snapshot's sections hold no rooms for a collapsed one (the
        // Invites section is always collapsed), so the list's own full, ordered room ids are read. Nothing is expanded,
        // so the user's stored section expansion (`RoomList.SectionExpansionState`) is never written.
        const ids = this.roomList.roomIds;
        // Item view-models exist only for rooms the list was told are visible.
        this.roomList.updateVisibleRooms(0, ids.length);
        const rooms: ViewRoom[] = this.localChatRooms();
        // The custom sections are the same in every item's snapshot (the item lists the store's sections); the first one's is
        // read, but the open non-member room's preview item has none (an empty list), so the first non-empty list wins.
        let sections: ViewSection[] | undefined;
        for (const id of ids) {
            const item = this.roomList.getRoomItemViewModel(id);
            if (!item) continue;
            const room = this.client.getRoom(id);
            const watched = this.watchedItems.get(id);
            if (watched?.item !== item) {
                watched?.off();
                const offItem = item.subscribe(() => this.syncRooms());
                const offEcho = room ? this.watchNotificationLevel(room) : () => {};
                this.watchedItems.set(id, {
                    item,
                    off: () => {
                        offItem();
                        offEcho();
                    },
                });
            }
            const s = item.getSnapshot();
            if (!sections?.length) sections = (s.sections ?? []).map(({ tag, name }, order) => ({ tag, name, order }));
            const avatarUrl = room ? (avatarUrlForRoom(room, AVATAR_PX, AVATAR_PX, "crop") ?? undefined) : undefined;
            rooms.push(toViewRoom(s, rooms.length, avatarUrl, room ? this.notificationLevelOf(room) : undefined));
            if (!this.statusBar && room) this.watchConnection(room);
        }
        // An invite that became a join: the kit asks for the room's timeline again (none was built while it was invited).
        const joined = rooms.filter((r) => r.membership !== "invite" && this.invitedRooms.has(r.id));
        this.invitedRooms = new Set(rooms.filter((r) => r.membership === "invite").map((r) => r.id));
        // A room that left the list takes its permalink creator (a started one listens to the room state) with it.
        const listed = new Set(ids);
        const previouslyListed = this.listedRoomIds;
        this.listedRoomIds = listed;
        for (const [roomId, creator] of this.permalinkCreators) {
            if (listed.has(roomId)) continue;
            creator.stop();
            this.permalinkCreators.delete(roomId);
            this.memberLoadFailed.delete(roomId);
        }
        for (const roomId of previouslyListed) {
            if (!listed.has(roomId)) this.roomLeftCount.set(roomId, (this.roomLeftCount.get(roomId) ?? 0) + 1);
        }
        for (const [roomId, provider] of this.userProviders) {
            if (listed.has(roomId)) continue;
            provider.destroy();
            this.userProviders.delete(roomId);
        }
        // A room read without permalinks while it was not listed (a rejoin the list shows late) is listed now: read it again.
        const relisted = [...this.readUnlisted].filter((id) => listed.has(id));
        for (const id of relisted) this.readUnlisted.delete(id);
        const sectionList = sections ?? [];
        if (
            JSON.stringify(rooms) !== JSON.stringify(this.roomCache) ||
            JSON.stringify(sectionList) !== JSON.stringify(this.sectionCache)
        ) {
            this.roomCache = rooms;
            this.sectionCache = sectionList;
            this.emit({ kind: "rooms" });
            for (const r of joined) this.emit({ kind: "timeline", roomId: r.id });
        }
        for (const id of relisted) if (!joined.some((r) => r.id === id)) this.emit({ kind: "timeline", roomId: id });
    }

    /**
     * The chats started from the kit (A6) that have no real room yet, from the client's local rooms (`createDmLocalRoom`),
     * first in the list. A chat whose room has been created (or whose local room is gone) is dropped: the real room is in
     * the room list view-model's own list.
     */
    /**
     * The room's notification level as Element's local echo holds it (`RoomEchoChamber.notificationVolume`, what the item's
     * snapshot is built from). The item view-model builds `roomNotifState` once per update of the room's notification state,
     * tags or name and does not listen to the echo, so after a level change its snapshot stays stale (it showed
     * `all_messages` after the push rules held `mentions_only`): the bridge reads the echo itself and watches it
     * (`watchNotificationLevel`). Undefined when the echo has none: the snapshot's value stands.
     */
    private notificationLevelOf(room: Room): ViewNotificationLevel | undefined {
        try {
            return EchoChamber.forRoom(room).notificationVolume;
        } catch {
            return undefined;
        }
    }

    /** A change of the room's echoed notification level (a write, its echo, a revert) re-reads the room list. */
    private watchNotificationLevel(room: Room): () => void {
        try {
            const chamber = EchoChamber.forRoom(room);
            const onUpdated = (): void => this.syncRooms();
            chamber.on(PROPERTY_UPDATED, onUpdated);
            return () => void chamber.off(PROPERTY_UPDATED, onUpdated);
        } catch {
            return () => {};
        }
    }

    private localChatRooms(): ViewRoom[] {
        const out: ViewRoom[] = [];
        for (const id of this.localChats) {
            const room = this.client.getRoom(id) as LocalRoom | null;
            if (!room || !isLocalRoom(id) || room.state === LocalRoomState.CREATED) {
                this.localChats.delete(id);
                continue;
            }
            out.push({
                id,
                name: room.name,
                unreadCount: 0,
                mentionCount: 0,
                isDirect: true,
                order: out.length,
                membership: "join",
                isFavourite: false,
                canMarkAsUnread: false,
                showsUnread: false,
                notificationLevel: "all_messages",
            });
        }
        return out;
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
        // An invited room has no timeline to load, and a view-model built now would stay empty after the join (see `syncRooms`).
        if (room.getMyMembership() !== KnownMembership.Join) return undefined;
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
                () => this.isEncryptionSettled(roomId),
                () => this.reactionPermissions(roomId),
            );
            this.rows.set(key, row);
        }
        return row;
    }

    /** What RoomView.updatePermissions computes for the stock reactions row, read at the moment of use. */
    private reactionPermissions(roomId: string): ReactionPermissions {
        const room = this.client.getRoom(roomId);
        const me = this.client.getUserId() ?? "";
        return {
            canReact:
                !!room &&
                room.getMyMembership() === KnownMembership.Join &&
                room.currentState.maySendEvent(EventType.Reaction, me),
            canSelfRedact: !!room && room.currentState.maySendEvent(EventType.RoomRedaction, me),
        };
    }

    /** The row of a message the kit was handed (every action targets a message of a snapshot it read). */
    private actionRow(roomId: string, eventId: string): EventRow {
        if (!this.client.getRoom(roomId)) throw new ClientViewActionError("unknown_room", `unknown room ${roomId}`);
        const row = this.rows.get(eventId);
        if (!row || row.roomId !== roomId) {
            throw new ClientViewActionError("unknown_event", `unknown event ${eventId} in ${roomId}`);
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

    public sections(): ViewSection[] {
        this.used = true;
        return this.sectionCache;
    }

    public timeline(roomId: string): ViewMessage[] {
        this.used = true;
        const vm = this.ensureTimeline(roomId);
        if (!vm) return [];
        const messages: ViewMessage[] = [];
        // Call events of this window, held or not: a card is dropped only when its event is no longer an item.
        const seenCalls = new Set<string>();
        for (const item of vm.getSnapshot().items) {
            if (item.kind !== "event") continue;
            const eventItem = item;
            if (eventItem.sendState && eventItem.sendState !== "sent") continue;
            const id = (eventItem.event as MatrixEvent).getId();
            if (!id || id.startsWith("~")) continue;
            if ((eventItem.event as MatrixEvent).getType() === EventType.RTCNotification) {
                seenCalls.add(id);
                const call = this.callMessage(eventItem.event as MatrixEvent, roomId);
                if (call) messages.push(call);
                continue;
            }
            const row = this.row(eventItem, roomId);
            const tile = row.tile.getSnapshot().snapshot;
            // An event still waiting for its key keeps the SDK type m.room.encrypted (a failed one is m.room.message).
            const isMessage =
                tile.event.eventType === EventType.RoomMessage ||
                tile.event.eventType === EventType.RoomMessageEncrypted;
            // The tile snapshot's `isLocalEcho` is fixed when the row is built: a row built in the window between the send
            // response (real event id, status SENT) and the remote echo kept it for good and hid the own message forever.
            // The event's status is read live.
            if (!isMessage || (eventItem.event as MatrixEvent).status != null) continue;
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
                row.threadSummary(),
                row.media(),
                row.urlPreviews(),
                {
                    canEdit: row.canEdit(),
                    canDownload: row.canDownload(),
                    edited: row.edited(),
                    editedTs: row.editedTs(),
                    redactedText: row.redactedText(),
                    pinned: row.pinned(),
                    canPin: row.canPin(),
                    permalink: this.permalinkOf(roomId, id),
                },
            );
            if (message) {
                const txnId = this.ownTxnId(eventItem.event as MatrixEvent);
                messages.push(txnId ? { ...message, txnId } : message);
            }
        }
        this.pruneCallCards(roomId, seenCalls);
        return messages.sort((a, b) => a.ts - b.ts);
    }

    /** Element's permalink of an event (`RoomPermalinkCreator.forEvent`, `via` included), undefined for a room the client does not know. */
    private permalinkOf(roomId: string, eventId: string): string | undefined {
        let creator = this.permalinkCreators.get(roomId);
        if (!creator) {
            // A cached timeline outlives its room's place in the list: no creator (and state listener) for it again.
            if (!this.listedRoomIds.has(roomId)) {
                this.readUnlisted.add(roomId);
                return undefined;
            }
            const room = this.client.getRoom(roomId);
            if (!room) return undefined;
            creator = new RoomPermalinkCreator(room);
            creator.start();
            this.permalinkCreators.set(roomId, creator);
            this.loadMembersForVia(room);
        } else if (this.memberLoadFailed.delete(roomId)) {
            const room = this.client.getRoom(roomId);
            if (room) this.loadMembersForVia(room);
        }
        return creator.forEvent(eventId);
    }

    /**
     * Element's own Copy link has the room's full member list behind its `via` servers (RoomView loads it on mount); a kit
     * mounts no RoomView, so with lazy-loaded members only the few loaded ones would count. Load them (once per room:
     * the SDK keeps the promise) and tell the kit to read the room again; the started creator follows the room state.
     */
    private loadMembersForVia(room: Room): void {
        if (!this.client.hasLazyLoadMembersEnabled() || room.getMyMembership() !== KnownMembership.Join) return;
        room.loadMembersIfNeeded().then(
            () => {
                if (this.permalinkCreators.has(room.roomId)) this.emit({ kind: "timeline", roomId: room.roomId });
            },
            (err) => {
                if (this.permalinkCreators.has(room.roomId)) this.memberLoadFailed.add(room.roomId);
                logger.error(
                    `Fetching room members for ${room.roomId} failed. Permalinks may list too few servers.`,
                    err,
                );
            },
        );
    }

    /** Drops the cards of a room's calls whose event left the timeline window (the view-model disposes its tiles). */
    private pruneCallCards(roomId: string, seen: Set<string>): void {
        for (const [id, card] of this.callCards) {
            if (card.roomId !== roomId || seen.has(id)) continue;
            card.dispose();
            this.callCards.delete(id);
        }
    }

    /**
     * The message of a call's root event (`EventTileFactory` draws it as the call card): `kind` "other", no body, and
     * `call` from the call-card view-models. Nothing for an event whose card Element cannot build.
     */
    private callMessage(event: MatrixEvent, roomId: string): ViewMessage | undefined {
        if (event.status != null) return undefined;
        const id = event.getId()!;
        let card = this.callCards.get(id);
        if (!card) {
            card = CallCard.create(this.client, event, () => this.emit({ kind: "timeline", roomId }));
            if (!card) return undefined;
            this.callCards.set(id, card);
        }
        const senderId = event.getSender() ?? "";
        const avatarUrl = senderId ? this.senderAvatarUrl(roomId, senderId) : undefined;
        return {
            id,
            roomId,
            senderId,
            senderName: event.sender?.name || senderId,
            ...(avatarUrl ? { senderAvatarUrl: avatarUrl } : {}),
            ts: event.getTs(),
            body: "",
            kind: "other",
            call: card.view(),
        };
    }

    /** The transaction id of an own message (its local echo's, else the sync echo's `unsigned.transaction_id`). */
    private ownTxnId(event: MatrixEvent): string | undefined {
        if (event.getSender() !== this.client.getUserId()) return undefined;
        return event.getTxnId() ?? event.getUnsigned().transaction_id;
    }

    /**
     * Toggles the user's reaction `key` on a message through the reactions row button view-model (its click sends or
     * redacts). One press per (event, key) is in flight: a repeat gets the pending call. Resolves `done` once the
     * snapshot shows the user's state of that key flipped, `failed` after REACTION_TIMEOUT_MS.
     */
    public react(roomId: string, eventId: string, key: string): Promise<ActionOutcome> {
        this.used = true;
        const flight = `${eventId}\n${key}`;
        const pending = this.reacting.get(flight);
        if (pending) return pending;
        let row: EventRow;
        try {
            row = this.actionRow(roomId, eventId);
        } catch (e) {
            return Promise.reject(e);
        }
        const pressed = row.pressReaction(key);
        if (!pressed) {
            return Promise.reject(new ClientViewActionError("forbidden", "reacting is not allowed on this message"));
        }
        // A press the snapshot shows at once (the SDK's local echo) ends inside the executor, before `call` exists.
        let ended = false;
        const call = new Promise<ActionOutcome>((resolve, reject) => {
            const timer = setTimeout(() => {
                end();
                reject(
                    new ClientViewActionError("failed", `the reaction did not show within ${REACTION_TIMEOUT_MS} ms`),
                );
            }, REACTION_TIMEOUT_MS);
            const poll = setInterval(() => check(), REACTION_POLL_MS);
            const onChange = (e: ChangeEvent): void => {
                if (e.kind === "timeline" && e.roomId === roomId) check();
            };
            const cancel = (): void => {
                end();
                reject(new ClientViewActionError("failed", "the bridge was disposed"));
            };
            const end = (): void => {
                clearTimeout(timer);
                clearInterval(poll);
                this.listeners.delete(onChange);
                this.reactionWaits.delete(cancel);
                this.reacting.delete(flight);
                ended = true;
            };
            const check = (): void => {
                if (row.isMine(key) === pressed.wasMine) return;
                end();
                resolve({ status: "done", roomId, eventId });
            };
            this.listeners.add(onChange);
            this.reactionWaits.add(cancel);
            check();
        });
        if (!ended) this.reacting.set(flight, call);
        return call;
    }

    /**
     * Opens Element's reaction picker (the one the reactions row's add button opens) over the kit, beside the host's
     * overlays. It resolves `done` when the picker closes: ReactionPicker calls `onFinished` for a choice and a
     * dismiss alike, and a chosen reaction arrives as a timeline change.
     */
    public openReactionPicker(roomId: string, eventId: string, anchor: ViewAnchor): Promise<ActionOutcome> {
        this.used = true;
        let row: EventRow;
        try {
            row = this.actionRow(roomId, eventId);
        } catch (e) {
            return Promise.reject(e);
        }
        const room = this.client.getRoom(roomId)!;
        const permissions = this.reactionPermissions(roomId);
        // The stock row shows the add button only where the user can react and the content is actionable.
        if (!permissions.canReact || !row.actionable()) {
            return Promise.reject(new ClientViewActionError("forbidden", "reacting is not allowed on this message"));
        }
        this.closeReactionPicker();
        return new Promise<ActionOutcome>((resolve) => {
            const request: ReactionPickerRequest = {
                key: `${eventId}#${++this.pickerCount}`,
                room,
                mxEvent: row.event,
                reactions: row.relations(),
                permissions,
                anchor,
                finish: () => {
                    if (this.picker?.request !== request) return;
                    this.picker = undefined;
                    this.pickerListeners.forEach((cb) => cb(null));
                    resolve({ status: "done", roomId, eventId });
                },
            };
            this.picker = { request, resolve };
            this.pickerListeners.forEach((cb) => cb(request));
        });
    }

    /**
     * E5: Element's own ViewSource dialog over the kit, opened the way the message context menu opens it (event id, the
     * event JSON, and for an encrypted event the decrypted and the original source). `done` when it closes; it changes
     * nothing. Interim (D31): there is no view-source action on a shared message view-model.
     */
    public openViewSource(roomId: string, eventId: string): Promise<ActionOutcome> {
        this.used = true;
        let row: EventRow;
        try {
            row = this.actionRow(roomId, eventId);
        } catch (e) {
            return Promise.reject(e);
        }
        return viewSourceViaDialog(roomId, eventId, () => {
            Modal.createDialog(ViewSource, { mxEvent: row.event }, "mx_Dialog_viewsource");
        });
    }

    /**
     * M7 E4: Element's report dialog over the kit, as the message context menu opens it (interim D31, see `ReportAction`).
     * `forbidden` for an own event; `done` when the dialog closes (a report, a cancel or a dismissal alike).
     */
    public openReport(roomId: string, eventId: string): Promise<ActionOutcome> {
        this.used = true;
        let row: EventRow;
        try {
            row = this.actionRow(roomId, eventId);
        } catch (e) {
            return Promise.reject(e);
        }
        return openReport(this.client, row.event);
    }

    /** Closes an open picker (a new one replaces it, the bridge going away ends it): its call resolves `done`. */
    private closeReactionPicker(): void {
        this.picker?.request.finish();
    }

    /** The host's hook: called with the picker to show, and with null when it is gone. Returns the unsubscribe. */
    public onReactionPicker(cb: (request: ReactionPickerRequest | null) => void): () => void {
        this.pickerListeners.add(cb);
        if (this.picker) cb(this.picker.request);
        return () => this.pickerListeners.delete(cb);
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

    public meetUrl(): string | undefined {
        return getMeetUrl();
    }

    public switchTo(viewId: string): void {
        void selectClientView(viewId);
    }

    public loadOlder(roomId: string): Promise<LoadOlderResult> {
        this.used = true;
        const running = this.olderLoads.get(roomId);
        if (running) return running;
        const vm = this.ensureTimeline(roomId);
        if (!vm) return Promise.reject(new ClientViewActionError("unknown_room", roomId));
        const load = this.loadOlderPage(roomId, vm).finally(() => this.olderLoads.delete(roomId));
        this.olderLoads.set(roomId, load);
        return load;
    }

    /** Waits until `done()` holds, looking every {@link LOAD_OLDER_POLL_MS} (the view-model's loading flag is not published). */
    private async waitFor(done: () => boolean, what: string): Promise<void> {
        const deadline = Date.now() + LOAD_OLDER_TIMEOUT_MS;
        while (!done()) {
            if (this.disposed) throw new ClientViewActionError("failed", "bridge disposed");
            if (Date.now() > deadline) throw new ClientViewActionError("failed", `timed out waiting for ${what}`);
            await new Promise((resolve) => setTimeout(resolve, LOAD_OLDER_POLL_MS));
        }
    }

    private async loadOlderPage(roomId: string, vm: RoomTimelineViewModel): Promise<LoadOlderResult> {
        const events = (): MatrixEvent[] =>
            vm
                .getSnapshot()
                .items.filter((i): i is EventItem => i.kind === "event")
                .map((i) => i.event as MatrixEvent);
        // The view-model's own `TimelineWindow` (private, read like `loading`): the start of the room is in view when the
        // creation event is among the window's events (hidden in most rooms, so not among the items), or when the window
        // cannot paginate backward any more (no token left and the index at the oldest event: the history visibility
        // stops it before the creation event). The timeline SET is not the window: a reopened view windows only the last
        // events of a set that may already hold the creation event further back.
        const timelineWindow = (
            vm as unknown as {
                timelineWindow: {
                    getEvents(): MatrixEvent[];
                    canPaginate: (direction: Direction) => boolean;
                    paginate: (...args: unknown[]) => Promise<boolean>;
                };
            }
        ).timelineWindow;
        // The room's real creation event (its id in the room state): an event that merely decrypts to an `m.room.create`
        // is not the start (crafted input), and a type test would take it for one.
        const createId = (): string | undefined =>
            this.client.getRoom(roomId)?.currentState.getStateEvents(EventType.RoomCreate, "")?.getId();
        const state = (): Pick<LoadOlderResult, "atStart" | "atLimit"> => {
            const windowEvents = timelineWindow.getEvents();
            const create = createId();
            return {
                atStart:
                    (create !== undefined && windowEvents.some((e) => e.getId() === create)) ||
                    !timelineWindow.canPaginate(Direction.Backward),
                // The cap is on the window's events, hidden reactions and edits included, not on the rendered rows. A window of
                // exactly WINDOW_LIMIT - PAGE_SIZE still takes one more page without a trim.
                atLimit: windowEvents.length > WINDOW_LIMIT - PAGE_SIZE,
            };
        };
        // The first window is still loading (or the room has no showable event yet): a page asked now would race it.
        // `loading` is the view-model's own flag for that; it is private and published nowhere.
        await this.waitFor(
            () =>
                !(vm as unknown as { loading?: boolean }).loading &&
                vm.getSnapshot().items.some((i) => i.kind === "event"),
            "the first window",
        );
        // The first window is held in place by `pendingAnchor` until a list view reports it settled, and paginating
        // waits for that. The kit has no list view, so it reports it here (a no-op without an anchor: safe for read
        // markers and jump to live).
        vm.onAnchorReached();
        const before = new Set(events().map((e) => e.getId()));
        const start = state();
        if (start.atStart || start.atLimit) return { added: 0, ids: [], ...start };
        // The view-model's paginate chain catches a failed `/messages` page and publishes nothing that tells it from an
        // empty page, so the window's own paginate is watched for the length of this page (instance wrap, restored below).
        // The chain also loops over up to 10 batches that show nothing (hidden events only) and, before each batch, trims
        // the live end when the window is past the limit: the wrap refuses a backward batch that would take the window past
        // WINDOW_LIMIT (`false`, no request: the chain ends), and `canPaginate(Backward)` says no for the same window so
        // the chain ends before that pre-trim. A page never trims the live end.
        let failure: unknown;
        const paginate = timelineWindow.paginate;
        const canPaginate = timelineWindow.canPaginate;
        const full = (): boolean => timelineWindow.getEvents().length > WINDOW_LIMIT - PAGE_SIZE;
        timelineWindow.canPaginate = (direction: Direction) =>
            !(direction === Direction.Backward && full()) && canPaginate.call(timelineWindow, direction);
        timelineWindow.paginate = async (...args: unknown[]) => {
            if (
                args[0] === Direction.Backward &&
                timelineWindow.getEvents().length + Number(args[1] ?? PAGE_SIZE) > WINDOW_LIMIT
            )
                return false;
            try {
                return await paginate.apply(timelineWindow, args);
            } catch (e) {
                if (args[0] === Direction.Backward) failure = e;
                throw e;
            }
        };
        try {
            vm.onStartReached();
            // The paginate chain shows a backward-loading item while it runs; no item (nothing to load, or the chain was
            // skipped) means it is already over.
            await this.waitFor(
                () => !vm.getSnapshot().items.some((i) => i.kind === "loading" && i.key === "backward-loading"),
                "older messages",
            );
        } finally {
            timelineWindow.paginate = paginate;
            timelineWindow.canPaginate = canPaginate;
        }
        if (failure !== undefined) throw toActionError(failure);
        const ids = events()
            .map((e) => e.getId())
            .filter((id): id is string => !!id && !before.has(id));
        return { added: ids.length, ids, ...state() };
    }

    public sendText(
        roomId: string,
        text: string,
        opts?: { txnId?: string; replyTo?: string; markdown?: boolean; mentions?: string[] },
    ): Promise<ActionOutcome> {
        this.used = true;
        // A3: the replied event is started through its action bar view-model's `onReplyClick` (the reply state Element's
        // composer reads); the content send is the interim path with the reply relation.
        return sendText(this.client, roomId, text, opts, {
            onReplyTarget: (target) => this.actionBar(target, (vm) => vm.onReplyClick(null), true),
        });
    }

    /**
     * M7 E2: the members Element's composer offers for `@<query>`: `UserProvider.getCompletions` with `force` (the bare
     * query, no `@`) after the room's members are loaded (lazy loading; no RoomView mounted under a kit).
     */
    public async mentionCandidates(
        roomId: string,
        query: string,
    ): Promise<{ userId: string; displayName: string; avatarUrl?: string }[]> {
        const room = this.client.getRoom(roomId);
        if (!room) throw new ClientViewActionError("unknown_room", `no room ${roomId}`);
        // Element's composer offers nobody once the token holds whitespace or starts with a separator.
        if (/\s/.test(query) || /^[/,.():;]/.test(query)) return [];
        const leftBefore = this.roomLeftCount.get(roomId) ?? 0;
        try {
            await room.loadMembersIfNeeded();
        } catch (e) {
            throw toActionError(e);
        }
        if (this.disposed) throw new ClientViewActionError("failed", "bridge disposed");
        const caret = { beginning: true, start: query.length, end: query.length };
        let provider = this.userProviders.get(roomId);
        let transient = false;
        if (!provider) {
            provider = new UserProvider(room);
            // Kept only for a listed room that did not leave the list during the load: the unlist pass destroys the
            // kept ones, so a provider for an unlisted room (or one that left meanwhile) is transient.
            if (!this.listedRoomIds.has(roomId) || (this.roomLeftCount.get(roomId) ?? 0) !== leftBefore)
                transient = true;
            else this.userProviders.set(roomId, provider);
        }
        let completions;
        try {
            completions = await provider.getCompletions(query, caret, true);
        } finally {
            if (transient) provider.destroy();
        }
        return completions.flatMap((c) =>
            c.completionId ? [{ userId: c.completionId, displayName: c.completion ?? c.completionId }] : [],
        );
    }

    /** A11: the replacement send is interim; the edit state is entered through the row's `onEditClick`. */
    public editText(
        roomId: string,
        eventId: string,
        text: string,
        opts?: { markdown?: boolean; mentions?: string[] },
    ): Promise<ActionOutcome> {
        this.used = true;
        const hooks = { onEnter: (ev: MatrixEvent) => this.actionBar(ev, (vm) => vm.onEditClick(null), true) };
        // M7 E1: the options go along only when the caller gave some (the plain call is unchanged).
        return opts
            ? editText(this.client, roomId, eventId, text, hooks, opts)
            : editText(this.client, roomId, eventId, text, hooks);
    }

    /**
     * M6 B2: pin / unpin through the event tile action bar view-model's `onPinClick` (D22), only when the message's pin
     * state differs; `forbidden` when Element does not offer it. Calls for one room run one after the other.
     */
    public setPinned(roomId: string, eventId: string, on: boolean): Promise<ActionOutcome> {
        this.used = true;
        let row: EventRow;
        try {
            row = this.actionRow(roomId, eventId);
        } catch (e) {
            return Promise.reject(e);
        }
        const ev = row.event;
        return setPinned(
            roomId,
            {
                pinned: () => row.pinned(),
                canPin: () => row.canPin(),
                press: () => {
                    let pressed: Promise<void> = Promise.resolve();
                    this.actionBar(ev, (vm) => (pressed = vm.onPinClick(null)), false);
                    return pressed;
                },
            },
            on,
            () => this.disposed,
        );
    }

    /** A12: interim until the event tile's action bar implements `onRemoveClick`. */
    public redact(roomId: string, eventId: string): Promise<ActionOutcome> {
        this.used = true;
        return redact(this.client, roomId, eventId);
    }

    /**
     * Runs one action of an event's action bar view-model (the stock one, built for this call and disposed after).
     * `reply_to_event` makes `RoomViewStore` dispatch `ViewRoom` for a room it does not show (RoomViewStore.tsx, case
     * "reply_to_event"), which navigates Element's own UI under the kit (principle 4; observed in the reply e2e: the
     * kit's timeline stops updating) and starts a call in a video room. So the reply entry runs only for the room the
     * store already shows; for any other the reply content is still sent with the relation (it does not depend on the
     * reply state), and the view-model entry is skipped. A contract mismatch, reported with A3.
     */
    private actionBar(ev: MatrixEvent, run: (vm: EventTileActionBarViewModel) => void, navigates: boolean): boolean {
        const roomId = ev.getRoomId() ?? "";
        if (navigates && roomId !== SDKContextClass.instance.roomViewStore.getRoomId()) return false;
        const vm = this.newActionBar(ev);
        try {
            run(vm);
            return true;
        } finally {
            vm.dispose();
        }
    }

    /** {@link actionBar} for an action that settles later: the view-model is disposed once `run` has settled. */
    private async actionBarSettled(
        ev: MatrixEvent,
        run: (vm: EventTileActionBarViewModel) => Promise<void>,
    ): Promise<void> {
        const vm = this.newActionBar(ev);
        try {
            await run(vm);
        } finally {
            vm.dispose();
        }
    }

    private newActionBar(ev: MatrixEvent): EventTileActionBarViewModel {
        return new EventTileActionBarViewModel({
            mxEvent: ev,
            timelineRenderingType: TimelineRenderingType.Room,
            canSendMessages: true,
            canReact: false,
        });
    }

    /**
     * B7: the Download button's click (`onDownloadClick`) for a media message, after the event is decrypted. One download
     * per event is in flight: a repeat gets the pending call (the view-model ignores a click while it loads).
     */
    public download(roomId: string, eventId: string): Promise<ActionOutcome> {
        this.used = true;
        const flight = `${roomId}\n${eventId}`;
        const pending = this.downloading.get(flight);
        if (pending) return pending;
        const run = downloadMedia(this.client, roomId, eventId, {
            withActionBar: (ev, use) =>
                this.actionBarSettled(ev, (vm) =>
                    use({
                        offered: () => vm.getSnapshot().actions.includes(ActionBarAction.Download),
                        click: () => vm.onDownloadClick(null),
                    }),
                ),
            disposed: () => this.disposed,
        })
            .catch((e: unknown) => {
                throw toActionError(e);
            })
            .finally(() => this.downloading.delete(flight));
        this.downloading.set(flight, run);
        return run;
    }

    public join(roomIdOrAlias: string): Promise<ActionOutcome> {
        return joinRoom(this.client, roomIdOrAlias);
    }

    public acceptInvite(roomId: string): Promise<ActionOutcome> {
        return acceptInvite(this.client, roomId);
    }

    public declineInvite(roomId: string): Promise<ActionOutcome> {
        return declineInvite(this.client, roomId);
    }

    public async createRoom(): Promise<ActionOutcome> {
        return createRoomViaDialog(() => this.roomList.createRoom());
    }

    public async createChat(): Promise<ActionOutcome> {
        const outcome = await startChatViaDialog(() => this.roomList.createChatRoom());
        // The local room of a new chat is listed (and opened) by the kit like any room until the first send creates it.
        if (outcome.status === "done" && outcome.roomId && isLocalRoom(outcome.roomId)) {
            this.localChats.add(outcome.roomId);
            this.syncRooms();
        }
        return outcome;
    }

    public async leave(roomId: string): Promise<ActionOutcome> {
        const room = this.client.getRoom(roomId);
        if (!room) throw new ClientViewActionError("unknown_room", `no room ${roomId}`);
        const item = this.roomList.getRoomItemViewModel(roomId);
        if (!item || !("onLeaveRoom" in item))
            throw new ClientViewActionError("unknown_room", `${roomId} is not in the room list`);
        // The view-model would `forget_room` an archived room without any confirm: not a leave.
        if (room.tags?.[DefaultTagID.Archived])
            throw new ClientViewActionError("unsupported", "an archived room is not left");
        return leaveViaDialog(this.client, roomId, () => item.onLeaveRoom());
    }

    /** A9: interim (D16), see `InterimActions.logout`. */
    public logout(): Promise<ActionOutcome> {
        return logout(this.client);
    }

    /** A8: the files come from Element's picker unless the caller has them. */
    public async upload(roomId: string, files?: File[]): Promise<ActionOutcome> {
        this.used = true;
        const room = this.client.getRoom(roomId);
        if (!room) throw new ClientViewActionError("unknown_room", `no room ${roomId}`);
        // A new DM is still a local room: Element would queue the upload on it and create the room behind the user's back.
        // Refused before any picker or dialog; the first message creates the room.
        if (isLocalRoom(roomId))
            throw new ClientViewActionError(
                "unsupported",
                "send a message first: a new chat has no room to upload into yet",
            );
        let chosen: File[] | null;
        if (files) chosen = await rewrapFiles(files);
        else {
            this.filePicker?.cancel();
            const picker = openFilePicker(document);
            this.filePicker = picker;
            try {
                chosen = await picker.files;
            } finally {
                if (this.filePicker === picker) this.filePicker = undefined;
            }
        }
        if (!chosen?.length) return { status: "cancelled" };
        const vm = new RoomUploadViewModel(
            room,
            this.client,
            TimelineRenderingType.Room,
            defaultDispatcher,
            undefined,
            undefined,
            () => {},
        );
        try {
            return await uploadFiles(vm, room, chosen);
        } finally {
            vm.dispose();
        }
    }

    /** The room's list item view-model and Room for an A10 action, or the contract's `unknown_room`. */
    private roomItem(roomId: string): { item: RoomItemActionsVm & RoomSectionVm; room: Room } {
        const room = this.client.getRoom(roomId);
        const item = this.roomList.getRoomItemViewModel(roomId);
        if (!room || !item || !("onMarkAsUnread" in item))
            throw new ClientViewActionError("unknown_room", `${roomId} is not in the room list`);
        return { item, room };
    }

    public async markUnread(roomId: string): Promise<ActionOutcome> {
        const { item, room } = this.roomItem(roomId);
        return markUnread(item, room);
    }

    public async setFavourite(roomId: string, on: boolean): Promise<ActionOutcome> {
        const { item, room } = this.roomItem(roomId);
        return setFavourite(item, room, on);
    }

    public async setSection(roomId: string, tag: string | null): Promise<ActionOutcome> {
        const { item, room } = this.roomItem(roomId);
        return setSection(item, room, tag);
    }

    public async createSection(roomId?: string): Promise<ActionOutcome> {
        if (roomId === undefined) return createSection(undefined);
        const { room } = this.roomItem(roomId);
        return createSection(room);
    }

    public async setNotificationLevel(roomId: string, level: ViewNotificationLevel): Promise<ActionOutcome> {
        const { item, room } = this.roomItem(roomId);
        return setNotificationLevel(item, room, this.client, level);
    }

    public onChange(cb: (e: ChangeEvent) => void): () => void {
        this.used = true;
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    public dispose(): void {
        this.disposed = true;
        this.closeReactionPicker();
        this.filePicker?.cancel();
        [...this.reactionWaits].forEach((cancel) => cancel());
        this.watchedItems.forEach((w) => w.off());
        this.watchedItems.clear();
        this.disposers.forEach((d) => d());
        this.rows.forEach((r) => r.dispose());
        this.callCards.forEach((c) => c.dispose());
        this.senderAvatars.forEach((a) => a.dispose());
        this.timelines.forEach((t) => t.dispose());
        this.permalinkCreators.forEach((c) => c.stop());
        this.permalinkCreators.clear();
        this.userProviders.forEach((p) => p.destroy());
        this.userProviders.clear();
        this.memberLoadFailed.clear();
        this.readUnlisted.clear();
        this.statusBar?.dispose();
        this.userMenu.dispose();
        this.roomList.dispose();
        this.listeners.clear();
    }
}
