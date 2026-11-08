/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { useEffect } from "react";

import "./facelift.css";

/**
 * M14 K8: the Element surfaces a kit opens (host panels, dialogs, menus, toasts) take the kit's look through ONE
 * stylesheet, `facelift.css`, which sets Compound tokens under `body.<class>`. The host sets the class on
 * document.body while that kit's view is mounted and removes it when the view goes: stock view selected, the kit
 * handed over or replaced by a call, sign-out (each unmounts the view host). Without the class the sheet matches
 * nothing, so the stock view is untouched.
 */
const FACELIFT_PREFIX = "mx_ClientViewFacelift_";

/** The kits with a look to take; every other view keeps Element's own. */
const FACELIFT_VIEWS: ReadonlySet<string> = new Set(["rocketchat"]);

/** The body class for a view, or undefined when that view has no facelift. */
export function faceliftClass(viewId: string): string | undefined {
    return FACELIFT_VIEWS.has(viewId) ? FACELIFT_PREFIX + viewId : undefined;
}

/** Puts the view's facelift class on document.body for as long as the calling component is mounted. */
export function useFaceliftClass(viewId: string): void {
    useEffect(() => {
        const cls = faceliftClass(viewId);
        if (!cls) return;
        document.body.classList.add(cls);
        return () => document.body.classList.remove(cls);
    }, [viewId]);
}
