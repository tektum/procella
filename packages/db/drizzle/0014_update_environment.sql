ALTER TABLE "updates" ADD COLUMN "environment" jsonb DEFAULT '{}'::jsonb NOT NULL;
