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
import SdkConfig from "../SdkConfig";
import { currentRoomSort, labsTabListed, openUserSettings, roomSortOf, setRoomSort } from "./RoomSortAction";
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
    /** The beta features `getFeatureSettingNames` lists (name -> `getBetaInfo`); none by default. */
    betas: {} as Record<string, unknown>,
    watchers: new Map<string, { name: string; cb: () => void }>(),
    next: 0,
}));
vi.mock("../settings/SettingsStore", () => ({
    default: {
        getValue: (name: string) => settings.values[name],
        getFeatureSettingNames: () => Object.keys(settings.betas),
        getBetaInfo: (name: string) => settings.betas[name],
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
    settings.betas = {};
    settings.watchers.clear();
    SdkConfig.reset();
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

describe("M11 Y2 labsTabListed (UserSettingsDialog.tsx:232, the Labs tab's predicate)", () => {
    it("is false with no labs config, no developer mode and no beta feature", () => {
        expect(labsTabListed()).toBe(false);
    });

    it("is true for the config show_labs_settings, the developer mode, or any beta feature, each alone", () => {
        SdkConfig.put({ show_labs_settings: true } as never);
        expect(labsTabListed()).toBe(true);
        SdkConfig.reset();
        expect(labsTabListed()).toBe(false);
        settings.values.developerMode = true;
        expect(labsTabListed()).toBe(true);
        settings.values.developerMode = false;
        expect(labsTabListed()).toBe(false);
        settings.betas.feature_video_rooms = { title: "Video rooms" };
        expect(labsTabListed()).toBe(true);
    });
});

describe("M11 Y2 openUserSettings({ tab }) (Action.ViewUserSettings with the tab's UserTab)", () => {
    type Mockable = { createDialog: unknown };
    const member = { isGuest: () => false };
    let finish!: (r: unknown[]) => void;
    let dispatch: ReturnType<typeof vi.spyOn>;

    function elementOpensTheDialog(): void {
        const finished = new Promise<unknown[]>((resolve) => (finish = resolve));
        (Modal as unknown as Mockable).createDialog = vi.fn(() => ({ close: vi.fn(), finished }));
        dispatch.mockImplementation(() => {
            (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {});
        });
    }
    /** Opens the dialog on `tab`, checks the dispatched tab, closes it, and expects `done`. */
    async function opensOn(tab: Parameters<typeof openUserSettings>[1], expected: UserTab): Promise<void> {
        elementOpensTheDialog();
        const outcome = openUserSettings(member, tab);
        await new Promise((r) => setTimeout(r, 0));
        expect(dispatch).toHaveBeenCalledExactlyOnceWith({ action: Action.ViewUserSettings, initialTabId: expected });
        finish([]);
        await expect(outcome).resolves.toEqual({ status: "done" });
        dispatch.mockClear();
    }

    beforeEach(() => {
        dispatch = vi.spyOn(defaultDispatcher, "dispatch");
    });
    afterEach(() => {
        dispatch.mockRestore();
        vi.useRealTimers();
    });

    it("opens Preferences, Appearance and Account on their own UserTab, and Account with no tab or an empty options object", async () => {
        await opensOn({ tab: "preferences" }, UserTab.Preferences);
        await opensOn({ tab: "appearance" }, UserTab.Appearance);
        await opensOn({ tab: "account" }, UserTab.Account);
        await opensOn(undefined, UserTab.Account);
        await opensOn({}, UserTab.Account);
    });

    it("opens Labs on UserTab.Labs when Element lists the tab (developer mode here)", async () => {
        settings.values.developerMode = true;
        await opensOn({ tab: "labs" }, UserTab.Labs);
    });

    it("opens Labs when only a beta feature makes Element list the tab", async () => {
        settings.betas.feature_video_rooms = { title: "Video rooms" };
        await opensOn({ tab: "labs" }, UserTab.Labs);
    });

    it("answers failed, dispatches nothing and opens no dialog for Labs while Element lists no Labs tab", async () => {
        elementOpensTheDialog();
        const outcome = openUserSettings(member, { tab: "labs" });
        await expect(outcome).rejects.toBeInstanceOf(ClientViewActionError);
        await expect(outcome).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("Labs") });
        expect(dispatch).not.toHaveBeenCalled();
        expect((Modal as unknown as Mockable).createDialog).not.toHaveBeenCalled();
        // The refusal leaves no running dialog action behind: Preferences right after works.
        await opensOn({ tab: "preferences" }, UserTab.Preferences);
    });

    it("answers failed for a guest whatever the tab, with nothing dispatched", async () => {
        elementOpensTheDialog();
        settings.values.developerMode = true;
        for (const tab of ["preferences", "appearance", "labs"] as const) {
            await expect(openUserSettings({ isGuest: () => true }, { tab })).rejects.toMatchObject({ code: "failed" });
        }
        expect(dispatch).not.toHaveBeenCalled();
    });
});
