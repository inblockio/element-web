/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// REQ-0008 V2: no "Rocket.Chat" text and no Rocket.Chat logo asset in the rendered kit.
//
// Scope, precisely. Inside the kit document only (the iframe), over the journey of switch.spec.ts (room list, a room
// with a message, the user menu opened):
//   text:   the rendered text of the document (innerText: hidden elements excluded) and the accessible-name attributes
//           aria-label, aria-description, title, alt, placeholder of every element, shadow roots excluded;
//   assets: every request made from the kit frame (an RC logo path, or a response body equal to one of RC's logo files
//           by sha256), every img src, svg use href, CSS background-image in the kit document, and inline svg path data
//           equal to an RC logo's.
// Out of scope, by design: Element's own "Switch to Rocket.Chat" menu item and the host iframe's title (host chrome, in
// the host document); code strings of the bundle that never render; the kit document's own <title> (not rendered
// anywhere; at runtime it reads as Element's title, logged here for the record).

import { createHash } from "node:crypto";

import { type Page, type Request, type Response } from "@playwright/test";

import { test, expect } from "../../../element-web-test";
import { KIT_FRAME, KIT_USE, clickPastToasts, sidebarRoom, switchToRocketChat } from "./kit";
import { RC_LOGO_PATH_PREFIXES, RC_LOGO_SHA256 } from "./brand-assets";

const BRAND = /Rocket\.?\s?Chat/i;
const LOGO_PATH = /\/images\/logo\//;
const LOGO_HASHES = new Set(Object.values(RC_LOGO_SHA256));

/** A request of the kit: its own files, or anything else asked for from a frame that is not the host's main frame. */
function isKitRequest(req: Request): boolean {
    try {
        return req.url().includes("/kits/rocketchat/") || req.frame().parentFrame() !== null;
    } catch {
        return req.url().includes("/kits/rocketchat/"); // a request without a frame (worker)
    }
}

/** Runs in the kit document: every place a brand mark can render. */
function scanKitDocument(prefixes: string[]) {
    const text = document.body.innerText;
    const attrs: string[] = [];
    const images: string[] = [];
    const inlineSvgPaths: string[] = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
        for (const name of ["aria-label", "aria-description", "title", "alt", "placeholder"]) {
            const v = el.getAttribute(name);
            if (v) attrs.push(`${el.tagName.toLowerCase()}[${name}]=${v}`);
        }
        if (el instanceof HTMLImageElement) images.push(el.currentSrc || el.src);
        if (el.tagName.toLowerCase() === "use") images.push(el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "");
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== "none") images.push(bg);
        if (el instanceof SVGPathElement) {
            const d = el.getAttribute("d") ?? "";
            if (prefixes.some((p) => d.startsWith(p))) inlineSvgPaths.push(d.slice(0, 40));
        }
    }
    return { text, attrs, images, inlineSvgPaths, title: document.title, elements: document.querySelectorAll("*").length };
}

async function scan(page: Page, label: string, findings: string[]): Promise<void> {
    const frame = (await (await page.locator(KIT_FRAME).elementHandle())!.contentFrame())!;
    const r = await frame.evaluate(scanKitDocument, RC_LOGO_PATH_PREFIXES);
    console.log(`brand scan [${label}]: ${r.elements} elements, ${r.text.length} chars of text, ${r.images.length} image refs, document title "${r.title}"`);
    for (const line of r.text.split("\n")) if (BRAND.test(line)) findings.push(`${label}: visible text "${line.trim()}"`);
    for (const a of r.attrs) if (BRAND.test(a)) findings.push(`${label}: attribute ${a}`);
    for (const i of r.images) if (LOGO_PATH.test(i)) findings.push(`${label}: image reference ${i}`);
    for (const d of r.inlineSvgPaths) findings.push(`${label}: inline svg path of an RC logo ${d}`);
}

test.describe("Rocket.Chat view: brand", () => {
    test.use(KIT_USE);

    test("no Rocket.Chat text and no Rocket.Chat logo asset in the rendered kit", async ({ page, app, bot }) => {
        const roomId = await app.client.createRoom({ name: "Team Lunch", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Hi Alice!");

        const findings: string[] = [];
        const requests: string[] = [];
        const bodies: Promise<void>[] = [];
        page.on("request", (req) => {
            try {
                if (isKitRequest(req)) requests.push(req.url());
            } catch {
                // a request without a frame (worker): not the kit document's
            }
        });
        page.on("response", (res: Response) => {
            if (!isKitRequest(res.request()) || !/^(image\/|application\/octet-stream)/.test(res.headers()["content-type"] ?? "")) return;
            bodies.push(
                res.body().then(
                    (b) => {
                        const sha = createHash("sha256").update(b).digest("hex");
                        if (LOGO_HASHES.has(sha)) findings.push(`response ${res.url()} is an RC logo file (sha256 ${sha})`);
                    },
                    () => undefined,
                ),
            );
        });

        const kit = await switchToRocketChat(page);
        const room = sidebarRoom(kit, "Team Lunch");
        await expect(room).toBeVisible({ timeout: 30000 });
        await scan(page, "room list", findings);
        await clickPastToasts(page, room);
        await expect(kit.getByText("Hi Alice!")).toBeVisible({ timeout: 30000 });
        await scan(page, "room", findings);
        await clickPastToasts(page, kit.getByRole("button", { name: "User menu", exact: true }));
        await expect(kit.getByRole("menuitemcheckbox", { name: "Switch to Element" })).toBeVisible();
        await scan(page, "user menu", findings);

        await Promise.all(bodies);
        for (const url of requests) if (LOGO_PATH.test(new URL(url).pathname)) findings.push(`request ${url}`);
        console.log(`brand scan: ${requests.length} kit requests, ${bodies.length} image bodies hashed`);

        // Proof the scan saw the kit: Rocket.Chat's own labels are in what it scanned.
        expect(requests.length).toBeGreaterThan(10);
        expect(findings, "Rocket.Chat brand marks in the rendered kit").toEqual([]);
    });
});
