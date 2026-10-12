import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 * Migrations are applied with `drizzle-kit migrate` against `DATABASE_URL`.
 * The generated SQL is committed under `drizzle/` so schema changes are
 * reviewable and reproducible without a live database.
 *
 * The connection URL is read from the environment ONLY. There is deliberately
 * no placeholder default: a silent `postgres://postgres:postgres@localhost`
 * fallback would let a mistyped environment target somebody else's local
 * database instead of failing loudly. `db:generate` never needs the URL; the
 * getter below is only evaluated by commands that actually open a connection.
 */
function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL']?.trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Set it in the server-side environment ' +
        '(backend/.env for local development) to a PostgreSQL connection string, ' +
        'for example postgres://user:password@host:5432/dbname. ' +
        'Never commit the real value.',
    );
  }
  return url;
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    get url(): string {
      return requireDatabaseUrl();
    },
  },
  strict: true,
  verbose: true,
});
