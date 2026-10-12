-- PART 5 migration: production persistence (PostgreSQL-backed stores).
--
-- Adds the columns/tables required for durable, crash-safe operation:
--   1. jobs              — lease-based claiming (worker ownership + expiry)
--   2. slot_contents     — optimistic version + cross-process lock columns
--   3. app_settings      — durable automation settings (single row)
--   4. scheduler_checkpoints — durable scheduler tick/checkpoint state
--   5. products / import_batches — catalog fidelity columns + batch FK
--
-- Nothing in this migration drops or rewrites existing data: every ADD COLUMN
-- is nullable or has a constant DEFAULT, every ADD CONSTRAINT targets existing
-- empty-of-dangling-rows tables, and no DROP statement appears anywhere.

-- --- 1. jobs: lease + claim identity ----------------------------------------
-- A claimed job records WHO owns it, WHEN the claim was made, a per-claim
-- token (so a stale worker cannot commit) and a lease deadline after which
-- another worker may reclaim it. `result` holds the structured outcome of a
-- completed run (never secrets).
ALTER TABLE "jobs"
	ADD COLUMN "claimed_at" timestamp with time zone,
	ADD COLUMN "lease_expires_at" timestamp with time zone,
	ADD COLUMN "claim_token" uuid,
	ADD COLUMN "completed_at" timestamp with time zone,
	ADD COLUMN "result" text DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Drives the claim scan: due jobs, plus expired leases that must be recovered.
CREATE INDEX "jobs_lease_idx" ON "jobs" USING btree ("status", "lease_expires_at");--> statement-breakpoint
CREATE INDEX "jobs_kind_idx" ON "jobs" USING btree ("kind");--> statement-breakpoint

-- --- 2. slot_contents: stale-writer guard -----------------------------------
-- `version` increments on every committed write; a writer that lost the race
-- updates 0 rows (its WHERE clause no longer matches) and must re-read.
-- `lock_owner`/`lock_expires_at` allow a crashed worker's slot to be resumed.
ALTER TABLE "slot_contents"
	ADD COLUMN "version" integer DEFAULT 1 NOT NULL,
	ADD COLUMN "lock_owner" varchar(100),
	ADD COLUMN "lock_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "slot_contents_lock_idx" ON "slot_contents" USING btree ("lock_expires_at");--> statement-breakpoint
CREATE INDEX "slot_contents_completed_idx" ON "slot_contents" USING btree ("completed_at");--> statement-breakpoint

-- --- 3. app_settings (single row) -------------------------------------------
-- Holds the validated automation settings document (automationState, interval,
-- daily cap, selection mode, image-count policy). The CHECK constraint makes
-- "exactly one row" a database invariant rather than an application habit.
CREATE TABLE "app_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"doc" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_single_row" CHECK ("id" = 1)
);--> statement-breakpoint

-- --- 4. scheduler_checkpoints ------------------------------------------------
-- Durable tick/anti-catch-up state: what the scheduler last did, so a restart
-- resumes instead of re-planning blind. Keyed by checkpoint name.
CREATE TABLE "scheduler_checkpoints" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"doc" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- --- 5. catalog fidelity -----------------------------------------------------
-- `product_url_normalized` is the dedupe key used by the importer
-- (urlDuplicatesSkipped); without it a re-import could not reproduce the
-- PART 3 idempotency behaviour in PostgreSQL.
ALTER TABLE "products"
	ADD COLUMN "product_url_normalized" text;--> statement-breakpoint
CREATE INDEX "products_url_normalized_idx" ON "products" USING btree ("product_url_normalized");--> statement-breakpoint

-- Import batch bookkeeping that PART 3 records per batch and PART 5 must not
-- lose: new/updated/url-duplicate counters, categories seen, per-row issues
-- and the batch source. `created_at` from 0000 is the batch timestamp.
ALTER TABLE "import_batches"
	ADD COLUMN "new_products" integer DEFAULT 0 NOT NULL,
	ADD COLUMN "updated_products" integer DEFAULT 0 NOT NULL,
	ADD COLUMN "url_duplicates_skipped" integer DEFAULT 0 NOT NULL,
	ADD COLUMN "categories_seen" integer DEFAULT 0 NOT NULL,
	ADD COLUMN "issues" text DEFAULT '[]' NOT NULL,
	ADD COLUMN "source" varchar(32) DEFAULT 'feed_import' NOT NULL;--> statement-breakpoint

-- Referential integrity from product -> the batch that produced it.
ALTER TABLE "products" ADD CONSTRAINT "products_import_batch_id_import_batches_id_fk"
	FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id")
	ON DELETE set null ON UPDATE no action;
