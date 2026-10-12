import { describe, it, expect } from 'vitest';
import {
  redactString,
  redactDeep,
  hasSensitiveValue,
  REDACTED,
} from '../../src/core/redact.js';

describe('redactString', () => {
  it('masks Telegram bot tokens', () => {
    const input = 'failed to call 123456789:AAE-yZ_xK9pQ7rT2vW5nB8cD3fH6jL1mN4 with timeout';
    const out = redactString(input);
    expect(out).not.toContain('AAE-yZ_xK9pQ7rT2vW5nB8cD3fH6jL1mN4');
    expect(out).toContain(REDACTED);
  });

  it('masks Meta-style access tokens', () => {
    const input = 'token=EAABsbCS9ZCZCdABCDEF1234567890abcdefghijk';
    const out = redactString(input);
    expect(out).not.toContain('EAABsbCS9ZCZCdABCDEF1234567890');
    expect(out).toContain(REDACTED);
  });

  it('masks AWS access key ids', () => {
    const input = 'using key AKIAIOSFODNN7EXAMPLE';
    const out = redactString(input);
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('masks Bearer authorization values', () => {
    const input = 'header was: Bearer abcdefghijklmnopqrstuvwxyz012345';
    const out = redactString(input);
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });

  it('masks JWTs in free text', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = redactString(`got ${jwt} back`);
    expect(out).not.toContain(jwt);
  });

  it('redacts credential query params but keeps the param name', () => {
    const url = 'https://graph.facebook.com/v23.0/123/feed?access_token=SECRETVALUE123456&limit=10';
    const out = redactString(url);
    expect(out).not.toContain('SECRETVALUE123456');
    expect(out).toContain('access_token=');
    expect(out).toContain('limit=10');
  });

  it('leaves ordinary text unchanged', () => {
    const input = 'the quick brown fox jumped over 12 lazy dogs';
    expect(redactString(input)).toBe(input);
  });

  it('never throws on weird input', () => {
    expect(() => redactString('')).not.toThrow();
    expect(() => redactString('a'.repeat(10_000))).not.toThrow();
  });

  it('truncates very long input', () => {
    const out = redactString('x'.repeat(10_000));
    expect(out.length).toBeLessThan(5000);
    expect(out).toContain('[TRUNCATED]');
  });
});

describe('redactDeep', () => {
  it('masks values under sensitive keys', () => {
    const out = redactDeep({
      botToken: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      apiKey: 'sk-abcdefghijklmnop',
      password: 'hunter2',
      nested: { accessToken: 'EAABxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    }) as Record<string, any>;

    expect(String(out['botToken'])).not.toContain('AAAA');
    expect(String(out['apiKey'])).not.toContain('sk-abcdefghijklmnop');
    expect(out['password']).toBe(REDACTED);
    expect(String(out['nested'].accessToken)).not.toContain('EAAB');
  });

  it('keeps non-sensitive fields intact', () => {
    const out = redactDeep({ name: 'Produk Bagus', count: 42, ok: true }) as Record<string, any>;
    expect(out['name']).toBe('Produk Bagus');
    expect(out['count']).toBe(42);
    expect(out['ok']).toBe(true);
  });

  it('does not mutate the input object', () => {
    const input = { apiKey: 'secret-value-here-123456' };
    const copy = { ...input };
    redactDeep(input);
    expect(input).toEqual(copy);
  });

  it('handles circular references', () => {
    const a: Record<string, unknown> = { name: 'root' };
    a['self'] = a;
    const out = redactDeep(a) as Record<string, any>;
    expect(out['self']).toBe('[CIRCULAR]');
  });

  it('redacts secrets embedded in string values of a normal field', () => {
    const out = redactDeep({ note: 'use token 123456789:AAEsecretsecretsecretsecretxx please' }) as Record<string, any>;
    expect(String(out['note'])).not.toContain('AAEsecretsecretsecretsecretxx');
  });

  it('handles arrays and depth limits without throwing', () => {
    let deep: any = { v: 1 };
    for (let i = 0; i < 20; i += 1) {
      deep = { child: deep };
    }
    expect(() => redactDeep(deep)).not.toThrow();
  });

  it('serializes Error instances safely', () => {
    const err = new Error('boom with token 123456789:AAEsecretsecretsecretsecretxx');
    const out = redactDeep(err) as Record<string, any>;
    expect(String(out['message'])).not.toContain('AAEsecretsecretsecretsecretxx');
  });
});

describe('hasSensitiveValue', () => {
  it('detects a non-empty sensitive value', () => {
    expect(hasSensitiveValue({ pageAccessToken: 'abc' })).toBe(true);
  });

  it('ignores empty strings', () => {
    expect(hasSensitiveValue({ pageAccessToken: '   ' })).toBe(false);
  });

  it('ignores non-sensitive keys', () => {
    expect(hasSensitiveValue({ pageId: '12345' })).toBe(false);
  });

  it('handles undefined/null', () => {
    expect(hasSensitiveValue(undefined)).toBe(false);
    expect(hasSensitiveValue(null)).toBe(false);
  });
});
