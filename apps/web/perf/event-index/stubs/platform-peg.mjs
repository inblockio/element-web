/* Stub for src/PlatformPeg: the index asks it for one thing, the session pickle key.
   `globalThis.__PERF_PICKLE_KEY__ = null` is how the harness selects a memory-only run. */
const peg = {
    get: () => ({
        getPickleKey: async () =>
            globalThis.__PERF_PICKLE_KEY__ === undefined ? "perf-pickle-key" : globalThis.__PERF_PICKLE_KEY__,
    }),
};
export default peg;
