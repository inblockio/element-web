/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

/*
 * D16 interim actions: the ONE file where the client view bridge calls Element's own client or dispatcher because no
 * view-model carries the action yet. Each function names the view-model Element would ship (`AWAITS`); when it ships,
 * the bridge calls that view-model and the function is dropped. Nothing outside this file bypasses a view-model.
 * No view-model of our own is shaped here: these are plain functions over the client.
 */

import {
    ClientEvent,
    EventStatus,
    type MatrixClient,
    type MatrixEvent,
    MatrixError,
    MsgType,
} from "matrix-js-sdk/src/matrix";
import { type RoomMessageEventContent } from "matrix-js-sdk/src/types";

import defaultDispatcher from "../dispatcher/dispatcher";
import { type LocalRoom, LocalRoomState } from "../models/LocalRoom";
import { isLocalRoom } from "../utils/localRoom/isLocalRoom";
import { createRoomFromLocalRoom } from "../utils/direct-messages";
import { doMaybeLocalRoomAction } from "../utils/local-room";
import { toActionError } from "./actions";
import { type ActionOutcome, ClientViewActionError } from "./types";

/**
 * A1 send: a composer send view-model. Today `vm/composer` ships only `MessageComposerUrlPreviewViewModel`, which
 * decides link previews and sends nothing.
 */
export const AWAITS_SEND_TEXT =
    "a composer send view-model (vm/composer ships only MessageComposerUrlPreviewViewModel)";

function pendingEventsOf(client: MatrixClient, roomId: string): MatrixEvent[] {
    try {
        return client.getRoom(roomId)?.getPendingEvents() ?? [];
    } catch {
        return []; // a room that does not keep a detached pending list
    }
}

/**
 * Cancels the pending (NOT_SENT) event a failed `client.sendMessage` leaves behind: it would block every later send in
 * that room ("Event blocked by other events not yet sent") and is persisted across a reload.
 */
function cancelFailedPendingEvents(client: MatrixClient, roomId: string, txnId: string): void {
    try {
        // By transaction id only: a pending event restored from a reload is never ours.
        for (const ev of pendingEventsOf(client, roomId)) {
            if (ev.status === EventStatus.NOT_SENT && ev.getTxnId() === txnId) client.cancelPendingEvent(ev);
        }
    } catch {
        // best effort: the send error is what the caller needs to see
    }
}

// H4: every DM-creation failure maps to `failed`. `createRoomFromLocalRoom` swallows the cause (it only sets ERROR),
// so a `forbidden` or `network` cause cannot be told apart without changing a stock file; left as `failed` on purpose.
/**
 * Rejects (`failed`) when the local room is, or goes to, ERROR; never resolves otherwise. Listens on the client for
 * every caller, because `createRoomFromLocalRoom` acts on a NEW room only and emits the ERROR state once.
 */
function localRoomCreationFailure(
    client: MatrixClient,
    local: LocalRoom,
): { failed: Promise<never>; stop: () => void } {
    let stop = (): void => {};
    const failed = new Promise<never>((_, reject) => {
        const check = (): void => {
            if (local.state === LocalRoomState.ERROR) {
                reject(new ClientViewActionError("failed", "the direct message could not be created"));
            }
        };
        client.on(ClientEvent.Room, check);
        stop = () => {
            client.off(ClientEvent.Room, check);
        };
        check();
    });
    failed.catch(() => {});
    return { failed, stop };
}

/**
 * Sends a plain `m.text` the way `SendMessageComposer` does (`SendMessageComposer.tsx`, `sendMessage`):
 * `doMaybeLocalRoomAction` + `client.sendMessage`, then the `message_sent` dispatch. A local room (a new DM that has
 * no real room yet) is turned into the real one by `createRoomFromLocalRoom`, as `RoomView.onLocalRoomEvent` does
 * (RoomView is not mounted under a kit); the outcome then carries the real room id. Every caller waiting on a local
 * room rejects when its creation fails and takes its queued callback back, so a rejected text is never delivered
 * later; a send to a local room in ERROR retries the creation, as `RoomStatusBar.onRetryRoomCreationClick` does. A
 * failed `sendMessage` cancels the pending event it left, so the next send in the room goes out.
 */
export async function sendText(
    client: MatrixClient,
    roomId: string,
    text: string,
    opts: { txnId?: string; replyTo?: string } = {},
): Promise<ActionOutcome> {
    // AWAITS: see AWAITS_SEND_TEXT. Replies (A3) are not implemented in this path yet.
    if (opts.replyTo) throw new ClientViewActionError("unsupported", "replying is not supported yet");
    const room = client.getRoom(roomId);
    if (!room) throw new ClientViewActionError("unknown_room", `no room ${roomId}`);
    if (!text.trim()) throw new ClientViewActionError("failed", "an empty message is not sent");
    const content: RoomMessageEventContent = { msgtype: MsgType.Text, body: text };
    // Always our own transaction id: the cancel of a failed send finds exactly this pending event.
    const txnId = opts.txnId ?? client.makeTxnId();

    let queued: ((roomId: string) => void) | undefined;
    let stopWatching = (): void => {};
    const local = isLocalRoom(roomId) ? (room as LocalRoom) : undefined;
    try {
        let sentRoomId = roomId;
        // A room in ERROR is reset to NEW, which makes the creation below run again (Element's own retry).
        if (local?.isError) local.state = LocalRoomState.NEW;
        const known = new Set(local?.afterCreateCallbacks);
        const sent = doMaybeLocalRoomAction(
            roomId,
            async (actualRoomId: string) => {
                sentRoomId = actualRoomId;
                try {
                    return await client.sendMessage(actualRoomId, null, content, txnId);
                } catch (e) {
                    cancelFailedPendingEvents(client, actualRoomId, txnId);
                    throw e;
                }
            },
            client,
        );
        sent.catch(() => {});
        queued = local?.afterCreateCallbacks.find((cb) => !known.has(cb));
        // As Element's composer: the event is queued, then `message_sent` goes out; the response is awaited below.
        defaultDispatcher.dispatch({ action: "message_sent" });
        let response;
        if (local && queued) {
            // The dispatched `local_room_event` has no listener without a mounted RoomView; the creation runs here
            // (a no-op while another caller's creation is running: it acts on a new local room only).
            const { failed, stop } = localRoomCreationFailure(client, local);
            stopWatching = stop;
            const startsCreation = local.isNew; // only the caller that starts it may declare it failed
            const creation = Promise.resolve(createRoomFromLocalRoom(client, local))
                .catch(() => {})
                .then(() => {
                    // A creation that settles without CREATED (a guest `createRoom` gives no room id, and the stock
                    // handler throws past its own rejection handler) must not leave the room in CREATING for every waiter.
                    if (startsCreation && local.state === LocalRoomState.CREATING) {
                        local.state = LocalRoomState.ERROR;
                        client.emit(ClientEvent.Room, local);
                    }
                    if (local.state === LocalRoomState.ERROR) {
                        throw new ClientViewActionError("failed", "the direct message could not be created");
                    }
                    return new Promise<never>(() => {}); // creation done: the callback sends, `sent` settles the race
                });
            creation.catch(() => {});
            response = await Promise.race([sent, failed, creation]);
        } else {
            response = await sent;
        }
        return { status: "done", roomId: sentRoomId, eventId: response.event_id };
    } catch (e) {
        throw toActionError(e);
    } finally {
        stopWatching();
        if (local && queued) local.afterCreateCallbacks = local.afterCreateCallbacks.filter((cb) => cb !== queued);
    }
}

/**
 * A5 join / invite: a room preview and join view-model, and an invite view-model. Today the room list item snapshot only
 * flags `notification.invited`, and joining lives in `RoomView` (not mounted under a kit).
 */
export const AWAITS_JOIN =
    "a room preview and join view-model (the room view joins through RoomViewStore, not a view-model)";
export const AWAITS_INVITE = "an invite view-model (the room list item snapshot only flags notification.invited)";

/**
 * Joins a room by id or by `#alias:server` the way Element does (`client.joinRoom`), without `ViewRoom` (bridge
 * principle 4). An alias is resolved first (`getRoomIdForAlias`, whose servers become the join's `viaServers`). `done`
 * carries the joined room's id; M_NOT_FOUND and a malformed address are `unknown_room`, M_FORBIDDEN `forbidden`.
 */
export async function joinRoom(client: MatrixClient, roomIdOrAlias: string): Promise<ActionOutcome> {
    const target = roomIdOrAlias.trim();
    if (!target.startsWith("#") && !target.startsWith("!")) {
        throw new ClientViewActionError("unknown_room", `${target || "(empty)"} is not a room id or alias`);
    }
    try {
        let roomId = target;
        let viaServers: string[] | undefined;
        if (target.startsWith("#")) {
            const resolved = await client.getRoomIdForAlias(target);
            roomId = resolved.room_id;
            viaServers = resolved.servers?.slice(0, 3);
        }
        const room = await client.joinRoom(roomId, viaServers?.length ? { viaServers } : undefined);
        return { status: "done", roomId: room.roomId };
    } catch (e) {
        if (e instanceof MatrixError && (e.errcode === "M_NOT_FOUND" || e.errcode === "M_UNKNOWN_ROOM")) {
            throw new ClientViewActionError("unknown_room", e.message);
        }
        throw toActionError(e);
    }
}

/** Accepts an invite: the join of the invited room (AWAITS: see `AWAITS_INVITE`). */
export function acceptInvite(client: MatrixClient, roomId: string): Promise<ActionOutcome> {
    return joinRoom(client, roomId);
}

/** Declines an invite: `client.leave` on the invited room, as `RoomView` does (AWAITS: see `AWAITS_INVITE`). */
export async function declineInvite(client: MatrixClient, roomId: string): Promise<ActionOutcome> {
    if (!client.getRoom(roomId)) throw new ClientViewActionError("unknown_room", `no room ${roomId}`);
    try {
        await client.leave(roomId);
        return { status: "done", roomId };
    } catch (e) {
        throw toActionError(e);
    }
}
