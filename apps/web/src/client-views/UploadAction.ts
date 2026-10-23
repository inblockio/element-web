/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

/*
 * A8 upload a file: `RoomUploadViewModel.initiateViaInputFiles` (D17). The files come from Element's own file picker (a
 * hidden `<input type="file">` in Element's document, opened inside the user's click in the kit) or, when the caller has
 * them, from the kit, re-wrapped as `File`s of Element's realm. Element then runs its own flow: `UploadConfirmDialog` (the
 * one confirmation), the media upload, the message, and on a refusal its own error dialog. The view-model resolves once the
 * dialogs are answered and leaves the uploads running, so the outcome is read from the upload actions Element dispatches
 * (`upload_started`, `upload_finished`, `upload_failed`, `upload_canceled`).
 */

import { type Room } from "matrix-js-sdk/src/matrix";

import { Action } from "../dispatcher/actions";
import { type ActionPayload } from "../dispatcher/payloads";
import { type UploadPayload } from "../dispatcher/payloads/UploadPayload";
import { toActionError } from "./actions";
import { recordPayloads } from "./RoomActions";
import { type ActionOutcome, ClientViewActionError } from "./types";

/** After the view-model's answer, how long Element may take to announce the uploads it started. */
const STARTED_SETTLE_MS = 150;
/** How long an upload may go without any progress or result before it counts as failed (contract principle 6). */
export const UPLOAD_IDLE_MS = 60_000;

/** The part of `RoomUploadViewModel` the action uses. */
export interface UploadVm {
    initiateViaInputFiles(files: FileList | File[] | null): Promise<void>;
}

/**
 * Element's own file picker: a hidden input in `doc`, clicked now (the caller runs inside the user's click, which same-origin
 * frames share). `files` resolves with the chosen files, or `null` when the picker is dismissed; `cancel` ends it early.
 */
export function openFilePicker(doc: Document): { files: Promise<File[] | null>; cancel: () => void } {
    const input = doc.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    let settle: (files: File[] | null) => void = () => {};
    const files = new Promise<File[] | null>((resolve) => {
        settle = resolve;
    });
    const end = (chosen: File[] | null): void => {
        input.removeEventListener("change", onChange);
        input.removeEventListener("cancel", onCancel);
        input.remove();
        settle(chosen);
    };
    const onChange = (): void => end(input.files?.length ? Array.from(input.files) : null);
    const onCancel = (): void => end(null);
    input.addEventListener("change", onChange);
    input.addEventListener("cancel", onCancel);
    doc.body.appendChild(input);
    input.click();
    return { files, cancel: () => end(null) };
}

/** Files of another realm (the kit's frame) as `File`s of this one: `instanceof` and `FormData` across frames are not reliable. */
export async function rewrapFiles(files: File[]): Promise<File[]> {
    return Promise.all(
        files.map(
            async (f) => new File([await f.arrayBuffer()], f.name, { type: f.type, lastModified: f.lastModified }),
        ),
    );
}

let uploadRunning = false;

/**
 * Runs `vm.initiateViaInputFiles(files)` and reads the outcome from Element's upload actions. `cancelled` when no upload
 * started (the confirm was dismissed, or there was nothing to send), `done` once every started upload finished, `failed`
 * when one failed (Element's error dialog shows too) or none reported anything for a minute.
 */
export async function uploadFiles(vm: UploadVm, room: Room, files: File[]): Promise<ActionOutcome> {
    if (uploadRunning) throw new ClientViewActionError("failed", "another upload is running");
    uploadRunning = true;
    const seen = recordPayloads();
    try {
        if (!room.maySendMessage()) throw new ClientViewActionError("forbidden", "the user may not send here");
        const names = new Set(files.map((f) => f.name || "Attachment"));
        const isMine = (p: ActionPayload): p is UploadPayload =>
            [
                Action.UploadStarted,
                Action.UploadProgress,
                Action.UploadFinished,
                Action.UploadFailed,
                Action.UploadCanceled,
            ].includes(p.action as Action) && names.has((p as UploadPayload).upload?.fileName);
        await vm.initiateViaInputFiles(files);
        // Element's dispatcher delivers asynchronously: the uploads the answered dialogs started are announced a tick later.
        await new Promise((r) => setTimeout(r, STARTED_SETTLE_MS));
        const started = new Set<unknown>();
        const ended = new Set<unknown>();
        let failed = false;
        let canceled = false;
        const settle = (p: ActionPayload): void => {
            if (!isMine(p)) return;
            if (p.action === Action.UploadStarted) started.add(p.upload);
            if (!started.has(p.upload)) return;
            if (p.action === Action.UploadFinished) ended.add(p.upload);
            if (p.action === Action.UploadFailed) {
                ended.add(p.upload);
                failed = true;
            }
            if (p.action === Action.UploadCanceled) {
                ended.add(p.upload);
                canceled = true;
            }
        };
        seen.payloads.forEach(settle);
        if (started.size === 0) return { status: "cancelled" };
        // Any action of these uploads (progress included) restarts the idle limit.
        while (ended.size < started.size) {
            seen.payloads.forEach(settle);
            if (ended.size >= started.size) break;
            const since = seen.payloads.length;
            try {
                await seen.wait<true>((p) => (isMine(p) ? true : undefined), UPLOAD_IDLE_MS, since);
            } catch {
                throw new ClientViewActionError("failed", "the upload did not finish");
            }
        }
        if (failed) throw new ClientViewActionError("failed", "the upload failed");
        if (canceled) return { status: "cancelled" };
        return { status: "done", roomId: room.roomId };
    } catch (e) {
        throw toActionError(e);
    } finally {
        seen.stop();
        uploadRunning = false;
    }
}
