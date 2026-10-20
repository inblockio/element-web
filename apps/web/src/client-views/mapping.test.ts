/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect } from "vitest";
import { MsgType } from "matrix-js-sdk/src/matrix";
import { type JSX } from "react";

import { bodyToNode } from "../HtmlUtils";
import { nodeText, toViewMessage, toViewRoom } from "./mapping";

const tile = (over: { msgtype?: string; eventId?: string; senderId?: string; rawDisplayName?: string } = {}) => ({
    event: {
        eventType: "m.room.message",
        msgtype: over.msgtype ?? MsgType.Text,
        eventId: "eventId" in over ? over.eventId : "$ev1",
        isState: false,
        eventTs: 1000,
        isLocalEcho: false,
    },
    sender: {
        senderId: over.senderId ?? "@alice:example.org",
        member: over.rawDisplayName
            ? { userId: "@alice:example.org", roomId: "!r", rawDisplayName: over.rawDisplayName, disambiguate: false }
            : null,
        isEmote: over.msgtype === MsgType.Emote,
    },
    timestamp: { show: true, value: 1234, displayState: "default" },
}) as unknown as Parameters<typeof toViewMessage>[1];

describe("client view mapping", () => {
    it("reads an emoji-only body as a string although the body view-model returns elements", () => {
        // The same call the body view-model makes for a message with big emoji enabled.
        const { emojiBodyElements, strippedBody } = bodyToNode({ msgtype: MsgType.Text, body: "😀🎉" }, [], {
            disableBigEmoji: false,
        });
        expect(Array.isArray(emojiBodyElements)).toBe(true);
        const body = (emojiBodyElements || strippedBody) as string | JSX.Element[];
        expect(typeof body).not.toBe("string");
        const message = toViewMessage("!r", tile(), { body, formattedBody: undefined });
        expect(message?.body).toBe("😀🎉");
    });

    it("keeps a string body and the sanitized HTML", () => {
        const message = toViewMessage("!r", tile({ rawDisplayName: "Alice" }), {
            body: "hello **you**",
            formattedBody: "hello <strong>you</strong>",
        });
        expect(message).toEqual({
            id: "$ev1",
            roomId: "!r",
            senderId: "@alice:example.org",
            senderName: "Alice",
            senderAvatarUrl: undefined,
            ts: 1234,
            body: "hello **you**",
            formattedBody: "hello <strong>you</strong>",
            kind: "text",
        });
    });

    it("falls back to the sender id as the name, maps msgtypes to kinds and skips tiles without an id", () => {
        expect(toViewMessage("!r", tile(), { body: "x" })?.senderName).toBe("@alice:example.org");
        expect(toViewMessage("!r", tile({ msgtype: MsgType.Notice }), { body: "x" })?.kind).toBe("notice");
        expect(toViewMessage("!r", tile({ msgtype: MsgType.Emote }), { body: "x" })?.kind).toBe("emote");
        expect(toViewMessage("!r", tile({ msgtype: MsgType.Image }), { body: "x" })?.kind).toBe("other");
        expect(toViewMessage("!r", tile({ eventId: undefined }), { body: "x" })).toBeUndefined();
    });

    it("maps room list counts: unread only with a count, mentions only for a mention", () => {
        const item = (n: { hasUnreadCount: boolean; count: number; isMention: boolean }) =>
            ({ id: "!r", name: "General", isDm: false, notification: n }) as Parameters<typeof toViewRoom>[0];
        expect(toViewRoom(item({ hasUnreadCount: true, count: 3, isMention: true }), 2, "http://a")).toEqual({
            id: "!r",
            name: "General",
            avatarUrl: "http://a",
            unreadCount: 3,
            mentionCount: 3,
            isDirect: false,
            order: 2,
        });
        const quiet = toViewRoom(item({ hasUnreadCount: false, count: 5, isMention: false }), 0);
        expect([quiet.unreadCount, quiet.mentionCount]).toEqual([0, 0]);
    });

    it("reads text from nested nodes", () => {
        expect(nodeText(["a", 1, null, false, ["b"]])).toBe("a1b");
    });
});
