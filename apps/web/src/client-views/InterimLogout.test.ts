/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import Modal from "../Modal";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { logout, LOGOUT_TIMEOUT_MS } from "./InterimActions";
import { ClientViewActionError } from "./types";

const logoutDialog = vi.hoisted(() => ({ shouldShow: vi.fn() }));
const lifecycle = vi.hoisted(() => ({ isLoggingOut: vi.fn(() => false) }));
vi.mock("../Lifecycle", () => lifecycle);
vi.mock("../Modal", () => ({ default: { createDialog: vi.fn() } }));
vi.mock("../components/views/dialogs/LogoutDialog", () => ({
    default: class LogoutDialog {},
    shouldShowLogoutDialog: logoutDialog.shouldShow,
}));

/* A9: the same decision as Element's SignOutButton (dialog or direct logout), and what each answer means. */
describe("A9 log out (InterimActions.logout)", () => {
    const client = {} as MatrixClient;
    let dispatched: string[];
    let token: string;

    beforeEach(() => {
        vi.useFakeTimers();
        dispatched = [];
        token = defaultDispatcher.register((p) => void dispatched.push(p.action));
    });
    afterEach(() => {
        defaultDispatcher.unregister(token);
        vi.useRealTimers();
    });

    /** A fake LogoutDialog: its `finished` is the dialog's own answer; `confirm` also dispatches `logout` like the real one. */
    const openDialog = (): { answer: (confirmed: boolean) => void } => {
        let resolve: (v: unknown[]) => void = () => {};
        const finished = new Promise<unknown[]>((r) => (resolve = r));
        vi.mocked(Modal.createDialog).mockReturnValue({ finished, close: vi.fn() } as never);
        return {
            answer: (confirmed) => {
                if (confirmed) defaultDispatcher.dispatch({ action: "logout" }, true);
                resolve([confirmed]);
            },
        };
    };

    it("opens Element's LogoutDialog when the client has crypto, and a dismissed dialog is cancelled (still signed in)", async () => {
        logoutDialog.shouldShow.mockResolvedValue(true);
        const dialog = openDialog();
        const result = logout(client);
        await vi.advanceTimersByTimeAsync(0);
        expect(Modal.createDialog).toHaveBeenCalledOnce();
        dialog.answer(false);
        expect(await result).toEqual({ status: "cancelled" });
        expect(dispatched).not.toContain("logout");
    });

    it("a confirmed dialog signs out: done once Element announced on_logged_out", async () => {
        logoutDialog.shouldShow.mockResolvedValue(true);
        const dialog = openDialog();
        const result = logout(client);
        await vi.advanceTimersByTimeAsync(0);
        dialog.answer(true);
        await vi.advanceTimersByTimeAsync(10);
        defaultDispatcher.dispatch({ action: Action.OnLoggedOut }, true);
        expect(await result).toEqual({ status: "done" });
        expect(dispatched).toContain("logout");
    });

    it("without crypto there is no dialog: logout is dispatched at once", async () => {
        logoutDialog.shouldShow.mockResolvedValue(false);
        vi.mocked(Modal.createDialog).mockClear();
        const result = logout(client);
        await vi.advanceTimersByTimeAsync(10);
        expect(Modal.createDialog).not.toHaveBeenCalled();
        expect(dispatched).toContain("logout");
        defaultDispatcher.dispatch({ action: Action.OnLoggedOut }, true);
        expect((await result).status).toBe("done");
    });

    it("fails when Element does not announce the sign-out in time, and allows one sign-out at a time", async () => {
        logoutDialog.shouldShow.mockResolvedValue(false);
        const first = logout(client);
        const second = logout(client);
        await expect(second).rejects.toBeInstanceOf(ClientViewActionError);
        const failed = first.catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(LOGOUT_TIMEOUT_MS + 100);
        const error = await failed;
        expect(error).toBeInstanceOf(ClientViewActionError);
        expect((error as ClientViewActionError).code).toBe("failed");
        // and the guard is free again
        logoutDialog.shouldShow.mockResolvedValue(true);
        const dialog = openDialog();
        const next = logout(client);
        await vi.advanceTimersByTimeAsync(0);
        dialog.answer(false);
        expect(await next).toEqual({ status: "cancelled" });
    });

    it("refuses a retry while Element's own sign-out still runs (after the timeout cleared the guard)", async () => {
        logoutDialog.shouldShow.mockResolvedValue(false);
        lifecycle.isLoggingOut.mockReturnValue(true);
        try {
            vi.mocked(Modal.createDialog).mockClear();
            await expect(logout(client)).rejects.toBeInstanceOf(ClientViewActionError);
            expect(dispatched).not.toContain("logout");
            expect(Modal.createDialog).not.toHaveBeenCalled();
        } finally {
            lifecycle.isLoggingOut.mockReturnValue(false);
        }
    });
});
