/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MatrixClient, type MatrixEvent } from "matrix-js-sdk/src/matrix";

import {
    canDownloadMedia,
    DOWNLOAD_DECRYPT_TIMEOUT_MS,
    DOWNLOAD_OFFER_TIMEOUT_MS,
    downloadMedia,
    type DownloadBar,
    type DownloadHooks,
} from "./DownloadAction";
import { ClientViewActionError } from "./types";

/* B7: the download waits for the key, then for the action bar view-model's offer, then awaits its click. */
const h = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./InterimActions", () => ({ loadEvent: (...args: unknown[]) => h.load(...args) }));

interface FakeEvent {
    type: string;
    content: Record<string, unknown>;
    decrypting: boolean;
    failure: boolean;
    redacted: boolean;
}
const fake = (over: Partial<FakeEvent> = {}): MatrixEvent & FakeEvent => {
    const state: FakeEvent = {
        type: "m.room.message",
        content: { msgtype: "m.file", body: "notes.txt", file: { url: "mxc://hs/abc" } },
        decrypting: false,
        failure: false,
        redacted: false,
        ...over,
    };
    return Object.assign(state, {
        status: null,
        getId: () => "$file",
        getType: () => state.type,
        getContent: () => state.content,
        isRedacted: () => state.redacted,
        isBeingDecrypted: () => state.decrypting,
        isDecryptionFailure: () => state.failure,
    }) as unknown as MatrixEvent & FakeEvent;
};

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
        await p;
    } catch (e) {
        expect(e).toBeInstanceOf(ClientViewActionError);
        return (e as ClientViewActionError).code;
    }
    return undefined;
};

describe("B7 download", () => {
    let order: string[];
    let offered: boolean;
    let click: () => Promise<void>;
    let disposed: boolean;
    let decrypt: ReturnType<typeof vi.fn>;
    let client: MatrixClient;
    let hooks: DownloadHooks;

    beforeEach(() => {
        vi.useFakeTimers();
        order = [];
        offered = true;
        disposed = false;
        click = async () => {
            order.push("click");
        };
        decrypt = vi.fn(async () => {});
        client = { getRoom: (id: string) => (id === "!a" ? {} : null), decryptEventIfNeeded: decrypt } as never;
        hooks = {
            withActionBar: async (_ev, task) => {
                order.push("open");
                const bar: DownloadBar = { offered: () => offered, click: () => click() };
                try {
                    await task(bar);
                } finally {
                    order.push("dispose");
                }
            },
            disposed: () => disposed,
        };
        h.load.mockReset();
        h.load.mockResolvedValue(fake());
    });
    afterEach(() => vi.useRealTimers());

    it("offers the download for a decrypted media message only", () => {
        expect(canDownloadMedia(fake())).toBe(true);
        expect(canDownloadMedia(fake({ content: { msgtype: "m.text", body: "hi" } }))).toBe(false);
        expect(canDownloadMedia(fake({ redacted: true }))).toBe(false);
        expect(canDownloadMedia(fake({ type: "m.room.encrypted", content: {} }))).toBe(false);
    });

    it("awaits Element's click and disposes the view-model only after it settled", async () => {
        let finish: () => void = () => {};
        click = () =>
            new Promise<void>((resolve) => {
                order.push("click");
                finish = resolve;
            });
        let settled = false;
        const run = downloadMedia(client, "!a", "$file", hooks).then((o) => {
            settled = true;
            return o;
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(order).toEqual(["open", "click"]);
        expect(settled).toBe(false);
        finish();
        await expect(run).resolves.toEqual({ status: "done", roomId: "!a", eventId: "$file" });
        expect(order).toEqual(["open", "click", "dispose"]);
    });

    it("waits while the event is still encrypted, then clicks once it decrypted", async () => {
        const ev = fake({ type: "m.room.encrypted", content: {} });
        h.load.mockResolvedValue(ev);
        const run = downloadMedia(client, "!a", "$file", hooks);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(order).toEqual([]);
        expect(decrypt).toHaveBeenCalledWith(ev);
        ev.type = "m.room.message";
        ev.content = { msgtype: "m.file", body: "notes.txt", file: { url: "mxc://hs/abc" } };
        await vi.advanceTimersByTimeAsync(100);
        await expect(run).resolves.toMatchObject({ status: "done" });
        expect(order).toEqual(["open", "click", "dispose"]);
    });

    it("fails (no click) when the event stays undecrypted", async () => {
        h.load.mockResolvedValue(fake({ type: "m.room.encrypted", content: {} }));
        const run = codeOf(downloadMedia(client, "!a", "$file", hooks));
        await vi.advanceTimersByTimeAsync(DOWNLOAD_DECRYPT_TIMEOUT_MS + 1_000);
        expect(await run).toBe("failed");
        expect(order).toEqual([]);
    });

    it("waits for the view-model's offer (its permission hint), and is forbidden when it is never offered", async () => {
        offered = false;
        const run = downloadMedia(client, "!a", "$file", hooks);
        const code = codeOf(run);
        await vi.advanceTimersByTimeAsync(500);
        expect(order).toEqual(["open"]);
        await vi.advanceTimersByTimeAsync(DOWNLOAD_OFFER_TIMEOUT_MS + 1_000);
        expect(await code).toBe("forbidden");
        expect(order).toEqual(["open", "dispose"]);
    });

    it("clicks as soon as the offer arrives", async () => {
        offered = false;
        const run = downloadMedia(client, "!a", "$file", hooks);
        await vi.advanceTimersByTimeAsync(300);
        offered = true;
        await vi.advanceTimersByTimeAsync(100);
        await expect(run).resolves.toMatchObject({ status: "done" });
        expect(order).toEqual(["open", "click", "dispose"]);
    });

    it("is done when Element's click settles after its own error dialog (the click never rejects)", async () => {
        click = async () => {
            order.push("click-error-dialog");
        };
        await expect(downloadMedia(client, "!a", "$file", hooks)).resolves.toMatchObject({ status: "done" });
        expect(order).toEqual(["open", "click-error-dialog", "dispose"]);
    });

    it("maps a room, an event and a non-media event to the contract's errors, without opening a view-model", async () => {
        expect(await codeOf(downloadMedia(client, "!none", "$file", hooks))).toBe("unknown_room");
        h.load.mockRejectedValueOnce(new ClientViewActionError("unknown_event", "gone"));
        expect(await codeOf(downloadMedia(client, "!a", "$file", hooks))).toBe("unknown_event");
        h.load.mockResolvedValueOnce(fake({ content: { msgtype: "m.text", body: "hi" } }));
        expect(await codeOf(downloadMedia(client, "!a", "$file", hooks))).toBe("unsupported");
        h.load.mockResolvedValueOnce(fake({ redacted: true, type: "m.room.encrypted", content: {} }));
        expect(await codeOf(downloadMedia(client, "!a", "$file", hooks))).toBe("unsupported");
        expect(order).toEqual([]);
    });

    it("stops waiting when the bridge is disposed", async () => {
        h.load.mockResolvedValue(fake({ type: "m.room.encrypted", content: {} }));
        const code = codeOf(downloadMedia(client, "!a", "$file", hooks));
        await vi.advanceTimersByTimeAsync(200);
        disposed = true;
        await vi.advanceTimersByTimeAsync(100);
        expect(await code).toBe("failed");
    });
});
