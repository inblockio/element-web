/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Increment 2, reactions: Element's reactions arrive in Rocket.Chat as its reaction row (emoji, count, "mine" for the
// user's own), read from the reactions row button view-models. Pressing them is A2 (react.spec.ts).

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

test.describe("Rocket.Chat view: reactions", () => {
    test.use(KIT_USE);

    test("shows Element reactions as Rocket.Chat's reaction row", async ({ page, app, bot }) => {
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        const { event_id: id } = await bot.sendMessage(roomId, "Lunch at noon");
        await bot.reactToMessage(roomId, null, id, "👍");
        await app.client.reactToMessage(roomId, null, id, "👍");
        await bot.reactToMessage(roomId, null, id, "🎉");

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));

        const reactions = kit.locator(".rcx-message-reactions__reaction:not(.rcx-message-reactions__reaction--action)");
        await expect(reactions).toHaveCount(2, { timeout: 30000 });
        const thumbs = reactions.filter({ hasText: "👍" });
        await expect(thumbs.locator(".rcx-message-reactions__counter")).toHaveText("2");
        await expect(thumbs).toHaveClass(/rcx-message-reactions__reaction--mine/);
        const other = reactions.filter({ hasText: "🎉" });
        await expect(other.locator(".rcx-message-reactions__counter")).toHaveText("1");
        await expect(other).not.toHaveClass(/rcx-message-reactions__reaction--mine/);
        // A2: the chips and the add button are wired (react.spec.ts presses them), so the overlay leaves them alone.
        await expect(kit.locator(".rcx-message-reactions__reaction--action").first()).not.toHaveAttribute("aria-disabled", "true");
        await expect(thumbs).not.toHaveAttribute("aria-disabled", "true");
        await expect(thumbs).not.toHaveAttribute("inert", "");
        // The hover toolbar: its react buttons are wired, its other items (reply, thread, more) stay under the overlay.
        await kit.getByText("Lunch at noon").hover();
        const toolbar = kit.locator(".rcx-message-toolbar").first();
        await expect(toolbar).not.toHaveAttribute("aria-disabled", "true");
        await expect(toolbar.locator('button[title="Add reaction"]')).not.toHaveAttribute("aria-disabled", "true");
        await expect(toolbar.locator('button[aria-disabled="true"]').first()).toBeVisible();
    });

    test("a reaction key without an emoji name shows as its own text, escaped (kit inc2 F2)", async ({ page, app, bot }) => {
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        const { event_id: id } = await bot.sendMessage(roomId, "Lunch at noon");
        await bot.reactToMessage(roomId, null, id, "lol");
        await bot.reactToMessage(roomId, null, id, "<b>x</b>");

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));

        const reactions = kit.locator(".rcx-message-reactions__reaction:not(.rcx-message-reactions__reaction--action)");
        await expect(reactions).toHaveCount(2, { timeout: 30000 });
        await expect(reactions.filter({ hasText: "lol" }).locator(".rcx-message-reactions__counter")).toHaveText("1");
        // The chip is named by the raw key and injects no markup. Its visible text shows the key's entities (`&lt;b&gt;`):
        // Rocket.Chat hands the rendered emoji's innerHTML to React as text (renderEmoji.ts), a cosmetic upstream limit.
        const hostile = kit.getByRole("button", { name: "Reacted with <b>x</b>" });
        await expect(hostile).toHaveCount(1);
        await expect(hostile.locator("b")).toHaveCount(0);
    });
});
