CREATE TABLE "github_setup_states" (
	"jti" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_github_setup_states_expires" ON "github_setup_states" USING btree ("expires_at");
--> statement-breakpoint
-- Existing rows were inferred from GitHub account names and are not authenticated
-- tenant bindings. Drop them so every retained row originates from signed setup.
DELETE FROM "github_installations";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_github_tenant_installation";
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_installation_id" ON "github_installations" USING btree ("installation_id");
