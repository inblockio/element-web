/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Increment 1, replies: an Element reply arrives in Rocket.Chat as its quote attachment (the quoted sender and text
// from the reply tile view-model), and the reply's own body without the reply fallback.

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

test.describe("Rocket.Chat view: replies", () => {
    test.use(KIT_USE);

    test("shows a reply as Rocket.Chat's quote of the replied message", async ({ page, app, bot }) => {
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        const { event_id: parentId } = await bot.sendMessage(roomId, "Lunch at noon");
        await bot.sendMessage(roomId, {
            msgtype: "m.text",
            body: "> <@bob> Lunch at noon\n\nCount me in",
            "m.relates_to": { "m.in_reply_to": { event_id: parentId } },
        } as any);

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));

        const quote = kit.locator("blockquote", { hasText: "Lunch at noon" });
        await expect(quote).toBeVisible({ timeout: 30000 });
        await expect(quote).toContainText("Bob");
        // The reply fallback ("> <@bot...> ...") is stripped from the reply's own body.
        await expect(kit.getByText("Count me in")).toBeVisible();
        await expect(kit.getByText(/^> </)).toHaveCount(0);

        // The quote's jump link stays in the room (grok kit F1: a `#/` link routed the kit document to Not Found).
        await quote.locator('a[href*="msg="]').first().click();
        await expect(kit.getByText("Count me in")).toBeVisible();
        await expect(kit.getByText(/page not found/i)).toHaveCount(0);
    });
});
