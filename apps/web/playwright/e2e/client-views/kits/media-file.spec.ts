/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Increment 6, file bodies: a file message arrives in Rocket.Chat as its file attachment, titled with Element's file
// label (name and size) and linking the download URL.

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

const TEXT = Buffer.from("hello from the bot\n");

test.describe("Rocket.Chat view: file bodies", () => {
    test.use(KIT_USE);

    test("shows a file message as Rocket.Chat's file attachment", async ({ page, app, bot }) => {
        const roomId = await app.client.createRoom({ name: "Shared Files", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        const { content_uri: url } = await app.client.uploadContent(TEXT, { type: "text/plain" });
        await bot.sendMessage(roomId, {
            msgtype: "m.file",
            body: "notes.txt",
            filename: "notes.txt",
            url,
            info: { mimetype: "text/plain", size: TEXT.length },
        } as never);

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Shared Files"));

        // Element's file label carries the name and the size ("notes.txt (19 B)").
        const title = kit.getByText(/notes\.txt \(19 B\)/);
        await expect(title.first()).toBeVisible({ timeout: 30000 });
        const preview = kit.locator(".rcx-message-generic-preview__content").filter({ hasText: "notes.txt" });
        await expect(preview).toHaveCount(1);
        const link = preview.locator("a[href]").first();
        await expect(link).toHaveAttribute("href", /\/_matrix\/(client\/v1\/)?media\/(v3\/)?download\//);
    });
});
