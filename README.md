# Procella

A self-hosted [Pulumi](https://www.pulumi.com/) backend for [tested core CLI workflows](apps/docs/src/content/docs/getting-started/compatibility.md), including login, stack management, updates, and state import/export — on your own infrastructure and without a Pulumi Cloud account.

## Features

- **Tested Pulumi CLI workflows** — login, stack management, updates, previews, refreshes, destroys, and state import/export across documented support tiers
- **Web dashboard** — React SPA with stack/update/event views, API token management, and admin settings
- **Admin settings panel** — invite users, manage roles, view audit log, edit tenant profile (Descope mode)
- **API token management** — create and revoke Descope access keys from the browser dashboard
- **Browser CLI login** — `pulumi login` opens a browser flow; token is stored automatically
- **Multi-tenant authentication** — dev mode with static tokens or [Descope](https://www.descope.com/) with tenant RBAC
- **Role-based access control** — viewer / member / admin roles enforced per-organization
- **AES-256-GCM encryption** — per-stack key derivation via HKDF for secrets at rest
- **Horizontal scaling** — serverless functions on Vercel with Neon database, stateless and zero-ops
- **S3-compatible blob storage** — local filesystem or any S3-compatible backend (AWS S3, MinIO, R2)
- **Single process** — CLI API + tRPC dashboard share one Hono server
- **Production deployment** — Deploy to Vercel with a single git push
- **Stack search** — full-text search with tag filtering and cursor-based pagination
- **Webhooks** — outbound HTTP event delivery with HMAC-SHA256 signing and retries
- **Audit logs** — automatic audit trail via Descope management API
- **GitHub App** — PR preview comments and commit status checks

## Performance

Benchmarked from Iowa (USA) against Procella deployed in us-east-1 (N. Virginia), N=10 resources, journal mode:

| Backend | `up` | `preview` | `destroy` |
|---|---|---|---|
| **Procella (AWS)** | **1,412ms** | **677ms** | **1,087ms** |
| Pulumi Cloud | 1,647ms | 749ms | 1,158ms |

Procella is faster than Pulumi Cloud. Server-side processing is ~55ms p50 per request on both — the difference comes from infrastructure choices (CloudFront edge termination, direct Lambda invocation). See the [benchmarking docs](apps/docs/src/content/docs/development/benchmarking.md) for methodology and how to run your own comparison.

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Bun 1.2 |
| HTTP Router | Hono v4 |
| Dashboard API | tRPC v11 + Drizzle ORM |
| Dashboard UI | React 19, Vite 7, Tailwind CSS v4 |
| Database | Neon Serverless PostgreSQL |
| Auth | Descope / static tokens |
| Encryption | AES-256-GCM + HKDF |
| Blob Storage | Local filesystem / S3 |
| Hosting | Vercel (serverless functions + static sites) |
| Quality | Biome + TypeScript strict |

## Quick Start

```bash
# Clone and start the dev environment
git clone https://github.com/tektum/procella.git
cd procella
bun run dev
```

This starts PostgreSQL, MinIO, the Bun server (with hot-reload), and the Vite UI dev server locally.

```bash
# Dev mode — set token directly
export PULUMI_ACCESS_TOKEN=devtoken123
pulumi login http://localhost:9090

# Descope mode — browser login flow (PULUMI_CONSOLE_DOMAIN is set in mise.toml)
pulumi login http://localhost:9090
# The CLI opens your browser to /cli-login, you sign in via Descope,
# and the token is stored automatically in ~/.pulumi/credentials.json

# Create and deploy a stack
mkdir my-project && cd my-project
pulumi new typescript
pulumi up
```

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/tektum/procella)
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/tektum/procella)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/tektum/procella)

| Platform | Method | Config file |
|---|---|---|
| [Render](apps/docs/src/content/docs/deployment/render.mdx) | One-click Blueprint | [`render.yaml`](render.yaml) |
| [Railway](apps/docs/src/content/docs/deployment/railway.mdx) | One-click from repo | [`railway.toml`](railway.toml) |
| [Vercel](https://vercel.com/docs) | One-click clone | [`vercel.json`](vercel.json) |
| [Fly.io](apps/docs/src/content/docs/deployment/fly-io.mdx) | `fly launch && fly deploy` | [`fly.toml`](fly.toml) |
| [Coolify](apps/docs/src/content/docs/deployment/coolify.mdx) | Docker Compose in Coolify UI | [`docker-compose.coolify.yml`](docker-compose.coolify.yml) |
| [Docker Compose](apps/docs/src/content/docs/operations/docker-compose.md) | `docker compose --profile dev up` | [`docker-compose.yml`](docker-compose.yml) |

All platforms need PostgreSQL and the `PROCELLA_*` environment variables. See the [full configuration reference](apps/docs/src/content/docs/operations/environment-variables.md).

## Configuration

All configuration is via `PROCELLA_*` environment variables. Set these as Vercel environment variables for production deployment. See `.env.example` for a complete reference.

| Variable | Default | Description |
|---|---|---|
| `PROCELLA_LISTEN_ADDR` | `:9090` | Server listen address |
| `PROCELLA_DATABASE_URL` | *(required)* | PostgreSQL connection string (Neon on Vercel, any PostgreSQL locally) |
| `PROCELLA_AUTH_MODE` | *(required)* | `dev` (static tokens) or `descope` (Descope access keys) |
| `PROCELLA_DEV_AUTH_TOKEN` | *(required if dev)* | Static auth token for dev mode |
| `PROCELLA_DEV_USER_LOGIN` | `dev-user` | Dev user login name |
| `PROCELLA_DEV_ORG_LOGIN` | `dev-org` | Dev org login name |
| `PROCELLA_DEV_USERS` | | JSON array of additional dev users |
| `PROCELLA_DESCOPE_PROJECT_ID` | *(required if descope)* | Descope project ID |
| `PROCELLA_DESCOPE_MANAGEMENT_KEY` | | Descope management key — enables `pulumi login` browser flow and API token creation |
| `PROCELLA_BLOB_BACKEND` | `local` | `local` (filesystem) or `s3` (S3-compatible) |
| `PROCELLA_BLOB_LOCAL_PATH` | `./data/blobs` | Local blob storage path |
| `PROCELLA_BLOB_S3_BUCKET` | *(required if s3)* | S3 bucket name |
| `PROCELLA_BLOB_S3_ENDPOINT` | | Custom S3 endpoint (MinIO, R2, etc.) |
| `PROCELLA_BLOB_S3_REGION` | `us-east-1` | S3 region |
| `PROCELLA_ENCRYPTION_KEY` | *(required)* | 64 hex chars (32 bytes) for AES-256-GCM |
| `PROCELLA_DELTA_CHECKPOINTS_ENABLED` | `false` | Advertise `delta-checkpoint-uploads-v2`; disable and restart to return clients to full checkpoints |
| `PROCELLA_CRON_SECRET` | *(required when `/cron/gc` is enabled)* | Bearer token used to authorize the GC cron endpoint |
| `PROCELLA_CORS_ORIGINS` | *(optional)* | Comma-separated allowed CORS origins; omit for strict same-origin |
| `PROCELLA_GITHUB_APP_ID` | *(optional)* | GitHub App ID for PR comments and commit status checks |
| `PROCELLA_GITHUB_APP_PRIVATE_KEY` | *(optional)* | GitHub App private key (PEM format) |
| `PROCELLA_GITHUB_APP_WEBHOOK_SECRET` | *(optional)* | GitHub App webhook secret for signature verification |

| `PROCELLA_TRUST_PROXY` | *(optional)* | Set to `true` only behind a trusted reverse proxy so Procella honors `X-Forwarded-For` / `X-Real-IP` |

For the GitHub App integration, use a dedicated App and configure the three `PROCELLA_GITHUB_APP_*` variables with that App's credentials. Do not reuse the Renovate App credentials; it requires broader repository permissions and should remain scoped to dependency updates. After moving this repository to another GitHub organization, install the Procella App on the destination organization and grant it access to this repository. See the [GitHub App setup guide](apps/docs/src/content/docs/features/github-app.md).

Encryption keys must be set explicitly in every environment. Generate one with `openssl rand -hex 32`.

### CORS

By default Procella does **not** mount CORS middleware. Set `PROCELLA_CORS_ORIGINS` explicitly when you need browser cross-origin access.

Using `PROCELLA_CORS_ORIGINS=*` is allowed for local experiments, but it enables any origin and should never be used in production.

### Reverse proxy and TLS termination

- Set `PROCELLA_TRUST_PROXY=true` only when Procella is behind a trusted reverse proxy (for example Caddy or CloudFront) that sanitizes and re-emits client IP headers.
- When Procella is reached directly, leave `PROCELLA_TRUST_PROXY` unset so audit logging and rate limiting use the socket peer IP instead of user-supplied forwarded headers.
- `apps/ui/Caddyfile` keeps `auto_https off` because it assumes TLS is terminated upstream. For self-hosted deployments without an upstream TLS terminator, remove `auto_https off` (or set `auto_https on`) and configure Caddy for Let's Encrypt.

## Quality Gates

```bash
bun run check          # biome lint + typecheck + 320 unit tests
bun run e2e            # E2E acceptance tests (89 tests)
bun run check:all      # check + e2e
```

## Documentation

Full documentation is available in the [`apps/docs/`](apps/docs/) directory, built with [Starlight](https://starlight.astro.build/):

```bash
bun run docs:dev       # Start docs dev server
bun run docs:build     # Build static docs site
```

- [Introduction](apps/docs/src/content/docs/getting-started/introduction.md)
- [Quick Start](apps/docs/src/content/docs/getting-started/quickstart.md)
- [Configuration](apps/docs/src/content/docs/getting-started/configuration.md)
- [Pulumi CLI Compatibility](apps/docs/src/content/docs/getting-started/compatibility.md)
- [Architecture Overview](apps/docs/src/content/docs/architecture/overview.md)
- [API Reference](apps/docs/src/content/docs/api/stacks.md)

## Project Structure

```
packages/
  types/              Pulumi protocol types + domain types + errors
  config/             Zod-validated env config (PROCELLA_*)
  db/                 Drizzle schema + dual-driver connection factory (Neon / node-postgres)
  crypto/             AES-256-GCM with HKDF per-stack key derivation
  storage/            Blob storage (local filesystem + S3)
  auth/               Dev mode (static token) + Descope (JWT)
  stacks/             Stack CRUD, rename, tags (PostgreSQL)
  updates/            Update lifecycle, checkpoints, events, GC worker
  api/                @procella/api — tRPC router (stacks, updates, events)
apps/
  server/             @procella/server — Hono HTTP server (CLI + tRPC + middleware)
  ui/                 @procella/ui — React SPA (Vite + Tailwind + tRPC client)
                      Pages: StackList, StackDetail, UpdateDetail, Tokens, Settings, CliLogin
examples/             Pulumi YAML example programs (7 examples)
e2e/                  E2E acceptance tests (89 tests, 9 files)
  docs/               @procella/docs — Starlight documentation site
```

## License

See [LICENSE](LICENSE) for details.
