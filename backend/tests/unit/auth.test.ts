import { describe, it, expect } from 'vitest';
import { mintToken, mintTokenFromOptions, verifyToken, requireScopes } from '../../src/core/auth.js';
import { AuthenticationError, AuthorizationError, TokenExpiredError } from '../../src/core/errors.js';

const SECRET = 'test-secret-value-that-is-long-enough-1234567890';
const ISSUER = 'test-issuer';
const AUDIENCE = 'test-audience';

function opts(overrides: Record<string, unknown> = {}) {
  return { issuer: ISSUER, audience: AUDIENCE, ...overrides } as {
    issuer: string;
    audience: string;
    clockSkewSeconds?: number;
    nowSeconds?: number;
  };
}

describe('mint + verify round-trip', () => {
  it('mints and verifies a valid token', () => {
    const token = mintTokenFromOptions(
      { subject: 'device-1', issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 3600, scope: ['read'] },
      SECRET,
    );
    const claims = verifyToken(token, SECRET, opts());
    expect(claims.sub).toBe('device-1');
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe(AUDIENCE);
    expect(claims.scope).toEqual(['read']);
  });

  it('produces a three-part compact JWT', () => {
    const token = mintTokenFromOptions(
      { subject: 'd', issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 60 },
      SECRET,
    );
    expect(token.split('.')).toHaveLength(3);
  });
});

describe('verifyToken — tampering', () => {
  it('rejects a token signed with a different secret', () => {
    const token = mintTokenFromOptions(
      { subject: 'd', issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 3600 },
      SECRET,
    );
    expect(() => verifyToken(token, 'another-secret-another-secret-123456', opts())).toThrow(
      AuthenticationError,
    );
  });

  it('rejects a token whose payload was modified', () => {
    const token = mintTokenFromOptions(
      { subject: 'd', issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 3600 },
      SECRET,
    );
    const [h, _p, s] = token.split('.') as [string, string, string];
    const tamperedPayload = Buffer.from(
      JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: 'ADMIN', iat: 1, exp: 9999999999 }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(() => verifyToken(`${h}.${tamperedPayload}.${s}`, SECRET, opts())).toThrow(
      AuthenticationError,
    );
  });

  it('rejects a token with an unsupported algorithm in the header', () => {
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const payload = Buffer.from(
      JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: 'x', iat: 1, exp: 9999999999 }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    // A forged signature cannot validate regardless.
    expect(() => verifyToken(`${noneHeader}.${payload}.forged`, SECRET, opts())).toThrow(
      AuthenticationError,
    );
  });
});

describe('verifyToken — malformed input', () => {
  it('rejects an empty token', () => {
    expect(() => verifyToken('', SECRET, opts())).toThrow(AuthenticationError);
  });

  it('rejects a token with the wrong number of parts', () => {
    expect(() => verifyToken('a.b', SECRET, opts())).toThrow(AuthenticationError);
    expect(() => verifyToken('a.b.c.d', SECRET, opts())).toThrow(AuthenticationError);
  });

  it('rejects garbage segments', () => {
    expect(() => verifyToken('!!!.@@@.###', SECRET, opts())).toThrow(AuthenticationError);
  });
});

describe('verifyToken — claims binding', () => {
  it('rejects a token issued for a different audience', () => {
    const token = mintTokenFromOptions(
      { subject: 'd', issuer: ISSUER, audience: 'other-aud', ttlSeconds: 3600 },
      SECRET,
    );
    expect(() => verifyToken(token, SECRET, opts())).toThrow(AuthenticationError);
  });

  it('rejects a token issued by a different issuer', () => {
    const token = mintTokenFromOptions(
      { subject: 'd', issuer: 'other-iss', audience: AUDIENCE, ttlSeconds: 3600 },
      SECRET,
    );
    expect(() => verifyToken(token, SECRET, opts())).toThrow(AuthenticationError);
  });
});

describe('verifyToken — expiry', () => {
  it('rejects an expired token', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintTokenFromOptions(
      {
        subject: 'd',
        issuer: ISSUER,
        audience: AUDIENCE,
        ttlSeconds: 10,
        nowSeconds: now - 3600,
      },
      SECRET,
    );
    expect(() => verifyToken(token, SECRET, opts({ nowSeconds: now }))).toThrow(TokenExpiredError);
  });

  it('accepts a token within the clock-skew allowance', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintTokenFromOptions(
      { subject: 'd', issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 10, nowSeconds: now - 20 },
      SECRET,
    );
    // Expired 10s ago, but 30s skew allows it.
    expect(() => verifyToken(token, SECRET, opts({ nowSeconds: now }))).not.toThrow();
  });

  it('respects a zero clock skew', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintTokenFromOptions(
      { subject: 'd', issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 10, nowSeconds: now - 11 },
      SECRET,
    );
    expect(() =>
      verifyToken(token, SECRET, opts({ nowSeconds: now, clockSkewSeconds: 0 })),
    ).toThrow(TokenExpiredError);
  });
});

describe('requireScopes', () => {
  const claims = { scope: ['read', 'dashboard'] } as never;

  it('passes when all required scopes are granted', () => {
    expect(() => requireScopes(claims, ['read'])).not.toThrow();
  });

  it('throws AuthorizationError when a scope is missing', () => {
    expect(() => requireScopes(claims, ['read', 'admin'])).toThrow(AuthorizationError);
  });

  it('throws when the token has no scopes and scopes are required', () => {
    expect(() => requireScopes({} as never, ['read'])).toThrow(AuthorizationError);
  });
});

describe('mintToken — structural', () => {
  it('round-trips custom claims', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintToken(
      { iss: ISSUER, aud: AUDIENCE, sub: 's', iat: now, nbf: now, exp: now + 60, role: 'owner' },
      SECRET,
    );
    const claims = verifyToken(token, SECRET, opts());
    expect(claims['role']).toBe('owner');
  });
});
