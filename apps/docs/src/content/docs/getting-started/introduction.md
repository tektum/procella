---
title: Introduction
description: What Procella is, why self-host your Pulumi backend, and what's included.
---

Procella is a self-hosted backend for [Pulumi](https://www.pulumi.com/), the infrastructure-as-code platform. It implements the Pulumi Service API routes needed by tested core CLI workflows, including `pulumi login`, `pulumi stack init`, `pulumi up`, `pulumi destroy`, state import/export, and secret encryption.

## Why Self-Host?

Pulumi Cloud is the default backend for managing state, secrets, and collaboration. For teams that need to keep infrastructure state within their own network boundary — whether for compliance, data sovereignty, or cost — Procella provides a self-hosted backend for the [documented core workflows](../compatibility/). Pulumi Cloud-only services are intentionally outside that contract.

- **Data sovereignty** — state and secrets never leave your infrastructure
- **No vendor dependency** — run on your own PostgreSQL and S3-compatible storage
- **Multi-tenant isolation** — organization-scoped access control with role-based permissions
- **Horizontal scaling** — add replicas behind a load balancer with zero configuration changes

## What Works

Procella implements and tests the following core workflows. This is not a promise that every Pulumi CLI command or Pulumi Cloud API works; see [Pulumi CLI Compatibility](../compatibility/) for version tiers and unsupported areas.

| Feature | Status |
|---|---|
| `pulumi login` | ✅ |
| `pulumi stack init / ls / rm / select` | ✅ |
| `pulumi up / preview / refresh / destroy` | ✅ |
| `pulumi stack export / import` | ✅ |
| `pulumi config set --secret` | ✅ |
| `pulumi stack rename` | ✅ |
| `pulumi stack tag` | ✅ |
| `pulumi cancel` | ✅ |
| Concurrent update protection | ✅ |
| Checkpoint versioning | ✅ |
| Delta checkpoints (operator opt-in) | ✅ |
| Update event history | ✅ |
| Orphan update garbage collection | ✅ |
| Web dashboard | ✅ |
| tRPC dashboard API | ✅ |
| API token management (web) | ✅ |
| Admin settings (users, roles, audit, tenant) | ✅ |
| Browser-based CLI login flow | ✅ |

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | [Bun](https://bun.sh/) 1.2 |
| HTTP Router | [Hono v4](https://hono.dev/) |
| Database | PostgreSQL 17 ([Drizzle ORM](https://orm.drizzle.team/) + Bun.sql) |
| Dashboard API | [tRPC v11](https://trpc.io/) |
| Authentication | [Descope](https://www.descope.com/) access keys / static dev tokens |
| Encryption | AES-256-GCM + HKDF per-stack key derivation |
| Blob Storage | Local filesystem or S3-compatible (AWS S3, MinIO, Cloudflare R2) |
| Frontend | React 19 + Vite 7 + Tailwind CSS v4 |
| Load Balancer | Caddy 2 |
| Container | `bun build --compile` → debian-slim |
| Quality | Biome + TypeScript strict + bun:test (320 unit + 89 E2E tests) |

## Next Steps

- [Quick Start](../quickstart/) — get a local instance running in under 5 minutes
- [Configuration](../configuration/) — all environment variables and their defaults
- [Pulumi CLI Compatibility](../compatibility/) — tested versions, optional capabilities, and unsupported Cloud-only areas
- [Architecture Overview](../../architecture/overview/) — how the pieces fit together
- [Web Dashboard](../../architecture/dashboard/) — pages, navigation, and Descope management widgets
