ALTER TABLE "journal_entries" ADD COLUMN "pending_replacement_old" bigint;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "pending_replacement_new" bigint;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "delete_old" bigint;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "delete_new" bigint;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "is_refresh" boolean DEFAULT false NOT NULL;