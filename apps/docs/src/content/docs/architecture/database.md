---
title: Database Schema
description: PostgreSQL schema — tables, indexes, constraints, and relationships.
---

Procella uses PostgreSQL 17 for all metadata and state. The schema is managed through Drizzle ORM migrations that run automatically on server startup.

## Entity Relationship

```
projects ◄──── stacks ◄──── updates ◄──── update_events
                                │
                                │
                            checkpoints
```

## Tables

### projects

Namespace for stacks. Each project is identified by a tenant ID (from Descope JWT) and a name.

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `tenantId` | `TEXT` | `NOT NULL` (from Descope JWT) |
| `name` | `TEXT` | `NOT NULL` |
| `description` | `TEXT` | |
| `createdAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |
| `updatedAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |
| | | `UNIQUE (tenantId, name)` |

**Index**: `idx_projects_tenant_name` on `(tenantId, name)` — fast lookup by tenant and project name.

### stacks

The core entity. Each stack belongs to a project and tracks its current active update.

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `projectId` | `UUID` | `FK → projects(id) ON DELETE CASCADE` |
| `name` | `TEXT` | `NOT NULL` |
| `tags` | `JSONB` | `NOT NULL DEFAULT '{}'` |
| `activeUpdateId` | `UUID` | Nullable — set when an update is running |
| `createdAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |
| `updatedAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |
| | | `UNIQUE (projectId, name)` |

**Index**: `idx_stacks_project_name` on `(projectId, name)` — fast lookup by project and stack name.

### updates

Tracks every operation performed on a stack (update, preview, refresh, destroy, import, etc.).

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `stackId` | `UUID` | Soft reference (no FK) — identifies the stack |
| `kind` | `TEXT` | `NOT NULL` — update, preview, refresh, destroy, import, etc. |
| `status` | `TEXT` | `NOT NULL DEFAULT 'not started'` — not started, requested, running, succeeded, failed, cancelled |
| `result` | `TEXT` | Nullable — final result message |
| `message` | `TEXT` | Nullable — status message |
| `version` | `INT` | `NOT NULL DEFAULT 1` — checkpoint version |
| `leaseToken` | `TEXT` | Nullable — token for execution phase |
| `leaseExpiresAt` | `TIMESTAMP` | Nullable — lease expiration time |
| `startedAt` | `TIMESTAMP` | Nullable |
| `completedAt` | `TIMESTAMP` | Nullable |
| `createdAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |
| `updatedAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |
| `config` | `JSONB` | `NOT NULL DEFAULT '{}'` — stack config |
| `program` | `JSONB` | `NOT NULL DEFAULT '{}'` — program metadata |

**Index**: `idx_updates_active` — **Partial unique** on `(stackId) WHERE status IN ('not started', 'requested', 'running')` — prevents concurrent updates on the same stack.

### checkpoints

Infrastructure state snapshots. Each checkpoint is associated with an update and a version number.

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `updateId` | `UUID` | `FK → updates(id) ON DELETE CASCADE` |
| `stackId` | `UUID` | Soft reference — identifies the stack |
| `version` | `INT` | `NOT NULL` — checkpoint version |
| `data` | `JSONB` | `NOT NULL` — deployment state |
| `blobKey` | `TEXT` | Nullable — reference to blob storage |
| `isDelta` | `BOOLEAN` | `NOT NULL DEFAULT false` — whether this is a delta checkpoint |
| `createdAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |

**Index**: `idx_checkpoints_update_version` on `(updateId, version)` — fast lookup of checkpoints per update.

### update_events

Engine events emitted during an update (resource operations, diagnostics, outputs).

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `updateId` | `UUID` | `FK → updates(id) ON DELETE CASCADE` |
| `sequence` | `INT` | `NOT NULL` — event sequence number |
| `kind` | `TEXT` | `NOT NULL` — event type |
| `fields` | `JSONB` | `NOT NULL` — event data |
| `createdAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |
| | | `UNIQUE (updateId, sequence)` |

**Index**: `idx_update_events_update_sequence` on `(updateId, sequence)` — ordered event retrieval.

## Key Indexes

| Index | Table | Purpose |
|---|---|---|
| `idx_projects_tenant_name` | `projects` | `(tenantId, name)` — fast lookup by tenant and project |
| `idx_stacks_project_name` | `stacks` | `(projectId, name)` — fast lookup by project and stack |
| `idx_updates_active` | `updates` | **Partial unique**: `(stackId) WHERE status IN ('not started', 'requested', 'running')` — prevents concurrent updates |
| `idx_checkpoints_update_version` | `checkpoints` | `(updateId, version)` — fast checkpoint lookup |
| `idx_update_events_update_sequence` | `update_events` | `(updateId, sequence)` — ordered event retrieval |
| `idx_github_update_outbox_update_phase` | `github_update_outbox` | Unique `(updateId, phase)` publication intent |
| `idx_github_update_outbox_available` | `github_update_outbox` | Due and expired-lease claim scanning |

## Auto-Create Pattern

When creating a stack, Procella auto-creates the project if it doesn't exist using Drizzle's `INSERT ... ON CONFLICT DO NOTHING`:

```typescript
await db.insert(projects).values({
  id: projectId,
  tenantId,
  name: projectName,
}).onConflictDoNothing();
```

This simplifies the CLI workflow — `pulumi stack init` creates everything in one step.

## Advisory Locks

The GC worker acquires a transaction-scoped PostgreSQL advisory lock before scanning and cancelling orphaned updates:

```typescript
await db.transaction(async (tx) => {
  const acquired = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(${GC_ADVISORY_LOCK_ID})`
  );
  // ... cancel orphaned updates and enqueue running-update publications ...
});
```

This ensures only one replica runs a GC cycle. PostgreSQL releases the lock automatically when the transaction commits, rolls back, or its connection closes.

## Transactional GitHub Outbox

Update start and terminal transitions insert their GitHub publication intent in the same PostgreSQL transaction. The outbox stores a monotonically increasing revision and the worker acknowledges the exact revision it delivered. A late, higher-sequence summary event increments the terminal revision so the existing pull-request comment is edited again.

Workers claim rows with `FOR UPDATE SKIP LOCKED` and a short lease, then release the transaction before calling GitHub. Acknowledgements and failures are fenced by claim owner and revision, so a late summary cannot be overwritten by stale in-flight work. Transient failures use bounded exponential backoff; malformed payloads and exhausted retries record a terminal failed revision. A failed started phase no longer blocks its terminal phase.

## Cascade Deletes

Foreign keys use `ON DELETE CASCADE`:

- Deleting a **project** cascades to its stacks
- Deleting an **update** cascades to events, checkpoints, and GitHub outbox rows

This means `pulumi stack rm` cleanly removes all associated data.

## Migrations

Migrations are managed by Drizzle Kit (`drizzle-kit`) and run automatically on server startup. The schema is defined in TypeScript in `packages/db/src/schema.ts` and migrations are generated and applied via Drizzle's migration system.
