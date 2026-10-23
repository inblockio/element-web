/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import defaultDispatcher from "../dispatcher/dispatcher";
import { EchoChamber } from "../stores/local-echo/EchoChamber";
import { TransactionStatus } from "../stores/local-echo/EchoTransaction";
import { markUnread, setFavourite, setNotificationLevel, type RoomItemActionsVm } from "./RoomItemActions";
import { ClientViewActionError, type ViewNotificationLevel } from "./types";

vi.mock("../stores/local-echo/EchoChamber", () => ({ EchoChamber: { forRoom: vi.fn() } }));

/* A10: the outcome of each room item action is read where the view-model leaves it (promise, tag result, echo transaction). */
type Snap = ReturnType<RoomItemActionsVm["getSnapshot"]>;

const snap = (over: Partial<Snap> = {}): Snap => ({
    isFavourite: false,
    canMarkAsUnread: true,
    showNotificationMenu: true,
    roomNotifState: "all_messages",
    notification: { invited: false },
    ...over,
});

function makeItem(initial: Snap): RoomItemActionsVm & {
    set(s: Partial<Snap>): void;
    onMarkAsUnread: Mock<() => Promise<void>>;
    onToggleFavorite: Mock<() => void>;
    onSetRoomNotifState: Mock<(state: ViewNotificationLevel) => void>;
} {
    let current = initial;
    const listeners = new Set<() => void>();
    return {
        getSnapshot: () => current,
        subscribe: (cb) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        set: (s) => {
            current = { ...current, ...s };
            listeners.forEach((cb) => cb());
        },
        onMarkAsUnread: vi.fn<() => Promise<void>>(async () => {}),
        onToggleFavorite: vi.fn<() => void>(),
        onSetRoomNotifState: vi.fn<(state: ViewNotificationLevel) => void>(),
    };
}

const room = (tags: Record<string, unknown> = {}): Room => ({ roomId: "!a:example.org", tags }) as unknown as Room;

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
        await p;
    } catch (e) {
        expect(e).toBeInstanceOf(ClientViewActionError);
        return (e as ClientViewActionError).code;
    }
    return undefined;
};

describe("A10 mark unread (onMarkAsUnread)", () => {
    it("calls the view-model and is done once its promise resolves", async () => {
        const item = makeItem(snap());
        expect(await markUnread(item, room())).toEqual({ status: "done", roomId: "!a:example.org" });
        expect(item.onMarkAsUnread).toHaveBeenCalledOnce();
    });

    it("does not write for a room that already shows unread", async () => {
        const item = makeItem(snap({ canMarkAsUnread: false }));
        expect((await markUnread(item, room())).status).toBe("done");
        expect(item.onMarkAsUnread).not.toHaveBeenCalled();
    });

    it("rejects with the contract's error when the homeserver refuses", async () => {
        const item = makeItem(snap());
        item.onMarkAsUnread.mockRejectedValue(new Error("500"));
        expect(await codeOf(markUnread(item, room()))).toBe("failed");
    });

    it("is unsupported for an invite and for an archived room", async () => {
        expect(await codeOf(markUnread(makeItem(snap({ notification: { invited: true } })), room()))).toBe(
            "unsupported",
        );
        expect(await codeOf(markUnread(makeItem(snap()), room({ "im.vector.fake.archived": {} })))).toBe("unsupported");
    });
});

describe("A10 favourite (onToggleFavorite, RoomListActions.tagRoom result)", () => {
    const answer = (action: string): void => {
        setTimeout(() => defaultDispatcher.dispatch({ action }, true), 0);
    };

    it("is done when the tag write succeeded and the room's tags show it", async () => {
        const item = makeItem(snap());
        item.onToggleFavorite.mockImplementation(() => {
            answer("RoomListActions.tagRoom.success");
            setTimeout(() => item.set({ isFavourite: true }), 5);
        });
        expect(await setFavourite(item, room(), true)).toEqual({ status: "done", roomId: "!a:example.org" });
        expect(item.onToggleFavorite).toHaveBeenCalledOnce();
    });

    it("calls nothing when the state already is the asked one", async () => {
        const item = makeItem(snap({ isFavourite: true }));
        expect((await setFavourite(item, room(), true)).status).toBe("done");
        expect(item.onToggleFavorite).not.toHaveBeenCalled();
    });

    it("fails when the tag write failed, and when the tags never show it", async () => {
        const refused = makeItem(snap());
        refused.onToggleFavorite.mockImplementation(() => answer("RoomListActions.tagRoom.failure"));
        expect(await codeOf(setFavourite(refused, room(), true))).toBe("failed");

        vi.useFakeTimers();
        try {
            const silent = makeItem(snap());
            silent.onToggleFavorite.mockImplementation(() =>
                defaultDispatcher.dispatch({ action: "RoomListActions.tagRoom.success" }, true),
            );
            const result = codeOf(setFavourite(silent, room(), true));
            await vi.advanceTimersByTimeAsync(9_000);
            expect(await result).toBe("failed");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("A10 notification level (onSetRoomNotifState, echo transaction)", () => {
    const client = {} as MatrixClient;
    let transactions: Array<{ status: TransactionStatus }>;
    let chamber: {
        context: { transactions: unknown[] };
        setClient: ReturnType<typeof vi.fn>;
        notificationVolume?: string;
    };

    beforeEach(() => {
        transactions = [];
        chamber = {
            context: {
                get transactions() {
                    return [...transactions];
                },
            },
            setClient: vi.fn(),
        };
        vi.mocked(EchoChamber.forRoom).mockReturnValue(chamber as never);
    });

    it("is done when the echo transaction succeeded", async () => {
        const item = makeItem(snap());
        item.onSetRoomNotifState.mockImplementation(() => {
            const txn = { status: TransactionStatus.Pending };
            transactions.push(txn);
            setTimeout(() => (txn.status = TransactionStatus.Success), 20);
        });
        expect(await setNotificationLevel(item, room(), client, "mute")).toEqual({
            status: "done",
            roomId: "!a:example.org",
        });
        expect(item.onSetRoomNotifState).toHaveBeenCalledWith("mute");
        expect(chamber.setClient).not.toHaveBeenCalled();
    });

    it("fails and drops the echo when the transaction failed", async () => {
        const item = makeItem(snap());
        item.onSetRoomNotifState.mockImplementation(() => {
            const txn = { status: TransactionStatus.Pending };
            transactions.push(txn);
            setTimeout(() => (txn.status = TransactionStatus.Error), 20);
        });
        expect(await codeOf(setNotificationLevel(item, room(), client, "mentions_only"))).toBe("failed");
        expect(chamber.setClient).toHaveBeenCalledWith(client);
    });

    it("compares with the echo's level, not the item's stale snapshot", async () => {
        // The snapshot still says all messages after a change to mentions only: asking for all messages must write.
        chamber.notificationVolume = "mentions_only";
        const item = makeItem(snap({ roomNotifState: "all_messages" }));
        item.onSetRoomNotifState.mockImplementation(() => {
            const txn = { status: TransactionStatus.Pending };
            transactions.push(txn);
            setTimeout(() => (txn.status = TransactionStatus.Success), 10);
        });
        expect((await setNotificationLevel(item, room(), client, "all_messages")).status).toBe("done");
        expect(item.onSetRoomNotifState).toHaveBeenCalledWith("all_messages");
        // and nothing is written for the level the echo holds
        const same = makeItem(snap({ roomNotifState: "all_messages" }));
        await setNotificationLevel(same, room(), client, "mentions_only");
        expect(same.onSetRoomNotifState).not.toHaveBeenCalled();
    });

    it("calls nothing for the level the room has, and refuses a room without the menu", async () => {
        const same = makeItem(snap({ roomNotifState: "mute" }));
        expect((await setNotificationLevel(same, room(), client, "mute")).status).toBe("done");
        expect(same.onSetRoomNotifState).not.toHaveBeenCalled();
        const noMenu = makeItem(snap({ showNotificationMenu: false }));
        expect(await codeOf(setNotificationLevel(noMenu, room(), client, "mute"))).toBe("unsupported");
    });
});
