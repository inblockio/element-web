/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect } from "vitest";
import { MsgType } from "matrix-js-sdk/src/matrix";
import { createElement, type JSX } from "react";
import { render } from "test-utils-rtl";
import {
    DecryptionFailureBodyView,
    DecryptionFailureReason,
    E2ePadlockIcon,
    FileBodyViewState,
    ImageBodyViewState,
    VideoBodyViewState,
    I18nContext,
} from "@element-hq/web-shared-components";
import { type I18nApi } from "@element-hq/element-web-module-api";

import { bodyToNode } from "../HtmlUtils";
import {
    decryptionFailureText,
    nodeText,
    padlockWarning,
    toViewE2e,
    toViewAudio,
    toViewMedia,
    toViewMessage,
    toViewUrlPreviews,
    toViewRoom,
} from "./mapping";
import { type EventTileE2ePadlockViewState } from "../viewmodels/room/timeline/event-tile/EventTileE2eState";

const tile = (over: { msgtype?: string; eventId?: string; senderId?: string; rawDisplayName?: string } = {}) =>
    ({
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
                ? {
                      userId: "@alice:example.org",
                      roomId: "!r",
                      rawDisplayName: over.rawDisplayName,
                      disambiguate: false,
                  }
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
            membership: "join",
        });
        const quiet = toViewRoom(item({ hasUnreadCount: false, count: 5, isMention: false }), 0);
        expect([quiet.unreadCount, quiet.mentionCount]).toEqual([0, 0]);
        // A5: an invited room (the item snapshot's `notification.invited`) is an invite.
        const invited = toViewRoom(
            item({ hasUnreadCount: false, count: 0, isMention: false, invited: true } as never),
            0,
        );
        expect(invited.membership).toBe("invite");
    });

    it("reads text from nested nodes", () => {
        expect(nodeText(["a", 1, null, false, ["b"]])).toBe("a1b");
    });
});

/** A translator that shows the key, so a test pins which string a reason maps to. */
const keyOnly = (key: string): string => key;

describe("E2EE trust signals mapping (REQ-0007 V3, host half)", () => {
    const reasons = Object.values(DecryptionFailureReason);

    it("covers every DecryptionFailureReason, with and without a verified local device", () => {
        expect(reasons).toHaveLength(7);
        for (const reason of reasons) {
            for (const verified of [undefined, true, false]) {
                expect(decryptionFailureText(reason, verified, keyOnly)).toMatch(/^timeline\|decryption_failure\|/);
            }
        }
    });

    it("maps each reason to its string", () => {
        const text = (r: DecryptionFailureReason, v?: boolean) => decryptionFailureText(r, v, keyOnly);
        expect(text(DecryptionFailureReason.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE)).toBe(
            "timeline|decryption_failure|blocked",
        );
        expect(text(DecryptionFailureReason.HISTORICAL_MESSAGE_NO_KEY_BACKUP)).toBe(
            "timeline|decryption_failure|historical_event_no_key_backup",
        );
        expect(text(DecryptionFailureReason.HISTORICAL_MESSAGE_USER_NOT_JOINED)).toBe(
            "timeline|decryption_failure|historical_event_user_not_joined",
        );
        expect(text(DecryptionFailureReason.SENDER_IDENTITY_PREVIOUSLY_VERIFIED)).toBe(
            "timeline|decryption_failure|sender_identity_previously_verified",
        );
        expect(text(DecryptionFailureReason.UNSIGNED_SENDER_DEVICE)).toBe(
            "timeline|decryption_failure|sender_unsigned_device",
        );
        expect(text(DecryptionFailureReason.UNABLE_TO_DECRYPT)).toBe("timeline|decryption_failure|unable_to_decrypt");
        // The unconfigured-backup case depends on the local device: an unverified one is asked to verify.
        expect(text(DecryptionFailureReason.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED, false)).toBe(
            "timeline|decryption_failure|historical_event_unverified_device",
        );
        expect(text(DecryptionFailureReason.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED, true)).toBe(
            "timeline|decryption_failure|unable_to_decrypt",
        );
        expect(text(DecryptionFailureReason.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED)).toBe(
            "timeline|decryption_failure|unable_to_decrypt",
        );
    });

    it("shows the same text as Element's own decryption failure body view for every reason", () => {
        const i18n = { translate: keyOnly } as unknown as I18nApi;
        for (const reason of reasons) {
            for (const verified of [undefined, true, false]) {
                const snapshot = { decryptionFailureReason: reason, isLocalDeviceVerified: verified };
                const vm = {
                    getSnapshot: () => snapshot,
                    subscribe: () => () => {},
                };
                const { container, unmount } = render(
                    createElement(
                        I18nContext.Provider,
                        { value: i18n },
                        createElement(DecryptionFailureBodyView, { vm }),
                    ),
                );
                expect(decryptionFailureText(reason, verified, keyOnly), `${reason} ${verified}`).toBe(
                    container.textContent,
                );
                unmount();
            }
        }
    });

    describe("padlock", () => {
        const warning = (p: EventTileE2ePadlockViewState, shared?: string) => padlockWarning(p, shared);

        it("takes the title of a warning or decryption-failure icon", () => {
            expect(warning({ kind: "icon", icon: E2ePadlockIcon.Warning, title: "Not encrypted" })).toBe(
                "Not encrypted",
            );
            expect(warning({ kind: "icon", icon: E2ePadlockIcon.DecryptionFailure, title: "Could not decrypt" })).toBe(
                "Could not decrypt",
            );
        });

        it("takes the shared-by text of a forwarded message", () => {
            expect(warning({ kind: "messageShared", keyForwardingUserId: "@c:x", roomId: "!a" }, "C shared it")).toBe(
                "C shared it",
            );
        });

        it("has no warning for none", () => {
            expect(warning({ kind: "none" })).toBeUndefined();
        });

        it("warns with the grey icon's title: the sending device is not established for that message (A3)", () => {
            const title = "The authenticity of this encrypted message can't be guaranteed on this device.";
            expect(warning({ kind: "icon", icon: E2ePadlockIcon.Normal, title })).toBe(title);
        });
    });

    describe("toViewE2e", () => {
        const none: EventTileE2ePadlockViewState = { kind: "none" };
        const t = keyOnly;

        it("a failure wins over the padlock and carries the reason text", () => {
            expect(
                toViewE2e({
                    failure: { reason: DecryptionFailureReason.UNSIGNED_SENDER_DEVICE },
                    padlock: none,
                    encrypted: true,
                    t,
                }),
            ).toEqual({ state: "failed", text: "timeline|decryption_failure|sender_unsigned_device" });
        });

        it("pending has the placeholder and no text", () => {
            expect(toViewE2e({ pending: true, padlock: none, encrypted: true, t })).toEqual({
                state: "pending",
                text: "",
            });
        });

        it("a decrypted message carries the padlock warning; an unmarked encrypted one carries none", () => {
            const padlock: EventTileE2ePadlockViewState = {
                kind: "icon",
                icon: E2ePadlockIcon.Warning,
                title: "unverified",
            };
            expect(toViewE2e({ padlock, encrypted: true, t })).toEqual({ state: "decrypted", warning: "unverified" });
            expect(toViewE2e({ padlock: none, encrypted: true, t })).toEqual({ state: "decrypted" });
        });

        it("a plain message in an unencrypted room has no e2e state; an unencrypted one in an encrypted room warns", () => {
            expect(toViewE2e({ padlock: none, encrypted: false, t })).toBeUndefined();
            const padlock: EventTileE2ePadlockViewState = {
                kind: "icon",
                icon: E2ePadlockIcon.Warning,
                title: "Not encrypted",
            };
            expect(toViewE2e({ padlock, encrypted: false, t })).toEqual({
                state: "decrypted",
                warning: "Not encrypted",
            });
        });
    });

    it("toViewMessage drops the SDK placeholder body of a failed or pending message", () => {
        const m = toViewMessage(
            "!a",
            tile({ msgtype: "m.bad.encrypted" }),
            { body: "** Unable to decrypt: DecryptionError **" },
            undefined,
            { state: "failed", text: "x" },
        );
        expect(m?.body).toBe("");
        expect(m?.formattedBody).toBeUndefined();
        expect(m?.e2e).toEqual({ state: "failed", text: "x" });
    });

    describe("toViewMedia", () => {
        it("an image with its URL is ready, with the thumbnail and the suggested frame size", () => {
            expect(
                toViewMedia("image", {
                    state: ImageBodyViewState.READY,
                    alt: "cat.png",
                    src: "blob:full",
                    thumbnailSrc: "http://hs/thumb",
                    maxWidth: 320,
                    maxHeight: 240,
                }),
            ).toEqual({
                kind: "image",
                state: "ready",
                url: "blob:full",
                thumbnailUrl: "http://hs/thumb",
                name: "cat.png",
                width: 320,
                height: 240,
            });
        });

        it("an image without a URL yet is loading; hidden and error carry Element's own text", () => {
            expect(toViewMedia("image", { state: ImageBodyViewState.READY, alt: "a" })).toMatchObject({
                state: "loading",
                url: undefined,
            });
            expect(toViewMedia("image", { state: ImageBodyViewState.HIDDEN, hiddenButtonLabel: "Show image" })).toEqual(
                { kind: "image", state: "hidden", name: "", label: "Show image" },
            );
            expect(
                toViewMedia("image", { state: ImageBodyViewState.ERROR, errorLabel: "Error decrypting image" }),
            ).toEqual({ kind: "image", state: "error", name: "", label: "Error decrypting image" });
        });

        it("a video maps src and poster; loading, hidden and error follow the view-model state", () => {
            expect(
                toViewMedia("video", {
                    state: VideoBodyViewState.READY,
                    videoTitle: "clip.webm",
                    src: "blob:v",
                    poster: "blob:p",
                    maxWidth: 480,
                    maxHeight: 270,
                }),
            ).toEqual({
                kind: "video",
                state: "ready",
                url: "blob:v",
                thumbnailUrl: "blob:p",
                name: "clip.webm",
                width: 480,
                height: 270,
            });
            expect(toViewMedia("video", { state: VideoBodyViewState.LOADING })).toMatchObject({ state: "loading" });
            // An encrypted video with autoplay off carries a data: placeholder until onPlay decrypts it.
            const waiting = toViewMedia("video", { state: VideoBodyViewState.READY, src: "data:video/mp4," });
            expect(waiting).toMatchObject({ state: "loading" });
            expect(waiting).not.toHaveProperty("url");
            expect(
                toViewMedia("video", { state: VideoBodyViewState.HIDDEN, hiddenButtonLabel: "Show video" }),
            ).toMatchObject({ state: "hidden", label: "Show video" });
            expect(
                toViewMedia("video", { state: VideoBodyViewState.ERROR, errorLabel: "Error decrypting video" }),
            ).toMatchObject({ state: "error", label: "Error decrypting video" });
        });

        it("an unencrypted file links to the download href and names itself by the full label (name and size)", () => {
            expect(
                toViewMedia("file", {
                    state: FileBodyViewState.UNENCRYPTED,
                    infoLabel: "notes.txt (12 bytes)",
                    infoTooltip: "notes.txt (12 bytes)",
                    downloadHref: "http://hs/download/notes",
                }),
            ).toEqual({ kind: "file", state: "ready", url: "http://hs/download/notes", name: "notes.txt (12 bytes)" });
        });

        it("an encrypted file has no URL (the view-model keeps the blob private); an invalid one is an error", () => {
            const enc = toViewMedia("file", { state: FileBodyViewState.DECRYPTION_PENDING, infoLabel: "s.bin" });
            expect(enc).toEqual({ kind: "file", state: "ready", name: "s.bin" });
            expect(toViewMedia("file", { state: FileBodyViewState.INVALID })).toEqual({
                kind: "file",
                state: "error",
                name: "",
            });
        });

        it("audio is ready with its URL and the label Element shows, loading without one, error with Element's text", () => {
            expect(toViewAudio("voice.ogg (3 KB)", "blob:a")).toEqual({
                kind: "audio",
                state: "ready",
                url: "blob:a",
                name: "voice.ogg (3 KB)",
            });
            expect(toViewAudio("voice.ogg", undefined)).toEqual({ kind: "audio", state: "loading", name: "voice.ogg" });
            expect(toViewAudio("voice.ogg", null)).toEqual({ kind: "audio", state: "loading", name: "voice.ogg" });
            expect(toViewAudio("voice.ogg", undefined, "Error processing audio message")).toEqual({
                kind: "audio",
                state: "error",
                name: "voice.ogg",
                label: "Error processing audio message",
            });
        });

        it("toViewMessage carries the URL previews when given, and none when the list is empty", () => {
            const urlPreviews = [{ link: "https://example.org/a", title: "A", siteName: "Example" }];
            const none = [undefined, undefined, undefined, undefined, undefined, undefined] as const;
            const m = toViewMessage("!a", tile({}), { body: "a" }, ...none, urlPreviews);
            expect(m?.urlPreviews).toEqual(urlPreviews);
            expect(toViewMessage("!a", tile({}), { body: "a" })).not.toHaveProperty("urlPreviews");
            expect(toViewMessage("!a", tile({}), { body: "a" }, ...none, [])).not.toHaveProperty("urlPreviews");
        });

        it("toViewMessage carries the media when given", () => {
            const media = { kind: "image", state: "ready", name: "a" } as const;
            const m = toViewMessage(
                "!a",
                tile({}),
                { body: "a" },
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                media,
            );
            expect(m?.media).toEqual(media);
            expect(toViewMessage("!a", tile({}), { body: "a" })).not.toHaveProperty("media");
        });
    });

    describe("toViewUrlPreviews", () => {
        const preview = {
            link: "https://example.org/post",
            showTooltipOnLink: true,
            title: "A post",
            siteName: "Example",
            ogUrl: "https://example.org/canonical",
            siteIcon: "https://example.org/icon.png",
            description: "About a post",
            author: "Alice",
            image: {
                imageThumb: "http://hs/thumb",
                imageFull: "http://hs/full",
                mxcImageFull: "mxc://hs/full",
                width: 320,
                height: 180,
                alt: "cover",
                playable: false,
            },
        };

        it("maps a preview to plain fields; the image is the thumbnail the view-model fetched", () => {
            expect(toViewUrlPreviews([preview])).toEqual([
                {
                    link: "https://example.org/post",
                    title: "A post",
                    siteName: "Example",
                    ogUrl: "https://example.org/canonical",
                    siteIcon: "https://example.org/icon.png",
                    description: "About a post",
                    author: "Alice",
                    image: { url: "http://hs/thumb", width: 320, height: 180, alt: "cover" },
                },
            ]);
        });

        it("leaves out what the preview does not have", () => {
            const [p] = toViewUrlPreviews([
                { link: "https://e.org", showTooltipOnLink: false, title: "T", siteName: "" },
            ])!;
            expect(p).toEqual({ link: "https://e.org", title: "T", siteName: "" });
        });

        it("is undefined for no previews", () => {
            expect(toViewUrlPreviews([])).toBeUndefined();
        });
    });
});
