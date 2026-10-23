/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// M5 A2, toggle a reaction and add one with Element's picker: the user does it in the Rocket.Chat view and Bob (a bot on
// the same homeserver) sees the annotation. The chip press is the reactions row button view-model's click; "+" opens
// Element's own reaction picker over the kit (D17).

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

test.describe("Rocket.Chat view: reacting (A2)", () => {
    test.use(KIT_USE);

    /** The annotations on an event as the homeserver holds them: [sender, key], redacted ones are not listed. */
    const annotations = async (bob: { evaluate: Function }, roomId: string, eventId: string): Promise<string[][]> =>
        bob.evaluate(
            async (cli: any, { roomId, eventId }: { roomId: string; eventId: string }) => {
                const { events } = await cli.relations(roomId, eventId, "m.annotation", "m.reaction");
                return events
                    .map((e: any) => [e.getSender(), e.getContent()["m.relates_to"].key])
                    .sort((a: string[], b: string[]) => (a.join() < b.join() ? -1 : 1));
            },
            { roomId, eventId },
        );

    test("pressing a reaction chip adds the user's reaction for Bob, and pressing it again takes it back", async ({
        page,
        app,
        bot,
    }) => {
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        const { event_id: id } = await bot.sendMessage(roomId, "Lunch at noon");
        await bot.reactToMessage(roomId, null, id, "👍");
        const bobId = bot.credentials!.userId;
        const aliceId = (await app.client.evaluate((cli) => cli.getUserId()))!;

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));

        const chip = kit
            .locator(".rcx-message-reactions__reaction:not(.rcx-message-reactions__reaction--action)")
            .filter({ hasText: "👍" });
        const counter = chip.locator(".rcx-message-reactions__counter");
        await expect(counter).toHaveText("1", { timeout: 30000 });
        await expect(chip).not.toHaveClass(/rcx-message-reactions__reaction--mine/);

        await chip.click();
        await expect(counter).toHaveText("2", { timeout: 15000 });
        await expect(chip).toHaveClass(/rcx-message-reactions__reaction--mine/);
        await expect
            .poll(() => annotations(bot, roomId, id), { timeout: 15000 })
            .toEqual(
                [
                    [aliceId, "👍"],
                    [bobId, "👍"],
                ].sort((a, b) => (a.join() < b.join() ? -1 : 1)),
            );

        await chip.click();
        await expect(counter).toHaveText("1", { timeout: 15000 });
        await expect(chip).not.toHaveClass(/rcx-message-reactions__reaction--mine/);
        await expect.poll(() => annotations(bot, roomId, id), { timeout: 15000 }).toEqual([[bobId, "👍"]]);
    });

    test("the + of the reactions row opens Element's reaction picker over the kit, and the chosen emoji reaches Bob", async ({
        page,
        app,
        bot,
    }) => {
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        const { event_id: id } = await bot.sendMessage(roomId, "Lunch at noon");
        await bot.reactToMessage(roomId, null, id, "👍");
        const aliceId = (await app.client.evaluate((cli) => cli.getUserId()))!;

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.locator(".rcx-message-reactions__reaction--mine")).toHaveCount(0, { timeout: 30000 });
        await kit.getByText("Lunch at noon").hover();
        await kit.locator(".rcx-message-reactions__reaction--action").first().click();

        // Element's picker, in the host page (not in the kit frame), above the frame: Playwright clicks only a target that
        // receives the pointer, so choosing an emoji proves the menu paints above the iframe and takes clicks.
        const picker = page.getByRole("region", { name: "Emoji picker" });
        await expect(picker).toBeVisible();
        await expect(kit.getByRole("region", { name: "Emoji picker" })).toHaveCount(0);
        await page.screenshot({ path: test.info().outputPath("picker-above-kit.png") });
        await picker.getByRole("textbox", { name: "Search" }).fill("party popper");
        await picker.getByRole("checkbox", { name: "🎉" }).first().click();
        await expect(picker).toHaveCount(0);

        const mine = kit
            .locator(".rcx-message-reactions__reaction--mine")
            .filter({ has: kit.locator(".rcx-message-reactions__counter", { hasText: "1" }) });
        await expect(mine).toHaveCount(1, { timeout: 15000 });
        await expect
            .poll(async () => (await annotations(bot, roomId, id)).filter(([sender]) => sender === aliceId), {
                timeout: 15000,
            })
            .toEqual([[aliceId, "🎉"]]);
    });

    // D21: the homeserver is the source of truth. Bob created the room and holds the power: reacting needs level 50 and
    // Alice has none, so her press is refused. Nothing may reach the homeserver and the view may keep no ghost.
    test("a refused reaction (power levels) leaves nothing on the homeserver and no ghost chip or count in the view", async ({
        page,
        app,
        bot,
    }) => {
        const bobId = bot.credentials!.userId;
        const aliceId = (await app.client.evaluate((cli) => cli.getUserId()))!;
        const roomId = await bot.createRoom({
            name: "Team Lunch",
            invite: [aliceId],
            power_level_content_override: { events: { "m.reaction": 50 } },
        });
        await app.client.joinRoom(roomId);
        const { event_id: id } = await bot.sendMessage(roomId, "Lunch at noon");
        await bot.reactToMessage(roomId, null, id, "👍");

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        const chip = kit
            .locator(".rcx-message-reactions__reaction:not(.rcx-message-reactions__reaction--action)")
            .filter({ hasText: "👍" });
        const counter = chip.locator(".rcx-message-reactions__counter");
        await expect(counter).toHaveText("1", { timeout: 30000 });

        await chip.click();
        // The press is settled (refused) well within this window; the view then shows the homeserver's state again.
        await page.waitForTimeout(4000);
        await expect(counter).toHaveText("1");
        await expect(chip).not.toHaveClass(/rcx-message-reactions__reaction--mine/);
        await expect(kit.locator(".rcx-message-reactions__reaction--mine")).toHaveCount(0);
        expect(await annotations(bot, roomId, id)).toEqual([[bobId, "👍"]]);

        // The same for the picker's route: nothing opens, nothing is added.
        await kit.getByText("Lunch at noon").hover();
        const add = kit.locator(".rcx-message-reactions__reaction--action").first();
        if (await add.isVisible()) {
            await add.click();
            await page.waitForTimeout(1500);
            await expect(page.getByRole("region", { name: "Emoji picker" })).toHaveCount(0);
        }
        await expect(kit.locator(".rcx-message-reactions__reaction--mine")).toHaveCount(0);
        expect(await annotations(bot, roomId, id)).toEqual([[bobId, "👍"]]);
    });
});
