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
import { ROOM_ACTION_TIMEOUT_MS } from "./RoomActions";
import { ClientViewActionError, type ViewNotificationLevel } from "./types";

vi.mock("../stores/local-echo/EchoChamber", () => ({ EchoChamber: { forRoom: vi.fn() } }));
const notifs = vi.hoisted(() => ({ state: vi.fn() }));
vi.mock("../RoomNotifs", () => ({ getRoomNotifsState: notifs.state }));

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

describe("A10 favourite (onToggleFavorite, the room's own m.favourite tag)", () => {
    const tagged = (r: Room, on: boolean): void => {
        (r as unknown as { tags: Record<string, unknown> }).tags = on ? { "m.favourite": { order: 0.5 } } : {};
    };

    it("is done when the room's tag shows it", async () => {
        const r = room();
        const item = makeItem(snap());
        item.onToggleFavorite.mockImplementation(() => {
            setTimeout(() => tagged(r, true), 120);
        });
        expect(await setFavourite(item, r, true)).toEqual({ status: "done", roomId: "!a:example.org" });
        expect(item.onToggleFavorite).toHaveBeenCalledOnce();
    });

    it("is done for removing the tag when the room's tag is gone", async () => {
        const r = room({ "m.favourite": { order: 0.5 } });
        const item = makeItem(snap({ isFavourite: true }));
        item.onToggleFavorite.mockImplementation(() => {
            setTimeout(() => tagged(r, false), 60);
        });
        expect((await setFavourite(item, r, false)).status).toBe("done");
    });

    it("calls nothing when the room's tag already is the asked state", async () => {
        const r = room({ "m.favourite": { order: 0.5 } });
        const item = makeItem(snap({ isFavourite: true }));
        expect((await setFavourite(item, r, true)).status).toBe("done");
        expect(item.onToggleFavorite).not.toHaveBeenCalled();
    });

    it("reads no tagRoom result: another room's answer (success or failure) decides nothing", async () => {
        const r = room();
        const item = makeItem(snap());
        item.onToggleFavorite.mockImplementation(() => {
            defaultDispatcher.dispatch({ action: "RoomListActions.tagRoom.failure", err: new Error("other") }, true);
            setTimeout(() => tagged(r, true), 300);
        });
        expect((await setFavourite(item, r, true)).status).toBe("done");
    });

    it("runs overlapping calls for one room one after the other: an opposite call does not return done on a stale tag", async () => {
        const r = room();
        const item = makeItem(snap());
        const order: string[] = [];
        item.onToggleFavorite.mockImplementation(() => {
            const adding = !(r.tags as Record<string, unknown>)["m.favourite"];
            order.push(adding ? "add" : "remove");
            setTimeout(() => tagged(r, adding), 200);
        });
        const on = setFavourite(item, r, true);
        const off = setFavourite(item, r, false);
        expect((await on).status).toBe("done");
        expect((await off).status).toBe("done");
        expect(order).toEqual(["add", "remove"]);
        expect((r.tags as Record<string, unknown>)["m.favourite"]).toBeUndefined();
    });

    it("is network (may still apply) when the room's tag does not show it in time", async () => {
        vi.useFakeTimers();
        try {
            const silent = makeItem(snap());
            const result = codeOf(setFavourite(silent, room(), true));
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
            expect(await result).toBe("network");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("A10 notification level (onSetRoomNotifState, echo transaction)", () => {
    const getPushRules = vi.fn(async () => ({}));
    const client = { getPushRules } as unknown as MatrixClient;
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
        notifs.state.mockReset();
        getPushRules.mockClear();
        getPushRules.mockImplementation(async () => ({}));
    });

    it("is done when the echo transaction succeeded and the homeserver's computed level is the asked one", async () => {
        notifs.state.mockReturnValue("mute");
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
        expect(getPushRules).toHaveBeenCalledOnce();
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

    it("fails and drops the echo when Success was a cancelled transaction and the server's level is another", async () => {
        notifs.state.mockReturnValue("mentions_only");
        const item = makeItem(snap());
        item.onSetRoomNotifState.mockImplementation(() => {
            const txn = { status: TransactionStatus.Pending };
            transactions.push(txn);
            setTimeout(() => (txn.status = TransactionStatus.Success), 20);
        });
        expect(await codeOf(setNotificationLevel(item, room(), client, "mute"))).toBe("failed");
        expect(getPushRules).toHaveBeenCalledOnce();
        expect(chamber.setClient).toHaveBeenCalledWith(client);
    });

    it("reads the server's rules first: a stale client.pushRules does not fail an accepted level", async () => {
        let loaded = false;
        getPushRules.mockImplementation(async () => {
            loaded = true;
            return {};
        });
        notifs.state.mockImplementation(() => (loaded ? "mute" : "all_messages"));
        const item = makeItem(snap());
        item.onSetRoomNotifState.mockImplementation(() => {
            const txn = { status: TransactionStatus.Pending };
            transactions.push(txn);
            setTimeout(() => (txn.status = TransactionStatus.Success), 20);
        });
        expect((await setNotificationLevel(item, room(), client, "mute")).status).toBe("done");
    });

    it("fails (and drops the echo) when the push rules cannot be read after Success", async () => {
        getPushRules.mockRejectedValue(new Error("gone"));
        const item = makeItem(snap());
        item.onSetRoomNotifState.mockImplementation(() => {
            const txn = { status: TransactionStatus.Pending };
            transactions.push(txn);
            setTimeout(() => (txn.status = TransactionStatus.Success), 20);
        });
        expect(await codeOf(setNotificationLevel(item, room(), client, "mute"))).toBe("failed");
        expect(chamber.setClient).toHaveBeenCalledWith(client);
    });

    it("compares with the echo's level, not the item's stale snapshot", async () => {
        notifs.state.mockReturnValue("all_messages");
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
