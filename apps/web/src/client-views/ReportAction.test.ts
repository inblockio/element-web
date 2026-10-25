/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { type MatrixClient, type MatrixEvent } from "matrix-js-sdk/src/matrix";

import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { openReport } from "./ReportAction";

const rooms = vi.hoisted(() => ({
    dialogAction: vi.fn(async (run: () => Promise<unknown>) => run()),
    openedDialog: vi.fn(),
}));
vi.mock("./RoomActions", () => rooms);

const event = (sender: string): MatrixEvent =>
    ({ getRoomId: () => "!a:x", getId: () => "$e", getSender: () => sender }) as unknown as MatrixEvent;
const client = { getUserId: () => "@me:x" } as unknown as MatrixClient;

describe("openReport (M7 E4)", () => {
    beforeEach(() => vi.clearAllMocks());

    it("dispatches OpenReportEventDialog with the event and is done when the dialog closes", async () => {
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => {});
        let close!: (v: unknown[]) => void;
        rooms.openedDialog.mockImplementation(async (start: () => void) => {
            start();
            return { finished: new Promise((r) => (close = r)) };
        });
        const ev = event("@bob:x");
        let outcome: unknown;
        const call = openReport(client, ev).then((o) => (outcome = o));
        await Promise.resolve();
        await Promise.resolve();
        expect(dispatch).toHaveBeenCalledWith({ action: Action.OpenReportEventDialog, event: ev });
        expect(outcome).toBeUndefined();
        close([false]);
        await call;
        expect(outcome).toEqual({ status: "done", roomId: "!a:x", eventId: "$e" });
        dispatch.mockRestore();
    });

    it("is forbidden for an own event and opens nothing", async () => {
        await expect(openReport(client, event("@me:x"))).rejects.toMatchObject({ code: "forbidden" });
        expect(rooms.dialogAction).not.toHaveBeenCalled();
    });
});
