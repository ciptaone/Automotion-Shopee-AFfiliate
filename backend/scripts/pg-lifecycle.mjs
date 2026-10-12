#!/usr/bin/env node
/**
 * PostgreSQL test-cluster lifecycle (PART 5).
 *
 * Starts an isolated, real PostgreSQL server for database integration tests,
 * writes a readiness file that admin-side scripts/tests can consume, and waits
 * for a stop flag before shutting the cluster down cleanly.
 *
 * WHY THIS EXISTS (Windows only):
 * PostgreSQL refuses to run under an elevated token
 * ("Execution of PostgreSQL by a user with administrative permissions is not
 * permitted"). `scripts/db.ps1` therefore launches this file under a
 * throwaway, unprivileged local account when the calling shell is elevated,
 * while the test suite itself connects over TCP as a normal client.
 *
 * NEVER used in production: production connects to a managed PostgreSQL via
 * DATABASE_URL. This cluster holds no production data and is torn down by the
 * test runner.
 *
 * Files written (all under the gitignored `backend/tmp/` folder):
 *   pg-creds.json  — local cluster login (throwaway, never committed)
 *   pg-status.json — readiness + connection URL for client processes
 *   pg-stop.flag   — presence tells this process to shut down
 */
import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const root = process.cwd();
const tmpDir = path.join(root, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const credsPath = path.join(tmpDir, 'pg-creds.json');
const statusPath = path.join(tmpDir, 'pg-status.json');
const stopPath = path.join(tmpDir, 'pg-stop.flag');
const dataDir = path.join(tmpDir, 'pgdata');

function readJson(file) {
  try {
    // Tolerate a leading BOM: Windows tools sometimes emit one.
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

const creds = readJson(credsPath);
if (!creds?.user || !creds?.password || !creds?.port || !creds?.database) {
  console.error('[pg] missing or incomplete tmp/pg-creds.json — start via scripts/db.ps1');
  process.exit(2);
}

if (process.argv.includes('--fresh') && fs.existsSync(dataDir)) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('[pg] removed previous data directory (--fresh)');
}
fs.rmSync(stopPath, { force: true });
fs.rmSync(statusPath, { force: true });

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: creds.user,
  password: creds.password,
  port: Number(creds.port),
  // Keep the cluster between runs so only `--fresh` wipes it.
  persistent: true,
  // WITHOUT an explicit encoding, `initdb --locale=C` yields a SQL_ASCII
  // cluster: then any non-ASCII byte (an emoji in a caption, a rupiah sign in a
  // product name) is rejected with `22P05` — the classic "works on my machine,
  // fails on the data" trap. UTF-8 + the C locale is what the application
  // assumes everywhere else (all timestamps are UTC, all text is UTF-8).
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});

let stopping = false;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  try {
    fs.rmSync(statusPath, { force: true });
  } catch {
    /* ignore */
  }
  try {
    await pg.stop();
  } catch (error) {
    console.error(`[pg] stop reported: ${error?.message ?? error}`);
  }
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

try {
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    console.log('[pg] initialising cluster...');
    await pg.initialise();
  }
  console.log('[pg] starting server...');
  await pg.start();

  try {
    await pg.createDatabase(creds.database);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!/already exists|duplicate database/i.test(message)) throw error;
  }

  const url =
    `postgres://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.password)}` +
    `@127.0.0.1:${creds.port}/${creds.database}`;

  fs.writeFileSync(
    statusPath,
    `${JSON.stringify(
      {
        ready: true,
        port: Number(creds.port),
        database: creds.database,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        url,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`[pg] ready — 127.0.0.1:${creds.port}/${creds.database} (pid ${process.pid})`);

  // Poll for the stop flag written by scripts/db.ps1.
  // (`globalThis.` keeps this file valid under flat-config lint, which does not
  //  inject Node globals into .mjs files by default.)
  const timer = globalThis.setInterval(() => {
    if (fs.existsSync(stopPath)) {
      globalThis.clearInterval(timer);
      console.log('[pg] stop flag received, shutting down...');
      void shutdown(0);
    }
  }, 400);
} catch (error) {
  console.error(`[pg] FAILED: ${error?.message ?? error}`);
  await shutdown(1);
}
