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
 * returned promise, the room's own tag, the local-echo transaction. D21: `done` only once the
 * homeserver has answered the write; a refusal rejects, and an echo that Element would keep showing is dropped.
 */

import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { DefaultTagID } from "../stores/room-list-v3/skip-list/tag";
import { isSectionTag } from "../stores/room-list-v3/section";
import { EchoChamber } from "../stores/local-echo/EchoChamber";
import { TransactionStatus } from "../stores/local-echo/EchoTransaction";
import { getRoomNotifsState } from "../RoomNotifs";
import { toActionError } from "./actions";
import { ROOM_ACTION_TIMEOUT_MS } from "./RoomActions";
import { type ActionOutcome, ClientViewActionError, type ViewNotificationLevel } from "./types";

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

const tagQueue = new Map<string, Promise<unknown>>();

/**
 * Runs `run` after every earlier room-tag write of the room (favourite, custom section) has settled: the room's tags are
 * stale until the sync, and `tagRoom` toggles on them, so an overlapping call would act on a stale state.
 */
export function serialTagWrite<T>(roomId: string, run: () => Promise<T>): Promise<T> {
    const previous = tagQueue.get(roomId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.catch(() => undefined);
    tagQueue.set(roomId, tail);
    void tail.then(() => {
        if (tagQueue.get(roomId) === tail) tagQueue.delete(roomId);
    });
    return next;
}

const LATE_LANDING_MS = 5_000;
const unsettled = new WeakMap<Room, { signature: string; at: number }>();
const tagSignature = (room: Room): string =>
    Object.keys(room.tags ?? {})
        .sort()
        .join("|");

/**
 * A tag write that timed out is not stoppable and may still land (a slow or refused homeserver call looks the same from
 * here). The room's tags at that moment are remembered so the next tag call for the room can tell a late landing from
 * "nothing happened" (`awaitLateLanding`).
 */
export function noteUnsettledTagWrite(room: Room): void {
    unsettled.set(room, { signature: tagSignature(room), at: Date.now() });
}

/**
 * Called first in every queued tag call: after a timed-out write for this room, waits (at most `LATE_LANDING_MS` after the
 * timeout) for the room's tags to change, so the next call acts on, and answers for, the state the late write leaves and
 * not on the state from before it. Nothing to wait for without an earlier timeout; a refused write costs the wait once.
 */
export async function awaitLateLanding(room: Room): Promise<void> {
    const mark = unsettled.get(room);
    if (!mark) return;
    unsettled.delete(room);
    while (tagSignature(room) === mark.signature && Date.now() - mark.at < LATE_LANDING_MS)
        await new Promise((r) => setTimeout(r, 50));
}

/**
 * Every section tag the room holds (favourite, low priority, any custom one). Element's one-section rule means a settled room
 * holds at most one; a room made elsewhere can hold several.
 */
export function sectionTagsOf(room: Room): string[] {
    return Object.keys(room.tags ?? {}).filter((tag) => isSectionTag(tag) && tag !== DefaultTagID.Invite);
}

/**
 * `tagRoom` toggles on the first of a room's section tags, so for a room holding several no kit write (favourite on or off,
 * section move, create with the room) is sure to reach the asked state: `unsupported`, nothing written. Element's own room
 * list can repair such a room.
 */
export function assertSingleSection(room: Room): void {
    if (sectionTagsOf(room).length > 1)
        throw new ClientViewActionError(
            "unsupported",
            "the room holds several section tags (for example favourite and a category); change it in Element's own room list",
        );
}

const FAVOURITE_TAG = "m.favourite";
const isTagged = (room: Room): boolean => !!room.tags?.[FAVOURITE_TAG];
/** Favourite on is settled once the toggle has also replaced the room's section (its delete landed): favourite is the only one left. */
const isSettled = (room: Room, on: boolean): boolean =>
    on ? sectionTagsOf(room).length === 1 && isTagged(room) : !isTagged(room);

/**
 * A10 favourite: `onToggleFavorite` dispatches `RoomListActions.tagRoom` (set / delete the room tag `m.favourite`). Its
 * result payloads name no room (any other room's tag change dispatches the same action), so none is read: the outcome is the
 * room's own tags, which arrive with the sync. Calls for one room run one after the other. `done` once it is as asked (favourite on:
 * `m.favourite` is the room's only section tag, the toggle also replaced a section it held); if it is not within
 * `ROOM_ACTION_TIMEOUT_MS` the answer is `network` (a refusal shows Element's own error dialog and leaves the tag as it was;
 * the write is not stoppable and may still apply).
 */
export function setFavourite(item: RoomItemActionsVm, room: Room, on: boolean): Promise<ActionOutcome> {
    const run = async (): Promise<ActionOutcome> => {
        await awaitLateLanding(room);
        const snap = item.getSnapshot();
        if (snap.notification.invited) throw new ClientViewActionError("unsupported", "an invite is not a favourite");
        assertListed(room);
        assertSingleSection(room);
        if (isTagged(room) === on) return done(room.roomId);
        item.onToggleFavorite();
        const until = Date.now() + ROOM_ACTION_TIMEOUT_MS;
        while (Date.now() < until) {
            if (isSettled(room, on)) return done(room.roomId);
            await new Promise((r) => setTimeout(r, 50));
        }
        noteUnsettledTagWrite(room);
        throw new ClientViewActionError("network", "the room's tag did not change in time; it may still apply");
    };
    // One call at a time per room: the tag is stale until the sync, so an overlapping opposite call would toggle on a stale
    // state (or return `done` on the first call's tag).
    return serialTagWrite(room.roomId, run);
}

/**
 * A10 notification level: `onSetRoomNotifState` sets Element's local echo (`RoomEchoChamber.notificationVolume`) and runs
 * the push rule writes as an echo transaction, whose status is the homeserver's answer. A failed transaction leaves the
 * echoed level shown (Element offers a retry); the bridge drops it (`setClient` re-reads the push rules and clears the
 * echo) so no level the homeserver does not hold stays visible. `Success` is checked against the server's push rules (read
 * again) and their computed level (`getRoomNotifsState`). On `network` (no answer in 15 s) the in-flight write is not stoppable and may still apply.
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
        // is not yet the homeserver's answer. `addPushRule` / `deletePushRule` do not reload `client.pushRules`: read the
        // server's rules (this sets it) and compare the level they compute for the room; only a mismatch fails.
        try {
            await client.getPushRules();
        } catch (e) {
            chamber.setClient(client);
            throw toActionError(e);
        }
        if (getRoomNotifsState(client, room.roomId) === level) return done(room.roomId);
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
