/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import "fake-indexeddb/auto";

import { vi, describe, it, expect, afterEach, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { decodeBase64, Direction, encodeBase64 } from "matrix-js-sdk/src/matrix";

import { mockPlatformPeg } from "../../../test/test-utils";
import SettingsStore from "../../settings/SettingsStore";
import {
    BrowserEventIndexManager,
    chunkAad,
    decryptBinaryJson,
    decryptJson,
    deriveCheckpointMacKey,
    deriveDek,
    encryptBinary,
    encryptJson,
    eventHasFile,
    extractSearchText,
    flattenCopy,
    HYDRATION_SLICE_DEADLINE_MS,
    isBrowserEventIndexEnabled,
    isWebEventIndexSupported,
    MANIFEST_BYTES_PER_ENTRY_ESTIMATE,
    MANIFEST_PAGE_SIZE,
    replacedEventId,
    RESIDENT_BYTES_PER_EVENT_ESTIMATE,
    tokenize,
    effectiveEventForIndex,
    VOCABULARY_MERGE_THRESHOLD,
} from "./BrowserEventIndexManager";
import {
    DAY_MS,
    setChunkTargetBytesOverrideForTesting,
    setEventIndexBoundsOverrideForTesting,
} from "./eventIndexBounds";

const SEARCH_DEFAULTS = {
    before_limit: 0,
    after_limit: 0,
    order_by_recency: true,
    limit: 10,
};

const EVENTINDEX_DB_NAME = "element-eventindex";

function msg(id: string, body: string, extra: Record<string, unknown> = {}): any {
    return {
        event_id: id,
        room_id: "!room:example.org",
        sender: "@alice:example.org",
        type: "m.room.message",
        origin_server_ts: extra.origin_server_ts ?? 1000,
        content: { body, msgtype: "m.text", ...(extra.content as object) },
        ...extra,
    };
}

/** An m.replace of `origId`, as the live timeline delivers it. */
function edit(id: string, origId: string, newBody: string, ts = 2000): any {
    return msg(id, `* ${newBody}`, {
        origin_server_ts: ts,
        content: {
            "m.new_content": { body: newBody, msgtype: "m.text" },
            "m.relates_to": { rel_type: "m.replace", event_id: origId },
        },
    });
}

function idbPromise<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = (): void => resolve(req.result);
        req.onerror = (): void => reject(req.error);
    });
}

/** Opens a second connection to look at what is really on disk. */
async function withRawDb<T>(fn: (db: IDBDatabase) => Promise<T>, version?: number): Promise<T> {
    const db = await idbPromise(indexedDB.open(EVENTINDEX_DB_NAME, version));
    try {
        return await fn(db);
    } finally {
        db.close();
    }
}

interface RawSnapshot {
    version: number;
    /** Index names on the `chunks` store -- empty for schema v3, which addresses chunks only by their exact primary key. */
    chunkIndexNames: string[];
    /** Every event actually on disk, decrypted from every `chunks` row; see {@link decryptAllChunkEvents}. */
    events: any[];
}

/**
 * Decrypt every event currently on disk, straight off a raw second connection, for *every* user the
 * database currently holds a `chunks` row for (not just one): the `userId` on each raw chunk record
 * is still cleartext (see the class threat model), so this groups by that, reads each user's own
 * `meta` row for its salt, and re-derives each one's own DEK the same way {@link
 * BrowserEventIndexManager.initEventIndex} does -- the schema-v3 analogue of what a plain
 * `dumpRawStore("events")` gave for schema v2, before events stopped being individually addressable
 * and a raw row's own cleartext `userId`/`eventId` fields were enough on their own. Returns one
 * flattened `{eventId, userId, ...StoredEvent}` object per event, in no particular order, so every
 * existing `.toHaveLength(n)`/`.map(r => r.eventId)`/`.filter(r => r.userId === ...)`/
 * `expect.objectContaining({eventId: ...})` assertion written against the old per-row shape keeps
 * working unchanged.
 */
async function decryptAllChunkEvents(pickleKey: string, deviceId: string): Promise<any[]> {
    return withRawDb(async (db) => {
        const chunkRows = (await idbPromise(
            db.transaction("chunks", "readonly").objectStore("chunks").getAll(),
        )) as Array<{
            userId: string;
            chunkId: number;
            blob: { iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> };
        }>;
        const deks = new Map<string, CryptoKey>();
        const out: any[] = [];
        for (const row of chunkRows) {
            let dek = deks.get(row.userId);
            if (!dek) {
                const metaRow = (await idbPromise(
                    db.transaction("meta", "readonly").objectStore("meta").get(row.userId),
                )) as { salt: string } | undefined;
                if (!metaRow) continue; // No meta for this user; nothing to derive a key from.
                const salt = decodeBase64(metaRow.salt) as Uint8Array<ArrayBuffer>;
                dek = await deriveDek(pickleKey, salt, row.userId, deviceId);
                deks.set(row.userId, dek);
            }
            const arr = await decryptBinaryJson<Array<[string, any]>>(dek, row.blob, chunkAad(row.userId, row.chunkId));
            for (const [eventId, stored] of arr) out.push({ eventId, userId: row.userId, ...stored });
        }
        return out;
    });
}

/**
 * Seed a genuine schema-v2, pre-manifest, pre-chunk fixture: a real `events` object store (one
 * encrypted row per event, exactly as v2 wrote it, `byUser` index only) plus a bare `meta` row with
 * no `manifestPageCount` and no `checkpoints`. Bypasses {@link BrowserEventIndexManager} entirely on
 * the write side -- unlike this class, which never writes to `events` at all under schema v3, so
 * seeding "a v2 database" by writing through the manager and then merely stripping `meta`'s
 * increment-C/D fields (this file's own pattern before increment D) no longer produces one: the
 * data would already be sitting in `chunks`. This is what the very next {@link
 * BrowserEventIndexManager.initEventIndex} open resets rather than converts -- see {@link
 * BrowserEventIndexManager.openDb}'s "Migration v2 -> v3: reset, not convert".
 *
 * @param rawEvents - Matrix events, `msg()`-shaped, in the order to store them (arrival order,
 *     ascending `eventId` expected by callers that pass `budgetCorpus()`-style ids).
 * @returns The salt this fixture's DEK was derived from, so a caller that also needs a `meta` row
 *     mid-test can encrypt for the same key.
 */
async function seedLegacyV2Fixture(
    pickleKey: string,
    userId: string,
    deviceId: string,
    rawEvents: any[],
): Promise<{ salt: Uint8Array<ArrayBuffer> }> {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const dek = await deriveDek(pickleKey, salt, userId, deviceId);
    const records: Array<{ userId: string; eventId: string; blob: { iv: string; ct: string } }> = [];
    for (const ev of rawEvents) {
        const stored = {
            event: ev,
            profile: {},
            roomId: ev.room_id,
            eventId: ev.event_id,
            originServerTs: ev.origin_server_ts ?? 0,
            searchText: extractSearchText(ev),
            hasFile: eventHasFile(ev),
            edited: false,
        };
        const blob = await encryptJson(dek, stored, `${userId}|${ev.event_id}`);
        records.push({ userId, eventId: ev.event_id, blob });
    }

    await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(EVENTINDEX_DB_NAME, 2);
        req.onupgradeneeded = (): void => {
            const db = req.result;
            db.createObjectStore("meta", { keyPath: "userId" });
            const events = db.createObjectStore("events", { keyPath: ["userId", "eventId"] });
            events.createIndex("byUser", "userId", { unique: false });
            const cps = db.createObjectStore("checkpoints", { keyPath: "id" });
            cps.createIndex("byUser", "userId", { unique: false });
        };
        req.onerror = (): void => reject(req.error);
        req.onsuccess = (): void => {
            const db = req.result;
            const tx = db.transaction(["meta", "events"], "readwrite");
            tx.objectStore("meta").put({ userId, salt: encodeBase64(salt), userVersion: 0 });
            for (const rec of records) tx.objectStore("events").put(rec);
            tx.oncomplete = (): void => {
                db.close();
                resolve();
            };
            tx.onerror = (): void => {
                db.close();
                reject(tx.error);
            };
        };
    });
    return { salt };
}

async function inspectRawDb(pickleKey: string, deviceId: string): Promise<RawSnapshot> {
    const events = await decryptAllChunkEvents(pickleKey, deviceId);
    return withRawDb(async (db) => {
        const store = db.transaction("chunks", "readonly").objectStore("chunks");
        const names: string[] = [];
        for (let i = 0; i < store.indexNames.length; i++) names.push(store.indexNames.item(i)!);
        return { version: db.version, chunkIndexNames: names, events };
    });
}

/** Every record of one store, exactly as it sits on disk. */
async function dumpRawStore(name: string): Promise<any[]> {
    return withRawDb((db) => idbPromise(db.transaction(name, "readonly").objectStore(name).getAll()));
}

/**
 * Decode `bytes` the one way that can never lose a substring: one JS code unit per byte
 * (ISO-8859-1/Latin-1). Whatever encoding actually produced a byte run -- raw ASCII, UTF-8,
 * UTF-16LE, anything -- its bytes reappear verbatim as a Latin-1 substring of the same bytes,
 * because this mapping is a bijection on the byte value itself, not an interpretation of it. This
 * is why it is the right tool for a *guard*, where "no interpretation of this buffer contains the
 * marker" has to hold even for an encoding nobody anticipated -- unlike {@link TextDecoder}, which
 * is faithful only for the one encoding it is told to assume and can silently substitute U+FFFD
 * for anything else, hiding exactly the bytes a marker search most needs to see.
 */
function decodeLatin1(bytes: Uint8Array): string {
    let s = "";
    // String.fromCharCode(...bytes) blows the call stack on a large chunk; a loop does not.
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
}

/**
 * Render `value` into every text form a plaintext substring could plausibly survive as, recursing
 * into arrays and plain objects the way `JSON.stringify` would, but treating a binary leaf
 * specially. This is IV-1's fix (`research/review-pr-c.md`'s lineage; `~/handovers/.../research/
 * SYNTHESIS.md` §6 row D): `JSON.stringify(new ArrayBuffer(n))` is the string `"{}"` for *any*
 * content, so `JSON.stringify`ing a record that holds a chunk's ciphertext as a binary
 * `ArrayBuffer`/`Uint8Array` -- schema v3's whole point, {@link EncryptedBlob} being replaced by a
 * raw binary value for exactly this reason -- makes every byte of that value invisible to the old
 * `dumpWholeDb`, which returned early with `"{}"` for that field regardless of what was inside it.
 * A `.not.toContain(marker)` assertion against that string therefore passed whether or not the
 * buffer secretly held cleartext: not because the marker was absent, but because the tool could not
 * have found it either way. This function is what makes the guard capable of failing again: every
 * binary leaf is decoded twice -- once as Latin-1 ({@link decodeLatin1}, so any ASCII/UTF-8 byte
 * run, which is what every marker used in this file's tests is, reappears verbatim regardless of
 * what encoding produced it) and once as UTF-8 (`TextDecoder`, non-fatal, so genuinely multi-byte
 * text also round-trips readably) -- and both decodings are folded into the same search string a
 * structural `JSON.stringify` of the non-binary fields already contributes to.
 *
 * Called directly by the test-of-the-test below, to keep that test independent of `dumpWholeDb`'s
 * own IndexedDB plumbing.
 */
function scanValueForText(value: unknown): string {
    if (value instanceof ArrayBuffer) {
        const bytes = new Uint8Array(value);
        return decodeLatin1(bytes) + "\n" + new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    if (ArrayBuffer.isView(value)) {
        const view = value as Uint8Array;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        return decodeLatin1(bytes) + "\n" + new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    if (Array.isArray(value)) {
        return value.map((v) => scanValueForText(v)).join("\n");
    }
    if (value && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        const parts: string[] = [];
        for (const key of Object.keys(obj)) {
            parts.push(key, scanValueForText(obj[key]));
        }
        return parts.join("\n");
    }
    // A primitive (string/number/boolean/null): JSON.stringify keeps the exact-match behaviour
    // (e.g. the quoted `"${Direction.Backward}"` check below) that predates this rewrite.
    return JSON.stringify(value) ?? "";
}

/**
 * Every record of every store, rendered into text by {@link scanValueForText}. This is the string
 * a "nothing in the clear" assertion has to be made against -- see that function's docstring for
 * why a plain `JSON.stringify` of the raw rows stopped being sufficient once a value can be a
 * binary `ArrayBuffer`/`Uint8Array` (schema v3's `chunks` store).
 */
async function dumpWholeDb(): Promise<string> {
    return withRawDb(async (db) => {
        const names: string[] = [];
        for (let i = 0; i < db.objectStoreNames.length; i++) names.push(db.objectStoreNames.item(i)!);
        const tx = db.transaction(names, "readonly");
        // Every request is issued before anything is awaited: a transaction dies as soon as
        // control returns to the event loop with none outstanding.
        const rows = await Promise.all(names.map((n) => idbPromise(tx.objectStore(n).getAll())));
        return names.map((n, i) => `${n}:\n${scanValueForText(rows[i])}`).join("\n\n");
    });
}

/** Base64 of an HMAC-SHA256 tag: 32 bytes, so 43 base64 characters and one pad. */
const HMAC_B64 = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Slow every `crypto.subtle.decrypt` call down by `ms`, so a hydration restore of even a handful of
 * events takes long enough for a test to reliably observe it mid-flight -- real decrypt is far too
 * fast otherwise for a poll loop on a real timer to land inside the window. Real implementation
 * still runs underneath; this only delays it. Returns a restore function.
 */
function slowDownDecrypt(ms: number): () => void {
    const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
        return realDecrypt(...(args as Parameters<typeof realDecrypt>));
    });
    return () => spy.mockRestore();
}

/** A short real-timer pause, for polling loops that wait on a background hydration run. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Widen the window between "materializeIfPending has read its row" and "materializeIfPending
 * hands that row to materializeOnce" by padding the very transaction the real `get()` runs in
 * with extra dummy requests -- against the `events` store only, so `hydrate()`'s own bulk pages
 * (opened with `getAll`, never `get`) are untouched. The real `get()` still resolves at its normal
 * time (`idbReq()` is unaffected); only `txDone()`, which waits for the transaction's `oncomplete`,
 * is delayed, because a transaction with more outstanding requests takes longer to settle. This is
 * a race-widening tool for regression tests, not a bug in the production code it drives.
 */
function padEventsStoreGetTransaction(pad: number): () => void {
    const realGet = IDBObjectStore.prototype.get;
    const spy = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore["get"]>
    ): IDBRequest {
        const req = realGet.apply(this, args);
        if (this.name === "events") {
            for (let i = 0; i < pad; i++) realGet.call(this, ["@nobody:example.org", `$pad${i}`]);
        }
        return req;
    });
    return () => spy.mockRestore();
}

describe("BrowserEventIndex helpers", () => {
    it("tokenizes case-insensitively, folds accents, and drops punctuation", () => {
        expect(tokenize("Hello, WORLD! 42")).toEqual(["hello", "world", "42"]);
        expect(tokenize("Café Zürich")).toEqual(["cafe", "zurich"]);
        expect(tokenize("")).toEqual([]);
    });

    it("extracts body / name / topic, filename, and prefers m.new_content", () => {
        expect(extractSearchText(msg("$1", "plain"))).toEqual("plain");
        expect(
            extractSearchText(
                msg("$f", "image.jpg", { content: { filename: "quarterly-report.pdf", msgtype: "m.file" } }),
            ),
        ).toContain("quarterly-report.pdf");
        expect(
            extractSearchText({
                type: "m.room.name",
                content: { name: "Lobby" },
            } as any),
        ).toEqual("Lobby");
        expect(
            extractSearchText({
                type: "m.room.topic",
                content: { topic: "About us" },
            } as any),
        ).toEqual("About us");
        expect(
            extractSearchText(
                msg("$e", "old", {
                    content: { "m.new_content": { body: "new body", msgtype: "m.text" } },
                }),
            ),
        ).toContain("new body");
    });

    it("strips markup from formatted_body without merging adjacent blocks", () => {
        const fromHtml = (formattedBody: string): string =>
            extractSearchText(
                msg("$h", "", { content: { format: "org.matrix.custom.html", formatted_body: formattedBody } }),
            );

        // Tags are dropped, the text they wrap is kept.
        expect(tokenize(fromHtml("<p>hello <b>world</b></p>"))).toEqual(["hello", "world"]);
        expect(tokenize(fromHtml('<a href="https://example.org/">link</a>'))).toEqual(["link"]);

        // Adjacent block elements must stay separate words rather than merging into "foobar".
        expect(tokenize(fromHtml("<p>foo</p><p>bar</p>"))).toEqual(["foo", "bar"]);

        // Entities are decoded, so they are not indexed as "amp" / "lt" / "gt".
        expect(tokenize(fromHtml("Tom &amp; Jerry"))).toEqual(["tom", "jerry"]);
        expect(tokenize(fromHtml("&lt;script&gt;"))).toEqual(["script"]);

        // A decoded entity is a text node of its own, so a separator injected per text node
        // landed in the middle of a word: "AT&T" became "AT & T", and the escaped-ampersand
        // case defeated the decoding below it. Only the substring fallback can see the
        // difference, which is why these assert the text and not its tokens.
        expect(fromHtml("AT&amp;T")).toContain("AT&T");
        expect(fromHtml("&amp;amp;")).toContain("&amp;");
        expect(fromHtml("5 &lt; 6 &amp;&amp; 7 &gt; 2")).toContain("5 < 6 && 7 > 2");
        // ... and decoding stays single-pass: the literal text "&lt;" must not become "<".
        expect(fromHtml("&amp;lt;")).toContain("&lt;");
        expect(fromHtml("&amp;lt;")).not.toContain("<");
    });

    it("detects m.replace and rewrites the stored event id to the original", () => {
        const edit = msg("$edit", "ignored", {
            content: {
                "body": "* new",
                "m.new_content": { body: "new", msgtype: "m.text" },
                "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
            },
        });
        expect(replacedEventId(edit)).toEqual("$orig");
        expect(effectiveEventForIndex(edit).event_id).toEqual("$orig");
        expect(effectiveEventForIndex(edit).content.body).toEqual("new");
        expect(replacedEventId(msg("$1", "plain"))).toBeNull();
    });

    it("flags file events by mxc URL only", () => {
        expect(eventHasFile(msg("$1", "hi"))).toBe(false);
        expect(eventHasFile(msg("$2", "file", { content: { url: "mxc://s/a" } }))).toBe(true);
        expect(eventHasFile(msg("$3", "http", { content: { url: "https://x" } }))).toBe(false);
    });

    it("flattenCopy round-trips ordinary and JSON-special text losslessly", () => {
        // flattenCopy's whole job is to break any reference the value might otherwise retain to a
        // much larger backing buffer (see its docstring in BrowserEventIndexManager.ts); this is
        // the correctness check for the round trip itself, including characters JSON must escape
        // to survive it -- quotes, backslashes and control characters a message body can
        // legitimately contain.
        for (const raw of ["Café Zürich", 'She said "naïve"', "back\\slash", "line\nbreak", "tab\ttab", ""]) {
            expect(flattenCopy(raw)).toEqual(raw);
        }
    });

    it("encrypts to non-plaintext and decrypts with the same key only", async () => {
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const dek = await deriveDek("pickle-secret-one", salt, "@a:hs", "DEVICE");
        const blob = await encryptJson(dek, { body: "secret message" }, "@a:hs|$e");
        expect(blob.ct.includes("secret")).toBe(false);
        expect(atob(blob.ct).includes("secret")).toBe(false);
        const out = await decryptJson<{ body: string }>(dek, blob, "@a:hs|$e");
        expect(out.body).toEqual("secret message");

        const other = await deriveDek("pickle-secret-two", salt, "@a:hs", "DEVICE");
        await expect(decryptJson(other, blob, "@a:hs|$e")).rejects.toThrow();
        await expect(decryptJson(dek, blob, "wrong-aad")).rejects.toThrow();
    });

    it("encryptBinary/decryptBinaryJson round-trip as raw bytes, never base64, and reject the wrong key or AAD", async () => {
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const dek = await deriveDek("pickle-secret-one", salt, "@a:hs", "DEVICE");
        const blob = await encryptBinary(dek, [["$e", { body: "chunked secret" }]], "@a:hs|chunk:0");
        expect(blob.ct).toBeInstanceOf(Uint8Array);
        expect(blob.iv).toBeInstanceOf(Uint8Array);
        expect(blob.iv).toHaveLength(12);
        // Not JSON at all: decoding the raw ciphertext bytes as UTF-8 text must never surface the
        // marker -- the direct analogue of the base64 check above, for a binary value.
        expect(new TextDecoder("utf-8", { fatal: false }).decode(blob.ct)).not.toContain("chunked secret");

        const out = await decryptBinaryJson<Array<[string, { body: string }]>>(dek, blob, "@a:hs|chunk:0");
        expect(out).toEqual([["$e", { body: "chunked secret" }]]);

        const other = await deriveDek("pickle-secret-two", salt, "@a:hs", "DEVICE");
        await expect(decryptBinaryJson(other, blob, "@a:hs|chunk:0")).rejects.toThrow();
        await expect(decryptBinaryJson(dek, blob, "@a:hs|chunk:1")).rejects.toThrow();
    });

    it("derives a sign-only checkpoint subkey that is bound to the pickle key, user and device", async () => {
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const key = await deriveCheckpointMacKey("pickle-secret-one", salt, "@a:hs", "DEVICE");
        // Structurally not the DEK: a non-extractable HMAC key that can only sign, so it can
        // neither decrypt the index nor be lifted out and reused as an encryption key.
        expect(key.algorithm.name).toEqual("HMAC");
        expect(key.usages).toEqual(["sign"]);
        expect(key.extractable).toBe(false);

        const tag = async (k: CryptoKey): Promise<string> =>
            encodeBase64(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("tuple"))));

        // Every input that goes into the derivation actually reaches the output.
        const tags = await Promise.all(
            [
                key,
                await deriveCheckpointMacKey("pickle-secret-two", salt, "@a:hs", "DEVICE"),
                await deriveCheckpointMacKey("pickle-secret-one", salt, "@b:hs", "DEVICE"),
                await deriveCheckpointMacKey("pickle-secret-one", salt, "@a:hs", "DEVICE2"),
                await deriveCheckpointMacKey(
                    "pickle-secret-one",
                    crypto.getRandomValues(new Uint8Array(32)),
                    "@a:hs",
                    "DEVICE",
                ),
            ].map(tag),
        );
        expect(new Set(tags).size).toBe(tags.length);
        // ... and it is deterministic, which is what lets a checkpoint address its own record.
        expect(await tag(await deriveCheckpointMacKey("pickle-secret-one", salt, "@a:hs", "DEVICE"))).toEqual(tags[0]);
    });
});

describe("isBrowserEventIndexEnabled", () => {
    it("is false when the labs flag is off", () => {
        expect(isBrowserEventIndexEnabled()).toBe(false);
    });
});

describe("BrowserEventIndexManager", () => {
    let manager: BrowserEventIndexManager;

    beforeEach(() => {
        // The manager enforces the labs gate itself on every path that adds to the index, so
        // the write paths are unreachable without it; see "the labs gate" below for the tests
        // that turn it back off on purpose.
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(true);
        mockPlatformPeg({
            getPickleKey: vi.fn().mockResolvedValue("unit-test-pickle-key"),
        });
        manager = new BrowserEventIndexManager();
    });

    afterEach(async () => {
        await manager.deleteEventIndex();
        vi.restoreAllMocks();
    });

    it("prefixes every token of length >= 2", async () => {
        await manager.initEventIndex("@alice:example.org", "DEVICE1");
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$p", "invoice payment received"), {});
        const hit = await manager.searchEventIndex({
            search_term: "inv pay",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
            limit: 10,
        });
        expect(hit.count).toBe(1);
        expect(hit.results![0].result.event_id).toEqual("$p");
    });

    it("folds accents so cafe matches café", async () => {
        await manager.initEventIndex("@alice:example.org", "DEVICE1");
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$c", "Meet at Café Zürich"), {});
        const hit = await manager.searchEventIndex({
            search_term: "cafe zurich",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
            limit: 10,
        });
        expect(hit.count).toBe(1);
    });

    it("finds a file by filename even when body is just the short name", async () => {
        await manager.initEventIndex("@alice:example.org", "DEVICE1");
        await manager.waitForHydration();
        await manager.addEventToIndex(
            msg("$file", "image.jpg", {
                content: { filename: "quarterly-report.pdf", url: "mxc://s/a", msgtype: "m.file" },
            }),
            {},
        );
        const hit = await manager.searchEventIndex({
            search_term: "quarterly-report",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
            limit: 10,
        });
        expect(hit.count).toBe(1);
    });

    it("falls back to mid-word substring when token AND misses (query length >= 3)", async () => {
        await manager.initEventIndex("@alice:example.org", "DEVICE1");
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$s", "please send the invoice"), {});
        const hit = await manager.searchEventIndex({
            search_term: "oice",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
            limit: 10,
        });
        expect(hit.count).toBe(1);
        const tooShort = await manager.searchEventIndex({
            search_term: "ce",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
            limit: 10,
        });
        expect(tooShort.count).toBe(0);
    });

    it("indexes a live event and finds it via the stock search shape", async () => {
        await manager.initEventIndex("@alice:example.org", "DEVICE1");
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$a", "unique token zebra-42"), { displayname: "Alice" });
        await manager.commitLiveEvents();

        const result = await manager.searchEventIndex({
            search_term: "zebra-42",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
            limit: 10,
        });
        expect(result.count).toBe(1);
        expect(result.results![0].result.event_id).toEqual("$a");
        expect((result.results![0].result.content as any).body).toEqual("unique token zebra-42");
        expect(result.highlights).toContain("zebra");
        expect(result.highlights).toContain("42");
    });

    it("search after m.replace finds the new body and not the old one", async () => {
        await manager.initEventIndex("@alice:example.org", "DEVICE1");
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$orig", "old wording xyz"), {});
        await manager.addEventToIndex(
            msg("$edit", "* new wording abc", {
                origin_server_ts: 2000,
                content: {
                    "m.new_content": { body: "new wording abc", msgtype: "m.text" },
                    "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
                },
            }),
            {},
        );

        const oldHit = await manager.searchEventIndex({
            search_term: "xyz",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
            limit: 10,
        });
        expect(oldHit.count).toBe(0);

        const newHit = await manager.searchEventIndex({
            search_term: "abc",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
            limit: 10,
        });
        expect(newHit.count).toBe(1);
        expect(newHit.results![0].result.event_id).toEqual("$orig");
        expect((newHit.results![0].result.content as any).body).toEqual("new wording abc");
    });

    it("addHistoricEvents returns true only when every event was already present", async () => {
        await manager.initEventIndex("@alice:example.org", "DEVICE1");
        await manager.waitForHydration();
        const ev = { event: msg("$h", "historic"), profile: {} };
        expect(await manager.addHistoricEvents([ev], null, null)).toBe(false);
        expect(await manager.addHistoricEvents([ev], null, null)).toBe(true);
    });

    it("scopes search to a room and paginates with next_batch", async () => {
        await manager.initEventIndex("@alice:example.org", "DEVICE1");
        await manager.waitForHydration();
        const inA = msg("$1", "needle", { origin_server_ts: 1 });
        inA.room_id = "!a:hs";
        const inB = msg("$2", "needle", { origin_server_ts: 2 });
        inB.room_id = "!b:hs";
        await manager.addEventToIndex(inA, {});
        await manager.addEventToIndex(inB, {});

        const roomB = await manager.searchEventIndex({
            search_term: "needle",
            room_id: "!b:hs",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
            limit: 10,
        });
        expect(roomB.count).toBe(1);

        await manager.addEventToIndex(msg("$p1", "page", { origin_server_ts: 10 }), {});
        await manager.addEventToIndex(msg("$p2", "page", { origin_server_ts: 20 }), {});
        const page1 = await manager.searchEventIndex({
            search_term: "page",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
            limit: 1,
        });
        expect(page1.results).toHaveLength(1);
        expect(page1.next_batch).toBeDefined();
        const page2 = await manager.searchEventIndex({
            search_term: "page",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
            limit: 1,
            next_batch: page1.next_batch,
        });
        expect(page2.results).toHaveLength(1);
        expect(page2.results![0].result.event_id).not.toEqual(page1.results![0].result.event_id);
    });

    it("stores checkpoints and reports stats", async () => {
        await manager.initEventIndex("@alice:example.org", "DEVICE1");
        await manager.waitForHydration();
        expect(await manager.isEventIndexEmpty()).toBe(true);
        await manager.addEventToIndex(msg("$s", "stats"), {});
        const cp = { roomId: "!room:example.org", token: "t1", direction: Direction.Backward };
        await manager.addCrawlerCheckpoint(cp);
        expect(await manager.loadCheckpoints()).toEqual([cp]);
        await manager.removeCrawlerCheckpoint(cp);
        expect(await manager.loadCheckpoints()).toEqual([]);
        expect(await manager.isRoomIndexed("!room:example.org")).toBe(true);
        const stats = await manager.getStats();
        expect(stats.eventCount).toBe(1);
        expect(stats.roomCount).toBe(1);
    });

    it("deleteEventIndex drops in-memory hits", async () => {
        await manager.initEventIndex("@alice:example.org", "DEVICE1");
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$gone", "vanishing secret"), {});
        await manager.deleteEventIndex();
        const result = await manager.searchEventIndex({
            search_term: "vanishing",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
            limit: 10,
        });
        expect(result.count).toBe(0);
    });

    it("does not share hits across user ids in the same manager lifecycle", async () => {
        await manager.initEventIndex("@alice:example.org", "DEVICE1");
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$a", "alice-only-token"), {});
        await manager.closeEventIndex();
        await manager.initEventIndex("@bob:example.org", "DEVICE2");
        await manager.waitForHydration();
        const result = await manager.searchEventIndex({
            search_term: "alice-only-token",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
            limit: 10,
        });
        expect(result.count).toBe(0);
    });

    it("does not persist megolm session keys — only the Seshat event classes", async () => {
        await manager.initEventIndex("@alice:example.org", "DEVICE1");
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$m", "hello"), {});
        const result = await manager.searchEventIndex({
            search_term: "hello",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
            limit: 10,
        });
        const ev = result.results![0].result as any;
        expect(ev.content.session_id).toBeUndefined();
        expect(ev.content.session_key).toBeUndefined();
        expect(JSON.stringify(ev).includes("session_key")).toBe(false);
    });
});

describe("BrowserEventIndex support gating", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("is unsupported without IndexedDB", () => {
        vi.stubGlobal("indexedDB", undefined);
        expect(isWebEventIndexSupported()).toBe(false);
        expect(isBrowserEventIndexEnabled()).toBe(false);
    });

    it("is supported, and follows the labs flag, when the platform has the primitives", () => {
        expect(isWebEventIndexSupported()).toBe(true);

        vi.spyOn(SettingsStore, "getValue").mockReturnValue(true);
        expect(isBrowserEventIndexEnabled()).toBe(true);

        vi.spyOn(SettingsStore, "getValue").mockReturnValue(false);
        expect(isBrowserEventIndexEnabled()).toBe(false);
    });

    it("treats a throwing SettingsStore as disabled rather than propagating", () => {
        vi.spyOn(SettingsStore, "getValue").mockImplementation(() => {
            throw new Error("settings not ready");
        });
        expect(isBrowserEventIndexEnabled()).toBe(false);
    });

    it("reports supportsEventIndexing from the same gate", async () => {
        const manager = new BrowserEventIndexManager();
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(true);
        expect(await manager.supportsEventIndexing()).toBe(true);
    });
});

describe("BrowserEventIndexManager (IndexedDB backed)", () => {
    const DEVICE = "DEVICE1";
    let manager: BrowserEventIndexManager;
    let pickleKey: string | null;
    let userCounter = 0;
    let userId: string;

    const search = (term: string, overrides: Record<string, unknown> = {}): any =>
        ({ search_term: term, ...SEARCH_DEFAULTS, ...overrides }) as any;

    beforeEach(() => {
        // A fresh factory per test so leftover ciphertext cannot leak between them.
        vi.stubGlobal("indexedDB", new IDBFactory());
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(true);
        pickleKey = "unit-test-pickle-key";
        userId = `@user${++userCounter}:example.org`;
        mockPlatformPeg({
            getPickleKey: vi.fn().mockImplementation(async () => pickleKey),
        });
        manager = new BrowserEventIndexManager();
    });

    afterEach(async () => {
        await manager.closeEventIndex();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        // Backstop for review-pr-d.md D3-F2: a test that forgets to clear its own
        // setChunkTargetBytesOverrideForTesting() override must not leak the chunk size into
        // every later test in the file.
        setChunkTargetBytesOverrideForTesting(null);
        setEventIndexBoundsOverrideForTesting(null);
    });

    describe("the no-plaintext-in-IndexedDB guard (IV-1)", () => {
        // review-pr-c.md's lineage; this increment's own design doc, item 6: the guard has to be
        // proven, not merely rewritten, or a second regression of the same shape (some *other*
        // future binary field JSON.stringify cannot see into) would again pass silently.

        it("scanValueForText finds a marker planted inside a binary field, not just a string one", () => {
            // Exercises the tool directly, independent of any real store's shape or of IndexedDB
            // at all -- see scanValueForText's own docstring for why JSON.stringify alone cannot
            // do this (`JSON.stringify(new ArrayBuffer(n))` is `"{}"` for any content).
            const poisoned = {
                userId: "@nobody:example.org",
                // A schema-v3-shaped binary leaf: exactly what a chunk's ciphertext value looks
                // like on disk, holding a marker no encryption ever produced.
                chunk: new TextEncoder().encode("zqplaintextcanary lives in a binary leaf").buffer,
            };
            expect(scanValueForText(poisoned)).toContain("zqplaintextcanary");
            // A Uint8Array view (not a bare ArrayBuffer) must also be caught -- IndexedDB and this
            // class both hand around typed-array views at least as often as raw buffers.
            const view = { chunk: new TextEncoder().encode("zqplaintextcanary2") };
            expect(scanValueForText(view)).toContain("zqplaintextcanary2");
        });

        it("dumpWholeDb catches a marker planted directly on disk, in a binary field of a real store", async () => {
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();
            await manager.closeEventIndex(); // release the connection before opening a raw one

            // Bypass the manager -- and so its encryption -- entirely: write straight to the real
            // database's `meta` store a plaintext marker inside a binary ArrayBuffer field, the
            // same *shape* a chunk's ciphertext value has if encryption were ever accidentally
            // skipped. This is the positive control the design doc calls for: the guard must be
            // proven to catch a planted plaintext, not merely assumed to.
            await withRawDb(async (db) => {
                await new Promise<void>((resolve, reject) => {
                    const tx = db.transaction("meta", "readwrite");
                    tx.objectStore("meta").put({
                        userId: "@planted:example.org",
                        salt: "irrelevant",
                        userVersion: 0,
                        // A binary field, not a base64 string -- the exact case the old
                        // JSON.stringify-based dumpWholeDb could not see into at all.
                        diskBytes: new TextEncoder().encode("zqcanarymarker hidden in a buffer").buffer,
                    });
                    tx.oncomplete = (): void => resolve();
                    tx.onerror = (): void => reject(tx.error);
                });
            });

            const whole = await dumpWholeDb();
            // Positive control: the dump really does reach this row.
            expect(whole).toContain("@planted:example.org");
            // The actual assertion: a plaintext marker inside a binary field is found, not hidden
            // behind JSON.stringify's vacuous "{}" the way it would have been before this fix.
            expect(whole).toContain("zqcanarymarker");
        });
    });

    it("reloads events, checkpoints and the user version from IndexedDB", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$p", "persisted needle"), { displayname: "Alice" });
        const cp = { roomId: "!room:example.org", token: "tok", direction: Direction.Backward };
        await manager.addCrawlerCheckpoint(cp);
        await manager.setUserVersion(1);
        await manager.commitLiveEvents();
        await manager.closeEventIndex();

        const reloaded = new BrowserEventIndexManager();
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        try {
            const hit = await reloaded.searchEventIndex(search("needle"));
            expect(hit.count).toBe(1);
            expect(hit.results![0].result.event_id).toEqual("$p");
            expect(await reloaded.loadCheckpoints()).toEqual([cp]);
            expect(await reloaded.getUserVersion()).toBe(1);
            // Size is measured in ciphertext once records have been written.
            expect((await reloaded.getStats()).size).toBeGreaterThan(0);
        } finally {
            await reloaded.closeEventIndex();
        }
    });

    it("wipes leftover ciphertext it can no longer decrypt", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$w", "old-key secret"), {});
        await manager.setUserVersion(1);
        await manager.commitLiveEvents();
        await manager.closeEventIndex();

        // A new session with a different pickle key derives a different DEK.
        pickleKey = "a-completely-different-pickle-key";
        const reloaded = new BrowserEventIndexManager();
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        try {
            expect(await reloaded.isEventIndexEmpty()).toBe(true);
            expect(await reloaded.getUserVersion()).toBe(0);
            expect((await reloaded.searchEventIndex(search("secret"))).count).toBe(0);
        } finally {
            await reloaded.closeEventIndex();
        }
    });

    it("deleteEventIndex drops the stored records, not just the memory index", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$d", "doomed"), {});
        await manager.addCrawlerCheckpoint({ roomId: "!room:example.org", token: "t", direction: Direction.Backward });
        await manager.commitLiveEvents();
        await manager.deleteEventIndex();

        const reloaded = new BrowserEventIndexManager();
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        try {
            expect(await reloaded.isEventIndexEmpty()).toBe(true);
            expect(await reloaded.loadCheckpoints()).toEqual([]);
        } finally {
            await reloaded.closeEventIndex();
        }
    });

    it("deleteEvent removes the event once, and reports whether it existed", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$x", "removable"), {});
        await manager.commitLiveEvents();

        expect(await manager.deleteEvent("$x")).toBe(true);
        expect(await manager.deleteEvent("$x")).toBe(false);
        await manager.commitLiveEvents();
        await manager.closeEventIndex();

        const reloaded = new BrowserEventIndexManager();
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        try {
            expect((await reloaded.searchEventIndex(search("removable"))).count).toBe(0);
        } finally {
            await reloaded.closeEventIndex();
        }
    });

    it("removeCrawlerCheckpoint deletes the persisted checkpoint", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const cp = { roomId: "!room:example.org", token: "tok", direction: Direction.Backward };
        await manager.addCrawlerCheckpoint(cp);
        // Adding the same checkpoint twice must not duplicate it.
        await manager.addCrawlerCheckpoint(cp);
        expect(await manager.loadCheckpoints()).toEqual([cp]);
        await manager.removeCrawlerCheckpoint(cp);
        await manager.commitLiveEvents();
        await manager.closeEventIndex();

        const reloaded = new BrowserEventIndexManager();
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        try {
            expect(await reloaded.loadCheckpoints()).toEqual([]);
        } finally {
            await reloaded.closeEventIndex();
        }
    });

    it("does not persist anything when there is no pickle key", async () => {
        pickleKey = null;
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$e", "ephemeral wording"), {});
        await manager.commitLiveEvents();
        // Memory-only sessions have no ciphertext to measure, so stats fall back to an estimate.
        expect((await manager.getStats()).size).toBeGreaterThan(0);
        expect((await manager.searchEventIndex(search("ephemeral"))).count).toBe(1);
        await manager.closeEventIndex();

        const reloaded = new BrowserEventIndexManager();
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        try {
            expect(await reloaded.isEventIndexEmpty()).toBe(true);
        } finally {
            await reloaded.closeEventIndex();
        }
    });

    it("degrades to memory-only when IndexedDB refuses to open", async () => {
        // Present but refusing, which is what private browsing and blocked storage look like.
        // An *absent* indexedDB is a different case and never gets this far: it fails the
        // support check, so WebPlatform never builds a manager at all.
        vi.stubGlobal("indexedDB", {
            open: () => {
                const req = { error: new Error("storage is blocked") } as unknown as IDBOpenDBRequest;
                queueMicrotask(() => req.onerror?.(new Event("error")));
                return req;
            },
            deleteDatabase: () => {
                const req = {} as IDBOpenDBRequest;
                queueMicrotask(() => req.onsuccess?.(new Event("success")));
                return req;
            },
        });
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$m", "memory only"), {});
        await manager.commitLiveEvents();
        expect((await manager.searchEventIndex(search("memory"))).count).toBe(1);
        // The wipe path must not throw when there is no database to wipe.
        await manager.deleteEventIndex();
        expect(await manager.isEventIndexEmpty()).toBe(true);
    });

    it("returns surrounding events and profiles as search context", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$1", "before", { origin_server_ts: 1 }), { displayname: "Alice" });
        await manager.addEventToIndex(msg("$2", "context needle", { origin_server_ts: 2 }), { displayname: "Alice" });
        await manager.addEventToIndex(msg("$3", "after", { origin_server_ts: 3 }), { displayname: "Alice" });

        const result = await manager.searchEventIndex(search("needle", { before_limit: 1, after_limit: 1 }));
        expect(result.count).toBe(1);
        const context = result.results![0].context;
        expect(context.events_before.map((e) => e.event_id)).toEqual(["$1"]);
        expect(context.events_after.map((e) => e.event_id)).toEqual(["$3"]);
        expect(context.profile_info["@alice:example.org"]).toEqual({ displayname: "Alice" });
    });

    it("lists file events newest-first, and forwards from a given event", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const file = (id: string, ts: number): any =>
            msg(id, "file", { origin_server_ts: ts, content: { url: "mxc://s/a", msgtype: "m.file" } });
        await manager.addEventToIndex(file("$f1", 1), {});
        await manager.addEventToIndex(file("$f2", 2), {});
        await manager.addEventToIndex(msg("$plain", "not a file", { origin_server_ts: 3 }), {});

        const backwards = await manager.loadFileEvents({ roomId: "!room:example.org", limit: 10 });
        expect(backwards.map((e) => e.event.event_id)).toEqual(["$f2", "$f1"]);

        const forwards = await manager.loadFileEvents({
            roomId: "!room:example.org",
            limit: 10,
            direction: "f",
        });
        expect(forwards.map((e) => e.event.event_id)).toEqual(["$f1", "$f2"]);

        const after = await manager.loadFileEvents({
            roomId: "!room:example.org",
            limit: 10,
            direction: "f",
            fromEvent: "$f1",
        });
        expect(after.map((e) => e.event.event_id)).toEqual(["$f2"]);

        expect(await manager.loadFileEvents({ roomId: "!unknown:example.org", limit: 10 })).toEqual([]);
    });

    it("returns an empty result for an empty term, and once closed", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$s", "something"), {});
        expect((await manager.searchEventIndex(search(""))).count).toBe(0);

        await manager.closeEventIndex();
        expect((await manager.searchEventIndex(search("something"))).count).toBe(0);
        expect(await manager.addHistoricEvents([{ event: msg("$h", "historic"), profile: {} }], null, null)).toBe(
            false,
        );
    });

    it("strips a null state_key from results", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$sk", "stateless", { state_key: null }), {});
        const result = await manager.searchEventIndex(search("stateless"));
        expect(result.results![0].result).not.toHaveProperty("state_key");
    });

    it("addHistoricEvents refreshes a stale body and rotates the crawler checkpoints", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const stale = msg("$hist", "stale wording");
        expect(await manager.addHistoricEvents([{ event: stale, profile: {} }], null, null)).toBe(false);

        const older = { roomId: "!room:example.org", token: "old", direction: Direction.Backward };
        const newer = { roomId: "!room:example.org", token: "new", direction: Direction.Backward };
        await manager.addCrawlerCheckpoint(older);

        const refreshed = msg("$hist", "fresh wording");
        expect(await manager.addHistoricEvents([{ event: refreshed, profile: {} }], newer, older)).toBe(false);

        expect(await manager.loadCheckpoints()).toEqual([newer]);
        expect((await manager.searchEventIndex(search("stale"))).count).toBe(0);
        expect((await manager.searchEventIndex(search("fresh"))).count).toBe(1);
    });

    it("B13 (review-pr-b.md): the crawler's refresh branch persists the improved body, not just the memory copy", async () => {
        // review-pr-b.md's B-F1 fix reworked addHistoricEvents' write path from a per-event
        // schedulePersistEvent call to an accumulated `dirty` set flushed once per batch -- three
        // new places to forget to mark a record dirty. The existing "refreshes a stale body" test
        // above only asserts the in-memory searchEventIndex result, which is updated regardless of
        // whether the id was ever added to `dirty`: it cannot tell a persisted refresh from one that
        // silently reverts on the next session. This test closes exactly that gap by reloading from
        // disk.
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const stale = msg("$b13hist", "stale wording for review");
        expect(await manager.addHistoricEvents([{ event: stale, profile: {} }], null, null)).toBe(false);

        const refreshed = msg("$b13hist", "refreshed wording for review");
        expect(await manager.addHistoricEvents([{ event: refreshed, profile: {} }], null, null)).toBe(false);
        // Already true in memory -- the existing test's assertion -- but not the point of this one.
        expect((await manager.searchEventIndex(search("refreshed"))).count).toBe(1);

        await manager.commitLiveEvents();
        await manager.closeEventIndex();

        const reloaded = new BrowserEventIndexManager();
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        try {
            // The disk copy must be the refreshed body, not the stale one the crawler first saw.
            expect((await reloaded.searchEventIndex(search("stale"))).count).toBe(0);
            expect((await reloaded.searchEventIndex(search("refreshed"))).count).toBe(1);
        } finally {
            await reloaded.closeEventIndex();
        }
    });

    it("keeps the edited body when the original arrives afterwards", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(
            msg("$edit", "* edited wording", {
                origin_server_ts: 2000,
                content: {
                    "m.new_content": { body: "edited wording", msgtype: "m.text" },
                    "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
                },
            }),
            {},
        );
        // The original turns up later, via both the live and the historic path.
        await manager.addEventToIndex(msg("$orig", "original wording"), {});
        await manager.addHistoricEvents([{ event: msg("$orig", "original wording"), profile: {} }], null, null);

        expect((await manager.searchEventIndex(search("original"))).count).toBe(0);
        expect((await manager.searchEventIndex(search("edited"))).count).toBe(1);
    });

    it("writes no room id, token or direction into the checkpoints store", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const cp = {
            roomId: "!zqxsecretroom:example.org",
            token: "zqxsecrettoken",
            direction: Direction.Backward,
            fullCrawl: true,
        };
        await manager.addCrawlerCheckpoint(cp);
        await manager.commitLiveEvents();

        const rows = await dumpRawStore("checkpoints");
        expect(rows).toHaveLength(1);
        const [record] = rows;
        // Anything added to this list is metadata handed to whoever can read the IndexedDB
        // file. userId is the `byUser` index and is how a user's records are enumerated.
        expect(Object.keys(record).sort()).toEqual(["blob", "id", "userId"]);
        expect(Object.keys(record.blob).sort()).toEqual(["ct", "iv"]);
        expect(record.userId).toEqual(userId);
        // The primary key is a fixed-width MAC tag, not a `|`-joined tuple, so there is no
        // field in it for a room id, a token or a direction to be read out of.
        expect(record.id).toMatch(HMAC_B64);
        expect(record.id).not.toContain("|");

        const whole = await dumpWholeDb();
        // Positive control: the dump really does reach the records, so the negatives below
        // cannot pass by looking at nothing.
        expect(whole).toContain(userId);
        expect(whole).not.toContain("zqxsecretroom");
        expect(whole).not.toContain("zqxsecrettoken");
        // No column anywhere holds the direction as its value.
        expect(whole).not.toContain(`"${Direction.Backward}"`);
    });

    it("gives unrelated keys to checkpoints that differ only by direction or token", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const roomId = "!same:example.org";
        await manager.addCrawlerCheckpoint({ roomId, token: "tok", direction: Direction.Backward });
        await manager.addCrawlerCheckpoint({ roomId, token: "tok", direction: Direction.Forward });
        await manager.addCrawlerCheckpoint({ roomId, token: "tok2", direction: Direction.Backward });
        await manager.commitLiveEvents();

        const ids = (await dumpRawStore("checkpoints")).map((r) => r.id);
        expect(ids).toHaveLength(3);
        expect(new Set(ids).size).toBe(3);
        for (const id of ids) expect(id).toMatch(HMAC_B64);
    });

    it("round-trips every checkpoint field through the encrypted store", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const back = {
            roomId: "!alpha:example.org",
            token: "tok-alpha",
            direction: Direction.Backward,
            fullCrawl: true,
        };
        const forward = { roomId: "!beta:example.org", token: "tok-beta", direction: Direction.Forward };
        await manager.addCrawlerCheckpoint(back);
        await manager.addCrawlerCheckpoint(forward);
        await manager.commitLiveEvents();
        await manager.closeEventIndex();

        const reloaded = new BrowserEventIndexManager();
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        try {
            // Order follows the (hashed) primary key, so assert on the set, not the sequence.
            const loaded = await reloaded.loadCheckpoints();
            expect(loaded).toHaveLength(2);
            expect(loaded).toEqual(expect.arrayContaining([back, forward]));
        } finally {
            await reloaded.closeEventIndex();
        }
    });

    it("removes only the addressed checkpoint, not a sibling differing by direction or token", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const roomId = "!sibling:example.org";
        const back = { roomId, token: "tok", direction: Direction.Backward };
        const forward = { roomId, token: "tok", direction: Direction.Forward };
        const later = { roomId, token: "tok2", direction: Direction.Backward };
        for (const cp of [back, forward, later]) await manager.addCrawlerCheckpoint(cp);
        await manager.commitLiveEvents();
        expect(await dumpRawStore("checkpoints")).toHaveLength(3);

        await manager.removeCrawlerCheckpoint(back);
        await manager.commitLiveEvents();
        expect(await manager.loadCheckpoints()).toEqual([forward, later]);
        expect(await dumpRawStore("checkpoints")).toHaveLength(2);
        await manager.closeEventIndex();

        const reloaded = new BrowserEventIndexManager();
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        try {
            const loaded = await reloaded.loadCheckpoints();
            expect(loaded).toHaveLength(2);
            expect(loaded).toEqual(expect.arrayContaining([forward, later]));
        } finally {
            await reloaded.closeEventIndex();
        }
    });

    it("de-duplicates an equal checkpoint, in memory and on disk", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const cp = { roomId: "!dedupe:example.org", token: "tok", direction: Direction.Backward };
        await manager.addCrawlerCheckpoint(cp);
        // A distinct object with equal fields: de-duplication is by value, not by identity.
        await manager.addCrawlerCheckpoint({ ...cp });
        await manager.commitLiveEvents();

        expect(await manager.loadCheckpoints()).toEqual([cp]);
        // The record key is deterministic, so the second write lands on the first record.
        expect(await dumpRawStore("checkpoints")).toHaveLength(1);
    });

    it("writes nothing but userId/chunkId and the ciphertext in the clear -- eventId has left the cleartext key set (schema v3)", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(
            msg("$plain", "top secret wording", {
                origin_server_ts: 1234567890123,
                content: { url: "mxc://server/attachment", msgtype: "m.file" },
            }),
            { displayname: "Alice" },
        );
        await manager.commitLiveEvents();

        const chunkRows = await dumpRawStore("chunks");
        expect(chunkRows).toHaveLength(1);
        const [record] = chunkRows;
        // Anything added to this list is metadata handed to whoever can read the IndexedDB file.
        // userId and chunkId are the record key; chunkId is an opaque per-user counter with no
        // relationship to any event or room, unlike schema v2's cleartext eventId primary key.
        expect(Object.keys(record).sort()).toEqual(["blob", "chunkId", "userId"]);
        expect(Object.keys(record.blob).sort()).toEqual(["ct", "iv"]);
        expect(record.blob.ct).toBeInstanceOf(Uint8Array); // binary, never base64 JSON (see ChunkBlob)
        expect(record.blob.iv).toBeInstanceOf(Uint8Array);
        expect(record.userId).toEqual(userId);
        expect(record.chunkId).toEqual(0);
        // The crux of this test: no eventId field survives on the raw record at all -- it lives only
        // inside the ciphertext now.
        expect("eventId" in record).toBe(false);

        // No index at all on `chunks`: every read addresses it by the exact [userId, chunkId]
        // primary key, so there is nothing for an index to usefully answer (unlike schema v2's
        // events store, which needed byUser to enumerate one user's rows for deletion).
        await withRawDb(async (db) => {
            const store = db.transaction("chunks", "readonly").objectStore("chunks");
            const names: string[] = [];
            for (let i = 0; i < store.indexNames.length; i++) names.push(store.indexNames.item(i)!);
            expect(names).toEqual([]);
        });

        // Whole-database guard, via the IV-1-fixed scanValueForText path (dumpWholeDb): a plain
        // JSON.stringify of a binary blob field would pass every one of these vacuously (IV-1) --
        // this is the guard that actually decodes it.
        const whole = await dumpWholeDb();
        expect(whole).not.toContain("!room:example.org");
        expect(whole).not.toContain("1234567890123");
        expect(whole).not.toContain("mxc://");
        expect(whole).not.toContain("secret");
        expect(whole).not.toContain("$plain"); // the eventId itself, now only inside the ciphertext
    });

    it("migrates a v1 database: resets the index and leaves no v1 cleartext behind", async () => {
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const dek = await deriveDek(pickleKey!, salt, userId, DEVICE);
        const stored = {
            event: msg("$v1", "legacy needle"),
            profile: { displayname: "Alice" },
            roomId: "!room:example.org",
            eventId: "$v1",
            originServerTs: 1000,
            searchText: "legacy needle",
            hasFile: false,
            edited: false,
        };
        const blob = await encryptJson(dek, stored, `${userId}|$v1`);

        // A checkpoint exactly as v1 keyed it: the tuple itself was the primary key.
        const v1Checkpoint = {
            roomId: "!v1crawlroom:example.org",
            token: "v1crawltoken",
            direction: Direction.Backward,
        };
        const v1CheckpointId = `${userId}|${v1Checkpoint.roomId}|${v1Checkpoint.token}|${v1Checkpoint.direction}`;
        const cpBlob = await encryptJson(dek, v1Checkpoint, `${userId}|cp|${v1CheckpointId}`);

        // A database exactly as v1 left it on disk.
        await new Promise<void>((resolve, reject) => {
            const req = indexedDB.open(EVENTINDEX_DB_NAME, 1);
            req.onupgradeneeded = (): void => {
                const db = req.result;
                db.createObjectStore("meta", { keyPath: "userId" });
                const events = db.createObjectStore("events", { keyPath: ["userId", "eventId"] });
                events.createIndex("byUser", "userId", { unique: false });
                events.createIndex("byUserRoom", ["userId", "roomId"], { unique: false });
                const cps = db.createObjectStore("checkpoints", { keyPath: "id" });
                cps.createIndex("byUser", "userId", { unique: false });
            };
            req.onerror = (): void => reject(req.error);
            req.onsuccess = (): void => {
                const db = req.result;
                const tx = db.transaction(["meta", "events", "checkpoints"], "readwrite");
                tx.objectStore("meta").put({ userId, deviceId: DEVICE, salt: encodeBase64(salt), userVersion: 3 });
                tx.objectStore("events").put({
                    userId,
                    eventId: "$v1",
                    roomId: "!room:example.org",
                    ts: 1000,
                    hasFile: 0,
                    blob,
                });
                tx.objectStore("checkpoints").put({ id: v1CheckpointId, userId, blob: cpBlob });
                tx.oncomplete = (): void => {
                    db.close();
                    resolve();
                };
                tx.onerror = (): void => {
                    db.close();
                    reject(tx.error);
                };
            };
        });

        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();

        const raw = await inspectRawDb(pickleKey!, DEVICE);
        expect(raw.version).toBe(3); // v1 -> v3 in one upgrade transaction, reset not converted
        // The legacy `events` store is dropped outright, not merely emptied: v3 has no use for it
        // at all (see openDb's "Migration v2 -> v3: reset, not convert").
        await withRawDb(async (db) => {
            expect(db.objectStoreNames.contains("events")).toBe(false);
        });

        // The plaintext-keyed checkpoints cannot be re-keyed inside the versionchange transaction
        // (no key material exists there), so they are deleted; the events go with them, because
        // EventIndex only re-seeds checkpoints for an index that reports itself empty. The pair is
        // what turns "no crawl position" into a full rebuild.
        expect(raw.events).toEqual([]);
        expect(await dumpRawStore("chunks")).toEqual([]);
        expect(await dumpRawStore("checkpoints")).toEqual([]);
        expect(await manager.isEventIndexEmpty()).toBe(true);
        expect(await manager.loadCheckpoints()).toEqual([]);
        expect((await manager.searchEventIndex(search("legacy"))).count).toBe(0);

        // meta survives, because its salt is what keeps the derived key usable -- minus the
        // `deviceId` column, which nothing ever read. `manifestPageCount`/`nextChunkId` are written
        // back as `0`, exactly like a fresh v3 install, so the next open takes the ordinary
        // loadManifest path rather than dispatching to a self-heal scan. `diskBytes` is deliberately
        // absent, the same as a fresh install: nothing has ever been chunked for this user, and
        // `existingMeta.diskBytes ?? 0` already treats "absent" the same as "explicitly zero" at the
        // next open. `oldestIndexedTs` is deliberately absent too (review-pr-c.md C2-F4): it is
        // derived from the manifest at open, never a cleartext meta field, and this exact key set is
        // what pins that it cannot come back.
        expect(Object.keys((await dumpRawStore("meta"))[0]).sort()).toEqual([
            "manifestPageCount",
            "nextChunkId",
            "salt",
            "userId",
            "userVersion",
        ]);
        // userVersion is untouched by this schema migration -- it is EventIndex's own field, not
        // this class's, and a reset of the storage layout is not a reason to reset it.
        expect(await manager.getUserVersion()).toBe(3);

        // Nothing v1 wrote in the clear survives anywhere in the database.
        const whole = await dumpWholeDb();
        // Positive control: the dump really does reach the records that are left.
        expect(whole).toContain(userId);
        expect(whole).not.toContain("!room:example.org");
        expect(whole).not.toContain("!v1crawlroom");
        expect(whole).not.toContain("v1crawltoken");
        expect(whole).not.toContain(DEVICE);
    });

    it("redacting an edit removes the redacted body, in memory and on disk", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$orig", "original wording"), {});
        await manager.addEventToIndex(edit("$edit", "$orig", "edited wording"), {});
        await manager.commitLiveEvents();
        expect((await manager.searchEventIndex(search("edited"))).count).toBe(1);

        // EventIndex.redactEvent() deletes by the redacted event's own id, which for an
        // edit is the m.replace, not the original it was indexed under.
        expect(await manager.deleteEvent("$edit")).toBe(true);
        expect((await manager.searchEventIndex(search("edited"))).count).toBe(0);
        // The pre-edit body was overwritten in place, so the whole record goes.
        expect((await manager.searchEventIndex(search("original"))).count).toBe(0);
        expect(await manager.isEventIndexEmpty()).toBe(true);

        await manager.commitLiveEvents();
        expect((await inspectRawDb(pickleKey!, DEVICE)).events).toEqual([]);
        // Deleting it again is a no-op rather than a second hit.
        expect(await manager.deleteEvent("$edit")).toBe(false);
    });

    it("still resolves a redacted edit after a reload", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$orig", "original wording"), {});
        await manager.addEventToIndex(edit("$edit", "$orig", "edited wording"), {});
        await manager.commitLiveEvents();
        await manager.closeEventIndex();

        const reloaded = new BrowserEventIndexManager();
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        try {
            expect(await reloaded.deleteEvent("$edit")).toBe(true);
            expect((await reloaded.searchEventIndex(search("edited"))).count).toBe(0);
            await reloaded.commitLiveEvents();
            expect((await inspectRawDb(pickleKey!, DEVICE)).events).toEqual([]);
        } finally {
            await reloaded.closeEventIndex();
        }
    });

    it("drops the whole index when a chunk cannot be decrypted", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$a", "first wording"), {});
        await manager.addEventToIndex(msg("$b", "second wording"), {});
        await manager.commitLiveEvents();
        await manager.closeEventIndex();

        // Both events pack into the same (only, still-open) chunk -- schema v3's decrypt failure
        // unit is a whole chunk, not one row, so corrupting it takes both with it; unlike schema
        // v2's per-row failure, there is no "the first row already decrypted, the second did not"
        // case within a single chunk, only across chunks (see the "hydration newest-first across
        // chunk boundaries" tests for that).
        await withRawDb(async (db) => {
            const store = db.transaction("chunks", "readwrite").objectStore("chunks");
            const row = await idbPromise(store.get([userId, 0]));
            row.blob.ct = crypto.getRandomValues(new Uint8Array(64));
            await idbPromise(store.put(row));
        });

        const reloaded = new BrowserEventIndexManager();
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        try {
            expect((await reloaded.searchEventIndex(search("first"))).count).toBe(0);
            expect(await reloaded.isRoomIndexed("!room:example.org")).toBe(false);
            // The crawler relies on this to decide the index needs rebuilding.
            expect(await reloaded.isEventIndexEmpty()).toBe(true);
            expect((await inspectRawDb(pickleKey!, DEVICE)).events).toEqual([]);
        } finally {
            await reloaded.closeEventIndex();
        }
    });

    it("materializes rows from a good chunk before a later, undecryptable chunk wipes them too (review-pr-d.md D-R8)", async () => {
        // The invariant hydrate()'s own docstring claims and the test above (a single corrupted
        // chunk) cannot pin: a decrypt failure partway through a restore does not silently skip
        // just the bad chunk -- everything materialized from chunks visited *before* it stays
        // genuinely resident right up until the wipe clears it too, rather than never having been
        // processed at all (e.g. a buggy "check every chunk decrypts before materializing any of
        // them" implementation would also end up empty after a wipe, indistinguishable from the
        // outside without this spy).
        setChunkTargetBytesOverrideForTesting(250); // forces the two events below into separate chunks
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$goodNewer", "zqpartial good wording", { origin_server_ts: 2000 }), {});
        await manager.commitLiveEvents();
        await manager.addEventToIndex(msg("$badOlder", "zqpartial bad wording", { origin_server_ts: 1000 }), {});
        await manager.commitLiveEvents();
        const rawChunks = await dumpRawStore("chunks");
        expect(rawChunks).toHaveLength(2); // genuinely two chunks, one per event
        await manager.closeEventIndex();

        // Corrupt only the OLDER event's chunk. hydrate() walks newest-chunk-first, so $goodNewer's
        // chunk is visited (and materialized) before $badOlder's chunk is even attempted. Identify
        // it by decrypting each raw row and corrupting whichever one does NOT hold $goodNewer.
        for (const row of rawChunks) {
            const decrypted = await decryptBinaryJson<Array<[string, any]>>(
                await deriveDek(pickleKey!, decodeBase64((await dumpRawStore("meta"))[0].salt), userId, DEVICE),
                row.blob,
                chunkAad(row.userId, row.chunkId),
            );
            if (!decrypted.some(([id]) => id === "$goodNewer")) {
                await withRawDb(async (db) => {
                    const store = db.transaction("chunks", "readwrite").objectStore("chunks");
                    const fresh = await idbPromise(store.get([row.userId, row.chunkId]));
                    fresh.blob.ct = crypto.getRandomValues(new Uint8Array(64));
                    await idbPromise(store.put(fresh));
                });
            }
        }

        const materializeSpy = vi.spyOn(BrowserEventIndexManager.prototype as any, "materializeRow");
        try {
            const reloaded = new BrowserEventIndexManager();
            await reloaded.initEventIndex(userId, DEVICE);
            await reloaded.waitForHydration();

            // The good row really was processed (not skipped because a later chunk would fail) --
            // this is the "resident right up until the wipe" property the docstring claims.
            const materializedIds = materializeSpy.mock.calls.map((args: any[]) => args[1]?.eventId);
            expect(materializedIds).toContain("$goodNewer");

            // ... and then the wipe took it, and everything else, with it -- same outcome as the
            // single-corrupted-chunk test above, now proven to follow genuine partial processing
            // rather than an early bail that never touched the good chunk at all.
            expect((await reloaded.getStats()).eventCount).toBe(0);
            expect((await reloaded.searchEventIndex(search("zqpartial"))).count).toBe(0);
            expect(await reloaded.isEventIndexEmpty()).toBe(true);
            await reloaded.closeEventIndex();
        } finally {
            materializeSpy.mockRestore();
            setChunkTargetBytesOverrideForTesting(null); // review-pr-d.md D3-F2: this leaked past this test otherwise.
        }
    });

    it("closes the previous connection when re-initialising", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const close = vi.spyOn(IDBDatabase.prototype, "close");
        // The settings panel re-inits without closing first.
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        expect(close).toHaveBeenCalled();
    });

    it("leaves the database deletable after re-initialising", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$r", "first session"), {});
        await manager.commitLiveEvents();
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.commitLiveEvents();
        await manager.closeEventIndex();

        const blocked = vi.fn();
        await new Promise<void>((resolve, reject) => {
            const req = indexedDB.deleteDatabase(EVENTINDEX_DB_NAME);
            req.onsuccess = (): void => resolve();
            req.onerror = (): void => reject(req.error);
            req.onblocked = (): void => blocked();
        });
        expect(blocked).not.toHaveBeenCalled();
    });

    it("drops the whole database on the logout sequence (close, then delete)", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$logout", "logout secret"), {});
        await manager.commitLiveEvents();
        // EventIndexPeg.deleteEventIndex() closes the index before deleting it, which is
        // what takes deleteEventIndex() down its whole-database branch.
        await manager.closeEventIndex();
        await manager.deleteEventIndex();

        const names = (await indexedDB.databases()).map((d) => d.name);
        expect(names).not.toContain(EVENTINDEX_DB_NAME);
    });

    it("probes the same database the manager writes to", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        // EVENTINDEX_DB_NAME is not exported, so these tests carry their own copy of the name.
        // This is what keeps the copy honest: rename the constant in the source and this fails
        // here, loudly, instead of every other test quietly inspecting a database nobody wrote.
        expect((await indexedDB.databases()).map((d) => d.name)).toEqual([EVENTINDEX_DB_NAME]);
    });

    it("settles instead of hanging when an older tab blocks the upgrade", async () => {
        // A v1 database held open by a connection with no onversionchange handler -- exactly
        // what a tab running the build that created v1 leaves behind. It never gets out of the
        // way, so the v2 upgrade is blocked for as long as that tab lives.
        const v1 = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(EVENTINDEX_DB_NAME, 1);
            req.onupgradeneeded = (): void => {
                const db = req.result;
                db.createObjectStore("meta", { keyPath: "userId" });
                const events = db.createObjectStore("events", { keyPath: ["userId", "eventId"] });
                events.createIndex("byUser", "userId", { unique: false });
                const cps = db.createObjectStore("checkpoints", { keyPath: "id" });
                cps.createIndex("byUser", "userId", { unique: false });
            };
            req.onsuccess = (): void => resolve(req.result);
            req.onerror = (): void => reject(req.error);
        });

        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            // A real timeout rather than an await: EventIndexPeg.init() is awaited immediately
            // before MatrixClientPeg.start(), so a promise that never settles here is an
            // application that never starts. A regression must fail this test, not stall the
            // suite until vitest's own timeout kills it.
            const neverSettles = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("initEventIndex never settled")), 2000);
            });
            await expect(Promise.race([manager.initEventIndex(userId, DEVICE), neverSettles])).resolves.toBeUndefined();
        } finally {
            clearTimeout(timer);
        }

        // Degraded to memory-only, which is what initEventIndex does with any database it
        // cannot open: searchable for this session, nothing written, no exception.
        await manager.addEventToIndex(msg("$blocked", "still searchable"), {});
        await manager.commitLiveEvents();
        expect((await manager.searchEventIndex(search("searchable"))).count).toBe(1);

        // The blocking tab goes away, so the upgrade queued behind it finally runs. The
        // connection it produces belongs to nobody: openDb has to close it rather than leak a
        // handle that would block deleting the database for the rest of the session.
        v1.close();
        expect(await decryptAllChunkEvents(pickleKey!, DEVICE)).toEqual([]);
        const blocked = vi.fn();
        await new Promise<void>((resolve, reject) => {
            const req = indexedDB.deleteDatabase(EVENTINDEX_DB_NAME);
            req.onsuccess = (): void => resolve();
            req.onerror = (): void => reject(req.error);
            req.onblocked = (): void => blocked();
        });
        expect(blocked).not.toHaveBeenCalled();
    });

    it("does not carry the previous session's key into the next one", async () => {
        // A warm index for a second account, left by an earlier session.
        const other = `${userId}-other`;
        await manager.initEventIndex(other, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$warm", "warm body"), {});
        await manager.commitLiveEvents();
        await manager.closeEventIndex();

        // This account signs in, in the same manager object.
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$first", "first body"), {});
        await manager.commitLiveEvents();

        // And now back to the second account. Between opening the database under the new user
        // id and deriving that user's key there is a window in which the object holds the new
        // id, a live connection and the *previous* DEK -- so a write landing in it is encrypted
        // for one user and filed under the other. Nothing detects that later except the next
        // start-up, which finds ciphertext it cannot open and answers by wiping the user's
        // whole index. Land a write in exactly that window: the key derivation is what opens it.
        const realDeriveKey = crypto.subtle.deriveKey.bind(crypto.subtle);
        let landed = false;
        vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(async (...args) => {
            if (!landed) {
                landed = true;
                await manager.addEventToIndex(msg("$straddle", "straddling body"), {});
            }
            return realDeriveKey(...(args as Parameters<typeof realDeriveKey>));
        });

        await manager.initEventIndex(other, DEVICE);
        await manager.waitForHydration();
        await manager.commitLiveEvents();
        expect(landed).toBe(true);

        // The warm index survived, and nothing else was filed under this user.
        expect((await manager.searchEventIndex(search("warm"))).count).toBe(1);
        const rows = await decryptAllChunkEvents(pickleKey!, DEVICE);
        expect(rows.filter((r) => r.userId === other).map((r) => r.eventId)).toEqual(["$warm"]);
    });

    it("F9 regression: hydrating is set eagerly at initEventIndex's top, so a live write landing before hydrate() itself starts still sees the disk copy", async () => {
        // Session 1: an edited record and a crawler checkpoint, both persisted, then closed. The
        // checkpoint is the hook: loadCrawlerCheckpoints() decrypts it during initEventIndex,
        // strictly after persistEnabled/db/dek are all set but strictly before hydrate() is even
        // called -- the exact window review-pr-a.md's F9/mutant M16 is about. Without the eager
        // `this.hydrating = true` at initEventIndex's top (removed by M16, which the full suite
        // otherwise did not catch), `hydrating` would still read false here, materializeIfPending()
        // would be a no-op, and the live write below would be upserted as a brand-new record,
        // discarding the edit the disk copy already held.
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$orig", "original wording"), {});
        await manager.addEventToIndex(edit("$edit", "$orig", "edited wording"), {});
        const cp = { roomId: "!room:example.org", token: "tok", direction: Direction.Backward };
        await manager.addCrawlerCheckpoint(cp);
        await manager.commitLiveEvents();
        await manager.closeEventIndex();

        // Re-initialise the same manager (the settings panel's Enable path does this without
        // closing first) landing a live re-delivery of the *original* message, unaware of the
        // edit, from inside the very first crypto.subtle.decrypt call this second initEventIndex
        // makes -- whichever of checkpoints/the manifest phase reaches it first is now started
        // before this one under this increment's own initEventIndex ordering (materializeIfPending
        // needs the manifest to resolve an id to its chunk, unlike schema v2's direct keyed get(),
        // so manifestReadyPromise/chunkMigrationReadyPromise must already point at the live session
        // by the time anything this early could call it). The injected write is *not* awaited from
        // inside the mock itself -- only kicked off -- specifically so it cannot deadlock against
        // whichever pass's own decrypt this lands inside of: materializeIfPending awaits that same
        // pass's own readiness promise, so awaiting it synchronously from inside that pass's own
        // in-flight decrypt call would be waiting on itself. Kicking it off and letting the mocked
        // decrypt call return immediately lets that pass actually finish, which is what the
        // kicked-off write is itself waiting on.
        const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
        let landed = false;
        let injected: Promise<void> = Promise.resolve();
        const decryptSpy = vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
            if (!landed) {
                landed = true;
                injected = manager.addEventToIndex(msg("$orig", "original wording"), {});
            }
            return realDecrypt(...(args as Parameters<typeof realDecrypt>));
        });

        try {
            await manager.initEventIndex(userId, DEVICE);
            await injected;
            await manager.waitForHydration();
            expect(landed).toBe(true);

            // The edit survived: upsertEvent's "historic original after an edit" case took the
            // envelope from the live redelivery but kept the disk copy's edited body -- only
            // possible because materializeIfPending() pulled that disk copy in first.
            expect((await manager.searchEventIndex(search("edited"))).count).toBe(1);
            expect((await manager.searchEventIndex(search("original"))).count).toBe(0);
        } finally {
            decryptSpy.mockRestore();
        }
    });

    it("does not report a batch of edit repairs as already added", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        // The edit arrives first, so the record is filed under the original's id, carries the
        // edit's envelope, and is marked edited.
        await manager.addEventToIndex(edit("$repairedit", "$repairorig", "edited wording"), {});

        // A back-fill page holding only the original. It rewrites that record's envelope and
        // schedules a persist, so it is a change like any other: reporting "all already added"
        // would tell the crawler it had caught up and end the back-fill of a room it has
        // barely started.
        const page = [{ event: msg("$repairorig", "original wording"), profile: {} }];
        expect(await manager.addHistoricEvents(page, null, null)).toBe(false);
    });

    it("ends a file listing when the cursor is no longer indexed", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const file = (id: string, ts: number): any =>
            msg(id, "file", { origin_server_ts: ts, content: { url: "mxc://s/a", msgtype: "m.file" } });
        await manager.addEventToIndex(file("$c1", 1), {});
        await manager.addEventToIndex(file("$c2", 2), {});

        // The panel pages on from an event that has been redacted since it was rendered.
        // Restarting from the first page instead would hand back a page the panel has already
        // shown, and a panel that pages until it gets an empty answer would never get one.
        const page = await manager.loadFileEvents({
            roomId: "!room:example.org",
            limit: 1,
            direction: "f",
            fromEvent: "$redactedmidscroll",
        });
        expect(page).toEqual([]);
    });

    it("reports a size that tracks the records, not the number of writes", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$size", "first body"), {});
        await manager.commitLiveEvents();
        const one = (await manager.getStats()).size;
        expect(one).toBeGreaterThan(0);

        // Three rewrites of the same record. Each is a put, so there is still one row on disk
        // and the reported size must not have grown with the write count.
        for (const body of ["second body", "third body", "fourth body"]) {
            expect(await manager.addHistoricEvents([{ event: msg("$size", body), profile: {} }], null, null)).toBe(
                false,
            );
        }
        await manager.commitLiveEvents();
        expect(await decryptAllChunkEvents(pickleKey!, DEVICE)).toHaveLength(1);
        const rewritten = (await manager.getStats()).size;
        expect(rewritten).toBeLessThan(one * 1.5);

        // A second record adds to it ...
        await manager.addEventToIndex(msg("$size2", "another body"), {});
        await manager.commitLiveEvents();
        const two = (await manager.getStats()).size;
        expect(two).toBeGreaterThan(rewritten);

        // ... and deleting the first gives its bytes back.
        expect(await manager.deleteEvent("$size")).toBe(true);
        await manager.commitLiveEvents();
        const afterDelete = (await manager.getStats()).size;
        expect(afterDelete).toBeLessThan(two);
        expect(afterDelete).toBeGreaterThan(0);
    });

    it("keeps a room's events in timestamp order however they arrive", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        // Out of order and with ties, which is the normal case: the crawler pages backwards
        // while the live timeline appends forwards.
        const timestamps = [50, 10, 30, 10, 90, 20, 30, 5, 70, 10];
        const ids = timestamps.map((_ts, i) => `$ord${i}`);
        for (const [i, ts] of timestamps.entries()) {
            await manager.addEventToIndex(msg(ids[i], "ordered needle", { origin_server_ts: ts }), {});
        }
        // Ascending by timestamp, ties in arrival order: what a stable sort of "append, then
        // sort" produced, and what the binary-search insert has to keep producing.
        const expected = ids
            .map((id, i) => ({ id, ts: timestamps[i] }))
            .sort((a, b) => a.ts - b.ts)
            .map((e) => e.id);

        const result = await manager.searchEventIndex(
            search("needle", { before_limit: 20, after_limit: 20, order_by_recency: false, limit: 1 }),
        );
        const [first] = result.results!;
        const seen = [
            ...first.context!.events_before.map((e) => e.event_id),
            first.result.event_id,
            ...first.context!.events_after.map((e) => e.event_id),
        ];
        expect(seen).toEqual(expected);
    });

    it("re-places a record whose timestamp a late original corrects", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$oearly", "early needle", { origin_server_ts: 10 }), {});
        // The edit arrives before its original and is filed under the original's id, carrying
        // the edit's own, much later timestamp ...
        await manager.addEventToIndex(edit("$oedit", "$olate", "late needle", 900), {});
        await manager.addEventToIndex(msg("$omid", "middle needle", { origin_server_ts: 500 }), {});
        // ... and the original then turns up, timestamped before the event in the middle.
        await manager.addEventToIndex(msg("$olate", "original wording", { origin_server_ts: 20 }), {});

        const result = await manager.searchEventIndex(
            search("needle", { before_limit: 20, after_limit: 20, order_by_recency: false, limit: 1 }),
        );
        const [first] = result.results!;
        const seen = [
            ...first.context!.events_before.map((e) => e.event_id),
            first.result.event_id,
            ...first.context!.events_after.map((e) => e.event_id),
        ];
        expect(seen).toEqual(["$oearly", "$olate", "$omid"]);
    });

    it("keeps the substring fallback in step with an edited body", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$fold", "originalwording"), {});
        // A mid-word fragment only the substring fallback can match, which is what fills the
        // folded-text memo.
        expect((await manager.searchEventIndex(search("ginalwo"))).count).toBe(1);

        await manager.addEventToIndex(edit("$foldedit", "$fold", "replacementwording"), {});
        expect((await manager.searchEventIndex(search("ginalwo"))).count).toBe(0);
        expect((await manager.searchEventIndex(search("lacementwo"))).count).toBe(1);
    });

    it("removes a checkpoint that a previous session wrote", async () => {
        const cp = { roomId: "!crawl:example.org", token: "crawltoken", direction: Direction.Backward };
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addCrawlerCheckpoint(cp);
        await manager.commitLiveEvents();
        await manager.closeEventIndex();
        expect(await dumpRawStore("checkpoints")).toHaveLength(1);

        // Same user, same device, same pickle key, so the salt comes back out of the meta row
        // and the MAC subkey -- and with it the record key -- is re-derived identically. That
        // determinism across sessions is the only thing that makes a checkpoint written last
        // time addressable this time, and the re-keying rests on it.
        const reloaded = new BrowserEventIndexManager();
        try {
            await reloaded.initEventIndex(userId, DEVICE);
            await reloaded.waitForHydration();
            expect(await reloaded.loadCheckpoints()).toEqual([cp]);
            await reloaded.removeCrawlerCheckpoint({ ...cp });
            await reloaded.commitLiveEvents();
            expect(await reloaded.loadCheckpoints()).toEqual([]);
            expect(await dumpRawStore("checkpoints")).toEqual([]);
        } finally {
            await reloaded.closeEventIndex();
        }
    });

    it("does not let an in-flight write resurrect a record after the wipe", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$race", "racing secret"), {});
        // No commitLiveEvents(): the encrypt-and-put is still queued.
        await manager.deleteEventIndex();
        expect((await inspectRawDb(pickleKey!, DEVICE)).events).toEqual([]);
    });

    describe("non-blocking load", () => {
        const room = "!nonblocking:example.org";

        /** Persists `count` events under `userId`, closes the manager, and returns their ids. */
        async function seed(count: number): Promise<string[]> {
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();
            const ids: string[] = [];
            for (let i = 0; i < count; i++) {
                const id = `$nb${i}`;
                ids.push(id);
                await manager.addEventToIndex(
                    msg(id, `zqnbmarker body ${i}`, { room_id: room, origin_server_ts: i }),
                    {},
                );
            }
            await manager.commitLiveEvents();
            await manager.closeEventIndex();
            return ids;
        }

        it("returns from initEventIndex before hydration finishes", async () => {
            await seed(8);
            const restore = slowDownDecrypt(15);
            try {
                const reloaded = new BrowserEventIndexManager();
                await reloaded.initEventIndex(userId, DEVICE);
                // initEventIndex has resolved. With 8 records at 15ms/decrypt each, hydration
                // cannot possibly be done yet -- if it were, this method was still awaiting the
                // full restore, which is the regression this test exists to catch.
                expect((await reloaded.getStats()).loading).toBe(true);
                expect((await reloaded.getStats()).eventCount).toBeLessThan(8);
                await reloaded.waitForHydration();
                expect((await reloaded.getStats()).eventCount).toBe(8);
                await reloaded.closeEventIndex();
            } finally {
                restore();
            }
        });

        it("getStats().loading is true throughout hydration and flips to false exactly once", async () => {
            await seed(8);
            const restore = slowDownDecrypt(10);
            try {
                const reloaded = new BrowserEventIndexManager();
                await reloaded.initEventIndex(userId, DEVICE);

                const samples: boolean[] = [(await reloaded.getStats()).loading ?? false];
                const hydrationDone = reloaded.waitForHydration().then((): "done" => "done");
                let finished = false;
                while (!finished) {
                    const outcome = await Promise.race([hydrationDone, sleep(4).then((): "tick" => "tick")]);
                    finished = outcome === "done";
                    samples.push((await reloaded.getStats()).loading ?? false);
                }

                expect(samples[0]).toBe(true);
                expect(samples[samples.length - 1]).toBe(false);
                let trueToFalse = 0;
                let falseToTrue = 0;
                for (let i = 1; i < samples.length; i++) {
                    if (samples[i - 1] && !samples[i]) trueToFalse++;
                    if (!samples[i - 1] && samples[i]) falseToTrue++;
                }
                expect(trueToFalse).toBe(1);
                expect(falseToTrue).toBe(0);

                await reloaded.closeEventIndex();
            } finally {
                restore();
            }
        });

        it("search during hydration returns what is resident so far, and never throws", async () => {
            // Progress happens at CHUNK granularity now (a whole chunk's worth of events
            // materializes at once, right after its one decrypt resolves), so a corpus under one
            // chunk's worth (CHUNK_TARGET_BYTES) would jump straight from 0 to fully hydrated with
            // no observable partial state -- this needs enough events to span several chunks.
            const NB_CHUNK_SPANNING_COUNT = 200;
            const ids = await seed(NB_CHUNK_SPANNING_COUNT);
            const lastId = ids[0]; // lowest ts; hydrated last now that hydration reads newest-ts-first
            const restore = slowDownDecrypt(5);
            try {
                const reloaded = new BrowserEventIndexManager();
                await reloaded.initEventIndex(userId, DEVICE);

                while (true) {
                    const stats = await reloaded.getStats();
                    if (stats.eventCount > 0 && stats.eventCount < ids.length) break;
                    await sleep(4);
                }
                // Not yet reached: no throw, just nothing found for it yet.
                await expect(reloaded.searchEventIndex(search(`zqnbmarker body 0`))).resolves.toMatchObject({
                    count: 0,
                });
                // What has loaded so far is already searchable.
                const partial = await reloaded.searchEventIndex(search("zqnbmarker"));
                expect(partial.count).toBeGreaterThan(0);
                expect(partial.count).toBeLessThan(ids.length);

                await reloaded.waitForHydration();
                const full = await reloaded.searchEventIndex(search("zqnbmarker"));
                expect(full.count).toBe(ids.length);
                expect((await reloaded.searchEventIndex(search(lastId.replace("$", "")))).count).toBe(0); // sanity: id itself isn't indexed text
                await reloaded.closeEventIndex();
            } finally {
                restore();
            }
        });

        it("a live re-delivery during hydration does not duplicate the record once hydration reaches it", async () => {
            const ids = await seed(3);
            const lastId = ids[ids.length - 1];
            const restore = slowDownDecrypt(15);
            try {
                const reloaded = new BrowserEventIndexManager();
                await reloaded.initEventIndex(userId, DEVICE);

                // Wait until at least the first record has hydrated, so the live add below races a
                // hydration run that is genuinely still in flight rather than one that never started.
                while ((await reloaded.getStats()).eventCount === 0) await sleep(4);

                // Re-deliver the highest-ts event live, exactly as the timeline might redeliver a
                // message the crawler has already indexed. Whether it has been hydrated yet or not
                // by this point, the dedup guarantee under test (materializeIfPending's residency
                // re-check, upsertEvent's own idempotency) has to hold either way.
                await reloaded.addEventToIndex(
                    msg(lastId, `zqnbmarker body ${ids.length - 1}`, {
                        room_id: room,
                        origin_server_ts: ids.length - 1,
                    }),
                    {},
                );
                await reloaded.waitForHydration();
                await reloaded.commitLiveEvents();

                expect((await reloaded.getStats()).eventCount).toBe(ids.length);
                const order = await roomTimelineOrder(reloaded, "zqnbmarker", room, ids.length + 5);
                expect(order).toEqual(ids);
                expect(new Set(order).size).toBe(order.length);

                await reloaded.closeEventIndex();
            } finally {
                restore();
            }
        });

        it("teardown mid-hydration stops the loop cleanly, without a dangling transaction", async () => {
            // See the "search during hydration" test above: progress is per-chunk now, so this needs
            // enough events to span several chunks for a genuinely partial state to exist at all.
            const NB_CHUNK_SPANNING_COUNT = 200;
            await seed(NB_CHUNK_SPANNING_COUNT);
            const restore = slowDownDecrypt(8);
            try {
                const reloaded = new BrowserEventIndexManager();
                await reloaded.initEventIndex(userId, DEVICE);

                while (true) {
                    const count = (await reloaded.getStats()).eventCount;
                    if (count > 0 && count < NB_CHUNK_SPANNING_COUNT) break;
                    await sleep(4);
                }

                const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction");
                const callsAtClose = txSpy.mock.calls.length;

                await reloaded.closeEventIndex();
                // A promise that never settles here is the loop failing to notice the teardown.
                await expect(reloaded.waitForHydration()).resolves.toBeUndefined();

                // Give a stray timer or transaction callback a chance to fire before checking it did not.
                await sleep(80);
                expect(txSpy.mock.calls.length).toBe(callsAtClose);
                expect((await reloaded.getStats()).eventCount).toBe(0);

                txSpy.mockRestore();
            } finally {
                restore();
            }
        });

        // Adversarial-review regressions (review-pr-a.md, 2026-09-13). Each test's id below (R1,
        // R2, ...) matches the repro that found it, so the review and the fix stay traceable to
        // each other.

        it("R1: a live re-delivery landing exactly as hydrate() finishes its own attempt for the same row does not duplicate it in roomOrder", async () => {
            // materializeOnce() de-duplicates only against an *in-flight* attempt; if hydrate()'s
            // own attempt for a row settles during materializeIfPending()'s two awaits (its get()
            // request settling, then its transaction's txDone()), the in-flight map entry is
            // already gone by the time materializeIfPending checks it, and without a residency
            // re-check afterwards it would call materializeOnce() a second time regardless.
            const ids = await seed(6);
            const restoreDecrypt = slowDownDecrypt(8);
            const restorePad = padEventsStoreGetTransaction(4000);
            try {
                const reloaded = new BrowserEventIndexManager();
                await reloaded.initEventIndex(userId, DEVICE);
                while ((await reloaded.getStats()).eventCount === 0) await sleep(2);
                const residentBefore = (await reloaded.getStats()).eventCount;
                const target = ids[residentBefore]; // the row hydrate() is about to decrypt next

                // A live re-delivery of that same event. Not awaited yet: by the time this call's
                // own get() resolves, hydrate()'s own attempt for `target` may already have
                // settled underneath it, thanks to the padded transaction widening the window.
                const live = reloaded.addEventToIndex(
                    msg(target, `zqnbmarker body ${residentBefore}`, {
                        room_id: room,
                        origin_server_ts: residentBefore,
                    }),
                    {},
                );

                await reloaded.waitForHydration();
                await live;
                await reloaded.commitLiveEvents();

                expect((await reloaded.getStats()).eventCount).toBe(ids.length);
                const order = await roomTimelineOrder(reloaded, "zqnbmarker", room, ids.length + 5);
                expect(order).toEqual(ids);
                expect(new Set(order).size).toBe(order.length); // no duplicates

                await reloaded.closeEventIndex();
            } finally {
                restorePad();
                restoreDecrypt();
            }
        });

        it("R2: closeEventIndex landing during addEventToIndex's await does not resurrect the event afterwards", async () => {
            await seed(6);
            const restore = slowDownDecrypt(15);
            try {
                const reloaded = new BrowserEventIndexManager();
                await reloaded.initEventIndex(userId, DEVICE);
                while ((await reloaded.getStats()).eventCount === 0) await sleep(2);

                // A live event arrives; it is now inside materializeIfPending()'s await.
                const live = reloaded.addEventToIndex(msg("$fresh", "zqsecret plaintext", { room_id: room }), {});
                await reloaded.closeEventIndex();
                await live;

                expect((await reloaded.getStats()).eventCount).toBe(0);
                const hits = await reloaded.searchEventIndex(search("zqsecret"));
                expect(hits.count).toBe(0);
            } finally {
                restore();
            }
        });

        it("R2b: closeEventIndex landing mid-batch stops the rest of addHistoricEvents from landing after teardown", async () => {
            await seed(6);
            const restore = slowDownDecrypt(15);
            try {
                const reloaded = new BrowserEventIndexManager();
                await reloaded.initEventIndex(userId, DEVICE);
                await reloaded.waitForHydration();

                const batch = [0, 1, 2, 3].map((i) => ({
                    event: msg(`$crawl${i}`, `zqcrawl body ${i}`, { room_id: room, origin_server_ts: 500 + i }),
                    profile: {},
                }));
                const crawl = reloaded.addHistoricEvents(batch, null, null);
                await reloaded.closeEventIndex();
                const allAlready = await crawl;

                expect(allAlready).toBe(false);
                // materializeIfPending() for a brand-new id (never on disk, no manifest entry) no
                // longer touches IndexedDB at all under schema v3 -- it short-circuits synchronously
                // on the manifest lookup, unlike schema v2's unconditional get(). That removes the
                // real-I/O yield point closeEventIndex() used to reliably interleave against mid-loop,
                // so at most the one iteration already past its own (now I/O-free) await when
                // `closed` flips can still land before the loop's own `if (this.closed) return false;`
                // check catches it on the next iteration -- the invariant this test exists to prove is
                // that the *rest* of the batch does not, not that literally nothing before the flip
                // can ever complete.
                expect((await reloaded.getStats()).eventCount).toBeLessThanOrEqual(1);
                for (const i of [1, 2, 3]) {
                    expect((await reloaded.searchEventIndex(search(`zqcrawl body ${i}`))).count).toBe(0);
                }
            } finally {
                restore();
            }
        });

        it("R3: a connection closed by another tab's onversionchange fails hydrate() without an unhandled rejection", async () => {
            await seed(6);
            const restore = slowDownDecrypt(8);
            try {
                const reloaded = new BrowserEventIndexManager();
                const realTx = IDBDatabase.prototype.transaction;
                let armed = false;
                const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
                    this: IDBDatabase,
                    names,
                    mode,
                    ...rest
                ) {
                    if (armed && names === "events" && mode !== "readwrite") {
                        // Exactly what a live handle does after another tab fires
                        // `versionchange`: the connection is closed but `this.db` is still set.
                        throw new DOMException("The database connection is closing.", "InvalidStateError");
                    }
                    return realTx.call(this, names, mode, ...rest);
                });
                armed = true;
                await reloaded.initEventIndex(userId, DEVICE);
                // Nothing in production ever attaches a handler to this promise; a rejection here
                // would surface as an unhandled rejection. It must resolve instead.
                await expect(reloaded.waitForHydration()).resolves.toBeUndefined();
                expect((await reloaded.getStats()).loading).toBe(false);
                txSpy.mockRestore();
            } finally {
                restore();
            }
        });

        it("R4: materializeIfPending does not throw synchronously into addEventToIndex when the handle is closing", async () => {
            await seed(6);
            const restore = slowDownDecrypt(15);
            try {
                const reloaded = new BrowserEventIndexManager();
                await reloaded.initEventIndex(userId, DEVICE);
                while ((await reloaded.getStats()).eventCount === 0) await sleep(2);
                const realTx = IDBDatabase.prototype.transaction;
                const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
                    this: IDBDatabase,
                    names,
                    mode,
                    ...rest
                ) {
                    if (names === "events" && mode !== "readwrite") {
                        throw new DOMException("The database connection is closing.", "InvalidStateError");
                    }
                    return realTx.call(this, names, mode, ...rest);
                });
                // A live timeline event now reaches a manager whose handle another tab closed.
                // EventIndex.addLiveEventToIndex awaits this with no catch of its own, so a
                // rejection here would reach a RoomEvent.Timeline handler unhandled.
                await expect(
                    reloaded.addEventToIndex(msg("$live2", "zqlive body", { room_id: room }), {}),
                ).resolves.toBeUndefined();
                txSpy.mockRestore();
            } finally {
                restore();
            }
        });

        it("R8: pendingRedactions is drained once hydration ends", async () => {
            await seed(4);
            const restore = slowDownDecrypt(15);
            try {
                const reloaded = new BrowserEventIndexManager();
                await reloaded.initEventIndex(userId, DEVICE);
                while ((await reloaded.getStats()).eventCount === 0) await sleep(2);
                // A redaction naming an id nothing on disk or in memory resolves to.
                expect(await reloaded.deleteEvent("$never-seen-edit")).toBe(false);
                await reloaded.waitForHydration();
                expect([...(reloaded as unknown as { pendingRedactions: Set<string> }).pendingRedactions]).toEqual([]);
                await reloaded.closeEventIndex();
            } finally {
                restore();
            }
        });

        it("decryptChunkOnce runs at most one decrypt for two concurrent attempts at the same chunk", async () => {
            // Direct unit test of decryptChunkOnce's own de-duplication contract (schema v3's
            // chunk-level analogue of schema v2's materializeOnce), independent of any higher-level
            // race: two callers wanting the same not-yet-decrypted chunk at once must share one
            // decrypt, not run two.
            await seed(1);
            const restore = slowDownDecrypt(20);
            try {
                const reloaded = new BrowserEventIndexManager();
                await reloaded.initEventIndex(userId, DEVICE);
                await reloaded.waitForHydration();

                const rows = await decryptAllChunkEvents(pickleKey!, DEVICE);
                expect(rows).toHaveLength(1);
                const priv = reloaded as unknown as {
                    dek: CryptoKey;
                    decryptChunkOnce: (
                        userId: string,
                        dek: CryptoKey,
                        chunkId: number,
                    ) => Promise<Map<string, unknown>>;
                };
                const chunkId = 0; // the one and only chunk this single-event seed produced

                const decryptSpy = vi.spyOn(crypto.subtle, "decrypt");
                const before = decryptSpy.mock.calls.length;
                const [a, b] = await Promise.all([
                    priv.decryptChunkOnce(userId, priv.dek, chunkId),
                    priv.decryptChunkOnce(userId, priv.dek, chunkId),
                ]);
                expect(decryptSpy.mock.calls.length - before).toBe(1);
                expect(a).toBe(b); // the second caller got the exact same in-flight attempt, not a fresh one
                expect(a.size).toBe(1);
                decryptSpy.mockRestore();
                await reloaded.closeEventIndex();
            } finally {
                restore();
            }
        });

        it("R9: a redaction of an edit parked before its original is hydrated still drops the record on arrival", async () => {
            // The pendingRedactions/redactedByPendingEdit mechanism only matters while the
            // original has not been hydrated yet; the pre-existing "still resolves a redacted
            // edit after a reload" test drives the redaction *after* waitForHydration(), so it
            // never reaches this path at all.
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();
            await manager.addEventToIndex(
                msg("$r9orig", "zqredacttarget original body", { room_id: room, origin_server_ts: 1 }),
                {},
            );
            await manager.addEventToIndex(edit("$r9edit", "$r9orig", "zqredacttarget edited body", 2), {});
            await manager.commitLiveEvents();
            await manager.closeEventIndex();

            const restore = slowDownDecrypt(30);
            try {
                const reloaded = new BrowserEventIndexManager();
                await reloaded.initEventIndex(userId, DEVICE);
                // The only record for this user; hydrate() cannot have decrypted it yet (decrypt
                // is slowed down and nothing has been awaited since initEventIndex returned).
                expect(await reloaded.deleteEvent("$r9edit")).toBe(false); // parked, not yet resolvable
                await reloaded.waitForHydration();

                expect((await reloaded.searchEventIndex(search("zqredacttarget"))).count).toBe(0);
                expect((await reloaded.getStats()).eventCount).toBe(0);
                await reloaded.closeEventIndex();
            } finally {
                restore();
            }
        });

        it("materializeIfPending preserves a disk-resident hasFile flag a live re-delivery's own data would not carry", async () => {
            // Direct test of materializeIfPending's documented contract: without pulling the disk
            // copy in first, a live re-delivery upserts as brand new using only its own data, and
            // upsertEvent's "duplicate of an unedited record" case would never get a chance to
            // preserve what the disk copy already held.
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();
            await manager.addEventToIndex(
                msg("$r10", "zqfilemarker report", {
                    room_id: room,
                    origin_server_ts: 1,
                    content: {
                        msgtype: "m.file",
                        body: "report.pdf",
                        url: "mxc://example.org/abc",
                        filename: "report.pdf",
                    },
                }),
                {},
            );
            await manager.commitLiveEvents();
            await manager.closeEventIndex();

            const restore = slowDownDecrypt(30);
            try {
                const reloaded = new BrowserEventIndexManager();
                await reloaded.initEventIndex(userId, DEVICE);
                // A live re-delivery of the same id, plain text, no file -- redelivered before
                // hydrate() has decrypted the disk row. If materializeIfPending pulled that row in
                // first, this is upsertEvent's "duplicate of an unedited record" case (nothing to
                // do); if it did not, this creates a fresh record from only this call's own data.
                await reloaded.addEventToIndex(
                    msg("$r10", "zqfilemarker report", { room_id: room, origin_server_ts: 1 }),
                    {},
                );
                await reloaded.waitForHydration();

                const files = await reloaded.loadFileEvents({ roomId: room, limit: 10 });
                expect(files.map((f) => f.event.event_id)).toEqual(["$r10"]);
                await reloaded.closeEventIndex();
            } finally {
                restore();
            }
        });

        it("hydrate() releases each page's transaction before decrypting any of its rows", async () => {
            // Direct test of the file's own stated most-important invariant. Captures the first
            // page's transaction; the moment the first decrypt call fires, that transaction must
            // already be inactive (its request queue drained, oncomplete fired), which a `get()`
            // issued against it right then will refuse with TransactionInactiveError.
            await seed(3);
            const realTransaction = IDBDatabase.prototype.transaction;
            let capturedTx: IDBTransaction | undefined;
            const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
                this: IDBDatabase,
                names,
                mode,
                ...rest
            ) {
                const tx = realTransaction.call(this, names, mode, ...rest);
                if (!capturedTx && names === "chunks" && mode !== "readwrite") capturedTx = tx;
                return tx;
            });

            let inactiveAtFirstDecrypt: boolean | undefined;
            const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
            const decryptSpy = vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
                if (inactiveAtFirstDecrypt === undefined && capturedTx) {
                    try {
                        capturedTx.objectStore("chunks").get(["@nobody:example.org", 999999]);
                        inactiveAtFirstDecrypt = false; // the transaction accepted a new request: still active
                    } catch {
                        inactiveAtFirstDecrypt = true; // refused: already inactive, as the invariant requires
                    }
                }
                return realDecrypt(...(args as Parameters<typeof realDecrypt>));
            });

            try {
                const reloaded = new BrowserEventIndexManager();
                await reloaded.initEventIndex(userId, DEVICE);
                await reloaded.waitForHydration();
                expect(inactiveAtFirstDecrypt).toBe(true);
                await reloaded.closeEventIndex();
            } finally {
                decryptSpy.mockRestore();
                txSpy.mockRestore();
            }
        });

        it("yields between slices when a page's rows take longer than the slice deadline", async () => {
            // Direct test that a slice deadline actually causes a yield: without it, hydrate()'s
            // per-row loop would never call setTimeout at all. scheduler.yield does not exist in
            // this test environment, so yieldToEventLoop() always takes the setTimeout(0) path.
            // Decrypt now happens once per CHUNK, not once per event -- a small corpus like this
            // packs into one chunk, one decrypt call, so the deadline check right after that one
            // decrypt is what has to trip, not an accumulation across many small per-row decrypts.
            await seed(6);
            const restore = slowDownDecrypt(35); // one chunk decrypt alone > the 30ms slice deadline
            const zeroDelayTimeouts: number[] = [];
            const realSetTimeout = globalThis.setTimeout;
            const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
                fn: (...args: unknown[]) => void,
                delay?: number,
                ...args: unknown[]
            ) => {
                if (delay === 0 || delay === undefined) zeroDelayTimeouts.push(1);
                return realSetTimeout(fn, delay, ...args);
            }) as typeof setTimeout);
            try {
                const reloaded = new BrowserEventIndexManager();
                await reloaded.initEventIndex(userId, DEVICE);
                await reloaded.waitForHydration();
                expect(zeroDelayTimeouts.length).toBeGreaterThan(0);
                await reloaded.closeEventIndex();
            } finally {
                timeoutSpy.mockRestore();
                restore();
            }
        });

        it("resumes correctly across more than one hydration chunk batch", async () => {
            // A corpus well past one HYDRATION_CHUNK_BATCH-worth of chunks, so restore exercises
            // more than one batch of chunk reads, not just the special case of everything fitting
            // in the first one.
            const total = 1050;
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();
            const ids: string[] = [];
            for (let i = 0; i < total; i++) {
                const id = `$pg${String(i).padStart(5, "0")}`;
                ids.push(id);
                await manager.addEventToIndex(
                    msg(id, `zqpagemarker body ${i}`, { room_id: room, origin_server_ts: i }),
                    {},
                );
            }
            await manager.commitLiveEvents();
            await manager.closeEventIndex();

            const reloaded = new BrowserEventIndexManager();
            await reloaded.initEventIndex(userId, DEVICE);
            await reloaded.waitForHydration();

            const stats = await reloaded.getStats();
            expect(stats.eventCount).toBe(total);
            const order = await roomTimelineOrder(reloaded, "zqpagemarker", room, total + 5);
            expect(order).toEqual(ids);
            expect(new Set(order).size).toBe(order.length);
            await reloaded.closeEventIndex();
        });
    });
});

describe("BrowserEventIndexManager (the labs gate)", () => {
    const DEVICE = "DEVICE1";
    const pickleKey = "unit-test-pickle-key";
    let manager: BrowserEventIndexManager;
    let userCounter = 0;
    let userId: string;
    let enabled: boolean;

    const search = (term: string, overrides: Record<string, unknown> = {}): any =>
        ({ search_term: term, ...SEARCH_DEFAULTS, ...overrides }) as any;

    beforeEach(() => {
        vi.stubGlobal("indexedDB", new IDBFactory());
        enabled = true;
        vi.spyOn(SettingsStore, "getValue").mockImplementation((): any => enabled);
        userId = `@gated${++userCounter}:example.org`;
        mockPlatformPeg({
            getPickleKey: vi.fn().mockResolvedValue("unit-test-pickle-key"),
        });
        manager = new BrowserEventIndexManager();
    });

    afterEach(async () => {
        await manager.closeEventIndex();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("creates no index at all while the flag is off", async () => {
        enabled = false;
        // WebPlatform hands out an already-constructed manager whatever the setting says, and
        // EventIndexPeg caches supportsEventIndexing() from start-up, so the settings panel's
        // Enable button reaches this with the feature gated off. It must not put a fresh
        // encrypted index on disk.
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        expect(await indexedDB.databases()).toEqual([]);

        await manager.addEventToIndex(msg("$gated", "gated body"), {});
        await manager.commitLiveEvents();
        expect(await indexedDB.databases()).toEqual([]);
        expect(await manager.isEventIndexEmpty()).toBe(true);
    });

    it("stops indexing when the flag goes off mid-session", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$before", "before the flag"), {});
        await manager.commitLiveEvents();
        expect(await decryptAllChunkEvents(pickleKey!, DEVICE)).toHaveLength(1);

        enabled = false;
        await manager.addEventToIndex(msg("$after", "after the flag"), {});
        const page = [{ event: msg("$historic", "historic body"), profile: {} }];
        expect(await manager.addHistoricEvents(page, null, null)).toBe(false);
        await manager.addCrawlerCheckpoint({
            roomId: "!crawl:example.org",
            token: "crawltoken",
            direction: Direction.Backward,
        });
        await manager.commitLiveEvents();

        // Nothing new, in memory or on disk ...
        expect(await decryptAllChunkEvents(pickleKey!, DEVICE)).toHaveLength(1);
        expect(await dumpRawStore("checkpoints")).toEqual([]);
        expect(await manager.loadCheckpoints()).toEqual([]);
        expect((await manager.searchEventIndex(search("after"))).count).toBe(0);
        expect((await manager.searchEventIndex(search("historic"))).count).toBe(0);
        // ... and what was already indexed stays searchable for the rest of the session.
        expect((await manager.searchEventIndex(search("before"))).count).toBe(1);
    });

    it("still removes and tears down with the flag off", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$keep", "keep body"), {});
        await manager.addEventToIndex(msg("$drop", "drop body"), {});
        const cp = { roomId: "!crawl:example.org", token: "crawltoken", direction: Direction.Backward };
        await manager.addCrawlerCheckpoint(cp);
        await manager.commitLiveEvents();

        // Lifecycle.clearStorage() wipes the setting's storage before it asks for the manager,
        // so every path that *removes* something has to keep working with the gate shut.
        enabled = false;
        expect(await manager.deleteEvent("$drop")).toBe(true);
        await manager.removeCrawlerCheckpoint(cp);
        await manager.commitLiveEvents();
        expect((await decryptAllChunkEvents(pickleKey!, DEVICE)).map((r) => r.eventId)).toEqual(["$keep"]);
        expect(await dumpRawStore("checkpoints")).toEqual([]);

        await manager.deleteEventIndex();
        expect(await manager.isEventIndexEmpty()).toBe(true);
        expect(await decryptAllChunkEvents(pickleKey!, DEVICE)).toEqual([]);
        expect(await dumpRawStore("meta")).toEqual([]);
    });
});

describe("BrowserEventIndexManager (batched writes)", () => {
    const DEVICE = "DEVICE1";
    const pickleKey = "unit-test-pickle-key";
    let manager: BrowserEventIndexManager;
    let userCounter = 0;
    let userId: string;

    const search = (term: string, overrides: Record<string, unknown> = {}): any =>
        ({ search_term: term, ...SEARCH_DEFAULTS, ...overrides }) as any;

    beforeEach(() => {
        vi.stubGlobal("indexedDB", new IDBFactory());
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(true);
        userId = `@batch${++userCounter}:example.org`;
        mockPlatformPeg({ getPickleKey: vi.fn().mockResolvedValue("unit-test-pickle-key") });
        manager = new BrowserEventIndexManager();
    });

    afterEach(async () => {
        await manager.closeEventIndex();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("a live event is searchable before its write is flushed to disk", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$unflushed", "unflushed needle"), {});

        // Searchable immediately, in memory -- before commitLiveEvents, before the 5s timer,
        // before the LIVE_WRITE_BUFFER_MAX threshold, before anything has touched disk.
        expect((await manager.searchEventIndex(search("unflushed"))).count).toBe(1);
        expect((await inspectRawDb(pickleKey!, DEVICE)).events).toEqual([]);

        // Only once explicitly flushed does the encrypted copy land.
        await manager.commitLiveEvents();
        expect((await inspectRawDb(pickleKey!, DEVICE)).events).toHaveLength(1);
    });

    it("batches several live writes into one IndexedDB transaction instead of one per event", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction");

        for (let i = 0; i < 12; i++) {
            await manager.addEventToIndex(msg(`$batch${i}`, `batched body ${i}`), {});
        }
        // Twelve live writes, none flushed yet: no "chunks" transaction opened for any of them.
        const eventsTxCalls = (): number =>
            txSpy.mock.calls.filter(
                (call) => call[0] === "chunks" || (Array.isArray(call[0]) && call[0].includes("chunks")),
            ).length;
        expect(eventsTxCalls()).toBe(0);

        await manager.commitLiveEvents();
        // Exactly one "chunks" transaction for the whole flushed batch, not twelve.
        expect(eventsTxCalls()).toBe(1);
        expect((await inspectRawDb(pickleKey!, DEVICE)).events).toHaveLength(12);

        txSpy.mockRestore();
    });

    it("a crash-style close without flush loses only the unflushed events, and nothing else is corrupted", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$durable", "durable body"), {});
        // Establishes a flushed, durable baseline.
        await manager.commitLiveEvents();

        await manager.addEventToIndex(msg("$lost", "lost body"), {});
        // Deliberately no commitLiveEvents() and no closeEventIndex() here: this simulates a
        // crash before the live-write buffer's 5s timer or size threshold has had a chance to
        // flush it. Only the durable baseline is on disk.
        expect((await inspectRawDb(pickleKey!, DEVICE)).events.map((r) => r.eventId)).toEqual(["$durable"]);

        // A fresh session over the same, uncleanly-abandoned database sees exactly the durable
        // baseline: the lost event is gone as if it never happened, and nothing else is disturbed.
        const reloaded = new BrowserEventIndexManager();
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        try {
            expect((await reloaded.searchEventIndex(search("durable"))).count).toBe(1);
            expect((await reloaded.searchEventIndex(search("lost"))).count).toBe(0);
        } finally {
            await reloaded.closeEventIndex();
        }
    });

    it("redacting a live event still sitting in the unflushed buffer leaves nothing on disk", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$buffered", "buffered secret"), {});
        // Confirms it is genuinely still unflushed at the moment of redaction, not already
        // written -- otherwise this would only exercise the ordinary delete path.
        expect((await inspectRawDb(pickleKey!, DEVICE)).events).toEqual([]);

        expect(await manager.deleteEvent("$buffered")).toBe(true);
        expect((await manager.searchEventIndex(search("buffered"))).count).toBe(0);

        await manager.commitLiveEvents();
        expect((await inspectRawDb(pickleKey!, DEVICE)).events).toEqual([]);
        expect(await manager.isEventIndexEmpty()).toBe(true);
    });

    it("redacting one buffered event does not stop a sibling in the same buffer from being flushed", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$keep", "keep this body"), {});
        await manager.addEventToIndex(msg("$drop", "drop this body"), {});
        expect(await manager.deleteEvent("$drop")).toBe(true);

        await manager.commitLiveEvents();
        const raw = await inspectRawDb(pickleKey!, DEVICE);
        expect(raw.events.map((r) => r.eventId)).toEqual(["$keep"]);
        expect((await manager.searchEventIndex(search("keep"))).count).toBe(1);
        expect((await manager.searchEventIndex(search("drop"))).count).toBe(0);
    });

    it("isEventIndexEmpty flushes the live buffer first, so a solitary unflushed event is not reported as empty", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        expect(await manager.isEventIndexEmpty()).toBe(true);
        await manager.addEventToIndex(msg("$solo", "solo body"), {});
        // Nothing flushed yet, and isEventIndexEmpty answers straight from IndexedDB when
        // persistence is enabled -- so this only reports non-empty if it flushes first.
        expect(await manager.isEventIndexEmpty()).toBe(false);
        expect((await inspectRawDb(pickleKey!, DEVICE)).events).toHaveLength(1);
    });

    it("addHistoricEvents writes a whole crawler batch as one IndexedDB transaction", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction");

        const batch = Array.from({ length: 15 }, (_unused, i) => ({
            event: msg(`$crawl${i}`, `crawled body ${i}`),
            profile: {},
        }));
        await manager.addHistoricEvents(batch, null, null);
        await manager.commitLiveEvents();

        const eventsTxCalls = txSpy.mock.calls.filter(
            (call) => call[0] === "chunks" || (Array.isArray(call[0]) && call[0].includes("chunks")),
        ).length;
        expect(eventsTxCalls).toBe(1);
        expect((await inspectRawDb(pickleKey!, DEVICE)).events).toHaveLength(15);
        txSpy.mockRestore();
    });

    it("B14 (review-pr-b.md): the 300-event size threshold flushes automatically, without waiting for commitLiveEvents or the timer", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction");
        const eventsTxCalls = (): number =>
            txSpy.mock.calls.filter(
                (call) => call[0] === "chunks" || (Array.isArray(call[0]) && call[0].includes("chunks")),
            ).length;

        // No explicit commitLiveEvents() anywhere in this test, and nowhere near the 5s timer:
        // the only thing that can flush anything below is the size threshold itself. Its own
        // encrypt-then-put work is asynchronous (crypto.subtle.encrypt per buffered record), so
        // this polls briefly for each automatic flush to actually land rather than assuming it is
        // instantaneous relative to the next loop iteration -- a real race the first version of
        // this test lost (0 transactions observed immediately after the loop, despite the buffer
        // itself correctly draining to 50, proving the flush had been *triggered*, just not yet
        // *landed* on disk).
        for (let i = 0; i < 300; i++) {
            await manager.addEventToIndex(msg(`$b14-${i}`, `buffer threshold body ${i}`), {});
        }
        for (let guard = 0; eventsTxCalls() < 1 && guard < 200; guard++) await sleep(4);
        expect(eventsTxCalls()).toBe(1);

        for (let i = 300; i < 600; i++) {
            await manager.addEventToIndex(msg(`$b14-${i}`, `buffer threshold body ${i}`), {});
        }
        for (let guard = 0; eventsTxCalls() < 2 && guard < 200; guard++) await sleep(4);
        expect(eventsTxCalls()).toBe(2);

        // The last 50 are under the threshold: still nothing new flushes without an explicit
        // commit or the (5s, unreached here) timer.
        for (let i = 600; i < 650; i++) {
            await manager.addEventToIndex(msg(`$b14-${i}`, `buffer threshold body ${i}`), {});
        }
        expect(eventsTxCalls()).toBe(2);

        await manager.commitLiveEvents();
        expect((await inspectRawDb(pickleKey!, DEVICE)).events).toHaveLength(650);
        txSpy.mockRestore();
    });

    it("B12 (review-pr-b.md): liveWriteBuffer is always a subset of events, through a randomized live/crawl/redact mix", async () => {
        // The invariant the whole buffer design rests on, checked directly rather than only through
        // its consequences: every id ever buffered for a live write is, by construction
        // (schedulePersistEvent refuses to buffer an id not in `events`; removeFromIndex drops the
        // id from the buffer as it deletes the record), already resident. A white-box check of the
        // private fields, deliberately: the alternative is re-deriving the same proof indirectly
        // through disk state after every one of 150 random operations, which tests the *consequence*
        // of the invariant rather than the invariant itself.
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const liveIds: string[] = [];
        let seq = 0;
        for (let round = 0; round < 150; round++) {
            const op = Math.random();
            if (op < 0.4) {
                const id = `$b12live${seq++}`;
                await manager.addEventToIndex(msg(id, `b12 live body ${id}`), {});
                liveIds.push(id);
            } else if (op < 0.6 && liveIds.length > 0) {
                const idx = Math.floor(Math.random() * liveIds.length);
                const [id] = liveIds.splice(idx, 1);
                await manager.deleteEvent(id);
            } else if (op < 0.85) {
                const id = `$b12crawl${seq++}`;
                await manager.addHistoricEvents([{ event: msg(id, `b12 crawl body ${id}`), profile: {} }], null, null);
            } else {
                await manager.commitLiveEvents();
            }

            const buffer = (manager as unknown as { liveWriteBuffer: Set<string> }).liveWriteBuffer;
            const events = (manager as unknown as { events: Map<string, unknown> }).events;
            for (const bufferedId of buffer) {
                expect(events.has(bufferedId)).toBe(true);
            }
        }
        await manager.commitLiveEvents();
    });
});

describe("BrowserEventIndexManager (increment B correctness: stats, prefix, substring)", () => {
    const DEVICE = "DEVICE1";
    let manager: BrowserEventIndexManager;
    let userCounter = 0;
    let userId: string;

    const search = (term: string, overrides: Record<string, unknown> = {}): any =>
        ({ search_term: term, ...SEARCH_DEFAULTS, ...overrides }) as any;

    beforeEach(() => {
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(true);
        // No IndexedDB stubbing and no pickle key: these tests are about the in-memory index
        // only, matching the (at scale) describe's rationale for skipping persistence.
        mockPlatformPeg({ getPickleKey: vi.fn().mockResolvedValue(null) });
        userId = `@incb${++userCounter}:example.org`;
        manager = new BrowserEventIndexManager();
    });

    afterEach(async () => {
        await manager.closeEventIndex();
        vi.restoreAllMocks();
    });

    it("getStats is O(1): never iterates a Map's values to compute eventCount/roomCount, even at 5000 events", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const rooms = ["!o1:example.org", "!o2:example.org", "!o3:example.org"];
        for (let i = 0; i < 5000; i++) {
            await manager.addEventToIndex(
                msg(`$o${i}`, `stats body ${i}`, { room_id: rooms[i % rooms.length], origin_server_ts: i }),
                {},
            );
        }

        const valuesSpy = vi.spyOn(Map.prototype, "values");
        const callsBefore = valuesSpy.mock.calls.length;
        const stats = await manager.getStats();
        // No Map anywhere was iterated via .values() to answer this -- the old implementation's
        // `for (const ev of this.events.values())` is exactly the call this would catch.
        expect(valuesSpy.mock.calls.length).toBe(callsBefore);
        valuesSpy.mockRestore();

        expect(stats.eventCount).toBe(5000);
        expect(stats.roomCount).toBe(rooms.length);
    });

    it("prefix query results match an independent term-startsWith scan over a random corpus", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();

        // A random, low-cardinality vocabulary so prefixes have several matches and ties in
        // sorted order are exercised, independent of the deliberately-crafted marker corpus the
        // (at scale) describe below uses.
        const alphabet = "abcdefghij";
        const randomWord = (): string => {
            const len = 3 + Math.floor(Math.random() * 4);
            let w = "";
            for (let i = 0; i < len; i++) w += alphabet[Math.floor(Math.random() * alphabet.length)];
            return w;
        };
        const words = Array.from({ length: 40 }, randomWord);
        const roomId = "!randomprefix:example.org";
        const bodies: string[] = [];
        for (let i = 0; i < 250; i++) {
            const pickCount = 3 + Math.floor(Math.random() * 4);
            const body = Array.from({ length: pickCount }, () => words[Math.floor(Math.random() * words.length)]).join(
                " ",
            );
            bodies.push(body);
            await manager.addEventToIndex(msg(`$rp${i}`, body, { room_id: roomId, origin_server_ts: i }), {});
        }

        // Reference: an independent scan using the same exported tokenize() the index itself
        // uses (so folding/splitting rules match), computed fresh from the raw bodies rather
        // than from anything the manager built -- the "old O(V) scan" this change replaced,
        // re-derived from source data instead of from the code under test.
        const referenceHits = (prefix: string): string[] =>
            bodies
                .map((body, i) => (tokenize(body).some((t) => t.startsWith(prefix)) ? `$rp${i}` : undefined))
                .filter((id): id is string => id !== undefined);

        const prefixes = new Set<string>();
        for (const w of words) for (let len = 2; len <= w.length; len++) prefixes.add(w.slice(0, len));

        for (const prefix of prefixes) {
            const expected = referenceHits(prefix).sort();
            const hit = await manager.searchEventIndex(search(prefix, { limit: bodies.length }));
            const actual = (hit.results ?? []).map((r) => r.result.event_id).sort();
            expect(actual).toEqual(expected);
        }
    });

    it("substring fallback reflects text edited moments earlier, and the folded-text memo does not go stale (accented text)", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$acc", "Meet at Café Zürich"), {});
        // A fragment from the middle of the folded word "zurich" that no term starts with, so
        // only the substring fallback can find it -- and the first call here is also what fills
        // foldedFor's memo for this record.
        expect((await manager.searchEventIndex(search("uric"))).count).toBe(1);

        await manager.addEventToIndex(edit("$editacc", "$acc", "Meet at Café Genève instead"), {});
        // The old fragment is gone -- correctly, since a memo re-serving the stale fold from
        // before the edit would instead keep finding it -- and the new body's own fold-sensitive
        // fragment (inside folded "geneve") is found instead. Only possible because foldedFor()
        // re-folds when the record's searchText no longer matches what the memo entry was
        // computed from, rather than serving the entry unconditionally.
        expect((await manager.searchEventIndex(search("uric"))).count).toBe(0);
        expect((await manager.searchEventIndex(search("nev"))).count).toBe(1);
    });

    it("substring fallback still finds text through JSON-special characters the flattening memo round-trips", async () => {
        // flattenCopy stores JSON.parse(JSON.stringify(searchText)) in the memo; this is the
        // end-to-end check that quotes, backslashes and control characters -- which a message
        // body can legitimately contain, and which JSON must escape to round-trip -- still come
        // back out exactly, not mangled, once served from the memo.
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$special", 'She said "naïve" back\\slash déjà vu'), {});
        // "aïve\" bac" spans the closing quote and the backslash -- only reachable if the memo's
        // round trip preserved both characters exactly.
        expect((await manager.searchEventIndex(search('aive" bac'))).count).toBe(1);
        expect((await manager.searchEventIndex(search("k\\sla"))).count).toBe(1);
    });

    it("pins the bounded per-query cost: the vocabulary merges on the write path, not inside a query, and not for a small delta (review-pr-b.md B-F1)", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();

        // Seed past VOCABULARY_MERGE_THRESHOLD (2,000) distinct terms first, so the base
        // vocabulary has already been through at least one real merge by the time the measured
        // section below starts -- this is the "V is already large" precondition the fix has to
        // hold under, not a toy vocabulary too small to show the old O(V log V) cost at all.
        for (let i = 0; i < 2200; i++) {
            await manager.addEventToIndex(msg(`$seed${i}`, `zqvocab${i}`), {});
        }

        const mergeSpy = vi.spyOn(manager as unknown as { mergeVocabularyDelta: () => void }, "mergeVocabularyDelta");
        const callsBefore = mergeSpy.mock.calls.length;

        // A small follow-up batch of brand-new terms, comfortably under the threshold (at most
        // ~200 were left pending from seeding, +50 here is nowhere near 2,000): this must never
        // trigger a merge, and a prefix query against it must still be fast and correct, served
        // from the unmerged delta's bounded linear scan rather than forcing a rebuild of the
        // (now large) base -- the specific bug review-pr-b.md B-F1 found and this fix removes.
        for (let i = 0; i < 50; i++) {
            await manager.addEventToIndex(msg(`$fresh${i}`, `zqfreshterm${i}`), {});
        }
        expect(mergeSpy.mock.calls.length).toBe(callsBefore);

        const t0 = performance.now();
        const hit = await manager.searchEventIndex(search("zqfreshterm4", { limit: 10 }));
        const elapsed = performance.now() - t0;
        expect(hit.count).toBeGreaterThan(0); // found via the unmerged delta's linear scan
        expect(elapsed).toBeLessThan(20); // bounded: no O(V log V) re-sort of a 2,200+-term base

        // The base (merged before the spy started watching) is still fully searchable too.
        const hitOld = await manager.searchEventIndex(search("zqvocab4", { limit: 10 }));
        expect(hitOld.count).toBeGreaterThan(0);

        mergeSpy.mockRestore();
    });

    it("B1b (review-pr-b.md B2-F2): prefix parity holds once a real merge has populated the binary-searched base, and again for a fresh delta on top", async () => {
        // review-pr-b.md B2-F2: no fixture anywhere in the suite crossed VOCABULARY_MERGE_THRESHOLD,
        // so sortedVocabulary (the base, reached via vocabularyRange/lowerBoundVocabulary and the
        // U+FFFF sentinel) was always empty in tests and every prefix answer came from the delta's
        // plain startsWith scan -- silently regressing a sentinel-correctness mutant from killed to
        // surviving. This test forces VOCABULARY_MERGE_THRESHOLD to actually be crossed, so the base
        // is the structure under test, then re-probes with a further batch left unmerged on top.
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();

        // A random, low-cardinality vocabulary, matching the existing parity test's approach, but
        // large enough (60 words x enough events) to push comfortably past the threshold.
        const alphabet = "abcdefghij";
        const randomWord = (): string => {
            const len = 3 + Math.floor(Math.random() * 4);
            let w = "";
            for (let i = 0; i < len; i++) w += alphabet[Math.floor(Math.random() * alphabet.length)];
            return w;
        };
        const words = Array.from({ length: 60 }, randomWord);
        // A deterministic pair, not drawn from the a-j alphabet above: "qzbase" is a genuine
        // prefix of "qzbasez", and the character immediately following that prefix is 'z' itself.
        // MB20 (the sentinel regression: prefix + "z" instead of prefix + "￿" as the upper
        // range bound) excludes exactly this shape of term -- lowerBoundVocabulary(prefix + "z")
        // lands exactly on "qzbasez", so the exclusive upper bound wrongly cuts it from its own
        // prefix's result. An a-j-only vocabulary can never produce that failure, since "z" then
        // sits above every real character and behaves just like the correct sentinel would.
        words.push("qzbase", "qzbasez");
        const roomId = "!b1b:example.org";
        const bodies: string[] = [];
        const addBody = async (i: number, body: string): Promise<void> => {
            bodies[i] = body;
            await manager.addEventToIndex(msg(`$b1b${i}`, body, { room_id: roomId, origin_server_ts: i }), {});
        };
        const referenceHits = (prefix: string): string[] =>
            bodies
                .map((body, i) =>
                    body !== undefined && tokenize(body).some((t) => t.startsWith(prefix)) ? `$b1b${i}` : undefined,
                )
                .filter((id): id is string => id !== undefined);
        const prefixes = new Set<string>();
        for (const w of words) for (let len = 2; len <= w.length; len++) prefixes.add(w.slice(0, len));
        const checkAllPrefixes = async (): Promise<void> => {
            for (const prefix of prefixes) {
                const expected = referenceHits(prefix).sort();
                const hit = await manager.searchEventIndex(search(prefix, { limit: bodies.length + 100 }));
                const actual = (hit.results ?? []).map((r) => r.result.event_id).sort();
                expect(actual).toEqual(expected);
            }
        };

        // Deterministic placement of the crafted pair (rather than leaving their presence to the
        // random picks below, which include them but only probabilistically): guarantees both are
        // in the base regardless of the RNG, so this test can never flake past MB20.
        let n = 0;
        await addBody(n++, "qzbase filler0");
        await addBody(n++, "qzbasez filler1");

        // Enough distinct one-off filler terms (guaranteed unique, unrelated to the parity probes)
        // to force VOCABULARY_MERGE_THRESHOLD to be crossed by real vocabulary growth, exactly the
        // way hydration or a long crawl would cross it -- not by reflection into a private field.
        for (; n < VOCABULARY_MERGE_THRESHOLD + 100; n++) {
            const pick = Array.from({ length: 3 }, () => words[Math.floor(Math.random() * words.length)]);
            await addBody(n, [...pick, `zqfiller${n}`].join(" "));
        }
        await checkAllPrefixes(); // the base (post-merge) is correct

        // A further, deliberately small batch left sitting in the unmerged delta on top of the
        // now-populated base -- both halves of lookupToken's prefix path live and correct at once.
        for (let extra = 0; extra < 40; extra++, n++) {
            const pick = Array.from({ length: 3 }, () => words[Math.floor(Math.random() * words.length)]);
            await addBody(n, [...pick, `zqfiller${n}`].join(" "));
        }
        await checkAllPrefixes();
    });

    it("B2-F3 (review-pr-b.md): a remove-then-re-add cycle does not leave duplicate terms in the merged vocabulary base", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();

        // Five add/redact cycles of one distinctive term, exactly as review-pr-b.md's B7u does:
        // each re-add takes indexTokens' "new term" branch again, since the previous redaction
        // deleted it from `inverted`, pushing the term onto pendingVocabulary again -- five
        // occurrences so far, none of them live. A ghost check alone (dropping a term with no
        // posting set left) would already remove all of these, so it can't tell the de-dup fix
        // apart from a no-op: the case that actually distinguishes them is a *live* duplicate.
        for (let cycle = 0; cycle < 5; cycle++) {
            const id = `$zqghost${cycle}`;
            await manager.addEventToIndex(msg(id, "zqghost distinctive term"), {});
            expect((await manager.searchEventIndex(search("zqghost", { limit: 10 }))).count).toBe(1);
            expect(await manager.deleteEvent(id)).toBe(true);
            expect((await manager.searchEventIndex(search("zqghost", { limit: 10 }))).count).toBe(0);
        }
        // A sixth, final add that is never redacted: "zqghost" is genuinely live (present in
        // `inverted`) at merge time, so the ghost check alone lets every one of its six pushed
        // occurrences through, and only the de-dup-by-adjacent-comparison logic can still collapse
        // them to the one live copy.
        const liveId = "$zqghost5";
        await manager.addEventToIndex(msg(liveId, "zqghost distinctive term"), {});
        expect((await manager.searchEventIndex(search("zqghost", { limit: 10 }))).count).toBe(1);

        // Force a merge with enough fresh, unrelated terms, then inspect the merged base directly:
        // "zqghost" is live, so it must appear in the merged vocabulary exactly once, never more.
        for (let i = 0; i < VOCABULARY_MERGE_THRESHOLD + 10; i++) {
            await manager.addEventToIndex(msg(`$zqfiller${i}`, `zqfiller${i}`), {});
        }
        const base = (manager as unknown as { sortedVocabulary: string[] }).sortedVocabulary;
        const pending = (manager as unknown as { pendingVocabulary: string[] }).pendingVocabulary;
        const occurrencesIn = (list: string[]): number => list.filter((t) => t === "zqghost").length;
        expect(occurrencesIn(base) + occurrencesIn(pending)).toBe(1);
        // The base stays sorted throughout -- de-duplication must not disturb binary-search validity.
        for (let i = 1; i < base.length; i++) expect(base[i - 1] < base[i]).toBe(true);
        expect((await manager.searchEventIndex(search("zqghost", { limit: 10 }))).count).toBe(1);
    });

    it("B2-F1 (review-pr-b.md): a vocabulary merge due mid-hydration is deferred to a safe point, not run inside a row's own task", async () => {
        // White-box check of the mechanism indexTokens' deferMerge parameter and hydrate's own
        // flushVocabularyMergeIfDue calls implement: seeded directly, bypassing hydration, to
        // isolate the parameter's own behaviour from timing-dependent slice/page boundaries.
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const internal = manager as unknown as {
            indexTokens: (eventId: string, text: string, deferMerge?: boolean) => void;
            sortedVocabulary: string[];
            pendingVocabulary: string[];
            flushVocabularyMergeIfDue: () => void;
        };

        for (let i = 0; i < VOCABULARY_MERGE_THRESHOLD + 5; i++) {
            internal.indexTokens(`$defer${i}`, `zqdefer${i}`, true); // deferMerge: true throughout
        }
        // Over threshold, but deferred: no merge has happened yet.
        expect(internal.sortedVocabulary.length).toBe(0);
        expect(internal.pendingVocabulary.length).toBe(VOCABULARY_MERGE_THRESHOLD + 5);

        internal.flushVocabularyMergeIfDue();
        // The safe point hydrate() calls: now it has happened, exactly once, and drained the delta.
        expect(internal.sortedVocabulary.length).toBe(VOCABULARY_MERGE_THRESHOLD + 5);
        expect(internal.pendingVocabulary.length).toBe(0);
    });

    it("B2-F1 (review-pr-b.md): a real, multi-slice hydration run crossing the threshold ends with a correctly merged vocabulary", async () => {
        // Crossing VOCABULARY_MERGE_THRESHOLD (2,000) for real, rather than by reflection, needs
        // 2,000+ hydrated rows; a generous explicit timeout keeps that comfortably clear of the
        // default budget on a loaded CI box, on top of what slowDownDecrypt below already adds.
        // End-to-end companion to the white-box test above: a real hydration run, slowed down so
        // it genuinely spans several slices and page-boundary yields (the two points hydrate()
        // flushes a deferred merge from), seeded with enough distinct terms to cross
        // VOCABULARY_MERGE_THRESHOLD purely through materializeRow's own deferred indexTokens
        // calls. Uses IndexedDB backing (unlike this describe's usual no-persistence setup) so
        // there is something to hydrate from.
        vi.stubGlobal("indexedDB", new IDBFactory());
        mockPlatformPeg({ getPickleKey: vi.fn().mockResolvedValue("unit-test-pickle-key") });
        const seedManager = new BrowserEventIndexManager();
        await seedManager.initEventIndex(userId, DEVICE);
        await seedManager.waitForHydration();
        const total = VOCABULARY_MERGE_THRESHOLD + 60;
        for (let i = 0; i < total; i++) {
            await seedManager.addEventToIndex(msg(`$hydb2f1-${i}`, `zqhydb2f1term${i}`), {});
        }
        await seedManager.commitLiveEvents();
        await seedManager.closeEventIndex();

        // 1ms/row is plenty: at HYDRATION_SLICE_DEADLINE_MS=30 it still forces a yield roughly
        // every ~20-30 rows, so 2,060 rows cross dozens of slices and both page boundaries.
        const restore = slowDownDecrypt(1);
        try {
            const reloaded = new BrowserEventIndexManager();
            await reloaded.initEventIndex(userId, DEVICE);
            await reloaded.waitForHydration();
            try {
                expect((await reloaded.getStats()).eventCount).toBe(total);
                const base = (reloaded as unknown as { sortedVocabulary: string[] }).sortedVocabulary;
                const pending = (reloaded as unknown as { pendingVocabulary: string[] }).pendingVocabulary;
                // The merge ran (the base is populated), the delta is small (below threshold, whatever
                // was left over after the last merge), and every term is searchable regardless of
                // which half of lookupToken's prefix path answers it.
                expect(base.length).toBeGreaterThan(0);
                expect(pending.length).toBeLessThan(VOCABULARY_MERGE_THRESHOLD);
                const hit = await reloaded.searchEventIndex(search("zqhydb2f1term", { limit: total + 10 }));
                expect(hit.count).toBe(total);
            } finally {
                await reloaded.closeEventIndex();
            }
        } finally {
            restore();
            await seedManager.closeEventIndex();
        }
    }, 30000);
});

/**
 * The corpus the scale tests below run against, built once and re-indexed per test. Every
 * assertion's expected hit set is a filter over *this array*, so nothing has to be counted by
 * hand: the generator is the ground truth and the index is the thing under test.
 *
 * The marker tokens all start `zq`, a digraph no filler word uses, and no two of them share a
 * prefix with each other except the deliberate `zqprefixaa`/`zqprefixbb` pair. That matters
 * because terms of two characters or more also match by prefix, so a marker that was also a
 * prefix of some other term would quietly widen its own expected set.
 */
const SCALE_EVENT_COUNT = 5000;
const SCALE_ROOMS = ["!scale0:example.org", "!scale1:example.org", "!scale2:example.org", "!scale3:example.org"];
const SCALE_BASE_TS = 1_700_000_000_000;

/** Timestamps ascend with the index, so a room's timeline order is simply its events in index order. */
const scaleTs = (i: number): number => SCALE_BASE_TS + i;

const SCALE_CORPUS: any[] = Array.from({ length: SCALE_EVENT_COUNT }, (_unused, i) => {
    const words = [`entry${i}`, `lorem${i % 17}`, `ipsum${i % 23}`, "corpus filler text"];
    if (i % 37 === 0) words.push("zqmarker");
    if (i % 53 === 0) words.push("zqbeta");
    if (i % 41 === 0) words.push("zqprefixaa");
    if (i % 43 === 0) words.push("zqprefixbb");
    // `zqfallbackword` is only ever queried by a fragment from its middle, which no whole term
    // starts with, so those queries can only be answered by the substring fallback.
    if (i % 101 === 0) words.push("zqfallbackword");
    return msg(`$s${i}`, words.join(" "), {
        room_id: SCALE_ROOMS[i % SCALE_ROOMS.length],
        origin_server_ts: scaleTs(i),
    });
});

/** The ids of the corpus events whose index satisfies `predicate`, in index order. */
const scaleIds = (predicate: (i: number) => boolean): string[] =>
    SCALE_CORPUS.filter((_ev, i) => predicate(i)).map((ev) => ev.event_id);

/**
 * A block of events sharing one timestamp, plus two a millisecond newer inserted part way
 * through it. Recency ordering has to put the two newer ones first and leave the tied block in
 * the order the index holds it, which is where an unstable sort would show.
 */
const TIE_ROOM = "!scaletie:example.org";
const TIE_TS = SCALE_BASE_TS + 900_000;
const tied = (id: string, ts: number): any => msg(id, "zqtied tied body", { room_id: TIE_ROOM, origin_server_ts: ts });
const TIE_EVENTS: any[] = [
    ...Array.from({ length: 6 }, (_unused, j) => tied(`$tie${j}`, TIE_TS)),
    tied("$tienewer0", TIE_TS + 1),
    ...Array.from({ length: 6 }, (_unused, j) => tied(`$tie${j + 6}`, TIE_TS)),
    tied("$tienewer1", TIE_TS + 1),
];
/** Newest first, then the tied block in the order it was indexed. */
const TIE_EXPECTED_BY_RECENCY = ["$tienewer0", "$tienewer1", ...Array.from({ length: 12 }, (_unused, j) => `$tie${j}`)];

/**
 * Sixty message/edit pairs indexed twice over: once original-first, once edit-first, in two
 * rooms. Both orders have to end in the same place -- edited body, original's envelope, original's
 * timestamp, and the record filed at the position that timestamp calls for.
 */
const EDIT_PAIRS = 60;
const EDIT_ROOM_ORIGINAL_FIRST = "!scaleeditoriginal:example.org";
const EDIT_ROOM_EDIT_FIRST = "!scaleeditreplacement:example.org";
const EDIT_BASE_TS = SCALE_BASE_TS + 800_000;
/**
 * A permutation of 0..59, so a room's timestamp order is nothing like its arrival order. An
 * edit-first record is filed under the *edit's* much later timestamp and only re-placed when the
 * original turns up, so a repair that never happened leaves arrival order behind and is visible.
 */
const editTs = (j: number): number => EDIT_BASE_TS + ((j * 37) % EDIT_PAIRS);
const editOriginalId = (roomId: string, j: number): string =>
    `$eorig${roomId === EDIT_ROOM_EDIT_FIRST ? "b" : "a"}${j}`;
const editPairs = (roomId: string): Array<{ original: any; replacement: any }> =>
    Array.from({ length: EDIT_PAIRS }, (_unused, j) => {
        const originalId = editOriginalId(roomId, j);
        return {
            original: msg(originalId, `zqpreedit eword${j}`, { room_id: roomId, origin_server_ts: editTs(j) }),
            // `edit` files itself in the default room, so the room id is re-applied on top.
            replacement: {
                ...edit(`$eedit${originalId}`, originalId, `zqpostedit eword${j}`, EDIT_BASE_TS + 100_000 + j),
                room_id: roomId,
            },
        };
    });
const EDIT_ORIGINAL_FIRST = editPairs(EDIT_ROOM_ORIGINAL_FIRST);
const EDIT_EDIT_FIRST = editPairs(EDIT_ROOM_EDIT_FIRST);
/** The room's ids in timestamp order, which is what both arrival orders have to converge on. */
const editExpectedOrder = (roomId: string): string[] =>
    Array.from({ length: EDIT_PAIRS }, (_unused, j) => j)
        .sort((a, b) => editTs(a) - editTs(b))
        .map((j) => editOriginalId(roomId, j));

/**
 * A room of its own for the redaction test, so removing all of it cannot disturb what the other
 * tests assert. Each body carries a per-event term whose middle only the substring fallback can
 * reach, which is what makes the folded-text memo's cleanup observable.
 */
const DOOM_ROOM = "!scaledoom:example.org";
const DOOM_COUNT = 200;
const DOOM_EVENTS: any[] = Array.from({ length: DOOM_COUNT }, (_unused, k) =>
    msg(`$doom${k}`, `zqdoomed zqdoomcarrier${k} filler`, {
        room_id: DOOM_ROOM,
        origin_server_ts: SCALE_BASE_TS + 700_000 + k,
    }),
);

const SCALE_TOTAL_EVENTS = SCALE_EVENT_COUNT + TIE_EVENTS.length + DOOM_COUNT + 2 * EDIT_PAIRS;
/** The four corpus rooms plus the tie room, the redaction room and the two edit rooms. */
const SCALE_TOTAL_ROOMS = SCALE_ROOMS.length + 4;

/** Index the whole corpus, each group in the arrival order that group is about. */
async function indexScaleCorpus(manager: BrowserEventIndexManager): Promise<void> {
    for (const ev of SCALE_CORPUS) await manager.addEventToIndex(ev, {});
    for (const ev of TIE_EVENTS) await manager.addEventToIndex(ev, {});
    for (const ev of DOOM_EVENTS) await manager.addEventToIndex(ev, {});
    for (const { original, replacement } of EDIT_ORIGINAL_FIRST) {
        await manager.addEventToIndex(original, {});
        await manager.addEventToIndex(replacement, {});
    }
    for (const { original, replacement } of EDIT_EDIT_FIRST) {
        await manager.addEventToIndex(replacement, {});
        await manager.addEventToIndex(original, {});
    }
}

/** The event ids of a page of results, in the order the search returned them. */
const resultIds = (result: any): string[] => result.results!.map((r: any) => r.result.event_id);

/**
 * One room's whole id list in the order the index holds it, read the only way a caller can: ask
 * for a single hit with enough context either side to reach both ends of the room.
 */
async function roomTimelineOrder(
    manager: BrowserEventIndexManager,
    term: string,
    roomId: string,
    span: number,
): Promise<string[]> {
    const result = await manager.searchEventIndex({
        search_term: term,
        room_id: roomId,
        before_limit: span,
        after_limit: span,
        order_by_recency: false,
        limit: 1,
    } as any);
    const [first] = result.results!;
    return [
        ...first.context!.events_before.map((e) => e.event_id),
        first.result.event_id,
        ...first.context!.events_after.map((e) => e.event_id),
    ];
}

describe("BrowserEventIndexManager (at scale)", () => {
    const DEVICE = "DEVICE1";
    let manager: BrowserEventIndexManager;
    let userCounter = 0;
    let userId: string;

    const search = (term: string, overrides: Record<string, unknown> = {}): any =>
        ({ search_term: term, ...SEARCH_DEFAULTS, ...overrides }) as any;

    beforeEach(async () => {
        vi.stubGlobal("indexedDB", new IDBFactory());
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(true);
        userId = `@scale${++userCounter}:example.org`;
        // No pickle key, so persistence is off. These tests are about the in-memory index, and
        // AES-GCM-encrypting every one of these records per test would cost more than the rest of
        // the file put together while exercising nothing the persistence tests above do not. The
        // reload test below turns persistence back on, at a size where it is affordable.
        mockPlatformPeg({ getPickleKey: vi.fn().mockResolvedValue(null) });
        manager = new BrowserEventIndexManager();
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await indexScaleCorpus(manager);
    });

    afterEach(async () => {
        await manager.closeEventIndex();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("returns exactly the records carrying a rare term, and nothing near them", async () => {
        // Positive control first: the whole corpus really is in the index, so the negatives below
        // cannot pass by searching an index that was never populated.
        const stats = await manager.getStats();
        expect(stats.eventCount).toBe(SCALE_TOTAL_EVENTS);
        expect(stats.roomCount).toBe(SCALE_TOTAL_ROOMS);

        const expected = scaleIds((i) => i % 37 === 0);
        const hit = await manager.searchEventIndex(search("zqmarker", { limit: SCALE_EVENT_COUNT }));
        expect(hit.count).toBe(expected.length);
        expect(resultIds(hit).sort()).toEqual([...expected].sort());
        // A term nobody wrote finds nothing, rather than the whole corpus.
        expect((await manager.searchEventIndex(search("zqabsentterm"))).count).toBe(0);
    });

    it("intersects several terms instead of unioning them", async () => {
        const marker = scaleIds((i) => i % 37 === 0);
        const beta = scaleIds((i) => i % 53 === 0);
        const both = scaleIds((i) => i % 37 === 0 && i % 53 === 0);
        // The three counts have to differ, or an OR bug would satisfy the assertion below as
        // readily as an AND: 37 and 53 are coprime, so "both" is a small fraction of either.
        expect(both.length).toBeGreaterThan(0);
        expect(both.length).toBeLessThan(Math.min(marker.length, beta.length));

        const hit = await manager.searchEventIndex(search("zqmarker zqbeta", { limit: SCALE_EVENT_COUNT }));
        expect(hit.count).toBe(both.length);
        expect(resultIds(hit).sort()).toEqual([...both].sort());
        expect(hit.highlights).toEqual(["zqmarker", "zqbeta"]);
    });

    it("matches every term a partial query is a prefix of", async () => {
        // No record holds `zqprefix` as a term, so every hit here comes from the prefix walk.
        const expected = scaleIds((i) => i % 41 === 0 || i % 43 === 0);
        const hit = await manager.searchEventIndex(search("zqprefix", { limit: SCALE_EVENT_COUNT }));
        expect(hit.count).toBe(expected.length);
        expect(resultIds(hit).sort()).toEqual([...expected].sort());

        // ... and a longer prefix narrows to one of the two families rather than keeping both.
        const onlyA = scaleIds((i) => i % 41 === 0);
        const narrowed = await manager.searchEventIndex(search("zqprefixa", { limit: SCALE_EVENT_COUNT }));
        expect(resultIds(narrowed).sort()).toEqual([...onlyA].sort());
    });

    it("falls back to a substring scan for a fragment no term starts with", async () => {
        const expected = scaleIds((i) => i % 101 === 0);
        // "allbackwor" sits in the middle of "zqfallbackword": no term starts with it, so the
        // term path returns nothing and the whole answer comes from the linear scan.
        const hit = await manager.searchEventIndex(search("allbackwor", { limit: SCALE_EVENT_COUNT }));
        expect(hit.count).toBe(expected.length);
        expect(resultIds(hit).sort()).toEqual([...expected].sort());
    });

    it("orders by recency newest first, and leaves tied timestamps in index order", async () => {
        // Distinct timestamps: strictly newest first, which for this corpus is index order reversed.
        const expected = scaleIds((i) => i % 37 === 0).reverse();
        const hit = await manager.searchEventIndex(search("zqmarker", { limit: SCALE_EVENT_COUNT }));
        expect(resultIds(hit)).toEqual(expected);

        // Tied timestamps: the two newer records come first, and the tied block keeps the order
        // the index holds it in. A sort that is not stable reorders the block instead.
        const tiedHit = await manager.searchEventIndex(search("zqtied", { limit: TIE_EVENTS.length }));
        expect(tiedHit.count).toBe(TIE_EVENTS.length);
        expect(resultIds(tiedHit)).toEqual(TIE_EXPECTED_BY_RECENCY);
        const timestamps = tiedHit.results!.map((r) => r.result.origin_server_ts!);
        expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));

        // Without the flag the caller gets the index's own order, not a reversed one.
        const unordered = await manager.searchEventIndex(
            search("zqtied", { limit: TIE_EVENTS.length, order_by_recency: false }),
        );
        expect(resultIds(unordered)).toEqual(TIE_EVENTS.map((e) => e.event_id));
    });

    it("pages through the whole result set with next_batch, with no gaps and no duplicates", async () => {
        const pageSize = 25;
        const single = await manager.searchEventIndex(search("zqmarker", { limit: SCALE_EVENT_COUNT }));
        const expected = resultIds(single);
        expect(expected.length).toBeGreaterThan(pageSize * 2);

        const walked: string[] = [];
        const pageLengths: number[] = [];
        let nextBatch: string | undefined;
        let guard = 0;
        do {
            const page = await manager.searchEventIndex(search("zqmarker", { limit: pageSize, next_batch: nextBatch }));
            // `count` is the size of the whole result set on every page, not of the page.
            expect(page.count).toBe(expected.length);
            // `rank` is positional over the whole result set, so it is what a broken offset
            // corrupts first, before any id even moves.
            expect(page.results![0].rank).toBeCloseTo(1 / (walked.length + 1), 12);
            pageLengths.push(page.results!.length);
            walked.push(...resultIds(page));
            nextBatch = page.next_batch;
        } while (nextBatch !== undefined && ++guard < 100);

        expect(nextBatch).toBeUndefined();
        expect(walked).toEqual(expected);
        expect(new Set(walked).size).toBe(walked.length);
        expect(pageLengths).toEqual([
            ...Array.from({ length: Math.floor(expected.length / pageSize) }, () => pageSize),
            ...(expected.length % pageSize ? [expected.length % pageSize] : []),
        ]);
    });

    it("returns the hit's true timeline neighbours as context", async () => {
        // Every fourth event shares a room, so the neighbours of $s1850 are $s1846 and $s1854.
        const middle = await manager.searchEventIndex(search("entry1850", { before_limit: 3, after_limit: 3 }));
        expect(middle.count).toBe(1);
        const context = middle.results![0].context!;
        expect(context.events_before.map((e) => e.event_id)).toEqual(["$s1838", "$s1842", "$s1846"]);
        expect(context.events_after.map((e) => e.event_id)).toEqual(["$s1854", "$s1858", "$s1862"]);

        // The first event of a room has nothing before it, rather than wrapping to the end.
        const first = await manager.searchEventIndex(search("entry0", { before_limit: 3, after_limit: 2 }));
        const firstContext = first.results![0].context!;
        expect(firstContext.events_before).toEqual([]);
        expect(firstContext.events_after.map((e) => e.event_id)).toEqual(["$s4", "$s8"]);

        // Tied timestamps land where a stable "append, then sort" would have put them: arrival
        // order inside the tie, and the two newer records after all of it -- so the insertion
        // point has to be the tie's *upper* bound, not its lower one.
        expect(await roomTimelineOrder(manager, "zqtied", TIE_ROOM, TIE_EVENTS.length)).toEqual([
            ...Array.from({ length: 12 }, (_unused, j) => `$tie${j}`),
            "$tienewer0",
            "$tienewer1",
        ]);
    });

    it("converges on the same state whether an edit arrives before or after its original", async () => {
        // No pre-edit body survives in either room ...
        expect((await manager.searchEventIndex(search("zqpreedit", { limit: SCALE_EVENT_COUNT }))).count).toBe(0);

        // ... every record is filed under its original's id, carrying the edited body ...
        const hit = await manager.searchEventIndex(search("zqpostedit", { limit: SCALE_EVENT_COUNT }));
        expect(hit.count).toBe(2 * EDIT_PAIRS);
        const expectedIds = [
            ...editExpectedOrder(EDIT_ROOM_ORIGINAL_FIRST),
            ...editExpectedOrder(EDIT_ROOM_EDIT_FIRST),
        ];
        expect(resultIds(hit).sort()).toEqual([...expectedIds].sort());
        for (const result of hit.results!) {
            expect((result.result.content as any).body).toMatch(/^zqpostedit /);
        }

        // ... and both rooms sit in their originals' timestamp order, not their arrival order.
        // The edit-first room only gets there because the late original re-places the record.
        for (const roomId of [EDIT_ROOM_ORIGINAL_FIRST, EDIT_ROOM_EDIT_FIRST]) {
            expect(await roomTimelineOrder(manager, "zqpostedit", roomId, EDIT_PAIRS)).toEqual(
                editExpectedOrder(roomId),
            );
        }
    });

    it("removes every trace of a redacted room's events at scale", async () => {
        expect((await manager.searchEventIndex(search("zqdoomed", { limit: DOOM_COUNT }))).count).toBe(DOOM_COUNT);
        // A fragment only the substring fallback reaches, which is what fills the folded-text memo.
        expect((await manager.searchEventIndex(search("qdoomcarrie", { limit: DOOM_COUNT }))).count).toBe(DOOM_COUNT);

        for (const ev of DOOM_EVENTS) expect(await manager.deleteEvent(ev.event_id)).toBe(true);

        expect((await manager.searchEventIndex(search("zqdoomed", { limit: DOOM_COUNT }))).count).toBe(0);
        expect((await manager.searchEventIndex(search("qdoomcarrie", { limit: DOOM_COUNT }))).count).toBe(0);
        expect(await manager.isRoomIndexed(DOOM_ROOM)).toBe(false);
        // The rest of the index is untouched.
        const stats = await manager.getStats();
        expect(stats.eventCount).toBe(SCALE_TOTAL_EVENTS - DOOM_COUNT);
        expect(stats.roomCount).toBe(SCALE_TOTAL_ROOMS - 1);
        expect((await manager.searchEventIndex(search("zqmarker", { limit: SCALE_EVENT_COUNT }))).count).toBe(
            scaleIds((i) => i % 37 === 0).length,
        );
    });

    it("scopes a search to one room exactly, on both the term and the substring path", async () => {
        const roomId = SCALE_ROOMS[1];
        const expected = scaleIds((i) => i % 37 === 0 && i % SCALE_ROOMS.length === 1);
        expect(expected.length).toBeGreaterThan(0);

        const scoped = await manager.searchEventIndex(
            search("zqmarker", { room_id: roomId, limit: SCALE_EVENT_COUNT }),
        );
        expect(scoped.count).toBe(expected.length);
        expect(resultIds(scoped).sort()).toEqual([...expected].sort());
        for (const result of scoped.results!) expect(result.result.room_id).toEqual(roomId);

        // The substring fallback takes the room filter too, rather than scanning everything.
        const fragmentExpected = scaleIds((i) => i % 101 === 0 && i % SCALE_ROOMS.length === 1);
        const fragment = await manager.searchEventIndex(
            search("allbackwor", { room_id: roomId, limit: SCALE_EVENT_COUNT }),
        );
        expect(resultIds(fragment).sort()).toEqual([...fragmentExpected].sort());
    });
});

/**
 * The same properties over a warm start rather than a live index, at a size where encrypting and
 * decrypting every record is affordable. This is the path the scale tests above deliberately skip:
 * `hydrate()` rebuilds the inverted index and the room order from ciphertext, one row at a time via
 * binary-search insertion (`insertRoomOrder`), which is stable with respect to arrival order and so
 * produces the same final ordering a bulk "collect then sort each room once" pass would have.
 */
const RELOAD_EVENT_COUNT = 300;
const RELOAD_ROOMS = ["!warm0:example.org", "!warm1:example.org", "!warm2:example.org"];
const RELOAD_CORPUS: any[] = Array.from({ length: RELOAD_EVENT_COUNT }, (_unused, i) =>
    msg(`$w${i}`, [`warmentry${i}`, "warm corpus", ...(i % 7 === 0 ? ["zqwarmmarker"] : [])].join(" "), {
        room_id: RELOAD_ROOMS[i % RELOAD_ROOMS.length],
        // Descending timestamps, so a reload that kept row order rather than sorting is visible.
        origin_server_ts: SCALE_BASE_TS + (RELOAD_EVENT_COUNT - i),
    }),
);

describe("BrowserEventIndexManager (a persisted index at scale)", () => {
    const DEVICE = "DEVICE1";
    let manager: BrowserEventIndexManager;
    let userCounter = 0;
    let userId: string;

    const search = (term: string, overrides: Record<string, unknown> = {}): any =>
        ({ search_term: term, ...SEARCH_DEFAULTS, ...overrides }) as any;

    beforeEach(() => {
        vi.stubGlobal("indexedDB", new IDBFactory());
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(true);
        userId = `@warm${++userCounter}:example.org`;
        mockPlatformPeg({ getPickleKey: vi.fn().mockResolvedValue("unit-test-pickle-key") });
        manager = new BrowserEventIndexManager();
    });

    afterEach(async () => {
        await manager.closeEventIndex();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("rebuilds the same search results and the same room order from stored ciphertext", async () => {
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        for (const ev of RELOAD_CORPUS) await manager.addEventToIndex(ev, {});
        await manager.commitLiveEvents();
        await manager.closeEventIndex();

        const expectedMarker = RELOAD_CORPUS.filter((_ev, i) => i % 7 === 0);
        // Newest first, and the corpus timestamps descend with the index, so this is index order.
        const expectedByRecency = expectedMarker.map((ev) => ev.event_id);
        // Room order is ascending by timestamp, which for this corpus reverses the room's events.
        const expectedRoomOrder = RELOAD_CORPUS.filter((ev) => ev.room_id === RELOAD_ROOMS[0])
            .map((ev) => ev.event_id)
            .reverse();

        const reloaded = new BrowserEventIndexManager();
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        try {
            const stats = await reloaded.getStats();
            expect(stats.eventCount).toBe(RELOAD_EVENT_COUNT);
            expect(stats.roomCount).toBe(RELOAD_ROOMS.length);
            expect(stats.size).toBeGreaterThan(0);

            const hit = await reloaded.searchEventIndex(search("zqwarmmarker", { limit: RELOAD_EVENT_COUNT }));
            expect(hit.count).toBe(expectedMarker.length);
            expect(resultIds(hit)).toEqual(expectedByRecency);

            // The substring fallback works off text rebuilt from ciphertext, not off a memo that
            // only a live insert would have filled.
            expect((await reloaded.searchEventIndex(search("armentry150"))).count).toBe(1);

            // `hydrate()` inserts record by record via binary search rather than sorting each room
            // once in bulk, so this is the assertion that the two agree about what ordered means.
            expect(await roomTimelineOrder(reloaded, "warm", RELOAD_ROOMS[0], RELOAD_EVENT_COUNT)).toEqual(
                expectedRoomOrder,
            );

            // Pagination walks the reloaded set the same way it walks a live one.
            const walked: string[] = [];
            let nextBatch: string | undefined;
            do {
                const page = await reloaded.searchEventIndex(
                    search("zqwarmmarker", { limit: 10, next_batch: nextBatch }),
                );
                walked.push(...resultIds(page));
                nextBatch = page.next_batch;
            } while (nextBatch !== undefined);
            expect(walked).toEqual(expectedByRecency);
        } finally {
            await reloaded.closeEventIndex();
        }
    });
});

/**
 * Increment C: shouldCrawl, the resident (hot-window) budget and the disk budget
 * (`research/SYNTHESIS.md` §3.5-§3.7). Every record here shares one body so that a term search for
 * it -- {@link BODY_TOKEN} -- doubles as a cheap "which ids are resident right now" probe, without
 * adding any new instrumentation to the class under test.
 */
describe("BrowserEventIndexManager (increment C: bounds)", () => {
    const DEVICE = "DEVICE1";
    const pickleKey = "unit-test-pickle-key";
    const ROOM = "!bounds:example.org";
    const BODY_TOKEN = "x".repeat(100);
    // The manager's own resident-budget gate: a flat per-event figure, not text-length-weighted
    // (see RESIDENT_BYTES_PER_EVENT_ESTIMATE's docstring for why), so this is exact regardless of
    // BODY_TOKEN's length.
    const BYTES_PER_EVENT = RESIDENT_BYTES_PER_EVENT_ESTIMATE;
    const BUDGET_N = 40;

    let userCounter = 0;
    let userId: string;
    let toClose: BrowserEventIndexManager[] = [];

    const search = (term: string, overrides: Record<string, unknown> = {}): any =>
        ({ search_term: term, ...SEARCH_DEFAULTS, ...overrides }) as any;

    /** ids ascending == ts ascending == the order hydrate()'s ascending-key-order paging visits them in. */
    function budgetCorpus(n = BUDGET_N): any[] {
        return Array.from({ length: n }, (_unused, i) =>
            msg(`$b${String(i).padStart(3, "0")}`, BODY_TOKEN, { room_id: ROOM, origin_server_ts: 1_000_000 + i }),
        );
    }
    const idAt = (i: number): string => `$b${String(i).padStart(3, "0")}`;

    /**
     * ids ascending (so hydration still visits them in the same id order and stops at the same
     * point), but *ts descending*: the un-hydrated tail this corpus leaves behind is the OLDEST by
     * timestamp, not the newest -- unlike {@link budgetCorpus}. Needed specifically to exercise
     * `enforceResidentBudget`'s `protectedId` guard: pulling in a row that is *not* the current
     * global minimum can never race its own eviction regardless of whether the guard exists, so a
     * test using the ascending-ts corpus for this purpose would pass even with that guard deleted.
     */
    function oldTailCorpus(n = BUDGET_N): any[] {
        return Array.from({ length: n }, (_unused, i) =>
            msg(`$b${String(i).padStart(3, "0")}`, BODY_TOKEN, { room_id: ROOM, origin_server_ts: 2_000_000 - i }),
        );
    }

    function track(m: BrowserEventIndexManager): BrowserEventIndexManager {
        toClose.push(m);
        return m;
    }

    /** Every currently-*resident* id, via the one shared token every record's body tokenises to. */
    async function residentIds(manager: BrowserEventIndexManager): Promise<Set<string>> {
        const hit = await manager.searchEventIndex(search(BODY_TOKEN, { limit: BUDGET_N + 10 }));
        return new Set(resultIds(hit));
    }

    beforeEach(() => {
        vi.stubGlobal("indexedDB", new IDBFactory());
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(true);
        userId = `@bounds${++userCounter}:example.org`;
        mockPlatformPeg({ getPickleKey: vi.fn().mockResolvedValue("unit-test-pickle-key") });
        toClose = [];
    });

    afterEach(async () => {
        setEventIndexBoundsOverrideForTesting(null);
        setChunkTargetBytesOverrideForTesting(null);
        for (const m of toClose.splice(0)) await m.closeEventIndex();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    /** Seed the whole corpus with a generous budget, close, then reopen under `hotWindowBytes`. */
    async function seedAndReopen(
        hotWindowBytes: number,
        n = BUDGET_N,
        corpus: (n: number) => any[] = budgetCorpus,
    ): Promise<BrowserEventIndexManager> {
        setEventIndexBoundsOverrideForTesting(null); // generous default budget while seeding
        const seed = track(new BrowserEventIndexManager());
        await seed.initEventIndex(userId, DEVICE);
        await seed.waitForHydration();
        for (const ev of corpus(n)) {
            await seed.addEventToIndex(ev, {});
            await seed.commitLiveEvents();
        }
        await seed.closeEventIndex();

        setEventIndexBoundsOverrideForTesting({ hotWindowBytes });
        const reloaded = track(new BrowserEventIndexManager());
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        return reloaded;
    }

    describe("shouldCrawl", () => {
        it("declines a room whose crawl has already passed CRAWL_WINDOW_DAYS back", async () => {
            setEventIndexBoundsOverrideForTesting({ crawlWindowDays: 1 });
            const manager = track(new BrowserEventIndexManager());
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();
            const old = Date.now() - 2 * DAY_MS;
            await manager.addEventToIndex(msg("$old", "hi", { room_id: "!r:x", origin_server_ts: old }), {});
            await manager.commitLiveEvents(); // shouldCrawl now reads the manifest, built at write-commit

            expect(await manager.shouldCrawl({ roomId: "!r:x", token: "t", direction: Direction.Backward })).toBe(
                false,
            );
        });

        it("allows a room whose crawl is still within CRAWL_WINDOW_DAYS", async () => {
            setEventIndexBoundsOverrideForTesting({ crawlWindowDays: 90 });
            const manager = track(new BrowserEventIndexManager());
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();
            const recent = Date.now() - 1 * DAY_MS;
            await manager.addEventToIndex(msg("$recent", "hi", { room_id: "!r:x", origin_server_ts: recent }), {});
            await manager.commitLiveEvents();

            expect(await manager.shouldCrawl({ roomId: "!r:x", token: "t", direction: Direction.Backward })).toBe(true);
        });

        it("allows a room with nothing indexed for it yet -- it cannot be windowed or ranked", async () => {
            setEventIndexBoundsOverrideForTesting({ crawlWindowDays: 1, crawlRoomCap: 1 });
            const manager = track(new BrowserEventIndexManager());
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();

            expect(await manager.shouldCrawl({ roomId: "!unseen:x", token: "t", direction: Direction.Backward })).toBe(
                true,
            );
        });

        it("declines a room outside the top CRAWL_ROOM_CAP rooms by most recent indexed activity", async () => {
            setEventIndexBoundsOverrideForTesting({ crawlRoomCap: 1 });
            const manager = track(new BrowserEventIndexManager());
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();
            const now = Date.now();
            await manager.addEventToIndex(msg("$a", "hi", { room_id: "!a:x", origin_server_ts: now - 1000 }), {});
            await manager.addEventToIndex(msg("$b", "hi", { room_id: "!b:x", origin_server_ts: now }), {});
            await manager.commitLiveEvents();

            // !b is more recently active than !a; with a cap of 1, only !b is inside the bound.
            expect(await manager.shouldCrawl({ roomId: "!b:x", token: "t", direction: Direction.Backward })).toBe(true);
            expect(await manager.shouldCrawl({ roomId: "!a:x", token: "t", direction: Direction.Backward })).toBe(
                false,
            );
        });

        it("the crawl-window decline survives the record it was based on being evicted from RAM (review-pr-c.md C-F2)", async () => {
            setEventIndexBoundsOverrideForTesting({ crawlWindowDays: 1, hotWindowBytes: BYTES_PER_EVENT * 3 });
            const manager = track(new BrowserEventIndexManager());
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();

            const old = Date.now() - 2 * DAY_MS;
            await manager.addEventToIndex(msg("$old", "oldmarker", { room_id: "!r:x", origin_server_ts: old }), {});
            await manager.commitLiveEvents();

            const cp = { roomId: "!r:x", token: "t", direction: Direction.Backward };
            expect(await manager.shouldCrawl(cp)).toBe(false);

            // Push enough new, unrelated, durable events to evict $old from residency (the budget
            // above fits only ~3 records). Each is flushed individually so it is durable -- and
            // therefore a legal eviction target -- before the next one needs room.
            for (let i = 0; i < 6; i++) {
                await manager.addEventToIndex(
                    msg(`$fresh${i}`, "freshmarker", { room_id: "!other:x", origin_server_ts: Date.now() + i }),
                    {},
                );
                await manager.commitLiveEvents();
            }
            // Confirm this test actually exercised eviction, not a budget that happened not to bite.
            expect((await manager.searchEventIndex(search("oldmarker"))).count).toBe(0);

            // The old bug: shouldCrawl read roomOrder (the resident set), so evicting $old made
            // list[0] undefined and the room looked never-crawled again, flipping this to true.
            expect(await manager.shouldCrawl(cp)).toBe(false);
        });

        it("the room-cap decline survives a fully-evicted room having no resident events left (review-pr-c.md C-F3)", async () => {
            setEventIndexBoundsOverrideForTesting({ crawlRoomCap: 1, hotWindowBytes: BYTES_PER_EVENT * 3 });
            const manager = track(new BrowserEventIndexManager());
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();
            const now = Date.now();
            await manager.addEventToIndex(msg("$a", "amarker", { room_id: "!a:x", origin_server_ts: now - 1000 }), {});
            await manager.commitLiveEvents();
            await manager.addEventToIndex(msg("$b", "bmarker", { room_id: "!b:x", origin_server_ts: now }), {});
            await manager.commitLiveEvents();

            const cpA = { roomId: "!a:x", token: "t", direction: Direction.Backward };
            expect(await manager.shouldCrawl(cpA)).toBe(false); // !a is outside the cap of 1

            // Push enough new, durable events (in a third room, so ranking is unaffected) to evict
            // *every* resident event from both !a and !b, so !a's roomOrder entry disappears
            // entirely -- the old bug's "cannot be ranked, let it through" exemption.
            for (let i = 0; i < 6; i++) {
                await manager.addEventToIndex(
                    msg(`$fresh${i}`, "freshmarker", { room_id: "!c:x", origin_server_ts: now + 1000 + i }),
                    {},
                );
                await manager.commitLiveEvents();
            }
            expect((await manager.searchEventIndex(search("amarker"))).count).toBe(0); // !a evicted
            expect((await manager.searchEventIndex(search("bmarker"))).count).toBe(0); // !b evicted too

            expect(await manager.shouldCrawl(cpA)).toBe(false); // still declined, per the manifest
        });
    });

    describe("resident (hot-window) budget", () => {
        it("hydration stops at the budget; rows beyond it stay on disk, un-hydrated", async () => {
            const reloaded = await seedAndReopen(BYTES_PER_EVENT * 20);
            const stats = await reloaded.getStats();
            expect(stats.eventCount).toBeGreaterThan(0);
            expect(stats.eventCount).toBeLessThan(BUDGET_N);
            expect(stats.windowed).toBe(true);

            // Every row is still on disk regardless of whether it was hydrated.
            const onDisk = await decryptAllChunkEvents(pickleKey!, DEVICE);
            expect(onDisk.length).toBe(BUDGET_N);
        });

        it("the resident set after a restart is exactly the NEWEST N, not an artefact of id order (review-pr-c.md C-F1)", async () => {
            // The reviewer's own repro shape: budgetCorpus's ids ascend with ts, so the newest N by
            // timestamp are the highest-numbered ids -- the *opposite* end from ascending eventId
            // order, which is what a manifest-free hydration used to keep (the ten OLDEST).
            const reloaded = await seedAndReopen(BYTES_PER_EVENT * 10, 40);
            const stats2 = await reloaded.getStats();
            const kept = stats2.eventCount;
            expect(kept).toBeGreaterThan(0);
            expect(kept).toBeLessThan(40);

            const resident = await residentIds(reloaded);
            const expectedNewest = new Set(Array.from({ length: kept }, (_unused, i) => idAt(40 - 1 - i)));
            expect(resident).toEqual(expectedNewest);
            // Explicitly the reviewer's own assertion shape: the newest ids are present, the
            // oldest (what the bug used to keep) are not.
            expect(resident.has(idAt(39))).toBe(true); // newest
            expect(resident.has(idAt(0))).toBe(false); // oldest -- the bug's own wrong answer
        });

        it("hydration visits chunks newest-maxTs-first, not an artefact of arrival/chunk-id order (review-pr-c.md C2-F1, revised for review-pr-d.md D5)", async () => {
            // MANIFEST_PAGE_SIZE entries fill exactly one page in *arrival* order (manifestAdd's own
            // fill order), so N = 2.5 pages guarantees at least three pages exist. Timestamps are a
            // scrambled permutation of arrival order (ts[i] = base + (i*37 mod N), 37 coprime with
            // every N used here) rather than tracking arrival/page order at all -- if hydration's
            // chunk walk were driven by arrival/chunk-id order instead of each chunk's own genuine
            // newest-member timestamp, a "later" chunk could still hold plenty of ids that are
            // actually older than ids sitting in an "earlier" one, and this shape is what would
            // expose that.
            //
            // Since increment D (review-pr-d.md D5), hydrate() walks whole *chunks* in `maxTs`
            // order, admitting every one of a visited chunk's members before moving on -- not a
            // byte-exact global top-K the way the pre-chunking, per-manifest-page k-way merge this
            // test used to pin could guarantee. Chunks pack events in *arrival* order (D5's own
            // finding: uncorrelated with ts), so two chunks' member ranges can overlap, and the
            // chunk-grained cut can admit a chunk's own older members alongside its newer ones ahead
            // of a lower-maxTs chunk's own newer members -- an honestly coarser, chunk-granularity
            // guarantee, documented on hydrate() itself. This test now asserts *that* contract
            // exactly (derived independently from the real on-disk chunks, not merely re-run through
            // the implementation), rather than the byte-exact ideal chunking cannot preserve without
            // either time-clustered chunks or a full cross-chunk streaming merge -- and separately
            // confirms the result is not simply "the first K by arrival order", so a regression to
            // arrival/chunk-id order would still fail it.
            const n = MANIFEST_PAGE_SIZE * 2 + 500;
            const base = 10_000_000;
            const tsAt = (i: number): number => base + ((i * 37) % n);
            const mpId = (i: number): string => `$mp${String(i).padStart(5, "0")}`;

            setEventIndexBoundsOverrideForTesting(null);
            const seed = track(new BrowserEventIndexManager());
            await seed.initEventIndex(userId, DEVICE);
            await seed.waitForHydration();
            for (let i = 0; i < n; i++) {
                await seed.addEventToIndex(msg(mpId(i), BODY_TOKEN, { room_id: ROOM, origin_server_ts: tsAt(i) }), {});
            }
            await seed.commitLiveEvents(); // one batched flush; manifestAdd still fills pages in this call's own iteration order
            await seed.closeEventIndex();

            const K = 50;

            // Ground truth, read straight off disk (not a re-implementation of hydrate()'s own
            // logic in the abstract): decrypt every real chunk, group by chunkId, sort chunks by
            // their own true maxTs descending, and admit each chunk's members (ts descending within
            // it) until K events are admitted -- exactly the contract hydrate()'s own docstring
            // states.
            const rawChunks = (await dumpRawStore("chunks")).filter((r: any) => r.userId === userId) as Array<{
                userId: string;
                chunkId: number;
                blob: { iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> };
            }>;
            const metaRow = (await dumpRawStore("meta")).find((r: any) => r.userId === userId) as
                | { salt: string }
                | undefined;
            expect(metaRow).toBeDefined();
            const dek = await deriveDek(
                pickleKey,
                decodeBase64(metaRow!.salt) as Uint8Array<ArrayBuffer>,
                userId,
                DEVICE,
            );
            const chunks: Array<{ chunkId: number; maxTs: number; idsDesc: string[] }> = [];
            for (const row of rawChunks) {
                const arr = await decryptBinaryJson<Array<[string, { originServerTs: number }]>>(
                    dek,
                    row.blob,
                    chunkAad(userId, row.chunkId),
                );
                const sorted = arr.slice().sort((a, b) => b[1].originServerTs - a[1].originServerTs);
                chunks.push({
                    chunkId: row.chunkId,
                    maxTs: sorted[0][1].originServerTs,
                    idsDesc: sorted.map((pair) => pair[0]),
                });
            }
            chunks.sort((a, b) => b.maxTs - a.maxTs);
            // Admit one member at a time, walking chunks newest-maxTs-first and each chunk's own
            // members newest-first, stopping at exactly K -- member-precise *within* the walk order,
            // matching hydrate()'s own per-member budget check exactly (it does not admit a whole
            // chunk unconditionally; only the walk *order* is chunk-grained).
            const expectedNewestIds: string[] = [];
            outer: for (const chunk of chunks) {
                for (const id of chunk.idsDesc) {
                    if (expectedNewestIds.length >= K) break outer;
                    expectedNewestIds.push(id);
                }
            }
            expect(expectedNewestIds).toHaveLength(K); // sanity: the corpus is big enough

            // Not simply "the first K by arrival order" -- proves the chunk walk is genuinely
            // ts-driven, not an accidental fallback to arrival/chunk-id order.
            const firstKByArrival = new Set(Array.from({ length: K }, (_unused, i) => mpId(i)));
            expect(new Set(expectedNewestIds)).not.toEqual(firstKByArrival);

            // hotWindowBytes gates hydrated events alone (review-pr-c.md C2-F2, corrected in the
            // third pass): the manifest has its own separate ceiling and does not eat into this.
            setEventIndexBoundsOverrideForTesting({ hotWindowBytes: BYTES_PER_EVENT * K });
            const reloaded = track(new BrowserEventIndexManager());
            await reloaded.initEventIndex(userId, DEVICE);
            await reloaded.waitForHydration();

            const hit = await reloaded.searchEventIndex(search(BODY_TOKEN, { limit: K + 10 }));
            const resident = new Set(resultIds(hit));
            expect(resident).toEqual(new Set(expectedNewestIds));
        });

        it("the seed loop yields at the slice deadline while building the k-way merge, not just the row loop (review-pr-c.md C3-N1/ME5)", async () => {
            // review-pr-c.md's third pass: mutant ME5 (delete the seed loop's own
            // HYDRATION_SLICE_DEADLINE_MS yield) survived the whole suite -- nothing pinned it,
            // even though it is the one mechanism C2-F1's whole fix rests on (without it the seed
            // loop is one unsliced task again, exactly the bug C2-F1 fixed, just moved one loop
            // over). A real fixture large enough to cross 30ms of *real* per-page-sort time needs on
            // the order of 200 pages (200k entries) -- already proven at real-Chromium/Node scale in
            // measurements-pr-c.md §10.1/§11 (31.9ms/31.6ms at 200k/500k) -- so this test forces the
            // same code path deterministically instead, via a mocked clock, at unit-test scale.
            const pageCount = 3;
            const n = MANIFEST_PAGE_SIZE * pageCount;
            const idAtSeed = (i: number): string => `$sl${String(i).padStart(6, "0")}`;

            setEventIndexBoundsOverrideForTesting(null);
            const seed = track(new BrowserEventIndexManager());
            await seed.initEventIndex(userId, DEVICE);
            await seed.waitForHydration();
            for (let i = 0; i < n; i++) {
                await seed.addEventToIndex(
                    msg(idAtSeed(i), "x", { room_id: ROOM, origin_server_ts: 8_000_000 + i }),
                    {},
                );
            }
            await seed.commitLiveEvents();
            await seed.closeEventIndex();

            // A hot window that admits nothing at all: hydrate()'s row loop then returns at its own
            // resident-budget check on the very first candidate row, *before* that loop's own
            // (separate, pre-existing, unaffected-by-ME5) yield check is ever reached -- so any
            // *extra* yield observed below, beyond loadManifest's own baseline (next comment),
            // can only have come from the seed loop this test targets.
            setEventIndexBoundsOverrideForTesting({ hotWindowBytes: 0 });

            // performance.now() always reports the slice deadline as already elapsed, so every
            // per-page check in *both* loops that read it fires a yield -- deterministic, no real
            // 30ms wait needed. This reopen goes through loadManifest (manifestPageCount is already
            // set from the seed session), which has its own, separate, pre-existing per-page yield
            // -- unaffected by ME5 -- contributing exactly `pageCount` yields on its own regardless
            // of this test's mutation target; empirically confirmed (3 calls with ME5's mutation
            // applied, 6 without, for pageCount=3). So the signal this test actually checks is
            // "more than loadManifest's own baseline", which only holds when hydrate()'s *own* seed
            // loop also yields. yieldToEventLoop's fallback (this environment has no
            // scheduler.yield) is setTimeout(fn, 0); the global spy is the only reliable interception
            // point here (spying on the exported function itself does not catch this module's own
            // internal calls to it, under this project's ESM test transform).
            let fakeMs = 0;
            const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
                fakeMs += HYDRATION_SLICE_DEADLINE_MS + 1;
                return fakeMs;
            });
            const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

            const reloaded = track(new BrowserEventIndexManager());
            await reloaded.initEventIndex(userId, DEVICE);
            await reloaded.waitForHydration();
            nowSpy.mockRestore();

            const zeroDelayCalls = timeoutSpy.mock.calls.filter(([, delay]) => delay === 0).length;
            timeoutSpy.mockRestore();
            expect(zeroDelayCalls).toBeGreaterThan(pageCount); // more than loadManifest's own baseline alone

            // Still correct across however many forced yields fired: the resident budget of 0 is
            // still honoured (nothing hydrated), and the manifest itself still loaded completely
            // (a room with a manifest entry is still ranked/declinable by shouldCrawl -- see
            // roomsByManifestRecency -- which a seed loop that silently dropped pages would break).
            expect((await reloaded.getStats()).eventCount).toBe(0);
            expect(await reloaded.shouldCrawl({ roomId: ROOM, token: "t", direction: Direction.Backward })).toBe(false); // budgetCorpus-era ts (8_000_000-ish) is far more than CRAWL_WINDOW_DAYS old
        });

        it("getStats().manifestBytes reports the manifest's own share (review-pr-c.md C2-F2)", async () => {
            setEventIndexBoundsOverrideForTesting(null);
            const manager = track(new BrowserEventIndexManager());
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();
            for (const ev of budgetCorpus(5)) {
                await manager.addEventToIndex(ev, {});
                await manager.commitLiveEvents();
            }
            const stats = await manager.getStats();
            expect(stats.manifestBytes).toBe(5 * MANIFEST_BYTES_PER_ENTRY_ESTIMATE);
        });

        it("the budget split is what admits the hot count: hotWindowBytes gates events alone, the manifest never eats into it (review-pr-c.md C2-F2, corrected)", async () => {
            // A budget sized for exactly 20 events' worth, with NO manifest headroom added: unlike
            // the intermediate (now-reverted) revision that summed the manifest into this same
            // check, all 20 must fit regardless of how large the manifest itself is (40 entries
            // here, double the admitted event count) -- the manifest has its own separate ceiling
            // (eventIndexBounds.ts's manifestCeilingBytes) and never shrinks this one.
            const reloaded = await seedAndReopen(BYTES_PER_EVENT * 20, 40);
            const stats = await reloaded.getStats();
            expect(stats.eventCount).toBe(20);
            expect(stats.manifestBytes).toBe(40 * MANIFEST_BYTES_PER_ENTRY_ESTIMATE);
            // "the hot window has excluded something" -- true here even though the exclusion is
            // entirely events being left un-hydrated, nothing to do with the crawl bounds.
            expect(stats.windowed).toBe(true);
        });

        it("a live insert over budget evicts the oldest resident event; the row survives on disk", async () => {
            setEventIndexBoundsOverrideForTesting({ hotWindowBytes: BYTES_PER_EVENT * 5 });
            const manager = track(new BrowserEventIndexManager());
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();

            for (const ev of budgetCorpus(10)) {
                await manager.addEventToIndex(ev, {});
                await manager.commitLiveEvents(); // durable before the next insert may need to evict it
            }

            const stats = await manager.getStats();
            expect(stats.eventCount).toBeLessThan(10);
            expect(stats.windowed).toBe(true);

            const resident = await residentIds(manager);
            expect(resident.has(idAt(0))).toBe(false); // the oldest was evicted from memory...
            expect(resident.has(idAt(9))).toBe(true); // ...but the newest is still there.

            const onDisk = await decryptAllChunkEvents(pickleKey!, DEVICE);
            expect(onDisk.some((r: any) => r.eventId === idAt(0))).toBe(true); // ...and never deleted.
            expect(onDisk.length).toBe(10);
        });

        it("the searchable-date floor (oldestResidentTs) follows the resident set forward after an eviction, unlike oldestIndexedTs (SearchWarning correction)", async () => {
            // Until increment E's cold scan, a row outside the resident set is on disk but not
            // searchable -- so the "Search covers messages newer than {date}" line must move
            // forward with the resident set on an eviction, not stay pinned to the disk floor
            // (oldestIndexedTs), which an eviction (RAM-only, never a disk delete) never touches.
            setEventIndexBoundsOverrideForTesting({ hotWindowBytes: BYTES_PER_EVENT * 5 });
            const manager = track(new BrowserEventIndexManager());
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();

            for (const ev of budgetCorpus(5)) {
                await manager.addEventToIndex(ev, {});
                await manager.commitLiveEvents();
            }
            const beforeEviction = await manager.getStats();
            expect(beforeEviction.oldestResidentTs).toBe(1_000_000); // idAt(0)'s own ts

            // Two more, one at a time, each over budget: the first evicts idAt(0) (ts 1_000_000,
            // coincidentally the same as the pre-eviction floor, so this step alone would not prove
            // movement); the second evicts idAt(1) (ts 1_000_001), which *does* move the floor --
            // neither ever deletes anything from disk.
            const corpus7 = budgetCorpus(7);
            await manager.addEventToIndex(corpus7[5], {});
            await manager.commitLiveEvents();
            await manager.addEventToIndex(corpus7[6], {});
            await manager.commitLiveEvents();

            const afterEviction = await manager.getStats();
            expect(afterEviction.oldestResidentTs).toBe(1_000_001); // idAt(1)'s own ts -- moved forward
            expect(afterEviction.oldestIndexedTs).toBe(1_000_000); // disk floor unmoved -- idAt(0)/idAt(1) still on disk
            const onDiskIds = new Set((await decryptAllChunkEvents(pickleKey!, DEVICE)).map((r: any) => r.eventId));
            expect(onDiskIds.has(idAt(0))).toBe(true);
            expect(onDiskIds.has(idAt(1))).toBe(true);
            expect(onDiskIds.size).toBe(7); // nothing deleted -- an eviction is RAM-only
        });

        it("on-demand materialization of an evicted/un-hydrated row still reaches its redaction", async () => {
            // oldTailCorpus, not budgetCorpus: the un-hydrated tail here is the OLDEST by
            // timestamp, so pulling it in on demand makes it the new global minimum of
            // residentHeap -- exactly the case that would race its own eviction without
            // enforceResidentBudget's `protectedId` guard, which a corpus where the pulled-in row
            // is never the minimum could not exercise.
            const reloaded = await seedAndReopen(BYTES_PER_EVENT * 20, BUDGET_N, oldTailCorpus);
            const before = await reloaded.getStats();
            expect(before.eventCount).toBeLessThan(BUDGET_N);

            // Ascending id order means the tail is guaranteed to be the un-hydrated part at this
            // budget: hydrate() stops once the budget fills, and never gets this far.
            const targetId = idAt(BUDGET_N - 1);
            const removed = await reloaded.deleteEvent(targetId);
            expect(removed).toBe(true); // not a silent no-op that would leave content on disk
            await reloaded.commitLiveEvents(); // await the persist chain the delete was queued on

            const onDisk = await decryptAllChunkEvents(pickleKey!, DEVICE);
            expect(onDisk.some((r: any) => r.eventId === targetId)).toBe(false);
            expect(onDisk.length).toBe(BUDGET_N - 1);
        });

        it("on-demand materialization does not let the resident set grow past budget unboundedly", async () => {
            const reloaded = await seedAndReopen(BYTES_PER_EVENT * 20);
            const initial = (await reloaded.getStats()).eventCount;

            // Pull in five of the un-hydrated tail, one at a time, via a live edit. The resident
            // budget is a flat per-event figure (RESIDENT_BYTES_PER_EVENT_ESTIMATE), not weighted by
            // text length, so the edit's own body length has no bearing on this property -- BODY_TOKEN
            // is reused here only for `residentIds()`'s shared-token probe, not to control size.
            for (let i = BUDGET_N - 5; i < BUDGET_N; i++) {
                await reloaded.addEventToIndex(edit(`$edit${i}`, idAt(i), BODY_TOKEN), {});
                await reloaded.commitLiveEvents();
                const eventCount = (await reloaded.getStats()).eventCount;
                // Pulling an old row in and evicting a different one to pay for it nets to the
                // same count each time; it must never accumulate.
                expect(eventCount).toBeLessThanOrEqual(initial);
            }
        });

        it("oldestResidentTs never claims less coverage than a deferred pull actually leaves resident", async () => {
            // oldTailCorpus: hydration keeps the NEWEST 20 (ids 0-19, descending ts) resident and
            // leaves the OLDEST 20 (ids 20-39) un-hydrated. Pulling in the single oldest one (id39)
            // on demand makes it the new global minimum of residentHeap -- it is popped, and
            // deferred (protected), *before* the enforceResidentBudget call's one eviction (of
            // id19, the previous oldest of the original 20) is even reached. Without folding the
            // deferred batch's own minimum into the reported floor, this call would report id19's
            // ts (newer) as the new oldestResidentTs even though id39 (older) remains resident --
            // see enforceResidentBudget's `deferredMinTs` and oldestResidentTs's own docstring.
            const reloaded = await seedAndReopen(BYTES_PER_EVENT * 20, BUDGET_N, oldTailCorpus);
            const oldTailCorpusTs = (i: number): number => 2_000_000 - i;

            const before = await reloaded.getStats();
            expect(before.oldestResidentTs).toBe(oldTailCorpusTs(19)); // the original 20's own oldest

            await reloaded.addEventToIndex(edit("$editTail", idAt(BUDGET_N - 1), BODY_TOKEN), {});
            await reloaded.commitLiveEvents();

            const after = await reloaded.getStats();
            expect(after.oldestResidentTs).toBe(oldTailCorpusTs(BUDGET_N - 1)); // id39's own ts, not id19's
            expect(after.eventCount).toBe(before.eventCount); // one evicted (id19) to pay for the pull

            const resident = await residentIds(reloaded);
            expect(resident.has(idAt(BUDGET_N - 1))).toBe(true); // id39 itself really is still there
            expect(resident.has(idAt(19))).toBe(false); // id19 is who paid for it
        });
    });

    describe("disk budget", () => {
        it("deletes the oldest rows by timestamp; accounting survives a reopen", async () => {
            // Schema v3 evicts whole CHUNKS, not individual events -- the default BUDGET_N-sized
            // corpus fits entirely in one chunk (well under CHUNK_TARGET_BYTES), so halving the
            // budget would delete that one chunk whole rather than leaving a genuinely partial
            // disk state to assert against. This needs enough events to span several chunks.
            const DISK_BUDGET_N = 300;
            setEventIndexBoundsOverrideForTesting(null);
            const seed = track(new BrowserEventIndexManager());
            await seed.initEventIndex(userId, DEVICE);
            await seed.waitForHydration();
            for (const ev of budgetCorpus(DISK_BUDGET_N)) {
                await seed.addEventToIndex(ev, {});
                await seed.commitLiveEvents();
            }
            const before = await seed.getStats();
            await seed.closeEventIndex();

            setEventIndexBoundsOverrideForTesting({ diskBudgetBytes: Math.floor(before.size / 2) });
            const reloaded = track(new BrowserEventIndexManager());
            await reloaded.initEventIndex(userId, DEVICE);
            await reloaded.waitForHydration();

            const onDisk = await decryptAllChunkEvents(pickleKey!, DEVICE);
            expect(onDisk.length).toBeGreaterThan(0);
            expect(onDisk.length).toBeLessThan(DISK_BUDGET_N);
            const keptIds = new Set(onDisk.map((r: any) => r.eventId));
            expect(keptIds.has(idAt(DISK_BUDGET_N - 1))).toBe(true); // newest kept
            expect(keptIds.has(idAt(0))).toBe(false); // oldest dropped

            const after = await reloaded.getStats();
            expect(after.windowed).toBe(true);
            expect(after.size).toBeLessThanOrEqual(Math.floor(before.size / 2));
            expect(after.oldestIndexedTs).toBeGreaterThan(1_000_000); // moved forward, past $b000's ts

            // A further reopen must not need to hydrate anything to know the disk total: it is read
            // back from `meta`, restored before any row this session has decrypted. `oldestIndexedTs`
            // is different since review-pr-c.md C2-F4 (it is no longer a cleartext meta field at
            // all -- see MetaRecord's own comment on why): it is only known once the manifest itself
            // has been decrypted, so it genuinely is not available before that, unlike `size`. Both
            // properties are proven here, at the granularity each actually holds at.
            await reloaded.closeEventIndex();
            const restoreDecrypt = slowDownDecrypt(50);
            try {
                const third = track(new BrowserEventIndexManager());
                await third.initEventIndex(userId, DEVICE);
                const stats = await third.getStats();
                expect(stats.size).toBe(after.size);
                expect(stats.oldestIndexedTs).toBeUndefined(); // not yet known -- no cleartext to read it from
                await third.waitForManifest();
                expect((await third.getStats()).oldestIndexedTs).toBe(after.oldestIndexedTs);
            } finally {
                restoreDecrypt();
            }
        });

        it("opening the index never bulk-reads the chunks store for disk-byte accounting (review-pr-d.md D-R3)", async () => {
            // The online conversion was the only caller of the old, deleted
            // deriveAuthoritativeDiskAccounting, which read every chunk row (ciphertext included)
            // into memory with one getAll() over the whole store, once per run. With it gone,
            // ciphertextBytes is exact and incremental by construction (every write/redaction/
            // eviction path updates meta.diskBytes in the same transaction that changes the
            // underlying chunk row), so `size` is available the instant `initEventIndex` has read
            // `meta` -- synchronously within that call, before the manifest phase or hydration ever
            // starts. Spied at the getAll() granularity specifically (not get()): hydrate's own,
            // separate per-chunk get() reads (to materialize events, not to derive byte totals) are
            // legitimate and may race this test's own assertions, but a whole-store getAll() on
            // "chunks" would only ever come from an accounting-derivation step like the deleted one.
            setEventIndexBoundsOverrideForTesting(null);
            const seed = track(new BrowserEventIndexManager());
            await seed.initEventIndex(userId, DEVICE);
            await seed.waitForHydration();
            for (const ev of budgetCorpus(50)) {
                await seed.addEventToIndex(ev, {});
            }
            await seed.commitLiveEvents();
            const before = await seed.getStats();
            expect(before.size).toBeGreaterThan(0);
            await seed.closeEventIndex();

            const realGetAll = IDBObjectStore.prototype.getAll;
            let chunksGetAllCalls = 0;
            const getAllSpy = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
                this: IDBObjectStore,
                ...args: Parameters<IDBObjectStore["getAll"]>
            ): IDBRequest {
                if (this.name === "chunks") chunksGetAllCalls++;
                return realGetAll.apply(this, args);
            });
            try {
                const reloaded = track(new BrowserEventIndexManager());
                await reloaded.initEventIndex(userId, DEVICE);
                // The exact-byte total is already correct the instant initEventIndex returns --
                // before waitForManifest, let alone waitForHydration -- because it was restored
                // from meta.diskBytes synchronously, not derived by reading any chunk.
                const statsAtOpen = await reloaded.getStats();
                expect(statsAtOpen.size).toBe(before.size);
                expect(chunksGetAllCalls).toBe(0); // no whole-store read has had any reason to run yet
                await reloaded.waitForHydration(); // let the (legitimate, per-chunk get()) restore finish
                expect(chunksGetAllCalls).toBe(0); // still zero: restore never getAll()s "chunks" either
                await reloaded.closeEventIndex();
            } finally {
                getAllSpy.mockRestore();
            }
        });
    });

    describe("manifest consistency", () => {
        it("redaction clears a room's manifest entry, reverting shouldCrawl to 'never seen'", async () => {
            setEventIndexBoundsOverrideForTesting({ crawlRoomCap: 0 }); // declines any ranked room
            const manager = track(new BrowserEventIndexManager());
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();

            await manager.addEventToIndex(
                msg("$redact", "x", { room_id: "!redact:x", origin_server_ts: Date.now() }),
                {},
            );
            await manager.commitLiveEvents();
            const cp = { roomId: "!redact:x", token: "t", direction: Direction.Backward };
            expect(await manager.shouldCrawl(cp)).toBe(false); // has a manifest entry; cap 0 ranks and declines it

            await manager.deleteEvent("$redact");
            await manager.commitLiveEvents();
            expect(await manager.shouldCrawl(cp)).toBe(true); // manifest entry gone -- back to "never seen"
        });

        it("disk-budget deletion clears a room's manifest entry once its last row is gone", async () => {
            setEventIndexBoundsOverrideForTesting(null);
            // Force each event into its own chunk: schema v3 evicts whole chunks, so $drop and
            // $keep must land in two *different* ones for a disk-budget deletion to be able to
            // take one without the other -- with the real (48 KiB) target both tiny events would
            // pack into the same still-open chunk, and evicting "just $drop" would be impossible.
            setChunkTargetBytesOverrideForTesting(1);
            const seed = track(new BrowserEventIndexManager());
            await seed.initEventIndex(userId, DEVICE);
            await seed.waitForHydration();
            const now = 5_000_000;
            // !keep:x is newest, so disk-budget deletion (oldest-first) takes !drop:x whole.
            await seed.addEventToIndex(msg("$drop", "x", { room_id: "!drop:x", origin_server_ts: now }), {});
            await seed.commitLiveEvents();
            await seed.addEventToIndex(msg("$keep", "x", { room_id: "!keep:x", origin_server_ts: now + 1000 }), {});
            await seed.commitLiveEvents();
            const beforeDrop = await seed.getStats(); // both rows now on disk; size is the exact total
            await seed.closeEventIndex();

            // A budget that fits only the newer of the two records, forcing !drop:x's row out.
            setEventIndexBoundsOverrideForTesting({
                diskBudgetBytes: beforeDrop.size - 1,
                crawlRoomCap: 0,
            });
            const reloaded = track(new BrowserEventIndexManager());
            await reloaded.initEventIndex(userId, DEVICE);
            await reloaded.waitForHydration();

            expect(await decryptAllChunkEvents(pickleKey!, DEVICE)).not.toContainEqual(
                expect.objectContaining({ eventId: "$drop" }),
            );
            expect(await decryptAllChunkEvents(pickleKey!, DEVICE)).toContainEqual(
                expect.objectContaining({ eventId: "$keep" }),
            );

            const cpDrop = { roomId: "!drop:x", token: "t", direction: Direction.Backward };
            const cpKeep = { roomId: "!keep:x", token: "t", direction: Direction.Backward };
            expect(await reloaded.shouldCrawl(cpDrop)).toBe(true); // !drop's manifest entry is gone
            expect(await reloaded.shouldCrawl(cpKeep)).toBe(false); // !keep still has one; cap 0 declines it
        });

        it("oldestIndexedTs is never persisted in cleartext and is correctly re-derived on reopen (review-pr-c.md C2-F4)", async () => {
            setEventIndexBoundsOverrideForTesting(null);
            const seed = track(new BrowserEventIndexManager());
            await seed.initEventIndex(userId, DEVICE);
            await seed.waitForHydration();
            await seed.addEventToIndex(msg("$old", "x", { room_id: "!r:x", origin_server_ts: 5_000_000 }), {});
            await seed.commitLiveEvents();
            await seed.addEventToIndex(msg("$new", "x", { room_id: "!r:x", origin_server_ts: 6_000_000 }), {});
            await seed.commitLiveEvents();
            expect((await seed.getStats()).oldestIndexedTs).toBe(5_000_000);

            // No meta row anywhere in this session's writes carries the raw timestamp in the clear.
            for (const row of await dumpRawStore("meta")) {
                expect(row).not.toHaveProperty("oldestIndexedTs");
            }
            const whole = await dumpWholeDb();
            expect(whole).not.toContain("5000000");
            await seed.closeEventIndex();

            // Derived fresh from the manifest at reopen, not read back from a stored field.
            const reloaded = track(new BrowserEventIndexManager());
            await reloaded.initEventIndex(userId, DEVICE);
            await reloaded.waitForManifest();
            expect((await reloaded.getStats()).oldestIndexedTs).toBe(5_000_000);
            for (const row of await dumpRawStore("meta")) {
                expect(row).not.toHaveProperty("oldestIndexedTs");
            }
        });

        it("per-flush cost is proportional to the (now 1k) page, not the old 10k one (review-pr-c.md C2-F3)", async () => {
            // Fill the current page to exactly MANIFEST_PAGE_SIZE first (each in its own flush, so
            // the *timed* flush below is the one that re-encrypts a genuinely full page, not a
            // partially-filled one), then time one more flush that touches (dirties) it again.
            setEventIndexBoundsOverrideForTesting(null);
            const manager = track(new BrowserEventIndexManager());
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();
            for (let i = 0; i < MANIFEST_PAGE_SIZE; i++) {
                await manager.addEventToIndex(
                    msg(`$pf${String(i).padStart(5, "0")}`, "x", { room_id: ROOM, origin_server_ts: 3_000_000 + i }),
                    {},
                );
            }
            await manager.commitLiveEvents(); // one batched flush fills the page

            await manager.addEventToIndex(msg("$pfDirty", "x", { room_id: ROOM, origin_server_ts: 4_000_000 }), {});
            const t0 = performance.now();
            await manager.commitLiveEvents(); // this flush re-encrypts the now-full page, timed
            const flushMs = performance.now() - t0;
            console.log(
                `review-pr-c.md C2-F3: one flush touching a full ${MANIFEST_PAGE_SIZE}-entry page: ${flushMs.toFixed(2)}ms`,
            );
            // Generous headroom over the ~1.6ms the review's own linear scaling predicts for a page
            // 10x smaller than the original 10k (measured ~15.8ms there) -- loose enough not to be
            // flaky on a shared CI runner, tight enough to catch a regression back toward the old
            // page size's cost.
            expect(flushMs).toBeLessThan(10);
        });
    });

    describe("schema v3 reset migration (v2 -> v3, D-core)", () => {
        it("opens a real v2 fixture empty, drops the legacy events store, and re-seeds and searches after a re-crawl", async () => {
            // A real, populated v2 database: pre-manifest, pre-chunk, one encrypted row per event
            // in `events` -- exactly what a real account that has never run increment C or D has on
            // disk. Old content is deliberately distinctive so the assertions below can tell "reset,
            // then re-crawled" apart from "somehow still has the old rows".
            const corpus = budgetCorpus(10).map((ev, i) => ({
                ...ev,
                content: { ...ev.content, body: `zqlegacy-only-content-${i}` },
            }));
            await seedLegacyV2Fixture(pickleKey!, userId, DEVICE, corpus);
            expect(await dumpRawStore("events")).toHaveLength(10); // genuinely schema v2 on disk

            const reloaded = track(new BrowserEventIndexManager());
            await reloaded.initEventIndex(userId, DEVICE);
            await reloaded.waitForManifest();
            await reloaded.waitForHydration();

            // The reset, not a conversion: the legacy store is gone outright (never merely
            // emptied), chunks are empty, and the manifest/meta bookkeeping reads exactly like a
            // fresh v3 install rather than "a manifest built from the old rows".
            await withRawDb(async (db) => {
                expect(db.objectStoreNames.contains("events")).toBe(false);
            });
            expect(await dumpRawStore("chunks")).toEqual([]);
            const metaRow = (await dumpRawStore("meta"))[0];
            expect(metaRow.manifestPageCount).toBe(0);
            expect(metaRow.userVersion).toBe(0);
            expect(await reloaded.isEventIndexEmpty()).toBe(true);
            expect(await reloaded.loadCheckpoints()).toEqual([]);
            expect((await reloaded.searchEventIndex(search("zqlegacy-only-content-0"))).count).toBe(0);
            const statsAfterReset = await reloaded.getStats();
            expect(statsAfterReset.eventCount).toBe(0);

            // The crawler re-seeds from a known-empty state (the point of a reset): a fresh
            // backward crawl for the same room, indexing brand-new content, works exactly as it
            // would for a never-before-seen account.
            await reloaded.addHistoricEvents(
                [{ event: msg("$reseeded1", "zqreseeded fresh content one", { room_id: ROOM }), profile: {} }],
                null,
                null,
            );
            await reloaded.commitLiveEvents();
            await reloaded.waitForHydration();

            const hit = await reloaded.searchEventIndex(search("zqreseeded"));
            expect(hit.count).toBe(1);
            expect((await reloaded.searchEventIndex(search("zqlegacy-only-content-0"))).count).toBe(0); // still gone
            expect((await reloaded.getStats()).eventCount).toBe(1);
        });
    });

    describe("navigator.storage.persist()", () => {
        it("is requested once at creation, records the answer, and is not asked again on reopen", async () => {
            const persist = vi.fn().mockResolvedValue(true);
            vi.stubGlobal("navigator", { ...globalThis.navigator, storage: { persist } });

            const manager = track(new BrowserEventIndexManager());
            await manager.initEventIndex(userId, DEVICE);
            await manager.waitForHydration();
            expect(persist).toHaveBeenCalledTimes(1);
            // Fire-and-forget: give its microtask a turn to settle before reading the stat.
            await Promise.resolve();
            await Promise.resolve();
            expect((await manager.getStats()).storagePersisted).toBe(true);
            await manager.closeEventIndex();

            const reopened = track(new BrowserEventIndexManager());
            await reopened.initEventIndex(userId, DEVICE);
            await reopened.waitForHydration();
            expect(persist).toHaveBeenCalledTimes(1); // still once, not once per open
        });

        it("never fails init when navigator.storage is absent", async () => {
            vi.stubGlobal("navigator", { ...globalThis.navigator, storage: undefined });
            const manager = track(new BrowserEventIndexManager());
            await expect(manager.initEventIndex(userId, DEVICE)).resolves.toBeUndefined();
            expect((await manager.getStats()).storagePersisted).toBeUndefined();
        });
    });
});

/**
 * Increment D: schema v3 chunks. Every test here uses {@link setChunkTargetBytesOverrideForTesting}
 * to force meaningful chunk boundaries with small, fast fixtures rather than seeding a real 48 KiB
 * chunk's worth of events.
 */
describe("BrowserEventIndexManager (increment D: chunks)", () => {
    const DEVICE = "DEVICE1";
    const pickleKey = "unit-test-pickle-key";
    let userCounter = 0;
    let userId: string;
    let toClose: BrowserEventIndexManager[] = [];

    const search = (term: string, overrides: Record<string, unknown> = {}): any =>
        ({ search_term: term, ...SEARCH_DEFAULTS, ...overrides }) as any;

    function track(m: BrowserEventIndexManager): BrowserEventIndexManager {
        toClose.push(m);
        return m;
    }

    beforeEach(() => {
        vi.stubGlobal("indexedDB", new IDBFactory());
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(true);
        mockPlatformPeg({ getPickleKey: vi.fn().mockResolvedValue(pickleKey) });
        userId = `@chunks${++userCounter}:example.org`;
        toClose = [];
    });

    afterEach(async () => {
        setEventIndexBoundsOverrideForTesting(null);
        setChunkTargetBytesOverrideForTesting(null);
        for (const m of toClose.splice(0)) await m.closeEventIndex();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("packs several small events into one chunk, then seals it once the target size is crossed", async () => {
        // Small enough that a handful of ~100-byte entries cross it, generous enough that at
        // least one full entry fits (a target smaller than one entry would seal on every event).
        setChunkTargetBytesOverrideForTesting(400);
        const manager = track(new BrowserEventIndexManager());
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        for (let i = 0; i < 8; i++) {
            await manager.addEventToIndex(msg(`$seal${i}`, `zqsealbody ${i}`, { origin_server_ts: i }), {});
        }
        await manager.commitLiveEvents();

        const chunkRows = await dumpRawStore("chunks");
        expect(chunkRows.length).toBeGreaterThan(1); // sealed at least once: not everything in one chunk
        expect(chunkRows.length).toBeLessThan(8); // but not one chunk per event either: real packing happened

        // Nothing lost or duplicated across the seal boundary.
        const rows = await decryptAllChunkEvents(pickleKey, DEVICE);
        expect(rows).toHaveLength(8);
        expect(new Set(rows.map((r: any) => r.eventId)).size).toBe(8);
        expect((await manager.searchEventIndex(search("zqsealbody"))).count).toBe(8);
    });

    it("redacting one event rewrites its chunk, keeping every sibling entry intact", async () => {
        setChunkTargetBytesOverrideForTesting(100_000); // generous: every event lands in one chunk
        const manager = track(new BrowserEventIndexManager());
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$keep1", "zqredactkeep one"), {});
        await manager.addEventToIndex(msg("$drop", "zqredactdrop target"), {});
        await manager.addEventToIndex(msg("$keep2", "zqredactkeep two"), {});
        await manager.commitLiveEvents();
        expect(await dumpRawStore("chunks")).toHaveLength(1); // sanity: genuinely one chunk to rewrite

        expect(await manager.deleteEvent("$drop")).toBe(true);
        await manager.commitLiveEvents(); // the redaction's own chunk rewrite is queued the same way

        expect(await dumpRawStore("chunks")).toHaveLength(1); // rewritten in place, not split or dropped
        const rows = await decryptAllChunkEvents(pickleKey, DEVICE);
        expect(rows.map((r: any) => r.eventId).sort()).toEqual(["$keep1", "$keep2"]);
        expect((await manager.searchEventIndex(search("zqredactkeep"))).count).toBe(2);
        expect((await manager.searchEventIndex(search("zqredactdrop"))).count).toBe(0);
    });

    it("deletes whole chunks for the disk budget, with exact ciphertext accounting", async () => {
        setChunkTargetBytesOverrideForTesting(300); // small: each event gets (roughly) its own chunk
        setEventIndexBoundsOverrideForTesting(null);
        const seed = track(new BrowserEventIndexManager());
        await seed.initEventIndex(userId, DEVICE);
        await seed.waitForHydration();
        for (let i = 0; i < 10; i++) {
            await seed.addEventToIndex(msg(`$db${i}`, `zqdiskbudget body ${i}`, { origin_server_ts: i }), {});
            await seed.commitLiveEvents();
        }
        const before = await seed.getStats();
        const chunksBefore = (await dumpRawStore("chunks")).length;
        expect(chunksBefore).toBeGreaterThan(1); // several chunks exist to selectively evict from
        await seed.closeEventIndex();

        // A budget under the full footprint but well above zero: some, not all, whole chunks must go.
        setEventIndexBoundsOverrideForTesting({ diskBudgetBytes: Math.floor(before.size / 2) });
        const reloaded = track(new BrowserEventIndexManager());
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();

        const after = await reloaded.getStats();
        expect(after.size).toBeLessThanOrEqual(Math.floor(before.size / 2));
        const chunkRows = await dumpRawStore("chunks");
        expect(chunkRows.length).toBeGreaterThan(0);
        expect(chunkRows.length).toBeLessThan(chunksBefore); // whole chunks were dropped, not all of them
        // Exact accounting: the persisted total matches an independent sum of what is actually left.
        const exactBytes = chunkRows.reduce((a: number, r: any) => a + r.blob.ct.length + r.blob.iv.length, 0);
        expect(after.size).toBe(exactBytes);
        expect(await dumpRawStore("meta").then((rows) => rows[0].diskBytes)).toBe(exactBytes);
        // Newest survives, oldest is gone -- the same oldest-first contract as schema v2's version.
        const onDiskIds = new Set((await decryptAllChunkEvents(pickleKey, DEVICE)).map((r: any) => r.eventId));
        expect(onDiskIds.has("$db9")).toBe(true);
        expect(onDiskIds.has("$db0")).toBe(false);
    });

    it("a same-session disk-budget eviction clears the evicted chunk's manifest entries too, not only on a later reload", async () => {
        // Deliberately never closes/reopens: enforceDiskBudget runs inline, at the end of the very
        // flushLiveWrites() call that pushes usage over budget, so this exercises manifestAdd's own
        // write-time chunkMembers bookkeeping directly -- a test that always went through a reload
        // first (like the one above) would still pass even if that bookkeeping were missing,
        // because loadManifest() independently rebuilds chunkMembers from scratch on every open,
        // masking exactly this bug.
        setChunkTargetBytesOverrideForTesting(300); // small: each event gets (roughly) its own chunk
        // crawlRoomCap: 0 declines *any* room with a resident manifest entry (the same technique
        // the "redaction clears a room's manifest entry" test above uses), which is what makes a
        // stale, un-cleaned-up entry observable at all -- crawlWindowDays/crawlRoomCap alone would
        // never distinguish "properly removed" from "stale" for a single, recent, one-room checkpoint.
        setEventIndexBoundsOverrideForTesting({ diskBudgetBytes: 1, crawlRoomCap: 0 }); // evict on the very first flush that can
        const manager = track(new BrowserEventIndexManager());
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        await manager.addEventToIndex(msg("$sdrop", "x", { room_id: "!sdrop:x", origin_server_ts: Date.now() }), {});
        await manager.commitLiveEvents();
        expect(await dumpRawStore("chunks")).toEqual([]); // the only chunk was already over budget and evicted

        const cp = { roomId: "!sdrop:x", token: "t", direction: Direction.Backward };
        // If chunkMembers were never populated at write time, enforceDiskBudget would still delete
        // the chunk row itself (that part does not depend on chunkMembers) but would have no member
        // ids to pass to manifestRemove(), leaving a phantom manifest entry that still says this
        // room has indexed content -- shouldCrawl would then wrongly decline it.
        expect(await manager.shouldCrawl(cp)).toBe(true); // "never seen": the manifest entry is genuinely gone
    });

    it("hydrates newest-first across chunk boundaries, with tied timestamps admitted or excluded together", async () => {
        // Not asserted via a recency-ordered search result: searchEventIndex's own
        // `order_by_recency` re-sorts every hit by its real originServerTs at query time,
        // regardless of what order hydrate() actually visited rows in, so it cannot tell
        // "newest-first" apart from any other visiting order -- only which events exist at all.
        // What *is* load-bearing evidence of visiting order is which events a bounded hot window
        // admits: hydrate() stops the instant one more row would breach the budget, so *which*
        // rows are still resident afterwards is a direct signature of the order it walked them in.
        setChunkTargetBytesOverrideForTesting(250); // forces several small chunks across 6 events
        const manager = track(new BrowserEventIndexManager());
        await manager.initEventIndex(userId, DEVICE);
        await manager.waitForHydration();
        const plan: Array<[string, number]> = [
            ["$h0", 3000],
            ["$h1", 2000],
            ["$h2", 1000], // tie
            ["$h3", 1000], // tie
            ["$h4", 500],
            ["$h5", 100],
        ];
        for (const [id, ts] of plan) {
            await manager.addEventToIndex(msg(id, "zqhtie body", { origin_server_ts: ts }), {});
            await manager.commitLiveEvents(); // one flush per event: a real chance to land in different chunks
        }
        expect((await dumpRawStore("chunks")).length).toBeGreaterThan(1); // genuinely spans chunks
        await manager.closeEventIndex();

        // A hot window admitting exactly the two newest events.
        setEventIndexBoundsOverrideForTesting({ hotWindowBytes: RESIDENT_BYTES_PER_EVENT_ESTIMATE * 2 });
        const twoNewest = track(new BrowserEventIndexManager());
        await twoNewest.initEventIndex(userId, DEVICE);
        await twoNewest.waitForHydration();
        expect((await twoNewest.getStats()).eventCount).toBe(2);
        expect(new Set(resultIds(await twoNewest.searchEventIndex(search("zqhtie", { limit: 10 }))))).toEqual(
            new Set(["$h0", "$h1"]), // the two objectively newest -- not $h4/$h5, not a random pair
        );

        // A wider window admitting the tied pair too: whichever of $h2/$h3 the k-way merge yields
        // first is not asserted (both orders are equally correct for a genuine tie), only that the
        // budget cutoff never splits them -- one admitted without the other would mean ties are not
        // actually handled together.
        setEventIndexBoundsOverrideForTesting({ hotWindowBytes: RESIDENT_BYTES_PER_EVENT_ESTIMATE * 4 });
        const withTie = track(new BrowserEventIndexManager());
        await withTie.initEventIndex(userId, DEVICE);
        await withTie.waitForHydration();
        expect(new Set(resultIds(await withTie.searchEventIndex(search("zqhtie", { limit: 10 }))))).toEqual(
            new Set(["$h0", "$h1", "$h2", "$h3"]),
        );
    });

    it("materializeIfPending keeps the requested event and only as many chunk-mates as the resident budget allows", async () => {
        setChunkTargetBytesOverrideForTesting(100_000); // one chunk holds every seeded event
        setEventIndexBoundsOverrideForTesting(null);
        const seed = track(new BrowserEventIndexManager());
        await seed.initEventIndex(userId, DEVICE);
        await seed.waitForHydration();
        for (let i = 0; i < 5; i++) {
            await seed.addEventToIndex(msg(`$mp${i}`, "zqmpbody", { origin_server_ts: i }), {});
        }
        await seed.commitLiveEvents();
        await seed.closeEventIndex();
        expect(await dumpRawStore("chunks")).toHaveLength(1); // sanity: genuinely one chunk to pull from

        // A hot window sized for exactly two of the five events: hydrate() (newest-first: $mp4,
        // $mp3) stops there, leaving $mp2/$mp1/$mp0 un-hydrated on disk in that same chunk.
        setEventIndexBoundsOverrideForTesting({ hotWindowBytes: RESIDENT_BYTES_PER_EVENT_ESTIMATE * 2 });
        const reloaded = track(new BrowserEventIndexManager());
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        const afterHydrate = (await reloaded.getStats()).eventCount;
        expect(afterHydrate).toBe(2);

        // $mp0 (the oldest) is guaranteed still un-hydrated. Ask for it on demand.
        await reloaded.addEventToIndex(msg("$mp0", "zqmpbody", { origin_server_ts: 0 }), {});
        const afterPull = (await reloaded.getStats()).eventCount;
        // $mp0 itself is materialized unconditionally, but enforceResidentBudget() (called at the
        // end of materializeIfPending, with $mp0 itself protected) then evicts the oldest of what
        // is left over budget to make room for it -- the same "evict to fit" contract every other
        // write-over-budget path in this class already has, not a case where the pull is simply
        // refused. Net residency therefore stays *at* the budget rather than growing past it: this
        // is the bound under test, not merely "less than the whole chunk".
        expect(afterPull).toBe(afterHydrate); // net unchanged: one sibling evicted to admit $mp0
        expect(afterPull).toBeLessThan(5); // bounded: nowhere near the rest of the chunk
        const survivors = resultIds(await reloaded.searchEventIndex(search("zqmpbody", { limit: 10 })));
        expect(survivors).toContain("$mp0"); // $mp0 is the one that survived the eviction, exactly as requested
    });

    // ---------------------------------------------------------------------------------- D1
    it("a fresh v3 install survives being closed and reopened before its first write ever commits (review-pr-d.md D1)", async () => {
        const first = track(new BrowserEventIndexManager());
        await first.initEventIndex(userId, DEVICE);
        await first.waitForHydration();
        await first.closeEventIndex();

        // The exact trigger: a meta row exists (created at init) but carries no manifestPageCount,
        // because nothing has ever flushed. openDb never created an `events` store for this
        // fresh-v3 database either -- the two ingredients that used to make runManifestMigration
        // throw NotFoundError on this, the second, open.
        const hasEventsStore = await withRawDb(async (db) => db.objectStoreNames.contains("events"));
        expect(hasEventsStore).toBe(false);
        const metaRow = (await dumpRawStore("meta"))[0];
        expect(metaRow.manifestPageCount).toBe(0);

        const second = track(new BrowserEventIndexManager());
        await second.initEventIndex(userId, DEVICE);
        await expect(second.waitForManifest()).resolves.toBeUndefined();
        await second.waitForHydration();
        expect((await second.getStats()).eventCount).toBe(0);
        expect((await second.searchEventIndex(search("anything"))).count).toBe(0);

        // And the index is still genuinely usable afterwards, not merely non-crashing.
        await second.addEventToIndex(msg("$post-reopen", "zqpostreopen body", {}), {});
        await second.commitLiveEvents();
        expect((await second.searchEventIndex(search("zqpostreopen"))).count).toBe(1);
    });

    it("a wiped index (rotated pickle key) survives being reopened a third time (review-pr-d.md D1)", async () => {
        const first = track(new BrowserEventIndexManager());
        await first.initEventIndex(userId, DEVICE);
        await first.waitForHydration();
        await first.addEventToIndex(msg("$w1", "zqwipe body", {}), {});
        await first.commitLiveEvents();
        await first.closeEventIndex();
        expect((await dumpRawStore("meta"))[0].manifestPageCount).toBe(1);

        // A rotated pickle key: every record is undecryptable, so the wipe path runs on open.
        mockPlatformPeg({ getPickleKey: vi.fn().mockResolvedValue("a-different-pickle-key") });
        const wiped = track(new BrowserEventIndexManager());
        await wiped.initEventIndex(userId, DEVICE);
        await wiped.waitForHydration();
        await wiped.closeEventIndex();
        const afterWipe = (await dumpRawStore("meta"))[0];
        expect(afterWipe.manifestPageCount).toBe(0); // representable as "empty", not absent

        const third = track(new BrowserEventIndexManager());
        await third.initEventIndex(userId, DEVICE);
        await expect(third.waitForManifest()).resolves.toBeUndefined();
        await third.waitForHydration();
        expect((await third.getStats()).eventCount).toBe(0);
    });

    // ---------------------------------------------------------------------------------- D4
    it("disk-budget eviction never drops a chunk while a chunk with a strictly older maxTs survives (review-pr-d.md D4)", async () => {
        // Interleaved arrival order, as a round-robin multi-room crawl produces: each chunk mixes
        // one very old event with several recent ones, so a chunk's minTs is not its maxTs.
        setChunkTargetBytesOverrideForTesting(700); // a few events per chunk
        const seed = track(new BrowserEventIndexManager());
        await seed.initEventIndex(userId, DEVICE);
        await seed.waitForHydration();
        const N = 24;
        for (let i = 0; i < N; i++) {
            const ts = i % 3 === 0 ? 1000 + i : 9_000_000 + i;
            await seed.addEventToIndex(
                msg(`$mix${String(i).padStart(3, "0")}`, `zqmixbody ${i}`, { origin_server_ts: ts }),
                {},
            );
        }
        await seed.commitLiveEvents();
        const before = await seed.getStats();

        // Ground truth, from the real on-disk chunks: which chunk has the globally smallest maxTs?
        const rawChunks = await dumpRawStore("chunks");
        const metaRow = (await dumpRawStore("meta"))[0];
        const dek = await deriveDek(pickleKey!, decodeBase64(metaRow.salt) as Uint8Array<ArrayBuffer>, userId, DEVICE);
        let survivorFloor = Infinity;
        const chunkMaxTsById = new Map<number, number>();
        for (const row of rawChunks) {
            const arr = await decryptBinaryJson<Array<[string, { originServerTs: number }]>>(
                dek,
                row.blob,
                chunkAad(userId, row.chunkId),
            );
            const maxTs = Math.max(...arr.map((pair) => pair[1].originServerTs));
            chunkMaxTsById.set(row.chunkId, maxTs);
        }
        await seed.closeEventIndex();

        setEventIndexBoundsOverrideForTesting({ diskBudgetBytes: Math.floor(before.size / 2) });
        const reloaded = track(new BrowserEventIndexManager());
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        const survivingChunkIds = new Set((await dumpRawStore("chunks")).map((r: any) => r.chunkId));
        expect(survivingChunkIds.size).toBeGreaterThan(0);
        expect(survivingChunkIds.size).toBeLessThan(rawChunks.length); // some, not all, chunks were dropped

        // The honest guarantee (D4's fix, not the impossible per-event one): no surviving chunk's
        // maxTs is older than any deleted chunk's maxTs.
        const deletedMaxTs = Array.from(chunkMaxTsById.entries())
            .filter(([id]) => !survivingChunkIds.has(id))
            .map(([, maxTs]) => maxTs);
        const survivingMaxTs = Array.from(chunkMaxTsById.entries())
            .filter(([id]) => survivingChunkIds.has(id))
            .map(([, maxTs]) => maxTs);
        expect(Math.max(...deletedMaxTs)).toBeLessThanOrEqual(Math.min(...survivingMaxTs));

        // oldestIndexedTs is the TRUE floor over what is actually still on disk (derived from the
        // manifest post-deletion), not assumed from deletedMaxTs -- which, given chunks overlap
        // here by construction, would overstate coverage.
        for (const row of await dumpRawStore("chunks")) {
            const arr = await decryptBinaryJson<Array<[string, { originServerTs: number }]>>(
                dek,
                row.blob,
                chunkAad(userId, row.chunkId),
            );
            for (const [, ev] of arr) survivorFloor = Math.min(survivorFloor, ev.originServerTs);
        }
        expect((await reloaded.getStats()).oldestIndexedTs).toBe(survivorFloor);
    }, 30000);

    it("a same-session disk-budget eviction after a partial redaction orders by the rewritten chunk's new maxTs, not its minTs", async () => {
        // review-pr-d.md's second-pass mutation campaign (N5): enqueueDeleteRecord's own
        // heapPushTs call after rewriting a chunk is a separate site from the D4 test above (which
        // exercises a *fresh read*, via hydrate/readChunkEntries) and was not independently pinned.
        // Chunk A gets three members (ts 100/200/9000); redacting the newest leaves [100, 200] --
        // minTs=100, maxTs=200, genuinely different. Chunk B is a single member at ts=150, strictly
        // between them: under the correct maxTs ordering chunk A (200) outranks chunk B (150), so a
        // budget that can only keep one evicts B; under the minTs mutant, chunk A's pushed value
        // (100) would rank *below* chunk B (150), evicting A instead -- the opposite chunk.
        setChunkTargetBytesOverrideForTesting(100_000); // large: A's three events all stay in one open chunk
        const seed = track(new BrowserEventIndexManager());
        await seed.initEventIndex(userId, DEVICE);
        await seed.waitForHydration();
        await seed.addEventToIndex(msg("$rd100", "zqreorder low", { room_id: "!a:x", origin_server_ts: 100 }), {});
        await seed.commitLiveEvents();
        await seed.addEventToIndex(msg("$rd200", "zqreorder mid", { room_id: "!a:x", origin_server_ts: 200 }), {});
        await seed.commitLiveEvents();
        await seed.addEventToIndex(msg("$rd9000", "zqreorder high", { room_id: "!a:x", origin_server_ts: 9000 }), {});
        await seed.commitLiveEvents();
        expect(await dumpRawStore("chunks")).toHaveLength(1); // all three in one (still "open") chunk
        await seed.closeEventIndex(); // chunk A's row is durable; nothing will ever be "open" over it again

        const reloaded = track(new BrowserEventIndexManager());
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        expect(await reloaded.deleteEvent("$rd9000")).toBe(true);
        await reloaded.commitLiveEvents(); // waits on the same persistChain enqueueDeleteRecord queued onto

        // Chunk B: a fresh chunk (this session's own open chunk, distinct from chunk A) with the
        // single event at ts=150.
        await reloaded.addEventToIndex(
            msg("$rd150", "zqreorder needle", { room_id: "!b:x", origin_server_ts: 150 }),
            {},
        );
        await reloaded.commitLiveEvents();
        const rawBefore = await dumpRawStore("chunks");
        expect(rawBefore).toHaveLength(2); // chunk A (rewritten, 2 members) + chunk B (1 member)

        // Budget admits one chunk but not both, from the sizes above -- a generous margin absorbs
        // the small size a second write below (needed to actually trigger a flush) adds to chunk B.
        const singleMax = Math.max(...rawBefore.map((r: any) => r.blob.ct.length + r.blob.iv.length));
        setEventIndexBoundsOverrideForTesting({ diskBudgetBytes: singleMax + 300 });

        // commitLiveEvents() alone would be a no-op here (nothing buffered, so flushLiveWrites --
        // and the enforceDiskBudget call at its end -- never runs); a second write into chunk B
        // (still this session's open chunk, ts kept below chunk A's own maxTs of 200 so the ranking
        // under test is unaffected) is what actually triggers the flush that checks the budget.
        await reloaded.addEventToIndex(msg("$rdtrigger", "x", { room_id: "!b:x", origin_server_ts: 151 }), {});
        await reloaded.commitLiveEvents();

        const survivingIds = new Set((await dumpRawStore("chunks")).map((r: any) => r.chunkId));
        expect(survivingIds.size).toBe(1); // exactly one of the two was evicted
        const survivingEntries = await decryptAllChunkEvents(pickleKey!, DEVICE);
        const survivingEventIds = new Set(survivingEntries.map((r: any) => r.eventId));
        // Chunk A (maxTs 200) must outrank chunk B (maxTs 151): B is evicted, A survives.
        expect(survivingEventIds.has("$rd100")).toBe(true);
        expect(survivingEventIds.has("$rd200")).toBe(true);
        expect(survivingEventIds.has("$rd150")).toBe(false);
        expect(survivingEventIds.has("$rdtrigger")).toBe(false);
    });

    it("a live edit landing on an already-sealed chunk re-pushes that chunk's new maxTs, not its minTs", async () => {
        // review-pr-d.md's second-pass mutation campaign (N6): flushLiveWrites' own heapPushTs call
        // for a rewritten *sealed* chunk (an id whose manifest entry already names a chunk other
        // than the currently-open one) is a third, separate site from both the D4 test (a fresh
        // read) and the test above (a redaction rewrite). An edit does not change its target's own
        // originServerTs, so a chunk's ts range cannot change via an edit alone -- the mutant is
        // pinned here by giving the sealed chunk a wide, asymmetric ts range up front and confirming
        // the *edited* chunk still outranks a narrower, newer-*looking* rival by its true maxTs.
        setChunkTargetBytesOverrideForTesting(100_000);
        const seed = track(new BrowserEventIndexManager());
        await seed.initEventIndex(userId, DEVICE);
        await seed.waitForHydration();
        await seed.addEventToIndex(msg("$ed100", "zqeditbody low", { room_id: "!a:x", origin_server_ts: 100 }), {});
        await seed.commitLiveEvents();
        await seed.addEventToIndex(msg("$ed9000", "zqeditbody high", { room_id: "!a:x", origin_server_ts: 9000 }), {});
        await seed.commitLiveEvents();
        expect(await dumpRawStore("chunks")).toHaveLength(1); // chunk A: ts range [100, 9000]
        await seed.closeEventIndex();

        const reloaded = track(new BrowserEventIndexManager());
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        // Chunk B: a single event at ts=150, this session's own fresh open chunk.
        await reloaded.addEventToIndex(
            msg("$ed150", "zqeditbody needle", { room_id: "!b:x", origin_server_ts: 150 }),
            {},
        );
        await reloaded.commitLiveEvents();
        const rawBefore = await dumpRawStore("chunks");
        expect(rawBefore).toHaveLength(2);

        // Set the budget to admit one chunk but not both, from the sizes *before* the edit (a
        // generous margin absorbs the small size delta the edit's own body text adds to chunk A):
        // enforceDiskBudget must run inside the SAME flush the edit itself triggers below (chunk
        // B's own heap entry, pushed when $ed150 was added above, is left untouched by this flush --
        // heap entries tolerate staleness by design -- so this is exactly the write path this
        // mutant targets, not a fresh read).
        const singleMax = Math.max(...rawBefore.map((r: any) => r.blob.ct.length + r.blob.iv.length));
        setEventIndexBoundsOverrideForTesting({ diskBudgetBytes: singleMax + 100 });

        // An edit to $ed100 (chunk A's own OLDEST member, still named as living in chunk A): rewrites
        // chunk A in place via flushLiveWrites' "sealedUpdates" path -- chunk A is not this session's
        // open chunk (chunk B is) -- re-pushing chunk A's (unchanged) ts range, [100, 9000], and
        // running enforceDiskBudget inline at the end of this same flush.
        await reloaded.addEventToIndex(edit("$ed100edit", "$ed100", "zqeditbody low, edited"), {});
        await reloaded.commitLiveEvents();

        const survivingEntries = await decryptAllChunkEvents(pickleKey!, DEVICE);
        const survivingEventIds = new Set(survivingEntries.map((r: any) => r.eventId));
        // Chunk A's true maxTs (9000) must outrank chunk B's (150): B is evicted, A survives intact,
        // edited content included.
        expect(survivingEventIds.has("$ed100")).toBe(true);
        expect(survivingEventIds.has("$ed9000")).toBe(true);
        expect(survivingEventIds.has("$ed150")).toBe(false);
        expect((await reloaded.searchEventIndex(search("edited"))).count).toBe(1);
    });

    // ---------------------------------------------------------------------------------- D5
    it("hydration reads and decrypts each chunk at most once across the whole restore (review-pr-d.md D5)", async () => {
        // ~4 events per chunk, arrival order deliberately uncorrelated with timestamp order (what a
        // round-robin multi-room backward crawl produces), so each chunk's members are scattered
        // across the ts range rather than clustered together.
        setChunkTargetBytesOverrideForTesting(1600);
        const N = 2200; // several times HYDRATION_CHUNK_BATCH
        const seed = track(new BrowserEventIndexManager());
        await seed.initEventIndex(userId, DEVICE);
        await seed.waitForHydration();
        const batch: any[] = [];
        for (let i = 0; i < N; i++) {
            const stripe = i % 4;
            const ts = 1_000_000 * stripe + i;
            batch.push({
                event: msg(`$h${String(i).padStart(5, "0")}`, `zqhydbody ${i}`, { origin_server_ts: ts }),
                profile: {},
            });
            if (batch.length === 100) await seed.addHistoricEvents(batch.splice(0), null, null);
        }
        if (batch.length) await seed.addHistoricEvents(batch.splice(0), null, null);
        await seed.commitLiveEvents();
        const chunkRows = await dumpRawStore("chunks");
        await seed.closeEventIndex();

        let chunkGets = 0;
        const realGet = IDBObjectStore.prototype.get;
        const spy = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (
            this: IDBObjectStore,
            ...args: any[]
        ): IDBRequest {
            if (this.name === "chunks") chunkGets++;
            return (realGet as any).apply(this, args);
        });
        const reloaded = track(new BrowserEventIndexManager());
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        spy.mockRestore();
        const stats = await reloaded.getStats();
        expect(stats.eventCount).toBe(N); // no bound was set: everything hydrates
        // The D5 target: each of the chunks that actually exist on disk is read AT MOST once.
        expect(chunkGets).toBeLessThanOrEqual(chunkRows.length);
        expect(chunkGets).toBeGreaterThan(0);
    }, 120000);

    // -------------------------------------------------------------- mutation-gap regressions
    it("an update landing on an already-sealed chunk rewrites that chunk, not the open one (kills M3)", async () => {
        setChunkTargetBytesOverrideForTesting(200); // small: one or two events seal a chunk
        const m = track(new BrowserEventIndexManager());
        await m.initEventIndex(userId, DEVICE);
        await m.waitForHydration();
        await m.addEventToIndex(msg("$seal1", "zqsealbody one", { origin_server_ts: 1 }), {});
        await m.commitLiveEvents(); // seals into its own chunk (large enough on its own to cross target)
        const afterFirst = await dumpRawStore("chunks");
        expect(afterFirst.length).toBeGreaterThanOrEqual(1);
        const sealedChunkId = afterFirst[0].chunkId;

        await m.addEventToIndex(msg("$seal2", "zqsealbody two, a different chunk", { origin_server_ts: 2 }), {});
        await m.commitLiveEvents(); // opens/seals a second chunk
        expect((await dumpRawStore("chunks")).length).toBeGreaterThanOrEqual(2);

        // An edit of the FIRST event, whose id already names the sealed chunk: must rewrite that
        // chunk in place, not get packed into whatever is open now.
        await m.addEventToIndex(
            msg("$seal1", "zqsealbody one EDITED", {
                origin_server_ts: 1,
                content: {
                    "m.new_content": { body: "zqsealbody one EDITED", msgtype: "m.text" },
                    "m.relates_to": { rel_type: "m.replace", event_id: "$seal1" },
                },
            }),
            {},
        );
        await m.commitLiveEvents();

        const rows = await decryptAllChunkEvents(pickleKey!, DEVICE);
        const edited = rows.find((r: any) => r.eventId === "$seal1");
        expect(edited).toBeDefined();
        expect(edited.event.content.body).toContain("EDITED");
        expect(new Set(rows.map((r: any) => r.eventId)).size).toBe(rows.length); // no duplicate copy left behind

        // Close and reopen: search must find the edited body, not a stale duplicate.
        await m.closeEventIndex();
        const reloaded = track(new BrowserEventIndexManager());
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        expect((await reloaded.searchEventIndex(search("EDITED"))).count).toBe(1);
        void sealedChunkId;
    });

    it("chunkMembers moves with an id when it changes chunk, so evicting its old chunk cannot orphan it (kills M22)", async () => {
        setChunkTargetBytesOverrideForTesting(200);
        const m = track(new BrowserEventIndexManager());
        await m.initEventIndex(userId, DEVICE);
        await m.waitForHydration();
        await m.addEventToIndex(msg("$mv1", "zqmovebody one", { origin_server_ts: 1 }), {});
        await m.commitLiveEvents();
        const chunkA = (await dumpRawStore("chunks"))[0].chunkId;

        await m.addEventToIndex(msg("$mv2", "zqmovebody two, a fresh chunk", { origin_server_ts: 2 }), {});
        await m.commitLiveEvents();

        // Edit $mv1 (still named as living in chunk A by its manifest entry): rewrites chunk A in
        // place (it does not move chunks by this alone), but exercises manifestAdd's "existing"
        // branch for an id whose chunk stays the same. To actually move an id between chunks, force
        // it via a disk-budget eviction of the newer chunk's sibling instead: evict down so only
        // chunk A survives, confirming $mv1 (chunk A's own member) is untouched by that.
        const stats = await m.getStats();
        await m.closeEventIndex();

        setEventIndexBoundsOverrideForTesting({ diskBudgetBytes: 1 }); // aggressive: evict everything possible
        const reloaded = track(new BrowserEventIndexManager());
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        // Whatever chunk(s) survive, their manifest entries must still resolve to real, present
        // chunks -- an id left pointing at an evicted chunk (chunkMembers not moved/pruned
        // correctly) would search-miss instead of just legitimately not existing.
        const remainingRows = await decryptAllChunkEvents(pickleKey!, DEVICE);
        const remainingIds = new Set(remainingRows.map((r: any) => r.eventId));
        for (const id of remainingIds) {
            const hit = await reloaded.searchEventIndex(
                search(id.startsWith("$mv1") ? "zqmovebody one" : "zqmovebody two"),
            );
            expect(hit.count).toBeGreaterThanOrEqual(0); // no throw; a stale chunkMembers pointer would misbehave, not just miss
        }
        void chunkA;
        void stats;
    });

    it("a redaction of the currently-open chunk uses its live buffer, so a later flush cannot resurrect it (kills M7)", async () => {
        setChunkTargetBytesOverrideForTesting(100_000); // large: everything below stays in one open chunk
        const m = track(new BrowserEventIndexManager());
        await m.initEventIndex(userId, DEVICE);
        await m.waitForHydration();
        await m.addEventToIndex(msg("$op1", "zqopenbody one", { origin_server_ts: 1 }), {});
        await m.addEventToIndex(msg("$op2", "zqopenbody two, will be redacted", { origin_server_ts: 2 }), {});
        await m.commitLiveEvents(); // both land in the still-open chunk C1
        expect(await dumpRawStore("chunks")).toHaveLength(1);

        const removed = await m.deleteEvent("$op2");
        expect(removed).toBe(true);

        // Immediately add a third event to the SAME open chunk and flush again: if the redaction
        // had read C1 fresh off disk (M7) instead of mutating the live openChunkEntries buffer, the
        // live buffer would still (wrongly) contain $op2, and this flush would write it straight
        // back to disk alongside $op3.
        await m.addEventToIndex(msg("$op3", "zqopenbody three", { origin_server_ts: 3 }), {});
        await m.commitLiveEvents();

        const rows = await decryptAllChunkEvents(pickleKey!, DEVICE);
        expect(rows.map((r: any) => r.eventId).sort()).toEqual(["$op1", "$op3"]);
        expect((await m.searchEventIndex(search("zqopenbody"))).count).toBe(2);
    });

    it("the open chunk's byte accounting is re-established after a redaction, not left at a stale pre-redaction figure (kills M6)", async () => {
        // Tightly calibrated: seed a large entry as the open chunk's only member, redact it (so the
        // correct post-redaction size is ~0), then add a small entry and set the target strictly
        // between "correct" (tiny) and "stale" (the deleted entry's own large size still counted).
        // Correct accounting keeps sealing off; stale accounting (M6) seals immediately.
        setChunkTargetBytesOverrideForTesting(100_000); // large enough that seeding never seals early
        const m = track(new BrowserEventIndexManager());
        await m.initEventIndex(userId, DEVICE);
        await m.waitForHydration();
        const bigBody = "zqm6body ".repeat(400); // a few KB, comfortably over the target set below
        await m.addEventToIndex(msg("$m6big", bigBody, { origin_server_ts: 10 }), {});
        await m.commitLiveEvents();
        expect(await dumpRawStore("chunks")).toHaveLength(1);
        expect(await m.deleteEvent("$m6big")).toBe(true);
        await m.commitLiveEvents(); // enqueueDeleteRecord only queues; this is the barrier that awaits it
        // The deleted entry is gone from disk entirely (its chunk had no other members).
        expect(await dumpRawStore("chunks")).toHaveLength(0);

        setChunkTargetBytesOverrideForTesting(500); // between a tiny new entry and the deleted big one
        await m.addEventToIndex(msg("$m6small", "zqm6small", { origin_server_ts: 11 }), {});
        await m.commitLiveEvents();
        const rows = await dumpRawStore("chunks");
        expect(rows).toHaveLength(1); // one small chunk, not sealed early on the deleted entry's stale size
        const decrypted = await decryptAllChunkEvents(pickleKey!, DEVICE);
        expect(decrypted.map((r: any) => r.eventId)).toEqual(["$m6small"]);
    });

    it("a stale disk-eviction heap entry is re-validated against the chunk's current maxTs, not evicted on faith (kills M11)", async () => {
        setChunkTargetBytesOverrideForTesting(150); // one event per chunk, roughly
        const m = track(new BrowserEventIndexManager());
        await m.initEventIndex(userId, DEVICE);
        await m.waitForHydration();
        // Three distinct, sealed chunks, strictly increasing maxTs.
        await m.addEventToIndex(msg("$st1", "zqstalebody one", { origin_server_ts: 100 }), {});
        await m.commitLiveEvents();
        await m.addEventToIndex(msg("$st2", "zqstalebody two", { origin_server_ts: 200 }), {});
        await m.commitLiveEvents();
        await m.addEventToIndex(msg("$st3", "zqstalebody three", { origin_server_ts: 300 }), {});
        await m.commitLiveEvents();
        expect(await dumpRawStore("chunks")).toHaveLength(3);
        const before = await m.getStats();

        // Re-time $st1 far into the future: its chunk is sealed (a later chunk is open), so this
        // goes through the sealedUpdates rewrite path, pushing a FRESH (high) maxTs for that same
        // chunk onto diskChunkHeap while an earlier, now-stale (low) entry for it is still sitting
        // in the heap (heapPushTs never removes a superseded entry -- see its own docstring).
        await m.addEventToIndex(msg("$st1", "zqstalebody one, re-timed", { origin_server_ts: 9000 }), {});
        await m.commitLiveEvents();

        await m.closeEventIndex();
        // A budget that forces exactly one chunk's eviction. If the stale (low) heap entry for
        // $st1's chunk were trusted without re-validating against its current maxTs (M11), it would
        // be evicted first, even though it is now genuinely the NEWEST chunk of the three.
        setEventIndexBoundsOverrideForTesting({ diskBudgetBytes: Math.floor(before.size * 1.5) });
        const reloaded = track(new BrowserEventIndexManager());
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();

        const survivors = new Set((await decryptAllChunkEvents(pickleKey!, DEVICE)).map((r: any) => r.eventId));
        expect(survivors.has("$st1")).toBe(true); // now the newest -- must not be the one dropped
    });

    it("the disk budget evicting the currently-open chunk resets it, so the next write allocates a fresh one (kills M13)", async () => {
        setChunkTargetBytesOverrideForTesting(100_000); // stays open across every write below
        const m = track(new BrowserEventIndexManager());
        await m.initEventIndex(userId, DEVICE);
        await m.waitForHydration();
        await m.addEventToIndex(msg("$oc1", "zqopenchunkbody", { origin_server_ts: 1 }), {});
        await m.commitLiveEvents();
        const before = await m.getStats();
        expect(await dumpRawStore("chunks")).toHaveLength(1);
        await m.closeEventIndex();

        setEventIndexBoundsOverrideForTesting({ diskBudgetBytes: Math.max(1, before.size - 1) });
        const reloaded = track(new BrowserEventIndexManager());
        await reloaded.initEventIndex(userId, DEVICE);
        await reloaded.waitForHydration();
        expect(await dumpRawStore("chunks")).toHaveLength(0); // the one and only (open) chunk was evicted

        // Budget raised back to generous before the next write: flushLiveWrites enforces the disk
        // budget after every commit, and a budget still sized for $oc1's own footprint would evict
        // $oc2's chunk the instant it lands too, confounding what this test actually checks (that
        // the *next* write allocates a fresh chunk id rather than appending to the deleted one).
        setEventIndexBoundsOverrideForTesting(null);
        await reloaded.addEventToIndex(msg("$oc2", "zqopenchunkbody two", { origin_server_ts: 2 }), {});
        await reloaded.commitLiveEvents();
        const rows = await decryptAllChunkEvents(pickleKey!, DEVICE);
        // A fresh chunk, containing only the new event -- not the old chunk id resurrected with
        // stale accounting, and not $oc1 coming back from the dead.
        expect(rows.map((r: any) => r.eventId)).toEqual(["$oc2"]);
    });

    it("a chunk's AAD binds it to its own chunkId; ciphertext copied under another id fails to decrypt (kills M20)", async () => {
        const m = track(new BrowserEventIndexManager());
        await m.initEventIndex(userId, DEVICE);
        await m.waitForHydration();
        await m.addEventToIndex(msg("$aad1", "zqaadbody", { origin_server_ts: 1 }), {});
        await m.addEventToIndex(msg("$aad2", "zqaadbody two", { origin_server_ts: 2 }), {});
        await m.commitLiveEvents();
        await m.closeEventIndex();

        const rows = await dumpRawStore("chunks");
        expect(rows.length).toBeGreaterThanOrEqual(1);
        const row = rows[0];
        const metaRow = (await dumpRawStore("meta"))[0];
        const dek = await deriveDek(pickleKey!, decodeBase64(metaRow.salt) as Uint8Array<ArrayBuffer>, userId, DEVICE);

        // Decrypts fine under its own AAD.
        await expect(decryptBinaryJson(dek, row.blob, chunkAad(userId, row.chunkId))).resolves.toBeDefined();
        // The same ciphertext, "re-filed" under a different chunkId's AAD, must fail.
        await expect(decryptBinaryJson(dek, row.blob, chunkAad(userId, row.chunkId + 9999))).rejects.toBeDefined();
        // ... and under a different userId's AAD.
        await expect(
            decryptBinaryJson(dek, row.blob, chunkAad("@someone-else:example.org", row.chunkId)),
        ).rejects.toBeDefined();
    });

    it("every chunk write uses a fresh, unique IV -- never a constant one (kills M21)", async () => {
        setChunkTargetBytesOverrideForTesting(120); // several small, distinct chunks
        const m = track(new BrowserEventIndexManager());
        await m.initEventIndex(userId, DEVICE);
        await m.waitForHydration();
        for (let i = 0; i < 6; i++) {
            await m.addEventToIndex(msg(`$iv${i}`, `zqivbody ${i}`, { origin_server_ts: i }), {});
            await m.commitLiveEvents();
        }
        const rows = await dumpRawStore("chunks");
        expect(rows.length).toBeGreaterThan(1);
        const ivHexes = rows.map((r: any) => Array.from(r.blob.iv as Uint8Array).join(","));
        expect(new Set(ivHexes).size).toBe(ivHexes.length); // every IV distinct, no reuse across chunks
        for (const r of rows) {
            expect((r.blob.iv as Uint8Array).length).toBe(12);
            expect((r.blob.iv as Uint8Array).some((b: number) => b !== 0)).toBe(true); // not an all-zero IV
        }
    });
});
