/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

/*
 * A6 create a room / start a DM and A7 leave a room: the room list view-models' own actions (`RoomListViewModel.createRoom`
 * and `.createChatRoom`, `RoomListItemViewModel.onLeaveRoom`, D17). Each only dispatches an action that Element's
 * `MatrixChat` answers with its own dialog; the dialog is the one confirmation. The view-model does not hand the dialog's
 * result back, so the dialog is picked up the moment it opens (`openedDialog`) and its `finished` result decides
 * `cancelled` (the dialog's own answer, never a close while the work still runs) against going on to the effect: the
 * `ViewRoom` Element dispatches after a create, the membership that drops after a leave. No `ViewRoom` of our own.
 */

import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import Modal from "../Modal";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { type ActionPayload } from "../dispatcher/payloads";
import { type ViewRoomPayload } from "../dispatcher/payloads/ViewRoomPayload";
import { type AfterLeaveRoomPayload } from "../dispatcher/payloads/AfterLeaveRoomPayload";
import { toActionError } from "./actions";
import { type ActionOutcome, ClientViewActionError } from "./types";

/** How long the work after the user's confirmation may take before it counts as failed (contract principle 6). */
export const ROOM_ACTION_TIMEOUT_MS = 15_000;
/** After Element reports the leave done, how long the membership may take to show it (an error leaves it as it was). */
export const LEAVE_SETTLE_MS = 3_000;
/** How long Element's dialog may take to open after the view-model action. */
const DIALOG_OPEN_MS = 5_000;

interface DialogHandle {
    finished: Promise<unknown[]>;
}

let dialogActionRunning = false;

/** The dispatched payloads of one action, newest last, until `stop`. */
function recordPayloads(): {
    payloads: ActionPayload[];
    stop: () => void;
    wait: <T>(pick: (p: ActionPayload) => T | Error | undefined, ms: number) => Promise<T>;
} {
    const payloads: ActionPayload[] = [];
    const waiters = new Set<(p: ActionPayload) => void>();
    const token = defaultDispatcher.register((p) => {
        payloads.push(p);
        waiters.forEach((w) => w(p));
    });
    return {
        payloads,
        stop: () => defaultDispatcher.unregister(token),
        wait: <T>(pick: (p: ActionPayload) => T | Error | undefined, ms: number): Promise<T> =>
            new Promise<T>((resolve, reject) => {
                const timer = setTimeout(() => {
                    waiters.delete(check);
                    reject(new ClientViewActionError("failed", "Element did not finish the action in time"));
                }, ms);
                const check = (p: ActionPayload): void => {
                    const hit = pick(p);
                    if (hit === undefined) return;
                    clearTimeout(timer);
                    waiters.delete(check);
                    if (hit instanceof Error) reject(hit);
                    else resolve(hit);
                };
                waiters.add(check);
                // Payloads that arrived since the recording began count too.
                for (const p of payloads) check(p);
            }),
    };
}

/**
 * Runs `start` (a view-model action that makes `MatrixChat` open a dialog) and resolves with the handle of the first
 * dialog that opens, so the dialog's own result can be read. Only one such action runs at a time.
 */
function openedDialog(start: () => void): Promise<DialogHandle> {
    return new Promise<DialogHandle>((resolve, reject) => {
        // oxlint-disable-next-line typescript/unbound-method -- put back as it was; called with `Modal` as `this` below
        const original = Modal.createDialog;
        const ownBefore = Object.prototype.hasOwnProperty.call(Modal, "createDialog");
        let settled = false;
        const restore = (): void => {
            if (ownBefore) Modal.createDialog = original;
            else delete (Modal as { createDialog?: unknown }).createDialog;
        };
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            restore();
            reject(new ClientViewActionError("failed", "Element's dialog did not open"));
        }, DIALOG_OPEN_MS);
        // A pass-through wrapper: the dialog opens exactly as it would, its handle is read on the way out.
        Modal.createDialog = function (this: unknown, ...args: Parameters<typeof original>) {
            const handle = original.apply(Modal, args);
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                restore();
                resolve(handle);
            }
            return handle;
        };
        try {
            start();
        } catch (e) {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                restore();
                reject(e);
            }
        }
    });
}

async function dialogAction(run: () => Promise<ActionOutcome>): Promise<ActionOutcome> {
    if (dialogActionRunning) throw new ClientViewActionError("failed", "another Element dialog action is running");
    dialogActionRunning = true;
    try {
        return await run();
    } catch (e) {
        throw toActionError(e);
    } finally {
        dialogActionRunning = false;
    }
}

const isViewRoom = (p: ActionPayload): p is ViewRoomPayload => p.action === Action.ViewRoom;

/**
 * A6 create room: Element's create-room dialog. Confirmed, Element creates the room and dispatches `ViewRoom` with trigger
 * `Created` (`createRoom.ts`); its failure is an error dialog plus `JoinRoomError`. `done` + the new room's id on the
 * first, `failed` on the second or after 15 s, `cancelled` when the dialog closes without a create.
 */
export function createRoomViaDialog(start: () => void): Promise<ActionOutcome> {
    return dialogAction(async () => {
        const seen = recordPayloads();
        try {
            const dialog = await openedDialog(start);
            const [confirmed] = await dialog.finished;
            if (!confirmed) return { status: "cancelled" };
            const roomId = await seen.wait<string>((p) => {
                if (p.action === Action.JoinRoomError)
                    return new ClientViewActionError("failed", "Element could not create the room");
                return isViewRoom(p) && p.metricsTrigger === "Created" ? p.room_id : undefined;
            }, ROOM_ACTION_TIMEOUT_MS);
            return { status: "done", roomId };
        } finally {
            seen.stop();
        }
    });
}

/**
 * A6 start chat: Element's start-chat dialog (`InviteDialog`). Its "Go" has already dispatched the `ViewRoom` of the
 * chat when the dialog reports success: an existing DM (trigger `MessageUser`) or the local room of a new one
 * (`direct-messages.ts`; the first `sendText` turns it into the real room). `done` + that room id, `cancelled` when the
 * dialog closes without success, `failed` when it reports success but no room was shown.
 */
export function startChatViaDialog(start: () => void): Promise<ActionOutcome> {
    return dialogAction(async () => {
        const seen = recordPayloads();
        try {
            const dialog = await openedDialog(start);
            const [success] = await dialog.finished;
            if (!success) return { status: "cancelled" };
            const shown = [...seen.payloads].reverse().find(isViewRoom);
            if (!shown?.room_id) throw new ClientViewActionError("failed", "Element did not open the chat");
            return { status: "done", roomId: shown.room_id };
        } finally {
            seen.stop();
        }
    });
}

/**
 * A7 leave: Element's leave confirm (`MatrixChat.leaveRoom`). Confirmed, it leaves and dispatches `AfterLeaveRoom` (also
 * when the leave failed, after an error dialog), so the membership decides: `done` once it is no longer `join`,
 * `failed` if it still is a moment after, `cancelled` when the confirm says no.
 */
export function leaveViaDialog(client: MatrixClient, roomId: string, start: () => void): Promise<ActionOutcome> {
    return dialogAction(async () => {
        const seen = recordPayloads();
        try {
            const dialog = await openedDialog(start);
            const [confirmed] = await dialog.finished;
            if (!confirmed) return { status: "cancelled" };
            await seen.wait<true>(
                (p) =>
                    p.action === Action.AfterLeaveRoom && (p as AfterLeaveRoomPayload).room_id === roomId
                        ? true
                        : undefined,
                ROOM_ACTION_TIMEOUT_MS,
            );
            const left = (): boolean => client.getRoom(roomId)?.getMyMembership() !== "join";
            const until = Date.now() + LEAVE_SETTLE_MS;
            while (!left() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
            if (!left()) throw new ClientViewActionError("failed", "the room could not be left");
            return { status: "done", roomId };
        } finally {
            seen.stop();
        }
    });
}
