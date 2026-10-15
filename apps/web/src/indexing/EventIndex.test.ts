/*
Copyright 2025 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// @vitest-environment happy-dom

import "fake-indexeddb/auto";

import { vi, describe, it, expect, afterEach, type Mocked } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
    Direction,
    type MatrixClient,
    type IEvent,
    MatrixEvent,
    type Room,
    ClientEvent,
    SyncState,
} from "matrix-js-sdk/src/matrix";

import * as sdkUtils from "matrix-js-sdk/src/utils";

import EventIndex from "./EventIndex.ts";
import {
    emitPromise,
    getMockClientWithEventEmitter,
    mockClientMethodsRooms,
    mockPlatformPeg,
} from "../../test/test-utils";
import type BaseEventIndexManager from "./BaseEventIndexManager.ts";
import { type ICrawlerCheckpoint } from "./BaseEventIndexManager.ts";
import SettingsStore from "../settings/SettingsStore.ts";
import { BrowserEventIndexManager } from "../vector/platform/BrowserEventIndexManager.ts";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("EventIndex", () => {
    it("crawls through the loaded checkpoints", async () => {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn(),
            removeCrawlerCheckpoint: vi.fn(),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            shouldCrawl: vi.fn().mockResolvedValue(true),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        const room1 = { roomId: "!room1:id" } as any as Room;
        const room2 = { roomId: "!room2:id" } as any as Room;
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            ...mockClientMethodsRooms([room1, room2]),
        });

        vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
            if (settingName === "crawlerSleepTime") return 0;
            return undefined;
        });

        mockIndexingManager.loadCheckpoints.mockResolvedValue([
            { roomId: "!room1:id", token: "token1", direction: Direction.Backward } as ICrawlerCheckpoint,
            { roomId: "!room2:id", token: "token2", direction: Direction.Forward } as ICrawlerCheckpoint,
        ]);

        const indexer = new EventIndex();
        await indexer.init();
        let changedCheckpointPromise = emitPromise(indexer, "changedCheckpoint") as Promise<Room>;

        indexer.startCrawler();

        // Mock out the /messags request, and wait for the crawler to hit the first room
        const mock1 = mockCreateMessagesRequest(mockClient);
        let changedCheckpoint = await changedCheckpointPromise;
        expect(changedCheckpoint.roomId).toEqual("!room1:id");

        await mock1.called;
        expect(mockClient.createMessagesRequest).toHaveBeenCalledWith("!room1:id", "token1", 100, "b");

        // Continue, and wait for the crawler to hit the second room
        changedCheckpointPromise = emitPromise(indexer, "changedCheckpoint") as Promise<Room>;
        mock1.resolve({ chunk: [] });
        changedCheckpoint = await changedCheckpointPromise;
        expect(changedCheckpoint.roomId).toEqual("!room2:id");

        // Mock out the /messages request again, and wait for it to be called
        const mock2 = mockCreateMessagesRequest(mockClient);
        await mock2.called;
        expect(mockClient.createMessagesRequest).toHaveBeenCalledWith("!room2:id", "token2", 100, "f");
    });

    it("adds checkpoints for the encrypted rooms after the first sync", async () => {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(true),
            addCrawlerCheckpoint: vi.fn(),
            removeCrawlerCheckpoint: vi.fn(),
            commitLiveEvents: vi.fn(),
            shouldCrawl: vi.fn().mockResolvedValue(true),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        const room1 = {
            roomId: "!room1:id",
            getLiveTimeline: () => ({
                getPaginationToken: () => "token1",
            }),
            getLastActiveTimestamp: () => 1,
        } as any as Room;
        const room2 = {
            roomId: "!room2:id",
            getLiveTimeline: () => ({
                getPaginationToken: () => "token2",
            }),
            getLastActiveTimestamp: () => 2,
        } as any as Room;
        const mockCrypto = {
            isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
        };
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            getCrypto: () => mockCrypto as any,
            ...mockClientMethodsRooms([room1, room2]),
        });

        const commitLiveEventsCalled = Promise.withResolvers<void>();
        mockIndexingManager.commitLiveEvents.mockImplementation(async () => {
            commitLiveEventsCalled.resolve();
        });

        const indexer = new EventIndex();
        await indexer.init();

        // During the first sync, some events are added to the index, meaning that `isEventIndexEmpty` will now be false.
        mockIndexingManager.isEventIndexEmpty.mockResolvedValue(false);

        // The first sync completes:
        mockClient.emit(ClientEvent.Sync, SyncState.Syncing, null, {});

        // Wait for `commitLiveEvents` to be called, by which time the checkpoints should have been added.
        await commitLiveEventsCalled.promise;
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledTimes(4);
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room1:id",
            token: "token1",
            direction: Direction.Backward,
            fullCrawl: true,
        });
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room1:id",
            token: "token1",
            direction: Direction.Forward,
        });
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room2:id",
            token: "token2",
            direction: Direction.Backward,
            fullCrawl: true,
        });
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room2:id",
            token: "token2",
            direction: Direction.Forward,
        });
    });

    it("declines a checkpoint outside the crawl bound instead of crawling it, and does not spin on it", async () => {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn(),
            removeCrawlerCheckpoint: vi.fn().mockResolvedValue(undefined),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            // room1 is outside the bound (e.g. the crawl window, or the room cap); room2 is not.
            shouldCrawl: vi.fn().mockImplementation(async (cp: ICrawlerCheckpoint) => cp.roomId !== "!room1:id"),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        const room1 = { roomId: "!room1:id" } as any as Room;
        const room2 = { roomId: "!room2:id" } as any as Room;
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            ...mockClientMethodsRooms([room1, room2]),
        });

        vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
            if (settingName === "crawlerSleepTime") return 0;
            return undefined;
        });

        mockIndexingManager.loadCheckpoints.mockResolvedValue([
            { roomId: "!room1:id", token: "token1", direction: Direction.Backward } as ICrawlerCheckpoint,
            { roomId: "!room2:id", token: "token2", direction: Direction.Forward } as ICrawlerCheckpoint,
        ]);

        const indexer = new EventIndex();
        await indexer.init();
        indexer.startCrawler();

        // room1's checkpoint is declined and removed without ever spending a request on it; the
        // crawler moves straight on to room2 instead of getting stuck re-offering the same
        // declined checkpoint.
        const mock2 = mockCreateMessagesRequest(mockClient);
        await mock2.called;
        expect(mockClient.createMessagesRequest).toHaveBeenCalledWith("!room2:id", "token2", 100, "f");
        expect(mockClient.createMessagesRequest).not.toHaveBeenCalledWith("!room1:id", "token1", 100, "b");
        expect(mockIndexingManager.removeCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room1:id",
            token: "token1",
            direction: Direction.Backward,
        });
    });

    it("drains every declined checkpoint before sleeping once, not once per decline (review-pr-c.md C-F4)", async () => {
        // Three checkpoints, the first two outside the crawl bound. The old code slept
        // crawlerSleepTime between *each* decline, head-of-line-blocking room3's in-bound
        // checkpoint behind the declined backlog; the fix drains room1+room2 in one pass and
        // sleeps exactly once, immediately before room3 is processed.
        const sleepSpy = vi.spyOn(sdkUtils, "sleep").mockResolvedValue(undefined);

        const mockIndexingManager = {
            loadCheckpoints: vi.fn(),
            removeCrawlerCheckpoint: vi.fn().mockResolvedValue(undefined),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            shouldCrawl: vi.fn().mockImplementation(async (cp: ICrawlerCheckpoint) => cp.roomId === "!room3:id"),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        const room1 = { roomId: "!room1:id" } as any as Room;
        const room2 = { roomId: "!room2:id" } as any as Room;
        const room3 = { roomId: "!room3:id" } as any as Room;
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            ...mockClientMethodsRooms([room1, room2, room3]),
        });

        vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
            if (settingName === "crawlerSleepTime") return 0;
            return undefined;
        });

        mockIndexingManager.loadCheckpoints.mockResolvedValue([
            { roomId: "!room1:id", token: "token1", direction: Direction.Backward } as ICrawlerCheckpoint,
            { roomId: "!room2:id", token: "token2", direction: Direction.Backward } as ICrawlerCheckpoint,
            { roomId: "!room3:id", token: "token3", direction: Direction.Forward } as ICrawlerCheckpoint,
        ]);

        const indexer = new EventIndex();
        await indexer.init();
        indexer.startCrawler();

        const mock3 = mockCreateMessagesRequest(mockClient);
        await mock3.called;

        expect(mockClient.createMessagesRequest).toHaveBeenCalledWith("!room3:id", "token3", 100, "f");
        expect(mockIndexingManager.removeCrawlerCheckpoint).toHaveBeenCalledWith(
            expect.objectContaining({ roomId: "!room1:id" }),
        );
        expect(mockIndexingManager.removeCrawlerCheckpoint).toHaveBeenCalledWith(
            expect.objectContaining({ roomId: "!room2:id" }),
        );
        // The one sleep that precedes processing room3 -- none spent between the two declines.
        expect(sleepSpy).toHaveBeenCalledTimes(1);
    });

    it("ranks initial checkpoints by the client's own recency and declines rooms past the cap (review-pr-c.md C-F4)", async () => {
        // A manager whose shouldCrawl behaves the way BrowserEventIndexManager's does for a fresh
        // index: nothing has any manifest activity yet, so the *only* signal it can decline on is
        // the caller-supplied clientRoomRank -- a cap of 1 here, so only the single most recently
        // active room should ever see addCrawlerCheckpoint.
        const mockIndexingManager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(true),
            addCrawlerCheckpoint: vi.fn(),
            removeCrawlerCheckpoint: vi.fn(),
            commitLiveEvents: vi.fn(),
            shouldCrawl: vi.fn().mockImplementation(async (_cp: ICrawlerCheckpoint, rank?: number) => {
                return rank === undefined || rank < 1;
            }),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        // Deliberately out of recency order in client.getRooms()'s own return order, so this also
        // proves addInitialCheckpoints does its own sort rather than trusting call order.
        const rooms = [
            {
                roomId: "!old:id",
                getLiveTimeline: () => ({ getPaginationToken: () => "t" }),
                getLastActiveTimestamp: () => 1,
            },
            {
                roomId: "!newest:id",
                getLiveTimeline: () => ({ getPaginationToken: () => "t" }),
                getLastActiveTimestamp: () => 3,
            },
            {
                roomId: "!middle:id",
                getLiveTimeline: () => ({ getPaginationToken: () => "t" }),
                getLastActiveTimestamp: () => 2,
            },
        ] as any as Room[];
        const mockCrypto = { isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true) };
        getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            getCrypto: () => mockCrypto as any,
            ...mockClientMethodsRooms(rooms),
        });

        const indexer = new EventIndex();
        await indexer.init();
        await indexer.addInitialCheckpoints();

        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith(
            expect.objectContaining({ roomId: "!newest:id" }),
        );
        expect(mockIndexingManager.addCrawlerCheckpoint).not.toHaveBeenCalledWith(
            expect.objectContaining({ roomId: "!middle:id" }),
        );
        expect(mockIndexingManager.addCrawlerCheckpoint).not.toHaveBeenCalledWith(
            expect.objectContaining({ roomId: "!old:id" }),
        );
        // Every shouldCrawl call for these rooms was ranked, never left to the "no signal" default.
        for (const call of mockIndexingManager.shouldCrawl.mock.calls) {
            expect(call[1]).not.toBeUndefined();
        }
    });
});

describe("EventIndex crawler: redaction tombstones (S1)", () => {
    const ROOM = "!room1:id";
    const SENDER = "@alice:id";
    const redaction = {
        event_id: "$r",
        room_id: ROOM,
        sender: SENDER,
        type: "m.room.redaction",
        origin_server_ts: 40,
        redacts: "$o",
        content: {},
    };
    const message = (id: string, extra: Record<string, unknown> = {}): any => ({
        event_id: id,
        room_id: ROOM,
        sender: SENDER,
        type: "m.room.message",
        origin_server_ts: 10,
        content: { body: "hello", msgtype: "m.text" },
        ...extra,
    });
    /** The batch a backward crawl gets for a deleted, edited message: R (newest), E, and the redacted O. */
    const deletedAndEditedBatch = (): any[] => [
        redaction,
        message("$e", {
            origin_server_ts: 20,
            content: {
                "body": "* edited",
                "msgtype": "m.text",
                "m.new_content": { body: "edited", msgtype: "m.text" },
                "m.relates_to": { rel_type: "m.replace", event_id: "$o" },
            },
        }),
        message("$o", { origin_server_ts: 10, content: {}, unsigned: { redacted_because: redaction } }),
        message("$reaction", { type: "m.reaction", content: {}, unsigned: { redacted_because: redaction } }),
    ];

    async function crawl(
        checkpoints: ICrawlerCheckpoint[],
        chunk: any[],
        manager: Partial<Record<keyof BaseEventIndexManager, unknown>> = {},
    ): Promise<{ manager: Mocked<BaseEventIndexManager>; client: Mocked<MatrixClient>; stop: () => void }> {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn().mockResolvedValue(checkpoints),
            removeCrawlerCheckpoint: vi.fn().mockResolvedValue(undefined),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            shouldCrawl: vi.fn().mockResolvedValue(true),
            deleteEvent: vi.fn().mockResolvedValue(false),
            addHistoricEvents: vi.fn().mockResolvedValue(false),
            releaseRedactionTombstones: vi.fn().mockResolvedValue(undefined),
            ...manager,
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });
        const room = { roomId: ROOM } as any as Room;
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            ...mockClientMethodsRooms([room]),
        });
        mockClient.createMessagesRequest.mockResolvedValueOnce({ chunk, end: "t-next" } as any);
        mockClient.createMessagesRequest.mockResolvedValue({ chunk: [] } as any);
        vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
            if (settingName === "crawlerSleepTime") return 0;
            return undefined;
        });
        const indexer = new EventIndex();
        await indexer.init();
        indexer.startCrawler();
        // The second /messages request is the crawler coming back for the continuation checkpoint, i.e. the first
        // batch has been fully handled (including whatever follows addHistoricEvents).
        await vi.waitFor(() => expect(mockClient.createMessagesRequest).toHaveBeenCalledTimes(2), { timeout: 4000 });
        return { manager: mockIndexingManager, client: mockClient, stop: () => indexer.stopCrawler() };
    }

    const backward = (roomId: string, token: string): ICrawlerCheckpoint =>
        ({ roomId, token, direction: Direction.Backward }) as ICrawlerCheckpoint;
    const forward = (roomId: string, token: string): ICrawlerCheckpoint =>
        ({ roomId, token, direction: Direction.Forward }) as ICrawlerCheckpoint;

    it("a backward batch releases exactly the ids it met redacted, after addHistoricEvents (R, E and O in one batch)", async () => {
        const { manager, stop } = await crawl([backward(ROOM, "t0")], deletedAndEditedBatch());
        try {
            expect(manager.deleteEvent).toHaveBeenCalledWith("$o"); // the redaction is applied first ...
            const added = manager.addHistoricEvents.mock.calls[0][0];
            expect(added.map((e: any) => e.event.event_id)).toEqual(["$e"]); // ... the edit is delivered, the original is not
            expect(manager.releaseRedactionTombstones).toHaveBeenCalledTimes(1);
            expect(manager.releaseRedactionTombstones).toHaveBeenCalledWith(["$o", "$reaction"]);
            // The release follows the add of the same batch, never precedes it.
            expect(manager.deleteEvent.mock.invocationCallOrder[0]).toBeLessThan(
                manager.addHistoricEvents.mock.invocationCallOrder[0],
            );
            expect(manager.addHistoricEvents.mock.invocationCallOrder[0]).toBeLessThan(
                manager.releaseRedactionTombstones.mock.invocationCallOrder[0],
            );
        } finally {
            stop();
        }
    });

    it("releases nothing when the batch met nothing redacted", async () => {
        const { manager, stop } = await crawl([backward(ROOM, "t0")], [message("$plain")]);
        try {
            expect(manager.addHistoricEvents).toHaveBeenCalledTimes(1);
            expect(manager.releaseRedactionTombstones).not.toHaveBeenCalled();
        } finally {
            stop();
        }
    });

    it("a forward batch never releases", async () => {
        const { manager, stop } = await crawl([forward(ROOM, "t0")], deletedAndEditedBatch());
        try {
            expect(manager.addHistoricEvents).toHaveBeenCalledTimes(1);
            expect(manager.deleteEvent).toHaveBeenCalledWith("$o"); // the redaction itself is still applied
            expect(manager.releaseRedactionTombstones).not.toHaveBeenCalled();
        } finally {
            stop();
        }
    });

    it("a second backward checkpoint of the same room, queued, suppresses the release", async () => {
        const { manager, stop } = await crawl(
            [backward(ROOM, "t0"), backward(ROOM, "t-other")],
            deletedAndEditedBatch(),
        );
        try {
            expect(manager.addHistoricEvents).toHaveBeenCalledTimes(1);
            expect(manager.releaseRedactionTombstones).not.toHaveBeenCalled();
        } finally {
            stop();
        }
    });

    it("a queued forward checkpoint of the same room suppresses it too", async () => {
        // The forward crawl may still deliver an edit of the original (probe X2): it starts where the backward one
        // did and walks towards the present, so it meets the edits the backward crawl never sees.
        const { manager, stop } = await crawl([backward(ROOM, "t0"), forward(ROOM, "t1")], deletedAndEditedBatch());
        try {
            expect(manager.addHistoricEvents).toHaveBeenCalledTimes(1);
            expect(manager.releaseRedactionTombstones).not.toHaveBeenCalled();
        } finally {
            stop();
        }
    });

    it("a queued checkpoint of another room does not suppress it", async () => {
        const { manager, stop } = await crawl(
            [backward(ROOM, "t0"), backward("!other:id", "t1"), forward("!other:id", "t1")],
            deletedAndEditedBatch(),
        );
        try {
            expect(manager.releaseRedactionTombstones).toHaveBeenCalledWith(["$o", "$reaction"]);
        } finally {
            stop();
        }
    });

    it("a release that fails only logs: the crawl goes on with the continuation checkpoint", async () => {
        const { manager, client, stop } = await crawl([backward(ROOM, "t0")], deletedAndEditedBatch(), {
            releaseRedactionTombstones: vi.fn().mockRejectedValue(new Error("boom")),
        });
        try {
            expect(manager.releaseRedactionTombstones).toHaveBeenCalledTimes(1);
            expect(manager.addHistoricEvents).toHaveBeenCalledTimes(1); // not retried as a failed batch
            expect(client.createMessagesRequest).toHaveBeenNthCalledWith(2, ROOM, "t-next", 100, "b");
        } finally {
            stop();
        }
    });
});

describe("EventIndex crawler on the browser manager: redaction tombstones (S1)", () => {
    const ROOM = "!room1:id";
    const SENDER = "@alice:id";
    const redaction = {
        event_id: "$r",
        room_id: ROOM,
        sender: SENDER,
        type: "m.room.redaction",
        origin_server_ts: 40,
        redacts: "$o",
        content: {},
    };
    const message = (id: string, extra: Record<string, unknown> = {}): any => ({
        event_id: id,
        room_id: ROOM,
        sender: SENDER,
        type: "m.room.message",
        origin_server_ts: 10,
        content: { body: "hello", msgtype: "m.text" },
        ...extra,
    });
    const editOfO = (): any =>
        message("$e", {
            origin_server_ts: 20,
            content: {
                "body": "* zzcrawledit",
                "msgtype": "m.text",
                "m.new_content": { body: "zzcrawledit", msgtype: "m.text" },
                "m.relates_to": { rel_type: "m.replace", event_id: "$o" },
            },
        });
    const redactedO = (): any =>
        message("$o", { origin_server_ts: 10, content: {}, unsigned: { redacted_because: redaction } });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("a backward crawl that meets the original redacted keeps its tombstone while a forward crawl of the room is queued (X2)", async () => {
        vi.stubGlobal("indexedDB", new IDBFactory());
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(true);
        vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any =>
            settingName === "crawlerSleepTime" ? 0 : undefined,
        );
        const manager = new BrowserEventIndexManager();
        mockPlatformPeg({
            getPickleKey: vi.fn().mockResolvedValue("unit-test-pickle-key"),
            getEventIndexingManager: () => manager,
        });
        await manager.initEventIndex("@x2:id", "DEVICE1");
        await manager.waitForHydration();
        // R arrives live and records the tombstone of O; a newer live message is indexed too.
        const live = message("$live", { origin_server_ts: 50, content: { body: "zzlivealready", msgtype: "m.text" } });
        await manager.deleteEvent("$o");
        await manager.addEventToIndex(live, {});

        // The initial pair of checkpoints of one room. The backward crawl meets O already redacted; the forward one
        // then delivers E, and stops at its next batch, which holds only what is already indexed: it never meets R.
        const pages: Record<string, { chunk: any[]; end?: string }> = {
            "b:t0": { chunk: [redactedO()], end: "tb1" },
            "f:t0": { chunk: [editOfO()], end: "tf1" },
            "f:tf1": { chunk: [live], end: "tf2" },
            "f:tf2": { chunk: [redaction], end: "tf3" }, // never reached
        };
        vi.spyOn(manager, "loadCheckpoints").mockResolvedValue([
            { roomId: ROOM, token: "t0", direction: Direction.Backward } as ICrawlerCheckpoint,
            { roomId: ROOM, token: "t0", direction: Direction.Forward } as ICrawlerCheckpoint,
        ]);
        vi.spyOn(manager, "shouldCrawl").mockResolvedValue(true);
        const removed = vi.spyOn(manager, "removeCrawlerCheckpoint");
        const room = { roomId: ROOM } as any as Room;
        const client = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            ...mockClientMethodsRooms([room]),
        });
        const requested: string[] = [];
        client.createMessagesRequest.mockImplementation(async (_roomId, token, _limit, dir) => {
            requested.push(`${dir}:${token}`);
            return (pages[`${dir}:${token}`] ?? { chunk: [] }) as any;
        });

        const indexer = new EventIndex();
        await indexer.init();
        indexer.startCrawler();
        try {
            // The forward crawl ending: its continuation is retired because the batch was all already indexed.
            await vi.waitFor(() => expect(removed).toHaveBeenCalledWith(expect.objectContaining({ token: "tf2" })), {
                timeout: 4000,
            });
        } finally {
            indexer.stopCrawler();
        }
        expect(requested).toEqual(["b:t0", "f:t0", "b:tb1", "f:tf1"]);

        const results = await manager.searchEventIndex({
            search_term: "zzcrawledit",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
            limit: 10,
        });
        expect((results.results ?? []).map((r) => r.result.event_id)).toEqual([]);
        // Kept, not released: the backward crawl passed O while the forward crawl could still deliver an edit of it.
        expect((await manager.getStats()).redactionTombstones).toBe(1);
        await manager.closeEventIndex();
    });
});

/**
 * Mock out the `createMessagesRequest` method on the client, with an implementation that will block until a resolver is called.
 *
 * @returns An object with the following properties:
 *  * `called`: A promise that resolves when `createMessagesRequest` is called.
 *  * `resolve`: A function that can be called to allow `createMessagesRequest` to complete.
 */
function mockCreateMessagesRequest(mockClient: Mocked<MatrixClient>): {
    called: Promise<void>;
    resolve: (result: any) => void;
} {
    const messagesCalledPromise = Promise.withResolvers<void>();
    const messagesResultPromise = Promise.withResolvers();
    mockClient.createMessagesRequest.mockImplementationOnce(() => {
        messagesCalledPromise.resolve();
        return messagesResultPromise.promise as any;
    });
    return {
        called: messagesCalledPromise.promise,
        resolve: messagesResultPromise.resolve,
    };
}
