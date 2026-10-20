/*
 * element-views spike (M0, S4): the Rocket.Chat kit on live Synapse data, fed only by Element view-model snapshots.
 */

import { appendFileSync, writeFileSync } from "node:fs";

import { test, expect } from "../../element-web-test";

const OUT = process.env.RC_KIT_OUT ?? "test-results/rc-kit";

test.describe("element-views rc-kit spike", () => {
    test.use({ displayName: "Alice", botCreateOpts: { displayName: "Bob" } });

    test("Rocket.Chat view shows rooms and messages from view-models", async ({ page, app, user, bot, homeserver, request }) => {
        test.setTimeout(180_000);
        const requests: string[] = [];
        page.on("request", (r) => requests.push(r.url()));
        writeFileSync(`${OUT}/s4-console.log`, "");
        page.on("console", (m) => appendFileSync(`${OUT}/s4-console.log`, `${m.type()} ${m.location().url.split("/").pop()} ${m.text().slice(0, 400)}\n`));
        page.on("pageerror", (e) => appendFileSync(`${OUT}/s4-console.log`, `PAGEERROR ${String(e).slice(0, 600)}\n`));

        const general = await app.client.createRoom({ name: "General Chat", invite: [bot.credentials.userId] });
        const random = await app.client.createRoom({ name: "Random", invite: [bot.credentials.userId] });
        await bot.joinRoom(general);
        await bot.joinRoom(random);
        await app.client.sendMessage(general, {
            msgtype: "m.text",
            body: "Hello **world**, this is _markdown_",
            format: "org.matrix.custom.html",
            formatted_body: "Hello <strong>world</strong>, this is <em>markdown</em>",
        });
        await bot.sendMessage(general, "Hi Alice!");
        await bot.sendMessage(general, "🎉");
        await bot.sendMessage(random, "Anyone up for lunch?");

        await page.goto("/?rc_kit=1#/home");
        const kit = page.frameLocator('iframe[title="Rocket.Chat view"]');
        test.info().setTimeout(180_000);
        await page.waitForTimeout(8000);
        await page.screenshot({ path: `${OUT}/s4-boot.png` });

        // Sidebar (H3a): names and unread from RoomListViewModel snapshots.
        await expect(kit.getByText(/general.chat/i).first()).toBeVisible({ timeout: 30000 });
        const randomItem = kit.getByRole("link", { name: /random/i }).first();
        await expect(randomItem).toBeVisible();
        await expect(randomItem).toContainText("1");
        await page.screenshot({ path: `${OUT}/s4-sidebar.png` });

        // Messages (H3b): sender, text, markdown rendered by Rocket.Chat's own renderer.
        await kit.getByRole("link", { name: /general.chat/i }).first().click();
        await expect(kit.getByText("Hi Alice!")).toBeVisible({ timeout: 30000 });
        await expect(kit.locator("strong", { hasText: "world" }).first()).toBeVisible();
        await page.screenshot({ path: `${OUT}/s4-room-general.png` });
        await expect(kit.getByText("Bob").first()).toBeVisible();

        // Live update (H2): a new message from Bob reaches the open room through the snapshots.
        // Straight to Synapse: the page-bound bot handle resets on the kit iframe's history changes.
        const live = await request.put(
            `${homeserver.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(general)}/send/m.room.message/live1`,
            { headers: { Authorization: `Bearer ${bot.credentials.accessToken}` }, data: { msgtype: "m.text", body: "Live from Synapse" } },
        );
        expect(live.ok()).toBe(true);
        await expect(kit.getByText("Live from Synapse")).toBeVisible({ timeout: 30000 });
        await page.screenshot({ path: `${OUT}/s4-live.png` });

        // Room switch A -> B -> A keeps the messages.
        await kit.getByRole("link", { name: /random/i }).first().click();
        await expect(kit.getByText("Anyone up for lunch?")).toBeVisible({ timeout: 30000 });
        await page.screenshot({ path: `${OUT}/s4-room-random.png` });
        await kit.getByRole("link", { name: /general.chat/i }).first().click();
        await expect(kit.getByText("Live from Synapse")).toBeVisible({ timeout: 30000 });
        await expect(kit.getByText("Hi Alice!")).toBeVisible();
        await page.screenshot({ path: `${OUT}/s4-room-general-again.png` });

        const frame = (await (await page.locator('iframe[title="Rocket.Chat view"]').elementHandle())!.contentFrame())!;
        const kitLog = await frame.evaluate(() => {
            const w = window as unknown as Record<string, unknown>;
            return { rejected: w.__rcSpikeRejected, answered: w.__rcSpikeAnswered };
        });
        const evidence = await page.evaluate(() =>
            (window as unknown as { __rcKitSource: { evidence(): unknown } }).__rcKitSource.evidence(),
        );
        // H5: no Rocket.Chat REST path (Matrix's own /_matrix/... v1 paths are Element's, not Rocket.Chat's).
        const rcRest = requests.filter((u) => !u.includes("/_matrix/") && /\/(api|v1)\//.test(new URL(u).pathname));
        writeFileSync(`${OUT}/s4-evidence.json`, JSON.stringify({ rcRest, evidence, kitLog, requests }, null, 2));
        expect(rcRest).toEqual([]);
    });
});
