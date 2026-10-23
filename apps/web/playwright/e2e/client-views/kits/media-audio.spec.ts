/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Increment 8, audio bodies: an audio message and a voice message arrive in Rocket.Chat as its audio attachment, played
// by Rocket.Chat's own audio element from the media helper's URL (no audio player view-model: it decodes the file).

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

/** 0.2 s of 8 kHz 16-bit mono silence as a WAV file. */
function wav(): Buffer {
    const samples = 1600;
    const data = Buffer.alloc(samples * 2);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(16000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

test.describe("Rocket.Chat view: audio bodies", () => {
    test.use(KIT_USE);

    test("shows an audio message and a voice message as Rocket.Chat's audio attachment", async ({ page, app, bot }) => {
        const roomId = await app.client.createRoom({ name: "Sound Check", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        const file = wav();
        const { content_uri: url } = await app.client.uploadContent(file, { type: "audio/wav" });
        await bot.sendMessage(roomId, {
            msgtype: "m.audio",
            body: "song.wav",
            url,
            info: { mimetype: "audio/wav", size: file.length, duration: 200 },
        } as never);
        await bot.sendMessage(roomId, {
            msgtype: "m.audio",
            body: "Voice message",
            url,
            info: { mimetype: "audio/wav", size: file.length, duration: 200 },
            "org.matrix.msc1767.audio": { duration: 200, waveform: [0, 512, 1024] },
            "org.matrix.msc3245.voice": {},
        } as never);

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Sound Check"));

        // Both are Rocket.Chat's audio element (its shared player's own element sits outside the messages).
        const audio = kit.locator('.rcx-message audio[preload="metadata"]');
        await expect(audio).toHaveCount(2, { timeout: 30000 });
        for (const i of [0, 1]) {
            await expect(audio.nth(i)).toHaveAttribute("src", /\/_matrix\/(client\/v1\/)?media\/(v3\/)?download\//);
            // The element has a source that loads: its metadata arrives (readyState >= HAVE_METADATA, a duration).
            await expect
                .poll(() => audio.nth(i).evaluate((a: HTMLAudioElement) => (a.readyState >= 1 ? a.duration : -1)), {
                    timeout: 30000,
                })
                .toBeGreaterThan(0);
        }
        await expect(kit.getByText("song.wav").first()).toBeVisible();
        await expect(kit.getByText("Voice message").first()).toBeVisible();
    });
});
