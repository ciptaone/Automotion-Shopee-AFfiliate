import { defineConfig } from 'vitest/config';

/**
 * PART 5: PostgreSQL integration suite.
 *
 * Run with `npm run test:db`, which boots an isolated real PostgreSQL
 * (scripts/db.ps1 + scripts/pg-lifecycle.mjs), applies every committed
 * migration with `drizzle-kit migrate`, and passes the connection to the
 * suite as TEST_DATABASE_URL.
 *
 * These tests deliberately use a real database — mocks cannot prove that two
 * concurrent claims do not collide, that `FOR UPDATE SKIP LOCKED` behaves, or
 * that a lease really expires. They never touch production credentials and
 * never call any external API (AI/storage/publishing are mocks).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/db/**/*.test.ts'],
    reporters: ['default'],
    passWithNoTests: false,
    // One shared cluster: files must not race each other for the same tables.
    fileParallelism: false,
    maxWorkers: 1,
    globalSetup: ['tests/db/global-setup.ts'],
    // Real round-trips (connect + migrate + claim) are slower than unit tests.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
