/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// REQ-0007 V1: a message Element cannot decrypt shows Rocket.Chat's own encrypted-message placeholder plus the reason
// Element's decryption failure body view-model gives, and never the SDK's placeholder body. Built the way the host's
// crypto/decryption-failure-messages.spec.ts and event-shields.spec.ts build an undecryptable event: Bob sends an
// m.room.encrypted event whose ciphertext nobody can read into an encrypted room.

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

// Rocket.Chat's E2E_message_encrypted_placeholder (en).
const RC_PLACEHOLDER =
    "This message is end-to-end encrypted. To view it, you must enter your encryption key in your account settings.";

test.describe("Rocket.Chat view: undecryptable message (REQ-0007 V1)", () => {
    test.use(KIT_USE);

    test("shows Rocket.Chat's encrypted placeholder and the reason, never the SDK text", async ({ page, app, bot }) => {
        const roomId = await app.client.createRoom({
            name: "Secret Room",
            invite: [bot.credentials!.userId],
            initial_state: [
                { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
            ],
        });
        await bot.joinRoom(roomId);
        await bot.awaitRoomMembership(roomId);
        await bot.sendEvent(roomId, null, "m.room.encrypted", {
            algorithm: "m.megolm.v1.aes-sha2",
            ciphertext: "the bird is in the hand",
        });

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Secret Room"));

        // Rocket.Chat's own placeholder for an encrypted message it cannot show ...
        await expect(kit.getByText(RC_PLACEHOLDER)).toBeVisible({ timeout: 30000 });
        // ... plus the reason Element's view-model gives, as a note under it.
        await expect(kit.getByRole("note")).toHaveText("Unable to decrypt message");
        // The SDK's placeholder body ("** Unable to decrypt: DecryptionError ... **") is never handed over.
        await expect(kit.getByText(/Unable to decrypt:/)).toHaveCount(0);
        await expect(kit.getByText(/DecryptionError/)).toHaveCount(0);
    });
});
