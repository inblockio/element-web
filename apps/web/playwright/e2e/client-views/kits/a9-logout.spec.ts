/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// M5 A9, log out: Alice picks "Logout" in the Rocket.Chat user menu; Element's own sign-out (its LogoutDialog, the key backup
// check) opens over the view and Rocket.Chat's own flow does not exist for it. D21: after the confirm the old access token
// answers 401 on /account/whoami, the device is gone from the homeserver's device list (read from a SECOND Alice session),
// nothing of the Rocket.Chat view survives in the page's storage and the app is on Element's welcome or login. Dismissing
// the dialog keeps everything: the token is valid, the device is still listed, the view is still there.

import { type FrameLocator, type Page } from "@playwright/test";

import { test, expect } from "../../../element-web-test";
import { KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";

const status = async (base: string, token: string): Promise<number> =>
    (await fetch(`${base}/_matrix/client/v3/account/whoami`, { headers: { Authorization: `Bearer ${token}` } })).status;

/** The device ids of the user as a second session lists them. */
async function devicesOf(second: { homeserverBaseUrl: string; accessToken: string }): Promise<string[]> {
    const res = await fetch(`${second.homeserverBaseUrl}/_matrix/client/v3/devices`, {
        headers: { Authorization: `Bearer ${second.accessToken}` },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { devices: { device_id: string }[] }).devices.map((d) => d.device_id);
}

/** Opens a room and leaves an unsent draft in Rocket.Chat's composer (the kit keeps it under `messagebox_<room id>`). */
async function typeDraft(page: Page, kit: FrameLocator, app: any, bot: any, draft: string): Promise<void> {
    const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
    await bot.joinRoom(roomId);
    await bot.sendMessage(roomId, "Lunch at noon");
    await clickPastToasts(page, sidebarRoom(kit, "Team Lunch"));
    await expect(kit.getByText("Lunch at noon").first()).toBeVisible({ timeout: 30000 });
    const composer = kit.getByRole("textbox", { name: /^Message/ });
    await composer.click();
    await composer.fill(draft);
    // The draft is stored with the input; wait until the page holds it (the audit point: it must not survive the sign-out).
    await expect
        .poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("messagebox_")).length), {
            timeout: 15000,
        })
        .toBeGreaterThan(0);
}

/** Opens the Rocket.Chat user menu and picks "Logout". */
async function pickLogout(page: Page, kit: FrameLocator): Promise<void> {
    await kit.getByRole("button", { name: "User menu", exact: true }).click();
    await kit.getByRole("menuitemcheckbox", { name: "Logout", exact: true }).click();
}

/** Element's own sign-out dialog, over the view; which one it is depends on the key backup (both are Element's). */
const signOutDialog = (page: Page) =>
    page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: /Remove this device|lose access/i }) });

test.describe("Rocket.Chat view: log out", () => {
    test.use(KIT_USE);

    test("dismissing Element's sign-out dialog keeps the session: token valid, device listed, view still shown", async ({
        page,
        homeserver,
        user,
    }) => {
        test.setTimeout(120000);
        const second = await homeserver.loginUser(user.userId, user.password!);
        const kit = await switchToRocketChat(page);
        await pickLogout(page, kit);
        const dialog = signOutDialog(page);
        await expect(dialog).toBeVisible({ timeout: 30000 });
        await dialog.getByRole("button", { name: /Cancel|Close/ }).first().click();
        await expect(dialog).toHaveCount(0);

        await page.waitForTimeout(2000);
        expect(await status(user.homeserverBaseUrl, user.accessToken)).toBe(200);
        expect(await devicesOf(second)).toContain(user.deviceId);
        await expect(kit.getByRole("button", { name: "User menu", exact: true })).toBeVisible();
        // A dismissed dialog is no error.
        await expect(kit.getByRole("alert")).toHaveCount(0);
    });

    test("confirming signs the device out: token 401, device gone, the view's storage gone (also an unsent draft), Element's welcome or login", async ({
        page,
        app,
        bot,
        homeserver,
        user,
    }) => {
        test.setTimeout(150000);
        const second = await homeserver.loginUser(user.userId, user.password!);
        const kit = await switchToRocketChat(page);
        await typeDraft(page, kit, app, bot, "an unsent draft that must not outlive the session");
        // What the Rocket.Chat view put in the page's storage by now (its own keys and the kit's).
        const before = await page.evaluate(() => Object.keys(localStorage));
        console.log("A9 localStorage keys before:", JSON.stringify(before.filter((k) => !k.startsWith("mx_"))));
        // The view's cache must not reach IndexedDB while the user is in it either.
        await page.waitForTimeout(5000);
        const dbsBefore = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
        expect(dbsBefore.filter((n) => /kits|rocketchat/i.test(n ?? ""))).toEqual([]);
        expect(await devicesOf(second)).toContain(user.deviceId);
        // Element's own databases (the sync store and the crypto store) exist while signed in.
        const elementDb = (n: string | undefined): boolean => /matrix-js-sdk|matrix-sdk-crypto|riot-web-sync|crypto/i.test(n ?? "");
        expect(dbsBefore.filter(elementDb).length).toBeGreaterThan(0);

        await pickLogout(page, kit);
        const dialog = signOutDialog(page);
        await expect(dialog).toBeVisible({ timeout: 30000 });
        // The dialog first loads the key backup state, then shows its question: wait for the sign-out button of either.
        const signOut = dialog.getByRole("button", { name: /^Remove this device( anyway)?$/ }).last();
        await expect(signOut).toBeVisible({ timeout: 30000 });
        console.log("A9 LogoutDialog for the test user:", (await dialog.getByRole("heading").first().innerText()).trim());
        await signOut.click();

        // Element's login or welcome; the Rocket.Chat view is gone with the session.
        await expect(page).toHaveURL(/#\/(welcome|login)/, { timeout: 60000 });
        await expect(page.locator('iframe[title="Rocket.Chat"]')).toHaveCount(0);

        // The homeserver: the old token is dead and the device is not listed any more.
        await expect.poll(() => status(user.homeserverBaseUrl, user.accessToken), { timeout: 30000 }).toBe(401);
        expect(await devicesOf(second)).not.toContain(user.deviceId);

        // The page: no session, no user state of the view in localStorage, no database of it. Element's `clearStorage` is
        // still deleting its databases when the welcome page renders (the sync store is gone a few seconds later): wait for it.
        const dbNames = (): Promise<string[]> => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ""));
        await expect
            .poll(async () => (await dbNames()).filter((n) => /riot-web-sync/.test(n)), { timeout: 15000 })
            .toEqual([]);
        const after = await page.evaluate(async () => ({
            keys: Object.keys(localStorage),
            session: Object.keys(sessionStorage),
            dbs: (await indexedDB.databases()).map((d) => d.name),
            token: localStorage.getItem("mx_access_token"),
        }));
        console.log("A9 storage after:", JSON.stringify({ keys: after.keys, session: after.session, dbs: after.dbs }));
        expect(after.token).toBeNull();
        expect(after.keys.filter((k) => !/^(mx_|language|loglevel)/.test(k))).toEqual([]);
        expect(after.keys.filter((k) => /access_token|user_id|device_id|rocketchat|Meteor|messagebox_/i.test(k))).toEqual([]);
        // The unsent draft (`messagebox_<room id>`) did not outlive the sign-out, and neither did anything in sessionStorage.
        expect(after.keys.filter((k) => k.startsWith("messagebox_"))).toEqual([]);
        expect(after.session).toEqual([]);
        // Element's crypto store and its sync store (`matrix-js-sdk:riot-web-sync`, asserted gone above) are deleted.
        expect(after.dbs.filter((n) => /crypto|riot-web-sync/i.test(n ?? ""))).toEqual([]);
        // The view's own cache (Rocket.Chat's rooms and subscriptions, tagged with the user) is not on disk: it is memory-only.
        expect(after.dbs.filter((n) => /kits|rocketchat/i.test(n ?? ""))).toEqual([]);
    });

    for (const failure of ["answered with HTTP 500", "aborted on the network"] as const) {
        test(`a logout request ${failure} still ends the session in the page (Element's rule); the token then stays valid on the server`, async ({
            page,
            homeserver,
            user,
        }) => {
            test.setTimeout(150000);
            const second = await homeserver.loginUser(user.userId, user.password!);
            await page.route(/\/_matrix\/client\/v3\/logout/, (route) =>
                failure === "aborted on the network"
                    ? route.abort("connectionreset")
                    : route.fulfill({
                          status: 500,
                          contentType: "application/json",
                          body: JSON.stringify({ errcode: "M_UNKNOWN", error: "logout refused" }),
                      }),
            );
            const kit = await switchToRocketChat(page);
            await pickLogout(page, kit);
            const dialog = signOutDialog(page);
            await expect(dialog).toBeVisible({ timeout: 30000 });
            await dialog.getByRole("button", { name: /^Remove this device( anyway)?$/ }).last().click();
            await expect(page).toHaveURL(/#\/(welcome|login)/, { timeout: 60000 });
            // The audit point: the page has no session left, but the server still has this one (Element's own behaviour).
            expect(await page.evaluate(() => localStorage.getItem("mx_access_token"))).toBeNull();
            expect(await status(user.homeserverBaseUrl, user.accessToken)).toBe(200);
            expect(await devicesOf(second)).toContain(user.deviceId);
        });
    }
});
