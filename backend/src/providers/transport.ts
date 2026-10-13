/**
 * Bounded outbound HTTP transport (Part 6 §3).
 *
 * Every provider request in the backend goes through this module, which
 * enforces the operational limits the brief requires:
 *
 *  - URL re-validation immediately before the request (policy cannot drift),
 *  - hard timeout + cooperative AbortSignal,
 *  - `redirect: 'error'` — a redirect can bounce a credential to another host,
 *  - streamed response-size cap (an oversized body is never buffered),
 *  - content-type discipline (JSON endpoints must answer JSON),
 *  - status classification into typed errors (auth / rate limit / transient /
 *    permanent) that the existing resilience runner already understands,
 *  - redaction of anything that could echo a credential.
 *
 * The `fetch` implementation is injectable so unit tests can drive deterministic
 * mocked responses; those mocks are labelled as mocks in the tests themselves.
 */
import { AiProviderError, RateLimitError } from '../core/errors.js';
import { redactString } from '../core/redact.js';
import { EndpointPolicy } from './endpoint-policy.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TransportRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  /** JSON string, or FormData for multipart uploads (images/edits). */
  readonly body?: string | FormData;
  readonly timeoutMs: number;
  /** Hard cap on the response body (bytes). */
  readonly maxResponseBytes: number;
  /** Cooperative cancellation from the resilience runner. */
  readonly signal?: AbortSignal;
  /** Service label used in errors/logs (provider display name). */
  readonly service: string;
  readonly operation: string;
  /**
   * How to read a 2xx body: `json` (default) parses it, `binary` returns raw
   * bytes — used when downloading a generated image from a provider URL.
   */
  readonly responseKind?: 'json' | 'binary';
}

export interface TransportResponse {
  readonly status: number;
  /** Only the response headers we deliberately surface (never all of them). */
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  /** Parsed JSON body, when the response was JSON. */
  readonly json: unknown;
  /** Raw bytes, when the caller asked for binary (`json` is null). */
  readonly bytes: Uint8Array | null;
  readonly contentType: string;
  readonly latencyMs: number;
}

export interface HttpTransportOptions {
  readonly policy: EndpointPolicy;
  /** Injectable fetch (tests use a labelled mock; production uses global fetch). */
  readonly fetchImpl?: FetchLike;
}

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function safeProviderMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const candidate =
    (typeof record['error'] === 'object' && record['error'] !== null
      ? ((record['error'] as Record<string, unknown>)['message'] ?? record['error'])
      : record['message'] ?? record['error']) ?? null;
  if (typeof candidate !== 'string') return null;
  const firstLine = candidate.split('\n')[0] ?? '';
  // Redact FIRST (a provider may echo the Authorization header back on error),
  // then bound the length so a huge body cannot reach logs or clients.
  return redactString(firstLine).slice(0, 300);
}

export class HttpTransport {
  private readonly policy: EndpointPolicy;
  private readonly fetchImpl: FetchLike;

  constructor(options: HttpTransportOptions) {
    this.policy = options.policy;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    // Re-validate every time: configuration may have been edited since save.
    const endpoint = await this.policy.validate(request.url);

    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    request.signal?.addEventListener('abort', abortFromCaller, { once: true });

    const timeoutMs = Math.min(Math.max(request.timeoutMs, 1_000), 120_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await this.fetchImpl(endpoint.url.toString(), {
        method: request.method,
        headers: { ...request.headers },
        body: request.body,
        redirect: 'error',
        signal: controller.signal,
      });

      const requestId = response.headers.get('x-request-id');
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader ? parseRetryAfter(retryAfterHeader) : null;
      const contentType = response.headers.get('content-type') ?? '';

      if (!response.ok) {
        const detail = await this.readCapped(response, 64 * 1024);
        const message = safeProviderMessage(decodeJson(detail)) ?? `HTTP ${response.status}`;
        throw this.classifyStatus(response.status, request, message, retryAfterMs);
      }

      const isBinary = request.responseKind === 'binary';
      if (isBinary) {
        const bytes = await this.readCapped(response, request.maxResponseBytes);
        return {
          status: response.status,
          requestId,
          retryAfterMs,
          json: null,
          bytes,
          contentType,
          latencyMs: Date.now() - startedAt,
        };
      }

      const raw = await this.readCapped(response, request.maxResponseBytes);
      if (contentType && !/json/i.test(contentType)) {
        throw new AiProviderError(
          `${request.service} ${request.operation} returned a non-JSON content-type (${contentType.slice(0, 60)}).`,
          { service: request.service, operation: request.operation, upstreamCode: 'AI_BAD_CONTENT_TYPE' },
          { retryable: false },
        );
      }
      return {
        status: response.status,
        requestId,
        retryAfterMs,
        json: decodeJson(raw),
        bytes: null,
        contentType,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw this.normalize(error, request, timeoutMs, startedAt);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  /**
   * Stream the body with a hard cap: a provider that answers with gigabytes is
   * cut off instead of being buffered into memory.
   */
  private async readCapped(response: Response, cap: number): Promise<Uint8Array> {
    const declared = response.headers.get('content-length');
    if (declared && Number.parseInt(declared, 10) > cap) {
      throw new AiProviderError(
        `Response exceeded the ${cap}-byte limit (content-length ${declared}).`,
        { service: 'provider', operation: 'http', upstreamCode: 'AI_RESPONSE_TOO_LARGE' },
        { retryable: false },
      );
    }
    if (!response.body) {
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > cap) {
        throw new AiProviderError(
          `Response exceeded the ${cap}-byte limit.`,
          { service: 'provider', operation: 'http', upstreamCode: 'AI_RESPONSE_TOO_LARGE' },
          { retryable: false },
        );
      }
      return buffer;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > cap) {
          await reader.cancel().catch(() => undefined);
          throw new AiProviderError(
            `Response exceeded the ${cap}-byte limit.`,
            { service: 'provider', operation: 'http', upstreamCode: 'AI_RESPONSE_TOO_LARGE' },
            { retryable: false },
          );
        }
        chunks.push(value);
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  private classifyStatus(
    status: number,
    request: TransportRequest,
    message: string,
    retryAfterMs: number | null,
  ): Error {
    if (status === 401 || status === 403) {
      return new AiProviderError(
        `${request.service} rejected the credentials (HTTP ${status}): ${message}`,
        { service: request.service, operation: request.operation, upstreamStatus: status },
        { retryable: false },
      );
    }
    if (status === 429) {
      return new RateLimitError(
        { service: request.service, operation: request.operation, upstreamStatus: status },
        retryAfterMs ?? undefined,
      );
    }
    if (status >= 500) {
      return new AiProviderError(
        `${request.service} ${request.operation} failed upstream (HTTP ${status}): ${message}`,
        { service: request.service, operation: request.operation, upstreamStatus: status },
        { retryable: true },
      );
    }
    return new AiProviderError(
      `${request.service} ${request.operation} was rejected (HTTP ${status}): ${message}`,
      { service: request.service, operation: request.operation, upstreamStatus: status },
      { retryable: false },
    );
  }

  /** Turn fetch/abort/DNS failures into typed, redacted provider errors. */
  private normalize(error: unknown, request: TransportRequest, timeoutMs: number, startedAt: number): Error {
    if (error instanceof AiProviderError || error instanceof RateLimitError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      return new AiProviderError(
        `${request.service} ${request.operation} timed out after ${timeoutMs}ms.`,
        { service: request.service, operation: request.operation, upstreamCode: 'AI_TIMEOUT' },
        { retryable: true },
      );
    }
    if (/redirect/i.test(message)) {
      return new AiProviderError(
        `${request.service} refused a redirect; redirects are not followed to protect credentials.`,
        { service: request.service, operation: request.operation, upstreamCode: 'AI_REDIRECT_BLOCKED' },
        { retryable: false },
      );
    }
    return new AiProviderError(
      `${request.service} ${request.operation} failed after ${Date.now() - startedAt}ms: ${redactString(message.split('\n')[0] ?? '').slice(0, 200)}`,
      { service: request.service, operation: request.operation, upstreamCode: 'AI_NETWORK_ERROR' },
      { retryable: true },
    );
  }
}

/* -------------------------------------------------------------------------- */

function decodeJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return null;
  }
}

function parseRetryAfter(raw: string): number | null {
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 600_000);
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.max(0, Math.min(at - Date.now(), 600_000));
  return null;
}

export { DEFAULT_MAX_RESPONSE_BYTES };
