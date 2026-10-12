/**
 * Environment schema and validation.
 *
 * All configuration is read ONCE at process start via `loadEnv()`. The returned
 * object is a deeply-frozen, type-safe snapshot. Nothing else in the codebase may
 * read `process.env` directly — this makes secret handling auditable in one file.
 *
 * Secrets are NEVER included in the returned error messages beyond their KEY NAME.
 */
import { z } from 'zod';
import { EnvironmentError } from './errors.js';

/* -------------------------------------------------------------------------- */
/*  Primitive refinements                                                     */
/* -------------------------------------------------------------------------- */

const trimmed = (min: number, max: number): z.ZodString =>
  z.string().trim().min(min).max(max);

/** A URL string. Uses a hand-rolled regex to avoid deprecated zod methods. */
const httpUrl = z
  .string()
  .trim()
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an absolute http(s) URL');

/** Optional variant: empty string / undefined is treated as "not provided". */
const optionalHttpUrl = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  httpUrl.optional(),
);

const optionalTrimmed = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  trimmed(1, 500).optional(),
);

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

const timeZoneId = z
  .string()
  .trim()
  .refine((v) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, 'must be a valid IANA time zone');

const scheduleMode = z.enum(['mock', 'disabled']).default('mock');
const logLevel = z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info');
const nodeEnv = z.enum(['development', 'test', 'production']).default('development');
const corsOrigin = z.string().trim().min(1);

/* -------------------------------------------------------------------------- */
/*  Schema                                                                     */
/* -------------------------------------------------------------------------- */

export const envSchema = z
  .object({
    /* --- Runtime --- */
    NODE_ENV: nodeEnv,
    PORT: port.default(8080),
    HOST: trimmed(1, 255).default('0.0.0.0'),
    LOG_LEVEL: logLevel,
    LOG_PRETTY: z.enum(['true', 'false']).default('false'),

    /* --- APK <-> backend auth boundary --- */
    // Shared secret used to mint/verify APK session tokens (HS256 JWT).
    AUTH_JWT_SECRET: trimmed(32, 512),
    AUTH_JWT_ISSUER: trimmed(1, 255).default('shopee-affiliate-autopilot'),
    AUTH_JWT_AUDIENCE: trimmed(1, 255).default('autopilot-apk'),
    AUTH_ACCESS_TOKEN_TTL_SECONDS: positiveInt.default(3600),

    /* --- CORS (explicit allow-list; must not be "*" in production) --- */
    CORS_ORIGINS: corsOrigin,

    /* --- Database (optional in Part 1; health reports "not configured") --- */
    DATABASE_URL: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z
        .string()
        .trim()
        .refine((v) => /^postgres(ql)?:\/\//i.test(v), 'must be a postgres:// or postgresql:// URL')
        .optional(),
    ),

    /* --- Scheduler --- */
    SCHEDULER_ENABLED: z.enum(['true', 'false']).default('false'),
    SCHEDULER_TIMEZONE: timeZoneId.default('Asia/Jakarta'),
    SCHEDULER_INTERVAL_MINUTES: positiveInt.default(60),
    SCHEDULER_MAX_SLOTS_PER_DAY: positiveInt.max(24).default(24),
    // Mock mode lets the scheduler tick without any downstream credentials.
    SCHEDULER_MODE: scheduleMode,

    /* --- Shopee Affiliate Product Feed --- */
    // Part 1 supports user-provided CSV/XLSX uploads only (no live API assumed).
    SHOPEE_FEED_MODE: z.enum(['upload', 'blocked']).default('upload'),
    SHOPEE_AFFILIATE_API_BASE: optionalHttpUrl,
    SHOPEE_AFFILIATE_API_TOKEN: optionalTrimmed,
    SHOPEE_APP_ID: optionalTrimmed,
    SHOPEE_APP_SECRET: optionalTrimmed,

    /* --- Facebook Page publishing --- */
    FACEBOOK_GRAPH_API_BASE: httpUrl.default('https://graph.facebook.com'),
    FACEBOOK_GRAPH_API_VERSION: trimmed(1, 32).default('v23.0'),
    FACEBOOK_PAGE_ID: optionalTrimmed,
    FACEBOOK_PAGE_ACCESS_TOKEN: optionalTrimmed,

    /* --- Threads publishing --- */
    THREADS_API_BASE: httpUrl.default('https://graph.threads.net'),
    THREADS_API_VERSION: trimmed(1, 32).default('v1.0'),
    THREADS_USER_ID: optionalTrimmed,
    THREADS_ACCESS_TOKEN: optionalTrimmed,
    THREADS_APP_ID: optionalTrimmed,
    THREADS_APP_SECRET: optionalTrimmed,

    /* --- Telegram notifications --- */
    TELEGRAM_BOT_TOKEN: optionalTrimmed,
    TELEGRAM_CHAT_ID: optionalTrimmed,

    /* --- S3-compatible object storage --- */
    S3_ENDPOINT: optionalHttpUrl,
    S3_REGION: optionalTrimmed,
    S3_BUCKET: optionalTrimmed,
    S3_ACCESS_KEY_ID: optionalTrimmed,
    S3_SECRET_ACCESS_KEY: optionalTrimmed,
    S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
    // Public base URL used by Facebook/Threads to cURL the generated image.
    S3_PUBLIC_BASE_URL: optionalHttpUrl,

    /* --- AI providers (provider-agnostic; both optional in Part 1) --- */
    AI_IMAGE_PROVIDER: z.enum(['mock', 'openai', 'google', 'disabled']).default('mock'),
    AI_IMAGE_API_KEY: optionalTrimmed,
    AI_IMAGE_MODEL: trimmed(1, 128).default('mock-image-v1'),
    AI_TEXT_PROVIDER: z.enum(['mock', 'openai', 'google', 'disabled']).default('mock'),
    AI_TEXT_API_KEY: optionalTrimmed,
    AI_TEXT_MODEL: trimmed(1, 128).default('mock-text-v1'),
  })
  .superRefine((env, ctx) => {
    /* Cross-field invariants. Each adds an issue on the offending KEY only. */

    // Production must not use wildcard CORS.
    if (env.NODE_ENV === 'production') {
      const origins = parseCorsOrigins(env.CORS_ORIGINS);
      if (origins.includes('*')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGINS'],
          message: 'CORS_ORIGINS must not include "*" in production',
        });
      }
    }

    // Scheduler interval must fit inside the daily slot budget.
    const minutesPerDay = 24 * 60;
    if (Math.floor(minutesPerDay / env.SCHEDULER_INTERVAL_MINUTES) > env.SCHEDULER_MAX_SLOTS_PER_DAY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SCHEDULER_MAX_SLOTS_PER_DAY'],
        message:
          `Interval of ${env.SCHEDULER_INTERVAL_MINUTES}m yields ` +
          `${Math.floor(minutesPerDay / env.SCHEDULER_INTERVAL_MINUTES)} slots/day, ` +
          `exceeding SCHEDULER_MAX_SLOTS_PER_DAY=${env.SCHEDULER_MAX_SLOTS_PER_DAY}`,
      });
    }

    // An AI provider set to a real backend requires a key.
    if (env.AI_IMAGE_PROVIDER !== 'mock' && env.AI_IMAGE_PROVIDER !== 'disabled' && !env.AI_IMAGE_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_IMAGE_API_KEY'],
        message: `AI_IMAGE_API_KEY is required when AI_IMAGE_PROVIDER=${env.AI_IMAGE_PROVIDER}`,
      });
    }
    if (env.AI_TEXT_PROVIDER !== 'mock' && env.AI_TEXT_PROVIDER !== 'disabled' && !env.AI_TEXT_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_TEXT_API_KEY'],
        message: `AI_TEXT_API_KEY is required when AI_TEXT_PROVIDER=${env.AI_TEXT_PROVIDER}`,
      });
    }

    // Threads OAuth requires both id and secret together.
    if (Boolean(env.THREADS_APP_ID) !== Boolean(env.THREADS_APP_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [env.THREADS_APP_ID ? 'THREADS_APP_SECRET' : 'THREADS_APP_ID'],
        message: 'THREADS_APP_ID and THREADS_APP_SECRET must be supplied together',
      });
    }

    // Publishing credentials must come as complete pairs.
    if (Boolean(env.FACEBOOK_PAGE_ID) !== Boolean(env.FACEBOOK_PAGE_ACCESS_TOKEN)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [env.FACEBOOK_PAGE_ID ? 'FACEBOOK_PAGE_ACCESS_TOKEN' : 'FACEBOOK_PAGE_ID'],
        message: 'FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN must be supplied together',
      });
    }
    if (Boolean(env.THREADS_USER_ID) !== Boolean(env.THREADS_ACCESS_TOKEN)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [env.THREADS_USER_ID ? 'THREADS_ACCESS_TOKEN' : 'THREADS_USER_ID'],
        message: 'THREADS_USER_ID and THREADS_ACCESS_TOKEN must be supplied together',
      });
    }
    if (Boolean(env.TELEGRAM_BOT_TOKEN) !== Boolean(env.TELEGRAM_CHAT_ID)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [env.TELEGRAM_BOT_TOKEN ? 'TELEGRAM_CHAT_ID' : 'TELEGRAM_BOT_TOKEN'],
        message: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be supplied together',
      });
    }

    // S3 requires the full credential set together.
    const s3Keys = [
      env.S3_ENDPOINT,
      env.S3_REGION,
      env.S3_BUCKET,
      env.S3_ACCESS_KEY_ID,
      env.S3_SECRET_ACCESS_KEY,
    ] as const;
    const s3Provided = s3Keys.filter((v) => Boolean(v)).length;
    if (s3Provided > 0 && s3Provided < s3Keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_ENDPOINT'],
        message:
          'S3 configuration is partial. S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must all be supplied together.',
      });
    }

    // DATABASE_URL, when present, must be a postgres URL.
    if (env.DATABASE_URL && !/^postgres(ql)?:\/\//i.test(env.DATABASE_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL must start with postgres:// or postgresql://',
      });
    }
  });

/** Parse `CORS_ORIGINS` (comma-separated) into a normalized array. */
export function parseCorsOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/* -------------------------------------------------------------------------- */
/*  Parsed, frozen environment                                                 */
/* -------------------------------------------------------------------------- */

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

/**
 * Validate and freeze the environment.
 *
 * @param source raw key/value pairs; defaults to `process.env`
 * @throws {EnvironmentError} listing the offending KEY NAMES (never values)
 */
export function loadEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Env {
  if (cachedEnv && source === process.env) {
    return cachedEnv;
  }

  const result = envSchema.safeParse(source);

  if (!result.success) {
    const missingKeys = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ].sort();
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new EnvironmentError(missingKeys, detail);
  }

  const frozen = deepFreeze(result.data);
  if (source === process.env) {
    cachedEnv = frozen;
  }
  return frozen;
}

/** Reset the memoized env. TEST-ONLY; never call in production code paths. */
export function resetEnvCache(): void {
  cachedEnv = null;
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const value of Object.values(obj as Record<string, unknown>)) {
      deepFreeze(value);
    }
  }
  return obj;
}

/* -------------------------------------------------------------------------- */
/*  Derived integration readiness                                              */
/* -------------------------------------------------------------------------- */

export interface IntegrationStatus {
  readonly service: string;
  readonly configured: boolean;
  readonly mode: string;
  /** Safe, non-secret descriptor of why the integration is/isn't ready. */
  readonly detail: string;
}

/**
 * Report, without leaking secrets, which integrations have complete credentials
 * and are therefore eligible to run live. Consumed by /health and the APK
 * integration-health screen.
 */
export function describeIntegrationStatus(env: Env): IntegrationStatus[] {
  const statuses: IntegrationStatus[] = [];

  const fbConfigured = Boolean(env.FACEBOOK_PAGE_ID && env.FACEBOOK_PAGE_ACCESS_TOKEN);
  statuses.push({
    service: 'facebook_page',
    configured: fbConfigured,
    mode: fbConfigured ? 'live_ready' : 'disabled',
    detail: fbConfigured
      ? `Page publishing enabled (Graph API ${env.FACEBOOK_GRAPH_API_VERSION}).`
      : 'FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN not set — publisher disabled.',
  });

  const threadsConfigured = Boolean(env.THREADS_USER_ID && env.THREADS_ACCESS_TOKEN);
  statuses.push({
    service: 'threads',
    configured: threadsConfigured,
    mode: threadsConfigured ? 'live_ready' : 'disabled',
    detail: threadsConfigured
      ? `Threads publishing enabled (API ${env.THREADS_API_VERSION}).`
      : 'THREADS_USER_ID / THREADS_ACCESS_TOKEN not set — publisher disabled.',
  });

  const telegramConfigured = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  statuses.push({
    service: 'telegram',
    configured: telegramConfigured,
    mode: telegramConfigured ? 'live_ready' : 'mock',
    detail: telegramConfigured
      ? 'Telegram notifications enabled.'
      : 'Telegram credentials not set — notifications will use the in-memory mock.',
  });

  const s3Configured = Boolean(
    env.S3_ENDPOINT && env.S3_REGION && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY,
  );
  statuses.push({
    service: 's3_storage',
    configured: s3Configured,
    mode: s3Configured ? 'live_ready' : 'mock',
    detail: s3Configured
      ? `S3-compatible storage enabled (bucket=${env.S3_BUCKET}).`
      : 'S3 credentials not set — storage will use the in-memory mock.',
  });

  statuses.push({
    service: 'ai_image',
    configured: env.AI_IMAGE_PROVIDER === 'mock' || Boolean(env.AI_IMAGE_API_KEY),
    mode: env.AI_IMAGE_PROVIDER,
    detail:
      env.AI_IMAGE_PROVIDER === 'mock'
        ? 'Image generation running in deterministic mock mode.'
        : env.AI_IMAGE_PROVIDER === 'disabled'
          ? 'Image generation disabled.'
          : `Image generation via ${env.AI_IMAGE_PROVIDER}.`,
  });

  statuses.push({
    service: 'ai_text',
    configured: env.AI_TEXT_PROVIDER === 'mock' || Boolean(env.AI_TEXT_API_KEY),
    mode: env.AI_TEXT_PROVIDER,
    detail:
      env.AI_TEXT_PROVIDER === 'mock'
        ? 'Caption generation running in deterministic mock mode.'
        : env.AI_TEXT_PROVIDER === 'disabled'
          ? 'Caption generation disabled.'
          : `Caption generation via ${env.AI_TEXT_PROVIDER}.`,
  });

  const dbConfigured = Boolean(env.DATABASE_URL);
  statuses.push({
    service: 'postgresql',
    configured: dbConfigured,
    mode: dbConfigured ? 'configured_not_connected' : 'not_configured',
    detail: dbConfigured
      ? 'DATABASE_URL set. Connectivity is verified lazily at first query.'
      : 'DATABASE_URL not set — persistence and job queue run in in-memory mode.',
  });

  statuses.push({
    service: 'shopee_feed',
    configured: true,
    mode: env.SHOPEE_FEED_MODE,
    detail:
      env.SHOPEE_FEED_MODE === 'upload'
        ? 'Product feed ingestion via user-provided CSV/XLSX upload. Live API not assumed.'
        : 'Shopee feed ingestion blocked pending live-feed sample and API contract.',
  });

  return statuses;
}
