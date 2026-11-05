/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConnectionError, MatrixError, MatrixEvent, Room, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { stubClient, flushPromises } from "test-utils";

import { ViewModelBridge } from "./ViewModelBridge";
import RoomListStoreV3 from "../stores/room-list-v3/RoomListStoreV3";
import { SDKContextClass } from "../contexts/SDKContextClass";
import { CHATS_TAG } from "../stores/room-list-v3/section";
import DMRoomMap from "../utils/DMRoomMap";

/*
 * M13 U6: the composer's `+:emoji:` as Element's own rule runs it (`SendMessageComposer.sendQuickReaction`), on the host.
 * Real js-sdk `Room`, `MatrixEvent` and relations; only the client's `getRoom` and `sendEvent` are faked. The rule: the
 * newest `m.room.message` of the live timeline (the host picks it, not the kit), an undecryptable one included.
 */
const ROOM = "!r:example.org";
const ME = "@me:example.org";
const KEY = "\u{1F389}";

describe("ViewModelBridge.quickReact (M13 U6)", () => {
    let client: MatrixClient;
    let room: Room;
    let bridge: ViewModelBridge;
    let sendEvent: ReturnType<typeof vi.fn>;
    let ts = 1000;

    const message = (id: string, sender = "@bob:example.org"): MatrixEvent =>
        new MatrixEvent({
            event_id: id,
            room_id: ROOM,
            sender,
            type: "m.room.message",
            origin_server_ts: ts++,
            content: { msgtype: "m.text", body: id },
        });
    /** A message whose decrypt is still pending: js-sdk reports `m.room.encrypted`, so the rule skips it. */
    const pending = (id: string): MatrixEvent =>
        new MatrixEvent({
            event_id: id,
            room_id: ROOM,
            sender: "@bob:example.org",
            type: "m.room.encrypted",
            origin_server_ts: ts++,
            content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "garbage" },
        });
    /** A FAILED decrypt: js-sdk sets the clear event to `m.room.message` / `m.bad.encrypted`, so the rule takes it. */
    const undecryptable = (id: string): MatrixEvent => {
        const ev = pending(id);
        (ev as unknown as { setClearDataForDecryptionFailure(r: string): void }).setClearDataForDecryptionFailure(
            "no session",
        );
        return ev;
    };
    const other = (id: string, type: string, extra: object = {}): MatrixEvent =>
        new MatrixEvent({
            event_id: id,
            room_id: ROOM,
            sender: "@bob:example.org",
            type,
            origin_server_ts: ts++,
            content: {},
            ...extra,
        });
    const reaction = (id: string, target: string, key: string, sender = ME): MatrixEvent =>
        new MatrixEvent({
            event_id: id,
            room_id: ROOM,
            sender,
            type: "m.reaction",
            origin_server_ts: ts++,
            content: { "m.relates_to": { rel_type: "m.annotation", event_id: target, key } },
        });
    const timeline = (...events: MatrixEvent[]): void => {
        room.addLiveEvents(events, { addToState: false });
    };
    const sentReactions = (): unknown[] => sendEvent.mock.calls.map((c) => c.slice(0, 3));
    const annotation = (target: string, key = KEY): unknown[] => [
        ROOM,
        "m.reaction",
        { "m.relates_to": { rel_type: "m.annotation", event_id: target, key } },
    ];

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(client, "getCrypto").mockReturnValue(undefined);
        vi.spyOn(client, "getSafeUserId").mockReturnValue(ME);
        vi.spyOn(client, "getUserId").mockReturnValue(ME);
        room = new Room(ROOM, client, ME);
        vi.spyOn(client, "getRoom").mockImplementation((id) => (id === ROOM ? room : null));
        sendEvent = vi.fn(async () => ({ event_id: "$sent" }));
        (client as unknown as { sendEvent: unknown }).sendEvent = sendEvent;
        DMRoomMap.setShared({ getUserIdForRoomId: vi.fn().mockReturnValue(null) } as unknown as DMRoomMap);
        vi.spyOn(RoomListStoreV3.instance, "getSortedRoomsInActiveSpace").mockImplementation(() => ({
            spaceId: "home",
            sections: [{ tag: CHATS_TAG, rooms: [] }],
        }));
        vi.spyOn(RoomListStoreV3.instance, "isLoadingRooms", "get").mockReturnValue(false);
        vi.spyOn(SDKContextClass.instance.spaceStore, "activeSpaceRoom", "get").mockReturnValue(null);
        vi.spyOn(SDKContextClass.instance.roomViewStore, "getRoomId").mockImplementation(() => null);
        bridge = new ViewModelBridge(client);
    });

    afterEach(() => {
        bridge?.dispose?.();
        vi.restoreAllMocks();
    });

    it("is bridge version 7 and offers quickReact", () => {
        expect(bridge.version).toBe(7);
        expect(typeof bridge.quickReact).toBe("function");
    });

    it("reacts to an undecryptable (failed-decrypt) newest message, not to the older readable one", async () => {
        timeline(message("$older"), undecryptable("$utd"));
        expect(room.getLiveTimeline().getEvents()[1].getType()).toBe("m.room.message"); // the js-sdk premise

        const outcome = await bridge.quickReact(ROOM, KEY);

        expect(outcome).toEqual({ status: "done", roomId: ROOM, eventId: "$utd" });
        expect(sentReactions()).toEqual([annotation("$utd")]);
    });

    it("skips a newest message whose decrypt is still pending and reacts to the older one", async () => {
        timeline(message("$older"), pending("$waiting"));

        const outcome = await bridge.quickReact(ROOM, KEY);

        expect(outcome).toEqual({ status: "done", roomId: ROOM, eventId: "$older" });
        expect(sentReactions()).toEqual([annotation("$older")]);
    });

    it("skips newer state events and reactions, and takes the host's own newest message even if the kit has not shown it", async () => {
        timeline(
            message("$older"),
            message("$newer-unseen-by-kit"),
            other("$state", "m.room.topic", { state_key: "", content: { topic: "t" } }),
            reaction("$r1", "$older", "\u{1F44D}", "@bob:example.org"),
        );

        const outcome = await bridge.quickReact(ROOM, KEY);

        expect(outcome).toEqual({ status: "done", roomId: ROOM, eventId: "$newer-unseen-by-kit" });
        expect(sentReactions()).toEqual([annotation("$newer-unseen-by-kit")]);
    });

    it("sends nothing when the user already reacted with that key (never toggles off), done with the target's id", async () => {
        timeline(message("$older"), message("$last"));
        timeline(reaction("$mine", "$last", KEY));

        const outcome = await bridge.quickReact(ROOM, KEY);

        expect(outcome).toEqual({ status: "done", roomId: ROOM, eventId: "$last" });
        expect(sendEvent).not.toHaveBeenCalled();
    });

    it("still sends when the only reaction of that key is redacted, or another user's, or another key", async () => {
        timeline(message("$last"));
        timeline(reaction("$bob", "$last", KEY, "@bob:example.org"), reaction("$other-key", "$last", "\u{1F44D}"));
        const gone = reaction("$gone", "$last", KEY);
        timeline(gone);
        gone.makeRedacted(
            new MatrixEvent({ event_id: "$red", type: "m.room.redaction", sender: ME, content: {}, redacts: "$gone" }),
            room,
        );

        const outcome = await bridge.quickReact(ROOM, KEY);

        expect(outcome).toEqual({ status: "done", roomId: ROOM, eventId: "$last" });
        expect(sentReactions()).toEqual([annotation("$last")]);
    });

    it("is done without an eventId and sends nothing in a room with no message", async () => {
        timeline(other("$state", "m.room.topic", { state_key: "", content: { topic: "t" } }), pending("$waiting"));

        expect(await bridge.quickReact(ROOM, KEY)).toEqual({ status: "done", roomId: ROOM });
        expect(sendEvent).not.toHaveBeenCalled();
    });

    it("rejects unknown_room for a room the client does not hold, without a write", async () => {
        await expect(bridge.quickReact("!nope:example.org", KEY)).rejects.toMatchObject({ code: "unknown_room" });
        expect(sendEvent).not.toHaveBeenCalled();
    });

    it("maps the homeserver's refusal: M_FORBIDDEN is forbidden, a lost connection is network, the rest failed", async () => {
        timeline(message("$last"));

        sendEvent.mockRejectedValueOnce(new MatrixError({ errcode: "M_FORBIDDEN", error: "no" }, 403));
        await expect(bridge.quickReact(ROOM, KEY)).rejects.toMatchObject({ code: "forbidden" });

        sendEvent.mockRejectedValueOnce(new ConnectionError("offline"));
        await expect(bridge.quickReact(ROOM, KEY)).rejects.toMatchObject({ code: "network" });

        sendEvent.mockRejectedValueOnce(new Error("boom"));
        await expect(bridge.quickReact(ROOM, KEY)).rejects.toMatchObject({ code: "failed" });
        await flushPromises();
    });
});
