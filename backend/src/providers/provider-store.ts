/**
 * Provider workspace persistence (Part 6 §2/§3).
 *
 * One document holds the provider CONFIGURATIONS, the independent text/image
 * selections and the per-provider readiness probes. It deliberately holds no
 * credentials — those live in `src/secrets/secret-store.ts`.
 *
 * Backends follow the established pattern (`SettingsStore`):
 *   memory (tests) / file (`backend/data/providers.json`, dev) / postgres
 *   (`provider_workspaces`, single row with optimistic versioning).
 *
 * Documents are re-validated on load, so a hand-edited or truncated file can
 * never put an invalid provider into the scheduler's generation path.
 */
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { atomicWriteText, createSerialQueue } from '../core/atomic-file.js';
import { AppError } from '../core/errors.js';
import { providerWorkspaces } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { EMPTY_WORKSPACE, providerInputSchema, type ProviderWorkspace } from './types.js';

const storedProviderSchema = providerInputSchema.extend({
  id: z.string().trim().min(1).max(64),
  createdAt: z.string().trim().min(1).max(40),
  updatedAt: z.string().trim().min(1).max(40),
});

const readinessSchema = z.record(
  z.string().max(64),
  z.record(
    z.enum([
      'configuration',
      'authentication',
      'text_generation',
      'image_generation',
      'image_reference_input',
      'image_editing',
      'structured_output',
    ]),
    z.object({
      status: z.enum([
        'not_configured',
        'configuration_invalid',
        'authentication_failed',
        'ready',
        'capability_unsupported',
        'temporarily_unavailable',
        'rate_limited',
        'test_failed',
      ]),
      testedAt: z.string().nullable(),
      detail: z.string().max(500),
      requestId: z.string().max(200).nullable(),
    }),
  ),
);

const workspaceSchema = z.object({
  providers: z.array(storedProviderSchema).max(50),
  textProviderId: z.string().max(64).nullable(),
  imageProviderId: z.string().max(64).nullable(),
  readiness: readinessSchema.default({}),
  updatedAt: z.string(),
});

export class ProviderStoreError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({
      code: 'PROVIDER_STORE_FAILED',
      category: 'configuration',
      message,
      expose: false,
      retryable: false,
      cause,
      context: {},
    });
  }
}

export function parseWorkspace(input: unknown): ProviderWorkspace {
  const result = workspaceSchema.safeParse(input);
  if (!result.success) {
    throw new ProviderStoreError(
      `Provider workspace failed validation (${result.error.issues.length} issue(s)); refusing to load it.`,
    );
  }
  return result.data;
}

export interface ProviderStore {
  readonly kind: 'memory' | 'file' | 'postgres';
  load(): Promise<ProviderWorkspace>;
  save(workspace: ProviderWorkspace): Promise<void>;
}

export class InMemoryProviderStore implements ProviderStore {
  readonly kind = 'memory' as const;
  private value: ProviderWorkspace | null = null;

  async load(): Promise<ProviderWorkspace> {
    return this.value ?? EMPTY_WORKSPACE;
  }

  async save(workspace: ProviderWorkspace): Promise<void> {
    this.value = parseWorkspace(workspace);
  }
}

export class FileProviderStore implements ProviderStore {
  readonly kind = 'file' as const;
  private readonly queue = createSerialQueue();

  constructor(private readonly filePath: string) {}

  async load(): Promise<ProviderWorkspace> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_WORKSPACE;
      throw new ProviderStoreError(`Could not read provider workspace ${this.filePath}`, error);
    }
    try {
      return parseWorkspace(JSON.parse(raw));
    } catch (error) {
      if (error instanceof ProviderStoreError) throw error;
      throw new ProviderStoreError(`Provider workspace ${this.filePath} is not valid JSON`, error);
    }
  }

  async save(workspace: ProviderWorkspace): Promise<void> {
    await this.queue(async () => {
      try {
        await atomicWriteText(this.filePath, `${JSON.stringify(workspace, null, 2)}\n`);
      } catch (error) {
        throw new ProviderStoreError(`Could not write provider workspace ${this.filePath}`, error);
      }
    });
  }
}

type Row = Record<string, unknown>;

export class PostgresProviderStore implements ProviderStore {
  readonly kind = 'postgres' as const;

  constructor(private readonly db: Database) {}

  async load(): Promise<ProviderWorkspace> {
    const rows = (await this.db
      .select()
      .from(providerWorkspaces)
      .limit(1)) as unknown as Row[];
    const row = rows[0];
    if (!row) return EMPTY_WORKSPACE;
    const doc = row['doc'];
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      return parseWorkspace(doc);
    }
    if (typeof doc === 'string') {
      try {
        return parseWorkspace(JSON.parse(doc));
      } catch {
        return EMPTY_WORKSPACE;
      }
    }
    return EMPTY_WORKSPACE;
  }

  async save(workspace: ProviderWorkspace): Promise<void> {
    const document = JSON.stringify(workspace);
    await this.db
      .insert(providerWorkspaces)
      .values({ id: 1, doc: document, version: 1, updatedAt: new Date() } as never)
      .onConflictDoUpdate({
        target: providerWorkspaces.id,
        set: {
          doc: sql`${document}::jsonb`,
          version: sql`${providerWorkspaces.version} + 1`,
          updatedAt: new Date(),
        } as never,
      });
  }
}
