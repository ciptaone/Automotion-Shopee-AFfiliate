/**
 * `npm run db:import -- [--dir ./data] [--apply]` — migrate local file data
 * into PostgreSQL ONCE, deliberately and repeatably.
 *
 * PART 5 rule: production never reads or writes `backend/data/*.json`. This CLI
 * exists so an existing local development catalog/settings/slots set can be
 * moved over without losing anything and without a hand-rolled script.
 *
 * Safety properties:
 *   - DRY RUN BY DEFAULT. Nothing is written unless `--apply` is passed.
 *   - OPT-IN ONLY. Nothing in the app ever calls this automatically.
 *   - IDEMPOTENT. Products/batches upsert on their natural keys
 *     (`(feed_id, marketplace)` and batch id); slot rows are insert-if-absent,
 *     so re-running can never overwrite a row the running system has since
 *     updated, and a second run reports "0 imported".
 *   - NO DELETES. It only ever adds or refreshes rows; nothing is dropped.
 *   - READS ONLY THE FILE STORE'S OWN FORMATS — it does not invent data.
 *
 * Never prints credentials or payload contents; only counts and identifiers.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createDatabaseHandle, sanitizeDatabaseError } from '../db/client.js';
import { loadDotEnv } from '../core/dotenv.js';
import { PostgresCatalogStore } from '../db/postgres-catalog-store.js';
import { PostgresSettingsStore } from '../db/postgres-settings-store.js';
import { PostgresSlotStore } from '../db/postgres-slot-store.js';
import type { AutomationSettings } from '../settings/automation-settings.js';
import type { CatalogSnapshot } from '../catalog/catalog.js';
import type { SlotStoreSnapshot } from '../automation/slot-store.js';

interface Args {
  readonly dir: string;
  readonly apply: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let dir = path.join(process.cwd(), 'data');
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--dir' && argv[i + 1]) {
      dir = path.resolve(argv[i + 1] ?? dir);
      i += 1;
    }
  }
  return { dir, apply };
}

async function readJson<T>(filePath: string): Promise<{ value: T | null; problem: string | null }> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return { value: JSON.parse(raw) as T, problem: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { value: null, problem: 'not present' };
    return { value: null, problem: `unreadable (${(error as Error).message.split('\n')[0]})` };
  }
}

async function main(): Promise<number> {
  loadDotEnv();
  const { dir, apply } = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error(
      'DATABASE_URL is not set. Set it server-side (backend/.env for local development) and retry.',
    );
    return 2;
  }

  const handle = createDatabaseHandle(url);
  if (!handle.db) {
    console.error('Could not create a database connection.');
    await handle.close();
    return 1;
  }
  const db = handle.db;

  try {
    if (!(await handle.healthy())) {
      console.error(`Could not reach PostgreSQL: ${await handle.statusDetail()}`);
      return 1;
    }

    const mode = apply ? 'APPLY' : 'DRY RUN (pass --apply to write)';
    console.log(`source directory : ${dir}`);
    console.log(`mode             : ${mode}\n`);

    let wrote = 0;

    /* --- settings ------------------------------------------------------- */
    const settings = await readJson<AutomationSettings>(path.join(dir, 'settings.json'));
    if (settings.problem) {
      console.log(`settings.json    : ${settings.problem} (skipped)`);
    } else if (settings.value) {
      if (apply) {
        await new PostgresSettingsStore(db).save(settings.value);
        wrote += 1;
      }
      console.log(
        `settings.json    : ${apply ? 'written' : 'would write'} (automationState=${settings.value.automationState}, interval=${settings.value.intervalMinutes}m)`,
      );
    }

    /* --- catalog -------------------------------------------------------- */
    const catalog = await readJson<CatalogSnapshot>(path.join(dir, 'catalog.json'));
    if (catalog.problem) {
      console.log(`catalog.json     : ${catalog.problem} (skipped)`);
    } else if (catalog.value) {
      const products = catalog.value.products?.length ?? 0;
      const batches = catalog.value.batches?.length ?? 0;
      if (apply) {
        await new PostgresCatalogStore(db).save(catalog.value);
        wrote += products + batches;
      }
      console.log(
        `catalog.json     : ${apply ? 'written' : 'would write'} (${products} products, ${batches} import batches; upserted by natural key)`,
      );
    }

    /* --- slot content --------------------------------------------------- */
    const slots = await readJson<SlotStoreSnapshot>(path.join(dir, 'slots.json'));
    if (slots.problem) {
      console.log(`slots.json       : ${slots.problem} (skipped)`);
    } else if (slots.value) {
      const records = slots.value.slots ?? [];
      if (apply) {
        // A dry run must not touch the database: the insert loop lives inside
        // the `apply` branch on purpose.
        const store = new PostgresSlotStore(db);
        let inserted = 0;
        let skipped = 0;
        for (const record of records) {
          const outcome = await store.write(record);
          if (outcome.ok) inserted += 1;
          else skipped += 1; // a row already exists: never overwrite newer state
        }
        wrote += inserted;
        console.log(
          `slots.json       : ${inserted} inserted, ${skipped} already present (existing rows are never overwritten)`,
        );
      } else {
        console.log(`slots.json       : would insert ${records.length} records (insert-if-absent)`);
      }
    }

    if (wrote === 0 && !apply) {
      console.log('\nRESULT: dry run complete — nothing was written.');
      return 0;
    }
    console.log(`\nRESULT: ${apply ? `imported ${wrote} record(s).` : 'dry run complete — nothing was written.'}`);
    console.log('Re-running is safe: every write is an idempotent upsert or an insert-if-absent.');
    return 0;
  } catch (error) {
    console.error(`db:import failed: ${sanitizeDatabaseError(error)}`);
    return 1;
  } finally {
    await handle.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`db:import failed: ${sanitizeDatabaseError(error)}`);
    process.exit(1);
  },
);
