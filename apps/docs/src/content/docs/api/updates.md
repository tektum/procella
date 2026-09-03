---
title: Update API
description: Update lifecycle endpoints — create, start, execute, and complete.
---

The update API implements the core Pulumi Service API update protocol used by Procella's tested CLI workflows. See [Update Lifecycle](../architecture/update-lifecycle/) for the conceptual overview and [Pulumi CLI Compatibility](../getting-started/compatibility/) for version tiers and unsupported surfaces.

Most update endpoints are compatible with clients that omit the Pulumi `Accept` header. Delta checkpoint uploads require `PROCELLA_DELTA_CHECKPOINTS_ENABLED=true`, a server restart, negotiated `delta-checkpoint-uploads-v2`, and `Accept: application/vnd.pulumi+8` or newer.

## Create Update

```
POST /api/stacks/{org}/{project}/{stack}/{kind}
```

Where `{kind}` is one of: `update`, `preview`, `refresh`, `destroy`.

**Auth**: `Authorization: token <api-token>`
**Required role**: `member`

**Request body** (`apitype.UpdateProgramRequest`):
```json
{
  "name": "my-project",
  "runtime": "nodejs",
  "main": "",
  "description": "",
  "config": {},
  "metadata": {
    "kind": "update",
    "message": "",
    "environment": {}
  }
}
```

**Response** (200, `apitype.UpdateProgramResponse`):
```json
{
  "updateID": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Errors**:
- `404 Not Found` — stack doesn't exist
- `409 Conflict` — another update is already active on this stack

## Start Update

```
POST /api/stacks/{org}/{project}/{stack}/update/{updateID}
```

Transitions the update from `not started` to `running` and issues a lease token.

**Auth**: `Authorization: token <api-token>`
**Required role**: `member`

**Request body** (`apitype.StartUpdateRequest`):
```json
{}
```

**Response** (200, `apitype.StartUpdateResponse`):
```json
{
  "version": 3,
  "token": "lease-token-uuid",
  "tokenExpiration": "2025-03-07T12:00:00Z"
}
```

- `version` — current checkpoint version (starting point for this update)
- `token` — lease token for execution-phase authentication
- `tokenExpiration` — when the lease expires (renew before this time)

If the request includes `journalVersion` 1 or newer, Procella negotiates `journalVersion: 1` in this response. Journaling is selected through this request/response exchange. The Procella-local `journaling-v1` capability remains advertised only for compatibility.

## Get Update Status

```
GET /api/stacks/{org}/{project}/{stack}/update/{updateID}
```

Returns the current status of an update.

**Auth**: `Authorization: token <api-token>`
**Required role**: `viewer`

**Response** (200):
```json
{
  "status": "succeeded",
  "kind": "update",
  "startTime": 1709827200,
  "endTime": 1709827260,
  "version": 4,
  "message": "",
  "result": "succeeded"
}
```

## Get Update Events

```
GET /api/stacks/{org}/{project}/{stack}/update/{updateID}/events
```

Returns engine events for an update, optionally filtered by continuation token.

**Auth**: `Authorization: token <api-token>`
**Required role**: `viewer`

**Query parameters**:
- `continuationToken` — return events after this sequence number

**Response** (200):
```json
{
  "events": [
    {
      "sequence": 1,
      "timestamp": 1709827200,
      "type": "resourcePreEvent",
      "resourcePreEvent": { ... }
    }
  ],
  "continuationToken": "5"
}
```

## Unsupported Update Inspection Routes

Procella does not register the upstream `GET .../updates/latest`, per-version `GET .../updates/{version}`, or update content-file retrieval routes. Use the supported update list and event history workflows below; do not assume every Pulumi Cloud update-inspection endpoint is available.

## List Updates

```
GET /api/stacks/{org}/{project}/{stack}/updates
```

Returns all updates for a stack, ordered by creation time (newest first).

**Auth**: `Authorization: token <api-token>`
**Required role**: `viewer`

## Execution-Phase Endpoints

These endpoints use a different auth scheme: `Authorization: update-token <lease-token>`.

### Patch Checkpoint

```
PATCH /api/stacks/{org}/{project}/{stack}/update/{updateID}/checkpoint
```

Saves a full checkpoint (infrastructure state snapshot).

**Request body** (`apitype.PatchUpdateCheckpointRequest`):
```json
{
  "deployment": { ... },
  "sequenceNumber": 0,
  "version": 4
}
```

### Patch Checkpoint Verbatim

```
PATCH /api/stacks/{org}/{project}/{stack}/update/{updateID}/checkpointverbatim
```

Saves a checkpoint preserving exact JSON formatting. Uses `sequenceNumber` for idempotency — duplicate sequence numbers are silently ignored.

### Patch Checkpoint Delta

```
PATCH /api/stacks/{org}/{project}/{stack}/update/{updateID}/checkpointdelta
```

Applies textual edits against the exact prior verbatim checkpoint baseline. Procella validates the sequence number and required SHA-256 checkpoint hash, applies the delta in a transaction, and materializes a canonical full checkpoint.

**Preconditions**: `PROCELLA_DELTA_CHECKPOINTS_ENABLED=true` followed by a restart; client negotiation of `delta-checkpoint-uploads-v2`; an advertised cutoff of `1048576` bytes (1 MiB); an existing verbatim baseline; and `Accept: application/vnd.pulumi+8` or newer.

Disabling the setting and restarting removes the capability advertisement. Clients return to full checkpoint uploads, while existing canonical checkpoints remain usable without a state rewrite or migration.

### Record Events

```
POST /api/stacks/{org}/{project}/{stack}/update/{updateID}/events/batch
```

Records a batch of engine events.

**Request body** (`apitype.EngineEventBatch`):
```json
{
  "events": [
    {
      "sequence": 1,
      "timestamp": 1709827200,
      "resourcePreEvent": { ... }
    }
  ]
}
```

### Renew Lease

```
POST /api/stacks/{org}/{project}/{stack}/update/{updateID}/renew_lease
```

Extends the lease token's expiration time.

**Request body** (`apitype.RenewUpdateLeaseRequest`):
```json
{
  "duration": 300
}
```

**Response** (200, `apitype.RenewUpdateLeaseResponse`):
```json
{
  "token": "lease-token-uuid",
  "tokenExpiration": "2025-03-07T12:05:00Z"
}
```

### Complete Update

```
POST /api/stacks/{org}/{project}/{stack}/update/{updateID}/complete
```

Marks the update as finished.

**Request body** (`apitype.CompleteUpdateRequest`):
```json
{
  "status": "succeeded"
}
```

Status values: `succeeded`, `failed`, `cancelled`.

## Cancel Update

```
POST /api/stacks/{org}/{project}/{stack}/update/{updateID}/cancel
```

Cancels a running update. Uses regular API token auth (not update-token).

**Auth**: `Authorization: token <api-token>`
**Required role**: `member`

**No request body. No response body.**

The cancel operation runs in a transaction: sets status to `cancelled`, clears the lease token, and clears the stack's `current_operation_id`. Idempotent — canceling an already-cancelled update returns success.
