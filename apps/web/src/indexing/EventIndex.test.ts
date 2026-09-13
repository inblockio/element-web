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

import { vi, describe, it, expect, afterEach, type Mocked } from "vitest";
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
