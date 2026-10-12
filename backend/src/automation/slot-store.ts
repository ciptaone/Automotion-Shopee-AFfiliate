/**
 * Slot content store (Part 3).
 *
 * Persists, per content slot, everything the pipeline decides and produces:
 *  - the reserved product,
 *  - the SELECTED IMAGE COUNT (chosen once, reused on every retry),
 *  - the generated assets (storage key, public URL, checksum, validation),
 *  - the generated captions per platform (with validation results),
 *  - the pipeline stage, blockers and errors.
 *
 * This is the module that makes "stable across retries" real: `runSlot` loads
 * the record first and only ever fills in what is missing. The image count is
 * written BEFORE generation begins, so a failed generation can never
 * re-randomize it.
 *
 * Persistence is pluggable (atomic file / in-memory) exactly like settings and
 * the catalog, with the same honesty rule: the file store is the verified
 * path here; a PostgreSQL-backed store is BLOCKED (no database available).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import type { ImageCountPolicy } from '../settings/automation-settings.js';
import type { SelectionMode } from './selection.js';

/* -------------------------------------------------------------------------- */
/*  Records                                                                   */
/* -------------------------------------------------------------------------- */

export type SlotStage =
  | 'reserved'
  | 'generating_images'
  | 'images_ready'
  | 'generating_captions'
  | 'captions_ready'
  | 'validated'
  | 'publish_ready'
  | 'blocked'
  | 'failed';

export const TERMINAL_SLOT_STAGES: readonly SlotStage[] = ['publish_ready', 'blocked', 'failed'];

export interface SlotBlocker {
  readonly code: string;
  readonly message: string;
}

export interface SlotAsset {
  /** Stable asset identity; survives retries. */
  readonly assetId: string;
  /** 1-based position in the shared image set. */
  readonly position: number;
  /** Composition intent: main POV close-up vs a complementary second angle. */
  readonly view: 'main_closeup_pov' | 'secondary_lifestyle';
  readonly storageKey: string;
  /** Publicly cURL-able URL (never a local file path). */
  readonly publicUrl: string;
  readonly checksumSha256: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly provider: string;
  readonly providerKind: 'mock' | 'live';
  readonly model: string;
  readonly promptVersion: string;
  readonly seed: number;
  readonly referenceImageUrl: string | null;
  readonly validationPassed: boolean;
  readonly validationIssues: readonly { rule: string; message: string; severity: string }[];
  readonly generatedAt: string;
}

export interface SlotCaption {
  readonly platform: 'facebook_page' | 'threads';
  readonly fullText: string;
  readonly hashtags: readonly string[];
  readonly provider: string;
  readonly providerKind: 'mock' | 'live';
  readonly model: string;
  readonly validationPassed: boolean;
  readonly blocking: readonly { rule: string; message: string }[];
  readonly warnings: readonly { rule: string; message: string }[];
  readonly generatedAt: string;
}

export interface SlotSelectionSnapshot {
  readonly mode: SelectionMode;
  readonly selectedCategoryIds: readonly string[];
  readonly score: number;
  readonly signals: Readonly<Record<string, number>>;
  readonly considered: number;
}

export interface SlotContentRecord {
  readonly slotKey: string;
  readonly stage: SlotStage;
  /** The reserved product's catalog identity (null until reserved). */
  readonly productId: string | null;
  readonly sourceProductId: string | null;
  readonly productName: string | null;
  readonly affiliateUrl: string | null;
  readonly categoryId: string | null;
  readonly imageCountPolicy: ImageCountPolicy;
  /** Chosen ONCE per slot, persisted before generation. Shared by both platforms. */
  readonly imageCount: number;
  readonly imageCountChosenAt: string;
  readonly selection: SlotSelectionSnapshot | null;
  readonly referenceImageUrl: string | null;
  /** Asset-generation job identity (the slot's pipeline run id). */
  readonly generationRunId: string;
  readonly assets: readonly SlotAsset[];
  readonly captions: readonly SlotCaption[];
  /** Publish-gate result; publish_ready requires every enabled gate to pass. */
  readonly validationPassed: boolean;
  readonly blockers: readonly SlotBlocker[];
  readonly lastError: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface SlotStoreSnapshot {
  readonly version: 1;
  readonly slots: readonly SlotContentRecord[];
  readonly updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/*  Store                                                                     */
/* -------------------------------------------------------------------------- */

export interface SlotStore {
  readonly kind: 'memory' | 'file';
  load(): Promise<SlotStoreSnapshot | null>;
  save(snapshot: SlotStoreSnapshot): Promise<void>;
}

export class InMemorySlotStore implements SlotStore {
  readonly kind = 'memory' as const;
  private value: SlotStoreSnapshot | null = null;

  async load(): Promise<SlotStoreSnapshot | null> {
    return this.value;
  }

  async save(snapshot: SlotStoreSnapshot): Promise<void> {
    this.value = snapshot;
  }
}

export class SlotStoreError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({
      code: 'SLOT_STORE_FAILED',
      category: 'configuration',
      message,
      expose: false,
      retryable: false,
      cause,
      context: {},
    });
  }
}

/** Atomic file store (temp write + rename), same crash-safety as settings. */
export class FileSlotStore implements SlotStore {
  readonly kind = 'file' as const;

  constructor(private readonly filePath: string) {}

  async load(): Promise<SlotStoreSnapshot | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new SlotStoreError(`Could not read slot store ${this.filePath}`, error);
    }
    try {
      const parsed = JSON.parse(raw) as SlotStoreSnapshot;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.slots)) {
        return parsed;
      }
      throw new SlotStoreError(`Slot store ${this.filePath} has an unsupported shape`);
    } catch (error) {
      if (error instanceof SlotStoreError) {
        throw error;
      }
      throw new SlotStoreError(`Slot store ${this.filePath} is not valid JSON`, error);
    }
  }

  async save(snapshot: SlotStoreSnapshot): Promise<void> {
    const dir = path.dirname(this.filePath);
    const tmp = `${this.filePath}.tmp`;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(tmp, `${JSON.stringify(snapshot)}\n`, 'utf8');
      await rename(tmp, this.filePath);
    } catch (error) {
      throw new SlotStoreError(`Could not write slot store ${this.filePath}`, error);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Service                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * In-process slot repository with a per-slot mutation lock.
 *
 * The lock serializes concurrent `mutate()` calls for the SAME slot key
 * (e.g. two pipeline workers racing to reserve one slot), so the first writer
 * wins and the second observes the already-reserved record — mirroring the
 * uniqueness guarantee a database unique index would provide.
 */
export class SlotContentStore {
  private slots = new Map<string, SlotContentRecord>();
  private initialized = false;
  private loadWarning: string | null = null;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly store: SlotStore = new InMemorySlotStore()) {}

  get storageKind(): 'memory' | 'file' {
    return this.store.kind;
  }

  get warning(): string | null {
    return this.loadWarning;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    try {
      const loaded = await this.store.load();
      if (loaded) {
        this.slots = new Map(loaded.slots.map((record) => [record.slotKey, record]));
      }
    } catch (error) {
      this.loadWarning =
        error instanceof AppError ? error.message : 'Slot store could not be loaded.';
      this.slots = new Map();
    }
  }

  get(slotKey: string): SlotContentRecord | null {
    return this.slots.get(slotKey) ?? null;
  }

  list(limit = 20): readonly SlotContentRecord[] {
    return [...this.slots.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.min(Math.max(1, limit), 100));
  }

  /**
   * Atomically read-modify-write one slot record.
   *
   * Concurrent `mutate()` calls for the same key are serialized through a
   * per-key promise chain (the in-process equivalent of a database unique
   * index + row lock): the first writer decides, the second observes the
   * result. The mapper MAY be async — the pipeline uses this to make
   * "reserve exactly once" race-free without holding the lock during slow
   * provider calls (only the decision runs inside the lock).
   */
  async mutate<T>(
    slotKey: string,
    mapper: (current: SlotContentRecord | null) => T | Promise<T>,
  ): Promise<T> {
    await this.init();
    const previous = this.locks.get(slotKey) ?? Promise.resolve();
    const run = previous.then(async () => {
      try {
        return await mapper(this.slots.get(slotKey) ?? null);
      } finally {
        // Keep the chain alive even when a mapper throws.
      }
    });
    // The chain stores a never-rejecting promise so one failure cannot wedge
    // the lock for subsequent callers.
    this.locks.set(
      slotKey,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** Persist a record (called inside `mutate` by the pipeline). */
  async put(record: SlotContentRecord): Promise<void> {
    await this.init();
    this.slots.set(record.slotKey, record);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.store.save({
      version: 1,
      slots: [...this.slots.values()],
      updatedAt: new Date().toISOString(),
    });
  }
}
