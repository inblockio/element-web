/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Lane CALL, C3 (join): Bob starts a call on the homeserver (as a client does, see call.ts), Alice's Rocket.Chat view shows
// Rocket.Chat's call card, and Join opens the call app on the room's link in Rocket.Chat's named window; a second Join
// focuses that same window (no second tab). Starting from the header while the call runs opens the same call (the card
// stays one, the link is the room's): no new call when one is running. D21: the call is Bob's member state on the homeserver.

import { test, expect } from "../../../element-web-test";
import { Bot } from "../../../pages/bot";
import { clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";
import { CALL_USE, CARD, MEET_USE, MEMBER_EVENT, meetRoomUrl, memberOnServer, serveMeetStub, startCall } from "./call";

test.use(CALL_USE);

test.describe("Rocket.Chat view: join a call", () => {
    test.use(MEET_USE);

    test("Join on the card opens the call app on the room, a second Join reuses the window, a start joins the running call", async ({
        page,
        app,
        bot,
        homeserver,
        user,
    }) => {
        test.setTimeout(150000);
        const stub = await serveMeetStub(page.context());
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

        await startCall(bot, roomId);
        const card = kit.locator(CARD);
        await expect(card.getByText("Call ongoing")).toBeVisible({ timeout: 30000 });
        const join = card.getByRole("button", { name: "Join" });
        await expect(join).toBeVisible();

        // First Join: the call app opens on the room.
        const firstPopup = page.waitForEvent("popup", { timeout: 30000 });
        await join.click();
        const popup = await firstPopup;
        await popup.waitForLoadState();
        expect(popup.url()).toBe(meetRoomUrl(roomId));
        expect(await popup.evaluate(() => window.name)).toBe("rocketchat-conference");
        expect(page.context().pages()).toHaveLength(2);

        // Second Join: the same window is reused, no second tab opens.
        const extra: string[] = [];
        page.context().on("page", (p) => extra.push(p.url()));
        await join.click();
        await join.click();
        await expect.poll(() => page.context().pages().length, { timeout: 5000 }).toBe(2);
        await page.waitForTimeout(1500);
        expect(page.context().pages()).toHaveLength(2);
        expect(popup.isClosed()).toBe(false);
        expect(popup.url()).toBe(meetRoomUrl(roomId));
        expect(extra, "no further page opened").toEqual([]);

        // The header button while the call runs: still the one call (one card), still the room's link, still one window.
        await kit.getByRole("button", { name: "Video call" }).click();
        await kit.getByRole("button", { name: "Start call" }).click();
        await page.waitForTimeout(1500);
        expect(page.context().pages()).toHaveLength(2);
        expect(popup.url()).toBe(meetRoomUrl(roomId));
        await expect(card).toHaveCount(1);

        // D21: the call is the homeserver's; the kit added nothing to it.
        const second = await homeserver.loginUser(user.userId, user.password!);
        expect((await memberOnServer(second, roomId, bot)).application).toBe("m.call");
        expect(MEMBER_EVENT).toBe("org.matrix.msc3401.call.member");
        expect(stub.hits()).toBeGreaterThan(0);
    });
});
