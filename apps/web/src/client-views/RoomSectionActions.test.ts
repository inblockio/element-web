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
import SettingsStore from "../settings/SettingsStore";
import {
    createSection,
    editSection,
    moveSection,
    removeSection,
    setSection,
    type RoomSectionVm,
} from "./RoomSectionActions";
import { setFavourite } from "./RoomItemActions";
import { ROOM_ACTION_TIMEOUT_MS } from "./RoomActions";
import { ClientViewActionError } from "./types";

vi.mock("../Modal", async () => {
    const { EventEmitter } = await import("events");
    const manager = Object.assign(new EventEmitter(), {
        createDialog: vi.fn(),
        modals: [] as object[],
        priorityModal: null as object | null,
        staticModal: null as object | null,
    });
    return { default: manager, ModalManagerEvent: { Opened: "opened", Closed: "closed" } };
});
const store = vi.hoisted(() => ({
    createSection: vi.fn(),
    editSection: vi.fn(),
    removeSection: vi.fn(),
    reorderSection: vi.fn(),
}));
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

    it("F3: createSection does not report the room moved while an older section still holds it (done with the section only, F4 round 2)", async () => {
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
            const result = createSection(r);
            await vi.advanceTimersByTimeAsync(100);
            setTags(r, { [B]: {}, [A]: {} });
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
            expect(await result).toEqual({ status: "done", section: A });
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

describe("M6 B1 fix round 2 (grok delta F1-F4): a room holding several section tags is read-only for moves", () => {
    const FAV = "m.favourite";
    let n = 0;
    const fresh = (tags: Record<string, unknown> = {}): Room =>
        ({ roomId: `!g${++n}:example.org`, tags }) as unknown as Room;
    const several = [
        ["favourite first, section second", { [FAV]: {}, [A]: {} }],
        ["section first, favourite second", { [A]: {}, [FAV]: {} }],
        ["two custom sections", { [A]: {}, [B]: {} }],
    ] as const;

    for (const [label, tags] of several) {
        for (const target of [null, A, B] as const) {
            it(`F1/F2: setSection(${target === null ? "null" : target === A ? "A" : "B"}) on ${label} is unsupported and writes nothing`, async () => {
                const r = fresh({ ...tags });
                const item = makeItem();
                expect(await codeOf(setSection(item, r, target))).toBe("unsupported");
                expect(item.onToggleSection).not.toHaveBeenCalled();
                expect(item.onRemoveFromSection).not.toHaveBeenCalled();
            });
        }

        it(`F3: setFavourite on/off on ${label} is unsupported and writes nothing`, async () => {
            const r = fresh({ ...tags });
            const onToggleFavorite = vi.fn();
            const item = { ...makeItem(), onToggleFavorite, getSnapshot: () => snap() } as unknown as Parameters<
                typeof setFavourite
            >[0];
            expect(await codeOf(setFavourite(item, r, false))).toBe("unsupported");
            expect(await codeOf(setFavourite(item, r, true))).toBe("unsupported");
            expect(onToggleFavorite).not.toHaveBeenCalled();
        });

        it(`createSection with a room that holds ${label} is unsupported: no dialog, nothing written`, async () => {
            const r = fresh({ ...tags });
            store.createSection.mockReset();
            expect(await codeOf(createSection(r))).toBe("unsupported");
            expect(store.createSection).not.toHaveBeenCalled();
        });
    }

    it("a room with one section tag and low priority counts as several", async () => {
        const item = makeItem();
        expect(await codeOf(setSection(item, fresh({ "m.lowpriority": {}, [A]: {} }), B))).toBe("unsupported");
        expect(item.onToggleSection).not.toHaveBeenCalled();
    });

    it("F4: createSection answers done with the new section when the store saved it but the room's move did not settle", async () => {
        vi.useFakeTimers();
        try {
            const r = fresh({ [FAV]: {} });
            const finished = Promise.resolve(["Projects", [r.roomId]]);
            (Modal as unknown as { createDialog: unknown }).createDialog = vi.fn(() => ({ close: vi.fn(), finished }));
            store.createSection.mockReset();
            store.createSection.mockImplementation(() => {
                (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {});
                return Promise.resolve(A);
            });
            const result = createSection(r);
            await vi.advanceTimersByTimeAsync(100);
            // The add landed, the favourite's delete was refused.
            setTags(r, { [FAV]: {}, [A]: {} });
            await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
            expect(await result).toEqual({ status: "done", section: A });
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

    it("is done with the section, without the room, when the preselected room does not show it in time", async () => {
        const outcome = createSection(room());
        await vi.advanceTimersByTimeAsync(0);
        finish("Projects", ["!a:example.org"]);
        await vi.advanceTimersByTimeAsync(0);
        storeResult(A);
        await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
        expect(await outcome).toEqual({ status: "done", section: A });
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

describe("createSection: a confirmed dialog answer wins over the drop signal (Modal.tsx resolves `finished`, then emits `closed`)", () => {
    it("is done with the new tag, not cancelled, when the dialog closes on the answer", async () => {
        vi.useFakeTimers();
        try {
            const fake = Modal as unknown as { createDialog: unknown; modals: object[]; emit: (e: string) => void };
            const modal = {};
            let resolve: (r: unknown[]) => void = () => {};
            const finished = new Promise<unknown[]>((r) => (resolve = r));
            fake.createDialog = vi.fn(() => {
                fake.modals.unshift(modal);
                return { close: vi.fn(), finished };
            });
            store.createSection.mockReset();
            store.createSection.mockImplementation(() => {
                (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {});
                return Promise.resolve(A);
            });
            const outcome = createSection(undefined);
            await vi.advanceTimersByTimeAsync(0);
            resolve(["Projects", []]);
            fake.modals = fake.modals.filter((m) => m !== modal);
            fake.emit("closed");
            await vi.advanceTimersByTimeAsync(0);
            await expect(outcome).resolves.toEqual({ status: "done", section: A });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("createSection: a dialog dropped by Modal.tsx's priority/static wipe (grok delta2 F1)", () => {
    type Fake = { createDialog: unknown; modals: object[]; emit: (e: string) => void };

    /** Opens create-section, then drops its dialog: `finished` never settles and the store's promise never ends. */
    async function openAndDrop(r: Room | undefined): Promise<{ outcome: Promise<unknown> }> {
        const fake = Modal as unknown as Fake;
        const modal = {};
        fake.createDialog = vi.fn(() => {
            fake.modals.unshift(modal);
            return { close: vi.fn(), finished: new Promise<unknown[]>(() => {}) };
        });
        store.createSection.mockReset();
        store.createSection.mockImplementation(() => {
            (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {});
            return new Promise<string | undefined>(() => {});
        });
        const outcome = createSection(r);
        await vi.advanceTimersByTimeAsync(0);
        fake.modals = fake.modals.filter((m) => m !== modal);
        fake.emit("closed");
        return { outcome };
    }

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        (Modal as unknown as Fake).modals = [];
    });

    it("answers cancelled in bounded time and accepts the next dialog action", async () => {
        const { outcome } = await openAndDrop(undefined);
        await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
        await expect(outcome).resolves.toEqual({ status: "cancelled" });

        (Modal as unknown as { createDialog: unknown }).createDialog = vi.fn(() => ({
            close: vi.fn(),
            finished: Promise.resolve([undefined, undefined]),
        }));
        store.createSection.mockReset();
        store.createSection.mockImplementation(() => {
            (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {});
            return Promise.resolve(undefined);
        });
        const next = createSection(undefined);
        await vi.advanceTimersByTimeAsync(0);
        await expect(next).resolves.toEqual({ status: "cancelled" });
    });

    it("with a room: the room's tag queue drains, so the next tag write for the room starts", async () => {
        const r = room();
        const { outcome } = await openAndDrop(r);
        await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
        await expect(outcome).resolves.toEqual({ status: "cancelled" });

        const item = makeItem();
        item.onToggleSection.mockImplementation((tag) => void setTimeout(() => setTags(r, { [tag]: {} }), 50));
        const next = setSection(item, r, A);
        await vi.advanceTimersByTimeAsync(500);
        expect(item.onToggleSection).toHaveBeenCalledExactlyOnceWith(A);
        await expect(next).resolves.toMatchObject({ status: "done" });
    });
});

describe("M10 W23 editSection / removeSection (RoomListStoreV3 -> Element's dialogs, answered from the dialog result)", () => {
    type Fake = { createDialog: unknown; modals: object[]; emit: (e: string) => void };
    type Stored = Record<string, { tag: string; name: string }>;

    let finish: (...result: unknown[]) => void;
    let storeResult: (error?: Error) => void;
    /** `RoomList.CustomSectionData` as the account data holds it (what `SettingsStore.getValue` reads once the local echo expired). */
    let stored: Stored;
    let getValue: ReturnType<typeof vi.spyOn>;
    const open = (fn: typeof store.editSection): void => {
        fn.mockReset();
        fn.mockImplementation(() => {
            (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {});
            return new Promise<void>((resolve, reject) => (storeResult = (e) => (e ? reject(e) : resolve())));
        });
    };
    const rename = (tag: string, name: string): void => void (stored[tag] = { tag, name });

    beforeEach(() => {
        vi.useFakeTimers();
        stored = { [A]: { tag: A, name: "Work" }, [B]: { tag: B, name: "Home" } };
        getValue = vi
            .spyOn(SettingsStore, "getValue")
            .mockImplementation(((name: string) =>
                name === "RoomList.CustomSectionData" ? stored : undefined) as never);
        const finished = new Promise<unknown[]>((resolve) => {
            finish = (...result) => resolve(result);
        });
        (Modal as unknown as { createDialog: unknown }).createDialog = vi.fn(() => ({ close: vi.fn(), finished }));
        open(store.editSection);
        open(store.removeSection);
    });
    afterEach(() => {
        vi.useRealTimers();
        getValue.mockRestore();
        (Modal as unknown as Fake).modals = [];
    });

    it("editSection: a returned name is done with the tag once the store has written", async () => {
        const outcome = editSection(A);
        await vi.advanceTimersByTimeAsync(0);
        finish("Renamed", [], []);
        await vi.advanceTimersByTimeAsync(0);
        rename(A, "Renamed");
        storeResult();
        await expect(outcome).resolves.toEqual({ status: "done", section: A });
        expect(store.editSection).toHaveBeenCalledExactlyOnceWith(A);
    });

    it("editSection: an unchanged name with room changes is done too (Element writes no name, the stored one is the dialog's)", async () => {
        const outcome = editSection(A);
        await vi.advanceTimersByTimeAsync(0);
        finish("Work", ["!a:example.org"], undefined);
        await vi.advanceTimersByTimeAsync(0);
        storeResult();
        await expect(outcome).resolves.toEqual({ status: "done", section: A });
    });

    it("editSection: a cancel at the rooms step returns (name, undefined) and still commits the rename: done (F3)", async () => {
        const outcome = editSection(A);
        await vi.advanceTimersByTimeAsync(0);
        finish("Renamed", undefined);
        await vi.advanceTimersByTimeAsync(0);
        rename(A, "Renamed");
        storeResult();
        await expect(outcome).resolves.toEqual({ status: "done", section: A });
    });

    it("editSection: a cancel at the rooms step with the name unchanged, (name, undefined), is done", async () => {
        const outcome = editSection(A);
        await vi.advanceTimersByTimeAsync(0);
        finish("Work", undefined);
        await vi.advanceTimersByTimeAsync(0);
        storeResult();
        await expect(outcome).resolves.toEqual({ status: "done", section: A });
    });

    it("editSection: closed at the name step (no name) is cancelled", async () => {
        const outcome = editSection(A);
        await vi.advanceTimersByTimeAsync(0);
        finish(undefined, undefined);
        await vi.advanceTimersByTimeAsync(0);
        storeResult();
        await expect(outcome).resolves.toEqual({ status: "cancelled" });
    });

    it("editSection: a store that has not written in time is network", async () => {
        const slow = codeOf(editSection(A));
        await vi.advanceTimersByTimeAsync(0);
        finish("Renamed", [], []);
        await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
        expect(await slow).toBe("network");
    });

    it("editSection: a store write that rejects maps to the contract's error", async () => {
        const outcome = codeOf(editSection(A));
        await vi.advanceTimersByTimeAsync(0);
        finish("Renamed", [], []);
        await vi.advanceTimersByTimeAsync(0);
        storeResult(new Error("account data refused"));
        expect(await outcome).toBe("failed");
    });

    it("editSection: a refused account-data write (the store's promise fulfils, the stored name is the old one) is failed (F1, D21)", async () => {
        const outcome = codeOf(editSection(A));
        await vi.advanceTimersByTimeAsync(0);
        finish("Renamed", [], []);
        await vi.advanceTimersByTimeAsync(0);
        // LocalEchoWrapper swallows the refusal: the promise fulfils and the local echo expires with the old name behind it.
        storeResult();
        expect(await outcome).toBe("failed");
        expect(stored[A].name).toBe("Work");
    });

    it("removeSection: confirmed is done once the section is gone from the account data and no longer listed (and not before)", async () => {
        let listed = true;
        const outcome = removeSection(A, false, () => listed);
        await vi.advanceTimersByTimeAsync(0);
        finish(true);
        await vi.advanceTimersByTimeAsync(0);
        delete stored[A];
        storeResult();
        let settled = false;
        void outcome.then(() => (settled = true));
        await vi.advanceTimersByTimeAsync(500);
        expect(settled).toBe(false);
        listed = false;
        await vi.advanceTimersByTimeAsync(100);
        await expect(outcome).resolves.toEqual({ status: "done", section: A });
        expect(store.removeSection).toHaveBeenCalledExactlyOnceWith(A, false);
    });

    it("removeSection: passes isEmpty through, and declined is cancelled", async () => {
        const outcome = removeSection(A, true, () => true);
        await vi.advanceTimersByTimeAsync(0);
        finish(false);
        await vi.advanceTimersByTimeAsync(0);
        storeResult();
        await expect(outcome).resolves.toEqual({ status: "cancelled" });
        expect(store.removeSection).toHaveBeenCalledExactlyOnceWith(A, true);
    });

    it("removeSection: a section still listed after the store wrote is network", async () => {
        const outcome = codeOf(removeSection(A, false, () => true));
        await vi.advanceTimersByTimeAsync(0);
        finish(true);
        await vi.advanceTimersByTimeAsync(0);
        delete stored[A];
        storeResult();
        await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
        expect(await outcome).toBe("network");
    });

    it("removeSection: a refused account-data write (the store's promise fulfils, the account data still holds the section) is failed even when listed() is already false (F1, D21)", async () => {
        // The item snapshots were rebuilt from the local echo, so the bridge's sections() no longer lists the tag.
        const outcome = codeOf(removeSection(A, false, () => false));
        await vi.advanceTimersByTimeAsync(0);
        finish(true);
        await vi.advanceTimersByTimeAsync(0);
        storeResult();
        expect(await outcome).toBe("failed");
        expect(stored[A]).toBeDefined();
    });

    it("editSection: the dialog lock is free after a network answer (the next dialog action is not refused; the first write may still apply, LIMIT F2)", async () => {
        const first = codeOf(editSection(A));
        await vi.advanceTimersByTimeAsync(0);
        finish("Renamed", [], []);
        await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
        expect(await first).toBe("network");

        // A refused start rejects at once: keep the rejection as the value so a regression is a failed assertion, not a crash.
        const next = editSection(A).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(0);
        rename(A, "Renamed");
        storeResult();
        await expect(next).resolves.toEqual({ status: "done", section: A });
        expect(store.editSection).toHaveBeenCalledTimes(2);
    });

    it("removeSection: the dialog lock is free after a network answer (the next dialog action is not refused)", async () => {
        const first = codeOf(removeSection(A, false, () => true));
        await vi.advanceTimersByTimeAsync(0);
        finish(true);
        await vi.advanceTimersByTimeAsync(0);
        delete stored[A];
        storeResult();
        await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
        expect(await first).toBe("network");

        const next = removeSection(B, false, () => false).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(0);
        delete stored[B];
        storeResult();
        await expect(next).resolves.toEqual({ status: "done", section: B });
        expect(store.removeSection).toHaveBeenCalledTimes(2);
    });

    /** Opens `run`, then drops its dialog the way Modal.tsx's priority/static wipe does: `finished` never settles, nor the store's promise. */
    async function openAndDrop(
        run: () => Promise<unknown>,
        fn: typeof store.editSection,
    ): Promise<{ outcome: Promise<unknown> }> {
        const fake = Modal as unknown as Fake;
        const modal = {};
        fake.createDialog = vi.fn(() => {
            fake.modals.unshift(modal);
            return { close: vi.fn(), finished: new Promise<unknown[]>(() => {}) };
        });
        fn.mockReset();
        fn.mockImplementation(() => {
            (Modal as unknown as { createDialog: (...a: unknown[]) => unknown }).createDialog(class {});
            return new Promise<void>(() => {});
        });
        const outcome = run();
        await vi.advanceTimersByTimeAsync(0);
        fake.modals = fake.modals.filter((m) => m !== modal);
        fake.emit("closed");
        return { outcome };
    }

    it("editSection: a dialog dropped by the modal wipe answers cancelled in bounded time and frees the lock", async () => {
        const { outcome } = await openAndDrop(() => editSection(A), store.editSection);
        await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
        await expect(outcome).resolves.toEqual({ status: "cancelled" });

        (Modal as unknown as { createDialog: unknown }).createDialog = vi.fn(() => ({
            close: vi.fn(),
            finished: Promise.resolve([undefined, undefined]),
        }));
        open(store.editSection);
        const next = editSection(A);
        await vi.advanceTimersByTimeAsync(0);
        storeResult();
        await expect(next).resolves.toEqual({ status: "cancelled" });
    });

    it("removeSection: a dialog dropped by the modal wipe answers cancelled in bounded time and frees the lock", async () => {
        const { outcome } = await openAndDrop(() => removeSection(A, false, () => true), store.removeSection);
        await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
        await expect(outcome).resolves.toEqual({ status: "cancelled" });

        (Modal as unknown as { createDialog: unknown }).createDialog = vi.fn(() => ({
            close: vi.fn(),
            finished: Promise.resolve([false]),
        }));
        open(store.removeSection);
        const next = removeSection(A, false, () => true);
        await vi.advanceTimersByTimeAsync(0);
        storeResult();
        await expect(next).resolves.toEqual({ status: "cancelled" });
    });
});

describe("M11 Y3 moveSection (RoomListStoreV3.reorderSection, answered from the stored order and sections())", () => {
    const C = "element.io.section.ccc";
    /** `RoomList.OrderedCustomSections` as the account data holds it: it also carries the `chats` and `People` tags. */
    let stored: string[];
    /** The bridge's `sections()` as tags (customs only): what the move waits to see change. */
    let listed: string[];
    let getValue: ReturnType<typeof vi.spyOn>;
    const order = (): readonly string[] => listed;
    /** Both sides apply the move: `tag` takes the place of `neighbour` in the customs (what Element's reorder stores). */
    const apply = (tag: string, neighbour: string): void => {
        const move = (list: string[]): string[] => {
            const rest = list.filter((t) => t !== tag);
            const at = rest.indexOf(neighbour);
            rest.splice(list.indexOf(tag) < list.indexOf(neighbour) ? at + 1 : at, 0, tag);
            return rest;
        };
        stored = move(stored);
        listed = move(listed);
    };

    beforeEach(() => {
        vi.useFakeTimers();
        stored = ["chats", A, B, "People", C];
        listed = [A, B, C];
        store.reorderSection.mockReset();
        getValue = vi
            .spyOn(SettingsStore, "getValue")
            .mockImplementation(((name: string) =>
                name === "RoomList.OrderedCustomSections" ? stored : undefined) as never);
    });
    afterEach(() => {
        vi.useRealTimers();
        getValue.mockRestore();
    });

    it("down: asks the store for the move with the next custom and is done once the stored order and sections() show it (and not before)", async () => {
        store.reorderSection.mockImplementation(async () => {
            stored = ["chats", B, A, "People", C];
        });
        const outcome = moveSection(A, "down", order);
        let settled = false;
        void outcome.then(() => (settled = true));
        await vi.advanceTimersByTimeAsync(200);
        expect(store.reorderSection).toHaveBeenCalledExactlyOnceWith(A, B);
        expect(settled).toBe(false); // the stored order moved, sections() has not caught up yet
        listed = [B, A, C];
        await vi.advanceTimersByTimeAsync(100);
        await expect(outcome).resolves.toEqual({ status: "done", section: A });
    });

    it("up: the neighbour is the previous custom (the one Element's reorder takes)", async () => {
        store.reorderSection.mockImplementation(async (tag: string, neighbour: string) => apply(tag, neighbour));
        const outcome = moveSection(C, "up", order);
        await vi.advanceTimersByTimeAsync(100);
        await expect(outcome).resolves.toEqual({ status: "done", section: C });
        expect(store.reorderSection).toHaveBeenCalledExactlyOnceWith(C, B);
        expect(stored).toEqual(["chats", A, C, B, "People"]);
    });

    it("an unknown tag is failed at once and the store is not asked", async () => {
        const outcome = codeOf(moveSection("element.io.section.zzz", "up", order));
        await vi.advanceTimersByTimeAsync(0);
        expect(await outcome).toBe("failed");
        expect(store.reorderSection).not.toHaveBeenCalled();
    });

    it("the first custom up and the last custom down have no neighbour: failed at once, the store is not asked", async () => {
        const up = codeOf(moveSection(A, "up", order));
        const down = codeOf(moveSection(C, "down", order));
        await vi.advanceTimersByTimeAsync(0);
        expect(await up).toBe("failed");
        expect(await down).toBe("failed");
        expect(store.reorderSection).not.toHaveBeenCalled();
    });

    it("a refused account-data write (the store's promise fulfils, the stored order is unchanged) is failed, also when sections() already shows the move", async () => {
        store.reorderSection.mockImplementation(async () => {
            listed = [B, A, C]; // the local echo moved the list, the PUT was refused and the echo expired
        });
        const outcome = codeOf(moveSection(A, "down", order));
        await vi.advanceTimersByTimeAsync(0);
        expect(await outcome).toBe("failed");
        expect(stored).toEqual(["chats", A, B, "People", C]);
    });

    it("a store that has not written in time is network, and the next move still takes its turn", async () => {
        store.reorderSection.mockImplementationOnce(() => new Promise<void>(() => undefined));
        const outcome = codeOf(moveSection(A, "down", order));
        await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
        expect(await outcome).toBe("network");

        store.reorderSection.mockImplementation(async (tag: string, neighbour: string) => apply(tag, neighbour));
        const next = moveSection(B, "down", order);
        await vi.advanceTimersByTimeAsync(100);
        await expect(next).resolves.toEqual({ status: "done", section: B });
        expect(store.reorderSection).toHaveBeenLastCalledWith(B, C);
    });

    it("sections() still lagging after the stored order moved is network once the time is up (the write is stored)", async () => {
        store.reorderSection.mockImplementation(async () => {
            stored = ["chats", B, A, "People", C];
        });
        const outcome = codeOf(moveSection(A, "down", order));
        await vi.advanceTimersByTimeAsync(ROOM_ACTION_TIMEOUT_MS + 1_000);
        expect(await outcome).toBe("network");
    });

    it("a store write that rejects maps to the contract's error", async () => {
        store.reorderSection.mockRejectedValue(new Error("boom"));
        const outcome = codeOf(moveSection(A, "down", order));
        await vi.advanceTimersByTimeAsync(0);
        expect(await outcome).toBe("failed");
    });

    it("two moves run one after the other: the second reads the order the first left", async () => {
        store.reorderSection.mockImplementation(async (tag: string, neighbour: string) => apply(tag, neighbour));
        const first = moveSection(A, "down", order);
        const second = moveSection(A, "down", order);
        await vi.advanceTimersByTimeAsync(300);
        await expect(first).resolves.toEqual({ status: "done", section: A });
        await expect(second).resolves.toEqual({ status: "done", section: A });
        expect(store.reorderSection.mock.calls).toEqual([
            [A, B],
            [A, C],
        ]);
        expect(listed).toEqual([B, C, A]);
    });
});
