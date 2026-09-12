/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/*
 * Synthetic corpus generator for the BrowserEventIndexManager perf harness (element-web PR #34718).
 *
 * Platform-neutral ES module: no Node built-ins (no `Buffer`, no `node:*` imports), so this file is bundled
 * as-is both for the Node harness (`event-index-perf.mjs`) and for the real-Chromium runner (`browser/`). A
 * single source of truth means the "old vs new corpus" bias check in Part 3 is actually comparing corpora,
 * not comparing two independently-written generators that drifted.
 *
 * WHY THIS EXISTS
 * ----------------
 * The original harness's corpus (see `generateCorpusOld` below, preserved verbatim in spirit) had four
 * best-case biases of the first version of this harness: ascending timestamps, even room spread, a thin event shape
 * missing the encrypted-room metadata fields, and an unrealistically small vocabulary. `generateCorpusNew` +
 * `crawlBatches` fix all four:
 *
 *   1. Real crawl order. `BrowserEventIndexManager.insertRoomOrder` binary-search-inserts every event into its
 *      room's ascending-by-timestamp id list. The live-timeline path (`addEventToIndex`) always appends, so it
 *      never pays the splice-at-front cost. The crawler (`EventIndex.ts`'s `crawlerFunc`, `EVENTS_PER_CRAWL =
 *      100`) walks backwards through history in batches of 100 via `addHistoricEvents`, delivering the newest
 *      undelivered events first, the exact case that pays that cost. `crawlBatches()` reproduces this: per
 *      room, newest-first, chunked into batches of 100, rooms visited round-robin the way the crawler's FIFO
 *      checkpoint queue does (dequeue the front room, hand it one batch, re-enqueue at the back if it has more
 *      history left).
 *   2. Zipfian room sizes. `planRoomSizes()` assigns each room a share of the total proportional to
 *      1/(rank+1)^zipfRoomExponent (default 1.0), so a handful of rooms carry most events and the rest trail
 *      off, a few huge rooms, a long tail, rather than an even split.
 *   3. Real-ish event shape. `BrowserEventIndexManager.eventToJson`-equivalent: `EventIndex.ts:eventToJson`
 *      adds `curve25519Key`, `ed25519Key`, `algorithm` (`ev.getWireContent().algorithm`) and
 *      `forwardingCurve25519KeyChain` on top of `getEffectiveEvent()`'s `unsigned` block, for every encrypted
 *      event (see EventIndex.ts:338-357 in the checkout). `buildEventShape()` reproduces those exact field
 *      names, not the wire-content fields "sender_key/session_id/device_id", which do not appear at this
 *      layer (they are on the *wire* `m.room.encrypted` content, already stripped by the time the event reaches
 *      the index). The measured overhead lines up with the ballpark figure anyway (see README.md).
 *   4. Realistic vocabulary and message text. `buildVocabulary()` sizes the vocabulary by Heaps' law
 *      (V = K * tokens^beta) and samples word rank by Zipf's law; `sampleWordCount()` gives a lognormal message
 *      length (median ~10 words, long tail); `accentedShare`/`cjkShare` inject accented-Latin and CJK bodies at
 *      configurable rates, exercising `foldText`'s NFKD path and the "one CJK run = one token" tokenizer
 *      property (`tokenize()` splits only on non-letter/number/underscore, and `\p{L}` covers CJK ideographs).
 */

/* ------------------------------------------------------------------ RNG (seeded, deterministic, no deps) */

/** mulberry32: tiny, fast, good enough statistically for corpus generation; deterministic from an integer seed. */
export function makeRng(seed) {
    let a = seed >>> 0 || 0xc0ffee;
    return function rng() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Standard normal via Box-Muller, drawing from `rng`. */
function randn(rng) {
    let u = 0,
        v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ------------------------------------------------------------------ Zipf sampling */

/**
 * Precompute a cumulative distribution over `n` ranks under a Zipf law with exponent `s`: P(rank r) ∝
 * 1/(r+1)^s. Returns a sampler `() => rank` that does a binary search over the CDF, O(log n) per draw, which
 * is fast enough at the vocabulary/room-count sizes this harness uses (tens of thousands of ranks, millions of
 * draws total at the largest corpus size).
 */
export function makeZipfSampler(rng, n, s) {
    const cdf = new Float64Array(n);
    let sum = 0;
    for (let r = 0; r < n; r++) {
        sum += 1 / Math.pow(r + 1, s);
        cdf[r] = sum;
    }
    for (let r = 0; r < n; r++) cdf[r] /= sum;
    return function sample() {
        const x = rng();
        let lo = 0,
            hi = n - 1;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (cdf[mid] < x) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
}

/** Ranked weights (descending), normalised to sum to `total`, integer, with rounding remainder given to rank 0. */
function zipfShares(n, s, total) {
    const weights = new Array(n);
    let sum = 0;
    for (let r = 0; r < n; r++) {
        weights[r] = 1 / Math.pow(r + 1, s);
        sum += weights[r];
    }
    const shares = weights.map((w) => Math.floor((w / sum) * total));
    const assigned = shares.reduce((a, b) => a + b, 0);
    shares[0] += total - assigned; // remainder to the largest room, never negative since floor() only loses share
    return shares;
}

/* ------------------------------------------------------------------ vocabulary */

const SYLLABLES = [
    "ba",
    "be",
    "bi",
    "bo",
    "bu",
    "ca",
    "ce",
    "ci",
    "co",
    "cu",
    "da",
    "de",
    "di",
    "do",
    "du",
    "fa",
    "fe",
    "fi",
    "fo",
    "fu",
    "ga",
    "ge",
    "gi",
    "go",
    "gu",
    "ha",
    "he",
    "hi",
    "ho",
    "hu",
    "ja",
    "je",
    "ji",
    "jo",
    "ju",
    "ka",
    "ke",
    "ki",
    "ko",
    "ku",
    "la",
    "le",
    "li",
    "lo",
    "lu",
    "ma",
    "me",
    "mi",
    "mo",
    "mu",
    "na",
    "ne",
    "ni",
    "no",
    "nu",
    "pa",
    "pe",
    "pi",
    "po",
    "pu",
    "ra",
    "re",
    "ri",
    "ro",
    "ru",
    "sa",
    "se",
    "si",
    "so",
    "su",
    "ta",
    "te",
    "ti",
    "to",
    "tu",
    "va",
    "ve",
    "vi",
    "vo",
    "vu",
    "wa",
    "we",
    "wi",
    "wo",
    "wu",
    "ya",
    "ye",
    "yi",
    "yo",
    "yu",
];

/** A curated head of genuinely common chat/workplace words, so the top of the frequency curve looks real. */
const COMMON_WORDS = (
    "the you is to for ok thanks meeting please review code today tomorrow yeah lol sure will can that " +
    "this we it on at in deploy branch pr bug fix test ship call sync standup docs ping sorry np cool nice " +
    "done wait actually maybe definitely agree disagree awesome great morning afternoon evening weekend " +
    "monday tuesday wednesday thursday friday saturday sunday project ticket issue merge commit push pull " +
    "request server client config release version update patch hotfix rollback database api endpoint token " +
    "auth login logout error warning info debug log trace yes no not just really quite very much more less " +
    "before after when where why how what who team lead manager customer client user feature flag rollout " +
    "staging prod production dev local env variable function class file folder repo branch main head diff " +
    "commit history blame revert cherry pick rebase squash conflict merge resolve approve comment thread " +
    "reply mention channel room message chat call video audio screen share link invite join leave kick ban " +
    "mute unmute pin unpin edit delete redact search filter sort export import backup restore sync offline " +
    "online status typing seen read unread notification badge settings profile avatar display name device " +
    "session key encrypt decrypt verify trust cross sign device recovery passphrase backup"
).split(/\s+/);

/** A synthetic, pronounceable word from 1-3 syllables, for vocabulary ranks beyond the curated common list. */
function synthWord(rng, existing) {
    let word;
    do {
        const n = 1 + Math.floor(rng() * 3);
        word = "";
        for (let i = 0; i < n; i++) word += SYLLABLES[Math.floor(rng() * SYLLABLES.length)];
    } while (existing.has(word));
    return word;
}

/** ~120 real accented-Latin chat words: precomposed (NFC) so `foldText`'s NFKD-decompose + combining-mark-strip
 *  path actually has combining marks to strip, matching the review's "+1,418 B/event for accented Latin" finding. */
const ACCENTED_WORDS = (
    "café naïve façade über résumé señor jalapeño crème château protégé cliché déjà à où être garçon coeur " +
    "voilà façon désolé bientôt là-bas très bien merci beaucoup s'il vous plaît année après-midi problème " +
    "français français numéro téléphone entrée sortie début fin réunion équipe employé général spécial " +
    "métier carrière société entreprise sécurité qualité vérité réalité créé mis à jour données système " +
    "développeur développement intégré déployé région séparé communiqué démarré arrêté préféré première " +
    "dernière prêt être là déjà vu piñata jalapeños niño mañana señora güey año pequeño español México " +
    "über schön grüße mädchen straße größer könnte müssen für während später natürlich fünf über weiß"
).split(/\s+/);

/** A pool of common CJK ideographs (mixed Chinese/Japanese usage), concatenated so contiguous substrings of
 *  it read as plausible (if not grammatical) CJK text, enough for the tokenizer property under test: a run
 *  with no ASCII word-boundary characters tokenizes as exactly one token, however long. */
const CJK_POOL =
    "的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么" +
    "之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因" +
    "很给名法间斯知世什两次使身者被高已亲其进此话常与活正感见明问力理尔点文几定本公特做外孩相西多然此际数命向员达山" +
    "先失叫轮酒住片";

/**
 * Build a Heaps'-law-sized vocabulary and a Zipfian word sampler.
 *
 * @param totalTokensEstimate - Rough total word-token count the corpus will contain, used to size V.
 * @param opts.heapsK - Heaps' constant K in V = K * tokens^beta.
 * @param opts.heapsBeta - Heaps' exponent, 0.5-0.6 typical for chat text; see module docstring for the
 *     calibration this harness uses (K=21, beta=0.55, anchored to fable-review.md's independently measured
 *     V≈17.5k-19.5k for 8-16-word Zipf messages at 20k-40k events).
 * @param opts.wordZipfExponent - Zipf exponent for word rank->frequency (~1.0-1.1 is the usual natural-language
 *     range; default 1.05).
 */
export function buildVocabulary(totalTokensEstimate, opts, rng) {
    const heapsK = opts.heapsK ?? 21;
    const heapsBeta = opts.heapsBeta ?? 0.55;
    const wordZipfExponent = opts.wordZipfExponent ?? 1.05;
    const targetV = Math.max(64, Math.round(heapsK * Math.pow(Math.max(totalTokensEstimate, 1), heapsBeta)));

    const words = [];
    const seen = new Set();
    for (const w of COMMON_WORDS) {
        if (!seen.has(w)) {
            seen.add(w);
            words.push(w);
        }
        if (words.length >= targetV) break;
    }
    while (words.length < targetV) {
        const w = synthWord(rng, seen);
        seen.add(w);
        words.push(w);
    }

    const sampleRank = makeZipfSampler(rng, words.length, wordZipfExponent);
    return {
        size: words.length,
        heapsK,
        heapsBeta,
        wordZipfExponent,
        word: () => words[sampleRank()],
    };
}

/** Lognormal word count: median ~10 (mu = ln(10)), long tail from sigma, clamped to a sane range. */
function sampleWordCount(rng, medianWords) {
    const mu = Math.log(medianWords);
    const sigma = 0.5;
    const n = Math.round(Math.exp(mu + sigma * randn(rng)));
    return Math.max(1, Math.min(60, n));
}

function asciiBody(rng, vocab, medianWords) {
    const n = sampleWordCount(rng, medianWords);
    const parts = new Array(n);
    for (let i = 0; i < n; i++) parts[i] = vocab.word();
    return parts.join(" ");
}

function accentedBody(rng, medianWords) {
    const n = Math.max(1, Math.min(30, sampleWordCount(rng, Math.max(4, medianWords / 2))));
    const parts = new Array(n);
    for (let i = 0; i < n; i++) parts[i] = ACCENTED_WORDS[Math.floor(rng() * ACCENTED_WORDS.length)];
    return parts.join(" ");
}

/** A contiguous CJK run with no whitespace, 15-40 characters, from CJK_POOL, one tokenizer token however long. */
function cjkBody(rng) {
    const len = 15 + Math.floor(rng() * 26);
    const start = Math.floor(rng() * Math.max(1, CJK_POOL.length - len));
    return CJK_POOL.slice(start, start + len);
}

/* ------------------------------------------------------------------ room sizing */

/**
 * Zipfian room sizes: rank 0 is the largest room. Returns `{ roomIds, sizes, largestShare }`, where
 * `largestShare = sizes[0] / events` is reported so a run can state how concentrated the synthetic account is.
 */
export function planRoomSizes({ events, rooms, zipfRoomExponent }) {
    const s = zipfRoomExponent ?? 1.0;
    const sizes = zipfShares(rooms, s, events);
    const roomIds = Array.from({ length: rooms }, (_, r) => `!perfroom${r}:example.org`);
    const largestShare = sizes[0] / events;
    return { roomIds, sizes, largestShare, zipfRoomExponent: s };
}

/* ------------------------------------------------------------------ event shape */

/** A plausible-looking 32-byte curve25519/ed25519 key, base64, unique per call, not a real key, just the right shape/size. */
function fakeKey(rng) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = Math.floor(rng() * 256);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    // btoa exists in browsers; Node 18+ also exposes a global btoa. Fall back to a manual base64 table if neither.
    if (typeof btoa === "function") return btoa(bin);
    return Buffer.from(bin, "binary").toString("base64");
}

const SENDER_COUNT_DEFAULT = 12;

/**
 * The per-event shape `eventToJson` (EventIndex.ts:338) actually produces for an encrypted-room event: the
 * decrypted `getEffectiveEvent()` object (event_id, room_id, sender, type, origin_server_ts, content, unsigned)
 * plus four fields added only for encrypted events: `curve25519Key`, `ed25519Key`, `algorithm`,
 * `forwardingCurve25519KeyChain`. This is the "+232 B/event" fix (task brief's field names
 * unsigned/algorithm/sender_key/session_id/device_id/relations are an approximation of this; see module
 * docstring point 3 for exactly which fields the real code adds and why sender_key/session_id/device_id do not
 * appear at this layer).
 */
function buildEventShape({ id, roomId, sender, ts, content, senderKeys, ageMs }) {
    return {
        event_id: id,
        room_id: roomId,
        sender,
        type: "m.room.message",
        origin_server_ts: ts,
        content,
        unsigned: { age: ageMs },
        curve25519Key: senderKeys.curve25519Key,
        ed25519Key: senderKeys.ed25519Key,
        algorithm: "m.megolm.v1.aes-sha2",
        forwardingCurve25519KeyChain: [],
    };
}

/* ------------------------------------------------------------------ new generator */

export const NEW_DEFAULTS = {
    events: 20000,
    rooms: 40,
    zipfRoomExponent: 1.0,
    eventsPerCrawl: 100,
    heapsK: 21,
    heapsBeta: 0.55,
    wordZipfExponent: 1.05,
    medianWords: 10,
    accentedShare: 0.1,
    cjkShare: 0.05,
    editRate: 0.02,
    fileRate: 0.03,
    replyRate: 0.05,
    senderCount: SENDER_COUNT_DEFAULT,
    seed: 1234567,
    // Marker tokens for deterministic query benchmarking (namespaced with "zq" so they can never collide with
    // synthesized/curated vocabulary).
    markerToken: "zqmarker",
    markerRate: 37, // one in N events carries the token marker
    prefixWord: "zqprefixword",
    prefixRate: 53,
    prefixQuery: "zqprefixw", // a prefix of prefixWord that is not itself an indexed term
    substringWord: "zqfallbackword",
    substringRate: 101,
    substringQuery: "allbackwor", // a mid-word fragment of substringWord; not a prefix of anything
    missQuery: "zqnomatch",
};

/**
 * Build the full synthetic corpus with all four bias fixes applied. Returns per-room event arrays in
 * oldest-to-newest content order (ascending `origin_server_ts`), `crawlBatches()` is what turns this into the
 * newest-first, batched, round-robin delivery order the real crawler uses; this function is only responsible
 * for *content*, not *delivery order*, so the content is independent of `eventsPerCrawl`/room count changes.
 */
export function generateCorpusNew(userOpts = {}) {
    const opts = { ...NEW_DEFAULTS, ...userOpts };
    const rng = makeRng(opts.seed);
    const { roomIds, sizes, largestShare, zipfRoomExponent } = planRoomSizes(opts);

    const totalTokensEstimate = opts.events * opts.medianWords;
    const vocab = buildVocabulary(totalTokensEstimate, opts, rng);

    const senders = Array.from({ length: opts.senderCount }, (_, i) => `@user${i}:example.org`);
    const senderKeys = new Map(senders.map((s) => [s, { curve25519Key: fakeKey(rng), ed25519Key: fakeKey(rng) }]));

    const baseTs = 1_700_000_000_000;
    let globalIndex = 0;
    let totalTokens = 0;
    let accentedCount = 0;
    let cjkCount = 0;
    let editCount = 0;
    let fileCount = 0;
    let replyCount = 0;

    /** plan[r] = ordered (oldest->newest) array of fully-formed IEventWithRoomId-shaped objects for room r. */
    const plan = new Array(roomIds.length);

    for (let r = 0; r < roomIds.length; r++) {
        const roomId = roomIds[r];
        const size = sizes[r];
        const roomEvents = new Array(size);
        // ts spacing: rooms with more events get denser traffic over the same wall-clock span, which is
        // realistic (a busy room posts more often, not over a longer span) and keeps origin_server_ts ranges
        // roughly comparable across rooms rather than one room's history stretching decades past another's.
        const spacingMs = Math.max(1, Math.round(30000 / Math.max(1, size / 200)));
        for (let i = 0; i < size; i++) {
            const ts = baseTs + i * spacingMs;
            const sender = senders[Math.floor(rng() * senders.length)];
            const roll = rng();
            let content;
            let editOf = null;
            if (roll < opts.editRate && i > 5) {
                // Edit an earlier message in this room (older -> the crawler delivers this edit BEFORE the
                // original it targets, exercising the "original arrives after its edit" path in addHistoricEvents).
                const targetIdx = Math.floor(rng() * i);
                editOf = roomEvents[targetIdx].event_id;
                const newBody = asciiBody(rng, vocab, opts.medianWords);
                totalTokens += newBody.split(/\s+/).length;
                content = {
                    "body": `* ${newBody}`,
                    "msgtype": "m.text",
                    "m.new_content": { body: newBody, msgtype: "m.text" },
                    "m.relates_to": { rel_type: "m.replace", event_id: editOf },
                };
                editCount++;
            } else {
                const bodyRoll = rng();
                let body;
                if (bodyRoll < opts.cjkShare) {
                    body = cjkBody(rng);
                    cjkCount++;
                } else if (bodyRoll < opts.cjkShare + opts.accentedShare) {
                    body = accentedBody(rng, opts.medianWords);
                    accentedCount++;
                } else {
                    body = asciiBody(rng, vocab, opts.medianWords);
                    totalTokens += body.split(/\s+/).length;
                }
                content = { body, msgtype: "m.text" };

                if (rng() < opts.fileRate) {
                    fileCount++;
                    content.msgtype = "m.file";
                    content.filename = `${vocab.word()}-${vocab.word()}.pdf`;
                    content.url = `mxc://example.org/${fakeKey(rng).slice(0, 16)}`;
                    body = `${body} ${content.filename}`;
                }
                if (rng() < opts.replyRate && i > 0) {
                    replyCount++;
                    const targetIdx = Math.floor(rng() * i);
                    content["m.relates_to"] = { "m.in_reply_to": { event_id: roomEvents[targetIdx].event_id } };
                }

                // Marker injection for deterministic query benchmarking (namespaced, see NEW_DEFAULTS).
                const extra = [];
                if (globalIndex % opts.markerRate === 0) extra.push(opts.markerToken);
                if (globalIndex % opts.prefixRate === 0) extra.push(opts.prefixWord);
                if (globalIndex % opts.substringRate === 0) extra.push(opts.substringWord);
                if (extra.length) content.body = `${content.body} ${extra.join(" ")}`;
            }

            roomEvents[i] = buildEventShape({
                id: `$perf${globalIndex}`,
                roomId,
                sender,
                ts,
                content,
                senderKeys: senderKeys.get(sender),
                ageMs: 0,
            });
            globalIndex++;
        }
        plan[r] = roomEvents;
    }

    return {
        roomIds,
        sizes,
        plan,
        stats: {
            events: opts.events,
            rooms: opts.rooms,
            zipfRoomExponent,
            largestRoomShare: largestShare,
            vocabSize: vocab.size,
            heapsK: vocab.heapsK,
            heapsBeta: vocab.heapsBeta,
            wordZipfExponent: vocab.wordZipfExponent,
            accentedCount,
            cjkCount,
            editCount,
            fileCount,
            replyCount,
            totalAsciiTokens: totalTokens,
        },
        opts,
    };
}

/**
 * Turn a `generateCorpusNew()` plan into the exact sequence of `addHistoricEvents` batches a real crawl would
 * produce: per room, newest-undelivered-first, batches of `eventsPerCrawl` (100 to match `EVENTS_PER_CRAWL`),
 * rooms visited round-robin via a FIFO queue (dequeue the front room, deliver one batch, re-enqueue at the back
 * if that room has more history left), mirroring `EventIndex.ts`'s `crawlerFunc`/`crawlerCheckpoints`.
 *
 * Yields `{ roomId, events, checkpoint, oldCheckpoint }`, `events` is an array of `{ event, profile }` pairs
 * exactly as `addHistoricEvents` expects, `checkpoint`/`oldCheckpoint` are the `ICrawlerCheckpoint`-shaped
 * objects to pass through (or `null`, matching a finished crawl).
 *
 * @yields {{roomId: string, events: Array<object>, checkpoint: object|null, oldCheckpoint: object|null}} one
 *   crawl batch, in the order the crawler would deliver it.
 */
export function* crawlBatches({ roomIds, plan }, eventsPerCrawl = 100) {
    const remaining = plan.map((events) => events.length);
    const queue = roomIds.map((_, i) => i);
    while (queue.length) {
        const r = queue.shift();
        const rem = remaining[r];
        if (rem <= 0) continue;
        const batchSize = Math.min(eventsPerCrawl, rem);
        const events = new Array(batchSize);
        for (let k = 0; k < batchSize; k++) {
            const localIndex = rem - 1 - k; // newest-undelivered first
            events[k] = { event: plan[r][localIndex], profile: { displayname: plan[r][localIndex].sender } };
        }
        remaining[r] -= batchSize;
        const hasMore = remaining[r] > 0;
        const oldCheckpoint = { roomId: roomIds[r], token: `tok-${r}-${rem}`, fullCrawl: true, direction: "b" };
        const checkpoint = hasMore
            ? { roomId: roomIds[r], token: `tok-${r}-${remaining[r]}`, fullCrawl: true, direction: "b" }
            : null;
        yield { roomId: roomIds[r], events, checkpoint, oldCheckpoint };
        if (hasMore) queue.push(r);
    }
}

/* ------------------------------------------------------------------ old generator (bias-check baseline) */

const OLD_MARKER = "zqmarker";
const OLD_FRAGMENT_HOST = "zqfallbackword";
export const OLD_FRAGMENT = "allbackwor";

/**
 * The ORIGINAL corpus generator, preserved for the "old vs new" bias-check comparison in README.md.
 * Verbatim in behaviour: ascending timestamps (`origin_server_ts: base + i`, strictly increasing, so
 * `insertRoomOrder` always appends), events spread evenly across rooms (`room_id: roomIds[i % rooms]`), a thin
 * shape with none of the encrypted-event fields, and a tiny vocabulary (4 fixed words + 2 index-derived ones,
 * i.e. effectively O(rooms) x O(1) distinct tokens regardless of corpus size).
 */
export function generateCorpusOld({ events, rooms }) {
    const roomIds = Array.from({ length: rooms }, (_, r) => `!perf${r}:example.org`);
    const corpus = [];
    for (let i = 0; i < events; i++) {
        const words = [`entry${i}`, `lorem${i % 17}`, `ipsum${i % 23}`, "corpus filler text"];
        if (i % 37 === 0) words.push(OLD_MARKER);
        if (i % 53 === 0) words.push("zqbeta");
        if (i % 101 === 0) words.push(OLD_FRAGMENT_HOST);
        corpus.push({
            event_id: `$perf${i}`,
            room_id: roomIds[i % rooms],
            sender: `@user${i % 11}:example.org`,
            type: "m.room.message",
            origin_server_ts: 1_700_000_000_000 + i,
            content: { body: words.join(" "), msgtype: "m.text" },
        });
    }
    return corpus;
}
