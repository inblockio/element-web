/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// M5 A6, create a room and start a chat: "Create new" in the Rocket.Chat view opens Element's own create-room and
// start-chat dialogs over it (D17). A public room Alice creates is found by bot Bob through its address on the
// homeserver; the room opens in the view. A new direct message is Element's local room, listed and opened in the view;
// Alice's first message creates the real room and Bob gets the invite and the text. D21: a closed dialog changes nothing,
// and a create or first message the homeserver refuses leaves no room and no row.

import { type FrameLocator, type Page } from "@playwright/test";

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, switchToRocketChat } from "./kit";

async function openCreateNew(page: Page, kit: FrameLocator, item: "Channel" | "Direct message"): Promise<void> {
    // After a closed dialog the focus sits on the view's "Skip to main content" link, which then covers the button.
    await kit.locator(":focus").evaluate((el: HTMLElement) => el.blur()).catch(() => {});
    await clickPastToasts(page, kit.locator('button[title="Create new"]'));
    await kit.getByRole("menuitem", { name: item, exact: true }).click();
}

/** The search field of Element's start-chat dialog. */
const dmSearch = (page: Page) => page.getByRole("dialog", { name: "Direct Messages" }).getByRole("textbox", { name: "Search" });

const CREATE_ROOM = /\/_matrix\/client\/v3\/createRoom/;

test.describe("Rocket.Chat view: create a room and start a chat", () => {
    test.use(KIT_USE);

    test("creates a public room in Element's dialog; Bob finds it by its address; it opens in the view", async ({ page, app, bot }) => {
        test.setTimeout(Number(process.env.PW_TEST_TIMEOUT ?? 300000));
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const domain = aliceId.split(":")[1];
        const kit = await switchToRocketChat(page);
        await openCreateNew(page, kit, "Channel");

        // Element's dialog, over the view (Rocket.Chat's own create modal does not open).
        const dialog = page.locator(".mx_CreateRoomDialog");
        await expect(dialog).toBeVisible();
        await expect(kit.getByRole("dialog")).toHaveCount(0);
        await dialog.getByRole("textbox", { name: "Name" }).fill("Kit Created");
        await dialog.getByRole("button", { name: "Room visibility" }).click();
        await dialog.getByRole("option", { name: "Public room" }).click();
        await dialog.getByRole("textbox", { name: "Room address" }).fill("kit-created-a6");
        await dialog.getByRole("button", { name: "Create room" }).click();

        // The homeserver holds the room: Bob resolves the address and joins; Alice is a member and the name is set.
        const alias = `#kit-created-a6:${domain}`;
        const roomId = await expect
            .poll(() => bot.evaluate((cli, a) => cli.getRoomIdForAlias(a).then((r) => r.room_id).catch(() => null), alias), {
                timeout: 30000,
            })
            .not.toBeNull()
            .then(() => bot.evaluate((cli, a) => cli.getRoomIdForAlias(a).then((r) => r.room_id), alias));
        // Element's own state of the room it created.
        await expect
            .poll(() => app.client.evaluate((cli, id) => cli.getRoom(id)?.getJoinRule(), roomId), { timeout: 30000 })
            .toBe("public");
        await bot.joinRoom(roomId);
        await expect
            .poll(
                () =>
                    bot.evaluate(
                        (cli, { id, alice }) => {
                            const room = cli.getRoom(id);
                            return [room?.name, room?.getMember(alice)?.membership];
                        },
                        { id: roomId, alice: aliceId },
                    ),
                { timeout: 30000 },
            )
            .toEqual(["Kit Created", "join"]);

        // The view lists the room and opened it.
        await expect(kit.getByRole("link", { name: /Kit Created/ })).toHaveCount(1, { timeout: 30000 });
        await expect(kit.getByRole("heading", { name: "Kit Created" }).first()).toBeVisible({ timeout: 30000 });
        await bot.sendMessage(roomId, "welcome to the new room");
        await expect(kit.getByText("welcome to the new room")).toBeVisible({ timeout: 30000 });
    });

    test("a room that is named after it appeared (Element's \"Empty room\" first) is renamed in the sidebar", async ({ page, app, bot }) => {
        test.setTimeout(Number(process.env.PW_TEST_TIMEOUT ?? 300000));
        void bot;
        const roomId = await app.client.createRoom({ name: "Old Name" });
        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, kit.getByRole("link", { name: /Old Name/ }).first());
        await app.client.evaluate((cli, id) => cli.setRoomName(id, "New Name"), roomId);
        await expect(kit.getByRole("link", { name: /New Name/ })).toHaveCount(1, { timeout: 30000 });
        await expect(kit.getByRole("link", { name: /Old Name/ })).toHaveCount(0);
    });

    test("a closed create dialog changes nothing", async ({ page, app, bot }) => {
        test.setTimeout(Number(process.env.PW_TEST_TIMEOUT ?? 300000));
        void bot; // the bot fixture signs Alice in first
        await app.client.evaluate((cli) => cli.getSafeUserId()); // signed in
        const kit = await switchToRocketChat(page);
        const before = await app.client.evaluate((cli) => cli.getRooms().length);
        await openCreateNew(page, kit, "Channel");
        const dialog = page.locator(".mx_CreateRoomDialog");
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await expect(dialog).toHaveCount(0);
        await page.waitForTimeout(2000);
        expect(await app.client.evaluate((cli) => cli.getRooms().length)).toBe(before);
        await expect(kit.getByRole("alert")).toHaveCount(0);
        // The menu still works afterwards.
        await openCreateNew(page, kit, "Channel");
        await expect(page.locator(".mx_CreateRoomDialog")).toBeVisible();
    });

    test("a create the homeserver refuses leaves no room and no row", async ({ page, app, bot }) => {
        test.setTimeout(Number(process.env.PW_TEST_TIMEOUT ?? 300000));
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const domain = aliceId.split(":")[1];
        await page.route(CREATE_ROOM, (route) =>
            route.fulfill({
                status: 403,
                contentType: "application/json",
                body: JSON.stringify({ errcode: "M_FORBIDDEN", error: "You may not create rooms" }),
            }),
        );
        const kit = await switchToRocketChat(page);
        const before = await app.client.evaluate((cli) => cli.getRooms().length);
        await openCreateNew(page, kit, "Channel");
        const dialog = page.locator(".mx_CreateRoomDialog");
        await dialog.getByRole("textbox", { name: "Name" }).fill("Refused Room");
        await dialog.getByRole("button", { name: "Room visibility" }).click();
        await dialog.getByRole("option", { name: "Public room" }).click();
        await dialog.getByRole("textbox", { name: "Room address" }).fill("refused-room-a6");
        await dialog.getByRole("button", { name: "Create room" }).click();

        // Element's own error dialog; the view shows Rocket.Chat's error toast.
        await expect(page.getByRole("dialog").filter({ hasText: /Failure to create room/i }).first()).toBeVisible({ timeout: 30000 });
        await page.getByRole("dialog").getByRole("button", { name: /OK|Close/ }).first().click();
        await expect(kit.getByRole("alert").first()).toBeVisible({ timeout: 30000 });

        // No ghost: no room in the view, none for Alice, and the address resolves to nothing for Bob.
        await expect(kit.getByRole("link", { name: /Refused Room/ })).toHaveCount(0);
        expect(await app.client.evaluate((cli) => cli.getRooms().length)).toBe(before);
        expect(
            await bot.evaluate((cli, a) => cli.getRoomIdForAlias(a).then(() => "exists").catch(() => "none"), `#refused-room-a6:${domain}`),
        ).toBe("none");
    });

    test("starts a chat in Element's dialog; the first message creates the real room and Bob gets the invite and the text", async ({ page, app, bot }) => {
        test.setTimeout(Number(process.env.PW_TEST_TIMEOUT ?? 300000));
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const bobId = bot.credentials!.userId;
        const kit = await switchToRocketChat(page);
        await openCreateNew(page, kit, "Direct message");

        const dialog = dmSearch(page);
        await expect(dialog).toBeVisible();
        await dmSearch(page).fill(bobId);
        await page.getByRole("option", { name: /Bob/ }).first().click();
        await page.getByRole("button", { name: "Go" }).click();
        // A contact Alice has never shared a room with is confirmed first.
        const proceed = page.getByRole("button", { name: "Continue" });
        await proceed.click({ timeout: 3000 }).catch(() => {});
        await expect(dialog).toHaveCount(0, { timeout: 30000 });

        // Element's local room for the chat: listed in the view and open, nothing on the homeserver yet.
        await expect(kit.getByRole("link", { name: /Bob/ })).toHaveCount(1, { timeout: 30000 });
        expect(await bot.evaluate((cli) => cli.getRooms().filter((r) => r.getMyMembership() === "invite").length)).toBe(0);

        const composer = kit.getByRole("textbox", { name: /^Message/ });
        await composer.click();
        await composer.fill("Hi Bob, first message");
        await composer.press("Enter");

        // The first message creates the real room: Bob is invited and the text is there for him.
        const bobRoom = await expect
            .poll(() => bot.evaluate((cli) => cli.getRooms().find((r) => r.getMyMembership() === "join")?.roomId ?? null), { timeout: 60000 })
            .not.toBeNull()
            .then(() => bot.evaluate((cli) => cli.getRooms().find((r) => r.getMyMembership() === "join")!.roomId));
        await expect
            .poll(
                () =>
                    bot.evaluate(
                        (cli, id) =>
                            cli
                                .getRoom(id)!
                                .getLiveTimeline()
                                .getEvents()
                                .filter((e) => e.getType() === "m.room.message")
                                .map((e) => [e.getSender(), e.getContent().body]),
                        bobRoom,
                    ),
                { timeout: 60000 },
            )
            .toEqual([[aliceId, "Hi Bob, first message"]]);
        // The view shows one chat with Bob (the local room is replaced) and the message once.
        await expect(kit.getByRole("link", { name: /Bob/ })).toHaveCount(1, { timeout: 30000 });
        await expect(kit.getByRole("listitem", { name: /Hi Bob, first message$/ })).toHaveCount(1, { timeout: 30000 });
    });

    test("a first message the homeserver refuses creates no room and leaves no row", async ({ page, app, bot }) => {
        test.setTimeout(Number(process.env.PW_TEST_TIMEOUT ?? 300000));
        await page.route(CREATE_ROOM, (route) =>
            route.fulfill({
                status: 403,
                contentType: "application/json",
                body: JSON.stringify({ errcode: "M_FORBIDDEN", error: "You may not create rooms" }),
            }),
        );
        const bobId = bot.credentials!.userId;
        const kit = await switchToRocketChat(page);
        await openCreateNew(page, kit, "Direct message");
        await dmSearch(page).fill(bobId);
        await page.getByRole("option", { name: /Bob/ }).first().click();
        await page.getByRole("button", { name: "Go" }).click();
        await page.getByRole("button", { name: "Continue" }).click({ timeout: 3000 }).catch(() => {});
        await expect(kit.getByRole("link", { name: /Bob/ })).toHaveCount(1, { timeout: 30000 });

        const composer = kit.getByRole("textbox", { name: /^Message/ });
        await composer.click();
        await composer.fill("This must never arrive 2");
        // The send attempt has to have reached the homeserver (its refusal answered) before the row can be judged: the
        // optimistic row appears after the composer's own awaits, so a first look at the list says nothing.
        const refused = page.waitForResponse((r) => CREATE_ROOM.test(r.url()) && r.request().method() === "POST");
        await composer.press("Enter");
        await refused;
        // From the refusal on, no row of the refused message is held for the whole window (the optimistic row, if one was
        // made, is withdrawn or shown failed, never kept as sent).
        const rows = kit.getByRole("listitem", { name: /This must never arrive 2$/ });
        await expect(rows).toHaveCount(0, { timeout: 30000 });
        for (let i = 0; i < 15; i++) {
            expect(await rows.count()).toBe(0);
            await page.waitForTimeout(200);
        }
        // Nothing for Bob, not even later; Alice made no real room.
        expect(await bot.evaluate((cli) => cli.getRooms().length)).toBe(0);
        expect(await app.client.evaluate((cli) => cli.getRooms().filter((r) => !r.roomId.startsWith("local+")).length)).toBe(0);
    });

    test("a closed start-chat dialog lists no room", async ({ page, app, bot }) => {
        test.setTimeout(Number(process.env.PW_TEST_TIMEOUT ?? 300000));
        void bot; // the bot fixture signs Alice in first
        await app.client.evaluate((cli) => cli.getSafeUserId()); // signed in
        const kit = await switchToRocketChat(page);
        await openCreateNew(page, kit, "Direct message");
        await expect(dmSearch(page)).toBeVisible();
        await page.getByRole("dialog", { name: "Direct Messages" }).getByRole("button", { name: "Close dialog" }).click();
        await expect(dmSearch(page)).toHaveCount(0);
        await page.waitForTimeout(1500);
        await expect(kit.getByRole("alert")).toHaveCount(0);
        await expect(kit.getByRole("link", { name: /Bob/ })).toHaveCount(0);
    });
});
