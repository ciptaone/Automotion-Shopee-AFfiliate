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
