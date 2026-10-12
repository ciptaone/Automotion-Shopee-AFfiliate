CREATE TABLE "api_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" varchar(255),
	"scopes" text DEFAULT 'dashboard read' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"filename" varchar(255) NOT NULL,
	"format" varchar(8) NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"duplicates_removed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" varchar(100) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"unique_key" varchar(255) NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"payload" text DEFAULT '{}' NOT NULL,
	"claimed_by" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dedupe_key" varchar(255) NOT NULL,
	"kind" varchar(40) NOT NULL,
	"title" text NOT NULL,
	"delivered" boolean DEFAULT false NOT NULL,
	"transport" varchar(20) DEFAULT 'mock' NOT NULL,
	"telegram_message_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"feed_id" varchar(255) NOT NULL,
	"name" text NOT NULL,
	"marketplace" varchar(64) NOT NULL,
	"product_url" text NOT NULL,
	"affiliate_url" text NOT NULL,
	"price" double precision,
	"currency" varchar(16),
	"commission_rate" double precision,
	"image_url" text,
	"category" varchar(255),
	"rating" double precision,
	"sold_count" integer,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid,
	"product_id" uuid,
	"slot_key" varchar(64) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"success" boolean DEFAULT false NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"post_id" varchar(255),
	"permalink" text,
	"error_detail" text,
	"caption_hash" varchar(64),
	"image_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "publish_runs" ADD CONSTRAINT "publish_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_runs" ADD CONSTRAINT "publish_runs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_clients_label_idx" ON "api_clients" USING btree ("label");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_unique_key_idx" ON "jobs" USING btree ("unique_key");--> statement-breakpoint
CREATE INDEX "jobs_status_scheduled_idx" ON "jobs" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key_idx" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "products_feed_id_marketplace_idx" ON "products" USING btree ("feed_id","marketplace");--> statement-breakpoint
CREATE INDEX "products_import_batch_idx" ON "products" USING btree ("import_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_runs_slot_provider_idx" ON "publish_runs" USING btree ("slot_key","provider");--> statement-breakpoint
CREATE INDEX "publish_runs_job_idx" ON "publish_runs" USING btree ("job_id");