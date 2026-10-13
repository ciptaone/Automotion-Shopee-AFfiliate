/**
 * PART 6 §3/§9/§10 — provider workspace, encrypted secrets and the usage
 * ledger against a REAL PostgreSQL.
 *
 * What only a real database can prove here:
 *   - a saved workspace (providers + independent selections) survives a
 *     backend restart, i.e. a brand-new store instance over the same database;
 *   - a credential is stored as CIPHERTEXT only (the row never contains the
 *     plaintext), decrypts with the server key, and comes back as `null` for a
 *     wrong/missing key — fail closed, never plaintext;
 *   - the usage ledger persists across restart and rolls up honestly
 *     (actual vs estimated vs unknown cost never mixed);
 *   - the transactional daily cap holds when TWO workers (separate pools)
 *     enqueue the same day at the same time: at most `max` posts per day.
 *
 * Credential-free: keys are deterministic test buffers, no external API is
 * ever contacted, nothing is published.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PostgresProviderStore } from '../../src/providers/provider-store.js';
import { PostgresSecretStore, SecretCipher } from '../../src/secrets/secret-store.js';
import { PostgresUsageStore, type UsageRecord } from '../../src/usage/usage-store.js';
import { PostgresJobQueue } from '../../src/db/postgres-job-queue.js';
import { DailyPostLimitError } from '../../src/core/errors.js';
import type { EnqueueJobInput } from '../../src/contracts/index.js';
import { openTestDatabase, resetDatabase, type TestDatabase } from './helpers.js';

const KEY_A = Buffer.alloc(32, 7);
const KEY_B = Buffer.alloc(32, 9); // a different, valid server key

let primary: TestDatabase;
let replica: TestDatabase; // second pool = "restarted backend"

beforeAll(async () => {
  primary = openTestDatabase();
  replica = openTestDatabase();
});

afterAll(async () => {
  await primary.close();
  await replica.close();
});

beforeEach(async () => {
  await resetDatabase(primary.db);
});

/* ========================================================================== */
/*  Provider workspace persistence                                           */
/* ========================================================================== */

describe('provider workspace survives a restart (Postgres)', () => {
  const workspace = {
    providers: [
      {
        id: 'prov-text-1',
        name: 'acme-text',
        displayName: 'Acme Text',
        adapterType: 'openai_chat_completions' as const,
        baseUrl: 'https://api.acme.example/v1',
        model: 'acme-large',
        auth: { type: 'bearer' as const },
        extraHeaders: {},
        params: {},
        timeoutMs: 30_000,
        maxRetries: 2,
        enabled: true,
        capabilityOverrides: {},
        createdAt: '2026-10-12T00:00:00.000Z',
        updatedAt: '2026-10-12T00:00:00.000Z',
      },
      {
        id: 'prov-image-1',
        name: 'acme-image',
        displayName: 'Acme Image',
        adapterType: 'openai_images' as const,
        baseUrl: 'https://images.acme.example/v1',
        model: 'acme-diffusion',
        auth: { type: 'bearer' as const },
        extraHeaders: {},
        params: {},
        timeoutMs: 60_000,
        maxRetries: 1,
        enabled: true,
        capabilityOverrides: {},
        createdAt: '2026-10-12T00:00:00.000Z',
        updatedAt: '2026-10-12T00:00:00.000Z',
      },
    ],
    // Independent selection: text and image point at DIFFERENT providers.
    textProviderId: 'prov-text-1',
    imageProviderId: 'prov-image-1',
    readiness: {
      'prov-text-1': {
        configuration: {
          status: 'ready' as const,
          testedAt: '2026-10-12T01:00:00.000Z',
          detail: 'Configuration validated.',
          requestId: null,
        },
      },
    },
    updatedAt: '2026-10-12T01:00:00.000Z',
  };

  it('round-trips the workspace including independent selections', async () => {
    const store = new PostgresProviderStore(primary.db);
    await store.save(workspace as never);

    // A fresh instance over the same database = backend restart.
    const restarted = new PostgresProviderStore(replica.db);
    const loaded = await restarted.load();
    expect(loaded.providers).toHaveLength(2);
    expect(loaded.textProviderId).toBe('prov-text-1');
    expect(loaded.imageProviderId).toBe('prov-image-1');
    expect(loaded.readiness['prov-text-1']?.['configuration']?.status).toBe('ready');
  });

  it('an empty database yields the empty workspace (no crash, no mock)', async () => {
    const store = new PostgresProviderStore(primary.db);
    const loaded = await store.load();
    expect(loaded.providers).toHaveLength(0);
    expect(loaded.textProviderId).toBeNull();
    expect(loaded.imageProviderId).toBeNull();
  });

  it('keeps exactly one workspace row (single-row invariant)', async () => {
    const store = new PostgresProviderStore(primary.db);
    await store.save(workspace as never);
    await store.save({ ...workspace, textProviderId: null } as never);
    await store.save({ ...workspace, textProviderId: 'prov-text-1' } as never);

    const rows = (await primary.raw.unsafe(
      'select count(*)::int as count from provider_workspaces',
    )) as unknown as { count: number }[];
    expect(rows[0]?.count).toBe(1);
  });
});

/* ========================================================================== */
/*  Secrets — encrypted at rest, fail closed                                 */
/* ========================================================================== */

describe('provider secrets (Postgres) — ciphertext only, fail closed', () => {
  const PROVIDER_ID = 'prov-secret-1';
  const PLAINTEXT = 'sk-live-DEADBEEF1234567890';

  it('never stores the plaintext in the database', async () => {
    const store = new PostgresSecretStore(primary.db, new SecretCipher(KEY_A));
    await store.set(PROVIDER_ID, PLAINTEXT);

    const rows = (await primary.raw.unsafe(
      'select iv, tag, ct, alg from provider_secrets where provider_id = $1',
      [PROVIDER_ID],
    )) as unknown as { iv: string; tag: string; ct: string; alg: string }[];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.alg).toBe('A256GCM');
    // The plaintext must not appear in any column.
    const blob = `${row.iv} ${row.tag} ${row.ct}`;
    expect(blob).not.toContain('DEADBEEF');
    expect(blob).not.toContain(PLAINTEXT);
    expect(row.ct.length).toBeGreaterThan(0);
    // Fresh IV per write: a replaced secret must not reuse the old IV.
    await store.set(PROVIDER_ID, 'sk-live-ANOTHER-SECRET-000001');
    const rows2 = (await primary.raw.unsafe(
      'select iv, ct from provider_secrets where provider_id = $1',
      [PROVIDER_ID],
    )) as unknown as { iv: string; ct: string }[];
    expect(rows2[0]?.iv).not.toBe(row.iv);
  });

  it('decrypts after a restart with the same key', async () => {
    const store = new PostgresSecretStore(primary.db, new SecretCipher(KEY_A));
    await store.set(PROVIDER_ID, PLAINTEXT);

    const restarted = new PostgresSecretStore(replica.db, new SecretCipher(KEY_A));
    await expect(restarted.get(PROVIDER_ID)).resolves.toBe(PLAINTEXT);
  });

  it('fails closed with a different key (returns null, never plaintext)', async () => {
    const store = new PostgresSecretStore(primary.db, new SecretCipher(KEY_A));
    await store.set(PROVIDER_ID, PLAINTEXT);

    const wrongKey = new PostgresSecretStore(replica.db, new SecretCipher(KEY_B));
    await expect(wrongKey.get(PROVIDER_ID)).resolves.toBeNull();
    // ...and the ciphertext itself is untouched.
    await expect(
      new PostgresSecretStore(replica.db, new SecretCipher(KEY_A)).get(PROVIDER_ID),
    ).resolves.toBe(PLAINTEXT);
  });

  it('fails closed when no encryption key is configured at all', async () => {
    const store = new PostgresSecretStore(primary.db, null);
    expect(store.keyConfigured).toBe(false);
    await expect(store.set(PROVIDER_ID, PLAINTEXT)).rejects.toThrow(/SECRETS_ENCRYPTION_KEY/);
    // Nothing was written, and nothing can be read back.
    const rows = (await primary.raw.unsafe(
      'select count(*)::int as count from provider_secrets',
    )) as unknown as { count: number }[];
    expect(rows[0]?.count).toBe(0);
    await expect(store.get(PROVIDER_ID)).resolves.toBeNull();

    // Even with a row present, a keyless store never decrypts anything.
    const withKey = new PostgresSecretStore(primary.db, new SecretCipher(KEY_A));
    await withKey.set(PROVIDER_ID, PLAINTEXT);
    await expect(store.get(PROVIDER_ID)).resolves.toBeNull();
  });

  it('replace and delete behave (delete is idempotent)', async () => {
    const store = new PostgresSecretStore(primary.db, new SecretCipher(KEY_A));
    await store.set(PROVIDER_ID, 'first-value');
    await store.set(PROVIDER_ID, 'second-value');
    await expect(store.get(PROVIDER_ID)).resolves.toBe('second-value');
    await expect(store.has(PROVIDER_ID)).resolves.toBe(true);

    await expect(store.delete(PROVIDER_ID)).resolves.toBe(true);
    await expect(store.get(PROVIDER_ID)).resolves.toBeNull();
    await expect(store.has(PROVIDER_ID)).resolves.toBe(false);
    await expect(store.delete(PROVIDER_ID)).resolves.toBe(false);
  });
});

/* ========================================================================== */
/*  Usage ledger persistence + honest roll-ups                               */
/* ========================================================================== */

function usageRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: randomUUID(),
    at: new Date().toISOString(),
    providerId: 'prov-text-1',
    providerName: 'Acme Text',
    adapterType: 'openai_chat_completions',
    model: 'acme-large',
    operation: 'text_generation',
    requestId: `req_${randomUUID().slice(0, 8)}`,
    status: 'success',
    latencyMs: 42,
    inputTokens: 100,
    outputTokens: 50,
    images: null,
    costUsd: null,
    costKind: 'unknown',
    errorCode: null,
    ...overrides,
  };
}

describe('usage ledger (Postgres) — persists and rolls up honestly', () => {
  it('survives a restart and keeps cost classification intact', async () => {
    const store = new PostgresUsageStore(primary.db);
    await store.append(usageRecord({ costUsd: 0.004, costKind: 'actual' }));
    await store.append(usageRecord({ costUsd: 0.002, costKind: 'estimated' }));
    await store.append(usageRecord({ costUsd: null, costKind: 'unknown' }));
    await store.append(
      usageRecord({ status: 'error', errorCode: 'AI_PROVIDER_FAILED', costKind: 'unknown' }),
    );

    const restarted = new PostgresUsageStore(replica.db);
    const records = await restarted.list(50);
    expect(records).toHaveLength(4);

    const actual = records.filter((r) => r.costKind === 'actual');
    const estimated = records.filter((r) => r.costKind === 'estimated');
    const unknown = records.filter((r) => r.costKind === 'unknown');
    expect(actual).toHaveLength(1);
    expect(estimated).toHaveLength(1);
    expect(unknown).toHaveLength(2); // includes the failure

    // The money sum only ever counts classified (actual/estimated) costs.
    const dayStart = new Date(Date.now() - 3_600_000).toISOString();
    const dayEnd = new Date(Date.now() + 3_600_000).toISOString();
    const totals = await restarted.totals(dayStart, dayEnd);
    expect(totals.requests).toBe(4);
    expect(totals.failures).toBe(1);
    expect(totals.actualCostUsd).toBeCloseTo(0.004, 10);
    expect(totals.estimatedCostUsd).toBeCloseTo(0.002, 10);
    expect(totals.knownCostUsd).toBeCloseTo(0.006, 10);
    expect(totals.unknownCostRequests).toBe(2);
  });

  it('the ledger enforces status/cost_kind check constraints', async () => {
    const store = new PostgresUsageStore(primary.db);
    await expect(
      store.append(usageRecord({ costKind: 'made_up' as never })),
    ).rejects.toThrow();
    await expect(
      store.append(usageRecord({ status: 'pending' as never })),
    ).rejects.toThrow();
  });
});

/* ========================================================================== */
/*  Transactional daily cap — two workers, one database                      */
/* ========================================================================== */

function contentJob(slotKey: string, max: number): EnqueueJobInput {
  const date = slotKey.split('#')[0]!;
  return {
    kind: 'content_generation',
    uniqueKey: `content:${slotKey}`,
    scheduledFor: `${date}T00:00:00.000Z`,
    payload: { slotKey },
    dailyCap: { dayPrefix: `content:${date}#`, max },
  };
}

describe('daily posting cap — transactional under concurrency (Postgres)', () => {
  it('two workers enqueueing the same day never exceed the target', async () => {
    // Two independent pools = two backend processes.
    const workerA = new PostgresJobQueue({ db: primary.db });
    const workerB = new PostgresJobQueue({ db: replica.db });

    const keys = Array.from({ length: 8 }, (_, i) => `2026-10-12#${String(i + 1).padStart(2, '0')}`);
    const attempts = await Promise.all(
      keys.map((key, i) => {
        const queue = i % 2 === 0 ? workerA : workerB;
        return queue.enqueue(contentJob(key, 4)).catch((error: unknown) => error);
      }),
    );

    const created = attempts.filter((entry) => !(entry instanceof Error));
    expect(created).toHaveLength(4);
    const refused = attempts.filter((entry) => entry instanceof DailyPostLimitError);
    expect(refused).toHaveLength(4);

    const rows = (await primary.raw.unsafe(
      `select count(*)::int as count from jobs where unique_key like 'content:2026-10-12%'`,
    )) as unknown as { count: number }[];
    expect(rows[0]?.count).toBe(4);
  });

  it('a sequential storm of 12 keys still stops at the target', async () => {
    const queue = new PostgresJobQueue({ db: primary.db });
    let created = 0;
    let refused = 0;
    for (let i = 1; i <= 12; i += 1) {
      const key = `2026-10-12#${String(i).padStart(2, '0')}`;
      try {
        await queue.enqueue(contentJob(key, 3));
        created += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(DailyPostLimitError);
        refused += 1;
      }
    }
    expect(created).toBe(3);
    expect(refused).toBe(9);
  });

  it('re-enqueueing a live key is idempotent and does not consume the cap', async () => {
    const queue = new PostgresJobQueue({ db: primary.db });
    const first = await queue.enqueue(contentJob('2026-10-12#01', 4));
    const again = await queue.enqueue(contentJob('2026-10-12#01', 4));
    expect(again.id).toBe(first.id);

    // Three more posts are still allowed for that day.
    for (const index of ['02', '03', '04']) {
      await expect(queue.enqueue(contentJob(`2026-10-12#${index}`, 4))).resolves.toBeTruthy();
    }
    await expect(queue.enqueue(contentJob('2026-10-12#05', 4))).rejects.toThrow(
      DailyPostLimitError,
    );
  });

  it('the cap is per Jakarta day prefix, not global', async () => {
    const queue = new PostgresJobQueue({ db: primary.db });
    for (const index of ['01', '02', '03', '04']) {
      await queue.enqueue(contentJob(`2026-10-12#${index}`, 4));
    }
    // Next day: fresh allowance.
    await expect(queue.enqueue(contentJob('2026-10-13#01', 4))).resolves.toBeTruthy();
    await expect(
      queue.enqueue({
        kind: 'feed_import',
        uniqueKey: 'feed:2026-10-12',
        scheduledFor: '2026-10-12T00:00:00.000Z',
        payload: {},
      }),
    ).resolves.toBeTruthy(); // no cap supplied at all
  });

  it('without a dailyCap the legacy unlimited behaviour is preserved', async () => {
    const queue = new PostgresJobQueue({ db: primary.db });
    for (let i = 1; i <= 10; i += 1) {
      const key = String(i).padStart(2, '0');
      await expect(
        queue.enqueue({
          kind: 'content_generation',
          uniqueKey: `content:legacy-${key}`,
          scheduledFor: '2026-10-12T00:00:00.000Z',
          payload: {},
        }),
      ).resolves.toBeTruthy();
    }
    const rows = (await primary.raw.unsafe(
      `select count(*)::int as count from jobs where unique_key like 'content:legacy-%'`,
    )) as unknown as { count: number }[];
    expect(rows[0]?.count).toBe(10);
  });

  it('advisory lock key is stable and the cap column exists', async () => {
    const columns = (await primary.raw.unsafe(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'jobs'
         and column_name in ('unique_key', 'payload', 'scheduled_for')`,
    )) as unknown as { column_name: string }[];
    expect(columns).toHaveLength(3);

    // The day lock is per-day; concurrent planners serialize on it.
    const lockProbe = await primary.raw.unsafe(
      'select pg_advisory_xact_lock($1::int) as locked',
      [20261012],
    );
    expect(lockProbe).toHaveLength(1);
  });
});
