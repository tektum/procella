---
title: GitHub Action
description: Run the official Pulumi GitHub Action against Procella without wiring up pulumi login.
---

`tektum/procella/actions/pulumi` is a thin composite action that delegates every Pulumi operation to the official [`pulumi/actions`](https://github.com/pulumi/actions) action (pinned to `v7`), with one change: `cloud-url` defaults to Procella production, `https://api.procella.cloud/api`.

That removes the separate `pulumi login` step from your workflow. Everything else — `preview`, `up`, `destroy`, PR comments, step summaries, secrets providers, policy packs — is the upstream action's behavior, unchanged.

## Usage

Add the action to a workflow and give it a `PULUMI_ACCESS_TOKEN`.

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
      - uses: actions/checkout@v6

      - uses: tektum/procella/actions/pulumi@main
        with:
          command: preview
          stack-name: my-org/my-project/staging
          comment-on-pr: true
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
```

`PULUMI_ACCESS_TOKEN` is required. Without it the `pulumi login` the action performs fails (upstream logs that as a warning) and the Pulumi command itself then fails. In Procella the token is a long-lived access key; store it as a repository or environment secret.

`comment-on-pr: true` makes the upstream action post the preview diff to the pull request. That posting is the upstream action's own behavior: it uses `GITHUB_TOKEN` (via the `github-token` input, which defaults to `${{ github.token }}`), so the job needs `pull-requests: write`. It is independent of the [Procella GitHub App](/features/github-app/), which posts comments from the server side using its own installation credentials. Use one or the other, not both, unless you want two comments.

To deploy instead of previewing, use `command: up` on `push`. To tear a stack down, use `command: destroy`.

## Pointing at a different backend

Pass `cloud-url` explicitly to target a self-hosted Procella instance:

```yaml
      - uses: tektum/procella/actions/pulumi@main
        with:
          command: up
          stack-name: my-org/my-project/production
          cloud-url: https://procella.internal.example.com/api
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
```

An explicit `cloud-url` is forwarded verbatim. Passing `cloud-url: ""` forwards an empty value, which leaves backend selection to the Pulumi CLI (`PULUMI_BACKEND_URL`, `Pulumi.yaml`, or an existing login).

## Supported inputs

The action declares and forwards the complete input surface of `pulumi/actions` at the pinned commit — all 37 inputs, one-to-one, with upstream's defaults. `cloud-url` is the only default that differs. Consult the [upstream input reference](https://github.com/pulumi/actions#inputs) for what each one does.

Two limitations follow from GitHub's action metadata format:

- **The surface is explicit, not dynamic.** A composite action cannot forward inputs it does not declare. If upstream adds an input, this action must be updated before you can pass it; until then GitHub warns about an unexpected input and the value is dropped. `scripts/pulumi-action.test.ts` pins the upstream surface so a pin bump that is not re-synced fails the test suite.
- **Only `cloud-url` behavior is added.** This action adds no inputs of its own and does not reinterpret any upstream input.

The single output, `output` (stdout of the Pulumi command), is re-exported.

## OIDC instead of a static token

If you would rather not store a long-lived access key, exchange a GitHub Actions OIDC token for a short-lived Procella token first and pass that as `PULUMI_ACCESS_TOKEN`. See [OIDC CI Authentication](/operations/oidc-ci/).
