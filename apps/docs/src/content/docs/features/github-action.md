---
title: GitHub Action
description: Run the official Pulumi GitHub Action against Procella without wiring up pulumi login.
---

`tektum/procella/actions/pulumi` is a composite action that delegates Pulumi operations to the official [`pulumi/actions`](https://github.com/pulumi/actions) action (pinned to `v7`). It defaults `cloud-url` to Procella production, `https://api.procella.cloud/api`, and can optionally authenticate to Procella through GitHub Actions OIDC before Pulumi runs.

That removes a separate `pulumi login` step from your workflow. Pulumi operations (`preview`, `up`, `destroy`, PR comments, step summaries, secrets providers, policy packs) retain the upstream action's behavior.

## Static access key

For an existing access-key workflow, pass `PULUMI_ACCESS_TOKEN` as before:

```yaml
name: Pulumi Preview

on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write # only needed for comment-on-pr

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - uses: tektum/procella/actions/pulumi@main
        with:
          command: preview
          stack-name: my-org/my-project/staging
          comment-on-pr: true
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
```

When `oidc-organization` is omitted, `PULUMI_ACCESS_TOKEN` is required. Procella access keys are long-lived, so store one as a repository or environment secret. Existing static-token workflows need no changes.

`@main` tracks the latest action definition. Pin the Procella action to a commit SHA or release tag for reproducible builds.

`comment-on-pr: true` makes the upstream action post the preview diff to the pull request. That posting is the upstream action's own behavior: it uses `GITHUB_TOKEN` (via the `github-token` input, which defaults to `${{ github.token }}`), so the job needs `pull-requests: write`. It is independent of the [Procella GitHub App](/features/github-app/), which posts comments from the server side using its own installation credentials. Use one or the other, not both, unless you want two comments. For the GitHub App path, Procella validates and derives the PR coordinates from the update metadata that the Pulumi CLI sends automatically; a complete set of explicit `github:*` stack tags remains a supported override.

To deploy instead of previewing, use `command: up` on `push`. To tear a stack down, use `command: destroy`.

## Secretless OIDC workflow

Set `oidc-organization` to explicitly enable OIDC authentication. The value is the Procella organization slug; the action never infers it from `stack-name`. Grant the job `id-token: write` so GitHub can mint an OIDC token. No `PULUMI_ACCESS_TOKEN` secret is needed.

```yaml
name: Pulumi Deploy

on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - uses: tektum/procella/actions/pulumi@main
        with:
          command: up
          stack-name: my-org/my-project/production
          oidc-organization: my-org
```

The action first runs `pulumi/auth-actions@v2`, requests an organization access token with type `urn:pulumi:token-type:access_token:organization`, and exports the short-lived token as `PULUMI_ACCESS_TOKEN` for the following `pulumi/actions` step. Configure a matching Procella OIDC trust policy before using the workflow; see [OIDC CI Authentication](/operations/oidc-ci/).

## Pointing at a different backend

Pass `cloud-url` explicitly to target a self-hosted Procella instance:

```yaml
      - uses: tektum/procella/actions/pulumi@main
        with:
          command: up
          stack-name: my-org/my-project/production
          oidc-organization: my-org
          cloud-url: https://procella.internal.example.com/api
```

The same `cloud-url` value is passed to OIDC authentication and the Pulumi action. For the example above, `pulumi/auth-actions` resolves the exchange endpoint to `https://procella.internal.example.com/api/oauth/token`, while `pulumi/actions` uses the configured value for `pulumi login`. Pass the Procella backend URL ending in `/api`. Passing `cloud-url: ""` selects Pulumi Cloud rather than retaining an existing backend, so do not combine an empty value with Procella OIDC.

## Supported inputs

The action declares and forwards the complete 37-input surface of `pulumi/actions` at the pinned commit, one-to-one, with upstream's defaults. `cloud-url` is the only upstream default that differs. The Procella-only `oidc-organization` input controls the preceding authentication step and is not forwarded upstream. Consult the [upstream input reference](https://github.com/pulumi/actions#inputs) for the delegated inputs.

Two limitations follow from GitHub's action metadata format:

- **The upstream surface is explicit, not dynamic.** A composite action cannot forward inputs it does not declare. If upstream adds an input, this action must be updated before you can pass it; until then GitHub warns about an unexpected input and the value is dropped. `scripts/pulumi-action.test.ts` pins the upstream surface so a pin bump that is not re-synced fails the test suite.
- **OIDC is explicit.** Only a non-empty `oidc-organization` enables OIDC. The organization is not derived from `stack-name`, and omitting the input leaves static `PULUMI_ACCESS_TOKEN` handling unchanged.

The single output, `output` (stdout of the Pulumi command), is re-exported.
