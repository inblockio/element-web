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
 * homeserver's answer, and the room state (which arrives with the sync) must show the change before `done`. The pinned list
 * is rebuilt from the local state on every press, so calls for one room run one after the other: an overlapping press would
 * build its list from a state that does not hold the first one yet and drop it.
 */

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

/** How long a rejected press waits for the room's list to show the change before it is reported as failed. */
export const PIN_SETTLE_MS = 5000;

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
            if (isDisposed()) throw new ClientViewActionError("failed", "the bridge was disposed");
            await new Promise((r) => setTimeout(r, 50));
        }
        return target.pinned() === on;
    };
    const run = async (): Promise<ActionOutcome> => {
        if (!target.canPin()) throw new ClientViewActionError("forbidden", "Element offers no pin on this message");
        if (target.pinned() === on) return { status: "done", roomId };
        try {
            await target.press();
        } catch (e) {
            // The press sends the list and a paired account-data write and rejects when either fails, so the list may
            // have landed behind a rejection (a landed pin is reported landed, D21), and the next call in this room must
            // not build on a state that does not hold it yet. A definite refusal (M_FORBIDDEN) is not waited for.
            const error = toActionError(e);
            if (error.code === "forbidden" || !(await shows(PIN_SETTLE_MS))) throw error;
            return { status: "done", roomId };
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
