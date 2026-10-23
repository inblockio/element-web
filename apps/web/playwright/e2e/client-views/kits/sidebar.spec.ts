/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Rocket.Chat's sidebar on the room list view-model (H3a): display names (not slugs), plain unread vs mention
// counts as Element counts them, room avatars from the view-model or an inline initial avatar (never Rocket.Chat's
// /avatar/ route).

import { test, expect } from "../../../element-web-test";
import { KIT_USE, sidebarRoom, switchToRocketChat } from "./kit";

// 1x1 PNG
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);

test.describe("Rocket.Chat view: sidebar", () => {
    test.use(KIT_USE);

    test("shows display names, unread and mention counts, avatars", async ({ page, app, bot, user }) => {
        // Plain unreads: the body must not contain "Alice", which Element's display-name push rule highlights.
        const lunch = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(lunch);
        await bot.sendMessage(lunch, "Lunch at noon");
        await bot.sendMessage(lunch, "See you there");
        // An intentional mention (m.mentions), a highlight in Element.
        const standup = await app.client.createRoom({ name: "Daily Standup", invite: [bot.credentials!.userId] });
        await bot.joinRoom(standup);
        await bot.sendMessage(standup, {
            msgtype: "m.text",
            body: "Standup in five",
            "m.mentions": { user_ids: [user.userId] },
        } as any);
        const { content_uri: avatar } = await app.client.uploadContent(PNG, { type: "image/png" });
        await app.client.sendStateEvent(lunch, "m.room.avatar", { url: avatar }, "");

        const kit = await switchToRocketChat(page);
        await expect(sidebarRoom(kit, "Team Lunch")).toBeVisible({ timeout: 30000 });
        await expect(sidebarRoom(kit, "Daily Standup")).toBeVisible();
        // Display names, not the route slugs Rocket.Chat's `name` carries.
        await expect(kit.getByRole("link", { name: /team-lunch|daily-standup/ })).toHaveCount(0);

        // Element counts 2 plain unreads in Team Lunch and 1 mention in Daily Standup.
        await expect(kit.getByRole("status", { name: "2 unread messages from Team Lunch" })).toBeVisible({
            timeout: 30000,
        });
        await expect(kit.getByRole("status", { name: "1 mention from Daily Standup" })).toBeVisible();
        await expect(kit.getByRole("status", { name: /mention.* from Team Lunch/ })).toHaveCount(0);

        // Avatars: the room avatar from the view-model (a homeserver thumbnail that loads), an initial avatar for a
        // room without one; no request to a Rocket.Chat avatar route.
        const lunchImg = sidebarRoom(kit, "Team Lunch").locator("img").first();
        await expect(lunchImg).toHaveAttribute("src", /\/_matrix\/.*(thumbnail|download)\//, { timeout: 30000 });
        await expect
            .poll(() => lunchImg.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
            .toBe(true);
        await expect(sidebarRoom(kit, "Daily Standup").locator("img").first()).toHaveAttribute(
            "src",
            /^data:image\/svg\+xml/,
        );
        await expect(kit.locator('img[src*="/avatar/"]')).toHaveCount(0);
    });
});
