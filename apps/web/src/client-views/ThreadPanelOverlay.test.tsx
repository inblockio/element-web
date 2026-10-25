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
import { type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk/src/matrix";

import { SDKContext } from "../contexts/SDKContext";
import { type SDKContextClass } from "../contexts/SDKContextClass";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { TimelineRenderingType } from "../contexts/RoomContext";
import { ThreadPanelOverlay, panelSdkContext } from "./ThreadPanelOverlay";
import { type ThreadPanelRequest } from "./ViewModelBridge";

const h = vi.hoisted(() => ({
    props: [] as Array<Record<string, unknown>>,
    seen: [] as Array<{
        maximised: boolean;
        history: unknown[];
        roomId?: string;
        canSend?: boolean;
        canReact?: boolean;
    }>,
    mounts: 0,
}));

// ThreadView is Element's; this stub reads what the panel gives it: its props, the room context and the SDK context.
vi.mock("../components/structures/ThreadView", async () => {
    const { SDKContext } = await import("../contexts/SDKContext");
    const { default: RoomContext } = await import("../contexts/RoomContext");
    return {
        default: function ThreadViewStub(props: Record<string, unknown>) {
            const sdk = React.useContext(SDKContext);
            const room = React.useContext(RoomContext);
            h.props.push(props);
            React.useEffect(() => void h.mounts++, []);
            h.seen.push({
                maximised: sdk.widgetLayoutStore.hasMaximisedWidget(props.room as never),
                history: sdk.rightPanelStore.roomPhaseHistory,
                roomId: room.roomId,
                canSend: room.canSendMessages,
                canReact: room.canReact,
            });
            return (
                <div>
                    <button onClick={() => sdk.rightPanelStore.popCard()}>back</button>
                    <button onClick={props.onClose as () => void}>close</button>
                    <input aria-label="thread composer" />
                </div>
            );
        },
    };
});

const makeSdk = () => {
    const widgetLayoutStore = { hasMaximisedWidget: vi.fn(() => false), other: "wl" };
    const rightPanelStore = { roomPhaseHistory: [{}, {}], popCard: vi.fn(), setCard: vi.fn(), other: "rp" };
    const client = {
        getSafeUserId: () => "@me:example.org",
        getCrypto: () => undefined,
    } as unknown as MatrixClient;
    return {
        client,
        widgetLayoutStore,
        rightPanelStore,
        roomViewStore: { getRoomId: () => null },
        resizeNotifier: { rn: true },
    } as unknown as SDKContextClass & {
        widgetLayoutStore: typeof widgetLayoutStore;
        rightPanelStore: typeof rightPanelStore;
    };
};

const room = {
    roomId: "!a",
    maySendMessage: () => true,
    getMyMembership: () => "join",
    getLiveTimeline: () => ({}),
    currentState: { maySendEvent: () => true, getStateEvents: () => undefined },
} as unknown as Room;
const root = { getId: () => "$root" } as unknown as MatrixEvent;

describe("panelSdkContext", () => {
    it("answers hasMaximisedWidget true and an empty, read-only right-panel history, and passes the rest through", () => {
        const sdk = makeSdk();
        const panel = panelSdkContext(sdk);
        expect(panel.widgetLayoutStore.hasMaximisedWidget(room)).toBe(true);
        expect(panel.rightPanelStore.roomPhaseHistory).toEqual([]);
        panel.rightPanelStore.popCard();
        expect(sdk.rightPanelStore.popCard).not.toHaveBeenCalled();
        // Everything else is the real thing, not a copy (lazy stores would be built twice).
        expect(panel.client).toBe(sdk.client);
        expect(panel.resizeNotifier).toBe(sdk.resizeNotifier);
        expect((panel.widgetLayoutStore as unknown as { other: string }).other).toBe("wl");
        expect(panel.rightPanelStore.setCard).toBe(sdk.rightPanelStore.setCard);
        // The real stores are untouched.
        expect(sdk.widgetLayoutStore.hasMaximisedWidget(room)).toBe(false);
        expect(sdk.rightPanelStore.roomPhaseHistory).toHaveLength(2);
    });
});

describe("ThreadPanelOverlay", () => {
    let finish: ReturnType<typeof vi.fn<() => void>>;
    let sdk: ReturnType<typeof makeSdk>;
    const request = (): ThreadPanelRequest => ({ key: "$root#1", room, mxEvent: root, finish });
    const mount = (req = request()) =>
        render(
            <SDKContext.Provider value={sdk}>
                <ThreadPanelOverlay request={req} />
            </SDKContext.Provider>,
        );

    beforeEach(() => {
        h.props.length = 0;
        h.seen.length = 0;
        h.mounts = 0;
        finish = vi.fn<() => void>();
        sdk = makeSdk();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("mounts Element's ThreadView on the root only (F1), with the room's context and the panel's SDK context", () => {
        mount();
        expect(h.props[0]).toMatchObject({ room, mxEvent: root, resizeNotifier: sdk.resizeNotifier });
        expect(h.props[0]).not.toHaveProperty("initialEvent");
        expect(h.seen[0]).toMatchObject({ maximised: true, history: [], roomId: "!a", canSend: true, canReact: true });
        expect(screen.getByTestId("client-view-thread-panel").className).toContain("mx_RightPanel");
    });

    it("F3: back writes no RightPanelStore, close goes only through finish", () => {
        mount();
        fireEvent.click(screen.getByText("back"));
        expect(sdk.rightPanelStore.popCard).not.toHaveBeenCalled();
        expect(sdk.rightPanelStore.setCard).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText("close"));
        expect(finish).toHaveBeenCalledTimes(1);
    });

    it("F2: Escape closes, a prevented Escape does not; the thread composer gets the focus action", () => {
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
        mount();
        act(() => void vi.advanceTimersByTime(2100));
        expect(dispatch).toHaveBeenCalledWith({
            action: Action.FocusSendMessageComposer,
            context: TimelineRenderingType.Thread,
        });
        expect(dispatch.mock.calls.filter(([p]) => (p as { action: string }).action === Action.ViewRoom)).toEqual([]);
        const input = screen.getByLabelText("thread composer");
        input.addEventListener("keydown", (e) => e.preventDefault());
        fireEvent.keyDown(input, { key: "Escape" });
        expect(finish).not.toHaveBeenCalled();
        const plain = screen.getByText("back");
        fireEvent.keyDown(plain, { key: "Escape" });
        expect(finish).toHaveBeenCalledTimes(1);
    });

    it("a replacement request with another key remounts ThreadView instead of changing its room prop (F3)", () => {
        const { rerender } = mount();
        const other = { ...request(), key: "$root#2" };
        rerender(
            <SDKContext.Provider value={sdk}>
                <ThreadPanelOverlay request={other} />
            </SDKContext.Provider>,
        );
        expect(h.mounts).toBe(2);
    });

    it("returns focus to the kit's frame on unmount", () => {
        const frame = document.createElement("iframe");
        frame.setAttribute("data-client-view", "x");
        document.body.appendChild(frame);
        const focus = vi.spyOn(frame, "focus");
        const { unmount } = mount();
        unmount();
        expect(focus).toHaveBeenCalled();
        frame.remove();
    });
});
