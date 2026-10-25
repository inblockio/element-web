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
import { EventEmitter } from "events";

import { SDKContext } from "../contexts/SDKContext";
import { type SDKContextClass } from "../contexts/SDKContextClass";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { RightPanelPhases } from "../stores/right-panel/RightPanelStorePhases";
import { ElementCall } from "../models/Call";
import { isHostPanelSlotMounted } from "./hostPanelSlot";
import { needsStockUi } from "./ClientViewGate";
import { CardPanelOverlay, HostPanelSlot, rootCard } from "./CardPanelOverlay";
import { type CardPanelRequest, type ThreadPanelRequest, type ViewModelBridge } from "./ViewModelBridge";

const h = vi.hoisted(() => ({
    fetched: new Map<string, unknown>(),
    summaryProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("../utils/EventUtils", async (orig) => ({
    ...(await orig<typeof import("../utils/EventUtils")>()),
    fetchInitialEvent: vi.fn(async (_c: unknown, _r: string, id: string) => h.fetched.get(id) ?? null),
}));

// Element's cards are stubs that read what the panel gives them: the SDK context's store answers, the props, the dispatcher.
vi.mock("../components/views/right_panel/RoomSummaryCardView", async () => {
    const R = await import("react");
    const { SDKContext } = await import("../contexts/SDKContext");
    const { RightPanelPhases } = await import("../stores/right-panel/RightPanelStorePhases");
    return {
        default: function RoomSummaryStub(props: Record<string, unknown>) {
            const store = R.useContext(SDKContext).rightPanelStore;
            h.summaryProps.push(props);
            const btn = (label: string, onClick: () => void) => R.createElement("button", { key: label, onClick }, label);
            const push = (label: string, phase: RightPanelPhases) => btn(label, () => store.pushCard({ phase }, true));
            return R.createElement("div", { "data-testid": "card-info" }, [
                push("People", RightPanelPhases.MemberList),
                push("Threads", RightPanelPhases.ThreadPanel),
                push("Ext", RightPanelPhases.Extensions),
                push("Files", RightPanelPhases.FilePanel),
                push("Pins", RightPanelPhases.PinnedMessages),
                btn("setFiles", () => store.setCard({ phase: RightPanelPhases.FilePanel })),
                btn("togglePins", () => store.showOrHidePhase(RightPanelPhases.PinnedMessages)),
                btn("toggle", () => store.togglePanel(null)),
            ]);
        },
    };
});
const cardStub = async (testId: string, extra?: (props: Record<string, unknown>, R: typeof import("react")) => unknown) => {
    const R = await import("react");
    const { SDKContext } = await import("../contexts/SDKContext");
    return function CardStub(props: Record<string, unknown>) {
        const store = R.useContext(SDKContext).rightPanelStore;
        const history = store.roomPhaseHistory;
        return R.createElement(
            "div",
            { "data-testid": testId, "data-history": history.map((c) => c.phase).join(">") },
            history.length > 1 ? R.createElement("button", { onClick: () => store.popCard() }, "back") : null,
            R.createElement("button", { onClick: props.onClose as () => void }, "close"),
            extra?.(props, R) as never,
        );
    };
};
vi.mock("../components/views/right_panel/UserInfo", async () => ({
    default: await cardStub("card-user", (p, R) =>
        R.createElement("span", { "data-testid": "user-id" }, (p.user as { userId: string }).userId),
    ),
}));
vi.mock("../components/views/rooms/ThirdPartyMemberInfo", async () => ({ default: await cardStub("card-3pid") }));
vi.mock("../components/views/rooms/MemberList/MemberListView", async () => {
    const { default: defaultDispatcher } = await import("../dispatcher/dispatcher");
    return {
        default: await cardStub("card-members", (_p, R) =>
            R.createElement(
                "button",
                {
                    onClick: () =>
                        defaultDispatcher.dispatch({
                            action: "view_user",
                            member: { userId: "@bob:example.org", roomId: "!a" },
                            push: true,
                        }),
                },
                "bob",
            ),
        ),
    };
});
vi.mock("../components/structures/FilePanel", async () => ({ default: await cardStub("card-files") }));
vi.mock("../components/views/right_panel/PinnedMessagesCard", async () => ({
    PinnedMessagesCard: await cardStub("card-pinned"),
}));

const makeSdk = () => {
    const rightPanelStore = {
        roomPhaseHistory: [] as unknown[],
        popCard: vi.fn(),
        pushCard: vi.fn(),
        setCard: vi.fn(),
        setCards: vi.fn(),
        showOrHidePhase: vi.fn(),
        togglePanel: vi.fn(),
    };
    const client = Object.assign(new EventEmitter(), {
        getSafeUserId: () => "@me:example.org",
        getCrypto: (): unknown => undefined,
        getRoom: (): unknown => undefined,
    }) as unknown as MatrixClient;
    return {
        client,
        widgetLayoutStore: { hasMaximisedWidget: () => false },
        rightPanelStore,
        roomViewStore: { getRoomId: () => null },
        resizeNotifier: {},
    } as unknown as SDKContextClass & { rightPanelStore: typeof rightPanelStore };
};

const events = new Map<string, unknown>();
const room = {
    roomId: "!a",
    maySendMessage: () => true,
    getMyMembership: () => "join",
    getLiveTimeline: () => ({}),
    findEventById: (id: string) => events.get(id),
    currentState: { maySendEvent: () => true, getStateEvents: () => undefined },
} as unknown as Room;
const plainEvent = (id: string, extra: Record<string, unknown> = {}) =>
    ({
        getId: () => id,
        isThreadRoot: false,
        getThread: () => undefined,
        isRelation: () => false,
        threadRootId: undefined,
        ...extra,
    }) as unknown as MatrixEvent;

describe("CardPanelOverlay", () => {
    let sdk: ReturnType<typeof makeSdk>;
    let req: CardPanelRequest;
    const mount = (card: CardPanelRequest["card"] = "info", extra: Partial<CardPanelRequest> = {}) => {
        req = {
            key: `!a/${card}#1`,
            room,
            card,
            permalinkCreator: {} as never,
            finish: vi.fn(),
            jump: vi.fn(),
            openRoom: vi.fn(),
            openThreadOn: vi.fn(),
            ...extra,
        };
        return render(
            <SDKContext.Provider value={sdk}>
                <CardPanelOverlay request={req} />
            </SDKContext.Provider>,
        );
    };
    const dispatch = (payload: Record<string, unknown>) => act(async () => void defaultDispatcher.dispatch(payload as never, true));
    const noStoreWrites = () => {
        const s = sdk.rightPanelStore;
        for (const fn of [s.popCard, s.pushCard, s.setCard, s.setCards, s.showOrHidePhase, s.togglePanel]) {
            expect(fn).not.toHaveBeenCalled();
        }
    };

    beforeEach(() => {
        sdk = makeSdk();
        events.clear();
        h.fetched.clear();
        h.summaryProps.length = 0;
    });
    afterEach(() => vi.restoreAllMocks());

    it("roots the stack at the card asked for; a DM's info card is the other member's user info", () => {
        expect(rootCard({ card: "info" }).phase).toBe(RightPanelPhases.RoomSummary);
        expect(rootCard({ card: "members" }).phase).toBe(RightPanelPhases.MemberList);
        expect(rootCard({ card: "files" }).phase).toBe(RightPanelPhases.FilePanel);
        expect(rootCard({ card: "pinned" }).phase).toBe(RightPanelPhases.PinnedMessages);
        const bob = { userId: "@bob:example.org", roomId: "!a" };
        expect(rootCard({ card: "info", dmMember: bob as never }).phase).toBe(RightPanelPhases.MemberInfo);
        mount("info", { dmMember: bob as never });
        expect(screen.getByTestId("user-id").textContent).toBe("@bob:example.org");
    });

    it.each([
        ["info", "card-info"],
        ["members", "card-members"],
        ["files", "card-files"],
        ["pinned", "card-pinned"],
    ] as const)("shows Element's %s card, with the hosted-panel hide on the info card (F6)", async (card, testId) => {
        mount(card);
        expect(await screen.findByTestId(testId)).toBeTruthy();
        if (card === "info") expect(h.summaryProps[0]).toMatchObject({ room, hostPanel: true });
        expect(screen.getByTestId("client-view-card-panel").getAttribute("data-card")).toBe(card);
    });

    it("the in-panel stack: People pushes, back pops, close at the root finishes; the stock store is never written", async () => {
        mount("info");
        fireEvent.click(await screen.findByText("People"));
        const members = await screen.findByTestId("card-members");
        expect(members.getAttribute("data-history")).toBe(`${RightPanelPhases.RoomSummary}>${RightPanelPhases.MemberList}`);
        fireEvent.click(screen.getByText("back"));
        expect(await screen.findByTestId("card-info")).toBeTruthy();
        expect(screen.queryByText("back")).toBeNull();
        fireEvent.click(screen.getByText("Files"));
        fireEvent.click(await screen.findByText("back"));
        // popCard at the root closes (nothing to pop to)
        fireEvent.click(screen.getByText("People"));
        fireEvent.click(await screen.findByText("close"));
        expect(req.finish).toHaveBeenCalledTimes(1);
        noStoreWrites();
    });

    it("ignores the phases the slot does not show (Threads, Extensions) and toggles; setCard and showOrHidePhase use the stack", async () => {
        mount("info");
        for (const name of ["Threads", "Ext", "toggle"]) fireEvent.click(await screen.findByText(name));
        expect(screen.getByTestId("card-info")).toBeTruthy();
        fireEvent.click(screen.getByText("setFiles"));
        expect((await screen.findByTestId("card-files")).getAttribute("data-history")).toBe(`${RightPanelPhases.FilePanel}`);
        fireEvent.click(screen.getByText("close"));
        expect(req.finish).toHaveBeenCalledTimes(1);
        noStoreWrites();
    });

    it("ViewUser pushes user info (back returns), View3pidInvite pushes the 3pid card, the stock store is not written", async () => {
        mount("members");
        fireEvent.click(await screen.findByText("bob"));
        expect((await screen.findByTestId("user-id")).textContent).toBe("@bob:example.org");
        fireEvent.click(screen.getByText("back"));
        expect(await screen.findByTestId("card-members")).toBeTruthy();
        await dispatch({ action: Action.View3pidInvite, event: { getId: () => "$3pid" } });
        expect(await screen.findByTestId("card-3pid")).toBeTruthy();
        noStoreWrites();
    });

    it("pinned: 'View in timeline' (same room, event) is a jump and the panel stays; a thread link opens the thread (F3, F5)", async () => {
        mount("pinned");
        const dispatchSpy = vi.spyOn(defaultDispatcher, "dispatch");
        events.set("$m", plainEvent("$m"));
        await dispatch({ action: Action.ViewRoom, room_id: "!a", event_id: "$m" });
        expect(req.jump).toHaveBeenCalledWith("$m");
        expect(req.finish).not.toHaveBeenCalled();

        const root = plainEvent("$root", { isThreadRoot: true });
        await dispatch({ action: Action.ShowThread, rootEvent: root });
        expect(req.openThreadOn).toHaveBeenCalledWith(root);

        // the host's own dispatches: none of its own ViewRoom (the two above are the test's)
        expect(dispatchSpy.mock.calls.filter(([p]) => (p as { action: string }).action === Action.ViewRoom)).toHaveLength(1);
        noStoreWrites();
    });

    it("F3: a jump to a thread reply opens the thread panel on its root (also when the reply is fetched), not a jump", async () => {
        mount("pinned");
        const root = plainEvent("$root", { isThreadRoot: true });
        const reply = plainEvent("$reply", { getThread: () => ({ rootEvent: root }) });
        events.set("$reply", reply);
        await dispatch({ action: Action.ViewRoom, room_id: "!a", event_id: "$reply" });
        expect(req.openThreadOn).toHaveBeenCalledWith(root);
        expect(req.jump).not.toHaveBeenCalled();

        const reply2 = plainEvent("$reply2", { isRelation: (t?: string) => t === "m.thread", threadRootId: "$root2" });
        const root2 = plainEvent("$root2", { isThreadRoot: true });
        h.fetched.set("$reply2", reply2);
        h.fetched.set("$root2", root2);
        await dispatch({ action: Action.ViewRoom, room_id: "!a", event_id: "$reply2" });
        expect(req.openThreadOn).toHaveBeenLastCalledWith(root2);
        expect(req.jump).not.toHaveBeenCalled();
    });

    it("a thread root, or an event that cannot be resolved, is a jump; the same room without an event is ignored", async () => {
        mount("pinned");
        events.set("$root", plainEvent("$root", { isThreadRoot: true }));
        await dispatch({ action: Action.ViewRoom, room_id: "!a", event_id: "$root" });
        await dispatch({ action: Action.ViewRoom, room_id: "!a", event_id: "$gone" });
        expect(req.jump).toHaveBeenNthCalledWith(1, "$root");
        expect(req.jump).toHaveBeenNthCalledWith(2, "$gone");
        await dispatch({ action: Action.ViewRoom, room_id: "!a" });
        expect(req.jump).toHaveBeenCalledTimes(2);
        expect(req.openRoom).not.toHaveBeenCalled();
        expect(req.openThreadOn).not.toHaveBeenCalled();
    });

    it("F4: another room (Message from user info) asks the kit to open it, starts no call and does not hand over to Element's UI", async () => {
        const create = vi.spyOn(ElementCall, "create").mockImplementation(() => {});
        mount("info");
        await dispatch({ action: Action.ViewRoom, room_id: "local+1", metricsTrigger: "MessageUser" });
        expect(req.openRoom).toHaveBeenCalledWith("local+1");
        expect(create).not.toHaveBeenCalled();
        expect(needsStockUi({ action: Action.ViewRoom, room_id: "local+1", metricsTrigger: "MessageUser" })).toBe(false);
    });

    it("Escape closes (a prevented one does not); a listener is gone after unmount", async () => {
        const { unmount } = mount("members");
        const panel = await screen.findByTestId("card-members");
        panel.addEventListener("keydown", (e) => e.preventDefault());
        fireEvent.keyDown(panel, { key: "Escape" });
        expect(req.finish).not.toHaveBeenCalled();
        fireEvent.keyDown(screen.getByText("close"), { key: "Escape" });
        expect(req.finish).toHaveBeenCalledTimes(1);
        unmount();
        await dispatch({ action: Action.ViewRoom, room_id: "!a", event_id: "$x" });
        expect(req.jump).not.toHaveBeenCalled();
    });
});

describe("HostPanelSlot", () => {
    it("marks the slot mounted (F5), shows the card or the thread the bridge hands it, one at a time", async () => {
        const sdk = makeSdk();
        const threadCbs = new Set<(r: ThreadPanelRequest | null) => void>();
        const cardCbs = new Set<(r: CardPanelRequest | null) => void>();
        const bridge = {
            onThreadPanel: (cb: never) => (threadCbs.add(cb), () => void threadCbs.delete(cb)),
            onCardPanel: (cb: never) => (cardCbs.add(cb), () => void cardCbs.delete(cb)),
        } as unknown as ViewModelBridge;
        expect(isHostPanelSlotMounted()).toBe(false);
        const { unmount } = render(
            <SDKContext.Provider value={sdk}>
                <HostPanelSlot client={sdk.client} bridge={bridge} />
            </SDKContext.Provider>,
        );
        expect(isHostPanelSlotMounted()).toBe(true);
        expect(screen.queryByTestId("client-view-card-panel")).toBeNull();
        const request = {
            key: "!a/files#1",
            room,
            card: "files",
            permalinkCreator: {} as never,
            finish: vi.fn(),
            jump: vi.fn(),
            openRoom: vi.fn(),
            openThreadOn: vi.fn(),
        } satisfies CardPanelRequest;
        act(() => cardCbs.forEach((cb) => cb(request)));
        expect(await screen.findByTestId("card-files")).toBeTruthy();
        act(() => cardCbs.forEach((cb) => cb(null)));
        expect(screen.queryByTestId("client-view-card-panel")).toBeNull();
        unmount();
        expect(isHostPanelSlotMounted()).toBe(false);
    });
});
