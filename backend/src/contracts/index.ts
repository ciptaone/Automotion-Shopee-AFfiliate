/**
 * Provider-agnostic integration contracts (Part 1).
 *
 * These are the ONLY surfaces the rest of the backend may depend on. Concrete
 * adapters (live HTTP clients or deterministic mocks) implement them. Nothing
 * outside `src/integrations/**` should reference a concrete vendor SDK.
 *
 * Every contract returns typed results — never raw `any` — so that provider
 * swaps (e.g. OpenAI -> Google for images) cannot silently change call sites.
 */

/* -------------------------------------------------------------------------- */
/*  Shared primitives                                                         */
/* -------------------------------------------------------------------------- */

/** Identifies the concrete implementation behind a contract, for health/logs. */
export type ProviderKind = 'mock' | 'live';

export interface ProviderInfo {
  readonly name: string;
  readonly kind: ProviderKind;
  readonly model?: string;
  /** Non-secret, human-readable readiness note. */
  readonly ready: boolean;
  readonly detail: string;
}

/* -------------------------------------------------------------------------- */
/*  Product feed                                                              */
/* -------------------------------------------------------------------------- */

/** Normalized product record. Field names are canonical, not vendor-specific. */
export interface FeedProduct {
  /** Stable identifier derived from the feed (item id / seller+item composite). */
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  /** Canonical product URL on the marketplace. */
  readonly productUrl: string;
  /** User-provided affiliate/deeplink URL. Falls back to productUrl when absent. */
  readonly affiliateUrl: string;
  readonly price: number | null;
  readonly currency: string | null;
  readonly commissionRate: number | null;
  readonly imageUrl: string | null;
  readonly category: string | null;
  readonly rating: number | null;
  readonly soldCount: number | null;
  /** Raw source row, retained for traceability. Redacted before logging. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface FeedParseRequest {
  readonly filename: string;
  /** Raw bytes of the uploaded CSV or XLSX file. */
  readonly content: Uint8Array;
  /** Optional explicit format hint; otherwise inferred from extension/content. */
  readonly format?: 'csv' | 'xlsx';
  /** Optional marketplace override applied when the feed lacks a marketplace column. */
  readonly defaultMarketplace?: string;
}

export interface FeedParseSummary {
  readonly totalRows: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly duplicatesRemoved: number;
  readonly format: 'csv' | 'xlsx';
  /** Per-row rejection reasons, capped for log safety. */
  readonly issues: readonly FeedRowIssue[];
}

export interface FeedRowIssue {
  readonly rowNumber: number;
  readonly reason: string;
  readonly field?: string;
}

export interface FeedParseResult {
  readonly products: readonly FeedProduct[];
  readonly summary: FeedParseSummary;
}

export interface ProductFeedImporter {
  readonly info: ProviderInfo;
  parse(request: FeedParseRequest): Promise<FeedParseResult>;
}

/* -------------------------------------------------------------------------- */
/*  AI — image generation                                                     */
/* -------------------------------------------------------------------------- */

export interface ImageGenerationRequest {
  /** Deterministic seed for reproducibility where the provider supports it. */
  readonly seed: number;
  readonly prompt: string;
  /** Negative prompt / avoid-list. Provider may ignore if unsupported. */
  readonly negativePrompt?: string;
  readonly width: number;
  readonly height: number;
  /** Public URL(s) of the real product reference image(s) for fidelity. */
  readonly referenceImageUrls: readonly string[];
  readonly model?: string;
  /** Hard cap on generation latency; providers should fail fast past this. */
  readonly timeoutMs?: number;
}

export interface GeneratedImage {
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/jpeg' | 'image/png';
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  readonly model: string;
  /** Provider-reported cost estimate in USD, when available. */
  readonly estimatedCostUsd: number | null;
}

export interface ImageGenerator {
  readonly info: ProviderInfo;
  generate(request: ImageGenerationRequest): Promise<GeneratedImage>;
}

/* -------------------------------------------------------------------------- */
/*  AI — caption / text generation                                            */
/* -------------------------------------------------------------------------- */

export interface CaptionGenerationRequest {
  readonly product: FeedProduct;
  /** Required CTA destination — the affiliate link that must appear verbatim. */
  readonly affiliateUrl: string;
  readonly language: 'id';
  readonly tone: 'soft_sell';
  readonly model?: string;
  readonly seed?: number;
  readonly timeoutMs?: number;
}

export interface GeneratedCaption {
  readonly hook: string;
  readonly body: string;
  readonly cta: string;
  readonly hashtags: readonly string[];
  /** The full caption as it should be published (hook+body+cta+hashtags). */
  readonly fullText: string;
  /** The affiliate link the generator claims to have embedded. */
  readonly embeddedUrl: string;
  readonly model: string;
  readonly estimatedCostUsd: number | null;
}

export interface CaptionGenerator {
  readonly info: ProviderInfo;
  generate(request: CaptionGenerationRequest): Promise<GeneratedCaption>;
}

/* -------------------------------------------------------------------------- */
/*  Object storage (S3-compatible)                                            */
/* -------------------------------------------------------------------------- */

export interface StorageObjectMeta {
  readonly key: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  /** Publicly reachable URL used by Facebook/Threads to cURL the asset. */
  readonly publicUrl: string;
}

export interface StorageUploadRequest {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** When true, the object must be readable without credentials. */
  readonly publicRead: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ObjectStorage {
  readonly info: ProviderInfo;
  upload(request: StorageUploadRequest): Promise<StorageObjectMeta>;
  /** Fetch metadata without downloading the object body. */
  head(key: string): Promise<StorageObjectMeta | null>;
  /** Verify the object is reachable over its public URL (accessibility check). */
  verifyPublicAccess(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Build the public URL for a key without performing any network call. */
  publicUrlFor(key: string): string;
}

/* -------------------------------------------------------------------------- */
/*  Publishing — Facebook Page & Threads                                      */
/* -------------------------------------------------------------------------- */

/** What a publisher is about to post. Both publishers receive identical input. */
export interface PublishRequest {
  /** Idempotency key — adapters MUST refuse to double-post the same job. */
  readonly idempotencyKey: string;
  readonly caption: string;
  /** Publicly cURL-able image URL. Both FB and Threads require a public URL. */
  readonly imageUrl: string;
  /** Optional destination link (the affiliate link) for link preview. */
  readonly link?: string;
  /** When true the adapter MUST NOT hit the network; returns a synthetic result. */
  readonly dryRun: boolean;
}

export interface PublishResult {
  readonly success: boolean;
  readonly provider: 'facebook_page' | 'threads';
  readonly postId: string | null;
  readonly permalink: string | null;
  /** Provider-returned status; for Threads this is the media id. */
  readonly providerStatus: string | null;
  readonly dryRun: boolean;
  readonly publishedAt: string;
}

export interface PublishingQuota {
  readonly used: number;
  readonly total: number;
  readonly windowSeconds: number;
}

export interface Publisher {
  readonly provider: 'facebook_page' | 'threads';
  readonly info: ProviderInfo;
  publish(request: PublishRequest): Promise<PublishResult>;
  /** Current publishing quota usage, when the provider exposes it. */
  getQuota(): Promise<PublishingQuota | null>;
}

/* -------------------------------------------------------------------------- */
/*  Notifications — Telegram                                                  */
/* -------------------------------------------------------------------------- */

export type NotificationKind =
  | 'publish_success'
  | 'publish_partial_success'
  | 'publish_failure'
  | 'feed_import'
  | 'health_alert';

export interface NotificationRequest {
  readonly kind: NotificationKind;
  /** Stable key used for duplicate suppression. Same key => delivered once. */
  readonly dedupeKey: string;
  readonly title: string;
  readonly lines: readonly string[];
  /** Links surfaced as inline buttons when the transport supports it. */
  readonly links?: readonly { readonly label: string; readonly url: string }[];
  /** Error detail (already redacted) for failure notifications. */
  readonly errorDetail?: string;
}

export interface NotificationResult {
  readonly delivered: boolean;
  readonly deduped: boolean;
  readonly messageId: string | null;
  readonly transport: 'telegram' | 'mock';
}

export interface Notifier {
  readonly info: ProviderInfo;
  send(request: NotificationRequest): Promise<NotificationResult>;
}

/* -------------------------------------------------------------------------- */
/*  Scheduling & jobs                                                         */
/* -------------------------------------------------------------------------- */

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobRecord {
  readonly id: string;
  readonly kind: string;
  readonly status: JobStatus;
  /** Uniqueness scope: prevents two jobs for the same slot/product. */
  readonly uniqueKey: string;
  readonly scheduledFor: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnqueueJobInput {
  readonly kind: string;
  readonly uniqueKey: string;
  readonly scheduledFor: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly maxAttempts?: number;
}

/**
 * Durable job queue contract. The Postgres-backed implementation is used in
 * production; an in-memory implementation satisfies tests and DB-less dev.
 *
 * Uniqueness contract: enqueueing a job whose `uniqueKey` already exists in a
 * non-terminal state MUST be a no-op returning the existing job.
 */
export interface JobQueue {
  enqueue(input: EnqueueJobInput): Promise<JobRecord>;
  /** Atomically claim the next due job. Returns null when nothing is due. */
  claim(workerId: string): Promise<JobRecord | null>;
  complete(jobId: string, result?: Readonly<Record<string, unknown>>): Promise<void>;
  fail(jobId: string, error: string, retryable: boolean): Promise<JobRecord>;
  get(jobId: string): Promise<JobRecord | null>;
  getByUniqueKey(uniqueKey: string): Promise<JobRecord | null>;
  list(limit?: number): Promise<readonly JobRecord[]>;
}
