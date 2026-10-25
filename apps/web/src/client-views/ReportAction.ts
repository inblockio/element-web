/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

/*
 * M7 E4 report a message: Element's own report dialog over the kit (D17), opened the way the message context menu opens
 * it (`MessageContextMenu.onReportEventClick`): the `OpenReportEventDialog` action, which `DialogOpener` (registered when
 * the client starts, no RoomView needed) answers with `ReportEventDialog`. The dialog sends the report itself and shows
 * its result; the kit keeps no state from this action, so `done` means the dialog closed (a send, a cancel or a dismissal
 * alike), never that a report was sent. Interim (D31): there is no report action on a shared view-model.
 */

import { type MatrixClient, type MatrixEvent } from "matrix-js-sdk/src/matrix";

import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { type OpenReportEventDialogPayload } from "../dispatcher/payloads/OpenReportEventDialogPayload";
import { dialogAction, openedDialog } from "./RoomActions";
import { type ActionOutcome, ClientViewActionError } from "./types";

export function openReport(client: MatrixClient, event: MatrixEvent): Promise<ActionOutcome> {
    const roomId = event.getRoomId()!;
    const eventId = event.getId()!;
    // Element offers Report only on events of others (MessageContextMenu: `mxEvent.getSender() !== me`).
    if (event.getSender() === client.getUserId()) {
        return Promise.reject(new ClientViewActionError("forbidden", "an own message is not reported"));
    }
    return dialogAction(async () => {
        const dialog = await openedDialog(() => {
            defaultDispatcher.dispatch<OpenReportEventDialogPayload>({ action: Action.OpenReportEventDialog, event });
        });
        await dialog.finished;
        return { status: "done", roomId, eventId };
    });
}
