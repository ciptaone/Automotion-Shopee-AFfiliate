/**
 * Telegram Bot API notifier (Part 1).
 *
 * Implements the `Notifier` contract with two interchangeable transports:
 *  - `MemoryTelegramTransport`: in-process, records messages, no network.
 *  - A live transport is intentionally NOT wired in Part 1. Real sends are gated
 *    behind configuration + an explicit allow-live flag, so automated tests can
 *    never send a real Telegram message.
 *
 * Duplicate suppression: a notification whose `dedupeKey` has already been
 * delivered is skipped and reported as `deduped: true`. Keys are held in memory
 * with a bounded LRU so a long-running process cannot grow without limit.
 *
 * Retry: transient transport failures are surfaced as `TelegramNotificationError`
 * with `retryable: true`; the caller (job runner) owns the backoff policy.
 */
import { TelegramNotificationError } from '../../core/errors.js';
import type {
  NotificationKind,
  NotificationRequest,
  NotificationResult,
  Notifier,
  ProviderInfo,
} from '../../contracts/index.js';
import type { EventDeliveryResult, EventNotifier, OpsSeverity } from '../../ops/ops-events.js';

export interface TelegramTransport {
  /**
   * Send a message. Returns the Telegram `message_id` on success.
   * Implementations MUST NOT log the bot token.
   */
  sendMessage(params: {
    chatId: string;
    text: string;
    parseMode?: 'HTML' | 'MarkdownV2';
  }): Promise<{ messageId: string }>;
}

/** In-memory transport: captures messages for assertions, never hits the network. */
export class MemoryTelegramTransport implements TelegramTransport {
  readonly sent: { chatId: string; text: string }[] = [];
  /** Set to true to simulate a transient network failure once. */
  failNext = false;

  async sendMessage(params: { chatId: string; text: string }): Promise<{ messageId: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated transient telegram failure');
    }
    this.sent.push({ chatId: params.chatId, text: params.text });
    return { messageId: String(1000 + this.sent.length) };
  }
}

export interface TelegramNotifierConfig {
  readonly botToken?: string;
  readonly chatId?: string;
  readonly allowLive?: boolean;
  /** Maximum retained dedupe keys. */
  readonly dedupeCapacity?: number;
}

export class TelegramNotifier implements Notifier {
  readonly info: ProviderInfo;

  private readonly config: TelegramNotifierConfig;
  private readonly transport: TelegramTransport;
  private readonly seen = new Set<string>();
  private readonly dedupeCapacity: number;

  constructor(config: TelegramNotifierConfig, transport: TelegramTransport) {
    this.config = config;
    this.transport = transport;
    this.dedupeCapacity = config.dedupeCapacity ?? 1000;
    this.info = {
      name: 'telegram',
      kind: this.isConfigured() ? 'live' : 'mock',
      ready: this.isConfigured(),
      detail: this.isConfigured()
        ? 'Telegram credentials present; live sends still require allowLive.'
        : 'Not configured — notifications are captured in-memory only.',
    };
  }

  isConfigured(): boolean {
    return Boolean(this.config.botToken && this.config.chatId);
  }

  /** True when this key has already been delivered. */
  isDuplicate(dedupeKey: string): boolean {
    return this.seen.has(dedupeKey);
  }

  async send(request: NotificationRequest): Promise<NotificationResult> {
    // Duplicate suppression happens BEFORE any transport interaction.
    if (this.seen.has(request.dedupeKey)) {
      return { delivered: false, deduped: true, messageId: null, transport: 'mock' };
    }

    const text = formatNotification(request);

    if (!this.isConfigured() || !this.config.allowLive) {
      // Mock path: still record the dedupe key so repeated sends are suppressed.
      this.remember(request.dedupeKey);
      if (this.transport instanceof MemoryTelegramTransport) {
        await this.transport.sendMessage({ chatId: this.config.chatId ?? 'mock-chat', text });
      }
      return { delivered: true, deduped: false, messageId: null, transport: 'mock' };
    }

    // Live path (requires explicit allowLive; not exercised by Part 1 tests).
    try {
      const result = await this.transport.sendMessage({
        chatId: this.config.chatId as string,
        text,
      });
      this.remember(request.dedupeKey);
      return {
        delivered: true,
        deduped: false,
        messageId: result.messageId,
        transport: 'telegram',
      };
    } catch (cause) {
      throw new TelegramNotificationError(
        'Telegram send failed',
        { service: 'telegram', operation: 'sendMessage', upstreamStatus: 502 },
        { retryable: true, cause },
      );
    }
  }

  private remember(dedupeKey: string): void {
    this.seen.add(dedupeKey);
    // Bounded LRU-ish eviction: drop oldest insertions beyond capacity.
    if (this.seen.size > this.dedupeCapacity) {
      const first = this.seen.values().next();
      if (!first.done) {
        this.seen.delete(first.value);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Message formatting                                                        */
/* -------------------------------------------------------------------------- */

const KIND_ICON: Record<NotificationKind, string> = {
  publish_success: '✅',
  publish_partial_success: '🟡',
  publish_failure: '❌',
  feed_import: '📥',
  health_alert: '🚨',
};

/**
 * Build the plain-text body. Plain text (not HTML/Markdown) avoids any escaping
 * footguns and keeps the message safe against caption-injected markup.
 *
 * The affiliate product link and the published-post link are always surfaced
 * when present, per the locked notification requirements.
 */
export function formatNotification(request: NotificationRequest): string {
  const lines: string[] = [];
  lines.push(`${KIND_ICON[request.kind] ?? '•'} ${request.title}`);
  // Visual gap between the header and the body.
  lines.push('');

  for (const line of request.lines) {
    if (line.trim().length > 0) {
      lines.push(line);
    }
  }

  if (request.errorDetail && request.errorDetail.trim().length > 0) {
    lines.push('');
    lines.push('Detail error:');
    lines.push(request.errorDetail);
  }

  if (request.links && request.links.length > 0) {
    lines.push('');
    lines.push('Link:');
    for (const link of request.links) {
      lines.push(`${link.label}: ${link.url}`);
    }
  }

  return lines.join('\n').slice(0, 4000);
}

/* -------------------------------------------------------------------------- */
/*  PART 8 §6 — live transport, ops-event formatting, delivery service         */
/* -------------------------------------------------------------------------- */

const OPS_SEVERITY_RANK: Readonly<Record<OpsSeverity, number>> = { info: 0, warning: 1, critical: 2 };

const OPS_SEVERITY_ICON: Readonly<Record<OpsSeverity, string>> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
};

/**
 * Transport-level failure with a SANITIZED machine code. The error message
 * never contains the bot token, the request URL (which embeds the token) or a
 * raw Telegram response body — only the classification below.
 */
export class TelegramTransportError extends Error {
  readonly code: 'rate_limited' | 'timeout' | 'unauthorized' | 'bad_request' | 'server_error' | 'network';
  readonly retryable: boolean;
  /** Suggested wait before a retry (Telegram `retry_after`), when reported. */
  readonly retryAfterMs: number | null;

  constructor(
    code: TelegramTransportError['code'],
    message: string,
    options: { retryable: boolean; retryAfterMs?: number | null },
  ) {
    super(message);
    this.name = 'TelegramTransportError';
    this.code = code;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** BASE URL is a hard-coded constant: no SSRF surface, no configurable host. */
export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Shape of a Bot API response — fields are read defensively (`unknown`). */
interface TelegramApiResponse {
  ok?: unknown;
  result?: { message_id?: unknown };
  parameters?: { retry_after?: unknown };
  description?: unknown;
}

export interface TelegramHttpTransportOptions {
  readonly botToken: string;
  /** Per-request timeout. Default 10s. */
  readonly timeoutMs?: number;
  /** Injectable fetch for deterministic tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * PART 8 §6: the real Telegram Bot API transport.
 *
 * Safety properties:
 *  - The host is the fixed `api.telegram.org` — the token only ever travels to
 *    Telegram itself; there is no configurable endpoint (no SSRF surface).
 *  - `delivered` is reported only when Telegram answers HTTP 200 with
 *    `ok: true` and a `result.message_id` — never on a hopeful guess.
 *  - 429 responses surface `retry_after` as `retryAfterMs` so the caller can
 *    perform bounded, well-mannered retries.
 *  - Error messages and codes are sanitized; the token (which is part of the
 *    URL path) is never included in any thrown error or log line.
 */
export class TelegramHttpTransport implements TelegramTransport {
  private readonly botToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelegramHttpTransportOptions) {
    this.botToken = options.botToken;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async sendMessage(params: {
    chatId: string;
    text: string;
    parseMode?: 'HTML' | 'MarkdownV2';
  }): Promise<{ messageId: string }> {
    const url = `${TELEGRAM_API_BASE}/bot${this.botToken}/sendMessage`;
    const payload: Record<string, unknown> = { chat_id: params.chatId, text: params.text };
    if (params.parseMode) payload.parse_mode = params.parseMode;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Network failure or timeout. The cause may embed the URL — never reuse it.
      throw new TelegramTransportError('network', 'Telegram request failed (network error or timeout).', {
        retryable: true,
      });
    }

    let body: TelegramApiResponse | null = null;
    try {
      body = (await response.json()) as TelegramApiResponse;
    } catch {
      body = null;
    }

    if (response.status === 429) {
      const retryAfterRaw = body?.parameters?.retry_after;
      const retryAfterMs =
        typeof retryAfterRaw === 'number' && Number.isFinite(retryAfterRaw)
          ? Math.max(1_000, retryAfterRaw * 1000)
          : 30_000;
      throw new TelegramTransportError('rate_limited', 'Telegram rate limit hit (429).', {
        retryable: true,
        retryAfterMs,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new TelegramTransportError(
        'unauthorized',
        'Telegram rejected the bot token (401/403). Check the stored credential.',
        { retryable: false },
      );
    }
    if (response.status >= 500) {
      throw new TelegramTransportError('server_error', `Telegram server error (HTTP ${response.status}).`, {
        retryable: true,
      });
    }
    if (!response.ok) {
      // Other 4xx (bad chat id, malformed payload): permanent, bounded message.
      throw new TelegramTransportError(
        'bad_request',
        `Telegram rejected the request (HTTP ${response.status}).`,
        { retryable: false },
      );
    }

    const messageId = body?.result?.message_id;
    if (body?.ok !== true || messageId === null || messageId === undefined) {
      throw new TelegramTransportError(
        'bad_request',
        'Telegram answered 200 but did not confirm the message (ok != true).',
        { retryable: false },
      );
    }
    return { messageId: String(messageId) };
  }
}

/**
 * Transport that resolves the CURRENT credential per send: the bot token may
 * live in the encrypted secret store, come from the environment, or be rotated
 * at runtime — this wrapper builds (or rebuilds) the underlying HTTP transport
 * from whatever the settings source reports right now, and fails cleanly when
 * no token exists yet.
 */
export class LazyTelegramTransport implements TelegramTransport {
  private readonly settings: TelegramSettingsSource;
  private readonly options: { timeoutMs?: number; fetchImpl?: typeof fetch };
  private delegate: TelegramHttpTransport | null = null;
  private boundToken: string | null = null;

  constructor(
    settings: TelegramSettingsSource,
    options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
  ) {
    this.settings = settings;
    this.options = options;
  }

  async sendMessage(params: { chatId: string; text: string }): Promise<{ messageId: string }> {
    const config = await this.settings.resolve();
    if (!config.botToken) {
      // Never pretend: the notifier maps this to not_configured/failed.
      throw new TelegramTransportError('bad_request', 'Telegram bot token is not configured.', {
        retryable: false,
      });
    }
    if (!this.delegate || this.boundToken !== config.botToken) {
      this.delegate = new TelegramHttpTransport({
        botToken: config.botToken,
        ...this.options,
      });
      this.boundToken = config.botToken;
    }
    return this.delegate.sendMessage(params);
  }
}

/** Bounded, plain-text ops-event body (secrets already redacted upstream). */
export function formatOpsEvent(event: {
  kind: string;
  severity: OpsSeverity;
  title: string;
  detail: string;
}): string {
  const lines = [`${OPS_SEVERITY_ICON[event.severity]} [${event.severity.toUpperCase()}] ${event.title}`];
  if (event.detail.trim().length > 0) {
    lines.push('');
    lines.push(event.detail);
  }
  lines.push('');
  lines.push(`Event: ${event.kind}`);
  return lines.join('\n').slice(0, 4000);
}

/** Non-sensitive runtime configuration, resolved fresh for every delivery. */
export interface TelegramRuntimeConfig {
  readonly botToken: string | null;
  readonly chatId: string | null;
  readonly enabled: boolean;
  readonly minSeverity: OpsSeverity;
  /** `'all'` or an explicit allow-list of event kinds. */
  readonly eventKinds: readonly string[] | 'all';
}

/** Reads current settings + (decrypted) secrets at send time. */
export interface TelegramSettingsSource {
  resolve(): Promise<TelegramRuntimeConfig>;
}

export interface TelegramNotificationServiceDeps {
  readonly settings: TelegramSettingsSource;
  /** Live HTTP transport, or a memory transport in tests/dev. */
  readonly transport: TelegramTransport;
  /** Bounded retries for retryable failures (rate limit, 5xx, network). */
  readonly maxAttempts?: number;
  /** Injectable sleep for deterministic retry tests. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
  /** Upper bound for a single retry wait (rate-limit storms stay bounded). */
  readonly maxRetryWaitMs?: number;
}

/**
 * PART 8 §6: delivers OPERATIONAL events to Telegram (implemented for the
 * `EventNotifier` interface the `OpsMonitor` consumes).
 *
 * Safeguards (verified by tests):
 *  - Settings and secrets are resolved per delivery; nothing is cached, so a
 *    credential update or disable takes effect immediately.
 *  - `not_configured` and `skipped` are returned as-is — a disabled or
 *    unconfigured Telegram never fails the emitting code path.
 *  - Bounded retries: only retryable failures (429 with `retry_after`, 5xx,
 *    network/timeout) are retried, at most `maxAttempts` attempts total, with
 *    the wait capped at `maxRetryWaitMs`.
 *  - The delivery result reflects the transport EXACTLY: `sent` only when
 *    Telegram confirmed; failures return sanitized codes, never raw bodies.
 *  - No recursion: this class emits no events of its own.
 */
export class TelegramNotificationService implements EventNotifier {
  private readonly settings: TelegramSettingsSource;
  private readonly transport: TelegramTransport;
  private readonly maxAttempts: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly maxRetryWaitMs: number;

  constructor(deps: TelegramNotificationServiceDeps) {
    this.settings = deps.settings;
    this.transport = deps.transport;
    this.maxAttempts = Math.max(1, deps.maxAttempts ?? 3);
    this.sleepImpl = deps.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetryWaitMs = Math.max(1_000, deps.maxRetryWaitMs ?? 60_000);
  }

  async notifyEvent(event: {
    fingerprint: string;
    kind: string;
    severity: OpsSeverity;
    title: string;
    detail: string;
  }): Promise<EventDeliveryResult> {
    const config = await this.settings.resolve();

    if (!config.enabled) {
      return { delivered: false, status: 'skipped', errorCode: 'notifications_disabled' };
    }
    if (OPS_SEVERITY_RANK[event.severity] < OPS_SEVERITY_RANK[config.minSeverity]) {
      return { delivered: false, status: 'skipped', errorCode: 'severity_filtered' };
    }
    if (config.eventKinds !== 'all' && !config.eventKinds.includes(event.kind)) {
      return { delivered: false, status: 'skipped', errorCode: 'kind_filtered' };
    }
    if (!config.botToken || !config.chatId) {
      return { delivered: false, status: 'not_configured', errorCode: 'telegram_not_configured' };
    }

    return this.sendBounded(config.chatId, formatOpsEvent(event));
  }

  /**
   * §6 explicit, user-triggered test delivery. Bypasses the severity/kind
   * filters (an operator asking "does this work?" must see the real answer)
   * but requires a complete credential. It never reports `sent` unless
   * Telegram confirmed the message.
   */
  async sendTestMessage(): Promise<EventDeliveryResult> {
    const config = await this.settings.resolve();
    if (!config.botToken || !config.chatId) {
      return { delivered: false, status: 'not_configured', errorCode: 'telegram_not_configured' };
    }
    const text = formatOpsEvent({
      kind: 'test_notification',
      severity: 'info',
      title: 'Shopee Affiliate Autopilot — test notification',
      detail: 'Telegram delivery is configured correctly. This message was triggered manually.',
    });
    return this.sendBounded(config.chatId, text);
  }

  /** Bounded retry loop shared by notifications and the test action. */
  private async sendBounded(chatId: string, text: string): Promise<EventDeliveryResult> {
    let lastCode = 'unknown';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const result = await this.transport.sendMessage({ chatId, text });
        return { delivered: true, status: 'sent', messageId: result.messageId, errorCode: null };
      } catch (error) {
        const transportError =
          error instanceof TelegramTransportError
            ? error
            : new TelegramTransportError('network', 'Telegram transport failed.', { retryable: true });
        lastCode = transportError.code;
        const isLastAttempt = attempt >= this.maxAttempts;
        if (!transportError.retryable || isLastAttempt) {
          return { delivered: false, status: 'failed', messageId: null, errorCode: lastCode };
        }
        const waitMs = Math.min(
          transportError.retryAfterMs ?? 2 ** attempt * 1_000,
          this.maxRetryWaitMs,
        );
        await this.sleepImpl(waitMs);
      }
    }
    return { delivered: false, status: 'failed', messageId: null, errorCode: lastCode };
  }
}
