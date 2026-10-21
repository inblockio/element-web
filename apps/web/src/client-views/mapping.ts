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
import {
    DecryptionFailureReason,
    type RoomListItemViewSnapshot,
    type EventContentBodyViewSnapshot,
} from "@element-hq/web-shared-components";

import { type EventTileViewModelSnapshot } from "../viewmodels/room/timeline/event-tile/EventTileViewModel";
import { type EventTileE2ePadlockViewState } from "../viewmodels/room/timeline/event-tile/EventTileE2eState";
import { type ViewE2e, type ViewMessage, type ViewReply, type ViewRoom } from "./types";

/** The shape of `_t` the mappings need: a translation key and optional variables. */
export type Translate = (key: string, variables?: Record<string, string>) => string;

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

/**
 * The text Element's decryption failure body view shows for a reason (a mirror of the view's `getErrorMessage`,
 * which is module-private; the same reason + local device verification -> translation key table).
 */
export function decryptionFailureText(
    reason: DecryptionFailureReason,
    isLocalDeviceVerified: boolean | undefined,
    t: Translate,
): string {
    switch (reason) {
        case DecryptionFailureReason.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE:
            return t("timeline|decryption_failure|blocked");
        case DecryptionFailureReason.HISTORICAL_MESSAGE_NO_KEY_BACKUP:
            return t("timeline|decryption_failure|historical_event_no_key_backup");
        case DecryptionFailureReason.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED:
            if (isLocalDeviceVerified === false)
                return t("timeline|decryption_failure|historical_event_unverified_device");
            break;
        case DecryptionFailureReason.HISTORICAL_MESSAGE_USER_NOT_JOINED:
            return t("timeline|decryption_failure|historical_event_user_not_joined");
        case DecryptionFailureReason.SENDER_IDENTITY_PREVIOUSLY_VERIFIED:
            return t("timeline|decryption_failure|sender_identity_previously_verified");
        case DecryptionFailureReason.UNSIGNED_SENDER_DEVICE:
            return t("timeline|decryption_failure|sender_unsigned_device");
    }
    return t("timeline|decryption_failure|unable_to_decrypt");
}

/**
 * The warning a padlock state stands for, if any: the title of any icon, or the "shared by" text of a forwarded
 * message. The grey icon warns too: its only case is a key from an insecure source (authenticity not guaranteed), i.e.
 * a sending device not established for that message ("unknown" in REQ-0007). Only `none` carries no warning.
 */
export function padlockWarning(padlock: EventTileE2ePadlockViewState, sharedByText?: string): string | undefined {
    switch (padlock.kind) {
        case "icon":
            return padlock.title;
        case "messageShared":
            return sharedByText;
        case "none":
            return undefined;
    }
}

/** The e2e field of a ViewMessage. `failure` is set while the event is a decryption failure, `pending` while waiting. */
export function toViewE2e(input: {
    pending?: boolean;
    failure?: { reason: DecryptionFailureReason; isLocalDeviceVerified?: boolean };
    padlock: EventTileE2ePadlockViewState;
    sharedByText?: string;
    encrypted: boolean;
    t: Translate;
}): ViewE2e | undefined {
    if (input.failure) {
        return {
            state: "failed",
            text: decryptionFailureText(input.failure.reason, input.failure.isLocalDeviceVerified, input.t),
        };
    }
    // Element shows nothing while a message waits for its key, so the kit gets the placeholder and no reason.
    if (input.pending) return { state: "pending", text: "" };
    const warning = padlockWarning(input.padlock, input.sharedByText);
    if (warning === undefined && !input.encrypted) return undefined;
    return warning === undefined ? { state: "decrypted" } : { state: "decrypted", warning };
}

/** An event tile snapshot plus its body snapshot as a ViewMessage; undefined for a tile without an event id. */
export function toViewMessage(
    roomId: string,
    tile: Pick<EventTileViewModelSnapshot, "event" | "sender" | "timestamp">,
    body: Pick<EventContentBodyViewSnapshot, "body" | "formattedBody">,
    senderAvatarUrl?: string,
    e2e?: ViewE2e,
    replyTo?: ViewReply,
): ViewMessage | undefined {
    const id = tile.event.eventId;
    if (!id) return undefined;
    const senderId = tile.sender.senderId ?? "";
    const failed = e2e?.state === "failed" || e2e?.state === "pending";
    return {
        id,
        roomId,
        senderId,
        senderName: tile.sender.member?.rawDisplayName || senderId,
        senderAvatarUrl,
        ts: tile.timestamp.value,
        // The SDK's placeholder body of an undecryptable event ("** Unable to decrypt ... **") is never handed over.
        body: failed ? "" : typeof body.body === "string" ? body.body : nodeText(body.body),
        formattedBody: failed ? undefined : body.formattedBody,
        kind: kindOf(tile.event.msgtype),
        ...(e2e ? { e2e } : {}),
        ...(replyTo ? { replyTo } : {}),
    };
}
