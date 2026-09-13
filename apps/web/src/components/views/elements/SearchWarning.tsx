/*
Copyright 2024 New Vector Ltd.
Copyright 2020 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { logger } from "matrix-js-sdk/src/logger";

import EventIndexPeg from "../../../indexing/EventIndexPeg";
import type EventIndex from "../../../indexing/EventIndex";
import { SearchScope } from "../../../Searching";
import { _t } from "../../../languageHandler";
import SdkConfig from "../../../SdkConfig";
import dis from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import { UserTab } from "../dialogs/UserTab";
import AccessibleButton, { type ButtonEvent } from "./AccessibleButton";

export enum WarningKind {
    Files,
    Search,
}

interface IProps {
    isRoomEncrypted?: boolean;
    kind: WarningKind;
    showLogo?: boolean;
    /** The scope of the search being warned about; only meaningful for {@link WarningKind.Search}. */
    scope?: SearchScope;
    /** The room being searched. Mirrors `SearchInfo.roomId`: `undefined` when searching all rooms. */
    roomId?: string;
}

/** How often to re-read {@link EventIndex.getStats} while `loading` is true; see the docstring below. */
const LOADING_POLL_MS = 1000;

/**
 * Track whether the index is still missing history that is relevant to the given search.
 *
 * A room-scoped search is incomplete if the crawler still holds a checkpoint for the room
 * ({@link EventIndex.crawlingRooms}, which covers both the checkpoint being crawled right now and
 * those still queued behind it), or if the index holds no events for it at all
 * ({@link EventIndex.isRoomIndexed}) — which is how a room looks before its checkpoint has been
 * seeded, and is the case the checkpoint set alone cannot see.
 *
 * The second question is only asked while the crawler still has work outstanding, for two reasons.
 * It is what the warning claims ("your search index is still being built"), and the index has no
 * event for its contents changing — `changedCheckpoint` fires only on checkpoint transitions, and
 * an idle crawler is silent — so a warning raised once the crawler has drained would never be
 * re-evaluated and would stick.
 *
 * Neither signal proves completeness: `isRoomIndexed` reports only that the index holds *some*
 * events for a room, not all of them, and a room has no checkpoint if it never had a
 * back-pagination token to crawl from or if its checkpoint was dropped because the server rejected
 * the request. So this under-warns rather than over-warns.
 *
 * An all-rooms search cannot ask the per-room question, so it uses the checkpoint set alone.
 *
 * A third signal, `getStats().loading`, answers a question neither checkpoint check can: the
 * browser index backend hydrates its on-disk store into memory in the background after start-up
 * (see `BrowserEventIndexManager.initEventIndex`), and a query issued before that finishes can
 * silently return only what has loaded so far, even with no checkpoints outstanding at all. Unlike
 * the two questions above, this one is not scoped by room: while it is true, every search is
 * potentially incomplete, and every kind of warning cares about it, not only {@link
 * WarningKind.Search} — see this hook's `loading` return value and its two call sites in {@link
 * SearchWarning} below.
 *
 * `loading` has no event of its own to clear it, unlike the checkpoint signal's `changedCheckpoint`:
 * the backend does not fire anything when hydration finishes. Polling on a plain interval, armed
 * only while `loading` is true (so a session that finished hydrating before this ever mounts pays
 * nothing), is the fix chosen here over adding an emitter to `EventIndex`/`BrowserEventIndexManager`
 * for one signal only this hook consumes; gating this disjunct on `anyOutstanding` the way the
 * `isRoomIndexed` one already is would avoid needing a poll at all, but was rejected because it
 * under-warns in exactly the case this signal exists for (no checkpoints outstanding at all).
 *
 * The `changedCheckpoint` payload carries only the globally-current room and so cannot answer a
 * per-room question: we re-read the index on each event rather than trust it.
 *
 * @param index The event index to observe, or `null` if there is no index.
 * @param scope The scope of the search, if this warning is being rendered for one.
 * @param roomId The room being searched, or `undefined` when searching all rooms.
 * @returns `incomplete`: true while the index is known to be missing history relevant to this
 *     specific search (the property every existing, `WarningKind.Search`-only caller wants).
 *     `loading`: true while the backend is still hydrating from disk at all, regardless of scope or
 *     room — the property a `WarningKind.Files` caller wants instead, the checkpoint-based signal
 *     never having applied to it.
 */
function useIsIndexIncomplete(
    index: EventIndex | null,
    scope?: SearchScope,
    roomId?: string,
): { incomplete: boolean; loading: boolean } {
    const readCheckpoints = useCallback((): { relevant: boolean; anyOutstanding: boolean } => {
        if (!index) return { relevant: false, anyOutstanding: false };
        const { crawlingRooms } = index.crawlingRooms();
        // Fall back to the global check when we don't know which room is being searched: the room
        // id may still be undefined while a room alias is being resolved.
        const roomScoped = scope === SearchScope.Room && roomId !== undefined;
        return {
            relevant: roomScoped ? crawlingRooms.has(roomId) : crawlingRooms.size > 0,
            anyOutstanding: crawlingRooms.size > 0,
        };
    }, [index, scope, roomId]);

    // The checkpoint half of the answer is known synchronously, so seed from it rather than
    // rendering an unwarned search for a room we already know is being crawled.
    const [incomplete, setIncomplete] = useState<boolean>(() => readCheckpoints().relevant);
    const [loading, setLoading] = useState<boolean>(false);

    // Shared between the subscription effect below and the poll effect further down, so a tick
    // from either agrees with the other about which answer is current; a ref rather than a
    // useCallback-captured local because both effects' cleanups, and the poll's own repeated
    // ticks, all need to see every increment, not the value each closure captured at creation.
    const generationRef = useRef(0);

    // A plain function wrapping the ref bump, so the effect cleanup below calls this instead of
    // writing `generationRef.current` directly: react-hooks' exhaustive-deps rule flags a bare
    // `.current` access inside a cleanup (it is normally about a DOM ref having already changed
    // by the time cleanup runs, which does not apply to a plain mutable counter like this one, but
    // the rule does not distinguish the two).
    const invalidate = useCallback((): void => {
        generationRef.current++;
    }, []);

    const update = useCallback(async (): Promise<void> => {
        if (!index) return;
        const current = ++generationRef.current;
        const { relevant, anyOutstanding } = readCheckpoints();

        // The index can still be hydrating from disk with no checkpoints outstanding at all -- a
        // fresh session, before the crawler has run this pass -- in which case a query can
        // silently return only what has been decrypted so far. This applies regardless of scope
        // or room, unlike the checkpoint checks below, so it is fetched unconditionally rather
        // than only when the checkpoint question alone leaves the answer open.
        let isLoading = false;
        try {
            const stats = await index.getStats();
            if (current !== generationRef.current) return;
            isLoading = Boolean(stats?.loading);
        } catch (e) {
            // A backend whose getStats() rejects is not evidence either way; log and treat it as
            // not loading rather than let the rejection go unhandled (this function is always
            // invoked as `void update()` or from a timer callback, neither of which has a catch).
            if (current !== generationRef.current) return;
            logger.warn("SearchWarning: getStats() failed; treating the index as not loading", e);
        }
        setLoading(isLoading);

        if (relevant || isLoading) {
            setIncomplete(true);
            return;
        }
        if (!anyOutstanding || scope !== SearchScope.Room || roomId === undefined) {
            setIncomplete(false);
            return;
        }

        // Nothing is queued for this room yet, but the index may hold nothing for it at all.
        // `undefined` means there is no index manager to ask, which is not evidence either way.
        const indexed = await index.isRoomIndexed(roomId);
        if (current === generationRef.current) setIncomplete(indexed === false);
    }, [index, scope, roomId, readCheckpoints]);

    useEffect(() => {
        if (!index) {
            setIncomplete(false);
            setLoading(false);
            return;
        }

        // Answer this scope and room from the checkpoint set up front, so that the previous
        // search's result is not left on screen while the first lookup below is in flight. Doing
        // this per effect run rather than per event matters: a checkpoint change is not a new
        // question, and resetting on one would blink an already-earned warning off and on again.
        setIncomplete(readCheckpoints().relevant);

        const onChangedCheckpoint = (): void => {
            void update();
        };

        // Re-sync in case the crawl state changed between the initial render and the subscription.
        onChangedCheckpoint();
        index.on("changedCheckpoint", onChangedCheckpoint);

        return () => {
            invalidate();
            index.removeListener("changedCheckpoint", onChangedCheckpoint);
        };
    }, [index, scope, roomId, readCheckpoints, update, invalidate]);

    // changedCheckpoint fires only on checkpoint transitions, and hydration finishing has no event
    // of its own, so `loading` would otherwise be raised once and never re-checked. Poll on a plain
    // interval instead, armed only while `loading` is true, so a session that finished hydrating
    // before this ever mounts (the overwhelmingly common case) never starts a timer at all.
    useEffect(() => {
        if (!index || !loading) return;
        const poll = setInterval(() => void update(), LOADING_POLL_MS);
        return () => clearInterval(poll);
    }, [index, loading, update]);

    return { incomplete, loading };
}

export default function SearchWarning({ isRoomEncrypted, kind, showLogo = true, scope, roomId }: IProps): JSX.Element {
    const eventIndex = EventIndexPeg.get();
    const { incomplete: indexIncomplete, loading: indexLoading } = useIsIndexIncomplete(eventIndex, scope, roomId);

    if (!isRoomEncrypted) return <></>;

    if (eventIndex) {
        // The index is still missing history for this search, so it may silently return partial
        // results (#32253). Warn the user.
        if (indexIncomplete && kind === WarningKind.Search) {
            // This warning appears dynamically while a search panel is already open (the crawler
            // finishes draining mid-session), so mark it as a polite live region for screen readers.
            return (
                <div className="mx_SearchWarning" role="status">
                    <span>{_t("seshat|warning_kind_search_partial")}</span>
                </div>
            );
        }
        // The Files kind never cared about crawler checkpoints -- loadFileEvents() answers from
        // whatever is resident, same as search, but nothing above ever warned about it for Files.
        // Hydration is the one signal that does apply here regardless of kind: while it is running,
        // the attachment list loadFileEvents() answers from is truncated or empty the same way a
        // search's results would be.
        if (indexLoading && kind === WarningKind.Files) {
            return (
                <div className="mx_SearchWarning" role="status">
                    <span>{_t("seshat|warning_kind_files_partial")}</span>
                </div>
            );
        }
        return <></>;
    }

    if (EventIndexPeg.error) {
        return (
            <div className="mx_SearchWarning">
                {_t(
                    "seshat|error_initialising",
                    {},
                    {
                        a: (sub) => (
                            <AccessibleButton
                                kind="link_inline"
                                onClick={(evt: ButtonEvent) => {
                                    evt.preventDefault();
                                    dis.dispatch({
                                        action: Action.ViewUserSettings,
                                        initialTabId: UserTab.Security,
                                    });
                                }}
                            >
                                {sub}
                            </AccessibleButton>
                        ),
                    },
                )}
            </div>
        );
    }

    const brand = SdkConfig.get("brand");
    const desktopBuilds = SdkConfig.getObject("desktop_builds");

    let text: ReactNode | undefined;
    let logo: JSX.Element | undefined;
    if (desktopBuilds?.get("available")) {
        logo = <img alt="" src={desktopBuilds.get("logo")} width="32px" />;
        const buildUrl = desktopBuilds.get("url");
        switch (kind) {
            case WarningKind.Files:
                text = _t(
                    "seshat|warning_kind_files_app",
                    {},
                    {
                        a: (sub) => (
                            <a href={buildUrl} target="_blank" rel="noreferrer noopener">
                                {sub}
                            </a>
                        ),
                    },
                );
                break;
            case WarningKind.Search:
                text = _t(
                    "seshat|warning_kind_search_app",
                    {},
                    {
                        a: (sub) => (
                            <a href={buildUrl} target="_blank" rel="noreferrer noopener">
                                {sub}
                            </a>
                        ),
                    },
                );
                break;
        }
    } else {
        switch (kind) {
            case WarningKind.Files:
                text = _t("seshat|warning_kind_files", { brand });
                break;
            case WarningKind.Search:
                text = _t("seshat|warning_kind_search", { brand });
                break;
        }
    }

    // for safety
    if (!text) {
        logger.warn("Unknown desktop builds warning kind: ", kind);
        return <></>;
    }

    return (
        <div className="mx_SearchWarning">
            {showLogo ? logo : null}
            <span>{text}</span>
        </div>
    );
}
