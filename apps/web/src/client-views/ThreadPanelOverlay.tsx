/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { EventType, KnownMembership, RoomEvent, RoomStateEvent } from "matrix-js-sdk/src/matrix";
import { type MatrixClient, type MatrixEvent, type RoomState } from "matrix-js-sdk/src/matrix";
import React, { type JSX, useCallback, useContext, useEffect, useMemo, useState } from "react";

import ThreadView from "../components/structures/ThreadView";
import RoomContext, { type RoomContextType, TimelineRenderingType } from "../contexts/RoomContext";
import { MatrixClientContextProvider } from "../components/structures/MatrixClientContextProvider";
import { SDKContext } from "../contexts/SDKContext";
import { type SDKContextClass } from "../contexts/SDKContextClass";
import { isRoomEncrypted } from "../hooks/useIsEncrypted";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import SettingsStore from "../settings/SettingsStore";
import { _t } from "../languageHandler";
import { parsePermalink } from "../utils/permalinks/Permalinks";
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

/**
 * Capture-phase click guard for the panel wrapper (frozen notes F2/F4). Three controls inside ThreadView dispatch
 * `Action.ViewRoom`, which would switch Element's room (or join a replacement room) under the kit; none has a switch to
 * turn it off, so the click is stopped before it reaches them. React's synthetic events travel through portals, so the
 * root's context menu (rendered in a portal) is covered by the same guard.
 *  - a link to a room or an event (the timestamp permalink; the composer's "room upgraded" link),
 *  - the "View in room" item of the message context menu.
 */
export function blocksViewRoom(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    const link = target.closest("a[href]");
    if (link) {
        if (link.classList.contains("mx_MessageComposer_roomReplaced_link")) return true;
        const parts = parsePermalink(link.getAttribute("href") ?? "");
        if (parts && (parts.roomIdOrAlias || parts.eventId)) return true;
    }
    const item = target.closest(".mx_MessageContextMenu [role^='menuitem']");
    return !!item && item.textContent?.trim() === _t("timeline|mab|view_in_room");
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

    // Room state the context reads (frozen note F3): recomputed on the same events RoomView listens to, so the composer,
    // the tombstone notice and the redact/react rights follow the room while the panel is open.
    const [stateTick, setStateTick] = useState(0);
    useEffect(() => {
        const onState = (_ev: MatrixEvent, state: RoomState): void => {
            if (state.roomId === room.roomId) setStateTick((n) => n + 1);
        };
        const onMembership = (r: { roomId: string }): void => {
            if (r.roomId === room.roomId) setStateTick((n) => n + 1);
        };
        client.on(RoomStateEvent.Events, onState);
        client.on(RoomEvent.MyMembership, onMembership);
        return () => {
            client.off(RoomStateEvent.Events, onState);
            client.off(RoomEvent.MyMembership, onMembership);
        };
    }, [client, room]);

    // Encryption is unknown until answered (F1): ThreadView is not rendered before, so no URL preview is fetched for a
    // room that may be encrypted. No crypto (or a failed answer) falls back to the room's m.room.encryption state.
    const [encrypted, setEncrypted] = useState<boolean | null>(null);
    useEffect(() => {
        const fromState = (): boolean => !!room.currentState.getStateEvents(EventType.RoomEncryption, "");
        const crypto = client.getCrypto();
        if (!crypto) {
            setEncrypted(fromState());
            return;
        }
        let live = true;
        isRoomEncrypted(room, crypto).then(
            (value) => {
                if (live) setEncrypted(value);
            },
            () => {
                if (live) setEncrypted(fromState());
            },
        );
        return () => {
            live = false;
        };
    }, [client, room, stateTick]);

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
            showUrlPreview:
                encrypted === null
                    ? false
                    : SettingsStore.getValue(encrypted ? "urlPreviewsEnabled_e2ee" : "urlPreviewsEnabled"),
            isRoomEncrypted: encrypted,
            tombstone: room.currentState.getStateEvents(EventType.RoomTombstone, "") ?? undefined,
            timelineRenderingType: TimelineRenderingType.Room,
        };
        // stateTick: the room object is the same across state events, so it is a dependency of its own.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inherited, client, room, sdk, encrypted, stateTick]);

    const guardClick = useCallback((ev: React.SyntheticEvent): void => {
        if (blocksViewRoom(ev.target)) {
            ev.preventDefault();
            ev.stopPropagation();
        }
    }, []);

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
                    onClickCapture={guardClick}
                    onAuxClickCapture={guardClick}
                    onKeyDown={(ev) => {
                        if (ev.key === "Escape" && !ev.defaultPrevented) {
                            ev.stopPropagation();
                            finish();
                        }
                    }}
                >
                    {encrypted !== null && (
                        <ThreadView
                            key={request.key}
                            room={room}
                            mxEvent={mxEvent}
                            resizeNotifier={sdk.resizeNotifier}
                            permalinkCreator={request.permalinkCreator}
                            onClose={finish}
                        />
                    )}
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
