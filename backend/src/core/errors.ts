/**
 * Typed application error hierarchy.
 *
 * Every error carries:
 *  - a stable, machine-readable `code` for API responses and evidence logs,
 *  - an HTTP status (or `null` when the error is not HTTP-facing),
 *  - an `expose` flag controlling whether `message` is safe to return to the APK,
 *  - an optional `retryable` hint consumed by the job runner,
 *  - an optional structured `context` that is redacted before logging.
 *
 * Adapter-specific failures (Facebook, Threads, Telegram, AI, S3) extend the
 * base class so callers can switch on `instanceof` without string matching.
 */

export type ErrorCategory =
  | 'validation'
  | 'auth'
  | 'not_found'
  | 'conflict'
  | 'rate_limit'
  | 'upstream'
  | 'configuration'
  | 'internal';

export interface AppErrorOptions {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly httpStatus?: number;
  /** Whether `message` may be returned verbatim to an API client. Default false. */
  readonly expose?: boolean;
  /** Whether the operation is safe to retry with identical inputs. Default false. */
  readonly retryable?: boolean;
  readonly cause?: unknown;
  readonly context?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly httpStatus: number;
  readonly expose: boolean;
  readonly retryable: boolean;
  readonly context: Record<string, unknown>;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code;
    this.category = options.category;
    this.httpStatus = options.httpStatus ?? defaultStatusForCategory(options.category);
    this.expose = options.expose ?? false;
    this.retryable = options.retryable ?? false;
    this.context = options.context ?? {};
    Error.captureStackTrace?.(this, new.target);
  }

  /** Structured, log-safe representation. Does NOT include raw secrets. */
  toLogObject(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
      message: this.message,
      context: this.context,
      cause:
        this.cause instanceof Error
          ? { name: this.cause.name, message: this.cause.message }
          : this.cause,
    };
  }
}

function defaultStatusForCategory(category: ErrorCategory): number {
  switch (category) {
    case 'validation':
      return 400;
    case 'auth':
      return 401;
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'rate_limit':
      return 429;
    case 'upstream':
      return 502;
    case 'configuration':
      return 503;
    case 'internal':
    default:
      return 500;
  }
}

/** Generic helper for constructing errors without a more specific subclass. */
export class DomainError extends AppError {
  constructor(options: AppErrorOptions) {
    super(options);
  }
}

/* -------------------------------------------------------------------------- */
/*  Validation / environment                                                  */
/* -------------------------------------------------------------------------- */

export class EnvironmentError extends AppError {
  readonly missingKeys: readonly string[];

  constructor(missingKeys: readonly string[], detail?: string) {
    super({
      code: 'ENV_INVALID',
      category: 'configuration',
      message: `Invalid environment configuration. Missing/invalid: ${missingKeys.join(', ')}${detail ? ` — ${detail}` : ''}`,
      expose: true,
      retryable: false,
      context: { missingKeys },
    });
    this.missingKeys = missingKeys;
  }
}

export class ContractViolationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super({
      code: 'CONTRACT_VIOLATION',
      category: 'validation',
      message,
      expose: true,
      retryable: false,
      context,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Authentication / authorization                                            */
/* -------------------------------------------------------------------------- */

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required', context?: Record<string, unknown>) {
    super({
      code: 'UNAUTHENTICATED',
      category: 'auth',
      message,
      httpStatus: 401,
      expose: true,
      retryable: false,
      context,
    });
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Insufficient permissions', context?: Record<string, unknown>) {
    super({
      code: 'FORBIDDEN',
      category: 'auth',
      message,
      httpStatus: 403,
      expose: true,
      retryable: false,
      context,
    });
  }
}

export class TokenExpiredError extends AuthenticationError {
  constructor(context?: Record<string, unknown>) {
    super('Access token expired', context);
  }
}

/* -------------------------------------------------------------------------- */
/*  Upstream integration errors                                               */
/* -------------------------------------------------------------------------- */

export interface UpstreamErrorContext extends Record<string, unknown> {
  service: string;
  operation?: string;
  upstreamStatus?: number;
  upstreamCode?: string | number;
}

/** Base class for all third-party (Shopee / Meta / Telegram / AI / S3) failures. */
export class UpstreamServiceError extends AppError {
  constructor(
    options: Omit<AppErrorOptions, 'category'> & { readonly context: UpstreamErrorContext },
  ) {
    super({ ...options, category: 'upstream' });
  }
}

export class IntegrationNotConfiguredError extends UpstreamServiceError {
  constructor(service: string, operation?: string) {
    super({
      code: 'INTEGRATION_NOT_CONFIGURED',
      message: `Integration "${service}" is not configured. ${operation ? `Operation "${operation}"` : 'All operations'} disabled until valid credentials are supplied.`,
      expose: true,
      retryable: false,
      context: { service, operation },
    });
  }
}

export class FacebookPublishError extends UpstreamServiceError {
  constructor(
    message: string,
    context: UpstreamErrorContext,
    options?: { readonly retryable?: boolean; readonly cause?: unknown },
  ) {
    super({
      code: 'FACEBOOK_PUBLISH_FAILED',
      message,
      expose: false,
      retryable: options?.retryable ?? false,
      cause: options?.cause,
      context,
    });
  }
}

export class ThreadsPublishError extends UpstreamServiceError {
  constructor(
    message: string,
    context: UpstreamErrorContext,
    options?: { readonly retryable?: boolean; readonly cause?: unknown },
  ) {
    super({
      code: 'THREADS_PUBLISH_FAILED',
      message,
      expose: false,
      retryable: options?.retryable ?? false,
      cause: options?.cause,
      context,
    });
  }
}

export class TelegramNotificationError extends UpstreamServiceError {
  constructor(
    message: string,
    context: UpstreamErrorContext,
    options?: { readonly retryable?: boolean; readonly cause?: unknown },
  ) {
    super({
      code: 'TELEGRAM_NOTIFICATION_FAILED',
      message,
      expose: false,
      retryable: options?.retryable ?? true,
      cause: options?.cause,
      context,
    });
  }
}

export class ShopeeFeedError extends UpstreamServiceError {
  constructor(
    message: string,
    context: UpstreamErrorContext,
    options?: { readonly retryable?: boolean; readonly cause?: unknown },
  ) {
    super({
      code: 'SHOPEE_FEED_FAILED',
      message,
      expose: false,
      retryable: options?.retryable ?? false,
      cause: options?.cause,
      context,
    });
  }
}

export class AiProviderError extends UpstreamServiceError {
  constructor(
    message: string,
    context: UpstreamErrorContext,
    options?: { readonly retryable?: boolean; readonly cause?: unknown },
  ) {
    super({
      code: 'AI_PROVIDER_FAILED',
      message,
      expose: false,
      retryable: options?.retryable ?? true,
      cause: options?.cause,
      context,
    });
  }
}

export class StorageError extends UpstreamServiceError {
  constructor(
    message: string,
    context: UpstreamErrorContext,
    options?: { readonly retryable?: boolean; readonly cause?: unknown },
  ) {
    super({
      code: 'STORAGE_FAILED',
      message,
      expose: false,
      retryable: options?.retryable ?? true,
      cause: options?.cause,
      context,
    });
  }
}

export class RateLimitError extends UpstreamServiceError {
  readonly retryAfterMs: number | undefined;

  constructor(context: UpstreamErrorContext, retryAfterMs?: number) {
    super({
      code: 'UPSTREAM_RATE_LIMITED',
      message: `Upstream rate limit reached for ${context.service}${context.operation ? ` (${context.operation})` : ''}.`,
      expose: false,
      retryable: true,
      context: { ...context, retryAfterMs },
    });
    this.retryAfterMs = retryAfterMs;
  }
}

/* -------------------------------------------------------------------------- */
/*  Content validation (publish-gate)                                         */
/* -------------------------------------------------------------------------- */

export interface ValidationIssue {
  readonly rule: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
}

/**
 * Raised when generated content fails one or more publish-gate rules.
 * Publication MUST NOT proceed when this error is thrown.
 */
export class ContentValidationError extends AppError {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const errors = issues.filter((i) => i.severity === 'error');
    super({
      code: 'CONTENT_VALIDATION_FAILED',
      category: 'validation',
      message: `Content failed ${errors.length} validation rule(s); publication blocked.`,
      httpStatus: 422,
      expose: true,
      retryable: false,
      context: { issueCount: issues.length, errorCount: errors.length },
    });
    this.issues = issues;
  }
}

/** Thrown by publisher adapters when live credentials are absent (safety latch). */
export class LivePublishBlockedError extends AppError {
  constructor(service: string, reason: string) {
    super({
      code: 'LIVE_PUBLISH_BLOCKED',
      category: 'configuration',
      message: `Live publication to ${service} is blocked: ${reason}`,
      expose: true,
      retryable: false,
      context: { service, reason },
    });
  }
}

/**
 * Thrown when a worker tries to commit the result of a job it no longer owns
 * (its lease expired and another worker took over).
 *
 * PART 5: this is the "stale worker must not overwrite newer results" guard.
 * It is NOT retryable by the caller — the job belongs to the new owner now, so
 * the correct response is to log it and walk away, never to force the write.
 */
export class StaleClaimError extends AppError {
  constructor(jobId: string, reason: string) {
    super({
      code: 'STALE_JOB_CLAIM',
      category: 'conflict',
      message: `Job ${jobId} was not updated: ${reason}`,
      expose: false,
      retryable: false,
      context: { jobId, reason },
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Narrowing helpers                                                         */
/* -------------------------------------------------------------------------- */

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Extract a stable code from any thrown value, for logging and mapping. */
export function errorCodeOf(error: unknown): string {
  if (isAppError(error)) {
    return error.code;
  }
  if (error instanceof Error) {
    return 'UNEXPECTED_ERROR';
  }
  return 'UNKNOWN_ERROR';
}
