/*
Copyright 2026 hayaksi1
Copyright 2024 New Vector Ltd.
Copyright 2024 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { act, render } from "jest-matrix-react";
import React from "react";
import { type Room } from "matrix-js-sdk/src/matrix";

import SdkConfig from "../../../../../src/SdkConfig";
import SearchWarning, { WarningKind } from "../../../../../src/components/views/elements/SearchWarning";
import EventIndexPeg from "../../../../../src/indexing/EventIndexPeg";
import { type default as EventIndex } from "../../../../../src/indexing/EventIndex";
import { SearchScope } from "../../../../../src/Searching";

const SEARCHED_ROOM = "!searched:example.org";
const OTHER_ROOM = "!other:example.org";
const PARTIAL_WARNING = "Results may be incomplete because your search index is still being built.";
const PARTIAL_FILES_WARNING = "Some encrypted files may be missing because your search index is still being built.";

// SearchWarning's `loading` disjunct polls getStats() on a 1s interval while it is true (there is
// no event for hydration finishing, unlike changedCheckpoint) -- see SearchWarning.tsx's
// LOADING_POLL_MS. Fake timers let the tests below advance past that without a real 1s wait.
jest.useFakeTimers();

/**
 * A minimal fake EventIndex exposing only the surface that SearchWarning consumes:
 * `crawlingRooms()` (the rooms with outstanding crawler checkpoints), `isRoomIndexed()` (whether
 * the index holds any events for a room), `getStats()` (whether the browser backend is still
 * hydrating from disk) and the `changedCheckpoint` emitter.
 */
class FakeEventIndex {
    private listeners = new Map<string, Set<(...args: any[]) => void>>();

    /** Settable after construction, so a test can flip it mid-render without a new instance. */
    public loading = false;

    /** Settable after construction; see the "windowed" describe block below. */
    public windowed = false;
    // oldestResidentTs, not oldestIndexedTs: SearchWarning's date line now sources from the
    // resident (searchable) floor, not the disk one -- see useIsIndexIncomplete's own docstring.
    public oldestResidentTs: number | undefined = undefined;

    /** getStats() rejects once, then answers normally; see "treats a getStats() failure as not loading". */
    public getStatsFailsOnce = false;

    /**
     * @param crawling Rooms with an outstanding crawler checkpoint.
     * @param indexed Rooms the index holds events for. Defaults to `undefined`, meaning
     *     `isRoomIndexed` resolves `undefined`, as it does when there is no index manager.
     */
    public constructor(
        private crawling: string[] = [],
        private indexed?: string[],
    ) {}

    public crawlingRooms(): { crawlingRooms: Set<string>; totalRooms: Set<string> } {
        return { crawlingRooms: new Set(this.crawling), totalRooms: new Set(this.crawling) };
    }

    public async isRoomIndexed(roomId: string): Promise<boolean | undefined> {
        return this.indexed === undefined ? undefined : this.indexed.includes(roomId);
    }

    public async getStats(): Promise<{
        size: number;
        eventCount: number;
        roomCount: number;
        loading: boolean;
        windowed: boolean;
        oldestResidentTs: number | undefined;
    }> {
        if (this.getStatsFailsOnce) {
            this.getStatsFailsOnce = false;
            throw new Error("simulated getStats() failure");
        }
        return {
            size: 0,
            eventCount: 0,
            roomCount: 0,
            loading: this.loading,
            windowed: this.windowed,
            oldestResidentTs: this.oldestResidentTs,
        };
    }

    public on(event: string, listener: (...args: any[]) => void): void {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(listener);
    }

    public removeListener(event: string, listener: (...args: any[]) => void): void {
        this.listeners.get(event)?.delete(listener);
    }

    /**
     * Test helper: simulate the crawler advancing (or finishing, when `crawling` is empty).
     *
     * The real index emits only the globally-current room, which cannot answer a per-room
     * question, so `currentRoom` is passed through purely to prove consumers ignore it.
     */
    public emitChangedCheckpoint(crawling: string[], currentRoom: Room | null = null): void {
        this.crawling = crawling;
        this.listeners.get("changedCheckpoint")?.forEach((listener) => listener(currentRoom));
    }
}

describe("<SearchWarning />", () => {
    afterEach(() => {
        EventIndexPeg.index = null;
        EventIndexPeg.error = undefined;
    });

    describe("with desktop builds available", () => {
        beforeEach(() => {
            EventIndexPeg.index = null;
            SdkConfig.put({
                brand: "Element",
                desktop_builds: {
                    available: true,
                    logo: "https://logo",
                    url: "https://url",
                },
            });
        });

        it("renders with a logo by default", () => {
            const { asFragment, getByRole } = render(
                <SearchWarning isRoomEncrypted={true} kind={WarningKind.Search} />,
            );
            expect(getByRole("presentation")).toHaveAttribute("src", "https://logo");
            expect(asFragment()).toMatchSnapshot();
        });

        it("renders without a logo when showLogo=false", () => {
            const { asFragment, queryByRole } = render(
                <SearchWarning isRoomEncrypted={true} kind={WarningKind.Search} showLogo={false} />,
            );

            expect(queryByRole("img")).not.toBeInTheDocument();
            expect(asFragment()).toMatchSnapshot();
        });
    });

    describe("with the event index present", () => {
        const setIndex = (index: FakeEventIndex): void => {
            EventIndexPeg.index = index as unknown as EventIndex;
        };

        /** Let the pending isRoomIndexed() lookup settle and React re-render off the back of it. */
        const settle = async (): Promise<void> => {
            await act(async () => {});
        };

        it("warns a room-scoped search while the searched room is still being crawled", async () => {
            setIndex(new FakeEventIndex([SEARCHED_ROOM], []));

            const { queryByText, queryByRole } = render(
                <SearchWarning
                    isRoomEncrypted={true}
                    kind={WarningKind.Search}
                    scope={SearchScope.Room}
                    roomId={SEARCHED_ROOM}
                />,
            );
            await settle();

            expect(queryByText(PARTIAL_WARNING)).toBeInTheDocument();
            // The notice appears dynamically while the panel is open, so it must be a live region (#32253).
            expect(queryByRole("status")).toBeInTheDocument();
        });

        it("does not warn a room-scoped search when only an unrelated room is still being crawled", async () => {
            setIndex(new FakeEventIndex([OTHER_ROOM], [SEARCHED_ROOM]));

            const { container } = render(
                <SearchWarning
                    isRoomEncrypted={true}
                    kind={WarningKind.Search}
                    scope={SearchScope.Room}
                    roomId={SEARCHED_ROOM}
                />,
            );
            await settle();

            expect(container).toBeEmptyDOMElement();
        });

        it("warns a room-scoped search when the index holds no events for the searched room", async () => {
            // Nothing is queued for the searched room, but it has never been indexed: this is how a
            // room looks before its checkpoint has been seeded, and the crawl set alone cannot see
            // it. The crawler is still working through another room, so indexing is still under way.
            setIndex(new FakeEventIndex([OTHER_ROOM], []));

            const { queryByText } = render(
                <SearchWarning
                    isRoomEncrypted={true}
                    kind={WarningKind.Search}
                    scope={SearchScope.Room}
                    roomId={SEARCHED_ROOM}
                />,
            );
            await settle();

            expect(queryByText(PARTIAL_WARNING)).toBeInTheDocument();
        });

        it("does not warn about an unindexed room once the crawler has drained", async () => {
            // The index holds nothing for the room, but the crawler has no work left, so nothing
            // more is coming: the warning would never clear itself, and its claim that the index is
            // "still being built" would be untrue.
            setIndex(new FakeEventIndex([], []));

            const { container } = render(
                <SearchWarning
                    isRoomEncrypted={true}
                    kind={WarningKind.Search}
                    scope={SearchScope.Room}
                    roomId={SEARCHED_ROOM}
                />,
            );
            await settle();

            expect(container).toBeEmptyDOMElement();
        });

        it("keeps an earned warning up while an unrelated checkpoint change is re-checked", async () => {
            // The warning here is earned asynchronously: the room is not queued, but the index
            // holds nothing for it. An unrelated crawler transition must not blink it off while
            // the fresh lookup is in flight.
            const index = new FakeEventIndex([OTHER_ROOM], []);
            setIndex(index);

            const { queryByText } = render(
                <SearchWarning
                    isRoomEncrypted={true}
                    kind={WarningKind.Search}
                    scope={SearchScope.Room}
                    roomId={SEARCHED_ROOM}
                />,
            );
            await settle();
            expect(queryByText(PARTIAL_WARNING)).toBeInTheDocument();

            // The crawler moves on to a third room; nothing about the searched room changed.
            act(() => {
                index.emitChangedCheckpoint([OTHER_ROOM, "!third:example.org"]);
            });

            // Asserted before the lookup settles: the warning must not have been dropped.
            expect(queryByText(PARTIAL_WARNING)).toBeInTheDocument();

            await settle();
            expect(queryByText(PARTIAL_WARNING)).toBeInTheDocument();
        });

        it("treats an unanswerable isRoomIndexed as no evidence for a room-scoped search", async () => {
            setIndex(new FakeEventIndex([OTHER_ROOM], undefined));

            const { container } = render(
                <SearchWarning
                    isRoomEncrypted={true}
                    kind={WarningKind.Search}
                    scope={SearchScope.Room}
                    roomId={SEARCHED_ROOM}
                />,
            );
            await settle();

            expect(container).toBeEmptyDOMElement();
        });

        it("does not carry a warning from a previously searched room across a scope change", async () => {
            // The crawler is working through OTHER_ROOM, so an all-rooms search warns. Switching to
            // a room-scoped search of a fully-indexed room must not leave that warning on screen
            // while the isRoomIndexed lookup for the new room is in flight.
            setIndex(new FakeEventIndex([OTHER_ROOM], [SEARCHED_ROOM]));

            const { queryByText, rerender } = render(
                <SearchWarning isRoomEncrypted={true} kind={WarningKind.Search} scope={SearchScope.All} />,
            );
            await settle();
            expect(queryByText(PARTIAL_WARNING)).toBeInTheDocument();

            rerender(
                <SearchWarning
                    isRoomEncrypted={true}
                    kind={WarningKind.Search}
                    scope={SearchScope.Room}
                    roomId={SEARCHED_ROOM}
                />,
            );

            // Asserted before settling: the stale answer must be gone as soon as the effect for
            // the new scope has run, rather than lingering for the isRoomIndexed round-trip.
            expect(queryByText(PARTIAL_WARNING)).not.toBeInTheDocument();
        });

        it("warns an all-rooms search while any room is still being crawled", async () => {
            setIndex(new FakeEventIndex([OTHER_ROOM], []));

            const { queryByText } = render(
                <SearchWarning isRoomEncrypted={true} kind={WarningKind.Search} scope={SearchScope.All} />,
            );
            await settle();

            expect(queryByText(PARTIAL_WARNING)).toBeInTheDocument();
        });

        it("falls back to the global check when the searched room is not yet known", async () => {
            // RoomView can render before a room alias has resolved to an id.
            setIndex(new FakeEventIndex([OTHER_ROOM], []));

            const { queryByText } = render(
                <SearchWarning
                    isRoomEncrypted={true}
                    kind={WarningKind.Search}
                    scope={SearchScope.Room}
                    roomId={undefined}
                />,
            );
            await settle();

            expect(queryByText(PARTIAL_WARNING)).toBeInTheDocument();
        });

        it("renders nothing once the index has finished crawling", async () => {
            setIndex(new FakeEventIndex([], []));

            const { container } = render(
                <SearchWarning isRoomEncrypted={true} kind={WarningKind.Search} scope={SearchScope.All} />,
            );
            await settle();

            expect(container).toBeEmptyDOMElement();
        });

        it("does not warn for the Files kind even while crawling", async () => {
            setIndex(new FakeEventIndex([SEARCHED_ROOM], []));

            const { container } = render(<SearchWarning isRoomEncrypted={true} kind={WarningKind.Files} />);
            await settle();

            expect(container).toBeEmptyDOMElement();
        });

        it("clears the warning when the searched room's checkpoint drains", async () => {
            const index = new FakeEventIndex([SEARCHED_ROOM], [SEARCHED_ROOM]);
            setIndex(index);

            const { queryByText } = render(
                <SearchWarning
                    isRoomEncrypted={true}
                    kind={WarningKind.Search}
                    scope={SearchScope.Room}
                    roomId={SEARCHED_ROOM}
                />,
            );
            await settle();

            expect(queryByText(PARTIAL_WARNING)).toBeInTheDocument();

            await act(async () => {
                index.emitChangedCheckpoint([]);
            });

            expect(queryByText(PARTIAL_WARNING)).not.toBeInTheDocument();
        });

        it("keeps warning when the crawler moves to another room but the searched room is still queued", async () => {
            const index = new FakeEventIndex([SEARCHED_ROOM, OTHER_ROOM], [SEARCHED_ROOM]);
            setIndex(index);

            const { queryByText } = render(
                <SearchWarning
                    isRoomEncrypted={true}
                    kind={WarningKind.Search}
                    scope={SearchScope.Room}
                    roomId={SEARCHED_ROOM}
                />,
            );
            await settle();

            // The event payload names a different room; the searched room is still outstanding, so
            // the warning must survive. This fails if the handler trusts the payload.
            await act(async () => {
                index.emitChangedCheckpoint([SEARCHED_ROOM], { roomId: OTHER_ROOM } as Room);
            });

            expect(queryByText(PARTIAL_WARNING)).toBeInTheDocument();
        });

        it("renders nothing when the room is not encrypted even while crawling", async () => {
            setIndex(new FakeEventIndex([SEARCHED_ROOM], []));

            const { container } = render(
                <SearchWarning
                    isRoomEncrypted={false}
                    kind={WarningKind.Search}
                    scope={SearchScope.Room}
                    roomId={SEARCHED_ROOM}
                />,
            );

            expect(container).toBeEmptyDOMElement();
        });

        it("still warns an all-rooms search even when the current room is not encrypted", async () => {
            // An all-rooms search merges hits from every locally-indexed encrypted room, regardless
            // of whether the room this panel happens to be docked in is itself encrypted -- the gap
            // this test guards. `roomId` is undefined for an all-rooms search (SearchInfo.roomId's
            // own contract), so `scope === SearchScope.All` is the only signal available.
            setIndex(new FakeEventIndex([SEARCHED_ROOM], []));

            const { queryByText } = render(
                <SearchWarning isRoomEncrypted={false} kind={WarningKind.Search} scope={SearchScope.All} />,
            );
            await settle();

            expect(queryByText(PARTIAL_WARNING)).toBeInTheDocument();
        });

        it("still renders nothing for WarningKind.Files when the room is not encrypted", async () => {
            // Files has no all-rooms concept (scope/roomId are never passed to it; see FilePanel's
            // call site), so it must keep the previous behaviour exactly: `scope` is `undefined`
            // there, and `undefined !== SearchScope.All` is true, same as before this change.
            const index = new FakeEventIndex([], [SEARCHED_ROOM]);
            index.loading = true;
            setIndex(index);

            const { container } = render(<SearchWarning isRoomEncrypted={false} kind={WarningKind.Files} />);
            await settle();

            expect(container).toBeEmptyDOMElement();
        });

        it("warns while the browser backend is still hydrating, with no checkpoints outstanding at all", async () => {
            // The scenario the loading disjunct exists for: a fresh session, crawler idle, nothing
            // queued, but the backend is still decrypting its on-disk store in the background.
            const index = new FakeEventIndex([], [SEARCHED_ROOM]);
            index.loading = true;
            setIndex(index);

            const { queryByText } = render(
                <SearchWarning
                    isRoomEncrypted={true}
                    kind={WarningKind.Search}
                    scope={SearchScope.Room}
                    roomId={SEARCHED_ROOM}
                />,
            );
            await settle();

            expect(queryByText(PARTIAL_WARNING)).toBeInTheDocument();
        });

        it("clears the loading warning once hydration finishes, without needing a checkpoint transition", async () => {
            // changedCheckpoint fires only on checkpoint transitions, and an idle crawler never
            // fires it, so a warning raised purely by `loading` needs its own way to re-check --
            // the 1s poll armed while `loading` is true. This is the regression test for the bug
            // where the warning, once raised, never cleared itself.
            const index = new FakeEventIndex([], [SEARCHED_ROOM]);
            index.loading = true;
            setIndex(index);

            const { queryByText } = render(
                <SearchWarning
                    isRoomEncrypted={true}
                    kind={WarningKind.Search}
                    scope={SearchScope.Room}
                    roomId={SEARCHED_ROOM}
                />,
            );
            await settle();
            expect(queryByText(PARTIAL_WARNING)).toBeInTheDocument();

            // Hydration finishes. Nothing emits changedCheckpoint -- only the poll can notice.
            index.loading = false;
            await act(async () => {
                await jest.advanceTimersByTimeAsync(1000);
            });

            expect(queryByText(PARTIAL_WARNING)).not.toBeInTheDocument();
        });

        it("does not warn when the backend was never loading in the first place", async () => {
            const index = new FakeEventIndex([], [SEARCHED_ROOM]);
            index.loading = false;
            setIndex(index);

            const { queryByText } = render(
                <SearchWarning
                    isRoomEncrypted={true}
                    kind={WarningKind.Search}
                    scope={SearchScope.Room}
                    roomId={SEARCHED_ROOM}
                />,
            );
            await settle();

            expect(queryByText(PARTIAL_WARNING)).not.toBeInTheDocument();

            // Nothing should be armed to poll: advancing time must not conjure the warning either.
            await act(async () => {
                await jest.advanceTimersByTimeAsync(5000);
            });
            expect(queryByText(PARTIAL_WARNING)).not.toBeInTheDocument();
        });

        it("treats a getStats() failure as not loading, rather than an unhandled rejection", async () => {
            const index = new FakeEventIndex([], [SEARCHED_ROOM]);
            index.getStatsFailsOnce = true;
            setIndex(index);

            const { queryByText } = render(
                <SearchWarning
                    isRoomEncrypted={true}
                    kind={WarningKind.Search}
                    scope={SearchScope.Room}
                    roomId={SEARCHED_ROOM}
                />,
            );
            // No unhandled rejection is asserted implicitly: jest fails the run on one. The rejection
            // path takes one more microtask hop than the resolved one, so this settles twice.
            await settle();
            await settle();

            expect(queryByText(PARTIAL_WARNING)).not.toBeInTheDocument();
        });

        it("warns the Files kind while the backend is still hydrating", async () => {
            // loadFileEvents() answers from resident rows only, exactly like search, but nothing
            // before this warned the Files kind about it at all.
            const index = new FakeEventIndex([], [SEARCHED_ROOM]);
            index.loading = true;
            setIndex(index);

            const { queryByText } = render(<SearchWarning isRoomEncrypted={true} kind={WarningKind.Files} />);
            await settle();

            expect(queryByText(PARTIAL_FILES_WARNING)).toBeInTheDocument();
        });

        it("does not warn the Files kind for crawler checkpoints alone, only for loading", async () => {
            // The Files kind never cared about crawler checkpoints; that must still be true now
            // that it cares about `loading`. Only checkpoints outstanding here, `loading` false.
            setIndex(new FakeEventIndex([SEARCHED_ROOM], []));

            const { container } = render(<SearchWarning isRoomEncrypted={true} kind={WarningKind.Files} />);
            await settle();

            expect(container).toBeEmptyDOMElement();
        });

        describe("windowed (a crawl bound or a budget has excluded something)", () => {
            const WINDOWED_TS = new Date("2026-01-15T00:00:00Z").getTime();

            it('shows "Search covers messages newer than {date}" when windowed and a date is known', async () => {
                const index = new FakeEventIndex([], [SEARCHED_ROOM]);
                index.windowed = true;
                index.oldestResidentTs = WINDOWED_TS;
                setIndex(index);

                const { queryByText } = render(
                    <SearchWarning
                        isRoomEncrypted={true}
                        kind={WarningKind.Search}
                        scope={SearchScope.Room}
                        roomId={SEARCHED_ROOM}
                    />,
                );
                await settle();

                expect(queryByText(/Search covers messages newer than/)).toBeInTheDocument();
            });

            it("does not show the windowed line when nothing has been excluded", async () => {
                const index = new FakeEventIndex([], [SEARCHED_ROOM]);
                index.windowed = false;
                index.oldestResidentTs = WINDOWED_TS; // a date being known is not sufficient on its own
                setIndex(index);

                const { queryByText, container } = render(
                    <SearchWarning
                        isRoomEncrypted={true}
                        kind={WarningKind.Search}
                        scope={SearchScope.Room}
                        roomId={SEARCHED_ROOM}
                    />,
                );
                await settle();

                expect(queryByText(/Search covers messages newer than/)).not.toBeInTheDocument();
                expect(container).toBeEmptyDOMElement();
            });

            it("does not show the windowed line when windowed but no date is known yet", async () => {
                const index = new FakeEventIndex([], [SEARCHED_ROOM]);
                index.windowed = true;
                index.oldestResidentTs = undefined; // windowed without a date is not enough either
                setIndex(index);

                const { queryByText, container } = render(
                    <SearchWarning
                        isRoomEncrypted={true}
                        kind={WarningKind.Search}
                        scope={SearchScope.Room}
                        roomId={SEARCHED_ROOM}
                    />,
                );
                await settle();

                expect(queryByText(/Search covers messages newer than/)).not.toBeInTheDocument();
                expect(container).toBeEmptyDOMElement();
            });

            it("never shows the windowed line for WarningKind.Files", async () => {
                const index = new FakeEventIndex([], [SEARCHED_ROOM]);
                index.windowed = true;
                index.oldestResidentTs = WINDOWED_TS;
                setIndex(index);

                const { queryByText } = render(<SearchWarning isRoomEncrypted={true} kind={WarningKind.Files} />);
                await settle();

                expect(queryByText(/Search covers messages newer than/)).not.toBeInTheDocument();
            });

            it("prefers the still-loading message over the windowed line while both are true", async () => {
                const index = new FakeEventIndex([], [SEARCHED_ROOM]);
                index.loading = true;
                index.windowed = true;
                index.oldestResidentTs = WINDOWED_TS;
                setIndex(index);

                const { queryByText } = render(
                    <SearchWarning
                        isRoomEncrypted={true}
                        kind={WarningKind.Search}
                        scope={SearchScope.Room}
                        roomId={SEARCHED_ROOM}
                    />,
                );
                await settle();

                // Not asserted as "still building" via PARTIAL_WARNING here, since `loading` alone
                // already makes `incomplete` true for this scope/room regardless of windowed.
                expect(queryByText(PARTIAL_WARNING)).toBeInTheDocument();
                expect(queryByText(/Search covers messages newer than/)).not.toBeInTheDocument();
            });
        });
    });

    describe("with no event index (web build)", () => {
        beforeEach(() => {
            EventIndexPeg.index = null;
            EventIndexPeg.error = undefined;
            SdkConfig.put({
                brand: "Element",
                desktop_builds: {
                    available: true,
                    logo: "https://logo",
                    url: "https://url",
                },
            });
        });

        it("still renders the desktop/enable-search warning", () => {
            const { container } = render(<SearchWarning isRoomEncrypted={true} kind={WarningKind.Search} />);

            expect(container.querySelector(".mx_SearchWarning")).toBeInTheDocument();
            expect(container.textContent).toContain("to search encrypted messages");
            // It is the desktop/enable-search affordance, not the partial-index notice.
            expect(container.textContent).not.toContain("your search index is still being built");
        });
    });
});
