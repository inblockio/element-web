/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Increment 7, video bodies: a video message arrives in Rocket.Chat as its video attachment, fed by Element's video
// body view-model (the homeserver URL, or the decrypted blob URL for an encrypted room).

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

// 16x16 red WebM, 0.4 s (ffmpeg, libvpx)
const WEBM = Buffer.from(
    "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAIXEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggIB7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjIuMy4xMDBXQYxMYXZmNjIuMy4xMDBEiYhAeQAAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WIDZY5/ZXo2PGcgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QL68IA4JCwgRC6gRCagQJVsIRVuYEBElTDZ/tzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYyLjMuMTAwc3PWY8CLY8WIDZY5/ZXo2PFnyKFFo4dFTkNPREVSRIeUTGF2YzYyLjExLjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjQwMDAwMDAwMAAfQ7Z12eeBAKO9gQAAgPACAJ0BKhAAEAAARwiFhYiFhIgCAgJ1qgP4A/oCDU0YAP79bvP/45k3MMT/jm3/8WE8DijI//FRAKOVgQDIALEBAAEQEAAYABhYL/QACAAAHFO7a5G7j7OBALeK94EB8YIBo/CBAw==",
    "base64",
);

test.describe("Rocket.Chat view: video bodies", () => {
    test.use(KIT_USE);

    test("shows a video message as Rocket.Chat's video attachment", async ({ page, app, bot }) => {
        const roomId = await app.client.createRoom({ name: "Clip Share", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        const { content_uri: url } = await app.client.uploadContent(WEBM, { type: "video/webm" });
        await bot.sendMessage(roomId, {
            msgtype: "m.video",
            body: "clip.webm",
            url,
            info: { mimetype: "video/webm", size: WEBM.length, w: 16, h: 16, duration: 400 },
        } as never);

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Clip Share"));

        const video = kit.locator(".rcx-message-generic-preview video");
        await expect(video).toHaveCount(1, { timeout: 30000 });
        // The element has a source that loads: its metadata arrives (readyState >= HAVE_METADATA, a duration).
        await expect
            .poll(() => video.evaluate((v: HTMLVideoElement) => (v.readyState >= 1 ? v.duration : -1)), {
                timeout: 30000,
            })
            .toBeGreaterThan(0);
        await expect(video.locator("source")).toHaveAttribute("src", /\/_matrix\/(client\/v1\/)?media\/(v3\/)?download\//);
    });
});
