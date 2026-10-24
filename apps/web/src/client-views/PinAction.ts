/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

/*
 * M6 B2 pin / unpin: the action bar view-model's `onPinClick` (stock `PinningUtils.pinOrUnpinEvent`, which sends the room's
 * `m.room.pinned_events` list built from Element's own state). It toggles, so it is called only when the message's pin
 * state differs from the asked one. The outcome is read where the view-model leaves it: the returned promise is the
 * state write's answer (a failing read-pins account-data write is not part of it), and the room state (which arrives with
 * the sync) must show the change before `done`, also after an answer that may have hidden an accepted write. The pinned list
 * is rebuilt from the local state on every press, so calls for one room run one after the other: an overlapping press would
 * build its list from a state that does not hold the first one yet and drop it.
 */

import { MatrixError } from "matrix-js-sdk/src/matrix";

import { toActionError } from "./actions";
import { ROOM_ACTION_TIMEOUT_MS } from "./RoomActions";
import { type ActionOutcome, ClientViewActionError } from "./types";

/** What `setPinned` reads and does on one message. */
export interface PinTarget {
    /** `PinningUtils.isPinned`, read live. */
    pinned(): boolean;
    /** Element's rule for offering Pin (unpinned message) or Unpin (pinned message), read live. */
    canPin(): boolean;
    /** `EventTileActionBarViewModel.onPinClick`; rejects when the homeserver refuses. */
    press(): Promise<void>;
}

const pinQueue = new Map<string, Promise<unknown>>();

export function setPinned(
    roomId: string,
    target: PinTarget,
    on: boolean,
    isDisposed: () => boolean = () => false,
): Promise<ActionOutcome> {
    // Waits for the room's list to show the asked state; true when it did within `ms`.
    const shows = async (ms: number): Promise<boolean> => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
            if (target.pinned() === on) return true;
            await new Promise((r) => setTimeout(r, 50));
        }
        return target.pinned() === on;
    };
    const run = async (): Promise<ActionOutcome> => {
        // Before the press only: once a write may be on its way, a dispose does not end the wait (it would release the
        // room's queue onto a list that does not hold that write yet).
        if (isDisposed()) throw new ClientViewActionError("failed", "the bridge was disposed");
        if (!target.canPin()) throw new ClientViewActionError("forbidden", "Element offers no pin on this message");
        if (target.pinned() === on) return { status: "done", roomId };
        try {
            await target.press();
        } catch (e) {
            // The press is the state write (the paired read-pins account-data write is a side effect that never rejects
            // it, `PinningUtils.pinOrUnpinEvent`). A definite refusal (the homeserver answered with a 4xx, M_FORBIDDEN
            // among them) left nothing behind and stands at once. Any other error (a lost connection, a timeout, a 5xx)
            // can hide an accepted write that the list shows only with a later sync: the room's queue is held for the
            // same wait as after a resolved press, so the next pin builds on the landed list instead of replacing it.
            const error = toActionError(e);
            const status = e instanceof MatrixError ? (e.httpStatus ?? 0) : 0;
            if (error.code === "forbidden" || (status >= 400 && status < 500)) throw error;
        }
        if (await shows(ROOM_ACTION_TIMEOUT_MS)) return { status: "done", roomId };
        throw new ClientViewActionError(
            "network",
            "the room's pinned list did not show the change in time; it may still apply",
        );
    };
    const previous = pinQueue.get(roomId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.catch(() => undefined);
    pinQueue.set(roomId, tail);
    void tail.then(() => {
        if (pinQueue.get(roomId) === tail) pinQueue.delete(roomId);
    });
    return next;
}
