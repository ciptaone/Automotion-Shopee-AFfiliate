/**
 * Vitest global setup for the PostgreSQL integration suite (PART 5).
 *
 * Applies the COMMITTED migration chain (drizzle/0000 -> 0001 -> 0002) to the
 * test database with the official `drizzle-kit migrate`, exactly as production
 * would. That makes every `npm run test:db` run also a real migration test: a
 * migration that cannot be applied fails the suite instead of being claimed as
 * verified.
 *
 * The cluster itself is started by `scripts/test-db.ps1`; this file only
 * consumes TEST_DATABASE_URL. Nothing here touches production: the URL must
 * point at the throwaway local cluster (port 55432, database autopilot_test).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default function globalSetup(): void {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Run this suite through `npm run test:db`, ' +
        'which boots an isolated PostgreSQL and sets it for you.',
    );
  }

  // `drizzle-kit migrate` reads DATABASE_URL from its config file, which reads
  // it from the environment. Propagate it for the child process only.
  const backend = process.cwd();
  process.env.DATABASE_URL = url;

  execFileSync(
    process.execPath,
    [path.join(backend, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'],
    {
      cwd: backend,
      env: { ...process.env, DATABASE_URL: url, CI: '1' },
      stdio: 'inherit',
    },
  );
}
