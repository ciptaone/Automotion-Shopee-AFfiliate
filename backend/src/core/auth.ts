/**
 * APK <-> backend authentication boundary.
 *
 * Implements HS256 JWT minting/verification using only `node:crypto`, so the
 * auth surface has no third-party dependency to audit.
 *
 * Design notes:
 *  - The signing secret comes from `AUTH_JWT_SECRET` and never leaves the backend.
 *  - Tokens carry issuer/audience claims, both verified on every request.
 *  - `exp`, `iat`, `nbf` are all checked with a clock-skew allowance.
 *  - Verification failures throw `AuthenticationError`/`TokenExpiredError`, which
 *    map to HTTP 401/403 in the API layer.
 *
 * The Flutter app holds only the opaque token; it never sees the secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthenticationError, AuthorizationError, TokenExpiredError } from './errors.js';

export interface JwtHeader {
  readonly alg: 'HS256';
  readonly typ: 'JWT';
  readonly kid?: string;
}

export interface JwtClaims {
  readonly iss: string;
  readonly aud: string;
  /** Subject — the APK installation / device id. */
  readonly sub: string;
  /** Issued-at (seconds since epoch). */
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  /** Arbitrary app-specific claims (role, scopes). */
  readonly scope?: readonly string[];
  readonly [key: string]: unknown;
}

export interface MintOptions {
  readonly subject: string;
  readonly issuer: string;
  readonly audience: string;
  readonly ttlSeconds: number;
  readonly scope?: readonly string[];
  /** Override the issuance time (tests only). */
  readonly nowSeconds?: number;
}

export interface VerifyOptions {
  readonly issuer: string;
  readonly audience: string;
  /** Allowed clock skew in seconds. Default 30. */
  readonly clockSkewSeconds?: number;
  readonly nowSeconds?: number;
}

const ALG = 'HS256';
const HEADER_B64 = base64UrlEncode(Buffer.from(JSON.stringify({ alg: ALG, typ: 'JWT' })));

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function sign(secret: string, signingInput: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(signingInput).digest());
}

/** Mint a signed HS256 JWT. */
export function mintToken(claims: JwtClaims, secret: string): string {
  const signingInput = `${HEADER_B64}.${base64UrlEncode(Buffer.from(JSON.stringify(claims)))}`;
  return `${signingInput}.${sign(secret, signingInput)}`;
}

/** Convenience: build claims from options and mint in one call. */
export function mintTokenFromOptions(options: MintOptions, secret: string): string {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const claims: JwtClaims = {
    iss: options.issuer,
    aud: options.audience,
    sub: options.subject,
    iat: now,
    nbf: now,
    exp: now + options.ttlSeconds,
    ...(options.scope ? { scope: options.scope } : {}),
  };
  return mintToken(claims, secret);
}

/** Constant-time string comparison for equal-length buffers. */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Verify a token and return its claims.
 *
 * @throws {TokenExpiredError} when `exp` is in the past
 * @throws {AuthenticationError} for malformed/tampered/wrong-audience tokens
 */
export function verifyToken(token: string, secret: string, options: VerifyOptions): JwtClaims {
  if (typeof token !== 'string' || token.length === 0) {
    throw new AuthenticationError('Missing access token');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AuthenticationError('Malformed token');
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  // 1. Signature first — never trust unverified claims.
  const expected = sign(secret, `${headerPart}.${payloadPart}`);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signaturePart);
  if (!safeEqual(expectedBuf, actualBuf)) {
    throw new AuthenticationError('Invalid token signature');
  }

  // 2. Decode header.
  let header: JwtHeader;
  try {
    header = JSON.parse(base64UrlDecode(headerPart).toString('utf8')) as JwtHeader;
  } catch {
    throw new AuthenticationError('Unreadable token header');
  }
  if (header.alg !== ALG) {
    throw new AuthenticationError('Unsupported token algorithm');
  }

  // 3. Decode claims.
  let claims: JwtClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payloadPart).toString('utf8')) as JwtClaims;
  } catch {
    throw new AuthenticationError('Unreadable token claims');
  }

  // 4. Structural claim checks.
  if (typeof claims.iss !== 'string' || typeof claims.aud !== 'string' || typeof claims.sub !== 'string') {
    throw new AuthenticationError('Token missing required claims');
  }
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
    throw new AuthenticationError('Token missing time claims');
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 30;

  if (claims.nbf !== undefined && typeof claims.nbf === 'number' && now + skew < claims.nbf) {
    throw new AuthenticationError('Token not yet valid');
  }
  if (now - skew >= claims.exp) {
    throw new TokenExpiredError({ expiredAt: new Date(claims.exp * 1000).toISOString() });
  }

  // 5. Issuer / audience binding.
  if (claims.iss !== options.issuer) {
    throw new AuthenticationError('Token issuer mismatch');
  }
  if (claims.aud !== options.audience) {
    throw new AuthenticationError('Token audience mismatch');
  }

  return claims;
}

/**
 * Assert that the caller's token grants every required scope.
 * @throws {AuthorizationError} when a scope is missing.
 */
export function requireScopes(claims: JwtClaims, required: readonly string[]): void {
  const granted = new Set(claims.scope ?? []);
  const missing = required.filter((s) => !granted.has(s));
  if (missing.length > 0) {
    throw new AuthorizationError('Insufficient scope', { missing });
  }
}
