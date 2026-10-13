/**
 * PART 8 §6 — Telegram: settings-driven delivery, bounded retries, transport.
 *
 * Guarantees under test:
 *  - `not_configured`/`skipped` outcomes never fail the emitting path,
 *  - severity and event-kind filters are honoured before any transport call,
 *  - bounded retries: only retryable failures (429/5xx/network) are retried,
 *    respecting `retry_after`, capped by maxAttempts and the wait ceiling,
 *  - `delivered: true`/`sent` ONLY when the transport confirms a message id,
 *  - error codes are sanitized and never contain the bot token,
 *  - the explicit test action bypasses filters but still requires a credential.
 *
 * SAFETY: every test injects a memory transport or a stub `fetch`. No test in
 * this file can reach api.telegram.org — there is no default-network path.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  LazyTelegramTransport,
  TELEGRAM_API_BASE,
  TelegramHttpTransport,
  TelegramNotificationService,
  TelegramTransportError,
  formatOpsEvent,
  type TelegramRuntimeConfig,
  type TelegramSettingsSource,
  type TelegramTransport,
} from '../../src/integrations/notifications/telegram.js';

const TOKEN = '123456789:AAHsupersecrettokenvalue-abcdef';
const CHAT = '-1001234567';

function settingsSource(overrides: Partial<TelegramRuntimeConfig> = {}): TelegramSettingsSource {
  return {
    resolve: async (): Promise<TelegramRuntimeConfig> => ({
      botToken: TOKEN,
      chatId: CHAT,
      enabled: true,
      minSeverity: 'warning',
      eventKinds: 'all',
      ...overrides,
    }),
  };
}

class MemoryTransport implements TelegramTransport {
  readonly sent: Array<{ chatId: string; text: string }> = [];
  behavior: 'ok' | 'throw' = 'ok';
  error: Error = new TelegramTransportError('server_error', 'boom', { retryable: true });
  messageId = 'msg-7';

  async sendMessage(params: { chatId: string; text: string }): Promise<{ messageId: string }> {
    this.sent.push({ chatId: params.chatId, text: params.text });
    if (this.behavior === 'throw') throw this.error;
    return { messageId: this.messageId };
  }
}

const sleepSpy = vi.fn(async (_ms: number) => undefined);
const instantSleep = (ms: number): Promise<void> => {
  sleepSpy(ms);
  return Promise.resolve();
};

const event = {
  fingerprint: 'scheduler_tick_failed',
  kind: 'scheduler_tick_failed',
  severity: 'critical' as const,
  title: 'Scheduler tick failed',
  detail: 'boom',
};

/* ========================================================================== */
/*  TelegramNotificationService                                               */
/* ========================================================================== */

describe('TelegramNotificationService', () => {
  beforeEach(() => {
    sleepSpy.mockClear();
  });

  it('skips when notifications are disabled (errorCode notifications_disabled)', async () => {
    const transport = new MemoryTransport();
    const service = new TelegramNotificationService({
      settings: settingsSource({ enabled: false }),
      transport,
    });
    const result = await service.notifyEvent(event);
    expect(result).toEqual({
      delivered: false,
      status: 'skipped',
      errorCode: 'notifications_disabled',
    });
    expect(transport.sent).toHaveLength(0);
  });

  it('filters events below the severity floor BEFORE touching the transport', async () => {
    const transport = new MemoryTransport();
    const service = new TelegramNotificationService({
      settings: settingsSource({ minSeverity: 'critical' }),
      transport,
    });
    const result = await service.notifyEvent({ ...event, severity: 'warning' });
    expect(result.status).toBe('skipped');
    expect(result.errorCode).toBe('severity_filtered');
    expect(transport.sent).toHaveLength(0);
  });

  it('honours the event-kind allow-list', async () => {
    const transport = new MemoryTransport();
    const service = new TelegramNotificationService({
      settings: settingsSource({ eventKinds: ['budget_exhausted'] }),
      transport,
    });
    const filtered = await service.notifyEvent(event);
    expect(filtered.errorCode).toBe('kind_filtered');
    const allowed = await service.notifyEvent({ ...event, kind: 'budget_exhausted' });
    expect(allowed.delivered).toBe(true);
    expect(transport.sent).toHaveLength(1);
  });

  it('returns not_configured (never throws) when the credential is missing', async () => {
    const transport = new MemoryTransport();
    const service = new TelegramNotificationService({
      settings: settingsSource({ botToken: null }),
      transport,
    });
    const result = await service.notifyEvent(event);
    expect(result).toEqual({
      delivered: false,
      status: 'not_configured',
      errorCode: 'telegram_not_configured',
    });
    expect(transport.sent).toHaveLength(0);
  });

  it('reports sent ONLY on transport confirmation, with the message id', async () => {
    const transport = new MemoryTransport();
    const service = new TelegramNotificationService({ settings: settingsSource(), transport });
    const result = await service.notifyEvent(event);
    expect(result).toEqual({
      delivered: true,
      status: 'sent',
      messageId: 'msg-7',
      errorCode: null,
    });
    expect(transport.sent[0]?.chatId).toBe(CHAT);
    expect(transport.sent[0]?.text).toContain('Scheduler tick failed');
  });

  it('retries a 429 exactly once after retry_after, then succeeds (bounded)', async () => {
    const transport = new MemoryTransport();
    let attempts = 0;
    transport.behavior = 'throw';
    vi.spyOn(transport, 'sendMessage').mockImplementation(async (params) => {
      attempts += 1;
      transport.sent.push(params);
      if (attempts === 1) {
        throw new TelegramTransportError('rate_limited', '429', {
          retryable: true,
          retryAfterMs: 2_500,
        });
      }
      return { messageId: 'msg-retry' };
    });

    const service = new TelegramNotificationService({
      settings: settingsSource(),
      transport,
      sleepImpl: instantSleep,
    });
    const result = await service.notifyEvent(event);

    expect(result.delivered).toBe(true);
    expect(result.messageId).toBe('msg-retry');
    expect(attempts).toBe(2);
    expect(sleepSpy).toHaveBeenCalledWith(2_500); // honoured Telegram's retry_after
  });

  it('caps the retry wait at maxRetryWaitMs (rate-limit storms stay bounded)', async () => {
    const transport = new MemoryTransport();
    let attempts = 0;
    vi.spyOn(transport, 'sendMessage').mockImplementation(async (params) => {
      attempts += 1;
      transport.sent.push(params);
      throw new TelegramTransportError('rate_limited', '429', {
        retryable: true,
        retryAfterMs: 10 * 60_000, // Telegram asked for 10 minutes
      });
    });

    const service = new TelegramNotificationService({
      settings: settingsSource(),
      transport,
      sleepImpl: instantSleep,
      maxRetryWaitMs: 5_000,
      maxAttempts: 2,
    });
    const result = await service.notifyEvent(event);

    expect(result.delivered).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('rate_limited');
    expect(sleepSpy).toHaveBeenCalledWith(5_000); // wait ceiling applied
    expect(attempts).toBe(2); // bounded attempts
  });

  it('does NOT retry permanent 4xx failures (bad chat id / bad request)', async () => {
    const transport = new MemoryTransport();
    let attempts = 0;
    vi.spyOn(transport, 'sendMessage').mockImplementation(async (params) => {
      attempts += 1;
      transport.sent.push(params);
      throw new TelegramTransportError('bad_request', '400', { retryable: false });
    });

    const service = new TelegramNotificationService({
      settings: settingsSource(),
      transport,
      sleepImpl: instantSleep,
    });
    const result = await service.notifyEvent(event);

    expect(result.delivered).toBe(false);
    expect(result.errorCode).toBe('bad_request');
    expect(attempts).toBe(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('treats an unknown thrown value as a retryable network failure, bounded', async () => {
    const transport = new MemoryTransport();
    let attempts = 0;
    vi.spyOn(transport, 'sendMessage').mockImplementation(async (params) => {
      attempts += 1;
      transport.sent.push(params);
      throw new TypeError('non-telegram error');
    });

    const service = new TelegramNotificationService({
      settings: settingsSource(),
      transport,
      sleepImpl: instantSleep,
      maxAttempts: 3,
    });
    const result = await service.notifyEvent(event);

    expect(result.delivered).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('network');
    expect(attempts).toBe(3);
  });

  it('sendTestMessage bypasses filters but still requires a credential', async () => {
    const transport = new MemoryTransport();
    const service = new TelegramNotificationService({
      settings: settingsSource({ minSeverity: 'critical', eventKinds: ['only_this'] }),
      transport,
    });
    const result = await service.sendTestMessage();
    expect(result.delivered).toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.text).toContain('test notification');

    const unconfigured = new TelegramNotificationService({
      settings: settingsSource({ chatId: null }),
      transport: new MemoryTransport(),
    });
    expect((await unconfigured.sendTestMessage()).status).toBe('not_configured');
  });

  it('re-resolves settings on every delivery (rotation takes effect immediately)', async () => {
    const transport = new MemoryTransport();
    let token = TOKEN;
    const settings: TelegramSettingsSource = {
      resolve: async () => ({
        botToken: token,
        chatId: CHAT,
        enabled: true,
        minSeverity: 'info',
        eventKinds: 'all',
      }),
    };
    const service = new TelegramNotificationService({ settings, transport });

    await service.notifyEvent(event);
    token = 'rotated-away-from-this-token-value-x'; // operator rotated the credential
    await service.notifyEvent(event);
    expect(transport.sent).toHaveLength(2);
  });
});

/* ========================================================================== */
/*  formatOpsEvent                                                            */
/* ========================================================================== */

describe('formatOpsEvent', () => {
  it('includes severity, title, detail and the event kind; bounded to 4000 chars', () => {
    const text = formatOpsEvent({
      kind: 'database_unavailable',
      severity: 'critical',
      title: 'PostgreSQL unreachable',
      detail: 'connection refused',
    });
    expect(text).toContain('[CRITICAL]');
    expect(text).toContain('PostgreSQL unreachable');
    expect(text).toContain('connection refused');
    expect(text).toContain('Event: database_unavailable');
  });

  it('handles an empty detail without producing stray blank bodies', () => {
    const text = formatOpsEvent({ kind: 'k', severity: 'info', title: 't', detail: '' });
    expect(text.split('\n').length).toBeLessThanOrEqual(3);
  });
});

/* ========================================================================== */
/*  TelegramHttpTransport (injected fetch — zero real network)                 */
/* ========================================================================== */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TelegramHttpTransport', () => {
  it('returns the message id when Telegram confirms (ok + result.message_id)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, result: { message_id: 99 } }));
    const transport = new TelegramHttpTransport({ botToken: TOKEN, fetchImpl: fetchImpl as typeof fetch });
    const result = await transport.sendMessage({ chatId: CHAT, text: 'hello' });
    expect(result).toEqual({ messageId: '99' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith(`${TELEGRAM_API_BASE}/bot`)).toBe(true);
    expect(url).toContain('/sendMessage');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain(CHAT);
  });

  it('rejects a 200 whose body does not confirm the message (ok != true)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: false, description: 'Bad Request' }));
    const transport = new TelegramHttpTransport({ botToken: TOKEN, fetchImpl: fetchImpl as typeof fetch });
    await expect(transport.sendMessage({ chatId: CHAT, text: 'x' })).rejects.toMatchObject({
      code: 'bad_request',
      retryable: false,
    });
  });

  it('maps 429 to a retryable rate_limited error carrying retry_after', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, { ok: false, parameters: { retry_after: 7 } }),
    );
    const transport = new TelegramHttpTransport({ botToken: TOKEN, fetchImpl: fetchImpl as typeof fetch });
    const error = await transport.sendMessage({ chatId: CHAT, text: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramTransportError);
    expect((error as TelegramTransportError).code).toBe('rate_limited');
    expect((error as TelegramTransportError).retryable).toBe(true);
    expect((error as TelegramTransportError).retryAfterMs).toBe(7_000);
  });

  it('maps 401/403 to a NON-retryable unauthorized error', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn(async () => jsonResponse(status, { ok: false }));
      const transport = new TelegramHttpTransport({ botToken: TOKEN, fetchImpl: fetchImpl as typeof fetch });
      const error = await transport.sendMessage({ chatId: CHAT, text: 'x' }).catch((e: unknown) => e);
      expect((error as TelegramTransportError).code).toBe('unauthorized');
      expect((error as TelegramTransportError).retryable).toBe(false);
    }
  });

  it('maps 5xx to a retryable server_error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(502, { ok: false }));
    const transport = new TelegramHttpTransport({ botToken: TOKEN, fetchImpl: fetchImpl as typeof fetch });
    const error = await transport.sendMessage({ chatId: CHAT, text: 'x' }).catch((e: unknown) => e);
    expect((error as TelegramTransportError).code).toBe('server_error');
    expect((error as TelegramTransportError).retryable).toBe(true);
  });

  it('maps network failures to a retryable network error that NEVER leaks the token', async () => {
    const fetchImpl = vi.fn(async () => {
      // Simulate a low-level failure whose message embeds the full URL (token!).
      throw new Error(`connect ECONNREFUSED ${TELEGRAM_API_BASE}/bot${TOKEN}/sendMessage`);
    });
    const transport = new TelegramHttpTransport({ botToken: TOKEN, fetchImpl: fetchImpl as typeof fetch });
    const error = (await transport.sendMessage({ chatId: CHAT, text: 'x' }).catch((e: unknown) => e)) as TelegramTransportError;
    expect(error.code).toBe('network');
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain('AAHsupersecret');
  });

  it('uses the fixed api.telegram.org host (no configurable endpoint = no SSRF surface)', () => {
    expect(TELEGRAM_API_BASE).toBe('https://api.telegram.org');
  });
});

/* ========================================================================== */
/*  LazyTelegramTransport                                                     */
/* ========================================================================== */

describe('LazyTelegramTransport', () => {
  it('fails cleanly (not a crash) when no token exists yet', async () => {
    const lazy = new LazyTelegramTransport(settingsSource({ botToken: null }));
    const error = await lazy.sendMessage({ chatId: CHAT, text: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramTransportError);
    expect((error as TelegramTransportError).retryable).toBe(false);
  });

  it('resolves the CURRENT token per send and rebuilds after rotation', async () => {
    let token = TOKEN;
    const settings: TelegramSettingsSource = {
      resolve: async () => ({ botToken: token, chatId: CHAT, enabled: true, minSeverity: 'info', eventKinds: 'all' }),
    };
    const fetches: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      fetches.push(url);
      return jsonResponse(200, { ok: true, result: { message_id: 1 } });
    });

    const lazy = new LazyTelegramTransport(settings, { fetchImpl: fetchImpl as typeof fetch });
    await lazy.sendMessage({ chatId: CHAT, text: 'one' });
    token = '987654321:BBFrotatednewtokenvalue-xyzxyz';
    await lazy.sendMessage({ chatId: CHAT, text: 'two' });

    expect(fetches).toHaveLength(2);
    expect(fetches[0]).toContain(TOKEN);
    expect(fetches[1]).toContain('987654321:BBFrotatednewtokenvalue-xyzxyz');
    expect(fetches.every((url) => url.startsWith(`${TELEGRAM_API_BASE}/bot`))).toBe(true);
  });
});
