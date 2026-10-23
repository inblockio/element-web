/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import {
    type EmptyObject,
    EventType,
    type MatrixClient,
    type MatrixEvent,
    MatrixEventEvent,
    type Room,
    RoomEvent,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { AsyncStoreWithClient } from "./AsyncStoreWithClient";
import defaultDispatcher from "../dispatcher/dispatcher";
import { type CallStore, CallStoreEvent } from "./CallStore";
import { CallEvent, type ElementCall } from "../models/Call";

/**
 * The event that {@link LatestRtcNotificationEventStore} emits when the latest event id changes.
 */
export const LatestRtcNotificationEventUpdate = "rtc_notification_updated";

/**
 * This store tracks the event-id of the {@link EventType.RTCNotification} event that
 * is related to an ongoing call.
 * This is required because the rtc notification arrives after the call has started.
 * Without this logic, we wouldn't know whether the last rtc notification tile in the
 * timeline is related to an ongoing call or if it is related to some other rtc notification
 * event that is yet to come through sync.
 */
export class LatestRtcNotificationEventStore extends AsyncStoreWithClient<EmptyObject> {
    private eventIdMap = new Map<string, string>();

    public constructor(private readonly callStore: CallStore) {
        super(defaultDispatcher);
    }

    /**
     * Get the event id of the latest rtc notification event corresponding to an ongoing call.
     * @param roomId The id of the room where the call is taking place
     * @returns event id or undefined
     */
    public getLatestEventId(roomId: string): string | undefined {
        return this.eventIdMap.get(roomId);
    }

    private async populateMap(): Promise<void> {
        if (!this.matrixClient) return;

        // 1. Get all the calls
        const callMap = this.callStore.getAllCalls();
        // 2. Add the calls to our map
        for (const roomId of callMap.keys()) {
            const room = this.getRoom(roomId);
            const eventId = (await getLastRtcNotificationEvent(this.matrixClient, room))?.getId();
            if (eventId) {
                this.eventIdMap.set(roomId, eventId);
                // 3. Emit event so that the call tile can re-render
                this.emit(LatestRtcNotificationEventUpdate, roomId, eventId);
            }
        }
    }

    private getRoom(roomId: string): Room {
        if (!this.matrixClient) {
            throw new Error("LatestRtcNotificationEventStore: this.matrixClient is undefined.");
        }

        const room = this.matrixClient.getRoom(roomId);
        if (!room) throw new Error(`No room associated with room-id ${roomId}`);
        return room;
    }

    protected async onReady(): Promise<void> {
        this.callStore.on(CallStoreEvent.Call, this.onCallStoreEvent);
        await this.populateMap();
    }

    protected async onNotReady(): Promise<void> {
        this.callStore.off(CallStoreEvent.Call, this.onCallStoreEvent);
        this.eventIdMap.clear();
    }

    protected async onAction(): Promise<void> {
        // nothing to do
    }

    private onCallStoreEvent = async (_: unknown, roomId: string): Promise<void> => {
        if (!this.matrixClient) return;
        const call = this.callStore.getCall(roomId) as ElementCall;
        if (!call) {
            // If there's no longer a call in this room, remove entry from map
            this.eventIdMap.delete(roomId);
        } else if (call && !this.eventIdMap.has(roomId)) {
            // If there's a call, find the event id and add it to the map.
            if (call.participants.size) {
                void this.findAndSetNotificationEvent(call, roomId);
            } else {
                // This call just started but the participants haven't been added yet.
                // So wait until participants are added and then compute the event id.
                call.once(CallEvent.Participants, () => {
                    void this.findAndSetNotificationEvent(call, roomId);
                });
            }
        }
    };

    private async findAndSetNotificationEvent(call: ElementCall, roomId: string): Promise<void> {
        const room = this.getRoom(roomId);
        // Since we're running this logic as the call just started, this membership
        // event probably (but not necessarily! TODO: do something more robust)
        // corresponds to the person who started the call.
        // The rtc notification event corresponding to this ongoing call will
        // hopefully have a reference relation to this membership event.
        const oldestActiveMembership = call.session.memberships.at(0);

        if (oldestActiveMembership) {
            try {
                const eventId = await getNotificationEventId(this.matrixClient!, room, oldestActiveMembership.eventId);
                this.eventIdMap.set(roomId, eventId);
                this.emit(LatestRtcNotificationEventUpdate, roomId, eventId);
            } catch (e) {
                logger.warn(`LatestRtcNotificationEventStore: no rtc notification event for call in ${roomId}`, e);
            }
        }
    }
}

/**
 * Starts decrypting the event if that has not started yet and waits for it. Events from the timeline are still
 * encrypted and have no decryption promise at the time RoomEvent.Timeline fires, so
 * `event.getDecryptionPromise()` alone would return too early. A failed decryption is not an error here, the
 * event just keeps its encrypted type.
 */
async function decryptIfNeeded(client: MatrixClient, event: MatrixEvent): Promise<void> {
    try {
        await client.decryptEventIfNeeded(event);
    } catch {
        // stays undecrypted
    }
}

/**
 * Returns the first rtc notification event from the end of the timeline
 */
async function getLastRtcNotificationEvent(client: MatrixClient, room: Room): Promise<MatrixEvent | undefined> {
    const events = room.getLiveTimeline().getEvents();
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        // Start decryption if it has not started yet, and wait for it
        await decryptIfNeeded(client, event);
        if (event.getType() === EventType.RTCNotification) {
            return event;
        }
    }
}

/**
 * Get the event id of the rtc notification event that has a relation to a given call membership event.
 * @param room The room in which this call is taking place
 * @param callMemberEventId The event id of the call membership event
 * @returns A promise that resolves to the event-id of the notification event.
 */
async function getNotificationEventId(client: MatrixClient, room: Room, callMemberEventId: string): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();

    // Events that are still encrypted when they reach the timeline, and whose decryption we are waiting for.
    const pending = new Set<MatrixEvent>();
    const cleanup = (): void => {
        room.off(RoomEvent.Timeline, onNewEvent);
        for (const event of pending) event.off(MatrixEventEvent.Decrypted, check);
        pending.clear();
        clearTimeout(timer);
    };

    // Resolves if the (decrypted) event is the notification that relates to the call membership event.
    const check = (event: MatrixEvent): void => {
        const type = event.getType();
        const relatedEventId = event.getRelation()?.event_id;
        const eventId = event.getId();

        if (type === EventType.RTCNotification && relatedEventId === callMemberEventId && eventId) {
            cleanup();
            resolve(eventId);
        }
    };

    // This callback will run with new events that are added to the timeline.
    // We'll run some logic in the callback to see if we're receiving any
    // new notification event that corresponds to the call membership event.
    const onNewEvent = async (event: MatrixEvent): Promise<void> => {
        // The timeline fires before decryption has started, so start it here (event.getDecryptionPromise() would be
        // undefined) and check the decrypted type, not the encrypted one.
        await decryptIfNeeded(client, event);
        check(event);

        // Fallback if it is still not decrypted (e.g. the keys arrive later): check again once it is.
        if (event.isEncrypted() && event.getType() === EventType.RoomMessageEncrypted) {
            pending.add(event);
            event.once(MatrixEventEvent.Decrypted, check);
        }
    };
    room.on(RoomEvent.Timeline, onNewEvent);

    // We won't wait for more than ten seconds for the notification event to come through.
    const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timeout waiting for rtc notification event"));
    }, 10000);

    // We might already have the notification event in the timeline. Scan it after the listener is registered, so an
    // event that arrives while older events are still decrypting is not missed.
    const latest = await getLastRtcNotificationEvent(client, room);
    const latestId = latest?.getId();
    if (latest?.getRelation()?.event_id === callMemberEventId && latestId) {
        cleanup();
        return latestId;
    }

    return await promise;
}
