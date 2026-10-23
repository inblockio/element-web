/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Lane CALL, C4 (ended): everyone leaves (the bot's member state becomes empty, as a client's hang-up writes it) and the
// card moves to Rocket.Chat's ended state. The state is Element's (RootCallTileViewModel switches to its tombstone tile),
// never the kit's own judgment (D21). Rocket.Chat's 8.9 ended card shows "Call ended" and no duration (its VideoConfMessage
// has none), and no Element view-model carries a duration or an end time for an ended call.

import { test, expect } from "../../../element-web-test";
import { Bot } from "../../../pages/bot";
import { KIT_FRAME, KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";
import { CALL_USE, CARD, declineCall, leaveCall, memberOnServer, startCall } from "./call";

test.use(CALL_USE);

test.describe("Rocket.Chat view: the ended call card", () => {
    test.use(KIT_USE);

    test("when everyone has left, the card is Rocket.Chat's ended card, as Element's view-models say", async ({
        page,
        app,
        bot,
        homeserver,
        user,
    }) => {
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

        await startCall(bot, roomId);
        const card = kit.locator(CARD);
        await expect(card.getByText("Call ongoing")).toBeVisible({ timeout: 30000 });

        await leaveCall(bot, roomId);

        // D21, homeserver: nobody is in the call any more.
        const second = await homeserver.loginUser(user.userId, user.password!);
        expect(await memberOnServer(second, roomId, bot)).toEqual({});

        // The card is the ended one: no Join, no ongoing state.
        await expect(card.getByText("Call ended")).toBeVisible({ timeout: 30000 });
        await expect(card.getByText("Call ongoing")).toHaveCount(0);
        await expect(card.getByRole("button", { name: "Join" })).toHaveCount(0);
        await expect(kit.locator(CARD)).toHaveCount(1);

        // D21, second client: stock Element in the same session shows the same end (its tombstone tile).
        await clickPastToasts(page, kit.getByRole("button", { name: "User menu", exact: true }));
        await kit.getByRole("menuitemcheckbox", { name: "Switch to Element" }).click();
        await expect(page.locator(KIT_FRAME)).toHaveCount(0);
        await app.viewRoomById(roomId);
        await expect(page.getByText("Group call ended")).toBeVisible({ timeout: 30000 });
        await expect(page.getByTestId("join-call-button")).toHaveCount(0);
    });

    test("a declined call in a two-member room (a DM) is the ended card that says it was not answered", async ({
        page,
        app,
        bot,
    }) => {
        test.setTimeout(120000);
        const roomId = await app.client.createRoom({ name: "Bob and Alice", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await app.client.setPowerLevel(roomId, bot.credentials!.userId, 50);
        await bot.sendMessage(roomId, "Hello Alice");
        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Bob and Alice"));
        await expect(kit.getByText("Hello Alice")).toBeVisible({ timeout: 30000 });

        const callId = await startCall(bot, roomId);
        const card = kit.locator(CARD);
        await expect(card.getByText("Call ongoing")).toBeVisible({ timeout: 30000 });

        // The caller's side ends it: Element's DM tombstone says "declined" once a decline refers to the call.
        await declineCall(bot, roomId, callId);
        await leaveCall(bot, roomId);
        await expect(card.getByText("Call ended")).toBeVisible({ timeout: 30000 });
        await expect(card.getByText("Call was not answered")).toBeVisible();
        await expect(card.getByRole("button", { name: "Join" })).toHaveCount(0);

        // D21, second client: stock Element shows the declined tile.
        await clickPastToasts(page, kit.getByRole("button", { name: "User menu", exact: true }));
        await kit.getByRole("menuitemcheckbox", { name: "Switch to Element" }).click();
        await app.viewRoomById(roomId);
        await expect(page.getByText(/Call declined|You declined a call/)).toBeVisible({ timeout: 30000 });
    });
});
