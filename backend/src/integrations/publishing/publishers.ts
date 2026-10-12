/**
 * Facebook Page and Threads publishing adapters (Part 1).
 *
 * Both adapters:
 *  - implement the shared `Publisher` contract,
 *  - refuse to perform any live network call unless fully configured,
 *  - honor `dryRun` so the whole pipeline can be exercised credential-free,
 *  - build HTTP request descriptions (method/url/params) WITHOUT embedding the
 *    access token, so nothing secret can leak into logs or evidence files.
 *
 * Part 1 does NOT perform live publication. The real Graph API calls are
 * documented in docs/implementation/part-01-integration-feasibility.md and are
 * gated behind a `LivePublishBlockedError` latch. Contract tests assert the
 * request shape using a captured transport, never the network.
 */
import {
  FacebookPublishError,
  IntegrationNotConfiguredError,
  ThreadsPublishError,
  UpstreamServiceError,
} from '../../core/errors.js';
import { redactParam } from '../../core/redact.js';
import type {
  ProviderInfo,
  PublishRequest,
  PublishResult,
  Publisher,
  PublishingQuota,
} from '../../contracts/index.js';

/* -------------------------------------------------------------------------- */
/*  Transport abstraction (captured in tests, real HTTP in a later part)      */
/* -------------------------------------------------------------------------- */

export interface CapturedRequest {
  readonly method: 'POST' | 'GET';
  readonly url: string;
  /** Form/query params. The access token is present but redacted for storage. */
  readonly params: Record<string, string>;
}

export interface GraphTransport {
  /** Perform the call and return the parsed JSON body. */
  execute(request: CapturedRequest): Promise<Record<string, unknown>>;
}

/**
 * Transport that performs NO network I/O and returns a fixed fixture.
 * Part 1 default: keeps every test offline and cost-free.
 */
export class StubGraphTransport implements GraphTransport {
  constructor(private readonly fixture: Record<string, unknown>) {}
  async execute(request: CapturedRequest): Promise<Record<string, unknown>> {
    // Record the attempt so tests can assert on the exact request shape.
    this.lastRequest = request;
    return this.fixture;
  }
  lastRequest: CapturedRequest | null = null;
}

/* -------------------------------------------------------------------------- */
/*  Facebook Page publisher                                                   */
/* -------------------------------------------------------------------------- */

export interface FacebookPageConfig {
  readonly apiBase: string;
  readonly apiVersion: string;
  readonly pageId?: string;
  readonly pageAccessToken?: string;
  /** When true, allow live calls. Part 1 forces this to false in production paths. */
  readonly allowLive?: boolean;
}

export class FacebookPagePublisher implements Publisher {
  readonly provider = 'facebook_page' as const;
  readonly info: ProviderInfo;

  private readonly config: FacebookPageConfig;
  private readonly transport: GraphTransport;

  constructor(config: FacebookPageConfig, transport: GraphTransport) {
    this.config = config;
    this.transport = transport;
    this.info = {
      name: 'facebook_page',
      kind: this.isConfigured() ? 'live' : 'mock',
      ready: false,
      detail: this.isConfigured()
        ? 'Credentials present. Live publication remains gated off in Part 1.'
        : 'Not configured — publisher disabled until FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN are set.',
    };
  }

  isConfigured(): boolean {
    return Boolean(this.config.pageId && this.config.pageAccessToken);
  }

  /**
   * Build the Graph API request for a Page feed post WITHOUT executing it.
   * Exposed for contract tests and for the feasibility report.
   */
  buildFeedRequest(request: PublishRequest): CapturedRequest {
    if (!this.config.pageId || !this.config.pageAccessToken) {
      throw new IntegrationNotConfiguredError('facebook_page', 'publish');
    }
    const url = `${this.config.apiBase}/${this.config.apiVersion}/${this.config.pageId}/feed`;
    const params: Record<string, string> = {
      message: request.caption,
      access_token: this.config.pageAccessToken,
    };
    if (request.link) {
      params['link'] = request.link;
    }
    // Idempotency: callers must not double-post. We surface the key in params so
    // a future server-side dedupe layer can consume it.
    params['fb_client_request_id'] = request.idempotencyKey;
    return { method: 'POST', url, params };
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    if (!this.isConfigured()) {
      throw new IntegrationNotConfiguredError('facebook_page', 'publish');
    }
    if (request.dryRun || !this.config.allowLive) {
      // Safety latch: Part 1 never publishes for real.
      return this.dryRunResult(request);
    }

    const graphRequest = this.buildFeedRequest(request);
    let response: Record<string, unknown>;
    try {
      response = await this.transport.execute(graphRequest);
    } catch (cause) {
      throw new FacebookPublishError(
        'Facebook Graph API call failed',
        { service: 'facebook', operation: 'page_feed', upstreamStatus: 502 },
        { retryable: true, cause },
      );
    }

    const postId = typeof response['id'] === 'string' ? response['id'] : null;
    if (!postId) {
      throw new FacebookPublishError(
        'Facebook response did not include a post id',
        { service: 'facebook', operation: 'page_feed', upstreamCode: 'MISSING_POST_ID' },
        { retryable: false },
      );
    }

    return {
      success: true,
      provider: 'facebook_page',
      postId,
      permalink: `https://www.facebook.com/${postId}`,
      providerStatus: 'published',
      dryRun: false,
      publishedAt: new Date().toISOString(),
    };
  }

  private dryRunResult(request: PublishRequest): PublishResult {
    return {
      success: true,
      provider: 'facebook_page',
      postId: `dryrun_${request.idempotencyKey}`,
      permalink: null,
      providerStatus: 'dry_run_not_published',
      dryRun: true,
      publishedAt: new Date().toISOString(),
    };
  }

  async getQuota(): Promise<PublishingQuota | null> {
    // Facebook does not expose a single simple publishing-quota endpoint for
    // Page feed posts the way Threads does. Return null (unknown) rather than
    // inventing a number.
    return null;
  }

  /** Log-safe description of the request this adapter would send. */
  describeRequest(request: PublishRequest): Record<string, unknown> {
    const built = this.buildFeedRequest(request);
    return {
      method: built.method,
      url: built.url,
      paramKeys: Object.keys(built.params).sort(),
      // Values are redacted so no token can appear in evidence.
      redactedParams: Object.fromEntries(
        Object.entries(built.params).map(([k, v]) => [k, redactParam(k, v)]),
      ),
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Threads publisher                                                         */
/* -------------------------------------------------------------------------- */

export interface ThreadsConfig {
  readonly apiBase: string;
  readonly apiVersion: string;
  readonly userId?: string;
  readonly accessToken?: string;
  readonly allowLive?: boolean;
}

export class ThreadsPublisher implements Publisher {
  readonly provider = 'threads' as const;
  readonly info: ProviderInfo;

  private readonly config: ThreadsConfig;
  private readonly transport: GraphTransport;

  constructor(config: ThreadsConfig, transport: GraphTransport) {
    this.config = config;
    this.transport = transport;
    this.info = {
      name: 'threads',
      kind: this.isConfigured() ? 'live' : 'mock',
      ready: false,
      detail: this.isConfigured()
        ? 'Credentials present. Live publication remains gated off in Part 1.'
        : 'Not configured — publisher disabled until THREADS_USER_ID and THREADS_ACCESS_TOKEN are set.',
    };
  }

  isConfigured(): boolean {
    return Boolean(this.config.userId && this.config.accessToken);
  }

  /**
   * Two-step publish per the official Threads API:
   *   1. POST /{user-id}/threads         -> media container id
   *   2. POST /{user-id}/threads_publish -> published media id
   * Both request shapes are exposed for contract tests.
   */
  buildContainerRequest(request: PublishRequest): CapturedRequest {
    if (!this.config.userId || !this.config.accessToken) {
      throw new IntegrationNotConfiguredError('threads', 'create_container');
    }
    const url = `${this.config.apiBase}/${this.config.apiVersion}/${this.config.userId}/threads`;
    return {
      method: 'POST',
      url,
      params: {
        media_type: 'IMAGE',
        image_url: request.imageUrl,
        // Threads counts emojis as UTF-8 bytes and caps text at 500 characters.
        text: clampThreadsText(request.caption, request.link),
        access_token: this.config.accessToken,
      },
    };
  }

  buildPublishRequest(containerId: string): CapturedRequest {
    if (!this.config.userId || !this.config.accessToken) {
      throw new IntegrationNotConfiguredError('threads', 'publish_container');
    }
    const url = `${this.config.apiBase}/${this.config.apiVersion}/${this.config.userId}/threads_publish`;
    return {
      method: 'POST',
      url,
      params: {
        creation_id: containerId,
        access_token: this.config.accessToken,
      },
    };
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    if (!this.isConfigured()) {
      throw new IntegrationNotConfiguredError('threads', 'publish');
    }
    if (request.dryRun || !this.config.allowLive) {
      return {
        success: true,
        provider: 'threads',
        postId: `dryrun_${request.idempotencyKey}`,
        permalink: null,
        providerStatus: 'dry_run_not_published',
        dryRun: true,
        publishedAt: new Date().toISOString(),
      };
    }

    // Step 1: create container.
    let container: Record<string, unknown>;
    try {
      container = await this.transport.execute(this.buildContainerRequest(request));
    } catch (cause) {
      throw new ThreadsPublishError(
        'Threads media container creation failed',
        { service: 'threads', operation: 'create_container', upstreamStatus: 502 },
        { retryable: true, cause },
      );
    }
    const containerId = container['id'];
    if (typeof containerId !== 'string' && typeof containerId !== 'number') {
      throw new ThreadsPublishError(
        'Threads container response did not include an id',
        { service: 'threads', operation: 'create_container', upstreamCode: 'MISSING_CONTAINER_ID' },
        { retryable: false },
      );
    }

    // Step 2: publish container.
    let published: Record<string, unknown>;
    try {
      published = await this.transport.execute(this.buildPublishRequest(String(containerId)));
    } catch (cause) {
      throw new ThreadsPublishError(
        'Threads container publish failed',
        { service: 'threads', operation: 'publish_container', upstreamStatus: 502 },
        { retryable: true, cause },
      );
    }
    const mediaId = published['id'];
    if (typeof mediaId !== 'string' && typeof mediaId !== 'number') {
      throw new ThreadsPublishError(
        'Threads publish response did not include a media id',
        { service: 'threads', operation: 'publish_container', upstreamCode: 'MISSING_MEDIA_ID' },
        { retryable: false },
      );
    }

    return {
      success: true,
      provider: 'threads',
      postId: String(mediaId),
      permalink: null,
      providerStatus: String(mediaId),
      dryRun: false,
      publishedAt: new Date().toISOString(),
    };
  }

  async getQuota(): Promise<PublishingQuota | null> {
    // Quota is fetched live via /{user-id}/threads_publishing_limit (250 posts /
    // 24h). Not queried in Part 1 — return null rather than fabricate a value.
    return null;
  }

  describeRequest(request: PublishRequest): Record<string, unknown> {
    const built = this.buildContainerRequest(request);
    return {
      method: built.method,
      url: built.url,
      paramKeys: Object.keys(built.params).sort(),
      redactedParams: Object.fromEntries(
        Object.entries(built.params).map(([k, v]) => [k, redactParam(k, v)]),
      ),
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Threads caption clamping                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Threads caps post text at 500 characters (emojis count as UTF-8 bytes).
 * If the caption already contains a link, Threads uses the first URL as the
 * link preview, so we append the affiliate link only when absent.
 */
export function clampThreadsText(caption: string, link?: string): string {
  let text = caption ?? '';
  if (link && !text.includes(link)) {
    text = `${text.trimEnd()}\n\n${link}`;
  }
  if (text.length <= 500) {
    return text;
  }
  return `${text.slice(0, 497).trimEnd()}…`;
}

/* -------------------------------------------------------------------------- */
/*  Factory                                                                  */
/* -------------------------------------------------------------------------- */

export function assertPublisherUsable(publisher: Publisher): void {
  if (publisher.info.kind === 'mock') {
    throw new UpstreamServiceError({
      code: 'INTEGRATION_NOT_CONFIGURED',
      message: `Publisher "${publisher.provider}" is running in mock mode.`,
      expose: true,
      retryable: false,
      context: { service: publisher.provider },
    });
  }
}
