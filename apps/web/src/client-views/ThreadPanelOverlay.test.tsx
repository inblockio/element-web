/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import React from "react";
import ReactDOM from "react-dom";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "test-utils-rtl";
import { type MatrixClient, type MatrixEvent, type Room, RoomStateEvent } from "matrix-js-sdk/src/matrix";
import { EventEmitter } from "events";

import { SDKContext } from "../contexts/SDKContext";
import { type SDKContextClass } from "../contexts/SDKContextClass";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { TimelineRenderingType } from "../contexts/RoomContext";
import SettingsStore from "../settings/SettingsStore";
import { _t } from "../languageHandler";
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
        showUrlPreview?: boolean;
        isRoomEncrypted?: boolean | null;
        tombstone?: unknown;
    }>,
    mounts: 0,
}));

const viewRoom = (): void => defaultDispatcher.dispatch({ action: Action.ViewRoom, room_id: "!a" });

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
                showUrlPreview: room.showUrlPreview,
                isRoomEncrypted: room.isRoomEncrypted,
                tombstone: room.tombstone,
            });
            return (
                <div>
                    <button onClick={() => sdk.rightPanelStore.popCard()}>back</button>
                    <button onClick={props.onClose as () => void}>close</button>
                    <input aria-label="thread composer" />
                    <a href="https://matrix.to/#/!a:example.org/$root:example.org" onClick={viewRoom}>
                        timestamp
                    </a>
                    <a
                        href="https://matrix.to/#/!new:example.org"
                        className="mx_MessageComposer_roomReplaced_link"
                        onClick={viewRoom}
                    >
                        upgraded
                    </a>
                    <a href="https://example.org/page" onClick={() => void h.mounts}>
                        plain link
                    </a>
                    {ReactDOM.createPortal(
                        <div className="mx_MessageContextMenu">
                            <div role="menuitem" onClick={viewRoom}>
                                {_t("timeline|mab|view_in_room")}
                            </div>
                            <div role="menuitem" onClick={() => defaultDispatcher.dispatch({ action: "other_item" })}>
                                Copy link
                            </div>
                        </div>,
                        document.body,
                    )}
                </div>
            );
        },
    };
});

const makeSdk = () => {
    const widgetLayoutStore = { hasMaximisedWidget: vi.fn(() => false), other: "wl" };
    const rightPanelStore = { roomPhaseHistory: [{}, {}], popCard: vi.fn(), setCard: vi.fn(), other: "rp" };
    const client = Object.assign(new EventEmitter(), {
        getSafeUserId: () => "@me:example.org",
        getCrypto: (): unknown => undefined,
    }) as unknown as MatrixClient;
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

const roomState = {
    canSend: true,
    maySendEvent: vi.fn((): boolean => true),
    events: {} as Record<string, unknown>,
};
const room = {
    roomId: "!a",
    maySendMessage: () => roomState.canSend,
    getMyMembership: () => "join",
    getLiveTimeline: () => ({}),
    currentState: {
        maySendEvent: (...a: unknown[]) => (roomState.maySendEvent as (...x: unknown[]) => boolean)(...a),
        getStateEvents: (type: string) => roomState.events[type],
    },
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
        roomState.canSend = true;
        roomState.events = {};
        roomState.maySendEvent.mockImplementation(() => true);
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

    it("a ViewRoom dispatched while the panel is open closes it, whoever dispatches it; none after close", () => {
        const { unmount } = mount();
        act(() => {
            viewRoom();
            vi.runAllTimers();
        });
        expect(finish).toHaveBeenCalledTimes(1);
        // Links and menu items are not blocked: their ViewRoom is what closes the panel.
        fireEvent.click(screen.getByText("timestamp"));
        fireEvent.click(screen.getByText("upgraded"));
        fireEvent.click(screen.getByText(_t("timeline|mab|view_in_room")));
        act(() => void vi.runAllTimers());
        expect(finish).toHaveBeenCalledTimes(4);
        unmount();
        act(() => {
            viewRoom();
            vi.runAllTimers();
        });
        expect(finish).toHaveBeenCalledTimes(4);
    });

    it("a non-ViewRoom action does not close; Share / Copy link and a plain link are not prevented", () => {
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
        mount();
        const copy = new MouseEvent("click", { bubbles: true, cancelable: true });
        screen.getByText("Copy link").dispatchEvent(copy);
        expect(copy.defaultPrevented).toBe(false);
        expect(dispatch).toHaveBeenCalledWith({ action: "other_item" });
        const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
        screen.getByText("plain link").dispatchEvent(plain);
        expect(plain.defaultPrevented).toBe(false);
        const nav = new MouseEvent("click", { bubbles: true, cancelable: true });
        screen.getByText("timestamp").dispatchEvent(nav);
        expect(nav.defaultPrevented).toBe(false);
        act(() => void vi.runAllTimers());
        expect(finish).toHaveBeenCalledTimes(1); // only the timestamp's ViewRoom
    });

    describe("F1: encryption known before ThreadView and before any URL preview", () => {
        let resolveCrypto: (v: boolean) => void;
        beforeEach(() => {
            vi.spyOn(SettingsStore, "getValue").mockImplementation(((name: string) =>
                name === "urlPreviewsEnabled" ? true : false) as never);
            (sdk.client as unknown as { getCrypto: () => unknown }).getCrypto = () => ({
                isEncryptionEnabledInRoom: () => new Promise<boolean>((r) => (resolveCrypto = r)),
            });
        });

        it("renders no ThreadView while the answer is pending, then uses the e2ee preview setting", async () => {
            mount();
            expect(h.props).toHaveLength(0);
            expect(screen.queryByLabelText("thread composer")).toBeNull();
            await act(async () => resolveCrypto(true));
            expect(h.seen[0]).toMatchObject({ isRoomEncrypted: true, showUrlPreview: false });
            expect(h.props.length).toBeGreaterThan(0);
        });

        it("an unencrypted answer takes the plain preview setting", async () => {
            mount();
            await act(async () => resolveCrypto(false));
            expect(h.seen[0]).toMatchObject({ isRoomEncrypted: false, showUrlPreview: true });
        });

        it("a failed crypto answer falls back to the room's encryption state (still encrypted: no preview)", async () => {
            (sdk.client as unknown as { getCrypto: () => unknown }).getCrypto = () => ({
                isEncryptionEnabledInRoom: () => Promise.reject(new Error("boom")),
            });
            roomState.events["m.room.encryption"] = { enc: true };
            mount();
            await act(async () => {});
            expect(h.seen[0]).toMatchObject({ isRoomEncrypted: true, showUrlPreview: false });
        });

        it("without crypto, the m.room.encryption state decides", () => {
            (sdk.client as unknown as { getCrypto: () => unknown }).getCrypto = () => undefined;
            roomState.events["m.room.encryption"] = { enc: true };
            mount();
            expect(h.seen[0]).toMatchObject({ isRoomEncrypted: true, showUrlPreview: false });
        });
    });

    const emitter = (): EventEmitter => sdk.client as unknown as EventEmitter;

    it("F3: a state event of the room recomputes canSendMessages, canReact and the tombstone; another room's does not", () => {
        mount();
        expect(h.seen.at(-1)).toMatchObject({ canSend: true, canReact: true, tombstone: undefined });
        roomState.canSend = false;
        roomState.maySendEvent.mockImplementation(() => false);
        roomState.events["m.room.tombstone"] = { tomb: true };
        const before = h.seen.length;
        act(() => void emitter().emit(RoomStateEvent.Events, {}, { roomId: "!other" }));
        expect(h.seen.length).toBe(before);
        act(() => void emitter().emit(RoomStateEvent.Events, {}, { roomId: "!a" }));
        expect(h.seen.at(-1)).toMatchObject({ canSend: false, canReact: false, tombstone: { tomb: true } });
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
