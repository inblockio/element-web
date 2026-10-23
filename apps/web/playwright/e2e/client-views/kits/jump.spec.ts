/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Rocket.Chat's jump-to-message route (F4): `/channel/<slug>?msg=<id>` opens the room, jumps, then drops `msg` from the
// route. That last step must keep Rocket.Chat's own path (in the kit's hash), never the kit document's path, or the
// room closes. Reload keeps the room (D8).

import { test, expect } from "../../../element-web-test";
import { KIT_FRAME, KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

test.describe("Rocket.Chat view: jump to message", () => {
    test.use(KIT_USE);

    test("a jump route opens the room and stays in it after the jump", async ({ page, app, bot }) => {
        const roomId = await app.client.createRoom({ name: "Release Notes", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        const { event_id: eventId } = await bot.sendMessage(roomId, "Version 2 is out");

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Release Notes"));
        await expect(kit.getByText("Version 2 is out")).toBeVisible({ timeout: 30000 });

        const kitHash = async () =>
            (await (await page.locator(KIT_FRAME).elementHandle())!.contentFrame())!.evaluate(() => window.location.hash);
        const route = await kitHash();
        expect(route).toMatch(/^#\/channel\/release-notes/);

        const frame = (await (await page.locator(KIT_FRAME).elementHandle())!.contentFrame())!;
        await frame.evaluate((hash) => {
            window.location.hash = hash;
            window.location.reload();
        }, `${route}?msg=${encodeURIComponent(eventId)}`);

        await expect(kit.getByText("Version 2 is out")).toBeVisible({ timeout: 30000 });
        // The jump clears `msg` from the route and keeps Rocket.Chat's path.
        await expect
            .poll(kitHash, { timeout: 15000 })
            .toBe(route);
        await expect(kit.getByText("Version 2 is out")).toBeVisible();
    });
});
