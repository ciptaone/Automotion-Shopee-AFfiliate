/**
 * HTTP API surface (Part 1).
 *
 * Endpoints:
 *  - GET    /health                  Public. Readiness + dependency status. No secrets.
 *  - GET    /v1/meta/integrations    Public. Per-service configuration + health (no secrets).
 *  - POST   /v1/auth/token           Public. Exchange an install credential for a JWT.
 *  - GET    /v1/me                   Authenticated. Echoes verified token claims.
 *  - GET    /v1/scheduler/status     Authenticated. Current slot schedule.
 *  - GET    /v1/queue/jobs           Authenticated. Recent job records.
 *  - GET    /v1/automation/status    Authenticated. Dashboard aggregate (state, slots,
 *                                    publication counters, recent activity).
 *  - GET    /v1/settings             Authenticated. Automation settings + constraints.
 *  - PUT    /v1/settings             Authenticated (control). Validate + persist settings.
 *  - POST   /v1/automation/control   Authenticated (control). start | pause | resume.
 *  - GET    /v1/content/preview      Authenticated. REAL pipeline preview when the slot
 *                                    has a record; Part 2 fixture fallback otherwise.
 *  - GET    /v1/history/publishes    Authenticated. FIXTURE publishing history.
 *  - POST   /v1/catalog/import       Authenticated (control). Import a CSV/XLSX feed.
 *  - GET    /v1/catalog              Authenticated. List catalog products (filterable).
 *  - GET    /v1/catalog/categories   Authenticated. Categories from the actual catalog.
 *  - GET    /v1/catalog/status       Authenticated. Catalog totals + recent imports.
 *  - POST   /v1/pipeline/run         Authenticated (control). Generate content for a slot.
 *  - GET    /v1/pipeline/slots       Authenticated. List pipeline slot records.
 *
 * PART 8 (operational readiness & notifications):
 *  - GET    /ready                   Public. Readiness gate (200/503): PostgreSQL
 *                                    reachability + schema consistency only; no leaks.
 *  - GET    /v1/ops/health           Authenticated. Component health (cached provider
 *                                    probes only — never a paid API call) + diagnostics.
 *  - GET    /v1/ops/metrics          Authenticated. Low-cardinality scheduler/queue/
 *                                    generation counters and ages.
 *  - GET    /v1/ops/preflight        Authenticated (control). Blockers + warnings for
 *                                    intended operation (read-only; enables nothing).
 *  - GET    /v1/notifications/telegram        Authenticated. Notification settings +
 *                                    credential PRESENCE (values never returned).
 *  - PUT    /v1/notifications/telegram        Authenticated (control). Enable/disable,
 *                                    severity floor, event-kind filter.
 *  - PUT    /v1/notifications/telegram/secret Authenticated (control). Store the bot
 *                                    token + chat id (write-only, AES-256-GCM).
 *  - DELETE /v1/notifications/telegram/secret Authenticated (control). Remove them.
 *  - POST   /v1/notifications/telegram/test   Authenticated (control). Explicit,
 *                                    rate-limited test send; reports confirmed delivery only.
 *
 * PART 6 (custom AI providers + usage):
 *  - GET    /v1/providers            Authenticated. Providers + capabilities + readiness
 *                                    + masked secret metadata (never a credential).
 *  - POST   /v1/providers            Authenticated (control). Create a provider.
 *  - PUT    /v1/providers/:id        Authenticated (control). Edit a provider.
 *  - DELETE /v1/providers/:id        Authenticated (control). Delete a deselected provider.
 *  - GET    /v1/providers/selection  Authenticated. Independent text/image selections.
 *  - PUT    /v1/providers/selection  Authenticated (control). Set text/image selections.
 *  - PUT    /v1/providers/:id/secret Authenticated (control). Store/replace a credential
 *                                    (write-only; the value is never returned).
 *  - DELETE /v1/providers/:id/secret Authenticated (control). Remove a credential.
 *  - POST   /v1/providers/:id/test/connection | /test/text | /test/image
 *                                    Authenticated (control). Bounded tests; never publish.
 *  - GET    /v1/usage/summary        Authenticated. Generation usage + budget state.
 *
 * Security invariants:
 *  - No endpoint ever returns a secret value; health/integration output is built
 *    from `describeIntegrationStatus`, which only emits key NAMES + booleans.
 *  - Authenticated routes verify the HS256 JWT, its issuer, audience, expiry and
 *    required scopes.
 *  - CORS is an explicit allow-list derived from CORS_ORIGINS.
 *  - User-supplied provider URLs are validated by the SSRF endpoint policy BEFORE
 *    they are stored and again before every outbound request; responses are
 *    bounded and redirects are refused.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import type { AppContainer } from '../app/container.js';
import { verifyToken, requireScopes, type JwtClaims } from '../core/auth.js';
import { AppError, AuthenticationError, ShopeeFeedError } from '../core/errors.js';
import { redactDeep } from '../core/redact.js';
import { InMemoryJobQueue } from '../queue/job-queue.js';
import { CONTENT_JOB_KIND } from '../scheduler/content-scheduler.js';
import { POSTING_WINDOWS } from '../scheduler/slots.js';
import {
  TELEGRAM_SECRET_BOT_TOKEN,
  TELEGRAM_SECRET_CHAT_ID,
} from '../ops/ops-service.js';
import { evaluatePreflight, preflightImageReferenceDeclared } from '../ops/preflight.js';
import { withIntegrationHealth } from './integration-health.js';
import { describeAutomationStatus } from '../automation/status.js';
import {
  buildContentPreview,
  buildPublishHistory,
  FIXTURE_CONTENT_NOTE,
  FIXTURE_HISTORY_NOTE,
} from '../automation/fixtures.js';
import { buildPipelinePreview } from '../automation/pipeline-preview.js';
import {
  AUTOMATION_ACTIONS,
  DEFAULT_AUTOMATION_SETTINGS,
  IMAGE_COUNT_POLICIES,
  SELECTION_MODES,
  parseSettingsPatch,
  SETTINGS_CONSTRAINTS,
} from '../settings/automation-settings.js';

const START_TIME = new Date();

/* -------------------------------------------------------------------------- */
/*  Request schemas                                                           */
/* -------------------------------------------------------------------------- */

const tokenRequestSchema = z.object({
  /** Opaque install credential. In Part 1 this is the shared APP_INSTALL_KEY. */
  installKey: z.string().trim().min(1).max(512),
  deviceLabel: z.string().trim().min(1).max(255).optional(),
});

/** Settings patch: only provided keys are validated; ranges are enforced on merge. */
const settingsPatchSchema = z
  .object({
    intervalMinutes: z.number().int().optional(),
    maxSlotsPerDay: z.number().int().optional(),
    facebookEnabled: z.boolean().optional(),
    threadsEnabled: z.boolean().optional(),
    imageCountPolicy: z.enum(IMAGE_COUNT_POLICIES).optional(),
    telegramNotificationsEnabled: z.boolean().optional(),
    /** PART 8 §6: severity floor + optional event-kind allow-list. */
    notificationMinSeverity: z.enum(['info', 'warning', 'critical']).optional(),
    notificationEventKinds: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    selectionMode: z.enum(SELECTION_MODES).optional(),
    selectedCategoryIds: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
    /** PART 6 §7: 3 or 4 posts per Asia/Jakarta day (the four WIB windows). */
    dailyPostTarget: z.number().int().min(3).max(4).optional(),
    /** PART 6 §10: optional generation budgets in USD (null clears the limit). */
    dailyBudgetUsd: z.number().nonnegative().max(1_000_000).nullable().optional(),
    monthlyBudgetUsd: z.number().nonnegative().max(1_000_000).nullable().optional(),
  })
  .strict();

const controlRequestSchema = z.object({ action: z.enum(AUTOMATION_ACTIONS) }).strict();

/** PART 8 §6: notification settings (non-sensitive fields only — no credentials). */
const notificationSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    minSeverity: z.enum(['info', 'warning', 'critical']).optional(),
    eventKinds: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  })
  .strict();

/** PART 8 §6: Telegram credential write (write-only; the values are never echoed). */
const telegramSecretSchema = z
  .object({
    botToken: z
      .string()
      .trim()
      .min(20)
      .max(200)
      .refine((value) => !/\s/.test(value), 'bot token must not contain whitespace'),
    chatId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((value) => !/\s/.test(value), 'chat id must not contain whitespace'),
  })
  .strict();

/** Feed import: raw file bytes as base64 (multipart upload is a later part). */
const catalogImportSchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    /** Base64-encoded file content (CSV or XLSX bytes). */
    contentBase64: z.string().min(1).max(40_000_000),
    format: z.enum(['csv', 'xlsx']).optional(),
    defaultMarketplace: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const catalogListQuerySchema = z.object({
  category: z.string().trim().min(1).max(64).optional(),
  eligible: z.enum(['true', 'false']).optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

const pipelineRunSchema = z
  .object({
    /** Explicit slot key; defaults to the scheduler's next slot. */
    slot: z.string().trim().min(1).max(64).optional(),
    /** Explicit regeneration of derived artifacts (keeps reservation + count). */
    regenerate: z.boolean().optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Auth helper                                                               */
/* -------------------------------------------------------------------------- */

function extractBearer(header: string | undefined): string {
  if (!header || !header.startsWith('Bearer ')) {
    throw new AuthenticationError('Expected "Authorization: Bearer <token>"');
  }
  const token = header.slice(7).trim();
  if (token.length === 0) {
    throw new AuthenticationError('Empty bearer token');
  }
  return token;
}

function authenticate(container: AppContainer, request: FastifyRequest): void {
  const token = extractBearer(request.headers.authorization);
  const claims = verifyToken(token, container.env.AUTH_JWT_SECRET, {
    issuer: container.env.AUTH_JWT_ISSUER,
    audience: container.env.AUTH_JWT_AUDIENCE,
  });
  // Attach for handlers.
  (request as FastifyRequest & { claims?: JwtClaims }).claims = claims;
}

function claimsOf(request: FastifyRequest): JwtClaims {
  const claims = (request as FastifyRequest & { claims?: JwtClaims }).claims;
  if (!claims) {
    throw new AuthenticationError('No verified claims on request');
  }
  return claims;
}

/* -------------------------------------------------------------------------- */
/*  Server factory                                                            */
/* -------------------------------------------------------------------------- */

/** PART 9 §5/§8: server-level runtime hooks (readiness during shutdown). */
export interface BuildServerOptions {
  /** True once a shutdown signal has begun processing (readiness => 503). */
  readonly isShuttingDown?: () => boolean;
}

export async function buildServer(
  container: AppContainer,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // We use our own redacting logger.
    trustProxy: true,
    bodyLimit: 25 * 1024 * 1024, // allow up to ~25MB feed uploads
    // PART 9 §9: bounded connection/request lifetimes. Connections that never
    // send a request are dropped after 15 s; a single request may not exceed
    // 10 minutes (long enough for a full pipeline run, short enough that a
    // stuck handler cannot pin a worker forever).
    connectionTimeout: 15_000,
    requestTimeout: 600_000,
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin / server-to-server requests have no Origin header.
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, container.corsOrigins.includes(origin));
    },
    methods: ['GET', 'POST', 'PUT'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });

  /* --- Global error handler: never leak secrets or stack traces --- */
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      container.logger.warn(
        { code: error.code, category: error.category, route: request.url },
        'request failed',
      );
      reply.status(error.httpStatus).send({
        error: {
          code: error.code,
          message: error.expose ? error.message : 'Internal error',
          ...(error.category === 'validation' ? { issues: redactDeep(error.context) } : {}),
        },
      });
      return;
    }
    container.logger.error({ err: error, route: request.url }, 'unhandled error');
    reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } });
  });

  /* ---------------------------------------------------------------------- */
  /*  Public: health                                                        */
  /* ---------------------------------------------------------------------- */

  app.get('/health', async (_request, reply) => {
    const statuses = container.integrationStatuses();
    const dbHealthy = await container.database.healthy();
    const readiness = container.readiness();
    const scheduler = container.schedulerStatus();

    const body = {
      status: readiness.ready ? 'ok' : 'degraded',
      version: '0.1.0',
      part: 1,
      uptimeSeconds: Math.floor((Date.now() - START_TIME.getTime()) / 1000),
      timestamp: new Date().toISOString(),
      degradedReasons: readiness.degradedReasons,
      database: {
        configured: container.database.configured,
        healthy: dbHealthy,
        detail: await container.database.statusDetail(),
      },
      scheduler,
      integrations: statuses.map((s) => ({
        service: s.service,
        configured: s.configured,
        mode: s.mode,
        detail: s.detail,
      })),
    };
    return reply.status(200).send(body);
  });

  /* ---------------------------------------------------------------------- */
  /*  Public: integration status                                            */
  /* ---------------------------------------------------------------------- */

  app.get('/v1/meta/integrations', async (_request, reply) => {
    return reply.status(200).send({
      integrations: withIntegrationHealth(container.integrationStatuses()),
      healthLegend: {
        connected: 'Live credentials present AND a live call verified in this deployment.',
        blocked: 'A required external prerequisite is missing, so the integration cannot run.',
        not_tested: 'Configured or mocked, but no live call has ever been verified.',
        disconnected: 'Nothing is configured for this service.',
      },
      note: 'No secret values are exposed. Each entry reports configuration and verification state only.',
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Public: auth token issuance                                            */
  /* ---------------------------------------------------------------------- */

  app.post('/v1/auth/token', async (request, reply) => {
    const parsed = tokenRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'INVALID_REQUEST', message: 'installKey is required' },
      });
    }

    // Part 1 auth boundary: a single shared install key issued by the operator
    // and delivered to the APK out-of-band (e.g. pasted by the user). A richer
    // per-device registration flow is deferred to a later part.
    const expectedKey = process.env['APP_INSTALL_KEY'] ?? container.env.AUTH_JWT_SECRET;
    const provided = parsed.data.installKey;
    if (!constantTimeEquals(provided, expectedKey)) {
      container.logger.warn({}, 'token issuance rejected: install key mismatch');
      return reply
        .status(401)
        .send({ error: { code: 'INVALID_INSTALL_KEY', message: 'Invalid install key' } });
    }

    const { mintTokenFromOptions } = await import('../core/auth.js');
    const token = mintTokenFromOptions(
      {
        subject: parsed.data.deviceLabel ?? 'apk-install',
        issuer: container.env.AUTH_JWT_ISSUER,
        audience: container.env.AUTH_JWT_AUDIENCE,
        ttlSeconds: container.env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
        scope: ['dashboard', 'read', 'control'],
      },
      container.env.AUTH_JWT_SECRET,
    );

    container.logger.info({ deviceLabel: parsed.data.deviceLabel }, 'token issued');
    return reply.status(200).send({
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn: container.env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      scope: ['dashboard', 'read', 'control'],
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Authenticated: identity                                               */
  /* ---------------------------------------------------------------------- */

  app.get('/v1/me', async (request, reply) => {
    authenticate(container, request);
    const claims = claimsOf(request);
    requireScopes(claims, ['read']);
    return reply.status(200).send({
      subject: claims.sub,
      scopes: claims.scope ?? [],
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Authenticated: scheduler + queue                                      */
  /* ---------------------------------------------------------------------- */

  app.get('/v1/scheduler/status', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    // Part 4: additive `contentScheduler` block describing the
    // scheduler -> queue -> pipeline integration. Every Part 1/2 key of
    // SchedulerStatus is preserved unchanged.
    const status = container.schedulerStatus();
    const lastTick = container.contentScheduler.peekLastTick();
    return reply.status(200).send({
      ...status,
      contentScheduler: {
        connected: true,
        loop: container.schedulerLoopStatus(),
        jobKind: CONTENT_JOB_KIND,
        maxCatchUpPerTick: container.contentScheduler.catchUpLimit,
        lastTick: lastTick
          ? {
              at: lastTick.at,
              today: lastTick.today,
              enqueued: lastTick.enqueued,
              executed: lastTick.executed,
              skipped: lastTick.skipped,
              failed: lastTick.failed,
              pendingJobs: lastTick.pendingJobs,
              message: lastTick.message,
            }
          : null,
        publishing: 'disabled',
        note: 'Executes the content pipeline to publish_ready only; never invokes Facebook/Threads publishers.',
      },
    });
  });

  app.get('/v1/queue/jobs', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    const limitRaw = (request.query as { limit?: string } | undefined)?.limit;
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50;

    // Part 1: in-memory queue. Swap to the Postgres queue when DATABASE_URL is set.
    const jobs =
      container.queue instanceof InMemoryJobQueue
        ? await container.queue.list(safeLimit)
        : await container.queue.list(safeLimit);
    return reply.status(200).send({ jobs, count: jobs.length });
  });

  /* ---------------------------------------------------------------------- */
  /*  Authenticated: automation status (dashboard aggregate)                */
  /* ---------------------------------------------------------------------- */

  app.get('/v1/automation/status', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    const now = new Date();
    const jobs = await container.queue.list(200);
    const status = describeAutomationStatus({
      settings: container.settings.current(),
      schedulerConfig: container.effectiveSchedulerConfig(),
      schedulerMode: container.env.SCHEDULER_MODE,
      degradedReasons: container.readiness().degradedReasons,
      jobs,
      now,
    });
    return reply.status(200).send(status);
  });

  /* ---------------------------------------------------------------------- */
  /*  Authenticated: automation settings                                    */
  /* ---------------------------------------------------------------------- */

  app.get('/v1/settings', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    return reply.status(200).send({
      settings: container.settings.current(),
      defaults: DEFAULT_AUTOMATION_SETTINGS,
      storage: { kind: container.settings.storageKind },
      warning: container.settings.loadWarning,
      constraints: SETTINGS_CONSTRAINTS,
      controls: [...AUTOMATION_ACTIONS],
      note:
        container.settings.storageKind === 'file'
          ? 'Settings are persisted by the backend. The APK never keeps an authoritative copy.'
          : 'Settings are held in memory only (tests/dev): they reset when the backend restarts.',
    });
  });

  app.put('/v1/settings', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    const parsed = settingsPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Settings patch must be an object of known, correctly-typed keys.',
          issues: redactDeep(
            parsed.error.issues.map((issue) => ({
              rule: issue.path.length > 0 ? issue.path.join('.') : 'body',
              message: issue.message,
            })),
          ),
        },
      });
    }
    const patch = parseSettingsPatch(parsed.data);

    // Cross-check category ids against the ACTUAL imported catalog: an
    // unknown id in selected-categories mode would silently skip every slot.
    if (patch.selectionMode === 'selected_categories' || patch.selectedCategoryIds) {
      const merged = { ...container.settings.current(), ...patch };
      if (merged.selectionMode === 'selected_categories') {
        if (merged.selectedCategoryIds.length === 0) {
          return reply.status(400).send({
            error: {
              code: 'INVALID_SETTINGS',
              message: 'Selected-categories mode requires at least one category id.',
              issues: redactDeep([
                {
                  rule: 'settings.selectedCategoryIds',
                  message: 'Select at least one category before switching to selected-categories mode.',
                },
              ]),
            },
          });
        }
        const known = new Set(container.catalog.categories().map((category) => category.id));
        const unknown = merged.selectedCategoryIds.filter((id) => !known.has(id));
        if (unknown.length > 0) {
          return reply.status(400).send({
            error: {
              code: 'INVALID_SETTINGS',
              message: 'One or more selected category ids do not exist in the imported catalog.',
              issues: redactDeep(
                unknown.map((id) => ({
                  rule: `settings.selectedCategoryIds.${id}`,
                  message: `Category "${id}" is not in the catalog. Import a feed or refresh the category list.`,
                })),
              ),
            },
          });
        }
      }
    }

    const settings = await container.settings.update(patch);
    container.logger.info(
      { storage: container.settings.storageKind, intervalMinutes: settings.intervalMinutes },
      'automation settings updated',
    );
    return reply.status(200).send({
      settings,
      storage: { kind: container.settings.storageKind },
      updated: true,
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Authenticated: start / pause / resume                                 */
  /* ---------------------------------------------------------------------- */

  app.post('/v1/automation/control', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    const parsed = controlRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: `action must be one of: ${AUTOMATION_ACTIONS.join(', ')}`,
        },
      });
    }
    const result = await container.settings.control(parsed.data.action);
    container.logger.info(
      { action: parsed.data.action, state: result.settings.automationState, changed: result.changed },
      'automation control requested',
    );
    return reply.status(200).send({
      action: result.action,
      changed: result.changed,
      state: result.settings.automationState,
      settings: result.settings,
      note:
        result.settings.automationState === 'running'
          ? 'The backend keeps running independently of the APK lifecycle.'
          : 'Paused: the backend stays up but will not schedule or publish anything.',
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Authenticated: content preview (REAL pipeline when present, fixture   */
  /*  fallback otherwise) + publishing history                              */
  /* ---------------------------------------------------------------------- */

  app.get('/v1/content/preview', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    const query = request.query as { slot?: string } | undefined;
    const scheduler = container.schedulerStatus();
    const slotKey =
      (query?.slot ?? '').trim() || scheduler.nextSlot?.key || `${scheduler.today}#01`;

    // REAL pipeline record wins; the Part 2 fixture is the honest fallback
    // while the pipeline has not run for this slot yet.
    const record = container.pipeline.get(slotKey);
    if (record) {
      const preview = buildPipelinePreview({
        record,
        facebookEnabled: container.settings.current().facebookEnabled,
        threadsEnabled: container.settings.current().threadsEnabled,
      });
      return reply.status(200).send(preview);
    }

    const preview = buildContentPreview(slotKey, container.settings.current());
    return reply.status(200).send({ ...preview, note: FIXTURE_CONTENT_NOTE });
  });

  /* ---------------------------------------------------------------------- */
  /*  Authenticated: product catalog (Part 3)                               */
  /* ---------------------------------------------------------------------- */

  app.post('/v1/catalog/import', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    const parsed = catalogImportSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'filename and contentBase64 are required; format must be csv or xlsx.',
          issues: redactDeep(
            parsed.error.issues.map((issue) => ({
              rule: issue.path.length > 0 ? issue.path.join('.') : 'body',
              message: issue.message,
            })),
          ),
        },
      });
    }

    let content: Uint8Array;
    try {
      content = new Uint8Array(Buffer.from(parsed.data.contentBase64, 'base64'));
    } catch {
      return reply.status(400).send({
        error: { code: 'INVALID_REQUEST', message: 'contentBase64 is not valid base64.' },
      });
    }

    try {
      const result = await container.feedImporter.parse({
        filename: parsed.data.filename,
        content,
        format: parsed.data.format,
        defaultMarketplace: parsed.data.defaultMarketplace,
      });
      const batch = await container.catalog.importFeed(result, {
        filename: parsed.data.filename,
        format: result.summary.format,
      });
      container.logger.info(
        {
          batchId: batch.id,
          newProducts: batch.newProducts,
          updatedProducts: batch.updatedProducts,
          rejected: batch.rejected,
          urlDuplicatesSkipped: batch.urlDuplicatesSkipped,
        },
        'catalog import completed',
      );
      return reply.status(200).send({
        batch,
        catalog: {
          total: container.catalog.total(),
          eligible: container.catalog.count({ eligibleOnly: true }),
          categories: container.catalog.categories().length,
          storage: container.catalog.storageKind,
        },
        note: 'Imported into the persistent catalog. Previously valid products are never deleted by a failed or partial import.',
      });
    } catch (error) {
      // A failed parse/import leaves the previous catalog fully intact.
      // Feed-shape problems are the operator's to fix, so surface a safe,
      // machine-readable code and message (never the internal context).
      if (error instanceof ShopeeFeedError) {
        const upstreamCode = (error.context as { upstreamCode?: string } | undefined)?.upstreamCode;
        return reply.status(422).send({
          error: {
            code: upstreamCode ?? error.code,
            message: error.message,
            hint: 'The existing catalog was not modified by this failed import.',
          },
        });
      }
      if (error instanceof AppError && error.expose) {
        return reply.status(error.httpStatus).send({
          error: { code: error.code, message: error.message },
        });
      }
      container.logger.error({ err: error }, 'catalog import failed');
      return reply.status(500).send({
        error: {
          code: 'IMPORT_FAILED',
          message: 'Feed import failed; the existing catalog was not modified.',
        },
      });
    }
  });

  app.get('/v1/catalog', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    await container.catalog.init();
    const query = catalogListQuerySchema.safeParse(request.query ?? {});
    const params = query.success ? query.data : {};
    const limit = params.limit ? Number.parseInt(params.limit, 10) : 50;
    const offset = params.offset ? Number.parseInt(params.offset, 10) : 0;
    const items = container.catalog.list({
      categoryId: params.category,
      eligibleOnly: params.eligible === 'true',
      search: params.search,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return reply.status(200).send({
      items,
      count: items.length,
      total: container.catalog.total(),
      eligibleTotal: container.catalog.count({ eligibleOnly: true }),
      storage: container.catalog.storageKind,
      warning: container.catalog.warning,
    });
  });

  app.get('/v1/catalog/categories', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    await container.catalog.init();
    const categories = container.catalog.categories();
    return reply.status(200).send({
      categories,
      count: categories.length,
      total: container.catalog.total(),
      note: 'Categories are derived from the ACTUAL imported catalog, not a hardcoded list.',
    });
  });

  app.get('/v1/catalog/status', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    await container.catalog.init();
    return reply.status(200).send({
      total: container.catalog.total(),
      eligible: container.catalog.count({ eligibleOnly: true }),
      categories: container.catalog.categories().length,
      storage: container.catalog.storageKind,
      warning: container.catalog.warning,
      recentImports: container.catalog.recentBatches(10),
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Authenticated: content pipeline (Part 3)                              */
  /* ---------------------------------------------------------------------- */

  app.post('/v1/pipeline/run', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    const parsed = pipelineRunSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Body must be an object with optional slot (string) and regenerate (boolean).',
        },
      });
    }
    const scheduler = container.schedulerStatus();
    const slotKey =
      (parsed.data.slot ?? '').trim() || scheduler.nextSlot?.key || `${scheduler.today}#01`;

    try {
      const result = await container.pipeline.runSlot(slotKey, {
        regenerate: parsed.data.regenerate === true,
      });
      const preview = buildPipelinePreview({
        record: result.record,
        facebookEnabled: container.settings.current().facebookEnabled,
        threadsEnabled: container.settings.current().threadsEnabled,
      });
      container.logger.info(
        {
          slotKey,
          stage: result.record.stage,
          imageCount: result.record.imageCount,
          attempts: result.record.attempts,
          actions: result.actions,
        },
        'pipeline run completed',
      );
      return reply.status(200).send({
        slotKey,
        stage: result.record.stage,
        actions: result.actions,
        preview,
        note: 'Content generation only: nothing is published to Facebook or Threads from this endpoint.',
      });
    } catch (error) {
      container.logger.error({ err: error, slotKey }, 'pipeline run failed');
      return reply.status(500).send({
        error: { code: 'PIPELINE_FAILED', message: 'Pipeline run failed; see backend logs.' },
      });
    }
  });

  app.get('/v1/pipeline/slots', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    const limitRaw = (request.query as { limit?: string } | undefined)?.limit;
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20;
    const records = container.pipeline.list(safeLimit);
    return reply.status(200).send({
      slots: records.map((record) => ({
        slotKey: record.slotKey,
        stage: record.stage,
        productName: record.productName,
        imageCount: record.imageCount,
        imageCountPolicy: record.imageCountPolicy,
        assets: record.assets.length,
        captions: record.captions.length,
        validationPassed: record.validationPassed,
        blockers: record.blockers,
        // PART 7: why a slot stopped (`failed` slots carry an explicit,
        // redacted reason; `blocked` slots use `blockers` instead).
        lastError: record.lastError ?? null,
        attempts: record.attempts,
        publishReady: record.stage === 'publish_ready',
        updatedAt: record.updatedAt,
      })),
      count: records.length,
      storage: container.slots.storageKind,
    });
  });

  app.get('/v1/history/publishes', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    const limitRaw = (request.query as { limit?: string } | undefined)?.limit;
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 10;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 10;
    const items = buildPublishHistory(container.settings.current()).slice(0, safeLimit);
    return reply.status(200).send({
      items,
      count: items.length,
      source: 'fixture',
      note: FIXTURE_HISTORY_NOTE,
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  PART 6: provider workspace (custom AI text/image providers)           */
  /* ---------------------------------------------------------------------- */

  // List: configuration + capability/readiness + masked secret metadata.
  // NO endpoint here ever returns a stored credential.
  app.get('/v1/providers', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    await container.providers.init();
    const [providers, selection] = await Promise.all([
      container.providers.list(),
      container.providers.selection(),
    ]);
    return reply.status(200).send({
      providers,
      selection,
      storage: container.providers.storage,
      secretsStorage: container.providers.secretsStorage,
      capabilities: [
        'text_generation',
        'image_generation',
        'image_reference_input',
        'image_editing',
        'structured_output',
      ],
      statuses: [
        'not_configured',
        'configuration_invalid',
        'authentication_failed',
        'ready',
        'capability_unsupported',
        'temporarily_unavailable',
        'rate_limited',
        'test_failed',
      ],
      note: 'Credentials are encrypted on the backend and are never returned by any endpoint (only masked metadata).',
    });
  });

  app.post('/v1/providers', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    await container.providers.init();
    const provider = await container.providers.create(request.body ?? {});
    container.logger.info({ providerId: provider.id, name: provider.name }, 'provider created');
    return reply.status(201).send({ provider });
  });

  app.get('/v1/providers/selection', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    await container.providers.init();
    return reply.status(200).send(await container.providers.selection());
  });

  app.put('/v1/providers/selection', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    await container.providers.init();
    const selection = await container.providers.setSelection(request.body ?? {});
    container.logger.info(
      { textProviderId: selection.textProviderId, imageProviderId: selection.imageProviderId },
      'provider selection updated',
    );
    return reply.status(200).send(selection);
  });

  app.put('/v1/providers/:id', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    await container.providers.init();
    const { id } = request.params as { id: string };
    const provider = await container.providers.update(id, request.body ?? {});
    return reply.status(200).send({ provider });
  });

  app.delete('/v1/providers/:id', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    await container.providers.init();
    const { id } = request.params as { id: string };
    const result = await container.providers.remove(id);
    container.logger.info({ providerId: id }, 'provider deleted');
    return reply.status(200).send({ ...result, providerId: id });
  });

  // Write-only credential endpoints: the secret value goes IN and is never read
  // back out (only presence + a masked preview are returned).
  app.put('/v1/providers/:id/secret', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    await container.providers.init();
    const { id } = request.params as { id: string };
    const metadata = await container.providers.setSecret(id, request.body ?? {});
    container.logger.info({ providerId: id }, 'provider secret stored (value never logged)');
    return reply.status(200).send({ providerId: id, secret: metadata });
  });

  app.delete('/v1/providers/:id/secret', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    await container.providers.init();
    const { id } = request.params as { id: string };
    const metadata = await container.providers.deleteSecret(id);
    return reply.status(200).send({ providerId: id, secret: metadata });
  });

  /* --- Test actions: bounded, sanitized, never publishing --------------- */

  app.post('/v1/providers/:id/test/connection', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    await container.providers.init();
    const { id } = request.params as { id: string };
    const result = await container.providers.testConnection(id);
    return reply.status(200).send(result);
  });

  app.post('/v1/providers/:id/test/text', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    await container.providers.init();
    const { id } = request.params as { id: string };
    const result = await container.providers.testText(id);
    return reply.status(200).send(result);
  });

  app.post('/v1/providers/:id/test/image', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    await container.providers.init();
    const { id } = request.params as { id: string };
    const result = await container.providers.testImage(id);
    return reply.status(200).send(result);
  });

  /* --- Usage + budget (§10) ---------------------------------------------- */

  app.get('/v1/usage/summary', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    const summary = await container.usage.summary();
    return reply.status(200).send({
      timezone: container.env.SCHEDULER_TIMEZONE,
      storage: summary.storage,
      day: summary.day,
      month: summary.month,
      budget: summary.budget,
      recent: summary.recent,
      note: 'Cost figures are provider-reported. Requests with no reported cost are counted as "unknown cost".',
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  PART 8 §3: readiness + operations diagnostics                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Public readiness gate for load balancers/probes. Deliberately minimal:
   * status codes only — no hostnames, credentials, provider bodies or internal
   * network detail. 200 = dependencies permit normal operation; 503 = the
   * service must NOT be sent generation work (database unreachable or schema
   * inconsistent). Liveness stays on GET /health and never calls a provider.
   */
  app.get('/ready', async (_request, reply) => {
    // PART 9 §5: readiness flips the moment a shutdown signal begins, so load
    // balancers stop sending generation work while draining. No database
    // round-trip is made here — shutdown must stay fast and the verdict does
    // not depend on it. Liveness stays on GET /health (part: 1, unchanged).
    if (options.isShuttingDown?.()) {
      return reply.status(503).send({
        status: 'stopping',
        checks: { database: 'not_probed', migrations: 'not_probed' },
        reason: 'shutting_down',
        note: 'The process is draining: no new work is accepted. Liveness is reported by GET /health.',
        timestamp: new Date().toISOString(),
      });
    }

    const configured = container.database.configured;
    const databaseCheck: 'ok' | 'unavailable' | 'not_configured' = !configured
      ? 'not_configured'
      : (await container.database.healthy())
        ? 'ok'
        : 'unavailable';

    let migrationsCheck: 'ok' | 'pending' | 'drift' | 'unknown' | 'not_configured' = 'ok';
    if (!configured) {
      migrationsCheck = 'not_configured';
    } else {
      const report = await container.database.migrationStatus();
      if (!report) {
        migrationsCheck = 'unknown';
      } else if (
        report.divergedCount > 0 ||
        report.unknownApplied.length > 0 ||
        !report.tablePresent
      ) {
        migrationsCheck = 'drift';
      } else if (report.pendingCount > 0) {
        migrationsCheck = 'pending';
      }
    }

    const reason =
      databaseCheck === 'unavailable'
        ? 'database_unreachable'
        : migrationsCheck === 'drift'
          ? 'migration_drift'
          : migrationsCheck === 'pending'
            ? 'migration_pending'
            : migrationsCheck === 'unknown'
              ? 'migration_status_unknown'
              : null;
    const ready = reason === null;

    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks: { database: databaseCheck, migrations: migrationsCheck },
      reason,
      note: 'Readiness covers PostgreSQL reachability and schema consistency — the dependencies required to accept generation jobs. Provider/budget readiness is reported by GET /v1/ops/health.',
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * Detailed component health (§2/§3): authenticated, read scope. Uses cached
   * provider probes and configuration state only — a health request never calls
   * a paid AI API. Every component carries a sanitized status/message; no
   * secret, token, prompt or raw provider body is included.
   */
  app.get('/v1/ops/health', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    const health = await container.opsService.health();
    return reply.status(200).send(health);
  });

  /**
   * §4 observability: authenticated, read scope. Low-cardinality counters and
   * ages only (no job ids, product data or keys), consumed by the app's Ops
   * dashboard and any external scraper with a read token.
   */
  app.get('/v1/ops/metrics', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    const metrics = await container.opsService.metrics();
    return reply.status(200).send(metrics);
  });

  /**
   * §8 preflight: authenticated (control). Pure evaluation — it can report
   * blockers/warnings but can NEVER enable automation, publishing, or store
   * credentials. Optional services only produce warnings, never blockers, for
   * local development.
   */
  app.get('/v1/ops/preflight', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    const now = new Date();
    const health = await container.opsService.health(now);
    const status = container.schedulerStatus(now);
    const report = evaluatePreflight({
      health,
      settings: container.settings.current(),
      nodeEnv: container.env.NODE_ENV,
      persistenceBackend: container.persistence.backend,
      secretsKeyConfigured: container.secretStore.keyConfigured,
      envImageProvider: container.env.AI_IMAGE_PROVIDER,
      envCaptionProvider: container.env.AI_TEXT_PROVIDER,
      timezone: container.env.SCHEDULER_TIMEZONE,
      postingWindowsCount: status.postingWindows.length,
      allowedWindowsCount: POSTING_WINDOWS.length,
      imageReferenceDeclared: preflightImageReferenceDeclared(health),
      now,
    });
    return reply.status(200).send(report);
  });

  /* ---------------------------------------------------------------------- */
  /*  PART 8 §6: Telegram notification settings (backend-only credential)    */
  /* ---------------------------------------------------------------------- */

  // Rate limit for the explicit test action (bounded message rate, §6).
  let lastTelegramTestAt = 0;

  /** Current notification status — never includes the token or chat id. */
  app.get('/v1/notifications/telegram', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    const current = container.settings.current();
    const envConfigured = Boolean(
      container.env.TELEGRAM_BOT_TOKEN && container.env.TELEGRAM_CHAT_ID,
    );
    let stored = false;
    try {
      stored = await container.secretStore.has(TELEGRAM_SECRET_BOT_TOKEN);
    } catch {
      stored = false;
    }
    const configured = stored || envConfigured;
    const recent = await container.opsMonitor.recent(10);
    const lastDelivery = recent.find((event) => event.lastNotifiedAt !== null) ?? null;

    return reply.status(200).send({
      enabled: current.telegramNotificationsEnabled,
      minSeverity: current.notificationMinSeverity,
      eventKinds: current.notificationEventKinds,
      secret: {
        present: configured,
        stored,
        envBootstrap: !stored && envConfigured,
        keyConfigured: container.secretStore.keyConfigured,
        location: 'encrypted backend store (AES-256-GCM); the value is never returned by any endpoint.',
      },
      lastDelivery: lastDelivery
        ? {
            status: lastDelivery.lastDeliveryStatus,
            at: lastDelivery.lastNotifiedAt,
            errorCode: lastDelivery.lastErrorCode,
          }
        : null,
      note: 'Bot token and chat id are write-only secrets. Configure them via PUT /v1/notifications/telegram/secret.',
    });
  });

  /** Enable/disable + severity floor + event-kind filter (non-sensitive). */
  app.put('/v1/notifications/telegram', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    const parsed = notificationSettingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Expected { enabled?, minSeverity?, eventKinds? } with correct types.',
          issues: redactDeep(
            parsed.error.issues.map((issue) => ({
              rule: issue.path.length > 0 ? issue.path.join('.') : 'body',
              message: issue.message,
            })),
          ),
        },
      });
    }
    const patch = parseSettingsPatch({
      ...(parsed.data.enabled !== undefined
        ? { telegramNotificationsEnabled: parsed.data.enabled }
        : {}),
      ...(parsed.data.minSeverity !== undefined
        ? { notificationMinSeverity: parsed.data.minSeverity }
        : {}),
      ...(parsed.data.eventKinds !== undefined
        ? { notificationEventKinds: parsed.data.eventKinds }
        : {}),
    });
    const settings = await container.settings.update(patch);
    return reply.status(200).send({
      enabled: settings.telegramNotificationsEnabled,
      minSeverity: settings.notificationMinSeverity,
      eventKinds: settings.notificationEventKinds,
      updated: true,
    });
  });

  /**
   * Store/replace the Telegram credential. WRITE-ONLY: the values go in and
   * are sealed with AES-256-GCM; this endpoint and every other response only
   * ever report presence. Fails closed when SECRETS_ENCRYPTION_KEY is absent.
   */
  app.put('/v1/notifications/telegram/secret', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    if (!container.secretStore.keyConfigured) {
      return reply.status(503).send({
        error: {
          code: 'SECRETS_KEY_MISSING',
          message:
            'SECRETS_ENCRYPTION_KEY is not configured, so credentials cannot be stored (fail-closed). Set the key and restart.',
        },
      });
    }
    const parsed = telegramSecretSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message:
            'Expected { botToken, chatId }: non-empty strings without whitespace (20-200 and 1-64 characters).',
        },
      });
    }
    await container.secretStore.set(TELEGRAM_SECRET_BOT_TOKEN, parsed.data.botToken);
    await container.secretStore.set(TELEGRAM_SECRET_CHAT_ID, parsed.data.chatId);
    container.logger.info({}, 'telegram credential stored (values never logged)');
    return reply.status(200).send({
      configured: true,
      secret: { present: true, stored: true },
      next: 'Send a test notification via POST /v1/notifications/telegram/test.',
    });
  });

  app.delete('/v1/notifications/telegram/secret', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    try {
      await container.secretStore.delete(TELEGRAM_SECRET_BOT_TOKEN);
      await container.secretStore.delete(TELEGRAM_SECRET_CHAT_ID);
    } catch {
      // Deleting a never-stored key is not an error; presence is re-checked below.
    }
    container.logger.info({}, 'telegram credential removed');
    return reply.status(200).send({ configured: false, secret: { present: false, stored: false } });
  });

  /**
   * Explicit, user-triggered test notification (§6). Bypasses severity/kind
   * filters but requires a credential; the response reports EXACTLY what the
   * transport confirmed — `sent` only when Telegram acknowledged the message.
   */
  app.post('/v1/notifications/telegram/test', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['control']);
    const now = Date.now();
    if (now - lastTelegramTestAt < 5_000) {
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: 'Test notifications are limited to one every 5 seconds.' },
      });
    }
    lastTelegramTestAt = now;
    const result = await container.telegramService.sendTestMessage();
    return reply.status(200).send({
      test: true,
      delivered: result.delivered,
      status: result.status,
      messageId: result.messageId ?? null,
      errorCode: result.errorCode ?? null,
      note:
        result.status === 'not_configured'
          ? 'No credential is stored. Save the bot token and chat id first.'
          : result.delivered
            ? 'Telegram confirmed the message.'
            : 'Delivery failed; see errorCode. The event was not reported as sent.',
      at: new Date().toISOString(),
    });
  });

  /* --- 404 --- */
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  return app;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** Length-safe constant-time comparison for install keys. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) {
    diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return diff === 0;
}

export type { FastifyReply };
