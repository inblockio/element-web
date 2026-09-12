/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/* Stub for src/PlatformPeg: the index asks it for one thing, the session pickle key.
   `globalThis.__PERF_PICKLE_KEY__ = null` is how the harness selects a memory-only run. */
const peg = {
    get: () => ({
        getPickleKey: async () =>
            globalThis.__PERF_PICKLE_KEY__ === undefined ? "perf-pickle-key" : globalThis.__PERF_PICKLE_KEY__,
    }),
};
export default peg;
