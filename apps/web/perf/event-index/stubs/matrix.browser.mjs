/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/* Browser-safe stub for matrix-js-sdk/src/matrix, mirroring stubs/matrix.mjs (the Node version) but without
   Buffer, which does not exist in a real browser page. Semantics match matrix-js-sdk's own base64.ts fallback
   path (btoa/atob over a byte string) closely enough to round-trip correctly; exact byte-for-byte parity with
   the SDK's own encodeBase64 (which prefers Uint8Array.prototype.toBase64 where available) is not required here
   because only round-trip correctness of IV/ciphertext strings matters for this harness. */
export function encodeBase64(uint8Array) {
    let binary = "";
    for (let i = 0; i < uint8Array.length; i++) binary += String.fromCharCode(uint8Array[i]);
    return btoa(binary);
}
export function decodeBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
export const Direction = { Backward: "b", Forward: "f" };
