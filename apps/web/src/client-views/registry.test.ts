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
    registerClientView,
    selectClientView,
    unregisterClientView,
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
        unregisterClientView("fixture");
        SdkConfig.reset();
        vi.restoreAllMocks();
    });

    it("lists kits from code and from config.json, ignoring invalid entries", () => {
        registerClientView(fixture);
        SdkConfig.put({
            client_views: [{ id: "other", name: "Other", url: "/kits/other/" }, { id: "stock", name: "x", url: "/" }, 7],
        } as never);
        expect(getClientViews().map((v) => v.id)).toEqual(["fixture", "other"]);
    });

    it("rejects an invalid registration and the reserved stock id", () => {
        expect(() => registerClientView({ id: "", name: "x", url: "/" })).toThrow();
        expect(() => registerClientView({ id: "stock", name: "x", url: "/" })).toThrow();
    });

    it("lets config.json override a kit registered in code", () => {
        registerClientView(fixture);
        SdkConfig.put({ client_views: [{ ...fixture, url: "/elsewhere/" }] } as never);
        expect(getClientViews()).toEqual([{ ...fixture, url: "/elsewhere/" }]);
    });

    it("shows a kit only with the Labs flag on and the kit selected", async () => {
        registerClientView(fixture);
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
        registerClientView(fixture);
        expect(clientViewsAvailable()).toBe(true);
    });
});
