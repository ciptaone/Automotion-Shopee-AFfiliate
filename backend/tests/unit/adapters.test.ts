import { describe, it, expect } from 'vitest';
import { MemoryObjectStorage } from '../../src/integrations/storage/object-storage.js';
import { StorageError, IntegrationNotConfiguredError } from '../../src/core/errors.js';
import {
  FacebookPagePublisher,
  ThreadsPublisher,
  StubGraphTransport,
  clampThreadsText,
} from '../../src/integrations/publishing/publishers.js';
import {
  MemoryTelegramTransport,
  TelegramNotifier,
  formatNotification,
} from '../../src/integrations/notifications/telegram.js';

/* ========================================================================== */
/*  Object storage                                                             */
/* ========================================================================== */

describe('MemoryObjectStorage', () => {
  it('uploads and returns metadata', async () => {
    const storage = new MemoryObjectStorage({ publicBaseUrl: 'https://cdn.example.com' });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const meta = await storage.upload({
      key: 'images/a.png',
      bytes,
      contentType: 'image/png',
      publicRead: true,
    });

    expect(meta.key).toBe('images/a.png');
    expect(meta.sizeBytes).toBe(4);
    expect(meta.contentType).toBe('image/png');
    expect(meta.publicUrl).toBe('https://cdn.example.com/images/a.png');
    expect(meta.etag).toBeTruthy();
  });

  it('retrieves metadata via head()', async () => {
    const storage = new MemoryObjectStorage();
    await storage.upload({ key: 'k', bytes: new Uint8Array([9]), contentType: 'image/png', publicRead: true });
    const head = await storage.head('k');
    expect(head?.key).toBe('k');
    expect(await storage.head('missing')).toBeNull();
  });

  it('verifies public access for a public object', async () => {
    const storage = new MemoryObjectStorage();
    await storage.upload({ key: 'pub', bytes: new Uint8Array([1]), contentType: 'image/png', publicRead: true });
    expect(await storage.verifyPublicAccess('pub')).toBe(true);
  });

  it('returns false for a non-public object', async () => {
    const storage = new MemoryObjectStorage();
    await storage.upload({ key: 'priv', bytes: new Uint8Array([1]), contentType: 'image/png', publicRead: false });
    expect(await storage.verifyPublicAccess('priv')).toBe(false);
  });

  it('returns false when verifying a missing key', async () => {
    const storage = new MemoryObjectStorage();
    expect(await storage.verifyPublicAccess('nope')).toBe(false);
  });

  it('deletes an object', async () => {
    const storage = new MemoryObjectStorage();
    await storage.upload({ key: 'x', bytes: new Uint8Array([1]), contentType: 'image/png', publicRead: true });
    await storage.delete('x');
    expect(await storage.head('x')).toBeNull();
    expect(storage.size).toBe(0);
  });

  it('rejects an upload missing contentType', async () => {
    const storage = new MemoryObjectStorage();
    await expect(
      storage.upload({ key: 'k', bytes: new Uint8Array([1]), contentType: '', publicRead: true }),
    ).rejects.toThrow(StorageError);
  });

  it('simulates a deterministic upload failure for the flagged key', async () => {
    const storage = new MemoryObjectStorage({ failKeySubstring: 'fail' });
    await expect(
      storage.upload({ key: 'images/fail.png', bytes: new Uint8Array([1]), contentType: 'image/png', publicRead: true }),
    ).rejects.toThrow(StorageError);

    // A non-matching key still succeeds.
    await expect(
      storage.upload({ key: 'images/ok.png', bytes: new Uint8Array([1]), contentType: 'image/png', publicRead: true }),
    ).resolves.toBeTruthy();
  });

  it('simulates a public-access denial for the flagged key', async () => {
    const storage = new MemoryObjectStorage({ denyPublicAccessKeySubstring: 'private' });
    await storage.upload({ key: 'images/private.png', bytes: new Uint8Array([1]), contentType: 'image/png', publicRead: true });
    expect(await storage.verifyPublicAccess('images/private.png')).toBe(false);
  });

  it('logs operations without throwing', async () => {
    const storage = new MemoryObjectStorage();
    await storage.upload({ key: 'a', bytes: new Uint8Array([1]), contentType: 'image/png', publicRead: true });
    await storage.head('a');
    await storage.delete('a');
    expect(storage.operationLog.map((o) => o.op)).toEqual(['upload', 'head', 'delete']);
  });
});

/* ========================================================================== */
/*  Facebook Page publisher                                                    */
/* ========================================================================== */

describe('FacebookPagePublisher', () => {
  const configured = {
    apiBase: 'https://graph.facebook.com',
    apiVersion: 'v23.0',
    pageId: 'PAGE123',
    pageAccessToken: 'EAABsecretsecretsecretsecretsecret99',
  };

  it('is not configured when credentials are missing', () => {
    const p = new FacebookPagePublisher(
      { apiBase: 'https://graph.facebook.com', apiVersion: 'v23.0' },
      new StubGraphTransport({ id: 'x' }),
    );
    expect(p.isConfigured()).toBe(false);
    expect(p.info.detail).toContain('disabled');
  });

  it('throws IntegrationNotConfiguredError when publishing unconfigured', async () => {
    const p = new FacebookPagePublisher(
      { apiBase: 'https://graph.facebook.com', apiVersion: 'v23.0' },
      new StubGraphTransport({ id: 'x' }),
    );
    await expect(
      p.publish({ idempotencyKey: 'k', caption: 'c', imageUrl: 'https://img', dryRun: false }),
    ).rejects.toThrow(IntegrationNotConfiguredError);
  });

  it('never publishes live even when configured (Part 1 latch)', async () => {
    const transport = new StubGraphTransport({ id: 'real-post' });
    const p = new FacebookPagePublisher(configured, transport);
    const result = await p.publish({
      idempotencyKey: 'slot-1',
      caption: 'hello',
      imageUrl: 'https://cdn/img.png',
      dryRun: false,
    });

    expect(result.dryRun).toBe(true);
    expect(result.success).toBe(true);
    expect(result.postId).toBe('dryrun_slot-1');
    // The stub transport must NOT have been invoked.
    expect(transport.lastRequest).toBeNull();
  });

  it('builds a correct Graph API /feed request', () => {
    const p = new FacebookPagePublisher(configured, new StubGraphTransport({}));
    const req = p.buildFeedRequest({
      idempotencyKey: 'slot-9',
      caption: 'Test caption',
      imageUrl: 'https://cdn/img.png',
      link: 'https://s.shopee.co.id/abc',
      dryRun: true,
    });

    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://graph.facebook.com/v23.0/PAGE123/feed');
    expect(req.params['message']).toBe('Test caption');
    expect(req.params['link']).toBe('https://s.shopee.co.id/abc');
    expect(req.params['access_token']).toBe(configured.pageAccessToken);
    expect(req.params['fb_client_request_id']).toBe('slot-9');
  });

  it('omits `link` when not supplied', () => {
    const p = new FacebookPagePublisher(configured, new StubGraphTransport({}));
    const req = p.buildFeedRequest({ idempotencyKey: 'k', caption: 'c', imageUrl: 'https://i', dryRun: true });
    expect(req.params['link']).toBeUndefined();
  });

  it('redacts the access token in describeRequest output', () => {
    const p = new FacebookPagePublisher(configured, new StubGraphTransport({}));
    const described = p.describeRequest({
      idempotencyKey: 'k',
      caption: 'c',
      imageUrl: 'https://i',
      dryRun: true,
    });
    const serialized = JSON.stringify(described);
    expect(serialized).not.toContain(configured.pageAccessToken);
    expect(serialized).toContain('access_token');
  });

  it('surfaces the stubbed response when live is explicitly allowed', async () => {
    const transport = new StubGraphTransport({ id: 'POST_123' });
    const p = new FacebookPagePublisher({ ...configured, allowLive: true }, transport);
    const result = await p.publish({
      idempotencyKey: 'k',
      caption: 'c',
      imageUrl: 'https://i',
      dryRun: false,
    });
    expect(result.postId).toBe('POST_123');
    expect(result.dryRun).toBe(false);
  });

  it('throws a typed error when the live response lacks an id', async () => {
    const transport = new StubGraphTransport({});
    const p = new FacebookPagePublisher({ ...configured, allowLive: true }, transport);
    await expect(
      p.publish({ idempotencyKey: 'k', caption: 'c', imageUrl: 'https://i', dryRun: false }),
    ).rejects.toThrow(/did not include a post id/);
  });

  it('returns null quota (unknown) rather than inventing a number', async () => {
    const p = new FacebookPagePublisher(configured, new StubGraphTransport({}));
    expect(await p.getQuota()).toBeNull();
  });
});

/* ========================================================================== */
/*  Threads publisher                                                          */
/* ========================================================================== */

describe('ThreadsPublisher', () => {
  const configured = {
    apiBase: 'https://graph.threads.net',
    apiVersion: 'v1.0',
    userId: 'USER456',
    accessToken: 'THQVJsecretsecretsecretsecretsecretxx',
  };

  it('is not configured when credentials are missing', () => {
    const p = new ThreadsPublisher(
      { apiBase: 'https://graph.threads.net', apiVersion: 'v1.0' },
      new StubGraphTransport({}),
    );
    expect(p.isConfigured()).toBe(false);
  });

  it('never publishes live even when configured (Part 1 latch)', async () => {
    const transport = new StubGraphTransport({ id: 'x' });
    const p = new ThreadsPublisher(configured, transport);
    const result = await p.publish({
      idempotencyKey: 'k',
      caption: 'c',
      imageUrl: 'https://cdn/img.png',
      dryRun: false,
    });
    expect(result.dryRun).toBe(true);
    expect(transport.lastRequest).toBeNull();
  });

  it('builds a correct media-container request', () => {
    const p = new ThreadsPublisher(configured, new StubGraphTransport({}));
    const req = p.buildContainerRequest({
      idempotencyKey: 'k',
      caption: 'Caption text',
      imageUrl: 'https://cdn/img.png',
      dryRun: true,
    });

    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://graph.threads.net/v1.0/USER456/threads');
    expect(req.params['media_type']).toBe('IMAGE');
    expect(req.params['image_url']).toBe('https://cdn/img.png');
    expect(req.params['access_token']).toBe(configured.accessToken);
    expect(req.params['text']).toContain('Caption text');
  });

  it('builds a correct publish request', () => {
    const p = new ThreadsPublisher(configured, new StubGraphTransport({}));
    const req = p.buildPublishRequest('CONTAINER_1');
    expect(req.url).toBe('https://graph.threads.net/v1.0/USER456/threads_publish');
    expect(req.params['creation_id']).toBe('CONTAINER_1');
  });

  it('performs the two-step flow when live is explicitly allowed', async () => {
    const transport = new StubGraphTransport({ id: 'CONTAINER_1' });
    transport.execute = async (req) =>
      req.url.endsWith('/threads_publish') ? { id: 'MEDIA_9' } : { id: 'CONTAINER_1' };
    const p = new ThreadsPublisher({ ...configured, allowLive: true }, transport);

    const result = await p.publish({
      idempotencyKey: 'k',
      caption: 'c',
      imageUrl: 'https://cdn/img.png',
      dryRun: false,
    });
    expect(result.postId).toBe('MEDIA_9');
    expect(result.dryRun).toBe(false);
  });

  it('redacts the token in describeRequest', () => {
    const p = new ThreadsPublisher(configured, new StubGraphTransport({}));
    const described = p.describeRequest({
      idempotencyKey: 'k',
      caption: 'c',
      imageUrl: 'https://i',
      dryRun: true,
    });
    expect(JSON.stringify(described)).not.toContain(configured.accessToken);
  });
});

describe('clampThreadsText', () => {
  it('leaves short text unchanged', () => {
    expect(clampThreadsText('short')).toBe('short');
  });

  it('appends the link when absent', () => {
    const out = clampThreadsText('caption', 'https://aff.link/x');
    expect(out).toContain('https://aff.link/x');
  });

  it('does not duplicate an existing link', () => {
    const out = clampThreadsText('see https://aff.link/x now', 'https://aff.link/x');
    expect(out.match(/https:\/\/aff\.link\/x/g)).toHaveLength(1);
  });

  it('truncates text beyond 500 characters with an ellipsis', () => {
    const long = 'a'.repeat(600);
    const out = clampThreadsText(long, 'https://aff.link/x');
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith('…')).toBe(true);
  });
});

/* ========================================================================== */
/*  Telegram notifier                                                          */
/* ========================================================================== */

describe('TelegramNotifier', () => {
  it('runs in mock mode when unconfigured', () => {
    const n = new TelegramNotifier({}, new MemoryTelegramTransport());
    expect(n.isConfigured()).toBe(false);
    expect(n.info.kind).toBe('mock');
  });

  it('captures a message in mock mode without throwing', async () => {
    const transport = new MemoryTelegramTransport();
    const n = new TelegramNotifier({}, transport);
    const result = await n.send({
      kind: 'publish_success',
      dedupeKey: 'slot-1',
      title: 'Published',
      lines: ['Facebook: ok'],
    });
    expect(result.delivered).toBe(true);
    expect(result.transport).toBe('mock');
    expect(transport.sent).toHaveLength(1);
  });

  it('suppresses duplicate deliveries by dedupeKey', async () => {
    const transport = new MemoryTelegramTransport();
    const n = new TelegramNotifier({}, transport);
    const req = { kind: 'publish_success' as const, dedupeKey: 'dup', title: 'T', lines: [] };

    const first = await n.send(req);
    const second = await n.send(req);

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.delivered).toBe(false);
    expect(transport.sent).toHaveLength(1);
  });

  it('treats different dedupe keys as distinct', async () => {
    const transport = new MemoryTelegramTransport();
    const n = new TelegramNotifier({}, transport);
    await n.send({ kind: 'publish_success', dedupeKey: 'a', title: 'A', lines: [] });
    await n.send({ kind: 'publish_success', dedupeKey: 'b', title: 'B', lines: [] });
    expect(transport.sent).toHaveLength(2);
  });

  it('does not send live even when credentials are present (Part 1 latch)', async () => {
    const transport = new MemoryTelegramTransport();
    const n = new TelegramNotifier(
      { botToken: '123:AAAAsecretsecretsecretsecretxx', chatId: '999' },
      transport,
    );
    const result = await n.send({ kind: 'publish_failure', dedupeKey: 'k', title: 'T', lines: [] });
    // allowLive defaults to false => mock transport used.
    expect(result.transport).toBe('mock');
  });

  it('evicts the oldest key beyond capacity', async () => {
    const transport = new MemoryTelegramTransport();
    const n = new TelegramNotifier({}, transport, );
    const small = new TelegramNotifier({ dedupeCapacity: 2 } as never, transport);
    void n;
    await small.send({ kind: 'publish_success', dedupeKey: '1', title: 'a', lines: [] });
    await small.send({ kind: 'publish_success', dedupeKey: '2', title: 'b', lines: [] });
    await small.send({ kind: 'publish_success', dedupeKey: '3', title: 'c', lines: [] });
    // '1' has been evicted, so re-sending it is allowed again.
    expect(small.isDuplicate('1')).toBe(false);
    expect(small.isDuplicate('3')).toBe(true);
  });

  it('surfaces a retryable error when the live transport fails', async () => {
    const transport = new MemoryTelegramTransport();
    transport.failNext = true;
    const n = new TelegramNotifier(
      { botToken: '123:AAAAsecretsecretsecretsecretxx', chatId: '999', allowLive: true } as never,
      transport,
    );
    await expect(
      n.send({ kind: 'publish_failure', dedupeKey: 'k', title: 'T', lines: [] }),
    ).rejects.toThrow(/Telegram send failed/);
  });
});

describe('formatNotification', () => {
  it('includes title, lines, error detail and links', () => {
    const text = formatNotification({
      kind: 'publish_partial_success',
      dedupeKey: 'k',
      title: 'Partial publish',
      lines: ['Facebook: OK', 'Threads: FAILED'],
      errorDetail: 'Threads rate limit',
      links: [
        { label: 'Product', url: 'https://s.shopee.co.id/abc' },
        { label: 'Post', url: 'https://facebook.com/123' },
      ],
    });

    expect(text).toContain('Partial publish');
    expect(text).toContain('Facebook: OK');
    expect(text).toContain('Threads: FAILED');
    expect(text).toContain('Threads rate limit');
    expect(text).toContain('https://s.shopee.co.id/abc');
    expect(text).toContain('https://facebook.com/123');
  });

  it('omits empty lines', () => {
    const text = formatNotification({
      kind: 'health_alert',
      dedupeKey: 'k',
      title: 'T',
      lines: ['', '   ', 'real'],
    });
    expect(text.split('\n').filter((l) => l.trim().length === 0)).toHaveLength(1); // title gap only
    expect(text).toContain('real');
  });

  it('is plain text (no HTML/Markdown markup injection)', () => {
    const text = formatNotification({
      kind: 'publish_failure',
      dedupeKey: 'k',
      title: '<b>bold</b>',
      lines: [],
    });
    expect(text).toContain('<b>bold</b>');
  });
});
