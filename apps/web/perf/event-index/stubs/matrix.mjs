/* Stub for matrix-js-sdk/src/matrix. Everything the index imports from it is a type except
   these two base64 helpers, which are re-implemented with identical semantics. */
export function encodeBase64(uint8Array) {
    return Buffer.from(uint8Array).toString("base64");
}
export function decodeBase64(base64) {
    return new Uint8Array(Buffer.from(base64, "base64"));
}
export const Direction = { Backward: "b", Forward: "f" };
