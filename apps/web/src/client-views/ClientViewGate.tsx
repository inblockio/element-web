/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { type MatrixCall } from "matrix-js-sdk/src/webrtc/call";

import SettingsStore from "../settings/SettingsStore";
import { SDKContext } from "../contexts/SDKContext";
import { LegacyCallHandlerEvent } from "../LegacyCallHandler";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { type ActionPayload } from "../dispatcher/payloads";
import { type ViewRoomPayload } from "../dispatcher/payloads/ViewRoomPayload";
import { UPDATE_EVENT } from "../stores/AsyncStore";
import ActiveWidgetStore, { ActiveWidgetStoreEvent } from "../stores/ActiveWidgetStore";
import { _t } from "../languageHandler";
import AccessibleButton from "../components/views/elements/AccessibleButton";
import ToastContainer from "../components/structures/ToastContainer";
import NonUrgentToastContainer from "../components/structures/NonUrgentToastContainer";
import { PipContainer } from "../components/structures/PipContainer";
import { MatrixClientContextProvider } from "../components/structures/MatrixClientContextProvider";
import AudioFeedArrayForLegacyCall from "../components/views/voip/AudioFeedArrayForLegacyCall";
import { getActiveClientView, isHandedOver, selectClientView, setHandedOver, watchHandOver } from "./registry";
import { ViewModelBridge } from "./ViewModelBridge";
import { HostReactionPicker } from "./ReactionPickerOverlay";
import { HostThreadPanel } from "./ThreadPanelOverlay";
import { BRIDGE_GLOBAL, type ClientViewDescriptor, STOCK_VIEW } from "./types";

type BridgeHolder = { [BRIDGE_GLOBAL]?: ViewModelBridge };

/** A kit that has not read the bridge this long after its frame loaded is taken as failed to start. */
export const BOOT_TIMEOUT_MS = 15000;

/** `?client_view=stock` in the page URL selects Element's own UI, a way back that needs no working kit. */
const ESCAPE_PARAM = "client_view";

/** Host room views whose UI lives in Element's tree: an answered or placed legacy call, a clicked notification. */
const HAND_OVER_TRIGGERS = new Set<ViewRoomPayload["metricsTrigger"]>(["WebAcceptCall", "WebDialPad", "Notification"]);

/**
 * Whether a dispatched action needs Element's own UI for its room: the call views and the call lobby live in
 * RoomView, which a kit replaces. A start-up room view (last room, URL) does not hand over.
 */
export function needsStockUi(payload: ActionPayload): boolean {
    if (payload.action !== Action.ViewRoom) return false;
    const { view_call: viewCall, metricsTrigger } = payload as ViewRoomPayload;
    return !!viewCall || HAND_OVER_TRIGGERS.has(metricsTrigger);
}

/** The calls whose remote audio LoggedInView plays; a kit replaces that tree, so the host plays them here. */
function useActiveLegacyCalls(): MatrixCall[] {
    const { legacyCallHandler } = useContext(SDKContext);
    const [calls, setCalls] = useState(() => legacyCallHandler.getAllActiveCalls());
    useEffect(() => {
        const update = (): void => setCalls(legacyCallHandler.getAllActiveCalls());
        legacyCallHandler.addListener(LegacyCallHandlerEvent.CallState, update);
        return () => void legacyCallHandler.removeListener(LegacyCallHandlerEvent.CallState, update);
    }, [legacyCallHandler]);
    return calls;
}

/** The room RoomViewStore shows, where Element draws a legacy call in RoomView instead of picture-in-picture. */
function useViewedRoomId(): string | null {
    const { roomViewStore } = useContext(SDKContext);
    const [roomId, setRoomId] = useState(() => roomViewStore.getRoomId());
    useEffect(() => {
        const update = (): void => setRoomId(roomViewStore.getRoomId());
        roomViewStore.on(UPDATE_EVENT, update);
        return () => void roomViewStore.off(UPDATE_EVENT, update);
    }, [roomViewStore]);
    return roomId;
}

/**
 * Whether a call widget (Element Call, Jitsi) is live. A PipContainer mounted while one is live starts with the widget
 * hidden (it shows it only on a later persistence or dock change), so the host's overlay above a kit would lose it.
 */
function usePersistentWidgetLive(): boolean {
    const [live, setLive] = useState(() => !!ActiveWidgetStore.instance.getPersistentWidgetId());
    useEffect(() => {
        const update = (): void => setLive(!!ActiveWidgetStore.instance.getPersistentWidgetId());
        ActiveWidgetStore.instance.on(ActiveWidgetStoreEvent.Persistence, update);
        return () => void ActiveWidgetStore.instance.off(ActiveWidgetStoreEvent.Persistence, update);
    }, []);
    return live;
}

/** The host's own overlays (toasts, incoming calls, picture-in-picture, call audio), drawn above the kit. */
function HostOverlays({ client }: { client: MatrixClient }): JSX.Element {
    const calls = useActiveLegacyCalls();
    return (
        <MatrixClientContextProvider client={client}>
            <ToastContainer />
            <PipContainer />
            <NonUrgentToastContainer />
            {calls.map((call) => (
                <AudioFeedArrayForLegacyCall call={call} key={call.callId} />
            ))}
        </MatrixClientContextProvider>
    );
}

/** Shown when a kit did not start, so a broken kit never locks the user out of Element's UI. */
function BootFailed({ view }: { view: ClientViewDescriptor }): JSX.Element {
    return (
        <div
            role="alert"
            style={{
                position: "fixed",
                insetInline: 0,
                top: 0,
                display: "flex",
                gap: "16px",
                alignItems: "center",
                justifyContent: "center",
                padding: "12px",
                background: "var(--cpd-color-bg-canvas-default)",
                borderBottom: "1px solid var(--cpd-color-border-critical-subtle)",
            }}
        >
            <span>{_t("labs|client_views_failed", { name: view.name })}</span>
            <AccessibleButton kind="primary" onClick={() => void selectClientView(STOCK_VIEW)}>
                {_t("labs|client_views_back")}
            </AccessibleButton>
        </div>
    );
}

/**
 * Authenticated media: Element's service worker adds the access token to a media request after asking the requesting
 * client (here the kit's frame) for the user's ids over postMessage, and only Element's own window answers that. The
 * frame's question is handed, unchanged, to this window's handler, which replies straight to the worker.
 */
export function relayMediaAuth(frame: Window): void {
    frame.navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
        if (event.data?.type !== "userinfo") return;
        navigator.serviceWorker?.dispatchEvent(new MessageEvent("message", { data: event.data, source: event.source }));
    });
}

/**
 * Hosts one kit in a full-size same-origin iframe on the signed-in client. The bridge is set on the frame's
 * window before the kit document loads (same-origin navigation from the initial about:blank keeps that window)
 * and on this window as a fallback. Unmounting removes the frame, so the kit's document and styles go with it.
 */
function ClientViewHost({ client, view }: { client: MatrixClient; view: ClientViewDescriptor }): JSX.Element {
    const [bridge, setBridge] = useState<ViewModelBridge>();
    const [failed, setFailed] = useState(false);
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    useEffect(() => {
        const b = new ViewModelBridge(client);
        // The worker's question reaches only listeners present when the document's message queue opens
        // (DOMContentLoaded), so the relay goes on when the kit's scripts first read the bridge, on every load.
        b.onUse = () => {
            const frame = frameRef.current?.contentWindow;
            if (frame) relayMediaAuth(frame);
        };
        (window as BridgeHolder)[BRIDGE_GLOBAL] = b;
        setBridge(b);
        return () => {
            delete (window as BridgeHolder)[BRIDGE_GLOBAL];
            b.dispose();
        };
    }, [client]);
    const attach = useCallback(
        (frame: HTMLIFrameElement | null) => {
            frameRef.current = frame;
            if (frame?.contentWindow && bridge) (frame.contentWindow as BridgeHolder)[BRIDGE_GLOBAL] = bridge;
        },
        [bridge],
    );
    // Every load of the kit document (first boot, a reload inside the frame) gets its own boot deadline.
    const [loads, setLoads] = useState(0);
    const deadline = useRef<number | undefined>(undefined);
    const arm = useCallback(() => {
        window.clearTimeout(deadline.current);
        if (bridge) deadline.current = window.setTimeout(() => setFailed(!bridge.used), BOOT_TIMEOUT_MS);
    }, [bridge]);
    useEffect(() => {
        setFailed(false);
        if (!bridge || loads === 0) return;
        arm();
        return () => window.clearTimeout(deadline.current);
    }, [bridge, loads, arm]);
    const onLoad = useCallback(
        (e: React.SyntheticEvent<HTMLIFrameElement>) => {
            // A reload inside the frame must start the kit again: the bridge counts as unused from the old document's
            // unload, so the next load's deadline checks the new document, not the first boot. The old document's
            // deadline is replaced by a fresh one from the unload: it must not judge the new document before that one
            // loads, and a reload that never loads still gets the way back. A frame being removed (ref detached
            // first) needs none.
            e.currentTarget.contentWindow?.addEventListener(
                "pagehide",
                () => {
                    if (bridge) bridge.used = false;
                    if (frameRef.current) arm();
                    else window.clearTimeout(deadline.current);
                },
                { once: true },
            );
            setLoads((n) => n + 1);
        },
        [bridge, arm],
    );
    if (!bridge) return <div />;
    return (
        <>
            <iframe
                ref={attach}
                onLoad={onLoad}
                // The kit reads the bridge from its own window, so it stays same-origin, as modal widgets do. A window the kit
                // opens (the call app, lane CALL) escapes the sandbox: it is another site and must not inherit this one.
                // oxlint-disable-next-line react/iframe-missing-sandbox
                sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
                title={view.name}
                src={view.url}
                data-client-view={view.id}
                style={{ border: 0, position: "fixed", inset: 0, width: "100vw", height: "100vh" }}
            />
            <HostOverlays client={client} />
            <HostReactionPicker client={client} bridge={bridge} />
            <HostThreadPanel client={client} bridge={bridge} />
            {failed && <BootFailed view={view} />}
        </>
    );
}

/**
 * Renders the selected client view instead of its children (Element's UI) while one is selected. A host room view
 * that needs Element's UI (see needsStockUi) shows the children for that room until the next view switch, and so
 * does a live legacy call in the viewed room.
 */
export function ClientViewGate({ client, children }: { client: MatrixClient; children: ReactNode }): JSX.Element {
    const [view, setView] = useState(getActiveClientView);
    const [handedOver, setHandedOverState] = useState(isHandedOver);
    useEffect(() => {
        const unwatch = watchHandOver(() => setHandedOverState(isHandedOver()));
        return () => {
            unwatch();
            setHandedOver(false);
        };
    }, []);
    useEffect(() => {
        if (!view || handedOver) return;
        // RoomViewStore and MatrixChat handle the room view as usual; the gate only stops hiding their tree.
        const ref = defaultDispatcher.register((payload) => {
            if (needsStockUi(payload)) setHandedOver(true);
        });
        return () => defaultDispatcher.unregister(ref);
    }, [view, handedOver]);
    useEffect(() => {
        if (new URLSearchParams(window.location.search).get(ESCAPE_PARAM) === STOCK_VIEW) {
            void selectClientView(STOCK_VIEW);
        }
    }, []);
    useEffect(() => {
        const update = (): void => setView(getActiveClientView());
        const refs = [
            SettingsStore.watchSetting("feature_client_views", null, update),
            SettingsStore.watchSetting("clientView", null, update),
        ];
        return () => refs.forEach((r) => SettingsStore.unwatchSetting(r));
    }, []);
    // Picture-in-picture leaves out a live legacy call in the viewed room (its controls are in RoomView), so a kit
    // never covers it: Element's UI stays until the call ends or the user views another room. A live call widget
    // keeps Element's UI until it ends: a running call stays in the tree it started in, never moved under a kit (G1).
    const calls = useActiveLegacyCalls();
    const viewedRoomId = useViewedRoomId();
    const widgetLive = usePersistentWidgetLive();
    const callInView = calls.some((call) => call.roomId === viewedRoomId) || widgetLive;
    if (!view || handedOver || callInView) return <>{children}</>;
    return <ClientViewHost key={view.id} client={client} view={view} />;
}
