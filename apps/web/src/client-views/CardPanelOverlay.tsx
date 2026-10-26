/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { RoomMember, THREAD_RELATION_TYPE, type MatrixClient, type MatrixEvent } from "matrix-js-sdk/src/matrix";
import React, { type JSX, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import RoomContext from "../contexts/RoomContext";
import { MatrixClientContextProvider } from "../components/structures/MatrixClientContextProvider";
import { SDKContext } from "../contexts/SDKContext";
import Modal from "../Modal";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { type ActionPayload } from "../dispatcher/payloads";
import { type ViewRoomPayload } from "../dispatcher/payloads/ViewRoomPayload";
import { type ShowThreadPayload } from "../dispatcher/payloads/ShowThreadPayload";
import { RightPanelPhases } from "../stores/right-panel/RightPanelStorePhases";
import { type IRightPanelCard } from "../stores/right-panel/RightPanelStoreIPanelState";
import RoomSummaryCardView from "../components/views/right_panel/RoomSummaryCardView";
import UserInfo from "../components/views/right_panel/UserInfo";
import ThirdPartyMemberInfo from "../components/views/rooms/ThirdPartyMemberInfo";
import MemberListView from "../components/views/rooms/MemberList/MemberListView";
import FilePanel from "../components/structures/FilePanel";
import { PinnedMessagesCard } from "../components/views/right_panel/PinnedMessagesCard";
import { SearchCard } from "./SearchCard";
import { fetchInitialEvent } from "../utils/EventUtils";
import { markHostPanelSlotMounted } from "./hostPanelSlot";
import { panelSdkContext, ThreadPanelOverlay, usePanelRoomContext } from "./ThreadPanelOverlay";
import { type CardPanelRequest, type ThreadPanelRequest, type ViewModelBridge } from "./ViewModelBridge";

/** The search card has no stock right-panel phase: a host-only one, stack-internal (never written to the store). */
export const SEARCH_PHASE = "HostSearch" as RightPanelPhases;

/** The phases the slot shows (frozen note F6): a push of any other phase (Threads, Extensions, widgets ...) is ignored. */
const SHOWN = new Set<RightPanelPhases | null>([
    RightPanelPhases.RoomSummary,
    RightPanelPhases.MemberList,
    RightPanelPhases.MemberInfo,
    RightPanelPhases.EncryptionPanel,
    RightPanelPhases.ThreePidMemberInfo,
    RightPanelPhases.PinnedMessages,
    RightPanelPhases.FilePanel,
    SEARCH_PHASE,
]);

/** The first card of a request: the in-panel stack starts with it (a DM's info card is the other member's user info). */
export function rootCard(request: Pick<CardPanelRequest, "card" | "dmMember">): IRightPanelCard {
    switch (request.card) {
        case "members":
            return { phase: RightPanelPhases.MemberList, state: {} };
        case "files":
            return { phase: RightPanelPhases.FilePanel, state: {} };
        case "pinned":
            return { phase: RightPanelPhases.PinnedMessages, state: {} };
        case "search":
            return { phase: SEARCH_PHASE, state: { searchTerm: "" } as IRightPanelCard["state"] };
        default:
            return request.dmMember
                ? { phase: RightPanelPhases.MemberInfo, state: { member: request.dmMember } }
                : { phase: RightPanelPhases.RoomSummary, state: {} };
    }
}

export interface CardStackOps {
    stack: () => IRightPanelCard[];
    set: (next: IRightPanelCard[]) => void;
    finish: () => void;
}

/**
 * The right-panel store answers the card panel's subtree sees (decision 1): its in-panel stack stands in for the store's
 * history, and every write into the store (push, set, toggle ...) lands in the stack instead. Cards of phases the slot does
 * not show are ignored (F6). Nothing here touches the real store.
 */
export function cardStoreOverrides(stack: IRightPanelCard[], ops: CardStackOps): Record<string, unknown> {
    const top = (): IRightPanelCard => stack[stack.length - 1] ?? { phase: null, state: {} };
    const setCard = (card: IRightPanelCard): void => {
        if (!SHOWN.has(card.phase)) return;
        const cur = ops.stack();
        const hasState = Object.keys(card.state ?? {}).length > 0;
        const last = cur[cur.length - 1];
        if (last && last.phase === card.phase && hasState) {
            ops.set([...cur.slice(0, -1), { phase: card.phase, state: card.state }]);
        } else {
            ops.set([{ phase: card.phase, state: card.state ?? {} }]);
        }
    };
    return {
        roomPhaseHistory: stack,
        currentCard: top(),
        previousCard: stack.length >= 2 ? stack[stack.length - 2] : { phase: null, state: {} },
        currentCardForRoom: () => top(),
        isOpen: true,
        isOpenForRoom: () => true,
        popCard: () => {
            const cur = ops.stack();
            if (cur.length <= 1) {
                ops.finish();
                return undefined;
            }
            ops.set(cur.slice(0, -1));
            return cur[cur.length - 1];
        },
        pushCard: (card: IRightPanelCard) => {
            if (!SHOWN.has(card.phase)) return;
            ops.set([...ops.stack(), { phase: card.phase, state: card.state ?? {} }]);
        },
        setCard,
        setCards: (cards: IRightPanelCard[]) => {
            const shown = cards
                .filter((c) => SHOWN.has(c.phase))
                .map((c) => ({ phase: c.phase, state: c.state ?? {} }));
            if (shown.length) ops.set(shown);
        },
        showOrHidePhase: (phase: RightPanelPhases, state?: IRightPanelCard["state"]) => {
            if (!SHOWN.has(phase)) return;
            if (ops.stack()[ops.stack().length - 1]?.phase === phase && !state) ops.finish();
            else setCard({ phase, state });
        },
        togglePanel: () => {},
        show: () => {},
        hide: () => {},
    };
}

const focusKit = (): void => {
    document.querySelector<HTMLElement>("iframe[data-client-view]")?.focus();
};

/**
 * Element's own right-panel card over a kit (M9, D39): room info, members, files or pinned messages in the host's tree at
 * the right edge, with an in-panel card stack (React state, never `RightPanelStore`). What a card asks for goes to the
 * kit through the request: an event of this room -> `jump`, another room -> `openRoom`, a thread -> `openThreadOn`
 * (frozen notes F3, F4). The panel dispatches no `ViewRoom` of its own.
 */
export function CardPanelOverlay({ request }: { request: CardPanelRequest }): JSX.Element {
    const sdk = useContext(SDKContext);
    const { room, finish } = request;
    const client = sdk.client!;
    const { context } = usePanelRoomContext(room);

    const [stack, setStack] = useState<IRightPanelCard[]>(() => [rootCard(request)]);
    const stackRef = useRef(stack);
    const ops = useMemo<CardStackOps>(
        () => ({
            stack: () => stackRef.current,
            set: (next) => {
                stackRef.current = next;
                setStack(next);
            },
            finish,
        }),
        [finish],
    );
    // A new Proxy per stack change: BaseCard reads the history from the context and re-renders on the new object.
    const panelSdk = useMemo(
        () => panelSdkContext(sdk, cardStoreOverrides(stack, ops)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [sdk, stack, ops],
    );

    // The dispatcher routing (decision 1, F3, F4). The panel never cancels or re-dispatches an action.
    useEffect(() => {
        let live = true;
        const onViewRoom = async (payload: ViewRoomPayload): Promise<void> => {
            const roomId = payload.room_id;
            if (!roomId) return;
            if (roomId !== room.roomId) {
                // A2: a hit of another room (all-rooms scope) carries its event; the kit opens the room at it.
                // r2 F2: a thread reply opens its room at the thread root (the main timeline does not hold the reply).
                const hitId = payload.event_id;
                if (!hitId) {
                    request.openRoom(roomId);
                    return;
                }
                let hit: MatrixEvent | null;
                try {
                    hit = await fetchInitialEvent(client, roomId, hitId);
                } catch {
                    // r3 F1: the root fetch can throw; the room still opens at the hit.
                    if (!live) return;
                    request.openRoom(roomId, hitId);
                    return;
                }
                if (!live) return;
                const rootId =
                    hit && !hit.isThreadRoot
                        ? (hit.getThread()?.rootEvent?.getId() ??
                          (hit.isRelation(THREAD_RELATION_TYPE.name) ? hit.threadRootId : undefined))
                        : undefined;
                request.openRoom(roomId, rootId ?? hitId);
                return;
            }
            const eventId = payload.event_id;
            if (!eventId) return;
            const ev = room.findEventById(eventId) ?? (await fetchInitialEvent(client, roomId, eventId)) ?? undefined;
            if (!live) return;
            let root: MatrixEvent | undefined;
            if (ev && !ev.isThreadRoot) {
                root = ev.getThread()?.rootEvent;
                if (!root && ev.isRelation(THREAD_RELATION_TYPE.name) && ev.threadRootId) {
                    root =
                        room.findEventById(ev.threadRootId) ??
                        (await fetchInitialEvent(client, roomId, ev.threadRootId)) ??
                        undefined;
                    if (!live) return;
                }
            }
            if (root) request.openThreadOn(root);
            else request.jump(eventId);
        };
        const token = defaultDispatcher.register((payload: ActionPayload) => {
            switch (payload.action) {
                case Action.ViewUser:
                    if (payload.member) {
                        ops.set([
                            ...ops.stack(),
                            { phase: RightPanelPhases.MemberInfo, state: { member: payload.member } },
                        ]);
                    }
                    break;
                case Action.View3pidInvite:
                    if (payload.event) {
                        ops.set([
                            ...ops.stack(),
                            { phase: RightPanelPhases.ThreePidMemberInfo, state: { memberInfoEvent: payload.event } },
                        ]);
                    }
                    break;
                case Action.ShowThread:
                    request.openThreadOn((payload as ShowThreadPayload).rootEvent);
                    break;
                case Action.ViewRoom:
                    void onViewRoom(payload as ViewRoomPayload);
                    break;
            }
        });
        return () => {
            live = false;
            defaultDispatcher.unregister(token);
        };
    }, [request, room, client, ops]);

    // Focus moves into the panel (so Escape reaches it) and returns to the kit's frame when it closes.
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        // A card that focuses its own field on open (the search card) keeps that focus: child effects run before this one.
        if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
        return focusKit;
    }, []);

    // The one close decision (stock RightPanel.onClose): Cancel on a pending verification cancels the request and keeps
    // the panel, otherwise the panel closes. The card's close control and the document-level Escape both take it.
    const closeTop = useCallback((): void => {
        const cur = ops.stack()[ops.stack().length - 1];
        const pending = cur?.state?.verificationRequest;
        if (cur?.phase === RightPanelPhases.EncryptionPanel && pending?.pending) void pending.cancel();
        else finish();
    }, [ops, finish]);

    // Escape also closes once focus has left the panel (in-card navigation unmounts the clicked button, an item vanishes):
    // a document-level listener, like Element's own right panel. A keydown inside the kit's iframe never reaches this document.
    useEffect(() => {
        const onKeyDown = (ev: KeyboardEvent): void => {
            if (ev.key !== "Escape" || ev.defaultPrevented) return;
            if (Modal.hasDialogs() || document.querySelector(".mx_Dialog_wrapper, .mx_Dialog")) return;
            const target = ev.target instanceof HTMLElement ? ev.target : null;
            // A field outside the panel (the composer, a search box) uses Escape itself; inside it the panel's own handler decides.
            if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
            closeTop();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [closeTop]);

    const current = stack[stack.length - 1];
    let card: JSX.Element | null = null;
    switch (current?.phase) {
        case RightPanelPhases.RoomSummary:
            card = (
                <RoomSummaryCardView
                    room={room}
                    permalinkCreator={request.permalinkCreator}
                    hostPanel
                    // The info card's search field hands its term to the search card (pushed on the in-panel stack).
                    onSearchChange={(term) => {
                        if (term)
                            ops.set([
                                ...ops.stack(),
                                { phase: SEARCH_PHASE, state: { searchTerm: term } as IRightPanelCard["state"] },
                            ]);
                    }}
                />
            );
            break;
        case SEARCH_PHASE:
            card = (
                <SearchCard
                    room={room}
                    key={stack.length}
                    initialTerm={(current.state as { searchTerm?: string } | undefined)?.searchTerm}
                    onClose={finish}
                />
            );
            break;
        case RightPanelPhases.MemberList:
            card = <MemberListView roomId={room.roomId} onClose={finish} />;
            break;
        case RightPanelPhases.MemberInfo:
        case RightPanelPhases.EncryptionPanel: {
            const member = current.state?.member;
            if (member) {
                const memberRoom = member instanceof RoomMember ? (client.getRoom(member.roomId) ?? room) : room;
                card = (
                    <UserInfo
                        user={member}
                        room={memberRoom}
                        key={`${stack.length}/${member.userId}`}
                        onClose={closeTop}
                        phase={current.phase}
                        verificationRequest={current.state?.verificationRequest}
                        verificationRequestPromise={current.state?.verificationRequestPromise}
                    />
                );
            }
            break;
        }
        case RightPanelPhases.ThreePidMemberInfo:
            if (current.state?.memberInfoEvent) {
                card = <ThirdPartyMemberInfo event={current.state.memberInfoEvent} onClose={finish} />;
            }
            break;
        case RightPanelPhases.PinnedMessages:
            card = <PinnedMessagesCard room={room} onClose={finish} permalinkCreator={request.permalinkCreator} />;
            break;
        case RightPanelPhases.FilePanel:
            card = <FilePanel roomId={room.roomId} onClose={finish} />;
            break;
    }

    return (
        <SDKContext.Provider value={panelSdk}>
            <RoomContext.Provider value={context}>
                <div
                    ref={ref}
                    tabIndex={-1}
                    className="mx_RightPanel"
                    data-testid="client-view-card-panel"
                    data-card={request.card}
                    style={{
                        position: "fixed",
                        top: 0,
                        right: 0,
                        bottom: 0,
                        width: "min(420px, 100vw)",
                        zIndex: 5000,
                        display: "flex",
                        flexDirection: "column",
                        background: "var(--cpd-color-bg-canvas-default)",
                        boxShadow: "0 0 12px rgba(0, 0, 0, 0.3)",
                        outline: "none",
                    }}
                    onKeyDown={(ev) => {
                        if (ev.key === "Escape" && !ev.defaultPrevented) {
                            ev.stopPropagation();
                            closeTop();
                        }
                    }}
                >
                    {card}
                </div>
            </RoomContext.Provider>
        </SDKContext.Provider>
    );
}

/**
 * The host panel slot (M9): shows the thread panel (M8) or a card panel, whichever the kit asked for last (the bridge
 * keeps at most one). While mounted, MatrixChat's ShowThread arm writes no right-panel store (F5).
 */
export function HostPanelSlot({
    client,
    bridge,
}: {
    client: MatrixClient;
    bridge: ViewModelBridge;
}): JSX.Element | null {
    const [thread, setThread] = useState<ThreadPanelRequest | null>(null);
    const [card, setCard] = useState<CardPanelRequest | null>(null);
    useEffect(() => markHostPanelSlotMounted(), []);
    useEffect(() => bridge.onThreadPanel(setThread), [bridge]);
    useEffect(() => bridge.onCardPanel(setCard), [bridge]);
    if (!thread && !card) return null;
    return (
        <MatrixClientContextProvider client={client}>
            {thread && <ThreadPanelOverlay key={thread.key} request={thread} />}
            {card && <CardPanelOverlay key={card.key} request={card} />}
        </MatrixClientContextProvider>
    );
}
