---
title: GitHub App
description: PR preview comments and commit status checks for Pulumi stacks.
---

The Procella GitHub App integration posts preview results directly to pull requests. When a CI run executes `pulumi preview` against a stack tagged with GitHub metadata, Procella automatically:

- Posts a comment on the PR with the preview diff (resources to add, change, or delete)
- Sets a commit status check (`pulumi/preview`) that shows pass/fail in the PR checks UI

This gives reviewers infrastructure change context without leaving GitHub.

## Setup

### 1. Create a GitHub App

Go to **GitHub** > **Settings** > **Developer settings** > **GitHub Apps** > **New GitHub App**.

Fill in:

| Field | Value |
|---|---|
| GitHub App name | `procella-your-org` (must be globally unique) |
| Homepage URL | Your Procella instance URL |
| Webhook URL | `https://your-procella.example.com/api/webhooks/github` |
| Setup URL | `https://your-procella.example.com/github/setup` |
| Redirect on update | Enabled |
| Webhook secret | A random string you generate (save it, you'll need it) |

Under **Permissions**, set:

| Permission | Access |
|---|---|
| Pull requests | Read & write |
| Commit statuses | Read & write |
| Contents | Read-only |
| Metadata | Read-only |

Under **Subscribe to events**, check:

- Pull request
- Push

Click **Create GitHub App**. On the next page, note your **App ID**.

Scroll down to **Private keys** and click **Generate a private key**. This downloads a `.pem` file.

### 2. Configure Environment Variables

Add these to your Procella deployment:

| Variable | Description |
|---|---|
| `PROCELLA_GITHUB_APP_ID` | The numeric App ID from the GitHub App settings page |
| `PROCELLA_GITHUB_APP_PRIVATE_KEY` | Contents of the `.pem` file (include the `-----BEGIN RSA PRIVATE KEY-----` headers) |
| `PROCELLA_GITHUB_APP_WEBHOOK_SECRET` | The webhook secret you set in step 1 |

For Docker or docker-compose, pass these as environment variables:

```bash
PROCELLA_GITHUB_APP_ID=123456
PROCELLA_GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAK...
-----END RSA PRIVATE KEY-----"
PROCELLA_GITHUB_APP_WEBHOOK_SECRET=my-random-secret
```

For Vercel or similar platforms, use the environment variable UI. The private key value should be the raw multiline PEM string.

### 3. Connect the App to a Tenant

Sign in to Procella as a tenant administrator, open **Settings** > **GitHub**, and select **Connect GitHub App**. Procella sends you to GitHub with signed, expiring state bound to the current tenant. After you install or configure the app, GitHub redirects to `/github/setup`; Procella validates the state and loads the installation details directly from GitHub before saving the binding.

Webhook events can update or remove an existing binding, but cannot create one.

Existing installations created before tenant-bound setup are removed during migration because their tenant ownership was inferred from a GitHub account name. Reconnect them from **Settings** > **GitHub**.

### Moving a Repository Between Organizations

Use a GitHub App owned by the destination organization when the previous organization-owned App cannot move with the repository. Create the replacement App under the destination organization, connect it from Procella Settings, and replace all three `PROCELLA_GITHUB_APP_*` credential values together. Procella rejects partial GitHub App configuration.

The new App may keep the existing webhook URL. Confirm a signed delivery succeeds after installation before retiring the old App.

### Deployment Credentials

The deployed Procella instance needs its own GitHub App credentials. Procella loads the current public App slug from GitHub using those credentials when an administrator starts installation, so App renames do not require configuration changes. Do not supply the Renovate App ID or private key as `PROCELLA_GITHUB_APP_*`; the two apps have different permissions and purposes. For SST deployments, configure the dedicated Procella App values in the matching `ProcellaGitHubApp*` secrets.

## How PR Comments Work

During an update, the Pulumi CLI sends source-control and CI metadata to Procella. For GitHub Actions pull-request runs, Procella verifies the metadata repository against the stack's persisted `vcs:owner` and `vcs:repo` tags, then uses these values automatically:

| Update metadata | Purpose |
|---|---|
| `vcs.owner` | GitHub organization or user |
| `vcs.repo` | Repository name |
| `ci.pr.number` | Pull request number |
| `ci.pr.headSHA` | Pull request head commit |

If `ci.pr.headSHA` is unavailable, Procella falls back to `git.head`. A complete set of explicit `github:owner`, `github:repo`, `github:pr`, and `github:sha` stack tags remains supported and takes precedence over update metadata.

When a preview associated with a pull request succeeds or fails, Procella:

1. Looks up the repository's GitHub App installation
2. Posts a Procella summary comment on the pull request
3. Creates or updates the commit status on the pull request head commit

## CI/CD Integration

Use the [Procella GitHub Action](/features/github-action/) to run a preview against the hosted Procella backend. The Pulumi CLI supplies the GitHub metadata automatically, so no `pulumi stack tag set` commands are required.

```yaml
name: Pulumi Preview

on:
  pull_request:
    branches: [main]

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - uses: tektum/procella/actions/pulumi@e036a1df5937e4ffc351c2fc47b5ea743b7f782e
        with:
          command: preview
          stack-name: my-org/my-project/staging
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
```

The metadata is attached to each update rather than stored on the stack, so concurrent or subsequent pull-request runs do not reuse another run's PR number or commit SHA.

## Managing the Integration

Go to **Settings** in the dashboard and open the **GitHub** tab. From here you can:

- Connect the configured GitHub App to the current tenant
- See every GitHub account installation bound to the tenant
- Reopen GitHub to configure repository access
- Disconnect a tenant binding without uninstalling the GitHub App

## Roadmap

The following features are planned for a later phase:

- **Git push to deploy** — automatically run `pulumi up` on merge to a configured branch
- **Review stacks** — ephemeral stacks created per PR and destroyed on merge/close, using stack tags to link them to the PR lifecycle

These aren't available yet. Track their status in the project's issue tracker.
