import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Telemetry is fire-and-forget; keep it disabled in unit tests so no run
    // ever attempts a network call. Enabled-path tests pass an explicit env.
    env: { POSTMAN_ACTIONS_TELEMETRY: 'off' },
    // CLI subprocesses and tar/npm packaging checks can exceed Vitest's 5s
    // default when the full suite runs under shared-host contention.
    testTimeout: 20_000,
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/live/**']
  }
});
