import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      $lib: resolve('./src/lib'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    /**
     * Above vitest's 5s default because several suites here call
     * `vi.resetModules()` and then `await import(...)` a store — and the first
     * such import in a worker pays the transform of that store's whole module
     * graph. Alone that costs well under a second; with every other file
     * transforming in parallel it crossed 5s and failed the *first* test of
     * `mcpBridge.test.ts` as a timeout, while the same test passed in
     * isolation. Nothing here legitimately runs for seconds, so this only
     * buys headroom for module loading — a real hang still fails, just later.
     */
    testTimeout: 20000,
    /**
     * Half the cores, not all of them.
     *
     * Several suites here assert on *wall-clock* behaviour against very short
     * windows — `waitForAgentReady` collapses its poll/deadline constants to
     * 2ms/40ms under `isTestEnv` (see `stores/terminal.ts`), so the whole
     * launch-failure decision happens inside 40ms. With one worker per core
     * every worker is fighting for CPU and a 40ms budget expires before the
     * fed output is ever polled: the test then sees `ready` instead of
     * `launch-failed` and the suite fails a different test on each run, while
     * every one of them passes in isolation. Leaving headroom keeps those
     * windows meaningful. Suite wall time is barely affected — the run is
     * dominated by transform work, not by test execution.
     */
    poolOptions: { threads: { maxThreads: 6 }, forks: { maxForks: 6 } },
  },
});
