---
title: Update Lifecycle
description: The four-phase Pulumi update protocol — create, start, execute, complete.
---

When you run a supported update command, the CLI follows a structured protocol to communicate with the backend. Procella implements the core create, start, execute, and complete workflow covered by its [compatibility test lanes](../getting-started/compatibility/).

## The Four Phases

### Phase 1: Create Update

```
POST /api/stacks/{org}/{project}/{stack}/update
```

The CLI tells the backend it wants to perform an update (or preview, refresh, destroy).

- **Auth**: `Authorization: token <api-token>`
- **Request**: `apitype.UpdateProgramRequest` — contains program metadata (name, runtime, main, description, config)
- **Response**: `apitype.UpdateProgramResponse` — contains the `updateID`
- **Side effect**: Creates an update record with status `not started`, locks the stack (sets `current_operation_id`)

The same endpoint pattern works for all update kinds:
- `POST .../update` — deployment
- `POST .../preview` — dry-run
- `POST .../refresh` — refresh from cloud provider
- `POST .../destroy` — tear down resources

:::caution
Only one active update per stack is allowed. The partial unique index `idx_updates_active_per_stack` enforces this at the database level. If another update is already running, the request returns `409 Conflict`.
:::

### Phase 2: Start Update

```
POST /api/stacks/{org}/{project}/{stack}/update/{updateID}
```

The CLI signals that execution is about to begin.

- **Auth**: `Authorization: token <api-token>`
- **Request**: `apitype.StartUpdateRequest`
- **Response**: `apitype.StartUpdateResponse` — contains:
  - `token` — the lease token for execution-phase auth
  - `version` — the current checkpoint version
  - `tokenExpiration` — when the lease expires
  - `journalVersion` — returned as `1` when the request asks for journaling version 1 or newer

Journaling is negotiated through `StartUpdateRequest.journalVersion` and `StartUpdateResponse.journalVersion`. The Procella-local `journaling-v1` capability remains advertised for compatibility; it is not an upstream Pulumi capability.

The update status transitions from `not started` → `running`.

### Phase 3: Execution

During execution, the CLI uses a **different auth scheme**: `Authorization: update-token <lease-token>`.

Four types of requests happen during execution:

#### Checkpoint Updates

The CLI periodically saves infrastructure state:

- `PATCH .../checkpoint` — standard checkpoint (full deployment JSON)
- `PATCH .../checkpointverbatim` — verbatim checkpoint (preserves exact JSON, with sequence number for idempotency)
- `PATCH .../checkpointdelta` — optional textual delta, available only after `PROCELLA_DELTA_CHECKPOINTS_ENABLED=true`, restart, capability negotiation, an `Accept` version of 8 or newer, and a verbatim baseline

Each checkpoint increments the stack's `last_checkpoint_version`.

When enabled, Procella advertises `delta-checkpoint-uploads-v2` with a `1048576`-byte (1 MiB) cutoff. Every accepted delta is validated and materialized as a canonical full checkpoint. To roll back, set the flag to `false` and restart; no state rewrite or database migration is required.

#### Event Streaming

```
POST .../events/batch
```

The CLI sends engine events (resource operations, diagnostics, outputs) as batches. Events are stored with sequence numbers for ordered replay.

#### Lease Renewal

```
POST .../renew_lease
```

The CLI periodically renews its lease to signal it's still alive. If the lease expires without renewal, the GC worker will eventually cancel the orphaned update.

### Phase 4: Complete Update

```
POST .../complete
```

- **Auth**: `Authorization: update-token <lease-token>`
- **Request**: `apitype.CompleteUpdateRequest` — contains `status`: `succeeded`, `failed`, or `cancelled`
- **Side effects**:
  - Sets update status to the provided value
  - Clears the lease token
  - Clears the stack's `current_operation_id` lock
  - Records `completed_at` timestamp

## Cancel Update

```
POST /api/stacks/{org}/{project}/{stack}/update/{updateID}/cancel
```

- **Auth**: `Authorization: token <api-token>` (regular API token, NOT update-token)
- **No request body, no response body**
- **Transaction**: Sets status to `cancelled`, clears lease token, clears stack's active update lock
- **Idempotent**: Canceling an already-cancelled update returns success

## Garbage Collection

The GC worker runs as a background interval task and cleans up orphaned updates:

- **Stale running updates**: Status is `running` but lease has expired
- **Abandoned not-started updates**: Status is `not started` or `requested` for longer than 1 hour

The GC worker uses PostgreSQL advisory locks (`pg_try_advisory_lock`) to ensure only one instance runs across a multi-replica cluster. It runs at startup (reconciliation) and then every 60 seconds.

See [Horizontal Scaling](../operations/horizontal-scaling/) for more on cluster safety.

## State Diagram

```
┌─────────────┐   CreateUpdate   ┌─────────────┐
│             │ ───────────────► │ not started  │
│  (no state) │                  └──────┬───────┘
│             │                         │
└─────────────┘                   StartUpdate
                                        │
                                 ┌──────▼───────┐
                          ┌──────│   running     │──────┐
                          │      └──────┬───────┘       │
                     CancelUpdate       │          Lease expires
                          │        CompleteUpdate       │
                          │             │          GC cancels
                    ┌─────▼─────┐ ┌─────▼─────┐  ┌─────▼─────┐
                    │ cancelled │ │ succeeded │  │ cancelled │
                    └───────────┘ └───────────┘  └───────────┘
                                  ┌───────────┐
                                  │  failed   │
                                  └───────────┘
```

## Concurrent Update Protection

Procella prevents multiple simultaneous updates to the same stack through two mechanisms:

1. **Stack lock**: The `current_operation_id` column on the `stacks` table tracks the active update
2. **Partial unique index**: `CREATE UNIQUE INDEX idx_updates_active_per_stack ON updates (stack_id) WHERE status IN ('not started', 'requested', 'running')` — PostgreSQL enforces at most one active update per stack

If a second update is attempted while one is already active, the `INSERT` fails with a unique constraint violation, and the handler returns `409 Conflict`.
