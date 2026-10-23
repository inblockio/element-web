/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// M3 step 0 spike: can media bodies reach the kit frame with the host as it is? (a) an unencrypted upload's v3
// download and thumbnail URLs load from inside the frame (Element's service worker adds the token after the host's
// userinfo relay), while the same download without the worker is refused; (b) a blob URL made by Element's window
// (what the image and video body view-models hand out after decrypting) loads in the frame.

import { test, expect } from "../../../element-web-test";
import { KIT_FRAME, KIT_USE, sidebarRoom, switchToRocketChat } from "./kit";

// 1x1 PNG
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);

test.describe("Rocket.Chat view: media-auth spike", () => {
    test.use(KIT_USE);

    test("media URLs and host blob URLs load inside the kit frame", async ({ page, app, bot }) => {
        const roomId = await app.client.createRoom({ name: "Media Spike", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        const { content_uri: mxc } = await app.client.uploadContent(PNG, { type: "image/png" });
        const [server, mediaId] = mxc.slice("mxc://".length).split("/");
        const hs = await page.evaluate(() => (window as any).mxMatrixClientPeg.get().getHomeserverUrl() as string);
        const download = `${hs.replace(/\/$/, "")}/_matrix/media/v3/download/${server}/${mediaId}`;
        const thumbnail = `${hs.replace(/\/$/, "")}/_matrix/media/v3/thumbnail/${server}/${mediaId}?width=32&height=32`;

        const kit = await switchToRocketChat(page);
        await expect(sidebarRoom(kit, "Media Spike")).toBeVisible({ timeout: 30000 });
        // The kit routes its own document path (reload.ts), so the frame is taken from its element, not its URL.
        const frame = (await (await page.locator(KIT_FRAME).elementHandle())!.contentFrame())!;

        // Control: the homeserver refuses the download without a token (authenticated media is on).
        const bare = await page.request.get(download);
        expect(bare.status(), "unauthenticated download must be refused").not.toBe(200);

        // (a) the same URLs fetched by the kit's document (a service-worker client) load.
        const probe = (url: string) =>
            frame.evaluate(async (u) => {
                const r = await fetch(u);
                return { status: r.status, type: r.headers.get("content-type") ?? "" };
            }, url);
        const d = await probe(download);
        expect(d.status, "download from the frame").toBe(200);
        expect(d.type).toMatch(/^image\//);
        const t = await probe(thumbnail);
        expect(t.status, "thumbnail from the frame").toBe(200);
        expect(t.type).toMatch(/^image\//);

        // (b) a blob URL created by Element's window renders in the frame.
        const blobUrl = await page.evaluate(
            (b64) => URL.createObjectURL(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/png" })),
            PNG.toString("base64"),
        );
        const width = await frame.evaluate(
            (u) =>
                new Promise<number>((resolve) => {
                    const img = new Image();
                    img.onload = () => resolve(img.naturalWidth);
                    img.onerror = () => resolve(-1);
                    img.src = u;
                }),
            blobUrl,
        );
        expect(width, "host blob URL in the frame").toBeGreaterThan(0);
    });
});
