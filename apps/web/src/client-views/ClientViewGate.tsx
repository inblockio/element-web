/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { type MatrixCall } from "matrix-js-sdk/src/webrtc/call";

import SettingsStore from "../settings/SettingsStore";
import { SDKContext } from "../contexts/SDKContext";
import { LegacyCallHandlerEvent } from "../LegacyCallHandler";
import { _t } from "../languageHandler";
import AccessibleButton from "../components/views/elements/AccessibleButton";
import ToastContainer from "../components/structures/ToastContainer";
import NonUrgentToastContainer from "../components/structures/NonUrgentToastContainer";
import { PipContainer } from "../components/structures/PipContainer";
import { MatrixClientContextProvider } from "../components/structures/MatrixClientContextProvider";
import AudioFeedArrayForLegacyCall from "../components/views/voip/AudioFeedArrayForLegacyCall";
import { getActiveClientView, selectClientView } from "./registry";
import { ViewModelBridge } from "./ViewModelBridge";
import { BRIDGE_GLOBAL, type ClientViewDescriptor, STOCK_VIEW } from "./types";

type BridgeHolder = { [BRIDGE_GLOBAL]?: ViewModelBridge };

/** A kit that has not read the bridge this long after its frame loaded is taken as failed to start. */
export const BOOT_TIMEOUT_MS = 15000;

/** `?client_view=stock` in the page URL selects Element's own UI, a way back that needs no working kit. */
const ESCAPE_PARAM = "client_view";

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
 * Hosts one kit in a full-size same-origin iframe on the signed-in client. The bridge is set on the frame's
 * window before the kit document loads (same-origin navigation from the initial about:blank keeps that window)
 * and on this window as a fallback. Unmounting removes the frame, so the kit's document and styles go with it.
 */
function ClientViewHost({ client, view }: { client: MatrixClient; view: ClientViewDescriptor }): JSX.Element {
    const [bridge, setBridge] = useState<ViewModelBridge>();
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        const b = new ViewModelBridge(client);
        (window as BridgeHolder)[BRIDGE_GLOBAL] = b;
        setBridge(b);
        return () => {
            delete (window as BridgeHolder)[BRIDGE_GLOBAL];
            b.dispose();
        };
    }, [client]);
    const attach = useCallback(
        (frame: HTMLIFrameElement | null) => {
            if (frame?.contentWindow && bridge) (frame.contentWindow as BridgeHolder)[BRIDGE_GLOBAL] = bridge;
        },
        [bridge],
    );
    // Every load of the kit document (first boot, a reload inside the frame) gets its own boot deadline.
    const [loads, setLoads] = useState(0);
    useEffect(() => {
        setFailed(false);
        if (!bridge || loads === 0) return;
        const timer = window.setTimeout(() => setFailed(!bridge.used), BOOT_TIMEOUT_MS);
        return () => window.clearTimeout(timer);
    }, [bridge, loads]);
    const onLoad = useCallback(() => setLoads((n) => n + 1), []);
    if (!bridge) return <div />;
    return (
        <>
            <iframe
                ref={attach}
                onLoad={onLoad}
                // The kit reads the bridge from its own window, so it stays same-origin, as modal widgets do.
                // oxlint-disable-next-line react/iframe-missing-sandbox
                sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-downloads"
                title={view.name}
                src={view.url}
                data-client-view={view.id}
                style={{ border: 0, position: "fixed", inset: 0, width: "100vw", height: "100vh" }}
            />
            <HostOverlays client={client} />
            {failed && <BootFailed view={view} />}
        </>
    );
}

/** Renders the selected client view instead of its children (Element's UI) while one is selected. */
export function ClientViewGate({ client, children }: { client: MatrixClient; children: ReactNode }): JSX.Element {
    const [view, setView] = useState(getActiveClientView);
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
    if (!view) return <>{children}</>;
    return <ClientViewHost key={view.id} client={client} view={view} />;
}
