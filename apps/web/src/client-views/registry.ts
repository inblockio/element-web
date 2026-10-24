/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { logger } from "matrix-js-sdk/src/logger";

import SdkConfig from "../SdkConfig";
import SettingsStore from "../settings/SettingsStore";
import { SettingLevel } from "../settings/SettingLevel";
import { type ClientViewDescriptor, STOCK_VIEW } from "./types";

const isDescriptor = (v: unknown): v is ClientViewDescriptor => {
    const d = v as Partial<ClientViewDescriptor> | null;
    return (
        typeof d?.id === "string" &&
        d.id !== "" &&
        d.id !== STOCK_VIEW &&
        typeof d.name === "string" &&
        typeof d.url === "string"
    );
};

/** The kits from config.json `client_views`, in config order. Invalid entries are skipped. */
export function getClientViews(): ClientViewDescriptor[] {
    const fromConfig = (SdkConfig.get() as { client_views?: unknown }).client_views;
    const views = new Map<string, ClientViewDescriptor>();
    if (Array.isArray(fromConfig)) {
        for (const entry of fromConfig) {
            if (isDescriptor(entry)) views.set(entry.id, { id: entry.id, name: entry.name, url: entry.url });
            else logger.warn("Ignoring invalid client_views entry", entry);
        }
    }
    return [...views.values()];
}

/**
 * The address of the call app (aqua-meet) from config.json `client_views_meet_url`, as `https://host[/path]` with no
 * query, fragment or trailing slash; undefined when the key is absent or no http(s) address (instance policy is config:
 * absent = calls are off in every kit).
 */
export function getMeetUrl(): string | undefined {
    const value = (SdkConfig.get() as { client_views_meet_url?: unknown }).client_views_meet_url;
    if (typeof value !== "string" || value.trim() === "") return undefined;
    try {
        const url = new URL(value.trim());
        if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
        return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
        logger.warn("Ignoring invalid client_views_meet_url", value);
        return undefined;
    }
}

/** Whether client views can be used at all: the Labs flag is on and at least one kit exists. */
export function clientViewsAvailable(): boolean {
    return SettingsStore.getValue("feature_client_views") && getClientViews().length > 0;
}

/** The kit to show instead of Element's UI, or undefined for the stock UI. */
export function getActiveClientView(): ClientViewDescriptor | undefined {
    if (!SettingsStore.getValue("feature_client_views")) return undefined;
    const id = SettingsStore.getValue("clientView");
    if (!id || id === STOCK_VIEW) return undefined;
    return getClientViews().find((v) => v.id === id);
}

/** Set while a host room view (a call, a notification) shows Element's UI over the selected kit; never persisted. */
let handedOver = false;
const handOverWatchers = new Set<() => void>();

/** Whether Element's UI is shown for now although a kit is selected. */
export function isHandedOver(): boolean {
    return handedOver;
}

/** Shows Element's UI over the selected kit until the next view switch (on) or ends that (off). */
export function setHandedOver(on: boolean): void {
    if (handedOver === on) return;
    handedOver = on;
    handOverWatchers.forEach((cb) => cb());
}

/** Calls `cb` when the hand-over starts or ends; returns the unsubscribe. */
export function watchHandOver(cb: () => void): () => void {
    handOverWatchers.add(cb);
    return () => void handOverWatchers.delete(cb);
}

/**
 * Selects a view for this device ("stock" = Element's UI). An unknown id selects the stock UI. Any switch ends a
 * hand-over, so picking the kit that is already selected brings it back.
 */
export function selectClientView(id: string): Promise<void> {
    setHandedOver(false);
    const known = id === STOCK_VIEW || getClientViews().some((v) => v.id === id);
    return SettingsStore.setValue("clientView", null, SettingLevel.DEVICE, known ? id : STOCK_VIEW);
}
