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

/** What the card disposes: a view-model of Element's. */
interface Disposable {
    dispose(): void;
}

type FacePileSnapshot = { memberAvatarViewModels: unknown[] } & Record<string, unknown>;

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
    /** Every view-model the card listens on (the tile, its face pile and the face pile's avatars) and how to stop. */
    private readonly followed = new Map<Disposable, () => void>();
    /** The tile the root held when the card last looked, to dispose it when the root swaps it. */
    private tile?: Disposable & { getSnapshot(): TileSnapshot };
    /** The duration view-models of the tiles seen: the tile does not track its own, and each ticks every second. */
    private readonly durations = new Set<Disposable>();
    private disposed = false;

    private constructor(
        private readonly event: MatrixEvent,
        root: RootCallTileViewModel,
        private readonly changed: () => void,
    ) {
        this.root = root;
        this.unsubscribe.push(root.subscribe(this.onRoot));
        this.follow();
    }

    /** The room of the call. */
    public get roomId(): string {
        return this.event.getRoomId() ?? "";
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

    /** A change of a followed view-model: the face pile may hold other avatars now, so what is followed is re-read. */
    private readonly onFollowed = (): void => {
        if (this.disposed) return;
        this.follow();
        this.changed();
    };

    /**
     * Follows what the card shows: the tile the root holds, and for an ongoing tile its face pile and the face pile's
     * member avatars (the tile merges only its counts, so a swapped participant, a new name or a new avatar change only
     * those). Called again on every change, so a face pile's new list is followed. The root swaps the tile when the call
     * ends and keeps the replaced one (and its duration view-model, which no tile tracks): both are disposed here.
     */
    private follow(): void {
        const root = this.root.getSnapshot();
        const tile = root.tileViewModel as unknown as Disposable & { getSnapshot(): TileSnapshot };
        const wanted = new Set<Disposable>([tile]);
        const snapshot = tile.getSnapshot();
        if ("facePileViewModel" in snapshot) {
            const pile = snapshot.facePileViewModel as unknown as Disposable & ViewModel<FacePileSnapshot>;
            wanted.add(pile);
            for (const avatar of pile.getSnapshot().memberAvatarViewModels) wanted.add(avatar as Disposable);
            if (snapshot.durationViewModel) this.durations.add(snapshot.durationViewModel as unknown as Disposable);
        }
        for (const [vm, stop] of this.followed) {
            if (wanted.has(vm)) continue;
            stop();
            this.followed.delete(vm);
        }
        for (const vm of wanted) {
            if (!this.followed.has(vm))
                this.followed.set(vm, (vm as unknown as ViewModel<unknown>).subscribe(this.onFollowed));
        }
        const replaced = this.tile;
        this.tile = tile;
        if (replaced && replaced !== tile) this.release(replaced);
    }

    /** Disposes a tile the root no longer holds, with the duration view-model it made. */
    private release(tile: Disposable & { getSnapshot(): TileSnapshot }): void {
        const duration = (tile.getSnapshot() as { durationViewModel?: unknown }).durationViewModel as
            | Disposable
            | undefined;
        if (duration) {
            duration.dispose();
            this.durations.delete(duration);
        }
        tile.dispose();
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
        this.disposed = true;
        this.unsubscribe.forEach((u) => u());
        this.unsubscribe.length = 0;
        this.followed.forEach((stop) => stop());
        this.followed.clear();
        // No duration interval outlives the card.
        this.durations.forEach((d) => d.dispose());
        this.durations.clear();
        this.root.dispose();
    }
}
