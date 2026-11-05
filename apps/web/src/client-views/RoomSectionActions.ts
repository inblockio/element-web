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
import SettingsStore from "../settings/SettingsStore";
import { toActionError } from "./actions";
import { DM_LOCK_CAP_MS, dialogAction, openedDialog, ROOM_ACTION_TIMEOUT_MS } from "./RoomActions";
import {
    assertSingleSection,
    awaitLateLanding,
    noteUnsettledTagWrite,
    sectionTagsOf,
    serialTagWrite,
} from "./RoomItemActions";
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

/**
 * The custom sections as the account data holds them right now (D21: the backend is the truth). Once the store's write has
 * settled, Element's local echo (`LocalEchoWrapper`) has expired, so this is the stored value, also when the PUT was refused:
 * the wrapper swallows the refusal and the store's promise still fulfils.
 */
function storedSections(): Record<string, { name?: unknown } | undefined> {
    const raw: unknown = SettingsStore.getValue("RoomList.CustomSectionData");
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, { name?: unknown } | undefined>)
        : {};
}

/** The room's custom section among the `known` ones, from its own room tags (what `tagRoom` writes). */
function sectionOf(room: Room, known: ReadonlySet<string>): string | undefined {
    return Object.keys(room.tags ?? {}).find((tag) => isCustomSectionTag(tag) && known.has(tag));
}

/**
 * Puts the room into the custom section `tag`, or out of its custom section with `null`. `onToggleSection` runs only when
 * the room's section differs (`tagRoom` toggles: a call for the section the room is in would take it out), and replaces a
 * favourite or another section in one go (Element's one-section rule); `onRemoveFromSection` only when the room is in a
 * custom section. `done` once the room's tags are as asked, for a section that is the room's only section tag (`tagRoom`'s
 * remove and add are two writes: with the add through and the favourite's delete refused, or not yet synced, the room is
 * still a favourite); if they are not within `ROOM_ACTION_TIMEOUT_MS` the answer is `network` (a refusal shows Element's
 * own error dialog and leaves the tags as they were; the write is not stoppable and may still apply, and the next call for
 * the room waits a moment for that, `awaitLateLanding`). A room that holds several section tags (a favourite and a
 * category, made elsewhere) is `unsupported` for every target, nothing written (`assertSingleSection`). Calls for one room run one after the other, also with a
 * favourite call and a create.
 */
export function setSection(item: RoomSectionVm, room: Room, tag: string | null): Promise<ActionOutcome> {
    const run = async (): Promise<ActionOutcome> => {
        await awaitLateLanding(room);
        const snap = item.getSnapshot();
        if (snap.notification.invited) throw new ClientViewActionError("unsupported", "an invite is in no section");
        if (room.tags?.[DefaultTagID.Archived])
            throw new ClientViewActionError("unsupported", "an archived room has no such action");
        if (!snap.canChangeSection) throw new ClientViewActionError("unsupported", "Element offers no section change");
        const known = new Set(snap.sections.map((s) => s.tag));
        if (tag !== null && !known.has(tag))
            throw new ClientViewActionError("unsupported", "the tag is not one of the custom sections");
        // A room in several sections is read-only here: `tagRoom` toggles on its first tag, whatever order they are in.
        assertSingleSection(room);
        // The state asked for: only that section tag (the toggle replaces the favourite or another section), or no known
        // custom section (a favourite or low priority room stays one).
        const asked = (): boolean => {
            const now = sectionTagsOf(room);
            return tag === null ? !sectionOf(room, known) : now.length === 1 && now[0] === tag;
        };
        if (asked()) return { status: "done", roomId: room.roomId };
        if (tag === null) item.onRemoveFromSection();
        else item.onToggleSection(tag);
        const until = Date.now() + ROOM_ACTION_TIMEOUT_MS;
        while (Date.now() < until) {
            if (asked()) return { status: "done", roomId: room.roomId };
            await new Promise((r) => setTimeout(r, POLL_MS));
        }
        noteUnsettledTagWrite(room);
        throw new ClientViewActionError("network", "the room's tags did not change in time; the write may still apply");
    };
    return serialTagWrite(room.roomId, run);
}

/**
 * Element's create-section dialog over the view (D17), the room preselected when given. The dialog's answer is read on the
 * way out (`openedDialog`): no name = `cancelled`. Confirmed, the store writes the section and tags the rooms the dialog
 * kept selected; `done` + `section` (the new tag) once that is through and, for the preselected room the dialog kept
 * selected, once the room's tags show the section (then with `roomId`). If they do not within `ROOM_ACTION_TIMEOUT_MS` the
 * section exists all the same: `done` + `section` without `roomId` (a retry would create a second section; the room's own
 * section is in `rooms()`, and the next tag call for the room waits for a late landing). A preselected room the user
 * deselected is not waited for; other rooms the dialog selected are tagged by Element outside the room queue and not waited
 * for. A room holding several section tags is `unsupported` before the dialog opens.
 */
export function createSection(room: Room | undefined): Promise<ActionOutcome> {
    // The store tags the room with a plain `tagRoom` once the dialog is confirmed: with a room, the whole dialog takes its
    // turn in the room's tag queue, so no earlier write is in flight when it does and none starts before it is through.
    return room ? serialTagWrite(room.roomId, () => createSectionNow(room)) : createSectionNow(undefined);
}

function createSectionNow(room: Room | undefined): Promise<ActionOutcome> {
    return dialogAction(async () => {
        if (room) {
            await awaitLateLanding(room);
            assertSingleSection(room);
        }
        let created: Promise<string | undefined> | undefined;
        const dialog = await openedDialog(() => {
            created = RoomListStoreV3.instance.createSection(room?.roomId);
        });
        const [name, roomsToTag] = await dialog.finished;
        if (!name) {
            // A dropped dialog never settles the store's promise (Modal.tsx's wipe): bound the wait, or the dialog lock and the room queue hang.
            await within(created, ROOM_ACTION_TIMEOUT_MS).catch(() => undefined);
            return { status: "cancelled" };
        }
        const tag = await within(created, ROOM_ACTION_TIMEOUT_MS);
        if (!tag) return { status: "cancelled" };
        const kept = !!room && Array.isArray(roomsToTag) && roomsToTag.includes(room.roomId);
        if (room && kept) {
            const until = Date.now() + ROOM_ACTION_TIMEOUT_MS;
            for (;;) {
                // Only the new section: an older section or the favourite the tag replaces may still be on the room.
                const held = sectionTagsOf(room);
                if (held.length === 1 && held[0] === tag) break;
                if (Date.now() >= until) {
                    // The section is stored by now: answer with it (a retry would create a second one) but without the
                    // room, which is not in it yet. The kit reads the room's own section from `rooms()`.
                    noteUnsettledTagWrite(room);
                    return { status: "done", section: tag };
                }
                await new Promise((r) => setTimeout(r, POLL_MS));
            }
        }
        return { status: "done", section: tag, ...(room ? { roomId: room.roomId } : {}) };
    });
}

/**
 * W2: Element's section dialog in edit mode over the view (D17), `RoomListStoreV3.editSection(tag)`: the name step, then the
 * rooms step. The answer is read from the dialog's result on the way out (`openedDialog`, grok D4): no name (closed at the name
 * step) = `cancelled`; any returned name = `done` + `section` (the tag), also an unchanged name with room changes (Element
 * applies the tag changes, `section.ts`) and a cancel at the rooms step, which still commits the rename (F3). `done` once the
 * store has written (its promise settled) and the stored section carries the name (re-read from `RoomList.CustomSectionData`,
 * D21: a refused account-data write leaves the old name and is `failed`, the store's promise fulfils all the same); if the
 * store has not settled within `ROOM_ACTION_TIMEOUT_MS` the answer is `network` (the write may still apply). The rooms the
 * dialog tags or untags are written by Element outside the room queue and not waited for. The caller has checked that `tag`
 * is listed (the store opens no dialog for a tag it does not hold).
 */
export function editSection(tag: string): Promise<ActionOutcome> {
    return dialogAction(async () => {
        let edited: Promise<void> | undefined;
        const dialog = await openedDialog(() => {
            edited = RoomListStoreV3.instance.editSection(tag);
        });
        const [name] = await dialog.finished;
        if (!name) {
            // A dropped dialog never settles the store's promise (Modal.tsx's wipe): bound the wait, or the dialog lock hangs.
            await within(edited, ROOM_ACTION_TIMEOUT_MS).catch(() => undefined);
            return { status: "cancelled" };
        }
        await within(edited, ROOM_ACTION_TIMEOUT_MS);
        if (storedSections()[tag]?.name !== name)
            throw new ClientViewActionError("failed", "the section was not renamed in the account data");
        return { status: "done", section: tag };
    });
}

/**
 * W3: Element's remove-section confirmation over the view (D17), `RoomListStoreV3.removeSection(tag, isEmpty)`; `isEmpty` is
 * the caller's (no bridged room is in the section). Declined (or the dialog closed) = `cancelled`. Confirmed, the store drops
 * the section from the settings (its rooms keep their tag, F3, and fall back to the default group in `rooms()`); `done` +
 * `section` once the store has settled, the stored `RoomList.CustomSectionData` no longer holds the tag (re-read, D21: a
 * refused account-data write leaves it there and is `failed`, the store's promise fulfils all the same) and `listed()` (the
 * bridge's `sections()`) no longer holds it. If the store has not settled, or the section is still listed, within
 * `ROOM_ACTION_TIMEOUT_MS` the answer is `network` (the write may still apply).
 */
export function removeSection(tag: string, isEmpty: boolean, listed: () => boolean): Promise<ActionOutcome> {
    return dialogAction(async () => {
        let removed: Promise<void> | undefined;
        const dialog = await openedDialog(() => {
            removed = RoomListStoreV3.instance.removeSection(tag, isEmpty);
        });
        const [confirmed] = await dialog.finished;
        if (!confirmed) {
            await within(removed, ROOM_ACTION_TIMEOUT_MS).catch(() => undefined);
            return { status: "cancelled" };
        }
        const until = Date.now() + ROOM_ACTION_TIMEOUT_MS;
        await within(removed, ROOM_ACTION_TIMEOUT_MS);
        if (storedSections()[tag])
            throw new ClientViewActionError("failed", "the section was not removed from the account data");
        while (listed()) {
            if (Date.now() >= until)
                throw new ClientViewActionError("network", "the section was still listed after it was removed");
            await new Promise((r) => setTimeout(r, POLL_MS));
        }
        return { status: "done", section: tag };
    });
}

/**
 * `RoomList.OrderedCustomSections` as the account data holds it right now (D21). Once the store's write has settled,
 * Element's local echo has expired, so this is the stored value, also when the PUT was refused (the wrapper swallows the
 * refusal and the store's promise still fulfils). It also holds the `chats` and `People` tags between the customs.
 */
function storedOrder(): string[] {
    const raw: unknown = SettingsStore.getValue("RoomList.OrderedCustomSections");
    return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
}

/** `tag` is on the `direction` side of `neighbour` in `order` (both present). */
function isMoved(order: readonly string[], tag: string, neighbour: string, direction: "up" | "down"): boolean {
    const at = order.indexOf(tag);
    const next = order.indexOf(neighbour);
    return at !== -1 && next !== -1 && (direction === "up" ? at < next : at > next);
}

/**
 * Y3: moves the custom section `tag` one place up or down among the custom sections, as Element's own drag does
 * (`RoomListViewModel.changeSectionOrder` -> `RoomListStoreV3.reorderSection(tag, neighbour)`, not a dialog). `order` is the
 * bridge's `sections()` as tags (customs only), read when the call takes the dialog lock. It runs inside `dialogAction`,
 * the one lock of every section-list write (create / edit / remove / move), so a second section write during a move
 * answers the busy `failed` instead of building its PUT from a `im.vector.web.settings` clone the move is about to
 * replace. `failed` at once for a tag it does not list and for the first / last custom
 * (no neighbour in that direction). `done` + `section` once the stored `RoomList.OrderedCustomSections` AND `order()` both
 * show `tag` on the neighbour's side (D21: a refused account-data write is swallowed by the store, only the re-read tells).
 * Codes (orchestrator ruling, card note N10, as M10 `removeSection` for the same kinds): `failed` for an unknown tag, no
 * neighbour and a refused write (the stored order did not change); `network` for a store that has not settled within
 * `ROOM_ACTION_TIMEOUT_MS` and for `sections()` still lagging after it (the write may still apply). On the store timeout the
 * caller gets `network` but the lock stays held until `reorderSection` settles, at most `DM_LOCK_CAP_MS` (the PUT is still
 * in flight: another section write or move meanwhile could be overwritten by it, last PUT wins); a late rejection is
 * swallowed (the caller has its answer). Only the relative order of the
 * customs moves: Element keeps `chats` and `People` in the same stored order and the move may jump over them (LIMIT).
 */
export function moveSection(
    tag: string,
    direction: "up" | "down",
    order: () => readonly string[],
): Promise<ActionOutcome> {
    return dialogAction(async (holdLock) => {
        const listed = order();
        const at = listed.indexOf(tag);
        const neighbour = at === -1 ? undefined : listed[direction === "up" ? at - 1 : at + 1];
        if (neighbour === undefined) {
            throw new ClientViewActionError(
                "failed",
                at === -1
                    ? `${tag} is not one of the sections`
                    : `${tag} is the ${direction === "up" ? "first" : "last"} section`,
            );
        }
        const until = Date.now() + ROOM_ACTION_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const store = RoomListStoreV3.instance.reorderSection(tag, neighbour);
            const written = await Promise.race([
                store.then(() => true),
                new Promise<false>((resolve) => {
                    timer = setTimeout(() => resolve(false), ROOM_ACTION_TIMEOUT_MS);
                }),
            ]);
            if (!written) {
                // The write is still in flight: keep the section lock until it settles (a rejection then is swallowed).
                holdLock(store, DM_LOCK_CAP_MS);
                throw new ClientViewActionError("network", "the section order was not written in time");
            }
        } catch (e) {
            throw toActionError(e);
        } finally {
            clearTimeout(timer);
        }
        if (!isMoved(storedOrder(), tag, neighbour, direction))
            throw new ClientViewActionError("failed", "the section order was not changed in the account data");
        while (!isMoved(order(), tag, neighbour, direction)) {
            if (Date.now() >= until)
                throw new ClientViewActionError("network", "the sections were not reordered after the move");
            await new Promise((r) => setTimeout(r, POLL_MS));
        }
        return { status: "done", section: tag };
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
