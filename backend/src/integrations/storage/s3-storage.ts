/**
 * S3-compatible object storage adapter (Part 9 §6).
 *
 * Implements the existing `ObjectStorage` contract against the S3 REST API
 * (AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO, Backblaze B2 — all wire
 * compatible), so call sites (the content pipeline, health reporting) do not
 * change. Part 1 shipped only the in-memory mock; this adapter is what makes
 * generated and source assets durable and independent of process lifetime.
 *
 * Design rules:
 *  - **SigV4 signing with node:crypto only** — no SDK dependency. The signing
 *    time comes from an injectable clock and the transport from an injectable
 *    interface, so every path (success, retry, failure) is deterministic in
 *    tests and no test ever opens a socket.
 *  - **Bounded everything**: ≤3 attempts, only for network errors / 5xx / 429;
 *    4xx is terminal (no retry — a wrong key or a denied policy will not fix
 *    itself); per-attempt timeout defaults to 10 s; inter-attempt sleep is
 *    injectable and capped.
 *  - **Secrets never leave this module**: the Authorization header, the secret
 *    key and the access key id never appear in messages, `info.detail`, or
 *    thrown error contexts. Upstream response bodies are never echoed.
 *  - **Endpoint is operator configuration** (`S3_ENDPOINT`, validated by env),
 *    never user input, so it does not go through the user-endpoint SSRF policy
 *    (documented in part-09-audit.md §9).
 */
import { createHash, createHmac } from 'node:crypto';
import { StorageError } from '../../core/errors.js';
import type {
  ObjectStorage,
  ProviderInfo,
  StorageObjectMeta,
  StorageUploadRequest,
} from '../../contracts/index.js';

/* -------------------------------------------------------------------------- */
/*  Configuration + transport                                                 */
/* -------------------------------------------------------------------------- */

export interface S3StorageConfig {
  /** e.g. https://s3.eu-west-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle?: boolean;
  /** Public origin (CDN/bucket website) used for `publicUrlFor` when set. */
  readonly publicBaseUrl?: string;
  /** Optional object ACL (e.g. `public-read`) sent on public uploads. */
  readonly objectAcl?: string;
}

export interface S3HttpRequest {
  readonly method: 'GET' | 'HEAD' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly timeoutMs: number;
}

export interface S3HttpResponse {
  readonly status: number;
  /** Lowercase header names. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface S3HttpTransport {
  request(request: S3HttpRequest): Promise<S3HttpResponse>;
}

export interface S3ObjectStorageOptions {
  readonly transport?: S3HttpTransport;
  /** Per-attempt timeout (default 10 000 ms). */
  readonly timeoutMs?: number;
  /** Max attempts including the first (default 3, capped at 5). */
  readonly maxAttempts?: number;
  /** Injectable delay so tests never wait in real time. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable clock so signatures/`LastModified` are deterministic in tests. */
  readonly now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_DELAY_CAP_MS = 2_000;
/** SHA-256 of the empty string — the payload hash for bodyless requests. */
const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/* -------------------------------------------------------------------------- */
/*  Default transport (global fetch, bounded by AbortSignal.timeout)          */
/* -------------------------------------------------------------------------- */

class FetchS3Transport implements S3HttpTransport {
  async request(request: S3HttpRequest): Promise<S3HttpResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      body: request.body,
      signal: AbortSignal.timeout(request.timeoutMs),
      redirect: 'error',
    });
    // Drain non-HEAD bodies so sockets are released promptly; the payload is
    // discarded on purpose — upstream bodies are never echoed into errors.
    if (request.method !== 'HEAD') {
      await response.arrayBuffer().catch(() => undefined);
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, headers };
  }
}

/* -------------------------------------------------------------------------- */
/*  SigV4                                                                     */
/* -------------------------------------------------------------------------- */

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC 3986 encoding that keeps `/` (S3 canonical URI rules). */
export function encodeS3Path(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

export interface SignInput {
  readonly method: string;
  /** Encoded canonical URI (starts with `/`). */
  readonly canonicalUri: string;
  readonly host: string;
  readonly region: string;
  readonly service: string;
  readonly amzDate: string; // 20261013T120000Z
  readonly payloadSha256: string;
  readonly extraHeaders: Readonly<Record<string, string>>; // additional headers to sign
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SignedHeaders {
  readonly headers: Record<string, string>;
  readonly signature: string;
  readonly stringToSign: string;
  readonly canonicalRequest: string;
}

/**
 * AWS Signature Version 4 for an S3 request. Exported so tests can recompute
 * the signature with an independent implementation and compare.
 */
export function signS3Request(input: SignInput): SignedHeaders {
  const dateStamp = input.amzDate.slice(0, 8);

  // Canonical headers: host + x-amz-date always; every other header must be
  // one the request actually carries (content-type, x-amz-* including
  // x-amz-content-sha256 for S3 traffic — supplied via extraHeaders). AWS
  // signs the headers that are PRESENT, which is what makes the published
  // test-suite vectors reproduce exactly.
  const headerMap: Record<string, string> = {
    host: input.host,
    'x-amz-date': input.amzDate,
  };
  for (const [key, value] of Object.entries(input.extraHeaders)) {
    const lower = key.toLowerCase();
    if (lower === 'content-type' || lower.startsWith('x-amz-')) {
      headerMap[lower] = value.trim().replace(/\s+/g, ' ');
    }
  }
  const signedNames = Object.keys(headerMap).sort();
  const canonicalHeaders = signedNames.map((name) => `${name}:${headerMap[name]}\n`).join('');
  const signedHeaders = signedNames.join(';');

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.canonicalUri,
    '', // canonical query string (no query parameters are ever used)
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    input.amzDate,
    `${dateStamp}/${input.region}/${input.service}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${dateStamp}/${input.region}/${input.service}/aws4_request, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    headers: { authorization, ...headerMap },
    signature,
    stringToSign,
    canonicalRequest,
  };
}

/* -------------------------------------------------------------------------- */
/*  Adapter                                                                   */
/* -------------------------------------------------------------------------- */

interface AttemptResult {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

export class S3ObjectStorage implements ObjectStorage {
  readonly info: ProviderInfo;

  private readonly endpoint: string;
  private readonly region: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly forcePathStyle: boolean;
  private readonly publicBaseUrl: string | null;
  private readonly objectAcl: string | undefined;
  private readonly transport: S3HttpTransport;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(config: S3StorageConfig, options: S3ObjectStorageOptions = {}) {
    const endpoint = config.endpoint?.trim().replace(/\/+$/, '');
    if (!endpoint || !config.region || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      // Key names only — the caller (env validation) already guarantees this,
      // this is defence against programmatic misuse.
      throw new StorageError(
        'S3 storage requires S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.',
        { service: 'storage', operation: 'configure', upstreamCode: 'S3_CONFIG_INCOMPLETE' },
        { retryable: false },
      );
    }
    try {
      const parsed = new URL(endpoint);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
    } catch {
      throw new StorageError(
        'S3_ENDPOINT must be an absolute http(s) URL.',
        { service: 'storage', operation: 'configure', upstreamCode: 'S3_ENDPOINT_INVALID' },
        { retryable: false },
      );
    }
    this.endpoint = endpoint;
    this.region = config.region;
    this.bucket = config.bucket;
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.forcePathStyle = config.forcePathStyle ?? false;
    this.publicBaseUrl = config.publicBaseUrl?.trim().replace(/\/+$/, '') || null;
    this.objectAcl = config.objectAcl;
    this.transport = options.transport ?? new FetchS3Transport();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = Math.min(Math.max(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1), 5);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());

    this.info = {
      name: 's3_object_storage',
      kind: 'live',
      ready: true,
      detail:
        `S3-compatible storage configured (bucket=${this.bucket}, region=${this.region}, ` +
        `style=${this.forcePathStyle ? 'path' : 'virtual-host'}, publicBase=${this.publicBaseUrl ? 'set' : 'derived'}). ` +
        'Reachability is verified on first use, never on a health request.',
    };
  }

  /* --- URL helpers ----------------------------------------------------- */

  private endpointParts(): { protocol: string; host: string } {
    const url = new URL(this.endpoint);
    return { protocol: url.protocol, host: url.host };
  }

  /** Request URL for an object (virtual-host or path style). */
  private objectUrl(key: string): { url: string; canonicalUri: string; host: string } {
    const { protocol, host } = this.endpointParts();
    const encodedKey = encodeS3Path(key.replace(/^\/+/, ''));
    if (this.forcePathStyle) {
      const canonicalUri = `/${encodeS3Path(this.bucket)}/${encodedKey}`;
      return { url: `${protocol}//${host}${canonicalUri}`, canonicalUri, host };
    }
    const vhost = `${this.bucket}.${host}`;
    const canonicalUri = `/${encodedKey}`;
    return { url: `${protocol}//${vhost}${canonicalUri}`, canonicalUri, host: vhost };
  }

  publicUrlFor(key: string): string {
    const cleanKey = key.replace(/^\/+/, '');
    const encodedKey = encodeS3Path(cleanKey);
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl}/${cleanKey}`;
    }
    const { protocol, host } = this.endpointParts();
    if (this.forcePathStyle) {
      return `${protocol}//${host}/${encodeS3Path(this.bucket)}/${encodedKey}`;
    }
    return `${protocol}//${this.bucket}.${host}/${encodedKey}`;
  }

  /* --- signing + execution --------------------------------------------- */

  /**
   * Sign a request. The `host` header is used for signing but stripped from
   * the outgoing request: the HTTP stack derives it from the URL (identical
   * value), and some fetch implementations refuse an explicitly set Host.
   */
  private sign(
    method: S3HttpRequest['method'],
    target: { canonicalUri: string; host: string },
    payloadSha256: string,
    extraHeaders: Record<string, string>,
  ): Record<string, string> {
    const amzDate = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const signed = signS3Request({
      method,
      canonicalUri: target.canonicalUri,
      host: target.host,
      region: this.region,
      service: 's3',
      amzDate,
      payloadSha256,
      // S3 requires x-amz-content-sha256 to be sent AND signed.
      extraHeaders: { ...extraHeaders, 'x-amz-content-sha256': payloadSha256 },
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
    });
    const sendable: Record<string, string> = {};
    for (const [name, value] of Object.entries(signed.headers)) {
      if (name !== 'host') sendable[name] = value;
    }
    return sendable;
  }

  private isRetryable(status: number): boolean {
    return status >= 500 || status === 429;
  }

  private async attempt(
    method: S3HttpRequest['method'],
    target: { url: string; canonicalUri: string; host: string },
    payloadSha256: string,
    extraHeaders: Record<string, string>,
    operation: string,
  ): Promise<AttemptResult> {
    let lastStatus = 0;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const headers = this.sign(method, target, payloadSha256, extraHeaders);
        const response = await this.transport.request({
          method,
          url: target.url,
          headers,
          timeoutMs: this.timeoutMs,
        });
        lastStatus = response.status;
        if (response.status >= 200 && response.status < 300) {
          return { ok: true, status: response.status, headers: response.headers };
        }
        if (!this.isRetryable(response.status)) {
          // Terminal (4xx): retrying a denied policy or a missing key only
          // wastes time. Status only — no upstream body, ever.
          throw this.httpError(operation, response.status, attempt, false);
        }
      } catch (error) {
        if (error instanceof StorageError) {
          if (!error.retryable) throw error;
          lastError = error;
        } else {
          // Network failure / timeout / abort.
          lastError = error;
        }
      }
      if (attempt < this.maxAttempts) {
        const delay = Math.min(RETRY_BASE_DELAY_MS * attempt, RETRY_DELAY_CAP_MS);
        await this.sleep(delay);
      }
    }
    if (lastError instanceof StorageError && lastStatus === 0) {
      throw lastError;
    }
    throw this.httpError(operation, lastStatus, this.maxAttempts, true, lastError);
  }

  private httpError(
    operation: string,
    status: number,
    attempts: number,
    retryable: boolean,
    cause?: unknown,
  ): StorageError {
    const code = status === 0 ? 'NETWORK_ERROR' : `HTTP_${status}`;
    return new StorageError(
      status === 0
        ? `S3 ${operation} failed: network error after ${attempts} attempt(s).`
        : `S3 ${operation} failed with HTTP ${status} after ${attempts} attempt(s).`,
      {
        service: 'storage',
        operation,
        upstreamStatus: status === 0 ? undefined : status,
        upstreamCode: code,
      },
      { retryable, cause },
    );
  }

  /* --- contract --------------------------------------------------------- */

  async upload(request: StorageUploadRequest): Promise<StorageObjectMeta> {
    if (!request.contentType || request.contentType.trim() === '') {
      throw new StorageError(
        'contentType is required for upload',
        { service: 'storage', operation: 'upload', upstreamStatus: 400, upstreamCode: 'MISSING_CONTENT_TYPE' },
        { retryable: false },
      );
    }
    const key = request.key.replace(/^\/+/, '');
    const target = this.objectUrl(key);
    const payloadSha256 = sha256Hex(request.bytes);

    const extraHeaders: Record<string, string> = { 'content-type': request.contentType };
    if (request.publicRead && this.objectAcl) {
      extraHeaders['x-amz-acl'] = this.objectAcl;
    }
    for (const [name, value] of Object.entries(request.metadata ?? {})) {
      const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      if (safeName) extraHeaders[`x-amz-meta-${safeName}`] = encodeURIComponent(value);
    }

    const result = await this.attempt('PUT', target, payloadSha256, extraHeaders, 'upload');
    return {
      key,
      sizeBytes: request.bytes.byteLength,
      contentType: request.contentType,
      etag: result.headers['etag'] ?? null,
      lastModified: this.now().toISOString(),
      publicUrl: this.publicUrlFor(key),
    };
  }

  async head(key: string): Promise<StorageObjectMeta | null> {
    const cleanKey = key.replace(/^\/+/, '');
    const target = this.objectUrl(cleanKey);
    let result: AttemptResult;
    try {
      result = await this.attempt('HEAD', target, EMPTY_PAYLOAD_SHA256, {}, 'head');
    } catch (error) {
      if (
        error instanceof StorageError &&
        error.context.upstreamStatus === 404
      ) {
        return null; // Missing asset is a normal, non-exceptional answer.
      }
      throw error;
    }
    const length = Number(result.headers['content-length'] ?? 0);
    return {
      key: cleanKey,
      sizeBytes: Number.isFinite(length) ? length : 0,
      contentType: result.headers['content-type'] ?? 'application/octet-stream',
      etag: result.headers['etag'] ?? null,
      lastModified: result.headers['last-modified'] ?? null,
      publicUrl: this.publicUrlFor(cleanKey),
    };
  }

  async verifyPublicAccess(key: string): Promise<boolean> {
    const url = this.publicUrlFor(key.replace(/^\/+/, ''));
    try {
      const response = await this.transport.request({
        method: 'HEAD',
        url,
        headers: { 'user-agent': 'autopilot-storage-verify/1.0' },
        timeoutMs: this.timeoutMs,
      });
      if (response.status >= 200 && response.status < 300) return true;
      // Definitive answers only: the object is missing or the policy denies
      // anonymous reads. 5xx/network problems are NOT "inaccessible" — they
      // are transient, so they surface as a retryable storage error instead.
      if (response.status === 403 || response.status === 404) return false;
      throw this.httpError('verifyPublicAccess', response.status, 1, this.isRetryable(response.status));
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw this.httpError('verifyPublicAccess', 0, 1, true, error);
    }
  }

  async delete(key: string): Promise<void> {
    const cleanKey = key.replace(/^\/+/, '');
    const target = this.objectUrl(cleanKey);
    try {
      await this.attempt('DELETE', target, EMPTY_PAYLOAD_SHA256, {}, 'delete');
    } catch (error) {
      // Deleting an object that is already gone is success (idempotent).
      if (error instanceof StorageError && error.context.upstreamStatus === 404) return;
      throw error;
    }
  }
}
