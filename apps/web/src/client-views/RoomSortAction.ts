/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

/*
 * M10 W4 + W6: the user's profile dialog and the room list sort order over the kit.
 *
 * `openUserSettings`: Element's own settings dialog on its Account tab (`Action.ViewUserSettings`, answered by MatrixChat
 * with `UserSettingsDialog`; name and avatar are `UserProfileSettings`). `UserMenuViewModel.openSettings` takes no tab, so
 * the action is dispatched as the view-model does, with the tab. M11 Y2 (bridge v5): an optional `tab` (account,
 * preferences, appearance, labs) picks the tab; `labs` while Element lists no Labs tab (`labsTabListed`) is `failed` with
 * no dialog. `done` when the dialog closes. A guest gets `failed`:
 * `MatrixChat` answers a guest's `ViewUserSettings` with a stored deferred action and Element's sign-in question, not the
 * settings dialog, so nothing is dispatched.
 *
 * `setRoomSort`: the store call `RoomListHeaderViewModel.sort(option)` runs, with its option -> `SortingAlgorithm` switch.
 * `RoomListStoreV3.resort` re-sorts, emits `ListsUpdate` (the bridge's `rooms` follow) and writes the device setting
 * `RoomList.preferredSorting`; no own sort here. `done` once the setting reads the new value.
 */

import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { type OpenToTabPayload } from "../dispatcher/payloads/OpenToTabPayload";
import { UserTab } from "../components/views/dialogs/UserTab";
import RoomListStoreV3 from "../stores/room-list-v3/RoomListStoreV3";
import { SortingAlgorithm } from "../stores/room-list-v3/skip-list/sorters";
import SettingsStore from "../settings/SettingsStore";
import SdkConfig from "../SdkConfig";
import { dialogAction, openedDialog } from "./RoomActions";
import { type ActionOutcome, ClientViewActionError, type ViewRoomSort, type ViewSettingsTab } from "./types";

const SORT_SETTING = "RoomList.preferredSorting";
/** How long the setting may take to show the new value after the store's resort. */
const SORT_SETTLE_MS = 5000;

/** `RoomListHeaderViewModel`'s switch, option -> algorithm (the kit sends only the first two). */
const ALGORITHM: Record<ViewRoomSort, SortingAlgorithm> = {
    "recent": SortingAlgorithm.Recency,
    "alphabetical": SortingAlgorithm.Alphabetic,
    "unread-first": SortingAlgorithm.Unread,
};

/** The setting's value as `ViewMe.roomSort` (`RoomListHeaderViewModel`'s initial snapshot switch); unknown = undefined. */
export function roomSortOf(value: unknown): ViewRoomSort | undefined {
    switch (value) {
        case SortingAlgorithm.Recency:
            return "recent";
        case SortingAlgorithm.Alphabetic:
            return "alphabetical";
        case SortingAlgorithm.Unread:
            return "unread-first";
        default:
            return undefined;
    }
}

/** The room list sort the device setting holds now. */
export const currentRoomSort = (): ViewRoomSort | undefined => roomSortOf(SettingsStore.getValue(SORT_SETTING));

/** The kit's tab names -> Element's `UserTab` ids (`dialogs/UserTab.ts`); an unknown name opens Account, as `TabbedView` does. */
const SETTINGS_TABS: Record<ViewSettingsTab, UserTab> = {
    account: UserTab.Account,
    preferences: UserTab.Preferences,
    appearance: UserTab.Appearance,
    labs: UserTab.Labs,
};

/**
 * M11 Y2: whether Element's settings dialog has a Labs tab, as `UserSettingsDialog.tsx:232` decides it:
 * `showLabsFlags()` (`LabsUserSettingsTab.tsx:25`: the config `show_labs_settings` or the developer mode setting) or any
 * beta feature. Read here from the same config and settings (no import of the tab component's module graph).
 */
export function labsTabListed(): boolean {
    return Boolean(
        SdkConfig.get("show_labs_settings") ||
        SettingsStore.getValue("developerMode") ||
        SettingsStore.getFeatureSettingNames().some((k) => SettingsStore.getBetaInfo(k)),
    );
}

export function openUserSettings(
    client: Pick<MatrixClient, "isGuest">,
    opts?: { tab?: ViewSettingsTab },
): Promise<ActionOutcome> {
    return dialogAction(async () => {
        if (client.isGuest()) throw new ClientViewActionError("failed", "a guest has no settings: sign in first");
        // Element has no Labs tab here: its dialog would fall back to Account, which is not what was asked for.
        if (opts?.tab === "labs" && !labsTabListed()) {
            throw new ClientViewActionError("failed", "Element lists no Labs tab (no labs setting, no beta feature)");
        }
        const initialTabId = (opts?.tab && SETTINGS_TABS[opts.tab]) || UserTab.Account;
        const dialog = await openedDialog(() => {
            defaultDispatcher.dispatch<OpenToTabPayload>({ action: Action.ViewUserSettings, initialTabId });
        });
        await dialog.finished;
        return { status: "done" };
    });
}

export async function setRoomSort(option: "recent" | "alphabetical"): Promise<ActionOutcome> {
    // The contract offers the two options RC has; "unread-first" has no RC entry and is refused, not stored.
    if (option !== "recent" && option !== "alphabetical") {
        throw new ClientViewActionError("unsupported", `room sort "${String(option)}" is not offered`);
    }
    const algorithm = ALGORITHM[option];
    try {
        RoomListStoreV3.instance.resort(algorithm);
    } catch (e) {
        // The store is not ready (no skip list or client yet).
        throw new ClientViewActionError("failed", e instanceof Error ? e.message : String(e));
    }
    if (SettingsStore.getValue(SORT_SETTING) === algorithm) return { status: "done" };
    // `resort` writes the setting without awaiting it: wait for the watcher to show the value.
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            SettingsStore.unwatchSetting(ref);
            reject(new ClientViewActionError("failed", "the room list sort setting did not change"));
        }, SORT_SETTLE_MS);
        const ref = SettingsStore.watchSetting(SORT_SETTING, null, () => {
            if (SettingsStore.getValue(SORT_SETTING) !== algorithm) return;
            clearTimeout(timer);
            SettingsStore.unwatchSetting(ref);
            resolve();
        });
    });
    return { status: "done" };
}
