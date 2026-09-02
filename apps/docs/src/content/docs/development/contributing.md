---
title: Contributing
description: Prerequisites, setup, code style, and development workflow.
---

## Prerequisites

| Tool | Purpose |
|---|---|
| [Bun](https://bun.sh/) 1.2+ | Runtime, package manager, test runner, bundler |
| [Docker](https://docs.docker.com/get-docker/) | Container runtime for PostgreSQL and MinIO |
| [Pulumi CLI](https://www.pulumi.com/docs/install/) | Required for E2E tests |

## Setup

```bash
git clone https://github.com/tektum/procella.git
cd procella
bun install

# Start the full dev environment (PostgreSQL, MinIO, Bun server with hot-reload, Vite UI)
bun run dev
```

## Code Style

### TypeScript

- **Formatting**: Tab indentation, double quotes, semicolons (enforced by [Biome](https://biomejs.dev/))
- **Linting**: Biome strict mode — no `console.log`, no `as any`, no `@ts-ignore`
- **Type Safety**: TypeScript strict mode, no type error suppression
- **Errors**: Throw typed errors from `@procella/types` (UnauthorizedError, NotFoundError, ConflictError, etc.)
- **Testing**: `bun:test` with `describe`, `test`, `expect`, `beforeAll`, `afterAll`

### Interfaces

Service interfaces are defined alongside their implementation in each package. Keep interfaces small (1–3 methods when possible).

### Error Handling

```typescript
// Good — typed domain errors
if (!stack) {
  throw new NotFoundError(`Stack ${name} not found`);
}

// Good — wrapped with context
try {
  await db.insert(stacks).values(data);
} catch (err) {
  if (isUniqueViolation(err)) {
    throw new ConflictError(`Stack ${name} already exists`);
  }
  throw err;
}
```

## Bun Scripts

| Script | Description |
|---|---|
| `bun run dev` | Start full dev environment (PostgreSQL + MinIO + Bun server + Vite UI) |
| `bun run dev:down` | Stop dev dependencies + remove volumes |
| `bun run build` | Build all packages and apps |
| `bun run check` | Biome lint + typecheck + unit tests (320 tests) |
| `bun run check:all` | check + E2E tests |
| `bun run e2e` | E2E acceptance tests (89 tests) |
| `bun run docker:build` | Build Docker image |
| `bun run docker:cluster` | Start 3-replica cluster with Caddy LB |
| `bun run docs:dev` | Start docs dev server |
| `bun run docs:build` | Build static docs site |

## Quality Gates

Before submitting a PR, ensure:

```bash
bun run check      # Must pass: Biome lint, typecheck, 320 unit tests
bun run e2e        # Must pass: 89 E2E acceptance tests
```

## Project Layout

When adding new features, follow the existing package structure:

- **New domain service** → create a package under `packages/`, export interface + implementation
- **New API route** → add handler to `apps/server/src/routes/`
- **New tRPC procedure** → add to `apps/api/src/router/`
- **New React page** → add to `apps/ui/src/pages/`
- **New E2E test** → add to `e2e/`

## Docker Image

Single Docker image built with `bun build --compile`:

1. **Builder stage** — pinned `oven/bun` image, installs dependencies and builds the application
2. **Final stage** — distroless Debian 13 image containing only the compiled binary and runtime assets

The compiled binary includes the Bun runtime, so no Node.js or Bun installation is needed in the final image.
