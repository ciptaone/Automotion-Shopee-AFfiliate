/**
 * Secret redaction primitives.
 *
 * Every log line and every error payload that may transitively contain
 * credentials MUST pass through this module before leaving the process.
 *
 * Design goals:
 *  - Deterministic (no regex backtracking on attacker-controlled input).
 *  - Zero-dependency.
 *  - Never throws: redaction failures must not break logging or request paths.
 */

/** Key names whose values are always fully masked, case-insensitively matched. */
const SENSITIVE_KEY_PATTERN =
  /(?:secret|password|passwd|token|api[_-]?key|apikey|authorization|auth|credential|private[_-]?key|session|cookie|signature|bot[_-]?token|access[_-]?key)/i;

/** Keys matched by the pattern above but safe to keep as a boolean-ish presence flag. */
const PRESENCE_ONLY_KEYS = new Set(['authorized', 'authenticated', 'has_token', 'is_admin']);

export const REDACTED = '[REDACTED]';

/**
 * Known secret *value* shapes that we mask even when they appear in free text
 * (e.g. inside an exception message or a captured URL query string).
 *
 * Each entry: [description, regex]
 */
const SECRET_VALUE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  // Telegram bot tokens: 123456789:AAE... (digits, colon, then 30+ base64url chars)
  ['telegram_bot_token', /\b\d{6,12}:[A-Za-z0-9_-]{25,}\b/g],
  // Facebook/Threads long-lived or short-lived user access tokens (EAAG... / EAAB... style)
  ['meta_access_token', /\bEA[A-Za-z0-9_-]{20,}\b/g],
  // AWS-style access key ids
  ['aws_access_key_id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  // Bearer Authorization header values
  ['bearer_header', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi],
  // JWTs (header.payload.signature)
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  // URL query-string parameters that carry credentials
  [
    'url_credential_query',
    /[?&](access_token|token|api_key|apikey|key|signature|sig|secret|client_secret)=([^&\s"']+)/gi,
  ],
];

/** Maximum string length retained for any redacted field, to keep logs bounded. */
const MAX_VALUE_LENGTH = 4096;

function maskValue(value: string): string {
  if (value.length <= 8) {
    return REDACTED;
  }
  // Keep a short prefix/suffix so operators can correlate without exposing secrets.
  const head = value.slice(0, 4);
  const tail = value.slice(-4);
  return `${head}${REDACTED}${tail}`;
}

/**
 * Scrub well-known secret value shapes out of an arbitrary string.
 * Safe to call on untrusted input; never throws.
 */
export function redactString(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    return input;
  }
  let out = input.slice(0, MAX_VALUE_LENGTH + 1);
  try {
    for (const [, pattern] of SECRET_VALUE_PATTERNS) {
      // Reset lastIndex because these are global regexes reused across calls.
      pattern.lastIndex = 0;
      out = out.replace(pattern, (match, group1?: string) => {
        // For the URL query pattern, mask only the value, keep the param name.
        if (typeof group1 === 'string') {
          return match.replace(/=([^&\s"']+)$/, `=${REDACTED}`);
        }
        return maskValue(match);
      });
    }
  } catch {
    // Redaction must never throw. Fall back to full masking of the field.
    return REDACTED;
  }
  if (out.length > MAX_VALUE_LENGTH) {
    out = `${out.slice(0, MAX_VALUE_LENGTH)}…[TRUNCATED]`;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-redact a JSON-like structure:
 *  - values under sensitive keys are masked (or reduced to a presence flag),
 *  - secret-shaped substrings in all strings are masked,
 *  - depth and breadth are bounded to avoid pathological payloads.
 *
 * Never throws; returns a new structure (input is not mutated).
 */
export function redactDeep(input: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) {
    return '[DEPTH_LIMIT]';
  }

  if (typeof input === 'string') {
    return redactString(input);
  }

  if (typeof input === 'number' || typeof input === 'boolean' || input === null || input === undefined) {
    return input;
  }

  if (typeof input === 'bigint') {
    return input.toString();
  }

  if (typeof input === 'function') {
    return '[FUNCTION]';
  }

  if (input instanceof Date) {
    return input.toISOString();
  }

  if (input instanceof Error) {
    return {
      name: input.name,
      message: redactString(input.message),
      stack: input.stack ? redactString(input.stack) : undefined,
      ...(isPlainObject(input.cause) || input.cause instanceof Error
        ? { cause: redactDeep(input.cause, depth + 1, seen) }
        : {}),
    };
  }

  if (Array.isArray(input)) {
    if (seen.has(input)) {
      return '[CIRCULAR]';
    }
    seen.add(input);
    const bounded = input.slice(0, 200).map((item) => redactDeep(item, depth + 1, seen));
    if (input.length > 200) {
      bounded.push(`[+${input.length - 200} more items]`);
    }
    return bounded;
  }

  if (input instanceof Map) {
    return redactDeep(Object.fromEntries(input), depth, seen);
  }

  if (input instanceof Set) {
    return redactDeep([...input], depth, seen);
  }

  if (input instanceof Uint8Array) {
    return `[BINARY ${input.byteLength} bytes]`;
  }

  if (isPlainObject(input)) {
    if (seen.has(input)) {
      return '[CIRCULAR]';
    }
    seen.add(input);
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, value] of Object.entries(input)) {
      if (count >= 200) {
        out['…'] = '[FIELD_LIMIT]';
        break;
      }
      count += 1;
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        if (PRESENCE_ONLY_KEYS.has(key.toLowerCase())) {
          out[key] = Boolean(value);
        } else if (typeof value === 'string' && value.length > 0) {
          // Fully mask values under sensitive keys. Unlike free-text redaction we
          // keep NO head/tail: the key name already identifies which credential
          // this is, so partial disclosure only adds leak risk.
          out[key] = REDACTED;
        } else {
          out[key] = value == null ? value : REDACTED;
        }
        continue;
      }
      out[key] = redactDeep(value, depth + 1, seen);
    }
    return out;
  }

  // Anything else (Symbols, class instances, etc.) is stringified defensively.
  try {
    return redactString(String(input));
  } catch {
    return '[UNSTRINGIFIABLE]';
  }
}

/** Returns true when a key name denotes a credential/secret (case-insensitive). */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Redact a value based on its key: fully mask sensitive keys, pattern-scrub the
 * rest. Used by publisher adapters when describing request parameters.
 */
export function redactParam(key: string, value: string): string {
  if (isSensitiveKey(key)) {
    return REDACTED;
  }
  return redactString(value);
}

/**
 * Returns true when a config object contains at least one non-empty value for a
 * sensitive key. Used by publisher adapters to decide whether they are
 * "configured" without ever logging the value itself.
 */
export function hasSensitiveValue(obj: Record<string, unknown> | undefined | null): boolean {
  if (!obj) {
    return false;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(key) && typeof value === 'string' && value.trim().length > 0) {
      return true;
    }
  }
  return false;
}
