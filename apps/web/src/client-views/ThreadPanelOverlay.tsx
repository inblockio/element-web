/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { EventType, KnownMembership } from "matrix-js-sdk/src/matrix";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import React, { type JSX, useContext, useEffect, useMemo, useState } from "react";

import ThreadView from "../components/structures/ThreadView";
import RoomContext, { type RoomContextType, TimelineRenderingType } from "../contexts/RoomContext";
import { MatrixClientContextProvider } from "../components/structures/MatrixClientContextProvider";
import { SDKContext } from "../contexts/SDKContext";
import { type SDKContextClass } from "../contexts/SDKContextClass";
import { isRoomEncrypted } from "../hooks/useIsEncrypted";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import SettingsStore from "../settings/SettingsStore";
import { type ThreadPanelRequest, type ViewModelBridge } from "./ViewModelBridge";

/**
 * The SDK context the panel's subtree sees: the stock one, with two answers changed so ThreadView's two exits to the
 * stock UI are not offered (frozen notes F1, F3). Everything else is read through from the real context (a Proxy, not a
 * copy: its stores are lazy getters, a copy would build a second set).
 *  - `widgetLayoutStore.hasMaximisedWidget` -> true: ThreadListContextMenu hides "View in room" (it dispatches
 *    `Action.ViewRoom`, which would switch Element's room under the kit). It is the only reader in ThreadView's subtree
 *    (RoomView and LegacyCallHandler read it outside it).
 *  - `rightPanelStore.roomPhaseHistory` -> [] and `popCard` -> no-op: BaseCard offers no back button (it pops the stock
 *    right-panel history, a store the kit never set) and nothing can write the store from the panel.
 */
export function panelSdkContext(real: SDKContextClass): SDKContextClass {
    const widgetLayoutStore = new Proxy(real.widgetLayoutStore, {
        get(target, prop) {
            if (prop === "hasMaximisedWidget") return () => true;
            return Reflect.get(target, prop, target);
        },
    });
    const rightPanelStore = new Proxy(real.rightPanelStore, {
        get(target, prop) {
            if (prop === "roomPhaseHistory") return [];
            if (prop === "popCard") return () => {};
            return Reflect.get(target, prop, target);
        },
    });
    return new Proxy(real, {
        get(target, prop) {
            if (prop === "widgetLayoutStore") return widgetLayoutStore;
            if (prop === "rightPanelStore") return rightPanelStore;
            return Reflect.get(target, prop, target);
        },
    });
}

const focusKit = (): void => {
    document.querySelector<HTMLElement>("iframe[data-client-view]")?.focus();
};

/**
 * Element's own thread panel over a kit (D37): ThreadView, mounted in the host's tree at the right edge, with the room
 * context RoomView would give it. Reads every value from the SDK room or Element's settings at open (no own data layer).
 */
export function ThreadPanelOverlay({ request }: { request: ThreadPanelRequest }): JSX.Element {
    const inherited = useContext(RoomContext);
    const sdk = useContext(SDKContext);
    const { room, mxEvent, finish } = request;
    const client = sdk.client!;
    const panelSdk = useMemo(() => panelSdkContext(sdk), [sdk]);

    const [encrypted, setEncrypted] = useState<boolean | null>(null);
    useEffect(() => {
        const crypto = client.getCrypto();
        if (!crypto) return;
        let live = true;
        void isRoomEncrypted(room, crypto).then((value) => {
            if (live) setEncrypted(value);
        });
        return () => {
            live = false;
        };
    }, [client, room]);

    const context = useMemo<RoomContextType>(() => {
        const me = client.getSafeUserId();
        return {
            ...inherited,
            room,
            roomId: room.roomId,
            roomViewStore: sdk.roomViewStore,
            liveTimeline: room.getLiveTimeline(),
            canSendMessages: room.maySendMessage(),
            canReact:
                room.getMyMembership() === KnownMembership.Join &&
                room.currentState.maySendEvent(EventType.Reaction, me),
            canSelfRedact: room.currentState.maySendEvent(EventType.RoomRedaction, me),
            showReadReceipts: SettingsStore.getValue("showReadReceipts", room.roomId),
            showUrlPreview: SettingsStore.getValue(encrypted ? "urlPreviewsEnabled_e2ee" : "urlPreviewsEnabled"),
            isRoomEncrypted: encrypted,
            tombstone: room.currentState.getStateEvents(EventType.RoomTombstone, "") ?? undefined,
            timelineRenderingType: TimelineRenderingType.Room,
        };
    }, [inherited, client, room, sdk, encrypted]);

    // F2: nothing in ThreadView focuses its composer or closes on Escape, so the panel does both: focus leaves the kit's
    // frame for the thread composer once it is there, and returns to the frame when the panel closes.
    useEffect(() => {
        let tries = 0;
        const timer = window.setInterval(() => {
            const composer = document.querySelector(".mx_ThreadView .mx_BasicMessageComposer_input");
            if (composer || ++tries > 40) {
                window.clearInterval(timer);
                defaultDispatcher.dispatch({
                    action: Action.FocusSendMessageComposer,
                    context: TimelineRenderingType.Thread,
                });
            }
        }, 50);
        return () => {
            window.clearInterval(timer);
            focusKit();
        };
    }, []);

    return (
        <SDKContext.Provider value={panelSdk}>
            <RoomContext.Provider value={context}>
                <div
                    className="mx_RightPanel"
                    data-testid="client-view-thread-panel"
                    style={{
                        position: "fixed",
                        top: 0,
                        right: 0,
                        bottom: 0,
                        width: "min(480px, 100vw)",
                        zIndex: 5000,
                        display: "flex",
                        flexDirection: "column",
                        background: "var(--cpd-color-bg-canvas-default)",
                        boxShadow: "0 0 12px rgba(0, 0, 0, 0.3)",
                    }}
                    onKeyDown={(ev) => {
                        if (ev.key === "Escape" && !ev.defaultPrevented) {
                            ev.stopPropagation();
                            finish();
                        }
                    }}
                >
                    <ThreadView
                        key={request.key}
                        room={room}
                        mxEvent={mxEvent}
                        resizeNotifier={sdk.resizeNotifier}
                        permalinkCreator={request.permalinkCreator}
                        onClose={finish}
                    />
                </div>
            </RoomContext.Provider>
        </SDKContext.Provider>
    );
}

/** The thread panel the kit asked for, if any: follows the bridge until it closes. */
export function HostThreadPanel({
    client,
    bridge,
}: {
    client: MatrixClient;
    bridge: ViewModelBridge;
}): JSX.Element | null {
    const [request, setRequest] = useState<ThreadPanelRequest | null>(null);
    useEffect(() => bridge.onThreadPanel(setRequest), [bridge]);
    return request ? (
        <MatrixClientContextProvider client={client}>
            <ThreadPanelOverlay key={request.key} request={request} />
        </MatrixClientContextProvider>
    ) : null;
}
