/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

/*
 * M13 U6 quick reaction: the composer's `+:emoji:` the way Element runs it, on the host. The target is chosen here, over
 * the room's live timeline, never over what the kit shows: the kit may hold a newer message Element's list does not
 * count (or the reverse), and an undecryptable newest message is a target in stock Element (js-sdk gives a failed
 * decrypt the type `m.room.message`, `m.bad.encrypted`; a decrypt still pending is `m.room.encrypted` and is skipped).
 *
 * MIRROR of `SendMessageComposer.sendQuickReaction` (components/views/rooms/SendMessageComposer.tsx, the private method
 * of that name, ~:311-345; called on `isQuickReaction`, ~:431-433). That method is private to a mounted React class
 * (`this.context.liveTimeline`, `this.props.room`), so it cannot be called without a composer; the file is not edited
 * (upstream conflict surface). Parity is the point: no status filter, no key normalisation, no kit-side selection.
 * Re-check this mirror on every Element bump. Differences, all deliberate: the send is awaited (stock fires and
 * forgets), a refused send's pending echo is cancelled (stock's RoomView offers cancel/resend, the kit has none), and
 * the composer-only `message_sent` dispatch is dropped (the kit composer does its own clearing).
 */

import { EventType, RelationType, type MatrixClient, type MatrixEvent } from "matrix-js-sdk/src/matrix";

import { toActionError } from "./actions";
import { cancelFailedPendingEvents } from "./InterimActions";
import { type ActionOutcome, ClientViewActionError } from "./types";

export async function quickReact(client: MatrixClient, roomId: string, key: string): Promise<ActionOutcome> {
    const room = client.getRoom(roomId);
    if (!room) throw new ClientViewActionError("unknown_room", `unknown room ${roomId}`);
    const events = room.getLiveTimeline().getEvents();
    // Stock: the newest event of type m.room.message, whatever else it is (own, redacted, a local echo, a failed decrypt).
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].getType() !== EventType.RoomMessage) continue;
        const target = events[i];
        const eventId = target.getId()!;
        const userId = client.getSafeUserId();
        const reactions = room.relations.getChildEventsForEvent(eventId, RelationType.Annotation, EventType.Reaction);
        // If the user already sent this reaction, neither redact nor re-send (it never toggles off).
        if (reactions) {
            const mine = reactions.getAnnotationsBySender()?.[userId] || new Set<MatrixEvent>();
            const keys = [...mine].filter((e) => !e.isRedacted()).map((e) => e.getRelation()?.key);
            if (keys.includes(key)) return { status: "done", roomId, eventId };
        }
        // A refused send leaves a NOT_SENT echo (it blocks the room's later sends and counts as "already reacted" for a
        // retry); the kit replaces RoomView, so no unsent-messages bar can cancel it. The bridge cancels it as it does for
        // text and forwards (`cancelFailedPendingEvents`, by this call's own transaction id).
        const txnId = client.makeTxnId();
        try {
            await client.sendEvent(
                roomId,
                EventType.Reaction,
                { "m.relates_to": { rel_type: RelationType.Annotation, event_id: eventId, key } },
                txnId,
            );
        } catch (e) {
            cancelFailedPendingEvents(client, roomId, txnId);
            throw toActionError(e);
        }
        return { status: "done", roomId, eventId };
    }
    // No message in the room: nothing to react to (stock does nothing).
    return { status: "done", roomId };
}
