/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { type Room } from "matrix-js-sdk/src/matrix";

import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { openFilePicker, rewrapFiles, uploadFiles, UPLOAD_IDLE_MS } from "./UploadAction";
import { ClientViewActionError } from "./types";

/* A8: Element's picker, the re-wrap into Element's realm, and the outcome read from Element's upload actions. */
const room = (maySend = true): Room => ({ roomId: "!a:example.org", maySendMessage: () => maySend }) as unknown as Room;
const file = (name = "notes.txt"): File => new File(["hello"], name, { type: "text/plain" });
const dispatch = (action: Action, upload: object): void =>
    defaultDispatcher.dispatch({ action, upload } as never, true);

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
        await p;
    } catch (e) {
        expect(e).toBeInstanceOf(ClientViewActionError);
        return (e as ClientViewActionError).code;
    }
    return undefined;
};

describe("A8 Element's file picker", () => {
    it("clicks a hidden input in the document and resolves with the chosen files", async () => {
        const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
        const picker = openFilePicker(document);
        const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
        expect(click).toHaveBeenCalledOnce();
        expect(input.multiple).toBe(true);
        Object.defineProperty(input, "files", { value: [file("a.txt"), file("b.txt")] });
        input.dispatchEvent(new Event("change"));
        expect((await picker.files)?.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
        expect(document.querySelector("input[type=file]")).toBeNull();
        click.mockRestore();
    });

    it("resolves null when the picker is dismissed, and leaves no input behind", async () => {
        const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
        const picker = openFilePicker(document);
        document.querySelector("input[type=file]")!.dispatchEvent(new Event("cancel"));
        expect(await picker.files).toBeNull();
        const second = openFilePicker(document);
        second.cancel();
        expect(await second.files).toBeNull();
        expect(document.querySelector("input[type=file]")).toBeNull();
        click.mockRestore();
    });

    it("re-wraps a file with its bytes, name and type", async () => {
        const [out] = await rewrapFiles([file("x.txt")]);
        expect(out).not.toBe(undefined);
        expect(out.name).toBe("x.txt");
        expect(out.type).toBe("text/plain");
        expect(await out.text()).toBe("hello");
    });
});

describe("A8 the outcome of Element's upload flow", () => {
    it("is done once every started upload finished", async () => {
        const upload = { fileName: "notes.txt" };
        const vm = {
            initiateViaInputFiles: vi.fn(async () => {
                dispatch(Action.UploadStarted, upload);
                setTimeout(() => dispatch(Action.UploadProgress, upload), 20);
                setTimeout(() => dispatch(Action.UploadFinished, upload), 40);
            }),
        };
        expect(await uploadFiles(vm, room(), [file()])).toEqual({ status: "done", roomId: "!a:example.org" });
        expect(vm.initiateViaInputFiles).toHaveBeenCalledOnce();
    });

    it("is cancelled when no upload starts (the confirm was dismissed)", async () => {
        const vm = { initiateViaInputFiles: vi.fn(async () => {}) };
        expect(await uploadFiles(vm, room(), [file()])).toEqual({ status: "cancelled" });
    });

    it("is failed when an upload failed, and an upload of another name is not its result", async () => {
        const upload = { fileName: "notes.txt" };
        const vm = {
            initiateViaInputFiles: vi.fn(async () => {
                dispatch(Action.UploadStarted, upload);
                dispatch(Action.UploadStarted, { fileName: "other.bin" });
                setTimeout(() => dispatch(Action.UploadFinished, { fileName: "other.bin" }), 10);
                setTimeout(() => dispatch(Action.UploadFailed, upload), 30);
            }),
        };
        expect(await codeOf(uploadFiles(vm, room(), [file()]))).toBe("failed");
    });

    it("is cancelled when Element's own UI cancelled the running upload", async () => {
        const upload = { fileName: "notes.txt" };
        const vm = {
            initiateViaInputFiles: vi.fn(async () => {
                dispatch(Action.UploadStarted, upload);
                setTimeout(() => dispatch(Action.UploadCanceled, upload), 20);
            }),
        };
        expect(await uploadFiles(vm, room(), [file()])).toEqual({ status: "cancelled" });
    });

    it("is failed when a started upload reports nothing for the idle limit", async () => {
        vi.useFakeTimers();
        try {
            const vm = {
                initiateViaInputFiles: vi.fn(async () => dispatch(Action.UploadStarted, { fileName: "notes.txt" })),
            };
            const result = codeOf(uploadFiles(vm, room(), [file()]));
            await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_MS + 1_000);
            expect(await result).toBe("failed");
        } finally {
            vi.useRealTimers();
        }
    });

    it("is forbidden where the user may not send, and runs one upload at a time", async () => {
        const vm = { initiateViaInputFiles: vi.fn(async () => {}) };
        expect(await codeOf(uploadFiles(vm, room(false), [file()]))).toBe("forbidden");
        expect(vm.initiateViaInputFiles).not.toHaveBeenCalled();
        let release: () => void = () => {};
        const slow = { initiateViaInputFiles: () => new Promise<void>((r) => (release = r)) };
        const first = uploadFiles(slow, room(), [file()]);
        expect(await codeOf(uploadFiles(vm, room(), [file()]))).toBe("failed");
        release();
        expect(await first).toEqual({ status: "cancelled" });
    });
});
