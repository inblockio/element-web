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

/** What the host hands a kit, as `window.__clientViewBridge`. */
export interface ClientViewBridge {
    readonly version: 1;
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
    onChange(cb: (e: { kind: "rooms" | "timeline" | "me" | "connection"; roomId?: string }) => void): () => void;
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
