/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import Modal from "../Modal";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { UserTab } from "../components/views/dialogs/UserTab";
import { SortingAlgorithm } from "../stores/room-list-v3/skip-list/sorters";
import { currentRoomSort, openUserSettings, roomSortOf, setRoomSort } from "./RoomSortAction";
import { ClientViewActionError } from "./types";

vi.mock("../Modal", () => ({
    default: {
        createDialog: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        modals: [] as object[],
        priorityModal: null as object | null,
        staticModal: null as object | null,
    },
    ModalManagerEvent: { Opened: "opened", Closed: "closed" },
}));
const store = vi.hoisted(() => ({ resort: vi.fn() }));
vi.mock("../stores/room-list-v3/RoomListStoreV3", () => ({ default: { instance: store } }));
const settings = vi.hoisted(() => ({
    values: {} as Record<string, unknown>,
    watchers: new Map<string, { name: string; cb: () => void }>(),
    next: 0,
}));
vi.mock("../settings/SettingsStore", () => ({
    default: {
        getValue: (name: string) => settings.values[name],
        watchSetting: vi.fn((name: string, _roomId: string | null, cb: () => void) => {
            const id = `w${settings.next++}`;
            settings.watchers.set(id, { name, cb });
            return id;
        }),
        unwatchSetting: vi.fn((id: string) => void settings.watchers.delete(id)),
    },
}));

const SORT = "RoomList.preferredSorting";
/** Changes the setting and tells its watchers, as `SettingsStore` does after a write. */
const writeSetting = (value: unknown): void => {
    settings.values[SORT] = value;
    for (const w of settings.watchers.values()) if (w.name === SORT) w.cb();
};
const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
        await p;
    } catch (e) {
        expect(e).toBeInstanceOf(ClientViewActionError);
        return (e as ClientViewActionError).code;
    }
    return undefined;
};

beforeEach(() => {
    store.resort.mockReset();
    settings.values = {};
    settings.watchers.clear();
});

describe("M10 W6 roomSortOf / currentRoomSort (RoomListHeaderViewModel's algorithm switch)", () => {
    it("maps the three algorithms to the kit's options", () => {
        expect(roomSortOf(SortingAlgorithm.Recency)).toBe("recent");
        expect(roomSortOf(SortingAlgorithm.Alphabetic)).toBe("alphabetical");
        expect(roomSortOf(SortingAlgorithm.Unread)).toBe("unread-first");
    });

    it("leaves an unknown or absent value undefined", () => {
        expect(roomSortOf(undefined)).toBeUndefined();
        expect(roomSortOf(false)).toBeUndefined();
        expect(roomSortOf("Newest")).toBeUndefined();
    });

    it("currentRoomSort reads the device setting", () => {
        expect(currentRoomSort()).toBeUndefined();
        settings.values[SORT] = SortingAlgorithm.Alphabetic;
        expect(currentRoomSort()).toBe("alphabetical");
        settings.values[SORT] = SortingAlgorithm.Unread;
        expect(currentRoomSort()).toBe("unread-first");
    });
});

describe("M10 W6 setRoomSort (RoomListStoreV3.resort, the call RoomListHeaderViewModel.sort makes)", () => {
    it("recent: resorts by recency and is done once the setting reads it", async () => {
        store.resort.mockImplementation((a: unknown) => void (settings.values[SORT] = a));
        await expect(setRoomSort("recent")).resolves.toEqual({ status: "done" });
        expect(store.resort).toHaveBeenCalledExactlyOnceWith(SortingAlgorithm.Recency);
        expect(settings.watchers.size).toBe(0);
    });

    it("alphabetical: resorts alphabetically and is done once the setting reads it", async () => {
        store.resort.mockImplementation((a: unknown) => void (settings.values[SORT] = a));
        await expect(setRoomSort("alphabetical")).resolves.toEqual({ status: "done" });
        expect(store.resort).toHaveBeenCalledExactlyOnceWith(SortingAlgorithm.Alphabetic);
    });

    it("waits for the setting when the store writes it after the call, and ignores a change to another value", async () => {
        settings.values[SORT] = SortingAlgorithm.Recency;
        let done = false;
        const outcome = setRoomSort("alphabetical").then((o) => {
            done = true;
            return o;
        });
        await Promise.resolve();
        expect(store.resort).toHaveBeenCalledExactlyOnceWith(SortingAlgorithm.Alphabetic);
        expect(done).toBe(false);
        expect(settings.watchers.size).toBe(1);
        writeSetting(SortingAlgorithm.Unread);
        await Promise.resolve();
        expect(done).toBe(false);
        writeSetting(SortingAlgorithm.Alphabetic);
        await expect(outcome).resolves.toEqual({ status: "done" });
        expect(settings.watchers.size).toBe(0);
    });

    it("fails, and stops watching, when the setting never shows the new value", async () => {
        vi.useFakeTimers();
        try {
            settings.values[SORT] = SortingAlgorithm.Recency;
            const code = codeOf(setRoomSort("alphabetical"));
            await vi.advanceTimersByTimeAsync(5_001);
            expect(await code).toBe("failed");
            expect(settings.watchers.size).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("refuses unread-first (no Rocket.Chat entry) as unsupported and does not resort", async () => {
        expect(await codeOf(setRoomSort("unread-first" as never))).toBe("unsupported");
        expect(await codeOf(setRoomSort("newest" as never))).toBe("unsupported");
        expect(store.resort).not.toHaveBeenCalled();
    });

    it("fails with the store's message when the store is not ready", async () => {
        store.resort.mockImplementation(() => {
            throw new Error("RoomListStoreV3 has no client yet");
        });
        const outcome = setRoomSort("recent");
        await expect(outcome).rejects.toBeInstanceOf(ClientViewActionError);
        await expect(outcome).rejects.toMatchObject({ code: "failed", message: "RoomListStoreV3 has no client yet" });
        expect(settings.watchers.size).toBe(0);
    });
});

describe("M10 W4 openUserSettings (Action.ViewUserSettings on the Account tab)", () => {
    type Mockable = { createDialog: unknown };
    const member = { isGuest: () => false };
    const guest = { isGuest: () => true };
    let finish!: (r: unknown[]) => void;
    let dispatch: ReturnType<typeof vi.spyOn>;

    /** Element's MatrixChat answers `ViewUserSettings` by opening `UserSettingsDialog`: the stand-in opens a dialog. */
    function elementOpensTheDialog(): void {
        const finished = new Promise<unknown[]>((resolve) => (finish = resolve));
        (Modal as unknown as Mockable).createDialog = vi.fn(() => ({ close: vi.fn(), finished }));
        dispatch.mockImplementation(() => {
            (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {});
        });
    }

    beforeEach(() => {
        dispatch = vi.spyOn(defaultDispatcher, "dispatch");
    });
    afterEach(() => {
        dispatch.mockRestore();
        vi.useRealTimers();
    });

    it("dispatches ViewUserSettings with the Account tab and is done when the dialog closes", async () => {
        elementOpensTheDialog();
        let done = false;
        const outcome = openUserSettings(member).then((o) => {
            done = true;
            return o;
        });
        await new Promise((r) => setTimeout(r, 0));
        expect(dispatch).toHaveBeenCalledExactlyOnceWith({
            action: Action.ViewUserSettings,
            initialTabId: UserTab.Account,
        });
        expect(done).toBe(false);
        finish([]);
        await expect(outcome).resolves.toEqual({ status: "done" });
    });

    it("answers failed while another Element dialog action runs, and accepts the next call after the first closes", async () => {
        elementOpensTheDialog();
        const first = openUserSettings(member);
        await new Promise((r) => setTimeout(r, 0));
        const second = openUserSettings(member);
        await expect(second).rejects.toMatchObject({ code: "failed" });
        expect(dispatch).toHaveBeenCalledOnce();
        finish([]);
        await expect(first).resolves.toEqual({ status: "done" });

        elementOpensTheDialog();
        const third = openUserSettings(member);
        await new Promise((r) => setTimeout(r, 0));
        finish([]);
        await expect(third).resolves.toEqual({ status: "done" });
    });

    it("answers failed for a guest and dispatches nothing: Element would show its sign-in question and keep the action", async () => {
        elementOpensTheDialog();
        const outcome = openUserSettings(guest);
        await expect(outcome).rejects.toBeInstanceOf(ClientViewActionError);
        await expect(outcome).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("sign in") });
        expect(dispatch).not.toHaveBeenCalled();
        expect((Modal as unknown as Mockable).createDialog).not.toHaveBeenCalled();

        // The refusal leaves no running dialog action behind: a member's call right after works.
        const next = openUserSettings(member);
        await new Promise((r) => setTimeout(r, 0));
        expect(dispatch).toHaveBeenCalledOnce();
        finish([]);
        await expect(next).resolves.toEqual({ status: "done" });
    });

    it("fails when Element's dialog does not open", async () => {
        vi.useFakeTimers();
        dispatch.mockImplementation(() => {});
        const code = codeOf(openUserSettings(member));
        await vi.advanceTimersByTimeAsync(5_001);
        expect(await code).toBe("failed");
    });
});
