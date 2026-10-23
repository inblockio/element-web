/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Walks kits/rocketchat/CAPABILITIES.md (copied next to this spec by tools/e2e.sh) on an open room (H4): every shown
// row is rendered, every hidden row is absent, every N/A element is aria-disabled, inert, unfocusable and carries a
// visible "N/A" badge in the body-level layer outside React's tree; wired rows are not marked. Rows that render only
// in the user menu are checked while it is open. After the walk (E3): every call the adapter rejected (the stub log)
// is in the table of unanswered calls and maps to an N/A row or to none, and the browser never asked a Rocket.Chat
// REST path (the adapter answers or rejects in the page, nothing leaves it).

import { readFileSync } from "node:fs";

import { test, expect } from "../../../element-web-test";
import { type Capability, parseCapabilities, parseUnansweredCalls } from "./capabilities";
import { KIT_FRAME, KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

const markdown = readFileSync(new URL("./CAPABILITIES.md", import.meta.url), "utf8");
const rows = parseCapabilities(markdown);
const calls = parseUnansweredCalls(markdown, rows);

test.describe("Rocket.Chat view: capability map", () => {
    test.use(KIT_USE);

    test("marks every N/A function of the table and leaves wired and interim (D16) ones alone", async ({ page, app, bot }) => {
        test.setTimeout(90000);
        // A Rocket.Chat REST path is /api/v1/...; Matrix paths start with /_matrix.
        const restRequests: string[] = [];
        page.on("request", (request) => {
            if (/^\/(api|v1)\//.test(new URL(request.url()).pathname)) restRequests.push(request.url());
        });

        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Lunch at noon");

        const kit = await switchToRocketChat(page);
        await expect(sidebarRoom(kit, "Team Lunch")).toBeVisible({ timeout: 30000 });
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Lunch at noon")).toBeVisible({ timeout: 30000 });

        const checkRow = async (row: Capability) => {
            await test.step(`${row.id} (${row.presence}, ${row.status})`, async () => {
                const elements = kit.locator(row.selector);
                if (row.presence === "hidden") {
                    await expect(elements).toHaveCount(0);
                    return;
                }
                await expect(elements.first()).toBeVisible();
                const el = elements.first();
                // wired, interim (D16) and hand-off (D26) rows are working functions: no N/A mark, not inert.
                if (row.status === "wired" || row.status.startsWith("interim (D16") || row.status === "hand-off (D26)") {
                    await expect(el).not.toHaveAttribute("data-kit-na");
                    await expect(el).not.toHaveAttribute("inert");
                    return;
                }
                // Every element of the row is marked, not only the first.
                for (let i = 0; i < (await elements.count()); i++) {
                    const each = elements.nth(i);
                    await expect(each).toHaveAttribute("aria-disabled", "true");
                    await expect(each).toHaveAttribute("inert", "");
                    await expect(each).toHaveAttribute("aria-description", `Not available in this view: ${row.reason}`);
                    // inert: focus does not land on it.
                    expect(await each.evaluate((node: HTMLElement) => (node.focus(), node.ownerDocument.activeElement === node))).toBe(false);
                }
                // The badge lives in the body-level layer, not inside the element (React's tree).
                const badge = kit.locator(`body > #kit-na-layer [data-kit-na-badge="${row.id}"]`).first();
                await expect(badge).toBeVisible();
                await expect(badge).toHaveText("N/A");
                await expect(el.locator("[data-kit-na-badge]")).toHaveCount(0);
            });
        };

        for (const row of rows.filter((r) => r.presence !== "user-menu")) await checkRow(row);

        // The user menu renders its items in a portal; open it, check its rows, close it.
        await test.step("user menu rows", async () => {
            await kit.getByRole("button", { name: "User menu", exact: true }).click();
            await expect(kit.getByRole("menu")).toBeVisible();
            for (const row of rows.filter((r) => r.presence === "user-menu")) await checkRow(row);
            await page.keyboard.press("Escape");
            await expect(kit.getByRole("menu")).toHaveCount(0);
        });

        // The wired search filters the bridged rooms locally; its server part asks the (rejected) spotlight.
        await test.step("search lists the bridged room and asks the server", async () => {
            const search = kit.locator('[role="search"] input');
            await search.fill("Lun");
            await expect(kit.getByRole("option", { name: /Team Lunch/ })).toBeVisible();
            await search.fill("");
            await page.keyboard.press("Escape");
        });

        const frame = (await (await page.locator(KIT_FRAME).elementHandle())!.contentFrame())!;
        const stubbed = () => frame.evaluate(() => ((window as any).__clientViewStubLog as { name: string }[]).map((entry) => entry.name));
        await expect.poll(stubbed).toContain("/v1/spotlight");

        await test.step("every unanswered call maps to an N/A row or to none", async () => {
            const names = [...new Set(await stubbed())];
            expect(names.filter((name) => !calls.some((c) => c.call === name)), "calls missing from the unanswered-call table").toEqual([]);
            for (const name of names) {
                const { row } = calls.find((c) => c.call === name)!;
                if (row !== "none") expect(rows.find((r) => r.id === row)?.status, `${name} -> ${row}`).toBe("N/A");
            }
        });

        expect(restRequests, "Rocket.Chat REST requests that left the page").toEqual([]);
    });
});
