/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

/*
 * M6 B1 custom sections ("categories"): the room list item view-model's own actions, `RoomListItemViewModel.onToggleSection`
 * and `.onRemoveFromSection` (both `tagRoom`, i.e. the room tags `m.tag`), and Element's create-section dialog
 * (`RoomListStoreV3.createSection`, which both `onCreateSection` and the header's `createSection` wrap and whose result they
 * drop). The section list and the room's section are the item snapshot's `sections` (tag, name, `isSelected`). Same shape as
 * the A10 favourite: the view-model call is fire-and-forget, so `done` is read where it leaves its result, the room's own
 * tags (D21: the homeserver's answer arrives with the sync). The tags are opaque (`element.io.section.<uuid>`).
 */

import { type Room } from "matrix-js-sdk/src/matrix";

import { DefaultTagID } from "../stores/room-list-v3/skip-list/tag";
import { isCustomSectionTag } from "../stores/room-list-v3/section";
import RoomListStoreV3 from "../stores/room-list-v3/RoomListStoreV3";
import { toActionError } from "./actions";
import { dialogAction, openedDialog, ROOM_ACTION_TIMEOUT_MS } from "./RoomActions";
import { serialTagWrite } from "./RoomItemActions";
import { type ActionOutcome, ClientViewActionError } from "./types";

/** The part of `RoomListItemViewModel` a section action uses. */
export interface RoomSectionVm {
    getSnapshot(): {
        sections: Array<{ tag: string; name: string; isSelected: boolean }>;
        canChangeSection: boolean;
        notification: { invited?: boolean };
    };
    onToggleSection(tag: string): void;
    onRemoveFromSection(): void;
}

const POLL_MS = 50;

/** The room's custom section among the `known` ones, from its own room tags (what `tagRoom` writes). */
function sectionOf(room: Room, known: ReadonlySet<string>): string | undefined {
    return Object.keys(room.tags ?? {}).find((tag) => isCustomSectionTag(tag) && known.has(tag));
}

/**
 * Puts the room into the custom section `tag`, or out of its custom section with `null`. `onToggleSection` runs only when
 * the room's section differs (`tagRoom` toggles: a call for the section the room is in would take it out), and replaces a
 * favourite or another section in one go (Element's one-section rule); `onRemoveFromSection` only when the room is in a
 * custom section. `done` once the room's tags are as asked; if they are not within `ROOM_ACTION_TIMEOUT_MS` the answer is
 * `network` (a refusal shows Element's own error dialog and leaves the tags as they were; the write is not stoppable and may
 * still apply). Calls for one room run one after the other, also with a favourite call.
 */
export function setSection(item: RoomSectionVm, room: Room, tag: string | null): Promise<ActionOutcome> {
    const run = async (): Promise<ActionOutcome> => {
        const snap = item.getSnapshot();
        if (snap.notification.invited) throw new ClientViewActionError("unsupported", "an invite is in no section");
        if (room.tags?.[DefaultTagID.Archived])
            throw new ClientViewActionError("unsupported", "an archived room has no such action");
        if (!snap.canChangeSection) throw new ClientViewActionError("unsupported", "Element offers no section change");
        const known = new Set(snap.sections.map((s) => s.tag));
        if (tag !== null && !known.has(tag))
            throw new ClientViewActionError("unsupported", "the tag is not one of the custom sections");
        const target = tag ?? undefined;
        if (sectionOf(room, known) === target) return { status: "done", roomId: room.roomId };
        if (tag === null) item.onRemoveFromSection();
        else item.onToggleSection(tag);
        const until = Date.now() + ROOM_ACTION_TIMEOUT_MS;
        while (Date.now() < until) {
            if (sectionOf(room, known) === target) return { status: "done", roomId: room.roomId };
            await new Promise((r) => setTimeout(r, POLL_MS));
        }
        throw new ClientViewActionError("network", "the room's tags did not change in time; the write may still apply");
    };
    return serialTagWrite(room.roomId, run);
}

/**
 * Element's create-section dialog over the view (D17), the room preselected when given. The dialog's answer is read on the
 * way out (`openedDialog`): no name = `cancelled`. Confirmed, the store writes the section and tags the rooms the dialog
 * kept selected; `done` + `section` (the new tag) once that is through and, for the preselected room the dialog kept
 * selected, once the room's tags show the section. A preselected room the user deselected is not waited for.
 */
export function createSection(room: Room | undefined): Promise<ActionOutcome> {
    return dialogAction(async () => {
        let created: Promise<string | undefined> | undefined;
        const dialog = await openedDialog(() => {
            created = RoomListStoreV3.instance.createSection(room?.roomId);
        });
        const [name, roomsToTag] = await dialog.finished;
        if (!name) {
            await created?.catch(() => undefined);
            return { status: "cancelled" };
        }
        const tag = await within(created, ROOM_ACTION_TIMEOUT_MS);
        if (!tag) return { status: "cancelled" };
        const kept = !!room && Array.isArray(roomsToTag) && roomsToTag.includes(room.roomId);
        if (room && kept) {
            const until = Date.now() + ROOM_ACTION_TIMEOUT_MS;
            for (;;) {
                if (room.tags?.[tag]) break;
                if (Date.now() >= until)
                    throw new ClientViewActionError("network", "the room's tags did not show the new section in time");
                await new Promise((r) => setTimeout(r, POLL_MS));
            }
        }
        return { status: "done", section: tag, ...(room ? { roomId: room.roomId } : {}) };
    });
}

async function within<T>(p: Promise<T> | undefined, ms: number): Promise<T | undefined> {
    if (!p) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            p,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new ClientViewActionError("network", "the section was not written in time")),
                    ms,
                );
            }),
        ]);
    } catch (e) {
        throw toActionError(e);
    } finally {
        clearTimeout(timer);
    }
}
