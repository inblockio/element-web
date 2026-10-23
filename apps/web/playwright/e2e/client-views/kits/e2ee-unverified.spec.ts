/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// REQ-0007 V2: a message from a device its owner has not verified shows its text with the warning Element's padlock
// view-model gives; a message from a trusted device shows none. Built the way the host's
// crypto/event-shields.spec.ts builds the "device not verified by its owner" shield: Alice verifies Bob, then a second,
// not cross-signed Bob device sends a message.

import { test, expect } from "../../../element-web-test";
import { autoJoin, createSecondBotDevice, createSharedEncryptedRoomWithUser, verify } from "../../crypto/utils";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

test.describe("Rocket.Chat view: unverified device (REQ-0007 V2)", () => {
    test.use({ ...KIT_USE, botCreateOpts: { displayName: "Bob", autoAcceptInvites: false } });

    test("shows the padlock warning for an unverified device and none for a trusted one", async ({
        page,
        app,
        bot: bob,
        user: aliceCredentials,
        homeserver,
    }) => {
        test.setTimeout(180000);
        await app.client.bootstrapCrossSigning(aliceCredentials);
        await autoJoin(bob);
        const roomId = await createSharedEncryptedRoomWithUser(app, bob.credentials!.userId, { name: "Verified Room" });
        await bob.awaitRoomMembership(roomId);

        // Bob has a second, not cross-signed, device.
        const bobSecondDevice = await createSecondBotDevice(page, homeserver, bob);

        // Dismiss the toasts nagging us, otherwise they get in the way of the room info panel.
        await page.getByRole("button", { name: "Dismiss" }).click();
        await page.getByRole("button", { name: "Yes, dismiss" }).click();

        await verify(app, bob);

        await bob.sendMessage(roomId, "from the trusted device");
        await bobSecondDevice.sendMessage(roomId, "from the unverified device");

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Verified Room"));

        await expect(kit.getByText("from the unverified device")).toBeVisible({ timeout: 30000 });
        await expect(kit.getByText("from the trusted device")).toBeVisible();
        // Exactly one warning, the unverified device's, and it is Element's padlock text.
        await expect(kit.getByRole("note")).toHaveCount(1);
        await expect(kit.getByRole("note")).toHaveText("Encrypted by a device not verified by its owner.");
        // Both decrypted: Rocket.Chat's placeholder never replaces their text.
        await expect(kit.getByText(/end-to-end encrypted. To view it/)).toHaveCount(0);
    });
});
