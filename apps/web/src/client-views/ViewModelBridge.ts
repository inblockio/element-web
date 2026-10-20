/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { type MatrixClient, type MatrixEvent, EventType } from "matrix-js-sdk/src/matrix";
import { type EventTimelineItem, RoomStatusBarState, type TimelineItem } from "@element-hq/web-shared-components";

import { SDKContextClass } from "../contexts/SDKContextClass";
import { TimelineRenderingType } from "../contexts/RoomContext";
import SettingsStore from "../settings/SettingsStore";
import { OwnProfileStore } from "../stores/OwnProfileStore";
import defaultDispatcher from "../dispatcher/dispatcher";
import { avatarUrlForRoom } from "../Avatar";
import { resolveRoomMemberProfile, roomMemberToMemberInfo } from "../hooks/room/useRoomMemberProfile";
import { RoomListViewModel } from "../viewmodels/room-list/RoomListViewModel";
import { RoomTimelineViewModel } from "../viewmodels/room/timeline/RoomTimelineViewModel";
import { EventTileViewModel } from "../viewmodels/room/timeline/event-tile/EventTileViewModel";
import { EventContentBodyViewModel } from "../viewmodels/message-body/EventContentBodyViewModel";
import { UserMenuViewModel } from "../viewmodels/menus/UserMenuViewModel";
import { RoomStatusBarViewModel } from "../viewmodels/room/RoomStatusBar";
import { getClientViews, selectClientView } from "./registry";
import { toViewMessage, toViewRoom } from "./mapping";
import {
    type ClientViewBridge,
    type ViewConnection,
    type ViewMe,
    type ViewMessage,
    type ViewRoom,
    STOCK_VIEW,
} from "./types";

type ChangeEvent = Parameters<Parameters<ClientViewBridge["onChange"]>[0]>[0];

const AVATAR_PX = 64;

/** The tile and body view-models of one timeline event, built the way EventTile builds them. */
class EventRow {
    public readonly tile: EventTileViewModel;
    public readonly body: EventContentBodyViewModel;

    public constructor(client: MatrixClient, ev: MatrixEvent, continuation: boolean) {
        // EventTile.createViewModelProps reads only two values from the legacy RoomContext:
        // showHiddenEvents and timelineRenderingType. Everything else is EventTile props or utilities.
        this.tile = new EventTileViewModel(
            {
                mxEvent: ev,
                matrixClient: client,
                showHiddenEvents: SettingsStore.getValue("showHiddenEventsInTimeline"),
            },
            {
                event: { isSending: false, isEditing: false },
                display: {
                    timelineRenderingType: TimelineRenderingType.Room,
                    continuation,
                    isProbablyMedia: false,
                    isHighlighted: false,
                    isSelected: false,
                },
                interaction: {
                    hover: false,
                    showActionBarFromFocus: false,
                    focusWithin: false,
                    isActionBarFocused: false,
                    hasContextMenu: false,
                },
                sender: {
                    member: roomMemberToMemberInfo(
                        resolveRoomMemberProfile({
                            room: client.getRoom(ev.getRoomId() ?? ""),
                            userId: ev.getSender() ?? undefined,
                            member: ev.sender,
                            useOnlyCurrentProfiles: SettingsStore.getValue("useOnlyCurrentProfiles"),
                            timelineRenderingType: TimelineRenderingType.Room,
                        }),
                    ),
                },
                timestamp: {},
                footer: {
                    isOwnEvent: ev.getSender() === client.getUserId(),
                    hasReactionsRow: false,
                    hasReactions: false,
                    hasPinnedMessageBadge: false,
                },
            },
        );
        this.body = new EventContentBodyViewModel({
            as: "div",
            includeDir: false,
            mxEvent: ev,
            content: ev.getContent(),
            stripReply: true,
            linkify: false,
            client,
        });
    }

    public dispose(): void {
        this.tile.dispose();
        this.body.dispose();
    }
}

/**
 * A ClientViewBridge fed only from shipped view-model snapshots. View-models are built outside their legacy
 * parent components; the matrix-js-sdk objects they need as props are passed through, never read for data.
 */
export class ViewModelBridge implements ClientViewBridge {
    public readonly version = 1;

    private readonly listeners = new Set<(e: ChangeEvent) => void>();
    private readonly disposers: Array<() => void> = [];
    private readonly roomList: RoomListViewModel;
    private readonly userMenu: UserMenuViewModel;
    private readonly watchedItems = new Set<string>();
    private readonly timelines = new Map<string, RoomTimelineViewModel>();
    private readonly rows = new Map<string, EventRow>();
    private statusBar?: RoomStatusBarViewModel;
    private roomCache: ViewRoom[] = [];
    private lastConnection: ViewConnection = "online";

    public constructor(private readonly client: MatrixClient) {
        this.roomList = new RoomListViewModel({
            client,
            roomViewStore: SDKContextClass.instance.roomViewStore,
            spaceStore: SDKContextClass.instance.spaceStore,
        });
        this.disposers.push(this.roomList.subscribe(() => this.syncRooms()));
        this.userMenu = new UserMenuViewModel({ ownProfileStore: OwnProfileStore.instance }, defaultDispatcher, client, false);
        this.disposers.push(this.userMenu.subscribe(() => this.emit({ kind: "me" })));
        this.syncRooms();
    }

    private emit(e: ChangeEvent): void {
        this.listeners.forEach((cb) => cb(e));
    }

    private syncRooms(): void {
        const ids = this.roomList.getSnapshot().sections.flatMap((s) => s.roomIds);
        // Item view-models exist only for rooms the list was told are visible.
        this.roomList.updateVisibleRooms(0, ids.length);
        const rooms: ViewRoom[] = [];
        for (const id of ids) {
            const item = this.roomList.getRoomItemViewModel(id);
            if (!item) continue;
            if (!this.watchedItems.has(id)) {
                this.watchedItems.add(id);
                this.disposers.push(item.subscribe(() => this.syncRooms()));
            }
            const s = item.getSnapshot();
            rooms.push(toViewRoom(s, rooms.length, avatarUrlForRoom(s.room, AVATAR_PX, AVATAR_PX, "crop") ?? undefined));
            if (!this.statusBar) this.watchConnection(s.room);
        }
        if (JSON.stringify(rooms) === JSON.stringify(this.roomCache)) return;
        this.roomCache = rooms;
        this.emit({ kind: "rooms" });
    }

    /** The sync state is global; the room status bar view-model exposes it for whichever room it is given. */
    private watchConnection(room: ConstructorParameters<typeof RoomStatusBarViewModel>[0]["room"]): void {
        this.statusBar = new RoomStatusBarViewModel({ room });
        this.disposers.push(
            this.statusBar.subscribe(() => {
                const next = this.connection();
                if (next === this.lastConnection) return;
                this.lastConnection = next;
                this.emit({ kind: "connection" });
            }),
        );
        this.lastConnection = this.connection();
    }

    private ensureTimeline(roomId: string): RoomTimelineViewModel | undefined {
        const existing = this.timelines.get(roomId);
        if (existing) return existing;
        const room = this.roomList.getRoomItemViewModel(roomId)?.getSnapshot().room;
        if (!room) return undefined;
        const vm = new RoomTimelineViewModel({ client: this.client, room });
        this.timelines.set(roomId, vm);
        this.disposers.push(vm.subscribe(() => this.emit({ kind: "timeline", roomId })));
        vm.start();
        return vm;
    }

    private row(item: EventTimelineItem, roomId: string): EventRow {
        const ev = item.event as MatrixEvent;
        const key = ev.getId()!;
        let row = this.rows.get(key);
        if (!row) {
            row = new EventRow(this.client, ev, item.continuation);
            this.rows.set(key, row);
            const changed = (): void => this.emit({ kind: "timeline", roomId });
            this.disposers.push(row.tile.subscribe(changed), row.body.subscribe(changed));
        }
        return row;
    }

    public me(): ViewMe {
        const s = this.userMenu.getSnapshot();
        return { userId: s.userId, displayName: s.displayName, avatarUrl: s.avatarUrl };
    }

    public rooms(): ViewRoom[] {
        return this.roomCache;
    }

    public timeline(roomId: string): ViewMessage[] {
        const vm = this.ensureTimeline(roomId);
        if (!vm) return [];
        const messages: ViewMessage[] = [];
        for (const item of vm.getSnapshot().items) {
            if ((item as TimelineItem).kind !== "event") continue;
            const eventItem = item as EventTimelineItem;
            if (eventItem.sendState && eventItem.sendState !== "sent") continue;
            const id = (eventItem.event as MatrixEvent).getId();
            if (!id || id.startsWith("~")) continue;
            const row = this.row(eventItem, roomId);
            const tile = row.tile.getSnapshot().snapshot;
            if (tile.event.eventType !== EventType.RoomMessage || tile.event.isLocalEcho) continue;
            // No shipped view-model exposes a sender avatar URL outside the legacy avatar component: left undefined.
            const message = toViewMessage(roomId, tile, row.body.getSnapshot());
            if (message) messages.push(message);
        }
        return messages.sort((a, b) => a.ts - b.ts);
    }

    public markRead(roomId: string): void {
        // The timeline view-model's "mark all as read" = the room list's "Mark as read" path.
        this.ensureTimeline(roomId)?.onMarkAllAsRead();
    }

    public connection(): ViewConnection {
        // The status bar view-model distinguishes only "connection lost"; "connecting" has no view-model source.
        return this.statusBar?.getSnapshot().state === RoomStatusBarState.ConnectionLost ? "offline" : "online";
    }

    public views(): { id: string; name: string }[] {
        return [{ id: STOCK_VIEW, name: "Element" }, ...getClientViews().map(({ id, name }) => ({ id, name }))];
    }

    public switchTo(viewId: string): void {
        void selectClientView(viewId);
    }

    public onChange(cb: (e: ChangeEvent) => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    public dispose(): void {
        this.disposers.forEach((d) => d());
        this.rows.forEach((r) => r.dispose());
        this.timelines.forEach((t) => t.dispose());
        this.statusBar?.dispose();
        this.userMenu.dispose();
        this.roomList.dispose();
        this.listeners.clear();
    }
}
