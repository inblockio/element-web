/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

/*
 * The contract between Element and a client view ("kit"): an alternative UI that Element hosts after login.
 * Plain data only, no Element or matrix-js-sdk types, so a kit can be built and tested without either.
 * Every value comes from a shipped view-model snapshot; a field without a view-model source stays undefined.
 */

/** A room as the room list view-model shows it. */
export interface ViewRoom {
    id: string;
    name: string;
    avatarUrl?: string;
    unreadCount: number;
    mentionCount: number;
    isDirect: boolean;
    /** position in the room list snapshot, 0 = top */
    order: number;
    /**
     * `invite` = the room list item's snapshot flags the room as invited (`notification.invited`); absent or `join` =
     * joined. An invite has no inviter field (no view-model source).
     */
    membership?: "join" | "invite";
    /** The room is a favourite (the room list item's `isFavourite`, the `m.favourite` room tag). */
    isFavourite: boolean;
    /**
     * The room's custom section (the room list item's `sections`, the entry with `isSelected`): the opaque tag of one of
     * `ClientViewBridge.sections()`. Absent for a room in no custom section. Exclusive with `isFavourite` (Element's tagRoom
     * keeps a room in one section).
     */
    section?: string;
    /**
     * Element offers "mark as unread" for the room (the item's `canMarkAsUnread`): it shows nothing unread and is not
     * archived. For a joined room, false means it already shows unread, by a count, an activity or a mark.
     */
    canMarkAsUnread: boolean;
    /**
     * Element shows the room as unread (the item's `canMarkAsRead`: a count, an activity or a "marked unread" mark; the
     * room's notification level is above none). False for a joined room that shows nothing unread, for a local room (a
     * new DM before its first message) and for the preview of a left room: those have no unread state. The kit's unread
     * look (bold row) reads this, not `canMarkAsUnread`.
     */
    showsUnread: boolean;
    /** The room's notification level (the item's `roomNotifState`). */
    notificationLevel: ViewNotificationLevel;
}

/**
 * A custom room-list section (Element's `RoomList.CustomSectionData` / `RoomList.OrderedCustomSections`), as the room list
 * item view-model's `sections` lists them. `tag` is opaque (a kit passes it back as it got it), `order` is Element's, 0 = top.
 */
export interface ViewSection {
    tag: string;
    name: string;
    order: number;
}

/**
 * A call, on the message that roots it (the `org.matrix.msc4075.rtc.notification` event Element draws its call card
 * from). Filled only from the call-card view-models: `RootCallTileViewModel` decides ongoing or ended, the Room/Dm
 * ongoing tile view-models give the participants, `DurationViewModel` the running time, the Room/Dm tombstone ones the
 * end and, in a DM, the decline. The host reads no MatrixRTC state of its own.
 */
export interface ViewCall {
    /** The call's id: the root event's id (`ViewMessage.id`). */
    callId: string;
    /** `RootCallTileViewModel.tileType`: an ongoing tile is "ongoing", a tombstone tile is "ended". */
    state: "ongoing" | "ended";
    /** The call's intent (the tile view-models read it from the notification event: `m.call.intent`). */
    callType: "video" | "voice";
    /** A DM tile (`ongoing-call-dm`, `tombstone-call-dm`), else a room tile. */
    isDm: boolean;
    /** The face pile of the ongoing tile (Element shows at most three). Empty when ended. */
    participants: ViewCallParticipant[];
    /** The room tile's `totalParticipants` (everyone in the call, not only the face pile). Ongoing room tile only. */
    participantCount?: number;
    /** When the call started: the notification event's `origin_server_ts` (the tombstone view-models give no time other than a formatted string). */
    startedTs: number;
    /** `DurationViewModel.duration` in seconds. Ongoing only; ended calls have no duration in any view-model. */
    durationSeconds?: number;
    /** The DM tombstone tile's `isCallDeclined`. Only a DM tombstone has it. */
    declined?: boolean;
}

export interface ViewCallParticipant {
    userId: string;
    name: string;
    avatarUrl?: string;
}

/** The notification levels of a room, as the room list item view-model's `RoomNotifState` names them. */
export type ViewNotificationLevel = "all_messages" | "all_messages_loud" | "mentions_only" | "mute";

/** A message as the timeline, event tile and body view-models show it. */
export interface ViewMessage {
    id: string;
    roomId: string;
    senderId: string;
    senderName: string;
    senderAvatarUrl?: string;
    ts: number;
    /** plain text, always a string (emoji-only included) */
    body: string;
    /** sanitized HTML if the view-model exposes it */
    formattedBody?: string;
    kind: "text" | "notice" | "emote" | "other";
    /**
     * Trust signals from the E2E view-models (REQ-0007). Absent for a message without any.
     * `pending`/`failed`: the message has no readable body (`body` is empty), `text` is the reason Element shows.
     * `decrypted`: the body is readable; `warning` is the padlock text when the padlock marks the message.
     */
    e2e?: ViewE2e;
    /** The message this one replies to, from the reply tile view-model, once it is loaded. */
    replyTo?: ViewReply;
    /** Reactions from the reactions row button view-models, in Element's order. Absent for a message without any. */
    reactions?: ViewReaction[];
    /** The thread this message roots, from the thread summary view-model. Absent for a message without replies. */
    thread?: ViewThread;
    /**
     * Own messages: the transaction id the message was sent with (`getTxnId()`, else the echo's
     * `unsigned.transaction_id`). A kit that sent it with a txnId of its own recognises its optimistic copy by it.
     */
    txnId?: string;
    /**
     * Own message that Element's edit rule allows editing (`canEditContent`: sent, not redacted, not an edit itself, own,
     * `m.text` or `m.emote` with a body). A kit offers its edit control only when this is true. Absent = not editable.
     */
    canEdit?: boolean;
    /**
     * M6 B2: the message is pinned (`m.room.pinned_events` of its room lists it, `PinningUtils.isPinned`). Absent = not pinned.
     * Refreshed when the room's pinned list changes, also from another client.
     */
    pinned?: boolean;
    /**
     * M6 B2: Element offers Pin (or Unpin, when pinned) on this message to the user: the action bar's own rule
     * (`PinningUtils.canPin` or `canUnpin`: the user may send `m.room.pinned_events` and the event is pinnable). A kit offers
     * its pin control only when this is true. Absent = not offered.
     */
    canPin?: boolean;
    /**
     * Element's permalink for this event, as its own "Copy link" / Share gives it (`RoomPermalinkCreator.forEvent`:
     * matrix.to or the configured permalink prefix, with `via` servers). Absent for a deleted message.
     */
    permalink?: string;
    /**
     * Element offers a download for this message (the Download action bar button's rule: a media message whose content is
     * actionable, `isContentActionable` and `MediaEventHelper.isEligible`). False or absent for a text message, a
     * redacted one and one still waiting for its key; the module permission hint of the action bar view-model is not
     * read here, `download` reports it as `forbidden`.
     */
    canDownload?: boolean;
    /** The message has been edited (the edited marker's rule: a replacement event exists). */
    edited?: true;
    /** When the latest replacement was sent (ms since epoch; `ts` stays the original's). Only with `edited`, when known. */
    editedTs?: number;
    /**
     * The message was deleted (redacted). Its `body` is then Element's own redacted text ("Message deleted"); a kit may
     * drop or tombstone the row.
     */
    redacted?: true;
    /** The image, file, video or audio of a media message, from its body view-model. Absent for any other message. */
    media?: ViewMedia;
    /**
     * The link previews of the message, from the URL preview group view-model, in Element's order. Absent when Element
     * shows none: previews hidden by the setting (room or encrypted-room default), by the user, or no link.
     */
    urlPreviews?: ViewUrlPreview[];
    /**
     * Set on the root event of a call (`kind` is "other", `body` is empty): the call card Element draws. See `ViewCall`.
     * Version 2, additive: a kit that does not know the field gets a message with an empty body and no content.
     */
    call?: ViewCall;
}

/**
 * A media body as the image, file, video or audio body view-model shows it. URLs are plain strings the kit's frame can load
 * (authenticated media goes through Element's service worker, encrypted media is the view-model's decrypted blob URL).
 * `state` "hidden" = Element's media-visibility setting hides it (`label` = the reveal text Element shows),
 * "error" = Element shows its error (`label` = that text), "loading" = no URL yet.
 * `name` is the label Element shows: the image alt, the video title, or the file or audio label (which already
 * carries the size). `width` and `height` are the frame size the view-model suggests for an image or video.
 * An audio message (a voice message included) has no body view-model here: Element's one decodes the whole file to
 * play it, so `url` is the media helper's (the homeserver URL, or the decrypted blob URL) and the kit's frame plays it.
 */
export interface ViewMedia {
    kind: "image" | "file" | "video" | "audio";
    state: "ready" | "loading" | "hidden" | "error";
    url?: string;
    thumbnailUrl?: string;
    name: string;
    width?: number;
    height?: number;
    label?: string;
}

/**
 * A link preview as the URL preview group view-model shows it. `image.url` is the thumbnail it fetched (absent when
 * Element's media-visibility setting hides media); `ogUrl` is the page's own canonical URL, if it differs from `link`.
 */
export interface ViewUrlPreview {
    link: string;
    title: string;
    siteName: string;
    description?: string;
    siteIcon?: string;
    ogUrl?: string;
    author?: string;
    image?: { url: string; width?: number; height?: number; alt?: string };
}

/**
 * A thread summary: `replyCount` as the summary view-model counts it, `lastReplyTs` in ms (the root's own time when the
 * latest reply is not loaded), `participantIds` = distinct senders of the replies, `lastReply.text` empty while that
 * event or its edit is unreadable.
 */
export interface ViewThread {
    replyCount: number;
    lastReplyTs: number;
    lastReply?: { eventId: string; senderId: string; text: string };
    participantIds: string[];
}

/** One reaction key: `count` = distinct senders, `mine` = the user reacted with it (not redacted). */
export interface ViewReaction {
    key: string;
    count: number;
    mine: boolean;
    senderIds: string[];
}

/** A replied-to message: `text` is its plain body without its own reply fallback, empty while it is unreadable. */
export interface ViewReply {
    eventId: string;
    senderId: string;
    senderName: string;
    text: string;
}

export type ViewE2e = { state: "pending" | "failed"; text: string } | { state: "decrypted"; warning?: string };

/** The signed-in user as the user menu view-model shows them. */
export interface ViewMe {
    userId: string;
    displayName: string;
    avatarUrl?: string;
}

export type ViewConnection = "online" | "connecting" | "offline";

/**
 * What an action resolved with. `done`: the effect happened (the server answered, the snapshot changed, the dialog
 * returned). `cancelled`: the user dismissed Element's own dialog or picker (never an error).
 */
export type ActionOutcome =
    | { status: "done"; roomId?: string; eventId?: string; section?: string }
    | { status: "cancelled" };

export type ClientViewActionErrorCode =
    | "unknown_room"
    | "unknown_event"
    | "forbidden"
    | "network"
    | "unsupported"
    | "failed";

/** What a rejected action carries: a code a kit maps to its own error, and Element's message. */
export class ClientViewActionError extends Error {
    public constructor(
        public readonly code: ClientViewActionErrorCode,
        message?: string,
    ) {
        super(message ?? code);
        this.name = "ClientViewActionError";
    }
}

/** Where a kit's control sits, in page coordinates (the kit's frame covers the page from its origin). */
export interface ViewAnchor {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** What `loadOlder` reports: the messages it brought in, and why no further page can follow. */
export interface LoadOlderResult {
    /** Events that newly entered the loaded window. */
    added: number;
    /** The room's creation event is in the window: there is nothing older. */
    atStart: boolean;
    /** The window is within one page of its size limit: older history is out of reach (loading it would drop the live end). */
    atLimit: boolean;
    /** The event ids this page added to the loaded window (a kit tells history from a live arrival by them, not by position or time). */
    ids?: string[];
}

/** What the host hands a kit, as `window.__clientViewBridge`. */
export interface ClientViewBridge {
    readonly version: 2;
    me(): ViewMe;
    rooms(): ViewRoom[];
    /** starts (idempotent) and returns the timeline of a room */
    timeline(roomId: string): ViewMessage[];
    markRead(roomId: string): void;
    connection(): ViewConnection;
    /** every selectable view, "stock" included */
    views(): { id: string; name: string }[];
    /** "stock" = Element's own UI */
    switchTo(viewId: string): void;
    /**
     * The address of the call app from the host config (`client_views_meet_url`), or undefined when the instance has none:
     * a kit then offers no call. Version 2, additive: a host without it is a host without calls. A kit builds the join
     * link from it (`<meetUrl>/#/room/<roomId>`); the call itself runs in that app, never in the kit.
     */
    meetUrl(): string | undefined;
    /**
     * Sends a plain-text message (`m.text`, no markdown) and resolves `done` + `eventId` once the server returns it.
     * `opts.txnId` is the transaction id the sent event carries (`ViewMessage.txnId`); `opts.replyTo` is the event id
     * of the replied message. In a local (not yet created) room the first send creates the room and `roomId` is the
     * real one. Interim (D16): Element's own client call, until a composer send view-model ships.
     */
    sendText(roomId: string, text: string, opts?: { txnId?: string; replyTo?: string }): Promise<ActionOutcome>;
    /**
     * Loads the next page of older messages of a room and resolves when the page is in (the room's `timeline` has
     * changed by then). Concurrent calls for a room share one load. Backed by the timeline view-model's
     * `onStartReached`. Rejects `unknown_room` for a room the bridge does not know, `failed` if the room's first window
     * never loads.
     */
    loadOlder(roomId: string): Promise<LoadOlderResult>;
    onChange(cb: (e: { kind: "rooms" | "timeline" | "me" | "connection"; roomId?: string }) => void): () => void;
    /**
     * A5: joins a room by id or `#alias:server` (no `ViewRoom`); `done` + the joined room's id. `unknown_room` for an
     * address that does not exist, `forbidden` when the server refuses. Interim (D16).
     */
    join(roomIdOrAlias: string): Promise<ActionOutcome>;
    /** A5: accepts an invite (the join of that room). Interim (D16). */
    acceptInvite(roomId: string): Promise<ActionOutcome>;
    /** A5: declines an invite (`client.leave`). Interim (D16). */
    declineInvite(roomId: string): Promise<ActionOutcome>;
    /**
     * A6: Element's create-room dialog (`RoomListViewModel.createRoom`). `done` + the new room's id once Element has
     * created it, `cancelled` when the dialog closes without creating, `failed` on Element's error dialog or after 15 s.
     */
    createRoom(): Promise<ActionOutcome>;
    /**
     * A6: Element's start-chat dialog (`RoomListViewModel.createChatRoom`). `done` + the chat's room id: an existing DM,
     * or the local room of a new one (listed in `rooms()` until its first `sendText` creates the real room).
     * `cancelled` when the dialog closes without a chat.
     */
    createChat(): Promise<ActionOutcome>;
    /**
     * A7: Element's leave confirm (`RoomListItemViewModel.onLeaveRoom`). `done` once the user is no longer in the room,
     * `cancelled` when the confirm says no, `unsupported` for an archived room, `failed` when the leave did not happen.
     */
    leave(roomId: string): Promise<ActionOutcome>;
    /**
     * A11: edits the user's own message `eventId` (the Matrix event id) to the plain text `text`. Resolves `done` with
     * the ORIGINAL event id once the homeserver holds the replacement. `forbidden` for another user's message or one
     * Element does not let the user edit (`ViewMessage.canEdit`), `unknown_event` when it cannot be loaded, `failed`
     * for a blank text (nothing is sent). Interim (D16/D20): entry through the action bar view-model's `onEditClick`,
     * the replacement send is Element's own client call.
     */
    editText(roomId: string, eventId: string, text: string): Promise<ActionOutcome>;
    /**
     * M6 B2: pins (`on`) or unpins the message `eventId` (the Matrix event id): `m.room.pinned_events` of the room. `done` once
     * the homeserver accepted the new list and the room's state shows it (`ViewMessage.pinned` equals `on`); already as asked is
     * `done` without a call. `forbidden` when Pin is not offered (`ViewMessage.canPin` false) or the homeserver refuses,
     * `unknown_event` / `unknown_room`, `network` when the state did not show in time (the write may still apply). A refused
     * write changes nothing locally. Calls for one room run one after the other. Backed by the action bar view-model's
     * `onPinClick` (D22; Element's `PinningUtils.pinOrUnpinEvent`, copy-fixed in the hook set).
     */
    setPinned(roomId: string, eventId: string, on: boolean): Promise<ActionOutcome>;
    /**
     * A12: deletes (redacts) the user's own message `eventId`. `done` once the homeserver accepted the redaction;
     * `forbidden` for another user's message (also for a user with redact power), `unknown_event` when it cannot be
     * loaded. The kit asks for the confirmation. Interim (D16/D20): Element's own client call.
     */
    redact(roomId: string, eventId: string): Promise<ActionOutcome>;
    /**
     * B7: downloads the file, image, video or audio of the message `eventId` the way Element's Download action bar button
     * does (`EventTileActionBarViewModel.onDownloadClick`): it waits until the event is decrypted, then Element fetches
     * and decrypts the file and saves it with its own downloader. `done` once Element's click settled, which is also the
     * case when the fetch or decryption failed: Element's own error dialog shows then and the kit shows nothing of its
     * own. `unknown_room` / `unknown_event` for what the client cannot load, `unsupported` for a message without media,
     * `failed` when it stays undecrypted, `forbidden` when the view-model does not offer the download.
     */
    download(roomId: string, eventId: string): Promise<ActionOutcome>;
    /**
     * A10: marks the room unread (the room list item's `onMarkAsUnread`: the room account data `m.marked_unread`). `done`
     * once the homeserver holds it, also for a room that already shows unread; `unsupported` for an invite or an archived
     * room, `unknown_room` for a room the list does not hold.
     */
    markUnread(roomId: string): Promise<ActionOutcome>;
    /**
     * A10: favourites or unfavourites the room (the item's `onToggleFavorite`, called only when `isFavourite` differs: the
     * `m.favourite` tag). `done` once the homeserver holds it and the room's tags show it; `failed` when it refuses (Element's
     * error dialog shows too).
     */
    setFavourite(roomId: string, on: boolean): Promise<ActionOutcome>;
    /**
     * The custom sections, in Element's order (the room list item view-model's `sections`: custom sections only, the
     * default sections are `isFavourite` and the unsectioned rest). A change fires `onChange` with kind `rooms`. Empty while
     * the list holds no room.
     */
    sections(): ViewSection[];
    /**
     * M6 B1: puts the room into the custom section `tag` (the item's `onToggleSection`, called only when the room's section
     * differs: Element's tagRoom replaces a favourite or another section), or takes it out of its custom section with `null`
     * (`onRemoveFromSection`, only when it is in one). `done` once the room's tags show the target; `unsupported` for an
     * invite, an archived room or a tag `sections()` does not list, `unknown_room`; `network` when the tag does not show in
     * 15 s (the write may still apply; a refusal shows Element's error dialog).
     */
    setSection(roomId: string, tag: string | null): Promise<ActionOutcome>;
    /**
     * M6 B1: Element's create-section dialog (`RoomListStoreV3.createSection`, D17), with `roomId` preselected when given.
     * `done` + `section` (the new tag) once the section exists and, for a room the dialog kept selected, the room is in it;
     * `cancelled` when the dialog closes without a name.
     */
    createSection(roomId?: string): Promise<ActionOutcome>;
    /**
     * A10: sets the room's notification level (the item's `onSetRoomNotifState`: push rules). `done` once the homeserver
     * holds it; `failed` when it refuses (the echoed level is dropped, the level stays what the homeserver holds).
     */
    setNotificationLevel(roomId: string, level: ViewNotificationLevel): Promise<ActionOutcome>;
    /**
     * A8: uploads files into a room through Element's own upload view-model (`RoomUploadViewModel.initiateViaInputFiles`).
     * Without `files`, Element's file picker opens now (call it inside the user's click); with them (from the kit's own
     * picker) they are re-wrapped as files of Element's realm. Element's `UploadConfirmDialog` is the one confirmation and
     * its error dialog shows on a refusal. `done` once every confirmed file is on the homeserver as a message,
     * `cancelled` when the picker or the confirm is dismissed, `failed` when an upload fails, `forbidden` when the user may
     * not send in the room, `unknown_room` for a room the client does not hold.
     */
    upload(roomId: string, files?: File[]): Promise<ActionOutcome>;
    /**
     * A9: signs the user out the way Element's own sign-out button does: `LogoutDialog` (key backup check) or, without
     * crypto, a direct sign-out. `cancelled` when the dialog is dismissed (still signed in). On success the page leaves the
     * session and unmounts the kit, so `done` (after Element announced `on_logged_out`) is normally not observable; `failed`
     * when Element does not sign out within 30 s. Interim (D16): there is no sign-out action on `UserMenuViewModel`.
     */
    logout(): Promise<ActionOutcome>;
    /** A2: toggles the user's reaction `key` on a message (the reactions row button view-model's click). */
    react(roomId: string, eventId: string, key: string): Promise<ActionOutcome>;
    /** A2: Element's own reaction picker over the kit; `done` when it closes, a chosen reaction arrives as a change. */
    openReactionPicker(roomId: string, eventId: string, anchor: ViewAnchor): Promise<ActionOutcome>;
    /**
     * E5: Element's own View source dialog over the kit (what the message context menu opens): the event id and the event
     * JSON of a message the kit shows, for an encrypted event the decrypted and the original source. `done` when the dialog
     * closes (it changes nothing; `roomId` + `eventId` are the message). `unknown_room` / `unknown_event` as the other
     * message actions; `failed` when the dialog does not open or another Element dialog action is running. Interim (D31):
     * awaits a view-source action on a shared message view-model.
     */
    openViewSource(roomId: string, eventId: string): Promise<ActionOutcome>;
}

/** A kit that runs in a same-origin iframe loaded from `url`. */
export interface ClientViewDescriptor {
    id: string;
    name: string;
    url: string;
}

/** The id of Element's own UI. */
export const STOCK_VIEW = "stock";

/** The property under which the host exposes the bridge, on its own window and on the kit's frame window. */
export const BRIDGE_GLOBAL = "__clientViewBridge";
