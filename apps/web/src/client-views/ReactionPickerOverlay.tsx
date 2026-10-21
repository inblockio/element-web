/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import React, { type JSX, useContext, useEffect, useMemo, useState } from "react";

import ContextMenu, { aboveLeftOf } from "../components/structures/ContextMenu";
import ReactionPicker from "../components/views/emojipicker/ReactionPicker";
import RoomContext, { type RoomContextType, TimelineRenderingType } from "../contexts/RoomContext";
import { MatrixClientContextProvider } from "../components/structures/MatrixClientContextProvider";
import { SDKContext } from "../contexts/SDKContext";
import { type ReactionPickerRequest, type ViewModelBridge } from "./ViewModelBridge";

/**
 * Element's own reaction picker over a kit (D17): the context menu and picker the stock reactions row opens
 * (ReactionsRowAdapter), rendered in the host's tree because a kit's frame has no Element code. The picker reads the
 * room's power from RoomContext (RoomView provides it in the stock UI), so a provider carries the same two values.
 */
export function ReactionPickerOverlay({ request }: { request: ReactionPickerRequest }): JSX.Element {
    const inherited = useContext(RoomContext);
    const { roomViewStore } = useContext(SDKContext);
    const context = useMemo<RoomContextType>(
        () => ({
            ...inherited,
            room: request.room,
            canReact: request.permissions.canReact,
            canSelfRedact: request.permissions.canSelfRedact,
            timelineRenderingType: TimelineRenderingType.Room,
            roomViewStore,
        }),
        [inherited, request, roomViewStore],
    );
    // The anchor is in page coordinates (the kit's frame covers the page from its origin), as a DOMRect would be.
    const { x, y, width, height } = request.anchor;
    const rect = { left: x, right: x + width, top: y, bottom: y + height };
    return (
        <RoomContext.Provider value={context}>
            <ContextMenu {...aboveLeftOf(rect)} onFinished={request.finish} managed={false} focusLock>
                <ReactionPicker mxEvent={request.mxEvent} reactions={request.reactions} onFinished={request.finish} />
            </ContextMenu>
        </RoomContext.Provider>
    );
}

/** The picker the kit asked for, if any: follows the bridge until it closes. */
export function HostReactionPicker({
    client,
    bridge,
}: {
    client: MatrixClient;
    bridge: ViewModelBridge;
}): JSX.Element | null {
    const [request, setRequest] = useState<ReactionPickerRequest | null>(null);
    useEffect(() => bridge.onReactionPicker(setRequest), [bridge]);
    return request ? (
        <MatrixClientContextProvider client={client}>
            <ReactionPickerOverlay key={request.key} request={request} />
        </MatrixClientContextProvider>
    ) : null;
}
