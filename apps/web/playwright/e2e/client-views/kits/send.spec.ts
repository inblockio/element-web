/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// M5 A1, send a text message: Alice types in Rocket.Chat's composer and sends; bot Bob receives it as a plain `m.text`
// on the Matrix side, and the kit shows exactly one row for it (Rocket.Chat's optimistic copy is replaced by the
// confirmed message, never joined by a second row).

import { test, expect } from "../../../element-web-test";
import { KIT_FRAME, KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

test.describe("Rocket.Chat view: send a text message", () => {
    test.use(KIT_USE);

    test("sends the composer's text to Matrix and shows one row for it", async ({ page, app, bot }) => {
        test.setTimeout(120000);
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Lunch at noon");
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Lunch at noon")).toBeVisible({ timeout: 30000 });

        const text = "Hello from Rocket.Chat *plain* 1";
        const composer = kit.getByRole("textbox", { name: /^Message/ });
        await composer.click();
        await composer.fill(text);
        await kit.getByRole("button", { name: "Send", exact: true }).click();

        // Bob receives it on the Matrix side: one m.text from Alice, the text unchanged (no markdown conversion).
        const received = () =>
            bot.evaluate(
                (cli, id) =>
                    cli
                        .getRoom(id)!
                        .getLiveTimeline()
                        .getEvents()
                        .filter((ev) => ev.getType() === "m.room.message")
                        .map((ev) => ({ sender: ev.getSender(), ...ev.getContent() })),
                roomId,
            );
        await expect
            .poll(async () => (await received()).filter((c) => c.body === text), { timeout: 30000 })
            .toEqual([{ sender: aliceId, msgtype: "m.text", body: text }]);

        // The kit shows the message once, also after the echo has had time to arrive (no second row).
        // (Rocket.Chat renders the *plain* markdown of its own message; the row's accessible name carries the words.)
        const row = kit.getByRole("listitem", { name: /^Alice .*Hello from Rocket\.Chat plain 1$/ });
        await expect(row).toHaveCount(1, { timeout: 30000 });
        await page.waitForTimeout(3000);
        await expect(row).toHaveCount(1);
        expect((await received()).filter((c) => c.body === text)).toHaveLength(1);

        // The composer was cleared, and a second message goes through the same path.
        await expect(composer).toHaveValue("");
        await composer.fill("second");
        await composer.press("Enter");
        await expect.poll(async () => (await received()).map((c) => c.body), { timeout: 30000 }).toContain("second");
        await expect(kit.getByRole("listitem", { name: /second$/ })).toHaveCount(1);
        await expect(page.locator(KIT_FRAME)).toBeVisible();
    });
    // D21 failure path: the homeserver refuses the send (Alice's power level is below `events_default`). The truth is the
    // homeserver: Bob never gets the text, not even later. The Rocket.Chat view keeps no ghost of the optimistic copy.
    test("a refused send reaches nobody and leaves no ghost row", async ({ page, app, bot }) => {
        test.setTimeout(120000);
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const bobId = bot.credentials!.userId;
        const roomId = await app.client.createRoom({
            name: "Locked Room",
            invite: [bobId],
            room_version: "10",
        });
        await bot.joinRoom(roomId);
        // Alice steps down to 50 and makes Bob the admin; messages need 50, so she can still write for now.
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

        // Bob raises the bar above Alice, and Alice's client has the new rule before she sends.
        await bot.evaluate(
            async (cli, { id }) => {
                const room = cli.getRoom(id)!;
                const pl = room.currentState.getStateEvents("m.room.power_levels", "")!.getContent();
                await cli.sendStateEvent(id, "m.room.power_levels" as any, { ...pl, events_default: 100 }, "");
            },
            { id: roomId },
        );
        await expect
            .poll(() =>
                app.client.evaluate(
                    (cli, id) =>
                        cli.getRoom(id)!.currentState.getStateEvents("m.room.power_levels", "")!.getContent().events_default,
                    roomId,
                ),
            )
            .toBe(100);

        const refused = "This must never arrive 1";
        const composer = kit.getByRole("textbox", { name: /^Message/ });
        await composer.click();
        await composer.fill(refused);
        await kit.getByRole("button", { name: "Send", exact: true }).click();

        const received = () =>
            bot.evaluate(
                (cli, id) =>
                    cli
                        .getRoom(id)!
                        .getLiveTimeline()
                        .getEvents()
                        .filter((ev) => ev.getType() === "m.room.message")
                        .map((ev) => ev.getContent().body as string),
                roomId,
            );
        const rows = kit.getByRole("listitem", { name: /This must never arrive 1$/ });
        // Whatever Rocket.Chat does with a rejected send, it settles: no row, or a row it marks as failed.
        await expect
            .poll(async () => (await rows.count()) === 0 || (await kit.getByText(/failed|not sent|retry/i).count()) > 0, {
                timeout: 30000,
            })
            .toBe(true);
        // The refused text is not lost with the cleared composer: it is back (Rocket.Chat keeps no failed message).
        await expect(composer).toHaveValue(refused, { timeout: 15000 });
        await page.waitForTimeout(3000);
        expect(await received()).not.toContain(refused);

        // The queue is not blocked by the refused send, and the refused text is not delivered later either.
        await bot.evaluate(
            async (cli, { id }) => {
                const room = cli.getRoom(id)!;
                const pl = room.currentState.getStateEvents("m.room.power_levels", "")!.getContent();
                await cli.sendStateEvent(id, "m.room.power_levels" as any, { ...pl, events_default: 50 }, "");
            },
            { id: roomId },
        );
        await expect
            .poll(() =>
                app.client.evaluate(
                    (cli, id) =>
                        cli.getRoom(id)!.currentState.getStateEvents("m.room.power_levels", "")!.getContent().events_default,
                    roomId,
                ),
            )
            .toBe(50);
        await composer.fill("after the refusal");
        await composer.press("Enter");
        await expect.poll(async () => await received(), { timeout: 30000 }).toContain("after the refusal");
        expect(await received()).not.toContain(refused);
    });
});
