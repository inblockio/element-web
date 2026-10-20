/*
 * element-views spike (M0, S3): hosts the Rocket.Chat kit in a same-origin iframe and hands it a KitSource built
 * only from shipped view-model snapshots. Behind the URL flag `?rc_kit=1`; stock Element is untouched otherwise.
 */

import React, { type JSX, useEffect, useState } from "react";
import { EventType, type MatrixClient, type MatrixEvent } from "matrix-js-sdk/src/matrix";
import { type EventTimelineItem, type TimelineItem } from "@element-hq/web-shared-components";

import { SDKContextClass } from "../contexts/SDKContextClass";
import { TimelineRenderingType } from "../contexts/RoomContext";
import SettingsStore from "../settings/SettingsStore";
import { resolveRoomMemberProfile, roomMemberToMemberInfo } from "../hooks/room/useRoomMemberProfile";
import { RoomListViewModel } from "../viewmodels/room-list/RoomListViewModel";
import { RoomTimelineViewModel } from "../viewmodels/room/timeline/RoomTimelineViewModel";
import { EventTileViewModel } from "../viewmodels/room/timeline/event-tile/EventTileViewModel";
import { EventContentBodyViewModel } from "../viewmodels/message-body/EventContentBodyViewModel";

type Doc = Record<string, unknown>;
type Kind = "room" | "subscription" | "message";
type Listener = (kind: Kind, doc: Doc) => void;

export const isRcKitEnabled = (): boolean => new URLSearchParams(window.location.search).has("rc_kit");

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "room";

/** Per event row: the tile and body view-models, built without the legacy EventTile. */
class Row {
    public readonly tile: EventTileViewModel;
    public readonly body: EventContentBodyViewModel;

    public constructor(client: MatrixClient, ev: MatrixEvent, continuation: boolean) {
        // EventTile.createViewModelDependencies/Props read only two values from legacy RoomContext:
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

export class RcKitBridge {
    private readonly listeners = new Set<Listener>();
    private readonly roomList: RoomListViewModel;
    private readonly timelines = new Map<string, RoomTimelineViewModel>();
    private readonly rows = new Map<string, Row>();
    private readonly messages = new Map<string, Map<string, Doc>>();
    private readonly users = new Map<string, Doc>();
    private readonly lastJson = new Map<string, string>();
    private readonly unsubs: Array<() => void> = [];
    private roomDocs: Doc[] = [];
    private subDocs: Doc[] = [];
    /** Shapes seen for EventContentBodyViewSnapshot.body that were not a string (H3b evidence). */
    public readonly nonStringBodies: Array<{ eventId: string; kind: string }> = [];
    public readonly me: Doc;

    public constructor(private readonly client: MatrixClient) {
        const userId = client.getSafeUserId();
        this.me = {
            _id: userId,
            username: userId,
            name: client.getUser(userId)?.displayName ?? userId,
            type: "user",
            active: true,
            status: "online",
            roles: ["user"],
            createdAt: new Date(0),
            _updatedAt: new Date(0),
            settings: { preferences: {} },
        };
        this.users.set(userId, this.me);
        this.roomList = new RoomListViewModel({
            client,
            roomViewStore: SDKContextClass.instance.roomViewStore,
            spaceStore: SDKContextClass.instance.spaceStore,
        });
        this.unsubs.push(this.roomList.subscribe(() => this.syncRooms()));
        this.syncRooms();
    }

    private emit(kind: Kind, key: string, doc: Doc): void {
        const json = JSON.stringify(doc);
        if (this.lastJson.get(key) === json) return;
        this.lastJson.set(key, json);
        this.listeners.forEach((cb) => cb(kind, doc));
    }

    private syncRooms(): void {
        const ids = this.roomList.getSnapshot().sections.flatMap((s) => s.roomIds);
        this.roomList.updateVisibleRooms(0, ids.length);
        const now = Date.now();
        const taken = new Set<string>();
        const rooms: Doc[] = [];
        const subs: Doc[] = [];
        ids.forEach((roomId, i) => {
            const item = this.roomList.getRoomItemViewModel(roomId);
            if (!item) return;
            if (!this.lastJson.has(`item:${roomId}`)) {
                this.lastJson.set(`item:${roomId}`, "");
                this.unsubs.push(item.subscribe(() => this.syncRooms()));
            }
            const s = item.getSnapshot();
            let name = slug(s.name);
            while (taken.has(name)) name += "-x";
            taken.add(name);
            // Element orders by activity; Rocket.Chat sorts by lm, so the order is carried as descending times.
            const at = new Date(now - i * 60_000);
            const n = s.notification;
            const unread = n.hasUnreadCount ? n.count : 0;
            const t = s.isDm ? "d" : "c";
            rooms.push({ _id: roomId, t, name, fname: s.name, msgs: 0, usersCount: 2, u: { _id: this.me._id, username: this.me.username }, ts: new Date(0), _updatedAt: at, lm: at });
            subs.push({
                _id: `s-${roomId}`,
                rid: roomId,
                name,
                fname: s.name,
                t,
                u: { _id: this.me._id, username: this.me.username },
                open: true,
                alert: s.isBold,
                unread,
                userMentions: n.isMention ? unread : 0,
                groupMentions: 0,
                ts: new Date(0),
                ls: new Date(unread > 0 ? 0 : now),
                lr: at,
                _updatedAt: at,
            });
            this.ensureTimeline(roomId);
        });
        this.roomDocs = rooms;
        this.subDocs = subs;
        rooms.forEach((d) => this.emit("room", `room:${d._id}`, d));
        subs.forEach((d) => this.emit("subscription", `sub:${d._id}`, d));
    }

    private ensureTimeline(roomId: string): void {
        if (this.timelines.has(roomId)) return;
        const room = this.client.getRoom(roomId);
        if (!room) return;
        const vm = new RoomTimelineViewModel({ client: this.client, room });
        this.timelines.set(roomId, vm);
        this.unsubs.push(vm.subscribe(() => this.syncTimeline(roomId)));
        vm.start();
        this.syncTimeline(roomId);
    }

    private syncTimeline(roomId: string): void {
        const vm = this.timelines.get(roomId)!;
        const docs = this.messages.get(roomId) ?? new Map<string, Doc>();
        this.messages.set(roomId, docs);
        const items = vm.getSnapshot().items.filter((i: TimelineItem): i is EventTimelineItem => i.kind === "event");
        for (const item of items) {
            if (item.sendState && item.sendState !== "sent") continue;
            const ev = item.event as MatrixEvent;
            if (ev.getType() !== EventType.RoomMessage || !ev.getId() || ev.getId()!.startsWith("~")) continue;
            const id = ev.getId()!;
            let row = this.rows.get(id);
            if (!row) {
                row = new Row(this.client, ev, item.continuation);
                this.rows.set(id, row);
                this.unsubs.push(row.tile.subscribe(() => this.syncTimeline(roomId)));
                this.unsubs.push(row.body.subscribe(() => this.syncTimeline(roomId)));
            }
            const tile = row.tile.getSnapshot().snapshot;
            const body = row.body.getSnapshot();
            let msg: string;
            if (typeof body.body === "string") msg = body.body;
            else {
                if (!this.nonStringBodies.some((b) => b.eventId === id))
                    this.nonStringBodies.push({ eventId: id, kind: Array.isArray(body.body) ? "jsx-array" : typeof body.body });
                msg = "";
            }
            const senderId = tile.sender.senderId ?? "";
            const name = tile.sender.member?.rawDisplayName ?? senderId;
            if (!this.users.has(senderId)) this.users.set(senderId, { _id: senderId, username: senderId, name, type: "user", active: true });
            const ts = new Date(tile.timestamp.value);
            const doc = { _id: id, rid: roomId, msg, u: { _id: senderId, username: senderId, name }, ts, _updatedAt: ts };
            docs.set(id, doc);
            this.emit("message", `msg:${id}`, doc);
        }
    }

    public readonly source = {
        get me(): Doc {
            return bridge().me;
        },
        rooms: (): Doc[] => this.roomDocs,
        subscriptions: (): Doc[] => this.subDocs,
        history: (rid: string): Doc[] =>
            [...(this.messages.get(rid)?.values() ?? [])].sort((a, b) => +(a.ts as Date) - +(b.ts as Date)),
        user: (key: string): Doc | undefined => this.users.get(key),
        onChange: (cb: Listener): (() => void) => {
            this.listeners.add(cb);
            return () => this.listeners.delete(cb);
        },
        /** Rocket.Chat's subscriptions.read, mapped to the timeline view-model's shipped action. */
        markRead: (rid: string): void => this.timelines.get(rid)?.onMarkAllAsRead(),
        /** Spike evidence for S4, not used by the kit. */
        evidence: () => ({ nonStringBodies: this.nonStringBodies }),
    };

    public dispose(): void {
        this.unsubs.forEach((u) => u());
        this.rows.forEach((r) => r.dispose());
        this.timelines.forEach((t) => t.dispose());
        this.roomList.dispose();
        this.listeners.clear();
    }
}

let current: RcKitBridge | undefined;
const bridge = (): RcKitBridge => current!;

export function RcKitHost({ client }: { client: MatrixClient }): JSX.Element {
    const [ready, setReady] = useState(false);
    useEffect(() => {
        current = new RcKitBridge(client);
        (window as unknown as { __rcKitSource?: unknown }).__rcKitSource = current.source;
        setReady(true);
        return () => {
            current?.dispose();
            current = undefined;
            delete (window as unknown as { __rcKitSource?: unknown }).__rcKitSource;
        };
    }, [client]);
    if (!ready) return <div />;
    return (
        <iframe
            title="Rocket.Chat view"
            src="rc-kit/index.html"
            style={{ border: 0, position: "fixed", inset: 0, width: "100vw", height: "100vh" }}
        />
    );
}
