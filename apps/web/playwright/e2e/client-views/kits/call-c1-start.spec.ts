/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Lane CALL, C1 (start): a room member presses the room header's video call button in a group room (Rocket.Chat's own
// button and its own "Start a call" popup) and Rocket.Chat opens the call app on that room: <Meet>/#/room/<room id>. The
// call app (aqua-meet, not in testcontainers: the test serves the address) starts the Matrix call there. D21: the
// kit writes nothing to the homeserver (no call membership of Alice), the call app does.

import { test, expect } from "../../../element-web-test";
import { Bot } from "../../../pages/bot";
import { clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";
import { CALL_USE, MEET_USE, callMembersOnServer, meetRoomUrl, serveMeetStub } from "./call";

test.use(CALL_USE);

test.describe("Rocket.Chat view: start a call", () => {
    test.use(MEET_USE);

    test("the header video call button opens the call app on the room, in the window Rocket.Chat names", async ({
        page,
        app,
        bot,
        homeserver,
        user,
    }) => {
        test.setTimeout(120000);
        const stub = await serveMeetStub(page.context());
        const charlie = new Bot(page, homeserver, { displayName: "Charlie", autoAcceptInvites: true });
        await charlie.prepareClient();
        const roomId = await app.client.createRoom({
            name: "Team Call",
            invite: [bot.credentials!.userId, charlie.credentials!.userId],
        });
        await bot.joinRoom(roomId);
        await charlie.joinRoom(roomId);
        await bot.sendMessage(roomId, "Before the call");

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Call"));
        await expect(kit.getByText("Before the call")).toBeVisible({ timeout: 30000 });

        // Rocket.Chat's own button (featured in the room header), then its own "Start a call" popup.
        const button = kit.getByRole("button", { name: "Video call" });
        await expect(button).toBeVisible({ timeout: 30000 });
        await button.click();
        const popupPromise = page.waitForEvent("popup", { timeout: 30000 });
        await kit.getByRole("button", { name: "Start call" }).click();
        const popup = await popupPromise;
        await popup.waitForLoadState();

        expect(popup.url()).toBe(meetRoomUrl(roomId));
        expect(stub.hits()).toBeGreaterThan(0);
        // Rocket.Chat's named conference window (reused by the next call), not a tab of its own each time.
        expect(await popup.evaluate(() => window.name)).toBe("rocketchat-conference");
        // The window escapes the kit's sandbox: the call app is another site (a sandboxed window cannot show a dialog).
        popup.once("dialog", (dialog) => void dialog.accept());
        await expect.poll(() => popup.evaluate(() => (window as any).__meetDialog), { timeout: 10000 }).toBe(true);

        // D21: the kit writes nothing to the homeserver; the call is the call app's to start.
        const second = await homeserver.loginUser(user.userId, user.password!);
        expect(await callMembersOnServer(second, roomId)).toEqual([]);
    });
});
