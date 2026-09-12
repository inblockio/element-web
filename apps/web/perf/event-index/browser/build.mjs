#!/usr/bin/env node
/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/*
 * esbuild bundling for the real-Chromium runner. Bundles BrowserEventIndexManager.ts (the checkout under
 * test, NEVER modified) plus corpus.mjs (this harness's corpus generator) into one browser-platform ESM file,
 * `dist/bundle.js`, and writes the static page that loads it, `dist/page.html`.
 *
 * Reuses the same four-stub redirect scheme as the Node harness (`../event-index-perf.mjs`), except
 * `matrix-js-sdk/src/matrix` is redirected to `stubs/matrix.browser.mjs` instead of `stubs/matrix.mjs`: the
 * Node stub's `encodeBase64`/`decodeBase64` use `Buffer`, which does not exist in a real browser page; the
 * browser stub uses `btoa`/`atob` instead (see that file's docstring for why exact byte-for-byte parity with
 * matrix-js-sdk's own implementation is not required here).
 *
 * USAGE: node browser/build.mjs [--out <dir>]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { dirname, join, resolve: resolvePath } = path;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, ".."); // apps/web/perf/event-index
// The manager under test comes from the checkout this file lives in; ELEMENT_WEB overrides that.
const REPO = resolvePath(process.env.ELEMENT_WEB ?? resolvePath(ROOT, "../../../.."));
// Same default out directory as run-browser.mjs, so the runner finds the bundle without being told.
const DEFAULT_OUT = join(
    resolvePath(process.env.EVENT_INDEX_PERF_OUT ?? join(homedir(), ".cache", "element-web-event-index-perf")),
    "dist",
);

function findRepo() {
    if (existsSync(join(REPO, "apps/web/src/vector/platform/BrowserEventIndexManager.ts"))) return REPO;
    throw new Error(`element-web checkout not found at ${REPO}. Set ELEMENT_WEB.`);
}

// esbuild and playwright-core come from a checkout that has been installed. A git worktree has no
// install of its own, so EVENT_INDEX_PERF_TOOLING can point at one that does.
const TOOLING = resolvePath(process.env.EVENT_INDEX_PERF_TOOLING ?? REPO);

function findEsbuildPackage(repo) {
    const direct = join(repo, "node_modules/esbuild");
    if (existsSync(join(direct, "lib/main.js"))) return direct;
    const store = join(repo, "node_modules/.pnpm");
    if (existsSync(store)) {
        for (const entry of readdirSync(store)) {
            if (!entry.startsWith("esbuild@")) continue;
            const pkg = join(store, entry, "node_modules/esbuild");
            if (existsSync(join(pkg, "lib/main.js"))) return pkg;
        }
    }
    throw new Error(
        `esbuild not found under ${repo}/node_modules; run \`pnpm install\` there, or set EVENT_INDEX_PERF_TOOLING.`,
    );
}

export async function buildBrowserBundle({ outdir = DEFAULT_OUT } = {}) {
    const repo = findRepo();
    const TOOLING_ROOT = TOOLING;
    mkdirSync(outdir, { recursive: true });
    const outfile = join(outdir, "bundle.js");
    const platformDir = join(repo, "apps/web/src/vector/platform");
    const stubs = join(ROOT, "stubs");
    const esbuild = await import(pathToFileURL(join(findEsbuildPackage(TOOLING), "lib/main.js")).href);

    const managerAbs = join(platformDir, "BrowserEventIndexManager");
    const corpusAbs = join(ROOT, "corpus.mjs");

    const redirects = [
        [/^matrix-js-sdk\/src\/logger$/, join(stubs, "logger.mjs")],
        [/^matrix-js-sdk\/src\/matrix$/, join(stubs, "matrix.browser.mjs")],
        [/(^|\/)PlatformPeg$/, join(stubs, "platform-peg.mjs")],
        [/(^|\/)settings\/SettingsStore$/, join(stubs, "settings-store.mjs")],
    ];

    await esbuild.build({
        stdin: {
            contents: [
                `import { BrowserEventIndexManager } from ${JSON.stringify(managerAbs)};`,
                `import * as Corpus from ${JSON.stringify(corpusAbs)};`,
                readFileSync(join(HERE, "harness-body.mjs"), "utf8"),
            ].join("\n"),
            resolveDir: platformDir,
            sourcefile: "browser-harness-entry.ts",
            loader: "ts",
        },
        bundle: true,
        // Bare specifiers (sanitize-html, matrix-js-sdk) resolve from the installed checkout's
        // node_modules, which is not necessarily the checkout holding the source under test.
        nodePaths: [join(TOOLING_ROOT, "apps/web/node_modules"), join(TOOLING_ROOT, "node_modules")],
        platform: "browser",
        format: "esm",
        target: "es2022",
        outfile,
        logLevel: "info",
        plugins: [
            {
                name: "perf-stubs",
                setup(build) {
                    for (const [filter, path] of redirects) {
                        build.onResolve({ filter }, () => ({ path }));
                    }
                },
            },
        ],
    });

    const pageHtml = readFileSync(join(HERE, "page.template.html"), "utf8");
    writeFileSync(join(outdir, "page.html"), pageHtml);

    return { outdir, outfile };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const outArgIdx = process.argv.indexOf("--out");
    const outdir = outArgIdx >= 0 ? resolvePath(process.argv[outArgIdx + 1]) : DEFAULT_OUT;
    void buildBrowserBundle({ outdir })
        .then(({ outfile }) => console.log(`Built ${outfile}`))
        .catch((e) => {
            console.error(e);
            process.exitCode = 1;
        });
}
