/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

/*
 * A10 mark unread, favourite, notification level: the room list item view-model's own actions
 * (`RoomListItemViewModel.onMarkAsUnread`, `.onToggleFavorite`, `.onSetRoomNotifState`). Each is fire-and-forget in the
 * view-model (the state is Element's per-user room account data, room tags and push rules, written by `setRoomAccountData`,
 * `setRoomTag` / `deleteRoomTag` and `setRoomNotifsState`), so the outcome is read where the view-model leaves it: the
 * returned promise, the dispatched `RoomListActions.tagRoom.*` result, the local-echo transaction. D21: `done` only once the
 * homeserver has answered the write; a refusal rejects, and an echo that Element would keep showing is dropped.
 */

import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { DefaultTagID } from "../stores/room-list-v3/skip-list/tag";
import { EchoChamber } from "../stores/local-echo/EchoChamber";
import { TransactionStatus } from "../stores/local-echo/EchoTransaction";
import { getRoomNotifsState } from "../RoomNotifs";
import { toActionError } from "./actions";
import { recordPayloads, ROOM_ACTION_TIMEOUT_MS } from "./RoomActions";
import { type ActionOutcome, ClientViewActionError, type ViewNotificationLevel } from "./types";

/** After the homeserver accepted a tag write, how long the room's tags may take to show it (they come back with the sync). */
const TAG_SETTLE_MS = 8_000;

/** The part of `RoomListItemViewModel` an A10 action uses. */
export interface RoomItemActionsVm {
    getSnapshot(): {
        isFavourite: boolean;
        canMarkAsUnread: boolean;
        showNotificationMenu: boolean;
        roomNotifState: string;
        notification: { invited?: boolean };
    };
    subscribe(cb: () => void): () => void;
    onMarkAsUnread(): void | Promise<void>;
    onToggleFavorite(): void;
    onSetRoomNotifState(state: ViewNotificationLevel): void;
}

const done = (roomId: string): ActionOutcome => ({ status: "done", roomId });

function assertListed(room: Room): void {
    if (room.tags?.[DefaultTagID.Archived])
        throw new ClientViewActionError("unsupported", "an archived room has no such action");
}

/**
 * A10 mark unread: `onMarkAsUnread` writes the room account data `m.marked_unread` (Element's `setMarkedUnreadState`) and
 * its promise is the homeserver's answer. A room that already shows unread (`canMarkAsUnread` false) is left as it is.
 */
export async function markUnread(item: RoomItemActionsVm, room: Room): Promise<ActionOutcome> {
    const snap = item.getSnapshot();
    if (snap.notification.invited) throw new ClientViewActionError("unsupported", "an invite is not marked unread");
    assertListed(room);
    if (!snap.canMarkAsUnread) return done(room.roomId);
    try {
        await item.onMarkAsUnread();
    } catch (e) {
        throw toActionError(e);
    }
    return done(room.roomId);
}

// One favourite change at a time: the tag action's result payloads do not name the room.
let favouriteQueue: Promise<unknown> = Promise.resolve();

const FAVOURITE_TAG = "m.favourite";
const isTagged = (room: Room): boolean => !!room.tags?.[FAVOURITE_TAG];

/**
 * A10 favourite: `onToggleFavorite` dispatches `RoomListActions.tagRoom` (set / delete the room tag `m.favourite`). Its
 * `.success` / `.failure` payloads name no room (any other room's tag change, low priority or "move to section" dispatch the
 * same action), so they only tell that Element has an answer; the outcome is the room's own `m.favourite` tag: `done` once
 * it is as asked (it arrives with the sync), `failed` when it is not within `TAG_SETTLE_MS` after the latest answer (at once
 * for a failure when no other room's tag write was pending: it is this one's) or after `ROOM_ACTION_TIMEOUT_MS`.
 */
export function setFavourite(item: RoomItemActionsVm, room: Room, on: boolean): Promise<ActionOutcome> {
    const run = async (): Promise<ActionOutcome> => {
        const snap = item.getSnapshot();
        if (snap.notification.invited) throw new ClientViewActionError("unsupported", "an invite is not a favourite");
        assertListed(room);
        if (isTagged(room) === on) return done(room.roomId);
        const seen = recordPayloads();
        try {
            item.onToggleFavorite();
            const start = Date.now();
            let read = 0;
            let answeredAt = 0;
            let foreignPending = false;
            let refusedAlone = false;
            for (;;) {
                for (; read < seen.payloads.length; read++) {
                    const p = seen.payloads[read] as { action: string; request?: { room?: Room } };
                    if (p.action === "RoomListActions.tagRoom.pending" && p.request?.room?.roomId !== room.roomId)
                        foreignPending = true;
                    if (
                        p.action === "RoomListActions.tagRoom.success" ||
                        p.action === "RoomListActions.tagRoom.failure"
                    ) {
                        answeredAt = Date.now();
                        if (p.action.endsWith("failure") && !foreignPending) refusedAlone = true;
                    }
                }
                if (isTagged(room) === on) return done(room.roomId);
                if (refusedAlone) throw new ClientViewActionError("failed", "the homeserver refused the tag");
                const now = Date.now();
                if (answeredAt && now - answeredAt > TAG_SETTLE_MS)
                    throw new ClientViewActionError("failed", "the room's tags did not change");
                if (now - start > ROOM_ACTION_TIMEOUT_MS)
                    throw new ClientViewActionError("failed", "Element did not finish the action in time");
                await new Promise((r) => setTimeout(r, 50));
            }
        } catch (e) {
            throw toActionError(e);
        } finally {
            seen.stop();
        }
    };
    const next = favouriteQueue.then(run, run);
    favouriteQueue = next.catch(() => undefined);
    return next;
}

/**
 * A10 notification level: `onSetRoomNotifState` sets Element's local echo (`RoomEchoChamber.notificationVolume`) and runs
 * the push rule writes as an echo transaction, whose status is the homeserver's answer. A failed transaction leaves the
 * echoed level shown (Element offers a retry); the bridge drops it (`setClient` re-reads the push rules and clears the
 * echo) so no level the homeserver does not hold stays visible. `Success` is checked against the push rules' computed level
 * (`getRoomNotifsState`). On `network` (no answer in 15 s) the in-flight write is not stoppable and may still apply.
 */
export async function setNotificationLevel(
    item: RoomItemActionsVm,
    room: Room,
    client: MatrixClient,
    level: ViewNotificationLevel,
): Promise<ActionOutcome> {
    const snap = item.getSnapshot();
    if (snap.notification.invited)
        throw new ClientViewActionError("unsupported", "an invite has no notification level");
    assertListed(room);
    if (!snap.showNotificationMenu)
        throw new ClientViewActionError("unsupported", "Element offers no notification level for this room");
    const chamber = EchoChamber.forRoom(room);
    // The item's snapshot is not refreshed when the level changes (see `ViewModelBridge.notificationLevelOf`): the echo is.
    if ((chamber.notificationVolume ?? snap.roomNotifState) === level) return done(room.roomId);
    const before = new Set(chamber.context.transactions);
    item.onSetRoomNotifState(level);
    const txn = chamber.context.transactions.find((t) => !before.has(t));
    if (!txn) throw new ClientViewActionError("failed", "Element started no change");
    const until = Date.now() + ROOM_ACTION_TIMEOUT_MS;
    while (txn.status === TransactionStatus.Pending && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    if (txn.status === TransactionStatus.Success) {
        // `Success` is also what `EchoTransaction.cancel()` sets (a sync of the push rules while this write is pending), so it
        // is not yet the homeserver's answer: the level its push rules now compute for the room must be the asked one.
        const settleUntil = Date.now() + TAG_SETTLE_MS;
        for (;;) {
            if (getRoomNotifsState(client, room.roomId) === level) return done(room.roomId);
            if (Date.now() > settleUntil) break;
            await new Promise((r) => setTimeout(r, 50));
        }
        chamber.setClient(client);
        throw new ClientViewActionError("failed", "the homeserver's notification level is not the asked one");
    }
    // Refused (or no answer in time): the echo is not the homeserver's state.
    chamber.setClient(client);
    throw new ClientViewActionError(
        txn.status === TransactionStatus.Error ? "failed" : "network",
        "the homeserver did not take the notification level",
    );
}
