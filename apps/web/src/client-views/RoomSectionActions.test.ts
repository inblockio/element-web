/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { type Room } from "matrix-js-sdk/src/matrix";

import Modal from "../Modal";
import { createSection, setSection, type RoomSectionVm } from "./RoomSectionActions";
import { ROOM_ACTION_TIMEOUT_MS } from "./RoomActions";
import { ClientViewActionError } from "./types";

vi.mock("../Modal", () => ({ default: { createDialog: vi.fn() } }));
const store = vi.hoisted(() => ({ createSection: vi.fn() }));
vi.mock("../stores/room-list-v3/RoomListStoreV3", () => ({ default: { instance: store } }));

/* M6 B1: the outcome of each section action is read where the view-model leaves it (the room's own tags, the dialog's answer). */
const A = "element.io.section.aaa";
const B = "element.io.section.bbb";
type Snap = ReturnType<RoomSectionVm["getSnapshot"]>;

const snap = (over: Partial<Snap> = {}): Snap => ({
    sections: [
        { tag: A, name: "Work", isSelected: false },
        { tag: B, name: "Home", isSelected: false },
    ],
    canChangeSection: true,
    notification: { invited: false },
    ...over,
});

function makeItem(s: Snap = snap()): RoomSectionVm & {
    onToggleSection: Mock<(tag: string) => void>;
    onRemoveFromSection: Mock<() => void>;
} {
    return { getSnapshot: () => s, onToggleSection: vi.fn(), onRemoveFromSection: vi.fn() };
}

const room = (tags: Record<string, unknown> = {}): Room => ({ roomId: "!a:example.org", tags }) as unknown as Room;
const setTags = (r: Room, tags: Record<string, unknown>): void =>
    void ((r as unknown as { tags: unknown }).tags = tags);

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
        await p;
    } catch (e) {
        expect(e).toBeInstanceOf(ClientViewActionError);
        return (e as ClientViewActionError).code;
    }
    return undefined;
};

describe("M6 B1 setSection (onToggleSection / onRemoveFromSection, the room's own tags)", () => {
    it("toggles into the section and is done once the room's tags show it", async () => {
        const r = room();
        const item = makeItem();
        item.onToggleSection.mockImplementation((tag) => void setTimeout(() => setTags(r, { [tag]: {} }), 120));
        expect(await setSection(item, r, A)).toEqual({ status: "done", roomId: "!a:example.org" });
        expect(item.onToggleSection).toHaveBeenCalledExactlyOnceWith(A);
        expect(item.onRemoveFromSection).not.toHaveBeenCalled();
    });

    it("moves a favourite into a section: the toggle replaces it (tagRoom's one-section rule), done when the section shows", async () => {
        const r = room({ "m.favourite": { order: 0.5 } });
        const item = makeItem();
        item.onToggleSection.mockImplementation((tag) => void setTimeout(() => setTags(r, { [tag]: {} }), 50));
        expect((await setSection(item, r, B)).status).toBe("done");
        expect(item.onToggleSection).toHaveBeenCalledExactlyOnceWith(B);
    });

    it("calls nothing when the room is in the section already (the toggle would take it out)", async () => {
        const item = makeItem();
        expect((await setSection(item, room({ [A]: {} }), A)).status).toBe("done");
        expect(item.onToggleSection).not.toHaveBeenCalled();
    });

    it("takes the room out of its custom section with null, and calls nothing for a room in none or a favourite", async () => {
        const r = room({ [A]: {} });
        const item = makeItem();
        item.onRemoveFromSection.mockImplementation(() => void setTimeout(() => setTags(r, {}), 50));
        expect((await setSection(item, r, null)).status).toBe("done");
        expect(item.onRemoveFromSection).toHaveBeenCalledOnce();
        expect((await setSection(item, room(), null)).status).toBe("done");
        expect((await setSection(item, room({ "m.favourite": {} }), null)).status).toBe("done");
        expect(item.onRemoveFromSection).toHaveBeenCalledOnce();
    });

    it("is unsupported for an invite, an archived room, a room Element lets no section change and a tag the list does not hold", async () => {
        expect(await codeOf(setSection(makeItem(snap({ notification: { invited: true } })), room(), A))).toBe(
            "unsupported",
        );
        expect(await codeOf(setSection(makeItem(), room({ "im.vector.fake.archived": {} }), A))).toBe("unsupported");
        expect(await codeOf(setSection(makeItem(snap({ canChangeSection: false })), room(), A))).toBe("unsupported");
        const item = makeItem();
        expect(await codeOf(setSection(item, room(), "element.io.section.zzz"))).toBe("unsupported");
        expect(await codeOf(setSection(item, room(), "m.favourite"))).toBe("unsupported");
        expect(item.onToggleSection).not.toHaveBeenCalled();
    });

    it("ignores a stale custom tag of a section the list no longer holds", async () => {
        const item = makeItem();
        const r = room({ "element.io.section.gone": {} });
        item.onToggleSection.mockImplementation((tag) => void setTimeout(() => setTags(r, { [tag]: {} }), 20));
        expect((await setSection(item, r, A)).status).toBe("done");
        expect(item.onToggleSection).toHaveBeenCalledOnce();
    });

    it("runs overlapping calls for one room one after the other", async () => {
        const r = room();
        const item = makeItem();
        const order: string[] = [];
        item.onToggleSection.mockImplementation((tag) => {
            order.push(`to ${tag}`);
            setTimeout(() => setTags(r, { [tag]: {} }), 100);
        });
        item.onRemoveFromSection.mockImplementation(() => {
            order.push("out");
            setTimeout(() => setTags(r, {}), 100);
        });
        const first = setSection(item, r, A);
        const second = setSection(item, r, null);
        expect((await first).status).toBe("done");
        expect((await second).status).toBe("done");
        expect(order).toEqual([`to ${A}`, "out"]);
    });

    it("is network (may still apply) when the room's tags do not show it in time", async () => {
        vi.useFakeTimers();
        try {
            const result = codeOf(setSection(makeItem(), room(), A));
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
            expect(await result).toBe("network");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("M6 B1 fix round 1 (grok F1-F4)", () => {
    const FAV = "m.favourite";
    // A fresh room per case: a case that times out leaves its tag queue busy for the room.
    let n = 0;
    const fresh = (tags: Record<string, unknown> = {}): Room =>
        ({ roomId: `!f${++n}:example.org`, tags }) as unknown as Room;

    it("F1: setSection into a section is not done while the favourite tag still owns the room", async () => {
        vi.useFakeTimers();
        try {
            const r = fresh({ [FAV]: { order: 0.5 } });
            const item = makeItem();
            // tagRoom's two writes: the add lands, the delete is refused (Element's error dialog), the favourite stays.
            item.onToggleSection.mockImplementation(
                (tag) => void setTimeout(() => setTags(r, { [FAV]: {}, [tag]: {} }), 100),
            );
            const result = codeOf(setSection(item, r, A));
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
            expect(await result).toBe("network");
        } finally {
            vi.useRealTimers();
        }
    });

    it("F1: the intermediate state (section added, favourite not yet gone) is not done, the final one is", async () => {
        const r = fresh({ [FAV]: {} });
        const item = makeItem();
        item.onToggleSection.mockImplementation((tag) => {
            setTimeout(() => setTags(r, { [FAV]: {}, [tag]: {} }), 50);
            setTimeout(() => setTags(r, { [tag]: {} }), 400);
        });
        const started = Date.now();
        expect((await setSection(item, r, A)).status).toBe("done");
        expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    });

    it("F2: setSection(null) on a room holding the favourite and a section writes nothing that could drop the favourite", async () => {
        vi.useFakeTimers();
        try {
            const r = fresh({ [FAV]: {}, [A]: {} });
            const item = makeItem();
            // What tagRoom does for the first ordered tag of the room, the favourite: it is deleted, the section stays.
            item.onRemoveFromSection.mockImplementation(() => void setTimeout(() => setTags(r, { [A]: {} }), 50));
            const result = codeOf(setSection(item, r, null));
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
            expect(await result).toBe("unsupported");
            expect(item.onRemoveFromSection).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("F2: moving a room that holds the section first and a favourite into that section does not take the section out", async () => {
        const r = fresh({ [A]: {}, [FAV]: {} });
        const item = makeItem();
        expect(await codeOf(setSection(item, r, A))).toBe("unsupported");
        expect(item.onToggleSection).not.toHaveBeenCalled();
    });

    it("F3: createSection takes its turn in the room's tag queue: the store is not asked while an earlier tag write is pending", async () => {
        vi.useFakeTimers();
        try {
            const r = fresh();
            const item = makeItem();
            item.onToggleSection.mockImplementation((tag) => void setTimeout(() => setTags(r, { [tag]: {} }), 2_000));
            const finished = Promise.resolve([undefined, undefined]);
            (Modal as unknown as { createDialog: unknown }).createDialog = vi.fn(() => ({ close: vi.fn(), finished }));
            store.createSection.mockReset();
            store.createSection.mockImplementation(() => {
                (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {});
                return Promise.resolve(undefined);
            });
            const first = setSection(item, r, A);
            const created = createSection(r);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(store.createSection).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(2_000);
            await first;
            await expect(created).resolves.toEqual({ status: "cancelled" });
            expect(store.createSection).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it("F3: createSection is not done while an older section still holds the room", async () => {
        vi.useFakeTimers();
        try {
            const r = fresh({ [B]: {} });
            const finished = Promise.resolve(["Projects", [r.roomId]]);
            (Modal as unknown as { createDialog: unknown }).createDialog = vi.fn(() => ({ close: vi.fn(), finished }));
            store.createSection.mockReset();
            store.createSection.mockImplementation(() => {
                (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {});
                return Promise.resolve(A);
            });
            const result = codeOf(createSection(r));
            await vi.advanceTimersByTimeAsync(100);
            setTags(r, { [B]: {}, [A]: {} });
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
            expect(await result).toBe("network");
        } finally {
            vi.useRealTimers();
        }
    });

    it("F4: a write that timed out and lands late is not answered as cleared by the next call", async () => {
        vi.useFakeTimers();
        try {
            const r = fresh();
            const item = makeItem();
            item.onToggleSection.mockImplementation(() => {});
            item.onRemoveFromSection.mockImplementation(() => void setTimeout(() => setTags(r, {}), 50));
            const first = codeOf(setSection(item, r, A));
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 100);
            expect(await first).toBe("network");
            // The first write lands late, a moment after the second call began.
            const second = setSection(item, r, null);
            await vi.advanceTimersByTimeAsync(1_000);
            setTags(r, { [A]: {} });
            await vi.advanceTimersByTimeAsync(1_000);
            expect((await second).status).toBe("done");
            expect(item.onRemoveFromSection).toHaveBeenCalledOnce();
            expect((r.tags as Record<string, unknown>)[A]).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("M6 B1 createSection (RoomListStoreV3.createSection -> Element's dialog)", () => {
    let finish: (...result: unknown[]) => void;
    let storeResult: (tag: string | undefined) => void;

    beforeEach(() => {
        vi.useFakeTimers();
        const finished = new Promise<unknown[]>((resolve) => {
            finish = (...result) => resolve(result);
        });
        (Modal as unknown as { createDialog: unknown }).createDialog = vi.fn(() => ({ close: vi.fn(), finished }));
        store.createSection.mockReset();
        // The store opens the dialog first, then (after its answer) writes the section: its promise ends with the tag.
        store.createSection.mockImplementation(() => {
            (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {});
            return new Promise<string | undefined>((resolve) => (storeResult = resolve));
        });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("is done with the new tag once the store wrote the section (no room preselected)", async () => {
        const outcome = createSection(undefined);
        await vi.advanceTimersByTimeAsync(0);
        finish("Projects", []);
        await vi.advanceTimersByTimeAsync(0);
        storeResult(A);
        await expect(outcome).resolves.toEqual({ status: "done", section: A });
        expect(store.createSection).toHaveBeenCalledExactlyOnceWith(undefined);
    });

    it("preselects the room and is done only once the room's tags show the new section", async () => {
        const r = room();
        const outcome = createSection(r);
        await vi.advanceTimersByTimeAsync(0);
        finish("Projects", ["!a:example.org"]);
        await vi.advanceTimersByTimeAsync(0);
        storeResult(A);
        let settled = false;
        void outcome.then(() => (settled = true));
        await vi.advanceTimersByTimeAsync(500);
        expect(settled).toBe(false);
        setTags(r, { [A]: {} });
        await vi.advanceTimersByTimeAsync(100);
        await expect(outcome).resolves.toEqual({ status: "done", section: A, roomId: "!a:example.org" });
        expect(store.createSection).toHaveBeenCalledExactlyOnceWith("!a:example.org");
    });

    it("does not wait for a preselected room the user deselected in the dialog", async () => {
        const outcome = createSection(room());
        await vi.advanceTimersByTimeAsync(0);
        finish("Projects", []);
        await vi.advanceTimersByTimeAsync(0);
        storeResult(A);
        await expect(outcome).resolves.toMatchObject({ status: "done", section: A });
    });

    it("is cancelled when the dialog closes without a name", async () => {
        const outcome = createSection(undefined);
        await vi.advanceTimersByTimeAsync(0);
        finish(undefined, undefined);
        await vi.advanceTimersByTimeAsync(0);
        storeResult(undefined);
        await expect(outcome).resolves.toEqual({ status: "cancelled" });
    });

    it("is network when the preselected room does not show the section in time", async () => {
        const outcome = codeOf(createSection(room()));
        await vi.advanceTimersByTimeAsync(0);
        finish("Projects", ["!a:example.org"]);
        await vi.advanceTimersByTimeAsync(0);
        storeResult(A);
        await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
        expect(await outcome).toBe("network");
    });

    it("maps a store write that fails to the contract's error", async () => {
        store.createSection.mockImplementation(() => {
            (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {});
            return new Promise<string | undefined>(
                (_, reject) => (storeResult = () => reject(new Error("account data refused"))),
            );
        });
        const outcome = codeOf(createSection(undefined));
        await vi.advanceTimersByTimeAsync(0);
        finish("Projects", []);
        await vi.advanceTimersByTimeAsync(0);
        storeResult(undefined);
        expect(await outcome).toBe("failed");
    });
});
