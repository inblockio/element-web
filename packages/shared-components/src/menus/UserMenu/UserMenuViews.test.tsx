/*
 * Copyright 2026 inblock.io
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";
import React, { type JSX, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import avatarUrl from "../../../static/element.png";
import { MockViewModel, useMockedViewModel } from "../../core/viewmodel";
import { type SetStatusViewSnapshot } from "../../status/SetStatusView";
import { UserMenuView, type UserMenuViewActions, type UserMenuViewSnapshot } from "./UserMenu";

class MockSetStatusViewModel extends MockViewModel<SetStatusViewSnapshot> {
    public setStatus = vi.fn();
    public clearStatus = vi.fn();
}

const sampleViews = [
    { id: "fixture", name: "Fixture" },
    { id: "other", name: "Other" },
];

/**
 * The menu's open state is controlled by the snapshot. Stories pass a static
 * `setOpen`, which leaves the menu closed after a click, so this harness
 * applies that callback to the snapshot the same way a real view model would.
 */
function UserMenuHarness({
    views,
    switchView,
}: {
    views?: UserMenuViewSnapshot["views"];
    switchView?: UserMenuViewActions["switchView"];
}): JSX.Element {
    const [open, setOpen] = useState(false);
    const [setStatusViewModel] = useState(() => new MockSetStatusViewModel({}));
    const vm = useMockedViewModel<UserMenuViewSnapshot, UserMenuViewActions>(
        {
            open,
            avatarUrl,
            displayName: "Sally Sanderson",
            userId: "@person-name:homeserver.com",
            expanded: true,
            actions: {
                linkNewDevice: true,
                openSecurity: true,
                openFeedback: true,
                openSettings: true,
            },
            setStatusViewModel,
            views,
        },
        {
            setOpen,
            createAccount: vi.fn(),
            signIn: vi.fn(),
            linkNewDevice: vi.fn(),
            openFeedback: vi.fn(),
            openHomePage: vi.fn(),
            openSecurity: vi.fn(),
            openSettings: vi.fn(),
            clearStatus: vi.fn(),
            ...(switchView ? { switchView } : {}),
        },
    );

    return <UserMenuView vm={vm} />;
}

async function openMenu(): Promise<void> {
    await userEvent.click(screen.getByRole("button"));
}

describe("UserMenuView", () => {
    it("lists a switch entry for each view, in order", async () => {
        render(<UserMenuHarness views={sampleViews} switchView={vi.fn()} />);
        await openMenu();

        const switchItems = screen.getAllByRole("menuitem", { name: /^Switch to/ });
        expect(switchItems).toHaveLength(2);
        expect(switchItems[0]).toBe(screen.getByRole("menuitem", { name: "Switch to Fixture" }));
        expect(switchItems[1]).toBe(screen.getByRole("menuitem", { name: "Switch to Other" }));
    });

    it("calls switchView with the selected view id", async () => {
        const switchView = vi.fn();
        render(<UserMenuHarness views={sampleViews} switchView={switchView} />);
        await openMenu();

        await userEvent.click(screen.getByRole("menuitem", { name: "Switch to Other" }));

        expect(switchView).toHaveBeenCalledExactlyOnceWith("other");
    });

    it("renders no switch entries when views is undefined", async () => {
        render(<UserMenuHarness views={undefined} />);
        await openMenu();

        expect(screen.getByRole("menuitem", { name: "All settings" })).toBeInTheDocument();
        expect(screen.queryAllByRole("menuitem", { name: /^Switch to/ })).toHaveLength(0);
    });

    it("renders no switch entries when views is empty", async () => {
        render(<UserMenuHarness views={[]} />);
        await openMenu();

        expect(screen.getByRole("menuitem", { name: "All settings" })).toBeInTheDocument();
        expect(screen.queryAllByRole("menuitem", { name: /^Switch to/ })).toHaveLength(0);
    });

    it("does not throw when a listed view is selected without switchView", async () => {
        render(<UserMenuHarness views={[{ id: "fixture", name: "Fixture" }]} />);
        await openMenu();

        await expect(
            userEvent.click(screen.getByRole("menuitem", { name: "Switch to Fixture" })),
        ).resolves.toBeUndefined();
    });
});
