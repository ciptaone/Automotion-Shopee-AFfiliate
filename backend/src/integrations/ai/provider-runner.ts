/**
 * Resilient, provider-neutral AI adapter layer (Part 4).
 *
 * WHY THIS EXISTS
 * ---------------
 * The contracts in `src/contracts/index.ts` describe WHAT generation is. This
 * module adds the operational discipline every live provider needs, without
 * leaking any vendor detail into call sites:
 *
 *  - TIMEOUTS:    every call races a hard timeout; past it the call fails with
 *                 a typed, retryable `AI_TIMEOUT` error and (where the
 *                 underlying contract supports it) an AbortSignal is aborted.
 *  - RETRIES:     transient failures are retried with exponential backoff,
 *                 strictly BOUNDED by `maxAttempts` (no infinite loops).
 *  - RATE LIMITS: a `RateLimitError` from a provider is honored — the retry
 *                 waits the provider's `retryAfterMs` when given, otherwise a
 *                 capped backoff. Rate-limited calls never spin.
 *  - USAGE/COST:  provider-reported `estimatedCostUsd` and call latency are
 *                 aggregated per wrapped provider (null when unreported).
 *  - REDACTION:   errors are logged through the existing redacting logger; no
 *                 prompt, credential or response body is ever logged raw.
 *  - MOCK/LIVE:   the wrapped provider's own `info.kind` is preserved and
 *                 surfaced, so the pipeline can never mislabel mock output as
 *                 live (or vice versa).
 *
 * DETERMINISTIC OFFLINE TESTS: the wrappers accept injectable `sleep`, `now`
 * and a fake clock, so retry/timeout behaviour is fully testable with the
 * existing mocks and zero network access. No paid API call is ever made here.
 *
 * HONESTY CONTRACT: this layer does not make an unsupported provider "work".
 * If a live adapter is not implemented (see `unavailable-provider.ts`), calls
 * fail fast with an explicit reason; nothing here pretends otherwise.
 */
import {
  AiProviderError,
  RateLimitError,
  isAppError,
} from '../../core/errors.js';
import { redactString } from '../../core/redact.js';
import type {
  CaptionGenerationRequest,
  CaptionGenerator,
  GeneratedCaption,
  GeneratedImage,
  ImageGenerationRequest,
  ImageGenerator,
  ProviderInfo,
} from '../../contracts/index.js';

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

export interface RetryPolicy {
  /** Total attempts INCLUDING the first one. Bounded; never infinite. */
  readonly maxAttempts: number;
  /** First backoff step; doubles each attempt. */
  readonly baseDelayMs: number;
  /** Backoff ceiling (also used when a rate limit gives no retryAfter). */
  readonly maxDelayMs: number;
  /** Default per-call timeout when the request omits one. */
  readonly defaultTimeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  defaultTimeoutMs: 60_000,
};

export interface ProviderLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** Minimal injectable clock/sleep so tests are deterministic and offline. */
export interface RunnerRuntime {
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

const defaultRuntime: RunnerRuntime = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** A silent logger for tests / default wiring (nothing is printed). */
export const silentProviderLogger: ProviderLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/* -------------------------------------------------------------------------- */
/*  Usage accounting                                                          */
/* -------------------------------------------------------------------------- */

export interface ProviderUsage {
  readonly calls: number;
  readonly failures: number;
  readonly retries: number;
  readonly timeouts: number;
  readonly rateLimits: number;
  /** Sum of provider-reported costs; null once ANY call omits cost. */
  readonly estimatedCostUsdTotal: number | null;
  readonly lastLatencyMs: number | null;
}

/* -------------------------------------------------------------------------- */
/*  Error classification                                                      */
/* -------------------------------------------------------------------------- */

type FailureKind = 'timeout' | 'rate_limit' | 'transient' | 'permanent';

interface ClassifiedFailure {
  readonly kind: FailureKind;
  readonly retryable: boolean;
  /** Provider-supplied wait (rate limit); otherwise the backoff applies. */
  readonly retryAfterMs: number | null;
  readonly code: string;
  readonly message: string;
}

/** Redact then truncate to a single safe log line. */
function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const first = raw.split('\n')[0] ?? '';
  // Redaction happens BEFORE truncation so a secret can never survive by
  // being split across the cut, and so callers never see it either.
  return redactString(first).slice(0, 200);
}

function classify(error: unknown): ClassifiedFailure {
  if (error instanceof RateLimitError) {
    return {
      kind: 'rate_limit',
      retryable: true,
      retryAfterMs: typeof error.retryAfterMs === 'number' ? error.retryAfterMs : null,
      code: 'AI_RATE_LIMITED',
      message: safeMessage(error),
    };
  }
  if (error instanceof AiProviderError) {
    const code = String(error.context.upstreamCode ?? 'AI_PROVIDER_FAILED');
    if (code === 'AI_TIMEOUT') {
      return { kind: 'timeout', retryable: true, retryAfterMs: null, code, message: safeMessage(error) };
    }
    return {
      kind: error.retryable ? 'transient' : 'permanent',
      retryable: error.retryable,
      retryAfterMs: null,
      code,
      message: safeMessage(error),
    };
  }
  if (isAppError(error)) {
    // Unknown AppError: treat `retryable` as authoritative.
    return {
      kind: error.retryable ? 'transient' : 'permanent',
      retryable: error.retryable,
      retryAfterMs: null,
      code: error.code,
      message: safeMessage(error),
    };
  }
  // Bare/unknown throw: assume transient (bounded retries cap the blast radius).
  return { kind: 'transient', retryable: true, retryAfterMs: null, code: 'AI_UNKNOWN_ERROR', message: safeMessage(error) };
}

/* -------------------------------------------------------------------------- */
/*  Core execution engine                                                     */
/* -------------------------------------------------------------------------- */

interface ExecuteOptions<T> {
  readonly provider: ProviderInfo;
  readonly operation: string;
  readonly timeoutMs: number | undefined;
  readonly policy: RetryPolicy;
  readonly logger: ProviderLogger;
  readonly runtime: RunnerRuntime;
  readonly usage: MutableUsage;
  /** Runs one attempt. Receives a signal aborted on timeout (best-effort). */
  readonly attempt: (signal: AbortSignal) => Promise<T>;
  /** Extracts the provider-reported cost (null when unreported). */
  readonly costOf: (result: T) => number | null;
}

interface MutableUsage {
  calls: number;
  failures: number;
  retries: number;
  timeouts: number;
  rateLimits: number;
  costTotal: number | null;
  lastLatencyMs: number | null;
}

function newUsage(): MutableUsage {
  return {
    calls: 0,
    failures: 0,
    retries: 0,
    timeouts: 0,
    rateLimits: 0,
    costTotal: 0,
    lastLatencyMs: null,
  };
}

function freezeUsage(u: MutableUsage): ProviderUsage {
  return {
    calls: u.calls,
    failures: u.failures,
    retries: u.retries,
    timeouts: u.timeouts,
    rateLimits: u.rateLimits,
    estimatedCostUsdTotal: u.costTotal,
    lastLatencyMs: u.lastLatencyMs,
  };
}

function backoffFor(policy: RetryPolicy, attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) {
    // Honor the provider's explicit wait, but clamp to a sane ceiling so a
    // malicious/erroneous huge value cannot wedge the worker.
    return Math.min(Math.max(retryAfterMs, 0), policy.maxDelayMs);
  }
  const exp = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exp, policy.maxDelayMs);
}

async function execute<T>(options: ExecuteOptions<T>): Promise<T> {
  const { policy, logger, runtime, usage, provider, operation } = options;
  const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts));
  let lastFailure: ClassifiedFailure | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const startedAt = runtime.now();
    usage.calls += 1;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutMs = options.timeoutMs ?? policy.defaultTimeoutMs;
    const timedOut = new AiProviderError(
      `${provider.name} ${operation} timed out after ${timeoutMs}ms.`,
      { service: provider.name, operation, upstreamCode: 'AI_TIMEOUT' },
      { retryable: true },
    );
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timedOut);
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        options.attempt(controller.signal),
        timeoutPromise,
      ]);
      usage.lastLatencyMs = runtime.now() - startedAt;
      const cost = options.costOf(result);
      if (cost === null) {
        usage.costTotal = null; // honest: unknown cost makes the total unknown
      } else if (usage.costTotal !== null) {
        usage.costTotal += cost;
      }
      return result;
    } catch (error) {
      const failure = classify(error);
      lastFailure = failure;
      usage.failures += 1;
      if (failure.kind === 'timeout') usage.timeouts += 1;
      if (failure.kind === 'rate_limit') usage.rateLimits += 1;

      const willRetry = failure.retryable && attempt < maxAttempts;
      logger.warn(
        {
          provider: provider.name,
          providerKind: provider.kind,
          operation,
          attempt,
          maxAttempts,
          failureKind: failure.kind,
          code: failure.code,
          retryable: failure.retryable,
          willRetry,
          // Redacted single-line message only; never prompt/response bodies.
          error: failure.message,
        },
        `AI ${operation} failed (${failure.kind}); ${willRetry ? 'retrying' : 'giving up'}.`,
      );

      if (!willRetry) {
        break;
      }
      const wait = backoffFor(policy, attempt, failure.retryAfterMs);
      usage.retries += 1;
      await runtime.sleep(wait);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  // Exhausted (or permanent). Surface a typed, redacted error.
  const failure = lastFailure ?? {
    kind: 'permanent' as const,
    retryable: false,
    retryAfterMs: null,
    code: 'AI_UNKNOWN_ERROR',
    message: 'unknown failure',
  };
  throw new AiProviderError(
    `${provider.name} ${operation} failed after ${Math.max(1, Math.floor(policy.maxAttempts))} attempt(s): ${failure.message}`,
    { service: provider.name, operation, upstreamCode: failure.code },
    { retryable: failure.retryable },
  );
}

/* -------------------------------------------------------------------------- */
/*  Image generator wrapper                                                   */
/* -------------------------------------------------------------------------- */

export interface ResilientRunnerOptions {
  readonly policy?: Partial<RetryPolicy>;
  readonly logger?: ProviderLogger;
  readonly runtime?: RunnerRuntime;
}

export class ResilientImageGenerator implements ImageGenerator {
  readonly info: ProviderInfo;
  private readonly usage: MutableUsage = newUsage();
  private readonly policy: RetryPolicy;

  constructor(
    private readonly inner: ImageGenerator,
    private readonly options: ResilientRunnerOptions = {},
  ) {
    this.policy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
    this.info = {
      ...inner.info,
      detail: `${inner.info.detail} [resilient: <=${this.policy.maxAttempts} attempts, ${this.policy.defaultTimeoutMs}ms timeout]`,
    };
  }

  getUsage(): ProviderUsage {
    return freezeUsage(this.usage);
  }

  async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
    return execute<GeneratedImage>({
      provider: this.info,
      operation: 'generate_image',
      timeoutMs: request.timeoutMs,
      policy: this.policy,
      logger: this.options.logger ?? silentProviderLogger,
      runtime: this.options.runtime ?? defaultRuntime,
      usage: this.usage,
      costOf: (image) => image.estimatedCostUsd,
      attempt: (signal) => this.inner.generate({ ...request, signal }),
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Caption generator wrapper                                                 */
/* -------------------------------------------------------------------------- */

export class ResilientCaptionGenerator implements CaptionGenerator {
  readonly info: ProviderInfo;
  private readonly usage: MutableUsage = newUsage();
  private readonly policy: RetryPolicy;

  constructor(
    private readonly inner: CaptionGenerator,
    private readonly options: ResilientRunnerOptions = {},
  ) {
    this.policy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
    this.info = {
      ...inner.info,
      detail: `${inner.info.detail} [resilient: <=${this.policy.maxAttempts} attempts, ${this.policy.defaultTimeoutMs}ms timeout]`,
    };
  }

  getUsage(): ProviderUsage {
    return freezeUsage(this.usage);
  }

  async generate(request: CaptionGenerationRequest): Promise<GeneratedCaption> {
    return execute<GeneratedCaption>({
      provider: this.info,
      operation: 'generate_caption',
      timeoutMs: request.timeoutMs,
      policy: this.policy,
      logger: this.options.logger ?? silentProviderLogger,
      runtime: this.options.runtime ?? defaultRuntime,
      usage: this.usage,
      costOf: (caption) => caption.estimatedCostUsd,
      attempt: (signal) => this.inner.generate({ ...request, signal }),
    });
  }
}
