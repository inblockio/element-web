/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, type ReactNode, useCallback, useEffect, useState } from "react";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import SettingsStore from "../settings/SettingsStore";
import { getActiveClientView } from "./registry";
import { ViewModelBridge } from "./ViewModelBridge";
import { BRIDGE_GLOBAL, type ClientViewDescriptor } from "./types";

type BridgeHolder = { [BRIDGE_GLOBAL]?: ViewModelBridge };

/**
 * Hosts one kit in a full-size same-origin iframe on the signed-in client. The bridge is set on the frame's
 * window before the kit document loads (same-origin navigation from the initial about:blank keeps that window)
 * and on this window as a fallback. Unmounting removes the frame, so the kit's document and styles go with it.
 */
function ClientViewHost({ client, view }: { client: MatrixClient; view: ClientViewDescriptor }): JSX.Element {
    const [bridge, setBridge] = useState<ViewModelBridge>();
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
    if (!bridge) return <div />;
    return (
        <iframe
            ref={attach}
            // The kit reads the bridge from its own window, so it stays same-origin, as modal widgets do.
            // oxlint-disable-next-line react/iframe-missing-sandbox
            sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-downloads"
            title={view.name}
            src={view.url}
            data-client-view={view.id}
            style={{ border: 0, position: "fixed", inset: 0, width: "100vw", height: "100vh" }}
        />
    );
}

/** Renders the selected client view instead of its children (Element's UI) while one is selected. */
export function ClientViewGate({ client, children }: { client: MatrixClient; children: ReactNode }): JSX.Element {
    const [view, setView] = useState(getActiveClientView);
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
