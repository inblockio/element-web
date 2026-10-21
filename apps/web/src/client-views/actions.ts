/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { ConnectionError, MatrixError } from "matrix-js-sdk/src/matrix";

import { ClientViewActionError } from "./types";

/**
 * The contract's error for whatever a client call threw (bridge v2, "Outcome and errors"): M_FORBIDDEN is
 * `forbidden`, a failed connection is `network`, anything else `failed`. An action maps its own `unknown_room` and
 * `unknown_event` before it calls the client.
 */
export function toActionError(e: unknown): ClientViewActionError {
    if (e instanceof ClientViewActionError) return e;
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof MatrixError && e.errcode === "M_FORBIDDEN") return new ClientViewActionError("forbidden", message);
    if (e instanceof ConnectionError) return new ClientViewActionError("network", message);
    return new ClientViewActionError("failed", message);
}
