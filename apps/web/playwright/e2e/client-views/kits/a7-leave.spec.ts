/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// M5 A7, leave a room: Alice picks Leave in a room's menu in the Rocket.Chat view; Element's own leave confirm opens over
// the view (D17, Rocket.Chat's warning modal is skipped). Confirmed, bot Bob sees Alice's membership drop to `leave` and
// the room leaves Alice's sidebar. D21: "Cancel" changes nothing, and a leave the homeserver refuses leaves the room in
// the sidebar and Alice a member for Bob.

import { type FrameLocator, type Page } from "@playwright/test";

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

/** Opens the room's menu in Rocket.Chat's sidebar and picks "Leave room". */
async function pickLeave(page: Page, kit: FrameLocator, name: string): Promise<void> {
    const link = sidebarRoom(kit, name);
    await clickPastToasts(page, link); // also clears the host's toasts that cover the sidebar
    await link.hover();
    await link.locator('button[title="Options"]').click();
    await kit.getByRole("menuitem", { name: "Leave", exact: true }).click();
}

test.describe("Rocket.Chat view: leave a room", () => {
    test.use(KIT_USE);

    const membershipSeenByBob = (bot: any, roomId: string, userId: string) =>
        bot.evaluate((cli: any, { id, user }: { id: string; user: string }) => cli.getRoom(id)?.getMember(user)?.membership, {
            id: roomId,
            user: userId,
        });

    test("leaves through Element's confirm; Bob sees the leave and the room leaves the sidebar", async ({ page, app, bot }) => {
        test.setTimeout(120000);
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Lunch at noon");

        const kit = await switchToRocketChat(page);
        await expect(sidebarRoom(kit, "Team Lunch")).toBeVisible({ timeout: 30000 });
        await pickLeave(page, kit, "Team Lunch");

        // Element's own confirm, over the view; Rocket.Chat's warning modal does not appear.
        const confirm = page.locator(".mx_LeaveRoomDialog");
        await expect(confirm).toBeVisible();
        await expect(kit.getByText(/Leave room|leave this room/i).filter({ hasText: /warning/i })).toHaveCount(0);
        await confirm.getByRole("button", { name: "Leave" }).click();

        // The homeserver holds the leave: Bob sees Alice's membership drop.
        await expect.poll(() => membershipSeenByBob(bot, roomId, aliceId), { timeout: 30000 }).toBe("leave");
        // Element's state agrees, and the room is gone from the Rocket.Chat sidebar.
        await expect
            .poll(() => app.client.evaluate((cli, id) => cli.getRoom(id)?.getMyMembership(), roomId), { timeout: 30000 })
            .toBe("leave");
        await expect(sidebarRoom(kit, "Team Lunch")).toHaveCount(0, { timeout: 30000 });
    });

    test("Cancel in Element's confirm changes nothing", async ({ page, app, bot }) => {
        test.setTimeout(120000);
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);

        const kit = await switchToRocketChat(page);
        await expect(sidebarRoom(kit, "Team Lunch")).toBeVisible({ timeout: 30000 });
        await pickLeave(page, kit, "Team Lunch");
        const confirm = page.locator(".mx_LeaveRoomDialog");
        await expect(confirm).toBeVisible();
        await confirm.getByRole("button", { name: "Cancel" }).click();
        await expect(confirm).toHaveCount(0);

        await page.waitForTimeout(3000);
        expect(await membershipSeenByBob(bot, roomId, aliceId)).toBe("join");
        await expect(sidebarRoom(kit, "Team Lunch")).toBeVisible();
        // A cancelled leave is not an error: no toast in the view.
        await expect(kit.getByRole("alert")).toHaveCount(0);
    });

    test("a leave the homeserver refuses leaves the room listed and Alice a member for Bob", async ({ page, app, bot }) => {
        test.setTimeout(120000);
        const aliceId = await app.client.evaluate((cli) => cli.getSafeUserId());
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await page.route(/\/_matrix\/client\/v3\/rooms\/[^/]+\/leave/, (route) =>
            route.fulfill({
                status: 403,
                contentType: "application/json",
                body: JSON.stringify({ errcode: "M_FORBIDDEN", error: "You may not leave this room" }),
            }),
        );

        const kit = await switchToRocketChat(page);
        await expect(sidebarRoom(kit, "Team Lunch")).toBeVisible({ timeout: 30000 });
        await pickLeave(page, kit, "Team Lunch");
        await page.locator(".mx_LeaveRoomDialog").getByRole("button", { name: "Leave" }).click();

        // Element reports the error in its own dialog; the view shows Rocket.Chat's error toast.
        await expect(page.getByRole("dialog").filter({ hasText: /Error|could not|Failed/i }).first()).toBeVisible({ timeout: 30000 });
        await page.getByRole("dialog").getByRole("button", { name: /OK|Close/ }).first().click();
        await expect(kit.getByRole("alert").first()).toBeVisible({ timeout: 30000 });

        // No ghost: the room is still listed, Alice is still a member for Bob, and Element agrees.
        await expect(sidebarRoom(kit, "Team Lunch")).toBeVisible();
        expect(await membershipSeenByBob(bot, roomId, aliceId)).toBe("join");
        expect(await app.client.evaluate((cli, id) => cli.getRoom(id)?.getMyMembership(), roomId)).toBe("join");
    });
});
