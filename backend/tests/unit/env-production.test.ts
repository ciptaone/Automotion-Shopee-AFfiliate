/**
 * PART 9 §3 — production-required configuration, fail closed at startup.
 *
 * Rules proven here (key NAMES only in errors, never values):
 *  - production requires PUBLIC_URL (https), the complete S3 credential set,
 *    a non-placeholder AUTH_JWT_SECRET and an explicit CORS allow-list;
 *  - lifecycle/pool knobs are bounded integers with working defaults, and the
 *    pool max >= min invariant holds in EVERY environment;
 *  - development still boots with just AUTH_JWT_SECRET + CORS_ORIGINS (no
 *    unavailable credential is required for local tests).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { loadEnv, resetEnvCache } from '../../src/core/env.js';
import { EnvironmentError } from '../../src/core/errors.js';

/** Minimal valid baseline (development). */
function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    AUTH_JWT_SECRET: 'x'.repeat(48),
    CORS_ORIGINS: 'http://localhost:8080',
    ...overrides,
  };
}

/** Everything a production boot needs beyond the baseline. */
function productionEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return baseEnv({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/autopilot',
    PUBLIC_URL: 'https://autopilot.example.com',
    CORS_ORIGINS: 'https://autopilot.example.com',
    AUTH_JWT_SECRET: 'prod-secret-' + 'y'.repeat(48),
    S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
    S3_REGION: 'eu-west-1',
    S3_BUCKET: 'assets',
    S3_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    S3_SECRET_ACCESS_KEY: 'secret-example-value',
    ...overrides,
  });
}

afterEach(() => {
  resetEnvCache();
});

describe('production-required settings', () => {
  it('accepts a complete production configuration', () => {
    const env = loadEnv(productionEnv());
    expect(env.PUBLIC_URL).toBe('https://autopilot.example.com');
    expect(env.S3_BUCKET).toBe('assets');
    expect(env.DATABASE_POOL_MAX).toBe(5);
    expect(env.SHUTDOWN_GRACE_MS).toBe(20_000);
    expect(env.JOB_LEASE_SECONDS).toBe(120);
  });

  it('requires PUBLIC_URL in production', () => {
    expect(() => loadEnv(productionEnv({ PUBLIC_URL: undefined }))).toThrow(EnvironmentError);
    try {
      loadEnv(productionEnv({ PUBLIC_URL: undefined }));
    } catch (error) {
      expect((error as EnvironmentError).message).toContain('PUBLIC_URL');
      expect((error as EnvironmentError).message).toContain('required in production');
    }
  });

  it('rejects a non-https PUBLIC_URL in production', () => {
    try {
      loadEnv(productionEnv({ PUBLIC_URL: 'http://autopilot.example.com' }));
      expect.unreachable('http PUBLIC_URL must be rejected');
    } catch (error) {
      expect((error as EnvironmentError).message).toContain('PUBLIC_URL');
      expect((error as EnvironmentError).message).toContain('https://');
    }
  });

  it('requires the complete S3 credential set in production (no silent in-memory assets)', () => {
    try {
      loadEnv(productionEnv({ S3_SECRET_ACCESS_KEY: undefined, S3_ACCESS_KEY_ID: undefined }));
      expect.unreachable('production without storage must be rejected');
    } catch (error) {
      const message = (error as EnvironmentError).message;
      expect(message).toContain('S3_ENDPOINT');
      expect(message).toContain('required in production');
      // Key names only — the placeholder endpoint must not be echoed either.
      expect(message).not.toContain('secret-example-value');
    }
  });

  it('accepts production without S3 in no other environment (dev stays credential-free)', () => {
    const dev = loadEnv(baseEnv());
    expect(dev.S3_BUCKET).toBeUndefined();
  });

  it('rejects the shipped CHANGE_ME placeholder secret in production', () => {
    try {
      loadEnv(productionEnv({ AUTH_JWT_SECRET: 'CHANGE_ME_min_32_chars_random_secret_value' }));
      expect.unreachable('placeholder secret must be rejected');
    } catch (error) {
      expect((error as EnvironmentError).message).toContain('AUTH_JWT_SECRET');
      expect((error as EnvironmentError).message).toContain('placeholder');
    }
  });

  it('still rejects wildcard CORS in production', () => {
    expect(() => loadEnv(productionEnv({ CORS_ORIGINS: '*' }))).toThrow(EnvironmentError);
  });

  it('does not require PUBLIC_URL or S3 outside production', () => {
    const dev = loadEnv(baseEnv());
    expect(dev.PUBLIC_URL).toBeUndefined();
    const test = loadEnv(baseEnv({ NODE_ENV: 'test' }));
    expect(test.SHUTDOWN_GRACE_MS).toBe(20_000);
  });
});

describe('bounded lifecycle and pool settings', () => {
  it('SHUTDOWN_GRACE_MS accepts the documented range and rejects outside it', () => {
    expect(loadEnv(baseEnv({ SHUTDOWN_GRACE_MS: '1000' })).SHUTDOWN_GRACE_MS).toBe(1_000);
    expect(loadEnv(baseEnv({ SHUTDOWN_GRACE_MS: '120000' })).SHUTDOWN_GRACE_MS).toBe(120_000);
    expect(() => loadEnv(baseEnv({ SHUTDOWN_GRACE_MS: '500' }))).toThrow(EnvironmentError);
    expect(() => loadEnv(baseEnv({ SHUTDOWN_GRACE_MS: '200000' }))).toThrow(EnvironmentError);
    expect(() => loadEnv(baseEnv({ SHUTDOWN_GRACE_MS: 'soon' }))).toThrow(EnvironmentError);
  });

  it('JOB_LEASE_SECONDS accepts the documented range and rejects outside it', () => {
    expect(loadEnv(baseEnv({ JOB_LEASE_SECONDS: '30' })).JOB_LEASE_SECONDS).toBe(30);
    expect(loadEnv(baseEnv({ JOB_LEASE_SECONDS: '3600' })).JOB_LEASE_SECONDS).toBe(3_600);
    expect(() => loadEnv(baseEnv({ JOB_LEASE_SECONDS: '10' }))).toThrow(EnvironmentError);
    expect(() => loadEnv(baseEnv({ JOB_LEASE_SECONDS: '4000' }))).toThrow(EnvironmentError);
  });

  it('rejects DATABASE_POOL_MAX < DATABASE_POOL_MIN in every environment', () => {
    expect(() =>
      loadEnv(baseEnv({ DATABASE_POOL_MIN: '4', DATABASE_POOL_MAX: '2' })),
    ).toThrow(EnvironmentError);
    const ok = loadEnv(baseEnv({ DATABASE_POOL_MIN: '2', DATABASE_POOL_MAX: '10' }));
    expect(ok.DATABASE_POOL_MIN).toBe(2);
    expect(ok.DATABASE_POOL_MAX).toBe(10);
  });

  it('S3_OBJECT_ACL is optional and trimmed when present', () => {
    expect(loadEnv(baseEnv({ S3_OBJECT_ACL: ' public-read ' })).S3_OBJECT_ACL).toBe('public-read');
    expect(loadEnv(baseEnv()).S3_OBJECT_ACL).toBeUndefined();
  });
});
