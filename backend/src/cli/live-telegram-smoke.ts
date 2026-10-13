/**
 * `npm run smoke:telegram` — PART 8 §6: OPT-IN live Telegram smoke test.
 *
 * This is the ONLY entry point that ever sends a REAL Telegram message. The
 * default test suite can never reach a real chat: it uses the in-memory
 * transport or an injected fetch, and this script stays BLOCKED until the
 * operator supplies credentials.
 *
 * Credentials (never committed, never printed — only their KEY NAMES appear):
 *
 *   LIVE_SMOKE_TELEGRAM_BOT_TOKEN   bot token from @BotFather
 *   LIVE_SMOKE_TELEGRAM_CHAT_ID     target chat id or @channel username
 *
 * Behaviour:
 *   - Missing credentials ⇒ `BLOCKED` / `NOT_CONFIGURED`, exit 2 — NEVER PASS.
 *   - Configured ⇒ exactly ONE explicit test message is sent (no events, no
 *     repeated sends, no rate-limit pressure).
 *   - PASS requires Telegram's own confirmation (`ok: true` + `message_id`).
 *     A 200 without confirmation, a rejection, or a timeout ⇒ FAIL, exit 1.
 *   - Nothing is ever published to Facebook or Threads — this script has no
 *     publisher access at all.
 *
 * Exit codes: 0 = PASS · 1 = FAIL · 2 = BLOCKED / NOT_CONFIGURED / bad config.
 *
 * Live Telegram delivery is verified ONLY when this script prints PASS.
 */
import { randomBytes } from 'node:crypto';
import { buildContainer, type AppContainer } from '../app/container.js';
import { loadEnv } from '../core/env.js';
import { createNullLogger } from '../core/logger.js';

const TOKEN_KEY = 'LIVE_SMOKE_TELEGRAM_BOT_TOKEN';
const CHAT_KEY = 'LIVE_SMOKE_TELEGRAM_CHAT_ID';

async function main(): Promise<void> {
  console.log('PART 8 live Telegram smoke — exactly ONE explicit test message.');
  console.log('Nothing is published to Facebook or Threads (no publisher access here).');

  const token = process.env[TOKEN_KEY];
  const chatId = process.env[CHAT_KEY];
  const missing = [!token?.trim() ? TOKEN_KEY : null, !chatId?.trim() ? CHAT_KEY : null].filter(
    (key): key is string => key !== null,
  );

  if (missing.length > 0) {
    console.log('\nRESULT: BLOCKED — NOT_CONFIGURED');
    console.log('No Telegram credentials are available, so no message was attempted.');
    console.log('Missing environment variables (names only, no values):');
    for (const key of missing) console.log(`  - ${key}`);
    console.log('Live Telegram delivery verified: NO (NOT_TESTED).');
    process.exit(2);
  }

  let container: AppContainer;
  try {
    const env = loadEnv({
      NODE_ENV: 'test', // in-memory stores: the smoke leaves no residue
      AUTH_JWT_SECRET: 'live-telegram-smoke-throwaway-jwt-secret-0123456789',
      AUTH_JWT_ISSUER: 'live-telegram-smoke',
      AUTH_JWT_AUDIENCE: 'live-telegram-smoke',
      CORS_ORIGINS: 'http://localhost',
      SECRETS_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      ...process.env,
      // The smoke's explicit credentials win over any ambient TELEGRAM_* env.
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_CHAT_ID: chatId,
    });
    container = buildContainer({ env, logger: createNullLogger() });
  } catch (error) {
    console.log('\nRESULT: BLOCKED — environment/configuration problem, no message attempted.');
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    console.log('Live Telegram delivery verified: NO (NOT_TESTED).');
    process.exit(2);
  }

  let exitCode = 2;
  try {
    const result = await container.telegramService.sendTestMessage();

    console.log('\n── Delivery ────────────────────────────────────────');
    console.log(`  status           : ${result.status}`);
    console.log(`  delivered        : ${result.delivered ? 'yes' : 'no'}`);
    console.log(`  telegram message : ${result.messageId ?? '(none confirmed)'}`);
    console.log(`  error code       : ${result.errorCode ?? '(none)'}`);
    console.log(
      '  note             : "sent" is reported only when Telegram confirmed the message (ok + message_id).',
    );

    if (result.delivered) {
      console.log('\nRESULT: PASS');
      console.log('Live Telegram delivery verified: YES — Telegram confirmed the test message.');
      exitCode = 0;
    } else if (result.status === 'not_configured') {
      console.log('\nRESULT: BLOCKED — NOT_CONFIGURED');
      console.log('Live Telegram delivery verified: NO (NOT_TESTED).');
      exitCode = 2;
    } else {
      console.log('\nRESULT: FAIL');
      console.log(`Telegram did not confirm delivery (errorCode=${result.errorCode ?? 'unknown'}).`);
      console.log('Live Telegram delivery verified: NO (FAILED).');
      exitCode = 1;
    }
  } catch (error) {
    console.log('\nRESULT: FAIL — the smoke runner errored.');
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  } finally {
    await container.shutdown().catch(() => undefined);
  }
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  console.error('Telegram smoke crashed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
