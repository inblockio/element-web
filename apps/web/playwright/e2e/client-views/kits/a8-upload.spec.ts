/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// M5 A8, upload a file: Alice presses "Upload file" in the Rocket.Chat composer; Element's own file picker opens (the kit's
// picker and upload modal are skipped, D17), then Element's upload confirmation, and Element uploads. D21: bot Bob sees an
// `m.file` / `m.image` event with the file name and an `mxc://` URL whose bytes are the file's. The failure path routes the
// media upload to a 413: Element's error dialog shows, no event reaches the homeserver and the view has no row of the file.
// closing Element's confirm sends nothing.

import { type FrameLocator, type Page } from "@playwright/test";

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

// A 1x1 PNG.
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);

/** Presses "Upload file" and gives Element's own picker (a file chooser of the page) the file. */
async function chooseFile(page: Page, kit: FrameLocator, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
    const button = kit.locator('button[title="Upload file"]');
    await expect(button).toBeEnabled({ timeout: 30000 });
    const chooser = page.waitForEvent("filechooser", { timeout: 30000 });
    await clickPastToasts(page, button);
    await (await chooser).setFiles(file);
}

/** The first message event of the room that bot Bob holds, by its body. */
const bobEvent = (bot: any, roomId: string, body: string) =>
    bot.evaluate(
        (cli: any, { id, text }: { id: string; text: string }) => {
            const e = cli
                .getRoom(id)
                ?.getLiveTimeline()
                .getEvents()
                .find((ev: any) => ev.getType() === "m.room.message" && ev.getContent().body === text);
            return e
                ? { msgtype: e.getContent().msgtype, url: e.getContent().url ?? e.getContent().file?.url, size: e.getContent().info?.size, encrypted: !!e.getContent().file }
                : null;
        },
        { id: roomId, text: body },
    );

/** The bytes of an `mxc://` URL as the homeserver serves them to Bob (authenticated media). */
async function download(creds: { homeserverBaseUrl: string; accessToken: string }, mxc: string): Promise<Buffer> {
    const [, server, mediaId] = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxc)!;
    const res = await fetch(`${creds.homeserverBaseUrl}/_matrix/client/v1/media/download/${server}/${mediaId}`, {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    expect(res.status).toBe(200);
    return Buffer.from(await res.arrayBuffer());
}

/** A new direct chat as the start-chat dialog makes it: a local room, nothing on the homeserver yet. */
async function startDirectChat(page: Page, kit: FrameLocator, bot: any): Promise<void> {
        // A new direct chat as the start-chat dialog makes it: a local room, nothing on the homeserver yet.
        await kit.locator(":focus").evaluate((el: HTMLElement) => el.blur()).catch(() => {});
        await clickPastToasts(page, kit.locator('button[title="Create new"]'));
        await kit.getByRole("menuitem", { name: "Direct message", exact: true }).click();
        const search = page.getByRole("dialog", { name: "Direct Messages" }).getByRole("textbox", { name: "Search" });
        await search.fill(bot.credentials!.userId);
        await page.getByRole("option", { name: /Bob/ }).first().click();
        await page.getByRole("button", { name: "Go" }).click();
        await page.getByRole("button", { name: "Continue" }).click({ timeout: 3000 }).catch(() => {});
        await expect(search).toHaveCount(0, { timeout: 30000 });
        await expect(kit.getByRole("link", { name: /Bob/ })).toHaveCount(1, { timeout: 30000 });
        expect(await bot.evaluate((cli) => cli.getRooms().length)).toBe(0);
}

test.describe("Rocket.Chat view: upload a file", () => {
    test.use(KIT_USE);

    test("upload in a new direct chat before the first message: Rocket.Chat's toast, no picker, no room, no invite", async ({
        page,
        app,
        bot,
    }) => {
        test.setTimeout(150000);
        const kit = await switchToRocketChat(page);
        await startDirectChat(page, kit, bot);
        let picker = false;
        page.on("filechooser", () => (picker = true));
        const button = kit.locator('button[title="Upload file"]');
        await expect(button).toBeEnabled({ timeout: 30000 });
        await clickPastToasts(page, button);

        // The host refuses before any dialog; the view shows its own error toast and the user stays in the chat.
        await expect(kit.getByRole("alert").first()).toBeVisible({ timeout: 30000 });
        await expect(kit.getByRole("alert").first()).toContainText(/send a message first/i);
        await page.waitForTimeout(3000);
        expect(picker).toBe(false);
        await expect(page.locator(".mx_UploadConfirmDialog")).toHaveCount(0);
        // The homeserver holds no room: Bob has no invite, Alice has no real room.
        expect(await bot.evaluate((cli) => cli.getRooms().length)).toBe(0);
        expect(await app.client.evaluate((cli) => cli.getRooms().filter((r) => !r.roomId.startsWith("local+")).length)).toBe(0);
        await expect(kit.getByRole("link", { name: /Bob/ })).toHaveCount(1);
        await expect(kit.locator("footer.rc-message-box")).toBeVisible();
    });

    test("a file chosen in Element's picker and confirmed in Element's dialog reaches Bob with the same bytes", async ({
        page,
        app,
        bot,
    }) => {
        test.setTimeout(150000);
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Lunch at noon");
        const kit = await switchToRocketChat(page);
        await expect(sidebarRoom(kit, "Team Lunch")).toBeVisible({ timeout: 30000 });
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Lunch at noon").first()).toBeVisible({ timeout: 30000 });

        const text = Buffer.from("the menu: pasta, salad\n");
        await chooseFile(page, kit, { name: "menu.txt", mimeType: "text/plain", buffer: text });
        // Element's own confirmation over the view; Rocket.Chat's upload modal does not appear.
        const confirm = page.locator(".mx_UploadConfirmDialog");
        await expect(confirm).toBeVisible({ timeout: 30000 });
        await expect(kit.getByRole("dialog")).toHaveCount(0);
        await confirm.getByRole("button", { name: "Upload" }).click();

        await expect.poll(() => bobEvent(bot, roomId, "menu.txt"), { timeout: 60000 }).toMatchObject({ msgtype: "m.file" });
        const event = await bobEvent(bot, roomId, "menu.txt");
        expect(event.url).toMatch(/^mxc:\/\//);
        expect((await download(bot.credentials!, event.url)).equals(text)).toBe(true);
        // The view shows it like any message, once.
        await expect(kit.getByText("menu.txt").first()).toBeVisible({ timeout: 30000 });
        await expect(kit.getByRole("alert")).toHaveCount(0);
    });

    test("an image is sent as an m.image with its bytes", async ({ page, app, bot }) => {
        test.setTimeout(150000);
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Lunch at noon");
        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Lunch at noon").first()).toBeVisible({ timeout: 30000 });
        await chooseFile(page, kit, { name: "pixel.png", mimeType: "image/png", buffer: PNG });
        await page.locator(".mx_UploadConfirmDialog").getByRole("button", { name: "Upload" }).click({ timeout: 30000 });
        await expect.poll(() => bobEvent(bot, roomId, "pixel.png"), { timeout: 60000 }).toMatchObject({ msgtype: "m.image" });
        const event = await bobEvent(bot, roomId, "pixel.png");
        expect((await download(bot.credentials!, event.url)).equals(PNG)).toBe(true);
    });

    test("Closing Element's confirm sends nothing and is no error", async ({ page, app, bot }) => {
        test.setTimeout(150000);
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Lunch at noon");
        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Lunch at noon").first()).toBeVisible({ timeout: 30000 });
        await chooseFile(page, kit, { name: "menu.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
        const confirm = page.locator(".mx_UploadConfirmDialog");
        await expect(confirm).toBeVisible({ timeout: 30000 });
        await confirm.getByRole("button", { name: "Close dialog" }).click();
        await expect(confirm).toHaveCount(0);

        await page.waitForTimeout(3000);
        expect(await bobEvent(bot, roomId, "menu.txt")).toBeNull();
        await expect(kit.getByText("menu.txt")).toHaveCount(0);
        await expect(kit.getByRole("alert")).toHaveCount(0);
    });

    test("a media upload the homeserver refuses shows Element's error, leaves no event and no row in the view", async ({
        page,
        app,
        bot,
    }) => {
        test.setTimeout(150000);
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Lunch at noon");
        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Lunch at noon").first()).toBeVisible({ timeout: 30000 });
        // Only the upload is refused (the media config the size check reads is left alone).
        await page.route(/\/_matrix\/media\/[^/]+\/(upload|create)/, (route) =>
            route.fulfill({
                status: 413,
                contentType: "application/json",
                body: JSON.stringify({ errcode: "M_TOO_LARGE", error: "Upload request body is too large" }),
            }),
        );
        await chooseFile(page, kit, { name: "menu.txt", mimeType: "text/plain", buffer: Buffer.from("too big") });
        await page.locator(".mx_UploadConfirmDialog").getByRole("button", { name: "Upload" }).click({ timeout: 30000 });

        // Element's own error dialog, then Rocket.Chat's error toast.
        const dialog = page.getByRole("dialog").filter({ hasText: /Upload Failed|failed to upload|too large/i }).first();
        await expect(dialog).toBeVisible({ timeout: 30000 });
        await dialog.getByRole("button", { name: /OK|Close/ }).first().click();
        await expect(kit.getByRole("alert").first()).toBeVisible({ timeout: 30000 });

        await page.waitForTimeout(2000);
        expect(await bobEvent(bot, roomId, "menu.txt")).toBeNull();
        await expect(kit.getByText("menu.txt")).toHaveCount(0);
    });
});
