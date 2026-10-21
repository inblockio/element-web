/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import SdkConfig from "../SdkConfig";
import SettingsStore from "../settings/SettingsStore";
import { SettingLevel } from "../settings/SettingLevel";
import {
    clientViewsAvailable,
    getActiveClientView,
    getClientViews,
    isHandedOver,
    selectClientView,
    setHandedOver,
    watchHandOver,
} from "./registry";

const fixture = { id: "fixture", name: "Fixture", url: "/kits/fixture/index.html" };

describe("client view registry", () => {
    let settings: Record<string, unknown>;

    beforeEach(() => {
        settings = { feature_client_views: true, clientView: "stock" };
        vi.spyOn(SettingsStore, "getValue").mockImplementation((name: string) => settings[name] as never);
        vi.spyOn(SettingsStore, "setValue").mockImplementation(async (name, _room, _level, value) => {
            settings[name] = value;
        });
    });

    afterEach(() => {
        SdkConfig.reset();
        vi.restoreAllMocks();
    });

    it("lists the valid kits from config.json and skips invalid entries", () => {
        SdkConfig.put({
            client_views: [
                fixture,
                { id: "", name: "x", url: "/" },
                { id: "stock", name: "x", url: "/" },
                { id: "noname", url: "/" },
                { id: "nourl", name: "x" },
                { id: "other", name: "Other", url: "/kits/other/" },
                7,
            ],
        } as never);
        expect(getClientViews()).toEqual([fixture, { id: "other", name: "Other", url: "/kits/other/" }]);
    });

    it("shows a kit only with the Labs flag on and the kit selected", async () => {
        SdkConfig.put({ client_views: [fixture] } as never);
        expect(getActiveClientView()).toBeUndefined();
        await selectClientView("fixture");
        expect(SettingsStore.setValue).toHaveBeenCalledWith("clientView", null, SettingLevel.DEVICE, "fixture");
        expect(getActiveClientView()).toEqual(fixture);
        settings.feature_client_views = false;
        expect(getActiveClientView()).toBeUndefined();
        expect(clientViewsAvailable()).toBe(false);
    });

    it("selects the stock UI for an unknown id and when the selected kit is gone", async () => {
        await selectClientView("nope");
        expect(settings.clientView).toBe("stock");
        settings.clientView = "removed-kit";
        expect(getActiveClientView()).toBeUndefined();
    });

    it("is available only with the Labs flag and at least one kit", () => {
        expect(clientViewsAvailable()).toBe(false);
        SdkConfig.put({ client_views: [fixture] } as never);
        expect(clientViewsAvailable()).toBe(true);
    });

    it("ends a hand-over on any switch, the already selected kit included, and tells the watchers", async () => {
        SdkConfig.put({ client_views: [fixture] } as never);
        await selectClientView("fixture");
        const watcher = vi.fn();
        const unwatch = watchHandOver(watcher);
        setHandedOver(true);
        setHandedOver(true);
        expect(isHandedOver()).toBe(true);
        expect(watcher).toHaveBeenCalledTimes(1);
        await selectClientView("fixture");
        expect(isHandedOver()).toBe(false);
        expect(watcher).toHaveBeenCalledTimes(2);
        unwatch();
        expect(settings.clientView).toBe("fixture");
    });
});
