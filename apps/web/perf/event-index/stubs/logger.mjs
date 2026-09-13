/*
 * Stub for matrix-js-sdk/src/logger: the index only ever calls debug/info/warn on a child. info()
 * forwards to console.log so hydrate()'s field-instrumentation line (duration/count/longest-slice)
 * reaches run-browser.mjs's console listener; debug/warn stay silent so the (frequent, expected)
 * per-batch/per-checkpoint chatter from ingestAndPersist() does not spam a run's output.
 */
const sink = {
    debug() {},
    info(...args) {
        console.log(...args);
    },
    warn() {},
    error() {},
    getChild: () => sink,
};
export const logger = sink;
export default sink;
