/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import {
    type EventTimeline,
    EventType,
    MatrixEvent,
    MatrixEventEvent,
    type MatrixClient,
    RoomEvent,
} from "matrix-js-sdk/src/matrix";
import { EventEmitter } from "node:events";
import { mkEvent, mkRoom, mkRoomMember, stubClient } from "test-utils";

import { CallStoreEvent, type CallStore } from "./CallStore";
import { LatestRtcNotificationEventStore } from "./LatestRtcNotificationEventStore";
import { type ElementCall, type Call } from "../models/Call";

type CryptoBackend = Parameters<MatrixEvent["attemptDecryption"]>[0];

describe("LatestRtcNotificationEventStore", () => {
    it("should populate map from timeline on start", async () => {
        const cli = stubClient();

        const event1 = mkEvent({
            type: EventType.RTCNotification,
            user: "@alice:m.org",
            content: {},
            event: true,
            id: "event-1",
        });
        const room1 = mkRoom(cli, "!my-room1:m.org");
        vi.spyOn(room1, "getLiveTimeline").mockImplementation(() => {
            return {
                getEvents: () => {
                    return [event1];
                },
            } as unknown as EventTimeline;
        });

        const event2 = mkEvent({
            type: EventType.RTCNotification,
            user: "@bob:m.org",
            content: {},
            event: true,
            id: "event-2",
        });
        const room2 = mkRoom(cli, "!my-room2:m.org");
        vi.spyOn(room2, "getLiveTimeline").mockImplementation(() => {
            return {
                getEvents: () => {
                    return [event2];
                },
            } as unknown as EventTimeline;
        });

        vi.spyOn(cli, "getRoom").mockImplementation((roomId) => (roomId === "!my-room1:m.org" ? room1 : room2));

        const callStore = new EventEmitter() as unknown as CallStore;
        callStore.getAllCalls = () => {
            return new Map([
                ["!my-room1:m.org", undefined],
                ["!my-room2:m.org", undefined],
            ]) as unknown as Map<string, Call>;
        };

        const store = new LatestRtcNotificationEventStore(callStore);
        vi.spyOn(store, "matrixClient", "get").mockReturnValue(cli);
        store.start();
        await vi.waitFor(() => {
            expect(store.getLatestEventId("!my-room1:m.org")).toStrictEqual("event-1");
            expect(store.getLatestEventId("!my-room2:m.org")).toStrictEqual("event-2");
        });
    });

    it("should wait for rtc notification event when a call begins", async () => {
        const cli = stubClient();

        // This is the last notification event in the timeline
        const oldNotificationEvent = mkEvent({
            type: EventType.RTCNotification,
            user: "@alice:m.org",
            content: {
                "m.relates_to": {
                    event_id: "$GOr0aimJwcQcPV4F20IEhBCpandNPMEfhWYfpcK3VeE",
                    rel_type: "m.reference",
                },
            },
            event: true,
            id: "event-1",
        });

        // This is the notification event corresponding to the ongoing call which hasn't come in yet
        const newNotificationEvent = mkEvent({
            type: EventType.RTCNotification,
            user: "@alice:m.org",
            content: {
                "m.relates_to": {
                    event_id: "call-membership-1",
                    rel_type: "m.reference",
                },
            },
            event: true,
            id: "event-2",
        });

        // The call membership event associated with newNotificationEvent
        const callMembershipEvent = mkEvent({
            type: EventType.GroupCallMemberPrefix,
            user: "@alice:m.org",
            content: {},
            event: true,
            id: "call-membership-1",
        });

        // The room where this call takes place
        const room = mkRoom(cli, "!my-room1:m.org");
        vi.spyOn(cli, "getRoom").mockImplementation(() => room);

        // The current timeline in that room
        const timeline = [oldNotificationEvent];
        vi.spyOn(room, "getLiveTimeline").mockImplementation(() => {
            return {
                getEvents: () => {
                    return timeline;
                },
            } as unknown as EventTimeline;
        });

        const call = new EventEmitter();
        // @ts-ignore
        call.participants = new Map([[mkRoomMember("!my-room1:m.org", "@alice:m.org"), new Set()]]);
        // @ts-ignore
        call.session = {
            memberships: [{ eventId: callMembershipEvent.getId() }],
        };

        const callStore = new EventEmitter() as unknown as CallStore;
        callStore.getAllCalls = () => {
            return new Map([]) as unknown as Map<string, Call>;
        };
        callStore.getCall = () => call as unknown as ElementCall;

        const store = new LatestRtcNotificationEventStore(callStore);
        vi.spyOn(store, "matrixClient", "get").mockReturnValue(cli);
        store.start();

        // No calls in the room yet
        expect(store.getLatestEventId("!my-room1:m.org")).toBeUndefined();

        // Let's say a new call starts
        callStore.emit(CallStoreEvent.Call, call, "!my-room1:m.org");

        // The correct notification event hasn't come in yet, so still undefined.
        expect(store.getLatestEventId("!my-room1:m.org")).toBeUndefined();

        // Notification event comes in
        room.emit(RoomEvent.Timeline, newNotificationEvent);

        // Should update the event id in store
        await vi.waitFor(() => {
            expect(store.getLatestEventId("!my-room1:m.org")).toStrictEqual("event-2");
        });
    });

    describe("encrypted rooms", () => {
        const roomId = "!my-room1:m.org";

        /** A notification as it arrives from sync in an encrypted room: still m.room.encrypted, decrypts later. */
        function mkEncryptedNotification(): { event: MatrixEvent; crypto: CryptoBackend } {
            const event = new MatrixEvent({
                type: EventType.RoomMessageEncrypted,
                sender: "@bob:m.org",
                room_id: roomId,
                event_id: "event-2",
                content: {
                    "algorithm": "m.megolm.v1.aes-sha2",
                    "ciphertext": "AwgA",
                    "m.relates_to": { event_id: "call-membership-1", rel_type: "m.reference" },
                },
            });
            const crypto = {
                decryptEvent: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 40));
                    return {
                        clearEvent: {
                            type: EventType.RTCNotification,
                            content: { "m.relates_to": { event_id: "call-membership-1", rel_type: "m.reference" } },
                        },
                    };
                },
            } as unknown as CryptoBackend;
            return { event, crypto };
        }

        /** A crypto backend that has no key (yet): decryption fails and the event becomes m.bad.encrypted. */
        const failingCrypto = {
            decryptEvent: async () => {
                throw new Error("no key");
            },
        } as unknown as CryptoBackend;

        function setup(
            cli: MatrixClient,
            timelineEvents: MatrixEvent[] = [],
        ): { store: LatestRtcNotificationEventStore; room: ReturnType<typeof mkRoom> } {
            const room = mkRoom(cli, roomId);
            vi.spyOn(cli, "getRoom").mockImplementation(() => room);
            vi.spyOn(room, "getLiveTimeline").mockImplementation(
                () => ({ getEvents: () => timelineEvents }) as unknown as EventTimeline,
            );

            const call = new EventEmitter();
            // @ts-ignore
            call.participants = new Map([[mkRoomMember(roomId, "@bob:m.org"), new Set()]]);
            // @ts-ignore
            call.session = { memberships: [{ eventId: "call-membership-1" }] };

            const callStore = new EventEmitter() as unknown as CallStore;
            callStore.getAllCalls = () => new Map([]) as unknown as Map<string, Call>;
            callStore.getCall = () => call as unknown as ElementCall;

            const store = new LatestRtcNotificationEventStore(callStore);
            vi.spyOn(store, "matrixClient", "get").mockReturnValue(cli);
            store.start();
            callStore.emit(CallStoreEvent.Call, call, roomId);
            return { store, room };
        }

        it("should match an encrypted notification that is decrypted after the timeline event", async () => {
            const cli = stubClient();
            const { event, crypto } = mkEncryptedNotification();
            // What MatrixClient.decryptEventIfNeeded does, with the fake crypto backend.
            vi.spyOn(cli, "decryptEventIfNeeded").mockImplementation(async (e) => {
                if (e.shouldAttemptDecryption()) void e.attemptDecryption(crypto);
                await e.getDecryptionPromise();
            });
            const { store, room } = setup(cli);

            // The timeline fires while the event is still encrypted and decryption has not started; the SDK's own
            // pipeline decrypts it a moment later.
            room.emit(RoomEvent.Timeline, event);
            setTimeout(() => {
                if (event.shouldAttemptDecryption()) void event.attemptDecryption(crypto);
            }, 20);

            await vi.waitFor(() => expect(store.getLatestEventId(roomId)).toStrictEqual("event-2"), { timeout: 1000 });
        });

        it("should match once the event is decrypted when the client could not start decryption", async () => {
            const cli = stubClient();
            const { event, crypto } = mkEncryptedNotification();
            vi.spyOn(cli, "decryptEventIfNeeded").mockResolvedValue(undefined);
            const { store, room } = setup(cli);

            room.emit(RoomEvent.Timeline, event);
            setTimeout(() => void event.attemptDecryption(crypto), 20);

            await vi.waitFor(() => expect(store.getLatestEventId(roomId)).toStrictEqual("event-2"), { timeout: 1000 });
        });

        describe("when the first decryption fails", () => {
            it("should match when a later decryption of a new timeline event succeeds", async () => {
                const cli = stubClient();
                const { event, crypto } = mkEncryptedNotification();
                vi.spyOn(cli, "decryptEventIfNeeded").mockImplementation(async (e) => {
                    await e.attemptDecryption(failingCrypto);
                });
                const { store, room } = setup(cli);

                room.emit(RoomEvent.Timeline, event);
                await vi.waitFor(() => expect(event.isDecryptionFailure()).toBe(true));
                // A failed decryption leaves a clear type, the event is not m.room.encrypted any more.
                expect(event.getType()).not.toBe(EventType.RoomMessageEncrypted);
                expect(store.getLatestEventId(roomId)).toBeUndefined();

                // The key arrives and decryption is retried.
                await event.attemptDecryption(crypto);

                await vi.waitFor(() => expect(store.getLatestEventId(roomId)).toStrictEqual("event-2"), {
                    timeout: 1000,
                });
                expect(event.listenerCount(MatrixEventEvent.Decrypted)).toBe(0);
            });

            it("should match a notification that was already on the timeline, undecryptable", async () => {
                const cli = stubClient();
                const { event, crypto } = mkEncryptedNotification();
                vi.spyOn(cli, "decryptEventIfNeeded").mockImplementation(async (e) => {
                    await e.attemptDecryption(failingCrypto);
                });
                const { store } = setup(cli, [event]);

                await vi.waitFor(() => expect(event.listenerCount(MatrixEventEvent.Decrypted)).toBe(1));
                expect(store.getLatestEventId(roomId)).toBeUndefined();

                await event.attemptDecryption(crypto);

                await vi.waitFor(() => expect(store.getLatestEventId(roomId)).toStrictEqual("event-2"), {
                    timeout: 1000,
                });
                expect(event.listenerCount(MatrixEventEvent.Decrypted)).toBe(0);
            });

            it("should remove the decryption listeners when no notification arrives", async () => {
                vi.useFakeTimers();
                try {
                    const cli = stubClient();
                    const { event } = mkEncryptedNotification();
                    vi.spyOn(cli, "decryptEventIfNeeded").mockImplementation(async (e) => {
                        await e.attemptDecryption(failingCrypto);
                    });
                    const { store } = setup(cli, [event]);
                    await vi.advanceTimersByTimeAsync(100);
                    expect(event.listenerCount(MatrixEventEvent.Decrypted)).toBe(1);

                    await vi.advanceTimersByTimeAsync(10_001);
                    expect(event.listenerCount(MatrixEventEvent.Decrypted)).toBe(0);
                    expect(store.getLatestEventId(roomId)).toBeUndefined();
                } finally {
                    vi.useRealTimers();
                }
            });
        });

        it("should not leave an unhandled rejection when no notification arrives", async () => {
            vi.useFakeTimers();
            try {
                const cli = stubClient();
                const { store } = setup(cli);
                await vi.advanceTimersByTimeAsync(10_001);
                expect(store.getLatestEventId(roomId)).toBeUndefined();
            } finally {
                vi.useRealTimers();
            }
        });
    });
});
