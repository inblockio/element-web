/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// @vitest-environment happy-dom

// M7 E1: `sendText` / `editText` with `opts.markdown` send what Element's own composer sends for the same CommonMark
// input (H1). The reference is built the way the composer builds it: the typed text goes through `EditorModel.update`
// (part creation as typing does it) and the stock `createMessageContent` / `createEditContent` with the Markdown
// preference ON. The plain path (no `markdown`) is covered in InterimActions.test.ts and stays byte-identical.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MatrixEvent, Room, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { createTestClient } from "test-utils";

import { editText, sendText } from "./InterimActions";
import defaultDispatcher from "../dispatcher/dispatcher";
import EditorModel from "../editor/model";
import DocumentOffset from "../editor/offset";
import { PartCreator } from "../editor/parts";
import { createMessageContent } from "../components/views/rooms/SendMessageComposer";
import { createEditContent } from "../components/views/rooms/EditMessageComposer";
import SettingsStore from "../settings/SettingsStore";

const CASES = [
    "plain words",
    "**bold** and *italic* and `code`",
    "<del>struck</del> and [a link](https://example.org/x)",
    "```\nfenced\ncode\n```",
    "line one\nline two",
    "# not a heading? it is",
    "- a\n- b",
    "**bold *nested italic* bold**",
    "snake_case_word and 2*3*4",
    "\\*escaped\\* stars",
    "<b>raw html</b> inline",
    "/me waves",
    "//not a command",
];

/** The model Element's composer holds after the user typed `text`. */
async function typed(client: MatrixClient, room: Room, text: string): Promise<EditorModel> {
    const model = new EditorModel([], new PartCreator(room, client));
    await model.update(text, "insertText", new DocumentOffset(text.length, true));
    return model;
}

describe("M7 E1 markdown send and edit (H1: the content Element's composer builds)", () => {
    let client: MatrixClient;
    let room: Room;

    beforeEach(() => {
        vi.clearAllMocks();
        client = createTestClient();
        vi.mocked(client.getUserId).mockReturnValue("@me:example.org");
        vi.mocked(client.getSafeUserId).mockReturnValue("@me:example.org");
        room = new Room("!a:example.org", client, "@me:example.org");
        vi.mocked(client.getRoom).mockImplementation((id?: string) => (id === room.roomId ? room : null));
        vi.mocked(client.sendMessage).mockResolvedValue({ event_id: "$sent" });
        vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => {});
    });

    describe.each(CASES)("send %j", (text) => {
        it("equals Element's composer event, whatever the Markdown preference says", async () => {
            for (const pref of [true, false]) {
                vi.spyOn(SettingsStore, "getValue").mockImplementation((n: string) =>
                    n === "MessageComposerInput.useMarkdown" ? pref : false,
                );
                vi.mocked(client.sendMessage).mockClear();
                await sendText(client, room.roomId, text, { markdown: true, txnId: "t1" });
                const sent = vi.mocked(client.sendMessage).mock.calls[0][2];
                vi.spyOn(SettingsStore, "getValue").mockImplementation((n: string) =>
                    n === "MessageComposerInput.useMarkdown" ? true : false,
                );
                const reference = createMessageContent(
                    "@me:example.org",
                    await typed(client, room, text),
                    undefined,
                    undefined,
                );
                expect(sent).toEqual(reference);
            }
        });
    });

    it("yields format + formatted_body only when Markdown produces HTML", async () => {
        await sendText(client, room.roomId, "just text", { markdown: true });
        expect(vi.mocked(client.sendMessage).mock.calls[0][2]).toEqual({
            "msgtype": "m.text",
            "body": "just text",
            "m.mentions": {},
        });
        await sendText(client, room.roomId, "a **b** c", { markdown: true });
        expect(vi.mocked(client.sendMessage).mock.calls[1][2]).toMatchObject({
            msgtype: "m.text",
            body: "a **b** c",
            format: "org.matrix.custom.html",
            formatted_body: "a <strong>b</strong> c",
        });
        await sendText(client, room.roomId, "x <del>y</del> `z`", { markdown: true });
        expect((vi.mocked(client.sendMessage).mock.calls[2][2] as any).formatted_body).toBe(
            "x <del>y</del> <code>z</code>",
        );
    });

    it("H1 ruling pinned: with Markdown on, a leading `/me ` goes out as an emote and a leading `//` loses one slash (as Element's composer does)", async () => {
        await sendText(client, room.roomId, "/me waves", { markdown: true });
        expect(vi.mocked(client.sendMessage).mock.calls[0][2]).toMatchObject({ msgtype: "m.emote", body: "waves" });
        await sendText(client, room.roomId, "//not a command", { markdown: true });
        expect(vi.mocked(client.sendMessage).mock.calls[1][2]).toMatchObject({
            msgtype: "m.text",
            body: "/not a command",
        });
    });

    it("an empty mentions list changes nothing and the plain path (no markdown) keeps the raw text", async () => {
        await sendText(client, room.roomId, "a **b**", { markdown: true, mentions: [] });
        await sendText(client, room.roomId, "a **b**", { markdown: true });
        const [withList, without] = vi.mocked(client.sendMessage).mock.calls.map((c) => c[2]);
        expect(withList).toEqual(without);
        await sendText(client, room.roomId, "a **b**", { markdown: false, txnId: "p" });
        expect(vi.mocked(client.sendMessage).mock.calls[2][2]).toEqual({ msgtype: "m.text", body: "a **b**" });
    });

    it("a reply carries the relation and the replied sender mention, like the composer", async () => {
        const target = new MatrixEvent({
            type: "m.room.message",
            room_id: room.roomId,
            event_id: "$t",
            sender: "@bob:example.org",
            content: { msgtype: "m.text", body: "question" },
        });
        vi.spyOn(room, "findEventById").mockReturnValue(target);
        await sendText(client, room.roomId, "an *answer*", { markdown: true, replyTo: "$t" });
        const sent = vi.mocked(client.sendMessage).mock.calls[0][2] as Record<string, any>;
        const reference = createMessageContent(
            "@me:example.org",
            await typed(client, room, "an *answer*"),
            target,
            undefined,
        );
        expect(sent).toEqual(reference);
        expect(sent["m.relates_to"]["m.in_reply_to"]).toEqual({ event_id: "$t" });
        expect(sent["m.mentions"]).toEqual({ user_ids: ["@bob:example.org"] });
    });

    it("a blank emote (`/me ` and nothing else) is not sent, as the composer drops it (grok F2)", async () => {
        for (const text of ["/me  ", "/me \n", "/me \n  "]) {
            await expect(sendText(client, room.roomId, text, { markdown: true })).rejects.toMatchObject({
                code: "failed",
            });
        }
        expect(client.sendMessage).not.toHaveBeenCalled();
    });

    describe("edit", () => {
        const own = (content: Record<string, unknown>) =>
            new MatrixEvent({
                type: "m.room.message",
                room_id: "!a:example.org",
                event_id: "$mine",
                sender: "@me:example.org",
                content,
            });

        it.each(CASES.filter((c) => !c.startsWith("/me") && !c.startsWith("//")))(
            "equals Element's edit composer event for %j",
            async (text) => {
                const ev = own({ msgtype: "m.text", body: "first" });
                vi.spyOn(room, "findEventById").mockReturnValue(ev);
                await editText(client, room.roomId, "$mine", text, {}, { markdown: true });
                const sent = vi.mocked(client.sendMessage).mock.calls[0][2];
                vi.spyOn(SettingsStore, "getValue").mockImplementation((n: string) =>
                    n === "MessageComposerInput.useMarkdown" ? true : false,
                );
                expect(sent).toEqual(createEditContent(await typed(client, room, text), ev));
            },
        );

        it("keeps formatting in m.new_content and the `* ` fallback in the outer content", async () => {
            vi.spyOn(room, "findEventById").mockReturnValue(own({ msgtype: "m.text", body: "first" }));
            await editText(client, room.roomId, "$mine", "now **bold**", {}, { markdown: true });
            expect(vi.mocked(client.sendMessage).mock.calls[0][2]).toMatchObject({
                "msgtype": "m.text",
                "body": "* now **bold**",
                "format": "org.matrix.custom.html",
                "formatted_body": "* now <strong>bold</strong>",
                "m.new_content": {
                    msgtype: "m.text",
                    body: "now **bold**",
                    format: "org.matrix.custom.html",
                    formatted_body: "now <strong>bold</strong>",
                },
                "m.relates_to": { rel_type: "m.replace", event_id: "$mine" },
            });
        });

        it("an emote stays an emote (edited with its /me prefix, as the editor holds it)", async () => {
            vi.spyOn(room, "findEventById").mockReturnValue(own({ msgtype: "m.emote", body: "waves" }));
            await editText(client, room.roomId, "$mine", "waves *hard*", {}, { markdown: true });
            const content = vi.mocked(client.sendMessage).mock.calls[0][2] as Record<string, any>;
            expect(content.msgtype).toBe("m.emote");
            expect(content["m.new_content"]).toMatchObject({
                msgtype: "m.emote",
                body: "waves *hard*",
                formatted_body: "waves <em>hard</em>",
            });
        });

        it("a later edit follows the type on screen: an m.text edited to an emote stays an emote (grok F1)", async () => {
            const ev = own({ msgtype: "m.text", body: "first" });
            const replacement = new MatrixEvent({
                type: "m.room.message",
                room_id: "!a:example.org",
                event_id: "$edit1",
                sender: "@me:example.org",
                content: {
                    "msgtype": "m.emote",
                    "body": "* waves",
                    "m.new_content": { msgtype: "m.emote", body: "waves" },
                    "m.relates_to": { rel_type: "m.replace", event_id: "$mine" },
                },
            });
            ev.makeReplaced(replacement);
            expect(ev.getContent().msgtype).toBe("m.emote");
            vi.spyOn(room, "findEventById").mockReturnValue(ev);
            await editText(client, room.roomId, "$mine", "waves again", {}, { markdown: true });
            const content = vi.mocked(client.sendMessage).mock.calls[0][2] as Record<string, any>;
            expect(content.msgtype).toBe("m.emote");
            expect(content["m.new_content"]).toMatchObject({ msgtype: "m.emote", body: "waves again" });
        });

        it("without markdown the replacement is the plain one (no formatted_body)", async () => {
            vi.spyOn(room, "findEventById").mockReturnValue(own({ msgtype: "m.text", body: "first" }));
            await editText(client, room.roomId, "$mine", "now **bold**");
            const content = vi.mocked(client.sendMessage).mock.calls[0][2] as Record<string, any>;
            expect(content.format).toBeUndefined();
            expect(content["m.new_content"]).toEqual({ "msgtype": "m.text", "body": "now **bold**", "m.mentions": {} });
        });
    });

    describe("M7 E2 mentions (pill parts as the autocomplete inserts them)", () => {
        const BOB = "@bob:example.org";
        const own = (content: Record<string, unknown>) =>
            new MatrixEvent({
                type: "m.room.message",
                room_id: "!a:example.org",
                event_id: "$mine",
                sender: "@me:example.org",
                content,
            });

        beforeEach(() => {
            vi.spyOn(SettingsStore, "getValue").mockImplementation((n: string) =>
                n === "MessageComposerInput.useMarkdown" ? true : false,
            );
            const member = { rawDisplayName: "Bob Builder", userId: BOB } as any;
            vi.spyOn(room, "getMember").mockImplementation((id: string) => (id === BOB ? member : null));
        });

        /** What the composer holds after the user picked Bob from the popup and typed around him. */
        const picked = (parts: (string | "BOB")[]): EditorModel => {
            const pc = new PartCreator(room, client);
            return new EditorModel(
                parts.map((p) => (p === "BOB" ? pc.userPill("Bob Builder", BOB) : pc.plain(p))),
                pc,
            );
        };

        it("sends the content Element's composer builds for a picked member: m.mentions and the pill link", async () => {
            await sendText(client, room.roomId, `hi ${BOB} there`, { markdown: true, mentions: [BOB] });
            const sent = vi.mocked(client.sendMessage).mock.calls[0][2] as Record<string, any>;
            expect(sent).toEqual(
                createMessageContent("@me:example.org", picked(["hi ", "BOB", " there"]), undefined, undefined),
            );
            expect(sent["m.mentions"]).toEqual({ user_ids: [BOB] });
            expect(sent.body).toBe("hi Bob Builder there");
            expect(sent.formatted_body).toBe(`hi <a href="https://matrix.to/#/${BOB}">Bob Builder</a> there`);
        });

        it("a token whose id is not in `mentions` stays text; a mention at the start and the end works", async () => {
            await sendText(client, room.roomId, `${BOB} and @carol:example.org`, { markdown: true, mentions: [BOB] });
            const sent = vi.mocked(client.sendMessage).mock.calls[0][2] as Record<string, any>;
            expect(sent["m.mentions"]).toEqual({ user_ids: [BOB] });
            expect(sent.body).toBe("Bob Builder and @carol:example.org");
            await sendText(client, room.roomId, `no mentions list ${BOB}`, { markdown: true });
            const plain = vi.mocked(client.sendMessage).mock.calls[1][2] as Record<string, any>;
            expect(plain["m.mentions"]).toEqual({});
            expect(plain.body).toBe(`no mentions list ${BOB}`);
        });

        it("a token inside a longer word or id is not a mention; punctuation after it is", async () => {
            await sendText(client, room.roomId, `x${BOB} and ${BOB}.org and ${BOB}x`, {
                markdown: true,
                mentions: [BOB],
            });
            expect((vi.mocked(client.sendMessage).mock.calls[0][2] as any)["m.mentions"]).toEqual({});
            await sendText(client, room.roomId, `hey ${BOB}, ok? ${BOB}.`, { markdown: true, mentions: [BOB] });
            const sent = vi.mocked(client.sendMessage).mock.calls[1][2] as Record<string, any>;
            expect(sent["m.mentions"]).toEqual({ user_ids: [BOB] });
            expect(sent.body).toBe("hey Bob Builder, ok? Bob Builder.");
        });

        it("a mention with no room member record falls back to the id as the display name; own id is not mentioned", async () => {
            vi.spyOn(room, "getMember").mockReturnValue(null);
            await sendText(client, room.roomId, `hi ${BOB} and @me:example.org`, {
                markdown: true,
                mentions: [BOB, "@me:example.org"],
            });
            const sent = vi.mocked(client.sendMessage).mock.calls[0][2] as Record<string, any>;
            expect(sent["m.mentions"]).toEqual({ user_ids: [BOB] });
            expect(sent.body).toBe(`hi ${BOB} and @me:example.org`);
        });

        it("a mention on a second line keeps the newline", async () => {
            await sendText(client, room.roomId, `first\n${BOB} second`, { markdown: true, mentions: [BOB] });
            const sent = vi.mocked(client.sendMessage).mock.calls[0][2] as Record<string, any>;
            expect(sent["m.mentions"]).toEqual({ user_ids: [BOB] });
            expect(sent.body).toBe("first\nBob Builder second");
        });

        it("an edit keeps the pill in m.new_content; the outer m.mentions lists only new users", async () => {
            const ev = own({ "msgtype": "m.text", "body": "hi Bob Builder", "m.mentions": { user_ids: [BOB] } });
            vi.spyOn(room, "findEventById").mockReturnValue(ev);
            await editText(client, room.roomId, "$mine", `hi ${BOB} again`, {}, { markdown: true, mentions: [BOB] });
            const sent = vi.mocked(client.sendMessage).mock.calls[0][2] as Record<string, any>;
            expect(sent).toEqual(createEditContent(picked(["hi ", "BOB", " again"]), ev));
            expect(sent["m.new_content"]["m.mentions"]).toEqual({ user_ids: [BOB] });
            expect(sent["m.new_content"].formatted_body).toBe(
                `hi <a href="https://matrix.to/#/${BOB}">Bob Builder</a> again`,
            );
            expect(sent["m.mentions"]).toEqual({});
        });
    });
});
