-- PART 3 migration: product catalog enrichment + slot content records.
--
-- BLOCKED NOTE: this migration has NOT been applied to a live PostgreSQL
-- server in the development environment (no database available). It is
-- generated to match src/db/schema.ts and is verified only by the Drizzle
-- schema snapshot, not by an actual `drizzle-kit migrate` run.

ALTER TABLE "products"
	ADD COLUMN "has_affiliate_link" boolean DEFAULT false NOT NULL,
	ADD COLUMN "category_id" varchar(64),
	ADD COLUMN "description" text,
	ADD COLUMN "eligible" boolean DEFAULT false NOT NULL,
	ADD COLUMN "eligibility_reasons" text DEFAULT '[]' NOT NULL,
	ADD COLUMN "extra_columns" text DEFAULT '{}' NOT NULL,
	ADD COLUMN "last_imported_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "products_eligible_idx" ON "products" USING btree ("eligible");--> statement-breakpoint
CREATE TABLE "slot_contents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slot_key" varchar(64) NOT NULL,
	"stage" varchar(32) DEFAULT 'reserved' NOT NULL,
	"product_id" uuid,
	"source_product_id" varchar(255),
	"product_name" text,
	"affiliate_url" text,
	"category_id" varchar(64),
	"image_count_policy" varchar(32) DEFAULT 'random_1_or_2' NOT NULL,
	"image_count" integer DEFAULT 1 NOT NULL,
	"image_count_chosen_at" timestamp with time zone,
	"selection" text DEFAULT '{}' NOT NULL,
	"reference_url" text,
	"generation_run_id" varchar(64),
	"assets" text DEFAULT '[]' NOT NULL,
	"captions" text DEFAULT '[]' NOT NULL,
	"validation_passed" boolean DEFAULT false NOT NULL,
	"blockers" text DEFAULT '[]' NOT NULL,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "slot_contents" ADD CONSTRAINT "slot_contents_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slot_contents_slot_key_idx" ON "slot_contents" USING btree ("slot_key");--> statement-breakpoint
CREATE INDEX "slot_contents_stage_idx" ON "slot_contents" USING btree ("stage");
