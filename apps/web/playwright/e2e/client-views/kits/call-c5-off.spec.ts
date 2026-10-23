/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Lane CALL, C5 (off): the host config has no Meet address (`client_views_meet_url`). Then the Rocket.Chat view offers no
// call: no video call button in a group room's header, and a call that runs (Bob's, on the homeserver) shows Rocket.Chat's
// card with its state and without Join. The capability map (e2e/capability-map.spec.ts) stays green with this config.

import { test, expect } from "../../../element-web-test";
import { Bot } from "../../../pages/bot";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";
import { CALL_USE, CARD, startCall } from "./call";

test.use(CALL_USE);

test.describe("Rocket.Chat view: calls off", () => {
    test.use(KIT_USE);

    test("no video call button, and the call card shows without Join", async ({ page, app, bot, homeserver }) => {
        test.setTimeout(120000);
        const charlie = new Bot(page, homeserver, { displayName: "Charlie", autoAcceptInvites: true });
        await charlie.prepareClient();
        const roomId = await app.client.createRoom({
            name: "Team Call",
            invite: [bot.credentials!.userId, charlie.credentials!.userId],
        });
        await bot.joinRoom(roomId);
        await charlie.joinRoom(roomId);
        await app.client.setPowerLevel(roomId, bot.credentials!.userId, 50);
        await bot.sendMessage(roomId, "Before the call");

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Call"));
        await expect(kit.getByText("Before the call")).toBeVisible({ timeout: 30000 });
        // The header is drawn (the room's other buttons are there), the call button is not.
        await expect(kit.getByRole("button", { name: "Room Information" })).toBeVisible({ timeout: 30000 });
        await expect(kit.getByRole("button", { name: "Video call" })).toHaveCount(0);

        await startCall(bot, roomId);
        const card = kit.locator(CARD);
        await expect(card.getByText("Call ongoing")).toBeVisible({ timeout: 30000 });
        await expect(card.getByText("joined")).toBeVisible();
        await expect(card.getByRole("button", { name: "Join" })).toHaveCount(0);
        await expect(card.getByRole("button", { name: "Join" })).not.toBeVisible();
    });
});
