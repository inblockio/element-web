/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

/*
 * B7 download a media file: `EventTileActionBarViewModel.onDownloadClick` (D4), the click behind the stock Download
 * button. Element fetches (and decrypts) the file and hands it to its own downloader; on a failure its own ErrorDialog
 * shows (D17), so the click never throws and the kit has no failure state of its own. The action first waits until the
 * event is decrypted, then until the view-model offers the download (its permission hint settled), awaits the click and
 * leaves disposing the view-model to the caller once the click settled.
 */

import { EventType, type MatrixClient, type MatrixEvent } from "matrix-js-sdk/src/matrix";

import { isContentActionable } from "../utils/EventUtils";
import { MediaEventHelper } from "../utils/MediaEventHelper";
import { loadEvent } from "./InterimActions";
import { ClientViewActionError } from "./types";

/** How long an event may stay undecrypted before the download gives up (a key can still be on its way). */
export const DOWNLOAD_DECRYPT_TIMEOUT_MS = 30_000;
/** How long the action bar view-model may take to offer the download (its permission hint is asynchronous). */
export const DOWNLOAD_OFFER_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

/** Element's rule for the Download action bar button, minus the view-model's asynchronous permission hint. */
export function canDownloadMedia(event: MatrixEvent): boolean {
    return isContentActionable(event) && MediaEventHelper.isEligible(event);
}

/** The part of the event's action bar view-model the action uses. */
export interface DownloadBar {
    /** The view-model's snapshot offers the Download action (its `showDownload`). */
    offered(): boolean;
    /** The view-model's `onDownloadClick`: resolves once Element handed the file to its downloader or showed its error. */
    click(): Promise<void>;
}

export interface DownloadHooks {
    /** Builds the event's action bar view-model, runs `use` with it and disposes it once `use` settled. */
    withActionBar(event: MatrixEvent, use: (bar: DownloadBar) => Promise<void>): Promise<void>;
    /** True once the bridge is disposed. */
    disposed(): boolean;
}

/** The event still waits for (or failed) its decryption; a redacted event never decrypts. */
const undecrypted = (ev: MatrixEvent): boolean =>
    !ev.isRedacted() &&
    (ev.isBeingDecrypted() || ev.isDecryptionFailure() || ev.getType() === EventType.RoomMessageEncrypted);

async function until(done: () => boolean, ms: number, hooks: DownloadHooks, timeout: () => Error): Promise<void> {
    const deadline = Date.now() + ms;
    while (!done()) {
        if (hooks.disposed()) throw new ClientViewActionError("failed", "bridge disposed");
        if (Date.now() > deadline) throw timeout();
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

/**
 * Downloads the media of event `eventId`. `unknown_room` / `unknown_event` for a room or event the client cannot load,
 * `unsupported` for an event that carries no media, `failed` when the event stays undecrypted, `forbidden` when the
 * view-model does not offer the download (a module's permission hint says no). `done` once the click settled; Element's
 * ErrorDialog shows a failed fetch or decryption, without a rejection.
 */
export async function downloadMedia(
    client: MatrixClient,
    roomId: string,
    eventId: string,
    hooks: DownloadHooks,
): Promise<{ status: "done"; roomId: string; eventId: string }> {
    const room = client.getRoom(roomId);
    if (!room) throw new ClientViewActionError("unknown_room", `no room ${roomId}`);
    const ev = await loadEvent(client, room, eventId);
    if (undecrypted(ev)) {
        void client.decryptEventIfNeeded(ev).catch(() => {});
        await until(
            () => !undecrypted(ev),
            DOWNLOAD_DECRYPT_TIMEOUT_MS,
            hooks,
            () => new ClientViewActionError("failed", `event ${eventId} is still encrypted`),
        );
    }
    if (!canDownloadMedia(ev))
        throw new ClientViewActionError("unsupported", `event ${eventId} has no file to download`);
    await hooks.withActionBar(ev, async (bar) => {
        await until(
            () => bar.offered(),
            DOWNLOAD_OFFER_TIMEOUT_MS,
            hooks,
            () => new ClientViewActionError("forbidden", `the download of ${eventId} is not offered`),
        );
        await bar.click();
    });
    return { status: "done", roomId, eventId };
}
