/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Shared helpers of the track's Rocket.Chat specs (copied next to them by tools/e2e.sh).

import { type Page, type FrameLocator, type Locator } from "@playwright/test";
import { rejectToastIfExists } from "@element-hq/element-web-playwright-common";

export const KIT_FRAME = 'iframe[title="Rocket.Chat"]';

/** test.use() options of every Rocket.Chat spec: Alice, a bot Bob, the views flag and the kit descriptor. */
export const KIT_USE = {
    displayName: "Alice",
    botCreateOpts: { displayName: "Bob" },
    labsFlags: ["feature_client_views"],
    config: { client_views: [{ id: "rocketchat", name: "Rocket.Chat", url: "/kits/rocketchat/index.html" }] } as object,
};

/** Opens the user menu and picks the Rocket.Chat view. */
export async function switchToRocketChat(page: Page): Promise<FrameLocator> {
    await page.getByRole("button", { name: "User menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Switch to Rocket.Chat" }).click();
    return page.frameLocator(KIT_FRAME);
}

/** Clicks through the host's toasts, which cover the kit as they cover the stock room list. */
export async function clickPastToasts(page: Page, target: Locator): Promise<void> {
    for (let attemptsLeft = 20; ; attemptsLeft--) {
        await rejectToastIfExists(page, "Verify this device", { timeout: 50 });
        await rejectToastIfExists(page, "Notifications", { timeout: 50 });
        try {
            await target.click({ timeout: 1000 });
            return;
        } catch (e) {
            if (attemptsLeft === 1) throw e;
        }
    }
}

/** A room's entry in Rocket.Chat's sidebar, by its display name. */
export const sidebarRoom = (kit: FrameLocator, name: string): Locator =>
    kit.getByRole("link", { name: new RegExp(name) }).first();
