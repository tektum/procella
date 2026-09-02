---
title: Configuration
description: Complete reference for all Procella environment variables.
---

Procella is configured entirely through environment variables prefixed with `PROCELLA_`. The server validates required variables at startup and exits with a clear error message if anything is missing.

## Core Settings

| Variable | Default | Description |
|---|---|---|
| `PROCELLA_LISTEN_ADDR` | `:9090` | Address and port the HTTP server listens on |
| `PROCELLA_DATABASE_URL` | *(required)* | PostgreSQL connection string (e.g. `postgres://user:pass@host:5432/db?sslmode=disable`) |

## Authentication

| Variable | Default | Description |
|---|---|---|
| `PROCELLA_AUTH_MODE` | `dev` | Authentication mode: `dev` or `descope` |
| `PROCELLA_DESCOPE_PROJECT_ID` | *(required if descope)* | Descope project ID for access key validation |
| `PROCELLA_DEV_AUTH_TOKEN` | *(required if dev)* | Static auth token for the primary dev user |
| `PROCELLA_DEV_USER_LOGIN` | `dev-user` | Login name for the primary dev user |
| `PROCELLA_DEV_ORG_LOGIN` | `dev-org` | Organization name for the primary dev user |
| `PROCELLA_DEV_USERS` | *(empty)* | JSON array of additional dev users (see below) |

### Dev Users JSON Format

`PROCELLA_DEV_USERS` accepts a JSON array of user objects for multi-tenant development and testing:

```json
[
  {
    "token": "token-user-b",
    "login": "user-b",
    "org": "org-b",
    "role": "admin"
  },
  {
    "token": "token-viewer",
    "login": "viewer-user",
    "org": "dev-org",
    "role": "viewer"
  }
]
```

Each user object requires `token`, `login`, and `org`. The `role` field accepts `viewer`, `member` (default), or `admin`.

:::note
The primary dev user (configured via `PROCELLA_DEV_AUTH_TOKEN`, `PROCELLA_DEV_USER_LOGIN`, `PROCELLA_DEV_ORG_LOGIN`) is always registered as an `admin`. Additional users from `PROCELLA_DEV_USERS` default to `member` if no role is specified.
:::

## Blob Storage

| Variable | Default | Description |
|---|---|---|
| `PROCELLA_BLOB_BACKEND` | `local` | Blob storage backend: `local` or `s3` |
| `PROCELLA_BLOB_LOCAL_PATH` | `./data/blobs` | Directory for local blob storage |
| `PROCELLA_BLOB_S3_BUCKET` | *(required if s3)* | S3 bucket name for checkpoint storage |
| `PROCELLA_BLOB_S3_ENDPOINT` | *(empty)* | Custom S3 endpoint (for MinIO, R2, etc.) |
| `PROCELLA_BLOB_S3_REGION` | `us-east-1` | S3 region |

When using `s3` with a custom endpoint, you must also set the standard AWS credentials:

| Variable | Description |
|---|---|
| `AWS_ACCESS_KEY_ID` | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | S3 secret key |

:::caution
Local blob storage stores checkpoints on the server's filesystem. This does **not** work with multiple replicas — use S3 for horizontal scaling.
:::

## Pulumi Compatibility

| Variable | Default | Description |
|---|---|---|
| `PROCELLA_DELTA_CHECKPOINTS_ENABLED` | `false` | Advertise the `delta-checkpoint-uploads-v2` capability with a 1 MiB cutoff |

Delta checkpoint uploads require all of the following: this setting enabled, a server restart, a compatible client that negotiates `delta-checkpoint-uploads-v2`, `Accept: application/vnd.pulumi+8` or newer on the delta route, and an established verbatim checkpoint baseline. Procella applies each validated delta and still stores a canonical full checkpoint.

To roll back, set `PROCELLA_DELTA_CHECKPOINTS_ENABLED=false` and restart. This removes the capability advertisement, returns clients to full checkpoint uploads, and requires no database migration or state rewrite. Existing full checkpoints remain usable. See [Pulumi CLI Compatibility](../compatibility/) for the tested versions and protocol boundaries.

## Encryption

| Variable | Default | Description |
|---|---|---|
| `PROCELLA_ENCRYPTION_KEY` | *(auto in dev)* | 64 hex characters (32 bytes) for AES-256-GCM master key |

In dev mode, if `PROCELLA_ENCRYPTION_KEY` is not set, a deterministic key is generated from `sha256("procella-dev-encryption-key")`. This is convenient for development but **must not be used in production**.

### Generating a Production Key

```bash
# Generate a random 32-byte key as 64 hex characters
openssl rand -hex 32
```

:::danger
The encryption key is used to derive per-stack keys via HKDF. Losing this key means losing access to all encrypted secrets. Back it up securely.
:::

## CORS

| Variable | Default | Description |
|---|---|---|
| `PROCELLA_CORS_ORIGINS` | *(unrestricted)* | Comma-separated list of allowed origins |

When set, only the listed origins are allowed in CORS preflight responses. When unset, all origins are permitted (suitable for development, not recommended for production).

```bash
export PROCELLA_CORS_ORIGINS="https://dashboard.example.com,https://admin.example.com"
```

## Validation Rules

The server enforces these constraints at startup:

- `PROCELLA_DATABASE_URL` is always required
- `PROCELLA_BLOB_BACKEND` must be `local` or `s3`
- `PROCELLA_BLOB_LOCAL_PATH` is required when `PROCELLA_BLOB_BACKEND=local`
- `PROCELLA_BLOB_S3_BUCKET` is required when `PROCELLA_BLOB_BACKEND=s3`
- `PROCELLA_AUTH_MODE` must be `dev` or `descope`
- `PROCELLA_DESCOPE_PROJECT_ID` is required when `PROCELLA_AUTH_MODE=descope`
- `PROCELLA_DEV_AUTH_TOKEN` is required when `PROCELLA_AUTH_MODE=dev`
- `PROCELLA_ENCRYPTION_KEY`, if set, must be exactly 64 hex characters (32 bytes)
- `PROCELLA_ENCRYPTION_KEY` is required when `PROCELLA_AUTH_MODE=descope` (production)

## Example: Minimal Production Config

```bash
export PROCELLA_LISTEN_ADDR=":9090"
export PROCELLA_DATABASE_URL="postgres://procella:secret@db.internal:5432/procella?sslmode=require"
export PROCELLA_AUTH_MODE="descope"
export PROCELLA_DESCOPE_PROJECT_ID="P3Aaha02iJvkGVbPDAF78KWuAxe6"
export PROCELLA_BLOB_BACKEND="s3"
export PROCELLA_BLOB_S3_BUCKET="my-procella-checkpoints"
export PROCELLA_ENCRYPTION_KEY="$(openssl rand -hex 32)"
export PROCELLA_CORS_ORIGINS="https://procella.example.com"
```
