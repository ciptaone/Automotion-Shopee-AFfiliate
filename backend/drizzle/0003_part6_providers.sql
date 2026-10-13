CREATE TABLE "generation_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_id" varchar(64),
	"provider_name" varchar(120) NOT NULL,
	"adapter_type" varchar(40),
	"model" varchar(200) NOT NULL,
	"operation" varchar(32) NOT NULL,
	"request_id" varchar(200),
	"status" varchar(16) NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"images" integer,
	"cost_usd" double precision,
	"cost_kind" varchar(16) DEFAULT 'unknown' NOT NULL,
	"error_code" varchar(64),
	CONSTRAINT "generation_usage_status_check" CHECK (status in ('success', 'error')),
	CONSTRAINT "generation_usage_cost_kind_check" CHECK (cost_kind in ('actual', 'estimated', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "provider_secrets" (
	"provider_id" varchar(64) PRIMARY KEY NOT NULL,
	"alg" varchar(16) DEFAULT 'A256GCM' NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"ct" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_workspaces" (
	"id" smallint PRIMARY KEY NOT NULL,
	"doc" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_workspaces_single_row" CHECK (id = 1)
);
--> statement-breakpoint
CREATE INDEX "generation_usage_at_idx" ON "generation_usage" USING btree ("at");