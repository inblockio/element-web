/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Track-repo spec, copied into the Element worktree at playwright/e2e/client-views/kits/ by tools/e2e.sh and run
// against a composed app (BASE_URL). Rocket.Chat-view locators by role/label only.
// Capture run only: tools/e2e.sh with no spec argument runs every spec, and this one stays skipped unless CAPTURE_OUT
// is set (tools/capture.sh).

import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect } from "../../../element-web-test";
import { KIT_FRAME, KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

// video is a worker option: Playwright rejects it inside a describe group.
test.use({
    video: { mode: "on", size: { width: 1280, height: 800 } },
    viewport: { width: 1280, height: 800 },
});

test.describe("Rocket.Chat view: capture", () => {
    test.skip(!process.env.CAPTURE_OUT, "capture run only");
    test.use(KIT_USE);

    test("records stock Element, the Rocket.Chat view and the switch both ways", async ({ page, app, bot }) => {
        test.setTimeout(120_000);
        fs.mkdirSync(process.env.CAPTURE_OUT!, { recursive: true });
        const out = process.env.CAPTURE_OUT!;

        const lunch = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(lunch);
        await bot.sendMessage(lunch, "Hi Alice! Lunch at noon?");
        await app.client.sendMessage(lunch, "Sounds good, see you there.");
        await bot.sendMessage(lunch, "I'll book the table.");
        const review = await app.client.createRoom({ name: "Design Review", invite: [bot.credentials!.userId] });
        await bot.joinRoom(review);
        await bot.sendMessage(review, "See the new mockups.");

        const deviceId = () => page.evaluate(() => (window as any).mxMatrixClientPeg.get().getDeviceId() as string);
        const before = await deviceId();

        // Stock Element: the room list row, then the three messages in the open room.
        const stockRoom = page.getByTestId("room-list").locator('[title="Team Lunch"]').first();
        await clickPastToasts(page, stockRoom);
        const roomView = page.locator(".mx_RoomView");
        await expect(roomView.getByText("Hi Alice! Lunch at noon?")).toBeVisible({ timeout: 30000 });
        await expect(roomView.getByText("Sounds good, see you there.")).toBeVisible();
        await expect(roomView.getByText("I'll book the table.")).toBeVisible();
        await page.waitForTimeout(1000);
        // Element's first-run "Introducing Sections" tip covers the room header; dismiss it so the shots show the room.
        const tip = page.getByRole("button", { name: "Ok", exact: true });
        if (await tip.isVisible()) await tip.click();
        await page.screenshot({ path: path.join(out, "01-element-stock.png") });
        expect(await deviceId()).toBe(before);

        const kit = await switchToRocketChat(page);
        const room = sidebarRoom(kit, "Team Lunch");
        await expect(room).toBeVisible({ timeout: 30000 });
        await clickPastToasts(page, room);
        await expect(kit.getByText("I'll book the table.")).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(1000);
        await page.screenshot({ path: path.join(out, "02-rocketchat-view.png") });
        expect(await deviceId()).toBe(before);

        // Back to Element from Rocket.Chat's own user menu, same sequence as switch.spec.ts.
        await clickPastToasts(page, kit.getByRole("button", { name: "User menu", exact: true }));
        // Rocket.Chat's GenericMenu gives its items the menuitemcheckbox role.
        await kit.getByRole("menuitemcheckbox", { name: "Switch to Element" }).click();
        await expect(page.locator(KIT_FRAME)).toHaveCount(0);
        await expect(page.getByRole("button", { name: "User menu", exact: true })).toBeVisible();
        await page.waitForTimeout(1000);
        await page.screenshot({ path: path.join(out, "03-element-after-switch-back.png") });
        expect(await deviceId()).toBe(before);

        const video = page.video();
        await page.close();
        await video!.saveAs(path.join(out, "04-switch-both-ways.webm"));
    });
});
