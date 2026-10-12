/**
 * Part 2 — integration health classification.
 *
 * The APK must never be told "Connected" just because credentials exist, so
 * these tests pin the four-state vocabulary and assert that nothing reaches
 * `connected` while live calls are gated off.
 */
import { describe, it, expect } from 'vitest';
import {
  INTEGRATION_HEALTH_VALUES,
  classifyIntegrationHealth,
  withIntegrationHealth,
} from '../../src/app/integration-health.js';
import { describeIntegrationStatus, loadEnv } from '../../src/core/env.js';

const TEST_ENV = loadEnv({
  AUTH_JWT_SECRET: 'test-secret-that-is-definitely-long-enough-123456',
  AUTH_JWT_ISSUER: 'test-issuer',
  AUTH_JWT_AUDIENCE: 'test-audience',
  CORS_ORIGINS: 'http://localhost:8080',
  NODE_ENV: 'test',
});

const ENV_WITH_CREDENTIALS = loadEnv({
  AUTH_JWT_SECRET: 'test-secret-that-is-definitely-long-enough-123456',
  AUTH_JWT_ISSUER: 'test-issuer',
  AUTH_JWT_AUDIENCE: 'test-audience',
  CORS_ORIGINS: 'http://localhost:8080',
  NODE_ENV: 'test',
  FACEBOOK_PAGE_ID: '123456',
  FACEBOOK_PAGE_ACCESS_TOKEN: 'page-token',
  THREADS_USER_ID: 'threads-user',
  THREADS_ACCESS_TOKEN: 'threads-token',
  TELEGRAM_BOT_TOKEN: '123456:token',
  TELEGRAM_CHAT_ID: '42',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_REGION: 'auto',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
});

describe('classifyIntegrationHealth', () => {
  it('marks the Shopee feed as blocked while the live contract is unverifiable', () => {
    const status = {
      service: 'shopee_feed',
      configured: true,
      mode: 'blocked' as const,
      detail: 'blocked',
    };
    expect(classifyIntegrationHealth(status).health).toBe('blocked');
  });

  it('marks upload-mode feed ingestion as not_tested (parser only)', () => {
    const status = {
      service: 'shopee_feed',
      configured: true,
      mode: 'upload' as const,
      detail: 'upload',
    };
    expect(classifyIntegrationHealth(status).health).toBe('not_tested');
  });

  it('never reports connected for a configured-but-gated publisher', () => {
    const status = {
      service: 'facebook_page',
      configured: true,
      mode: 'live_ready' as const,
      detail: 'configured',
    };
    expect(classifyIntegrationHealth(status).health).toBe('not_tested');
  });

  it('reports disconnected when nothing is configured', () => {
    const status = {
      service: 'threads',
      configured: false,
      mode: 'disabled' as const,
      detail: 'not configured',
    };
    expect(classifyIntegrationHealth(status).health).toBe('disconnected');
  });

  it('treats mock AI providers as not_tested, disabled ones as disconnected', () => {
    expect(
      classifyIntegrationHealth({
        service: 'ai_image',
        configured: true,
        mode: 'mock',
        detail: 'mock',
      }).health,
    ).toBe('not_tested');
    expect(
      classifyIntegrationHealth({
        service: 'ai_image',
        configured: false,
        mode: 'disabled',
        detail: 'disabled',
      }).health,
    ).toBe('disconnected');
  });

  it('always attaches a human-readable justification', () => {
    const result = classifyIntegrationHealth({
      service: 'telegram',
      configured: false,
      mode: 'mock',
      detail: '',
    });
    expect(result.healthDetail.length).toBeGreaterThan(10);
  });
});

describe('withIntegrationHealth', () => {
  it('classifies every service in the default (credential-free) environment', () => {
    const enriched = withIntegrationHealth(describeIntegrationStatus(TEST_ENV));
    expect(enriched.length).toBeGreaterThanOrEqual(7);

    for (const entry of enriched) {
      expect(INTEGRATION_HEALTH_VALUES).toContain(entry.health);
      // No credentials anywhere in this environment: nothing can be connected.
      expect(entry.health).not.toBe('connected');
    }

    const byService = Object.fromEntries(enriched.map((e) => [e.service, e]));
    expect(byService['facebook_page']?.health).toBe('disconnected');
    expect(byService['threads']?.health).toBe('disconnected');
    expect(byService['telegram']?.health).toBe('disconnected');
    expect(byService['s3_storage']?.health).toBe('disconnected');
    expect(byService['ai_image']?.health).toBe('not_tested'); // deterministic mock
    expect(byService['postgresql']?.health).toBe('disconnected');
  });

  it('still refuses to claim connected when credentials ARE present (gated build)', () => {
    const enriched = withIntegrationHealth(describeIntegrationStatus(ENV_WITH_CREDENTIALS));
    for (const entry of enriched) {
      expect(entry.health).not.toBe('connected');
    }
    const byService = Object.fromEntries(enriched.map((e) => [e.service, e]));
    expect(byService['facebook_page']?.health).toBe('not_tested');
    expect(byService['telegram']?.health).toBe('not_tested');
  });

  it('preserves the original status fields', () => {
    const [entry] = withIntegrationHealth([
      { service: 'threads', configured: false, mode: 'disabled', detail: 'x' },
    ]);
    expect(entry).toMatchObject({ service: 'threads', configured: false, mode: 'disabled' });
  });
});
