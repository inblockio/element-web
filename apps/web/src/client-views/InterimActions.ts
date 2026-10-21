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

import { type MatrixClient, MsgType } from "matrix-js-sdk/src/matrix";
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

/**
 * Sends a plain `m.text` the way `SendMessageComposer` does (`SendMessageComposer.tsx`, `sendMessage`):
 * `doMaybeLocalRoomAction` + `client.sendMessage`, then the `message_sent` dispatch. A local room (a new DM that has
 * no real room yet) is turned into the real one by `createRoomFromLocalRoom`, as `RoomView.onLocalRoomEvent` does
 * (RoomView is not mounted under a kit); the outcome then carries the real room id.
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

    try {
        let sentRoomId = roomId;
        const sent = doMaybeLocalRoomAction(
            roomId,
            (actualRoomId: string) => {
                sentRoomId = actualRoomId;
                return client.sendMessage(actualRoomId, null, content, opts.txnId);
            },
            client,
        );
        // As Element's composer: the event is queued, then `message_sent` goes out; the response is awaited below.
        defaultDispatcher.dispatch({ action: "message_sent" });
        if (isLocalRoom(roomId)) {
            const local = room as LocalRoom;
            // The dispatched `local_room_event` has no listener without a mounted RoomView; the creation runs here
            // (a no-op when RoomView already started it: it acts on a new local room only).
            const created = createRoomFromLocalRoom(client, local).then(() => {
                if (local.state === LocalRoomState.ERROR) {
                    throw new ClientViewActionError("failed", "the direct message could not be created");
                }
            });
            await Promise.race([sent, created.then(() => sent)]);
        }
        const response = await sent;
        return { status: "done", roomId: sentRoomId, eventId: response.event_id };
    } catch (e) {
        throw toActionError(e);
    }
}
