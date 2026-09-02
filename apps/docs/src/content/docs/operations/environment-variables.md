---
title: Environment Variables
description: Comprehensive reference for all environment variables, grouped by category.
---

All Procella configuration is via environment variables. Variables prefixed with `PROCELLA_` are Procella-specific; others (`AWS_*`) follow standard conventions.

## Quick Reference

| Variable | Default | Required | Description |
|---|---|---|---|
| `PROCELLA_LISTEN_ADDR` | `:9090` | No | Server listen address |
| `PROCELLA_DATABASE_URL` | — | **Yes** | PostgreSQL connection string |
| `PROCELLA_AUTH_MODE` | `dev` | No | `dev` or `descope` |
| `PROCELLA_DEV_AUTH_TOKEN` | — | If dev | Primary dev user token |
| `PROCELLA_DEV_USER_LOGIN` | `dev-user` | No | Primary dev user name |
| `PROCELLA_DEV_ORG_LOGIN` | `dev-org` | No | Primary dev org name |
| `PROCELLA_DEV_USERS` | — | No | JSON array of extra dev users |
| `PROCELLA_DESCOPE_PROJECT_ID` | — | If descope | Descope project ID |
| `PROCELLA_BLOB_BACKEND` | `local` | No | `local` or `s3` |
| `PROCELLA_BLOB_LOCAL_PATH` | `./data/blobs` | If local | Local blob directory |
| `PROCELLA_BLOB_S3_BUCKET` | — | If s3 | S3 bucket name |
| `PROCELLA_BLOB_S3_ENDPOINT` | — | No | Custom S3 endpoint |
| `PROCELLA_BLOB_S3_REGION` | `us-east-1` | No | S3 region |
| `PROCELLA_ENCRYPTION_KEY` | *(auto in dev)* | If non-dev | 64 hex chars (32 bytes) |
| `PROCELLA_DELTA_CHECKPOINTS_ENABLED` | `false` | No | Advertise `delta-checkpoint-uploads-v2` with a 1 MiB cutoff |
| `PROCELLA_OTEL_ENABLED` | `false` | No | Export OpenTelemetry traces, metrics, and operator-local compatibility buckets |
| `PROCELLA_CORS_ORIGINS` | *(unrestricted)* | No | Comma-separated allowed origins |
| `PROCELLA_TRUST_PROXY` | `false` | No | Trust `X-Forwarded-For` / `X-Real-IP` only when running behind a trusted reverse proxy |
| `AWS_ACCESS_KEY_ID` | — | If custom endpoint | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | — | If custom endpoint | S3 secret key |

## Server

### PROCELLA_LISTEN_ADDR

The address and port the HTTP server binds to:

- `:9090` — listen on all interfaces, port 9090 (default)
- `127.0.0.1:9090` — localhost only
- `0.0.0.0:3000` — all interfaces, port 3000

### PROCELLA_DATABASE_URL

PostgreSQL connection string. Required in all modes.

```
postgres://user:password@host:5432/database?sslmode=disable
```

Common `sslmode` values:
- `disable` — no SSL (development only)
- `require` — encrypted connection, no certificate verification
- `verify-full` — encrypted + verified certificate (production recommended)

## Pulumi Compatibility

### PROCELLA_DELTA_CHECKPOINTS_ENABLED

Controls advertisement of the optional `delta-checkpoint-uploads-v2` capability. Accepted enabled values are `true` and `1`; `false`, `0`, or omission leave it disabled.

When enabled and the server is restarted, compatible clients can use delta checkpoint uploads for checkpoint bodies beyond the advertised `checkpointCutoffSizeBytes` of `1048576` bytes (1 MiB, derived from `BLOB_THRESHOLD`). The delta endpoint also requires `Accept: application/vnd.pulumi+8` or newer and a prior verbatim checkpoint baseline. Procella validates and applies deltas while retaining a canonical full checkpoint.

Rollback is one setting change: set the variable to `false` and restart. The capability is no longer advertised, clients use full checkpoint uploads, existing canonical checkpoints remain valid, and no state rewrite or database migration is needed.

### PROCELLA_OTEL_ENABLED

Enables OpenTelemetry export. Compatibility observations are operator-local and use the support bucket, a closed CLI release-line bucket (`3.9`, `3.233`, `other-legacy`, `other-supported`, or `unknown`), API-version bucket, route class, and result class. They do not include patch/prerelease/build data, exact user agents, customer identifiers, stack names, tokens, or resolved path parameters. When this setting is disabled, compatibility metrics are no-ops.

The structured `pulumi-compatibility-policy` startup log plus these metrics are the compatibility diagnostic. Procella does not keep process-local fleet state or expose a public compatibility diagnostic endpoint, because either would diverge across replicas. See [Pulumi CLI Compatibility](../getting-started/compatibility/#operator-local-compatibility-telemetry) for the exact attributes.

## Authentication

### PROCELLA_AUTH_MODE

Controls how the server validates `Authorization: token <value>` headers.

- `dev` — validate against static tokens (default)
- `descope` — exchange access keys via the Descope API

### PROCELLA_DEV_AUTH_TOKEN

The token for the primary dev user. Required when `PROCELLA_AUTH_MODE=dev`.

The primary dev user is always assigned the `admin` role in `PROCELLA_DEV_ORG_LOGIN`.

### PROCELLA_DEV_USERS

JSON array of additional users for multi-tenant development and testing:

```json
[{"token":"t1","login":"alice","org":"acme","role":"admin"}]
```

Fields:
- `token` (required) — the auth token
- `login` (required) — the user's login name
- `org` (required) — the user's organization
- `role` (optional) — `viewer`, `member` (default), or `admin`

### PROCELLA_DESCOPE_PROJECT_ID

Your Descope project ID. Required when `PROCELLA_AUTH_MODE=descope`. Used to initialize the Descope SDK client for access key validation.

## Blob Storage

### PROCELLA_BLOB_BACKEND

- `local` — store blobs on the local filesystem (default)
- `s3` — store blobs in an S3-compatible bucket

### PROCELLA_BLOB_LOCAL_PATH

Directory path for local blob storage. Created automatically if it doesn't exist. Only used when `PROCELLA_BLOB_BACKEND=local`.

### PROCELLA_BLOB_S3_BUCKET

The S3 bucket name. The bucket must already exist. Required when `PROCELLA_BLOB_BACKEND=s3`.

### PROCELLA_BLOB_S3_ENDPOINT

Custom S3 endpoint URL for non-AWS providers:

- MinIO: `http://minio:9000`
- Cloudflare R2: `https://<account-id>.r2.cloudflarestorage.com`

When set, path-style addressing is used and `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` are required.

When not set, the standard AWS SDK credential chain is used.

### PROCELLA_BLOB_S3_REGION

The AWS region for the S3 bucket. Defaults to `us-east-1`. Only relevant when using real AWS S3 (not MinIO or other custom endpoints).

## Encryption

### PROCELLA_ENCRYPTION_KEY

A 64-character hex string representing 32 bytes for AES-256-GCM encryption.

Generate one:
```bash
openssl rand -hex 32
```

If not set and `PROCELLA_AUTH_MODE=dev`, a deterministic key is derived from `sha256("procella-dev-encryption-key")`. This is not safe for production.

When `PROCELLA_AUTH_MODE=descope` (production), this variable is **required**. The server will refuse to start without it.

## CORS

### PROCELLA_CORS_ORIGINS

Comma-separated list of allowed origins for CORS preflight responses:

```bash
PROCELLA_CORS_ORIGINS=https://dashboard.example.com,https://admin.example.com
```

When not set, all origins are permitted. For production deployments, restrict this to the origins that host your dashboard UI.

## Reverse Proxy Awareness

### PROCELLA_TRUST_PROXY

Set this to `true` only when Procella is deployed behind a trusted reverse proxy (such as Caddy, CloudFront, or another load balancer) that strips client-supplied forwarding headers and sets its own trusted values.

- `true` — audit logging and rate limiting may use `X-Forwarded-For` / `X-Real-IP`
- unset / `false` — Procella ignores forwarded IP headers and uses the direct peer address when available

The bundled `apps/ui/Caddyfile` is configured with trusted proxies and keeps `auto_https off` because it assumes TLS is terminated upstream. For self-hosted deployments without an upstream TLS terminator, remove `auto_https off` (or set `auto_https on`) so Caddy can manage HTTPS directly.

## AWS Credentials

### AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY

Standard AWS credentials. Required when `PROCELLA_BLOB_S3_ENDPOINT` is set (custom S3 endpoint). For standard AWS S3, you can also use IAM roles, instance profiles, or any method supported by the AWS SDK default credential chain.
