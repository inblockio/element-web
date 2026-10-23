/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Increment 4, URL previews: a message with a link arrives in Rocket.Chat with its own link preview, fed by Element's URL
// preview group view-model (the host fetches the preview; the kit only shows it), and it follows Element's setting.

import { SettingLevel } from "../../../../src/settings/SettingLevel";
import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

// the same stub as Element's own message preview specs: the host's client asks, so the page-level route answers
const PREVIEW_URL_PATTERN = /.*\/_matrix\/(client\/v1\/media|media\/v3)\/preview_url.*/;

test.describe("Rocket.Chat view: URL previews", () => {
    test.use(KIT_USE);

    test("shows a link preview as Rocket.Chat's own, and follows Element's setting while the room is open", async ({
        page,
        app,
        bot,
    }) => {
        await page.route(PREVIEW_URL_PATTERN, (route) =>
            route.fulfill({
                json: {
                    "og:title": "A simple site",
                    "og:description": "And with a brief description",
                    "og:site_name": "Example Site",
                },
            }),
        );
        const roomId = await app.client.createRoom({ name: "Link Share", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, { msgtype: "m.text", body: "look at https://example.org/ today" });

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Link Share"));

        const preview = kit.locator(".rcx-message-generic-preview").filter({ hasText: "A simple site" });
        await expect(preview).toHaveCount(1, { timeout: 30000 });
        await expect(preview.getByRole("link", { name: "A simple site" })).toHaveAttribute(
            "href",
            "https://example.org/",
        );
        await expect(preview.locator(".rcx-message-generic-preview__description")).toHaveText(
            "And with a brief description",
        );
        await expect(preview.locator(".rcx-message-generic-preview__footer")).toContainText("Example Site");

        // Element's setting turned off while the room is open: the preview is gone (hidden = no preview in the kit).
        await app.settings.setValue("urlPreviewsEnabled", null, SettingLevel.DEVICE, false);
        await expect(kit.locator(".rcx-message-generic-preview__footer")).toHaveCount(0, { timeout: 30000 });
        // and back on
        await app.settings.setValue("urlPreviewsEnabled", null, SettingLevel.DEVICE, true);
        await expect(kit.locator(".rcx-message-generic-preview").filter({ hasText: "A simple site" })).toHaveCount(1, {
            timeout: 30000,
        });
    });
});
