/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { createTestClient, flushPromises, mkStubRoom } from "test-utils";

import { ViewModelBridge } from "./ViewModelBridge";
import RoomListStoreV3, { RoomListStoreV3Event } from "../stores/room-list-v3/RoomListStoreV3";
import { SortingAlgorithm } from "../stores/room-list-v3/skip-list/sorters";
import { SDKContextClass } from "../contexts/SDKContextClass";
import { CHATS_TAG } from "../stores/room-list-v3/section";
import DMRoomMap from "../utils/DMRoomMap";

/*
 * M10 W6: the kit's room order after the user picks a sort in the Display menu. The bridge lists what the room list
 * view-model lists (`roomIds`); the view-model keeps the open room at its old index on a plain list update (sticky room).
 * A resort is not such an update: Element's store (`RoomListStoreV3.resort`) holds the new order, and the bridge must
 * show it, whichever room is open. Real room list view-model and bridge; only the store's list and the open room are faked.
 */
describe("ViewModelBridge: the room order after a resort (W6)", () => {
    let client: MatrixClient;
    let bridge: ViewModelBridge;
    let rooms: Room[];
    let sort: SortingAlgorithm;
    let order: Room[];
    let openRoomId: string | null;

    const ids = (): string[] => bridge.rooms().map((r) => r.id);
    const storeShows = (next: Room[], algorithm?: SortingAlgorithm): void => {
        order = next;
        if (algorithm) sort = algorithm;
        RoomListStoreV3.instance.emit(RoomListStoreV3Event.ListsUpdate);
    };

    beforeEach(() => {
        client = createTestClient();
        vi.spyOn(client, "getCrypto").mockReturnValue(undefined);
        rooms = ["Alpha", "Bravo", "Charlie"].map((n) => mkStubRoom(`!${n.toLowerCase()}:server`, n, client));
        const [alpha, bravo, charlie] = rooms;
        // Activity order: Charlie, Bravo, Alpha; Alphabetic would be Alpha, Bravo, Charlie.
        sort = SortingAlgorithm.Recency;
        order = [charlie, bravo, alpha];
        openRoomId = null;
        DMRoomMap.setShared({ getUserIdForRoomId: vi.fn().mockReturnValue(null) } as unknown as DMRoomMap);
        vi.spyOn(RoomListStoreV3.instance, "getSortedRoomsInActiveSpace").mockImplementation(() => ({
            spaceId: "home",
            sections: [{ tag: CHATS_TAG, rooms: order }],
        }));
        vi.spyOn(RoomListStoreV3.instance, "isLoadingRooms", "get").mockReturnValue(false);
        vi.spyOn(RoomListStoreV3.instance, "activeSortAlgorithm", "get").mockImplementation(() => sort);
        vi.spyOn(SDKContextClass.instance.spaceStore, "activeSpaceRoom", "get").mockReturnValue(null);
        vi.spyOn(SDKContextClass.instance.roomViewStore, "getRoomId").mockImplementation(() => openRoomId);
    });

    afterEach(() => {
        bridge?.dispose?.();
        vi.restoreAllMocks();
    });

    it("lists the store's alphabetical order after a resort though the open room was listed first", async () => {
        const [alpha, bravo, charlie] = rooms;
        // The open room is the most recently active one (first in Activity order), as in the preview check's standing room.
        openRoomId = charlie.roomId;
        bridge = new ViewModelBridge(client);
        await flushPromises();
        expect(ids()).toEqual([charlie, bravo, alpha].map((r) => r.roomId));

        const onChange = vi.fn();
        bridge.onChange(onChange);
        storeShows([alpha, bravo, charlie], SortingAlgorithm.Alphabetic);
        await flushPromises();

        expect(ids()).toEqual([alpha, bravo, charlie].map((r) => r.roomId));
        expect(onChange).toHaveBeenCalledWith({ kind: "rooms" });
    });

    it("lists the store's order after a resort back to activity, with the open room anywhere", async () => {
        const [alpha, bravo, charlie] = rooms;
        order = [alpha, bravo, charlie];
        sort = SortingAlgorithm.Alphabetic;
        openRoomId = bravo.roomId;
        bridge = new ViewModelBridge(client);
        await flushPromises();
        expect(ids()).toEqual([alpha, bravo, charlie].map((r) => r.roomId));

        storeShows([bravo, charlie, alpha], SortingAlgorithm.Recency);
        await flushPromises();

        expect(ids()).toEqual([bravo, charlie, alpha].map((r) => r.roomId));
    });

    it("keeps Element's sticky open room on a plain list update (no resort): only a resort drops it", async () => {
        const [alpha, bravo, charlie] = rooms;
        openRoomId = charlie.roomId;
        bridge = new ViewModelBridge(client);
        await flushPromises();
        expect(ids()).toEqual([charlie, bravo, alpha].map((r) => r.roomId));

        // Same algorithm: Bravo got a message and moved first. The open room (Charlie) stays at its index 0.
        storeShows([bravo, charlie, alpha]);
        await flushPromises();

        expect(ids()).toEqual([charlie, bravo, alpha].map((r) => r.roomId));
    });
});
