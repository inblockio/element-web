/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// M5 A3, reply to a message: Alice quotes Bob's message in Rocket.Chat's view (the toolbar's "Quote") and sends; bot Bob
// sees a plain `m.text` that carries the Matrix reply relation to his event (no permalink in the text). The reply goes
// through the replied event's action bar view-model (onReplyClick) and Element's own client send (D22, interim D16).
// Failure path (D21): a refused reply reaches nobody, leaves no row in the view, and the text comes back to the composer.

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

test.describe("Rocket.Chat view: reply (A3)", () => {
    test.use(KIT_USE);

    /** The messages in the room as Bob's client holds them. */
    const messages = (bob: { evaluate: Function }, roomId: string): Promise<any[]> =>
        bob.evaluate(
            (cli: any, id: string) =>
                cli
                    .getRoom(id)
                    .getLiveTimeline()
                    .getEvents()
                    .filter((ev: any) => ev.getType() === "m.room.message")
                    .map((ev: any) => ({ id: ev.getId(), sender: ev.getSender(), content: ev.getContent() })),
            roomId,
        );

    test("quoting a message and sending it is a Matrix reply that Bob sees, shown once as a quote", async ({
        page,
        app,
        bot,
    }) => {
        test.setTimeout(120000);
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        const { event_id: bobEvent } = await bot.sendMessage(roomId, "Where shall we eat?");
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Where shall we eat?")).toBeVisible({ timeout: 30000 });

        // The Quote action of the hover toolbar puts the quote in front of the composer.
        await kit.getByText("Where shall we eat?").hover();
        await kit.locator('.rcx-message-toolbar button[title="Quote"]').click();
        const composer = kit.getByRole("textbox", { name: /^Message/ });
        await composer.click();
        await composer.fill("Pizza at noon");
        await composer.press("Enter");

        // Bob's side: Alice's event is a plain m.text replying to Bob's event; the permalink is not in the text.
        await expect
            .poll(async () => (await messages(bot, roomId)).filter((m) => m.sender === aliceId), { timeout: 30000 })
            .toEqual([
                {
                    id: expect.any(String),
                    sender: aliceId,
                    content: expect.objectContaining({
                        "msgtype": "m.text",
                        "body": "Pizza at noon",
                        "m.relates_to": { "m.in_reply_to": { event_id: bobEvent } },
                        "m.mentions": { user_ids: [bot.credentials!.userId] },
                    }),
                },
            ]);

        // The view: the reply once, with the quote of Bob's message (Rocket.Chat's quote attachment).
        const row = kit.getByRole("listitem", { name: /^Alice .*Pizza at noon/ });
        await expect(row).toHaveCount(1, { timeout: 30000 });
        await expect(kit.locator("blockquote", { hasText: "Where shall we eat?" })).toHaveCount(1, { timeout: 30000 });
        await page.waitForTimeout(3000);
        await expect(row).toHaveCount(1);
        expect((await messages(bot, roomId)).filter((m) => m.sender === aliceId)).toHaveLength(1);
    });

    test("a refused reply reaches nobody, leaves no row, and the text is back in the composer", async ({
        page,
        app,
        bot,
    }) => {
        test.setTimeout(120000);
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const bobId = bot.credentials!.userId;
        const roomId = await app.client.createRoom({ name: "Locked Room", invite: [bobId], room_version: "10" });
        await bot.joinRoom(roomId);
        await app.client.evaluate(
            async (cli, { id, alice, bob }) => {
                const pl = cli.getRoom(id)!.currentState.getStateEvents("m.room.power_levels", "")!.getContent();
                await cli.sendStateEvent(
                    id,
                    "m.room.power_levels" as any,
                    { ...pl, users: { [alice]: 50, [bob]: 100 }, events_default: 50 },
                    "",
                );
            },
            { id: roomId, alice: aliceId, bob: bobId },
        );
        await bot.sendMessage(roomId, "Room is open");

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Locked Room"));
        await expect(kit.getByText("Room is open")).toBeVisible({ timeout: 30000 });

        // Bob raises the bar above Alice, and Alice's client has the new rule before she replies.
        await bot.evaluate(async (cli, { id }) => {
            const pl = cli.getRoom(id)!.currentState.getStateEvents("m.room.power_levels", "")!.getContent();
            await cli.sendStateEvent(id, "m.room.power_levels" as any, { ...pl, events_default: 100 }, "");
        }, { id: roomId });
        await expect
            .poll(() =>
                app.client.evaluate(
                    (cli, id) =>
                        cli.getRoom(id)!.currentState.getStateEvents("m.room.power_levels", "")!.getContent().events_default,
                    roomId,
                ),
            )
            .toBe(100);

        await kit.getByText("Room is open").hover();
        await kit.locator('.rcx-message-toolbar button[title="Quote"]').click();
        const composer = kit.getByRole("textbox", { name: /^Message/ });
        await composer.click();
        await composer.fill("This reply must never arrive");
        await composer.press("Enter");

        const rows = kit.getByRole("listitem", { name: /This reply must never arrive/ });
        await expect.poll(async () => await rows.count(), { timeout: 30000 }).toBe(0);
        // The only copy of the user's text came back to the composer (the quote's permalink did not).
        await expect(composer).toHaveValue("This reply must never arrive", { timeout: 15000 });
        await page.waitForTimeout(3000);
        expect((await messages(bot, roomId)).map((m) => m.content.body)).toEqual(["Room is open"]);
        await expect(rows).toHaveCount(0);
    });
});
