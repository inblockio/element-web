/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// M5 A4, load older history: bot Bob has posted more messages than the first window holds before Alice joins the room;
// Alice scrolls up in the Rocket.Chat view and Rocket.Chat's own history request pulls older messages from Matrix until
// the oldest one is shown. The first view must not already hold it (the room really is longer than its first window).
// D21: what the view shows is what the homeserver holds (Bob's messages in order, none missing or doubled at the seam
// between pages), and a pagination that fails leaves the view consistent (no phantom rows, no endless spinner) and a
// later scroll retries and loads.

import { test, expect } from "../../../element-web-test";
import { KIT_FRAME, KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

const COUNT = 230;
const label = (n: number): string => `history ${String(n).padStart(3, "0")}`;
/** Failed pagination requests that are enough to show: one history call tries three pages. */
const FAILURES = 3;

test.describe("Rocket.Chat view: load older messages", () => {
    test.use(KIT_USE);

    test("scrolling up in a long room brings in its oldest message, also after a failed page", async ({
        page,
        app,
        bot,
    }) => {
        test.setTimeout(300000);
        // Bob's room is long before Alice is in it: she joins afterwards, so her client holds only the newest events its
        // sync brought and everything older has to be paged in from the homeserver.
        const roomId = await bot.createRoom({ name: "Long History" });
        for (let n = 1; n <= COUNT; n++) await bot.sendMessage(roomId, label(n));
        await bot.inviteUser(roomId, await app.client.evaluate((cli) => cli.getSafeUserId()));
        await app.client.joinRoom(roomId);

        // What the homeserver holds, oldest first.
        const expected = Array.from({ length: COUNT }, (_, i) => label(i + 1));
        const held = await app.client.evaluate(async (cli, id) => {
            const res = await cli.createMessagesRequest(id, null, 1000, "b" as never);
            return res.chunk
                .filter((ev) => ev.type === "m.room.message")
                .map((ev) => ev.content.body as string)
                .reverse();
        }, roomId);
        expect(held).toEqual(expected);

        // Pagination requests fail on the wire once the first two history answers are in (the room's first window, and the
        // page Rocket.Chat asks for at once) and until `failing` is switched off: the pages after that cannot load.
        let failing = true;
        let failed = 0;
        const historyAnswers = (): Promise<number> =>
            Promise.all(page.frames().map((f) => f.evaluate(() => (window as never as { __clientViewHistory?: { answered: number } }).__clientViewHistory?.answered ?? 0).catch(() => 0))).then((a) => Math.max(0, ...a));
        await page.route(/\/_matrix\/client\/v3\/rooms\/[^/]+\/messages/, async (route) => {
            if (failing && (await historyAnswers()) >= 2) {
                failed++;
                await route.fulfill({ status: 500, json: { errcode: "M_UNKNOWN", error: "pagination failed (test)" } });
            } else await route.continue();
        });

        const kit = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(kit, "Long History"));
        await expect(kit.getByText(label(COUNT), { exact: true })).toBeVisible({ timeout: 60000 });
        // More than the first window: the oldest message is not loaded yet.
        await expect(kit.getByText(label(1), { exact: true })).toHaveCount(0);

        // The rows in the DOM, as numbers: every one is a message the homeserver holds, each once, consecutive.
        const rows = async (): Promise<number[]> => {
            const texts = await kit.getByText(/^history \d{3}$/).allTextContents();
            return texts.map((t) => Number(t.slice(8)));
        };
        const consistent = async (): Promise<void> => {
            const nums = await rows();
            expect(new Set(nums).size).toBe(nums.length);
            expect(nums.every((n) => n >= 1 && n <= COUNT)).toBe(true);
            nums.slice(1).forEach((n, i) => expect(n).toBe(nums[i] + 1));
        };
        await consistent();

        // The user's wheel over the message list (Rocket.Chat asks for older messages when a scroll ends near the top).
        const list = kit.locator(".messages-box").first();
        const wheel = async (dy: number): Promise<void> => {
            const box = await list.boundingBox();
            if (!box) return;
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(0, dy);
        };
        const oldest = kit.getByText(label(1), { exact: true });

        // A failed page: the requests were made and failed, nothing is shown that was not there, the spinner goes.
        await expect
            .poll(
                async () => {
                    await wheel(-4000);
                    return failed;
                },
                { timeout: 60000, intervals: [500] },
            )
            .toBeGreaterThanOrEqual(FAILURES);
        failing = false;
        await expect.poll(() => kit.locator(".load-more .loading__animation").count(), { timeout: 60000 }).toBe(0);
        await consistent();
        await expect(oldest).toHaveCount(0);

        // A later scroll (after the kit's pause for a failing homeserver) retries and loads, to the room's start.
        await page.waitForTimeout(5500);
        await expect
            .poll(
                async () => {
                    await wheel(800);
                    await wheel(-4000);
                    return oldest.count();
                },
                { timeout: 150000, intervals: [500] },
            )
            .toBeGreaterThan(0);
        await expect(oldest.first()).toBeVisible();
        await expect.poll(() => kit.locator(".load-more .loading__animation").count()).toBe(0);

        // Top to bottom: the rows are the homeserver's messages in order, none missing, none doubled at a page seam.
        const seen = new Set<number>();
        for (let step = 0; step < 200 && seen.size < COUNT; step++) {
            await consistent();
            (await rows()).forEach((n) => seen.add(n));
            await wheel(500);
            await page.waitForTimeout(150);
        }
        expect([...seen].sort((a, b) => a - b).map(label)).toEqual(held);
        await expect(page.locator(KIT_FRAME)).toBeVisible();

        // Reopened view (grok F1): Element keeps the room's timeline, with the creation event in it, while the view-model
        // of the new view windows only the newest events. The older ones must still be paged in, not reported as the start.
        await clickPastToasts(page, kit.getByRole("button", { name: "User menu", exact: true }));
        await kit.getByRole("menuitemcheckbox", { name: "Switch to Element" }).click();
        await expect(page.locator(KIT_FRAME)).toHaveCount(0);
        const reopened = await switchToRocketChat(page);
        await clickPastToasts(page, sidebarRoom(reopened, "Long History"));
        await expect(reopened.getByText(label(COUNT), { exact: true })).toBeVisible({ timeout: 60000 });
        const reopenedList = reopened.locator(".messages-box").first();
        const reopenedOldest = reopened.getByText(label(1), { exact: true });
        await expect
            .poll(
                async () => {
                    const box = await reopenedList.boundingBox();
                    if (box) {
                        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                        await page.mouse.wheel(0, -4000);
                    }
                    return reopenedOldest.count();
                },
                { timeout: 150000, intervals: [500] },
            )
            .toBeGreaterThan(0);
    });
});
