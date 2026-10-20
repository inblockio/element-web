/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { vi, describe, it, expect, beforeEach, afterEach, type MockedObject } from "vitest";
import {
    getMockClientWithEventEmitter,
    mockClientMethodsServer,
    mockClientMethodsUser,
    TestSDKContext,
} from "test-utils";

import { UserMenuViewModel } from "../viewmodels/menus/UserMenuViewModel";
import { MatrixDispatcher } from "../dispatcher/dispatcher";
import { SDKContextClass } from "../contexts/SDKContextClass";
import SettingsStore from "../settings/SettingsStore";
import { type OwnProfileStore } from "../stores/OwnProfileStore";
import { registerClientView, unregisterClientView } from "./registry";

/** The stock user menu's "Switch to <view>" entries, one per kit, behind the Labs flag. */
describe("user menu client view entries", () => {
    let client: MockedObject<MatrixClient>;
    let labs: boolean;
    let ownProfileStore: OwnProfileStore;

    beforeEach(() => {
        client = getMockClientWithEventEmitter({
            ...mockClientMethodsUser(),
            ...mockClientMethodsServer(),
            getAuthMetadata: vi.fn(),
            getSyncState: vi.fn().mockReturnValue("SYNCING"),
        });
        const sdkContext = new TestSDKContext();
        // @ts-ignore UserMenuViewModel uses SDKContext in the constructor
        SDKContextClass.instance = sdkContext;
        sdkContext._client = client;
        ownProfileStore = {
            displayName: "Sally",
            userStatus: undefined,
            getHttpAvatarUrl: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
        } as unknown as OwnProfileStore;
        labs = false;
        const getValue = SettingsStore.getValue;
        vi.spyOn(SettingsStore, "getValue").mockImplementation(((name: string, ...rest: unknown[]) =>
            name === "feature_client_views"
                ? labs
                : (getValue as (...a: unknown[]) => unknown)(name, ...rest)) as never);
        vi.spyOn(SettingsStore, "setValue").mockResolvedValue();
        registerClientView({ id: "fixture", name: "Fixture", url: "/kits/fixture/index.html" });
    });

    afterEach(() => {
        unregisterClientView("fixture");
        vi.restoreAllMocks();
        SDKContextClass.instance.onLoggedOut();
    });

    const menu = (): UserMenuViewModel =>
        new UserMenuViewModel({ ownProfileStore }, new MatrixDispatcher(), client, false);

    it("lists no views with the Labs flag off", () => {
        const vm = menu();
        vm.setOpen(true);
        expect(vm.getSnapshot().views).toEqual([]);
    });

    it("lists the registered kits when the menu opens with the Labs flag on", () => {
        const vm = menu();
        labs = true;
        vm.setOpen(true);
        expect(vm.getSnapshot().views).toEqual([{ id: "fixture", name: "Fixture" }]);
    });

    it("closes the menu and selects the view for this device", () => {
        labs = true;
        const vm = menu();
        vm.setOpen(true);
        vm.switchView("fixture");
        expect(vm.getSnapshot().open).toBe(false);
        expect(SettingsStore.setValue).toHaveBeenCalledWith("clientView", null, "device", "fixture");
    });
});
