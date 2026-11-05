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

import { EventStatus, KnownMembership, type MatrixClient } from "matrix-js-sdk/src/matrix";

import Modal, { ModalManagerEvent } from "../Modal";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { type ActionPayload } from "../dispatcher/payloads";
import { type ViewRoomPayload } from "../dispatcher/payloads/ViewRoomPayload";
import { type AfterLeaveRoomPayload } from "../dispatcher/payloads/AfterLeaveRoomPayload";
import { isLocalRoom } from "../utils/localRoom/isLocalRoom";
import { DirectoryMember, startDmOnFirstMessage } from "../utils/direct-messages";
import { toActionError } from "./actions";
import { type ActionOutcome, ClientViewActionError } from "./types";

/** How long the work after the user's confirmation may take before it counts as failed (contract principle 6). */
export const ROOM_ACTION_TIMEOUT_MS = 15_000;
/** After Element reports the leave done, how long the membership may take to show it (an error leaves it as it was). */
export const LEAVE_SETTLE_MS = 3_000;
/** How long Element may take to show the chat once its dialog reported success. */
const CHAT_SHOWN_MS = 5_000;
/** How long Element's dialog may take to open after the view-model action. */
const DIALOG_OPEN_MS = 5_000;

export interface DialogHandle {
    finished: Promise<unknown[]>;
    /** A dialog that took this one's place on the stack (Element's static modals overwrite each other), if any. */
    replacedBy?: () => object | undefined;
}

/** Who holds the dialog lock now (a token per action, so a late release never frees a later holder's lock). */
let dialogLock: object | undefined;

/** Keeps the dialog lock past the action's own answer until `until` settles, at most `capMs` (see `dialogAction`). */
type HoldLock = (until: Promise<unknown>, capMs: number) => void;

/** The dialogs Element's modal manager holds now (its private lists; `ModalManager` offers no query for one dialog). */
function modalStack(): Set<object> {
    const m = Modal as unknown as { modals?: object[]; priorityModal?: object | null; staticModal?: object | null };
    return new Set([...(m.modals ?? []), m.priorityModal, m.staticModal].filter((x): x is object => !!x));
}

/**
 * The result of `handle`, or `[]` (closed without an answer) once its dialog has left the modal stack without it:
 * Modal.tsx wipes `modals` on a priority or static close without resolving the dropped dialogs' `finished`.
 */
function finishedOrDropped(handle: DialogHandle, mine: object | undefined): Promise<unknown[]> {
    if (!mine) return handle.finished;
    return new Promise<unknown[]>((resolve, reject) => {
        let dropped: ReturnType<typeof setTimeout> | undefined;
        const release = (): void => {
            clearTimeout(dropped);
            Modal.off(ModalManagerEvent.Closed, check);
            Modal.off(ModalManagerEvent.Opened, check);
        };
        const check = (): void => {
            if (modalStack().has(mine) || dropped !== undefined) return;
            // Modal.tsx resolves `finished` and then emits Closed on one stack: one macrotask lets that answer win over the drop.
            dropped = setTimeout(() => (release(), resolve([])), 0);
        };
        Modal.on(ModalManagerEvent.Closed, check);
        Modal.on(ModalManagerEvent.Opened, check);
        handle.finished.then(
            (r) => (release(), resolve(r)),
            (e) => (release(), reject(e)),
        );
    });
}

/** Resolves once `modal` is no longer in Element's modal stack (closed, or another dialog took its place). */
function leftStack(modal: object): Promise<void> {
    return new Promise<void>((resolve) => {
        const check = (): void => {
            if (modalStack().has(modal)) return;
            Modal.off(ModalManagerEvent.Closed, check);
            Modal.off(ModalManagerEvent.Opened, check);
            resolve();
        };
        Modal.on(ModalManagerEvent.Closed, check);
        Modal.on(ModalManagerEvent.Opened, check);
        check();
    });
}

/** The dispatched payloads of one action, newest last, until `stop`. */
export function recordPayloads(): {
    payloads: ActionPayload[];
    stop: () => void;
    wait: <T>(
        pick: (p: ActionPayload) => T | Error | undefined,
        ms: number,
        since?: number,
        signal?: AbortSignal,
    ) => Promise<T>;
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
        wait: <T>(
            pick: (p: ActionPayload) => T | Error | undefined,
            ms: number,
            since = 0,
            signal?: AbortSignal,
        ): Promise<T> =>
            new Promise<T>((resolve, reject) => {
                const timer = setTimeout(() => {
                    waiters.delete(check);
                    reject(new ClientViewActionError("failed", "Element did not finish the action in time"));
                }, ms);
                // An abort drops the timer and the waiter (the caller no longer needs the answer) and rejects, unheard.
                signal?.addEventListener("abort", () => {
                    clearTimeout(timer);
                    waiters.delete(check);
                    reject(new ClientViewActionError("failed", "The wait was stopped"));
                });
                const check = (p: ActionPayload): void => {
                    const hit = pick(p);
                    if (hit === undefined) return;
                    clearTimeout(timer);
                    waiters.delete(check);
                    if (hit instanceof Error) reject(hit);
                    else resolve(hit);
                };
                waiters.add(check);
                // Payloads that arrived since `since` (default: since the recording began) count too.
                for (const p of payloads.slice(since)) check(p);
            }),
    };
}

/**
 * Runs `start` (a view-model action that makes `MatrixChat` open a dialog) and resolves with the handle of the first
 * dialog that opens, so the dialog's own result can be read. Only one such action runs at a time. `onOpened` runs right
 * after the dialog opened (before any later dispatch), `onFinished` once its result is in.
 */
export function openedDialog(start: () => void, onFinished?: () => void, onOpened?: () => void): Promise<DialogHandle> {
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
            const stackBefore = modalStack();
            const handle = original.apply(Modal, args);
            if (!settled) {
                // The mark of this dialog's opening: what the caller records after it belongs to the dialog.
                onOpened?.();
                const mine = [...modalStack()].find((m) => !stackBefore.has(m));
                // Registered before the caller of `createDialog` can await the result, so it runs before whatever Element
                // does after the answer: the mark it takes separates what came before the answer from what follows.
                if (onFinished) void Promise.resolve(handle.finished).then(onFinished, () => {});
                settled = true;
                clearTimeout(timer);
                restore();
                resolve({
                    finished: finishedOrDropped(handle, mine),
                    replacedBy: () => [...modalStack()].find((m) => m !== mine && !stackBefore.has(m)),
                });
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

export async function dialogAction(run: (holdLock: HoldLock) => Promise<ActionOutcome>): Promise<ActionOutcome> {
    if (dialogLock) throw new ClientViewActionError("failed", "another Element dialog action is running");
    const token = {};
    dialogLock = token;
    const release = (): void => {
        if (dialogLock === token) dialogLock = undefined;
    };
    // `run` may keep the lock past its answer (`holdLock`): the work it started is still running in Element, and another
    // dialog action must not overlap it. The hold ends when that work settles or at the cap, whichever is first.
    let returned = false;
    let held = false;
    let holdOver = true;
    const holdLock: HoldLock = (until, capMs) => {
        if (held) return;
        held = true;
        holdOver = false;
        let cap: ReturnType<typeof setTimeout> | undefined;
        const end = (): void => {
            holdOver = true;
            clearTimeout(cap);
            if (returned) release();
        };
        cap = setTimeout(end, capMs);
        until.then(end, end);
    };
    try {
        return await run(holdLock);
    } catch (e) {
        throw toActionError(e);
    } finally {
        returned = true;
        if (holdOver) release();
    }
}

const isViewRoom = (p: ActionPayload): p is ViewRoomPayload => p.action === Action.ViewRoom;

/**
 * The `ViewRoom` that the start-chat dialog's Go dispatches (`startDmOnFirstMessage`, `startDm`): an existing DM
 * (trigger `MessageUser`), the room `startDm` makes for a single 3rd-party invite in an encrypted-by-default setup (trigger
 * `Created`, a real room id), or the new chat's local room, which carries the `targets`. Any other `ViewRoom` (a notification
 * click, an answered call) is not the chat.
 */
const isChatViewRoom = (p: ActionPayload): p is ViewRoomPayload =>
    isViewRoom(p) &&
    (p.metricsTrigger === "MessageUser" ||
        p.metricsTrigger === "Created" ||
        (isLocalRoom(p.room_id) && (p as { targets?: unknown }).targets !== undefined));

/**
 * A6 create room: Element's create-room dialog. Confirmed, Element creates the room and dispatches `ViewRoom` with trigger
 * `Created` (`createRoom.ts`); its failure is an error dialog plus `JoinRoomError`. `done` + the new room's id on the
 * first, `failed` on the second or after 15 s, `cancelled` when the dialog closes without a create.
 */
export function createRoomViaDialog(start: () => void): Promise<ActionOutcome> {
    return dialogAction(async () => {
        const seen = recordPayloads();
        // Only what follows the confirmation belongs to the create: an earlier ViewRoom or a failed join of another room
        // (a notification click, an answered call) is not its result.
        let confirmedAt = 0;
        try {
            const dialog = await openedDialog(start, () => (confirmedAt = seen.payloads.length));
            const [confirmed] = await dialog.finished;
            if (!confirmed) return { status: "cancelled" };
            const roomId = await seen.wait<string>(
                (p) => {
                    // createRoom's own failure carries no `err`; RoomViewStore's (a failed join of some other room, which
                    // may be in flight while this create runs) does, and is not this create's result.
                    if (p.action === Action.JoinRoomError && (p as { err?: unknown }).err === undefined)
                        return new ClientViewActionError("failed", "Element could not create the room");
                    return isViewRoom(p) && p.metricsTrigger === "Created" ? p.room_id : undefined;
                },
                ROOM_ACTION_TIMEOUT_MS,
                confirmedAt,
            );
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
 * dialog closes without success, `failed` when it reports success but no room is shown within 5 s.
 */
export function startChatViaDialog(start: () => void): Promise<ActionOutcome> {
    return dialogAction(async () => {
        const seen = recordPayloads();
        try {
            const dialog = await openedDialog(start);
            const [success] = await dialog.finished;
            if (!success) return { status: "cancelled" };
            // Element dispatches asynchronously, so the chat's `ViewRoom` may follow the dialog's answer by a tick.
            const roomId = await seen.wait<string>((p) => (isChatViewRoom(p) ? p.room_id : undefined), CHAT_SHOWN_MS);
            return { status: "done", roomId };
        } finally {
            seen.stop();
        }
    });
}

/** A Matrix user id: `@localpart:server`, no whitespace (the shape Element's own invite dialog accepts as a user id). */
const MATRIX_USER_ID = /^@[^\s:]+:\S+$/;

/** How long a start that has not settled may keep the dialog lock after the caller was answered `failed`. */
export const DM_LOCK_CAP_MS = 60_000;

/**
 * M12 Z2 the display name and avatar (mxc) that Element's client already holds for a user, for the `DirectoryMember` of a new
 * DM. Stock hands both over (`UserInfoBasicOptionsViewModel.onOpenDmForUser`: `rawDisplayName` + the member's or user's
 * avatar); `createDmLocalRoom` titles the local room from them, so a member without a name titles the chat with the user id
 * until the first send. "Reply directly" is only offered on another sender's message, so the user is a joined member of a room
 * we share (the first one that names them), else the client's own `User` (a profile it was told of). Nothing known gives `{}`
 * and the id stays the title. No server call: only what the client holds.
 */
export function knownProfile(client: MatrixClient, userId: string): { display_name?: string; avatar_url?: string } {
    let avatar: string | undefined;
    for (const room of client.getRooms()) {
        const member = room.getMember(userId);
        if (member?.membership !== KnownMembership.Join) continue;
        const memberAvatar = member.getMxcAvatarUrl() ?? undefined;
        if (member.rawDisplayName && member.rawDisplayName !== userId)
            return { display_name: member.rawDisplayName, avatar_url: memberAvatar };
        avatar ??= memberAvatar;
    }
    const user = client.getUser(userId);
    if (user?.rawDisplayName && user.rawDisplayName !== userId)
        return { display_name: user.rawDisplayName, avatar_url: user.avatarUrl || avatar };
    return avatar ? { avatar_url: avatar } : {};
}

/**
 * M11 Y4 start a DM with a user (the message menu's "Reply directly"): not a dialog. Element's own DM path
 * (`startDmOnFirstMessage`, the one the user-info "Message" button and the start-chat dialog call) dispatches the `ViewRoom`
 * itself: an existing DM opens, else a local DM room (nothing sent) that the first send turns into the real room. `done` +
 * the room id that call RETURNS (an existing DM or the local room), never a `ViewRoom` seen. It runs inside `dialogAction`
 * so it cannot overlap the directory's chat waits (a busy host answers the same failure as every dialog action). `failed`
 * at once for a malformed user id or the own id (no self-DM), for a start that gives no room, for a start that rejects
 * (a plain sentence, not Element's error) and for one that gives none within 15 s.
 *
 * The caller is answered at 15 s, but the start keeps running in Element (the encrypted default path awaits device lists).
 * The dialog lock stays held until it settles, at most `DM_LOCK_CAP_MS`, so no other dialog action starts meanwhile and
 * mistakes this chat's late `ViewRoom` for its own. A local room that arrives after the answer is handed to `onLateChat`
 * (the bridge lists it, as for the directory), and a late rejection is caught.
 */
export function startDmWithUser(
    client: MatrixClient,
    userId: string,
    onLateChat?: (roomId: string) => void,
): Promise<ActionOutcome> {
    return dialogAction(async (holdLock) => {
        if (typeof userId !== "string" || !MATRIX_USER_ID.test(userId))
            throw new ClientViewActionError("failed", `${String(userId)} is not a Matrix user id`);
        if (userId === client.getUserId())
            throw new ClientViewActionError("failed", "a direct chat with yourself is not started");
        let answered = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // An async wrapper: a synchronous throw of Element's call is a rejection too.
        const start = (async () =>
            startDmOnFirstMessage(client, [
                new DirectoryMember({ user_id: userId, ...knownProfile(client, userId) }),
            ]))().then(
            (roomId) => {
                // The caller has been told `failed`: the chat Element opened is not reported to it, but it is listed.
                if (answered && roomId && isLocalRoom(roomId)) onLateChat?.(roomId);
                return roomId;
            },
            () => {
                if (!answered)
                    throw new ClientViewActionError("failed", `Element could not open a chat with ${userId}`);
                return null;
            },
        );
        holdLock(start, DM_LOCK_CAP_MS);
        try {
            const roomId = await Promise.race([
                start,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        answered = true;
                        reject(new ClientViewActionError("failed", "Element did not open the chat in time"));
                    }, ROOM_ACTION_TIMEOUT_MS);
                }),
            ]);
            if (!roomId) throw new ClientViewActionError("failed", `Element opened no chat with ${userId}`);
            return { status: "done", roomId };
        } finally {
            clearTimeout(timer);
        }
    });
}

/** What the directory needs of the bridge's room list: whether a room is listed in `rooms()`, and when that list changes. */
export interface DirectoryRooms {
    /** The room is in the kit's list and joined (an invitation is listed too, but is not a join). */
    isListed: (roomId: string) => boolean;
    /** The room is an invitation of the user's (listed too): a plain row picked for it opens the invitation, which is the pick. */
    isInvited?: (roomId: string) => boolean;
    onRooms: (cb: () => void) => () => void;
    /** A new chat's local room that Element opened after the action had answered `cancelled` (within 15 s of it). */
    onLateChat?: (roomId: string) => void;
}

/** What Spotlight dispatches for a picked room (`SpotlightDialog.viewRoom`); a person row's is `isPersonPick`. */
const isDirectoryRoomPick = (p: ActionPayload): boolean => isViewRoom(p) && p.metricsTrigger === "WebUnifiedSearch";
/**
 * What a person row of Spotlight dispatches (`startDmOnFirstMessage`): an existing DM (`MessageUser`) or the new chat's
 * local room. Not `Created`: that is the room `startDm` makes for a single 3rd-party invite, which only the invite dialog
 * that replaces Spotlight (a followed replacement) can lead to; any other `Created` is somebody else's room.
 */
const isPersonPick = (p: ActionPayload): boolean =>
    isViewRoom(p) &&
    (p.metricsTrigger === "MessageUser" ||
        (isLocalRoom(p.room_id) && (p as { targets?: unknown }).targets !== undefined));

/**
 * W1 / W5 directory and server search: Element's Spotlight dialog (`Action.ViewRoomDirectory`, or `OpenSpotlight` on the
 * People filter), opened by `start`. The dialog's `finished` is `[]` on every close, so the result is read from the
 * `ViewRoom` the dialog dispatched. A room row dispatches it before the dialog closes: a joined room (listed) is `done`;
 * `auto_join` is `done` once the room is listed (`failed` on `JoinRoomError` for it, or after 15 s); a room only
 * peeked (`should_peek`, world-readable) is `done` with `peek: true`; an alias-only `ViewRoom` waits for the re-dispatch
 * that carries the id (`ViewRoomError` is `failed`). A person row runs `startDmOnFirstMessage`, which dispatches the
 * chat's `ViewRoom` after `resolveThreePids`, i.e. after the dialog closed: that is awaited as in `startChatViaDialog`
 * (an existing DM, or the local room of a new one) for either filter, as the rooms filter lists people too, or the
 * room the dialog's Create new room made. Closed with no such `ViewRoom` is `cancelled`.
 */
export function directoryViaDialog(
    filter: "rooms" | "people",
    start: () => void,
    rooms: DirectoryRooms,
): Promise<ActionOutcome> {
    return dialogAction(async () => {
        const seen = recordPayloads();
        // Only what Spotlight dispatches once it is open is its result: an earlier ViewRoom (a notification click, an
        // answered call, one dispatched while `start` ran) is not the pick.
        let openedAt = 0;
        // A person pick is `isPersonPick`; after a followed replacement (the invite dialog) `Created` is one too.
        let followed = false;
        // Spotlight's "Create new room" button dispatches `CreateRoom` (Spotlight stays open); the room it makes is then
        // viewed with `Created`. That is the pick only when the `CreateRoom` came from this dialog: any other `Created`
        // is somebody else's room.
        const createdHere = (): boolean => seen.payloads.slice(openedAt).some((p) => p.action === Action.CreateRoom);
        const isPick = (p: ActionPayload): boolean =>
            isDirectoryRoomPick(p) ||
            (followed ? isChatViewRoom(p) : isPersonPick(p)) ||
            (createdHere() && isViewRoom(p) && p.metricsTrigger === "Created");
        const pickFrom = (from: number): number => {
            const at = seen.payloads.slice(from).findIndex(isPick);
            return at < 0 ? at : at + from;
        };
        try {
            const dialog = await openedDialog(start, undefined, () => (openedAt = seen.payloads.length));
            await dialog.finished;
            // The group-chat button replaces Spotlight with Element's invite dialog (static over static: Spotlight's `finished`
            // never resolves, it is answered as dropped). That dialog is the rest of the action: hold the lock until it is gone.
            // A room pick already made is not followed (an error dialog after a join is not part of the action).
            if (!seen.payloads.slice(openedAt).some(isDirectoryRoomPick)) {
                for (let next = dialog.replacedBy?.(); next; next = dialog.replacedBy?.()) {
                    followed = true;
                    await leftStack(next);
                }
            }
            // A room row dispatches before it closes; one tick covers a queued dispatch. A person row's follows the close.
            await new Promise((resolve) => setTimeout(resolve, 0));
            let at = pickFrom(openedAt);
            if (at < 0) {
                try {
                    await seen.wait<true>((p) => (isPick(p) ? true : undefined), CHAT_SHOWN_MS, openedAt);
                } catch {
                    watchLateChat(rooms);
                    return { status: "cancelled" };
                }
                at = pickFrom(openedAt);
            }
            if (at < 0) return { status: "cancelled" };
            const first = seen.payloads[at] as ViewRoomPayload;
            if (!isDirectoryRoomPick(first)) return { status: "done", roomId: first.room_id };
            let pick = first;

            if (!pick.room_id) {
                // Alias-only: RoomViewStore resolves it and dispatches the same payload again with the room id.
                const alias = pick.room_alias;
                pick = await seen.wait<ViewRoomPayload>(
                    (p) => {
                        if (p.action === Action.ViewRoomError && (p as { room_alias?: string }).room_alias === alias)
                            return new ClientViewActionError("failed", "Element could not resolve the room alias");
                        return isViewRoom(p) && p.room_alias === alias && !!p.room_id ? p : undefined;
                    },
                    ROOM_ACTION_TIMEOUT_MS,
                    at,
                );
                at = seen.payloads.length;
            }
            const roomId = pick.room_id as string;
            if (rooms.isListed(roomId)) return { status: "done", roomId };
            // An invitation picked from a plain row (`auto_join` waits for the join below) is the room Element opened.
            if (!pick.auto_join && rooms.isInvited?.(roomId)) return { status: "done", roomId };
            if (pick.auto_join) {
                await listedOrJoinError(roomId, rooms, seen, at);
                return { status: "done", roomId };
            }
            // `should_peek` (a world-readable room) is the only peek; a room Element opens without joining or peeking
            // (ask to join) is not one the kit can show.
            if (pick.should_peek) return { status: "done", roomId, peek: true };
            throw new ClientViewActionError("failed", "Element opened the room without joining or previewing it");
        } finally {
            seen.stop();
        }
    });
}

/**
 * `startDmOnFirstMessage` dispatches the chat's `ViewRoom` after `resolveThreePids`, which can outlast the wait: Element
 * then opens a local room the kit has not been told about. For 15 s more, hand a local-room chat to `onLateChat`.
 */
function watchLateChat(rooms: DirectoryRooms): void {
    if (!rooms.onLateChat) return;
    const late = recordPayloads();
    late.wait<string>(
        (p) => (isChatViewRoom(p) && p.room_id && isLocalRoom(p.room_id) ? p.room_id : undefined),
        ROOM_ACTION_TIMEOUT_MS,
    )
        .then(
            (roomId) => rooms.onLateChat?.(roomId),
            () => {},
        )
        .finally(late.stop);
}

/** Resolves once the room is joined and in `rooms()`; rejects on `JoinRoomError` for it (after `since`) or after 15 s. */
async function listedOrJoinError(
    roomId: string,
    rooms: DirectoryRooms,
    seen: ReturnType<typeof recordPayloads>,
    since: number,
): Promise<void> {
    const stopWaiting = new AbortController();
    const failed = seen.wait<never>(
        (p) =>
            p.action === Action.JoinRoomError && (p as { roomId?: string | null }).roomId === roomId
                ? toActionError((p as { err?: unknown }).err)
                : undefined,
        ROOM_ACTION_TIMEOUT_MS,
        since,
        stopWaiting.signal,
    );
    failed.catch(() => {});
    let off = (): void => {};
    let poll: ReturnType<typeof setInterval> | undefined;
    const listed = new Promise<void>((resolve) => {
        const check = (): void => {
            if (rooms.isListed(roomId)) resolve();
        };
        off = rooms.onRooms(check);
        poll = setInterval(check, 250);
        check();
    });
    try {
        await Promise.race([listed, failed]);
    } finally {
        off();
        clearInterval(poll);
        stopWaiting.abort();
    }
}

/**
 * E3 forward: Element's forward dialog (`DialogOpener` on `OpenForwardDialog`, the way the message context menu opens it).
 * The dialog sends each copy itself and shows its own sending / sent / failed state (D17), so the kit keeps nothing from
 * this action: `done` when the dialog closes. The room name in a dialog row is a jump (`ViewRoom`, trigger
 * `WebForwardShortcut`, then the dialog closes): `done` + that room's id, so the kit follows to it (H5); without a jump
 * `done` + the source room and event. `start` opens the dialog and is handed the dialog's own client view
 * (`forwardDialogClient`, the `matrixClient` prop of `ForwardDialog`): only sends made through that view are claimed,
 * so a send anyone else makes on the real client is never touched.
 */
export function forwardViaDialog(
    client: MatrixClient,
    sourceRoomId: string,
    eventId: string,
    start: (dialogClient: MatrixClient) => void,
): Promise<ActionOutcome> {
    return dialogAction(async () => {
        const seen = recordPayloads();
        try {
            const dialog = await openedDialog(() => start(forwardDialogClient(client)));
            await dialog.finished;
            // Element dispatches the jump before it closes the dialog; one tick covers a queued dispatch.
            await new Promise((resolve) => setTimeout(resolve, 0));
            const jump = [...seen.payloads].reverse().find(isForwardJump);
            return jump ? { status: "done", roomId: jump.room_id } : { status: "done", roomId: sourceRoomId, eventId };
        } finally {
            seen.stop();
        }
    });
}

/**
 * The forward dialog's own client view: a proxy of the real client that the dialog gets as its `matrixClient` prop (the
 * only way `ForwardDialog` and its entries send), so only its sends are claimed. ForwardDialog never cancels the NOT_SENT
 * echo of a copy that failed, and the kit hides NOT_SENT echoes, so it would block that room for good. Its `sendEvent`
 * (either overload: `(roomId, type, content, txnId?)` or `(roomId, threadId | null, type, content, txnId?)`) gives each
 * call a txnId when the caller gave none and, when the promise rejects (also after the dialog closed) and the pending
 * event with that txnId is NOT_SENT, cancels it; the rejection still reaches the dialog. Every other property is the real
 * client's (`Reflect.get` on the real client, functions bound to it), and `client.sendEvent` itself is never replaced, so
 * a widget's, an upload's or a reaction's send on the real client keeps its echo and its retry.
 */
export function forwardDialogClient(client: MatrixClient): MatrixClient {
    const sendEvent = (...args: unknown[]): Promise<unknown> => {
        // Non-threaded: content at 2; threaded (thread id or null at 1): type at 2, content at 3.
        const txnAt = typeof args[2] === "object" && args[2] !== null ? 3 : 4;
        if (args[txnAt] === undefined || args[txnAt] === null) {
            while (args.length < txnAt) args.push(undefined);
            args[txnAt] = client.makeTxnId();
        }
        const roomId = args[0] as string;
        const txnId = args[txnAt];
        const promise = (client.sendEvent as unknown as (...a: unknown[]) => Promise<unknown>).apply(client, args);
        promise.then(undefined, () => {
            const echo = [...(client.getRoom(roomId)?.getPendingEvents() ?? [])].find((ev) => ev.getTxnId() === txnId);
            if (echo?.status === EventStatus.NOT_SENT) client.cancelPendingEvent(echo);
        });
        return promise;
    };
    const bound = new Map<PropertyKey, unknown>();
    return new Proxy(client, {
        get(target, key) {
            if (key === "sendEvent") return sendEvent;
            const value = Reflect.get(target, key, target);
            if (typeof value !== "function" || key === "constructor") return value;
            let fn = bound.get(key);
            if (!fn || (fn as { original?: unknown }).original !== value) {
                fn = Object.assign(value.bind(target), { original: value });
                bound.set(key, fn);
            }
            return fn;
        },
    });
}

const isForwardJump = (p: ActionPayload): p is ViewRoomPayload =>
    isViewRoom(p) && p.metricsTrigger === "WebForwardShortcut" && !!p.room_id;

/**
 * A7 leave: Element's leave confirm (`MatrixChat.leaveRoom`). Confirmed, it leaves and dispatches `AfterLeaveRoom` (also
 * when the leave failed, after an error dialog), so the membership decides: `done` once it went from what it was (join,
 * invite, knock) to leave or ban, or the room is gone; `failed` if it still is what it was a moment after, `cancelled` when the confirm says no.
 */
export function leaveViaDialog(client: MatrixClient, roomId: string, start: () => void): Promise<ActionOutcome> {
    return dialogAction(async () => {
        const seen = recordPayloads();
        try {
            const before = client.getRoom(roomId)?.getMyMembership();
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
            // Left means the membership went from what it was (join, invite, knock) to leave or ban, or the room is gone: an
            // invite or a knock whose leave failed is still that, not "not join".
            const left = (): boolean => {
                const now = client.getRoom(roomId)?.getMyMembership();
                if (now === undefined) return true;
                return before !== now && (now === "leave" || now === "ban");
            };
            const until = Date.now() + LEAVE_SETTLE_MS;
            while (!left() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
            if (!left()) throw new ClientViewActionError("failed", "the room could not be left");
            return { status: "done", roomId };
        } finally {
            seen.stop();
        }
    });
}

/**
 * E5 view source: Element's own ViewSource dialog (`MessageContextMenu.onViewSourceClick`'s `Modal.createDialog`). It
 * only shows the event (and the original of a decrypted one) and changes nothing, so the kit keeps no state from this
 * action: `done` + the message when the dialog closes. `start` is that `createDialog` call.
 */
export function viewSourceViaDialog(roomId: string, eventId: string, start: () => void): Promise<ActionOutcome> {
    return dialogAction(async () => {
        const dialog = await openedDialog(start);
        await dialog.finished;
        return { status: "done", roomId, eventId };
    });
}
