/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Rocket.Chat's message list on the timeline / event body view-models (H3b): plain text, markdown, emoji-only bodies,
// sender avatars from the member avatar view-model, read sync (opening the room clears Element's unread through a read
// receipt), the offline banner from the host's connection state.

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

// 1x1 PNG
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);

test.describe("Rocket.Chat view: message list", () => {
    test.use(KIT_USE);

    test("renders text, markdown and emoji-only bodies, clears the unread on open", async ({ page, app, bot }) => {
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Lunch at noon");
        await bot.sendMessage(roomId, {
            msgtype: "m.text",
            body: "**Bring** _snacks_",
            format: "org.matrix.custom.html",
            formatted_body: "<strong>Bring</strong> <em>snacks</em>",
        } as any);
        await bot.sendMessage(roomId, "🍕🎉");

        const kit = await switchToRocketChat(page);
        await expect(kit.getByRole("status", { name: "3 unread messages from Team Lunch" })).toBeVisible({
            timeout: 30000,
        });
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));

        await expect(kit.getByText("Lunch at noon")).toBeVisible({ timeout: 30000 });
        await expect(kit.locator("strong", { hasText: "Bring" })).toBeVisible();
        await expect(kit.locator("em", { hasText: "snacks" })).toBeVisible();
        // Emoji-only: a JSX body in the view-model snapshot, the bridge must still hand over its text.
        await expect(kit.getByText(/🍕\s*🎉/).or(kit.getByRole("img", { name: /pizza/i })).first()).toBeVisible();

        // Read sync: Rocket.Chat's read marker -> an Element read receipt -> the room list view-model drops the unread.
        await expect(kit.getByRole("status", { name: /from Team Lunch/ })).toHaveCount(0, { timeout: 30000 });
        const unread = await page.evaluate((id) => {
            const room = (window as any).mxMatrixClientPeg.get().getRoom(id);
            return room.getUnreadNotificationCount("total") as number;
        }, roomId);
        expect(unread).toBe(0);
    });

    test("shows Rocket.Chat's offline banner while the host has lost its connection", async ({ page, app, bot }) => {
        // Element only reports a lost connection after its in-flight /sync long-poll and a few failed retries.
        test.setTimeout(240000);
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Lunch at noon");

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Lunch at noon")).toBeVisible({ timeout: 30000 });
        await expect(kit.getByText("You’re offline")).toHaveCount(0);

        await page.route("**/_matrix/client/*/sync*", (route) => route.abort("internetdisconnected"));
        await page.context().setOffline(true);
        const states = async () =>
            page.evaluate(() => ({
                sync: (window as any).mxMatrixClientPeg.get().getSyncState(),
                bridge: (document.querySelector('iframe[title="Rocket.Chat"]') as any)?.contentWindow?.__clientViewBridge?.connection(),
            }));
        for (let i = 0; i < 18 && process.env.KIT_DIAG; i++) {
            console.log(`offline diag ${i * 5}s: ${JSON.stringify(await states())}`);
            await page.waitForTimeout(5000);
        }
        await expect(kit.getByText("You’re offline")).toBeVisible({ timeout: 90000 });

        await page.context().setOffline(false);
        await page.unroute("**/_matrix/client/*/sync*");
        await expect(kit.getByText("You’re offline")).toHaveCount(0, { timeout: 90000 });
    });

    test("shows sender avatars from the member avatar view-model, loaded with media auth", async ({ page, app, bot }) => {
        // The bot's profile avatar lands in its member event when it joins.
        const { content_uri: avatar } = await bot.uploadContent(PNG, { type: "image/png" });
        await bot.setAvatarUrl(avatar);
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Lunch at noon");

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        const message = kit.getByRole("listitem").filter({ hasText: "Lunch at noon" });
        await expect(message).toBeVisible({ timeout: 30000 });
        // A homeserver thumbnail (authenticated media: it only loads through the host's service-worker relay).
        const img = message.locator(`img[data-username="${bot.credentials!.userId}"]`);
        await expect(img).toHaveAttribute("src", /\/_matrix\/.*(thumbnail|download)\//, { timeout: 30000 });
        await expect
            .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
            .toBe(true);
    });
});
