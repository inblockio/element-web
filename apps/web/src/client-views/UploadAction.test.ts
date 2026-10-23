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
import ContentMessages from "../ContentMessages";
import { openFilePicker, rewrapFiles, uploadFiles, UPLOAD_IDLE_MS, UPLOAD_PROCESSING_MS } from "./UploadAction";
import { ClientViewActionError } from "./types";

/* A8: Element's picker, the re-wrap into Element's realm, and the outcome read from Element's upload actions. */
const room = (maySend = true): Room => ({ roomId: "!a:example.org", maySendMessage: () => maySend }) as unknown as Room;
const file = (name = "notes.txt"): File => new File(["hello"], name, { type: "text/plain" });
const up = (fileName: string): { fileName: string; roomId: string } => ({ fileName, roomId: "!a:example.org" });
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
        const upload = up("notes.txt");
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
        const upload = up("notes.txt");
        const vm = {
            initiateViaInputFiles: vi.fn(async () => {
                dispatch(Action.UploadStarted, upload);
                dispatch(Action.UploadStarted, up("other.bin"));
                setTimeout(() => dispatch(Action.UploadFinished, up("other.bin")), 10);
                setTimeout(() => dispatch(Action.UploadFailed, upload), 30);
            }),
        };
        expect(await codeOf(uploadFiles(vm, room(), [file()]))).toBe("failed");
    });

    it("is cancelled when Element's own UI cancelled the running upload", async () => {
        const upload = up("notes.txt");
        const vm = {
            initiateViaInputFiles: vi.fn(async () => {
                dispatch(Action.UploadStarted, upload);
                setTimeout(() => dispatch(Action.UploadCanceled, upload), 20);
            }),
        };
        expect(await uploadFiles(vm, room(), [file()])).toEqual({ status: "cancelled" });
    });

    it("cancels Element's own upload when it reports nothing for the idle limit, then fails (no message after failed)", async () => {
        vi.useFakeTimers();
        const cancel = vi.spyOn(ContentMessages.sharedInstance(), "cancelUpload").mockImplementation(() => {});
        try {
            const upload = up("notes.txt");
            const vm = {
                initiateViaInputFiles: vi.fn(async () => {
                    dispatch(Action.UploadStarted, upload);
                    dispatch(Action.UploadProgress, upload);
                }),
            };
            const result = codeOf(uploadFiles(vm, room(), [file()]));
            await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_MS - 1_000);
            expect(cancel).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(2_000);
            expect(await result).toBe("failed");
            expect(cancel).toHaveBeenCalledOnce();
            expect(cancel).toHaveBeenCalledWith(upload);
        } finally {
            cancel.mockRestore();
            vi.useRealTimers();
        }
    });

    it("gives the phase before the first progress (Element encrypts and thumbnails) a longer bound than the idle limit", async () => {
        vi.useFakeTimers();
        const cancel = vi.spyOn(ContentMessages.sharedInstance(), "cancelUpload").mockImplementation(() => {});
        try {
            const upload = up("notes.txt");
            const vm = {
                initiateViaInputFiles: vi.fn(async () => {
                    dispatch(Action.UploadStarted, upload);
                    setTimeout(() => dispatch(Action.UploadFinished, upload), UPLOAD_IDLE_MS + 5_000);
                }),
            };
            const result = uploadFiles(vm, room(), [file()]);
            await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_MS + 10_000);
            expect(await result).toEqual({ status: "done", roomId: "!a:example.org" });
            expect(cancel).not.toHaveBeenCalled();
            expect(UPLOAD_PROCESSING_MS).toBeGreaterThan(UPLOAD_IDLE_MS);
            // and a start that never progresses is cancelled and failed at the longer bound
            const silent = {
                initiateViaInputFiles: vi.fn(async () => dispatch(Action.UploadStarted, up("notes.txt"))),
            };
            const stalled = codeOf(uploadFiles(silent, room(), [file()]));
            await vi.advanceTimersByTimeAsync(UPLOAD_PROCESSING_MS + 1_000);
            expect(await stalled).toBe("failed");
            expect(cancel).toHaveBeenCalledOnce();
        } finally {
            cancel.mockRestore();
            vi.useRealTimers();
        }
    });

    it("several files: any finished is done (also when another was cancelled or failed); cancelled only when nothing finished and nothing failed", async () => {
        const run = async (second: Action): Promise<unknown> => {
            const a = up("notes.txt");
            const b = up("two.txt");
            const vm = {
                initiateViaInputFiles: vi.fn(async () => {
                    dispatch(Action.UploadStarted, a);
                    dispatch(Action.UploadStarted, b);
                    setTimeout(() => dispatch(Action.UploadFinished, a), 10);
                    setTimeout(() => dispatch(second, b), 30);
                }),
            };
            return uploadFiles(vm, room(), [file(), file("two.txt")]).catch((e: ClientViewActionError) => e.code);
        };
        expect(await run(Action.UploadCanceled)).toEqual({ status: "done", roomId: "!a:example.org" });
        expect(await run(Action.UploadFailed)).toEqual({ status: "done", roomId: "!a:example.org" });
        const a = up("notes.txt");
        const b = up("two.txt");
        const none = {
            initiateViaInputFiles: vi.fn(async () => {
                dispatch(Action.UploadStarted, a);
                dispatch(Action.UploadStarted, b);
                setTimeout(() => dispatch(Action.UploadCanceled, a), 10);
                setTimeout(() => dispatch(Action.UploadCanceled, b), 20);
            }),
        };
        expect(await uploadFiles(none, room(), [file(), file("two.txt")])).toEqual({ status: "cancelled" });
    });

    it("ignores an upload of the same name into another room", async () => {
        const mine = up("notes.txt");
        const other = { fileName: "notes.txt", roomId: "!other:example.org" };
        const vm = {
            initiateViaInputFiles: vi.fn(async () => {
                dispatch(Action.UploadStarted, mine);
                dispatch(Action.UploadStarted, other);
                setTimeout(() => dispatch(Action.UploadFailed, other), 10);
                setTimeout(() => dispatch(Action.UploadFinished, mine), 30);
            }),
        };
        expect(await uploadFiles(vm, room(), [file()])).toEqual({ status: "done", roomId: "!a:example.org" });
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
