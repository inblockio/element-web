/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// M5 A11, edit own message: Alice edits her message in Rocket.Chat's edit box (hover toolbar, More, Edit); bot Bob sees a
// `m.replace` replacement carrying the new plain text, and the view shows the new text once, marked edited. The edit state
// is entered through the event tile's onEditClick and the replacement is Element's own client send (D22, interim D16/D20).
// Failure path (D21): another user's message offers no Edit and the bridge refuses it (forbidden, nothing on the
// homeserver); an edit the homeserver refuses leaves the message as it was, with no "(edited)" and no second row.

import { type Page } from "@playwright/test";

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

test.describe("Rocket.Chat view: edit own message (A11)", () => {
    test.use(KIT_USE);

    /** Every message event of the room as Bob's client holds it, with its replacement (if any). */
    const history = (bob: { evaluate: Function }, roomId: string): Promise<any[]> =>
        bob.evaluate(
            (cli: any, id: string) =>
                cli
                    .getRoom(id)
                    .getLiveTimeline()
                    .getEvents()
                    .filter((ev: any) => ev.getType() === "m.room.message")
                    .map((ev: any) => ({
                        id: ev.getId(),
                        sender: ev.getSender(),
                        relation: ev.getRelation()?.rel_type,
                        original: ev.getOriginalContent(),
                        wire: ev.getWireContent(),
                        body: ev.getContent().body,
                    })),
            roomId,
        );

    /** What the host's bridge answers for an edit, from the page (the kit's own path, without its UI). */
    const bridgeEdit = (page: Page, roomId: string, eventId: string, text: string): Promise<string> =>
        page.evaluate(
            async ([r, e, t]) => {
                try {
                    await (window as any).__clientViewBridge.editText(r, e, t);
                    return "done";
                } catch (err) {
                    return (err as any).code ?? String(err);
                }
            },
            [roomId, eventId, text],
        );

    test("edits an own message: Bob sees the m.replace with the new plain text, the view shows it once as edited", async ({
        page,
        app,
        bot,
    }) => {
        test.setTimeout(150000);
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Lunch at noon");
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const original = await app.client.evaluate((cli, id) => cli.sendTextMessage(id, "first draft"), roomId);

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("first draft")).toBeVisible({ timeout: 30000 });

        await kit.getByText("first draft").hover();
        await kit.locator('.rcx-message-toolbar button[title="More"]').click();
        await kit.getByRole("menuitem", { name: "Edit", exact: true }).click();
        const composer = kit.getByRole("textbox", { name: /^Message/ });
        await expect(composer).toHaveValue("first draft");
        await composer.fill("second draft");
        await composer.press("Enter");

        // Bob: one replacement for the original, plain text, `* ` outer body, the original event untouched.
        await expect
            .poll(async () => (await history(bot, roomId)).filter((m) => m.relation === "m.replace"), { timeout: 30000 })
            .toEqual([
                expect.objectContaining({
                    sender: aliceId,
                    wire: expect.objectContaining({
                        "msgtype": "m.text",
                        "body": "* second draft",
                        "m.new_content": expect.objectContaining({ msgtype: "m.text", body: "second draft" }),
                        "m.relates_to": { rel_type: "m.replace", event_id: original.event_id },
                    }),
                }),
            ]);
        const bobView = (await history(bot, roomId)).find((m) => m.id === original.event_id);
        expect(bobView.body).toBe("second draft");
        expect(bobView.original.body).toBe("first draft");

        // The view: the new text once, marked edited, no row with the old text, no row for the replacement.
        const row = kit.getByRole("listitem", { name: /^Alice .*second draft/ });
        await expect(row).toHaveCount(1, { timeout: 30000 });
        await expect(row.locator("[title*=\"has been edited\"]")).toHaveCount(1);
        await page.waitForTimeout(3000);
        await expect(kit.getByRole("listitem", { name: /first draft/ })).toHaveCount(0);
        await expect(kit.getByText(/second draft/)).toHaveCount(1);
    });

    test("a message sent from the view is edited by the id the view knows it by", async ({ page, app, bot }) => {
        test.setTimeout(150000);
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Lunch at noon");
        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Lunch at noon")).toBeVisible({ timeout: 30000 });

        const composer = kit.getByRole("textbox", { name: /^Message/ });
        await composer.click();
        await composer.fill("sent here");
        await composer.press("Enter");
        await expect(kit.getByRole("listitem", { name: /sent here$/ })).toHaveCount(1, { timeout: 30000 });
        await page.waitForTimeout(2000);

        await kit.getByText("sent here").hover();
        await kit.locator('.rcx-message-toolbar button[title="More"]').click();
        await kit.getByRole("menuitem", { name: "Edit", exact: true }).click();
        await composer.fill("edited here");
        await composer.press("Enter");

        await expect
            .poll(async () => (await history(bot, roomId)).find((m) => m.relation === "m.replace")?.wire.body, { timeout: 30000 })
            .toBe("* edited here");
        await expect(kit.getByRole("listitem", { name: /edited here/ })).toHaveCount(1, { timeout: 30000 });
        await expect(kit.getByRole("listitem", { name: /sent here/ })).toHaveCount(0);
    });

    // D21 failure path, part 1: another user's message. The view offers no Edit, and the bridge refuses it.
    test("another user's message offers no Edit and the bridge refuses it: nothing on the homeserver, no ghost", async ({
        page,
        app,
        bot,
    }) => {
        test.setTimeout(120000);
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        const { event_id: bobEvent } = await bot.sendMessage(roomId, "Bob wrote this");
        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Bob wrote this")).toBeVisible({ timeout: 30000 });

        await kit.getByText("Bob wrote this").hover();
        await kit.locator('.rcx-message-toolbar button[title="More"]').click();
        await expect(kit.getByRole("menuitem", { name: "Copy text" })).toBeVisible();
        await expect(kit.getByRole("menuitem", { name: "Edit", exact: true })).toHaveCount(0);
        await page.keyboard.press("Escape");

        expect(await bridgeEdit(page, roomId, bobEvent, "hijacked")).toBe("forbidden");
        await page.waitForTimeout(2000);
        expect((await history(bot, roomId)).filter((m) => m.relation === "m.replace")).toEqual([]);
        expect((await history(bot, roomId))[0].body).toBe("Bob wrote this");
        await expect(kit.getByText("Bob wrote this")).toHaveCount(1);
        await expect(kit.getByText("hijacked")).toHaveCount(0);
    });

    // D21 failure path, part 2: the homeserver refuses Alice's own edit (messages need a power level she no longer has).
    test("an edit the homeserver refuses leaves the message as it was: nothing on the homeserver, no edited mark", async ({
        page,
        app,
        bot,
    }) => {
        test.setTimeout(150000);
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
        const original = await app.client.evaluate((cli, id) => cli.sendTextMessage(id, "keep me as I am"), roomId);

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Locked Room"));
        await expect(kit.getByText("keep me as I am")).toBeVisible({ timeout: 30000 });

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

        await kit.getByText("keep me as I am").hover();
        await kit.locator('.rcx-message-toolbar button[title="More"]').click();
        await kit.getByRole("menuitem", { name: "Edit", exact: true }).click();
        const composer = kit.getByRole("textbox", { name: /^Message/ });
        await composer.fill("this edit must never land");
        await composer.press("Enter");

        await page.waitForTimeout(4000);
        expect((await history(bot, roomId)).filter((m) => m.relation === "m.replace")).toEqual([]);
        expect((await history(bot, roomId)).find((m) => m.id === original.event_id).body).toBe("keep me as I am");
        await expect(kit.getByText("keep me as I am")).toHaveCount(1);
        await expect(kit.getByText("this edit must never land")).toHaveCount(0);
        await expect(kit.getByText(/\(edited\)|edited/i)).toHaveCount(0);
        // and the bridge says why
        expect(await bridgeEdit(page, roomId, original.event_id, "again")).toBe("forbidden");
    });
});
