#!/usr/bin/env node
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
 * USAGE: node build.mjs [--element-web /path] [--out dist]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, "..");

function findRepo() {
    const candidates = [process.env.ELEMENT_WEB, "/home/waldknoten-01/.cache/ew-pr34718/element-web"].filter(Boolean);
    for (const candidate of candidates) {
        if (existsSync(join(candidate, "apps/web/src/vector/platform/BrowserEventIndexManager.ts"))) {
            return resolvePath(candidate);
        }
    }
    throw new Error(`element-web checkout not found (tried: ${candidates.join(", ")}). Set ELEMENT_WEB.`);
}

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
    throw new Error("esbuild not found under the checkout's node_modules; run `pnpm install` there first.");
}

export async function buildBrowserBundle({ outdir = join(HERE, "dist") } = {}) {
    const repo = findRepo();
    mkdirSync(outdir, { recursive: true });
    const outfile = join(outdir, "bundle.js");
    const platformDir = join(repo, "apps/web/src/vector/platform");
    const stubs = join(ROOT, "stubs");
    const esbuild = await import(pathToFileURL(join(findEsbuildPackage(repo), "lib/main.js")).href);

    const managerAbs = join(platformDir, "BrowserEventIndexManager");
    const corpusAbs = join(ROOT, "corpus.mjs");
    // eventIndexBounds.ts is increment C's own file (a sibling worktree, e.g. wt-pr-c) and does not
    // exist in increment A/B's checkouts. Imported only when present, so harness-body.mjs's
    // setBoundsOverride() works against a checkout that has it and is simply unreachable dead code
    // (never called unless --force-tier is passed) against one that does not -- rather than making
    // every other increment's build fail to resolve a module that is not part of its own checkout.
    const boundsPath = join(platformDir, "eventIndexBounds.ts");
    const boundsAbs = existsSync(boundsPath) ? join(platformDir, "eventIndexBounds") : null;

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
                boundsAbs ? `import * as EventIndexBounds from ${JSON.stringify(boundsAbs)};` : "",
                readFileSync(join(HERE, "harness-body.mjs"), "utf8"),
            ].join("\n"),
            resolveDir: platformDir,
            sourcefile: "browser-harness-entry.ts",
            loader: "ts",
        },
        bundle: true,
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
    const outdir = outArgIdx >= 0 ? resolvePath(process.argv[outArgIdx + 1]) : join(HERE, "dist");
    const { outfile } = await buildBrowserBundle({ outdir });
    console.log(`Built ${outfile}`);
}
