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
 *  - GET    /v1/content/preview      Authenticated. FIXTURE preview of a content slot.
 *  - GET    /v1/history/publishes    Authenticated. FIXTURE publishing history.
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
import { AppError, AuthenticationError } from '../core/errors.js';
import { redactDeep } from '../core/redact.js';
import { InMemoryJobQueue } from '../queue/job-queue.js';
import { withIntegrationHealth } from './integration-health.js';
import { describeAutomationStatus } from '../automation/status.js';
import {
  buildContentPreview,
  buildPublishHistory,
  FIXTURE_CONTENT_NOTE,
  FIXTURE_HISTORY_NOTE,
} from '../automation/fixtures.js';
import {
  AUTOMATION_ACTIONS,
  DEFAULT_AUTOMATION_SETTINGS,
  IMAGE_COUNT_POLICIES,
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
  })
  .strict();

const controlRequestSchema = z.object({ action: z.enum(AUTOMATION_ACTIONS) }).strict();

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
    methods: ['GET', 'POST'],
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
    return reply.status(200).send(container.schedulerStatus());
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
    const settings = await container.settings.update(parseSettingsPatch(parsed.data));
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
  /*  Authenticated: FIXTURE content preview + publishing history           */
  /* ---------------------------------------------------------------------- */

  app.get('/v1/content/preview', async (request, reply) => {
    authenticate(container, request);
    requireScopes(claimsOf(request), ['read']);
    const query = request.query as { slot?: string } | undefined;
    const scheduler = container.schedulerStatus();
    const slotKey =
      (query?.slot ?? '').trim() || scheduler.nextSlot?.key || `${scheduler.today}#01`;
    const preview = buildContentPreview(slotKey, container.settings.current());
    return reply.status(200).send({ ...preview, note: FIXTURE_CONTENT_NOTE });
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
