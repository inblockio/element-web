/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

/*
 * Pure mapping from shipped view-model snapshots to the plain client-view data.
 * Kept free of view-model construction so it can be unit-tested with snapshot literals.
 */

import { isValidElement, type ReactNode } from "react";
import { MsgType } from "matrix-js-sdk/src/matrix";
import { type RoomListItemViewSnapshot, type EventContentBodyViewSnapshot } from "@element-hq/web-shared-components";

import { type EventTileViewModelSnapshot } from "../viewmodels/room/timeline/event-tile/EventTileViewModel";
import { type ViewMessage, type ViewRoom } from "./types";

/**
 * The text a rendered body node shows. The body view-model returns a JSX array (one element per emoji) for an
 * emoji-only message instead of a string; the emoji are the elements' children, so the text is read from there.
 */
export function nodeText(node: ReactNode): string {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(nodeText).join("");
    if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
    return "";
}

/** A room list item snapshot as a ViewRoom. */
export function toViewRoom(
    snapshot: Pick<RoomListItemViewSnapshot, "id" | "name" | "isDm" | "notification">,
    order: number,
    avatarUrl?: string,
): ViewRoom {
    const n = snapshot.notification;
    const unreadCount = n.hasUnreadCount ? n.count : 0;
    return {
        id: snapshot.id,
        name: snapshot.name,
        avatarUrl,
        unreadCount,
        mentionCount: n.isMention ? unreadCount : 0,
        isDirect: snapshot.isDm,
        order,
    };
}

const kindOf = (msgtype: string | undefined): ViewMessage["kind"] => {
    switch (msgtype) {
        case MsgType.Text:
            return "text";
        case MsgType.Notice:
            return "notice";
        case MsgType.Emote:
            return "emote";
        default:
            return "other";
    }
};

/** An event tile snapshot plus its body snapshot as a ViewMessage; undefined for a tile without an event id. */
export function toViewMessage(
    roomId: string,
    tile: Pick<EventTileViewModelSnapshot, "event" | "sender" | "timestamp">,
    body: Pick<EventContentBodyViewSnapshot, "body" | "formattedBody">,
    senderAvatarUrl?: string,
): ViewMessage | undefined {
    const id = tile.event.eventId;
    if (!id) return undefined;
    const senderId = tile.sender.senderId ?? "";
    return {
        id,
        roomId,
        senderId,
        senderName: tile.sender.member?.rawDisplayName || senderId,
        senderAvatarUrl,
        ts: tile.timestamp.value,
        body: typeof body.body === "string" ? body.body : nodeText(body.body),
        formattedBody: body.formattedBody,
        kind: kindOf(tile.event.msgtype),
    };
}
