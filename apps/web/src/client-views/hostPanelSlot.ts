/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

let mounted = 0;

/**
 * M9 (frozen note F5): whether a client view's host panel slot is mounted. MatrixChat's `ShowThread` arm returns before it
 * writes the right-panel store while it is: the slot's own dispatcher listener is the only consumer there, and a store
 * write would only move a panel nobody sees under the kit.
 */
export const isHostPanelSlotMounted = (): boolean => mounted > 0;

/** Called by the slot on mount; the returned function on unmount. */
export function markHostPanelSlotMounted(): () => void {
    mounted++;
    let done = false;
    return () => {
        if (done) return;
        done = true;
        mounted--;
    };
}
