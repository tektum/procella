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

### 3. Install the App on Your GitHub Org

Go back to your GitHub App settings and click **Install App**. Choose your organization and select which repositories should have access.

After installation, the app starts receiving webhook events from GitHub.

### Moving a Repository Between Organizations

Use a GitHub App owned by the destination organization when the previous organization-owned App cannot move with the repository. Create the replacement App under the destination organization, install it on the required repositories, and replace all three `PROCELLA_GITHUB_APP_*` values together with the new App ID, private key, and webhook secret. Procella rejects partial GitHub App configuration.

The new App may keep the existing webhook URL. Confirm a signed delivery succeeds after installation before retiring the old App.

### Deployment Credentials

The deployed Procella instance needs its own GitHub App credentials. Do not supply the Renovate App ID or private key as `PROCELLA_GITHUB_APP_*`; the two apps have different permissions and purposes. For SST deployments, map the dedicated Procella App to the `PROCELLA_GITHUB_APP_ID` and `PROCELLA_GITHUB_APP_PRIVATE_KEY` GitHub Actions secrets, then keep the matching webhook secret in `PROCELLA_GITHUB_APP_WEBHOOK_SECRET`.

## How PR Comments Work

The integration relies on stack tags to know which PR a stack is associated with. When running `pulumi preview` in CI, your workflow must set these tags on the stack:

| Tag | Value | Example |
|---|---|---|
| `github:owner` | GitHub org or user | `my-org` |
| `github:repo` | Repository name | `my-app` |
| `github:pr` | PR number | `42` |
| `github:sha` | Commit SHA | `abc1234...` |

When Procella receives an `update.succeeded` or `update.failed` event for a preview on a stack with these tags, it:

1. Looks up the installation token for the repo's GitHub App installation
2. Finds any existing Procella comment on the PR and updates it (or posts a new one)
3. Creates or updates the commit status on `github:sha`

## CI/CD Integration

If you don't need the GitHub App's PR comments, use the [Procella GitHub Action](/features/github-action/) and skip the setup and login steps below entirely.

This page's flow needs them because neither the Pulumi CLI nor `pulumi/actions` sets the `github:*` tags, and `pulumi stack tag set` needs an authenticated CLI. The Procella action only logs in as part of running a Pulumi command, so it cannot authenticate the tagging step that has to happen *before* the preview.

Here's a complete GitHub Actions workflow that runs `pulumi preview` on PRs and posts results:

```yaml
name: Pulumi Preview

on:
  pull_request:
    branches: [main]

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Pulumi
        uses: pulumi/actions@v7

      - name: Login to Procella
        run: pulumi login https://your-procella.example.com/api
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}

      - name: Tag stack with GitHub metadata
        run: |
          pulumi stack tag set github:owner ${{ github.repository_owner }}
          pulumi stack tag set github:repo ${{ github.event.repository.name }}
          pulumi stack tag set github:pr ${{ github.event.pull_request.number }}
          pulumi stack tag set github:sha ${{ github.event.pull_request.head.sha }}
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}

      - name: Run preview
        run: pulumi preview
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
          # Add any stack-specific env vars here
```

The tags are set at the stack level so they persist across runs. If the PR number changes (e.g. the branch is used for multiple PRs), update the tags before running preview.

## Managing the Integration

Go to **Settings** in the dashboard and open the **GitHub** tab. From here you can:

- See which repositories the app is installed on
- View recent webhook deliveries from GitHub
- Disconnect the integration (removes the webhook config from Procella, but doesn't uninstall the GitHub App)

## Roadmap

The following features are planned for a later phase:

- **Git push to deploy** — automatically run `pulumi up` on merge to a configured branch
- **Review stacks** — ephemeral stacks created per PR and destroyed on merge/close, using stack tags to link them to the PR lifecycle

These aren't available yet. Track their status in the project's issue tracker.
