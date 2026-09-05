ALTER TABLE "updates" ADD COLUMN "github_target" jsonb;
--> statement-breakpoint
ALTER TABLE "updates" ADD COLUMN "github_comment_id" text;
--> statement-breakpoint
ALTER TABLE "updates" ADD COLUMN "summary_sequence" integer;
--> statement-breakpoint
ALTER TABLE "updates" ADD COLUMN "summary" jsonb;
--> statement-breakpoint
CREATE TABLE "github_update_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"update_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"delivered_revision" integer DEFAULT 0 NOT NULL,
	"failed_revision" integer DEFAULT 0 NOT NULL,
	"failed_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"claimed_by" uuid,
	"claimed_until" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_github_update_outbox_phase" CHECK ("github_update_outbox"."phase" IN ('started', 'terminal')),
	CONSTRAINT "chk_github_update_outbox_revisions" CHECK ("github_update_outbox"."revision" >= 1 AND "github_update_outbox"."delivered_revision" >= 0 AND "github_update_outbox"."delivered_revision" <= "github_update_outbox"."revision" AND "github_update_outbox"."failed_revision" >= 0 AND "github_update_outbox"."failed_revision" <= "github_update_outbox"."revision")
);
--> statement-breakpoint
ALTER TABLE "github_update_outbox" ADD CONSTRAINT "github_update_outbox_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_update_outbox_update_phase" ON "github_update_outbox" USING btree ("update_id", "phase");
--> statement-breakpoint
CREATE INDEX "idx_github_update_outbox_available" ON "github_update_outbox" USING btree ("available_at", "claimed_until");
