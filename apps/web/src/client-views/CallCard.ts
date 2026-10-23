/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { type MatrixClient, type MatrixEvent } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import {
    CallType,
    type DmOngoingCallTileViewSnapshot,
    type DmTombstoneCallTileViewSnapshot,
    type RoomOngoingCallTileViewSnapshot,
    type ViewModel,
} from "@element-hq/web-shared-components";

import { SDKContextClass } from "../contexts/SDKContextClass";
import { RootCallTileViewModel } from "../viewmodels/room/timeline/event-tile/call/RootCallTileViewModel";
import { getIntentFromEvent } from "../viewmodels/room/timeline/event-tile/call/common";
import { type ViewCall, type ViewCallParticipant } from "./types";

/** The tile view-model snapshots the root call tile view-model can hold. */
type TileSnapshot = RoomOngoingCallTileViewSnapshot | DmOngoingCallTileViewSnapshot | DmTombstoneCallTileViewSnapshot;

const isOngoing = (tileType: string): boolean => tileType.startsWith("ongoing-");

/**
 * The call card of one `org.matrix.msc4075.rtc.notification` event: Element's RootCallTileViewModel, built the way
 * the stock timeline builds it (EventTileFactory `CallStartedTileViewWrapped`), read as plain data. `changed` runs
 * when the root view-model switches tile or the tile it holds changes (a participant joins or leaves). The
 * duration view-model ticks every second and is only read, never followed.
 */
export class CallCard {
    private readonly root: RootCallTileViewModel;
    private readonly unsubscribe: Array<() => void> = [];
    private followed?: ViewModel<TileSnapshot>;
    private unfollow?: () => void;

    private constructor(
        private readonly event: MatrixEvent,
        root: RootCallTileViewModel,
        private readonly changed: () => void,
    ) {
        this.root = root;
        this.unsubscribe.push(root.subscribe(this.onRoot));
        this.follow();
    }

    /** The card of a call notification, or undefined when Element's view-model cannot be built for it. */
    public static create(client: MatrixClient, event: MatrixEvent, changed: () => void): CallCard | undefined {
        const roomId = event.getRoomId();
        const room = roomId ? client.getRoom(roomId) : null;
        if (!room) return undefined;
        const context = SDKContextClass.instance;
        try {
            const root = new RootCallTileViewModel({
                mxEvent: event,
                getRelationsForEvent: (id, relationType, eventType) =>
                    room.getUnfilteredTimelineSet().relations.getChildEventsForEvent(id, relationType, eventType),
                cli: client,
                callStore: context.callStore,
                latestRtcNotificationEventStore: context.latestRtcNotificationEventStore,
                legacyCallHandler: context.legacyCallHandler,
            });
            return new CallCard(event, root, changed);
        } catch (e) {
            // The view-model throws for an event it cannot draw (no sender, no room): such a call has no card.
            logger.warn("call card: view-model not built", e);
            return undefined;
        }
    }

    private readonly onRoot = (): void => {
        this.follow();
        this.changed();
    };

    /** Follows the tile view-model the root holds now (the root swaps it when ongoing becomes ended). */
    private follow(): void {
        const tile = this.root.getSnapshot().tileViewModel as ViewModel<TileSnapshot>;
        if (tile === this.followed) return;
        this.unfollow?.();
        this.followed = tile;
        this.unfollow = tile.subscribe(this.changed);
    }

    public view(): ViewCall {
        const { tileType, tileViewModel } = this.root.getSnapshot();
        const tile = (tileViewModel as ViewModel<TileSnapshot>).getSnapshot();
        const ongoing = isOngoing(tileType);
        const isDm = tileType.endsWith("-dm");
        const base = {
            callId: this.event.getId() ?? "",
            state: ongoing ? ("ongoing" as const) : ("ended" as const),
            isDm,
            startedTs: this.event.getTs(),
        };
        // A DM tile names the type; a room tile's view-models do not, they read the intent from the same event.
        const callType =
            "callType" in tile ? tile.callType : "type" in tile ? tile.type : getIntentFromEvent(this.event);
        const common = { ...base, callType: callType === CallType.Voice ? ("voice" as const) : ("video" as const) };
        if (!ongoing) {
            const declined = "isCallDeclined" in tile ? { declined: tile.isCallDeclined } : {};
            return { ...common, participants: [], ...declined };
        }
        const ongoingTile = tile as RoomOngoingCallTileViewSnapshot | DmOngoingCallTileViewSnapshot;
        const participants: ViewCallParticipant[] = ongoingTile.facePileViewModel
            .getSnapshot()
            .memberAvatarViewModels.map((vm) => {
                const s = vm.getSnapshot();
                return { userId: s.id, name: s.name, ...(s.url ? { avatarUrl: s.url } : {}) };
            });
        const duration = ongoingTile.durationViewModel?.getSnapshot().duration;
        return {
            ...common,
            participants,
            ...("totalParticipants" in ongoingTile ? { participantCount: ongoingTile.totalParticipants } : {}),
            ...(duration !== undefined ? { durationSeconds: duration } : {}),
        };
    }

    public dispose(): void {
        this.unsubscribe.forEach((u) => u());
        this.unsubscribe.length = 0;
        this.unfollow?.();
        this.unfollow = undefined;
        this.root.dispose();
    }
}
