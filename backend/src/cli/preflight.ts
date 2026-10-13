/**
 * `npm run preflight` — PART 8 §8: production readiness check (READ-ONLY).
 *
 * Evaluates whether the system is configured for its INTENDED operation and
 * prints explicit blockers and warnings: database + schema, scheduler windows
 * and target, provider readiness (text/image independently), image-reference
 * and asset-storage configuration, budgets, Telegram (only when enabled), the
 * live-publishing gate (must stay disabled) and production-mode integrity
 * (PostgreSQL persistence, secrets key, no silent mock generation).
 *
 * A preflight changes NOTHING: it cannot enable automation, cannot enable
 * publishing, cannot store credentials and cannot run migrations. Optional
 * services (Telegram, budgets) only produce warnings in development — they
 * never block a local run, and production-mode problems escalate to blockers.
 *
 * Exit codes:
 *   0 = OK (warnings allowed)
 *   1 = BLOCKERS found (not configured for intended operation)
 *   2 = could not evaluate (environment validation failed)
 */
import { buildContainer, type AppContainer } from '../app/container.js';
import { loadEnv } from '../core/env.js';
import { loadDotEnv } from '../core/dotenv.js';
import { createNullLogger } from '../core/logger.js';
import { POSTING_WINDOWS } from '../scheduler/slots.js';
import { evaluatePreflight, preflightImageReferenceDeclared } from '../ops/preflight.js';

async function main(): Promise<void> {
  loadDotEnv();
  console.log('PART 8 preflight — evaluates configuration for intended operation.');
  console.log('Read-only: it cannot enable automation, publishing, or store credentials.');

  let container: AppContainer;
  try {
    const env = loadEnv({
      // Throwaway auth values for the CLI context (no server is started); a
      // real deployment's own environment always wins where it is set.
      AUTH_JWT_SECRET: 'preflight-readonly-cli-jwt-secret-0123456789',
      AUTH_JWT_ISSUER: 'preflight-cli',
      AUTH_JWT_AUDIENCE: 'preflight-cli',
      CORS_ORIGINS: 'http://localhost',
      ...process.env,
    });
    container = buildContainer({ env, logger: createNullLogger() });
  } catch (error) {
    console.log('\nRESULT: BLOCKED — environment validation failed; nothing was evaluated.');
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  let exitCode = 2;
  try {
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

    console.log(`\nOverall system status : ${health.overall}`);
    console.log(`Accepting generation   : ${health.ready ? 'yes' : 'no'} (${health.blockers.join(', ') || 'no blockers'})`);
    console.log(`Persistence backend    : ${container.persistence.backend}`);
    console.log(`Automation state       : ${container.settings.current().automationState}`);

    if (report.blockers.length > 0) {
      console.log(`\n── BLOCKERS (${report.blockers.length}) — fix before intended operation ──`);
      for (const check of report.blockers) {
        console.log(`  ✗ [${check.id}] ${check.title}`);
        console.log(`      ${check.message}`);
      }
    }
    if (report.warnings.length > 0) {
      console.log(`\n── WARNINGS (${report.warnings.length}) — recommended, non-blocking ──`);
      for (const check of report.warnings) {
        console.log(`  ! [${check.id}] ${check.title}`);
        console.log(`      ${check.message}`);
      }
    }
    console.log(`\n── PASSED (${report.passed.length}) ──`);
    console.log(`  ${report.passed.map((check) => check.id).join(', ')}`);

    console.log(`\nRESULT: ${report.ok ? 'OK' : 'BLOCKED'} (${report.nodeEnv})`);
    console.log('No state was changed: automation and publishing remain exactly as they were.');
    exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.log('\nRESULT: FAILED — preflight could not be evaluated.');
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 2;
  } finally {
    await container.shutdown().catch(() => undefined);
  }
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  console.error('Preflight crashed:', error instanceof Error ? error.message : String(error));
  process.exit(2);
});
