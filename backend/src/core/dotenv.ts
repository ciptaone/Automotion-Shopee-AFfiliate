/**
 * `.env` file loading (Part 9 §3).
 *
 * The documented workflow ("copy backend/.env.example to backend/.env") needs
 * something that actually reads the file — and it must behave like a
 * 12-factor citizen: **real environment variables always win**, so a systemd
 * unit, a container orchestrator or a shell export is never silently
 * overridden by a file on disk.
 *
 * Rules:
 *   - missing file is normal (containers/systemd inject variables instead);
 *   - never prints values — only a debug-level note that the file was found;
 *   - load once per process; idempotent;
 *   - called explicitly at the top of the entrypoints (main.ts + CLIs), never
 *     from library code, so tests control their own environment.
 */
import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';

let loaded = false;

export function loadDotEnv(cwd: string = process.cwd()): boolean {
  if (loaded) return false;
  loaded = true;
  try {
    const result = dotenvConfig({ path: path.join(cwd, '.env'), quiet: true });
    // A missing file is the normal case in containers and CI.
    return !result.error;
  } catch {
    return false;
  }
}

/** TEST-ONLY: allow a second load in the same process. */
export function resetDotEnvCache(): void {
  loaded = false;
}
