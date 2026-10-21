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
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";

import { SDKContext } from "../contexts/SDKContext";
import { type SDKContextClass } from "../contexts/SDKContextClass";
import ToastStore from "../stores/ToastStore";
import { UPDATE_EVENT } from "../stores/AsyncStore";
import { LegacyCallHandlerEvent } from "../LegacyCallHandler";
import ActiveWidgetStore, { ActiveWidgetStoreEvent } from "../stores/ActiveWidgetStore";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { type ViewRoomPayload } from "../dispatcher/payloads/ViewRoomPayload";
import { BOOT_TIMEOUT_MS, ClientViewGate, relayMediaAuth } from "./ClientViewGate";
import { getActiveClientView, selectClientView } from "./registry";

const h = vi.hoisted(() => ({
    used: false,
    handedOver: false,
    watchers: new Set<() => void>(),
    pickerListeners: new Set<(request: unknown) => void>(),
    aboveLeftOf: vi.fn((rect: unknown) => ({ placedAt: rect })),
}));

vi.mock("./registry", () => {
    const setHandedOver = (on: boolean): void => {
        h.handedOver = on;
        h.watchers.forEach((cb) => cb());
    };
    return {
        getActiveClientView: vi.fn(() => ({ id: "fixture", name: "Fixture", url: "/kits/fixture/index.html" })),
        selectClientView: vi.fn(async () => setHandedOver(false)),
        isHandedOver: () => h.handedOver,
        setHandedOver,
        watchHandOver: (cb: () => void) => {
            h.watchers.add(cb);
            return () => void h.watchers.delete(cb);
        },
    };
});
vi.mock("./ViewModelBridge", () => ({
    ViewModelBridge: class {
        public get used(): boolean {
            return h.used;
        }
        public set used(on: boolean) {
            h.used = on;
        }
        public dispose = vi.fn();
        public onReactionPicker = (cb: (request: unknown) => void): (() => void) => {
            h.pickerListeners.add(cb);
            return () => void h.pickerListeners.delete(cb);
        };
    },
}));
// The picker stack (menu, emoji grid) is Element's own; the stubs pin what the host hands it.
vi.mock("../components/structures/ContextMenu", () => ({
    default: ({ children, onFinished }: { children: React.ReactNode; onFinished: () => void }) => (
        <div data-testid="menu">
            <button onClick={onFinished}>dismiss</button>
            {children}
        </div>
    ),
    aboveLeftOf: (rect: unknown) => h.aboveLeftOf(rect),
}));
vi.mock("../components/views/emojipicker/ReactionPicker", async () => {
    const { default: RoomContext } = await import("../contexts/RoomContext");
    return {
        default: function PickerStub({
            mxEvent,
            onFinished,
        }: {
            mxEvent: { getId(): string };
            onFinished: () => void;
        }) {
            const { canReact, canSelfRedact } = React.useContext(RoomContext);
            return (
                <button onClick={onFinished}>
                    {`picker ${mxEvent.getId()} canReact=${canReact} canSelfRedact=${canSelfRedact}`}
                </button>
            );
        },
    };
});
// The overlays below need the whole call and widget stack; stubs pin only that the gate draws them.
vi.mock("../components/structures/PipContainer", () => ({ PipContainer: () => <div data-testid="pip" /> }));
vi.mock("../components/views/voip/AudioFeedArrayForLegacyCall", () => ({
    default: ({ call }: { call: { callId: string } }) => <div data-testid={`audio-${call.callId}`} />,
}));
vi.mock("../components/structures/MatrixClientContextProvider", () => ({
    MatrixClientContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("ClientViewGate", () => {
    const calls = Object.assign(new TypedEventEmitter<string, any>(), {
        getAllActiveCalls: vi.fn(() => [] as { callId: string; roomId?: string }[]),
    });
    const roomViewStore = Object.assign(new TypedEventEmitter<string, any>(), {
        getRoomId: vi.fn(() => null as string | null),
    });
    const sdk = { legacyCallHandler: calls, roomViewStore } as unknown as SDKContextClass;
    const client = {} as MatrixClient;

    const renderGate = () =>
        render(
            <SDKContext.Provider value={sdk}>
                <ClientViewGate client={client}>
                    <div>stock UI</div>
                </ClientViewGate>
            </SDKContext.Provider>,
        );
    const loadKit = () => fireEvent.load(screen.getByTitle("Fixture"));

    beforeEach(() => {
        vi.useFakeTimers();
        h.used = false;
        h.handedOver = false;
        calls.getAllActiveCalls.mockReturnValue([]);
        roomViewStore.getRoomId.mockReturnValue(null);
        vi.mocked(selectClientView).mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
        ToastStore.sharedInstance().reset();
    });

    it("draws the host's toasts, picture-in-picture and call audio above a kit", () => {
        renderGate();
        expect(screen.queryByText("stock UI")).toBeNull();
        expect(screen.getByTitle("Fixture")).toBeTruthy();
        expect(screen.getByTestId("pip")).toBeTruthy();

        act(() =>
            ToastStore.sharedInstance().addOrReplaceToast({
                key: "incoming-call",
                title: "Incoming call",
                component: () => <div>Bob is calling</div>,
                priority: 100,
            }),
        );
        expect(screen.getByText("Bob is calling")).toBeTruthy();

        calls.getAllActiveCalls.mockReturnValue([{ callId: "c1" }]);
        act(() => void calls.emit(LegacyCallHandlerEvent.CallState));
        expect(screen.getByTestId("audio-c1")).toBeTruthy();
    });

    it("draws Element's reaction picker above the kit from the bridge's request, at the kit's anchor", () => {
        renderGate();
        expect(screen.queryByTestId("menu")).toBeNull();
        const finish = vi.fn();
        const request = {
            room: {},
            mxEvent: { getId: () => "$1" },
            reactions: null,
            permissions: { canReact: true, canSelfRedact: false },
            anchor: { x: 10, y: 20, width: 30, height: 40 },
            finish,
        };
        act(() => h.pickerListeners.forEach((cb) => cb(request)));
        expect(screen.getByRole("button", { name: "picker $1 canReact=true canSelfRedact=false" })).toBeTruthy();
        expect(h.aboveLeftOf).toHaveBeenCalledWith({ left: 10, right: 40, top: 20, bottom: 60 });
        fireEvent.click(screen.getByRole("button", { name: "dismiss" }));
        expect(finish).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole("button", { name: /^picker/ }));
        expect(finish).toHaveBeenCalledTimes(2);
        act(() => h.pickerListeners.forEach((cb) => cb(null)));
        expect(screen.queryByTestId("menu")).toBeNull();
    });

    it("offers the way back to Element when a kit never reads the bridge", () => {
        renderGate();
        loadKit();
        act(() => void vi.advanceTimersByTime(BOOT_TIMEOUT_MS - 1));
        expect(screen.queryByText("Fixture did not start.")).toBeNull();
        act(() => void vi.advanceTimersByTime(1));
        expect(screen.getByText("Fixture did not start.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Back to Element" }));
        expect(selectClientView).toHaveBeenCalledWith("stock");
    });

    it("stays out of the way of a kit that started", () => {
        renderGate();
        h.used = true;
        loadKit();
        act(() => void vi.advanceTimersByTime(BOOT_TIMEOUT_MS));
        expect(screen.queryByText("Fixture did not start.")).toBeNull();
    });

    it("checks every reload of the kit, not only its first boot (G4)", () => {
        renderGate();
        h.used = true;
        loadKit();
        act(() => void vi.advanceTimersByTime(BOOT_TIMEOUT_MS));
        expect(screen.queryByText("Fixture did not start.")).toBeNull();

        // A reload inside the frame: the old document unloads, the new one never reads the bridge.
        const frame = screen.getByTitle("Fixture") as HTMLIFrameElement;
        act(() => void frame.contentWindow!.dispatchEvent(new Event("pagehide")));
        loadKit();
        act(() => void vi.advanceTimersByTime(BOOT_TIMEOUT_MS));
        expect(screen.getByText("Fixture did not start.")).toBeTruthy();
    });

    it("drops the old document's deadline when the frame reloads, so a slow reload is not taken as failed", () => {
        renderGate();
        h.used = true;
        loadKit();
        act(() => void vi.advanceTimersByTime(BOOT_TIMEOUT_MS - 5000));

        const frame = screen.getByTitle("Fixture") as HTMLIFrameElement;
        act(() => void frame.contentWindow!.dispatchEvent(new Event("pagehide")));
        act(() => void vi.advanceTimersByTime(5000));
        expect(screen.queryByText("Fixture did not start.")).toBeNull();

        loadKit();
        act(() => void vi.advanceTimersByTime(BOOT_TIMEOUT_MS));
        expect(screen.getByText("Fixture did not start.")).toBeTruthy();
    });

    it("offers the way back when a reload inside the frame never loads (grok re-review F1)", () => {
        renderGate();
        h.used = true;
        loadKit();
        const frame = screen.getByTitle("Fixture") as HTMLIFrameElement;
        act(() => void frame.contentWindow!.dispatchEvent(new Event("pagehide")));
        act(() => void vi.advanceTimersByTime(BOOT_TIMEOUT_MS));
        expect(screen.getByText("Fixture did not start.")).toBeTruthy();
    });

    it("keeps Element's UI while a call widget is live (G1)", () => {
        const persistent = vi.spyOn(ActiveWidgetStore.instance, "getPersistentWidgetId").mockReturnValue("ec");
        try {
            renderGate();
            expect(screen.getByText("stock UI")).toBeTruthy();
            expect(screen.queryByTitle("Fixture")).toBeNull();

            persistent.mockReturnValue(null);
            act(() => void ActiveWidgetStore.instance.emit(ActiveWidgetStoreEvent.Persistence));
            expect(screen.getByTitle("Fixture")).toBeTruthy();
        } finally {
            persistent.mockRestore();
        }
    });

    it("selects Element's UI when the page is opened with ?client_view=stock", () => {
        const url = window.location.href;
        window.history.replaceState(null, "", "/?client_view=stock");
        try {
            renderGate();
            expect(selectClientView).toHaveBeenCalledWith("stock");
        } finally {
            window.history.replaceState(null, "", url);
        }
    });

    it("renders the stock UI while no kit is selected", () => {
        vi.mocked(getActiveClientView).mockReturnValueOnce(undefined);
        renderGate();
        expect(screen.getByText("stock UI")).toBeTruthy();
        expect(screen.queryByTitle("Fixture")).toBeNull();
    });

    const viewRoom = (extra: Partial<ViewRoomPayload>) =>
        act(() =>
            defaultDispatcher.dispatch<ViewRoomPayload>(
                { action: Action.ViewRoom, room_id: "!r:x", metricsTrigger: undefined, ...extra },
                true,
            ),
        );

    it.each<[string, Partial<ViewRoomPayload>]>([
        ["an answered legacy call", { metricsTrigger: "WebAcceptCall" }],
        ["a joined Element Call", { view_call: true }],
        ["a clicked notification", { metricsTrigger: "Notification" }],
    ])("shows Element's UI for %s until the next switch, without changing the selected view", async (_, extra) => {
        renderGate();
        viewRoom(extra);
        expect(screen.getByText("stock UI")).toBeTruthy();
        expect(screen.queryByTitle("Fixture")).toBeNull();
        expect(selectClientView).not.toHaveBeenCalled();

        await act(() => selectClientView("fixture"));
        expect(screen.getByTitle("Fixture")).toBeTruthy();
        expect(screen.queryByText("stock UI")).toBeNull();
    });

    it("keeps the kit for a start-up room view (last room, URL)", () => {
        renderGate();
        viewRoom({});
        expect(screen.getByTitle("Fixture")).toBeTruthy();
        expect(screen.queryByText("stock UI")).toBeNull();
    });

    it("ends a hand-over when the gate unmounts", () => {
        const { unmount } = renderGate();
        viewRoom({ view_call: true });
        expect(h.handedOver).toBe(true);
        unmount();
        expect(h.handedOver).toBe(false);
    });

    it("keeps Element's UI while a live legacy call is in the viewed room (picture-in-picture leaves it out)", () => {
        renderGate();
        // A PiP double-click or a consultative transfer views the call's room without a hand-over trigger.
        calls.getAllActiveCalls.mockReturnValue([{ callId: "c1", roomId: "!call:x" }]);
        act(() => void calls.emit(LegacyCallHandlerEvent.CallState));
        expect(screen.getByTitle("Fixture")).toBeTruthy();
        roomViewStore.getRoomId.mockReturnValue("!call:x");
        act(() => void roomViewStore.emit(UPDATE_EVENT));
        expect(screen.getByText("stock UI")).toBeTruthy();
        expect(screen.queryByTitle("Fixture")).toBeNull();

        calls.getAllActiveCalls.mockReturnValue([]);
        act(() => void calls.emit(LegacyCallHandlerEvent.CallState));
        expect(screen.getByTitle("Fixture")).toBeTruthy();
    });
});

describe("relayMediaAuth", () => {
    afterEach(() => {
        delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    });

    it("hands the worker's userinfo question from the kit frame to this window's handler, nothing else", () => {
        const host = new EventTarget();
        Object.defineProperty(navigator, "serviceWorker", { value: host, configurable: true });
        const seen: unknown[] = [];
        host.addEventListener("message", (e) => seen.push((e as MessageEvent).data));
        const frameWorker = new EventTarget();
        relayMediaAuth({ navigator: { serviceWorker: frameWorker } } as unknown as Window);
        frameWorker.dispatchEvent(new MessageEvent("message", { data: { type: "userinfo", responseKey: 7 } }));
        frameWorker.dispatchEvent(new MessageEvent("message", { data: { type: "other" } }));
        expect(seen).toEqual([{ type: "userinfo", responseKey: 7 }]);
    });
});
