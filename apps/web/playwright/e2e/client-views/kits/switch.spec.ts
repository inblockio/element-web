/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Track-repo spec, copied into the Element worktree at playwright/e2e/client-views/kits/ by tools/e2e.sh and run
// against a composed app (BASE_URL). Rocket.Chat-view locators by role/label only.

import { test, expect } from "../../../element-web-test";
import { KIT_FRAME, KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

test.describe("Rocket.Chat view: switch", () => {
    test.use(KIT_USE);

    test("boots Rocket.Chat on the session, survives a reload inside the frame, switches back from its menu", async ({
        page,
        app,
        bot,
    }) => {
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Hi Alice!");

        const deviceId = () => page.evaluate(() => (window as any).mxMatrixClientPeg.get().getDeviceId() as string);
        const before = await deviceId();

        const kit = await switchToRocketChat(page);
        // Display name from the room-list view-model, not a slug.
        const room = sidebarRoom(kit, "Team Lunch");
        await expect(room).toBeVisible({ timeout: 30000 });
        await clickPastToasts(page, room);
        await expect(kit.getByText("Hi Alice!")).toBeVisible({ timeout: 30000 });
        expect(await deviceId()).toBe(before);
        if (process.env.KIT_ARIA_DUMP) console.log(await kit.locator("body").ariaSnapshot());

        const frame = (await (await page.locator(KIT_FRAME).elementHandle())!.contentFrame())!;
        const stubLog = await frame.evaluate(() => (window as any).__clientViewStubLog as unknown[]);
        // Unwired Rocket.Chat calls are rejected and recorded (H5), not crashes.
        expect(stubLog.length).toBeGreaterThan(0);
        console.log(`stub log: ${stubLog.length} entries, e.g. ${JSON.stringify(stubLog.slice(0, 5))}`);

        // D8: the document URL stays inside the kit; Rocket.Chat's route lives in the hash, so a reload inside the
        // frame boots the kit again at the same room instead of loading Element.
        expect(frame.url()).toMatch(/\/kits\/rocketchat\/?(index\.html)?#\/channel\/team-lunch-[0-9a-z]{6}$/);
        await frame.evaluate(() => window.location.reload());
        await expect(kit.getByText("Hi Alice!")).toBeVisible({ timeout: 30000 });
        expect(frame.url()).toMatch(/\/kits\/rocketchat\/?(index\.html)?#\/channel\/team-lunch-[0-9a-z]{6}$/);
        expect(await deviceId()).toBe(before);

        // Back to Element from Rocket.Chat's own user menu (H6): same session, no login page.
        await clickPastToasts(page, kit.getByRole("button", { name: "User menu", exact: true }));
        // Rocket.Chat's GenericMenu gives its items the menuitemcheckbox role.
        await kit.getByRole("menuitemcheckbox", { name: "Switch to Element" }).click();
        await expect(page.locator(KIT_FRAME)).toHaveCount(0);
        await expect(page.getByRole("button", { name: "User menu", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
        expect(await deviceId()).toBe(before);
    });

    test("hands a host room view (call, notification) over to Element's UI for that room; the next switch brings the kit back", async ({
        page,
        app,
        user: _user,
    }) => {
        const roomId = await app.client.createRoom({ name: "Call Room" });
        await app.client.createRoom({ name: "Other Room" });

        const kit = await switchToRocketChat(page);
        await expect(sidebarRoom(kit, "Other Room")).toBeVisible({ timeout: 30000 });

        // A clicked notification and an answered call both reach the host as a ViewRoom with this trigger shape.
        await page.evaluate(
            (room_id) =>
                (window as any).mxDispatcher.dispatch({ action: "view_room", room_id, metricsTrigger: "Notification" }),
            roomId,
        );
        await expect(page.locator(KIT_FRAME)).toHaveCount(0);
        await expect(page.locator(".mx_RoomHeader").getByText("Call Room")).toBeVisible();
        // Transient: the selected view is still the kit, so a reload of the page boots the kit again.
        expect(
            await page.evaluate(() => (window as any).mxSettingsStore.getValue("clientView") as string),
        ).toBe("rocketchat");

        const back = await switchToRocketChat(page);
        await expect(sidebarRoom(back, "Other Room")).toBeVisible({ timeout: 30000 });
    });
});
