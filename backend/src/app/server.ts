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
 * Security invariants:
 *  - No endpoint ever returns a secret value; health/integration output is built
 *    from `describeIntegrationStatus`, which only emits key NAMES + booleans.
 *  - Authenticated routes verify the HS256 JWT, its issuer, audience, expiry and
 *    required scopes.
 *  - CORS is an explicit allow-list derived from CORS_ORIGINS.
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
    selectionMode: z.enum(SELECTION_MODES).optional(),
    selectedCategoryIds: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
  })
  .strict();

const controlRequestSchema = z.object({ action: z.enum(AUTOMATION_ACTIONS) }).strict();

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

export async function buildServer(container: AppContainer): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // We use our own redacting logger.
    trustProxy: true,
    bodyLimit: 25 * 1024 * 1024, // allow up to ~25MB feed uploads
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
