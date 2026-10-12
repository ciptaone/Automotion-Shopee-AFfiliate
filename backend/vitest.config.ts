import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    reporters: ['default'],
    passWithNoTests: false,
    // Contract/unit tests must never touch the network or a real database.
    // Individual tests that would need external services must be marked BLOCKED instead.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
