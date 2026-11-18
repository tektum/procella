ALTER TABLE "stacks" ADD COLUMN "managed_environment" text;--> statement-breakpoint
ALTER TABLE "updates" ADD COLUMN "managed_environment" jsonb;
