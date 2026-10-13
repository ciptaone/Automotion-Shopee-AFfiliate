/**
 * `npm run smoke:providers` — PART 7 §7: OPT-IN live provider smoke test.
 *
 * This is the ONLY entry point that ever makes a real, authenticated request to
 * an external AI provider. The default test suite never calls external APIs;
 * this script stays silent (BLOCKED) until the operator supplies credentials.
 *
 * Credentials (never committed, never printed — only their KEY NAMES appear):
 *
 *   LIVE_SMOKE_TEXT_BASE_URL    OpenAI-compatible chat endpoint base URL
 *   LIVE_SMOKE_TEXT_MODEL       model id for the text request
 *   LIVE_SMOKE_TEXT_API_KEY     credential (stored encrypted, deleted afterwards)
 *   LIVE_SMOKE_TEXT_ADAPTER     optional, default `openai_chat_completions`
 *
 *   LIVE_SMOKE_IMAGE_BASE_URL   OpenAI-compatible images endpoint base URL
 *   LIVE_SMOKE_IMAGE_MODEL      model id for the image request
 *   LIVE_SMOKE_IMAGE_API_KEY    credential (stored encrypted, deleted afterwards)
 *   LIVE_SMOKE_IMAGE_ADAPTER    optional, default `openai_images`
 *
 * Behaviour:
 *   - TEXT and IMAGE are tested SEPARATELY (one bounded request each), through
 *     the real ProviderService test routes: no publishing can occur.
 *   - Missing credentials ⇒ `NOT_CONFIGURED` / `BLOCKED`, exit 2 — NEVER PASS.
 *   - Configured but rejected/failed request ⇒ `FAIL`, exit 1.
 *   - Both capabilities exercised and ready ⇒ `PASS`, exit 0.
 *   - The temporary provider (and its encrypted secret) is deleted afterwards;
 *     usage rows recorded for the run are reported (and, when NODE_ENV is not
 *     `test`, left in the ledger as an honest record of real usage).
 *
 * Exit codes: 0 = PASS · 1 = FAIL · 2 = BLOCKED / NOT_CONFIGURED / bad config.
 *
 * Nothing is published. Live generation counts as verified ONLY when this
 * script prints PASS with real authenticated responses.
 */
import { randomBytes } from 'node:crypto';
import { buildContainer, type AppContainer } from '../app/container.js';
import { loadEnv } from '../core/env.js';
import { loadDotEnv } from '../core/dotenv.js';
import { createNullLogger } from '../core/logger.js';
import type { CapabilityStatus, ProviderReadiness } from '../providers/types.js';
import type { ProviderTestResult } from '../providers/provider-service.js';

type Verdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_CONFIGURED';
type Capability = 'text' | 'image';

interface CapabilityConfig {
  readonly capability: Capability;
  readonly label: string;
  readonly prefix: string;
  readonly defaultAdapter: string;
  readonly configured: boolean;
  readonly missing: readonly string[];
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly apiKey: string | null;
  readonly adapterType: string;
}

interface CapabilityReport {
  readonly config: CapabilityConfig;
  readonly verdict: Verdict;
  readonly providerId?: string;
  readonly providerName?: string;
  readonly connection?: ProviderTestResult;
  readonly result?: ProviderTestResult;
  readonly setupError?: string;
}

/* -------------------------------------------------------------------------- */
/*  Credential reading (values are never printed)                             */
/* -------------------------------------------------------------------------- */

function readConfig(capability: Capability): CapabilityConfig {
  const prefix = capability === 'text' ? 'LIVE_SMOKE_TEXT' : 'LIVE_SMOKE_IMAGE';
  const label = capability === 'text' ? 'TEXT' : 'IMAGE';
  const defaultAdapter = capability === 'text' ? 'openai_chat_completions' : 'openai_images';

  const required: Record<string, string | undefined> = {
    [`${prefix}_BASE_URL`]: process.env[`${prefix}_BASE_URL`],
    [`${prefix}_MODEL`]: process.env[`${prefix}_MODEL`],
    [`${prefix}_API_KEY`]: process.env[`${prefix}_API_KEY`],
  };
  const missing = Object.entries(required)
    .filter(([, value]) => typeof value !== 'string' || value.trim().length === 0)
    .map(([key]) => key);

  return {
    capability,
    label,
    prefix,
    defaultAdapter,
    configured: missing.length === 0,
    missing,
    baseUrl: required[`${prefix}_BASE_URL`] ?? null,
    model: required[`${prefix}_MODEL`] ?? null,
    apiKey: required[`${prefix}_API_KEY`] ?? null,
    adapterType: process.env[`${prefix}_ADAPTER`]?.trim() || defaultAdapter,
  };
}

/* -------------------------------------------------------------------------- */
/*  Classification                                                            */
/* -------------------------------------------------------------------------- */

/** Status ⇒ verdict. A missing/invalid configuration can never be PASS. */
function verdictOf(result: ProviderTestResult | null): Verdict {
  if (!result) return 'FAIL';
  if (result.ok && result.status === 'ready') return 'PASS';
  switch (result.status as CapabilityStatus) {
    case 'not_configured':
    case 'configuration_invalid':
    case 'capability_unsupported':
      return 'BLOCKED';
    default:
      // authentication_failed, rate_limited, temporarily_unavailable,
      // test_failed — the configured request did not work.
      return 'FAIL';
  }
}

function authenticationSucceeded(readiness: ProviderReadiness | undefined): string {
  const probe = readiness?.authentication;
  if (!probe) return 'not probed';
  if (probe.status === 'ready') return `yes (${probe.detail})`;
  return `no — ${probe.status}: ${probe.detail}`;
}

function overallVerdict(reports: readonly CapabilityReport[]): Verdict {
  if (reports.some((r) => r.verdict === 'FAIL')) return 'FAIL';
  if (reports.some((r) => r.verdict !== 'PASS')) return 'BLOCKED';
  return 'PASS';
}

/* -------------------------------------------------------------------------- */
/*  Report                                                                    */
/* -------------------------------------------------------------------------- */

function printLine(key: string, value: string): void {
  console.log(`  ${key.padEnd(14)}: ${value}`);
}

function printReport(reports: readonly CapabilityReport[]): void {
  for (const report of reports) {
    const { config } = report;
    console.log(`\n── ${config.label} ─────────────────────────────────────────`);
    printLine('adapter', config.adapterType);
    printLine('endpoint', config.baseUrl ?? '(not set)');
    printLine('model', config.model ?? '(not set)');
    printLine('credential', config.configured ? 'present (value never shown)' : 'MISSING');

    if (!config.configured) {
      printLine('verdict', `NOT_CONFIGURED — set ${config.missing.join(', ')}`);
      continue;
    }
    if (report.setupError) {
      printLine('verdict', 'BLOCKED');
      printLine('setup error', report.setupError);
      continue;
    }
    if (report.connection) {
      printLine(
        'connection',
        `${report.connection.status} in ${report.connection.durationMs} ms — ${report.connection.detail}`,
      );
      printLine('auth', authenticationSucceeded(report.connection.readiness));
    }
    const result = report.result;
    if (result) {
      printLine(
        'capability',
        `${result.status} in ${result.durationMs} ms — ${result.detail}`,
      );
      printLine('request id', result.requestId ?? '(provider sent none)');
      if (result.text) {
        printLine('generated', `${result.text.chars} chars (model ${result.text.model})`);
        printLine('mandatory end', result.text.endsWithMandatory ? 'yes' : 'NO');
        printLine('preview', `"${result.text.preview}"`);
      }
      if (result.image) {
        printLine(
          'generated',
          `${result.image.mimeType} ${result.image.width}x${result.image.height}, ${result.image.byteLength} bytes (model ${result.image.model})`,
        );
      }
      const readiness = result.readiness;
      printLine(
        'readiness',
        Object.entries(readiness)
          .map(([key, probe]) => `${key}=${probe.status}`)
          .join(' '),
      );
    }
    printLine('verdict', report.verdict);
  }
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

async function runCapability(
  container: AppContainer,
  config: CapabilityConfig,
): Promise<CapabilityReport> {
  if (!config.configured || !config.baseUrl || !config.model || !config.apiKey) {
    return { config, verdict: 'NOT_CONFIGURED' };
  }
  const name = `live-smoke-${config.capability}-${Date.now()}`;
  const displayName = `Live Smoke ${config.label}`;
  let providerId: string | null = null;
  try {
    const provider = await container.providers.create({
      name,
      displayName,
      adapterType: config.adapterType,
      baseUrl: config.baseUrl,
      model: config.model,
      auth: { type: 'bearer' },
    });
    providerId = provider.id;
    // Write-only: the key goes in encrypted and is deleted with the provider.
    await container.providers.setSecret(provider.id, { secret: config.apiKey });

    const connection = await container.providers.testConnection(provider.id);
    const result =
      config.capability === 'text'
        ? await container.providers.testText(provider.id)
        : await container.providers.testImage(provider.id);

    return {
      config,
      verdict: verdictOf(result),
      providerId: provider.id,
      providerName: displayName,
      connection,
      result,
    };
  } catch (error) {
    // Setup problems (endpoint rejected, secrets key missing, …) are
    // configuration states — BLOCKED, never a fabricated PASS or FAIL.
    const message = error instanceof Error ? error.message : String(error);
    return { config, verdict: 'BLOCKED', setupError: message.slice(0, 300) };
  } finally {
    if (providerId) {
      try {
        await container.providers.remove(providerId); // also deletes the secret
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  console.log('PART 7 live provider smoke — one bounded TEXT and one bounded IMAGE request.');
  console.log('Nothing is published; temporary providers are deleted afterwards.');

  const configs = [readConfig('text'), readConfig('image')];
  const configured = configs.filter((c) => c.configured);

  if (configured.length === 0) {
    console.log('\nRESULT: BLOCKED — NOT_CONFIGURED');
    console.log('No live credentials are available, so no live request was attempted.');
    console.log('Missing environment variables (names only, no values):');
    for (const config of configs) {
      for (const key of config.missing) console.log(`  - ${key}`);
    }
    console.log('Live generation verified: NO (NOT_TESTED).');
    process.exit(2);
  }

  /* --- Build the real container (in-process, no HTTP server) ------------- */
  let container: AppContainer;
  try {
    // Default to in-memory stores so the smoke leaves no residue; set
    // NODE_ENV explicitly to record usage rows in a real ledger instead.
    const env = loadEnv({
      NODE_ENV: 'test',
      AUTH_JWT_SECRET: 'live-provider-smoke-throwaway-jwt-secret-0123456789',
      AUTH_JWT_ISSUER: 'live-provider-smoke',
      AUTH_JWT_AUDIENCE: 'live-provider-smoke',
      // Throwaway key when none is configured (the provider is deleted after).
      SECRETS_ENCRYPTION_KEY: process.env.SECRETS_ENCRYPTION_KEY ?? randomBytes(32).toString('hex'),
      ...process.env,
    });
    container = buildContainer({ env, logger: createNullLogger() });
    await container.providers.init();
  } catch (error) {
    console.log('\nRESULT: BLOCKED — environment/configuration problem, no request attempted.');
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    console.log('Live generation verified: NO (NOT_TESTED).');
    process.exit(2);
  }

  const reports: CapabilityReport[] = [];
  try {
    for (const config of configs) {
      reports.push(
        config.configured
          ? await runCapability(container, config)
          : { config, verdict: 'NOT_CONFIGURED' },
      );
    }

    /* --- Usage/cost metadata recorded for this run (honest classes) ------ */
    const providerIds = new Set(
      reports.map((r) => r.providerId).filter((id): id is string => Boolean(id)),
    );
    const usage = await container.usage.summary();
    const rows = usage.recent.filter((row) => row.providerId && providerIds.has(row.providerId));
    if (rows.length > 0) {
      console.log('\nUsage recorded (cost class is whatever the provider actually reported):');
      for (const row of rows) {
        console.log(
          `  - ${row.operation} ${row.status} provider=${row.providerName} model=${row.model} ` +
            `latency=${row.latencyMs}ms cost=${row.costUsd ?? 'n/a'} (${row.costKind})` +
            (row.errorCode ? ` error=${row.errorCode}` : ''),
        );
      }
    } else {
      console.log('\nUsage recorded: no rows (no request completed).');
    }
  } finally {
    await container.shutdown().catch(() => undefined);
  }

  printReport(reports);

  const verdict = overallVerdict(reports);
  const bothExercised = reports.every((r) => r.verdict === 'PASS');
  console.log(`\nRESULT: ${verdict}`);
  console.log(
    `Live generation verified: ${bothExercised ? 'YES — real authenticated requests succeeded' : 'NO (NOT_TESTED)'}.`,
  );
  console.log('Nothing was published to Facebook or Threads.');
  process.exit(verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 2);
}

main().catch((error: unknown) => {
  console.error('Smoke runner crashed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
