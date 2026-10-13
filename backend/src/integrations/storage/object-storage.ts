/**
 * S3-compatible object storage contract + deterministic in-memory mock.
 *
 * Part 1 shipped the `ObjectStorage` interface and an in-memory implementation;
 * PART 9 §6 adds the live `S3ObjectStorage` adapter (AWS S3 / Cloudflare R2 /
 * DigitalOcean Spaces / MinIO — wire-compatible) in `s3-storage.ts`. This
 * module keeps the shared contract, the free mock, and the factory that picks
 * between them from validated configuration.
 *
 * The mock records every operation so tests can assert upload success, upload
 * failure, metadata retrieval, accessibility verification, and deletion.
 */
import { StorageError } from '../../core/errors.js';
import type {
  ObjectStorage,
  ProviderInfo,
  StorageObjectMeta,
  StorageUploadRequest,
} from '../../contracts/index.js';
import { S3ObjectStorage, type S3ObjectStorageOptions } from './s3-storage.js';

export interface MemoryObjectStorageOptions {
  readonly publicBaseUrl?: string;
  /**
   * When set, any key containing this substring simulates an upstream failure.
   * Used by contract tests to exercise the failure path deterministically.
   */
  readonly failKeySubstring?: string;
  /** Simulate the upload succeeding but the object being unreachable publicly. */
  readonly denyPublicAccessKeySubstring?: string;
}

export class MemoryObjectStorage implements ObjectStorage {
  readonly info: ProviderInfo;

  private readonly objects = new Map<string, StorageObjectMeta & { bytes: Uint8Array; publicRead: boolean }>();
  private readonly publicBaseUrl: string;
  private readonly failKeySubstring: string | undefined;
  private readonly denyPublicAccessKeySubstring: string | undefined;

  /** Operation log for assertions. Contains keys only — never bytes or secrets. */
  readonly operationLog: { op: string; key: string }[] = [];

  constructor(options: MemoryObjectStorageOptions = {}) {
    this.publicBaseUrl = (options.publicBaseUrl ?? 'https://storage.mock.local').replace(/\/+$/, '');
    this.failKeySubstring = options.failKeySubstring;
    this.denyPublicAccessKeySubstring = options.denyPublicAccessKeySubstring;
    this.info = {
      name: 'memory_object_storage',
      kind: 'mock',
      ready: true,
      detail: 'In-memory S3-compatible mock. No network, no cost.',
    };
  }

  async upload(request: StorageUploadRequest): Promise<StorageObjectMeta> {
    this.operationLog.push({ op: 'upload', key: request.key });

    if (this.failKeySubstring && request.key.includes(this.failKeySubstring)) {
      throw new StorageError(
        `Simulated storage upload failure for key "${request.key}"`,
        { service: 'storage', operation: 'upload', upstreamStatus: 500, upstreamCode: 'SIMULATED_FAILURE' },
        { retryable: false },
      );
    }

    if (!request.contentType || request.contentType.trim() === '') {
      throw new StorageError(
        'contentType is required for upload',
        { service: 'storage', operation: 'upload', upstreamStatus: 400, upstreamCode: 'MISSING_CONTENT_TYPE' },
        { retryable: false },
      );
    }

    const meta: StorageObjectMeta & { bytes: Uint8Array; publicRead: boolean } = {
      key: request.key,
      sizeBytes: request.bytes.byteLength,
      contentType: request.contentType,
      etag: mockEtag(request.bytes),
      lastModified: new Date().toISOString(),
      publicUrl: `${this.publicBaseUrl}/${request.key}`,
      bytes: request.bytes,
      publicRead: request.publicRead,
    };
    this.objects.set(request.key, meta);

    return this.toPublicMeta(meta);
  }

  async head(key: string): Promise<StorageObjectMeta | null> {
    this.operationLog.push({ op: 'head', key });
    const found = this.objects.get(key);
    return found ? this.toPublicMeta(found) : null;
  }

  async verifyPublicAccess(key: string): Promise<boolean> {
    this.operationLog.push({ op: 'verifyPublicAccess', key });
    const found = this.objects.get(key);
    if (!found) {
      return false;
    }
    if (this.denyPublicAccessKeySubstring && key.includes(this.denyPublicAccessKeySubstring)) {
      return false;
    }
    return found.publicRead;
  }

  async delete(key: string): Promise<void> {
    this.operationLog.push({ op: 'delete', key });
    this.objects.delete(key);
  }

  publicUrlFor(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }

  /** Test helper: number of stored objects. */
  get size(): number {
    return this.objects.size;
  }

  private toPublicMeta(meta: StorageObjectMeta & { bytes: Uint8Array; publicRead: boolean }): StorageObjectMeta {
    return {
      key: meta.key,
      sizeBytes: meta.sizeBytes,
      contentType: meta.contentType,
      etag: meta.etag,
      lastModified: meta.lastModified,
      publicUrl: meta.publicUrl,
    };
  }
}

/** Stable, deterministic pseudo-ETag derived from content length + FNV-1a hash. */
function mockEtag(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  const step = Math.max(1, Math.floor(bytes.byteLength / 4096));
  for (let i = 0; i < bytes.byteLength; i += step) {
    const byte = bytes[i];
    if (byte !== undefined) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `"${bytes.byteLength.toString(16)}-${hash.toString(16).padStart(8, '0')}"`;
}

/* -------------------------------------------------------------------------- */
/*  Factory                                                                   */
/* -------------------------------------------------------------------------- */

export interface StorageConfig {
  readonly endpoint?: string;
  readonly region?: string;
  readonly bucket?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly forcePathStyle?: boolean;
  readonly publicBaseUrl?: string;
  /** PART 9 §6: optional object ACL for stores that still support ACLs. */
  readonly objectAcl?: string;
}

/**
 * Resolve the storage implementation from validated config (Part 9 §6).
 *
 *  - Complete S3 credential set  → the LIVE `S3ObjectStorage` adapter
 *    (SigV4, bounded retries, secret-free errors).
 *  - No credential set          → the in-memory mock, so development and
 *    tests stay free and offline.
 *  - A PARTIAL credential set is impossible: `env.ts` rejects it at startup.
 *
 * Production additionally requires the S3 set, so a production process can
 * never silently fall back to process-memory assets.
 */
export function createObjectStorage(config: StorageConfig, options?: S3ObjectStorageOptions): ObjectStorage {
  const hasS3Creds = Boolean(
    config.endpoint && config.region && config.bucket && config.accessKeyId && config.secretAccessKey,
  );
  if (hasS3Creds) {
    return new S3ObjectStorage(
      {
        endpoint: config.endpoint as string,
        region: config.region as string,
        bucket: config.bucket as string,
        accessKeyId: config.accessKeyId as string,
        secretAccessKey: config.secretAccessKey as string,
        forcePathStyle: config.forcePathStyle,
        publicBaseUrl: config.publicBaseUrl,
        objectAcl: config.objectAcl,
      },
      options,
    );
  }
  return new MemoryObjectStorage({ publicBaseUrl: config.publicBaseUrl });
}
