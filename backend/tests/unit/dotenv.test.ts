/**
 * PART 9 §3 — `.env` file loading behaves like a 12-factor citizen.
 *
 *  - reads `backend/.env` from a caller-provided directory,
 *  - NEVER overrides a variable already present in the real environment
 *    (systemd/container exports win over the file),
 *  - a missing file is normal, not an error,
 *  - loads at most once per process unless the test-only cache is reset.
 *
 * The probe keys are random per run so nothing collides with the suite's own
 * environment.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadDotEnv, resetDotEnvCache } from '../../src/core/dotenv.js';

const PROBE_A = `PART9_DOTENV_PROBE_A_${process.pid}`;
const PROBE_B = `PART9_DOTENV_PROBE_B_${process.pid}`;

afterEach(async () => {
  resetDotEnvCache();
  delete process.env[PROBE_A];
  delete process.env[PROBE_B];
});

async function withEnvFile(content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'part9-dotenv-'));
  await writeFile(path.join(dir, '.env'), content, 'utf8');
  return dir;
}

describe('loadDotEnv', () => {
  it('loads values from the file into process.env', async () => {
    const dir = await withEnvFile(`${PROBE_A}=from_file\n`);
    expect(loadDotEnv(dir)).toBe(true);
    expect(process.env[PROBE_A]).toBe('from_file');
    await rm(dir, { recursive: true, force: true });
  });

  it('real environment variables always win over the file', async () => {
    process.env[PROBE_B] = 'from_environment';
    const dir = await withEnvFile(`${PROBE_B}=from_file\n`);
    expect(loadDotEnv(dir)).toBe(true);
    expect(process.env[PROBE_B]).toBe('from_environment'); // file did NOT override
    await rm(dir, { recursive: true, force: true });
  });

  it('treats a missing file as normal (containers/systemd inject instead)', async () => {
    const missing = path.join(tmpdir(), `part9-dotenv-missing-${process.pid}`);
    expect(loadDotEnv(missing)).toBe(false);
    expect(process.env[PROBE_A]).toBeUndefined();
  });

  it('is a no-op on the second call within a process', async () => {
    const first = await withEnvFile(`${PROBE_A}=first\n`);
    expect(loadDotEnv(first)).toBe(true);
    expect(process.env[PROBE_A]).toBe('first');

    const second = await withEnvFile(`${PROBE_A}=second\n`);
    expect(loadDotEnv(second)).toBe(false); // cache: one load per process
    expect(process.env[PROBE_A]).toBe('first');
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  });
});
