/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// M5 A10, room item actions: Alice marks a room unread, favourites it and sets its notification level in the Rocket.Chat
// view. These are Alice's own per-user state, which bot Bob cannot see, so D21 reads the homeserver through a SECOND Alice
// session (own login, plain REST): the room tag `m.favourite`, the room account data `m.marked_unread`, the push rules.
// The failure path routes the write to a 500: the view keeps no star, unread mark or level, and the homeserver holds none.

import { type FrameLocator, type Page } from "@playwright/test";

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

/** Alice's second session on the homeserver, and her state of one room as that session reads it. */
function secondSession(creds: { homeserverBaseUrl: string; accessToken: string; userId: string }) {
    const get = async (path: string): Promise<any | undefined> => {
        const res = await fetch(`${creds.homeserverBaseUrl}/_matrix/client/v3${path}`, {
            headers: { Authorization: `Bearer ${creds.accessToken}` },
        });
        if (res.status === 404) return undefined;
        if (!res.ok) throw new Error(`${path}: ${res.status}`);
        return res.json();
    };
    const user = encodeURIComponent(creds.userId);
    return {
        tags: async (roomId: string): Promise<string[]> =>
            Object.keys((await get(`/user/${user}/rooms/${encodeURIComponent(roomId)}/tags`))?.tags ?? {}),
        /** The marked-unread flag as a client reads it: the stable type, else the unstable one. */
        markedUnread: async (roomId: string): Promise<boolean> => {
            for (const type of ["m.marked_unread", "com.famedly.marked_unread"]) {
                const data = await get(`/user/${user}/rooms/${encodeURIComponent(roomId)}/account_data/${type}`);
                if (data?.unread !== undefined) return Boolean(data.unread);
            }
            return false;
        },
        /** Element's four levels from the room's push rules: an override rule that does not notify mutes, a room rule that does not notify is mentions only. */
        level: async (roomId: string): Promise<"mute" | "mentions_only" | "all_messages"> => {
            const global = (await get("/pushrules/"))?.global ?? {};
            const own = (kind: string) =>
                (global[kind] ?? []).find((r: any) => r.rule_id === roomId && r.enabled !== false) as any;
            const silent = (r: any) => r.actions.length === 0 || (r.actions.length === 1 && r.actions[0] === "dont_notify");
            if (own("override") && silent(own("override"))) return "mute";
            if (own("room") && silent(own("room"))) return "mentions_only";
            return "all_messages";
        },
        /** Gives the room a push rule that notifies with a sound (Element's "all messages, loud"), as another client would. */
        setLoud: async (roomId: string): Promise<void> => {
            const res = await fetch(`${creds.homeserverBaseUrl}/_matrix/client/v3/pushrules/global/room/${encodeURIComponent(roomId)}`, {
                method: "PUT",
                headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ actions: ["notify", { set_tweak: "sound", value: "default" }] }),
            });
            expect(res.status).toBe(200);
        },
        /** Whether the room has the loud room rule. */
        loud: async (roomId: string): Promise<boolean> => {
            const global = (await get("/pushrules/"))?.global ?? {};
            return (global.room ?? []).some(
                (r: any) =>
                    r.rule_id === roomId && r.enabled !== false && r.actions.some((a: any) => a && typeof a === "object" && a.set_tweak === "sound"),
            );
        },
        whoami: async (): Promise<number> =>
            (await fetch(`${creds.homeserverBaseUrl}/_matrix/client/v3/account/whoami`, {
                headers: { Authorization: `Bearer ${creds.accessToken}` },
            })).status,
    };
}

/** Opens the room's menu in Rocket.Chat's sidebar. */
async function openRoomMenu(page: Page, kit: FrameLocator, name: string): Promise<void> {
    const link = sidebarRoom(kit, name);
    await clickPastToasts(page, link);
    await link.hover();
    await link.locator('button[title="Options"]').click();
}

test.describe("Rocket.Chat view: favourite, mark unread, notification level", () => {
    test.use(KIT_USE);

    const setup = async ({ app, bot, homeserver, user }: any) => {
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Lunch at noon");
        const second = secondSession(await homeserver.loginUser(user.userId, user.password!));
        return { roomId, second };
    };

    test("favourite and unfavourite reach the homeserver, a second Alice session reads the tag", async ({
        page,
        app,
        bot,
        homeserver,
        user,
    }) => {
        test.setTimeout(150000);
        const { roomId, second } = await setup({ app, bot, homeserver, user });
        const kit = await switchToRocketChat(page);
        await expect(sidebarRoom(kit, "Team Lunch")).toBeVisible({ timeout: 30000 });

        await openRoomMenu(page, kit, "Team Lunch");
        await kit.getByRole("menuitem", { name: "Favorite", exact: true }).click();
        await expect.poll(() => second.tags(roomId), { timeout: 30000 }).toContain("m.favourite");

        // The view shows it: the menu now offers to take the star off, and the room header's star is on.
        await openRoomMenu(page, kit, "Team Lunch");
        await expect(kit.getByRole("menuitem", { name: "Unfavorite", exact: true })).toBeVisible({ timeout: 30000 });
        await kit.getByRole("menuitem", { name: "Unfavorite", exact: true }).click();
        await expect.poll(() => second.tags(roomId), { timeout: 30000 }).not.toContain("m.favourite");
        await openRoomMenu(page, kit, "Team Lunch");
        await expect(kit.getByRole("menuitem", { name: "Favorite", exact: true })).toBeVisible({ timeout: 30000 });
    });

    test("a tag write the homeserver refuses leaves no star in the view and no tag on the server", async ({
        page,
        app,
        bot,
        homeserver,
        user,
    }) => {
        test.setTimeout(150000);
        const { roomId, second } = await setup({ app, bot, homeserver, user });
        await page.route(/\/_matrix\/client\/v3\/user\/[^/]+\/rooms\/[^/]+\/tags\//, (route) =>
            route.request().method() === "PUT"
                ? route.fulfill({
                      status: 500,
                      contentType: "application/json",
                      body: JSON.stringify({ errcode: "M_UNKNOWN", error: "tag write refused" }),
                  })
                : route.continue(),
        );
        const kit = await switchToRocketChat(page);
        await expect(sidebarRoom(kit, "Team Lunch")).toBeVisible({ timeout: 30000 });
        await openRoomMenu(page, kit, "Team Lunch");
        await kit.getByRole("menuitem", { name: "Favorite", exact: true }).click();

        // Element's own error dialog, then Rocket.Chat's error toast.
        const dialog = page.getByRole("dialog").filter({ hasText: /Failed|Error/i }).first();
        await expect(dialog).toBeVisible({ timeout: 30000 });
        await dialog.getByRole("button", { name: /OK|Close/ }).first().click();
        await expect(kit.getByRole("alert").first()).toBeVisible({ timeout: 30000 });

        expect(await second.tags(roomId)).not.toContain("m.favourite");
        await openRoomMenu(page, kit, "Team Lunch");
        await expect(kit.getByRole("menuitem", { name: "Favorite", exact: true })).toBeVisible();
        await expect(kit.getByRole("menuitem", { name: "Unfavorite", exact: true })).toHaveCount(0);
    });

    test("mark unread writes the room's unread mark; the sidebar shows it unread and the second session reads it", async ({
        page,
        app,
        bot,
        homeserver,
        user,
    }) => {
        test.setTimeout(150000);
        const { roomId, second } = await setup({ app, bot, homeserver, user });
        const kit = await switchToRocketChat(page);
        await expect(sidebarRoom(kit, "Team Lunch")).toBeVisible({ timeout: 30000 });
        // Read first: opening the room reads it (Bob's message), so the room can be marked unread.
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Lunch at noon").first()).toBeVisible({ timeout: 30000 });
        await expect(sidebarRoom(kit, "Team Lunch")).not.toHaveAttribute("data-unread", "true", { timeout: 30000 });
        expect(await second.markedUnread(roomId)).toBe(false);

        await openRoomMenu(page, kit, "Team Lunch");
        await kit.getByRole("menuitem", { name: "Mark Unread", exact: true }).click();
        await expect.poll(() => second.markedUnread(roomId), { timeout: 30000 }).toBe(true);
        await expect(sidebarRoom(kit, "Team Lunch")).toHaveAttribute("data-unread", "true", { timeout: 30000 });
        // Element agrees (its own room account data).
        await openRoomMenu(page, kit, "Team Lunch");
        await expect(kit.getByRole("menuitem", { name: "Mark Read", exact: true })).toBeVisible({ timeout: 30000 });
    });

    test("a mark the homeserver refuses leaves the room read in the view and unmarked on the server", async ({
        page,
        app,
        bot,
        homeserver,
        user,
    }) => {
        test.setTimeout(150000);
        const { roomId, second } = await setup({ app, bot, homeserver, user });
        await page.route(/\/account_data\/(m|com\.famedly)\.marked_unread/, (route) =>
            route.request().method() === "PUT"
                ? route.fulfill({
                      status: 500,
                      contentType: "application/json",
                      body: JSON.stringify({ errcode: "M_UNKNOWN", error: "account data refused" }),
                  })
                : route.continue(),
        );
        const kit = await switchToRocketChat(page);
        await expect(sidebarRoom(kit, "Team Lunch")).toBeVisible({ timeout: 30000 });
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Lunch at noon").first()).toBeVisible({ timeout: 30000 });
        await openRoomMenu(page, kit, "Team Lunch");
        await kit.getByRole("menuitem", { name: "Mark Unread", exact: true }).click();

        await expect(kit.getByRole("alert").first()).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(2000);
        expect(await second.markedUnread(roomId)).toBe(false);
        await expect(sidebarRoom(kit, "Team Lunch")).not.toHaveAttribute("data-unread", "true");
    });

    /** Rocket.Chat's Notification Preferences panel of the open room. */
    async function openPreferences(kit: FrameLocator): Promise<void> {
        await kit.getByRole("toolbar").first().getByRole("button", { name: "Options" }).click();
        await kit.getByRole("menuitem", { name: "Notifications Preferences" }).click();
    }

    test("the notification preferences set Element's level; the second session reads the push rules", async ({
        page,
        app,
        bot,
        homeserver,
        user,
    }) => {
        test.setTimeout(150000);
        const { roomId, second } = await setup({ app, bot, homeserver, user });
        const kit = await switchToRocketChat(page);
        await expect(sidebarRoom(kit, "Team Lunch")).toBeVisible({ timeout: 30000 });
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Lunch at noon").first()).toBeVisible({ timeout: 30000 });
        expect(await second.level(roomId)).toBe("all_messages");

        // Mentions only: the desktop alert "Mentions".
        await openPreferences(kit);
        await kit.getByRole("button", { name: "Desktop" }).click();
        await kit.getByRole("button", { name: "All messages" }).click();
        await kit.getByRole("option", { name: "Mentions" }).click();
        await kit.getByRole("button", { name: "Save", exact: true }).click();
        await expect.poll(() => second.level(roomId), { timeout: 30000 }).toBe("mentions_only");
        // The view shows what Element holds: the panel, opened again, has the alert "Mentions".
        await kit.getByRole("button", { name: "Close" }).first().click();
        await openPreferences(kit);
        await kit.getByRole("button", { name: "Desktop" }).click();
        await expect(kit.locator("button:not([inert])").filter({ hasText: /Mentions/ })).toBeVisible({ timeout: 30000 });
        // And back to all messages: the rule is removed.
        await kit.locator("button:not([inert])").filter({ hasText: /Mentions/ }).first().click();
        await kit.getByRole("option", { name: "All messages" }).click();
        await kit.getByRole("button", { name: "Save", exact: true }).click();
        await expect.poll(() => second.level(roomId), { timeout: 30000 }).toBe("all_messages");

        // Off: the "Turn on notifications" switch.
        await kit.getByText("Turn on", { exact: true }).click();
        await kit.getByRole("button", { name: "Save", exact: true }).click();
        await expect.poll(() => second.level(roomId), { timeout: 30000 }).toBe("mute");
    });

    test("a level the homeserver refuses is not kept: the panel still shows the level the server holds", async ({
        page,
        app,
        bot,
        homeserver,
        user,
    }) => {
        test.setTimeout(150000);
        const { roomId, second } = await setup({ app, bot, homeserver, user });
        await page.route(/\/_matrix\/client\/v3\/pushrules\//, (route) =>
            route.request().method() === "PUT" || route.request().method() === "DELETE"
                ? route.fulfill({
                      status: 500,
                      contentType: "application/json",
                      body: JSON.stringify({ errcode: "M_UNKNOWN", error: "push rule write refused" }),
                  })
                : route.continue(),
        );
        const kit = await switchToRocketChat(page);
        await expect(sidebarRoom(kit, "Team Lunch")).toBeVisible({ timeout: 30000 });
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Lunch at noon").first()).toBeVisible({ timeout: 30000 });

        await openPreferences(kit);
        await kit.getByRole("button", { name: "Desktop" }).click();
        await kit.getByRole("button", { name: "All messages" }).click();
        await kit.getByRole("option", { name: "Mentions" }).click();
        await kit.getByRole("button", { name: "Save", exact: true }).click();
        await expect(kit.getByRole("alert").first()).toBeVisible({ timeout: 30000 });

        // The homeserver holds nothing, and the view does not keep the level: the panel, opened again, shows all messages.
        expect(await second.level(roomId)).toBe("all_messages");
        await kit.getByRole("button", { name: "Close" }).first().click();
        await openPreferences(kit);
        await kit.getByRole("button", { name: "Desktop" }).click();
        await expect(kit.getByRole("button", { name: "All messages" })).toBeVisible({ timeout: 30000 });
    });

    test("a new direct chat (Element's local room) is not shown unread", async ({ page, app, bot }) => {
        test.setTimeout(150000);
        const kit = await switchToRocketChat(page);
        await kit.locator(":focus").evaluate((el: HTMLElement) => el.blur()).catch(() => {});
        await clickPastToasts(page, kit.locator('button[title="Create new"]'));
        await kit.getByRole("menuitem", { name: "Direct message", exact: true }).click();
        const search = page.getByRole("dialog", { name: "Direct Messages" }).getByRole("textbox", { name: "Search" });
        await search.fill(bot.credentials!.userId);
        await page.getByRole("option", { name: /Bob/ }).first().click();
        await page.getByRole("button", { name: "Go" }).click();
        await page.getByRole("button", { name: "Continue" }).click({ timeout: 3000 }).catch(() => {});
        await expect(search).toHaveCount(0, { timeout: 30000 });
        const row = sidebarRoom(kit, "Bob");
        await expect(row).toBeVisible({ timeout: 30000 });
        // Nothing is unread in a chat that has no message yet: no bold row, whatever Element says about marking it unread.
        for (let i = 0; i < 10; i++) {
            await expect(row).not.toHaveAttribute("data-unread", "true");
            await page.waitForTimeout(200);
        }
    });

    test("saving the notification preferences of an all-messages-loud room does not downgrade the loud rule", async ({
        page,
        app,
        bot,
        homeserver,
        user,
    }) => {
        test.setTimeout(150000);
        const { roomId, second } = await setup({ app, bot, homeserver, user });
        await second.setLoud(roomId);
        const kit = await switchToRocketChat(page);
        await expect(sidebarRoom(kit, "Team Lunch")).toBeVisible({ timeout: 30000 });
        await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
        await expect(kit.getByText("Lunch at noon").first()).toBeVisible({ timeout: 30000 });
        // Element has the loud level (the rule came with the sync) before the form is opened and saved unchanged.
        await expect.poll(() => second.loud(roomId), { timeout: 30000 }).toBe(true);
        await page.waitForTimeout(3000);
        await openPreferences(kit);
        await kit.getByRole("button", { name: "Desktop" }).click();
        await expect(kit.getByRole("button", { name: "All messages" })).toBeVisible({ timeout: 30000 });
        // Change another field of the form (mute @all and @here) and save: the desktop alert still says "All messages".
        await kit.getByText("Mute @all and @here mentions", { exact: true }).click();
        await kit.getByRole("button", { name: "Save", exact: true }).click();
        // No level change was sent: the loud rule stays on the homeserver.
        await page.waitForTimeout(4000);
        expect(await second.loud(roomId)).toBe(true);
        await expect(kit.getByRole("alert")).toHaveCount(0);
    });
});
