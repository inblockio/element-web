/*
 * M9 item S (D39 panel): the "Search messages" card of the host panel. It runs exactly what RoomView runs for a search:
 * Element's `eventSearch` after a 300 ms debounce, `RoomSearchView` for the results and its pagination, and
 * `RoomSearchAuxPanel` (count, scope link, SearchWarning for an encrypted room). Nothing is re-implemented, no server
 * call and no index of ours. A hit's click dispatches `ViewRoom{event_id}`, which CardPanelOverlay turns into a jump.
 */

import { Form, Search } from "@vector-im/compound-web";
import { debounce } from "lodash";
import React, { type JSX, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type Room } from "matrix-js-sdk/src/matrix";
import { type ISearchResults } from "matrix-js-sdk/src/matrix";

import BaseCard from "../components/views/right_panel/BaseCard";
import { RoomSearchView } from "../components/structures/RoomSearchView";
import RoomSearchAuxPanel from "../components/views/rooms/RoomSearchAuxPanel";
import { ScopedRoomContextProvider } from "../contexts/ScopedRoomContext";
import RoomContext, { TimelineRenderingType } from "../contexts/RoomContext";
import { SDKContext } from "../contexts/SDKContext";
import eventSearch, { type SearchInfo, SearchScope } from "../Searching";
import { _t } from "../languageHandler";

/** RoomView's search debounce (onSearchChange). */
const SEARCH_DEBOUNCE_MS = 300;

export interface SearchCardProps {
    room: Room;
    /** The term the card opens with (the Room info card hands its field's term over); searched at once. */
    initialTerm?: string;
    onClose: () => void;
}

export function SearchCard({ room, initialTerm = "", onClose }: SearchCardProps): JSX.Element {
    const client = useContext(SDKContext).client!;
    const roomContext = useContext(RoomContext);
    const [value, setValue] = useState(initialTerm);
    const [search, setSearch] = useState<SearchInfo | undefined>(undefined);
    const searchRef = useRef<SearchInfo | undefined>(undefined);
    const inputRef = useRef<HTMLInputElement>(null);

    const run = useCallback(
        (term: string, scope: SearchScope = SearchScope.Room): void => {
            searchRef.current?.abortController?.abort();
            if (!term) {
                // Stock sends the empty term too; here an empty field just clears the search (no request).
                searchRef.current = undefined;
                setSearch(undefined);
                return;
            }
            const roomId = scope === SearchScope.Room ? room.roomId : undefined;
            const abortController = new AbortController();
            const promise = eventSearch(client, term, roomId, abortController.signal);
            // A rejected search is shown by RoomSearchView through onUpdate; this branch only keeps the rejection handled.
            promise.catch(() => {});
            const info: SearchInfo = {
                // Unique id so that the results of an aborted search are never shown (RoomSearchView is keyed by it).
                searchId: new Date().getTime(),
                roomId,
                term,
                scope,
                promise,
                abortController,
            };
            searchRef.current = info;
            setSearch(info);
        },
        [client, room.roomId],
    );

    const runDebounced = useMemo(() => debounce(run, SEARCH_DEBOUNCE_MS), [run]);

    useEffect(() => {
        // The handed term goes through the same 300 ms debounce as a typed one (RoomView's onSearchChange).
        if (initialTerm) runDebounced(initialTerm);
        const input = inputRef.current;
        if (input) {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        }
        return () => {
            runDebounced.cancel();
            searchRef.current?.abortController?.abort();
        };
        // Mount only: the term it opens with.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const onUpdate = useCallback((inProgress: boolean, results: ISearchResults | null, error: Error | null): void => {
        const current = searchRef.current;
        if (!current) return;
        const next: SearchInfo = { ...current, count: results?.count, error: error ?? undefined, inProgress };
        searchRef.current = next;
        setSearch(next);
    }, []);

    const onCancel = useCallback((): void => {
        runDebounced.cancel();
        setValue("");
        run("");
        inputRef.current?.focus();
    }, [run, runDebounced]);

    const header = (
        <Form.Root className="mx_RoomSummaryCard_search" onSubmit={(e) => e.preventDefault()}>
            <Search
                placeholder={_t("room|search|placeholder")}
                name="room_message_search"
                data-testid="client-view-search-input"
                onChange={(e) => {
                    setValue(e.currentTarget.value);
                    runDebounced(e.currentTarget.value);
                }}
                value={value}
                className="mx_no_textinput"
                ref={inputRef}
                autoFocus
                onKeyDown={(e) => {
                    // A non-empty field: Escape clears the search and the panel stays; an empty one bubbles and closes it.
                    if (e.key === "Escape" && value) {
                        e.stopPropagation();
                        e.preventDefault();
                        onCancel();
                    }
                }}
            />
        </Form.Root>
    );

    const encryptionKnown = roomContext.isRoomEncrypted !== null && roomContext.isRoomEncrypted !== undefined;

    return (
        <ScopedRoomContextProvider {...roomContext} timelineRenderingType={TimelineRenderingType.Search}>
            <BaseCard
                id="host-search-panel"
                className="mx_RoomSummaryCard"
                header={header}
                onClose={onClose}
                closeLabel={_t("action|close")}
                withoutScrollContainer
            >
                {search && encryptionKnown && (
                    <RoomSearchAuxPanel
                        searchInfo={search}
                        onCancelClick={onCancel}
                        onSearchScopeChange={(scope) => run(search.term, scope)}
                        isRoomEncrypted={!!roomContext.isRoomEncrypted}
                    />
                )}
                {search && (
                    <RoomSearchView
                        key={search.searchId}
                        term={search.term}
                        scope={search.scope}
                        promise={search.promise}
                        inProgress={!!search.inProgress}
                        className="mx_RoomView_messagePanel"
                        onUpdate={onUpdate}
                    />
                )}
            </BaseCard>
        </ScopedRoomContextProvider>
    );
}
