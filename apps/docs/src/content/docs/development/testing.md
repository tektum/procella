---
title: Testing
description: Unit tests, E2E acceptance tests, and quality gates.
---

Procella has two levels of testing: unit tests (320 tests across all packages) and E2E acceptance tests (89 tests exercising the full Pulumi CLI lifecycle).

## Unit Tests

```bash
bun run check
# or: bun test
```

Unit tests use Bun's built-in test runner (`bun:test`) with `describe`, `test`, `expect`, `beforeAll`, and `afterAll`. They run without any external dependencies (no database, no Docker).

Key test suites across packages:

| Package | Coverage |
|---|---|
| `packages/auth` | Auth service (dev + Descope mock) |
| `packages/crypto` | AES-256-GCM encryption, HKDF key derivation |
| `packages/storage` | Local + S3 blob storage |
| `packages/stacks` | Stack CRUD operations |
| `packages/updates` | Update lifecycle, GC worker |
| `apps/server` | HTTP handlers, middleware, route matching |
| `apps/api` | tRPC procedures (stacks, updates, events) |

### Running Specific Tests

```bash
# Run tests in a specific package
bun test --cwd packages/crypto

# Run tests matching a pattern
bun test --filter "encrypt"
```

## E2E Acceptance Tests

```bash
bun run e2e
```

E2E tests exercise the full Pulumi CLI lifecycle against a real Procella server. They require:
- PostgreSQL (started via `docker compose up -d`)
- Pulumi CLI installed
- `PROCELLA_DATABASE_URL` environment variable

### Pulumi CLI Compatibility Lanes

CI separates the support policy into four lanes:

| Lane | CLI version | Coverage |
|---|---|---|
| Legacy smoke | `v3.9.0` | Login/`whoami`; stack CRUD; preview/update/refresh/destroy with an empty Node.js program; direct cancellation; secret config; synthetic export/import; no-`Accept` legacy checks |
| Fully supported minimum | `v3.233.0` | All legacy/common checks plus API v9 behavior, batch crypto, journaling negotiation, and tolerant `SecretValue` decoding |
| SDK-matched contract | Derived during CI from `packages/types/tygo/go.mod` | Complete E2E suite against the CLI version matching generated Pulumi SDK contracts |
| Latest canary | `latest` | Login, stack initialization, preview, update, export, destroy, and stack removal |

The legacy and minimum lanes use the workspace's installed `@pulumi/pulumi` package through a direct temporary symlink. Their empty Node.js program has no provider resources or plugins, so the lanes require neither YAML support nor network dependency/plugin installation.

The focused delta load integration test starts with an exact-text checkpoint larger than 1 MiB and applies 16 accepted deltas. It deterministically asserts canonical checkpoint rows, the single sidecar row, exported state, and bounded blob storage: canonical blobs plus only the current sidecar baseline. Superseded sidecar blobs are deleted only after commit, and cleanup failure cannot invalidate committed state. The test reports elapsed time, CPU time, RSS/heap observations, database row shape, and blob-file counts without a wall-clock pass/fail threshold.

The canary detects upstream changes but does not move the supported minimum. The minimum is a testing and support policy, not a global runtime version lockout. See [Pulumi CLI Compatibility](../getting-started/compatibility/) for unsupported areas and opt-in capabilities.

### Test Files

| File | Coverage |
|---|---|
| `e2e/setup.ts` | Test infrastructure, server setup/teardown |
| `e2e/login.test.ts` | `pulumi login` validation |
| `e2e/healthz.test.ts` | Health endpoint |
| `e2e/stacks.test.ts` | Create, list, get, delete stacks |
| `e2e/rename.test.ts` | Stack rename operations |
| `e2e/updates.test.ts` | Full update flow: create → start → checkpoint → events → complete |
| `e2e/state.test.ts` | Export, import, versioned export |
| `e2e/encryption.test.ts` | Secret encryption/decryption |
| `e2e/cancel.test.ts` | Update cancellation + GC |
| `e2e/examples.test.ts` | Real Pulumi YAML programs (pulumi-random, pulumi-command) |

### Test Count

89 tests covering the full Pulumi CLI lifecycle, multi-tenant isolation, and edge cases.

### Example Programs

The `e2e/examples.test.ts` file deploys real Pulumi YAML programs from the `examples/` directory using:
- **pulumi-random** — generates random resources (no cloud provider needed)
- **pulumi-command** — runs local shell commands

This validates the complete update lifecycle end-to-end without requiring cloud provider credentials.

## Quality Gates

```bash
bun run check      # Biome lint + typecheck + 320 unit tests
bun run e2e        # 89 E2E acceptance tests
bun run check:all  # check + e2e
```

## Writing New Tests

### Unit Test Pattern

```typescript
import { describe, expect, test } from "bun:test";

describe("MyFeature", () => {
	test("handles valid input", () => {
		const result = myFeature("foo");
		expect(result).toBe("bar");
	});

	test("rejects empty input", () => {
		expect(() => myFeature("")).toThrow();
	});
});
```

### E2E Test Pattern

E2E tests use `bun:test` and interact with the server via HTTP or the Pulumi CLI:

```typescript
import { describe, expect, test } from "bun:test";
import { pulumiCli, serverUrl } from "./helpers";

describe("MyE2EFeature", () => {
	test("works end-to-end", async () => {
		const result = await pulumiCli(["stack", "ls", "--json"]);
		expect(result.exitCode).toBe(0);
	});
});
```

### Running a Subset

```bash
# Run a specific test file
bun test e2e/stacks.test.ts

# Run tests matching a pattern
bun test --filter "stack lifecycle"
```

## Benchmarks

For performance benchmarking (journaling vs checkpoint), see [Benchmarking](/development/benchmarking/).
