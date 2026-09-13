/*
Copyright 2024 New Vector Ltd.
Copyright 2019-2021 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    type IMatrixProfile,
    type IEventWithRoomId as IMatrixEvent,
    type IResultRoomEvents,
    type Direction,
} from "matrix-js-sdk/src/matrix";

// The following interfaces take their names and member names from seshat and the spec

/** A record of a place to resume crawling events in a given room. */
export interface ICrawlerCheckpoint {
    /** The room to be indexed */
    roomId: string;

    /** The pagination index to resume crawling from. */
    token: string;

    /**
     * If `fullCrawl` is false (or absent) and we find that we have already indexed the events we find, then we stop crawling.
     *
     * If `fullCrawl` is true, then we keep going until we reach the end of the room history.
     */
    fullCrawl?: boolean;

    /** Whether we should crawl in the forward or backward direction. */
    direction: Direction;
}

export interface ISearchArgs {
    search_term: string;
    before_limit: number;
    after_limit: number;
    order_by_recency: boolean;
    room_id?: string;
    limit: number;
    next_batch?: string;
}

export interface IEventAndProfile {
    event: IMatrixEvent;
    profile: IMatrixProfile;
}

export interface ILoadArgs {
    roomId: string;
    limit: number;
    fromEvent?: string;
    direction?: string;
}

export interface IIndexStats {
    size: number;
    eventCount: number;
    roomCount: number;
    /**
     * True while historic events are still being decrypted and loaded from disk into memory, in
     * the background, after {@link BaseEventIndexManager.initEventIndex} has already returned;
     * false once nothing more is pending (including immediately, if there was never anything to
     * load). `eventCount`/`roomCount`/`size` above are always answered from what is resident right
     * now, so they climb while this is true rather than reporting the eventual total early. Optional
     * because a backend that restores synchronously, such as desktop's Seshat, has nothing to report
     * here and every caller must treat "not present" the same as `false`.
     */
    loading?: boolean;
    /**
     * True once a crawl bound (a recency window or a room cap) or a byte budget (the resident hot
     * window or the on-disk footprint) has excluded or dropped something that would otherwise be
     * indexed. Optional and absent means "not windowed" (or "backend does not track this"), the
     * same convention as {@link loading}. Drives {@link SearchWarning}'s "Search covers messages
     * newer than {date}" line together with {@link oldestIndexedTs}.
     */
    windowed?: boolean;
    /**
     * The oldest event timestamp (`origin_server_ts`, epoch ms) this backend still guarantees is
     * covered on disk, or `undefined` while nothing is known yet. Only ever moves *forward* (more
     * recent) when something bounded is dropped, and *backward* (older) when an older event is
     * newly discovered -- never a promise that this is the literal oldest surviving row, only that
     * nothing older than it is guaranteed findable. See `BrowserEventIndexManager`'s docstring on
     * its own field of the same name for why a backend bounded by disk space cannot always know the
     * exact figure without a full scan.
     */
    oldestIndexedTs?: number;
    /**
     * A floor on the oldest event timestamp currently *resident* (hydrated into memory), or
     * `undefined` while nothing is resident or the backend does not track this: the same
     * guarantee-floor reading as {@link oldestIndexedTs}, not necessarily the literal minimum.
     * Expected, but not contractually guaranteed by this interface, to read `>= oldestIndexedTs`
     * when both are known -- everything resident is necessarily also on disk (or on its way there).
     */
    oldestResidentTs?: number;
    /**
     * The answer from a one-time `navigator.storage.persist()` request made when this backend's
     * index was first created, or `undefined` if it was never asked (no such API, a backend that
     * does not use it, or a session that opened an index created earlier and so never re-asked).
     * Informational only for the settings UI; nothing reads this to change behaviour.
     */
    storagePersisted?: boolean;
}

/**
 * Base class for classes that provide platform-specific event indexing.
 *
 * Instances of this class are provided by the application.
 */
export default abstract class BaseEventIndexManager {
    /**
     * Does our EventIndexManager support event indexing.
     *
     * If an EventIndexManager implementor has runtime dependencies that
     * optionally enable event indexing they may override this method to perform
     * the necessary runtime checks here.
     *
     * @returns {Promise} A promise that will resolve to true if event indexing
     * is supported, false otherwise.
     */
    public async supportsEventIndexing(): Promise<boolean> {
        return true;
    }
    /**
     * Initialize the event index for the given user.
     *
     * @param {string} userId The event that should be added to the index.
     * @param {string} deviceId The profile of the event sender at the
     *
     * @returns {Promise} A promise that will resolve when the event index is
     * initialized.
     */
    public async initEventIndex(userId: string, deviceId: string): Promise<void> {
        throw new Error("Unimplemented");
    }

    /**
     * Queue up an event to be added to the index.
     *
     * @param {MatrixEvent} ev The event that should be added to the index.
     * @param {IMatrixProfile} profile The profile of the event sender at the
     * time the event was received.
     *
     * @returns {Promise} A promise that will resolve when the was queued up for
     * addition.
     */
    public async addEventToIndex(ev: IMatrixEvent, profile: IMatrixProfile): Promise<void> {
        throw new Error("Unimplemented");
    }

    public async deleteEvent(eventId: string): Promise<boolean> {
        throw new Error("Unimplemented");
    }

    public async isEventIndexEmpty(): Promise<boolean> {
        throw new Error("Unimplemented");
    }

    /**
     * Check if the room with the given id is already indexed.
     *
     * @param {string} roomId The ID of the room which we want to check if it
     * has been already indexed.
     *
     * @returns {Promise<boolean>} Returns true if the index contains events for
     * the given room, false otherwise.
     */
    public isRoomIndexed(roomId: string): Promise<boolean> {
        throw new Error("Unimplemented");
    }

    /**
     * Get statistical information of the index.
     *
     * @returns {Promise<IIndexStats>} A promise that will resolve to the index
     * statistics.
     */
    public async getStats(): Promise<IIndexStats> {
        throw new Error("Unimplemented");
    }

    /**
     * Get the user version of the database.
     * @returns {Promise<number>} A promise that will resolve to the user stored
     * version number.
     */
    public async getUserVersion(): Promise<number> {
        throw new Error("Unimplemented");
    }

    /**
     * Set the user stored version to the given version number.
     *
     * @param {number} version The new version that should be stored in the
     * database.
     *
     * @returns {Promise<void>} A promise that will resolve once the new version
     * is stored.
     */
    public async setUserVersion(version: number): Promise<void> {
        throw new Error("Unimplemented");
    }

    /**
     * Commit the previously queued up events to the index.
     *
     * @returns {Promise} A promise that will resolve once the queued up events
     * were added to the index.
     */
    public async commitLiveEvents(): Promise<void> {
        throw new Error("Unimplemented");
    }

    /**
     * Search the event index using the given term for matching events.
     *
     * @param {ISearchArgs} searchArgs The search configuration for the search,
     * sets the search term and determines the search result contents.
     *
     * @returns {Promise<IResultRoomEvents[]>} A promise that will resolve to an array
     * of search results once the search is done.
     */
    public async searchEventIndex(searchArgs: ISearchArgs): Promise<IResultRoomEvents> {
        throw new Error("Unimplemented");
    }

    /**
     * Add events from the room history to the event index.
     *
     * This is used to add a batch of events to the index.
     *
     * @param {[IEventAndProfile]} events The list of events and profiles that
     * should be added to the event index.
     * @param {[ICrawlerCheckpoint]} checkpoint A new crawler checkpoint that
     * should be stored in the index which should be used to continue crawling
     * the room.
     * @param {[ICrawlerCheckpoint]} oldCheckpoint The checkpoint that was used
     * to fetch the current batch of events. This checkpoint will be removed
     * from the index.
     *
     * @returns {Promise} A promise that will resolve to true if all the events
     * were already added to the index, false otherwise.
     */
    public async addHistoricEvents(
        events: IEventAndProfile[],
        checkpoint: ICrawlerCheckpoint | null,
        oldCheckpoint: ICrawlerCheckpoint | null,
    ): Promise<boolean> {
        throw new Error("Unimplemented");
    }

    /**
     * Add a new crawler checkpoint to the index.
     *
     * @param {ICrawlerCheckpoint} checkpoint The checkpoint that should be added
     * to the index.
     *
     * @returns {Promise} A promise that will resolve once the checkpoint has
     * been stored.
     */
    public async addCrawlerCheckpoint(checkpoint: ICrawlerCheckpoint): Promise<void> {
        throw new Error("Unimplemented");
    }

    /**
     * Whether the crawler should still spend a request crawling `checkpoint`, or decline it; see
     * {@link EventIndex.crawlerFunc} (consulted before every `createMessagesRequest`) and {@link
     * EventIndex.addInitialCheckpoints} (consulted before a fresh checkpoint is even persisted).
     * The default is always yes: only a manager enforcing a crawl bound -- a recency window, a room
     * cap -- needs to say no, and declining is handled by the caller exactly like having crawled to
     * completion: the checkpoint is removed, not retried, so a manager that returns `false` must
     * not also expect to see this checkpoint again.
     *
     * @param checkpoint The checkpoint about to be crawled.
     * @returns `true` to proceed as before; `false` to decline it.
     */
    public async shouldCrawl(checkpoint: ICrawlerCheckpoint): Promise<boolean> {
        return true;
    }

    /**
     * Add a new crawler checkpoint to the index.
     *
     * @param {ICrawlerCheckpoint} checkpoint The checkpoint that should be
     * removed from the index.
     *
     * @returns {Promise} A promise that will resolve once the checkpoint has
     * been removed.
     */
    public async removeCrawlerCheckpoint(checkpoint: ICrawlerCheckpoint): Promise<void> {
        throw new Error("Unimplemented");
    }

    /**
     * Load the stored checkpoints from the index.
     *
     * @returns {Promise<[ICrawlerCheckpoint]>} A promise that will resolve to an
     * array of crawler checkpoints once they have been loaded from the index.
     */
    public async loadCheckpoints(): Promise<ICrawlerCheckpoint[]> {
        throw new Error("Unimplemented");
    }

    /** Load events that contain an mxc URL to a file from the index.
     *
     * @param  {object} args Arguments object for the method.
     * @param  {string} args.roomId The ID of the room for which the events
     * should be loaded.
     * @param  {number} args.limit The maximum number of events to return.
     * @param  {string} args.fromEvent An event id of a previous event returned
     * by this method. Passing this means that we are going to continue loading
     * events from this point in the history.
     * @param  {string} args.direction The direction to which we should continue
     * loading events from. This is used only if fromEvent is used as well.
     *
     * @returns {Promise<[IEventAndProfile]>} A promise that will resolve to an
     * array of Matrix events that contain mxc URLs accompanied with the
     * historic profile of the sender.
     */
    public async loadFileEvents(args: ILoadArgs): Promise<IEventAndProfile[]> {
        throw new Error("Unimplemented");
    }

    /**
     * close our event index.
     *
     * @returns {Promise} A promise that will resolve once the event index has
     * been closed.
     */
    public async closeEventIndex(): Promise<void> {
        throw new Error("Unimplemented");
    }

    /**
     * Delete our current event index.
     *
     * @returns {Promise} A promise that will resolve once the event index has
     * been deleted.
     */
    public async deleteEventIndex(): Promise<void> {
        throw new Error("Unimplemented");
    }
}
