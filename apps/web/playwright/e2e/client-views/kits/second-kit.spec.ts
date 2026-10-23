/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Journey of the second kit (Fixture List), written from docs/KIT-API.md section 5: switch through the user menu,
// read the room list and a timeline through the bridge, open a room by clicking it, switch back to stock Element.
// Copied into the Element worktree next to ./kit.ts by tools/e2e.sh and run against a composed app (BASE_URL).

import { test, expect } from "../../../element-web-test";
import { clickPastToasts } from "./kit";

const NAME = "Fixture List";
const FRAME = `iframe[title="${NAME}"]`;

test.describe("Fixture List kit: journey", () => {
    test.use({
        displayName: "Alice",
        botCreateOpts: { displayName: "Bob" },
        labsFlags: ["feature_client_views"],
        config: {
            client_views: [
                { id: "rocketchat", name: "Rocket.Chat", url: "/kits/rocketchat/index.html" },
                { id: "fixture-list", name: NAME, url: "/kits/fixture-list/index.html" },
            ],
        } as object,
    });

    test("lists rooms and messages through the bridge, opens a room by click, switches back to Element", async ({
        page,
        app,
        bot,
    }) => {
        const lunch = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(lunch);
        await bot.sendMessage(lunch, "Hi Alice!");
        const dinner = await app.client.createRoom({ name: "Team Dinner", invite: [bot.credentials!.userId] });
        await bot.joinRoom(dinner);
        await bot.sendMessage(dinner, "Pasta tonight");

        await page.getByRole("button", { name: "User menu", exact: true }).click();
        await page.getByRole("menuitem", { name: `Switch to ${NAME}` }).click();
        const kit = page.frameLocator(FRAME);

        // Room list: each room's name, as plain list items.
        const list = kit.getByTestId("room-list");
        await expect(list).toBeVisible({ timeout: 30000 });
        const lunchItem = list.getByTestId("room-item").filter({ hasText: "Team Lunch" });
        const dinnerItem = list.getByTestId("room-item").filter({ hasText: "Team Dinner" });
        await expect(lunchItem.getByTestId("room-name")).toHaveText("Team Lunch", { timeout: 30000 });
        await expect(dinnerItem.getByTestId("room-name")).toHaveText("Team Dinner");

        // Nothing is selected yet.
        await expect(kit.getByTestId("no-room")).toBeVisible();

        // Open a room through the bridge by clicking it: sender and body of the bot's message.
        await clickPastToasts(page, lunchItem);
        await expect(lunchItem).toHaveAttribute("aria-current", "true");
        const message = kit.getByTestId("timeline").getByTestId("message").filter({ hasText: "Hi Alice!" });
        await expect(message).toBeVisible({ timeout: 30000 });
        await expect(message.getByTestId("message-sender")).toHaveText("Bob");
        await expect(message.getByTestId("message-body")).toHaveText("Hi Alice!");

        // Open the other room: the timeline follows the selection.
        await clickPastToasts(page, dinnerItem);
        await expect(dinnerItem).toHaveAttribute("aria-current", "true");
        await expect(kit.getByTestId("message-body").filter({ hasText: "Pasta tonight" })).toBeVisible({
            timeout: 30000,
        });
        await expect(kit.getByTestId("message-body").filter({ hasText: "Hi Alice!" })).toHaveCount(0);

        // Back to stock Element through the kit's own view switcher (bridge.switchTo("stock")).
        await clickPastToasts(page, kit.locator('[data-testid="view-switch"][data-view-id="stock"]'));
        await expect(page.locator(FRAME)).toHaveCount(0);
        await expect(page.getByRole("button", { name: "User menu", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
    });
});
