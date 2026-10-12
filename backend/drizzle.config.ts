import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 * Migrations are applied with `drizzle-kit migrate` against `DATABASE_URL`.
 * The generated SQL is committed under `drizzle/` so schema changes are reviewable
 * and reproducible without a live database.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/autopilot',
  },
  strict: true,
  verbose: true,
});
