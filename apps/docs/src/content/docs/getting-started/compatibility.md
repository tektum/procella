---
title: Pulumi CLI Compatibility
description: Tested Pulumi CLI versions, supported workflows, optional capabilities, and unsupported Pulumi Cloud surfaces.
---

Procella implements the Pulumi Service API needed for core self-hosted state workflows. Compatibility is defined by tested CLI lanes and explicit protocol capabilities, not by a claim that every Pulumi CLI command or Pulumi Cloud API is supported.

## Support policy

| Tier | Pulumi CLI version | Coverage |
|---|---|---|
| Legacy smoke | `v3.9.0` | Login and `whoami`; stack init, list, select, preview, update, refresh, destroy, and removal; direct cancellation; secret config round-trip; synthetic state export/import; and legacy requests without a Pulumi `Accept` header. |
| Fully supported minimum | `v3.233.0` | All legacy/common checks plus API v9 request behavior, batch crypto, journaling negotiation, and tolerant `SecretValue` decoding. This is the support floor for new installations and support cases. |
| SDK-matched contract | Derived during CI from the Pulumi SDK version pinned in `packages/types/tygo/go.mod` | The complete end-to-end suite. Generated types, the checked route/capability inventory, and the tested CLI version move together. |
| Latest canary | `latest` | Login, stack initialization, preview, update, export, destroy, and stack removal. This detects upstream changes without silently changing the supported minimum. |

The legacy and minimum lanes use an empty Node.js Pulumi program with no provider resources or plugins. Its `@pulumi/pulumi` dependency is linked directly from the checked-out workspace, so these lanes do not depend on YAML support, network installs, or fake commands.

Versions older than `v3.9.0` are untested. Versions between `v3.9.0` and `v3.233.0` remain covered only by the legacy policy, not the fully supported contract.

The minimum is a testing and support boundary, not a global runtime lockout. Procella does not reject all requests from older clients, and legacy routes continue to accept clients that omit the Pulumi `Accept` header. Version-gated routes enforce their own protocol requirements.

## Supported core workflows

The tested contract covers the CLI workflows most self-hosted backends need:

- login and identity discovery
- stack creation, selection, listing, rename, tags, and removal
- preview, update, refresh, destroy, cancellation, leases, and event batches
- state import, export, and versioned export
- config secret encryption/decryption, including batch crypto on supported clients
- full, verbatim, and optionally delta checkpoint uploads
- update history used by the supported CLI workflow

Support is workflow-based. It does not mean every command, flag combination, or upstream service endpoint works.

## Intentionally unsupported Pulumi Cloud surfaces

The checked compatibility manifest classifies these Pulumi Cloud or Enterprise areas as intentionally unsupported:

- Pulumi Deployments settings, secrets, listing, and cancellation
- Pulumi Insights resource search, account listing, and scan logs
- organization and team membership administration
- organization template catalogs and template registry publishing
- policy pack administration and publishing
- usage and billing summaries
- Pulumi Cloud package registry publishing and deletion
- the Pulumi Cloud console GitHub App integration
- Pulumi Copilot features and `pulumi neo`

Procella also does not promise upstream service routes outside the tested core workflows, including stack logs, update content-file retrieval, and other Cloud-oriented metadata endpoints. Consult this policy before adopting a command that depends on Pulumi Cloud rather than the core state backend protocol.

## Delta checkpoint opt-in

Delta checkpoint uploads are implemented but disabled by default. Enable them with:

```bash
PROCELLA_DELTA_CHECKPOINTS_ENABLED=true
```

After a restart, Procella advertises `delta-checkpoint-uploads-v2` with `checkpointCutoffSizeBytes: 1048576` (1 MiB, derived from the runtime `BLOB_THRESHOLD`). A compatible client must negotiate the capability, send `Accept: application/vnd.pulumi+8` or newer to the delta endpoint, and establish a verbatim checkpoint baseline before sending textual deltas. Procella validates the sequence and SHA-256 checkpoint hash, applies each delta transactionally, and materializes a canonical full checkpoint for normal export and recovery.

Clients that do not negotiate the capability continue uploading full checkpoints. Enabling delta uploads does not change the deployment schema boundary.

### Rollback

Set `PROCELLA_DELTA_CHECKPOINTS_ENABLED=false` and restart Procella. The server stops advertising `delta-checkpoint-uploads-v2`, so clients return to full checkpoint uploads. Canonical full checkpoints remain usable; no database migration or state rewrite is required. Delta baseline sidecars become inert.

## Operator-local compatibility telemetry

Compatibility telemetry uses the OpenTelemetry counter `procella.compat.http_requests` with bounded attributes:

- CLI support bucket: `supported`, `legacy-below-supported`, or `unknown`
- CLI release-line bucket: exact policy anchors `3.9` and `3.233`, plus `other-legacy`, `other-supported`, or `unknown`; patch, prerelease, and build data are discarded
- advertised API bucket: `none`, `below-v8`, `v8`, `v9-plus`, or `invalid`
- route class: `legacy`, `version-gated`, `update`, `state`, `crypto`, or `other`
- result class: `success`, `protocol-error`, `client-error`, `auth-error`, `unsupported-version`, or `server-error`; HTTP 400 validation and 409 conflict responses are `protocol-error`

No exact user agent, stack, organization, update identifier, token, or path parameter is attached. These metrics stay in the operator's configured OpenTelemetry destination and are disabled unless `PROCELLA_OTEL_ENABLED` is enabled. Procella does not provide customer telemetry visibility or phone these observations home.

The structured `pulumi-compatibility-policy` startup log and these operator-local metrics are the compatibility diagnostic. Procella deliberately keeps no process-local fleet observations and exposes no public compatibility diagnostic endpoint: either would be incomplete or inconsistent across a three-replica deployment.

## Conservative protocol boundaries

- `api-version` is watched but not advertised. Its min/max/default semantics are not part of the supported contract, and legacy routes do not globally require a versioned `Accept` header.
- `begin-update` is watched but not advertised. Procella retains the tested create-then-start update flow.
- Journaling is negotiated through `StartUpdateRequest.journalVersion` and `StartUpdateResponse.journalVersion`. The Procella-local `journaling-v1` capability remains advertised for compatibility; it is not an upstream Pulumi capability.
- Procella advertises deployment schema capability envelope version `1` with `configuration.version: 3`. Schema v4 and non-empty deployment feature markers are rejected until Procella can round-trip them without loss through import, checkpointing, export, rename, history, and migration workflows.
