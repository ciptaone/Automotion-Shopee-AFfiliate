import { describe, it, expect, afterEach } from 'vitest';
import { loadEnv, resetEnvCache, parseCorsOrigins, describeIntegrationStatus } from '../../src/core/env.js';
import { EnvironmentError } from '../../src/core/errors.js';

/** A minimal valid baseline for tests that don't care about specific keys. */
function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    AUTH_JWT_SECRET: 'x'.repeat(48),
    CORS_ORIGINS: 'http://localhost:8080',
    ...overrides,
  };
}

afterEach(() => {
  resetEnvCache();
});

describe('loadEnv — required keys', () => {
  it('fails when AUTH_JWT_SECRET is missing', () => {
    expect(() => loadEnv({ CORS_ORIGINS: 'http://localhost:8080' })).toThrow(EnvironmentError);
  });

  it('fails when AUTH_JWT_SECRET is too short', () => {
    expect(() => loadEnv(baseEnv({ AUTH_JWT_SECRET: 'short' }))).toThrow(EnvironmentError);
  });

  it('fails when CORS_ORIGINS is missing', () => {
    expect(() => loadEnv({ AUTH_JWT_SECRET: 'x'.repeat(48) })).toThrow(EnvironmentError);
  });

  it('lists offending KEY NAMES, never values', () => {
    let message = '';
    try {
      loadEnv({ CORS_ORIGINS: 'http://localhost:8080' });
    } catch (error) {
      message = (error as EnvironmentError).message;
    }
    expect(message).toContain('AUTH_JWT_SECRET');
    // The message must not echo any secret-looking value.
    expect(message).not.toMatch(/= *[A-Za-z0-9+/]{32,}/);
  });

  it('succeeds with minimal valid input and applies defaults', () => {
    const env = loadEnv(baseEnv());
    expect(env.PORT).toBe(8080);
    expect(env.NODE_ENV).toBe('development');
    expect(env.SCHEDULER_TIMEZONE).toBe('Asia/Jakarta');
    expect(env.SCHEDULER_INTERVAL_MINUTES).toBe(60);
    expect(env.SCHEDULER_MAX_SLOTS_PER_DAY).toBe(24);
  });

  it('returns a deeply frozen object', () => {
    const env = loadEnv(baseEnv());
    expect(Object.isFrozen(env)).toBe(true);
  });
});

describe('loadEnv — cross-field invariants', () => {
  it('rejects wildcard CORS in production', () => {
    expect(() => loadEnv(baseEnv({ NODE_ENV: 'production', CORS_ORIGINS: '*' }))).toThrow(
      EnvironmentError,
    );
  });

  it('allows wildcard CORS in development', () => {
    expect(() => loadEnv(baseEnv({ NODE_ENV: 'development', CORS_ORIGINS: '*' }))).not.toThrow();
  });

  it('rejects an invalid IANA time zone', () => {
    expect(() => loadEnv(baseEnv({ SCHEDULER_TIMEZONE: 'Mars/Olympus' }))).toThrow(EnvironmentError);
  });

  it('accepts Asia/Jakarta', () => {
    expect(() => loadEnv(baseEnv({ SCHEDULER_TIMEZONE: 'Asia/Jakarta' }))).not.toThrow();
  });

  it('rejects max slots above 24', () => {
    expect(() => loadEnv(baseEnv({ SCHEDULER_MAX_SLOTS_PER_DAY: '25' }))).toThrow(EnvironmentError);
  });

  it('rejects an interval that would exceed the slot budget', () => {
    // 30-minute interval => 48 slots/day, but cap is 24 => invalid.
    expect(() =>
      loadEnv(baseEnv({ SCHEDULER_INTERVAL_MINUTES: '30', SCHEDULER_MAX_SLOTS_PER_DAY: '24' })),
    ).toThrow(EnvironmentError);
  });

  it('accepts a 60-minute interval with a 24-slot cap', () => {
    expect(() =>
      loadEnv(baseEnv({ SCHEDULER_INTERVAL_MINUTES: '60', SCHEDULER_MAX_SLOTS_PER_DAY: '24' })),
    ).not.toThrow();
  });

  it('requires an AI key when a real image provider is selected', () => {
    expect(() => loadEnv(baseEnv({ AI_IMAGE_PROVIDER: 'openai' }))).toThrow(EnvironmentError);
    expect(() =>
      loadEnv(baseEnv({ AI_IMAGE_PROVIDER: 'openai', AI_IMAGE_API_KEY: 'sk-test' })),
    ).not.toThrow();
  });

  it('does not require a key for the mock provider', () => {
    expect(() => loadEnv(baseEnv({ AI_IMAGE_PROVIDER: 'mock' }))).not.toThrow();
  });

  it('requires Facebook page id and token as a pair', () => {
    expect(() => loadEnv(baseEnv({ FACEBOOK_PAGE_ID: '123' }))).toThrow(EnvironmentError);
    expect(() => loadEnv(baseEnv({ FACEBOOK_PAGE_ACCESS_TOKEN: 'tok' }))).toThrow(EnvironmentError);
    expect(() =>
      loadEnv(baseEnv({ FACEBOOK_PAGE_ID: '123', FACEBOOK_PAGE_ACCESS_TOKEN: 'tok' })),
    ).not.toThrow();
  });

  it('requires Threads user id and token as a pair', () => {
    expect(() => loadEnv(baseEnv({ THREADS_USER_ID: '123' }))).toThrow(EnvironmentError);
    expect(() =>
      loadEnv(baseEnv({ THREADS_USER_ID: '123', THREADS_ACCESS_TOKEN: 'tok' })),
    ).not.toThrow();
  });

  it('requires Threads app id and secret as a pair', () => {
    expect(() => loadEnv(baseEnv({ THREADS_APP_ID: 'app123' }))).toThrow(EnvironmentError);
  });

  it('requires Telegram token and chat id as a pair', () => {
    expect(() => loadEnv(baseEnv({ TELEGRAM_BOT_TOKEN: '123:abc' }))).toThrow(EnvironmentError);
  });

  it('requires the full S3 credential set together', () => {
    expect(() => loadEnv(baseEnv({ S3_ENDPOINT: 'https://s3.example.com' }))).toThrow(
      EnvironmentError,
    );
    expect(() =>
      loadEnv(
        baseEnv({
          S3_ENDPOINT: 'https://s3.example.com',
          S3_REGION: 'auto',
          S3_BUCKET: 'assets',
          S3_ACCESS_KEY_ID: 'key',
          S3_SECRET_ACCESS_KEY: 'secret',
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadEnv(baseEnv({ DATABASE_URL: 'mysql://localhost/db' }))).toThrow(
      EnvironmentError,
    );
  });

  it('accepts a postgres DATABASE_URL', () => {
    expect(() =>
      loadEnv(baseEnv({ DATABASE_URL: 'postgres://user:pass@localhost:5432/db' })),
    ).not.toThrow();
  });
});

describe('parseCorsOrigins', () => {
  it('splits and trims', () => {
    expect(parseCorsOrigins(' http://a.com , http://b.com ,, ')).toEqual([
      'http://a.com',
      'http://b.com',
    ]);
  });

  it('returns empty for empty input', () => {
    expect(parseCorsOrigins('')).toEqual([]);
  });
});

describe('describeIntegrationStatus', () => {
  it('reports every integration as not configured on a minimal env', () => {
    const env = loadEnv(baseEnv());
    const statuses = describeIntegrationStatus(env);
    const byService = Object.fromEntries(statuses.map((s) => [s.service, s]));

    expect(byService['facebook_page']?.configured).toBe(false);
    expect(byService['threads']?.configured).toBe(false);
    expect(byService['telegram']?.configured).toBe(false);
    expect(byService['s3_storage']?.configured).toBe(false);
    expect(byService['ai_image']?.mode).toBe('mock');
    expect(byService['shopee_feed']?.mode).toBe('upload');
  });

  it('marks a service configured only when credentials are present', () => {
    const env = loadEnv(
      baseEnv({
        FACEBOOK_PAGE_ID: '123',
        FACEBOOK_PAGE_ACCESS_TOKEN: 'tok',
        TELEGRAM_BOT_TOKEN: '123:abc',
        TELEGRAM_CHAT_ID: '999',
      }),
    );
    const byService = Object.fromEntries(describeIntegrationStatus(env).map((s) => [s.service, s]));
    expect(byService['facebook_page']?.configured).toBe(true);
    expect(byService['telegram']?.configured).toBe(true);
    expect(byService['threads']?.configured).toBe(false);
  });

  it('never leaks secret values into the detail strings', () => {
    const secretToken = 'EAABsecretsecretsecretsecretsecret12';
    const env = loadEnv(
      baseEnv({ FACEBOOK_PAGE_ID: '123', FACEBOOK_PAGE_ACCESS_TOKEN: secretToken }),
    );
    const details = describeIntegrationStatus(env)
      .map((s) => s.detail)
      .join(' ');
    expect(details).not.toContain(secretToken);
  });
});
