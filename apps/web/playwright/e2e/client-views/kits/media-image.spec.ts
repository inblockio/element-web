/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Increment 5, image bodies: an image message arrives in Rocket.Chat as its image attachment, fed by Element's image
// body view-model (the thumbnail URL, or the decrypted blob URL for an encrypted room).

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

// 1x1 PNG
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);

test.describe("Rocket.Chat view: image bodies", () => {
    test.use(KIT_USE);

    test("shows an image message as Rocket.Chat's image attachment", async ({ page, app, bot }) => {
        const roomId = await app.client.createRoom({ name: "Photo Share", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        const { content_uri: url } = await app.client.uploadContent(PNG, { type: "image/png" });
        await bot.sendMessage(roomId, {
            msgtype: "m.image",
            body: "pixel.png",
            url,
            info: { mimetype: "image/png", size: PNG.length, w: 1, h: 1 },
        } as never);

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Photo Share"));

        const image = kit.locator("img.gallery-item");
        await expect(image).toHaveCount(1, { timeout: 30000 });
        await expect
            .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 30000 })
            .toBeGreaterThan(0);
        // Rocket.Chat's own attachment shows the file name as its title; the message has no text of its own.
        await expect(kit.getByText("pixel.png").first()).toBeVisible();
        // The download control links the media URL as it is: Rocket.Chat's `?download` suffix would break a blob URL
        // and add a second query to a homeserver URL (grok inc 5-7 track F2).
        const download = kit.locator('a[download][href*="/_matrix/"]').first();
        await expect(download).toHaveAttribute("href", /\/_matrix\/(client\/v1\/)?media\/(v3\/)?download\/[^?]*(\?[^?]*)?$/);
        await expect(download).not.toHaveAttribute("href", /download$/);
    });
});
