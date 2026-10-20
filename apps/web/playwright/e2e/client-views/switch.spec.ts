/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { rejectToastIfExists } from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";

const FIXTURE_KIT = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture-kit", "index.html"),
    "utf8",
);

test.describe("Client views", () => {
    test.use({
        displayName: "Alice",
        botCreateOpts: { displayName: "Bob" },
        labsFlags: ["feature_client_views"],
        // client_views is not in IConfigOptions (the host reads it untyped, like registry.ts), so widen here.
        config: { client_views: [{ id: "fixture", name: "Fixture", url: "/kits/fixture/index.html" }] } as object,
    });

    test.beforeEach(async ({ page }) => {
        // A composed app copies kits into webapp/kits/<id>/; here the fixture kit is served from the spec dir.
        await page.route("**/kits/fixture/index.html", (route) =>
            route.fulfill({ contentType: "text/html", body: FIXTURE_KIT }),
        );
    });

    test("switches to a kit from the user menu and back, on the same session", async ({ page, app, bot }) => {
        const roomId = await app.client.createRoom({ name: "General", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Hi Alice!");
        await bot.sendMessage(roomId, "🎉");

        const deviceId = () => page.evaluate(() => (window as any).mxMatrixClientPeg.get().getDeviceId() as string);
        const before = await deviceId();

        await page.getByRole("button", { name: "User menu", exact: true }).click();
        await page.getByRole("menuitem", { name: "Switch to Fixture" }).click();

        const kit = page.frameLocator('iframe[title="Fixture"]');
        await expect(kit.getByText("Alice (")).toBeVisible();
        // The host's toasts stay above the kit, where they cover it as they cover the stock room list: the new
        // device's "Verify this device" toast is shown over the kit. Dismiss toasts as openRoom() does.
        await expect(page.getByRole("alert").filter({ hasText: "Verify this device" })).toBeVisible();
        const general = kit.getByRole("navigation", { name: "Rooms" }).getByRole("button", { name: /^General/ });
        for (let attemptsLeft = 10; ; attemptsLeft--) {
            await rejectToastIfExists(page, "Verify this device", { timeout: 50 });
            await rejectToastIfExists(page, "Notifications", { timeout: 50 });
            try {
                await general.click({ timeout: 500 });
                break;
            } catch (e) {
                if (attemptsLeft === 1) throw e;
            }
        }
        const messages = kit.getByRole("main", { name: "Messages" });
        await expect(messages.getByText("Bob: Hi Alice!")).toBeVisible();
        // Emoji-only bodies arrive as text although the body view-model renders them as elements.
        await expect(messages.getByText("Bob: 🎉")).toBeVisible();
        await expect(kit.getByText("online")).toBeVisible();
        expect(await deviceId()).toBe(before);

        await kit.getByRole("button", { name: "Back to Element" }).click();
        await expect(page.locator('iframe[title="Fixture"]')).toHaveCount(0);
        await expect(page.getByRole("button", { name: "User menu", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
        expect(await deviceId()).toBe(before);

        // The choice is per device and survives a reload.
        await page.getByRole("button", { name: "User menu", exact: true }).click();
        await page.getByRole("menuitem", { name: "Switch to Fixture" }).click();
        await expect(kit.getByText("Alice (")).toBeVisible();
        await page.reload();
        await expect(page.frameLocator('iframe[title="Fixture"]').getByText("Alice (")).toBeVisible();
        expect(await deviceId()).toBe(before);
    });
});
