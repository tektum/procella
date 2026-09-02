---
title: State Operations API
description: Export and import stack state endpoints.
---

State operations allow exporting and importing infrastructure state. These are the API endpoints behind `pulumi stack export` and `pulumi stack import`.

All endpoints require `Authorization: token <api-token>`. State export and
import remain compatible with clients that omit the Pulumi `Accept` header.

Procella's deployment schema boundary is version 3. Schema v4 and non-empty deployment feature markers are rejected rather than accepted with possible data loss. Delta uploads, when enabled, are always materialized into canonical full checkpoints, so export does not depend on the delta capability remaining enabled.

## Export Stack

```
GET /api/stacks/{org}/{project}/{stack}/export
```

Returns the latest checkpoint as an `apitype.UntypedDeployment`.

**Required role**: `viewer`

**Response** (200):
```json
{
  "version": 3,
  "deployment": {
    "manifest": {
      "time": "2025-03-07T10:00:00Z",
      "magic": "...",
      "version": "..."
    },
    "resources": [
      {
        "urn": "urn:pulumi:dev::my-project::pulumi:pulumi:Stack::my-project-dev",
        "type": "pulumi:pulumi:Stack",
        "inputs": {},
        "outputs": {}
      }
    ]
  }
}
```

### Empty Stacks

Stacks with no deployments return a valid response with an empty resource list:

```json
{
  "version": 3,
  "deployment": {
    "resources": null
  }
}
```

This ensures `pulumi stack export` never fails on a new stack.

## Export Stack Version

```
GET /api/stacks/{org}/{project}/{stack}/export/{version}
```

Returns a specific checkpoint version.

**Required role**: `viewer`

**Response**: Same format as Export Stack.

**Errors**:
- `404 Not Found` — version doesn't exist

Useful for inspecting previous states or debugging state issues.

## Import Stack

```
POST /api/stacks/{org}/{project}/{stack}/import
```

Imports a deployment as the stack's new state.

**Required role**: `member`

**Request body** (`apitype.UntypedDeployment`):
```json
{
  "version": 3,
  "deployment": {
    "manifest": { ... },
    "resources": [ ... ]
  }
}
```

**Response** (200, `apitype.ImportStackResponse`):
```json
{
  "updateID": "550e8400-e29b-41d4-a716-446655440000"
}
```

### How Import Works

Import is a single-shot operation — it does not follow the create → start → complete lifecycle:

1. Creates an update record with kind `import` and status `succeeded`
2. Stores the deployment as a new checkpoint
3. Returns the update ID immediately

After import, the CLI polls `GET .../update/{updateID}` to confirm. Procella returns the update with `status: "succeeded"`.

### CLI Usage

```bash
# Export from one stack
pulumi stack export --stack org/project/source > state.json

# Import to another stack
pulumi stack import --stack org/project/target < state.json

# Cross-stack import requires --force
pulumi stack import --stack org/project/target --force < state.json
```

The `--force` flag is a client-side safety check; Procella accepts imports regardless.

## Update Status (used after Import)

```
GET /api/stacks/{org}/{project}/{stack}/update/{updateID}
```

The CLI polls this endpoint after import to confirm the operation completed.

**Required role**: `viewer`

**Response** (200):
```json
{
  "status": "succeeded",
  "kind": "import",
  "result": "succeeded"
}
```
