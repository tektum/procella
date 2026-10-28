---
title: Descope Setup
description: Configure Procella for production multi-tenant auth with Descope.
---

Descope mode replaces the static dev token with full multi-tenant authentication: users sign in via Descope, receive a JWT, and use Descope access keys as their `PULUMI_ACCESS_TOKEN`. You get browser-based `pulumi login`, role-based access control, audit logs, and self-service token management — all managed through the Procella dashboard.

See [Authentication Architecture](../architecture/authentication/) for how the auth layer works internally.

## Prerequisites

- A [Descope](https://app.descope.com) account
- Procella deployed and reachable (see [Docker Compose](./docker-compose/))
- [Pulumi CLI](https://www.pulumi.com/docs/install/) installed (for the `infra/` deployment step)

## Step 1: Create a Descope Project

1. Sign in to [app.descope.com](https://app.descope.com)
2. Create a new project — name it anything (e.g. `Procella`)
3. Copy the **Project ID** from the project settings (it starts with `P`)

## Step 2: Deploy Descope Configuration

The `infra/` directory contains a Pulumi program that provisions all required Descope configuration:

- **Roles**: `viewer`, `member`, `admin` (`Tenant Admin` is built into every Descope project)
- **Permissions**: `stacks:write`, `stacks:delete`, `members:manage`
- **JWT templates**: both user and access key JWTs include `roles` and `tenants` claims, with `autoTenantClaim` enabled so the `dct` claim is set automatically
- **Sign-up-or-in flow**: auto-provisions a new tenant for first-time users and assigns them `Tenant Admin`
- **Password policy**: minimum 12 characters, upper + lower + number + special required, account lock after 10 failures, temporary lock after 5 failures within a window

:::note[Management Key]
The Pulumi program authenticates to Descope using a **management key**. Generate one from your Descope project's **Access Keys** page. It is stored as a Pulumi secret and never appears in plaintext in version control.
:::

```bash
cd infra
bun install
pulumi config set --secret descope:managementKey <your-management-key>
pulumi up
```

After `pulumi up` completes, your Descope project has all roles, flows, and JWT templates configured correctly for Procella.

## Step 3: Configure Environment Variables

Set these on your Procella server:

| Variable | Required | Description |
|---|---|---|
| `PROCELLA_AUTH_MODE` | Yes | Set to `descope` |
| `PROCELLA_DESCOPE_PROJECT_ID` | Yes | Your Descope project ID (from Step 1) |
| `PROCELLA_DESCOPE_MANAGEMENT_KEY` | Recommended | Descope management key — required for browser `pulumi login` flow and API token management in the dashboard |
| `PROCELLA_ENCRYPTION_KEY` | Yes (production) | 64 hex chars — required when `PROCELLA_AUTH_MODE=descope` |

Generate an encryption key:

```bash
openssl rand -hex 32
```

:::caution
`PROCELLA_ENCRYPTION_KEY` is required in Descope mode. Back it up securely — losing it means losing access to all encrypted stack secrets.
:::

:::note
`PROCELLA_DESCOPE_MANAGEMENT_KEY` is optional but strongly recommended. Without it, `pulumi login` falls back to a manual token entry form and the API Tokens page in the dashboard is unavailable.
:::

## Step 4: pulumi login (Browser Flow)

With `PROCELLA_DESCOPE_MANAGEMENT_KEY` set, users can log in with a single command:

```bash
pulumi login http://your-procella-host
```

What happens:

1. The Pulumi CLI starts a local callback server and opens your browser to `/cli-login`
2. If you are not already signed in, the Descope sign-up-or-in form is shown
3. Once authenticated, a confirmation card shows your name and email with a **Continue** button
4. Clicking Continue calls `POST /api/auth/cli-token` — the server creates a Descope access key and returns it
5. The browser redirects to the CLI's local callback; the access key is stored in `~/.pulumi/credentials.json`

From this point on, `pulumi up`, `pulumi stack export`, etc. all work as normal.

## Managing Users and Roles

Admins manage users from the **Settings** page in the dashboard (requires the `admin` role):

- **Users tab** — invite users, remove members, change roles
- **Roles tab** — view roles and permissions
- **Audit Log tab** — full audit trail of authentication and management events
- **Tenant tab** — edit tenant name and settings

Users who sign up for the first time automatically have a tenant created for them and are assigned `Tenant Admin`, which grants access to the management widgets on the Settings page.

## API Tokens

Users manage their own Pulumi access keys from the **Tokens** page (`/tokens`) in the dashboard:

- **API Tokens tab** — create and revoke Descope access keys
- **Profile tab** — update name, email, password, MFA, and passkeys

Access keys created here are standard Descope access keys. Use them as the value of `PULUMI_ACCESS_TOKEN` for CI/CD pipelines or non-interactive environments.

## Roles Reference

| Role | Rank | HTTP Methods | Description |
|---|---|---|---|
| `viewer` | 1 | GET, HEAD | Read-only access to stacks and update history |
| `member` | 2 | POST, PATCH | Create stacks, run updates |
| `admin` | 3 | DELETE | Full access including stack deletion |
| `Tenant Admin` | — | — | Descope management widgets (Settings page) — auto-assigned on first sign-up |

Roles use `AtLeast` semantics: an `admin` satisfies any `member` or `viewer` requirement.
