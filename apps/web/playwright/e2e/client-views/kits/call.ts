/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Shared helpers of the call specs (lane CALL): a bot makes and ends a MatrixRTC call on the homeserver the way a client
// does (no aqua-meet in testcontainers), so what Element's call-card view-models show is what the homeserver holds.

import { type BrowserContext, type Page } from "@playwright/test";

import { KIT_USE } from "./kit";

import { type Bot } from "../../../pages/bot";

/** The homeserver and the call-capable Element, as Element's own call specs configure them. */
export const CALL_USE = {
    synapseConfig: {
        experimental_features: { msc4143_enabled: true },
        matrix_rtc: { transports: [{ type: "livekit", livekit_service_url: "https://example.org/can-be-anything" }] },
    },
};

export const DECLINE_EVENT = "org.matrix.msc4310.rtc.decline";
export const MEMBER_EVENT = "org.matrix.msc3401.call.member";
export const NOTIFICATION_EVENT = "org.matrix.msc4075.rtc.notification";
const DEVICE = "BOBDEVICE";

/** The member state key of the bot's device (the session form `_<user>_<device>_m.call`). */
export const memberKey = (bot: Bot): string => `_${bot.credentials!.userId}_${DEVICE}_m.call`;

/**
 * The bot starts a call: its member state event (what Element's MatrixRTC session reads: application m.call, call_id "",
 * device, active and preferred focus, expires) and the notification event that roots the call card, which refers to the
 * member event. Returns the notification's event id (the call's id).
 */
export async function startCall(bot: Bot, roomId: string, intent: "video" | "audio" = "video"): Promise<string> {
    const memberEventId = await joinCall(bot, roomId, intent);
    const notification = await bot.sendEvent(roomId, null, NOTIFICATION_EVENT, {
        "lifetime": 30000,
        "m.mentions": { room: true, user_ids: [] },
        "m.relates_to": { event_id: memberEventId, rel_type: "m.reference" },
        "m.call.intent": intent,
        "notification_type": "notification",
        "sender_ts": Date.now(),
    });
    return notification.event_id;
}

/** The bot joins the call (its member state event only, no notification); returns the member event id. */
export async function joinCall(bot: Bot, roomId: string, intent: "video" | "audio" = "video"): Promise<string> {
    const member = await bot.sendStateEvent(
        roomId,
        MEMBER_EVENT,
        {
            "application": "m.call",
            "call_id": "",
            "m.call.intent": intent,
            "device_id": DEVICE,
            "expires": 180000000,
            "foci_preferred": [{ livekit_alias: roomId, livekit_service_url: "https://example.org", type: "livekit" }],
            "focus_active": { focus_selection: "oldest_membership", type: "livekit" },
            "scope": "m.room",
        },
        memberKey(bot),
    );
    return member.event_id;
}

/** The bot declines the call (an rtc.decline event that refers to the notification), as a callee's client sends it. */
export async function declineCall(bot: Bot, roomId: string, callId: string): Promise<void> {
    await bot.sendEvent(roomId, null, DECLINE_EVENT, {
        "m.relates_to": { event_id: callId, rel_type: "m.reference" },
    });
}

/** The bot leaves the call: its member state becomes empty, as a client's hang-up writes it. */
export async function leaveCall(bot: Bot, roomId: string): Promise<void> {
    await bot.sendStateEvent(roomId, MEMBER_EVENT, {}, memberKey(bot));
}

/** The member state of the bot's device as another session of the user reads it from the homeserver (D21: the truth). */
export async function memberOnServer(
    creds: { homeserverBaseUrl: string; accessToken: string },
    roomId: string,
    bot: Bot,
): Promise<Record<string, unknown>> {
    const url = `${creds.homeserverBaseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${MEMBER_EVENT}/${encodeURIComponent(memberKey(bot))}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${creds.accessToken}` } });
    if (!res.ok) throw new Error(`member state: ${res.status}`);
    return res.json();
}

/** Rocket.Chat's call card (`VideoConfMessage`) in the kit frame. */
export const CARD = ".rcx-videoconf-message-block";

/** Whether the page shows Element's own call tile for the room (the stock timeline), by its room list entry's call hint. */
export async function stockRoomListCallHint(page: Page, roomName: string): Promise<string | undefined> {
    const option = page.getByRole("option", { name: new RegExp(`Open room ${roomName}`) });
    return (await option.count()) ? ((await option.first().getAttribute("aria-label")) ?? undefined) : undefined;
}

/** The call app's address of the host config in the write-side specs: an origin the test serves itself (no aqua-meet in testcontainers). */
export const MEET = "https://meet.example.test";

/** KIT_USE plus the Meet address (`client_views_meet_url`, the host config key next to `client_views`). */
export const MEET_USE = { ...KIT_USE, config: { ...(KIT_USE.config as object), client_views_meet_url: MEET } as object };

/** aqua-meet's room link for a room (the room id URL-encoded, as aqua-meet's `<portal>/#/room/...` link reads it). */
export const meetRoomUrl = (roomId: string): string => `${MEET}/#/room/${encodeURIComponent(roomId)}`;

/**
 * Serves the Meet address from the test: a page that records it was opened (`window.__meetOpened`, the URL and the window
 * name) and asks for a confirm dialog (`window.__meetDialog`), which only an unsandboxed window can show. Returns the
 * number of requests the stub got.
 */
export async function serveMeetStub(context: BrowserContext): Promise<{ hits: () => number }> {
    let hits = 0;
    await context.route(`${MEET}/**`, (route) => {
        hits++;
        return route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><title>Meet stub</title><body>meet stub<script>
                window.__meetOpened = { href: location.href, name: window.name };
                setTimeout(() => { window.__meetDialog = confirm("meet stub"); }, 200);
            </script>`,
        });
    });
    return { hits: () => hits };
}

/** The call member events (MatrixRTC memberships) in a room as the homeserver holds them: the state events, any sender. */
export async function callMembersOnServer(
    creds: { homeserverBaseUrl: string; accessToken: string },
    roomId: string,
): Promise<{ type: string; state_key: string; content: Record<string, unknown> }[]> {
    const res = await fetch(`${creds.homeserverBaseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`, {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    if (!res.ok) throw new Error(`room state: ${res.status}`);
    const state = (await res.json()) as { type: string; state_key: string; content: Record<string, unknown> }[];
    return state.filter((e) => e.type === MEMBER_EVENT && Object.keys(e.content).length > 0);
}
