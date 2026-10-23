/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Lane CALL, C2 (card): a call runs in a room (here a bot makes it on the homeserver the way a client does; aqua-meet and
// stock Element make the same events). The Rocket.Chat view's timeline shows Rocket.Chat's own call card (ongoing, the
// participant's avatar, Join) at the call's root event, drawn from Element's call-card view-models. D21: the homeserver
// holds the call (the bot's member state, read by a second Alice session), and stock Element in the same session shows the
// same call (its room list hint and its own tile), so the card never differs from Element.

import { test, expect } from "../../../element-web-test";
import { Bot } from "../../../pages/bot";
import { clickPastToasts, sidebarRoom, switchToRocketChat, KIT_FRAME } from "./kit";
import { CALL_USE, CARD, MEET_USE, joinCall, memberOnServer, startCall } from "./call";

test.use(CALL_USE);

test.describe("Rocket.Chat view: the call card", () => {
    test.use(MEET_USE); // calls on: the card has Join (without a Meet address it has none, see call-c5-off.spec.ts)

    test("a running call is Rocket.Chat's call card with Bob as participant and Join; Element shows the same call", async ({
        page,
        app,
        bot,
        homeserver,
        user,
    }) => {
        test.setTimeout(120000);
        // Three members: a room call (a two-member room is a DM call, covered by the second test).
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
        await expect(sidebarRoom(kit, "Team Call")).toBeVisible({ timeout: 30000 });
        await clickPastToasts(page, sidebarRoom(kit, "Team Call"));
        await expect(kit.getByText("Before the call")).toBeVisible({ timeout: 30000 });
        await expect(kit.locator(CARD)).toHaveCount(0);

        const callId = await startCall(bot, roomId);

        // Rocket.Chat's own card: "Call ongoing", the Join button, the joined participant (Bob's avatar and "joined").
        const card = kit.locator(CARD);
        await expect(card).toHaveCount(1, { timeout: 30000 });
        await expect(card.getByText("Call ongoing")).toBeVisible();
        await expect(card.getByRole("button", { name: "Join" })).toBeVisible();
        await expect(card.getByText("joined")).toBeVisible();
        await expect(card.locator("img").first()).toBeVisible();
        await expect(card.getByText("Call ended")).toHaveCount(0);

        // D21, homeserver: the bot's member state holds a call (the card shows what the homeserver has).
        const second = await homeserver.loginUser(user.userId, user.password!);
        expect((await memberOnServer(second, roomId, bot)).application).toBe("m.call");
        expect(callId).toMatch(/^\$/);

        // D21, second client: stock Element in the same session shows the same call.
        await clickPastToasts(page, kit.getByRole("button", { name: "User menu", exact: true }));
        await kit.getByRole("menuitemcheckbox", { name: "Switch to Element" }).click();
        await expect(page.locator(KIT_FRAME)).toHaveCount(0);
        await expect(page.getByRole("option", { name: /Open room Team Call, video call in progress/ })).toBeVisible({
            timeout: 30000,
        });
        await app.viewRoomById(roomId);
        await expect(page.getByTestId("join-call-button").first()).toBeVisible({ timeout: 30000 });
    });

    test("a call in a two-member room (a DM call) is the card too, with Bob as participant", async ({ page, app, bot }) => {
        test.setTimeout(120000);
        const roomId = await app.client.createRoom({ name: "Bob and Alice", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await app.client.setPowerLevel(roomId, bot.credentials!.userId, 50);
        await bot.sendMessage(roomId, "Hello Alice");
        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Bob and Alice"));
        await expect(kit.getByText("Hello Alice")).toBeVisible({ timeout: 30000 });
        await startCall(bot, roomId);
        const card = kit.locator(CARD);
        await expect(card).toHaveCount(1, { timeout: 30000 });
        await expect(card.getByText("Call ongoing")).toBeVisible();
        await expect(card.getByRole("button", { name: "Join" })).toBeVisible();
    });

    test("five participants: Rocket.Chat counts all five, draws and names the first three, and invents no identity", async ({
        page,
        app,
        bot,
        homeserver,
    }) => {
        test.setTimeout(180000);
        const others = [];
        for (const displayName of ["Carol", "Dan", "Erin", "Frank"]) {
            const b = new Bot(page, homeserver, { displayName, autoAcceptInvites: true });
            await b.prepareClient();
            others.push(b);
        }
        const roomId = await app.client.createRoom({
            name: "Big Call",
            invite: [bot, ...others].map((b) => b.credentials!.userId),
        });
        for (const b of [bot, ...others]) await b.joinRoom(roomId);
        await app.client.setPowerLevel(roomId, [bot, ...others].map((b) => b.credentials!.userId), 50);
        await bot.sendMessage(roomId, "Before the call");
        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Big Call"));
        await expect(kit.getByText("Before the call")).toBeVisible({ timeout: 30000 });

        await startCall(bot, roomId);
        for (const b of others) await joinCall(b, roomId);

        const card = kit.locator(CARD);
        // Element's participant count is 5; Rocket.Chat's own count is "+ 2 joined" after its three avatars.
        await expect(card.getByText("+ 2 joined")).toBeVisible({ timeout: 30000 });
        await expect(card.locator("img")).toHaveCount(3);
        const tooltip = await card.getByText("+ 2 joined").getAttribute("title");
        console.log(`tooltip: ${JSON.stringify(tooltip)}`);
        expect(tooltip).toMatch(/ and 2 more joined$/);
        // Only real names, none of the count-only entries' (empty) text.
        expect(tooltip!.replace(/ and 2 more joined$/, "").split(", ")).toHaveLength(3);
        expect(tooltip).not.toMatch(/@|\u200b/);
    });
});
