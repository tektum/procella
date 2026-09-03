WITH ranked_updates AS (
	SELECT
		id,
		stack_id,
		version,
		MAX(version) OVER (PARTITION BY stack_id) AS max_version,
		ROW_NUMBER() OVER (
			PARTITION BY stack_id, version
			ORDER BY created_at DESC, id DESC
		) AS duplicate_rank
	FROM updates
	WHERE kind <> 'preview'
), collision_replacements AS (
	SELECT
		id,
		(max_version + ROW_NUMBER() OVER (
			PARTITION BY stack_id
			ORDER BY version, id
		))::integer AS version
	FROM ranked_updates
	WHERE duplicate_rank > 1
)
UPDATE updates
SET version = collision_replacements.version
FROM collision_replacements
WHERE updates.id = collision_replacements.id;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_updates_stack_version" ON "updates" USING btree ("stack_id", "version") WHERE "updates"."kind" <> 'preview';
