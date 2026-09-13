/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * Browser EventIndex backend for Element Web. Implements {@link BaseEventIndexManager} so that the stock Search UX --
 * served on Desktop by Seshat, a native Rust/Tantivy index -- also works in the browser, where encrypted rooms cannot
 * be searched server side. This is not a port of Seshat: the query engine is a plain in-memory inverted index over
 * whitespace-ish tokens, and the durable state is a set of AES-GCM records in a dedicated IndexedDB database, decrypted
 * in full at startup.
 *
 * ## Threat model
 *
 * The DEK is derived with HKDF-SHA256 from the session pickle key, whose own ciphertext and wrapping key live in the
 * *same origin's* IndexedDB (`apps/web/src/utils/tokens/pickling.ts`). So an attacker who exfiltrates **only** the
 * `element-eventindex` database learns nothing about message content, only the metadata below; one with the **whole
 * browser profile** can re-derive the DEK and read everything, which is the assumption Element already makes for access
 * tokens; and it buys **nothing** against XSS in this origin, where script can ask the platform for the pickle key or
 * read the already-decrypted in-memory index.
 *
 * ### What is still cleartext on disk
 *
 * - `events`: the record key `[userId, eventId]` and the `byUser` index over `userId`. Note what a cleartext `eventId`
 *   implies, because it bounds the whole database: Matrix event ids are globally unique identifiers the server
 *   assigned, so the homeserver -- or any member of the room -- can map any of them straight back to its room. **The
 *   database as a whole therefore does disclose which rooms are indexed**, to exactly the class of attacker the
 *   checkpoint HMAC defends against.
 * - `checkpoints`: the `userId` column and its `byUser` index. The record key is an HMAC of the checkpoint tuple
 *   ({@link checkpointKey}), so no room id, token or direction is on disk in the clear. Given the point above, keying
 *   still buys two things: a room with a crawl checkpoint but no indexed events yet is not disclosed at all, and a
 *   guessed room id cannot be confirmed offline by hashing it. What it does disclose is **equality and count**.
 * - `meta`: `userId`, the HKDF `salt` and `userVersion`. The salt is not secret by construction.
 * - Shape: the number of records approximates the number of indexed events, and each ciphertext length the size of the
 *   event it holds.
 *
 * Every record is additionally bound by AAD to its own key, so an attacker with write access cannot re-file a record
 * under another user or event id and have it decrypt -- though that is no defence against deleting records or rolling
 * the database back. And all of this is strictly about data **at rest**: once {@link
 * BrowserEventIndexManager.initEventIndex} has run, every record it decrypts is held that way in memory for the rest
 * of the session -- which, since {@link BrowserEventIndexManager.hydrate} restores everything in the background
 * rather than all at once before `initEventIndex` returns, is initially nothing at all, growing to the whole index
 * over the following seconds as hydration proceeds.
 *
 * ### What a crash can lose
 *
 * Writes are batched, not one IndexedDB transaction per event: a crawler batch ({@link
 * BrowserEventIndexManager.addHistoricEvents}) writes as one transaction, and live events ({@link
 * BrowserEventIndexManager.addEventToIndex}) accumulate in {@link BrowserEventIndexManager.liveWriteBuffer} and flush
 * as one transaction at least every 5s or every 300 events, whichever comes first (see {@link
 * BrowserEventIndexManager.schedulePersistEvent}). A crash before a flush therefore loses, at most, one crawler batch
 * or a few seconds of live events -- never more, and never silently corrupting what *did* commit, each transaction
 * being all-or-nothing. This is acceptable because this index is a derived, best-effort search structure and never
 * the source of truth for a message's existence (the room's own timeline is, unaffected by any of this), and because
 * the crawler -- resuming from its last surviving checkpoint -- will walk back over exactly the gap a crash left and
 * re-index it with no user-visible difference from having written it the first time.
 */

import { logger } from "matrix-js-sdk/src/logger";
import {
    decodeBase64,
    encodeBase64,
    type IMatrixProfile,
    type IEventWithRoomId as IMatrixEvent,
    type IResultRoomEvents,
} from "matrix-js-sdk/src/matrix";
import sanitizeHtml from "sanitize-html";

import BaseEventIndexManager, {
    type ICrawlerCheckpoint,
    type IEventAndProfile,
    type IIndexStats,
    type ISearchArgs,
    type ILoadArgs,
} from "../../indexing/BaseEventIndexManager";
import PlatformPeg from "../../PlatformPeg";
import SettingsStore from "../../settings/SettingsStore";

const log = logger.getChild("BrowserEventIndex");

/**
 * Name of the IndexedDB database holding the index. Deliberately its own database, neither the rust crypto store nor
 * `matrix-react-sdk` (which holds the pickle key), so that {@link deleteDisabledEventIndexDb} and {@link
 * BrowserEventIndexManager.deleteEventIndex} can drop it without risking unrelated data.
 */
const EVENTINDEX_DB_NAME = "element-eventindex";
/**
 * v2 closed three metadata leaks at once: the unread plaintext `roomId`/`ts`/`hasFile` columns and `byUserRoom` index
 * on `events`, the unread `deviceId` column on `meta`, and the `checkpoints` primary key, which was the cleartext tuple
 * and is now an HMAC of it. See {@link migrateV1ToV2}, which resets the index rather than converting it.
 */
const EVENTINDEX_DB_VERSION = 2;

/**
 * HKDF `info` prefix for the data encryption key, domain-separating it from anything else derivable from the same
 * pickle key; the user and device ids are appended per derivation ({@link deriveDek}). The trailing `v1` versions the
 * *derivation*, not the schema, so changing it makes every existing record undecryptable -- which {@link
 * BrowserEventIndexManager.initEventIndex} handles by wiping and re-crawling.
 */
const EVENTINDEX_HKDF_INFO = "element-eventindex-v1";

/**
 * HKDF `info` prefix for the subkey that names checkpoint records ({@link deriveCheckpointMacKey}). Deliberately
 * different from {@link EVENTINDEX_HKDF_INFO}: the key that names records must never be the key that encrypts them, and
 * HKDF gives independent outputs only for distinct `info`. The two differ before their first `|`, so no user or device
 * id can make them collide.
 */
const EVENTINDEX_CPMAC_HKDF_INFO = "element-eventindex-cpmac-v1";

/**
 * One indexed event, in memory and inside the ciphertext of an {@link EventRecord}. Everything the search path needs is
 * precomputed here, because a query must not re-parse event content on every keystroke.
 */
interface StoredEvent {
    /**
     * The event as handed back in search results (through {@link resultEvent}, which copies it). For an edited message
     * this carries the replacement content under the original's envelope once both have been seen, and `event_id` is
     * always the original's; see {@link effectiveEventForIndex}.
     */
    event: IMatrixEvent;
    /** Sender display name and avatar as of the time the event was seen, for rendering results without a room. */
    profile: IMatrixProfile;
    /** Denormalised `event.room_id`, used by the room filter and by {@link BrowserEventIndexManager.contextFor}. */
    roomId: string;
    /** The id this record is filed under: always the *original* event's id, never an edit's. */
    eventId: string;
    /** Denormalised `event.origin_server_ts`, defaulting to 0. Drives recency ordering. */
    originServerTs: number;
    /** The concatenated searchable text extracted by {@link extractSearchText}; the input to tokenisation. */
    searchText: string;
    /** Whether this event carries an `mxc://` attachment, so {@link BrowserEventIndexManager.loadFileEvents} can answer without re-inspecting content. */
    hasFile: boolean;
    /** True once an m.replace has been applied. Later originals must not revert the body. */
    edited: boolean;
    /**
     * Ids of the m.replace events whose content was folded into this record. A redaction names the edit's own id, so
     * this is what maps it back to the record to remove.
     */
    editIds?: string[];
}

/**
 * An AES-GCM ciphertext as stored in IndexedDB. Both halves are base64 rather than the `Uint8Array`s the crypto API
 * deals in, which buys nothing at rest but keeps the stored record plain JSON, comparable and assertable in tests
 * without caring how an engine round-trips buffers.
 */
interface EncryptedBlob {
    /** Base64 of the 12-byte random IV used for this one encryption. */
    iv: string;
    /** Base64 of the ciphertext, GCM tag included. */
    ct: string;
}

/**
 * The single per-user bookkeeping row, in the `meta` store. Entirely cleartext, and must stay that way: {@link
 * BrowserEventIndexManager.initEventIndex} has to read the salt *before* it can derive the key that would decrypt
 * anything.
 */
interface MetaRecord {
    /** Owning user, and the record key. */
    userId: string;
    /** Base64 of the 32-byte HKDF salt. Not secret; its job is to make the derivation unique per index, not to hide anything. */
    salt: string;
    /** Schema version owned by the caller (EventIndex), not by this file. See {@link BrowserEventIndexManager.setUserVersion}. */
    userVersion: number;
}

/**
 * A stored event. `userId` and `eventId` are the record key, and `eventId` is bound into the AAD, so they are
 * necessarily cleartext; everything else lives in `blob` and must never be duplicated out here.
 */
interface EventRecord {
    userId: string;
    eventId: string;
    blob: EncryptedBlob;
}

/**
 * A crawler checkpoint at rest. `id` is {@link checkpointKey}: the primary key and part of the AAD, disclosing no room
 * id, token or direction. Its determinism is what lets {@link BrowserEventIndexManager.removeCrawlerCheckpoint} address
 * a record, and is also the residual equality/count leak in the threat model above.
 */
interface CheckpointRecord {
    id: string;
    userId: string;
    blob: EncryptedBlob;
}

/**
 * Normalise text for matching: lowercase, NFKD-decompose, drop combining marks, so `cafe` and its accented and
 * full-width spellings fold together. Applied both when indexing (via {@link tokenize}) and when querying -- the only
 * reason a stored term and a typed term can compare equal -- so it must stay a pure function of its input.
 */
function foldText(text: string): string {
    return text
        .toLocaleLowerCase()
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "");
}

/**
 * Split text into the terms this index stores and queries: fold it ({@link foldText}), then break on every run of
 * characters that is not a letter, a number or an underscore, which keeps punctuation, markdown syntax and URL
 * separators off the words around them. Deliberately language-unaware, so a query in a script that does not separate
 * words collapses to one long token matching nothing -- one of the cases {@link BrowserEventIndexManager.substringHits}
 * exists to catch.
 *
 * @knipignore - exported for tests
 */
export function tokenize(text: string): string[] {
    if (!text) return [];
    return foldText(text)
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((t) => t.length > 0);
}

/**
 * The id of the event that `ev` edits, or `null` if it is not an edit or the relation is malformed. This index files an
 * edit under the *original* message's id ({@link effectiveEventForIndex}), so nearly every write path begins by asking
 * this.
 * @knipignore - exported for tests
 */
export function replacedEventId(ev: IMatrixEvent): string | null {
    const rel = ev.content?.["m.relates_to"];
    if (rel && rel.rel_type === "m.replace" && typeof rel.event_id === "string" && rel.event_id.length > 0) {
        return rel.event_id;
    }
    return null;
}

/**
 * Strip the markup from an event's `formatted_body` (untrusted HTML) down to its text, for indexing. The result is only
 * ever tokenised; it is not safe to render, and nothing renders it. `sanitize-html` drops tags without leaving anything
 * in their place, so `<p>foo</p><p>bar</p>` would run together into the bogus token `foobar`. A separator is supplied
 * by putting a space before every `<` in the *input*, which cannot change how the markup parses: inside a quoted
 * attribute value it is one more character of a discarded value, and everywhere else `<` already begins a tag or is
 * already text. Doing it through `textFilter` looks equivalent and is not -- the parser emits a decoded entity as its
 * own text node, so a space landed mid-word (`AT&amp;T` became `AT & T`). The sanitiser re-escapes what it emits, so
 * its three entities are decoded again in a single pass.
 */
function stripHtml(s: string): string {
    const stripped = sanitizeHtml(s.replace(/</g, " <"), { allowedTags: [] });
    return stripped.replace(/&(lt|gt|amp);/g, (_match, entity) =>
        entity === "lt" ? "<" : entity === "gt" ? ">" : "&",
    );
}

/**
 * Walk a piece of event content and collect every human-readable string it contains into `into`. Recursive because
 * extensible-event content nests, and both stable `m.*` and unstable `org.matrix.msc1767.*` names are read. Anything
 * that is not a string or object is ignored rather than stringified, so structural data and identifiers cannot leak
 * into the search text.
 */
function collectText(value: unknown, into: string[]): void {
    if (typeof value === "string") {
        if (value.length > 0) into.push(value);
        return;
    }
    if (!value || typeof value !== "object") return;
    const o = value as Record<string, unknown>;
    if (typeof o.body === "string") into.push(o.body);
    if (typeof o.filename === "string") into.push(o.filename);
    if (typeof o.formatted_body === "string") into.push(stripHtml(o.formatted_body));
    if (o["m.caption"] !== undefined) collectText(o["m.caption"], into);
    if (o["org.matrix.msc1767.caption"] !== undefined) collectText(o["org.matrix.msc1767.caption"], into);
    const markup = o["m.markup"] ?? o["org.matrix.msc1767.markup"];
    if (Array.isArray(markup)) {
        for (const part of markup) collectText(part, into);
    }
}

/**
 * Everything in an event a user could plausibly search for, concatenated into {@link StoredEvent.searchText} once on
 * the way in, because a query runs against every indexed event. `m.room.name` and `m.room.topic` are special-cased to
 * their one meaningful field, their content having no `body`; `m.new_content` is collected *in addition to* the
 * top-level content, so a malformed edit still contributes its fallback body.
 *
 * @returns The strings joined by single spaces, or `""` when there is no text at all -- which tokenises to no terms, so
 *     such an event is still returned as search *context* but never matches a term query.
 * @knipignore - exported for tests
 */
export function extractSearchText(ev: IMatrixEvent): string {
    const type = ev.type;
    if (type === "m.room.name") return typeof ev.content?.name === "string" ? ev.content.name : "";
    if (type === "m.room.topic") return typeof ev.content?.topic === "string" ? ev.content.topic : "";
    const parts: string[] = [];
    collectText(ev.content, parts);
    const neu = ev.content?.["m.new_content"];
    if (neu) collectText(neu, parts);
    return parts.filter((p) => p.length > 0).join(" ");
}

/**
 * Whether an event carries an attachment: an `mxc://` URL at `content.url` or `content.file.url`. Denormalised into
 * {@link StoredEvent.hasFile} so the file panel need not re-inspect content per event. The scheme is checked rather
 * than mere presence, so an `http://` value planted by a hostile sender cannot masquerade as an attachment.
 * @knipignore - exported for tests
 */
export function eventHasFile(ev: IMatrixEvent): boolean {
    const url = ev.content?.url ?? ev.content?.file?.url;
    return typeof url === "string" && url.startsWith("mxc://");
}

/**
 * The event as it should be indexed: for an edit, the replacement content re-attached to the *original* event's id; for
 * anything else, `ev` itself. Filing an edit under its own id would mean a search for text the user can see returns an
 * event no timeline renders and no permalink resolves. `m.new_content` is preferred, falling back to the edit's own
 * content; `m.relates_to` is dropped from the copy, or the stored event would look like an edit to every later reader.
 *
 * @returns For a non-edit, `ev` by reference, so callers must not mutate it. For an edit, a new object carrying the
 *     *edit's* envelope and the original's `event_id` -- which is why a record indexed edit-first holds the edit's
 *     timestamp until the original arrives.
 * @knipignore - exported for tests
 */
export function effectiveEventForIndex(ev: IMatrixEvent): IMatrixEvent {
    const origId = replacedEventId(ev);
    if (!origId) return ev;
    const newContent = ev.content?.["m.new_content"];
    const content = newContent && typeof newContent === "object" ? { ...newContent } : { ...ev.content };
    delete (content as Record<string, unknown>)["m.relates_to"];
    return {
        ...ev,
        event_id: origId,
        content,
    };
}

/**
 * Whether this browser can run the index at all: WebCrypto for the key derivation and AES-GCM, IndexedDB for the
 * records and for the pickle key upstream. Checked before the labs flag, so an unsupported browser reports the feature
 * unavailable rather than failing later. Presence is not permission, though: IndexedDB can still refuse to open, which
 * {@link BrowserEventIndexManager.initEventIndex} handles by falling back to memory-only.
 *
 * @knipignore - exported for tests
 */
export function isWebEventIndexSupported(): boolean {
    return typeof crypto !== "undefined" && !!crypto.subtle && typeof indexedDB !== "undefined";
}

/**
 * The single gate on the whole feature: platform support *and* the `feature_web_event_index` labs flag, which defaults
 * to off. Declared with `LEVELS_DEVICE_ONLY_SETTINGS_WITH_CONFIG_PRIORITISED` (`apps/web/src/settings/Settings.tsx`),
 * so a deployment can turn it on from `config.json` and it is otherwise a per-device choice. It runs once per live
 * event through {@link BrowserEventIndexManager.featureEnabled}, so it must stay cheap and must never throw: a settings
 * read that fails is treated as "off".
 */
export function isBrowserEventIndexEnabled(): boolean {
    if (!isWebEventIndexSupported()) return false;
    try {
        return Boolean(SettingsStore.getValue("feature_web_event_index"));
    } catch {
        return false;
    }
}

/**
 * Derive the AES-GCM data encryption key protecting one user's index on one device: HKDF-SHA256 over the session pickle
 * key, salted with the per-index {@link MetaRecord.salt} and domain-separated by an `info` of
 * `${EVENTINDEX_HKDF_INFO}|${userId}|${deviceId}`. Binding both ids means a second account, or the same account on a
 * second device, derives an unrelated key from the same root. **Why the base64 *string* is hashed, not the bytes it
 * encodes.** `pickleKey` is fed to HKDF as its ASCII characters, deliberately not decoded first, and this is safe: it
 * is `encodeUnpaddedBase64` of 32 bytes from `crypto.getRandomValues` (`createPickleKey` in
 * `apps/web/src/BasePlatform.ts`), base64 is injective, so those 43 characters carry all 256 bits of entropy, and
 * HKDF-Extract accepts keying material of any length and encoding. Decoding first would be equally sound but would
 * derive a *different* key, orphaning every record already written. `ikm` is zeroed once WebCrypto has copied it --
 * best effort only, `pickleKey` being a JavaScript string whose immutable copy of the secret remains on the heap.
 *
 * @param deviceId - Mixed into `info`, so a re-login under a new device id orphans the old records; {@link
 *     BrowserEventIndexManager.initEventIndex} then wipes and re-crawls, which is the intended outcome.
 */
export async function deriveDek(
    pickleKey: string,
    salt: Uint8Array<ArrayBuffer>,
    userId: string,
    deviceId: string,
): Promise<CryptoKey> {
    const ikm = new TextEncoder().encode(pickleKey);
    const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
    ikm.fill(0);
    const info = new TextEncoder().encode(`${EVENTINDEX_HKDF_INFO}|${userId}|${deviceId}`);
    return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info },
        baseKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
}

/**
 * Derive the HMAC-SHA256 subkey that names checkpoint records. Same HKDF root, salt and per-user/per-device binding as
 * {@link deriveDek} -- including the point about `pickleKey` being hashed as base64 text -- but a different `info` and
 * algorithm, so this key is independent of the DEK and can only sign.
 * @knipignore - exported for tests
 */
export async function deriveCheckpointMacKey(
    pickleKey: string,
    salt: Uint8Array<ArrayBuffer>,
    userId: string,
    deviceId: string,
): Promise<CryptoKey> {
    const ikm = new TextEncoder().encode(pickleKey);
    const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
    ikm.fill(0);
    const info = new TextEncoder().encode(`${EVENTINDEX_CPMAC_HKDF_INFO}|${userId}|${deviceId}`);
    return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info },
        baseKey,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
    );
}

/**
 * Serialise a value and encrypt it as AES-GCM, ready to store as an {@link EncryptedBlob}. A fresh 12-byte IV from the
 * CSPRNG on every call. 96 bits is the length GCM is specified around, so it is used directly as the counter block
 * without the extra GHASH pass any other length needs. Random rather than a counter because there is no durable place
 * to keep a counter that a wiped, restored or rolled-back database could not silently reset -- and a repeated IV under
 * one key is catastrophic for GCM, whereas the birthday bound on random 96-bit IVs (NIST SP 800-38D, 2^32 invocations
 * per key) is not remotely approached when one invocation is one record write. `pt.fill(0)` afterwards is hygiene, not
 * a guarantee.
 *
 * @param aad - The record's own primary key: `${userId}|${eventId}` for events, {@link checkpointAad} for checkpoints.
 *     Authenticated but not encrypted, and {@link decryptJson} must be given the identical string. This is what stops
 *     an attacker with write access from re-filing a record under another user or event id.
 */
export async function encryptJson(dek: CryptoKey, value: unknown, aad: string): Promise<EncryptedBlob> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode(JSON.stringify(value));
    const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
        dek,
        pt,
    );
    pt.fill(0);
    return { iv: encodeBase64(iv), ct: encodeBase64(new Uint8Array(ct)) };
}

/**
 * Open a blob written by {@link encryptJson} and parse it back. Nothing is zeroed here, deliberately: the plaintext
 * becomes an object graph this index keeps in memory on purpose. `aad` must be the identical string the record was
 * written with -- a mismatch is indistinguishable from corruption or tampering, and callers treat that as "this index
 * cannot be read".
 *
 * @knipignore - exported for tests
 */
export async function decryptJson<T>(dek: CryptoKey, blob: EncryptedBlob, aad: string): Promise<T> {
    const iv = decodeBase64(blob.iv);
    const ct = decodeBase64(blob.ct);
    const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
        dek,
        ct,
    );
    const text = new TextDecoder().decode(pt);
    return JSON.parse(text) as T;
}

/**
 * The tuple identifying a checkpoint, canonically and injectively encoded. Never reaches disk: it is the in-memory
 * identity used to de-duplicate and to find the entry to drop, and the message {@link checkpointKey} authenticates.
 * JSON rather than `|`-joining, which is not injective. `fullCrawl` is excluded, matching the v1 key, because the
 * crawler flips that flag on a checkpoint it means to replace in place.
 */
function checkpointIdentity(userId: string, cp: ICrawlerCheckpoint): string {
    return JSON.stringify([userId, cp.roomId, cp.token, cp.direction]);
}

/**
 * The primary key of a checkpoint record: base64 of HMAC-SHA256 over {@link checkpointIdentity}, under the sign-only
 * subkey from {@link deriveCheckpointMacKey} -- never the DEK. Keyed rather than a plain digest because room ids are
 * guessable, so `SHA-256("!room:example.org")` would be as good as cleartext. Deterministic, so a checkpoint handed to
 * {@link BrowserEventIndexManager.removeCrawlerCheckpoint} addresses exactly the record that was written.
 */
async function checkpointKey(macKey: CryptoKey, identity: string): Promise<string> {
    const mac = await crypto.subtle.sign("HMAC", macKey, new TextEncoder().encode(identity));
    return encodeBase64(new Uint8Array(mac));
}

/**
 * The AAD for a checkpoint record, binding its ciphertext to the user and to its own primary key. The `|cp|` keeps this
 * namespace disjoint from the `${userId}|${eventId}` form used for events, and binding the *hashed* key rather than the
 * cleartext tuple is what let the binding survive the v1 to v2 re-keying.
 */
function checkpointAad(userId: string, id: string): string {
    return `${userId}|cp|${id}`;
}

/**
 * The one and only upgrade path, v1 to v2, closing three leaks in one bump because v1 has never existed anywhere but
 * the branch introducing this file: the unread cleartext `roomId`/`ts`/`hasFile` columns and `byUserRoom` index on
 * `events`, the unread `deviceId` column on `meta`, and the `checkpoints` primary key, which was
 * `${userId}|${roomId}|${token}|${direction}` and so disclosed every room the crawler had a position for. Those keys
 * cannot be *converted* here: `onupgradeneeded` runs inside the `versionchange` transaction, long before any key
 * material exists, so the new HMAC cannot be computed yet. The `events` store is cleared with them, and that is the
 * point rather than collateral damage: `EventIndex` seeds fresh checkpoints **only** when {@link
 * BrowserEventIndexManager.isEventIndexEmpty} says the index is empty, so dropping checkpoints while keeping events
 * would leave an index that is not empty and has nowhere to resume from -- back-fill would stop for good, silently,
 * while the crawl-progress UI showed nothing outstanding. `meta` is kept, minus `deviceId`, because the salt is what
 * lets the next DEK match anything written after the upgrade. The accepted cost is one full re-crawl.
 */
function migrateV1ToV2(tx: IDBTransaction): void {
    const events = tx.objectStore("events");
    if (events.indexNames.contains("byUserRoom")) events.deleteIndex("byUserRoom");
    events.clear();
    tx.objectStore("checkpoints").clear();
    stripMetaDeviceId(tx.objectStore("meta"));
}

/**
 * Rewrite every `meta` record without v1's unread `deviceId` column. Cursor-driven rather than getAll/put so it stays
 * inside the `versionchange` transaction, which lives only as long as requests keep being issued against it.
 */
function stripMetaDeviceId(meta: IDBObjectStore): void {
    const cursorReq = meta.openCursor();
    cursorReq.onsuccess = (): void => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const rec = cursor.value as MetaRecord;
        cursor.update({ userId: rec.userId, salt: rec.salt, userVersion: rec.userVersion });
        cursor.continue();
    };
}

/**
 * Open the index database, creating or upgrading its schema as needed. Three stores: `meta`, keyed by `userId`, holding
 * the one cleartext row per user (the salt, readable *before* any key exists); `events`, keyed by the compound
 * `[userId, eventId]` so a single record is addressable for update and delete; and `checkpoints`, keyed by the opaque
 * {@link checkpointKey}. Both record stores carry a `byUser` index, the only way one user's rows can be enumerated
 * without scanning everything.
 *
 * @returns The open connection, with an `onversionchange` handler installed. Rejects when there is no `indexedDB`, when
 *     the open fails, and when the upgrade is *blocked* by an older connection in another tab -- which must reject
 *     rather than wait, since `EventIndexPeg.init()` is awaited on the path that starts the Matrix client and a pending
 *     promise there is an application that never finishes loading.
 */
function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const factory = globalThis.indexedDB;
        if (!factory) {
            reject(new Error("IndexedDB not available"));
            return;
        }
        const req = factory.open(EVENTINDEX_DB_NAME, EVENTINDEX_DB_VERSION);
        // An older connection holds the previous version open and blocks this upgrade for as long as its tab lives.
        // Reject instead of waiting: an unsettled promise here hangs the whole application.
        let abandoned = false;
        req.onblocked = (): void => {
            abandoned = true;
            reject(new Error("idb open blocked by an older connection"));
        };
        req.onerror = (): void => reject(req.error ?? new Error("idb open failed"));
        req.onsuccess = (): void => {
            const db = req.result;
            // Release the database when something else wants to delete or upgrade it, rather than blocking that
            // forever; without this a stale handle can survive a logout.
            db.onversionchange = (): void => db.close();
            // The blocking connection closed after all and the open went through, but nobody is waiting for this one
            // any more. Close it rather than leaking a handle that would block deleting the database.
            if (abandoned) {
                db.close();
                return;
            }
            resolve(db);
        };
        req.onupgradeneeded = (event: IDBVersionChangeEvent): void => {
            const db = req.result;
            if (!db.objectStoreNames.contains("meta")) {
                db.createObjectStore("meta", { keyPath: "userId" });
            }
            if (!db.objectStoreNames.contains("events")) {
                const events = db.createObjectStore("events", { keyPath: ["userId", "eventId"] });
                events.createIndex("byUser", "userId", { unique: false });
            }
            if (!db.objectStoreNames.contains("checkpoints")) {
                const cps = db.createObjectStore("checkpoints", { keyPath: "id" });
                cps.createIndex("byUser", "userId", { unique: false });
            }
            if (event.oldVersion > 0 && event.oldVersion < 2 && req.transaction) {
                migrateV1ToV2(req.transaction);
            }
        };
    });
}

/**
 * Promisify a single IndexedDB request. It settles when the *request* succeeds, not when its transaction commits, which
 * is why every write path awaits {@link txDone} instead, and why callers must not await anything but further IndexedDB
 * work between requests on one transaction.
 */
function idbReq<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = (): void => resolve(req.result);
        req.onerror = (): void => reject(req.error ?? new Error("idb request failed"));
    });
}

/**
 * Rows read per IndexedDB page during hydration ({@link BrowserEventIndexManager.hydrate}), each
 * fetched by one `getAll()` call in its own read-only transaction. Sized to keep that one call --
 * IndexedDB read plus structured-clone deserialisation, which can land in a single main-thread task
 * -- comfortably under the 50 ms long-task ceiling: measured at ~20 µs/event for `getAll` on this
 * schema at 200k rows (`research/measurements-v1.md` §3.2), so 1,000 rows is ~20 ms, leaving margin
 * for slower hardware. Revisit alongside a future chunked schema, which changes what a page reads.
 *
 * @knipignore - exported so a test can seed more than one page's worth of rows without waiting on
 *     a production-sized restore; the multi-page resume branch in {@link userEventKeyRange} is
 *     otherwise never exercised by any fixture small enough to run quickly.
 */
export const HYDRATION_PAGE_SIZE = 1000;

/**
 * How long one hydration slice may run before {@link yieldToEventLoop} hands control back to the
 * event loop; see SYNTHESIS.md §3.4/§3.7 (`SLICE_DEADLINE_MS`). Comfortably under the 50 ms
 * long-task threshold that {@link BrowserEventIndexManager.hydrate} must never exceed.
 */
const HYDRATION_SLICE_DEADLINE_MS = 30;

/**
 * Traversal order for {@link BrowserEventIndexManager.hydrate}'s paged reads over the *current*
 * (v2, unchunked) schema: ascending primary key, i.e. ascending `eventId` for one user, which is
 * what `IDBObjectStore.getAll()` over a key range returns for free, one page-sized read at a time.
 *
 * This is **not** recency order, and deliberately does not pretend to be. Matrix event ids are
 * opaque, server-assigned strings with no guaranteed relationship to `origin_server_ts`, and schema
 * v2 keeps no plaintext timestamp column to sort by at all -- it was removed as metadata leakage
 * (see the class threat model). Genuine newest-first hydration needs a schema whose on-disk key
 * already reflects recency; reversing this constant would not get there, because without such a
 * key, "the last N rows by key" can only be read by stepping a cursor one row at a time, which
 * reintroduces exactly the per-record-transaction cost this file's write path already had to be
 * fixed to avoid. It is kept as its own named constant, rather than inlined into {@link
 * userEventKeyRange}, so that the day a recency-ordered key exists -- a chunked schema keyed by
 * `maxTs`, per SYNTHESIS.md §3.4/§3.6 -- this is the one line that changes.
 */
const HYDRATION_KEY_ORDER = "ascending" as const;

/**
 * How long a live write may sit in {@link BrowserEventIndexManager.liveWriteBuffer} before {@link
 * BrowserEventIndexManager.flushLiveWriteBufferNow} is called automatically; see {@link
 * BrowserEventIndexManager.schedulePersistEvent}. This is also the upper bound on how much *live*
 * (not crawler-batch) content a crash can lose that was not already lost before this increment --
 * see the durability note on {@link BrowserEventIndexManager.schedulePersistEvent}.
 */
const LIVE_WRITE_FLUSH_INTERVAL_MS = 5000;

/**
 * Live writes accumulated past this count trigger an immediate flush rather than waiting for
 * {@link LIVE_WRITE_FLUSH_INTERVAL_MS}, so a burst of live events (a fast-scrolling backfill of the
 * live timeline, not the crawler) cannot grow the buffer unboundedly between timer firings. Chosen
 * from `research/browser-limits-model.md` §4.2's measured transaction-size sweet spot of 200-500
 * records per IndexedDB transaction (fable, Chromium 149: 0.65ms/event at 1/tx, 0.43ms/event at
 * 100/tx); 300 sits inside that band.
 */
const LIVE_WRITE_BUFFER_MAX = 300;

/**
 * Current time in milliseconds, monotonic where available. A one-line wrapper purely so every
 * hydration timing call site reads the same way; `performance` is present in every environment this
 * file runs in (every real browser, and happy-dom in the unit tests), so there is no fallback to
 * maintain.
 */
function now(): number {
    return performance.now();
}

/**
 * The primary-key range covering one user's rows in the `events` store, optionally resuming after a
 * specific `eventId`; see {@link HYDRATION_KEY_ORDER}. Built on an IndexedDB rule worth spelling
 * out: array keys compare element by element, and where one array is a prefix of the other the
 * *shorter* one sorts first. So `[userId]` (length 1) sorts before every `[userId, eventId]` (length
 * 2) whatever `eventId` is, and appending any single character to `userId` -- a plain space is used
 * below, nothing about the choice matters -- makes an array holding only that longer string sort
 * after every `[userId, eventId]`, for the same reason: the comparison is decided at element 0 (the
 * bare `userId` is a proper prefix of, and so sorts before, `userId` plus anything appended to it)
 * before `eventId` is ever considered, so both bounds hold for literally *any* `eventId` string --
 * unlike a fixed sentinel character, which some real event id could in principle sort after.
 *
 * @param afterEventId - When given, the range starts strictly after this id, to resume a paged read;
 *     the row at this id itself is excluded, on the assumption the caller already has it.
 */
function userEventKeyRange(userId: string, afterEventId?: string): IDBKeyRange {
    const lower = afterEventId !== undefined ? [userId, afterEventId] : [userId];
    const upper = [userId + " "];
    return IDBKeyRange.bound(lower, upper, afterEventId !== undefined, true);
}

/**
 * Yield to the event loop between hydration slices ({@link BrowserEventIndexManager.hydrate}).
 * Prefers `scheduler.yield()` (Chrome 129+), which resumes at the browser's next opportunity,
 * because a plain timer is subject to HTML's nested-timer clamp; falls back to `setTimeout(0)` --
 * Safari, older Chrome, and every environment these unit tests run in all lack `scheduler.yield`.
 */
async function yieldToEventLoop(): Promise<void> {
    const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (sched?.yield) {
        await sched.yield();
        return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * The bytes a base64 ciphertext stands for on disk. One function produces every number feeding {@link
 * BrowserEventIndexManager.ciphertextBytes}, so the total and its parts cannot disagree about how a record is measured.
 */
function ciphertextByteLength(ct: string): number {
    return Math.ceil((ct.length * 3) / 4);
}

/**
 * Drop the entire index database, for every user of this origin. Used only where per-user deletion cannot work or has
 * already failed; callers must close their own connection first, since an open handle blocks the delete. Rejects on
 * failure and -- importantly -- when the delete is merely *blocked*: resolving would tell the caller the ciphertext was
 * wiped while it is still on disk.
 */
function deleteDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
        const factory = globalThis.indexedDB;
        if (!factory) {
            resolve();
            return;
        }
        const req = factory.deleteDatabase(EVENTINDEX_DB_NAME);
        req.onsuccess = (): void => resolve();
        req.onerror = (): void => reject(req.error ?? new Error("idb deleteDatabase failed"));
        // A blocked delete has *not* happened: report it rather than claiming success, so callers can close their own
        // handle and retry.
        req.onblocked = (): void => reject(new Error("idb deleteDatabase blocked by an open connection"));
    });
}

/**
 * Best-effort removal of an index database left behind by a user who turned the labs flag off: nothing else would ever
 * delete it. Does nothing when the setting cannot be read, when the feature is on, or when there is no IndexedDB, and
 * never throws. Called from `WebPlatform` on the path where the gate is off, the only path where no manager exists and
 * so nothing can race the delete.
 */
export async function deleteDisabledEventIndexDb(): Promise<void> {
    if (typeof globalThis.indexedDB === "undefined") return;
    let enabled: boolean;
    try {
        enabled = Boolean(SettingsStore.getValue("feature_web_event_index"));
    } catch {
        return;
    }
    if (enabled) return;
    try {
        await deleteDatabase();
    } catch (e) {
        log.debug("EventIndex: could not drop the database of the disabled index", e);
    }
}

/**
 * The browser implementation of {@link BaseEventIndexManager}, one instance per `WebPlatform`, created lazily and only
 * while the labs gate is on. The **in-memory** state is the index: every query and every mutation is answered from it,
 * synchronously. The **IndexedDB** records are a write-behind encrypted copy whose only job is to make the next session
 * start warm, so everything keeps working for this session when persistence is unavailable or fails.
 */
export class BrowserEventIndexManager extends BaseEventIndexManager {
    /** The user this index belongs to, or null before {@link initEventIndex} / after teardown. */
    private userId: string | null = null;
    /**
     * The AES-GCM key protecting every record, from {@link deriveDek}. Null when no index is open; its presence is also
     * the "we have key material" test the persistence paths guard on.
     */
    private dek: CryptoKey | null = null;
    /**
     * HMAC subkey naming checkpoint records, see {@link checkpointKey}. Held separately from {@link
     * BrowserEventIndexManager.dek} precisely so the naming key is never the encryption key; both die with {@link
     * dropKey}.
     */
    private cpMacKey: CryptoKey | null = null;
    /**
     * Whether records should be written to disk at all. False when there is no pickle key to derive a stable DEK from,
     * when IndexedDB could not be opened, and during teardown. The index is fully functional for the session either
     * way; only the warm start is lost.
     */
    private persistEnabled = false;
    /**
     * True before the first {@link initEventIndex} and after teardown. The mutating entry points return early while it
     * is set, so a late callback from the crawler cannot repopulate an index that has just been torn down.
     */
    private closed = true;

    /** The index proper: record id (always an original event's id) -> the stored event. */
    private readonly events = new Map<string, StoredEvent>();
    /** m.replace event id -> id of the record its content was folded into. */
    private readonly editTargets = new Map<string, string>();
    /**
     * The inverted index: term -> ids of the records whose {@link StoredEvent.searchText} contains it. Maintained only
     * by {@link indexTokens} / {@link unindexTokens}, and pruned when a term's set empties.
     */
    private readonly inverted = new Map<string, Set<string>>();
    /**
     * Room id -> that room's record ids, ordered by `origin_server_ts` ascending. The ordering is an invariant,
     * maintained by {@link insertRoomOrder} and repaired by {@link reindexRoomOrder}; {@link contextFor} and {@link
     * loadFileEvents} depend on it.
     */
    private readonly roomOrder = new Map<string, string[]>();
    /** Outstanding crawler positions, cleartext in memory and mirrored encrypted to disk. */
    private checkpoints: ICrawlerCheckpoint[] = [];
    /** Schema version owned by `EventIndex`, round-tripped through the `meta` record. */
    private userVersion = 0;
    /**
     * Running total of ciphertext bytes, reported as {@link getStats} `size`. Kept equal to the sum of {@link
     * recordBytes} rather than accumulated: a rewrite replaces a record's contribution instead of adding a second one.
     */
    private ciphertextBytes = 0;
    /**
     * Memo of {@link foldText} over each record's {@link StoredEvent.searchText}, for the substring fallback; see
     * {@link foldedFor}. Purely derived, never persisted, and validated against the text it was computed from rather
     * than invalidated by hand.
     */
    private readonly foldedSearchText = new Map<string, { src: string; folded: string }>();
    /**
     * Ciphertext size of each event record *as it currently sits on disk*, which is what makes {@link ciphertextBytes}
     * a sum rather than a tally of everything ever written. Maintained only from inside the persistence chain, since a
     * record's size is not known until it has been encrypted, so it is empty in a memory-only session where {@link
     * getStats} falls back to {@link estimatePlainSize}.
     */
    private readonly recordBytes = new Map<string, number>();
    /**
     * Record ids whose current in-memory state has not yet been written to disk, for live writes; see {@link
     * schedulePersistEvent}. Never holds a crawler-batch id: {@link addHistoricEvents} writes its whole batch as one
     * transaction immediately rather than buffering it, so this exists only to coalesce *live* writes -- one
     * `addEventToIndex` call at a time -- into fewer transactions than one per call.
     */
    private readonly liveWriteBuffer = new Set<string>();
    /**
     * The pending {@link LIVE_WRITE_FLUSH_INTERVAL_MS} timer that will call {@link flushLiveWriteBufferNow}, or null
     * when {@link liveWriteBuffer} is empty or a flush has already been triggered by size. Armed once, by the first
     * write into an empty buffer, and not rearmed by later writes before it fires -- see {@link schedulePersistEvent}
     * for why that is what makes "at most every 5s" bound the buffer's *oldest* entry rather than debounce forever
     * under sustained writes.
     */
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * The tail of the serialised persistence chain; see {@link enqueuePersist}. Awaiting it means "every write
     * scheduled so far has been attempted", which is what {@link commitLiveEvents} and the teardown paths do.
     */
    private persistChain: Promise<void> = Promise.resolve();
    /** The open IndexedDB connection, or null when memory-only or closed. */
    private db: IDBDatabase | null = null;

    /**
     * True from the top of {@link initEventIndex} -- before key derivation, before it is known whether there is
     * even anything to restore -- until either a hydration run finishes (successfully, aborted by teardown, or by
     * wiping a corrupt index) or `initEventIndex` determines there is nothing to hydrate and clears this itself.
     * Set this early, rather than only once {@link hydrate} starts, specifically so {@link materializeIfPending}
     * is not a no-op during `initEventIndex`'s own earlier awaits (`openDb`, key derivation, checkpoint load) --
     * `closed`/`userId` are already set by then, so a write landing in that window would otherwise pass its guard
     * and upsert a disk-resident id as brand new. Surfaced on {@link getStats}' `loading` so {@link
     * SearchWarning}'s `useIsIndexIncomplete` can keep showing the existing "results may be incomplete" line while
     * it is set.
     */
    private hydrating = false;

    /**
     * Bumped by {@link resetMemory}. {@link hydrate} captures the value in effect when it starts and
     * compares it against this on every resumption point (after each transaction settles, after each
     * yield); the two differing is what tells a hydration run left over from a previous session, or
     * from a re-initialisation that did not go through {@link closeEventIndex} first, to stop without
     * touching {@link db} rather than racing whatever now owns it.
     */
    private hydrationEpoch = 0;

    /**
     * Settles when the hydration run started by the most recent {@link initEventIndex} finishes, is
     * aborted, or -- if nothing was ever started -- immediately. Production code never awaits this;
     * the entire point of {@link initEventIndex} returning early is that nothing on the app-start
     * path should wait for it. It exists so tests, which do need a fully-warmed index to assert
     * against, have a deterministic point to resume at instead of racing a background loop; see the
     * public {@link waitForHydration} wrapper.
     */
    private hydrationPromise: Promise<void> = Promise.resolve();

    /**
     * Set by {@link hydrate}'s outer catch when a run fails for a reason other than a bad row (which wipes and
     * returns instead): most realistically another tab's `onversionchange` closing this connection mid-page-read.
     * Read only by {@link hydrate} itself, to skip its own success log line, and cleared by {@link clearIndexMaps} so
     * a fresh session never inherits a previous one's failure. This is the "stats" a failed run's outcome is
     * recorded in -- the field instrumentation log line already required by this increment, now honest about a run
     * that did not finish cleanly rather than silently printing as if it had.
     */
    private hydrationFailure: unknown = undefined;

    /**
     * Redactions naming an `m.replace` event whose original has not been hydrated yet. An edit is
     * never filed under its own id (see {@link upsertEvent}), so there is no disk row keyed by it at
     * all to look up -- only the original's row carries it, in that row's own `editIds` -- and {@link
     * editTargets} for that original cannot exist until the row that would populate it has been
     * decrypted. Parked here by {@link deleteEvent}, and drained by {@link materializeRow} as each
     * row's own `editIds` is checked against this set while it streams in from disk.
     */
    private readonly pendingRedactions = new Set<string>();

    /**
     * Id -> the in-flight {@link materializeRow} attempt for it, if any; see {@link materializeOnce},
     * the only thing that reads or writes this. Entries live only for the duration of one decrypt.
     */
    private readonly materializing = new Map<string, Promise<void>>();

    /**
     * Whether this session may use the index; see {@link BaseEventIndexManager.supportsEventIndexing}. Re-reads the
     * live gate on every call, but do not mistake that for the feature being re-checked: `EventIndexPeg.init()` asks
     * once and caches the answer. Enforcing the gate is {@link featureEnabled}'s job; this is the honest report, not
     * the mechanism.
     */
    public async supportsEventIndexing(): Promise<boolean> {
        return isBrowserEventIndexEnabled();
    }

    /**
     * Open the index for a user and make it usable; see {@link BaseEventIndexManager.initEventIndex}. The order up to
     * that point is load-bearing: discard any previous state, connection and key material (the settings panel can
     * re-initialise without closing first, and a leaked handle would later block deleting the database); read this
     * user's `meta` row, whose salt yields the same DEK as last time; derive the DEK and checkpoint MAC subkey from the
     * pickle key; then write `meta` if this is a first run.
     *
     * What happens next is **not** a full restore, and that is the point: this resolves once {@link
     * loadCrawlerCheckpoints} has loaded this user's checkpoints -- needed synchronously, because `EventIndex.init()`
     * calls {@link loadCheckpoints} immediately after this returns, and an empty answer here would read as "nothing
     * left to crawl" on an index that is, in fact, most of the way through restoring one -- which is cheap regardless
     * of index size (bounded by the number of *in-progress crawl positions*, not by event count). Decrypting the
     * events themselves into {@link events} is {@link hydrate}'s job, started here but deliberately never awaited, in
     * slices bounded by {@link HYDRATION_SLICE_DEADLINE_MS} so it never produces one long main-thread task regardless
     * of index size -- this method's own cost is now independent of how much has been indexed, deliberately not even
     * proportional to it: there is no bulk "list every id on disk" step here, on purpose (an earlier version had one,
     * a single `getAllKeys()` over this user's whole key range, and it alone measured at 2.5s wall time and a 205ms
     * single task at 200k -- exactly what this method exists to avoid; see {@link materializeIfPending} for how a
     * `has()`-style check stays exact without it). {@link getStats}' `loading` is true for as long as hydration takes.
     *
     * Three fallbacks, all deliberate, are unchanged from before this method stopped awaiting the restore. Unavailable
     * IndexedDB means carrying on memory-only. No pickle key means deriving both keys from fresh random material and
     * disabling persistence, so leftover ciphertext stays unopenable -- the safe failure rather than the convenient
     * one. And a checkpoint, or later a hydrated row, that fails to decrypt means deleting every record for this user
     * and resetting `userVersion` to 0, the expected response to a rotated pickle key or a new device id rather than an
     * error path -- for a checkpoint this still happens here, synchronously; for an event row it happens inside {@link
     * hydrate}, since by the time hydration reaches a bad row this method has already returned. Does nothing at all
     * while the labs gate is off ({@link featureEnabled}): this is the path that would otherwise *create* the database,
     * so a session that has turned the feature off must not be able to put a fresh encrypted index on disk from the
     * settings panel's Enable button.
     */
    public async initEventIndex(userId: string, deviceId: string): Promise<void> {
        if (!this.featureEnabled("initEventIndex")) return;
        await this.resetMemory();
        // Re-initialising must not leak the previous connection, and the key material goes with it: the window between
        // opening the new database and deriving the new key would otherwise hold this user's id, the new connection and
        // the *previous* user's DEK, so a write landing there would be filed under one user and encrypted for another.
        this.closeDb();
        this.dropKey();
        this.persistEnabled = false;
        this.userId = userId;
        this.closed = false;
        // Set eagerly, not left for hydrate() to set on its own first await: openDb/loadMeta/deriveKey/
        // loadCrawlerCheckpoints below are themselves await points, and closed/userId are already set, so a write
        // path landing in this window would otherwise pass its guard, find materializeIfPending() a no-op (gated on
        // this very flag), and upsert a disk-resident id as brand new. Cleared on whichever path below does not go
        // on to start a hydration run; hydrate() itself re-sets it (redundantly, harmlessly) at its own top.
        this.hydrating = true;

        const pickleKey = await PlatformPeg.get()?.getPickleKey(userId, deviceId);
        let salt = crypto.getRandomValues(new Uint8Array(32));
        let existingMeta: MetaRecord | undefined;

        try {
            this.db = await openDb();
            existingMeta = await this.loadMeta(userId);
            if (existingMeta?.salt) {
                salt = decodeBase64(existingMeta.salt);
                this.userVersion = existingMeta.userVersion ?? 0;
            }
        } catch (e) {
            log.warn("IndexedDB unavailable; index will be memory-only this session", e);
            this.db = null;
        }

        if (pickleKey) {
            this.dek = await deriveDek(pickleKey, salt, userId, deviceId);
            this.cpMacKey = await deriveCheckpointMacKey(pickleKey, salt, userId, deviceId);
            this.persistEnabled = this.db !== null;
        } else {
            // No pickle key: session-only DEK, so leftover ciphertext from a previous session cannot be opened.
            const ephemeral = crypto.getRandomValues(new Uint8Array(32));
            const baseKey = await crypto.subtle.importKey("raw", ephemeral, "HKDF", false, ["deriveKey"]);
            ephemeral.fill(0);
            this.dek = await crypto.subtle.deriveKey(
                {
                    name: "HKDF",
                    hash: "SHA-256",
                    salt,
                    info: new TextEncoder().encode(`${EVENTINDEX_HKDF_INFO}|session`),
                },
                baseKey,
                { name: "AES-GCM", length: 256 },
                false,
                ["encrypt", "decrypt"],
            );
            // Nothing persists on this path, but deriving the MAC subkey anyway keeps the
            // invariant "a DEK implies a checkpoint key" true everywhere else in the class.
            this.cpMacKey = await crypto.subtle.deriveKey(
                {
                    name: "HKDF",
                    hash: "SHA-256",
                    salt,
                    info: new TextEncoder().encode(`${EVENTINDEX_CPMAC_HKDF_INFO}|session`),
                },
                baseKey,
                { name: "HMAC", hash: "SHA-256", length: 256 },
                false,
                ["sign"],
            );
            this.persistEnabled = false;
            log.info("EventIndex: no pickle key; index will not persist across reload");
        }

        if (this.persistEnabled && this.db && this.dek) {
            if (!existingMeta) {
                await this.saveMeta({
                    userId,
                    salt: encodeBase64(salt),
                    userVersion: this.userVersion,
                });
            }
            const loaded = await this.loadCrawlerCheckpoints(userId);
            if (!loaded) {
                log.warn("EventIndex: a stored checkpoint could not be decrypted; wiping leftover for this user");
                // Nothing has been hydrated yet at this point, only checkpoints, so there is nothing in `events`
                // to lose here -- unlike hydrate()'s own failure path, which has to undo however much of a
                // restore it had already completed.
                this.clearIndexMaps();
                await this.deleteUserRecords(userId);
                await this.saveMeta({
                    userId,
                    salt: encodeBase64(salt),
                    userVersion: 0,
                });
                this.userVersion = 0;
                this.hydrating = false; // Nothing will hydrate after a wipe; the restore this flag guarded is over.
            } else {
                // Deliberately not awaited -- see the docstring above. hydrationPromise exists only so tests
                // (and, per §6 of the increment this implements, field instrumentation) have something to
                // observe; production code must never depend on it settling.
                const epoch = this.hydrationEpoch;
                this.hydrationPromise = this.hydrate(userId, salt, epoch);
            }
        } else {
            // Memory-only (no IndexedDB, or no pickle key): there is nothing on disk to restore, so the window
            // this.hydrating opened at the top of this method closes here, with nothing having hydrated.
            this.hydrating = false;
        }
    }

    /**
     * Resolve once the hydration run started by the most recent {@link initEventIndex} has finished, aborted, or --
     * if nothing needed hydrating -- immediately. Production code must never call this: the entire point of {@link
     * initEventIndex} returning early is that nothing on the app-start path waits for a restore. It exists for tests
     * that need a fully-warmed index to assert against, as a deterministic point to resume at instead of racing
     * {@link hydrate}'s background loop.
     * @knipignore - exported for tests
     */
    public async waitForHydration(): Promise<void> {
        await this.hydrationPromise;
    }

    /**
     * Index one live event; see {@link BaseEventIndexManager.addEventToIndex}. Does nothing while the labs gate is off,
     * in memory as well as on disk ({@link featureEnabled}). The in-memory update is synchronous, so the event is
     * searchable immediately; only the encrypted write is deferred. Note that the record written is the one for {@link
     * targetId}: when `ev` is an edit it is the *original* message's record that changed.
     *
     * Pulls the target record in from disk first if {@link hydrate} has not reached it yet ({@link
     * materializeIfPending}): without that, an id already sitting in a disk row {@link hydrate} has not decrypted yet
     * would look brand new to {@link upsertEvent}, and upserting it as new would both duplicate its entry in {@link
     * roomOrder} once hydration *does* reach it, and persist a version missing whatever the disk copy already held (a
     * prior edit's `editIds`, say).
     *
     * `materializeIfPending` is the first genuine interleaving point this method has ever had, and its own guards only
     * protect *itself* -- they say nothing about what runs after it returns. So `closed` (and `userId`, cleared on the
     * same teardown paths) is re-checked immediately afterwards: without that, a `closeEventIndex()`/`deleteEventIndex()`
     * landing during the await resolves, clears every map via `resetMemory()`, and this method would then carry on to
     * `upsertEvent` a plaintext event straight into the maps teardown just emptied.
     *
     * @param profile - The sender's display name and avatar *at the time of this event*, so a result can be rendered
     *     without the room being loaded.
     */
    public async addEventToIndex(ev: IMatrixEvent, profile: IMatrixProfile): Promise<void> {
        if (this.closed || !this.userId || !this.featureEnabled()) return;
        await this.materializeIfPending(this.targetId(ev));
        if (this.closed || !this.userId) return;
        this.upsertEvent(ev, profile);
        this.schedulePersistEvent(this.targetId(ev));
    }

    /**
     * Remove an event from the index, in response to a redaction; see {@link BaseEventIndexManager.deleteEvent}. A
     * redaction may name an *edit*, whose content was folded into the original message's record, so the id is resolved
     * through {@link editTargets} first or the redacted text stays searchable under the original's id. The whole record
     * is then dropped rather than reverted, the pre-edit body having been overwritten in place.
     *
     * Three cases, in order: a record already resident resolves as before. One that is not, but hydration is still
     * running, is worth a direct look at the disk row for `eventId` itself ({@link materializeIfPending}, which pulls
     * it in if there is one) so there is something here to remove rather than treating "not decrypted yet" as "does
     * not exist". And one that resolves to neither -- which, while hydration is running, can mean "this is an edit's
     * id, and its original is a disk row not hydrated yet, so {@link editTargets} cannot know about it" -- is parked
     * in {@link pendingRedactions} for {@link materializeRow} to drain as rows stream in, rather than being dropped as
     * a no-op.
     *
     * @returns True if a record was removed; false when nothing matched (including a redaction just parked for later,
     *     which has removed nothing *yet*) and also when the index is closed, which callers do not need to distinguish.
     */
    public async deleteEvent(eventId: string): Promise<boolean> {
        if (this.closed) return false;
        // Resolve an edit's id to the record its content was folded into; see the doc above.
        let targetId = this.events.has(eventId) ? eventId : this.editTargets.get(eventId);
        if (targetId === undefined && this.hydrating) {
            await this.materializeIfPending(eventId);
            targetId = this.events.has(eventId) ? eventId : this.editTargets.get(eventId);
        }
        if (targetId === undefined) {
            if (this.hydrating) this.pendingRedactions.add(eventId);
            return false;
        }
        const existed = this.events.has(targetId);
        this.removeFromIndex(targetId);
        if (existed && this.persistEnabled && this.db && this.userId) {
            this.enqueueDeleteRecord(this.userId, targetId);
        }
        return existed;
    }

    /**
     * Whether the index holds no events at all; see {@link BaseEventIndexManager.isEventIndexEmpty}. It carries more
     * weight than its size suggests: `EventIndex.init` asks exactly once at start-up, and an empty answer is what makes
     * it seed a backward and a forward crawler checkpoint for every encrypted room on the next sync -- see {@link
     * migrateV1ToV2}.
     *
     * Answered from IndexedDB directly with `IDBIndex.getKey()`, which returns the primary key of the first matching
     * row without reading its value and was measured at ~0.5 ms even at 50k rows -- never `IDBIndex.count()`, which
     * walks the whole index and was measured at 0.4-0.5 s at the same size (`research/measurements-v1.md`). This
     * matters more than it once did: since {@link initEventIndex} no longer awaits {@link hydrate}, {@link events} can
     * be near-empty on a database that holds hundreds of thousands of rows, and the caller above needs the honest
     * answer the moment this resolves, not the eventual one. Falls back to the in-memory check when there is nothing
     * persisted to ask, which is also the one case {@link events} cannot disagree with reality about.
     *
     * Flushes {@link liveWriteBuffer} first, and awaits the persist chain, because this is the one caller for which
     * "eventually on disk" is not good enough: a live event sitting in the buffer is real and resident in {@link
     * events}, but until it is flushed the raw `getKey()` below cannot see it, and would answer "empty" about an
     * index that plainly is not -- exactly the wrong answer for the one caller (`EventIndex.init`) that acts on it by
     * re-seeding checkpoints for every room. Only {@link commitLiveEvents} and this method need to reach into disk
     * state this way; every other reader below -- {@link searchEventIndex}, {@link loadCheckpoints}, {@link
     * materializeIfPending} -- answers from memory alone and is unaffected by anything still sitting in the buffer;
     * see each for why.
     */
    public async isEventIndexEmpty(): Promise<boolean> {
        if (!this.persistEnabled || !this.db || !this.userId) return this.events.size === 0;
        this.flushLiveWriteBufferNow();
        await this.persistChain;
        const tx = this.db.transaction("events", "readonly");
        const key = await idbReq(tx.objectStore("events").index("byUser").getKey(this.userId));
        return key === undefined;
    }

    /**
     * Whether any event from a room is indexed; see {@link BaseEventIndexManager.isRoomIndexed}. Answered from {@link
     * roomOrder}, whose entry is deleted outright when a room's last event goes. It says nothing about *how much* is
     * indexed.
     */
    public async isRoomIndexed(roomId: string): Promise<boolean> {
        const ids = this.roomOrder.get(roomId);
        return Boolean(ids && ids.length > 0);
    }

    /**
     * Index statistics for the settings UI; see {@link BaseEventIndexManager.getStats}. `size` is best-effort,
     * IndexedDB offering no per-database measurement: it reports {@link ciphertextBytes}, excluding store overhead,
     * keys and checkpoints, and falls back to {@link estimatePlainSize} where nothing has been persisted, since 0 bytes
     * for a populated index would read as a bug.
     *
     * `eventCount` and `roomCount` are exact for what is resident *right now*, which while {@link loading} is true is
     * not yet the eventual total: both climb as {@link hydrate} decrypts more of the disk store, rather than reporting
     * the final numbers before they are true. `loading` is what tells a caller these are still climbing.
     *
     * `roomCount` is {@link roomOrder}'s own size, not a walk of {@link events}: `roomOrder` already holds exactly one
     * entry per room with at least one resident event, its own entry deleted the moment a room's last one goes (see
     * {@link removeFromIndex}), so re-deriving the same count by visiting every event is redundant work, and at scale
     * not free -- measured at 8.9-15.3 ms at 200k resident events, synchronous and uninterruptible, on a path
     * `useIsIndexIncomplete` now calls on every checkpoint change while a `SearchWarning` is mounted.
     */
    public async getStats(): Promise<IIndexStats> {
        return {
            size: this.ciphertextBytes || this.estimatePlainSize(),
            eventCount: this.events.size,
            roomCount: this.roomOrder.size,
            loading: this.hydrating,
        };
    }

    /**
     * The caller's schema version; see {@link BaseEventIndexManager.getUserVersion}. Opaque here: `EventIndex` owns its
     * meaning. Reset to 0 whenever the index is wiped, so a rebuilt index is treated as new rather than as already
     * migrated.
     */
    public async getUserVersion(): Promise<number> {
        return this.userVersion;
    }

    /**
     * Record the caller's schema version; see {@link BaseEventIndexManager.setUserVersion}. Written straight through to
     * the `meta` row rather than onto the persistence chain, because the caller expects it to have taken effect when
     * the promise resolves. Skipped when there is no existing row to update.
     */
    public async setUserVersion(version: number): Promise<void> {
        this.userVersion = version;
        if (this.persistEnabled && this.db && this.userId) {
            const meta = await this.loadMeta(this.userId);
            if (meta) {
                meta.userVersion = version;
                await this.saveMeta(meta);
            }
        }
    }

    /**
     * Flush queued writes; see {@link BaseEventIndexManager.commitLiveEvents}. On Desktop this commits a Seshat write
     * transaction and events are not searchable until it runs; here they are searchable the moment {@link
     * addEventToIndex} returns, so this only waits for the encrypted writes scheduled so far to have been attempted.
     * Never rejects, so awaiting the chain reports completion, not success.
     *
     * Also flushes {@link liveWriteBuffer} first ({@link flushLiveWriteBufferNow}): the buffer batches live writes
     * across up to {@link LIVE_WRITE_FLUSH_INTERVAL_MS} or {@link LIVE_WRITE_BUFFER_MAX} events, so without this a
     * caller could await an empty chain moments after `addEventToIndex` and see "done" while the write it asked about
     * has not even been scheduled yet.
     */
    public async commitLiveEvents(): Promise<void> {
        this.flushLiveWriteBufferNow();
        await this.persistChain;
    }

    /**
     * Run a query against the in-memory index; see {@link BaseEventIndexManager.searchEventIndex}. The pipeline:
     * tokenise the query exactly as indexed text was and intersect the per-term match sets, so a result must contain
     * *every* term (terms of two characters or more also match by prefix, so results narrow while the user is still
     * typing); fall back to a substring scan ({@link substringHits}) if that found nothing; filter by room; sort by
     * recency if asked; paginate by offset; then decorate each hit with its surrounding events ({@link contextFor}) and
     * a positional `rank`. Unlike Seshat there is no relevance scoring, phrase or field syntax, boolean operators or
     * stemming, and query cost is bounded by the number of *terms* in the index rather than by the number of events --
     * except on the substring fallback, which is linear in total indexed text.
     *
     * Never needs to flush {@link liveWriteBuffer} first: every structure this reads -- {@link events}, {@link
     * inverted}, {@link roomOrder} -- is updated synchronously by {@link upsertEvent} the moment a live event is
     * indexed, before {@link schedulePersistEvent} ever buffers anything for disk. A live event is therefore
     * searchable immediately, seconds before its encrypted copy exists anywhere.
     *
     * @param searchArgs - `search_term` is the raw user input; `room_id` scopes the search; `order_by_recency` sorts
     *     newest first rather than leaving the index's own iteration order; `limit` is the page size, where a missing
     *     or zero value means 10 and a negative one clamps to 1; `before_limit`/`after_limit` ask for context events
     *     either side of each hit; `next_batch` is an opaque token from a previous call.
     * @returns The page. `count` is the total number of matches rather than the page size, `highlights` the query's
     *     terms (returned even for an empty result, so the UI can mark them), and `next_batch` the token for the
     *     following page.
     */
    public async searchEventIndex(searchArgs: ISearchArgs): Promise<IResultRoomEvents> {
        const tokens = tokenize(searchArgs.search_term);
        const empty: IResultRoomEvents = { count: 0, results: [], highlights: tokens, next_batch: undefined };
        if (this.closed) return empty;

        // Intersect the per-term match sets, so a result must contain every term (AND, not OR). `ids === null` is the
        // sentinel for "no term processed yet", which is what lets the first term *seed* the set instead of being
        // intersected against it. An empty Set cannot play that role, and that distinction is the whole reason the
        // sentinel exists: empty already means "some term matched nothing", so starting from one would intersect the
        // first term's matches down to nothing and every query would return no results. A query with no terms therefore
        // starts at an empty Set deliberately -- the loop does not run and the decision passes to the substring
        // fallback below. The early break is not just an optimisation: once the intersection is empty no later term can
        // put anything back, so the remaining prefix scans over the whole vocabulary would be pure waste.
        let ids: Set<string> | null = tokens.length === 0 ? new Set() : null;
        for (const token of tokens) {
            const matches = this.lookupToken(token, token.length >= 2);
            if (ids === null) {
                ids = matches;
            } else {
                const next = new Set<string>();
                for (const id of ids) {
                    if (matches.has(id)) next.add(id);
                }
                ids = next;
            }
            if (ids.size === 0) break;
        }

        // The term path found nothing: retry the raw query as a literal substring. See substringHits for what this
        // reaches that whole-word terms cannot.
        if (!ids || ids.size === 0) {
            ids = this.substringHits(searchArgs.search_term, searchArgs.room_id);
        }
        if (ids.size === 0) return empty;

        // Resolve ids to records, dropping any that have gone: a redaction between matching and reading must not become
        // an undefined result. Room scoping is applied here rather than inside the index, there being no per-room
        // posting lists.
        let hits = Array.from(ids, (eventId) => this.events.get(eventId)).filter((e): e is StoredEvent => Boolean(e));
        if (searchArgs.room_id) {
            hits = hits.filter((e) => e.roomId === searchArgs.room_id);
        }

        // Newest first when the caller asks. Otherwise the order is whatever fell out of the Set iteration above:
        // deterministic for a given index state, but derived from insertion order rather than from any notion of
        // relevance, which nothing here computes.
        if (searchArgs.order_by_recency) {
            hits.sort((a, b) => b.originServerTs - a.originServerTs);
        }

        // Pagination is a plain offset, and `next_batch` that offset back as a decimal string. An offset rather than a
        // cursor because the whole result set is recomputed from memory on every call, so events indexed between two
        // pages can shift rows across the boundary. A malformed token resolves to offset 0 rather than throwing at the
        // user.
        const offset = searchArgs.next_batch ? Number.parseInt(searchArgs.next_batch, 10) || 0 : 0;
        const limit = Math.max(1, searchArgs.limit || 10);
        const page = hits.slice(offset, offset + limit);
        const next_batch = offset + page.length < hits.length ? String(offset + page.length) : undefined;

        const beforeLimit = Math.max(0, searchArgs.before_limit || 0);
        const afterLimit = Math.max(0, searchArgs.after_limit || 0);

        const results = page.map((hit, i) => {
            const context = this.contextFor(hit, beforeLimit, afterLimit);
            return {
                // `rank` is positional, not a relevance score, and nothing should read a meaning into its magnitude. It
                // is 1/n over the hit's position in the *whole* result set rather than in the page, so any consumer
                // that sorts by rank reproduces the order chosen above. Seshat puts a real BM25 score here; the
                // substitution is safe only because nothing in Element reads it.
                rank: 1 / (offset + i + 1),
                result: this.resultEvent(hit.event),
                context,
            };
        });

        return {
            count: hits.length,
            results,
            highlights: tokens,
            next_batch,
        };
    }

    /**
     * Index a batch of back-filled history and advance the crawler's position; see {@link
     * BaseEventIndexManager.addHistoricEvents}. The checkpoint swap happens after the events, so a crash between the
     * two re-fetches a batch rather than skipping it. Either checkpoint may be null; no new one means the crawl has
     * reached the end of that room's history.
     *
     * Each event is pulled in from disk first if {@link hydrate} has not reached it yet ({@link
     * materializeIfPending}), so `existing` below reflects reality -- including a rotated hasFile flag or an already-
     * folded edit history the crawler's own copy would not carry -- rather than looking new merely because hydration
     * has not decrypted it yet. Without that, this method would both duplicate {@link roomOrder}'s entry for the id
     * once hydration does reach it and persist a version regressing whatever the disk copy already held.
     *
     * The loop re-checks {@link closed} after every `materializeIfPending` await, for the same reason {@link
     * addEventToIndex} does: that call is the loop's only interleaving point, its own guards protect only itself, and a
     * teardown landing between two events must stop the batch rather than upsert into maps `resetMemory()` just
     * cleared. Ending the batch there and returning `false` is safe by the contract below -- it is exactly what an
     * empty batch or a shut labs gate already does.
     *
     * Every record this call touches is written as **one IndexedDB transaction** rather than one per event: `dirty`
     * collects the ids that actually changed while the loop below does its (synchronous) in-memory work, and only
     * once the whole batch has been walked does {@link enqueueBatchedWrite} encrypt and `put()` all of them together.
     * This is queued on {@link persistChain}, not awaited here, matching every write path in this class: the crawler
     * gets its answer as soon as the in-memory state is settled, and the encrypted copy lands in the background. A
     * crash between this call returning and that write landing loses at most this one batch's worth of history --
     * acceptable because the checkpoint has not advanced yet either (still queued after this write on the same
     * chain), so the next session's crawler simply re-fetches the same batch and re-derives the identical records.
     *
     * @returns True only if every event in the batch was already indexed *and* nothing about it changed. The crawler
     *     uses this to stop crawling backwards through a room it has covered, so a false negative costs a redundant
     *     page while a false positive would silently truncate history. An empty batch returns false, as does one
     *     dropped because the labs gate is shut: unlike true, false leaves the persisted crawl positions untouched.
     */
    public async addHistoricEvents(
        events: IEventAndProfile[],
        checkpoint: ICrawlerCheckpoint | null,
        oldCheckpoint: ICrawlerCheckpoint | null,
    ): Promise<boolean> {
        if (this.closed || !this.featureEnabled()) return false;
        let allAlready = events.length > 0;
        const dirty = new Set<string>();
        // Three cases per event, which is why this is not just a call to upsertEvent:
        //
        // 1. An unedited record for this id and a non-edit incoming event: the ordinary "seen it already" case. Text
        //    and file flag are recomputed rather than trusted, because the crawler can hand back a better copy than the
        //    live timeline gave us. Only a real difference re-indexes or clears the "nothing new here" flag.
        // 2. A record already edited, and this is the original arriving late: the edit's content must survive, only the
        //    envelope is taken.
        // 3. Anything else -- a new event, or an edit for a record we hold -- is a plain upsert.
        for (const { event, profile } of events) {
            const id = this.targetId(event);
            await this.materializeIfPending(id);
            if (this.closed) return false;
            const existing = this.events.get(id);
            const isReplace = replacedEventId(event) !== null;
            if (existing && !isReplace && existing.edited === false) {
                const incoming = effectiveEventForIndex(event);
                const nextText = extractSearchText(incoming);
                const nextFile = eventHasFile(incoming);
                if (nextText !== existing.searchText || nextFile !== existing.hasFile) {
                    this.unindexTokens(existing.eventId, existing.searchText);
                    existing.searchText = nextText;
                    existing.hasFile = nextFile;
                    existing.event = incoming;
                    this.indexTokens(existing.eventId, nextText);
                    dirty.add(id);
                    allAlready = false;
                }
                continue;
            }
            if (existing && !isReplace && existing.edited) {
                // Original arriving after an edit: keep the new body, take the envelope. That rewrites the record and
                // schedules a persist, so it must clear the flag -- a batch made only of these would otherwise report
                // "all already added" and end the back-fill.
                this.upsertEvent(event, profile);
                dirty.add(id);
                allAlready = false;
                continue;
            }
            if (!existing) allAlready = false;
            else if (isReplace) allAlready = false;
            this.upsertEvent(event, profile);
            dirty.add(id);
        }
        this.enqueueBatchedWrite(Array.from(dirty));
        if (oldCheckpoint) await this.removeCrawlerCheckpoint(oldCheckpoint);
        if (checkpoint) await this.addCrawlerCheckpoint(checkpoint);
        return allAlready;
    }

    /**
     * Record a crawler position; see {@link BaseEventIndexManager.addCrawlerCheckpoint}. Idempotent by tuple: the
     * encrypted record hashes to the same key, so it overwrites itself rather than accumulating. `fullCrawl` is not
     * part of the identity ({@link checkpointIdentity}), so re-adding a checkpoint that differs only in that flag keeps
     * the *first* one's value. Gated on the labs flag, a checkpoint being a record in the same encrypted store.
     */
    public async addCrawlerCheckpoint(checkpoint: ICrawlerCheckpoint): Promise<void> {
        if (this.closed || !this.userId || !this.featureEnabled()) return;
        const userId = this.userId;
        // De-duplication compares the cleartext tuple, not the record key: the in-memory list is
        // cleartext anyway, and this keeps the hot path off an async MAC.
        const identity = checkpointIdentity(userId, checkpoint);
        if (!this.checkpoints.some((c) => checkpointIdentity(userId, c) === identity)) {
            this.checkpoints.push(checkpoint);
        }
        await this.persistCheckpoint(checkpoint);
    }

    /**
     * Retire a crawler position; see {@link BaseEventIndexManager.removeCrawlerCheckpoint}. Matched by room, token and
     * direction, ignoring `fullCrawl`; one that is not held is silently ignored. Addressing the right record is only
     * possible because {@link checkpointKey} is deterministic -- which is also the residual equality leak in the threat
     * model above.
     */
    public async removeCrawlerCheckpoint(checkpoint: ICrawlerCheckpoint): Promise<void> {
        if (!this.userId) return;
        const userId = this.userId;
        const identity = checkpointIdentity(userId, checkpoint);
        this.checkpoints = this.checkpoints.filter((c) => checkpointIdentity(userId, c) !== identity);
        if (this.persistEnabled && this.db && this.cpMacKey) {
            const macKey = this.cpMacKey;
            this.enqueuePersist(async () => {
                // The MAC is computed before the transaction is opened: awaiting anything that
                // is not an IndexedDB request inside a live transaction lets it auto-close.
                const id = await checkpointKey(macKey, identity);
                const tx = this.db!.transaction("checkpoints", "readwrite");
                tx.objectStore("checkpoints").delete(id);
                await txDone(tx);
            });
        }
    }

    /**
     * Every outstanding crawler position; see {@link BaseEventIndexManager.loadCheckpoints}. Served from memory, the
     * records having been decrypted once during {@link initEventIndex}. The array is copied because the caller keeps it
     * as its own work queue and shifts entries off it.
     *
     * Never needs to flush {@link liveWriteBuffer} first, unlike {@link isEventIndexEmpty}: {@link checkpoints} is
     * updated synchronously by {@link addCrawlerCheckpoint}/{@link removeCrawlerCheckpoint} the moment either is
     * called, never read from disk here, so nothing sitting unflushed in the *events* write buffer can make this
     * answer stale.
     */
    public async loadCheckpoints(): Promise<ICrawlerCheckpoint[]> {
        return this.checkpoints.slice();
    }

    /**
     * Page through a room's attachments, for the room file panel; see {@link BaseEventIndexManager.loadFileEvents}.
     * Keeps the records whose {@link StoredEvent.hasFile} was set when indexed, and sorts ascending then reverses for a
     * backward read rather than sorting by direction, so both directions derive from the same total order.
     *
     * @param args - `roomId` selects the room; `limit` is the page size, where a missing or zero value means 10 and a
     *     negative one clamps to 1; `direction` is "b" for newest-first and anything else for oldest-first, defaulting
     *     to backwards; `fromEvent` is an event id from a previous page, and results start immediately after it. One
     *     that is no longer indexed ends the listing rather than erroring, since restarting from the first page would
     *     turn a panel that pages until it gets an empty answer into an endless loop.
     */
    public async loadFileEvents(args: ILoadArgs): Promise<IEventAndProfile[]> {
        const ids = this.roomOrder.get(args.roomId) ?? [];
        const files: StoredEvent[] = [];
        for (const id of ids) {
            const ev = this.events.get(id);
            if (ev?.hasFile) files.push(ev);
        }
        files.sort((a, b) => a.originServerTs - b.originServerTs);
        const backwards = !args.direction || args.direction === "b";
        if (backwards) files.reverse();

        let start = 0;
        if (args.fromEvent) {
            const idx = files.findIndex((e) => e.eventId === args.fromEvent);
            // An unknown cursor is the end of the listing, not the start of it: see above.
            if (idx < 0) return [];
            start = idx + 1;
        }
        return files.slice(start, start + Math.max(1, args.limit || 10)).map((e) => ({
            event: this.resultEvent(e.event),
            profile: e.profile,
        }));
    }

    /**
     * Shut the index down without destroying it; see {@link BaseEventIndexManager.closeEventIndex}. Queued writes are
     * flushed first, then the keys are dropped, memory cleared and the connection closed; a failed flush is logged and
     * teardown continues, since refusing to close would leave the keys in memory. The records stay on disk -- the point
     * of the distinction from {@link deleteEventIndex} -- inert without the pickle key.
     *
     * "Queued writes are flushed first" now includes {@link liveWriteBuffer}: {@link flushLiveWriteBufferNow} is
     * called, synchronously, before anything is awaited, cancelling the pending timer and enqueuing the buffer's
     * contents onto {@link persistChain} under *this* session's still-live `userId`/`dek` -- so the `await` right
     * after genuinely waits for everything this session ever asked to be written, not just what had already reached
     * the chain by whatever moment {@link schedulePersistEvent} happened to be called.
     *
     * If {@link hydrate} is still running, {@link resetMemory} below moves {@link hydrationEpoch} on and clears what
     * that run has built so far; the loop notices at its next resumption point and returns without touching {@link db}
     * (already closed by then) or leaving a transaction or a pending timer behind. Not awaited here -- see {@link
     * waitForHydration} for why that would be a contradiction for tests that need to observe the stop, and why
     * production code has no such need.
     */
    public async closeEventIndex(): Promise<void> {
        this.flushLiveWriteBufferNow();
        try {
            await this.persistChain;
        } catch (e) {
            log.warn("EventIndex: flush on close failed", e);
        }
        this.dropKey();
        await this.resetMemory();
        this.closeDb();
        this.closed = true;
        this.persistEnabled = false;
        this.userId = null;
    }

    /**
     * Destroy the index and everything it has written; see {@link BaseEventIndexManager.deleteEventIndex}. Reached from
     * the settings panel and from `Lifecycle.clearStorage()`, so it must work on a half-dismantled session -- which is
     * why `WebPlatform` keeps returning an existing manager even after the labs flag goes off. Per-user deletion is
     * preferred, the database being shared by every account that has used this origin, and dropping the whole thing is
     * the fallback. Failure is survivable: leftover ciphertext is unreadable without the pickle key, which `Lifecycle`
     * destroys on the same path.
     *
     * Unlike {@link closeEventIndex}, {@link liveWriteBuffer} is *discarded* here ({@link discardLiveWriteBuffer}),
     * not flushed: everything on disk is about to be deleted anyway, so writing the buffer out first would only cost
     * an encrypt-and-commit for content the next line removes. `this.closed = true` is set first, which is also what
     * makes discarding rather than flushing safe against the timer having already fired: {@link flushLiveWrites}
     * re-checks {@link closed} at the moment it actually runs, so even a flush that had raced ahead of this method --
     * queued by the timer moments before this call, its op already appended to {@link persistChain} -- writes nothing
     * once it gets there.
     */
    public async deleteEventIndex(): Promise<void> {
        const userId = this.userId;
        // Stop accepting work, then let what is already in flight finish: resetMemory() replaces the chain, so an
        // operation that captured `this.db` could otherwise open its transaction after the wipe and write a ciphertext
        // row back in.
        this.closed = true;
        this.persistEnabled = false;
        this.discardLiveWriteBuffer();
        try {
            await this.persistChain;
        } catch (e) {
            log.warn("EventIndex: flush before wipe failed", e);
        }
        this.dropKey();
        await this.resetMemory();
        try {
            if (userId && this.db) {
                await this.deleteUserRecords(userId);
            } else {
                this.closeDb();
                await deleteDatabase();
            }
        } catch (e) {
            log.warn("EventIndex: wipe failed; leftover ciphertext is inert without the pickle key", e);
            try {
                this.closeDb();
                await deleteDatabase();
            } catch (e2) {
                log.warn("EventIndex: database drop also failed", e2);
            }
        }
        this.closeDb();
        this.userId = null;
    }

    /**
     * The live labs gate, re-read on every path that can add to the index. `WebPlatform.getEventIndexingManager()`
     * hands out an already-constructed manager whatever the setting now says, because `Lifecycle.clearStorage()` wipes
     * the setting's storage *before* it asks for the manager to delete the index -- teardown has to stay reachable.
     * That makes this object, not the platform, the only place left that can enforce the gate, since `EventIndex` asks
     * {@link supportsEventIndexing} exactly once and caches the answer. Every method that can *create or grow* the
     * at-rest index consults this ({@link initEventIndex}, {@link addEventToIndex}, {@link addHistoricEvents}, {@link
     * addCrawlerCheckpoint}); every method that *removes* something deliberately does not ({@link deleteEvent}, {@link
     * removeCrawlerCheckpoint}, {@link closeEventIndex}, {@link deleteEventIndex}), because turning the feature off
     * must stop the writing without disarming the wiping. {@link setUserVersion} is not gated either, since it rewrites
     * one number in an existing `meta` row. Reads are left alone.
     *
     * One named exception to "every method that grows the index": {@link hydrate} itself does not re-check this on
     * each row, because it is *decrypting what {@link initEventIndex} already committed to restoring* under a gate
     * that was live at the moment `initEventIndex` checked it, not adding anything new. A flag flip mid-hydration
     * (`Lifecycle.clearStorage()` clears the setting's storage before it reaches {@link deleteEventIndex}, so there
     * is a real window) leaves a run already in flight decrypting for slightly longer than the setting has been off
     * -- bounded by `deleteEventIndex`'s epoch bump, which still stops it -- rather than aborting mid-page.
     */
    private featureEnabled(reason?: string): boolean {
        if (isBrowserEventIndexEnabled()) return true;
        if (reason) log.debug(`EventIndex: ${reason} ignored because the feature is turned off`);
        return false;
    }

    /**
     * The record id an event belongs under: the id of the message it edits, or its own. Anything that schedules a
     * persist must use it, because the record that changed when an edit arrives is the original's.
     */
    private targetId(ev: IMatrixEvent): string {
        return replacedEventId(ev) ?? ev.event_id;
    }

    /**
     * Insert or update the record for an event, maintaining every in-memory structure around it. This is where the edit
     * model lives. An edit never gets a record of its own: its content is folded into the record of the message it
     * replaces, and the edit's id is remembered in {@link editTargets} so a later redaction of the edit can find that
     * record. Events arrive from two directions at once -- the live timeline forwards, the crawler backwards -- so an
     * edit and its original can turn up in either order, hence four cases:
     *
     * 1. **Edit for a record we hold.** Re-index around the new content, splicing it onto the *existing* envelope so
     *    sender, timestamp and event id stay the original's.
     * 2. **Original arriving after its edit.** Take the original's envelope but keep the edited content, correcting the
     *    timestamp used for ordering.
     * 3. **Duplicate of an unedited record.** Nothing to do.
     * 4. **Anything new.** Build a fresh record, marked already edited if it is an edit whose original has not been
     *    seen, so case 2 can repair the envelope later without the original reverting the body.
     *
     * @param ev - As received, not the output of {@link effectiveEventForIndex}, which this calls itself. One with no
     *     `event_id`/`room_id` is dropped silently.
     */
    private upsertEvent(ev: IMatrixEvent, profile: IMatrixProfile): void {
        const origId = replacedEventId(ev);
        const targetId = origId ?? ev.event_id;
        if (!targetId || !ev.room_id) return;

        const existing = this.events.get(targetId);
        const incoming = effectiveEventForIndex(ev);

        // Case 1: an edit for a record we hold. Only `content` moves across; the envelope stays
        // the original's, which is what keeps results pointing at the visible message.
        if (existing && origId) {
            this.unindexTokens(existing.eventId, existing.searchText);
            existing.event = {
                ...existing.event,
                content: incoming.content,
            };
            existing.searchText = extractSearchText(existing.event);
            existing.edited = true;
            existing.profile = profile ?? existing.profile;
            existing.hasFile = eventHasFile(existing.event);
            this.rememberEdit(existing, ev.event_id);
            this.indexTokens(existing.eventId, existing.searchText);
            return;
        }

        if (existing && !origId && existing.edited) {
            // Case 2: historic original after an edit: keep the new body, take envelope.
            existing.event = {
                ...incoming,
                content: existing.event.content,
            };
            const previousTs = existing.originServerTs;
            existing.originServerTs = incoming.origin_server_ts ?? existing.originServerTs;
            existing.profile = profile ?? existing.profile;
            // The record has moved in time, so its place in the room's ordered list has to move with it.
            if (existing.originServerTs !== previousTs) this.reindexRoomOrder(existing);
            return;
        }

        // Case 3: a duplicate of an unedited record. It cannot be improved from here, and re-indexing would churn the
        // inverted index for nothing.
        if (existing && !origId) {
            return;
        }

        // Case 4: nothing held for this id. `edited` is seeded from whether this is an edit, so an
        // edit that arrives before its original is already protected against case 2 reverting it.
        const stored: StoredEvent = {
            event: incoming,
            profile: profile ?? {},
            roomId: incoming.room_id,
            eventId: targetId,
            originServerTs: incoming.origin_server_ts ?? 0,
            searchText: extractSearchText(incoming),
            hasFile: eventHasFile(incoming),
            edited: Boolean(origId),
        };
        this.events.set(targetId, stored);
        if (origId) this.rememberEdit(stored, ev.event_id);
        this.indexTokens(targetId, stored.searchText);
        this.insertRoomOrder(stored);
    }

    /**
     * Note that `editId` (an m.replace event) was folded into `stored`, so a redaction naming the edit can find the
     * record to remove. Both directions are recorded: {@link StoredEvent.editIds} on the record, which survives to disk
     * inside the ciphertext, and the reverse lookup in {@link editTargets}, rebuilt from those ids on load. `editId` is
     * ignored when it equals the record's own id, or redacting the original would resolve back to the same record.
     */
    private rememberEdit(stored: StoredEvent, editId: string): void {
        if (!editId || editId === stored.eventId) return;
        const editIds = (stored.editIds ??= []);
        if (!editIds.includes(editId)) editIds.push(editId);
        this.editTargets.set(editId, stored.eventId);
    }

    /**
     * Add a record to its room's id list, keeping that list ordered by `origin_server_ts` ascending -- an invariant the
     * rest of the class reads without re-checking, since {@link contextFor} slices it for the events around a hit and
     * {@link loadFileEvents} walks it to page through attachments. Events genuinely do not arrive in timestamp order,
     * so the position is found by binary search and spliced in; appending and re-sorting instead costs a full sort per
     * indexed event, O(n^2 log n) comparisons to build one room's list, on the main thread inside the awaited login
     * path. The search is for the *upper* bound, so a tied timestamp lands where a stable "append, then sort" put it.
     *
     * There is deliberately no "already present?" check here -- it would be a linear scan on every insert -- so
     * every caller is responsible for calling this at most once per id. {@link upsertEvent} only reaches here when
     * {@link events} held nothing for the id, and {@link reindexRoomOrder} splices the id out immediately before
     * re-inserting it. Hydration's warm start goes through this on every single row it materializes ({@link
     * materializeRow}), not around it -- there is no longer a separate bulk "append everything, sort each room once"
     * path -- so `materializeRow` itself carries the one Map-lookup guard (`events.has()` before its own `set`) that
     * keeps a bug reaching this function from becoming a silent duplicate rather than a caller's own mistake to fix.
     */
    private insertRoomOrder(stored: StoredEvent): void {
        let list = this.roomOrder.get(stored.roomId);
        if (!list) {
            list = [];
            this.roomOrder.set(stored.roomId, list);
        }
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if ((this.events.get(list[mid])?.originServerTs ?? 0) <= stored.originServerTs) lo = mid + 1;
            else hi = mid;
        }
        list.splice(lo, 0, stored.eventId);
    }

    /**
     * Move a record to its correct place in its room's ordered list after its timestamp changed. The one thing that
     * re-times a filed record is an original message arriving after the edit that replaced it, when {@link upsertEvent}
     * adopts the original's envelope. Repairing it here makes the ordering invariant hold at every point rather than
     * eventually.
     */
    private reindexRoomOrder(stored: StoredEvent): void {
        const list = this.roomOrder.get(stored.roomId);
        if (!list) return;
        const at = list.indexOf(stored.eventId);
        if (at >= 0) list.splice(at, 1);
        this.insertRoomOrder(stored);
    }

    /**
     * Remove a record from every in-memory structure at once, because they have to stay consistent or later reads break
     * in ways that are hard to trace: {@link inverted}, {@link events}, {@link foldedSearchText}, {@link editTargets}
     * and {@link roomOrder} (whose entry is deleted entirely when a room's last event goes, so {@link isRoomIndexed}
     * need not check for emptiness). {@link recordBytes} is the exception, describing what is on *disk*, where the row
     * survives until the delete this caller queues has committed.
     *
     * Also drops `eventId` from {@link liveWriteBuffer}, if it is there: a redaction or removal that raced a buffered,
     * not-yet-flushed live write must win outright, not have that write land afterwards and resurrect what this call
     * just removed from every other structure. This is a belt-and-suspenders removal rather than the only thing making
     * that safe -- {@link flushLiveWrites} independently re-reads {@link events} for each id at flush time and skips
     * any that are no longer there -- but dropping it here also keeps a redacted id from counting towards {@link
     * LIVE_WRITE_BUFFER_MAX} for no reason.
     *
     * @param eventId - A record id, not an edit's id; resolve that through {@link editTargets} first. Unknown ids are a
     *     no-op, and nothing here touches the database.
     */
    private removeFromIndex(eventId: string): void {
        const existing = this.events.get(eventId);
        if (!existing) return;
        this.unindexTokens(eventId, existing.searchText);
        this.events.delete(eventId);
        this.foldedSearchText.delete(eventId);
        this.liveWriteBuffer.delete(eventId);
        for (const editId of existing.editIds ?? []) this.editTargets.delete(editId);
        const list = this.roomOrder.get(existing.roomId);
        if (list) {
            const next = list.filter((id) => id !== eventId);
            if (next.length) this.roomOrder.set(existing.roomId, next);
            else this.roomOrder.delete(existing.roomId);
        }
    }

    /**
     * Add a record's terms to the inverted index. Paired with {@link unindexTokens}, and the pairing is a precondition
     * rather than a convention: both re-tokenise the text they are given, so removing a record's terms requires passing
     * the *same text it was indexed with* -- which is why {@link upsertEvent} unindexes before it overwrites
     * `searchText`, never after.
     */
    private indexTokens(eventId: string, text: string): void {
        for (const token of tokenize(text)) {
            let set = this.inverted.get(token);
            if (!set) {
                set = new Set();
                this.inverted.set(token, set);
            }
            set.add(eventId);
        }
    }

    /**
     * Remove a record's terms from the inverted index, passing the exact text the record was indexed with; see {@link
     * indexTokens}. A term whose posting set empties is deleted rather than left behind: {@link lookupToken} walks the
     * entire vocabulary on every prefix query, so dead terms would make queries progressively slower for the life of
     * the session.
     */
    private unindexTokens(eventId: string, text: string): void {
        for (const token of tokenize(text)) {
            const set = this.inverted.get(token);
            if (!set) continue;
            set.delete(eventId);
            if (set.size === 0) this.inverted.delete(token);
        }
    }

    /**
     * The fallback matcher: a linear scan for the query as a literal substring of stored text. Reached only when the
     * term path in {@link searchEventIndex} produced nothing, it covers what whole-word terms plus prefix matching
     * cannot reach at all -- a fragment from the middle of a word, a query whose punctuation split it into terms that
     * never co-occur, and scripts written without word separators. The three-character floor keeps it affordable, and
     * {@link foldedFor} memoises each record's folded text so the folding is not repeated per query. Whitespace runs in
     * the query are collapsed to single spaces and the result trimmed. That normalises the *query* side only: stored
     * text is folded but never whitespace-normalised, so a multi-word query matches only where the stored text
     * separates those words by exactly single spaces -- a body holding a newline between `hello` and `world` is not
     * found by `hello world`. The words must appear adjacent and in order; this is a substring test, not a looser
     * second term search.
     */
    private substringHits(rawQuery: string, roomId?: string): Set<string> {
        const folded = foldText(rawQuery).replace(/\s+/g, " ").trim();
        const out = new Set<string>();
        if (folded.length < 3) return out;
        for (const ev of this.events.values()) {
            if (roomId && ev.roomId !== roomId) continue;
            if (this.foldedFor(ev).includes(folded)) out.add(ev.eventId);
        }
        return out;
    }

    /**
     * One record's search text, folded, from the memo. The memo stores the text it was folded from beside the result
     * and re-folds when the two no longer match, rather than being invalidated wherever {@link StoredEvent.searchText}
     * is written. That is why it is safe: a cache updated at each of those four assignments would be one forgotten line
     * away from serving a stale body to the substring fallback, which fails silently.
     */
    private foldedFor(ev: StoredEvent): string {
        const memo = this.foldedSearchText.get(ev.eventId);
        if (memo && memo.src === ev.searchText) return memo.folded;
        const folded = foldText(ev.searchText);
        this.foldedSearchText.set(ev.eventId, { src: ev.searchText, folded });
        return folded;
    }

    /**
     * Every record id matching one query term, as a fresh Set -- never one of the index's own posting sets, because
     * {@link searchEventIndex} adopts this object directly as the running intersection for the first term.
     *
     * @param prefix - When true, indexed terms that *start with* `token` match as well as the exact term, so typing
     *     "mess" already finds "message". It costs a walk over the whole vocabulary, which is why the caller passes
     *     false for single-character terms; the inner length check repeats that condition, so the prefix walk is
     *     unreachable for one-character terms.
     */
    private lookupToken(token: string, prefix: boolean): Set<string> {
        if (!prefix) return new Set(this.inverted.get(token) ?? []);
        const out = new Set<string>();
        const exact = this.inverted.get(token);
        if (exact) for (const id of exact) out.add(id);
        if (token.length >= 2) {
            for (const [idx, ids] of this.inverted) {
                if (idx !== token && idx.startsWith(token)) {
                    for (const id of ids) out.add(id);
                }
            }
        }
        return out;
    }

    /**
     * The events immediately around a hit, for the lines of context shown with a search result. Slices the room's
     * timestamp-ordered id list either side of the hit, so the context is the neighbourhood *in the index*, not in the
     * room: anything not indexed is simply absent, and a gap does not announce itself as one.
     *
     * @returns The two event lists in timeline order plus `profile_info`, mapping sender MXID to the profile recorded
     *     when that sender's event was indexed, so results render with the display name and avatar of the time. A hit
     *     absent from its own room list yields two empty lists rather than throwing.
     */
    private contextFor(
        hit: StoredEvent,
        beforeLimit: number,
        afterLimit: number,
    ): { events_before: IMatrixEvent[]; events_after: IMatrixEvent[]; profile_info: Record<string, IMatrixProfile> } {
        const list = this.roomOrder.get(hit.roomId) ?? [];
        const idx = list.indexOf(hit.eventId);
        const beforeIds = idx >= 0 ? list.slice(Math.max(0, idx - beforeLimit), idx) : [];
        const afterIds = idx >= 0 ? list.slice(idx + 1, idx + 1 + afterLimit) : [];
        const events_before = beforeIds.map((id) => this.resultEvent(this.events.get(id)!.event));
        const events_after = afterIds.map((id) => this.resultEvent(this.events.get(id)!.event));
        const profile_info: Record<string, IMatrixProfile> = {};
        const consider = [
            hit,
            ...beforeIds.map((id) => this.events.get(id)!),
            ...afterIds.map((id) => this.events.get(id)!),
        ];
        for (const ev of consider) {
            if (ev.event.sender) profile_info[ev.event.sender] = ev.profile;
        }
        return { events_before, events_after, profile_info };
    }

    /**
     * Prepare a stored event for handing out in a result. It returns a *shallow copy*, because js-sdk's search
     * processing decorates the events it is given and a consumer must not corrupt the index's own record. And it
     * removes `state_key` when it is explicitly `null`: js-sdk treats the presence of the key as "this is a state
     * event" regardless of its value, so a null one turns a message into a malformed state event downstream.
     */
    private resultEvent(ev: IMatrixEvent): IMatrixEvent {
        const copy = { ...ev } as IMatrixEvent & { state_key?: unknown };
        if (copy.state_key === null) delete copy.state_key;
        return copy;
    }

    /**
     * Queue the removal of one record's disk row and its accounting, shared by {@link deleteEvent}'s ordinary path and
     * by {@link materializeRow}'s "redacted before it was even hydrated" path -- both end up wanting exactly the same
     * thing done to a row that may or may not still be in {@link recordBytes} (the second caller's row was never
     * added there, having never been materialized, so the `?? 0` matters for it specifically).
     */
    private enqueueDeleteRecord(userId: string, targetId: string): void {
        this.enqueuePersist(async () => {
            const tx = this.db!.transaction("events", "readwrite");
            tx.objectStore("events").delete([userId, targetId]);
            await txDone(tx);
            this.ciphertextBytes -= this.recordBytes.get(targetId) ?? 0;
            this.recordBytes.delete(targetId);
        });
    }

    /**
     * Buffer a live write for {@link liveWriteBuffer}, flushed later as one batched IndexedDB transaction rather than
     * opening a transaction per event -- see {@link flushLiveWriteBufferNow} and {@link flushLiveWrites}, and the
     * class docstring's threat model for the durability trade-off this makes.
     *
     * **Durability semantics.** A crash (tab kill, OS kill, browser crash) before this buffer flushes loses at most
     * the live events buffered since the last flush -- never more than {@link LIVE_WRITE_FLUSH_INTERVAL_MS} (5s) of
     * wall time, and never more than {@link LIVE_WRITE_BUFFER_MAX} events, whichever bound is hit first. This is
     * acceptable for the same reason a crash losing an in-flight crawler batch already was (see {@link
     * addHistoricEvents}): this index is a derived, best-effort search structure, never the source of truth for
     * whether a message exists -- the room's own timeline already has it, unaffected -- and the crawler, walking
     * backwards from its last surviving checkpoint, will eventually re-index anything a live-buffer loss dropped, the
     * same way it recovers from any other gap. Nothing here is more fragile than the crawler-batch case; it is only a
     * few seconds wider.
     *
     * Only the id is buffered here, not a snapshot of the record: {@link flushLiveWrites} re-reads {@link events} for
     * each id at flush time, so a message edited twice before its first flush is written once, in its final state --
     * the same outcome the old per-event scheduling achieved by capturing the object by reference, just reached by
     * re-fetching instead of holding a reference open.
     *
     * @param eventId - The *record* id, i.e. {@link targetId} of the event that arrived, never an edit's own id.
     */
    private schedulePersistEvent(eventId: string): void {
        if (!this.persistEnabled || !this.dek || !this.db || !this.userId) return;
        if (!this.events.has(eventId)) return;
        this.liveWriteBuffer.add(eventId);
        if (this.liveWriteBuffer.size >= LIVE_WRITE_BUFFER_MAX) {
            this.flushLiveWriteBufferNow();
        } else if (this.flushTimer === null) {
            // Armed only by the transition from empty to non-empty, and never rearmed by a later write while it is
            // already pending: that is what bounds the *oldest* buffered write's age by this interval, rather than
            // resetting on every write and never firing under sustained traffic (a debounce, which this must not be).
            this.flushTimer = setTimeout(() => this.flushLiveWriteBufferNow(), LIVE_WRITE_FLUSH_INTERVAL_MS);
        }
    }

    /**
     * Cancel the pending flush timer, if any, and enqueue {@link liveWriteBuffer}'s current contents as one batched
     * write ({@link enqueueBatchedWrite}) -- a no-op if the buffer is empty. Called by the timer itself, by {@link
     * schedulePersistEvent} when the size threshold is hit, and by every path that must observe a live write before
     * it proceeds: {@link commitLiveEvents}, {@link closeEventIndex}, {@link isEventIndexEmpty}.
     */
    private flushLiveWriteBufferNow(): void {
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.liveWriteBuffer.size === 0) return;
        const ids = Array.from(this.liveWriteBuffer);
        this.liveWriteBuffer.clear();
        this.enqueueBatchedWrite(ids);
    }

    /**
     * Drop {@link liveWriteBuffer} without writing it, and cancel the pending timer. Used by {@link deleteEventIndex}
     * (everything on disk is about to be wiped, so flushing first would only cost an encrypt-and-commit for content
     * the next step removes) and by {@link resetMemory} (a defensive reset for every path that reaches it, in case a
     * write somehow failed to flush on its way there).
     */
    private discardLiveWriteBuffer(): void {
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.liveWriteBuffer.clear();
    }

    /**
     * Queue one encrypted, batched write of `ids` onto the persistence chain -- shared by the crawler-batch path
     * ({@link addHistoricEvents}, which calls this once per batch, immediately) and the live-write buffer ({@link
     * flushLiveWriteBufferNow}, which accumulates ids across calls first). `userId` and the DEK are captured here, at
     * the point the write is queued, not read from `this` when {@link flushLiveWrites} finally runs -- the same
     * reason the old per-event `schedulePersistEvent` always captured them this way: a write queued just before a
     * logout or re-initialisation must still encrypt for the session that scheduled it.
     */
    private enqueueBatchedWrite(ids: string[]): void {
        if (ids.length === 0) return;
        if (!this.persistEnabled || !this.dek || !this.db || !this.userId) return;
        const userId = this.userId;
        const dek = this.dek;
        this.enqueuePersist(() => this.flushLiveWrites(userId, dek, ids));
    }

    /**
     * Encrypt and write `ids` as **one** IndexedDB transaction: every value is prepared -- {@link events} re-read,
     * {@link encryptJson} awaited -- entirely before the transaction below is opened, so the only `await` inside the
     * live transaction is {@link txDone} itself, never a decrypt or encrypt that would let IndexedDB auto-close it out
     * from underneath a later `put()` in the same batch. This is what turns "one transaction per event" into "one
     * transaction per batch" for both callers of {@link enqueueBatchedWrite}.
     *
     * Re-reads {@link events} for each id rather than trusting a snapshot taken when the id was buffered: an id can
     * have been deleted (a redaction racing a still-buffered write; see {@link removeFromIndex}) between being queued
     * and this running, and `this.events.get(id)` being absent is exactly how that shows up here -- skipped rather
     * than written, which is correct because the delete this class queues elsewhere for that same id is idempotent
     * against a row that was never written in the first place.
     *
     * Sequential, not `Promise.all`-parallelised: that was tried and measured
     * (`research/measurements-pr-b.md`) to make no difference at 200k events -- Chromium's
     * WebCrypto AES-GCM path does not pipeline meaningfully faster for concurrently-issued calls
     * here, so the extra combinator/filter code would be complexity with no payoff. What
     * batching *does* buy is one `put()` transaction per batch instead of one per event; the
     * remaining drain cost at scale is genuinely the encrypt work itself, not IndexedDB.
     *
     * @param userId - Captured by {@link enqueueBatchedWrite} at schedule time, not read from `this.userId`.
     * @param dek - Captured by {@link enqueueBatchedWrite} at schedule time, not read from `this.dek`.
     */
    private async flushLiveWrites(userId: string, dek: CryptoKey, ids: string[]): Promise<void> {
        // this.closed is re-checked here, not only at schedule time, to close one specific race: a flush queued by
        // the live-write timer can still be sitting on the persist chain when closeEventIndex/deleteEventIndex begin
        // tearing the session down. Both set `closed` before doing anything else, so a flush that reaches this point
        // afterwards -- however it got queued -- writes nothing rather than reviving a session that has moved on.
        if (this.closed || !this.db) return;
        const records: EventRecord[] = [];
        const sizes: Array<[string, number]> = [];
        for (const id of ids) {
            const stored = this.events.get(id);
            if (!stored) continue; // Deleted since being buffered; nothing left to write.
            const blob = await encryptJson(dek, stored, `${userId}|${id}`);
            records.push({ userId, eventId: id, blob });
            sizes.push([id, ciphertextByteLength(blob.ct)]);
        }
        if (records.length === 0) return;
        const tx = this.db.transaction("events", "readwrite");
        const store = tx.objectStore("events");
        for (const rec of records) store.put(rec);
        await txDone(tx);
        // Only once the whole batch has committed, and replacing each record's previous contribution rather than
        // adding to it: these are puts, so a rewrite leaves one row per id, not two.
        for (const [id, bytes] of sizes) {
            this.ciphertextBytes += bytes - (this.recordBytes.get(id) ?? 0);
            this.recordBytes.set(id, bytes);
        }
    }

    /**
     * Queue an encrypted write of one crawler checkpoint. The identity string is computed eagerly, pinning the
     * checkpoint's values at the moment it was added; the MAC over it is computed inside the queued operation but
     * before the transaction is opened, keeping a non-IndexedDB await out of a live transaction that would otherwise
     * auto-close mid-write.
     */
    private async persistCheckpoint(checkpoint: ICrawlerCheckpoint): Promise<void> {
        if (!this.persistEnabled || !this.dek || !this.cpMacKey || !this.db || !this.userId) return;
        const userId = this.userId;
        const dek = this.dek;
        const macKey = this.cpMacKey;
        const identity = checkpointIdentity(userId, checkpoint);
        this.enqueuePersist(async () => {
            const id = await checkpointKey(macKey, identity);
            const blob = await encryptJson(dek, checkpoint, checkpointAad(userId, id));
            const rec: CheckpointRecord = { id, userId, blob };
            const tx = this.db!.transaction("checkpoints", "readwrite");
            tx.objectStore("checkpoints").put(rec);
            await txDone(tx);
        });
    }

    /**
     * Append an operation to the single, serialised persistence chain. IndexedDB already serialises overlapping
     * readwrite transactions, so the point is not mutual exclusion but *ordering*: each operation does asynchronous
     * crypto before opening its transaction, so without the chain a record's write could commit after the delete meant
     * to follow it. Awaiting {@link persistChain} is therefore a meaningful barrier. Failures are logged and swallowed
     * rather than propagated, and that is a decision rather than an omission: a rejection left on the chain would fail
     * every write scheduled after it, and a failed write costs only durability. The cost is that a disk refusing writes
     * shows up only as an index that keeps starting cold.
     */
    private enqueuePersist(op: () => Promise<void>): void {
        this.persistChain = this.persistChain.then(op).catch((e) => {
            log.warn("EventIndex persist failed", e);
        });
    }

    /**
     * Read a user's `meta` row. This is the one read that has to work before any key exists, which is why the row is
     * cleartext: it carries the salt the DEK is derived from. Undefined covers both "no index yet" and "no database",
     * whose response is the same: generate a salt and start fresh.
     */
    private async loadMeta(userId: string): Promise<MetaRecord | undefined> {
        if (!this.db) return undefined;
        const tx = this.db.transaction("meta", "readonly");
        return idbReq(tx.objectStore("meta").get(userId));
    }

    /**
     * Write a user's `meta` row, replacing any existing one. Written directly rather than through {@link
     * enqueuePersist}, because the salt must be on disk before the records encrypted under the key derived from it, or
     * a crash in between would leave ciphertext nothing can derive a key for.
     */
    private async saveMeta(meta: MetaRecord): Promise<void> {
        if (!this.db) return;
        const tx = this.db.transaction("meta", "readwrite");
        tx.objectStore("meta").put(meta);
        await txDone(tx);
    }

    /**
     * The cheap half of a restore, awaited by {@link initEventIndex}: every outstanding crawler checkpoint, decrypted.
     * Bounded by the number of *in-progress crawl positions* -- typically a handful, one per room the crawler has not
     * finished with -- never by how many events this user has indexed, which is what keeps this cheap regardless of
     * index size. Deliberately does **not** also list every event id on disk: an earlier version of this method did,
     * with a single `getAllKeys()` over the user's whole key range, on the reasoning that it was "cheap: primary keys
     * only, never decrypted content" -- true in the sense that it never touches ciphertext, but false in the sense
     * that matters here, because it is still one IndexedDB request whose result deserialises in one main-thread
     * callback proportional to id count: measured at 2.5s wall time and a single 205ms task at 200k, exactly the
     * failure mode this whole method exists to avoid. See {@link materializeIfPending} for how a `has()`-style check
     * stays exact without listing every id up front.
     *
     * @returns True when everything loaded, including the vacuous case of no checkpoints at all. False if one fails to
     *     decrypt, which {@link initEventIndex} responds to exactly as {@link hydrate} responds to a bad event row:
     *     wipe this user's whole index.
     */
    private async loadCrawlerCheckpoints(userId: string): Promise<boolean> {
        if (!this.db || !this.dek) return true;
        const dek = this.dek;

        const cpTx = this.db.transaction("checkpoints", "readonly");
        const cpIdx = cpTx.objectStore("checkpoints").index("byUser");
        const cpRows = (await idbReq(cpIdx.getAll(userId))) as CheckpointRecord[];
        await txDone(cpTx);
        this.checkpoints = [];
        for (const row of cpRows) {
            try {
                const cp = await decryptJson<ICrawlerCheckpoint>(dek, row.blob, checkpointAad(userId, row.id));
                this.checkpoints.push(cp);
            } catch {
                return false;
            }
        }

        return true;
    }

    /**
     * Decrypt everything this user has on disk into memory, in the background, without ever awaiting anything but an
     * IndexedDB request or {@link yieldToEventLoop} between two decrypts -- see {@link initEventIndex}, which starts
     * this without awaiting it, and the class threat model's note on why a non-IndexedDB `await` inside a live
     * transaction is the one mistake to avoid here above all others.
     *
     * Paged: each page is read with one `getAll()` over {@link userEventKeyRange} in its own read-only transaction,
     * which is allowed to settle ({@link txDone}) *before* anything in it is decrypted, because decryption is not an
     * IndexedDB operation and awaiting one inside a live transaction lets it auto-close out from underneath the rest
     * of the page. Sliced: work inside a page is further cut at {@link HYDRATION_SLICE_DEADLINE_MS}, yielding between
     * slices, so a large restore never produces one long main-thread task regardless of how many pages it takes.
     *
     * Every resumption point -- the top of the loop, after each transaction settles, after each row, after each yield
     * -- re-checks {@link closed} and the epoch this run was started with, and returns without touching {@link db} the
     * moment either has moved on. That is what makes teardown and re-initialisation safe against a hydration run left
     * over from a previous session: see {@link resetMemory}, which is what moves the epoch on.
     *
     * A row whose id is already in {@link events} is skipped rather than overwritten: a live event or a crawler batch
     * that named this id got there first and is authoritative (see {@link materializeIfPending}, which is what a write
     * path calls to pull a not-yet-hydrated row in early instead of racing this loop for it), so the disk copy this
     * loop is holding is superseded and must not regress it or duplicate its entry in {@link roomOrder}.
     *
     * A row that fails to decrypt reproduces the old, fully-synchronous {@link initEventIndex}'s failure response --
     * wipe this user's index, in memory and on disk, and reset to `userVersion` 0 -- because that is what a rotated
     * pickle key or a new device id looks like from the inside, and both remain possible mid-hydration. Whatever this
     * run had already hydrated is included in the wipe, which is why it is a caller-visible reset ({@link
     * clearIndexMaps}) rather than something the caller has to notice and clean up after.
     *
     * @param userId - Captured at the call site rather than read from `this.userId`, so a logout or a re-
     *     initialisation for a different user cannot redirect a page this loop already has in flight.
     * @param salt - Needed only by the failure path, to re-save a `meta` row with the same salt after wiping the rest.
     * @param epoch - This run's stamp; see {@link resetMemory} and {@link hydrationEpoch}.
     */
    private async hydrate(userId: string, salt: Uint8Array<ArrayBuffer>, epoch: number): Promise<void> {
        const started = now();
        let longestSliceMs = 0;
        let hydratedCount = 0;

        // No up-front "is there anything to hydrate?" check: the first page read below answers that on its own
        // (an empty result ends the loop immediately, at the cost of one bounded getAll() call, never proportional
        // to n), which is the same reasoning that keeps initEventIndex() from listing every id before this even
        // starts -- see loadCrawlerCheckpoints's docstring.
        this.hydrating = true;

        try {
            let afterEventId: string | undefined;
            for (;;) {
                if (this.closed || epoch !== this.hydrationEpoch || !this.db || !this.dek) return;
                const dek = this.dek;
                const db = this.db;

                const tx = db.transaction("events", "readonly");
                const range = userEventKeyRange(userId, afterEventId);
                const rows = (await idbReq(
                    tx.objectStore("events").getAll(range, HYDRATION_PAGE_SIZE),
                )) as EventRecord[];
                await txDone(tx);
                if (this.closed || epoch !== this.hydrationEpoch) return;
                if (rows.length === 0) break;
                afterEventId = rows[rows.length - 1].eventId;

                let sliceStart = now();
                for (const row of rows) {
                    if (this.closed || epoch !== this.hydrationEpoch) return;

                    if (!this.events.has(row.eventId)) {
                        try {
                            await this.materializeOnce(userId, dek, row, epoch);
                            if (this.closed || epoch !== this.hydrationEpoch) return;
                            hydratedCount++;
                        } catch {
                            log.warn(
                                "EventIndex: stored ciphertext could not be decrypted; wiping leftover for this user",
                            );
                            this.clearIndexMaps();
                            await this.deleteUserRecords(userId);
                            await this.saveMeta({ userId, salt: encodeBase64(salt), userVersion: 0 });
                            this.userVersion = 0;
                            return;
                        }
                    }

                    const elapsedInSlice = now() - sliceStart;
                    if (elapsedInSlice >= HYDRATION_SLICE_DEADLINE_MS) {
                        longestSliceMs = Math.max(longestSliceMs, elapsedInSlice);
                        await yieldToEventLoop();
                        if (this.closed || epoch !== this.hydrationEpoch) return;
                        sliceStart = now();
                    }
                }
                longestSliceMs = Math.max(longestSliceMs, now() - sliceStart);

                if (rows.length < HYDRATION_PAGE_SIZE) break;
            }
        } catch (e) {
            // Anything not already handled inside the loop above -- most realistically db.transaction()/idbReq()/
            // txDone() throwing because another tab's onversionchange closed this connection out from underneath an
            // in-flight page read (openDb installs db.onversionchange = () => db.close()). Recorded, not rethrown:
            // this.hydrationPromise must never reject, since production code never awaits it (see initEventIndex),
            // and an unhandled rejection here would surface as untriaged noise where, before this method existed,
            // EventIndexPeg.initEventIndex's own try/catch turned the equivalent failure into `this.error` plus a
            // disabled index. The index is left exactly as far hydrated as it got, the same graceful-degradation
            // policy every other failure path in this class already follows.
            this.hydrationFailure = e;
            log.warn("EventIndex: hydration failed; leaving the index partially hydrated", e);
        } finally {
            if (epoch === this.hydrationEpoch) {
                this.hydrating = false;
                // Any redaction still parked here named an edit whose original this run never reached (the row
                // does not exist, or decrypting it failed independently of this run's own error path above).
                // clearIndexMaps() would silently absorb these on the next reset regardless, but logging first
                // makes a redaction that this run could not act on visible rather than incidental.
                if (this.pendingRedactions.size > 0) {
                    log.debug(`EventIndex: ${this.pendingRedactions.size} redaction(s) never found their original`);
                    this.pendingRedactions.clear();
                }
            }
        }

        if (!this.hydrationFailure) {
            log.info(
                `EventIndex: hydration finished in ${(now() - started).toFixed(1)}ms, ${hydratedCount} events, ` +
                    `longest slice ${longestSliceMs.toFixed(1)}ms, key order ${HYDRATION_KEY_ORDER}`,
            );
        }
    }

    /**
     * Decrypt one disk row and fold it into every in-memory structure exactly as the old, fully-synchronous restore
     * did: build the {@link StoredEvent}, index its tokens, record its ciphertext size, and insert it into its room's
     * ordered list. Binary-search insertion ({@link insertRoomOrder}), rather than the old bulk "push everything, then
     * sort each room once", because hydration now happens in slices that can be interrupted between any two rows, so
     * the ordering invariant has to hold after every single row instead of only once a whole room's rows have all
     * arrived. Fed rows in ascending primary-key order -- what every caller here does -- the two produce identical
     * output, ties included, because both are stable with respect to that arrival order.
     *
     * Also drains {@link pendingRedactions}: if this row's own `editIds` names an id a redaction already arrived for
     * (necessarily before this row could be hydrated to resolve it, an edit never being filed under its own id), the
     * record this row would have created is redacted on arrival instead of being inserted at all, and its disk row is
     * queued for deletion. This is the one path through which a redaction that raced hydration still ends up removing
     * content in memory and on disk, which is the invariant this exists to not regress.
     *
     * @param epoch - The caller's {@link hydrationEpoch} snapshot, taken before this row's decrypt started. Re-checked
     *     the moment decrypt resolves, against both this and {@link closed}, because decrypt is the one genuinely slow
     *     await in this method and the only point at which a teardown or a re-initialisation that lands mid-decrypt
     *     could otherwise write a freshly-decrypted row into maps {@link resetMemory} has *already* cleared by the time
     *     this resumes -- resurrecting exactly one record into what teardown promised would be empty.
     * @throws Whatever {@link decryptJson} throws on ciphertext that will not decrypt. Both callers -- this method's
     *     own {@link hydrate} loop and {@link materializeIfPending} -- treat that as expected, not exceptional, but
     *     respond to it differently; see each.
     */
    private async materializeRow(userId: string, dek: CryptoKey, row: EventRecord, epoch: number): Promise<void> {
        const stored = await decryptJson<StoredEvent>(dek, row.blob, `${userId}|${row.eventId}`);
        if (this.closed || epoch !== this.hydrationEpoch) return;
        // Belt-and-braces idempotency: every caller is meant to check residency before reaching here
        // ({@link hydrate}'s loop, {@link materializeOnce}'s in-flight de-duplication,
        // {@link materializeIfPending}'s own re-check), but this guard is what makes a future caller
        // that forgets a fail-safe rather than a silent room-order duplicate -- one Map lookup.
        if (this.events.has(stored.eventId)) return;

        const redactedByPendingEdit = (stored.editIds ?? []).some((id) => this.pendingRedactions.has(id));
        if (redactedByPendingEdit) {
            for (const id of stored.editIds ?? []) this.pendingRedactions.delete(id);
            this.enqueueDeleteRecord(userId, stored.eventId);
            return;
        }

        this.events.set(stored.eventId, stored);
        for (const editId of stored.editIds ?? []) this.editTargets.set(editId, stored.eventId);
        this.indexTokens(stored.eventId, stored.searchText);
        this.insertRoomOrder(stored);
        const bytes = ciphertextByteLength(row.blob.ct);
        this.recordBytes.set(stored.eventId, bytes);
        this.ciphertextBytes += bytes;
    }

    /**
     * Materialize one row at most once, however many callers want it at the same time. {@link hydrate}'s loop and
     * {@link materializeIfPending} each decide whether an id needs materializing from a synchronous check of {@link
     * events} taken *before* either starts decrypting -- so if a live write names an id hydration has already started
     * decrypting, but not yet finished, both checks can pass before either's decrypt resolves. Without this, both
     * would go on to call {@link materializeRow}, and both would then insert into {@link roomOrder}, which has no
     * "already present?" check of its own and so duplicates the id in it. A caller that finds an id already being
     * materialized awaits that attempt instead of starting a second one; the map entry is removed once the attempt
     * settles (successfully or not), so a later, genuinely new request for the same id is never permanently blocked by
     * one that has already finished.
     */
    private async materializeOnce(userId: string, dek: CryptoKey, row: EventRecord, epoch: number): Promise<void> {
        const inFlight = this.materializing.get(row.eventId);
        if (inFlight) {
            await inFlight;
            return;
        }
        const attempt = this.materializeRow(userId, dek, row, epoch);
        this.materializing.set(row.eventId, attempt);
        try {
            await attempt;
        } finally {
            this.materializing.delete(row.eventId);
        }
    }

    /**
     * Pull one not-yet-hydrated row into memory immediately, if there is one, so a write path about to consult {@link
     * events} for `targetId` sees the disk copy instead of treating a record that already exists as brand new; see
     * {@link addEventToIndex}, {@link addHistoricEvents} and {@link deleteEvent}, all of which call this before
     * touching {@link events} for an id that came from outside. Without it, a live event or a crawler batch naming an
     * id {@link hydrate} has not reached yet would be folded into the index as if new -- silently dropping whatever
     * the disk copy already held (an `editIds` list, a `hasFile` flag from a later edit) the moment the resulting
     * persist overwrites it.
     *
     * Deliberately answers "does a disk row exist for this id?" with a direct, targeted `get()` rather than consulting
     * a pre-loaded set of every id on disk: {@link initEventIndex} does not build one (see {@link
     * loadCrawlerCheckpoints}'s docstring for why -- in short, doing so at start-up was measured to cost seconds and a
     * single long task at 200k, exactly what this file exists to avoid), and a live `get()` is no less exact, only
     * asked later. {@link hydrating} is what makes this cheap in the common case: once it is false, hydration has
     * necessarily visited every row that ever existed, so nothing pending can be waiting on disk and this returns
     * without ever touching the database.
     *
     * A no-op whenever there is nothing to pull in: the id is already resident, hydration is not running (so nothing
     * could be pending), this session has nothing persisted to read from, or the targeted `get()` finds no row
     * (genuinely new, or already handled by something else). Not itself sliced -- unlike {@link hydrate}'s own
     * paging, this is one record, and the cost is paid once per id, only while hydration is running.
     *
     * Two things are re-checked after the two awaits below, and both matter: `closed`/`epoch` (a teardown or
     * re-initialisation landing mid-call must not resurrect a record into an index that has moved on -- the class of
     * bug {@link addEventToIndex}'s own post-await check exists for) and residency (`this.events.has(targetId)` again
     * -- the id can have finished materializing *during* this call, via {@link hydrate}'s own loop reaching the same
     * row concurrently, in which case {@link materializeOnce}'s in-flight de-duplication map no longer has an entry
     * for it by the time this resumes, and without this second check {@link materializeRow} would run a second time
     * and duplicate the id in {@link roomOrder}, which has no "already present?" check of its own).
     *
     * Never needs to flush {@link liveWriteBuffer} first, despite reading disk directly: this method only ever runs
     * for an id *not yet* in {@link events} (the first line above), and every id in {@link liveWriteBuffer} is, by
     * construction, already in {@link events} -- {@link schedulePersistEvent} is only ever reached after {@link
     * upsertEvent} has added the record. The two sets are therefore always disjoint, so no id this method looks up on
     * disk can ever be the one a buffered-but-not-yet-flushed write is about to change. (Calling
     * {@link flushLiveWriteBufferNow} here anyway, defensively, would also be actively wrong: this runs once per
     * event inside {@link addHistoricEvents}' own loop, so forcing a synchronous flush on every call would open one
     * transaction per event again, exactly the cost this increment's batching exists to remove.)
     */
    private async materializeIfPending(targetId: string): Promise<void> {
        if (this.events.has(targetId)) return;
        if (!this.hydrating) return;
        if (!this.persistEnabled || !this.db || !this.dek || !this.userId) return;
        const userId = this.userId;
        const dek = this.dek;
        const epoch = this.hydrationEpoch;
        let row: EventRecord | undefined;
        try {
            const tx = this.db.transaction("events", "readonly");
            row = (await idbReq(tx.objectStore("events").get([userId, targetId]))) as EventRecord | undefined;
            await txDone(tx);
        } catch (e) {
            // A handle closed out from underneath us by another tab's onversionchange (openDb installs
            // db.onversionchange = () => db.close()) throws synchronously from transaction()/get() -- straight into
            // whichever live write path called this method, e.g. addEventToIndex from a RoomEvent.Timeline handler
            // with no catch of its own. Treat any such failure the same as "no row on disk": conservative, and
            // exactly this function's existing contract for "nothing to pull in".
            log.debug("EventIndex: materializeIfPending could not read the disk row; treating it as absent", e);
            return;
        }
        // A teardown or re-initialisation, or a concurrent materialize attempt for this same id (see the docstring
        // above), could have landed while the read above was in flight; re-check both rather than resurrect a
        // record into an index that has moved on, or duplicate one already materialized by someone else in the
        // meantime. materializeRow() repeats the closed/epoch half of this on its own, for the same reason.
        if (this.closed || epoch !== this.hydrationEpoch) return;
        if (this.events.has(targetId)) return;
        if (!row) return; // Genuinely new, or raced with a delete; nothing left to pull in.
        try {
            await this.materializeOnce(userId, dek, row, epoch);
        } catch {
            // Corrupt row. hydrate()'s own loop will reach this same row later in its pass and respond by wiping
            // the whole index, which is right for a rotated key; until then, this is a bounded, self-limiting cost
            // (a repeated failed get()+decrypt for this one id, only if it is written to again before hydrate()
            // gets there), not worth tearing a session down over on its own.
        }
    }

    /**
     * Delete every row belonging to one user: events, checkpoints and the `meta` row. Per-user rather than per-database
     * because the database is shared by every account that has signed in to this origin. The `meta` row goes too, and
     * with it the salt, so the next {@link initEventIndex} derives a *different* DEK and any row that somehow survived
     * is unreadable afterwards.
     */
    private async deleteUserRecords(userId: string): Promise<void> {
        if (!this.db) return;
        const evTx = this.db.transaction("events", "readwrite");
        const evStore = evTx.objectStore("events");
        const evRows = await idbReq(evStore.index("byUser").getAllKeys(userId));
        for (const key of evRows) evStore.delete(key);
        await txDone(evTx);

        const cpTx = this.db.transaction("checkpoints", "readwrite");
        const cpStore = cpTx.objectStore("checkpoints");
        const cpRows = (await idbReq(cpStore.index("byUser").getAll(userId))) as CheckpointRecord[];
        for (const row of cpRows) cpStore.delete(row.id);
        await txDone(cpTx);

        const metaTx = this.db.transaction("meta", "readwrite");
        metaTx.objectStore("meta").delete(userId);
        await txDone(metaTx);
    }

    /**
     * A rough in-memory size for {@link getStats}, used when nothing has been persisted: the searchable text plus a
     * flat 64 bytes per record. It exists so the settings panel shows a plausible figure rather than "0 bytes", and no
     * decision depends on the number.
     */
    private estimatePlainSize(): number {
        let n = 0;
        for (const ev of this.events.values()) n += ev.searchText.length + 64;
        return n;
    }

    /**
     * Release both key handles. Dropping the references is the whole of it and is enough: the keys are non-extractable,
     * so the key material never existed in JavaScript memory to be zeroed.
     */
    private dropKey(): void {
        this.dek = null;
        this.cpMacKey = null;
    }

    /**
     * Clear every structure {@link hydrate}/{@link materializeRow} populate, without touching {@link checkpoints},
     * {@link userVersion}, {@link persistChain} or {@link hydrationEpoch}. Split out from {@link resetMemory}
     * specifically for {@link hydrate}'s own decrypt-failure path: that path runs *inside* a hydration run and has to
     * wipe what it has built so far without invalidating its own epoch, which the epoch-bumping {@link resetMemory}
     * would do to itself if called mid-run (a hydration loop that just wiped everything would then see its own epoch
     * as stale on its very next check and abort before finishing the wipe it was in the middle of).
     */
    private clearIndexMaps(): void {
        this.events.clear();
        this.editTargets.clear();
        this.foldedSearchText.clear();
        this.inverted.clear();
        this.roomOrder.clear();
        this.ciphertextBytes = 0;
        this.recordBytes.clear();
        this.pendingRedactions.clear();
        this.hydrationFailure = undefined;
    }

    /**
     * Discard all in-memory state and start the persistence chain over. Resetting {@link persistChain} to a resolved
     * promise is the part with teeth: it detaches any operations still queued from anything that awaits the chain
     * afterwards. That is why both teardown paths await the *old* chain before calling this, and why {@link
     * deleteEventIndex} clears {@link persistEnabled} first.
     *
     * Also bumps {@link hydrationEpoch}, which is what tells a hydration run left over from before this call -- a
     * previous session's, or one from a re-initialisation that skipped {@link closeEventIndex} -- to stop at its next
     * resumption point instead of writing into the state this method is about to hand to a new one. Every caller of
     * this method (this class's own {@link initEventIndex}, {@link closeEventIndex}, {@link deleteEventIndex}) is
     * exactly a point where the previous hydration run, if any, must be treated as no longer owning anything.
     *
     * Also calls {@link discardLiveWriteBuffer}: every caller of this method is a point where {@link liveWriteBuffer}
     * either has already been explicitly flushed ({@link closeEventIndex}) or explicitly discarded ({@link
     * deleteEventIndex}) beforehand, so this is the defensive backstop that keeps a stray timer or a leftover id from
     * surviving into whatever this method hands to next, not the primary mechanism for either case.
     */
    private async resetMemory(): Promise<void> {
        this.clearIndexMaps();
        this.checkpoints = [];
        this.userVersion = 0;
        this.persistChain = Promise.resolve();
        this.hydrating = false;
        this.hydrationEpoch++;
        this.discardLiveWriteBuffer();
    }

    /**
     * Close the IndexedDB connection and forget it. Failures are swallowed because every caller is on a teardown path,
     * where an already-closed or broken handle is exactly the case that throws and also the case where it no longer
     * matters. What does matter is that {@link db} ends up null either way.
     */
    private closeDb(): void {
        try {
            this.db?.close();
        } catch {
            /* ignore */
        }
        this.db = null;
    }
}

/**
 * Await an IndexedDB transaction's outcome. `oncomplete` is the only signal that its writes are durable, which is why
 * every write path awaits this rather than the individual `put`/`delete` requests: those report success as soon as the
 * operation is queued, and a transaction can still abort afterwards -- quota exhaustion being the likeliest case here.
 */
function txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = (): void => resolve();
        tx.onerror = (): void => reject(tx.error ?? new Error("idb tx failed"));
        tx.onabort = (): void => reject(tx.error ?? new Error("idb tx aborted"));
    });
}
