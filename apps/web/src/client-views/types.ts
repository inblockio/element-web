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
}

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
    /** The message has been edited (the edited marker's rule: a replacement event exists). */
    edited?: true;
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
export type ActionOutcome = { status: "done"; roomId?: string; eventId?: string } | { status: "cancelled" };

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
     * A11: edits the user's own message `eventId` (the Matrix event id) to the plain text `text`. Resolves `done` with
     * the ORIGINAL event id once the homeserver holds the replacement. `forbidden` for another user's message or one
     * Element does not let the user edit (`ViewMessage.canEdit`), `unknown_event` when it cannot be loaded, `failed`
     * for a blank text (nothing is sent). Interim (D16/D20): entry through the action bar view-model's `onEditClick`,
     * the replacement send is Element's own client call.
     */
    editText(roomId: string, eventId: string, text: string): Promise<ActionOutcome>;
    /**
     * A12: deletes (redacts) the user's own message `eventId`. `done` once the homeserver accepted the redaction;
     * `forbidden` for another user's message (also for a user with redact power), `unknown_event` when it cannot be
     * loaded. The kit asks for the confirmation. Interim (D16/D20): Element's own client call.
     */
    redact(roomId: string, eventId: string): Promise<ActionOutcome>;
    /** A2: toggles the user's reaction `key` on a message (the reactions row button view-model's click). */
    react(roomId: string, eventId: string, key: string): Promise<ActionOutcome>;
    /** A2: Element's own reaction picker over the kit; `done` when it closes, a chosen reaction arrives as a change. */
    openReactionPicker(roomId: string, eventId: string, anchor: ViewAnchor): Promise<ActionOutcome>;
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
