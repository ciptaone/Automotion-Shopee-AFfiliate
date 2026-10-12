/**
 * `npm run env:check` — validate the environment WITHOUT starting the server.
 *
 * Exit codes:
 *   0  environment valid
 *   78 invalid environment (EX_CONFIG)
 *
 * Output lists offending KEY NAMES and messages. Secret VALUES are never printed.
 */
import { loadEnv, describeIntegrationStatus } from '../core/env.js';
import { EnvironmentError } from '../core/errors.js';

function main(): void {
  try {
    const env = loadEnv(process.env);
    console.log('✓ Environment is valid.\n');

    console.log('Runtime:');
    console.log(`  NODE_ENV                = ${env.NODE_ENV}`);
    console.log(`  PORT                    = ${env.PORT}`);
    console.log(`  LOG_LEVEL               = ${env.LOG_LEVEL}`);
    console.log(`  Scheduler enabled       = ${env.SCHEDULER_ENABLED}`);
    console.log(`  Scheduler timezone      = ${env.SCHEDULER_TIMEZONE}`);
    console.log(`  Scheduler interval (m)  = ${env.SCHEDULER_INTERVAL_MINUTES}`);
    console.log(`  Scheduler max slots/day = ${env.SCHEDULER_MAX_SLOTS_PER_DAY}`);
    console.log('');

    console.log('Integrations (configured = credentials present; no values shown):');
    for (const status of describeIntegrationStatus(env)) {
      const flag = status.configured ? '✓' : '·';
      console.log(`  ${flag} ${status.service.padEnd(16)} mode=${status.mode.padEnd(12)} ${status.detail}`);
    }
    console.log('');

    const configured = describeIntegrationStatus(env).filter((s) => s.configured).length;
    console.log(
      `${configured}/${describeIntegrationStatus(env).length} integrations have credentials. Part 1 runs safely with none of them set (all mocks).`,
    );
    process.exit(0);
  } catch (error) {
    if (error instanceof EnvironmentError) {
      console.error('✗ Environment is INVALID.\n');
      console.error(error.message);
      console.error('\nFix the keys above in backend/.env (see backend/.env.example).');
      process.exit(78);
    }
    console.error('✗ Unexpected error while validating the environment.');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
