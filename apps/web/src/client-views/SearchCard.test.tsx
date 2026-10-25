/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import React from "react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "test-utils-rtl";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { SDKContext } from "../contexts/SDKContext";
import { type SDKContextClass } from "../contexts/SDKContextClass";
import RoomContext, { TimelineRenderingType } from "../contexts/RoomContext";
import eventSearch, { SearchScope } from "../Searching";
import { SearchCard } from "./SearchCard";

vi.mock("../Searching", async (orig) => ({
    ...(await orig<typeof import("../Searching")>()),
    default: vi.fn(),
}));
vi.mock("../components/views/right_panel/BaseCard", async () => {
    const R = await import("react");
    return {
        default: (p: { header: React.ReactNode; children: React.ReactNode; onClose: () => void }) =>
            R.createElement(
                "div",
                { "data-testid": "base-card" },
                p.header,
                R.createElement("button", { onClick: p.onClose }, "close"),
                p.children,
            ),
    };
});
vi.mock("../components/structures/RoomSearchView", async () => {
    const R = await import("react");
    const { useScopedRoomContext } = await import("../contexts/ScopedRoomContext");
    const RoomContext = (await import("../contexts/RoomContext")).default;
    return {
        RoomSearchView: (p: { term: string; scope: string; onUpdate: (...a: unknown[]) => void }) => {
            const scoped = useScopedRoomContext("timelineRenderingType");
            const legacy = R.useContext(RoomContext);
            return R.createElement(
                "div",
                {
                    "data-testid": "search-view",
                    "data-term": p.term,
                    "data-scope": p.scope,
                    "data-scoped": String(scoped.timelineRenderingType),
                    "data-legacy": String(legacy.timelineRenderingType),
                },
                R.createElement("button", { onClick: () => p.onUpdate(false, { count: 3 }, null) }, "done"),
            );
        },
    };
});
vi.mock("../components/views/rooms/RoomSearchAuxPanel", async () => {
    const R = await import("react");
    return {
        default: (p: { isRoomEncrypted: boolean; searchInfo?: { count?: number }; onCancelClick: () => void }) =>
            R.createElement(
                "div",
                {
                    "data-testid": "aux",
                    "data-encrypted": String(p.isRoomEncrypted),
                    "data-count": String(p.searchInfo?.count),
                },
                R.createElement("button", { onClick: p.onCancelClick }, "cancel"),
            ),
    };
});

const room = { roomId: "!a" } as unknown as Room;
const client = {} as unknown as MatrixClient;
const sdk = { client } as unknown as SDKContextClass;

describe("SearchCard", () => {
    const search = vi.mocked(eventSearch);
    const signals: AbortSignal[] = [];
    const mount = (props: Partial<React.ComponentProps<typeof SearchCard>> = {}, encrypted: boolean | null = false) => {
        const onClose = vi.fn();
        const ctx = { isRoomEncrypted: encrypted, timelineRenderingType: TimelineRenderingType.Room } as never;
        const view = render(
            <SDKContext.Provider value={sdk}>
                <RoomContext.Provider value={ctx}>
                    <SearchCard room={room} onClose={onClose} {...props} />
                </RoomContext.Provider>
            </SDKContext.Provider>,
        );
        return { onClose, ...view };
    };
    const input = () => screen.getByRole("searchbox") as HTMLInputElement;
    const type = (v: string) => fireEvent.change(input(), { target: { value: v } });

    beforeEach(() => {
        vi.useFakeTimers();
        signals.length = 0;
        search.mockReset();
        search.mockImplementation((_c, _t, _r, signal) => {
            if (signal) signals.push(signal);
            return Promise.resolve({ results: [], highlights: [] } as never);
        });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("opens with a focused field and no search; typing sends exactly one eventSearch for the room after 300 ms", () => {
        mount();
        expect(document.activeElement).toBe(input());
        expect(screen.queryByTestId("search-view")).toBeNull();
        type("n");
        type("ne");
        type("needle");
        act(() => void vi.advanceTimersByTime(299));
        expect(search).not.toHaveBeenCalled();
        act(() => void vi.advanceTimersByTime(1));
        expect(search).toHaveBeenCalledTimes(1);
        expect(search).toHaveBeenCalledWith(client, "needle", "!a", expect.any(AbortSignal));
        const view = screen.getByTestId("search-view");
        expect(view.dataset.term).toBe("needle");
        expect(view.dataset.scope).toBe(SearchScope.Room);
    });

    it("runs RoomSearchView under RoomContext timelineRenderingType Search, scoped and legacy", () => {
        mount({ initialTerm: "x" });
        act(() => void vi.advanceTimersByTime(300));
        const view = screen.getByTestId("search-view");
        expect(view.dataset.scoped).toBe(TimelineRenderingType.Search);
        expect(view.dataset.legacy).toBe(TimelineRenderingType.Search);
    });

    it("a new term aborts the previous search; unmounting aborts the last one", () => {
        const { unmount } = mount();
        type("one");
        act(() => void vi.advanceTimersByTime(300));
        type("two");
        act(() => void vi.advanceTimersByTime(300));
        expect(search).toHaveBeenCalledTimes(2);
        expect(signals[0].aborted).toBe(true);
        expect(signals[1].aborted).toBe(false);
        unmount();
        expect(signals[1].aborted).toBe(true);
    });

    it("opens with the term the info card handed over, searches after the same 300 ms debounce as typing (F2), cursor at the end", () => {
        mount({ initialTerm: "handed" });
        expect(search).not.toHaveBeenCalled();
        act(() => void vi.advanceTimersByTime(299));
        expect(search).not.toHaveBeenCalled();
        act(() => void vi.advanceTimersByTime(1));
        expect(search).toHaveBeenCalledTimes(1);
        expect(search).toHaveBeenCalledWith(client, "handed", "!a", expect.any(AbortSignal));
        expect(input().value).toBe("handed");
        expect(input().selectionStart).toBe(6);
    });

    it("an empty term clears the search (no request); Escape clears a non-empty field and stays, an empty one bubbles", () => {
        const outer = vi.fn();
        mount({ initialTerm: "x" });
        act(() => void vi.advanceTimersByTime(300));
        document.body.addEventListener("keydown", outer);
        expect(search).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(input(), { key: "Escape" });
        expect(input().value).toBe("");
        expect(screen.queryByTestId("search-view")).toBeNull();
        expect(signals[0].aborted).toBe(true);
        expect(outer).not.toHaveBeenCalled();
        fireEvent.keyDown(input(), { key: "Escape" });
        expect(outer).toHaveBeenCalledTimes(1);
        type("a");
        type("");
        act(() => void vi.advanceTimersByTime(300));
        expect(search).toHaveBeenCalledTimes(1);
    });

    it("onUpdate feeds the aux panel's count; the aux panel waits for the encryption answer and passes it on (SearchWarning LIMIT)", () => {
        const { rerender } = mount({ initialTerm: "x" }, null);
        act(() => void vi.advanceTimersByTime(300));
        expect(screen.queryByTestId("aux")).toBeNull();
        rerender(
            <SDKContext.Provider value={sdk}>
                <RoomContext.Provider
                    value={{ isRoomEncrypted: true, timelineRenderingType: TimelineRenderingType.Room } as never}
                >
                    <SearchCard room={room} onClose={vi.fn()} initialTerm="x" />
                </RoomContext.Provider>
            </SDKContext.Provider>,
        );
        expect(screen.getByTestId("aux").dataset.encrypted).toBe("true");
        fireEvent.click(screen.getByText("done"));
        expect(screen.getByTestId("aux").dataset.count).toBe("3");
        fireEvent.click(screen.getByText("cancel"));
        expect(screen.queryByTestId("search-view")).toBeNull();
    });

    it("close is the card's close", () => {
        const { onClose } = mount();
        fireEvent.click(screen.getByText("close"));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
