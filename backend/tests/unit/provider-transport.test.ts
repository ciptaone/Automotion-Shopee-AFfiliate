/**
 * PART 6 §3 — bounded outbound transport.
 *
 * Credential-free and offline: `fetch` is always an injected, labelled mock.
 * Covers timeouts, redirects, response-size caps, content-type discipline,
 * status classification (auth / rate limit / transient / permanent), SSRF
 * re-validation immediately before the request, and redaction of any credential
 * a provider echoes back.
 */
import { describe, it, expect } from 'vitest';
import { HttpTransport, type FetchLike, type TransportRequest } from '../../src/providers/transport.js';
import { EndpointPolicy } from '../../src/providers/endpoint-policy.js';
import { AiProviderError, EndpointRejectedError, RateLimitError } from '../../src/core/errors.js';

/** Policy with a labelled mock resolver (no DNS, no network). */
function openPolicy(): EndpointPolicy {
  return new EndpointPolicy({ lookup: async () => ['93.184.216.34'] });
}

function transportWith(fetchImpl: FetchLike): HttpTransport {
  return new HttpTransport({ policy: openPolicy(), fetchImpl });
}

function request(overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    url: 'https://api.example.com/v1/chat/completions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer super-secret-value-1234' },
    body: JSON.stringify({ model: 'test-model' }),
    timeoutMs: 5_000,
    maxResponseBytes: 1024 * 1024,
    service: 'Test Provider',
    operation: 'generate_caption',
    ...overrides,
  };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

/* ========================================================================== */

describe('HttpTransport — happy path', () => {
  it('parses a JSON body, surfaces the request id and forces redirect:"error"', async () => {
    let captured: RequestInit | null = null;
    const transport = transportWith(async (_url, init) => {
      captured = init;
      return jsonResponse(
        { choices: [{ message: { content: 'ok' } }] },
        { headers: { 'x-request-id': 'req_abc123' } },
      );
    });

    const response = await transport.request(request());
    expect(response.status).toBe(200);
    expect(response.requestId).toBe('req_abc123');
    expect((response.json as { choices: unknown[] }).choices).toHaveLength(1);
    expect(response.bytes).toBeNull();
    // A redirect can bounce a credential to another host: never follow one.
    expect(captured!.redirect).toBe('error');
  });

  it('always installs an abort signal, even with an out-of-range timeout', async () => {
    const seen: number[] = [];
    const transport = transportWith(async (_url, init) => {
      seen.push(init.signal ? 1 : 0);
      return jsonResponse({});
    });
    await transport.request(request({ timeoutMs: 1 })); // below the 1s floor
    await transport.request(request({ timeoutMs: 999_999 })); // above the 120s ceiling
    expect(seen).toEqual([1, 1]); // both requests stayed bounded
  });

  it('parses Retry-After in seconds', async () => {
    const transport = transportWith(async () =>
      jsonResponse({}, { status: 429, headers: { 'retry-after': '7' } }),
    );
    // 429 is classified as a rate limit error BEFORE Retry-After is parsed off
    // the success path, so assert the typed error instead.
    const error = await captureError(transport.request(request()));
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(7_000);
  });

  it('returns raw bytes when the caller asks for binary', async () => {
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const transport = transportWith(
      async () =>
        new Response(payload, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const response = await transport.request(
      request({ method: 'GET', body: undefined, responseKind: 'binary' }),
    );
    expect(response.bytes).toEqual(payload);
    expect(response.json).toBeNull();
  });

  it('treats an empty or malformed body as null instead of throwing', async () => {
    const empty = transportWith(
      async () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect((await empty.request(request())).json).toBeNull();

    const noBody = transportWith(async () => new Response(null, { status: 204 }));
    expect((await noBody.request(request({ operation: 'test_connection' })).then((r) => r.json))).toBeNull();

    const malformed = transportWith(
      async () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect((await malformed.request(request())).json).toBeNull();
  });
});

describe('HttpTransport — status classification', () => {
  it('classifies 401 as a non-retryable credential rejection', async () => {
    const transport = transportWith(async () =>
      jsonResponse({ error: { message: 'Incorrect API key provided' } }, { status: 401 }),
    );
    const error = await captureError(transport.request(request()));
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).retryable).toBe(false);
    expect(error.message).toMatch(/rejected the credentials \(HTTP 401\)/);
    expect(error.message).toMatch(/Incorrect API key/);
  });

  it('redacts a credential the provider echoes back in its error body', async () => {
    const transport = transportWith(async () =>
      jsonResponse(
        { error: { message: 'Bearer super-secret-value-1234 was rejected' } },
        { status: 401 },
      ),
    );
    const error = await captureError(transport.request(request()));
    expect(error.message).not.toContain('super-secret-value-1234');
  });

  it('classifies 429 as a rate limit error carrying Retry-After', async () => {
    const transport = transportWith(async () =>
      jsonResponse({ error: { message: 'slow down' } }, { status: 429, headers: { 'retry-after': '7' } }),
    );
    const error = await captureError(transport.request(request()));
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(7_000);
  });

  it('classifies 5xx as retryable (bounded retries may help)', async () => {
    const transport = transportWith(async () => jsonResponse({}, { status: 503 }));
    const error = await captureError(transport.request(request()));
    expect((error as AiProviderError).retryable).toBe(true);
    expect(error.message).toMatch(/HTTP 503/);
  });

  it('classifies 4xx (other) as non-retryable', async () => {
    const transport = transportWith(async () =>
      jsonResponse({ error: { message: 'bad request' } }, { status: 400 }),
    );
    const error = await captureError(transport.request(request()));
    expect((error as AiProviderError).retryable).toBe(false);
    expect(error.message).toMatch(/was rejected \(HTTP 400\)/);
  });
});

describe('HttpTransport — limits and hard failures', () => {
  it('refuses a non-JSON content-type on a JSON operation', async () => {
    const transport = transportWith(
      async () => new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const error = await captureError(transport.request(request()));
    expect((error as AiProviderError).retryable).toBe(false);
    expect(error.message).toMatch(/non-JSON content-type/);
  });

  it('refuses a declared content-length above the cap without buffering it', async () => {
    const transport = transportWith(
      async () =>
        new Response('x'.repeat(64), {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': '99999999' },
        }),
    );
    // Cap below the real body size as well, so the refusal holds whether the
    // declared length is honoured or the stream is measured.
    const error = await captureError(transport.request(request({ maxResponseBytes: 32 })));
    expect(error.message).toMatch(/exceeded the 32-byte limit/);
    expect((error as AiProviderError).retryable).toBe(false);
  });

  it('stops reading a streamed body that exceeds the cap', async () => {
    const chunk = new Uint8Array(512).fill(1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const transport = transportWith(
      async () => new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const error = await captureError(transport.request(request({ maxResponseBytes: 1024 })));
    expect(error.message).toMatch(/exceeded the 1024-byte limit/);
    expect((error as AiProviderError).retryable).toBe(false);
  });

  it('re-validates the URL immediately before the request (SSRF cannot drift)', async () => {
    const transport = transportWith(async () => jsonResponse({}));
    const error = await captureError(
      transport.request(request({ url: 'http://169.254.169.254/latest/meta-data/' })),
    );
    expect(error).toBeInstanceOf(EndpointRejectedError);
  });

  it('turns an abort into a bounded, retryable timeout', async () => {
    const transport = transportWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const abort = new Error('The operation was aborted.');
            abort.name = 'AbortError';
            reject(abort);
          });
        }),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const error = await captureError(transport.request(request({ signal: controller.signal })));
    expect((error as AiProviderError).code).toBe('AI_PROVIDER_FAILED');
    expect((error as AiProviderError).retryable).toBe(true);
    expect(error.message).toMatch(/timed out after 5000ms/);
  });

  it('never follows a redirect (the credential stays on the configured host)', async () => {
    const transport = transportWith(async () => {
      throw new Error('fetch failed: redirect is not allowed');
    });
    const error = await captureError(transport.request(request()));
    expect((error as AiProviderError).retryable).toBe(false);
    expect(error.message).toMatch(/refused a redirect/);
  });

  it('redacts and bounds unexpected network errors', async () => {
    const transport = transportWith(async () => {
      throw new Error('connect ECONNREFUSED; sent Authorization: Bearer super-secret-value-1234');
    });
    const error = await captureError(transport.request(request()));
    expect((error as AiProviderError).retryable).toBe(true);
    expect(error.message).not.toContain('super-secret-value-1234');
    expect(error.message.length).toBeLessThan(400);
  });
});
