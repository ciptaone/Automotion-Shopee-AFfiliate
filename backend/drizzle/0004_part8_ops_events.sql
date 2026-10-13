CREATE TABLE "ops_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"fingerprint" varchar(255) NOT NULL,
	"kind" varchar(40) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cooldown_until" timestamp with time zone,
	"last_delivery_status" varchar(20) DEFAULT 'not_sent' NOT NULL,
	"last_error_code" varchar(60),
	"last_message_id" varchar(64),
	"last_notified_at" timestamp with time zone,
	CONSTRAINT "ops_events_severity_check" CHECK (severity in ('info', 'warning', 'critical')),
	CONSTRAINT "ops_events_delivery_check" CHECK (last_delivery_status in ('not_sent', 'deduped', 'cooldown', 'sent', 'failed', 'not_configured'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ops_events_fingerprint_idx" ON "ops_events" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "ops_events_last_seen_idx" ON "ops_events" USING btree ("last_seen_at");