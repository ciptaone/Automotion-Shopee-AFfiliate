/**
 * Encrypted-at-rest secret storage (Part 6 §4).
 *
 * Provider credentials live ONLY here:
 *  - never inside `ProviderConfig` (configuration and secrets stay separate),
 *  - never in Flutter preferences or browser storage (clients cannot read them),
 *  - never in logs or API responses (only presence + masked metadata is exposed).
 *
 * Encryption: AES-256-GCM with a 32-byte key supplied through the server-side
 * environment variable `SECRETS_ENCRYPTION_KEY` (base64 or hex). There is no
 * built-in key, no key file, and no plaintext fallback: when the key is missing
 * every write FAILS CLOSED (`SECRETS_KEY_MISSING`) and every read reports the
 * provider as unconfigured instead of silently using an unprotected value.
 *
 * Backends mirror the settings/catalog stores:
 *  - `memory`  — tests only (process-local, clearly labelled),
 *  - `file`    — development, ciphertext JSON under `backend/data/`,
 *  - `postgres`— production, `provider_secrets` rows (ciphertext columns only).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { AppError } from '../core/errors.js';
import { atomicWriteText, createSerialQueue } from '../core/atomic-file.js';
import { providerSecrets } from '../db/schema.js';
import type { Database } from '../db/client.js';

/* -------------------------------------------------------------------------- */
/*  Cipher                                                                    */
/* -------------------------------------------------------------------------- */

export class SecretsKeyMissingError extends AppError {
  constructor(reason: string) {
    super({
      code: 'SECRETS_KEY_MISSING',
      category: 'configuration',
      message: `Provider secrets cannot be stored: ${reason}. Set SECRETS_ENCRYPTION_KEY (32 bytes, base64 or hex) in the server environment.`,
      expose: true,
      retryable: false,
      context: { reason },
    });
  }
}

/** Parse a 32-byte key from base64 or hex. Returns null when unset/blank. */
export function parseEncryptionKey(raw: string | undefined | null): Buffer | null {
  if (!raw || raw.trim().length === 0) return null;
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength === 32 ? decoded : null;
}

export interface SealedSecret {
  readonly v: 1;
  readonly alg: 'A256GCM';
  readonly iv: string;
  readonly tag: string;
  readonly ct: string;
}

export class SecretCipher {
  private key: Buffer;

  constructor(key: Buffer) {
    if (key.byteLength !== 32) {
      throw new SecretsKeyMissingError('the encryption key is not 32 bytes');
    }
    this.key = key;
  }

  seal(plaintext: string): SealedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      v: 1,
      alg: 'A256GCM',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    };
  }

  open(sealed: SealedSecret): string {
    if (sealed.alg !== 'A256GCM') {
      throw new SecretsKeyMissingError('stored secret uses an unsupported algorithm');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const pt = Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]);
    return pt.toString('utf8');
  }
}

/** Build a cipher from the environment, or null when no key is configured. */
export function cipherFromEnv(raw: string | undefined | null): SecretCipher | null {
  const key = parseEncryptionKey(raw);
  if (!key) return null;
  return new SecretCipher(key);
}

/**
 * Cheap, non-reversible secret fingerprint used for "same value?" checks in
 * tests and for masked metadata (`sk-…a1b2`). Never reversible to the secret.
 */
export function maskedPreview(secret: string): string {
  const visible = secret.replace(/\s+/g, '').slice(0, 3);
  return `${visible}${'•'.repeat(4)}${secret.slice(-2)}`;
}

/* -------------------------------------------------------------------------- */
/*  Store contract                                                            */
/* -------------------------------------------------------------------------- */

export interface SecretStore {
  readonly kind: 'memory' | 'file' | 'postgres';
  /** False when no encryption key is configured (writes fail closed). */
  readonly keyConfigured: boolean;
  /** Create or REPLACE the secret for a provider. Never logged, never returned. */
  set(providerId: string, secret: string): Promise<void>;
  /** Plaintext read — server-side use ONLY (outbound requests). */
  get(providerId: string): Promise<string | null>;
  /** Whether a secret exists, without decrypting it. */
  has(providerId: string): Promise<boolean>;
  /** Remove the secret. Returns true when one existed. */
  delete(providerId: string): Promise<boolean>;
}

function requireCipher(cipher: SecretCipher | null): SecretCipher {
  if (!cipher) throw new SecretsKeyMissingError('SECRETS_ENCRYPTION_KEY is not set');
  return cipher;
}

/* -------------------------------------------------------------------------- */
/*  In-memory (tests / ephemeral dev)                                         */
/* -------------------------------------------------------------------------- */

/** Test-only store. Ciphertext is real AES-GCM; the map lives in this process. */
export class InMemorySecretStore implements SecretStore {
  readonly kind = 'memory' as const;
  private readonly entries = new Map<string, SealedSecret>();

  constructor(private readonly cipher: SecretCipher | null) {}

  get keyConfigured(): boolean {
    return this.cipher !== null;
  }

  async set(providerId: string, secret: string): Promise<void> {
    this.entries.set(providerId, requireCipher(this.cipher).seal(secret));
  }

  async get(providerId: string): Promise<string | null> {
    const sealed = this.entries.get(providerId);
    if (!sealed) return null;
    try {
      return requireCipher(this.cipher).open(sealed);
    } catch {
      // Wrong/rotated key: fail closed rather than returning garbage.
      return null;
    }
  }

  async has(providerId: string): Promise<boolean> {
    return this.entries.has(providerId);
  }

  async delete(providerId: string): Promise<boolean> {
    return this.entries.delete(providerId);
  }
}

/* -------------------------------------------------------------------------- */
/*  File (development)                                                        */
/* -------------------------------------------------------------------------- */

interface SecretFileDocument {
  readonly v: 1;
  readonly entries: Record<string, SealedSecret>;
}

/**
 * Ciphertext-on-disk store. The file contains NO plaintext and NO key: without
 * `SECRETS_ENCRYPTION_KEY` the entries are unreadable (recovery limitation,
 * documented in part-06-evidence.md).
 */
export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;
  private readonly queue = createSerialQueue();
  private cache: SecretFileDocument | null = null;

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher | null,
  ) {}

  get keyConfigured(): boolean {
    return this.cipher !== null;
  }

  private async load(): Promise<SecretFileDocument> {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = { v: 1, entries: {} };
        return this.cache;
      }
      throw new AppError({
        code: 'SECRET_STORE_FAILED',
        category: 'configuration',
        message: 'Provider secret store could not be read.',
        expose: false,
        retryable: false,
        cause: error,
        context: {},
      });
    }
    try {
      const parsed = JSON.parse(raw) as SecretFileDocument;
      this.cache = { v: 1, entries: parsed.entries ?? {} };
    } catch {
      throw new AppError({
        code: 'SECRET_STORE_FAILED',
        category: 'configuration',
        message: 'Provider secret store is corrupt; refusing to overwrite it.',
        expose: false,
        retryable: false,
        context: {},
      });
    }
    return this.cache;
  }

  private async persist(doc: SecretFileDocument): Promise<void> {
    await atomicWriteText(this.filePath, `${JSON.stringify(doc, null, 2)}\n`);
    this.cache = doc;
  }

  async set(providerId: string, secret: string): Promise<void> {
    const cipher = requireCipher(this.cipher);
    await this.queue(async () => {
      const doc = await this.load();
      await this.persist({ v: 1, entries: { ...doc.entries, [providerId]: cipher.seal(secret) } });
    });
  }

  async get(providerId: string): Promise<string | null> {
    const doc = await this.load();
    const sealed = doc.entries[providerId];
    if (!sealed) return null;
    try {
      return requireCipher(this.cipher).open(sealed);
    } catch {
      return null;
    }
  }

  async has(providerId: string): Promise<boolean> {
    const doc = await this.load();
    return Boolean(doc.entries[providerId]);
  }

  async delete(providerId: string): Promise<boolean> {
    return this.queue(async () => {
      const doc = await this.load();
      if (!doc.entries[providerId]) return false;
      const entries = { ...doc.entries };
      delete entries[providerId];
      await this.persist({ v: 1, entries });
      return true;
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  PostgreSQL (production)                                                   */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

export class PostgresSecretStore implements SecretStore {
  readonly kind = 'postgres' as const;

  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher | null,
  ) {}

  get keyConfigured(): boolean {
    return this.cipher !== null;
  }

  async set(providerId: string, secret: string): Promise<void> {
    const sealed = requireCipher(this.cipher).seal(secret);
    await this.db
      .insert(providerSecrets)
      .values({
        providerId,
        alg: sealed.alg,
        iv: sealed.iv,
        tag: sealed.tag,
        ct: sealed.ct,
        updatedAt: new Date(),
      } as never)
      .onConflictDoUpdate({
        target: providerSecrets.providerId,
        set: {
          alg: sealed.alg,
          iv: sealed.iv,
          tag: sealed.tag,
          ct: sealed.ct,
          updatedAt: new Date(),
        } as never,
      });
  }

  private async row(providerId: string): Promise<Row | null> {
    const rows = (await this.db
      .select()
      .from(providerSecrets)
      .where(sql`${providerSecrets.providerId} = ${providerId}`)
      .limit(1)) as unknown as Row[];
    return rows[0] ?? null;
  }

  async get(providerId: string): Promise<string | null> {
    const row = await this.row(providerId);
    if (!row) return null;
    try {
      return requireCipher(this.cipher).open({
        v: 1,
        alg: 'A256GCM',
        iv: String(row['iv']),
        tag: String(row['tag']),
        ct: String(row['ct']),
      });
    } catch {
      return null;
    }
  }

  async has(providerId: string): Promise<boolean> {
    return (await this.row(providerId)) !== null;
  }

  async delete(providerId: string): Promise<boolean> {
    const existing = await this.row(providerId);
    if (!existing) return false;
    await this.db.delete(providerSecrets).where(sql`${providerSecrets.providerId} = ${providerId}`);
    return true;
  }
}
