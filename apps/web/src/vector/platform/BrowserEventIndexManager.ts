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
 * ## Storage layout (schema v3: chunks)
 *
 * Events are not individually addressable on disk. They are packed, newest-write-first, into `chunks`: each a run of
 * up to roughly {@link CHUNK_TARGET_BYTES} of plaintext event records, serialised once and sealed under **one** AES-GCM
 * ciphertext, stored as a raw binary value (`ArrayBuffer`/`Uint8Array`, never base64 JSON -- see {@link encryptBinary}'s
 * own docstring for the measured cost of the base64 detour this avoids). The {@link
 * BrowserEventIndexManager.manifest} (an encrypted recency index over every id on disk, introduced by increment C)
 * is the chunk *directory*: each entry now carries the id of the chunk holding it, so hydration, redaction and
 * eviction can all find "which chunk has this event" in O(1) rather than scanning. See {@link ChunkRecord}, {@link
 * ManifestEntry.chunkId} and {@link BrowserEventIndexManager.openChunkId} for the write side, and {@link
 * BrowserEventIndexManager.hydrate} for the read side.
 *
 * **Why IndexedDB, not OPFS.** An encrypted, paged store built on top of IndexedDB needs neither OPFS nor
 * `Cross-Origin-Embedder-Policy`/COEP: every chunk read here is a single `get()` by primary key inside an ordinary
 * transaction, not a range scan or a memory-mapped file. `research/prior-art.md` §4.2 (of the increment-D handover)
 * covers why OPFS was considered and set aside for this feature: no shippable, licensable WASM SQLite-with-encryption
 * story (SQLite's own SEE forbids public-site hosting; SQLCipher has no official WASM build), no OPFS at all in
 * Safari private browsing (a real, currently-supported browsing mode this feature must degrade gracefully in, not one
 * the search index can require the absence of), and a roughly 1&nbsp;MB WASM dependency being a materially different
 * PR than this one -- capability was never the objection, and COEP specifically is the *weakest* of the three
 * (`opfs-sahpool` does not even need it; only the `opfs` VFS does).
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
 * - `chunks`: the record key `[userId, chunkId]` and nothing else -- a chunk's *contents* (every event it holds,
 *   including every `eventId`) live only inside its ciphertext. `chunkId` is a per-user, globally monotonic counter
 *   with no relationship to any room, event id or timestamp, so, unlike schema v2's cleartext `eventId` primary key,
 *   it discloses nothing about *which* rooms or events are indexed -- **this closes the admission schema v2 made
 *   here** ("the database as a whole does disclose which rooms are indexed"): the only thing a `chunks` key now
 *   discloses is that *some* chunk with that id exists, and its ciphertext length.
 * - `checkpoints`: the `userId` column and its `byUser` index. The record key is an HMAC of the checkpoint tuple
 *   ({@link checkpointKey}), so no room id, token or direction is on disk in the clear. Keying still buys two things:
 *   a room with a crawl checkpoint but no indexed events yet is not disclosed at all, and a guessed room id cannot be
 *   confirmed offline by hashing it. What it does disclose is **equality and count**.
 * - `meta`: `userId`, the HKDF `salt`, `userVersion` and the small scalar bookkeeping fields on {@link MetaRecord}
 *   (chunk/page counts, the currently-open chunk id) -- all counts or ids, nothing content-shaped. Manifest pages
 *   ({@link ManifestPageRecord}) and the persisted {@link BrowserEventIndexManager.oldestIndexedTs} row live in this
 *   same store, keyed by a string that embeds `userId` and a page/purpose tag, never a room or event id. The salt is
 *   not secret by construction.
 * - Shape: the number of chunk records approximates (events / events-per-chunk), not the event count directly, and
 *   each ciphertext length the size of the events it packs -- coarser than schema v2's one-length-per-event shape.
 *
 * **The complete cleartext key set, across every store, is: `userId`, `chunkId`, the manifest page keys and the HKDF
 * salt** -- `eventId` has left it entirely, on every database this class opens. A v2 (or v1) database is never
 * converted in place: {@link openDb}'s `onupgradeneeded` resets it, dropping the legacy `events` store outright
 * (schema v2's cleartext `[userId, eventId]` primary key and its `byUser` index go with it) rather than reading it
 * to repack its rows into chunks -- see {@link openDb}'s own docstring, "Migration v2 -> v3: reset, not convert"
 * (`research/SYNTHESIS.md` §3.2, decision #5). There is therefore no window, of any length, in which this class
 * holds an open connection to a database with a live `events` store: the reset happens inside the same
 * `versionchange` transaction that bumps {@link EVENTINDEX_DB_VERSION}, before any application code -- this class's
 * own included -- ever gets to read from it. See the exact-key-set test in the test file, which pins this.
 *
 * Every record is additionally bound by AAD to its own key, so an attacker with write access cannot re-file a record
 * under another user or chunk id and have it decrypt -- though that is no defence against deleting records or rolling
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
 * being all-or-nothing (that includes the open chunk: a flush rewrites it whole, so a crash mid-flush leaves either
 * its previous sealed contents or its new ones, never a half-written blob). This is acceptable because this index is
 * a derived, best-effort search structure and never the source of truth for a message's existence (the room's own
 * timeline is, unaffected by any of this), and because the crawler -- resuming from its last surviving checkpoint --
 * will walk back over exactly the gap a crash left and re-index it with no user-visible difference from having
 * written it the first time.
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
import { DAY_MS, getChunkTargetBytes, getEventIndexBounds } from "./eventIndexBounds";

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
 * and is now an HMAC of it. See {@link migrateToV3}, which resets the index rather than converting it (both this
 * step and the later v2-to-v3 step, folded into the same function -- see its own docstring).
 *
 * v3 (this increment) replaces the per-event `events` store with `chunks` -- see the class docstring's own "Storage
 * layout" section. **Reset, not converted**, exactly like v1-to-v2: an online conversion was built and reviewed
 * (`research/review-pr-d.md`'s second pass, 2026-09-14) and found to destroy rows it did not repack, reopen a
 * closed data-loss window under its own batching fix, and read the whole chunk store into memory once per
 * conversion -- three HIGH findings in the conversion machinery itself, none in the chunk store it was converting
 * *into*. Given increment C's bounded crawl (90-day window, 100/20-room cap), a reset's cost is one bounded
 * re-crawl, the same trade v1-to-v2 already made, so the online conversion was dropped rather than fixed (Tim's
 * ruling stands, `research/SYNTHESIS.md` §7 decision #5). See {@link migrateToV3}, run from `onupgradeneeded`
 * for any `oldVersion` below this one: it drops the legacy `events` store outright (there is nothing left to
 * convert, so nothing is gained by keeping it around empty) and clears `checkpoints` and this user's manifest/
 * chunk bookkeeping in `meta`, keeping only `userId`+`salt` so the same DEK still opens whatever this session
 * writes next.
 */
const EVENTINDEX_DB_VERSION = 3;

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
 * One indexed event, in memory and inside the ciphertext of a {@link ChunkRecord}. Everything the
 * search path needs is precomputed here, because a query must not re-parse event content on every
 * keystroke.
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
 * An AES-GCM ciphertext as stored in IndexedDB, for every *small* record in this file: `meta`'s own row, manifest
 * pages and the persisted {@link BrowserEventIndexManager.oldestIndexedTs} row. Both halves are base64 rather than the
 * `Uint8Array`s the crypto API deals in, which buys nothing at rest but keeps the stored record plain JSON, comparable
 * and assertable in tests without caring how an engine round-trips buffers -- an affordable choice for these records
 * because none of them holds bulk event content; see {@link ChunkBlob} for the one record shape (`chunks`) where the
 * base64 detour's cost is why this increment exists to remove it.
 */
interface EncryptedBlob {
    /** Base64 of the 12-byte random IV used for this one encryption. */
    iv: string;
    /** Base64 of the ciphertext, GCM tag included. */
    ct: string;
}

/**
 * An AES-GCM ciphertext as stored in IndexedDB for a {@link ChunkRecord}: raw binary, never base64. `research/
 * browser-limits-model.md`'s IndexedDB-value-storage section (of the increment-D handover) measured base64 JSON at
 * roughly 1.33x the disk footprint of the binary bytes it encodes (the fixed base64 expansion ratio) and materially
 * slower on both the read and write path -- `put()` and `getAll()` of a structured-clone `Uint8Array` costing a small
 * fraction of the same operation on an equivalent-content base64 *string*, because a string additionally has to be
 * parsed/allocated character-by-character where a typed array is copied as bytes. `chunks` is where this matters:
 * unlike `meta`'s handful of small rows, it holds effectively the whole database's content.
 */
interface ChunkBlob {
    /** The 12-byte random IV used for this one encryption, as raw bytes. */
    iv: Uint8Array<ArrayBuffer>;
    /** The ciphertext, GCM tag included, as raw bytes. */
    ct: Uint8Array<ArrayBuffer>;
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
    /**
     * Total ciphertext bytes of every `chunks` row on disk for this user (schema v3; every `events`
     * row before this increment converts), exact, updated in the same transaction as every write and
     * delete that changes it. Restored into {@link BrowserEventIndexManager.ciphertextBytes} at
     * {@link BrowserEventIndexManager.initEventIndex} so `DISK_BUDGET_BYTES` accounting
     * (`research/SYNTHESIS.md` §3.6/§4) is exact from the moment the index opens rather than only
     * once hydration has re-visited every row -- which, since hydration is now itself bounded by the
     * resident budget, may never happen at all. This is additional cleartext, but not a new
     * disclosure: the same total is already recoverable by an attacker with database read access
     * simply by summing every row's own ciphertext length (see the class threat model's "Shape"
     * bullet), which this field only saves them the arithmetic for.
     */
    diskBytes?: number;
    /**
     * Number of manifest pages currently persisted for this user (see {@link ManifestPageRecord}),
     * so {@link BrowserEventIndexManager.loadManifest} knows how many `manifest:<page>` rows to
     * read without a range query. Always present by the time this class's own code reads it: a
     * fresh v3 install and the v2/v1-to-v3 reset (see {@link openDb}'s "Migration v2 -> v3: reset,
     * not convert") both write `0` explicitly, before anything is ever chunked. Treated as `0` if
     * ever absent regardless (an empty manifest, never a signal to re-scan anything -- there is no
     * self-healing migration left to dispatch to).
     */
    manifestPageCount?: number;
    /**
     * The next fresh id {@link BrowserEventIndexManager.allocateChunkId} will hand out, i.e. one past
     * the highest chunk id this user has ever used. A plain counter, never reused (even a chunk that
     * is later deleted outright by {@link BrowserEventIndexManager.deleteRecordsForDiskBudget} does
     * not free its id), so a chunk id alone is never evidence of how many chunks currently exist.
     * `undefined` on a database with no chunk yet (a fresh v3 install, or a v2 database whose
     * conversion has not allocated one) -- treated as `0`.
     *
     * **No corresponding `openChunkId` field, deliberately.** Which chunk is currently *open* (still
     * accepting new entries -- {@link BrowserEventIndexManager.openChunkId}) is kept in memory only
     * and never persisted: every {@link BrowserEventIndexManager.initEventIndex} starts a fresh
     * session with nothing open, allocating a new chunk id on its first write rather than reading
     * back and re-decrypting whatever a previous session left under-full. The cost is bounded and
     * small -- at most one under-filled chunk per session that writes anything at all, never
     * unboundedly many, and never a correctness issue (a chunk this small still round-trips exactly
     * the same way a full one does) -- and it is what keeps chunk state entirely local to the session
     * that is filling it: no decrypt-on-startup for a value nothing has asked for yet, and no failure
     * mode where a corrupted or unreadable "resume" chunk has to be reasoned about separately from an
     * ordinary read failure elsewhere in this file.
     */
    nextChunkId?: number;
    // No `oldestIndexedTs` field, deliberately (review-pr-c.md C2-F4): an earlier revision of this
    // increment stored it here as a verbatim `origin_server_ts`, cleartext, which the class threat
    // model's "What is still cleartext on disk" list does not allow -- unlike `diskBytes`, it
    // discloses something not otherwise recoverable from the ciphertext's own shape (when an
    // account's indexed history begins, to the millisecond). It is persisted instead as its own
    // small *encrypted* row, keyed by {@link oldestIndexedTsKey} -- see {@link
    // BrowserEventIndexManager.prepareOldestIndexedTsWrite}/{@link
    // BrowserEventIndexManager.loadOldestIndexedTs}. Do not re-add it here -- the
    // exact-cleartext-key-set test in the test file pins this interface's field set and will fail
    // if it comes back.
}

/**
 * One page of the encrypted recency manifest: every `{eventId, originServerTs, roomId, chunkId}`
 * quadruple this session knows is on disk, chunked (in the pagination sense -- unrelated to {@link
 * ChunkRecord}) into pages of at most `MANIFEST_PAGE_SIZE` entries so that no single write ever has
 * to re-encrypt the whole manifest. Stored in the *same* `meta` object store as {@link MetaRecord}
 * -- not a new object store, so no extra `EVENTINDEX_DB_VERSION` bump of its own -- keyed by {@link
 * manifestPageKey} (`${userId}|manifest:${page}`), which is also the AAD, same discipline as every
 * other record in this file. The plaintext underneath `blob` is a JSON array of `[eventId,
 * originServerTs, roomId, chunkId]` quadruples (`chunkId` added by this increment: see {@link
 * ManifestEntry.chunkId}); see {@link BrowserEventIndexManager.manifest}'s own docstring for why
 * this exists and what it is used for.
 */
interface ManifestPageRecord {
    /** `${userId}|manifest:${page}`; see {@link manifestPageKey}. */
    userId: string;
    blob: EncryptedBlob;
}

/**
 * One packed chunk of events, schema v3's replacement for one-row-per-event: `blob` decrypts to a
 * JSON array of `[eventId, StoredEvent]` pairs, up to roughly {@link CHUNK_TARGET_BYTES} of
 * plaintext. `chunkId` is a per-user, globally monotonic counter ({@link
 * BrowserEventIndexManager.allocateChunkId}) with no relationship to any room, event id or
 * timestamp -- see the class threat model's "What is still cleartext on disk" section for why this
 * is the key design property that lets `[userId, chunkId]` be the primary key without disclosing
 * which rooms are indexed. Which events currently live in a given chunk is tracked in memory by
 * {@link BrowserEventIndexManager.chunkMembers} and, per event, by {@link
 * ManifestEntry.chunkId} -- never re-derived by reading the chunk itself except where a chunk must
 * be rewritten (packing a new entry into a sealed chunk, redaction, disk-budget deletion).
 */
interface ChunkRecord {
    /** Owning user; half of the record key. */
    userId: string;
    /** The chunk's id; half of the record key, and part of the AAD ({@link chunkAad}). */
    chunkId: number;
    blob: ChunkBlob;
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
 * A copy of `s` guaranteed to be a flat V8 string holding only its own characters, with no
 * possibility of retaining a reference to whatever larger string `s` was carved out of. Exists
 * for {@link BrowserEventIndexManager.foldedFor}'s memo: `foldText`'s `.replace(/\p{M}+/gu, "")`
 * can return a result that, while shorter, is internally a Sliced/ConsString still pointing at the
 * full two-byte-per-character NFKD-decomposed intermediate `normalize("NFKD")` produced -- for
 * *any* accented character, that intermediate is longer than the original text and, because
 * combining marks sit outside Latin-1, forces the whole string into V8's wide (two-byte) internal
 * representation. A memo that stores such a result keeps that whole oversized buffer alive for as
 * long as the memo entry lives, which is what `research/browser-limits-model.md` §2.4 measured as
 * up to +1,418 B/event for accented Latin text.
 *
 * **Verified by measurement, not assumed.** A Node heap check (same V8 as Chromium; see
 * `research/measurements-pr-b.md` for the numbers and the full candidate list) found several
 * plausible "flatten a string" idioms that do *not* work at all (`String(s)`, `s.substring(0)`,
 * `s.repeat(1)`: 569-573 B/event, indistinguishable from not flattening) and two tiers that do:
 * the classic `(" " + s).slice(1)` concatenate-then-slice trick (136 B/event, a real 4.2x
 * improvement but not the floor) and a round trip through an entirely independent representation
 * (`TextEncoder`/`TextDecoder` over UTF-8 bytes, `JSON.parse(JSON.stringify(s))`, or
 * `s.split("").join("")`: all three converged on ~104 B/event, matching the minimal cost of a
 * genuinely flat string of this length with no retained baggage). `JSON.parse(JSON.stringify(s))`
 * is used here because it matched that floor while costing about the same per call as the
 * concatenate-then-slice trick (~0.3 µs), whereas the byte round trip and `split`/`join` were both
 * roughly 5x slower for the same result. Round-tripping through JSON string escaping is lossless
 * for any valid JS string -- including quotes, backslashes and control characters a message body
 * can legitimately contain -- so this is exact, not an approximation.
 *
 * @knipignore - exported for tests
 */
export function flattenCopy(s: string): string {
    return JSON.parse(JSON.stringify(s)) as string;
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
 * The chunk analogue of {@link encryptJson}, for a {@link ChunkBlob}: same construction (fresh
 * random 12-byte IV, AES-GCM with `aad` authenticated but not encrypted), but the ciphertext and IV
 * are returned as raw `Uint8Array`s rather than base64 strings -- see {@link ChunkBlob}'s own
 * docstring for the measured cost the base64 detour would add here, at the scale a chunk's own
 * plaintext (up to {@link CHUNK_TARGET_BYTES}) reaches.
 *
 * @param aad - {@link chunkAad}: the record's own primary key, `${userId}|chunk:${chunkId}`.
 */
export async function encryptBinary(dek: CryptoKey, value: unknown, aad: string): Promise<ChunkBlob> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode(JSON.stringify(value));
    const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
        dek,
        pt,
    );
    pt.fill(0);
    return { iv, ct: new Uint8Array(ct) };
}

/**
 * Open a {@link ChunkBlob} written by {@link encryptBinary} and parse it back. Same contract as
 * {@link decryptJson}: `aad` must be the identical string the record was written with, a mismatch is
 * indistinguishable from corruption or tampering, and nothing here is zeroed, the plaintext becoming
 * an object graph this index keeps in memory on purpose.
 *
 * @knipignore - exported for tests
 */
export async function decryptBinaryJson<T>(dek: CryptoKey, blob: ChunkBlob, aad: string): Promise<T> {
    const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: blob.iv, additionalData: new TextEncoder().encode(aad) },
        dek,
        blob.ct,
    );
    const text = new TextDecoder().decode(pt);
    return JSON.parse(text) as T;
}

/**
 * The primary key -- and AAD -- of one chunk's record in the `chunks` store; see {@link ChunkRecord}.
 * @knipignore - exported for tests, to decrypt a chunk read straight off a raw second connection.
 */
export function chunkAad(userId: string, chunkId: number): string {
    return `${userId}|chunk:${chunkId}`;
}

/**
 * The oldest/newest `originServerTs` among `entries`' values, for {@link
 * BrowserEventIndexManager.chunkInfo}. `entries` is never empty at any call site (an empty chunk is
 * deleted outright, never encrypted -- see {@link BrowserEventIndexManager.enqueueDeleteRecord}), so
 * this never has to represent "no events" as a value.
 */
function tsRangeOf(entries: Map<string, StoredEvent>): { minTs: number; maxTs: number } {
    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const ev of entries.values()) {
        if (ev.originServerTs < minTs) minTs = ev.originServerTs;
        if (ev.originServerTs > maxTs) maxTs = ev.originServerTs;
    }
    return { minTs, maxTs };
}

/**
 * The exact serialised byte length `entries` would have as one chunk's plaintext -- the same `[id,
 * StoredEvent]` array shape {@link encryptBinary} encrypts. Used to (re)establish {@link
 * BrowserEventIndexManager.openChunkPlainBytes} exactly after a structural change too small to be
 * worth tracking incrementally (a redaction dropping one entry); the hot path, packing many new
 * entries into the open chunk one at a time, tracks this incrementally instead (see {@link
 * BrowserEventIndexManager.packIntoOpenChunk}) specifically to avoid re-stringifying the whole
 * (up-to-{@link CHUNK_TARGET_BYTES}) chunk on every single packed event.
 */
function chunkPlainBytesFor(entries: Map<string, StoredEvent>): number {
    return JSON.stringify(Array.from(entries)).length;
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
 * The one and only upgrade path, any pre-v3 schema (v1 or v2) to v3, reached from `onupgradeneeded`
 * whenever `event.oldVersion` is between 1 and {@link EVENTINDEX_DB_VERSION} exclusive. v1 has never
 * existed anywhere but the branch that introduced this file, and v2's own upgrade (from v1) already
 * reset rather than converted for the same reason this one now does: `onupgradeneeded` runs inside
 * the `versionchange` transaction, long before any key material exists, so nothing here can decrypt
 * a row to repack it, and the plaintext-keyed v1 `checkpoints` (`${userId}|${roomId}|${token}|
 * ${direction}`, disclosing every room the crawler had a position for) cannot be *re-keyed* here
 * either, for the same reason.
 *
 * **v3 folds the v2-to-v3 step into the same shape, rather than converting `events` into `chunks`.**
 * An online conversion was built, reviewed and found to destroy rows it decided not to repack, reopen
 * a data-loss window its own batching fix had just closed, and read the whole `chunks` store into
 * memory once per run (`research/review-pr-d.md`'s second pass, 2026-09-14) -- three HIGH findings in
 * the conversion machinery, and increment C's bounded crawl (90-day window, 100/20-room cap) means a
 * reset's cost is a bounded re-crawl, the same trade v1-to-v2 already made. So this drops the legacy
 * `events` store outright (there is nothing left to convert, and keeping it around empty gains
 * nothing) and clears `checkpoints` with it, the same "no checkpoints without also no events" pairing
 * v1-to-v2 established: {@link BrowserEventIndexManager.isEventIndexEmpty} is what tells `EventIndex`
 * to seed fresh checkpoints, so dropping one without the other would leave an index that reports
 * itself non-empty with nowhere to resume from.
 *
 * `meta` keeps only `userId`/`salt`/`userVersion` (reset to 0) per user -- the salt is what lets the
 * next DEK match anything written after the upgrade -- and every manifest-page/`oldestIndexedTs` row
 * sharing this store under a composite key (see {@link ManifestPageRecord}'s own docstring) is
 * deleted outright, since the manifest and chunk bookkeeping they describe no longer correspond to
 * anything on disk (see {@link resetMetaForV3}). `manifestPageCount`/`nextChunkId` are written back
 * as `0`, exactly as a fresh v3 install's own first {@link BrowserEventIndexManager.saveMeta} call
 * does, so the very next open takes the ordinary {@link BrowserEventIndexManager.loadManifest} path
 * rather than dispatching to a self-heal scan that has nothing left to scan.
 */
function migrateToV3(tx: IDBTransaction, db: IDBDatabase): void {
    if (db.objectStoreNames.contains("events")) db.deleteObjectStore("events");
    tx.objectStore("checkpoints").clear();
    resetMetaForV3(tx.objectStore("meta"));
}

/**
 * Reset every `meta`-store row for the v2/v1-to-v3 upgrade ({@link migrateToV3}). A real {@link
 * MetaRecord} (primary-keyed by a plain `userId`, no `|` in it) keeps `userId`/`salt` and its own
 * `userVersion` (owned by the caller -- `EventIndex`/`BaseEventIndexManager` -- not by this schema
 * migration, exactly like v1-to-v2's own meta rewrite left it alone), resetting only this
 * increment's own bookkeeping (`manifestPageCount`/`nextChunkId`) to the same `0` a fresh v3 install
 * writes, since nothing they described survives the reset; a manifest-page or `oldestIndexedTs` row
 * (primary-keyed by a composite string containing `|` -- both share this store with `MetaRecord`,
 * see {@link ManifestPageRecord}'s own docstring) is deleted outright, for the same reason.
 * Cursor-driven, same discipline as v1-to-v2's own meta rewrite, so it stays inside the
 * `versionchange` transaction, which lives only as long as requests keep being issued against it.
 */
function resetMetaForV3(meta: IDBObjectStore): void {
    const cursorReq = meta.openCursor();
    cursorReq.onsuccess = (): void => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const key = cursor.key as string;
        if (key.includes("|")) {
            cursor.delete();
        } else {
            const rec = cursor.value as MetaRecord;
            cursor.update({
                userId: rec.userId,
                salt: rec.salt,
                userVersion: rec.userVersion,
                manifestPageCount: 0,
                nextChunkId: 0,
            });
        }
        cursor.continue();
    };
}

/**
 * Open the index database, creating or upgrading its schema as needed. Two stores: `meta`, keyed by `userId`, holding
 * the one cleartext row per user (the salt, readable *before* any key exists, plus the manifest pages and
 * `oldestIndexedTs` row described in {@link ManifestPageRecord}'s own docstring); and `checkpoints`, keyed by the
 * opaque {@link checkpointKey}, carrying a `byUser` index, the only way one user's rows can be enumerated without
 * scanning everything. Event content itself lives in `chunks` (see the class docstring's "Storage layout" section),
 * created below alongside these two. A database at a pre-v3 version also has a legacy, per-event `events` store from
 * whichever earlier version wrote it; {@link migrateToV3} drops it as part of the upgrade rather than converting it
 * (see that function's own docstring for why), so no code past `onupgradeneeded` ever needs to know it once existed.
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
            // `events` (the legacy, per-event v1/v2 store) is never created here, for a fresh v3
            // install or an upgrade alike: v3 never writes to it, and a pre-v3 database's own copy
            // is dropped by migrateToV3 below rather than kept around to convert. This is what makes
            // eventId leave the cleartext key set outright, on every database this class ever opens.
            if (!db.objectStoreNames.contains("chunks")) {
                db.createObjectStore("chunks", { keyPath: ["userId", "chunkId"] });
            }
            if (!db.objectStoreNames.contains("checkpoints")) {
                const cps = db.createObjectStore("checkpoints", { keyPath: "id" });
                cps.createIndex("byUser", "userId", { unique: false });
            }
            // Any pre-v3 database (schema v1 or v2, oldVersion 0 being a brand-new install with
            // nothing to reset) is reset, not converted -- see migrateToV3's own docstring.
            if (event.oldVersion > 0 && event.oldVersion < EVENTINDEX_DB_VERSION && req.transaction) {
                migrateToV3(req.transaction, db);
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
 * Distinct chunks {@link BrowserEventIndexManager.hydrate} reads together in one read-only
 * transaction before decrypting any of them (review-pr-d.md D5 fix; `research/SYNTHESIS.md` §3.4's
 * own "pages of ~64 chunks (~4 MB)" recommendation). Hydration walks the full set of chunks this
 * user has, newest-member-first, computed once from the already-resident {@link
 * BrowserEventIndexManager.manifest}/{@link BrowserEventIndexManager.chunkMembers} with no I/O;
 * this constant only bounds how many of that walk's chunk *reads* share one transaction, trading a
 * larger in-flight ciphertext batch (bounded: at most this many chunks' worth, on the order of
 * `HYDRATION_CHUNK_BATCH * CHUNK_TARGET_BYTES` plaintext once decrypted) for far fewer transactions
 * than one-per-chunk. Every chunk in the walk is still read and decrypted **at most once** for the
 * whole restore regardless of this number -- it is a transaction-batching knob, not a correctness
 * or caching one.
 */
const HYDRATION_CHUNK_BATCH = 64;

/**
 * How long one hydration slice may run before {@link yieldToEventLoop} hands control back to the
 * event loop; see SYNTHESIS.md §3.4/§3.7 (`SLICE_DEADLINE_MS`). Comfortably under the 50 ms
 * long-task threshold that {@link BrowserEventIndexManager.hydrate} must never exceed.
 * @knipignore - exported for tests, so a test can assert against this value directly (e.g. a mocked
 *     clock forcing the deadline to have elapsed) rather than duplicating the literal `30`.
 */
export const HYDRATION_SLICE_DEADLINE_MS = 30;

/**
 * The resident cost of one indexed event, for checking {@link
 * BrowserEventIndexManager.hydrate}/{@link BrowserEventIndexManager.enforceResidentBudget} against
 * `HOT_WINDOW_BYTES`. **Deliberately not** {@link BrowserEventIndexManager.plainTextByteEstimate}
 * (`searchText.length + 64`): that field is calibrated for a different job -- a plausible non-zero
 * number for the settings UI's `size` stat on a memory-only session -- and measures only the
 * search text, which real-Chromium measurement shows is a small, near-constant fraction of what a
 * `StoredEvent` actually costs on the JS heap (the event envelope, profile, room-order array entry
 * and inverted-index Set entries dominate). Using the text-only estimate as the budget gate was
 * tried and measured wrong: at 200k real-shaped events on the small tier it let ~181k stay
 * resident against a 48 MiB budget, because the text-only estimate for that many events looked
 * nowhere near 48 MiB while the real JS heap had already grown past 178 MiB.
 *
 * `research/SYNTHESIS.md` §1.6/§3.7 cites 869-914 B/event measured across corpus sizes and even
 * across a 5x change in accented-Latin share (`research/measurements-pr-b.md` §6.4), i.e. the
 * real cost is close to a *per-event constant*, not proportional to text length -- which is why a
 * flat per-event figure, not a text-length-weighted one, is the right shape for this estimate.
 * 1024 rounds that measured range up for headroom rather than down. `events.size` (a `Map`'s own
 * count, already read for `getStats()`'s `eventCount`) is what this is multiplied by, so no new
 * per-event bookkeeping is needed to use it: {@link BrowserEventIndexManager.residentByteEstimate}.
 *
 * @knipignore - exported so a test can construct an exact `hotWindowBytes` override (an exact
 *     multiple of this constant) instead of reverse-engineering it.
 */
export const RESIDENT_BYTES_PER_EVENT_ESTIMATE = 1024;

/**
 * Flat per-entry resident-byte estimate for {@link BrowserEventIndexManager.manifest} (an id, a
 * number and a room id, plus `Map`/`Set` overhead), used by {@link EventIndexBounds}'s own
 * `manifestCeilingBytes` and by {@link BrowserEventIndexManager.getStats}' `manifestBytes` --
 * **not** by {@link BrowserEventIndexManager.residentByteEstimate}, which checks `HOT_WINDOW_BYTES`
 * for hydrated events alone (review-pr-c.md C2-F2's second pass: an intermediate revision summed
 * this into that same check, which shrank admitted events by more than half at both proof sizes
 * measurements-pr-c.md §10.2 reports -- corrected in §11: the manifest is its own resident tier
 * with its own ceiling, never a tax on the hot window). `research/measurements-pr-c.md` measured
 * 136.7-138.1 B/event at §9's page size (10k entries/page) and 136.8-171.1 B/event at §10/§11's
 * smaller page size (1k entries/page, review-pr-c.md C2-F3 -- more, smaller `Set`s cost slightly
 * more fixed overhead in aggregate), i.e. roughly constant across a 2.5x scale change either way,
 * the same "per-entry, not proportional to anything else" shape {@link
 * RESIDENT_BYTES_PER_EVENT_ESTIMATE} already assumes for events. 160 rounds that measured range up
 * for headroom, the same convention.
 *
 * **Planned follow-up, not yet built** (see {@link BrowserEventIndexManager.manifest}'s own
 * docstring): a compact representation -- fixed-width ids in one concatenated byte buffer plus
 * typed arrays for `ts`, rather than boxed objects and JS strings in a `Map` -- targeting under
 * 60 B/entry, which would let a tier admit a proportionally larger manifest (and, if ever revisited,
 * a smaller `manifestCeilingBytes`) for the same memory cost.
 * @knipignore - exported for tests, for the same reason {@link RESIDENT_BYTES_PER_EVENT_ESTIMATE} is.
 */
export const MANIFEST_BYTES_PER_ENTRY_ESTIMATE = 160;

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
 * How many terms {@link BrowserEventIndexManager.pendingVocabulary} may hold before {@link
 * BrowserEventIndexManager.indexTokens} merges it into {@link BrowserEventIndexManager.sortedVocabulary}
 * ({@link BrowserEventIndexManager.mergeVocabularyDelta}) -- see that field's docstring for the incident
 * (`research/review-pr-b.md` B-F1) this exists to fix. A fixed constant rather than a function of V (e.g.
 * `sqrt(V)`, the review's other suggestion): easier to reason about and to test, and the amortised cost either
 * choice buys is dominated by the same O(V) merge pass regardless -- a fixed threshold just makes how often that
 * pass runs a constant the reader can see directly rather than one they have to compute. At the corpus's own
 * Heaps'-law rate (~0.15 new terms/event at V=61k, n=200k, `research/browser-limits-model.md` §6.1), this merges
 * roughly once per 13,000 indexed events; each merge is one linear pass over the whole vocabulary --
 * **measured at 17.28ms median at V=200,000** (`research/measurements-pr-b.md` §5.4; review-pr-b.md's B2-F1
 * found an earlier revision of this comment cited "a few ms", which was never a real measurement and was wrong),
 * growing to ~44ms at V=400,000 and ~65ms at V=600,000 -- long enough that {@link
 * BrowserEventIndexManager.hydrate} never lets it run as part of a per-row task; see {@link
 * BrowserEventIndexManager.indexTokens}'s `deferMerge` parameter. Never inside a query, regardless.
 *
 * @knipignore - exported so a test can seed a fixture that actually crosses this threshold rather than
 * duplicating the number (`research/review-pr-b.md` B2-F2: no fixture in the suite used to reach 2,000 distinct
 * terms, so {@link BrowserEventIndexManager.mergeVocabularyDelta} never ran in a test and the binary-searched
 * *base* half of the prefix path -- as opposed to the linearly-scanned delta -- was dead code, which silently
 * regressed a mutant from killed to surviving).
 */
export const VOCABULARY_MERGE_THRESHOLD = 2000;

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
 * The primary-key range covering one user's rows in the `chunks` store, `[userId, chunkId]`. Built
 * on an IndexedDB rule worth spelling out: array keys compare element by element, and where one
 * array is a prefix of the other the *shorter* one sorts first. So `[userId]` (length 1) sorts
 * before every `[userId, chunkId]` (length 2) whatever `chunkId` is, and appending any single
 * character to `userId` -- a plain space is used below, nothing about the choice matters -- makes
 * an array holding only that longer string sort after every `[userId, chunkId]`, for the same
 * reason: the comparison is decided at element 0 before `chunkId` is ever considered.
 *
 * Every caller here ({@link BrowserEventIndexManager.deleteUserRecords}) wants every chunk id at
 * once, there being far fewer chunks than there ever were events (tens of thousands even at the
 * largest proof size, versus hundreds of thousands of events), so an unpaged `getAllKeys()` is
 * cheap enough not to need slicing.
 */
function userChunkKeyRange(userId: string): IDBKeyRange {
    return IDBKeyRange.bound([userId], [userId + " "]);
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
 * Entries per manifest page ({@link ManifestPageRecord}) before a new page is started. The
 * *current* (last, still-filling) page is what every flush re-encrypts (see {@link
 * prepareManifestPageWrites}'s docstring), so this is effectively "the size of the append-only
 * tail" -- review-pr-c.md C2-F3 measured a 10k-entry page (the original value) costing ~15.8ms
 * median to re-encrypt on every flush that touches it (`JSON.stringify` + one AES-GCM encrypt of
 * ~0.5MB of plaintext), which is a large constant cost bought for nothing: a *sealed* page (one
 * that has already filled and rolled over to the next) is only re-encrypted again on a removal,
 * not on every flush, so the page size is a free parameter for flush cost with no correctness
 * trade-off either way. 1,000 (~0.05MB/page) cuts that to ~1.6ms while still keeping even a
 * disk-budget-sized manifest (hundreds of thousands of entries) at a few hundred pages, not
 * thousands.
 * @knipignore - exported for tests, so a fixture can cross a page boundary without seeding a
 *     production-sized manifest.
 */
export const MANIFEST_PAGE_SIZE = 1_000;

/** The primary key -- and AAD -- of one manifest page's record in the `meta` store; see {@link ManifestPageRecord}. */
function manifestPageKey(userId: string, page: number): string {
    return `${userId}|manifest:${page}`;
}

/**
 * The primary key -- and AAD -- of the one encrypted row holding {@link
 * BrowserEventIndexManager.oldestIndexedTs}'s persisted value (review-pr-c.md C2-F4). Reuses {@link
 * ManifestPageRecord}'s shape (`{userId, blob}`) rather than a new interface -- it is exactly the
 * same "one keyed encrypted row in the `meta` store" pattern, just holding `{ts: number}` instead
 * of a page of manifest entries.
 */
function oldestIndexedTsKey(userId: string): string {
    return `${userId}|oldestIndexedTs`;
}

/**
 * One candidate for eviction/deletion by age: an id (an event id for {@link
 * BrowserEventIndexManager.residentHeap}, or `String(chunkId)` for {@link
 * BrowserEventIndexManager.diskChunkHeap}) and the `originServerTs` it was pushed onto a heap with.
 * Kept as the *value pushed*, not a live reference, because both heaps below tolerate staleness by
 * design -- see {@link heapPushTs}.
 */
interface TsEntry {
    ts: number;
    id: string;
}

/**
 * One entry of {@link BrowserEventIndexManager.manifest}: everything the manifest knows about one
 * on-disk id, including which chunk currently holds it ({@link ChunkRecord}). `chunkId` is set once,
 * when an id is first added, and never changes afterwards for as long as the id exists in the
 * manifest -- an id whose *content* changes (an edit, a late-arriving original) is rewritten in
 * place inside its existing chunk, never moved to a different one; only a redaction or a disk-budget
 * deletion ever removes an id from the manifest outright ({@link BrowserEventIndexManager.manifestRemove}).
 * `chunkId` is always a real, allocated chunk id: schema v3 has no reset-then-repack step in this
 * increment (see {@link openDb}'s "Migration v2 -> v3: reset, not convert"), so every manifest entry
 * this class ever creates already knows its chunk at creation time.
 */
interface ManifestEntry {
    ts: number;
    roomId: string;
    chunkId: number;
}

/**
 * The resume position for {@link BrowserEventIndexManager.searchEventIndex}'s streamed cold-tier
 * scan (increment E, `research/SYNTHESIS.md` §3.4/§7 decision #3: old retained messages stay
 * findable, found slower, never lost), encoded into `next_batch` as JSON once a query's scan has
 * touched disk at all -- a query whose page(s) come entirely from the resident (hot) set keeps the
 * legacy bare-decimal `next_batch` format {@link parseSearchCursor}/{@link encodeSearchCursor}
 * already produced before this increment, unchanged, so every existing hot-only caller sees no
 * difference.
 *
 * `offset`/`hotCount` are a deliberate simplification, not full session state: once a query's cold
 * scan starts, the hot-hit count it saw that first time is *pinned* here rather than recomputed on
 * every subsequent page (a live write landing mid-pagination could in principle change it) -- the
 * same "recomputed from memory, so a shift across a page boundary is possible" best-effort
 * pagination contract {@link searchEventIndex}'s own docstring already states for `next_batch`,
 * just extended to cover the cold tier too, rather than a new one. `chunkIdx`/`within` are what
 * make resumption cheap: they name the newest-first chunk-walk position ({@link
 * newestFirstChunkWalk}) the previous call's scan stopped at, and how many of *that* chunk's own
 * matches (not raw entries) were already emitted, so a resumed scan re-decrypts at most the one
 * chunk it stopped inside and then only genuinely new chunks after it -- never the ones a previous
 * page already fully consumed.
 */
interface ColdSearchCursor {
    /** Combined hot+cold position of the next item to serve; the plain pagination offset. */
    offset: number;
    /**
     * The hot-hit count as of the call that started this query's cold scan, or `undefined` on the
     * legacy bare-decimal format (meaning: recompute fresh from this call's own hot hits, exactly
     * as every pre-increment-E call already did).
     */
    hotCount?: number;
    /** Index into {@link newestFirstChunkWalk}'s result where the next cold read should resume. */
    chunkIdx: number;
    /** Matches of chunk `chunkIdx` already emitted by an earlier call; skip this many on resume. */
    within: number;
    /** True once a previous call's scan reached the end of the chunk walk with nothing left. */
    coldExhausted: boolean;
}

/** The shape both {@link BrowserEventIndexManager.contextFor} and {@link BrowserEventIndexManager.coldContextFor} return. */
type ColdContext = {
    events_before: IMatrixEvent[];
    events_after: IMatrixEvent[];
    profile_info: Record<string, IMatrixProfile>;
};

/**
 * Push `entry` onto a plain binary min-heap ordered by `ts`, array-backed, no external library:
 * both {@link BrowserEventIndexManager.residentHeap} (oldest-resident-event-first, for the
 * hot-window budget) and {@link BrowserEventIndexManager.diskChunkHeap} (oldest-chunk-first, by the
 * chunk's own oldest member event, for the disk budget) are exactly this shape. Neither heap is kept
 * free of stale entries eagerly -- a record whose id is redacted, evicted, or re-timed leaves its old
 * heap entry in place -- because IDs are cheap to push and a heap has no efficient arbitrary-removal
 * operation; {@link heapPopMinTs}'s caller is the one place that has to notice and skip a stale
 * entry, once, when it is popped.
 */
function heapPushTs(heap: TsEntry[], entry: TsEntry): void {
    heap.push(entry);
    let i = heap.length - 1;
    while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent].ts <= heap[i].ts) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
    }
}

/** Pop and return the entry with the smallest `ts`, or `undefined` if `heap` is empty. */
function heapPopMinTs(heap: TsEntry[]): TsEntry | undefined {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
            const l = i * 2 + 1;
            const r = i * 2 + 2;
            let smallest = i;
            if (l < heap.length && heap[l].ts < heap[smallest].ts) smallest = l;
            if (r < heap.length && heap[r].ts < heap[smallest].ts) smallest = r;
            if (smallest === i) break;
            [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
            i = smallest;
        }
    }
    return top;
}

// The per-page-sort + k-way merge that used to live here (review-pr-c.md C2-F1) was removed when
// BrowserEventIndexManager.hydrate stopped walking the manifest id-by-id and started walking
// chunks instead (review-pr-d.md D5): a chunk-ordered walk needs only a sort of the (far smaller)
// distinct-chunk-id set, not a merge over every manifest page's own sorted ids. See hydrate's own
// docstring.

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
     * The **base** of the sorted vocabulary: every term that was in {@link inverted}'s key set as of the last merge
     * ({@link mergeVocabularyDelta}), sorted, for {@link lookupToken}'s prefix path to binary-search. Never re-sorted
     * from scratch on a read: a term newly added to {@link inverted} goes into {@link pendingVocabulary} instead, and
     * only moves here in a bounded, write-triggered merge -- see that field and {@link mergeVocabularyDelta} for why.
     * May contain a term whose posting set has since emptied (a "ghost" -- see {@link unindexTokens}); harmless,
     * because {@link lookupToken} looks the term back up in {@link inverted} and skips it if the posting is gone.
     */
    private sortedVocabulary: string[] = [];
    /**
     * Terms added to {@link inverted}'s key set since {@link sortedVocabulary} was last merged, in insertion order
     * (not sorted). This is the fix for B-F1 (`research/review-pr-b.md`): the previous design re-sorted the *entire*
     * vocabulary from scratch on the first prefix query after any write, which measured at 25ms at this corpus's own
     * V (61,346 terms at 200k events) and 107ms at V=200,000 -- a long-task violation on every keystroke during
     * hydration or a crawler batch, both of which dirty the vocabulary on nearly every write. Kept small instead:
     * {@link lookupToken}'s prefix path binary-searches {@link sortedVocabulary} *and* linearly scans this delta (at
     * most {@link VOCABULARY_MERGE_THRESHOLD} terms, a fixed, small, insert-rate-independent cost -- see that
     * constant), and {@link indexTokens} merges this into the base with one O(V) pass ({@link mergeVocabularyDelta})
     * only once this list reaches that threshold, never as a side effect of a read. A term never needs to be removed
     * from this list on a redaction: {@link unindexTokens} intentionally does nothing to either vocabulary structure
     * (see its docstring), and a term that was pending, then fully redacted before ever being merged, is simply a
     * ghost once it does merge, exactly as tolerated in {@link sortedVocabulary}'s own docstring.
     */
    private readonly pendingVocabulary: string[] = [];
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
     * Running total of ciphertext bytes, reported as {@link getStats} `size`. Kept equal to the sum
     * of {@link chunkInfo}'s `bytes` rather than accumulated: a rewrite replaces a chunk's
     * contribution instead of adding a second one.
     */
    private ciphertextBytes = 0;
    /**
     * Running total of {@link StoredEvent.searchText} length (plus a flat 64 bytes/record), for {@link
     * estimatePlainSize} -- the `size` stat's fallback when nothing is persisted. Maintained incrementally, the same
     * way {@link ciphertextBytes} is, rather than recomputed by scanning {@link events}: see {@link getStats}, which
     * is called roughly every 3s while the Security panel is open and must not cost O(n). Every site that changes a
     * record's `searchText` -- {@link upsertEvent}'s four cases, {@link addHistoricEvents}' refresh branch, {@link
     * materializeRow}, {@link removeFromIndex} -- adjusts this by the same delta it applies to {@link inverted} via
     * {@link indexTokens}/{@link unindexTokens}, so the two can never drift independently of each other.
     */
    private plainTextByteEstimate = 0;
    /**
     * Memo of {@link foldText} over each record's {@link StoredEvent.searchText}, for the substring fallback; see
     * {@link foldedFor}. Purely derived, never persisted, and validated against the text it was computed from rather
     * than invalidated by hand. Stores a {@link flattenCopy} of the folded text, not the direct result of {@link
     * foldText}: see that function's docstring for why the direct result can retain a much larger buffer than its own
     * length suggests, and `research/measurements-pr-b.md` for the three-way measurement (no memo, this memo, the
     * original unflattened memo) that is why this exists in this exact form rather than either alternative.
     */
    private readonly foldedSearchText = new Map<string, { src: string; folded: string }>();
    /**
     * Per-chunk bookkeeping for every chunk this session knows is on disk: its exact ciphertext byte
     * length (updated wherever the chunk is written -- {@link flushLiveWrites}, {@link
     * enqueueDeleteRecord}, {@link deleteRecordsForDiskBudget} -- never re-derived by re-encrypting),
     * and the oldest/newest `originServerTs` among its current member
     * events, recomputed from {@link chunkMembers} and the manifest every time the chunk is rewritten
     * (cheap: a chunk holds on the order of {@link CHUNK_TARGET_BYTES} / one event's worth of
     * entries, tens of them, never thousands). `minTs` is what {@link diskChunkHeap} orders by --
     * schema v3's disk budget deletes whole chunks, oldest-chunk-first, not individual events.
     */
    private readonly chunkInfo = new Map<number, { bytes: number; minTs: number; maxTs: number }>();
    /**
     * chunkId -> the event ids currently packed into that chunk, per the manifest ({@link
     * ManifestEntry.chunkId}). Maintained alongside {@link manifest} by {@link manifestAdd}/{@link
     * manifestRemove} (never independently), so it is always exactly "the ids whose manifest entry
     * names this chunk" -- the O(chunk size) membership list {@link deleteRecordsForDiskBudget} needs
     * to remove every id of a chunk being dropped without an O(manifest size) scan, and that {@link
     * enqueueDeleteRecord}/the crawler's update path need to find which chunk to rewrite for an id
     * whose content changed.
     */
    private readonly chunkMembers = new Map<number, Set<string>>();
    /**
     * Min-heap of every *durable* resident record by `originServerTs`, the eviction candidate list
     * for {@link enforceResidentBudget} (`HOT_WINDOW_BYTES`, `research/SYNTHESIS.md` §3.6/§3.7).
     * Never cleaned up eagerly on removal -- see {@link heapPushTs}'s docstring -- so a popped
     * entry must be checked against {@link events} before being trusted.
     *
     * Populated *only* once a record's write has actually committed -- {@link flushLiveWrites} (a
     * batch or the live buffer, once its chunk `put()`s succeed) and {@link materializeRow} (a
     * pre-existing disk row, durable by definition the moment it is decrypted) -- **never** at the
     * moment a record becomes resident ({@link upsertEvent} case 4) or is merely re-timed while
     * resident ({@link upsertEvent} case 2, which relies on its own fresh persist eventually reaching
     * this heap the same way). This was not the original design and the reason it changed is worth
     * recording: an earlier version pushed at case 4 and called {@link enforceResidentBudget}
     * synchronously on every insert, deferring any entry not yet known durable ({@link manifest} not
     * yet containing it). Measured on a real 200k-event crawler ingest, that made every eviction
     * attempt walk (and re-push) most of the heap for nothing, for two compounding reasons:
     * `enqueueBatchedWrite` never awaits, so the entire ~2.5s ingest loop runs to completion (all
     * 200k heap pushes) before the persist chain has committed almost anything; and this class's
     * backward-crawl delivery order (newest first, progressively *older* content batch over batch)
     * means the not-yet-durable tail is also usually the current heap *minimum* -- precisely what
     * eviction pops first. The result was effectively quadratic in event count, and a 200k-event
     * ingest did not finish inside a 15-minute harness timeout. Granting candidacy only at the
     * write-commit site removes the "not yet durable" case from {@link enforceResidentBudget}
     * entirely -- every entry popped from this heap either evicts or is stale, never deferred for
     * durability -- at the cost of eviction lagging insertion by up to one flush's worth (a live
     * buffer: {@link LIVE_WRITE_BUFFER_MAX} events or {@link LIVE_WRITE_FLUSH_INTERVAL_MS}; a crawler
     * batch: ~100 events), never unboundedly.
     */
    private readonly residentHeap: TsEntry[] = [];
    /**
     * Min-heap of every *chunk* this session knows is on disk, keyed by that chunk's own {@link
     * chunkInfo} `minTs` -- `id` is `String(chunkId)`, reusing {@link TsEntry}/{@link heapPushTs}
     * rather than a second heap implementation. The deletion candidate list for {@link
     * enforceDiskBudget} (`DISK_BUDGET_BYTES`): schema v3 evicts whole chunks, oldest-chunk-first
     * ({@link deleteRecordsForDiskBudget}), not individual events, so this is a heap of chunks, not
     * of records the way schema v2's equivalent (`diskTsHeap`) was. Populated wherever {@link
     * chunkInfo} is; a popped entry is checked against {@link chunkInfo}'s current `minTs` before
     * being trusted, the same staleness discipline {@link residentHeap} uses against {@link events}.
     *
     * A known limitation, named rather than silently accepted: this heap, like {@link chunkInfo},
     * only ever contains chunks this *session* has written or decrypted at least once. A chunk from a
     * previous session that this session's hydration has not reached yet (because {@link
     * residentBudgetExceeded} stopped it early) is invisible to {@link enforceDiskBudget} until
     * something -- a live write touching it, or hydration reaching it -- makes it visible. This is
     * the same "no full scan" constraint that bounds hydration itself.
     */
    private readonly diskChunkHeap: TsEntry[] = [];
    /**
     * A floor on the oldest `originServerTs` currently resident, or `undefined` while nothing is
     * (or the concept has never been touched, e.g. a memory-only session): "nothing older than this
     * is promised resident", the same guarantee-floor reading as {@link oldestIndexedTs}, not a
     * promise that this is the literal minimum -- {@link events} has no blind spot the way disk
     * does, so it is *usually* exact, but {@link enforceResidentBudget}'s own docstring on
     * `deferredMinTs` explains the one case (a deferred entry popped ahead of a later-evicted one in
     * the same call) where it would otherwise overstate coverage without that correction. Maintained
     * as a simple running bound either way: {@link upsertEvent}/{@link materializeRow} pull it
     * *backward* (older) with `Math.min` when an older record becomes resident, and {@link
     * enforceResidentBudget} pushes it *forward* (newer, never past the true floor) as records are
     * evicted, since eviction is always oldest-first and so can only ever raise this floor.
     */
    private oldestResidentTs: number | undefined;
    /**
     * The oldest `originServerTs` this session (or a previous one) has confirmed is on disk. Read
     * this as a *guarantee floor* -- "nothing older than this is promised findable" -- not as the
     * literal timestamp of the single oldest surviving row, and the two are allowed to diverge:
     * {@link enforceDiskBudget} raises this to at least the newest record it just deleted, which is
     * exact for what it deleted but says nothing about whether some other, untouched-this-session
     * row happens to be even older (see {@link diskTsHeap}'s docstring for why that can happen
     * under the current schema). The floor can only move forward from a deliberate drop, or
     * backward from genuinely discovering an older record still exists ({@link Math.min} on write
     * or on {@link materializeRow}); it is never guessed at.
     *
     * **Never persisted in cleartext** (review-pr-c.md C2-F4: an earlier revision stored this
     * verbatim in the `meta` row -- a real event timestamp, disclosing to the millisecond when an
     * account's indexed history begins to anyone with database read access, which the class threat
     * model's cleartext list does not allow). Persisted instead as its own small encrypted row
     * ({@link prepareOldestIndexedTsWrite}/{@link loadOldestIndexedTs}), in the same transaction as
     * whatever write just changed it -- **not** derived from {@link manifestOldestByRoom} at read
     * time, even though that map tracks a per-room version of the same idea, because that map is
     * deliberately left *stale* on a partial removal (the safe direction for a per-room crawl
     * floor, C-F2's fix) which is the *wrong* direction for this field (it must move forward on a
     * drop, never stay behind it).
     */
    private oldestIndexedTs: number | undefined;
    /**
     * True once {@link hydrate} has stopped early because the resident set reached
     * `HOT_WINDOW_BYTES` (leaving rows un-hydrated on disk), or {@link enforceResidentBudget} has
     * evicted at least one record to make room for a live/crawler write. Sticky for the life of the
     * in-memory session (reset only by {@link clearIndexMaps}): once true, {@link
     * materializeIfPending} must keep consulting disk for ids it cannot find resident even after
     * {@link hydrating} itself goes false, because "hydration finished" no longer implies "every row
     * was visited" the way it did before this increment.
     *
     * **No longer feeds {@link getStats}' `windowed` (increment E).** Content beyond the resident
     * budget is still on disk and still findable -- {@link searchEventIndex}'s streamed cold-tier
     * scan reaches it, just more slowly than a resident hit -- so it is not the same kind of "gone"
     * {@link diskBudgetDropped}/{@link crawlBoundDeclined} are. This field still gates
     * `materializeIfPending`'s on-demand disk consultation above, which is unrelated to `windowed`.
     */
    private residentBudgetExceeded = false;
    /**
     * True once {@link enforceDiskBudget} has deleted at least one row this session. Feeds {@link
     * getStats}' `windowed`, alongside {@link residentBudgetExceeded} and {@link crawlBoundDeclined}.
     */
    private diskBudgetDropped = false;
    /**
     * True once {@link shouldCrawl} has declined at least one checkpoint this session (a room
     * outside `CRAWL_ROOM_CAP`, or a crawl that has passed `CRAWL_WINDOW_DAYS` back in some room).
     * Feeds {@link getStats}' `windowed`. Unlike {@link oldestIndexedTs}, a declined room-cap
     * checkpoint carries no timestamp of its own, which is why `windowed` and "a date is known"
     * ({@link IIndexStats.oldestIndexedTs}) are two separate conditions rather than one.
     */
    private crawlBoundDeclined = false;
    /**
     * Bumped at the top of every {@link searchEventIndex} call, before any cold-tier scan work
     * starts. A scan's every `await` (a chunk decrypt, a slice yield) re-checks this against the
     * value it captured at its own start, so a *newer* search superseding an older, still-running
     * one makes the older one stop at its next checkpoint rather than keep decrypting chunks or
     * holding the event loop for a result nothing will use -- the same "epoch" discipline {@link
     * hydrationEpoch} already uses for hydration, applied to search instead. Never reset except by
     * this counter's own increment; there is no "search closed" state to restore it to.
     */
    private searchEpoch = 0;
    /**
     * True once the most recent {@link searchEventIndex} call's cold-tier scan stopped at the page
     * cap (`SEARCH_PAGE_CAP`, `research/SYNTHESIS.md` §3.7) with more on-disk content left
     * unscanned, rather than exhausting every chunk on record for that query. Surfaced on {@link
     * getStats} as `isSearchPartial`; see that field's own docstring for why this is a last-search,
     * not per-result, signal. Recomputed on every search call (including one that never touches the
     * cold tier at all, which clears it back to false), never left stale from an earlier query.
     */
    private searchPartial = false;
    /**
     * The answer from the one-time {@link navigator.storage.persist} request made when this user's
     * index is first created (never on a later re-open of an existing one; see {@link
     * initEventIndex}), or `undefined` before that has ever run, is not applicable (no `navigator.storage`),
     * or on a session that opened an *existing* index and so never asked. Surfaced on {@link
     * getStats} purely for the settings UI; nothing in this class changes behaviour based on it,
     * `initEventIndex` never fails because of it, and a denial is not retried.
     */
    private storagePersisted: boolean | undefined;

    /**
     * The encrypted recency manifest: `originServerTs`/`roomId`/`chunkId` for **every** event this
     * user has on disk, resident for the life of the session regardless of the resident (hot-window)
     * budget -- the identity layer `research/review-pr-c.md`'s fix asked for (increment C), now also
     * the chunk *directory* schema v3's storage layout needs (increment D, this field's `chunkId`):
     * "which chunk holds this event" is answered from here, never by scanning {@link chunkMembers} or
     * a chunk's own contents. It exists to answer three questions the resident set (`events`/
     * `roomOrder`) cannot answer once eviction has run, because eviction only ever removes from the
     * resident set, never from disk, and this does not shrink on eviction:
     *
     * 1. **What order should {@link hydrate} read rows in to make the resident set genuinely the
     *    newest, not an artefact of key order** (Matrix event ids are opaque, server-assigned
     *    strings with no guaranteed relationship to `origin_server_ts`; review-pr-c.md C-F1 is what
     *    happens once hydration stops early against key order instead). {@link hydrate} sorts this map's entries by
     *    `originServerTs` descending once, and reads disk rows in that order.
     * 2. **How far a room's crawl has gone, and how it ranks against other rooms, in a way eviction
     *    cannot mutate** (C-F2/C-F3: the previous design asked `roomOrder`, which eviction edits by
     *    design). {@link manifestOldestByRoom}/{@link manifestNewestByRoom} answer this from the
     *    manifest instead.
     * 3. **Which chunk holds a given event** ({@link ManifestEntry.chunkId}, this increment), for
     *    every chunk-rewrite path (an update landing on an already-sealed chunk, a redaction, a
     *    disk-budget deletion) to find its target in O(1).
     *
     * Persisted as AES-GCM pages in the *existing* `meta` store ({@link ManifestPageRecord},
     * {@link MANIFEST_PAGE_SIZE} entries each) -- no new object store, no `EVENTINDEX_DB_VERSION`
     * bump, no reset. Maintained on every write commit ({@link flushLiveWrites}), redaction
     * ({@link enqueueDeleteRecord}) and disk-budget deletion ({@link deleteRecordsForDiskBudget}),
     * via {@link manifestAdd}/{@link manifestRemove}; **not** touched by RAM-only eviction
     * ({@link enforceResidentBudget}), which is the entire point -- a row leaving the resident set
     * must not look, to this map, like it left disk.
     *
     * **Memory cost, tracked in its own resident tier, not inside `HOT_WINDOW_BYTES`
     * (review-pr-c.md C2-F2, corrected):** {@link MANIFEST_BYTES_PER_ENTRY_ESTIMATE} per entry,
     * reported via {@link getStats}' `manifestBytes` and bounded, per tier, by {@link
     * EventIndexBounds.manifestCeilingBytes} (`eventIndexBounds.ts`'s own module docstring has the
     * worst-case numbers per tier and the "manifest ceiling + hot window = total resident" figure).
     * An earlier revision of this fix (review-pr-c.md's own second pass, C2-F2) summed this cost
     * *into* {@link residentByteEstimate} alongside `events.size`, checked against the same
     * `HOT_WINDOW_BYTES` -- correct that the manifest's real memory cost must not be invisible, but
     * the wrong tier for it to count against: `HOT_WINDOW_BYTES` is the "instantly searchable"
     * tier's own budget, and folding the manifest into it shrank admitted events by more than half
     * at both proof sizes (measurements-pr-c.md §10.2), which guts what the hot window exists to
     * guarantee. The manifest is still never itself evicted or truncated to make room -- it cannot
     * be, per the two questions above -- it simply has its own accounting and its own ceiling now,
     * self-enforcing because the manifest cannot exceed the events {@link
     * EventIndexBounds.diskBudgetBytes} admits. {@link MANIFEST_BYTES_PER_ENTRY_ESTIMATE} is kept
     * unchanged by this increment's own addition of `chunkId` to every entry: one more boxed number
     * per entry falls well inside the 136.7-171.1 B/event range increment C already measured across
     * proof sizes and page sizes, which the chosen 160 B/entry already rounds up from for headroom.
     *
     * **Planned follow-up, not yet built:** a compact manifest representation -- fixed-width ids
     * concatenated into one byte buffer plus typed (`Float64Array`/similar) arrays for `ts`, rather
     * than a `Map<string, ManifestEntry>` of individually-boxed objects and JS strings -- targeting
     * under 60 B/entry, well below {@link MANIFEST_BYTES_PER_ENTRY_ESTIMATE}'s current 160.
     *
     * Kept as `Map<eventId, ManifestEntry>` rather than a structure pre-sorted by `originServerTs`:
     * inserts (overwhelmingly the common operation, one per write) are O(1); {@link hydrate} reads
     * this snapshot via a sliced per-page sort plus a k-way merge (review-pr-c.md C2-F1), not the
     * single unsliced whole-manifest sort this docstring once described -- see {@link hydrate}'s own
     * comment on why a page-index-ordered concatenation would not be correct here.
     */
    private readonly manifest = new Map<string, ManifestEntry>();
    /**
     * `manifest`'s entries chunked into on-disk pages, by page index; the persistence unit for
     * {@link ManifestPageRecord}. A `Set`, not an array, so removing an id from a page ({@link
     * manifestRemove}) is O(1) rather than an O(page size) splice -- disk-budget deletion can remove
     * many ids from the manifest in one pass, and a splice-based page would make that O(page size)
     * per id.
     */
    private readonly manifestPages: Set<string>[] = [];
    /** id -> the page (index into {@link manifestPages}) it currently lives in. */
    private readonly manifestEntryPage = new Map<string, number>();
    /** Pages changed since the last time they were written; {@link prepareManifestPageWrites} drains this. */
    private readonly manifestDirtyPages = new Set<number>();
    /**
     * roomId -> ids in {@link manifest} for that room. Exists for {@link manifestOldestByRoom}/
     * {@link manifestNewestByRoom} to know when a room's floor/ceiling must be cleared outright
     * (the set becomes empty) versus merely stale (some, not all, of a room's entries removed --
     * see {@link manifestRemove}'s docstring for why leaving a floor stale in that case is the safe
     * direction, not a bug).
     */
    private readonly manifestRoomIds = new Map<string, Set<string>>();
    /**
     * roomId -> the oldest `originServerTs` this session has ever recorded in the manifest for that
     * room, i.e. how far that room's crawl has gone -- what {@link shouldCrawl}'s window check
     * reads instead of `roomOrder` (C-F2). A floor in the same sense as {@link oldestIndexedTs}:
     * only ever pulled *backward* (older) by {@link manifestAdd}'s `Math.min`, and deliberately
     * **not** recomputed when some (not all) of a room's entries are removed, so a disk-budget
     * deletion of this room's oldest rows cannot make its own crawl window creep backward again and
     * re-open the fetch-write-delete treadmill C-F2 named. Cleared only when {@link
     * manifestRoomIds} for that room becomes empty (nothing left to have a floor about).
     */
    private readonly manifestOldestByRoom = new Map<string, number>();
    /**
     * roomId -> the newest `originServerTs` this session has ever recorded in the manifest for that
     * room -- what {@link roomsByManifestRecency} ranks rooms by for `CRAWL_ROOM_CAP` (C-F3),
     * instead of `roomOrder`'s last (resident) entry. Pulled *forward* (newer) by `Math.max` on
     * every {@link manifestAdd}, and, symmetrically with {@link manifestOldestByRoom}, left stale
     * rather than recomputed on a partial removal.
     */
    private readonly manifestNewestByRoom = new Map<string, number>();
    /**
     * True once this session's manifest is fully populated by {@link loadManifest} (there is no
     * from-scratch build any more: a database with nothing persisted yet is a fresh install, which
     * has an empty manifest by construction, not something to scan for). {@link shouldCrawl} treats
     * "not yet loaded" as "cannot judge, let it through" (the same conservative default as "room
     * never seen"), and {@link hydrate} awaits {@link manifestReadyPromise} before it reads the
     * first row, so hydration never sorts a partial view.
     */
    private manifestLoaded = false;
    /**
     * Settles once the manifest phase ({@link loadManifest}) of the most recent {@link
     * initEventIndex} finishes; {@link waitForManifest} exposes it to tests/the perf harness so the
     * manifest phase's own duration can be measured separately from the rest of hydration. {@link
     * hydrate} awaits this directly before it reads its first chunk.
     */
    private manifestReadyPromise: Promise<void> = Promise.resolve();

    /**
     * The id of the chunk currently accepting new (never-before-chunked) entries, or `undefined`
     * before the first write of this session -- see {@link MetaRecord.nextChunkId}'s docstring for
     * why this is deliberately session-local, never persisted or resumed across sessions. Allocated
     * once, lazily, by {@link ensureOpenChunk}, and replaced whenever {@link openChunkPlainBytes}
     * crosses {@link CHUNK_TARGET_BYTES} and the current chunk is sealed.
     */
    private openChunkId: number | undefined;
    /**
     * Full current contents of {@link openChunkId} -- every event packed into it so far this session
     * -- kept decrypted in memory the whole time it is open (bounded: at most {@link
     * CHUNK_TARGET_BYTES} of plaintext), so a flush can rewrite the *whole* chunk from this map
     * without a read. Cleared and rebuilt fresh whenever the chunk is sealed and a new one is opened.
     */
    private readonly openChunkEntries = new Map<string, StoredEvent>();
    /**
     * Running estimate of {@link openChunkEntries}' own serialised plaintext size (the `[eventId,
     * StoredEvent]` array {@link CHUNK_TARGET_BYTES} is a target on), maintained incrementally by
     * {@link packIntoOpenChunk} rather than recomputed by re-serialising the whole map on every
     * write -- the same "track it, do not scan for it" discipline {@link ciphertextBytes} already
     * follows.
     */
    private openChunkPlainBytes = 0;
    /**
     * The next fresh chunk id this session will hand out ({@link allocateChunkId}); loaded from
     * {@link MetaRecord.nextChunkId} at {@link initEventIndex} (`0` for a database with none yet) and
     * persisted back in the same transaction as every write that allocates a new one, so ids stay
     * globally unique for this user across every session, past and future, even though *which* chunk
     * is open is not itself persisted.
     */
    private nextChunkId = 0;

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
     * ids removed from the resident set ({@link removeFromIndex}) by a genuine deletion -- {@link
     * deleteEvent}'s ordinary path, or {@link materializeRow}'s "redacted before it was even
     * hydrated" path -- whose disk chunk has been queued for rewrite ({@link enqueueDeleteRecord})
     * but has not committed yet. Added synchronously the same moment the record leaves {@link
     * events}/`manifest` bookkeeping begins; removed once that queued rewrite settles (success or
     * failure, in a `finally`). Unlike {@link residentHeap}'s "durable by construction" candidates,
     * a **deleted** id's old disk row can still be sitting there, unchanged, for as long as the
     * removal sits on {@link persistChain} -- which is exactly the window {@link coldSearchScan}
     * (increment E) would otherwise be able to read: it walks {@link chunkMembers}/decrypts a
     * chunk directly, neither of which reflects the deletion until the queued rewrite lands, and
     * its own "already resident?" check (`this.events.has`) reads false for a just-deleted id
     * (deletion removed it from `events` too), so nothing else stops a stale hit here without this
     * set. {@link materializeIfPending} checks it for the same reason, on the same window, for an
     * on-demand pull racing the same queued rewrite.
     */
    private readonly pendingDiskDeletes = new Set<string>();

    /**
     * chunkId -> the in-flight {@link readChunkEntries} attempt for it, if any; see {@link
     * decryptChunkOnce}, the only thing that reads or writes this. Entries live only for the
     * duration of one chunk decrypt. Keyed by chunk, not by event id, since schema v3's shared,
     * decrypt-once resource is the chunk -- {@link hydrate}'s own batch read and {@link
     * materializeIfPending}'s on-demand pull can both want the same chunk at once, and this is what
     * makes the second one reuse the first's decrypt instead of paying for it twice.
     */
    private readonly materializingChunks = new Map<number, Promise<Map<string, StoredEvent>>>();

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
                // Exact disk-budget accounting from the moment the index opens, not only once
                // hydration has re-visited every row -- which it may never do now that hydration
                // itself is bounded; see MetaRecord.diskBytes and ciphertextBytes' own docstring.
                this.ciphertextBytes = existingMeta.diskBytes ?? 0;
                // oldestIndexedTs is NOT restored here (review-pr-c.md C2-F4): it is no longer a
                // stored field at all, and is instead derived from the manifest once loadManifest
                // finishes, below.
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
                // manifestPageCount: 0 (and nextChunkId: 0) written right here, at creation, not left
                // absent for a later flush to fill in: without it, a fresh v3 install closed before its
                // first write commits leaves a meta row with no signal at all for the next open to
                // tell "genuinely nothing here yet" from "meta row lost its manifest count somehow".
                // "A manifest exists and is empty" -- exactly what a fresh install and a just-reset
                // or just-wiped index both are -- must be representable, per MetaRecord.manifestPageCount's
                // own docstring.
                await this.saveMeta({
                    userId,
                    salt: encodeBase64(salt),
                    userVersion: this.userVersion,
                    manifestPageCount: 0,
                    nextChunkId: 0,
                });
                // Asked once, right here at creation, never again on a later re-open of this same
                // index (see storagePersisted's docstring). Fire-and-forget: some browsers show a
                // permission prompt for this, and awaiting it here would defeat the fast, bounded
                // return increment A specifically exists to guarantee.
                this.requestStoragePersistenceOnce();
            }

            // Deliberately not awaited -- see the docstring above. hydrationPromise/manifestReadyPromise
            // exist only so tests (and, per §6 of the increment this implements, field instrumentation)
            // have something to observe; production code must never depend on either settling.
            //
            // Started here, BEFORE loadCrawlerCheckpoints below, not after it (schema v2's ordering):
            // manifestReadyPromise must already point at *this* session's pending work by the time
            // anything can call materializeIfPending, and that can happen as early as
            // loadCrawlerCheckpoints' own checkpoint decrypt -- this.hydrating is already true from
            // the top of this method, and a live write landing during that decrypt (review-pr-a.md's
            // F9) reaches materializeIfPending, which needs the manifest (to resolve an id to its
            // chunk) in a way schema v2's direct per-event get() never did. If this were assigned
            // only after loadCrawlerCheckpoints resolved, as before, such a call would await a
            // *stale*, already-resolved promise left over from a previous session rather than
            // genuinely waiting for anything -- resolving instantly into an empty manifest and
            // silently finding nothing. Safe to start this early because it touches only
            // `meta`/`chunks`, never `checkpoints`, so there is no race with the checkpoint load
            // itself; the failure branch below bumps hydrationEpoch precisely so any of this that is
            // still in flight self-aborts rather than writing into what the wipe is about to clear.
            const epoch = this.hydrationEpoch;
            const dek = this.dek;
            this.nextChunkId = existingMeta?.nextChunkId ?? 0;
            if (!existingMeta) {
                // A genuinely fresh install (no meta row existed before the save above): nothing to
                // load, since there is nothing on disk yet for this user at all.
                this.manifestLoaded = true;
                this.manifestReadyPromise = Promise.resolve();
            } else {
                this.manifestReadyPromise = this.loadManifest(
                    userId,
                    dek,
                    existingMeta.manifestPageCount ?? 0,
                    salt,
                    epoch,
                );
            }
            this.hydrationPromise = this.hydrate(userId, salt, epoch);

            const loaded = await this.loadCrawlerCheckpoints(userId);
            if (!loaded) {
                log.warn("EventIndex: a stored checkpoint could not be decrypted; wiping leftover for this user");
                // Nothing has been hydrated yet at this point (the manifest/hydrate work just
                // started above may still be in flight, but each of them checks `epoch` before
                // writing anything into memory, and the bump below is what makes that check fail),
                // so there is nothing in `chunks` to lose here that this session itself wrote --
                // unlike hydrate()'s own failure path, which has to undo however much of a restore
                // it had already completed.
                this.clearIndexMaps();
                this.hydrationEpoch++; // Invalidates the manifest/hydrate work just started above.
                await this.deleteUserRecords(userId);
                await this.saveMeta({
                    userId,
                    salt: encodeBase64(salt),
                    userVersion: 0,
                    manifestPageCount: 0,
                    nextChunkId: this.nextChunkId,
                });
                this.userVersion = 0;
                this.hydrating = false; // Nothing will hydrate after a wipe; the restore this flag guarded is over.
            } else if (!this.dek) {
                // this.dek was cleared by a concurrent closeEventIndex()/deleteEventIndex() landing in
                // the await above (loadCrawlerCheckpoints); hydrate()/the manifest phase would each
                // check this and return immediately anyway, but closing the window this.hydrating
                // opened at the top of this method here is more honest than leaving it to whichever
                // of them happens to notice first.
                this.hydrating = false;
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
     * running -- or has stopped early at the resident budget, leaving rows behind it un-hydrated; see {@link
     * residentBudgetExceeded} -- is worth a direct look at the disk row for `eventId` itself ({@link
     * materializeIfPending}, which pulls it in if there is one) so there is something here to remove rather than
     * treating "not decrypted yet" as "does not exist". And one that resolves to neither -- which, in either of
     * those states, can mean "this is an edit's id, and its original is a disk row not hydrated yet, so {@link
     * editTargets} cannot know about it" -- is parked in {@link pendingRedactions} for {@link materializeRow} to
     * drain as rows stream in, rather than being dropped as a no-op.
     *
     * `!this.hydrating` alone used to be reason enough to skip {@link materializeIfPending} outright (as an
     * optimisation -- that method's own guard makes the skip correct either way): once hydration is bounded, that
     * reasoning no longer holds on its own, since `hydrating` going false no longer implies every disk row has been
     * visited. `materializeIfPending` gates on the same {@link residentBudgetExceeded} condition internally, so this
     * check is only ever an optimisation, never a correctness gate of its own.
     *
     * @returns True if a record was removed; false when nothing matched (including a redaction just parked for
     *     later, which has removed nothing *yet*) and also when the index is closed, which callers do not need to
     *     distinguish.
     */
    public async deleteEvent(eventId: string): Promise<boolean> {
        if (this.closed) return false;
        // Resolve an edit's id to the record its content was folded into; see the doc above.
        let targetId = this.events.has(eventId) ? eventId : this.editTargets.get(eventId);
        if (targetId === undefined && (this.hydrating || this.residentBudgetExceeded)) {
            await this.materializeIfPending(eventId);
            targetId = this.events.has(eventId) ? eventId : this.editTargets.get(eventId);
        }
        if (targetId === undefined) {
            if (this.hydrating || this.residentBudgetExceeded) this.pendingRedactions.add(eventId);
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
     * migrateToV3}.
     *
     * Answered from IndexedDB directly with `IDBObjectStore.getKey()` over {@link userChunkKeyRange}
     * (the `chunks` primary key needs no index, unlike schema v2's `events`), which returns the
     * primary key of the first matching row without reading its value and was measured at ~0.5 ms
     * even at 50k rows for the equivalent `events` index lookup (`research/measurements-v1.md`) --
     * never `IDBIndex.count()`, which walks the whole index and was measured at 0.4-0.5 s at the same
     * size. This matters more than it once did: since {@link initEventIndex} no longer awaits {@link
     * hydrate}, {@link events} can be near-empty on a database that holds hundreds of thousands of
     * rows, and the caller above needs the honest answer the moment this resolves, not the eventual
     * one. Falls back to the in-memory check when there is nothing persisted to ask, which is also
     * the one case {@link events} cannot disagree with reality about. Also checks the legacy `events`
     * store, if it still exists: a user mid v2-to-v3 conversion can have real, unconverted history
     * sitting there and nothing in `chunks` yet.
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
        const chunkTx = this.db.transaction("chunks", "readonly");
        const chunkKey = await idbReq(chunkTx.objectStore("chunks").getKey(userChunkKeyRange(this.userId)));
        if (chunkKey !== undefined) return false;
        if (this.db.objectStoreNames.contains("events")) {
            const evTx = this.db.transaction("events", "readonly");
            const evKey = await idbReq(evTx.objectStore("events").index("byUser").getKey(this.userId));
            if (evKey !== undefined) return false;
        }
        return true;
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
     * O(1): this is called roughly every 3s while the Security panel is open (and now, per `useIsIndexIncomplete`, on
     * every checkpoint change while a `SearchWarning` is mounted), so it must not scan {@link events}. `eventCount` is
     * {@link events}' own `size` (a `Map` tracks its count already); `roomCount` is {@link roomOrder}'s own `size`
     * rather than a fresh `Set` built by walking every resident event's `roomId` -- correct because {@link
     * removeFromIndex} deletes a room's entry outright once its last event goes, so `roomOrder`'s key count is
     * always exactly the count of rooms with at least one resident event, the same value the old scan computed, and
     * re-deriving it by visiting every event was measured at 8.9-15.3 ms at 200k resident events, synchronous and
     * uninterruptible; `size` is {@link ciphertextBytes} or the incrementally-maintained {@link estimatePlainSize},
     * neither of which scan anything either.
     *
     * `windowed`, `oldestIndexedTs` and `oldestResidentTs` are every one of them plain scalar field
     * reads too -- see {@link diskBudgetDropped}, {@link crawlBoundDeclined}, {@link oldestIndexedTs}
     * and {@link oldestResidentTs} for how each is maintained -- so none of the three costs this
     * method anything it did not already cost.
     *
     * **`windowed` no longer includes {@link residentBudgetExceeded} (increment E).** Before the
     * streamed cold-tier scan existed, everything beyond the resident (hot-window) budget was
     * genuinely unfindable, so a resident-budget breach belonged in the same "something is excluded"
     * signal as a real crawl-bound decline or disk-budget drop. Now it is merely *slower* to find
     * (`research/SYNTHESIS.md` §7 decision #3), which is a wholly different thing to tell a user than
     * "not covered at all" -- conflating the two would make `windowed` fire, and `SearchWarning` show
     * the "Search covers messages newer than {date}" line with a date that understates real coverage,
     * on every large, ordinarily-healthy index. `windowed` now reflects only the crawl bound
     * ({@link crawlBoundDeclined}) and the disk budget ({@link diskBudgetDropped}) -- the two ways
     * content can be genuinely absent from disk, as opposed to merely absent from memory.
     *
     * `manifestBytes` is {@link manifest}'s own share of {@link residentByteEstimate} (review-pr-c.md
     * C2-F2) -- `manifest.size * MANIFEST_BYTES_PER_ENTRY_ESTIMATE`, another O(1) `Map.size` read.
     *
     * `isSearchPartial` (increment E) is {@link searchPartial}, a plain scalar set by the most recent
     * {@link searchEventIndex} call; see that field's own docstring.
     */
    public async getStats(): Promise<IIndexStats> {
        return {
            size: this.ciphertextBytes || this.estimatePlainSize(),
            eventCount: this.events.size,
            roomCount: this.roomOrder.size,
            loading: this.hydrating,
            windowed: this.diskBudgetDropped || this.crawlBoundDeclined,
            oldestIndexedTs: this.oldestIndexedTs,
            oldestResidentTs: this.oldestResidentTs,
            storagePersisted: this.storagePersisted,
            manifestBytes: this.manifest.size * MANIFEST_BYTES_PER_ENTRY_ESTIMATE,
            isSearchPartial: this.searchPartial,
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
     * Run a query against the in-memory index, then -- if that alone did not already reach the page cap -- a streamed
     * scan of on-disk content the resident set does not cover; see {@link BaseEventIndexManager.searchEventIndex}.
     * The hot-path pipeline (unchanged from before increment E): tokenise the query exactly as indexed text was and
     * intersect the per-term match sets, so a result must contain *every* term (terms of two characters or more also
     * match by prefix, so results narrow while the user is still typing); fall back to a substring scan ({@link
     * substringHits}) if that found nothing; filter by room; sort by recency if asked.
     *
     * **The cold tier (increment E, `research/SYNTHESIS.md` §3.4/§7 decision #3).** Old retained messages stay
     * findable, just found slower: if the hot hits alone are fewer than `SEARCH_PAGE_CAP` (`2 * limit`) and this
     * user's manifest knows of on-disk events this session does not hold resident, {@link coldSearchScan} streams a
     * newest-first read of the chunks the hot path could not see, applying the *same* matching semantics
     * (token AND + prefix, or the folded substring fallback -- whichever the hot path itself used for this query) to
     * each decrypted record, appended newest-first **after** the hot hits, deduplicated by eventId against both the
     * resident set and anything already found. This is why `hits`/pagination below speak of "hot" and "cold"
     * separately rather than one flat array: the cold half is only ever discovered as far as a page actually needs,
     * never materialised in full up front.
     *
     * **Context for a cold hit comes from the same chunk's own decrypted neighbours** ({@link coldContextFor}),
     * bounded to that one chunk's population (tens of records) -- not a second disk read of manifest neighbours.
     * Chosen because the chunk is already decrypted and resident in memory at the moment a match is found in it, so
     * this needs no extra I/O and keeps "at most one decrypted chunk in memory at a time" exactly true; the
     * trade-off is that a hit whose true neighbours in the room's timeline landed in an *adjacent* chunk (the crawl
     * interleaves rooms, so this is possible) will show a shorter context than {@link contextFor}'s disk-independent,
     * whole-room-order view gives a hot hit -- an accepted, bounded degradation, not a silent gap: nothing pretends
     * these are more complete than they are.
     *
     * **Cancellation.** A new call bumps {@link searchEpoch}; a scan already in flight for an older call notices at
     * its next `await` (a chunk decrypt or a slice yield) and returns whatever it has rather than continuing to
     * decrypt chunks or hold the event loop for a result nothing will use. No transaction is ever held across an
     * await here to begin with ({@link BrowserEventIndexManager.readChunkEntries} closes its own before decrypting),
     * so cancellation only ever stops *further* reads, never interrupts one already open.
     *
     * Never needs to flush {@link liveWriteBuffer} first: every structure this reads -- {@link events}, {@link
     * inverted}, {@link roomOrder} -- is updated synchronously by {@link upsertEvent} the moment a live event is
     * indexed, before {@link schedulePersistEvent} ever buffers anything for disk. A live event is therefore
     * searchable immediately, seconds before its encrypted copy exists anywhere.
     *
     * @param searchArgs - `search_term` is the raw user input; `room_id` scopes the search (and, once the cold tier
     *     is reached, restricts the chunk walk itself to chunks holding at least one of that room's events -- see
     *     {@link newestFirstChunkWalk}); `order_by_recency` sorts newest first rather than leaving the index's own
     *     iteration order (the hot half only -- cold hits are always appended newest-first regardless); `limit` is
     *     the page size, where a missing or zero value means 10 and a negative one clamps to 1; `before_limit`/
     *     `after_limit` ask for context events either side of each hit; `next_batch` is an opaque token from a
     *     previous call -- see {@link parseSearchCursor}/{@link ColdSearchCursor} for its two possible shapes.
     * @returns The page. `count` is the total number of matches *known so far* (hot plus every cold hit discovered
     *     across this query's pages), which can be less than the true total while {@link searchPartial}/{@link
     *     IIndexStats.isSearchPartial} is true; `highlights` the query's terms (returned even for an empty result,
     *     so the UI can mark them); `next_batch` the token for the following page.
     */
    public async searchEventIndex(searchArgs: ISearchArgs): Promise<IResultRoomEvents> {
        const tokens = tokenize(searchArgs.search_term);
        const empty: IResultRoomEvents = { count: 0, results: [], highlights: tokens, next_batch: undefined };
        if (this.closed) return empty;

        // Cancels any older call's still-running cold scan; see this method's own docstring.
        const epoch = ++this.searchEpoch;

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
        // reaches that whole-word terms cannot. Captured before `ids` is replaced: the cold-tier scan below must
        // apply the *same* decision (token-AND vs substring), not re-derive its own independently of what the hot
        // path just did.
        const useSubstring = !ids || ids.size === 0;
        if (useSubstring) {
            ids = this.substringHits(searchArgs.search_term, searchArgs.room_id);
        }

        // Resolve ids to records, dropping any that have gone: a redaction between matching and reading must not become
        // an undefined result. Room scoping is applied here rather than inside the index, there being no per-room
        // posting lists.
        let hotHits = Array.from(ids ?? [], (eventId) => this.events.get(eventId)).filter(
            (e): e is StoredEvent => Boolean(e),
        );
        if (searchArgs.room_id) {
            hotHits = hotHits.filter((e) => e.roomId === searchArgs.room_id);
        }

        // Newest first when the caller asks. Otherwise the order is whatever fell out of the Set iteration above:
        // deterministic for a given index state, but derived from insertion order rather than from any notion of
        // relevance, which nothing here computes. Cold hits (below) are always appended newest-first regardless of
        // this flag -- they come from a disk scan that only ever walks newest-first, there being no cheap way to
        // walk it any other way.
        if (searchArgs.order_by_recency) {
            hotHits.sort((a, b) => b.originServerTs - a.originServerTs);
        }
        // Deliberately no "hot found nothing, return empty" short-circuit here (unlike the
        // pre-increment-E code): a query the resident index cannot answer at all is exactly the
        // case the cold-tier scan below exists for (hits lying entirely beyond the hot window).

        const limit = Math.max(1, searchArgs.limit || 10);
        // SEARCH_PAGE_CAP (research/SYNTHESIS.md §3.7): the ceiling on hot+cold hits this query will ever
        // accumulate across every page, hot and cold alike -- Proton's own `hybridSearch` cap, "two pages" at the
        // default page size. Once reached, {@link searchPartial}/`isSearchPartial` goes true and the scan stops
        // rather than walking the rest of this user's disk for one query.
        const pageCap = 2 * limit;
        const beforeLimit = Math.max(0, searchArgs.before_limit || 0);
        const afterLimit = Math.max(0, searchArgs.after_limit || 0);

        // Pagination is a plain offset either way. Backward compatible: a token this query's own cold scan never
        // touches (the overwhelming majority -- everything the pre-increment-E suite already exercises) keeps the
        // exact bare-decimal `next_batch` format and parsing that predates this increment; only a query whose scan
        // actually reaches disk switches to the richer {@link ColdSearchCursor} JSON shape. See {@link
        // parseSearchCursor}.
        const cursor = this.parseSearchCursor(searchArgs.next_batch);
        const requestedOffset = cursor.offset;
        // Pinned at the call that first touched the cold tier for this query, not recomputed on every later page --
        // see {@link ColdSearchCursor}'s own docstring for why (the same "recomputed from memory, so a write
        // between pages can shift things" best-effort contract the plain offset above already has, just extended).
        const hotCount = cursor.hotCount ?? hotHits.length;
        const alreadyHaveCold = Math.max(0, requestedOffset - hotCount);

        const needsMoreThanHot = requestedOffset + limit > hotCount;
        const diskHasColdContent = this.manifest.size > this.events.size;

        // The hot slice for *this page* -- computed before the cold scan, not just before building
        // `pageItems` below, because how much cold content this call needs to look for depends on it:
        // asking the scan for more than the page can absorb would find genuine matches this call then
        // has nowhere to put, and -- since the resume cursor advances to wherever the scan actually
        // stopped -- those over-fetched matches would be skipped as "already emitted" by a later page
        // that never actually saw them. Bounding `need` to exactly this page's remaining room is what
        // keeps the resume cursor's position exactly aligned with what was actually served.
        const hotSlice = requestedOffset < hotHits.length ? hotHits.slice(requestedOffset, requestedOffset + limit) : [];

        let coldHits: Array<{ stored: StoredEvent; context: ColdContext }> = [];
        let chunkIdx = cursor.chunkIdx;
        let within = cursor.within;
        let coldExhausted = cursor.coldExhausted;
        if (needsMoreThanHot && hotCount < pageCap && diskHasColdContent && !coldExhausted && !this.closed) {
            const coldNeededForPage = limit - hotSlice.length;
            const coldRoomUnderCap = pageCap - hotCount - alreadyHaveCold;
            const need = Math.min(coldNeededForPage, coldRoomUnderCap);
            if (need > 0) {
                const resident = new Set(hotHits.map((h) => h.eventId));
                const scan = await this.coldSearchScan({
                    tokens,
                    useSubstring,
                    rawQuery: searchArgs.search_term,
                    roomId: searchArgs.room_id,
                    startChunkIdx: cursor.chunkIdx,
                    startWithin: cursor.within,
                    need,
                    epoch,
                    excludeIds: resident,
                    beforeLimit,
                    afterLimit,
                });
                coldHits = scan.hits;
                chunkIdx = scan.chunkIdx;
                within = scan.within;
                coldExhausted = scan.exhausted;
            }
        }
        const coldTouchedThisQuery = alreadyHaveCold > 0 || coldHits.length > 0 || coldExhausted;

        // This page: the hot slice already computed above, plus every cold hit this call's own scan
        // found -- `coldHits` is never larger than this page's own remaining room (`need` above), so
        // no further slicing is needed to fit it; it is still bounded defensively rather than
        // trusted, in case a future change to the scan's own stopping condition ever overshoots.
        const pageItems: Array<{ stored: StoredEvent; coldContext?: ColdContext }> = hotSlice.map((stored) => ({
            stored,
        }));
        for (const hit of coldHits.slice(0, limit - pageItems.length)) {
            pageItems.push({ stored: hit.stored, coldContext: hit.context });
        }

        const totalKnown = hotCount + alreadyHaveCold + coldHits.length;
        const nextOffset = requestedOffset + pageItems.length;
        // "Partial" in the SEARCH_PAGE_CAP sense: the scan stopped with (as far as this session knows) more on-disk
        // content left to look at. Independent of whether *this page* has a next_batch -- see this field's own
        // docstring for why it is a last-search stats signal, not a per-result one.
        this.searchPartial = coldTouchedThisQuery && !coldExhausted && totalKnown >= pageCap;

        // A page this call's cold tier never touched keeps the exact pre-increment-E, uncapped
        // pagination contract (`offset + page.length < hits.length`, `hits.length` here being
        // `hotHits.length`) -- nothing about a purely-resident query changes.
        //
        // Once the cold tier is involved, `next_batch` is offered *optimistically* whenever this page
        // came back completely full (`limit` items) and the page cap has not yet been reached: this
        // call's own `need` is bounded to what *this* page needed, so a full page does not by itself
        // prove more exists (unlike the pre-increment-E, unbounded-count case) -- the next call's own
        // scan is what settles that, either finding more (another full-or-partial page) or coming back
        // short (a page under `limit`, which stops offering a token, ending the query there). This is
        // the trade this increment makes for keeping a resumed scan's position exactly aligned with
        // what was actually served (see `hotSlice`'s own comment above): at most one extra, possibly
        // short, round trip at the very end of a query's content, never a wrong or skipped result.
        const next_batch = !coldTouchedThisQuery
            ? nextOffset < hotHits.length
                ? String(nextOffset)
                : undefined
            : pageItems.length === limit && totalKnown < pageCap
              ? this.encodeSearchCursor({ offset: nextOffset, hotCount, chunkIdx, within, coldExhausted })
              : undefined;

        const results = pageItems.map((item, i) => {
            const context = item.coldContext ?? this.contextFor(item.stored, beforeLimit, afterLimit);
            return {
                // `rank` is positional, not a relevance score, and nothing should read a meaning into its magnitude. It
                // is 1/n over the hit's position in the *whole* result set rather than in the page, so any consumer
                // that sorts by rank reproduces the order chosen above. Seshat puts a real BM25 score here; the
                // substitution is safe only because nothing in Element reads it.
                rank: 1 / (requestedOffset + i + 1),
                result: this.resultEvent(item.stored.event),
                context,
            };
        });

        return {
            count: totalKnown,
            results,
            highlights: tokens,
            next_batch,
        };
    }

    /**
     * Parse a `next_batch` token into {@link ColdSearchCursor}, accepting both shapes this class has ever produced:
     * a bare decimal offset (the format used before increment E, and still used by any query whose cold tier this
     * query's scan never touches) or the JSON {@link ColdSearchCursor} shape a cold-touching query now produces.
     * `undefined`/empty, and anything that parses as neither, all resolve to offset 0 with no cold-scan state --
     * "a malformed token resolves to offset 0 rather than throwing at the user", the same contract this had before
     * increment E, now extended to a second token shape.
     */
    private parseSearchCursor(token: string | undefined): ColdSearchCursor {
        const none: ColdSearchCursor = { offset: 0, chunkIdx: 0, within: 0, coldExhausted: false };
        if (!token) return none;
        if (/^\d+$/.test(token)) {
            return { ...none, offset: Number.parseInt(token, 10) || 0 };
        }
        try {
            const parsed: unknown = JSON.parse(token);
            if (
                parsed &&
                typeof parsed === "object" &&
                typeof (parsed as ColdSearchCursor).offset === "number" &&
                typeof (parsed as ColdSearchCursor).chunkIdx === "number" &&
                typeof (parsed as ColdSearchCursor).within === "number"
            ) {
                const p = parsed as ColdSearchCursor;
                return {
                    offset: p.offset,
                    hotCount: typeof p.hotCount === "number" ? p.hotCount : undefined,
                    chunkIdx: p.chunkIdx,
                    within: p.within,
                    coldExhausted: Boolean(p.coldExhausted),
                };
            }
        } catch {
            // Malformed JSON: fall through to `none`, same as any other unrecognised token.
        }
        return none;
    }

    /** The inverse of {@link parseSearchCursor}, for a query whose scan has touched the cold tier. */
    private encodeSearchCursor(cursor: ColdSearchCursor): string {
        return JSON.stringify(cursor);
    }

    /**
     * The newest-first walk order {@link coldSearchScan} reads chunks in: every chunk id this session knows about
     * (from {@link chunkMembers}, no I/O), ranked by that chunk's own newest member `originServerTs` -- exactly
     * {@link hydrate}'s own chunk-ordering computation (see its docstring for why *chunk* `maxTs`, not a per-event
     * sort, is both cheap and the right newest-first notion once storage is chunked), reused here rather than
     * duplicated with different rounding. Room-scoped when `roomId` is given: {@link manifestRoomIds} names every id
     * in that room, and {@link manifest} each one's chunk, so the walk can skip a chunk with nothing from this room
     * without ever decrypting it -- "use the manifest's roomId" rather than filtering post-decrypt.
     *
     * Sliced across {@link HYDRATION_SLICE_DEADLINE_MS} the same way {@link hydrate}'s own seeding pass is (a chunk
     * count in the thousands, not the hundreds of thousands, but each one still costs a pass over its own
     * membership); `null` if `epoch` was superseded or the index closed mid-walk, which {@link coldSearchScan}
     * treats as "found nothing more this call" rather than throwing.
     */
    private async newestFirstChunkWalk(roomId: string | undefined, epoch: number): Promise<number[] | null> {
        const relevantChunkIds = roomId
            ? new Set(
                  Array.from(this.manifestRoomIds.get(roomId) ?? [], (id) => this.manifest.get(id)?.chunkId).filter(
                      (id): id is number => id !== undefined,
                  ),
              )
            : null;
        const chunkMaxTs = new Map<number, number>();
        let sliceStart = now();
        for (const [chunkId, members] of this.chunkMembers) {
            if (relevantChunkIds && !relevantChunkIds.has(chunkId)) continue;
            if (this.closed || this.searchEpoch !== epoch) return null;
            let max = -Infinity;
            for (const id of members) {
                const ts = this.manifest.get(id)?.ts;
                if (ts !== undefined && ts > max) max = ts;
            }
            if (max > -Infinity) chunkMaxTs.set(chunkId, max);
            if (now() - sliceStart >= HYDRATION_SLICE_DEADLINE_MS) {
                await yieldToEventLoop();
                if (this.closed || this.searchEpoch !== epoch) return null;
                sliceStart = now();
            }
        }
        return Array.from(chunkMaxTs.entries())
            .sort((a, b) => b[1] - a[1])
            .map((pair) => pair[0]);
    }

    /**
     * Whether `stored` matches every one of `tokens`, the cold-tier analogue of {@link searchEventIndex}'s
     * resident-index term-AND-with-prefix path: `stored` has no posting-list entry (it is not indexed -- that is
     * the whole reason it is being checked here rather than found via {@link lookupToken}), so this tokenises its
     * own {@link StoredEvent.searchText} on the spot and checks each query token against that small, per-record set
     * directly -- an exact match, or (mirroring {@link lookupToken}'s own `token.length >= 2` guard) a prefix match
     * against any of the record's own tokens. Cheap: a record's own token count is tens, not the whole vocabulary.
     */
    private coldRecordMatchesTokens(stored: StoredEvent, tokens: string[]): boolean {
        if (tokens.length === 0) return false;
        const recordTokens = tokenize(stored.searchText);
        for (const token of tokens) {
            if (recordTokens.includes(token)) continue;
            if (token.length >= 2 && recordTokens.some((t) => t.startsWith(token))) continue;
            return false;
        }
        return true;
    }

    /**
     * Context for a cold hit, sourced from the *same already-decrypted chunk*'s own other members -- see {@link
     * searchEventIndex}'s own docstring for why this, rather than a further disk read by manifest neighbours, is
     * what this increment implements: no extra I/O, and "at most one decrypted chunk in memory at a time" stays
     * exactly true. Bounded to that chunk's own population (tens of records, {@link CHUNK_TARGET_BYTES}'s own
     * sizing) -- a genuine neighbour that happens to live in an *adjacent* chunk (rooms interleave across chunks by
     * write order, not by room) is not reached, which can make a cold hit's context shorter than a hot hit's own
     * whole-room-order {@link contextFor} would give the same position. Mirrors {@link contextFor}'s own shape
     * (timeline-ordered before/after plus `profile_info`) so the two are interchangeable to a caller.
     */
    private coldContextFor(chunkEntries: Map<string, StoredEvent>, hit: StoredEvent, beforeLimit: number, afterLimit: number): ColdContext {
        const roomList = Array.from(chunkEntries.values())
            .filter((e) => e.roomId === hit.roomId)
            .sort((a, b) => a.originServerTs - b.originServerTs);
        const idx = roomList.findIndex((e) => e.eventId === hit.eventId);
        const beforeEvents = idx >= 0 ? roomList.slice(Math.max(0, idx - beforeLimit), idx) : [];
        const afterEvents = idx >= 0 ? roomList.slice(idx + 1, idx + 1 + afterLimit) : [];
        const events_before = beforeEvents.map((ev) => this.resultEvent(ev.event));
        const events_after = afterEvents.map((ev) => this.resultEvent(ev.event));
        const profile_info: Record<string, IMatrixProfile> = {};
        for (const ev of [hit, ...beforeEvents, ...afterEvents]) {
            if (ev.event.sender) profile_info[ev.event.sender] = ev.profile;
        }
        return { events_before, events_after, profile_info };
    }

    /**
     * The streamed newest-first disk scan {@link searchEventIndex} runs once the resident index alone has not
     * reached `SEARCH_PAGE_CAP`: walk {@link newestFirstChunkWalk}'s order starting at `startChunkIdx`/`startWithin`
     * (a fresh query starts both at 0), reading and decrypting **one chunk at a time** -- {@link decryptChunkOnce},
     * shared with any concurrent {@link hydrate}/{@link materializeIfPending} call decrypting the same chunk, so a
     * scan racing hydration's own admission neither double-decrypts nor double-returns an event hydration just made
     * resident (checked live via `this.events.has(id)`, not a snapshot taken before the scan started) -- evaluating
     * `useSubstring ? folded-substring : token-AND-with-prefix` ({@link coldRecordMatchesTokens}) against every
     * member not already resident or in `excludeIds` (the hot hits), newest-member-first within the chunk to match
     * {@link hydrate}'s own admission order.
     *
     * On `startChunkIdx` only, the first `startWithin` *matches* (not raw entries) are skipped without being
     * re-emitted -- they are what an earlier call already returned; see {@link ColdSearchCursor}'s own docstring.
     * A chunk whose disk row is gone by the time it is read (the disk budget dropped it between the walk being
     * computed and this reaching it) decrypts to an empty map ({@link readChunkEntries}'s own contract) and is
     * simply skipped, never thrown; a chunk that fails to decrypt for any other reason is logged and skipped the
     * same way, rather than aborting the whole query over one bad chunk.
     *
     * Stops, and returns a resume position, as soon as: `need` new hits have been found; the chunk walk is
     * exhausted (`exhausted: true`, nothing left on disk for this query); or `epoch` is superseded ({@link
     * searchEpoch}) or the index closes, in which case cancellation must not leave a slice or a transaction
     * running -- checked after every `await` (a decrypt, a slice yield), the same discipline {@link hydrate} uses.
     * Sliced in {@link HYDRATION_SLICE_DEADLINE_MS} deadlines with the existing {@link yieldToEventLoop} helper.
     */
    private async coldSearchScan(opts: {
        tokens: string[];
        useSubstring: boolean;
        rawQuery: string;
        roomId: string | undefined;
        startChunkIdx: number;
        startWithin: number;
        need: number;
        epoch: number;
        excludeIds: Set<string>;
        beforeLimit: number;
        afterLimit: number;
    }): Promise<{ hits: Array<{ stored: StoredEvent; context: ColdContext }>; chunkIdx: number; within: number; exhausted: boolean }> {
        const hits: Array<{ stored: StoredEvent; context: ColdContext }> = [];
        const notFound = { hits, chunkIdx: opts.startChunkIdx, within: opts.startWithin, exhausted: false };
        if (opts.need <= 0 || !this.dek || !this.db || !this.userId || this.closed) return notFound;
        const userId = this.userId;
        const dek = this.dek;
        const foldedQuery = flattenCopy(foldText(opts.rawQuery)).replace(/\s+/g, " ").trim();
        if (opts.useSubstring && foldedQuery.length < 3) return { ...notFound, exhausted: true };

        const walk = await this.newestFirstChunkWalk(opts.roomId, opts.epoch);
        if (walk === null) return notFound; // Cancelled or closed mid-walk-computation.

        let sliceStart = now();
        for (let ci = opts.startChunkIdx; ci < walk.length; ci++) {
            if (this.closed || this.searchEpoch !== opts.epoch) return { ...notFound, chunkIdx: ci, within: 0 };

            const chunkId = walk[ci];
            const members = this.chunkMembers.get(chunkId);
            // Cheap, no-I/O skip: every member of this chunk is already resident, so the hot path already found
            // (or ruled out) everything in it -- nothing cold to decrypt for.
            if (!members || Array.from(members).every((id) => this.events.has(id))) continue;

            let entries: Map<string, StoredEvent>;
            try {
                entries = await this.decryptChunkOnce(userId, dek, chunkId);
            } catch (e) {
                log.debug("EventIndex: cold scan could not read a chunk; skipping it", e);
                continue;
            }
            if (this.closed || this.searchEpoch !== opts.epoch) return { ...notFound, chunkIdx: ci, within: 0 };
            if (entries.size === 0) continue; // Deleted by the disk budget between the walk and this read.

            const orderedIds = Array.from(entries.keys()).sort(
                (a, b) => (entries.get(b)?.originServerTs ?? 0) - (entries.get(a)?.originServerTs ?? 0),
            );

            let matchIndex = 0;
            for (const id of orderedIds) {
                // this.events: already resident, the hot path already covers it. excludeIds: already
                // returned this call. pendingDiskDeletes: removed from the resident set by a genuine
                // deletion whose disk rewrite has not committed yet -- see that field's own docstring
                // for why a plain `events.has` check alone cannot see this window.
                // this.events: already resident, the hot path already covers it. excludeIds: already
                // returned this call. pendingDiskDeletes: removed from the resident set by a genuine
                // deletion whose disk rewrite has not committed yet (the window *before*
                // manifestRemove runs). !manifest.has(id): the authoritative "is this id still on
                // disk at all, right now" check, live against the current manifest rather than the
                // snapshot `entries` was decrypted from -- closes the *other* window, where this
                // chunk's own ciphertext was read (started) before a concurrent deletion's
                // manifestRemove + disk commit landed, but this loop only inspects the result after
                // both had already finished: `entries` is then a stale pre-deletion snapshot even
                // though pendingDiskDeletes has *also* already been cleared (the deletion's own
                // `finally` runs after both manifestRemove and the disk write) -- a real race hit
                // empirically (R9's flake) that pendingDiskDeletes alone does not close, because the
                // two checks guard non-overlapping windows of the same deletion's lifetime.
                if (
                    this.events.has(id) ||
                    opts.excludeIds.has(id) ||
                    this.pendingDiskDeletes.has(id) ||
                    !this.manifest.has(id)
                ) {
                    continue;
                }
                const stored = entries.get(id)!;
                if (opts.roomId && stored.roomId !== opts.roomId) continue;
                const isMatch = opts.useSubstring
                    ? flattenCopy(foldText(stored.searchText)).includes(foldedQuery)
                    : this.coldRecordMatchesTokens(stored, opts.tokens);
                if (!isMatch) continue;

                if (ci === opts.startChunkIdx && matchIndex < opts.startWithin) {
                    matchIndex++;
                    continue; // Already emitted by an earlier call.
                }
                matchIndex++;

                hits.push({ stored, context: this.coldContextFor(entries, stored, opts.beforeLimit, opts.afterLimit) });
                if (hits.length >= opts.need) return { hits, chunkIdx: ci, within: matchIndex, exhausted: false };

                if (now() - sliceStart >= HYDRATION_SLICE_DEADLINE_MS) {
                    await yieldToEventLoop();
                    if (this.closed || this.searchEpoch !== opts.epoch) {
                        return { hits, chunkIdx: ci, within: matchIndex, exhausted: false };
                    }
                    sliceStart = now();
                }
            }
        }
        return { hits, chunkIdx: walk.length, within: 0, exhausted: true };
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
                    this.plainTextByteEstimate += nextText.length - existing.searchText.length;
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
     * The crawl bound; see {@link BaseEventIndexManager.shouldCrawl}. Three independent reasons to
     * decline, each sufficient on its own (`research/SYNTHESIS.md` §3.5):
     *
     * 1. This room's crawl has already reached `CRAWL_WINDOW_DAYS` back, per {@link
     *    manifestOldestByRoom} -- **not** {@link roomOrder}, which is the resident set and which
     *    eviction edits: answering this from `roomOrder` let a room's own eviction erase how far its
     *    crawl had gone, so the window check would pass again and the crawler would walk backwards
     *    past the window it had already satisfied (`research/review-pr-c.md` C-F2, "fetch, write,
     *    delete, repeat"). The manifest does not shrink on eviction, only on an actual disk delete,
     *    so this floor survives exactly the case that broke the previous version.
     * 2. The checkpoint's room has fallen out of the top `CRAWL_ROOM_CAP` rooms by most recent
     *    *manifest* activity ({@link roomsByManifestRecency}), again not resident activity: a fully
     *    evicted room has no `roomOrder` entry at all and used to fall through to "cannot be ranked,
     *    let it through" -- exactly the rooms the cap exists to exclude, since the least recently
     *    active rooms are the ones eviction reaches first (C-F3).
     * 3. `clientRoomRank` (supplied only by {@link EventIndex.addInitialCheckpoints}, for a fresh
     *    index with no manifest activity for any room yet to rank by) is at or past `CRAWL_ROOM_CAP`
     *    (C-F4): without this, the cap could never decline anything on the one path that seeds every
     *    room's very first checkpoint, because nothing has been indexed for *any* room yet.
     *
     * A room with no manifest entries and no `clientRoomRank` (every caller except
     * `addInitialCheckpoints`, for a room genuinely never seen) cannot be ranked or windowed by
     * either signal, and is let through rather than guessed at -- the same conservative default as
     * before, now also the default while {@link manifestLoaded} is still false (a checkpoint asked
     * about before the manifest has finished loading gets a real answer next time it comes up).
     */
    public async shouldCrawl(checkpoint: ICrawlerCheckpoint, clientRoomRank?: number): Promise<boolean> {
        const bounds = getEventIndexBounds();
        const roomIds = this.manifestLoaded ? this.manifestRoomIds.get(checkpoint.roomId) : undefined;

        if (roomIds && roomIds.size > 0) {
            const oldestTs = this.manifestOldestByRoom.get(checkpoint.roomId) ?? 0;
            if (oldestTs > 0 && Date.now() - oldestTs > bounds.crawlWindowDays * DAY_MS) {
                this.crawlBoundDeclined = true;
                return false;
            }
            if (this.roomsByManifestRecency().indexOf(checkpoint.roomId) >= bounds.crawlRoomCap) {
                this.crawlBoundDeclined = true;
                return false;
            }
            return true;
        }

        if (clientRoomRank !== undefined && clientRoomRank >= bounds.crawlRoomCap) {
            this.crawlBoundDeclined = true;
            return false;
        }
        return true;
    }

    /**
     * Every room with at least one manifest entry, ordered by that room's most recently *indexed*
     * (ever, on disk, per {@link manifestNewestByRoom}) event first. The ranking {@link
     * shouldCrawl} enforces `CRAWL_ROOM_CAP` against; survives eviction because the manifest does
     * (see {@link manifest}'s own docstring). `O(R log R)` in the number of *rooms* the manifest
     * knows about, not events, and only ever called once per checkpoint the crawler is about to
     * spend a request on, never per event.
     */
    private roomsByManifestRecency(): string[] {
        const withTs: Array<[roomId: string, ts: number]> = [];
        for (const [roomId, ids] of this.manifestRoomIds) {
            if (ids.size === 0) continue;
            withTs.push([roomId, this.manifestNewestByRoom.get(roomId) ?? 0]);
        }
        withTs.sort((a, b) => b[1] - a[1]);
        return withTs.map(([roomId]) => roomId);
    }

    /**
     * Encrypt {@link oldestIndexedTs}'s current value for persistence, if it has one, the same
     * "encrypt before the transaction opens" discipline {@link prepareManifestPageWrites} follows
     * (review-pr-c.md C2-F4). Deliberately **not** derived from {@link manifestOldestByRoom} at
     * read time -- that map is intentionally left *stale* on a partial removal (see its own
     * docstring, C-F2's fix), which is the safe direction for a per-room crawl floor but is the
     * *wrong* direction here: this value must move **forward** whenever a disk-budget deletion
     * drops rows, or `SearchWarning` would claim coverage back further than genuinely survives.
     * {@link oldestIndexedTs} itself is still maintained incrementally, in memory, exactly as
     * before every one of C2-F4's changes (the same `Math.min`/`Math.max` call sites); only *where*
     * it is persisted changed, from a cleartext `meta` field to this encrypted row. Returns `null`
     * when there is nothing to write, so a caller with no manifest yet (a brand-new index) does not
     * write a spurious record. Takes the value to persist as a parameter, rather than reading
     * `this.oldestIndexedTs` directly, because every caller here follows the class's usual
     * "compute the new value locally, encrypt it before the transaction opens, only assign
     * `this.oldestIndexedTs` once the transaction has committed" ordering, and reading the field
     * here would read the *old*, not-yet-updated value.
     */
    private async prepareOldestIndexedTsWrite(
        userId: string,
        dek: CryptoKey,
        ts: number | undefined,
    ): Promise<ManifestPageRecord | null> {
        if (ts === undefined) return null;
        const key = oldestIndexedTsKey(userId);
        const blob = await encryptJson(dek, { ts }, key);
        return { userId: key, blob };
    }

    /**
     * Read and decrypt {@link oldestIndexedTs}'s persisted value, if any -- the counterpart to
     * {@link prepareOldestIndexedTsWrite}, called once by {@link loadManifest}. A row that is simply
     * absent (a pre-C2-F4 manifest-having database, or a brand-new index) is `undefined`, not an
     * error. A row that fails to **decrypt** is the caller's problem, not this method's -- it
     * throws, and {@link loadManifest} responds exactly like a manifest-page decrypt failure does
     * (a rotated key looks identical either way).
     */
    private async loadOldestIndexedTs(userId: string, dek: CryptoKey): Promise<number | undefined> {
        if (!this.db) return undefined;
        const key = oldestIndexedTsKey(userId);
        let row: ManifestPageRecord | undefined;
        try {
            const tx = this.db.transaction("meta", "readonly");
            row = (await idbReq(tx.objectStore("meta").get(key))) as ManifestPageRecord | undefined;
            await txDone(tx);
        } catch (e) {
            log.warn("EventIndex: could not read the persisted oldestIndexedTs row; treating it as absent", e);
            return undefined;
        }
        if (!row) return undefined;
        const { ts } = await decryptJson<{ ts: number }>(dek, row.blob, key);
        return ts;
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
     *
     * **Out of scope for increment E's cold tier, deliberately.** Unlike {@link searchEventIndex},
     * this only ever reads {@link roomOrder}/{@link events} -- the resident set -- so a file older
     * than the hot window is not listed here even though it is still findable by a text search that
     * happens to match it. Left as a named follow-up rather than extended in this increment: the
     * Files panel has no page-cap/streamed-scan precedent to extend from the way search's own
     * pagination does, and giving it one is a separate, larger design question (a bounded scan
     * keyed on `hasFile` rather than on search terms) than this increment's brief covers.
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
            const previousTextLength = existing.searchText.length;
            existing.event = {
                ...existing.event,
                content: incoming.content,
            };
            existing.searchText = extractSearchText(existing.event);
            this.plainTextByteEstimate += existing.searchText.length - previousTextLength;
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
            // The record has moved in time, so its place in the room's ordered list has to move with
            // it. Deliberately NOT pushed to residentHeap here -- see that field's own docstring for
            // why it is populated only once a write actually commits, never at the moment a record
            // becomes resident or re-timed: this case already schedules a fresh persist for the
            // record (whichever caller reaches here goes on to call schedulePersistEvent or
            // enqueueBatchedWrite), and that write's own flush will push a heap entry carrying the
            // *current* ts once it lands, which is both correct and one call site's worth of code
            // rather than two.
            if (existing.originServerTs !== previousTs) {
                this.reindexRoomOrder(existing);
                this.oldestResidentTs =
                    this.oldestResidentTs === undefined
                        ? existing.originServerTs
                        : Math.min(this.oldestResidentTs, existing.originServerTs);
            }
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
        this.plainTextByteEstimate += stored.searchText.length + 64;
        if (origId) this.rememberEdit(stored, ev.event_id);
        this.indexTokens(targetId, stored.searchText);
        this.insertRoomOrder(stored);
        this.oldestResidentTs =
            this.oldestResidentTs === undefined
                ? stored.originServerTs
                : Math.min(this.oldestResidentTs, stored.originServerTs);
        // Deliberately NOT pushed to residentHeap and NOT running enforceResidentBudget here --
        // see residentHeap's own docstring for why eviction candidacy is granted only once a write
        // actually commits ({@link flushLiveWrites}), never at the moment of insertion. Measured,
        // not assumed: an earlier version did both here, and a fast crawler ingest (every one of a
        // batch's ~100 events inserted before that batch's own write has committed, let alone any
        // later batch's -- `enqueueBatchedWrite` never awaits) meant residentHeap held up to the
        // entire remaining corpus as "not yet durable" for most of the run, and this class's
        // backward-crawl delivery order (progressively *older* content, batch over batch) means
        // those not-yet-durable entries are also usually the current heap minimum -- exactly what
        // eviction pops first. Every attempted eviction therefore walked (and re-pushed) most of
        // the heap to find nothing durable to evict, on every one of 200k inserts: O(heap size) per
        // call, on every call, quadratic overall, and it turned a ~2.5s ingest loop into one that
        // did not finish inside a 15-minute harness timeout.
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
     * re-inserting it. {@link materializeRow} itself carries the one Map-lookup guard (`events.has()` before its own
     * `set`) that keeps a bug reaching this function from becoming a silent duplicate rather than a caller's own
     * mistake to fix.
     *
     * review-pr-d.md D-R6 proposed deferring this during {@link hydrate}'s bulk loop into a per-room
     * pending list, merged in later in one linear pass, to avoid the O(N^2/rooms) splice cost over a
     * whole restore. review-pr-d.md D3-F1 found that deferral let a redaction or eviction landing
     * mid-hydration leave a phantom id in {@link roomOrder} that is not in {@link events}, wedging
     * {@link contextFor} for that room for the rest of the session; D3-F5 found no measured
     * restore-time benefit from the deferral on the corpora it was tried against. It was removed:
     * {@link hydrate} calls this method directly for every admitted row, same as every other caller.
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
     * in ways that are hard to trace: {@link inverted}, {@link events}, {@link foldedSearchText}, {@link editTargets},
     * {@link roomOrder} (whose entry is deleted entirely when a room's last event goes, so {@link isRoomIndexed} need
     * not check for emptiness), and {@link plainTextByteEstimate}. {@link recordBytes} is the exception, describing
     * what is on *disk*, where the row survives until the delete this caller queues has committed.
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
        this.plainTextByteEstimate -= existing.searchText.length + 64;
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
     *
     * Pushes a *new* term (one not already in {@link inverted}'s key set) onto {@link pendingVocabulary} rather than
     * re-sorting {@link sortedVocabulary} from scratch; merges that delta into the base, in one bounded O(V) pass,
     * once it reaches {@link VOCABULARY_MERGE_THRESHOLD} ({@link mergeVocabularyDelta}) -- on this write path, never
     * as a side effect of a read. See `pendingVocabulary`'s own docstring for the incident this replaced. The
     * threshold check runs once per call, after the whole batch of terms in `text` has been pushed, rather than
     * immediately at each push: that is what makes a merge fire even when a call's *own* terms are all already
     * known (nothing new pushed this call) but an *earlier* call already left {@link pendingVocabulary} at or past
     * the threshold -- otherwise a run of live events that happen to reuse only existing terms could leave a
     * deferred merge (see `deferMerge` below) sitting unflushed indefinitely.
     *
     * @param deferMerge - When true, a merge that is due is *not* triggered here even if the delta has reached the
     *     threshold; the caller takes on the responsibility of triggering it later, at a point it controls. The only
     *     caller that passes `true` is {@link materializeRow}, from inside {@link hydrate}'s per-row loop
     *     (`research/review-pr-b.md` B2-F1): a merge is a single synchronous task of up to tens of milliseconds at
     *     realistic V (17ms measured at V=200,000, `research/measurements-pr-b.md` §5.4), and `hydrate`'s own
     *     {@link HYDRATION_SLICE_DEADLINE_MS} accounting only checks *after* each row -- so a merge landing inside a
     *     row's own processing would inflate that row's task by the merge's full cost, invisibly to the slice
     *     budget, before the next check ever ran. `hydrate` instead flushes a deferred merge itself, only at a point
     *     already outside any row's own task (see {@link flushVocabularyMergeIfDue}).
     */
    private indexTokens(eventId: string, text: string, deferMerge = false): void {
        for (const token of tokenize(text)) {
            let set = this.inverted.get(token);
            if (!set) {
                set = new Set();
                this.inverted.set(token, set);
                this.pendingVocabulary.push(token);
            }
            set.add(eventId);
        }
        if (!deferMerge) this.flushVocabularyMergeIfDue();
    }

    /**
     * Merge {@link pendingVocabulary} into {@link sortedVocabulary} if it has reached {@link
     * VOCABULARY_MERGE_THRESHOLD} -- otherwise a no-op. The one gate between "the delta is due for a merge" and
     * "the merge actually runs", so that {@link indexTokens}'s `deferMerge` path and {@link hydrate}'s own
     * between-rows call site both go through the identical decision rather than each re-implementing it.
     */
    private flushVocabularyMergeIfDue(): void {
        if (this.pendingVocabulary.length >= VOCABULARY_MERGE_THRESHOLD) this.mergeVocabularyDelta();
    }

    /**
     * Remove a record's terms from the inverted index, passing the exact text the record was indexed with; see {@link
     * indexTokens}. A term whose posting set empties is deleted from {@link inverted} rather than left behind, so a
     * redaction cannot make an unrelated exact-term lookup (`this.inverted.get(token)`) find a dead posting set -- but
     * deliberately does **not** touch {@link sortedVocabulary} or {@link pendingVocabulary}: {@link lookupToken}'s
     * prefix path re-looks-up every candidate term in `inverted` and skips one whose posting is gone (a "ghost"), so a
     * stale entry in either vocabulary structure changes no result, only costs one wasted `Map.get()` -- and per
     * `research/review-pr-b.md`'s B-N3, invalidating on this edge was never load-bearing even under the previous
     * design; this increment removes it rather than keep paying to detect an edge nothing needs detected.
     */
    private unindexTokens(eventId: string, text: string): void {
        for (const token of tokenize(text)) {
            const set = this.inverted.get(token);
            if (!set) continue;
            set.delete(eventId);
            if (set.size === 0) {
                this.inverted.delete(token);
            }
        }
    }

    /**
     * The fallback matcher: a linear scan for the query as a literal substring of stored text. Reached only when the
     * term path in {@link searchEventIndex} produced nothing, it covers what whole-word terms plus prefix matching
     * cannot reach at all -- a fragment from the middle of a word, a query whose punctuation split it into terms that
     * never co-occur, and scripts written without word separators. The three-character floor keeps it affordable.
     * Whitespace runs in the query are collapsed to single spaces and the result trimmed. That normalises the *query*
     * side only: stored text is folded but never whitespace-normalised, so a multi-word query matches only where the
     * stored text separates those words by exactly single spaces -- a body holding a newline between `hello` and
     * `world` is not found by `hello world`. The words must appear adjacent and in order; this is a substring test,
     * not a looser second term search.
     *
     * Folds each candidate via {@link foldedFor}'s memo, not on demand. A first attempt at this fallback deleted the
     * per-record memo entirely and folded every candidate fresh on every call; measured in real Chromium at 200k
     * events (`research/measurements-pr-b.md`), that cost ~127ms median here versus ~53ms with a memo -- a real
     * regression, not a negligible one, since this is the only path CJK text and a query the term index cannot
     * answer at all ever take, on every keystroke. The memo is kept, but never stores {@link foldText}'s direct
     * result: see {@link flattenCopy} for why that result can retain several times its own apparent size, and
     * `research/measurements-pr-b.md`'s three-way comparison (no memo, this flattened memo, the original unflattened
     * memo) for the numbers that decided this exact form -- the flattened memo matched the unflattened one's latency
     * (~54ms vs ~53ms at 200k) while adding only ~11 B/event more than no memo at all on a 50%-accented corpus
     * (versus ~115 B/event for the unflattened memo), comfortably inside the decision thresholds that measurement
     * task set.
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
     * One record's search text, folded, from the memo -- computed lazily, on first use, rather than eagerly at
     * hydration or insert time. Eager computation would add a {@link flattenCopy} call (and the {@link foldText} it
     * wraps) to every resident record's hydration and every live write, whether or not that record is ever reached by
     * a substring query at all; lazy computation costs nothing for the common case (a query the term/prefix path
     * already answers) and, for the case that does reach here, the harness's own "3 untimed warmup calls, then the
     * timed samples" methodology (`research/measurements-v1.md` §3.3) means the fill cost lands in the warmup, not in
     * any reported latency -- the same place it would land if every record had been folded eagerly at start-up. The
     * memo stores the text it was folded from beside the result and re-folds when the two no longer match, rather
     * than being invalidated wherever {@link StoredEvent.searchText} is written. That is why it is safe: a cache
     * updated at each of those four assignments would be one forgotten line away from serving a stale body to the
     * substring fallback, which fails silently.
     */
    private foldedFor(ev: StoredEvent): string {
        const memo = this.foldedSearchText.get(ev.eventId);
        if (memo && memo.src === ev.searchText) return memo.folded;
        const folded = flattenCopy(foldText(ev.searchText));
        this.foldedSearchText.set(ev.eventId, { src: ev.searchText, folded });
        return folded;
    }

    /**
     * Every record id matching one query term, as a fresh Set -- never one of the index's own posting sets, because
     * {@link searchEventIndex} adopts this object directly as the running intersection for the first term.
     *
     * @param prefix - When true, indexed terms that *start with* `token` match as well as the exact term, so typing
     *     "mess" already finds "message". Answered by binary-searching {@link sortedVocabulary} for the contiguous
     *     range of terms starting with `token` ({@link vocabularyRange}), plus a linear scan of {@link
     *     pendingVocabulary} (at most {@link VOCABULARY_MERGE_THRESHOLD} terms) for anything indexed since the last
     *     merge -- see that field's docstring for why a bounded scan of the unmerged delta, rather than a full
     *     rebuild here, is what keeps this method's cost independent of write rate. The caller passes false for
     *     single-character terms, since walking either structure for a one-character prefix is not worth it; the
     *     inner length check repeats that condition, so the prefix walk is unreachable for one-character terms.
     */
    private lookupToken(token: string, prefix: boolean): Set<string> {
        if (!prefix) return new Set(this.inverted.get(token) ?? []);
        const out = new Set<string>();
        const exact = this.inverted.get(token);
        if (exact) for (const id of exact) out.add(id);
        if (token.length >= 2) {
            const [start, end] = this.vocabularyRange(token);
            for (let i = start; i < end; i++) {
                const term = this.sortedVocabulary[i];
                if (term === token) continue; // Exact match already added above.
                const ids = this.inverted.get(term);
                if (ids) for (const id of ids) out.add(id);
            }
            for (const term of this.pendingVocabulary) {
                if (term === token || !term.startsWith(token)) continue;
                const ids = this.inverted.get(term);
                if (ids) for (const id of ids) out.add(id);
            }
        }
        return out;
    }

    /**
     * Merge {@link pendingVocabulary} into {@link sortedVocabulary} with one linear-time pass (sort the small delta,
     * then merge two sorted sequences), replacing the O(V log V) full re-sort this class used to do on every prefix
     * query once any write had touched the vocabulary (`research/review-pr-b.md` B-F1: measured at 25ms at V=61,346,
     * 107ms at V=200,000 -- run on *every* keystroke during hydration or a crawler batch, since both dirty the
     * vocabulary on nearly every write). Callers decide *when*, never a query: see {@link indexTokens}'s
     * `deferMerge` parameter for why a call from inside {@link hydrate}'s per-row loop is not one of them, despite
     * {@link pendingVocabulary} having reached {@link VOCABULARY_MERGE_THRESHOLD}. A no-op if the delta is empty.
     *
     * Two things happen while merging that neither stream needs sorted-and-deduplicated going in, only coming out:
     *
     * - **Duplicates are dropped** (`research/review-pr-b.md` B2-F3): a term can appear in {@link pendingVocabulary}
     *   more than once if it is removed from {@link inverted} (its posting set empties) and later re-added before a
     *   merge ever runs -- {@link indexTokens} re-pushes it every time, having no way to know it is already pending.
     *   Since both `base` and the sorted `delta` are duplicate-free *within* themselves (by induction: every previous
     *   merge already deduplicated `base`, and a term cannot be pushed onto `delta` twice without an intervening
     *   removal, which cannot itself duplicate a sorted array), any duplicate in the merged output is necessarily
     *   adjacent to the value that produced it, so comparing only against the immediately preceding output element
     *   is sufficient -- no separate dedup pass or Set is needed.
     * - **Ghosts are garbage-collected**: a term whose posting set is gone (checked against {@link inverted}, the
     *   source of truth) is dropped rather than carried into the merged base. Nothing else ever removes a ghost --
     *   {@link unindexTokens} deliberately does not touch either vocabulary structure -- so this is the one place
     *   sustained add/redact churn on a term (URLs, hashes, code identifiers: exactly what `tokenize` is most
     *   generous about keeping) does not inflate every subsequent merge's V for the rest of the session.
     */
    private mergeVocabularyDelta(): void {
        if (this.pendingVocabulary.length === 0) return;
        this.pendingVocabulary.sort();
        const base = this.sortedVocabulary;
        const delta = this.pendingVocabulary;
        const merged: string[] = new Array(base.length + delta.length);
        let i = 0;
        let j = 0;
        let k = 0;
        const take = (term: string): void => {
            if (!this.inverted.has(term)) return; // Ghost: no posting set left; do not carry it forward.
            if (k > 0 && merged[k - 1] === term) return; // Duplicate of the value just accepted; drop it.
            merged[k++] = term;
        };
        while (i < base.length && j < delta.length) {
            if (base[i] <= delta[j]) take(base[i++]);
            else take(delta[j++]);
        }
        while (i < base.length) take(base[i++]);
        while (j < delta.length) take(delta[j++]);
        merged.length = k;
        this.sortedVocabulary = merged;
        this.pendingVocabulary.length = 0;
    }

    /**
     * The `[start, end)` index range within {@link sortedVocabulary} of every term that starts with `prefix`, found by
     * two binary searches rather than one O(V) linear scan. Every indexed term is drawn from `\p{L}\p{N}_` ({@link
     * tokenize}'s split pattern), which cannot contain the U+FFFF noncharacter, so appending it to `prefix` produces
     * a string that every prefix-matching term sorts strictly before and every non-matching term at or after -- the
     * standard "lower bound of prefix, lower bound of prefix + a sentinel higher than any real character" technique
     * for a contiguous prefix range in a sorted array. Only covers {@link sortedVocabulary} (the merged base); {@link
     * lookupToken} scans {@link pendingVocabulary} (the unmerged delta) separately, linearly.
     */
    private vocabularyRange(prefix: string): [number, number] {
        return [this.lowerBoundVocabulary(prefix), this.lowerBoundVocabulary(prefix + "\uFFFF")];
    }

    /**
     * The first index in {@link sortedVocabulary} whose term is `>= target`, or the array's length if none is -- a
     * plain binary search. {@link vocabularyRange} calls it twice to bound one prefix's contiguous run.
     */
    private lowerBoundVocabulary(target: string): number {
        let lo = 0;
        let hi = this.sortedVocabulary.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.sortedVocabulary[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /**
     * The position of `hit.eventId` within `list` (one room's {@link roomOrder} entry), or -1 if it is not there.
     * Binary search over `originServerTs` rather than `Array.prototype.indexOf`'s O(n) linear scan, exploiting the
     * invariant {@link insertRoomOrder}/{@link reindexRoomOrder} already maintain -- `list` is always sorted by
     * `originServerTs` ascending -- so this needs no cache or position map of its own to stay correct across inserts,
     * hydration and removals: it just reads the current, always-sorted structure, the same one every other reader of
     * {@link roomOrder} already trusts.
     *
     * Finds the *lower bound* of `hit.originServerTs` first, then scans forward through the run of entries sharing
     * that exact timestamp for the matching id. Ties are rare in real chat data and the run they form is short, so
     * this stays O(log n) amortized; a plain id-indexed `Map<eventId, position>` was rejected instead, because
     * {@link insertRoomOrder} splices into the *middle* of the list, which would shift every later entry's stored
     * position on every insert -- trading an O(n) `indexOf` for an O(n) index-map repair on every write, no better.
     */
    private positionInRoomOrder(list: string[], hit: StoredEvent): number {
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const ts = this.events.get(list[mid])?.originServerTs ?? 0;
            if (ts < hit.originServerTs) lo = mid + 1;
            else hi = mid;
        }
        for (let i = lo; i < list.length; i++) {
            const candidate = this.events.get(list[i]);
            if (list[i] === hit.eventId) return i;
            if ((candidate?.originServerTs ?? 0) !== hit.originServerTs) break;
        }
        return -1;
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
    private contextFor(hit: StoredEvent, beforeLimit: number, afterLimit: number): ColdContext {
        const list = this.roomOrder.get(hit.roomId) ?? [];
        const idx = this.positionInRoomOrder(list, hit);
        const beforeIds = idx >= 0 ? list.slice(Math.max(0, idx - beforeLimit), idx) : [];
        const afterIds = idx >= 0 ? list.slice(idx + 1, idx + 1 + afterLimit) : [];
        // Resolved and filtered, not asserted non-null: `roomOrder` entries are meant to always be
        // resident in `events`, but a future regression of that invariant (review-pr-d.md D3-F1 was
        // one such shape) should drop the stale id from this one result rather than throw and fail
        // the whole search for the room.
        const beforeEvents = beforeIds.flatMap((id) => {
            const ev = this.events.get(id);
            return ev ? [ev] : [];
        });
        const afterEvents = afterIds.flatMap((id) => {
            const ev = this.events.get(id);
            return ev ? [ev] : [];
        });
        const events_before = beforeEvents.map((ev) => this.resultEvent(ev.event));
        const events_after = afterEvents.map((ev) => this.resultEvent(ev.event));
        const profile_info: Record<string, IMatrixProfile> = {};
        for (const ev of [hit, ...beforeEvents, ...afterEvents]) {
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
     * Queue the removal of one record from disk and its accounting, shared by {@link deleteEvent}'s
     * ordinary path and by {@link materializeRow}'s "redacted before it was even hydrated" path.
     * Schema v3's shape for this: rewrite the *chunk* that currently holds `targetId` without it --
     * decrypt (bounded: at most one chunk, {@link CHUNK_TARGET_BYTES} of plaintext), drop the one
     * entry, re-encrypt, write back -- or, if that was the chunk's last member, delete the chunk row
     * outright rather than storing an empty ciphertext.
     *
     * **A no-op only if `targetId` never reached disk at all** (no manifest entry -- still
     * buffered): every id that has one always names a real chunk (see {@link ManifestEntry}'s own
     * docstring), so there is always exactly one chunk to rewrite.
     */
    private enqueueDeleteRecord(userId: string, targetId: string): void {
        // Synchronous, same moment the record leaves the resident set -- see pendingDiskDeletes's
        // own docstring for the window this closes.
        this.pendingDiskDeletes.add(targetId);
        this.enqueuePersist(async () => {
          try {
            const dek = this.dek;
            const entry = this.manifest.get(targetId);
            if (!entry) return; // Never reached disk at all -- still buffered only.
            if (!dek || !this.db) {
                this.manifestRemove(targetId);
                return;
            }
            const chunkId = entry.chunkId;
            const wasOpen = chunkId === this.openChunkId;
            // The open chunk's own live buffer is mutated directly (it is the authoritative
            // in-memory copy, never re-read from disk while open); a sealed chunk is read fresh.
            const entries = wasOpen ? this.openChunkEntries : await this.readChunkEntries(userId, dek, chunkId);
            entries.delete(targetId);
            if (wasOpen) this.openChunkPlainBytes = entries.size > 0 ? chunkPlainBytesFor(entries) : 0;
            // oldestIndexedTs is deliberately NOT touched here: it is a *cutoff* from a deliberate,
            // contiguous, oldest-first drop (enforceDiskBudget), not a promise about any arbitrary
            // single record's age, and an ordinary redaction is neither of those things -- see
            // oldestIndexedTs's own docstring, and deleteRecordsForDiskBudget's for the case that
            // *does* update it.
            this.manifestRemove(targetId);

            let newTotal = this.ciphertextBytes - (this.chunkInfo.get(chunkId)?.bytes ?? 0);
            let chunkRecord: ChunkRecord | null = null;
            let newInfo: { bytes: number; minTs: number; maxTs: number } | null = null;
            if (entries.size > 0) {
                const blob = await encryptBinary(dek, Array.from(entries), chunkAad(userId, chunkId));
                chunkRecord = { userId, chunkId, blob };
                newInfo = { bytes: blob.ct.length + blob.iv.length, ...tsRangeOf(entries) };
                newTotal += newInfo.bytes;
            }

            const manifestRecords = await this.prepareManifestPageWrites(userId, dek);
            const meta = await this.loadMeta(userId);
            const tx = this.db.transaction(["chunks", "meta"], "readwrite");
            if (chunkRecord) tx.objectStore("chunks").put(chunkRecord);
            else tx.objectStore("chunks").delete([userId, chunkId]);
            for (const rec of manifestRecords) tx.objectStore("meta").put(rec);
            if (meta) {
                tx.objectStore("meta").put({
                    ...meta,
                    diskBytes: newTotal,
                    manifestPageCount: this.manifestPages.length,
                    nextChunkId: this.nextChunkId,
                });
            }
            await txDone(tx);

            this.ciphertextBytes = newTotal;
            if (newInfo) {
                this.chunkInfo.set(chunkId, newInfo);
                heapPushTs(this.diskChunkHeap, { ts: newInfo.maxTs, id: String(chunkId) }); // D4: order by maxTs, not minTs.
            } else {
                this.chunkInfo.delete(chunkId);
                if (wasOpen) {
                    this.openChunkId = undefined;
                    this.openChunkEntries.clear();
                    this.openChunkPlainBytes = 0;
                }
            }
          } finally {
            // However this settled -- deleted the whole chunk, rewrote it, found nothing to do, or
            // threw -- the window pendingDiskDeletes exists for is over: either the disk row now
            // reflects the deletion, or nothing here ever depended on it doing so.
            this.pendingDiskDeletes.delete(targetId);
          }
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
     * Add or update one id in {@link manifest}, and every derived structure alongside it: the
     * page it belongs to (a fresh page if the current last one is full), the per-room id set, and
     * the per-room oldest/newest floors (`Math.min`/`Math.max`, so both only ever move toward more
     * coverage). Called for a genuinely new id or for one whose `ts`/`roomId` changed (an original
     * arriving after its edit re-times a record; a room id never changes for a given event, but the
     * update path is the same either way).
     *
     * **Applied optimistically, before the caller's write transaction has committed** -- the same
     * trade-off {@link flushLiveWrites} and {@link deleteRecordsForDiskBudget} make for the reasons
     * given at each call site: computing the *would-be* page contents to encrypt has to happen
     * before the transaction opens (encryption is not an IndexedDB operation), and undoing a
     * speculative manifest add on a rare transaction failure would need a full dry-run/commit split
     * this class does not otherwise have. The failure mode if a write is ever rejected (quota,
     * mainly) is a harmless phantom manifest entry for a row that never landed: {@link hydrate}'s
     * per-id `get()` simply finds nothing and skips it, and the entry very rarely affects a crawl
     * decision materially given how large the windows/caps it feeds are relative to one record.
     *
     * @param chunkId - The chunk this id currently lives in; see {@link ManifestEntry.chunkId}'s own
     *     docstring for why an id's chunk never actually changes in practice. Passing a different
     *     `chunkId` for an id that already has one would move its {@link chunkMembers} entry
     *     accordingly, but no caller in this class does that.
     */
    private manifestAdd(id: string, ts: number, roomId: string, chunkId: number): void {
        const existing = this.manifest.get(id);
        if (!existing) {
            let page = this.manifestPages.length - 1;
            if (page < 0 || this.manifestPages[page].size >= MANIFEST_PAGE_SIZE) {
                page = this.manifestPages.length;
                this.manifestPages.push(new Set());
            }
            this.manifestPages[page].add(id);
            this.manifestEntryPage.set(id, page);
            this.manifestDirtyPages.add(page);
            let rooms = this.manifestRoomIds.get(roomId);
            if (!rooms) {
                rooms = new Set();
                this.manifestRoomIds.set(roomId, rooms);
            }
            rooms.add(id);
            this.chunkMembersAdd(chunkId, id);
        } else {
            const page = this.manifestEntryPage.get(id);
            if (page !== undefined) this.manifestDirtyPages.add(page);
            if (existing.chunkId !== chunkId) {
                this.chunkMembersRemove(existing.chunkId, id);
                this.chunkMembersAdd(chunkId, id);
            }
        }
        this.manifest.set(id, { ts, roomId, chunkId });
        this.manifestOldestByRoom.set(roomId, Math.min(this.manifestOldestByRoom.get(roomId) ?? Infinity, ts));
        this.manifestNewestByRoom.set(roomId, Math.max(this.manifestNewestByRoom.get(roomId) ?? -Infinity, ts));
    }

    /** Add `id` to {@link chunkMembers}'s set for `chunkId`. */
    private chunkMembersAdd(chunkId: number, id: string): void {
        let members = this.chunkMembers.get(chunkId);
        if (!members) {
            members = new Set();
            this.chunkMembers.set(chunkId, members);
        }
        members.add(id);
    }

    /** Remove `id` from {@link chunkMembers}'s set for `chunkId`, pruning an emptied set. */
    private chunkMembersRemove(chunkId: number, id: string): void {
        const members = this.chunkMembers.get(chunkId);
        if (!members) return;
        members.delete(id);
        if (members.size === 0) this.chunkMembers.delete(chunkId);
    }

    /**
     * Remove one id from {@link manifest}, its page and its chunk's {@link chunkMembers} entry, for
     * a row genuinely leaving disk (a redaction or a disk-budget deletion -- never RAM-only eviction,
     * which must not call this: see {@link manifest}'s own docstring for why). Deliberately does
     * **not** recompute {@link manifestOldestByRoom}/{@link manifestNewestByRoom} from the room's
     * remaining entries unless the room's manifest set becomes empty -- see those fields' own
     * docstrings for why leaving a floor/ceiling stale after a *partial* removal is the safe
     * direction (it can only make `shouldCrawl` decline a *little* more readily than strictly
     * necessary, never less), while a full rescan on every deletion would cost O(room size) on a
     * path {@link enforceDiskBudget} can call many times in one pass.
     */
    private manifestRemove(id: string): void {
        const entry = this.manifest.get(id);
        if (!entry) return;
        this.manifest.delete(id);
        const page = this.manifestEntryPage.get(id);
        if (page !== undefined) {
            this.manifestPages[page]?.delete(id);
            this.manifestEntryPage.delete(id);
            this.manifestDirtyPages.add(page);
        }
        this.chunkMembersRemove(entry.chunkId, id);
        const rooms = this.manifestRoomIds.get(entry.roomId);
        if (rooms) {
            rooms.delete(id);
            if (rooms.size === 0) {
                this.manifestRoomIds.delete(entry.roomId);
                this.manifestOldestByRoom.delete(entry.roomId);
                this.manifestNewestByRoom.delete(entry.roomId);
            }
        }
    }

    /**
     * Encrypt every page {@link manifestDirtyPages} currently names, ready to `put()` into the
     * `meta` store, and clear that set. Must be called -- and its result awaited -- **before** the
     * caller's transaction opens, the same discipline every other encrypt in this class follows:
     * `encryptJson` is not an IndexedDB operation, and awaiting one inside a live transaction lets
     * it auto-close before a later `put()` in the same batch runs.
     */
    private async prepareManifestPageWrites(userId: string, dek: CryptoKey): Promise<ManifestPageRecord[]> {
        const pages = Array.from(this.manifestDirtyPages);
        this.manifestDirtyPages.clear();
        const records: ManifestPageRecord[] = [];
        for (const page of pages) {
            const ids = this.manifestPages[page];
            const entries: Array<[string, number, string, number]> = [];
            if (ids) {
                for (const id of ids) {
                    const entry = this.manifest.get(id);
                    if (entry) entries.push([id, entry.ts, entry.roomId, entry.chunkId]);
                }
            }
            const key = manifestPageKey(userId, page);
            const blob = await encryptJson(dek, entries, key);
            records.push({ userId: key, blob });
        }
        return records;
    }

    /**
     * The next fresh chunk id, bumping {@link nextChunkId}. Pure in-memory bookkeeping -- persisted
     * only as part of whichever write actually uses the id, in the same `meta` row every chunk write
     * already updates (`diskBytes`, `manifestPageCount`); never its own transaction.
     */
    private allocateChunkId(): number {
        const id = this.nextChunkId;
        this.nextChunkId += 1;
        return id;
    }

    /**
     * Make sure {@link openChunkId} names a chunk, allocating a fresh one if this session has not
     * written anything yet. Idempotent: a chunk, once open, stays open (its id unchanged) until
     * {@link packIntoOpenChunk} seals it for crossing {@link CHUNK_TARGET_BYTES}, or {@link
     * enqueueDeleteRecord} empties it via a redaction.
     */
    private ensureOpenChunk(): void {
        if (this.openChunkId === undefined) this.openChunkId = this.allocateChunkId();
    }

    /**
     * Read and decrypt one chunk by id -- the bounded, single-chunk read every chunk-rewrite path
     * uses (an update landing on an already-sealed chunk in {@link flushLiveWrites}, a redaction of a
     * sealed chunk in {@link enqueueDeleteRecord}), and, via {@link decryptChunkOnce}, every on-demand
     * read path too. One read-only transaction, released before the decrypt runs -- the same "no
     * non-IndexedDB await inside a live transaction" discipline every other read in this file
     * follows. Returns an empty map for a chunk id with no row (nothing to lose: the caller is about
     * to add to or replace its contents regardless); throws whatever {@link decryptBinaryJson} throws
     * on ciphertext that will not decrypt, which every caller here treats as the same "this index
     * cannot be read" failure every other decrypt in this file responds to.
     *
     * Also the one place a chunk *learned this way* (read, not written, by this session) populates
     * {@link chunkInfo}/{@link diskChunkHeap} -- the analogue of what the old per-event {@link
     * residentHeap}/`recordBytes` docstring called "durable by definition the moment it is
     * decrypted". Guarded by `!chunkInfo.has(chunkId)`: only the *first* time this session sees a
     * chunk, never overwriting what a write path (which runs serialized, always current) already
     * knows with what could be a stale read racing that write's own in-flight commit.
     */
    private async readChunkEntries(userId: string, dek: CryptoKey, chunkId: number): Promise<Map<string, StoredEvent>> {
        if (!this.db) return new Map();
        const tx = this.db.transaction("chunks", "readonly");
        const row = (await idbReq(tx.objectStore("chunks").get([userId, chunkId]))) as ChunkRecord | undefined;
        await txDone(tx);
        if (!row) return new Map();
        const arr = await decryptBinaryJson<Array<[string, StoredEvent]>>(dek, row.blob, chunkAad(userId, chunkId));
        const entries = new Map(arr);
        if (!this.chunkInfo.has(chunkId)) {
            const { minTs, maxTs } = tsRangeOf(entries);
            this.chunkInfo.set(chunkId, { bytes: row.blob.ct.length + row.blob.iv.length, minTs, maxTs });
            heapPushTs(this.diskChunkHeap, { ts: maxTs, id: String(chunkId) }); // D4: order by maxTs, not minTs.
        }
        return entries;
    }

    /**
     * Decrypt one chunk at most once, however many callers want it at the same time -- the chunk
     * analogue of schema v2's `materializeOnce`. {@link hydrate}'s batch read and {@link
     * materializeIfPending} each decide which chunks they need from a synchronous read of {@link
     * manifest} taken before either starts decrypting, so if a live write's on-demand pull names a
     * chunk hydration has already started decrypting, but not yet finished, both checks can pass
     * before either's decrypt resolves. A caller that finds a chunk already being decrypted awaits
     * that attempt instead of starting a second one; the map entry is removed once the attempt
     * settles (successfully or not), so a later, genuinely new request for the same chunk is never
     * permanently blocked by one that has already finished.
     */
    private async decryptChunkOnce(userId: string, dek: CryptoKey, chunkId: number): Promise<Map<string, StoredEvent>> {
        const inFlight = this.materializingChunks.get(chunkId);
        if (inFlight) return inFlight;
        const attempt = this.readChunkEntries(userId, dek, chunkId);
        this.materializingChunks.set(chunkId, attempt);
        try {
            return await attempt;
        } finally {
            this.materializingChunks.delete(chunkId);
        }
    }

    /**
     * Pack one entry into {@link openChunkEntries}, maintaining {@link openChunkPlainBytes}
     * incrementally -- stringifying only the one `[id, StoredEvent]` pair that changed, never the
     * whole chunk, so packing a full crawler batch (up to {@link LIVE_WRITE_BUFFER_MAX} entries) into
     * the open chunk costs O(entries), not O(entries x chunk size). Sealing (crossing {@link
     * CHUNK_TARGET_BYTES}) is the caller's decision -- {@link flushLiveWrites} -- since only it knows
     * whether more entries from the same flush still need somewhere to go.
     */
    private packIntoOpenChunk(id: string, stored: StoredEvent): void {
        const already = this.openChunkEntries.get(id);
        const newLen = JSON.stringify([id, stored]).length;
        if (already === undefined) {
            this.openChunkPlainBytes += newLen + (this.openChunkEntries.size > 0 ? 1 : 0); // +1: the joining comma
        } else {
            this.openChunkPlainBytes += newLen - JSON.stringify([id, already]).length;
        }
        this.openChunkEntries.set(id, stored);
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
     * Pack/rewrite `ids` into chunks and write every touched chunk as **one** IndexedDB transaction
     * with the manifest tail: every value is prepared -- {@link events} re-read, every chunk
     * encrypted ({@link encryptBinary}/{@link encryptJson}) -- entirely before the transaction below
     * is opened, so the only `await` inside it is {@link txDone} itself, the same discipline every
     * write path in this file follows.
     *
     * Re-reads {@link events} for each id rather than trusting a snapshot taken when the id was
     * buffered: an id can have been deleted (a redaction racing a still-buffered write; see {@link
     * removeFromIndex}) between being queued and this running, and `this.events.get(id)` being
     * absent is exactly how that shows up here -- skipped rather than written.
     *
     * **Which chunk an id goes into.** A genuinely new id, or one whose existing chunk *is* the
     * currently open one, is packed into {@link openChunkEntries} ({@link packIntoOpenChunk}),
     * sealing and starting a fresh chunk every time {@link openChunkPlainBytes} crosses {@link
     * CHUNK_TARGET_BYTES} -- so one large flush (a crawler batch) can seal several chunks in a row,
     * not just one. An id whose manifest entry already names a *different*, sealed chunk (an edit or
     * a late-arriving original landing on content packed by an earlier flush) rewrites that chunk in
     * place instead ({@link readChunkEntries}, bounded to that one chunk) -- it is never moved to the
     * open chunk, per {@link ManifestEntry.chunkId}'s own docstring.
     *
     * Sequential, not `Promise.all`-parallelised: that was tried and measured
     * (`research/measurements-pr-b.md`) to make no difference at 200k events -- Chromium's
     * WebCrypto AES-GCM path does not pipeline meaningfully faster for concurrently-issued calls
     * here, so the extra combinator/filter code would be complexity with no payoff.
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
        const live: Array<{ id: string; stored: StoredEvent }> = [];
        for (const id of ids) {
            const stored = this.events.get(id);
            if (stored) live.push({ id, stored }); // Absent: deleted since being buffered; nothing left to write.
        }
        if (live.length === 0) return;
        this.ensureOpenChunk();

        // Partition: ids landing in the open chunk (new, or already the open chunk) vs. ids that must
        // rewrite some other, already-sealed chunk in place.
        const forOpenChunk: typeof live = [];
        const sealedUpdates = new Map<number, typeof live>();
        for (const item of live) {
            const existing = this.manifest.get(item.id);
            if (existing && existing.chunkId !== this.openChunkId) {
                let arr = sealedUpdates.get(existing.chunkId);
                if (!arr) {
                    arr = [];
                    sealedUpdates.set(existing.chunkId, arr);
                }
                arr.push(item);
            } else {
                forOpenChunk.push(item);
            }
        }

        // Pack forOpenChunk, sealing (and starting a fresh chunk) every time the target size is
        // crossed -- a single large flush can seal several chunks this way.
        const chunkTargetBytes = getChunkTargetBytes();
        const sealedThisFlush: Array<{ chunkId: number; entries: Map<string, StoredEvent> }> = [];
        for (const { id, stored } of forOpenChunk) {
            this.packIntoOpenChunk(id, stored);
            if (this.openChunkPlainBytes >= chunkTargetBytes) {
                sealedThisFlush.push({ chunkId: this.openChunkId!, entries: new Map(this.openChunkEntries) });
                this.openChunkId = this.allocateChunkId();
                this.openChunkEntries.clear();
                this.openChunkPlainBytes = 0;
            }
        }
        const chunksToWrite = sealedThisFlush;
        // Whatever is left in the (possibly just-rolled-over) open chunk still needs writing, unless
        // nothing here touched it at all this flush (a pure sealed-chunk-update flush).
        if (forOpenChunk.length > 0 && this.openChunkEntries.size > 0) {
            chunksToWrite.push({ chunkId: this.openChunkId!, entries: new Map(this.openChunkEntries) });
        }

        // Sealed-chunk updates: read (bounded, one chunk each), apply, queue for the same write.
        for (const [chunkId, items] of sealedUpdates) {
            const entries = await this.readChunkEntries(userId, dek, chunkId);
            for (const { id, stored } of items) entries.set(id, stored);
            chunksToWrite.push({ chunkId, entries });
        }

        // Encrypt every touched chunk and compute its new size/ts-range before the transaction opens.
        const chunkRecords: ChunkRecord[] = [];
        const chunkInfoUpdates: Array<{ chunkId: number; bytes: number; minTs: number; maxTs: number }> = [];
        for (const { chunkId, entries } of chunksToWrite) {
            const blob = await encryptBinary(dek, Array.from(entries), chunkAad(userId, chunkId));
            chunkRecords.push({ userId, chunkId, blob });
            chunkInfoUpdates.push({ chunkId, bytes: blob.ct.length + blob.iv.length, ...tsRangeOf(entries) });
            for (const [id, ev] of entries) this.manifestAdd(id, ev.originServerTs, ev.roomId, chunkId);
        }

        // Computed before the transaction opens, same discipline as the encrypt calls above: this is a
        // plain object read/arithmetic (loadMeta is cleartext, cheap), never an await once the tx is live.
        let newTotal = this.ciphertextBytes;
        for (const u of chunkInfoUpdates) newTotal += u.bytes - (this.chunkInfo.get(u.chunkId)?.bytes ?? 0);
        let newOldest = this.oldestIndexedTs;
        for (const { stored } of live) {
            newOldest = newOldest === undefined ? stored.originServerTs : Math.min(newOldest, stored.originServerTs);
        }

        const manifestRecords = await this.prepareManifestPageWrites(userId, dek);
        const oldestIndexedTsRecord = await this.prepareOldestIndexedTsWrite(userId, dek, newOldest);
        const meta = await this.loadMeta(userId);

        const tx = this.db.transaction(["chunks", "meta"], "readwrite");
        const store = tx.objectStore("chunks");
        for (const rec of chunkRecords) store.put(rec);
        for (const rec of manifestRecords) tx.objectStore("meta").put(rec);
        if (oldestIndexedTsRecord) tx.objectStore("meta").put(oldestIndexedTsRecord);
        if (meta) {
            tx.objectStore("meta").put({
                ...meta,
                diskBytes: newTotal,
                manifestPageCount: this.manifestPages.length,
                nextChunkId: this.nextChunkId,
            });
        }
        await txDone(tx);

        // Only once the whole batch has committed, and replacing each chunk's previous contribution
        // rather than adding to it: these are puts, so a rewrite leaves one row per chunk, not two.
        this.ciphertextBytes = newTotal;
        // Persisted encrypted, not cleartext (review-pr-c.md C2-F4), just above; still moves
        // backward here exactly as before, on genuine discovery of an older record.
        this.oldestIndexedTs = newOldest;
        for (const u of chunkInfoUpdates) {
            this.chunkInfo.set(u.chunkId, { bytes: u.bytes, minTs: u.minTs, maxTs: u.maxTs });
            heapPushTs(this.diskChunkHeap, { ts: u.maxTs, id: String(u.chunkId) }); // D4: order by maxTs, not minTs.
        }
        for (const { id, stored } of live) {
            // Only now, once the write has actually committed, does this id become an eviction
            // candidate -- see residentHeap's own docstring for why granting candidacy any earlier
            // (at insertion) made every eviction attempt during a fast crawler ingest walk most of
            // the heap for nothing. A record deleted since being buffered was already skipped above,
            // so everything reaching this loop is still resident.
            heapPushTs(this.residentHeap, { ts: stored.originServerTs, id });
        }
        this.enforceResidentBudget();
        await this.enforceDiskBudget(userId);
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
     * Resolve once the manifest phase started by the most recent {@link initEventIndex} has
     * finished. Exists for the same reason {@link waitForHydration} does -- a deterministic point
     * for tests, and this increment's own proof requirement to report the manifest phase's duration
     * separately from the rest of hydration -- and the same warning applies: production code must
     * never call this.
     * @knipignore - exported for tests
     */
    public async waitForManifest(): Promise<void> {
        await this.manifestReadyPromise;
    }

    /**
     * Decrypt every persisted manifest page for this user, newest-page-first, into {@link manifest}
     * and its derived structures. "Newest page first" is a heuristic, not a guarantee -- pages are
     * sealed in insertion order ({@link manifestAdd}), and insertion order tracks recency well for
     * live events but not for a backward crawler batch, which inserts progressively *older* content
     * over time -- so the true newest-first guarantee {@link hydrate} relies on comes from sorting
     * the *complete*, in-memory manifest once every page has loaded, not from this method's read
     * order; reading newest-page-first only means a caller that inspected partial state mid-load
     * would see a bias toward recent entries sooner, which nothing here currently does.
     *
     * Sliced at {@link HYDRATION_SLICE_DEADLINE_MS} between pages, same discipline as {@link
     * hydrate}: manifest entries are tiny (an id, a number, a room id) so this is expected to be
     * fast in absolute terms even at hundreds of thousands of entries, but "fast" is not "zero", and
     * this must not produce one long task any more than hydration itself may.
     *
     * A page that fails to **decrypt** gets the same response {@link hydrate}'s own failure path
     * gives an unreadable event row: wipe this user's index, in memory and on disk, and reset to
     * `userVersion` 0. This has to be a wipe, not a "treat as empty and carry on": a rotated pickle
     * key or a new device id looks identical from here, and if it were tolerated silently, {@link
     * hydrate} would go on to read its (now-empty) candidate list from an *empty* manifest and never
     * attempt a single event-row decrypt itself -- the one thing that used to surface a rotated key
     * at all before this increment. A page that merely fails to **read** (an IndexedDB-level error,
     * e.g. another tab's `onversionchange` closing this connection mid-page) is treated as absent
     * instead, the same conservative response {@link materializeIfPending} gives the same class of
     * error: not evidence of a bad key, just nothing usable from that one request.
     */
    private async loadManifest(
        userId: string,
        dek: CryptoKey,
        pageCount: number,
        salt: Uint8Array<ArrayBuffer>,
        epoch: number,
    ): Promise<void> {
        const started = now();
        let sliceStart = now();
        for (let page = pageCount - 1; page >= 0; page--) {
            if (this.closed || epoch !== this.hydrationEpoch || !this.db) return;
            const key = manifestPageKey(userId, page);
            let row: ManifestPageRecord | undefined;
            try {
                const tx = this.db.transaction("meta", "readonly");
                row = (await idbReq(tx.objectStore("meta").get(key))) as ManifestPageRecord | undefined;
                await txDone(tx);
            } catch (e) {
                log.warn(`EventIndex: could not read manifest page ${page}; treating it as absent`, e);
                continue;
            }
            if (this.closed || epoch !== this.hydrationEpoch) return;
            if (!row) continue;
            // Every manifest page this class has ever written since the v2/v1-to-v3 reset carries a
            // real chunkId on every entry (see ManifestEntry's own docstring): there is no
            // "known ts/roomId, not yet chunked" state left to decode a missing fourth element into.
            let entries: Array<[string, number, string, number]>;
            try {
                entries = await decryptJson<Array<[string, number, string, number]>>(dek, row.blob, key);
            } catch {
                log.warn("EventIndex: a manifest page could not be decrypted; wiping leftover for this user");
                this.clearIndexMaps();
                await this.deleteUserRecords(userId);
                await this.saveMeta({
                    userId,
                    salt: encodeBase64(salt),
                    userVersion: 0,
                    manifestPageCount: 0,
                    nextChunkId: this.nextChunkId,
                });
                this.userVersion = 0;
                this.manifestLoaded = true;
                return;
            }
            if (this.closed || epoch !== this.hydrationEpoch) return;
            while (this.manifestPages.length <= page) this.manifestPages.push(new Set());
            for (const [id, ts, roomId, chunkId] of entries) {
                this.manifestPages[page].add(id);
                this.manifestEntryPage.set(id, page);
                this.manifest.set(id, { ts, roomId, chunkId });
                this.chunkMembersAdd(chunkId, id);
                let rooms = this.manifestRoomIds.get(roomId);
                if (!rooms) {
                    rooms = new Set();
                    this.manifestRoomIds.set(roomId, rooms);
                }
                rooms.add(id);
                this.manifestOldestByRoom.set(roomId, Math.min(this.manifestOldestByRoom.get(roomId) ?? Infinity, ts));
                this.manifestNewestByRoom.set(roomId, Math.max(this.manifestNewestByRoom.get(roomId) ?? -Infinity, ts));
            }
            if (now() - sliceStart >= HYDRATION_SLICE_DEADLINE_MS) {
                await yieldToEventLoop();
                if (this.closed || epoch !== this.hydrationEpoch) return;
                sliceStart = now();
            }
        }
        if (this.closed || epoch !== this.hydrationEpoch || !this.db) return;
        // review-pr-c.md C2-F4: read back from its own encrypted row, never a cleartext meta field.
        // Absent (`undefined`) on a database that has a manifest but pre-dates C2-F4's own fix, or
        // on a brand-new index -- not an error; see loadOldestIndexedTs's own docstring.
        try {
            this.oldestIndexedTs = await this.loadOldestIndexedTs(userId, dek);
        } catch {
            log.warn(
                "EventIndex: the persisted oldestIndexedTs row could not be decrypted; wiping leftover for this user",
            );
            this.clearIndexMaps();
            await this.deleteUserRecords(userId);
            await this.saveMeta({
                userId,
                salt: encodeBase64(salt),
                userVersion: 0,
                manifestPageCount: 0,
                nextChunkId: this.nextChunkId,
            });
            this.userVersion = 0;
            this.manifestLoaded = true;
            return;
        }
        this.manifestLoaded = true;
        log.info(
            `EventIndex: manifest loaded in ${(now() - started).toFixed(1)}ms, ${this.manifest.size} entries, ${pageCount} pages`,
        );
    }

    /**
     * Exact `Math.min` of every {@link manifest} entry's `originServerTs`, or `undefined` if the
     * manifest is empty. Cheap and authoritative with no I/O: {@link manifest} is resident for the
     * life of the session for every id on disk, regardless of the hydration/hot-window budget (its
     * own docstring) -- a single in-memory pass is therefore already exact, unlike deriving the same
     * figure from any partial, session-local structure. Used by {@link deleteRecordsForDiskBudget}
     * (D4), which used to *assume* a new floor from what it had itself just touched rather than
     * asking what is actually still on disk.
     */
    private manifestOldestTs(): number | undefined {
        let oldest: number | undefined;
        for (const entry of this.manifest.values()) {
            if (oldest === undefined || entry.ts < oldest) oldest = entry.ts;
        }
        return oldest;
    }

    /**
     * Decrypt this user's disk rows into memory, in the background, newest-`originServerTs`-first,
     * without ever awaiting anything but an IndexedDB request or {@link yieldToEventLoop} between
     * two decrypts -- see {@link initEventIndex}, which starts this without awaiting it, and the
     * class threat model's note on why a non-IndexedDB `await` inside a live transaction is the one
     * mistake to avoid here above all others.
     *
     * **Walks chunks, not manifest entries (review-pr-d.md D5 rewrite).** An earlier version of
     * this method walked {@link manifest} id-by-id in fixed-size pages, grouping each page's ids by
     * chunk and caching decrypted chunks *for that page only*
     * (`decryptedChunks`, scoped inside the page loop). Because manifest order (ts-descending) is
     * uncorrelated with chunk packing (arrival order -- see {@link CHUNK_TARGET_BYTES}'s own
     * docstring on crawl locality), a single chunk's ~47 members are typically scattered across many
     * pages, so the same chunk was re-read and re-decrypted once per page that touched it: measured
     * at 13.3x redundant chunk reads at 200k/desktop-tier, 39,475 chunk transactions against ~2,960
     * chunks that actually exist, each parse yielding on average 3.3 useful (admitted) events out of
     * ~47 decrypted -- a 2.2-2.6x hydration regression versus the previous schema.
     *
     * This version inverts the walk: compute the full **set of distinct chunks** this user has from
     * {@link manifest}/{@link chunkMembers} (both fully resident already, for every id on disk,
     * regardless of hydration -- no I/O to learn this), each chunk's own newest member `ts`
     * (`chunkMaxTs`, a single in-memory pass, sliced), sort that (far smaller) chunk-id set
     * newest-first once, and then visit each chunk **exactly once, ever, for the whole restore**:
     * read it (batched, up to {@link HYDRATION_CHUNK_BATCH} chunks sharing one read-only
     * transaction, decrypted only after that transaction settles -- the same "no non-IndexedDB await
     * inside a live transaction" discipline every read in this file follows), admit its
     * still-non-resident members newest-first, and move on. No chunk cache is needed because none is
     * possible: a chunk this walk has already visited is never looked at again, by construction, so
     * there is nothing to re-read even without one. A chunk another caller ({@link
     * materializeIfPending}, racing this run for the same id) is already decrypting is awaited
     * instead of re-read, the same dedup {@link decryptChunkOnce} gives a single-chunk caller.
     *
     * **Ordering chunks by `maxTs` is the same key {@link enforceDiskBudget} now evicts by
     * (review-pr-d.md D4's fix)**, so the chunk this run visits *last* (if it stops early at the
     * resident budget) and the chunk a disk-budget pass would delete *first* are, by construction,
     * drawn from the same end of the same ordering -- hydration's hot window and the disk-budget
     * floor point the same direction.
     *
     * **Restores (most of) the pre-chunking budget-before-decrypt property.** Schema v2/increment C
     * checked the hot-window budget *before* decrypting each row, so a row this run was never going
     * to keep resident was never decrypted at all; per-chunk decryption cannot preserve that exactly
     * (a whole chunk is the smallest unit this schema can read), but checking the budget before
     * *each chunk* -- not merely once per page of up to 1,000 ids, the previous shape -- bounds the
     * overshoot to at most one chunk's worth of wasted decrypt, not one page's.
     *
     * Sliced at {@link HYDRATION_SLICE_DEADLINE_MS} exactly as before, so a large restore never
     * produces one long main-thread task regardless of how many chunks it takes. Every resumption
     * point -- the top of the walk, after each chunk decrypt, after each row, after each yield --
     * re-checks {@link closed} and the epoch this run was started with, and returns without touching
     * {@link db} the moment either has moved on: see {@link resetMemory}, which is what moves the
     * epoch on.
     *
     * Each row's own {@link materializeRow} indexes with {@link indexTokens}' `deferMerge` set, so a
     * vocabulary merge that becomes due mid-row never runs as part of that row's task
     * (`research/review-pr-b.md` B2-F1: the merge alone can cost tens of milliseconds at realistic V,
     * and {@link HYDRATION_SLICE_DEADLINE_MS}'s own accounting only checks *after* a row completes, so
     * it would otherwise inflate one row's task by the merge's full cost, invisibly). This loop flushes
     * a deferred merge itself instead, at the two points already outside any row's own task: right
     * after a slice's {@link yieldToEventLoop} and at each chunk-batch boundary.
     *
     * A row whose id is already in {@link events} is skipped rather than overwritten (a live event
     * or a crawler batch got there first and is authoritative), and one no longer inside its chunk at
     * all (a redaction having raced ahead of this run reaching it) is simply skipped -- neither is an
     * error. A chunk that fails to decrypt reproduces the old, fully-synchronous {@link
     * initEventIndex}'s failure response -- wipe this user's index, in memory and on disk, and reset
     * to `userVersion` 0 -- because that is what a rotated pickle key or a new device id looks like
     * from the inside, and both remain possible mid-hydration.
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
        // Read once per run, not per row: an override set mid-run by a test is not a case this needs
        // to react to, and re-reading it 1000 times per row would be pure waste in production.
        const bounds = getEventIndexBounds();

        this.hydrating = true;

        try {
            await this.manifestReadyPromise;
            if (this.closed || epoch !== this.hydrationEpoch || !this.db || !this.dek) return;

            // Compute this run's walk order: every chunk this user has, newest-member-first, from
            // manifest/chunkMembers alone -- no I/O, no chunk decrypted merely to learn its own
            // timestamps. Sliced across this method's own 30ms deadline, the same cost class
            // review-pr-c.md C2-F1 already sliced its own whole-manifest pass at; see hydrate's own
            // docstring for why this replaced a per-page sort plus k-way merge over manifest ids.
            const chunkMaxTs = new Map<number, number>();
            let seedSliceStart = now();
            for (const [chunkId, members] of this.chunkMembers) {
                if (this.closed || epoch !== this.hydrationEpoch || !this.db || !this.dek) return;
                let max = -Infinity;
                for (const id of members) {
                    const ts = this.manifest.get(id)?.ts;
                    if (ts !== undefined && ts > max) max = ts;
                }
                if (max > -Infinity) chunkMaxTs.set(chunkId, max);
                // Checked every chunk, not gated behind a count threshold: there are far fewer
                // chunks than events (thousands, not hundreds of thousands), but each one costs a
                // pass over its own membership (tens of ids), so a fixed-count gate here could let
                // real elapsed time run well past the deadline before ever looking -- the same
                // per-item check {@link loadManifest}'s own per-page loop uses, just at chunk
                // granularity instead of page granularity.
                if (now() - seedSliceStart >= HYDRATION_SLICE_DEADLINE_MS) {
                    await yieldToEventLoop();
                    if (this.closed || epoch !== this.hydrationEpoch || !this.db || !this.dek) return;
                    seedSliceStart = now();
                }
            }
            const sortedChunkIds = Array.from(chunkMaxTs.entries())
                .sort((a, b) => b[1] - a[1])
                .map((pair) => pair[0]);

            for (let i = 0; i < sortedChunkIds.length; i += HYDRATION_CHUNK_BATCH) {
                if (this.closed || epoch !== this.hydrationEpoch || !this.db || !this.dek) return;
                const dek = this.dek;
                // Checked before each batch of chunk reads, not only once per page of ids the old
                // shape managed: bounds the decrypt-past-budget overshoot to at most one batch's
                // worth of chunks rather than a whole 1,000-id page's worth (see hydrate's own
                // docstring, "restores most of the budget-before-decrypt property").
                if (this.residentByteEstimate() >= bounds.hotWindowBytes) {
                    this.residentBudgetExceeded = true;
                    log.info(`EventIndex: hydration stopped at the resident budget after ${hydratedCount} events`);
                    return;
                }
                const group = sortedChunkIds.slice(i, i + HYDRATION_CHUNK_BATCH);

                // A chunk another caller (materializeIfPending, racing this run for the same id) is
                // already decrypting is awaited, not re-read; everything else is fetched together in
                // ONE read-only transaction, decrypted only after it settles.
                const inFlight = new Map<number, Promise<Map<string, StoredEvent>>>();
                const toFetch: number[] = [];
                for (const chunkId of group) {
                    const attempt = this.materializingChunks.get(chunkId);
                    if (attempt) inFlight.set(chunkId, attempt);
                    else toFetch.push(chunkId);
                }

                const fetchedRows = new Map<number, ChunkRecord>();
                if (toFetch.length > 0) {
                    const db = this.db;
                    const tx = db.transaction("chunks", "readonly");
                    const store = tx.objectStore("chunks");
                    const reqs = toFetch.map((chunkId) => ({ chunkId, req: store.get([userId, chunkId]) }));
                    await txDone(tx);
                    if (this.closed || epoch !== this.hydrationEpoch || !this.db || !this.dek) return;
                    for (const { chunkId, req } of reqs) {
                        const row = req.result as ChunkRecord | undefined;
                        if (row) fetchedRows.set(chunkId, row);
                    }
                }

                let sliceStart = now();
                for (const chunkId of group) {
                    if (this.closed || epoch !== this.hydrationEpoch) return;

                    let chunkEntries: Map<string, StoredEvent>;
                    const shared = inFlight.get(chunkId);
                    if (shared) {
                        try {
                            chunkEntries = await shared;
                        } catch {
                            continue; // The in-flight owner already reports/handles its own failure.
                        }
                    } else {
                        const row = fetchedRows.get(chunkId);
                        if (!row) continue; // Gone (disk budget/redaction) between the snapshot above and this read.
                        // Registered before the decrypt starts, exactly like decryptChunkOnce, so a
                        // concurrent materializeIfPending pull for the same id shares this attempt
                        // instead of issuing its own single-chunk read.
                        const attempt = (async (): Promise<Map<string, StoredEvent>> =>
                            new Map(
                                await decryptBinaryJson<Array<[string, StoredEvent]>>(
                                    dek,
                                    row.blob,
                                    chunkAad(userId, chunkId),
                                ),
                            ))();
                        this.materializingChunks.set(chunkId, attempt);
                        try {
                            chunkEntries = await attempt;
                        } catch {
                            this.materializingChunks.delete(chunkId);
                            log.warn(
                                "EventIndex: stored ciphertext could not be decrypted; wiping leftover for this user",
                            );
                            this.clearIndexMaps();
                            await this.deleteUserRecords(userId);
                            await this.saveMeta({
                                userId,
                                salt: encodeBase64(salt),
                                userVersion: 0,
                                manifestPageCount: 0,
                                nextChunkId: this.nextChunkId,
                            });
                            this.userVersion = 0;
                            return;
                        }
                        this.materializingChunks.delete(chunkId);
                        if (!this.chunkInfo.has(chunkId)) {
                            const { minTs, maxTs } = tsRangeOf(chunkEntries);
                            this.chunkInfo.set(chunkId, {
                                bytes: row.blob.ct.length + row.blob.iv.length,
                                minTs,
                                maxTs,
                            });
                            heapPushTs(this.diskChunkHeap, { ts: maxTs, id: String(chunkId) });
                        }
                    }
                    if (this.closed || epoch !== this.hydrationEpoch) return;

                    // Admit this chunk's members newest-first. No cache to maintain here and no
                    // chunk read or parsed twice: the outer walk never revisits a chunkId, by
                    // construction (D5's own target).
                    const members = Array.from(this.chunkMembers.get(chunkId) ?? []).sort(
                        (a, b) => (this.manifest.get(b)?.ts ?? 0) - (this.manifest.get(a)?.ts ?? 0),
                    );
                    for (const id of members) {
                        if (this.events.has(id)) continue;
                        const stored = chunkEntries.get(id);
                        if (!stored) continue; // Redacted since the manifest was built; nothing left to read.

                        // Newest-first hydration stops here, at the moment adding another row would
                        // breach HOT_WINDOW_BYTES: everything from this row onward for the rest of
                        // this run stays on disk, un-hydrated -- never deleted, still reachable via
                        // materializeIfPending on demand or the streamed cold scan increment E adds.
                        // Because rows are now visited newest-first, the rows left un-hydrated when
                        // this fires are genuinely the oldest, not an artefact of key order (C-F1).
                        if (this.residentByteEstimate() >= bounds.hotWindowBytes) {
                            this.residentBudgetExceeded = true;
                            log.info(
                                `EventIndex: hydration stopped at the resident budget after ${hydratedCount} events`,
                            );
                            return;
                        }
                        this.materializeRow(userId, stored);
                        hydratedCount++;
                    }

                    const elapsedInSlice = now() - sliceStart;
                    if (elapsedInSlice >= HYDRATION_SLICE_DEADLINE_MS) {
                        longestSliceMs = Math.max(longestSliceMs, elapsedInSlice);
                        await yieldToEventLoop();
                        if (this.closed || epoch !== this.hydrationEpoch) return;
                        // A safe point for the merge every row's own indexTokens() call deferred (B2-F1):
                        // outside any row's own task, right after a real yield, so its own tens-of-milliseconds
                        // cost is never added on top of one already in progress.
                        this.flushVocabularyMergeIfDue();
                        sliceStart = now();
                    }
                }
                longestSliceMs = Math.max(longestSliceMs, now() - sliceStart);
                // A second safe point, for a batch that ends without ever crossing the slice deadline
                // (a small last batch, most commonly): otherwise a deferred merge could sit unflushed
                // until whatever live write happens to come along next -- see
                // flushVocabularyMergeIfDue's own caller in indexTokens, which only re-checks when
                // *something* is indexed, not on a timer.
                this.flushVocabularyMergeIfDue();

                // Once per batch, not once per row: cheap in the common case (one scalar comparison),
                // and disk usage only ever grows from writes, never from hydration itself decrypting
                // pre-existing rows -- see enforceDiskBudget's own docstring -- so this exists purely
                // to let a disk that was *already* over budget when this session started (restored
                // from meta) self-correct as hydration's own decrypts populate diskChunkHeap with
                // candidates, rather than waiting for an unrelated future write to trigger it.
                if (this.persistEnabled) await this.enforceDiskBudget(userId);
                if (this.closed || epoch !== this.hydrationEpoch) return;
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
                    `longest slice ${longestSliceMs.toFixed(1)}ms, order manifest-ts-desc`,
            );
        }
    }

    /**
     * Fold one already-decrypted event into every in-memory structure exactly as the old,
     * fully-synchronous restore did: index its tokens, and file it into its room's ordered list.
     *
     * **Synchronous, unlike schema v2's own `materializeRow`** -- the decrypt this needed used to be
     * per-event and lived *inside* this method; schema v3's decrypt is per-*chunk*, and happens once,
     * shared, in {@link decryptChunkOnce} before this is ever called. That is a real simplification,
     * not just a rename: every caller already re-checks `closed`/{@link hydrationEpoch} immediately
     * after its own chunk decrypt resolves, so this method itself no longer needs to -- there is no
     * `await` left inside it for a teardown to land during.
     *
     * Also drains {@link pendingRedactions}: if this row's own `editIds` names an id a redaction already arrived for
     * (necessarily before this row could be hydrated to resolve it, an edit never being filed under its own id), the
     * record this row would have created is redacted on arrival instead of being inserted at all, and its disk row is
     * queued for deletion. This is the one path through which a redaction that raced hydration still ends up removing
     * content in memory and on disk, which is the invariant this exists to not regress.
     *
     * Belt-and-braces idempotency: every caller is meant to check residency before reaching here
     * ({@link hydrate}'s loop, {@link materializeIfPending}'s own re-checks), but this guard is what
     * makes a future caller that forgets one fail safe rather than silently duplicate the id in
     * {@link roomOrder}, which has no "already present?" check of its own.
     */
    private materializeRow(userId: string, stored: StoredEvent): void {
        if (this.events.has(stored.eventId)) return;

        const redactedByPendingEdit = (stored.editIds ?? []).some((id) => this.pendingRedactions.has(id));
        if (redactedByPendingEdit) {
            for (const id of stored.editIds ?? []) this.pendingRedactions.delete(id);
            this.enqueueDeleteRecord(userId, stored.eventId);
            return;
        }

        this.events.set(stored.eventId, stored);
        this.plainTextByteEstimate += stored.searchText.length + 64;
        for (const editId of stored.editIds ?? []) this.editTargets.set(editId, stored.eventId);
        // deferMerge: true -- see indexTokens' docstring. hydrate()'s own loop flushes a deferred merge
        // at its next safe point (a page boundary or a slice yield), never inside this row's own task.
        this.indexTokens(stored.eventId, stored.searchText, true);
        this.insertRoomOrder(stored);

        // Unlike schema v2, nothing here touches ciphertextBytes/chunkInfo: that accounting is
        // entirely per-chunk now, owned by whichever path decrypted the chunk this event came from
        // ({@link readChunkEntries}) or wrote it ({@link flushLiveWrites}) -- this method only ever
        // folds an *already-accounted-for* event into memory.
        heapPushTs(this.residentHeap, { ts: stored.originServerTs, id: stored.eventId });
        this.oldestIndexedTs =
            this.oldestIndexedTs === undefined
                ? stored.originServerTs
                : Math.min(this.oldestIndexedTs, stored.originServerTs);
        this.oldestResidentTs =
            this.oldestResidentTs === undefined
                ? stored.originServerTs
                : Math.min(this.oldestResidentTs, stored.originServerTs);
    }

    /**
     * Pull one not-yet-hydrated event into memory immediately, if there is one, so a write path about to consult
     * {@link events} for `targetId` sees the disk copy instead of treating a record that already exists as brand new;
     * see {@link addEventToIndex}, {@link addHistoricEvents} and {@link deleteEvent}, all of which call this before
     * touching {@link events} for an id that came from outside. Without it, a live event or a crawler batch naming an
     * id {@link hydrate} has not reached yet would be folded into the index as if new -- silently dropping whatever
     * the disk copy already held (an `editIds` list, a `hasFile` flag from a later edit) the moment the resulting
     * persist overwrites it.
     *
     * **Bounded chunk read, per this increment's own design rule.** `targetId`'s chunk is looked up
     * from {@link manifest} (O(1) -- no store-wide scan) and decrypted whole ({@link
     * decryptChunkOnce}, at most {@link CHUNK_TARGET_BYTES}): the target event is always materialized,
     * unconditionally, because the caller is about to act on it synchronously -- but the chunk's
     * *other* events, already decrypted for free by the same read, are kept too only while there is
     * still room under `HOT_WINDOW_BYTES`, so a single on-demand pull can never grow the resident set
     * past budget the way materializing an entire chunk unconditionally could. Keeping what budget
     * allows (rather than discarding it) means a later pull that lands in the *same* chunk never
     * re-pays for a decrypt this one already did.
     *
     * A no-op whenever there is nothing to pull in: the id is already resident, hydration is not running (so nothing
     * could be pending), this session has nothing persisted to read from, or the id is not in the manifest at all
     * (genuinely new). Not itself sliced -- unlike {@link hydrate}'s own paging, this is one chunk, and the cost is
     * paid once per distinct chunk, only while hydration is running.
     *
     * `closed`/`epoch` and residency are both re-checked after the chunk decrypt resolves, for the
     * same reason {@link addEventToIndex}'s own post-await check exists: a teardown or a concurrent
     * materialize attempt for the same chunk (via {@link decryptChunkOnce}'s own de-duplication)
     * could have landed while the read was in flight.
     *
     * Never needs to flush {@link liveWriteBuffer} first, despite reading disk directly: this method only ever runs
     * for an id *not yet* in {@link events} (the first line above), and every id in {@link liveWriteBuffer} is, by
     * construction, already in {@link events} -- {@link schedulePersistEvent} is only ever reached after {@link
     * upsertEvent} has added the record. The two sets are therefore always disjoint, so no id this method looks up on
     * disk can ever be the one a buffered-but-not-yet-flushed write is about to change.
     */
    private async materializeIfPending(targetId: string): Promise<void> {
        if (this.events.has(targetId)) return;
        // Ordinarily "hydration is not running" means "hydration has visited every row, so nothing
        // can be pending" -- but not once residentBudgetExceeded is true: hydrate() may have
        // stopped early, on purpose, leaving rows un-hydrated behind the resident budget, so this
        // must keep consulting disk for them even after hydrating itself goes false. See
        // residentBudgetExceeded's own docstring.
        if (!this.hydrating && !this.residentBudgetExceeded) return;
        if (!this.persistEnabled || !this.db || !this.dek || !this.userId) return;
        const userId = this.userId;
        const dek = this.dek;
        const epoch = this.hydrationEpoch;
        // Unlike schema v2's direct-by-primary-key get(), resolving an id to *which chunk* holds it
        // needs the manifest -- so this has to wait for it (manifestReadyPromise) before consulting
        // it, which a caller this early can otherwise race: `initEventIndex` sets `hydrating` before
        // it even starts `loadCrawlerCheckpoints`, and a live write landing during that decrypt
        // (review-pr-a.md's F9) reaches here well before the manifest has loaded a single entry. The
        // wait is bounded -- the same promise `hydrate()` itself awaits -- and free once the
        // manifest is already ready, the overwhelmingly common case.
        await this.manifestReadyPromise;
        if (this.closed || epoch !== this.hydrationEpoch) return;
        if (this.events.has(targetId)) return;
        const chunkId = this.manifest.get(targetId)?.chunkId;
        if (chunkId === undefined) return;

        let entries: Map<string, StoredEvent>;
        try {
            entries = await this.decryptChunkOnce(userId, dek, chunkId);
        } catch (e) {
            // A handle closed out from underneath us by another tab's onversionchange, or genuinely
            // corrupt ciphertext. Either way: hydrate()'s own loop will reach this same chunk later
            // and respond to real corruption by wiping the whole index, which is right for a rotated
            // key; until then, this is a bounded, self-limiting cost (a repeated failed read for this
            // one chunk, only if it is asked for again before hydrate() gets there), not worth
            // tearing a session down over on its own.
            log.debug("EventIndex: materializeIfPending could not read the target chunk; treating it as absent", e);
            return;
        }
        // A teardown or re-initialisation, or a concurrent materialize attempt for the same chunk (see the
        // docstring above), could have landed while the read above was in flight; re-check both rather than
        // resurrect a record into an index that has moved on, or duplicate one already materialized in the meantime.
        if (this.closed || epoch !== this.hydrationEpoch) return;
        if (this.events.has(targetId)) return;
        // A deletion racing this same read (see pendingDiskDeletes's own docstring): `targetId` left
        // the resident set and is queued for a disk rewrite that has not landed yet, so `entries`
        // (read just above) can still carry its now-stale ciphertext. Must not resurrect it.
        if (this.pendingDiskDeletes.has(targetId)) return;
        // The *other* window (found empirically via coldSearchScan's own R9 flake, same fix
        // applies here): this read could have started before a concurrent deletion's
        // manifestRemove + disk commit, both of which can finish before this line runs, clearing
        // pendingDiskDeletes too -- `entries` is then a stale pre-deletion snapshot. The manifest is
        // the authoritative live answer to "is this id still on disk at all", checked fresh here
        // rather than trusted from before the decrypt.
        if (!this.manifest.has(targetId)) return;
        const targetStored = entries.get(targetId);
        if (!targetStored) return; // Redacted since the manifest was consulted; nothing left to pull in.

        this.materializeRow(userId, targetStored);
        const bounds = getEventIndexBounds();
        for (const [id, stored] of entries) {
            if (id === targetId || this.events.has(id) || this.pendingDiskDeletes.has(id) || !this.manifest.has(id)) {
                continue;
            }
            if (this.residentByteEstimate() >= bounds.hotWindowBytes) break;
            this.materializeRow(userId, stored);
        }
        // Pulling in an old chunk on demand must not let the resident set grow past budget
        // unboundedly (the loop above already stops taking more once it would, but the target event
        // itself was materialized unconditionally). `targetId` is protected from being evicted by
        // this very call, so whichever caller asked for it (addEventToIndex, addHistoricEvents,
        // deleteEvent) still finds it resident immediately afterwards.
        this.enforceResidentBudget(targetId);
    }

    /**
     * Evict resident records, oldest `originServerTs` first, until {@link residentByteEstimate} is
     * back under `HOT_WINDOW_BYTES` -- the hot-window half of `research/SYNTHESIS.md` §3.6.
     * Eviction only ever removes a record from memory ({@link removeFromIndex}); it never touches
     * the record's disk row, which is the whole point (rows beyond the resident budget stay
     * findable later, via the streamed cold scan increment E adds).
     *
     * Every candidate this pops from {@link residentHeap} is durable by construction -- see that
     * field's own docstring for why entries are pushed only from {@link flushLiveWrites} and {@link
     * materializeRow}, never at the moment a record becomes resident -- so, unlike an earlier
     * version of this method, there is no "not yet durable, defer it" case to handle here at all;
     * the only thing skipped (and re-pushed, so a later call can reconsider it) is a **stale**
     * entry, whose id is no longer resident or has been re-timed since (see {@link heapPushTs}'s
     * docstring), and `protectedId` (see below).
     *
     * @param protectedId - An id to never evict during *this* call, however old, because the caller
     *     just on-demand-materialized it ({@link materializeIfPending}) and is about to act on it
     *     synchronously. Without this, a caller like {@link deleteEvent} that pulls a very old row
     *     in specifically to remove it could find eviction got there first: `events.has(targetId)`
     *     would read false, `deleteEvent` would report nothing to remove, and the redaction would
     *     silently fail to reach disk. The protection is one call's worth, not permanent: the
     *     record becomes a normal candidate again the next time anything triggers this method.
     *
     * Called from {@link flushLiveWrites}, once a batch's writes actually commit (so the budget can
     * lag insertion by at most one batch's worth, never unboundedly -- see {@link residentHeap}'s
     * docstring for why calling this eagerly at every insertion was tried and measured to make a
     * 200k-event ingest not finish inside a 15-minute harness timeout), and from {@link
     * materializeIfPending}, immediately after an on-demand pull, with `protectedId` set.
     */
    private enforceResidentBudget(protectedId?: string): void {
        const bounds = getEventIndexBounds();
        if (this.residentByteEstimate() <= bounds.hotWindowBytes) return;
        const deferred: TsEntry[] = [];
        let evictedMaxTs: number | undefined;
        while (this.residentByteEstimate() > bounds.hotWindowBytes && this.residentHeap.length > 0) {
            const top = heapPopMinTs(this.residentHeap)!;
            const stored = this.events.get(top.id);
            if (!stored || stored.originServerTs !== top.ts) continue; // Stale: gone, or re-timed.
            if (top.id === protectedId) {
                deferred.push(top);
                continue;
            }
            this.removeFromIndex(top.id);
            evictedMaxTs = evictedMaxTs === undefined ? top.ts : Math.max(evictedMaxTs, top.ts);
        }
        for (const entry of deferred) heapPushTs(this.residentHeap, entry);
        if (evictedMaxTs !== undefined) {
            // The new floor is at most evictedMaxTs (everything actually evicted is gone), but a
            // heap pop is non-decreasing, so a *deferred* entry popped before some later-evicted one
            // can still be resident with a smaller ts than evictedMaxTs -- min-heap pop order alone
            // does not let eviction skip over a deferred entry the way it can skip a merely-stale
            // one. Folding in the deferred batch's own minimum keeps this a genuine floor (at most
            // the true new minimum, matching residentHeap's claim to be exact) rather than
            // overstating coverage the way a plain evictedMaxTs cutoff could whenever a deferral
            // happened to land ahead of an eviction in pop order.
            const deferredMinTs = deferred.length > 0 ? Math.min(...deferred.map((e) => e.ts)) : undefined;
            const cutoff = deferredMinTs === undefined ? evictedMaxTs : Math.min(evictedMaxTs, deferredMinTs);
            this.oldestResidentTs =
                this.oldestResidentTs === undefined ? cutoff : Math.max(this.oldestResidentTs, cutoff);
            this.residentBudgetExceeded = true;
        }
    }

    /**
     * Delete the oldest on-disk **chunks**, by each chunk's own oldest member `originServerTs`,
     * until {@link ciphertextBytes} is back under `DISK_BUDGET_BYTES` -- the disk half of
     * `research/SYNTHESIS.md` §3.6 ("drop = delete": unlike {@link enforceResidentBudget}, this
     * removes the row itself, not just its residency). Schema v3 evicts whole chunks, not individual
     * events -- a chunk is one row, so this is also exact and cheap: no per-event accounting to
     * reconcile, no partial-chunk rewrite. A cheap no-op in the overwhelmingly common case
     * (`ciphertextBytes` already under budget).
     *
     * Candidates come from {@link diskChunkHeap}, which -- see that field's docstring -- only knows
     * about chunks this session has written or decrypted at least once. If it runs dry before the
     * total is back under budget (nothing left to pop, or every remaining entry turns out stale),
     * this stops there rather than guessing: the remaining excess is real, but this session does
     * not yet know which chunks account for it, and a future call (the next write, or hydration
     * reaching further) will have more information than this one does.
     *
     * **Ordered by each chunk's `maxTs`, not `minTs` (review-pr-d.md D4).** Chunks are not
     * time-clustered -- a round-robin multi-room crawl packs events from many rooms, at very
     * different points in their own timelines, into whichever chunk happens to be open at that
     * moment -- so a chunk's oldest and newest members can be very far apart. Popping by `minTs`
     * deleted a chunk for the age of its *oldest* member while its newest members, sometimes far
     * newer than content in chunks left behind, died with it: a disk budget that was supposed to
     * drop the oldest content instead dropped events newer than ones it kept, by up to the full
     * span between a chunk's own oldest and newest member. Popping by `maxTs` means every chunk
     * this deletes has *every* member at least as old as that chunk's own newest -- the guarantee
     * this class can actually make at chunk granularity: **no chunk is deleted while a chunk with a
     * strictly older `maxTs` survives.** This is honestly weaker than the old per-event guarantee
     * ("nothing newer than a retained event is ever deleted"), which chunking cannot preserve
     * exactly without either time-clustering chunks at write time or rewriting an evicted chunk's
     * surviving newer members into a fresh one before dropping it -- both larger changes than this
     * increment makes; see `research/review-pr-d.md` D4 for the full discussion of why this is the
     * cheapest correct fix rather than the complete one. `oldestIndexedTs`, the user-visible
     * coverage floor, is derived from the manifest *after* deletion ({@link
     * deleteRecordsForDiskBudget}), not assumed from what was just deleted, precisely because a
     * chunk with an older stray member can still survive even under this ordering.
     */
    private async enforceDiskBudget(userId: string): Promise<void> {
        const bounds = getEventIndexBounds();
        if (this.ciphertextBytes <= bounds.diskBudgetBytes) return;
        const toDelete: number[] = [];
        let projected = this.ciphertextBytes;
        while (projected > bounds.diskBudgetBytes && this.diskChunkHeap.length > 0) {
            const top = heapPopMinTs(this.diskChunkHeap)!;
            const chunkId = Number(top.id);
            const info = this.chunkInfo.get(chunkId);
            if (!info || info.maxTs !== top.ts) continue; // Stale: gone, or its maxTs moved since.
            toDelete.push(chunkId);
            projected -= info.bytes;
        }
        if (toDelete.length === 0) return;
        await this.deleteRecordsForDiskBudget(userId, toDelete);
    }

    /**
     * The write half of {@link enforceDiskBudget}: delete `chunkIds` from the `chunks` store and
     * update the persisted disk-byte total and coverage floor in `meta`, in one bounded transaction
     * over both stores, then only after it commits mutate the live accounting to match -- the same
     * commit-before-mutate discipline every other disk-touching path in this class follows.
     *
     * Every member event of a deleted chunk ({@link chunkMembers}) leaves the manifest and, if still
     * resident (old by timestamp, but not yet reached by {@link enforceResidentBudget}), memory too:
     * "drop = delete" means a resident event has no business staying resident on the strength of a
     * memory copy whose disk backing has just been pulled out from under it.
     *
     * **`oldestIndexedTs` is derived from {@link manifestOldestTs} after the deletions are applied
     * in memory, never assumed from `deletedMaxTs` (review-pr-d.md D4).** Because {@link
     * enforceDiskBudget} orders eviction by each chunk's own `maxTs` and chunks are not
     * time-clustered, a *surviving* chunk can still hold a member older than every deleted chunk's
     * `maxTs` -- assuming `Math.max(oldestIndexedTs, deletedMaxTs)` (the old formula) would then
     * claim a coverage floor newer than what is actually still on disk and searchable, the "newer
     * than {date}" `SearchWarning` text lying in the direction that hides real content. {@link
     * manifest} already reflects every removal by the time this reads it (`manifestRemove` below
     * runs first), so the scan is exact and free of that assumption.
     */
    private async deleteRecordsForDiskBudget(userId: string, chunkIds: number[]): Promise<void> {
        if (!this.db || chunkIds.length === 0) return;
        let newTotal = this.ciphertextBytes;
        for (const chunkId of chunkIds) newTotal -= this.chunkInfo.get(chunkId)?.bytes ?? 0;

        // Maintained here too, per the manifest's own docstring: every event of a chunk genuinely
        // leaving disk must leave the manifest, or hydrate() would later try (and harmlessly fail) to
        // read a chunk that is no longer there, and shouldCrawl's per-room floors would still count
        // its events. chunkMembers is snapshotted to an array first: manifestRemove mutates the very
        // Set this would otherwise be iterating.
        const evictedIds: string[] = [];
        for (const chunkId of chunkIds) {
            const members = this.chunkMembers.get(chunkId);
            if (members) evictedIds.push(...members);
        }
        for (const id of evictedIds) this.manifestRemove(id);
        // Authoritative, post-removal: see this method's own docstring for why this must not be
        // `Math.max(oldestIndexedTs, deletedMaxTs)`.
        const newOldest = this.manifestOldestTs();
        const dek = this.dek;
        const manifestRecords = dek ? await this.prepareManifestPageWrites(userId, dek) : [];
        const oldestIndexedTsRecord = dek ? await this.prepareOldestIndexedTsWrite(userId, dek, newOldest) : null;

        const meta = await this.loadMeta(userId);
        const tx = this.db.transaction(["chunks", "meta"], "readwrite");
        const store = tx.objectStore("chunks");
        for (const chunkId of chunkIds) store.delete([userId, chunkId]);
        for (const rec of manifestRecords) tx.objectStore("meta").put(rec);
        if (oldestIndexedTsRecord) tx.objectStore("meta").put(oldestIndexedTsRecord);
        if (meta) {
            tx.objectStore("meta").put({
                ...meta,
                diskBytes: newTotal,
                manifestPageCount: this.manifestPages.length,
                nextChunkId: this.nextChunkId,
            });
        }
        await txDone(tx);

        this.ciphertextBytes = newTotal;
        // Encrypted, not cleartext (review-pr-c.md C2-F4); persisted just above, in the same
        // transaction as everything else this deletion touches.
        this.oldestIndexedTs = newOldest;
        this.diskBudgetDropped = true;
        for (const chunkId of chunkIds) {
            this.chunkInfo.delete(chunkId);
            if (chunkId === this.openChunkId) {
                // The open chunk itself was old enough to be dropped (a long-idle session, or a very
                // small hot window): nothing left to append to; the next write allocates a fresh one.
                this.openChunkId = undefined;
                this.openChunkEntries.clear();
                this.openChunkPlainBytes = 0;
            }
        }
        for (const id of evictedIds) {
            if (this.events.has(id)) this.removeFromIndex(id);
        }
    }

    /**
     * Delete every row belonging to one user: chunks, any legacy `events` rows a v2-to-v3 conversion
     * has not yet reached, checkpoints, the `meta` row and every manifest page ({@link
     * ManifestPageRecord}). Per-user rather than per-database because the database is shared by
     * every account that has signed in to this origin. The `meta` row goes too, and with it the
     * salt, so the next {@link initEventIndex} derives a *different* DEK and any row that somehow
     * survived is unreadable afterwards -- including a manifest page, which is exactly why those
     * must be deleted explicitly rather than left as orphaned ciphertext nothing will ever be able to
     * open again: {@link manifestPageKey} embeds `userId` as a plain string prefix, not as a separate
     * indexed column, so `IDBKeyRange.bound` over that prefix is what finds them all without needing
     * to know how many pages exist.
     */
    private async deleteUserRecords(userId: string): Promise<void> {
        if (!this.db) return;
        const chunkTx = this.db.transaction("chunks", "readwrite");
        const chunkStore = chunkTx.objectStore("chunks");
        const chunkKeys = await idbReq(chunkStore.getAllKeys(userChunkKeyRange(userId)));
        for (const key of chunkKeys) chunkStore.delete(key);
        await txDone(chunkTx);

        // A v2-to-v3 conversion this user may still be mid-way through leaves rows here until it
        // reaches them; the store may not even exist at all for a database that never had schema v2.
        if (this.db.objectStoreNames.contains("events")) {
            const evTx = this.db.transaction("events", "readwrite");
            const evStore = evTx.objectStore("events");
            const evRows = await idbReq(evStore.index("byUser").getAllKeys(userId));
            for (const key of evRows) evStore.delete(key);
            await txDone(evTx);
        }

        const cpTx = this.db.transaction("checkpoints", "readwrite");
        const cpStore = cpTx.objectStore("checkpoints");
        const cpRows = (await idbReq(cpStore.index("byUser").getAll(userId))) as CheckpointRecord[];
        for (const row of cpRows) cpStore.delete(row.id);
        await txDone(cpTx);

        const metaTx = this.db.transaction("meta", "readwrite");
        const metaStore = metaTx.objectStore("meta");
        metaStore.delete(userId);
        const manifestPrefix = `${userId}|manifest:`;
        // ￿ is not a character any page index's decimal digits can produce, so this bound
        // catches every "${userId}|manifest:<n>" key and nothing else -- the same technique
        // vocabularyRange uses for a contiguous prefix range in a sorted key space.
        const manifestKeys = await idbReq(
            metaStore.getAllKeys(IDBKeyRange.bound(manifestPrefix, manifestPrefix + "￿")),
        );
        for (const key of manifestKeys) metaStore.delete(key);
        metaStore.delete(oldestIndexedTsKey(userId)); // review-pr-c.md C2-F4's own encrypted row
        await txDone(metaTx);
    }

    /**
     * A rough in-memory size for {@link getStats}, used when nothing has been persisted: the searchable text plus a
     * flat 64 bytes per record. It exists so the settings panel shows a plausible figure rather than "0 bytes", and no
     * decision depends on the number.
     *
     * O(1): returns {@link plainTextByteEstimate}, a running total maintained incrementally at every site that adds,
     * changes or removes a record's `searchText` -- the same "track it, do not scan for it" treatment {@link
     * ciphertextBytes} already gets from {@link recordBytes} -- rather than summing {@link events} fresh on every
     * call, which {@link getStats} cannot afford at the roughly-every-3s cadence it is called at while the Security
     * panel is open.
     */
    private estimatePlainSize(): number {
        return this.plainTextByteEstimate;
    }

    /**
     * The resident-set byte estimate `hydrate()`/{@link enforceResidentBudget} check against
     * `HOT_WINDOW_BYTES`; see {@link RESIDENT_BYTES_PER_EVENT_ESTIMATE}'s docstring for why this is
     * a flat per-event figure rather than {@link plainTextByteEstimate}. `HOT_WINDOW_BYTES` gates
     * *hydrated events only* -- it is `SYNTHESIS.md`'s "instantly searchable" tier, and the
     * coordinator's correction to review-pr-c.md C2-F2 restored that meaning: an intermediate
     * revision counted {@link manifest}'s own resident cost in here too, which shrank admitted
     * events from ~49k to ~21k at 200k/small tier (measurements-pr-c.md §10.2) -- correct in the
     * narrow sense that the manifest's real memory cost was no longer invisible, but the wrong
     * *tier* for it to count against: the manifest is its own resident tier, with its own ceiling
     * (`eventIndexBounds.ts`'s `manifestCeilingBytes`), not a tax on the hot window. See {@link
     * getStats}' `manifestBytes` for the manifest's own accounting, tracked and reported but never
     * summed into this method. O(1): `events.size` is a `Map`'s own maintained count.
     */
    private residentByteEstimate(): number {
        return this.events.size * RESIDENT_BYTES_PER_EVENT_ESTIMATE;
    }

    /**
     * Ask the browser to make this origin's storage persistent (best-effort; not every browser
     * grants it, and some never prompt at all), once, at the moment this user's index is first
     * created; see {@link initEventIndex}'s only call site and {@link storagePersisted}'s docstring
     * for why it is not repeated on a later re-open. Fire-and-forget by design -- never awaited, and
     * its own rejection is caught here rather than left to become an unhandled one -- because a
     * permission prompt in some browsers could otherwise hang around waiting for the user, and
     * `initEventIndex` must never wait on that.
     */
    private requestStoragePersistenceOnce(): void {
        const storage = (globalThis.navigator as { storage?: StorageManager } | undefined)?.storage;
        if (!storage?.persist) return;
        storage
            .persist()
            .then((granted) => {
                this.storagePersisted = granted;
            })
            .catch((e: unknown) => {
                log.debug("EventIndex: navigator.storage.persist() failed", e);
                this.storagePersisted = false;
            });
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
     *
     * {@link sortedVocabulary}, {@link pendingVocabulary} and {@link plainTextByteEstimate} are cleared here rather
     * than in {@link resetMemory}, alongside {@link inverted} and {@link events}: all three mirror derived state of
     * exactly those two structures, so they belong with the group hydrate populates, not with the broader session
     * reset below.
     */
    private clearIndexMaps(): void {
        this.events.clear();
        this.editTargets.clear();
        this.foldedSearchText.clear();
        this.inverted.clear();
        this.roomOrder.clear();
        this.ciphertextBytes = 0;
        this.chunkInfo.clear();
        this.chunkMembers.clear();
        this.residentHeap.length = 0;
        this.diskChunkHeap.length = 0;
        this.oldestResidentTs = undefined;
        this.oldestIndexedTs = undefined;
        this.residentBudgetExceeded = false;
        this.diskBudgetDropped = false;
        this.crawlBoundDeclined = false;
        this.manifest.clear();
        this.manifestPages.length = 0;
        this.manifestEntryPage.clear();
        this.manifestDirtyPages.clear();
        this.manifestRoomIds.clear();
        this.manifestOldestByRoom.clear();
        this.manifestNewestByRoom.clear();
        this.manifestLoaded = false;
        this.openChunkId = undefined;
        this.openChunkEntries.clear();
        this.openChunkPlainBytes = 0;
        this.nextChunkId = 0;
        this.pendingRedactions.clear();
        this.pendingDiskDeletes.clear();
        this.hydrationFailure = undefined;
        this.plainTextByteEstimate = 0;
        this.sortedVocabulary.length = 0;
        this.pendingVocabulary.length = 0;
        this.searchPartial = false;
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
