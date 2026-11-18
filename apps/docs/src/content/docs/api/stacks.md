---
title: Stack API
description: Stack CRUD endpoints — create, list, get, delete, rename, and tag management.
---

Stack API endpoints require an `Authorization: token <api-token>` header. The
`Accept: application/vnd.pulumi+N` header is optional for these legacy routes;
version-gated features document their minimum version below.

The `{org}` parameter in the URL determines which organization is being accessed. The OrgAuth middleware checks that the authenticated user has the required role in that organization.

## Create Stack

```
POST /api/stacks/{org}/{project}
```

Creates a new stack. Auto-creates the organization and project if they don't exist (via `INSERT ON CONFLICT DO NOTHING`).

**Required role**: `member`

**Request body**:
```json
{
  "stackName": "dev",
  "createManagedEnvironment": false
}
```

`createManagedEnvironment` (optional) is sent by `pulumi stack init --esc-config` (experimental). Procella then also creates the ESC environment `{project}/{stack}` with the CLI's placeholder definition (`values: {pulumiConfig: {}}`) and returns its name as `managedEnvironment`. The stack's configuration lives in that environment; see [Stack-managed ESC environments](#stack-managed-esc-environments).

**Response** (200):
```json
{
  "id": "org/project/dev",
  "orgName": "org",
  "projectName": "project",
  "stackName": "dev",
  "tags": {},
  "managedEnvironment": "project/dev",
  "version": 0
}
```

`managedEnvironment` is present only for managed stacks.

**Errors**:
- `409 Conflict` — stack already exists, or (for a managed stack) the ESC environment `{project}/{stack}` already exists. The stack and environment are created in one transaction, so in that case nothing is created.

## Check Project Exists

```
HEAD /api/stacks/{org}/{project}
```

Returns 200 if the project exists, 404 otherwise. Used by the CLI to check if a project namespace is available.

**Required role**: `viewer`

## Get Stack

```
GET /api/stacks/{org}/{project}/{stack}
```

Returns stack metadata.

**Required role**: `viewer`

**Response** (200):
```json
{
  "orgName": "org",
  "projectName": "project",
  "stackName": "dev",
  "tags": {"pulumi:project": "my-project"},
  "version": 5,
  "activeUpdate": ""
}
```

Managed stacks also include `managedEnvironment` (`"{project}/{stack}"`). The name is kept even if the environment was deleted separately, and it does not change when the stack is renamed.

## Delete Stack

```
DELETE /api/stacks/{org}/{project}/{stack}
```

Deletes a stack and all associated data (updates, events, checkpoints) via cascade. For a managed stack, its ESC environment is deleted in the same transaction. An environment that was already deleted separately is ignored; any other failure aborts the stack deletion.

**Required role**: `admin`

**Errors**:
- `404 Not Found` — stack doesn't exist
- `409 Conflict` — stack has an active update in progress

## List Stacks

```
GET /api/user/stacks
```

Returns all stacks the authenticated user has access to, filtered by their organization memberships.

**Required role**: `viewer` (per org)

**Response** (200):
```json
{
  "stacks": [
    {
      "orgName": "dev-org",
      "projectName": "my-project",
      "stackName": "dev",
      "tags": {},
      "version": 3,
      "activeUpdate": "",
      "lastUpdate": {
        "kind": "update",
        "status": "succeeded",
        "startTime": 1709827200
      }
    }
  ]
}
```

## Rename Stack

```
POST /api/stacks/{org}/{project}/{stack}/rename
```

Renames a stack within the same organization. Creates the target project if it doesn't exist.

**Required role**: `member`

**Request body**:
```json
{
  "newName": "org/new-project/staging"
}
```

**Response** (204): No content

**Errors**:
- `400 Bad Request` — invalid fully qualified name
- `404 Not Found` — source stack doesn't exist
- `409 Conflict` — target stack name already exists

The rename operation runs in a transaction and also creates a `rename` update record for history tracking.

## Update Tags

```
PATCH /api/stacks/{org}/{project}/{stack}/tags
```

Adds or removes tags on a stack. Tags are key-value pairs stored as JSONB.

**Required role**: `member`

**Request body**:
```json
{
  "tags": {
    "pulumi:project": "my-project",
    "environment": "staging",
    "team": "platform"
  }
}
```

**Response** (204): No content

## Stack-managed ESC environments

Pulumi CLI v3.276.0 and newer can keep a stack's configuration in an ESC environment that the stack manages (`pulumi stack init --esc-config`, behind `PULUMI_EXPERIMENTAL`). The definition lives under `environment:` in `Pulumi.<stack>.yaml`; before each operation the CLI compares it with the published environment and either opens that revision or creates a draft and opens the draft.

Procella serves the routes this flow uses:

| Route | Purpose |
|---|---|
| `GET /api/esc/environments/{org}/{project}/{env}` | Published definition with `ETag` and `Pulumi-ESC-Revision` headers |
| `POST /api/esc/environments/{org}/{project}/{env}/versions/{version}/open` | Open a specific published revision (number or tag) |
| `POST /api/esc/environments/{org}/{project}/{env}/drafts` | Create a draft from the local definition |
| `POST /api/esc/environments/{org}/{project}/{env}/drafts/{id}/open?revision=0` | Open a draft. Drafts are not versioned, so only revision `0` is accepted |
| `POST /api/esc/environments/{org}/{project}/{env}/encrypt-secrets` | Encrypt `pulumi config set --secret` values into `fn::secret: {ciphertext: ...}` |

The update request's `environment` field (`baseRevision`, `changeRequestID`, `draftRevision`) records which revision or draft the update evaluated. Procella stores it on the update.

Secret ciphertexts use the `escx` envelope from `github.com/pulumi/esc`, encrypted with AES-256-GCM under a per-tenant key derived from `PROCELLA_ENCRYPTION_KEY`. The ESC evaluator decrypts them when an environment is opened. Rotating `PROCELLA_ENCRYPTION_KEY` makes existing ciphertexts unreadable.

## Common Headers

Requests typically include:

```
Authorization: token <api-token>
Content-Type: application/json  (for POST/PATCH)
```

Batch crypto endpoints require `Accept: application/vnd.pulumi+8` or newer.
