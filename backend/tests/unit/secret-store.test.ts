/**
 * PART 6 §4 — provider secret storage.
 *
 * Proves: AES-256-GCM encryption at rest, no plaintext ever on disk, replace
 * and delete are safe, a missing/unusable key FAILS CLOSED (no plaintext
 * fallback), a wrong key never returns garbage, and previews are masked.
 * Credential-free: the values below are obvious synthetic test strings.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FileSecretStore,
  InMemorySecretStore,
  SecretCipher,
  SecretsKeyMissingError,
  cipherFromEnv,
  maskedPreview,
  parseEncryptionKey,
  type SealedSecret,
} from '../../src/secrets/secret-store.js';

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);
const SYNTHETIC_SECRET = 'sk-synthetic-test-value-abcdef-123456';

describe('key parsing', () => {
  it('accepts a 64-char hex key', () => {
    const parsed = parseEncryptionKey('ab'.repeat(32));
    expect(parsed?.byteLength).toBe(32);
  });

  it('accepts a base64 key of exactly 32 bytes', () => {
    expect(parseEncryptionKey(KEY_A.toString('base64'))?.byteLength).toBe(32);
  });

  it('rejects wrong-length keys and blank values', () => {
    expect(parseEncryptionKey(Buffer.alloc(16).toString('base64'))).toBeNull();
    expect(parseEncryptionKey('short')).toBeNull();
    expect(parseEncryptionKey('   ')).toBeNull();
    expect(parseEncryptionKey(undefined)).toBeNull();
    expect(parseEncryptionKey(null)).toBeNull();
  });

  it('cipherFromEnv returns null without a usable key (fail closed)', () => {
    expect(cipherFromEnv(undefined)).toBeNull();
    expect(cipherFromEnv('nope')).toBeNull();
    expect(cipherFromEnv(KEY_A.toString('base64'))).toBeInstanceOf(SecretCipher);
  });
});

describe('SecretCipher (AES-256-GCM)', () => {
  it('round-trips a secret', () => {
    const cipher = new SecretCipher(KEY_A);
    expect(cipher.open(cipher.seal(SYNTHETIC_SECRET))).toBe(SYNTHETIC_SECRET);
  });

  it('never stores the plaintext in the sealed payload', () => {
    const sealed = new SecretCipher(KEY_A).seal(SYNTHETIC_SECRET);
    const wire = JSON.stringify(sealed);
    expect(wire).not.toContain(SYNTHETIC_SECRET);
    expect(wire).not.toContain('synthetic');
    expect(sealed.alg).toBe('A256GCM');
  });

  it('uses a fresh IV per seal (identical inputs differ)', () => {
    const cipher = new SecretCipher(KEY_A);
    const first = cipher.seal(SYNTHETIC_SECRET);
    const second = cipher.seal(SYNTHETIC_SECRET);
    expect(first.ct).not.toBe(second.ct);
    expect(first.iv).not.toBe(second.iv);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => new SecretCipher(Buffer.alloc(16))).toThrow(SecretsKeyMissingError);
  });

  it('refuses to open ciphertext with a different key', () => {
    const sealed = new SecretCipher(KEY_A).seal(SYNTHETIC_SECRET);
    expect(() => new SecretCipher(KEY_B).open(sealed)).toThrow();
  });

  it('refuses an unsupported algorithm', () => {
    const sealed = {
      ...new SecretCipher(KEY_A).seal(SYNTHETIC_SECRET),
      alg: 'ROT13',
    } as unknown as SealedSecret;
    expect(() => new SecretCipher(KEY_A).open(sealed)).toThrow(SecretsKeyMissingError);
  });
});

describe('InMemorySecretStore', () => {
  it('stores, replaces, reports presence and deletes', async () => {
    const store = new InMemorySecretStore(new SecretCipher(KEY_A));
    expect(store.keyConfigured).toBe(true);

    await store.set('p1', SYNTHETIC_SECRET);
    expect(await store.get('p1')).toBe(SYNTHETIC_SECRET);
    expect(await store.has('p1')).toBe(true);

    await store.set('p1', 'replaced-value-9876543210');
    expect(await store.get('p1')).toBe('replaced-value-9876543210');

    expect(await store.delete('p1')).toBe(true);
    expect(await store.get('p1')).toBeNull();
    expect(await store.has('p1')).toBe(false);
    expect(await store.delete('p1')).toBe(false);
  });

  it('fails closed without an encryption key (no plaintext mode)', async () => {
    const store = new InMemorySecretStore(null);
    expect(store.keyConfigured).toBe(false);
    await expect(store.set('p1', SYNTHETIC_SECRET)).rejects.toThrow(SecretsKeyMissingError);
    expect(await store.get('p1')).toBeNull();
    expect(await store.has('p1')).toBe(false);
  });
});

describe('FileSecretStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'part6-secrets-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const file = (): string => path.join(dir, 'provider-secrets.enc.json');

  it('persists ciphertext only and survives a restart with the same key', async () => {
    const first = new FileSecretStore(file(), new SecretCipher(KEY_A));
    await first.set('p1', SYNTHETIC_SECRET);

    const onDisk = await readFile(file(), 'utf8');
    expect(onDisk).not.toContain(SYNTHETIC_SECRET);
    expect(onDisk).not.toContain('synthetic');

    // Simulated restart: a brand-new store instance over the same file.
    const restarted = new FileSecretStore(file(), new SecretCipher(KEY_A));
    expect(await restarted.has('p1')).toBe(true);
    expect(await restarted.get('p1')).toBe(SYNTHETIC_SECRET);
  });

  it('returns null (never garbage) when the key changed', async () => {
    const withKeyA = new FileSecretStore(file(), new SecretCipher(KEY_A));
    await withKeyA.set('p1', SYNTHETIC_SECRET);

    const rotated = new FileSecretStore(file(), new SecretCipher(KEY_B));
    expect(await rotated.has('p1')).toBe(true); // still recorded…
    expect(await rotated.get('p1')).toBeNull(); // …but unreadable: fail closed
  });

  it('refuses writes when no key is configured', async () => {
    const store = new FileSecretStore(file(), null);
    expect(store.keyConfigured).toBe(false);
    await expect(store.set('p1', SYNTHETIC_SECRET)).rejects.toThrow(SecretsKeyMissingError);
  });

  it('replaces and deletes entries without disturbing the others', async () => {
    const store = new FileSecretStore(file(), new SecretCipher(KEY_A));
    await store.set('p1', 'value-one-1111111111');
    await store.set('p2', 'value-two-2222222222');

    await store.set('p1', 'value-one-updated-9999999');
    expect(await store.get('p1')).toBe('value-one-updated-9999999');
    expect(await store.get('p2')).toBe('value-two-2222222222');

    expect(await store.delete('p1')).toBe(true);
    expect(await store.get('p1')).toBeNull();
    expect(await store.get('p2')).toBe('value-two-2222222222');
  });

  it('refuses to overwrite a corrupt store', async () => {
    const store = new FileSecretStore(file(), new SecretCipher(KEY_A));
    await store.set('p1', SYNTHETIC_SECRET);
    await writeFile(file(), '{ this is not json', 'utf8');

    const fresh = new FileSecretStore(file(), new SecretCipher(KEY_A));
    await expect(fresh.set('p2', 'another-value-333333')).rejects.toThrow(/corrupt/i);
    await expect(fresh.get('p1')).rejects.toThrow(/corrupt/i);
  });
});

describe('maskedPreview', () => {
  it('shows only a short prefix and suffix', () => {
    const preview = maskedPreview(SYNTHETIC_SECRET);
    expect(preview).toBe('sk-••••56');
    expect(preview).not.toContain('synthetic');
    expect(preview.length).toBeLessThan(SYNTHETIC_SECRET.length);
  });

  it('never returns the raw secret for short values either', () => {
    const preview = maskedPreview('ab');
    expect(preview).not.toBe('ab');
  });
});
