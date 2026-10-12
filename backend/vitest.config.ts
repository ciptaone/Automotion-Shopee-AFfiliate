import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // PostgreSQL integration tests live in tests/db/ and run through
    // `npm run test:db` (vitest.db.config.ts) against a real, isolated
    // cluster. They must never run as part of the default suite.
    exclude: ['tests/db/**', '**/node_modules/**', '**/dist/**'],
    reporters: ['default'],
    passWithNoTests: false,
    // Contract/unit tests must never touch the network or a real database.
    // Individual tests that would need external services must be marked BLOCKED instead.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
