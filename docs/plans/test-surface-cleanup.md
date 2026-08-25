# Test Surface Cleanup Plan

Source: test-surface audit (2026-08-25). Goal: revive dead test surfaces, delete redundant tests, and remove CI duplication. Phases 1–3 are in scope; Phase 4 is a follow-up requiring judgment and is explicitly out of scope for the implementing agent.

## Phase 1 — Revive dead test surfaces

### 1.1 Run security regressions in CI
`e2e/security-regressions/` (40 tests) never runs in CI: the e2e shards glob `e2e/*.test.ts` (no subdirectories), server-level tests are gated on `PROCELLA_SECURITY_E2E=1`, and no workflow invokes `test:security:e2e`.

- Add a `security-e2e` job to `.github/workflows/ci.yml`, modeled on the existing `e2e` job (same postgres service, setup-bun action, `pulumi/setup-pulumi` action, `needs: [check]`).
- Run step: `bun run test:security:e2e` with `PROCELLA_DATABASE_URL: postgres://procella:procella@localhost:5432/procella?sslmode=disable`.
- Add `security-e2e` to the `needs:` list of the `ci-required` gate job (strict semantics: it must succeed, it is not a preview job).

### 1.2 Move the OIDC policy integration test where it actually runs
`packages/oidc/src/policy.integration.test.ts` self-skips when `CI=true` without `PROCELLA_DATABASE_URL` (the `check` job has no Postgres) and the `integration` CI job only globs `integration/`. So it never runs in CI, and worse, local `bun run test:unit` picks it up and demands a live Postgres.

- Move it to `integration/oidc-policy.integration.test.ts`.
- Read `integration/setup.ts` first and conform: use the same DB env var the other integration tests use (`TEST_DATABASE_URL` is what CI passes) and the same setup/teardown conventions as e.g. `integration/stacks.integration.test.ts`.
- Change relative imports (`./policy.js`) to the package import (`@procella/oidc`), matching how other integration tests import package code. Verify `PostgresTrustPolicyRepository` is exported from the package entrypoint; if not, export it.
- Remove the `SKIP_INTEGRATION` / `describe_db` gating — the integration suite always has a real DB.

### 1.3 Run bench tests somewhere
`bench/*.test.ts` (13 tests across `pulumi-home.test.ts`, `pulumi-plugins.test.ts`, `setup-preview-auth.test.ts`) match no glob; the bench CI job runs `bun run bench`, not `bun test`.

- Read the three files to confirm what they need (they may exercise pulumi CLI helpers — the bench job already has pulumi + postgres).
- Add a step to the `bench` job in ci.yml, before "Run benchmark": `bun test bench/`.
- If any of the three turn out to be pure-unit (no external deps), that's fine — they still run there.

## Phase 2 — Delete redundant / low-value tests

### 2.1 Source-text tests (delete files)
- Delete `apps/ui/src/components/ProcellaLogo.test.ts` — reads the `.tsx` source with `readFileSync` and asserts substrings like `text-mist`; breaks on any refactor, defends nothing behavioral.
- Delete `apps/ui/src/components/Layout.test.ts` — same pattern.

### 2.2 `packages/updates/src/gc-worker.test.ts` — keep behavior, drop restatements
Real GC behavior is covered by `integration/gc-worker.integration.test.ts` (advisory lock, orphan cleanup).
- Delete the `constructor`, `constants`, and `type checks` describe blocks.
- Keep the `resilience` describe and the `M8: grace window` functional test.

### 2.3 FQN parsing tested in three files — keep one
`packages/types/src/domain.test.ts` has the most thorough `parseStackFQN`/`formatStackFQN` coverage (including roundtrip).
- Delete the `FQN parsing` describe from `packages/stacks/src/stacks.test.ts`.
- Delete the `StackFQN` describe from `packages/types/src/types.test.ts`.

### 2.4 Type-plumbing tests in `packages/stacks/src/stacks.test.ts`
`tsc --build` already enforces these.
- Delete the `StackInfo type` describe ("satisfies expected shape").
- Delete the `StacksService interface` describe ("can define a mock satisfying the interface", "listStacks accepts optional org/project filters") — both only exercise a hand-rolled mock.
- Keep `buildStackTags`, `mergeTags`, and `pgErrorCode` describes untouched.

### 2.5 Error-class tests — collapse to the real contract
`packages/types/src/errors.test.ts` (23 tests) restates each class's hardcoded status/code/message, and `types.test.ts` has an overlapping `errors` describe.
- In `errors.test.ts`, keep only the inheritance-chain tests (the `instanceof` assertions are the non-trivial contract given Error-subclassing pitfalls): "is an instance of Error", "is instance of ProcellaError", "is instance of NotFoundError and ProcellaError", "is instance of ConflictError", "is instance of UnauthorizedError", and the final `inheritance` describe. Delete the per-class status/code/message tests.
- Delete the `errors` describe from `packages/types/src/types.test.ts`.

### 2.6 Enum-restating tests in `packages/types/src/types.test.ts`
- Delete "UPDATE_KINDS has all expected values", "UpdateResult has all expected values", "UpdateStatus has all expected values", "ErrorType has all expected values".
- Keep "isValidUpdateKind only allows the update allowlist" (tests behavior, not a constant).

### 2.7 Webhooks — constant test + SSRF triple coverage
- In `packages/webhooks/src/webhooks.test.ts`: delete "WebhookEvent constants match expected strings". Keep the full `validateWebhookUrl`/`resolveAndValidateWebhookUrl` suites (they are the canonical exhaustive coverage).
- In `integration/webhooks.integration.test.ts`: keep only "rejects localhost URLs" in the `SSRF validation` describe (proves the service wires in the validator); delete "rejects private IP URLs" and "rejects 10.x.x.x URLs".

### 2.8 Role-enum restating in `packages/types/src/domain.test.ts`
- Delete "has admin, member, viewer values" and "has exactly 3 role values". Keep `hasRole`/`hasAnyRole` and all FQN tests.

Note: `test:security` in package.json references `packages/stacks/src/stacks.test.ts` and other files being trimmed — those files all still exist, so the script stays valid. Do not remove files listed there.

## Phase 3 — CI / script hygiene

### 3.1 Drop the duplicate unit-test run
The `types-freshness` job in ci.yml re-runs `bun test --parallel packages/` after the `check` job already ran all unit tests. The step adds nothing beyond the typecheck-with-regenerated-types that precedes it.
- Delete the "Run unit tests" step from `types-freshness`. Keep "Typecheck with regenerated types".

### 3.2 Unify unit-test globs
`test:unit` in package.json globs `packages/*/src apps/*/src scripts/` while the CI `check` job globs `packages/ apps/ scripts/` — two sources of truth. After 1.2 moves the stray integration test out of `packages/oidc/src`, the globs cover identical sets.
- Change `test:unit` (and `test:unit:coverage`) in package.json to `packages/ apps/ scripts/` to match CI.

### 3.3 Move `e2e/warmup.test.ts` out of the e2e glob
It unit-tests the `warmupServer` helper with mocked fetch but lives under `e2e/*.test.ts`, so its 10 tests pay a full docker-check + DB reset + server boot preload in every CI shard.
- Move it to `scripts/warmup.test.ts`, importing the helper via a relative path (`../e2e/warmup.js`). It then runs under the unit glob (`scripts/`) with no preload. Leave `e2e/warmup.ts` itself where it is (e2e/setup.ts imports it).

## Verification

1. `bunx biome check .` — clean.
2. `bun run typecheck` — clean.
3. `bun run test:unit` — all green, and confirm the moved policy test no longer runs there.
4. If Docker + Postgres are available locally, `bun run test:integration`; otherwise state that it was skipped and why.
5. Sanity-check ci.yml is valid YAML (e.g. parse it with a quick script).

## Status

Phases 1–3 complete (2026-08-25). Verification:
- `bunx biome check` on touched paths: clean
- `bun run typecheck`: clean
- `bun run test:unit`: 896 pass / 0 fail (OIDC policy integration no longer in unit suite; warmup runs via `scripts/`)
- `bun run test:integration`: 80 pass / 0 fail (including rewritten `integration/oidc-policy.integration.test.ts`)
- Added `pathIgnorePatterns = ["**/dist/**"]` to `bunfig.toml` so the unified `packages/` glob does not pick up compiled `dist/*.test.js` after local builds
- Local `docker compose` postgres:18 volume mount is broken for PG18 (`/var/lib/postgresql/data`); integration verified against an ephemeral `docker run postgres:18-alpine`

## Phase 4 — Out of scope (follow-up, needs judgment)

- Merge `e2e/update-lifecycle.test.ts` into the simple example run in `e2e/examples.test.ts`; trim `examples.test.ts` protocol coverage to up/destroy for 5 of 7 examples.
- Extract shared `makeMockStacksService()` / `makeMockUpdatesService()` fixtures for the 7 files that hand-roll service mocks.
- Replace the hardcoded `test:security` file list with something that can't silently rot.
