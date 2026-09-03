---
title: OIDC CI Authentication
description: Authenticate from CI/CD pipelines to Procella using OpenID Connect — no long-lived secrets required.
---

OIDC CI authentication lets pipelines prove their identity to Procella using short-lived tokens issued by the CI provider, with no static secrets to rotate or leak. The Pulumi CLI has native OIDC support, so existing workflows migrate by changing the login URL only.

See [Authentication Architecture](../architecture/authentication/) for how the auth layer works internally.

## Overview

With traditional access keys, CI/CD pipelines need a long-lived `PULUMI_ACCESS_TOKEN` stored as a secret. That token never expires on its own, and if it leaks, an attacker can access your stacks indefinitely.

OIDC flips this: the CI provider (GitHub Actions, for example) issues a short-lived JWT signed with its private key. Procella verifies that JWT against the provider's public keys, checks that the claims match a trust policy you configured, and issues a scoped, time-limited token. No secrets ever enter your repo or CI environment.

The Pulumi CLI has supported OIDC authentication since v3.x via `--oidc-token` and `--oidc-org`. Procella implements the same protocol as Pulumi Cloud, so any workflow that works against Pulumi Cloud works against Procella after a URL change.

## Prerequisites

Your Procella instance needs:

- `PROCELLA_AUTH_MODE=descope` — OIDC is only available in Descope auth mode (not dev mode)
- `PROCELLA_OIDC_ENABLED` defaults to `true` in Descope mode; set to `false` to disable the OIDC exchange endpoint
- A Descope management key set as `PROCELLA_DESCOPE_MANAGEMENT_KEY` — required for issuing exchange tokens
- Procella reachable from the CI environment over HTTPS

Your CI environment needs:

- A GitHub repo with OIDC enabled (it's on by default for Actions)
- The `id-token: write` permission on the job

## Supported Providers

| Provider | Issuer URL | Notes |
|---|---|---|
| GitHub Actions | `https://token.actions.githubusercontent.com` | Supported in v1. No extra setup needed for public or private repos. |

More providers (GitLab, Buildkite, CircleCI) are planned for a later phase.

## Setup: Create a Trust Policy

Trust policies define which OIDC tokens Procella will accept and what role they receive.

Go to **Settings** in the Procella dashboard, open the **OIDC** tab, and click **Add policy**.

### Fields

**Provider** — Select the CI provider. Procella uses this to fetch the correct public keys for JWT verification.

**Display name** — A human-readable label for this policy, shown in the OIDC tab and audit logs. Pick something descriptive like `GitHub / acme-infra prod`.

**Issuer** — The token issuer URL. For GitHub Actions this is `https://token.actions.githubusercontent.com`. Procella rejects tokens whose `iss` claim doesn't match.

**Max expiration (seconds)** — The maximum lifetime of the exchange token Procella issues, in seconds. Default is `7200` (2 hours). The CLI can request a shorter duration with `--oidc-expiration`; it can't request longer than this cap.

**Claim conditions** — One or more `key=value` pairs matched against the JWT claims. All conditions must match (AND semantics). Values are exact-match strings. Use these to lock the policy to a specific org, repo, or environment.

**Granted role** — The Procella role (`viewer`, `member`, or `admin`) the exchange token carries. Use the minimum role needed. Most deploy pipelines need `member`.

### Example: lock to a specific repo

To allow only the `acme/infra` repo to authenticate:

| Key | Value |
|---|---|
| `repository_owner_id` | `12345` |
| `repository_id` | `67890` |

Use the numeric IDs rather than the names. Names are mutable; IDs are stable. Find your org's ID at `https://api.github.com/orgs/YOUR_ORG` and your repo's ID at `https://api.github.com/repos/YOUR_ORG/YOUR_REPO`.

To further restrict to the `prod` environment on the `main` branch:

| Key | Value |
|---|---|
| `repository_owner_id` | `12345` |
| `repository_id` | `67890` |
| `environment` | `prod` |
| `ref` | `refs/heads/main` |

## GitHub Actions Workflow

The Procella composite Pulumi action performs the OIDC exchange before running Pulumi. Replace `YOUR_ORG` with your Procella organization slug and set `cloud-url` to your Procella backend URL ending in `/api`. The action builds the required `urn:pulumi:org:YOUR_ORG` audience from the explicit organization input.

```yaml
name: Deploy

on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: prod
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - name: Deploy with Procella OIDC
        uses: tektum/procella/actions/pulumi@main
        with:
          command: up
          stack-name: YOUR_ORG/YOUR_PROJECT/YOUR_STACK
          oidc-organization: YOUR_ORG
          cloud-url: https://procella.example.com/api
```

No `PULUMI_ACCESS_TOKEN` secret is required. `oidc-organization` explicitly enables the pinned `pulumi/auth-actions@v2` step, which requests `urn:pulumi:token-type:access_token:organization` and exports the resulting short-lived token for the subsequent Pulumi step. The job must grant `permissions: id-token: write`; `contents: read` is required by `actions/checkout`.

Pin `tektum/procella/actions/pulumi` to a release tag or full commit SHA in production workflows instead of tracking `@main`.

## Claim Conditions Reference

These are the most useful GitHub Actions claims for restricting trust policies.

| Claim | Description | Example value |
|---|---|---|
| `repository_owner_id` | Stable numeric GitHub org or user ID | `"12345"` |
| `repository_id` | Stable numeric repo ID | `"67890"` |
| `repository` | `owner/repo` name (mutable — prefer IDs) | `"acme/infra"` |
| `environment` | GitHub Environment name | `"prod"` |
| `workflow_ref` | Workflow file path and ref | `"acme/infra/.github/workflows/deploy.yml@refs/heads/main"` |
| `ref` | Full Git ref | `"refs/heads/main"` |
| `ref_protected` | Whether the ref is branch-protected | `"true"` |
| `job_workflow_ref` | Reusable workflow ref (if used) | `"acme/shared/.github/workflows/deploy.yml@refs/heads/main"` |

Prefer `repository_owner_id` and `repository_id` over `repository`. The name field changes if someone renames the repo; the numeric IDs don't.

All claim values in conditions are strings, including numbers and booleans. Write `"true"` not `true`, and `"12345"` not `12345`.

## Token Expiration

The exchange token Procella issues defaults to 7200 seconds (2 hours). A trust policy's **Max expiration** field caps this; the CLI can request a shorter duration.

To request a 1-hour token:

```bash
pulumi login --oidc-token "$TOKEN" --oidc-org YOUR_ORG --oidc-expiration 1h https://procella.example.com
```

The underlying GitHub Actions OIDC token has a much shorter lifetime (typically 10 minutes). It's only used during the exchange step; after that, Procella's exchange token is what the CLI uses.

## Audit Logs

Operations authenticated via OIDC appear in the audit log with actor type `workload` rather than a named user. The log entry includes full provenance from the JWT claims:

- Repository owner and name
- Workflow file and ref
- GitHub Actions run ID
- The human who triggered the run (via the `actor` claim), if available

This means you can trace any stack update back to the exact workflow run and the person who pushed or approved it, without storing a static identity in your CI configuration.

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `access_denied` (403) | No trust policy matches the JWT claims | Check claim conditions in Settings → OIDC. Verify the org slug in the audience matches your Procella org exactly. |
| `invalid_target` | Audience format wrong | Use `urn:pulumi:org:YOUR_ORG_SLUG` exactly — the `urn:pulumi:org:` prefix is required. |
| `token_expired` | The GitHub Actions OIDC token expired before exchange | Request the token and run `pulumi login` in the same shell step with no blocking commands between them. |
| OIDC exchange returns 501 | `PROCELLA_OIDC_ENABLED` is `false` (or `dev` auth mode) | Set `PROCELLA_OIDC_ENABLED=true` and `PROCELLA_AUTH_MODE=descope`, then restart the server. The endpoint is always registered but returns 501 when OIDC is disabled. |
| `id_token` permission missing | Job lacks `id-token: write` | Add `permissions: id-token: write` to the job in your workflow YAML. |
| `ACTIONS_ID_TOKEN_REQUEST_URL` empty | Workflow triggered without OIDC (e.g. pull_request from a fork) | OIDC is unavailable for fork PRs. Use `environment` protection rules to restrict which contexts can request tokens. |
