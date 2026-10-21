/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { ConnectionError, HTTPError, MatrixError, type MatrixClient, Room } from "matrix-js-sdk/src/matrix";
import { createTestClient } from "test-utils";

import { sendText } from "./InterimActions";
import { ClientViewActionError } from "./types";
import { LocalRoom, LocalRoomState, LOCAL_ROOM_ID_PREFIX } from "../models/LocalRoom";
import defaultDispatcher from "../dispatcher/dispatcher";
import { createRoomFromLocalRoom } from "../utils/direct-messages";

vi.mock("../utils/direct-messages", () => ({ createRoomFromLocalRoom: vi.fn() }));

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
        await p;
    } catch (e) {
        expect(e).toBeInstanceOf(ClientViewActionError);
        return (e as ClientViewActionError).code;
    }
    return undefined;
};

describe("sendText (interim action, D16)", () => {
    let client: MatrixClient;
    let room: Room;
    let localRoom: LocalRoom;
    let dispatch: Mock;

    beforeEach(() => {
        vi.clearAllMocks();
        client = createTestClient();
        room = new Room("!a:example.org", client, "@me:example.org");
        localRoom = new LocalRoom(LOCAL_ROOM_ID_PREFIX + "dm", client, "@me:example.org");
        vi.mocked(client.getRoom).mockImplementation((id?: string) =>
            id === room.roomId ? room : id === localRoom.roomId ? localRoom : null,
        );
        vi.mocked(client.sendMessage).mockResolvedValue({ event_id: "$sent" });
        dispatch = vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => {}) as unknown as Mock;
    });

    it("sends a plain m.text with the kit's transaction id and resolves done with the event id", async () => {
        const outcome = await sendText(client, "!a:example.org", "**hello**", { txnId: "rc-id" });
        expect(client.sendMessage).toHaveBeenCalledWith(
            "!a:example.org",
            null,
            { msgtype: "m.text", body: "**hello**" },
            "rc-id",
        );
        expect(dispatch).toHaveBeenCalledWith({ action: "message_sent" });
        expect(outcome).toEqual({ status: "done", roomId: "!a:example.org", eventId: "$sent" });
    });

    it("rejects an unknown room, an empty text and a reply (A3 not implemented yet)", async () => {
        expect(await codeOf(sendText(client, "!nope:example.org", "hi"))).toBe("unknown_room");
        expect(await codeOf(sendText(client, "!a:example.org", "  "))).toBe("failed");
        expect(await codeOf(sendText(client, "!a:example.org", "hi", { replyTo: "$x" }))).toBe("unsupported");
        expect(client.sendMessage).not.toHaveBeenCalled();
    });

    it("maps client errors to the contract codes", async () => {
        const mx = vi.mocked(client.sendMessage);
        mx.mockRejectedValueOnce(new MatrixError({ errcode: "M_FORBIDDEN", error: "no" }, 403));
        expect(await codeOf(sendText(client, "!a:example.org", "hi"))).toBe("forbidden");
        mx.mockRejectedValueOnce(new ConnectionError("offline"));
        expect(await codeOf(sendText(client, "!a:example.org", "hi"))).toBe("network");
        mx.mockRejectedValueOnce(new HTTPError("boom", 500));
        expect(await codeOf(sendText(client, "!a:example.org", "hi"))).toBe("failed");
    });

    describe("local room (a new DM)", () => {
        it("creates the real room, sends there and resolves with the real room id", async () => {
            vi.mocked(createRoomFromLocalRoom).mockImplementation(async (_c, local) => {
                local.state = LocalRoomState.CREATED;
                local.actualRoomId = "!real:example.org";
                local.afterCreateCallbacks.forEach((cb) => cb("!real:example.org"));
                return "!real:example.org";
            });
            const outcome = await sendText(client, localRoom.roomId, "first", { txnId: "t1" });
            expect(createRoomFromLocalRoom).toHaveBeenCalledWith(client, localRoom);
            expect(client.sendMessage).toHaveBeenCalledWith(
                "!real:example.org",
                null,
                { msgtype: "m.text", body: "first" },
                "t1",
            );
            expect(outcome).toEqual({ status: "done", roomId: "!real:example.org", eventId: "$sent" });
        });

        it("rejects `failed` when the room cannot be created, instead of waiting forever", async () => {
            vi.mocked(createRoomFromLocalRoom).mockImplementation(async (_c, local) => {
                local.state = LocalRoomState.ERROR;
            });
            expect(await codeOf(sendText(client, localRoom.roomId, "first"))).toBe("failed");
            expect(client.sendMessage).not.toHaveBeenCalled();
        });
    });
});
