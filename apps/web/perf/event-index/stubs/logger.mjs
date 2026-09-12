/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/* Stub for matrix-js-sdk/src/logger: the index only ever calls debug/info/warn on a child. */
const sink = { debug() {}, info() {}, warn() {}, error() {}, getChild: () => sink };
export const logger = sink;
export default sink;
