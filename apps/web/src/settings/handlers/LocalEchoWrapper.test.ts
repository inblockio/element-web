/*
SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { describe, it, expect } from "vitest";

import LocalEchoWrapper from "./LocalEchoWrapper";
import SettingsHandler from "./SettingsHandler";
import { SettingLevel } from "../SettingLevel";
import { WatchManager } from "../WatchManager";

const ROOM = "!room:example.org";

/** A handler whose stored value only changes when its write is accepted (a refused PUT leaves the old value). */
class FakeHandler extends SettingsHandler {
    public readonly watchers = new WatchManager();
    public stored: unknown = "old";
    private settle?: { resolve: () => void; reject: (e: Error) => void };

    public getValue(): unknown {
        return this.stored;
    }

    public setValue(_name: string, _roomId: string | null, newValue: unknown): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.settle = {
                resolve: () => {
                    this.stored = newValue;
                    resolve();
                },
                reject,
            };
        });
    }

    public refuse(): void {
        this.settle?.reject(new Error("M_FORBIDDEN"));
    }

    public accept(): void {
        this.settle?.resolve();
    }

    public canSetValue(): boolean {
        return true;
    }

    public isSupported(): boolean {
        return true;
    }
}

/** What each watcher callback reads through the wrapper at the moment it is notified (Element's watchers re-read, they ignore the notified value). */
function watch(handler: FakeHandler, wrapper: LocalEchoWrapper): unknown[] {
    const seen: unknown[] = [];
    handler.watchers.watchSetting("s", ROOM, () => seen.push(wrapper.getValue("s", ROOM)));
    return seen;
}

describe("LocalEchoWrapper: a refused write rolls the echo back before the rollback notify (M10 W23 F2, Element bug, D21)", () => {
    it("a watcher re-reading inside the rollback notify sees the stored (old) value", async () => {
        const handler = new FakeHandler();
        const wrapper = new LocalEchoWrapper(handler, SettingLevel.ACCOUNT);
        const seen = watch(handler, wrapper);

        const write = wrapper.setValue("s", ROOM, "new");
        expect(wrapper.getValue("s", ROOM)).toBe("new");
        handler.refuse();
        await write;

        // [optimistic notify, rollback notify]: the rollback must read the real value, not the cached echo.
        expect(seen).toEqual(["new", "old"]);
        expect(wrapper.getValue("s", ROOM)).toBe("old");
    });

    it("an accepted write keeps the echo until the store has it and expires it afterwards", async () => {
        const handler = new FakeHandler();
        const wrapper = new LocalEchoWrapper(handler, SettingLevel.ACCOUNT);
        const seen = watch(handler, wrapper);

        const write = wrapper.setValue("s", ROOM, "new");
        handler.accept();
        await write;

        expect(seen).toEqual(["new"]);
        expect(wrapper.getValue("s", ROOM)).toBe("new");
        expect(handler.stored).toBe("new");
    });

    it("a refused write does not drop a newer echo (guard `=== newValue` kept)", async () => {
        const handler = new FakeHandler();
        const wrapper = new LocalEchoWrapper(handler, SettingLevel.ACCOUNT);

        const first = wrapper.setValue("s", ROOM, "first");
        const refuseFirst = (handler as any).settle.reject as (e: Error) => void;
        const second = wrapper.setValue("s", ROOM, "second");
        refuseFirst(new Error("M_FORBIDDEN"));
        await first;

        expect(wrapper.getValue("s", ROOM)).toBe("second");
        handler.accept();
        await second;
    });
});
