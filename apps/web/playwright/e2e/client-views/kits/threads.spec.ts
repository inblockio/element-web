/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Increment 3, thread summary: the thread under an Element message arrives in Rocket.Chat as its own thread metrics
// (reply count, last reply, participants), read from the thread summary view-model. Element keeps the thread replies
// out of the main timeline, and so does the view. Opening the thread (and following it) is N/A.

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

test.describe("Rocket.Chat view: thread summary", () => {
    test.use(KIT_USE);

    test("shows a thread as Rocket.Chat's thread summary under its root message", async ({ page, app, bot }) => {
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        const { event_id: rootId } = await bot.sendMessage(roomId, "Lunch at noon?");
        await bot.sendMessage(roomId, "Reply one", rootId);
        await app.client.sendMessage(roomId, "Reply two", rootId);

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));

        await expect(kit.getByText("Lunch at noon?")).toBeVisible({ timeout: 30000 });
        // Rocket.Chat's own metrics: the reply count ("2 replies, <date>"; "2 replies" in a narrow list).
        const summary = kit.locator(".rcx-message-metrics__item-label", { hasText: /^2 replies/ });
        await expect(summary).toHaveCount(1, { timeout: 30000 });
        // The thread replies are not messages of the main timeline (Element keeps them in the thread).
        await expect(kit.getByText("Reply one")).toHaveCount(0);
        await expect(kit.getByText("Reply two")).toHaveCount(0);
        // Opening the thread is a navigation the bridge has no source for: Rocket.Chat's button is under the N/A overlay.
        await expect(kit.locator(".rcx-message-metrics__item button[data-mid]").first()).toHaveAttribute(
            "aria-disabled",
            "true",
        );
    });
});
