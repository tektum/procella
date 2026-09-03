WITH numbered_updates AS (
	SELECT
		id,
		ROW_NUMBER() OVER (PARTITION BY stack_id ORDER BY created_at, id)::integer AS version
	FROM updates
	WHERE kind <> 'preview'
)
UPDATE updates
SET version = numbered_updates.version
FROM numbered_updates
WHERE updates.id = numbered_updates.id;
--> statement-breakpoint
WITH preview_versions AS (
	SELECT
		preview.id,
		COALESCE((
			SELECT MAX(candidate.version)
			FROM updates AS candidate
			WHERE candidate.stack_id = preview.stack_id
				AND candidate.kind <> 'preview'
				AND candidate.status = 'succeeded'
				AND (
					candidate.created_at < preview.created_at
					OR (candidate.created_at = preview.created_at AND candidate.id < preview.id)
				)
		), 0)::integer AS version
	FROM updates AS preview
	WHERE preview.kind = 'preview'
)
UPDATE updates
SET version = preview_versions.version
FROM preview_versions
WHERE updates.id = preview_versions.id;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_updates_stack_version" ON "updates" USING btree ("stack_id", "version") WHERE "updates"."kind" <> 'preview';
