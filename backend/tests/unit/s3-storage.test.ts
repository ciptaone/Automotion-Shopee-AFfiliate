/**
 * PART 9 §6 — S3-compatible object storage adapter.
 *
 * Fully deterministic: an injected transport records every request and plays
 * canned responses, so no test opens a socket. Covered here:
 *  - SigV4 signing validated against the PUBLISHED AWS signature test-suite
 *    vector (get-vanilla) — a known-answer test, not a self-comparison;
 *  - canonical request shape + URL styles (virtual-host, path-style, public
 *    base URL) and metadata/ACL header handling;
 *  - bounded retries (network/5xx/429 only; 4xx terminal) with injectable,
 *    never-real sleep;
 *  - interrupted upload, missing asset (head => null), public verification;
 *  - deletion idempotency, constructor validation;
 *  - secrecy: the secret key and Authorization header never appear in
 *    messages, error context or provider info.
 */
import { createHash, createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { StorageError } from '../../src/core/errors.js';
import {
  S3ObjectStorage,
  signS3Request,
  sha256Hex,
  type S3HttpRequest,
  type S3HttpResponse,
  type S3HttpTransport,
} from '../../src/integrations/storage/s3-storage.js';

/* -------------------------------------------------------------------------- */
/*  Deterministic fixtures                                                    */
/* -------------------------------------------------------------------------- */

const CONFIG = {
  endpoint: 'https://s3.eu-west-1.amazonaws.com',
  region: 'eu-west-1',
  bucket: 'assets',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'SECRET_EXAMPLE_KEY_DO_NOT_LEAK',
};

const FIXED_NOW = new Date('2026-10-13T10:20:30.000Z'); // amzDate: 20261013T102030Z

type Step = S3HttpResponse | { throws: Error };

function transport(steps: Step[]): { transport: S3HttpTransport; requests: S3HttpRequest[] } {
  const requests: S3HttpRequest[] = [];
  const queue = [...steps];
  return {
    requests,
    transport: {
      async request(request: S3HttpRequest): Promise<S3HttpResponse> {
        requests.push(request);
        const step = queue.shift();
        if (!step) throw new Error('transport exhausted — unexpected extra attempt');
        if ('throws' in step) throw step.throws;
        return step;
      },
    },
  };
}

const ok = (headers: Record<string, string> = {}): S3HttpResponse => ({ status: 200, headers });
const status = (code: number, headers: Record<string, string> = {}): S3HttpResponse => ({
  status: code,
  headers,
});
const networkError = (): Step => ({ throws: new Error('connect ECONNRESET 127.0.0.1:9000') });

function storage(steps: Step[], maxAttempts = 3) {
  const t = transport(steps);
  const sleeps: number[] = [];
  const instance = new S3ObjectStorage(CONFIG, {
    transport: t.transport,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => FIXED_NOW,
    maxAttempts,
  });
  return { instance, requests: t.requests, sleeps };
}

const pngBytes = new TextEncoder().encode('fake-png-bytes');

/* -------------------------------------------------------------------------- */
/*  Known-answer: AWS SigV4 test-suite vector (get-vanilla)                   */
/* -------------------------------------------------------------------------- */

describe('signS3Request — published AWS test-suite vector', () => {
  it('reproduces the official signature for get-vanilla', () => {
    // From the AWS SigV4 test suite (get-vanilla): GET / on
    // example.amazonaws.com, service name "service", secret
    // wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY.
    const payloadHash = sha256Hex(new Uint8Array(0));
    const signed = signS3Request({
      method: 'GET',
      canonicalUri: '/',
      host: 'example.amazonaws.com',
      region: 'us-east-1',
      service: 'service',
      amzDate: '20150830T123600Z',
      payloadSha256: payloadHash,
      extraHeaders: {},
      accessKeyId: 'AKID',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    });
    expect(signed.signature).toBe(
      '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('pins the canonical request shape (headers end with \\n, then a blank line)', () => {
    const signed = signS3Request({
      method: 'GET',
      canonicalUri: '/',
      host: 'example.amazonaws.com',
      region: 'us-east-1',
      service: 'service',
      amzDate: '20150830T123600Z',
      payloadSha256: sha256Hex(new Uint8Array(0)),
      extraHeaders: {},
      accessKeyId: 'AKID',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    });
    expect(signed.canonicalRequest).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com\nx-amz-date:20150830T123600Z\n',
        'host;x-amz-date',
        sha256Hex(new Uint8Array(0)),
      ].join('\n'),
    );
    expect(signed.stringToSign.split('\n')).toHaveLength(4);
    // Independent recomputation of the signing key derivation.
    const hmac = (key: Buffer | string, data: string): Buffer =>
      createHmac('sha256', key).update(data, 'utf8').digest();
    const kSigning = hmac(
      hmac(hmac(hmac('AWS4' + 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830'), 'us-east-1'), 'service'),
      'aws4_request',
    );
    const expected = createHmac('sha256', kSigning)
      .update(signed.stringToSign, 'utf8')
      .digest('hex');
    expect(signed.signature).toBe(expected);
    expect(createHash('sha256').update(signed.canonicalRequest, 'utf8').digest('hex')).toBe(
      signed.stringToSign.split('\n')[3],
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  upload                                                                    */
/* -------------------------------------------------------------------------- */

describe('S3ObjectStorage.upload', () => {
  it('signs and sends a PUT to the virtual-host URL, returning storage metadata', async () => {
    const { instance, requests } = storage([
      { status: 200, headers: { etag: '"abc123"', 'content-length': '14' } },
    ]);

    const meta = await instance.upload({
      key: 'slots/demo/image-1-hero.png',
      bytes: pngBytes,
      contentType: 'image/png',
      publicRead: true,
      metadata: { slot: 'demo slot', position: '1' },
    });

    expect(requests).toHaveLength(1);
    const sent = requests[0]!;
    expect(sent.method).toBe('PUT');
    expect(sent.url).toBe(
      'https://assets.s3.eu-west-1.amazonaws.com/slots/demo/image-1-hero.png',
    );
    // Host is used for signing but left to the HTTP stack.
    expect(Object.keys(sent.headers)).not.toContain('host');
    expect(sent.headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261013\/eu-west-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-position;x-amz-meta-slot, Signature=[0-9a-f]{64}$/,
    );
    expect(sent.headers['x-amz-date']).toBe('20261013T102030Z');
    expect(sent.headers['x-amz-content-sha256']).toBe(sha256Hex(pngBytes));
    expect(sent.headers['content-type']).toBe('image/png');
    expect(sent.headers['x-amz-meta-slot']).toBe('demo%20slot');
    expect(sent.headers['x-amz-meta-position']).toBe('1');
    expect(sent.timeoutMs).toBeGreaterThan(0);

    expect(meta).toEqual({
      key: 'slots/demo/image-1-hero.png',
      sizeBytes: pngBytes.byteLength,
      contentType: 'image/png',
      etag: '"abc123"',
      lastModified: FIXED_NOW.toISOString(),
      publicUrl: 'https://assets.s3.eu-west-1.amazonaws.com/slots/demo/image-1-hero.png',
    });
  });

  it('sends the object ACL only when publicRead is set AND an ACL is configured', async () => {
    const acl = transport([ok(), ok()]);
    const withAcl = new S3ObjectStorage(
      { ...CONFIG, objectAcl: 'public-read' },
      { transport: acl.transport, sleep: async () => undefined, now: () => FIXED_NOW },
    );
    await withAcl.upload({ key: 'a.png', bytes: pngBytes, contentType: 'image/png', publicRead: true });
    await withAcl.upload({ key: 'b.png', bytes: pngBytes, contentType: 'image/png', publicRead: false });
    expect(acl.requests[0]?.headers['x-amz-acl']).toBe('public-read');
    expect(acl.requests[1]?.headers['x-amz-acl']).toBeUndefined();

    // No ACL configured: the bucket policy is the documented default.
    const plain = storage([ok()]);
    await plain.instance.upload({ key: 'c.png', bytes: pngBytes, contentType: 'image/png', publicRead: true });
    expect(plain.requests[0]?.headers['x-amz-acl']).toBeUndefined();
  });

  it('uses path-style URLs when forced, and the configured public base URL', async () => {
    const t = transport([ok(), ok()]);
    const instance = new S3ObjectStorage(
      {
        ...CONFIG,
        endpoint: 'http://127.0.0.1:9000',
        forcePathStyle: true,
        publicBaseUrl: 'https://cdn.example.com/',
      },
      { transport: t.transport, sleep: async () => undefined, now: () => FIXED_NOW },
    );

    const meta = await instance.upload({ key: 'x/y.png', bytes: pngBytes, contentType: 'image/png', publicRead: false });
    expect(t.requests[0]?.url).toBe('http://127.0.0.1:9000/assets/x/y.png');
    expect(meta.publicUrl).toBe('https://cdn.example.com/x/y.png');
    expect(instance.publicUrlFor('/x/y.png')).toBe('https://cdn.example.com/x/y.png');

    // Path-style without a public base derives from the endpoint itself.
    const t2 = transport([ok()]);
    const noBase = new S3ObjectStorage(
      { ...CONFIG, endpoint: 'http://127.0.0.1:9000', forcePathStyle: true },
      { transport: t2.transport, sleep: async () => undefined, now: () => FIXED_NOW },
    );
    expect(noBase.publicUrlFor('k.png')).toBe('http://127.0.0.1:9000/assets/k.png');
  });

  it('rejects a missing contentType before touching the network', async () => {
    const { instance, requests } = storage([ok()]);
    await expect(
      instance.upload({ key: 'a.png', bytes: pngBytes, contentType: ' ', publicRead: false }),
    ).rejects.toThrow(StorageError);
    expect(requests).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Retries (bounded)                                                         */
/* -------------------------------------------------------------------------- */

describe('S3ObjectStorage — bounded retry policy', () => {
  it('recovers from an interrupted upload (network error) on the next attempt', async () => {
    const { instance, requests, sleeps } = storage([networkError(), ok({ etag: '"r1"' })]);
    const meta = await instance.upload({ key: 'k.png', bytes: pngBytes, contentType: 'image/png', publicRead: false });
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([250]);
    expect(meta.etag).toBe('"r1"');
  });

  it('retries a 500 then succeeds', async () => {
    const { instance, requests, sleeps } = storage([status(500), ok({ etag: '"r2"' })]);
    await instance.upload({ key: 'k.png', bytes: pngBytes, contentType: 'image/png', publicRead: false });
    expect(requests).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it('gives up after maxAttempts on persistent 5xx, reporting a retryable error', async () => {
    const { instance, requests } = storage([status(503), status(503), status(503), ok()]);
    const failure = await instance
      .upload({ key: 'k.png', bytes: pngBytes, contentType: 'image/png', publicRead: false })
      .then(() => null, (error: unknown) => error);
    expect(requests).toHaveLength(3);
    expect(failure).toBeInstanceOf(StorageError);
    const error = failure as StorageError;
    expect(error.retryable).toBe(true);
    expect(error.context.upstreamStatus).toBe(503);
    expect(error.message).toBe('S3 upload failed with HTTP 503 after 3 attempt(s).');
  });

  it('never retries a 403 — a denied policy is terminal', async () => {
    const { instance, requests } = storage([status(403), ok()]);
    const failure = await instance
      .upload({ key: 'k.png', bytes: pngBytes, contentType: 'image/png', publicRead: false })
      .then(() => null, (error: unknown) => error);
    expect(requests).toHaveLength(1);
    const error = failure as StorageError;
    expect(error.retryable).toBe(false);
    expect(error.context.upstreamStatus).toBe(403);
  });

  it('retries 429 (rate limit) like a server error', async () => {
    const { instance, requests } = storage([status(429), ok()]);
    await instance.upload({ key: 'k.png', bytes: pngBytes, contentType: 'image/png', publicRead: false });
    expect(requests).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/*  head / verifyPublicAccess / delete                                        */
/* -------------------------------------------------------------------------- */

describe('S3ObjectStorage — reads and deletes', () => {
  it('head returns metadata for an existing object', async () => {
    const { instance } = storage([
      {
        status: 200,
        headers: {
          'content-length': '1234',
          'content-type': 'image/png',
          etag: '"e1"',
          'last-modified': 'Tue, 13 Oct 2026 10:20:30 GMT',
        },
      },
    ]);
    const meta = await instance.head('slots/demo/image-1-hero.png');
    expect(meta).toEqual({
      key: 'slots/demo/image-1-hero.png',
      sizeBytes: 1234,
      contentType: 'image/png',
      etag: '"e1"',
      lastModified: 'Tue, 13 Oct 2026 10:20:30 GMT',
      publicUrl: 'https://assets.s3.eu-west-1.amazonaws.com/slots/demo/image-1-hero.png',
    });
  });

  it('head of a missing asset is null — not an exception', async () => {
    const { instance, requests } = storage([status(404)]);
    expect(await instance.head('missing.png')).toBeNull();
    expect(requests).toHaveLength(1); // 404 is terminal, no retry storm
  });

  it('verifyPublicAccess: 200 true, 403/404 false, 5xx throws retryable', async () => {
    const ok200 = storage([ok()]);
    expect(await ok200.instance.verifyPublicAccess('a.png')).toBe(true);
    expect(ok200.requests[0]?.url).toBe(
      'https://assets.s3.eu-west-1.amazonaws.com/a.png',
    );

    const denied = storage([status(403)]);
    expect(await denied.instance.verifyPublicAccess('a.png')).toBe(false);

    const missing = storage([status(404)]);
    expect(await missing.instance.verifyPublicAccess('a.png')).toBe(false);

    const failing = storage([status(500)]);
    const error = await failing.instance
      .verifyPublicAccess('a.png')
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).retryable).toBe(true);
    expect(failing.requests).toHaveLength(1);

    const offline = storage([networkError()]);
    const netError = await offline.instance
      .verifyPublicAccess('a.png')
      .then(() => null, (e: unknown) => e);
    expect(netError).toBeInstanceOf(StorageError); // transient ≠ inaccessible
    expect((netError as StorageError).message).toContain('network error');
  });

  it('delete is idempotent: 404 counts as already gone', async () => {
    const gone = storage([status(204)]);
    await expect(gone.instance.delete('a.png')).resolves.toBeUndefined();

    const wasMissing = storage([status(404)]);
    await expect(wasMissing.instance.delete('a.png')).resolves.toBeUndefined();

    const broken = storage([status(500), status(500), status(500)]);
    const error = await broken.instance.delete('a.png').then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(broken.requests).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */
/*  Configuration + secrecy                                                   */
/* -------------------------------------------------------------------------- */

describe('S3ObjectStorage — configuration validation', () => {
  it('refuses an incomplete credential set with key names only', () => {
    try {
      new S3ObjectStorage({ ...CONFIG, secretAccessKey: '' });
      expect.unreachable('constructor must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      const storageError = error as StorageError;
      expect(storageError.retryable).toBe(false);
      expect(storageError.message).toContain('S3_SECRET_ACCESS_KEY');
      expect(storageError.message).not.toContain('AKIDEXAMPLE');
    }
  });

  it('refuses a non-http(s) endpoint', () => {
    expect(() => new S3ObjectStorage({ ...CONFIG, endpoint: 'ftp://files.example.com' })).toThrow(
      StorageError,
    );
  });

  it('reports live provider info without any credential material', () => {
    const { instance } = storage([ok()]);
    const detail = `${instance.info.detail} ${JSON.stringify(instance.info)}`;
    expect(instance.info.kind).toBe('live');
    expect(instance.info.ready).toBe(true);
    expect(detail).not.toContain(CONFIG.secretAccessKey);
    expect(detail).not.toContain(CONFIG.accessKeyId);
    expect(detail).toContain('bucket=assets');
  });

  it('never leaks the secret or the Authorization header through thrown errors', async () => {
    const { instance } = storage([status(403)]);
    const error = await instance
      .upload({ key: 'k.png', bytes: pngBytes, contentType: 'image/png', publicRead: false })
      .then(() => null, (e: unknown) => e as StorageError);

    const surfaces = [
      error!.message,
      JSON.stringify(error!.context),
      String(error!.stack ?? ''),
      JSON.stringify(error!.toLogObject()),
    ].join(' ');
    expect(surfaces).not.toContain(CONFIG.secretAccessKey);
    expect(surfaces).not.toContain('AWS4-HMAC-SHA256 Credential');
    expect(surfaces).not.toContain('Signature=');
  });
});
