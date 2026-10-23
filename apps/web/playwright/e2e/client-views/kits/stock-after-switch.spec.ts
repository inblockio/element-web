/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// REQ-0004 V4 / H7: the kit mounts in its own frame and its global styles go away with it, so the stock screens after
// a switch to Rocket.Chat and back match what they were before. Self-contained: the "baseline" is a screenshot taken in
// the same run before the switch, so no committed image (and no platform- or font-dependent baseline file) is needed.
// Element's UI mounts again on the way back. Stock itself mounts a room's timeline again on every visit (RoomView is
// keyed by the room) and the read receipt it sent on load then hides the marker line, so the room's read marker is
// settled before the baseline; the open room's row keeps its selected highlight, and a message that arrived while
// Rocket.Chat was shown gets the marker line.

import { writeFileSync } from "node:fs";

import { type Page, type Locator } from "@playwright/test";
import { rejectToastIfExists } from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../../element-web-test";
import { KIT_FRAME, KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

/** Everything whose pixels differ between two runs of the same screen: times, avatars, presence, unread counts. */
const nonDeterministic = (page: Page): Locator[] => [
    page.locator(".mx_MessageTimestamp, .mx_DateSeparator, time"),
    page.locator(".mx_BaseAvatar, .mx_DecoratedRoomAvatar, .mx_UserMenu_userAvatar"),
    page.locator(".mx_NotificationBadge, .mx_RoomListItemView_notification"),
];

async function stockScreenshot(page: Page): Promise<Buffer> {
    await page.mouse.move(0, 0); // no hover state
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    return page.screenshot({
        mask: nonDeterministic(page),
        maskColor: "#ff00ff",
        animations: "disabled",
        caret: "hide",
    });
}

test.describe("Stock Element after a Rocket.Chat view", { tag: "@screenshot" }, () => {
    test.use(KIT_USE);

    test("the stock room view is pixel-identical after a switch to Rocket.Chat and back", async ({
        page,
        app,
        bot,
    }, testInfo) => {
        const roomId = await app.client.createRoom({
            name: "Stock Baseline",
            invite: [bot.credentials!.userId],
        });
        await bot.joinRoom(roomId);
        const { event_id: fixedId } = await app.client.sendMessage(roomId, "Fixed message for the stock baseline");
        // The read marker at the last message, as the first visit's read receipt leaves it for every later mount.
        await app.client.evaluate(
            (cli, [room, ev]) => cli.setRoomReadMarkersHttpRequest(room, ev, ev),
            [roomId, fixedId],
        );
        await expect
            .poll(() =>
                app.client.evaluate(
                    (cli, room) => cli.getRoom(room)?.getAccountData("m.fully_read")?.getContent().event_id,
                    roomId,
                ),
            )
            .toBe(fixedId);
        // Opening a room in Rocket.Chat reads it (the kit's markRead), so the kit opens this other room and the stock
        // room's read state stays Element's own.
        const otherId = await app.client.createRoom({ name: "Kit Side" });
        await app.client.sendMessage(otherId, "Message in the room the kit opens");
        const stockRoom = page.locator(".mx_RoomView");
        await app.viewRoomByName("Stock Baseline");
        await expect(stockRoom.getByText("Fixed message for the stock baseline")).toBeVisible();
        const settle = async () => {
            await rejectToastIfExists(page, "Verify this device", { timeout: 500 });
            await rejectToastIfExists(page, "Notifications", { timeout: 500 });
            await expect(page.locator(".mx_Toast_toast")).toHaveCount(0);
            await page.waitForTimeout(500);
        };
        await settle();
        const before = await stockScreenshot(page);

        // Out to Rocket.Chat, a room opened there, and back to Element from Rocket.Chat's own menu (as switch.spec.ts).
        const roundTrip = async (whileAway?: () => Promise<void>) => {
            const kit = await switchToRocketChat(page);
            const room = sidebarRoom(kit, "Kit Side");
            await expect(room).toBeVisible({ timeout: 30000 });
            await clickPastToasts(page, room);
            await expect(kit.getByText("Message in the room the kit opens")).toBeVisible({ timeout: 30000 });
            await whileAway?.();
            await clickPastToasts(page, kit.getByRole("button", { name: "User menu", exact: true }));
            await kit.getByRole("menuitemcheckbox", { name: "Switch to Element" }).click();
            await expect(page.locator(KIT_FRAME)).toHaveCount(0);
        };
        await roundTrip();
        await expect(stockRoom.getByText("Fixed message for the stock baseline")).toBeVisible();
        await settle();
        const after = await stockScreenshot(page);

        // Kept next to the test output, so a failure can be inspected by eye.
        for (const [name, body] of [
            ["stock-before.png", before],
            ["stock-after.png", after],
        ] as const) {
            const path = testInfo.outputPath(name);
            writeFileSync(path, body);
            await testInfo.attach(name, { path, contentType: "image/png" });
        }
        // Buffer equality: a failure prints no pixel diff, the two PNGs in the test output show it.
        expect(after.equals(before), "stock screen after the switch back differs from before the switch").toBe(true);

        // Read while away in Rocket.Chat's other room, unread here: the marker line stands right above it.
        await roundTrip(async () => {
            await bot.sendMessage(roomId, "Arrived while Rocket.Chat was shown");
        });
        const arrived = stockRoom.locator(".mx_EventTile", {
            hasText: "Arrived while Rocket.Chat was shown",
        });
        await expect(arrived).toBeVisible();
        const marker = stockRoom.locator(".mx_MessagePanel_myReadMarker hr");
        await expect(marker).toBeVisible();
        const [markerBox, arrivedBox] = [await marker.boundingBox(), await arrived.boundingBox()];
        expect(markerBox!.y).toBeLessThan(arrivedBox!.y);
        const fixedBox = await stockRoom
            .locator(".mx_EventTile", {
                hasText: "Fixed message for the stock baseline",
            })
            .boundingBox();
        expect(markerBox!.y).toBeGreaterThan(fixedBox!.y);
    });
});
