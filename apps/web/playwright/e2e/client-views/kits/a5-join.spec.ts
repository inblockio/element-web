/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// M5 A5, join a room by its address and accept or decline an invite, in the Rocket.Chat view. Bot Bob owns the rooms:
// the sidebar search lists an exact `#alias:server` and its Join joins; an invite is Rocket.Chat's invite screen with
// Accept and Reject. D21: the effect is what Bob sees on the homeserver (Alice's membership); an unknown address, a room
// that refuses her, or a refused accept leave her out of the room and the view without a ghost entry.

import { type FrameLocator, type Page } from "@playwright/test";

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

/** Types an address into the sidebar search and opens the one room it lists (Rocket.Chat's "channel not joined" screen). */
async function openByAddress(page: Page, kit: FrameLocator, address: string): Promise<void> {
    const search = kit.locator('[role="search"] input').first();
    await clickPastToasts(page, search);
    await search.fill(address);
    await kit.getByRole("option", { name: new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click({ timeout: 30000 });
}

const membershipOf = (bot: any, roomId: string, userId: string) =>
    bot.evaluate((cli: any, { id, user }: { id: string; user: string }) => cli.getRoom(id)?.getMember(user)?.membership ?? "none", {
        id: roomId,
        user: userId,
    });

test.describe("Rocket.Chat view: join a room and answer an invite", () => {
    test.use(KIT_USE);

    test("joins a public room by its address; Bob sees Alice join and the room opens", async ({ page, app, bot }) => {
        test.setTimeout(Number(process.env.PW_TEST_TIMEOUT ?? 300000));
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const domain = aliceId.split(":")[1];
        const roomId = await bot.createRoom({
            name: "Public Lobby",
            room_alias_name: "lobby-a5",
            visibility: "public" as any,
            preset: "public_chat" as any,
        });
        await bot.sendMessage(roomId, "welcome to the lobby");

        const kit = await switchToRocketChat(page);
        await openByAddress(page, kit, `#lobby-a5:${domain}`);
        await expect(kit.getByText("Channel not joined")).toBeVisible({ timeout: 30000 });
        expect(await membershipOf(bot, roomId, aliceId)).not.toBe("join");
        await kit.getByRole("button", { name: "Join channel" }).click();

        // The homeserver holds the join; the room is in the sidebar, open, with its history.
        await expect.poll(() => membershipOf(bot, roomId, aliceId), { timeout: 30000 }).toBe("join");
        await expect(sidebarRoom(kit, "Public Lobby")).toBeVisible({ timeout: 30000 });
        await expect(kit.getByText("welcome to the lobby")).toBeVisible({ timeout: 30000 });
        expect(await app.client.evaluate((cli, id) => cli.getRoom(id)?.getMyMembership(), roomId)).toBe("join");
    });

    test("an address nobody owns joins nothing and leaves no entry", async ({ page, app, bot }) => {
        test.setTimeout(Number(process.env.PW_TEST_TIMEOUT ?? 300000));
        void bot; // the bot fixture signs Alice in first
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const domain = aliceId.split(":")[1];
        const before = await app.client.evaluate((cli) => cli.getRooms().length);
        const kit = await switchToRocketChat(page);
        await openByAddress(page, kit, `#nobody-a5:${domain}`);
        await kit.getByRole("button", { name: "Join channel" }).click();
        await expect(kit.getByRole("alert").first()).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(2000);
        expect(await app.client.evaluate((cli) => cli.getRooms().length)).toBe(before);
        await expect(kit.getByRole("link", { name: /nobody/i })).toHaveCount(0);
    });

    test("a room that refuses Alice stays unjoined: Bob does not see her in it, the view has no entry", async ({ page, app, bot }) => {
        test.setTimeout(Number(process.env.PW_TEST_TIMEOUT ?? 300000));
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const domain = aliceId.split(":")[1];
        const roomId = await bot.createRoom({ name: "Closed Door", room_alias_name: "closed-a5", preset: "private_chat" as any });
        const kit = await switchToRocketChat(page);
        await openByAddress(page, kit, `#closed-a5:${domain}`);
        await kit.getByRole("button", { name: "Join channel" }).click();
        await expect(kit.getByRole("alert").first()).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(2000);
        expect(await membershipOf(bot, roomId, aliceId)).not.toBe("join");
        expect(await app.client.evaluate((cli, id) => cli.getRoom(id)?.getMyMembership() ?? "none", roomId)).not.toBe("join");
        await expect(sidebarRoom(kit, "Closed Door")).toHaveCount(0);
    });

    test("accepts an invite on Rocket.Chat's invite screen; Bob sees Alice join", async ({ page, app, bot }) => {
        test.setTimeout(Number(process.env.PW_TEST_TIMEOUT ?? 300000));
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const roomId = await bot.createRoom({ name: "Invite Only", preset: "private_chat" as any });
        await bot.evaluate((cli, { id, alice }) => cli.invite(id, alice), { id: roomId, alice: aliceId });

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Invite Only"));
        await expect(kit.getByText("Message request")).toBeVisible({ timeout: 30000 });
        expect(await membershipOf(bot, roomId, aliceId)).toBe("invite");
        await kit.getByRole("button", { name: "Accept" }).click();

        await expect.poll(() => membershipOf(bot, roomId, aliceId), { timeout: 30000 }).toBe("join");
        await expect(kit.getByText("Message request")).toHaveCount(0, { timeout: 30000 });
        // The room is open in the view: what Bob writes now arrives in it.
        await bot.sendMessage(roomId, "see you inside");
        await expect(kit.getByText("see you inside")).toBeVisible({ timeout: 30000 });
        expect(await app.client.evaluate((cli, id) => cli.getRoom(id)?.getMyMembership(), roomId)).toBe("join");
    });

    test("declines an invite after Rocket.Chat's confirm; Bob sees Alice's invite withdrawn and the room leaves the sidebar", async ({ page, app, bot }) => {
        test.setTimeout(Number(process.env.PW_TEST_TIMEOUT ?? 300000));
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const roomId = await bot.createRoom({ name: "Unwanted", preset: "private_chat" as any });
        await bot.evaluate((cli, { id, alice }) => cli.invite(id, alice), { id: roomId, alice: aliceId });

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Unwanted"));
        await kit.getByRole("button", { name: "Reject", exact: true }).click();
        await kit.getByRole("button", { name: "Reject invitation" }).click();

        await expect.poll(() => membershipOf(bot, roomId, aliceId), { timeout: 30000 }).toBe("leave");
        await expect(sidebarRoom(kit, "Unwanted")).toHaveCount(0, { timeout: 30000 });
        expect(await app.client.evaluate((cli, id) => cli.getRoom(id)?.getMyMembership() ?? "none", roomId)).not.toBe("join");
    });

    test("an accept the homeserver refuses keeps the invite and Alice out of the room", async ({ page, app, bot }) => {
        test.setTimeout(Number(process.env.PW_TEST_TIMEOUT ?? 300000));
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const roomId = await bot.createRoom({ name: "Refused Join", preset: "private_chat" as any });
        await bot.evaluate((cli, { id, alice }) => cli.invite(id, alice), { id: roomId, alice: aliceId });
        await page.route(/\/_matrix\/client\/v3\/join\//, (route) =>
            route.fulfill({
                status: 403,
                contentType: "application/json",
                body: JSON.stringify({ errcode: "M_FORBIDDEN", error: "You may not join" }),
            }),
        );

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Refused Join"));
        await kit.getByRole("button", { name: "Accept" }).click();
        await expect(kit.getByRole("alert").first()).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(2000);
        // Still an invite: for Bob, for Element, and on Rocket.Chat's screen.
        expect(await membershipOf(bot, roomId, aliceId)).toBe("invite");
        expect(await app.client.evaluate((cli, id) => cli.getRoom(id)?.getMyMembership(), roomId)).toBe("invite");
        await expect(kit.getByText("Message request")).toBeVisible();
    });
});
