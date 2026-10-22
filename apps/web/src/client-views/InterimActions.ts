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
    EventType,
    type MatrixClient,
    type MatrixEvent,
    MsgType,
    RelationType,
    type Room,
    RoomMember,
} from "matrix-js-sdk/src/matrix";
import { type RoomMessageEventContent } from "matrix-js-sdk/src/types";

import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { canEditContent } from "../utils/EventUtils";
import { addReplyToMessageContent } from "../utils/Reply";
import { attachMentions, attachRelation } from "../utils/messages";
import { TimelineRenderingType } from "../contexts/RoomContext";
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

/** The message types editText replaces as plain text (the types `canEditContent` allows besides a poll). */
const EDITABLE_TEXT_MSGTYPES = new Set<string>([MsgType.Text, MsgType.Emote]);

/** A11 edit: an edit/composer view-model. Entry goes through the event tile's `onEditClick`; the send is Element's. */
export const AWAITS_EDIT_TEXT = "an edit/composer view-model (EventTileActionBarViewModel only opens the edit state)";
/** A12 delete: the event tile action bar's `onRemoveClick` (absent in v1.12.32; only EditHistoryActionBarViewModel forwards one). */
export const AWAITS_REDACT = "EventTileActionBarViewModel.onRemoveClick (not implemented in v1.12.32)";

function pendingEventsOf(client: MatrixClient, roomId: string): MatrixEvent[] {
    try {
        return client.getRoom(roomId)?.getPendingEvents() ?? [];
    } catch {
        return []; // a room that does not keep a detached pending list
    }
}

/**
 * Cancels the pending (NOT_SENT) event a failed `client.sendMessage` left behind: it would block every later send in
 * that room ("Event blocked by other events not yet sent") and is persisted across a reload. Also frees its transaction
 * id: the SDK keeps `Room.txnToEvent[txnId]` after a cancel (no public way to drop it), and a later send with the same
 * id would throw before any request. Called only for a transaction id that had no local echo before the send, so the
 * event found is this call's own and an echo that existed before is never touched.
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
    try {
        (client.getRoom(roomId) as unknown as { txnToEvent?: Map<string, MatrixEvent> } | null)?.txnToEvent?.delete(
            txnId,
        );
    } catch {
        // best effort
    }
}

/**
 * The event a message action targets: the loaded one of the room, else fetched from the homeserver. `unknown_event`
 * when it cannot be loaded (the action's client call is then not made).
 */
export async function loadEvent(client: MatrixClient, room: Room, eventId: string): Promise<MatrixEvent> {
    const loaded = room.findEventById(eventId);
    if (loaded) return loaded;
    try {
        const ev = client.getEventMapper()(await client.fetchRoomEvent(room.roomId, eventId));
        if (ev.getId() !== eventId || (ev.getRoomId() && ev.getRoomId() !== room.roomId))
            throw new Error("wrong event");
        return ev;
    } catch (e) {
        throw new ClientViewActionError("unknown_event", `event ${eventId} cannot be loaded: ${(e as Error).message}`);
    }
}

/** The event's sender as a member, so Element's mention rules (`replyToEvent.sender`) work on a fetched event. */
function withSender(room: Room, ev: MatrixEvent): MatrixEvent {
    const senderId = ev.getSender();
    if (!ev.sender && senderId) ev.sender = room.getMember(senderId) ?? new RoomMember(room.roomId, senderId);
    return ev;
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
    hooks: { onReplyTarget?: (target: MatrixEvent) => void } = {},
): Promise<ActionOutcome> {
    // AWAITS: see AWAITS_SEND_TEXT.
    const room = client.getRoom(roomId);
    if (!room) throw new ClientViewActionError("unknown_room", `no room ${roomId}`);
    if (!text.trim()) throw new ClientViewActionError("failed", "an empty message is not sent");
    // A3: the replied event is loaded first (`unknown_event` before anything is sent), the view-model entry follows.
    const replyTo = opts.replyTo ? withSender(room, await loadEvent(client, room, opts.replyTo)) : undefined;
    const content: RoomMessageEventContent = { msgtype: MsgType.Text, body: text };
    if (replyTo) {
        // As `createMessageContent` (SendMessageComposer): the mentions (the replied sender), then the reply relation.
        attachMentions(client.getSafeUserId(), content, null, replyTo);
        addReplyToMessageContent(content, replyTo);
        hooks.onReplyTarget?.(replyTo);
    }
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
                // A transaction id with a local echo already (a pending send, or a failed one restored from a reload) is
                // not ours to send over or cancel: refused before any request or echo of this call.
                if (client.getRoom(actualRoomId)?.getEventForTxnId(txnId)) {
                    throw new ClientViewActionError(
                        "failed",
                        `a message with transaction id ${txnId} is already pending`,
                    );
                }
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
        if (replyTo) {
            // The reply state goes with the queued message (SendMessageComposer clears it the same way).
            defaultDispatcher.dispatch({ action: "reply_to_event", event: null, context: TimelineRenderingType.Room });
        }
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
 * The own event of a message action, loaded (room timeline, else `fetchRoomEvent`). Only the user's own event:
 * `forbidden` for anyone else's, also for a user with redact power (bridge v2, addendum rule 2).
 */
async function loadOwnEvent(
    client: MatrixClient,
    roomId: string,
    eventId: string,
): Promise<{ room: Room; ev: MatrixEvent }> {
    const room = client.getRoom(roomId);
    if (!room) throw new ClientViewActionError("unknown_room", `no room ${roomId}`);
    const ev = await loadEvent(client, room, eventId);
    if (ev.getSender() !== client.getUserId()) {
        throw new ClientViewActionError("forbidden", "only the user's own message can be changed");
    }
    return { room, ev };
}

/**
 * A11 edit: the replacement event as Element's plain-text edit composer builds it (`createEditContent`, rules 3-6 of the
 * D20 addendum): `* text` as the outer body, `m.new_content` with the plain text and the ORIGINAL msgtype, `m.mentions`
 * through `attachMentions` (outer lists only new mentions), an existing link preview bundle copied onto
 * `m.new_content`, the `m.replace` relation. Own event only and only when `canEditContent` allows (else `forbidden`);
 * a blank text is `failed` and sends nothing; an earlier queued or unsent replacement of the event is cancelled first.
 * `onEnter` is the action bar view-model's `onEditClick` (the edit state), called once the edit is allowed. Resolves
 * with the ORIGINAL event id (the replacement's id is never a message id), once the homeserver has the replacement.
 */
export async function editText(
    client: MatrixClient,
    roomId: string,
    eventId: string,
    text: string,
    hooks: { onEnter?: (ev: MatrixEvent) => void } = {},
): Promise<ActionOutcome> {
    const { room, ev } = await loadOwnEvent(client, roomId, eventId);
    if (!canEditContent(client, ev)) throw new ClientViewActionError("forbidden", "this message cannot be edited");
    // Only a plain text message: canEditContent also allows an own poll, whose edit is Element's poll dialog, not a
    // text replacement (the replacement would turn the poll into text).
    if (ev.getType() !== EventType.RoomMessage || !EDITABLE_TEXT_MSGTYPES.has(ev.getOriginalContent().msgtype ?? "")) {
        throw new ClientViewActionError("forbidden", "only a text message can be edited");
    }
    if (!text.trim()) throw new ClientViewActionError("failed", "an empty edit is not sent");
    const original = ev.getOriginalContent();
    const newContent: Record<string, unknown> = { msgtype: original.msgtype, body: text };
    // The bundle on screen (a replacement's `m.new_content` once edited), as the edit composer restores it.
    const previews = ev.getContent()["com.beeper.linkpreviews"];
    if (previews !== undefined) newContent["com.beeper.linkpreviews"] = previews;
    const content: Record<string, unknown> = {
        "msgtype": original.msgtype,
        "body": `* ${text}`,
        "m.new_content": newContent,
    };
    const repliedTo = ev.replyEventId ? room.findEventById(ev.replyEventId) : undefined;
    attachMentions(
        client.getSafeUserId(),
        content,
        null,
        repliedTo ? withSender(room, repliedTo) : undefined,
        ev.getContent(),
    );
    attachRelation(content, { rel_type: RelationType.Replace, event_id: eventId });

    const previous = ev.replacingEvent();
    if (previous && (previous.status === EventStatus.QUEUED || previous.status === EventStatus.NOT_SENT)) {
        client.cancelPendingEvent(previous);
    }
    const txnId = client.makeTxnId();
    try {
        hooks.onEnter?.(ev);
        await client.sendMessage(roomId, ev.threadRootId ?? null, content as unknown as RoomMessageEventContent, txnId);
        defaultDispatcher.dispatch({ action: "message_sent" });
        return { status: "done", roomId, eventId };
    } catch (e) {
        cancelFailedPendingEvents(client, roomId, txnId);
        throw toActionError(e);
    } finally {
        // Element's edit state ends with the send (EditMessageComposer.endEdit).
        defaultDispatcher.dispatch({
            action: Action.EditEvent,
            event: null,
            timelineRenderingType: TimelineRenderingType.Room,
        });
    }
}

/**
 * A12 delete: redacts the user's own event with `client.redactEvent`, as Element's redact dialog does after its
 * confirmation (D20 addendum rule 6: no dialog here, the kit's own confirm came first). `done` when the call resolves;
 * a failed redaction cancels the local redaction it left, so the message does not look deleted.
 */
export async function redact(client: MatrixClient, roomId: string, eventId: string): Promise<ActionOutcome> {
    // AWAITS: see AWAITS_REDACT.
    const { ev } = await loadOwnEvent(client, roomId, eventId);
    // Our own transaction id, as editText: the failed redaction is found by it, whichever event object the SDK marked
    // (a fetched target is not in the room; an overlapping second redact is not the target's local redaction).
    const txnId = client.makeTxnId();
    try {
        await client.redactEvent(roomId, eventId, txnId);
        return { status: "done", roomId, eventId };
    } catch (e) {
        cancelFailedPendingEvents(client, roomId, txnId);
        try {
            // The SDK undoes the local redaction only on the unfiltered timeline set, not on a thread's: unmark the
            // target if the failed redaction of this call is still what marks it.
            const local = ev.localRedactionEvent();
            if (local && local.getTxnId() === txnId) {
                // a room that keeps no detached pending list: the redaction is still pending
                if (local.status === EventStatus.NOT_SENT) client.cancelPendingEvent(local);
                ev.unmarkLocallyRedacted();
            }
        } catch {
            // best effort: the redaction error is what the caller needs to see
        }
        throw toActionError(e);
    }
}
