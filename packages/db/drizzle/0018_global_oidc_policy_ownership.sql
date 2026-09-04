LOCK TABLE "oidc_trust_policies" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "oidc_trust_policies"
		GROUP BY "org_slug", "issuer"
		HAVING COUNT(DISTINCT "tenant_id") > 1
	) THEN
		RAISE EXCEPTION 'OIDC trust policy ownership migration blocked: reconcile duplicate (org_slug, issuer) rows before retrying';
	END IF;
END
$$;
--> statement-breakpoint
DROP INDEX "idx_oidc_trust_org_issuer";
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oidc_trust_org_issuer" ON "oidc_trust_policies" USING btree ("org_slug", "issuer");
