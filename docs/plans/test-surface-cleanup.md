# Test Surface Cleanup — Decisions

Source: test-surface audit (2026-08-25). Implementation tracked via PR #225.

## Problem

Several test surfaces were dead or duplicated:

- `e2e/security-regressions/` never ran in CI (`e2e/*.test.ts` excludes subdirs; server tests gated on `PROCELLA_SECURITY_E2E=1`).
- `packages/oidc/src/policy.integration.test.ts` lived under the unit tree, skipped in CI (no Postgres on `check`), and demanded Postgres for local `test:unit`.
- `bench/*.test.ts` matched no glob; the bench job ran `bun run bench`, not `bun test`.
- Packages unit suite ran twice (`check` + `types-freshness`).
- Low-value coverage: source-text UI tests, constant-restating enums/errors/roles, duplicated FQN parsing, SSRF cases retested at integration after exhaustive unit coverage.
- `e2e/warmup.test.ts` was a mocked unit test paying full e2e preload cost.
- Unified `packages/` / `apps/` globs could pick up compiled `dist/*.test.js` after local builds.

## Decisions

1. **Revive dead surfaces in CI** rather than delete them: `security-e2e` job, `bun test bench/` in the bench job, move OIDC policy integration into `integration/`.
2. **Delete constant-restating / source-text tests**; keep behavioral contracts (inheritance chains, `isValidUpdateKind`, SSRF unit suite, one integration SSRF wiring proof).
3. **Unify unit globs** with CI (`packages/ apps/ scripts/`) and ignore `**/dist/**` via `bunfig.toml`.
4. **Move warmup helper unit tests** to `scripts/` so they do not pay e2e preload.

## Out of scope (deferred)

- Consolidate `e2e/update-lifecycle` into `examples.test.ts` and trim per-example protocol coverage.
- Shared `makeMockStacksService` / `makeMockUpdatesService` fixtures.
- Replace hardcoded `test:security` file list with a non-rotting discovery mechanism.
