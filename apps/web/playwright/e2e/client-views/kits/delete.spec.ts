/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// M5 A12, delete own message: Alice deletes her message in Rocket.Chat's view (hover toolbar, More, Delete, Rocket.Chat's
// own confirmation); bot Bob sees the event redacted, and the row leaves the view. The redaction is Element's own client
// call (interim D16/D20; the event tile's onRemoveClick does not exist in v1.12.32).
// Failure path (D21): another user's message offers no Delete and the bridge refuses it (forbidden, also for a user with
// the power to redact); nothing happens on the homeserver and the message stays in the view.

import { type Page } from "@playwright/test";

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

test.describe("Rocket.Chat view: delete own message (A12)", () => {
    test.use(KIT_USE);

    /** Every message event of the room as Bob's client holds it: [id, redacted, body]. */
    const events = (bob: { evaluate: Function }, roomId: string): Promise<Array<[string, boolean, string | undefined]>> =>
        bob.evaluate(
            (cli: any, id: string) =>
                cli
                    .getRoom(id)
                    .getLiveTimeline()
                    .getEvents()
                    .filter((ev: any) => ev.getType() === "m.room.message")
                    .map((ev: any) => [ev.getId(), ev.isRedacted(), ev.getContent().body]),
            roomId,
        );

    const bridgeRedact = (page: Page, roomId: string, eventId: string): Promise<string> =>
        page.evaluate(
            async ([r, e]) => {
                try {
                    await (window as any).__clientViewBridge.redact(r, e);
                    return "done";
                } catch (err) {
                    return (err as any).code ?? String(err);
                }
            },
            [roomId, eventId],
        );

    test("deleting an own message redacts it for Bob and the row leaves the view", async ({ page, app, bot }) => {
        test.setTimeout(150000);
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        const { event_id: bobEvent } = await bot.sendMessage(roomId, "Lunch at noon");
        const mine = await app.client.evaluate((cli, id) => cli.sendTextMessage(id, "delete me please"), roomId);

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("delete me please")).toBeVisible({ timeout: 30000 });

        await kit.getByText("delete me please").hover();
        await kit.locator('.rcx-message-toolbar button[title="More"]').click();
        await kit.getByRole("menuitem", { name: "Delete", exact: true }).click();
        // Rocket.Chat's own confirmation (the only one: the bridge opens no dialog).
        await expect(page.locator("body > div[role=dialog], .mx_Dialog")).toHaveCount(0);
        await kit.getByRole("button", { name: "Yes, delete" }).click();

        // Bob: Alice's event is redacted on the homeserver, his own is untouched.
        await expect
            .poll(async () => (await events(bot, roomId)).find(([id]) => id === mine.event_id)?.[1], { timeout: 30000 })
            .toBe(true);
        expect((await events(bot, roomId)).find(([id]) => id === bobEvent)).toEqual([bobEvent, false, "Lunch at noon"]);

        // The view: the row is gone (not a "Message deleted" row), the other message stays.
        await expect(kit.getByText("delete me please")).toHaveCount(0, { timeout: 30000 });
        await expect(kit.getByText("Lunch at noon")).toHaveCount(1);
    });

    test("a message sent from the view is deleted by the id the view knows it by", async ({ page, app, bot }) => {
        test.setTimeout(150000);
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Lunch at noon");
        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Lunch at noon")).toBeVisible({ timeout: 30000 });

        const composer = kit.getByRole("textbox", { name: /^Message/ });
        await composer.click();
        await composer.fill("sent and gone");
        await composer.press("Enter");
        await expect(kit.getByRole("listitem", { name: /sent and gone$/ })).toHaveCount(1, { timeout: 30000 });
        await page.waitForTimeout(2000);

        await kit.getByText("sent and gone").hover();
        await kit.locator('.rcx-message-toolbar button[title="More"]').click();
        await kit.getByRole("menuitem", { name: "Delete", exact: true }).click();
        await kit.getByRole("button", { name: "Yes, delete" }).click();

        await expect
            .poll(async () => (await events(bot, roomId)).find(([, , body]) => body === "sent and gone" || body === undefined)?.[1], {
                timeout: 30000,
            })
            .toBe(true);
        await expect(kit.getByText("sent and gone")).toHaveCount(0, { timeout: 30000 });
    });

    // D21 failure path: another user's message. The room is Bob's, Alice has the power to redact (she is a moderator), and
    // still it is not hers to delete here: no Delete item, the bridge says forbidden, nothing happens.
    test("another user's message offers no Delete and the bridge refuses it, also with redact power", async ({
        page,
        app,
        bot,
    }) => {
        test.setTimeout(120000);
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const bobId = bot.credentials!.userId;
        const roomId = await bot.createRoom({
            name: "Team Lunch",
            invite: [aliceId],
            power_level_content_override: { users: { [aliceId]: 100 } },
        });
        const { event_id: bobEvent } = await bot.sendMessage(roomId, "Bob wrote this");
        await app.client.evaluate((cli, id) => cli.joinRoom(id), roomId);

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Bob wrote this")).toBeVisible({ timeout: 30000 });

        await kit.getByText("Bob wrote this").hover();
        await kit.locator('.rcx-message-toolbar button[title="More"]').click();
        await expect(kit.getByRole("menuitem", { name: "Copy text" })).toBeVisible();
        await expect(kit.getByRole("menuitem", { name: "Delete", exact: true })).toHaveCount(0);
        await page.keyboard.press("Escape");

        expect(await bridgeRedact(page, roomId, bobEvent)).toBe("forbidden");
        await page.waitForTimeout(2000);
        expect(await events(bot, roomId)).toEqual([[bobEvent, false, "Bob wrote this"]]);
        await expect(kit.getByText("Bob wrote this")).toHaveCount(1);
    });
});
