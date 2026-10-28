---
title: Web Dashboard
description: The React SPA dashboard — pages, navigation, authentication modes, and Descope management widgets.
---

The Procella web dashboard is a React 19 single-page application built with Vite 7, Tailwind CSS v4, and tRPC. In production it is served as static files by the Procella server. In development the Vite dev server handles it with hot module replacement.

## Pages

| Route | Page | Description |
|---|---|---|
| `/` | Stack List | All stacks for the authenticated organization |
| `/stacks/:org/:project/:stack` | Stack Detail | Stack info and full update history |
| `/stacks/:org/:project/:stack/updates/:updateId` | Update Detail | Engine events for a single update |
| `/tokens` | API Tokens | Create/revoke API tokens and edit user profile (Descope mode only) |
| `/settings` | Admin Settings | User, role, audit, and tenant management (Descope admin only) |
| `/cli-login` | CLI Authorization | Browser-based `pulumi login` authorization flow |
| `/login` | Login | Descope sign-up-or-in flow or dev token entry |

## Navigation

The sticky header contains:

- **Procella wordmark** — links to `/`
- **"Pulumi Backend" badge** — static label
- **Tokens link** — shown in Descope mode for all authenticated users
- **Settings link** — shown in Descope mode only for users with the `admin` role
- **User avatar dropdown** (Descope mode) — displays initials, full name and email, with a sign-out action
- **Token input** (dev mode) — password field saved to `localStorage` and sent as the API token on all tRPC requests

Role detection uses the JWT claims from the active Descope session. The `admin` check reads the `roles` array for the current tenant from the session token — no server round-trip required.

## Authentication Modes

### Dev Mode

The header shows a password input. The entered token is stored in `localStorage` and attached to all tRPC requests. The CLI login page (`/cli-login`) shows a password form where the user types the static token directly.

### Descope Mode

The Descope React SDK manages the session. On load it restores any existing session from storage. The tRPC client reads the session token and sends it as `Authorization: token <key>` on every request. Role and tenant information is extracted from the JWT claims client-side.

## Tokens Page (`/tokens`)

Available in Descope mode for all authenticated users. Contains two tabs:

| Tab | Widget | Purpose |
|---|---|---|
| API Tokens | `AccessKeyManagement` | Create and revoke Descope access keys used as Pulumi API tokens |
| Profile | `UserProfile` | Edit name, email, password, MFA, and passkeys |

Access keys created here are standard Descope access keys. The Pulumi CLI uses them as `PULUMI_ACCESS_TOKEN` values — the Procella server validates them via `ExchangeAccessKey` on every request.

## Settings Page (`/settings`)

Available in Descope mode only for users with the `admin` role. Contains four tabs:

| Tab | Widget | Purpose |
|---|---|---|
| Users | `UserManagement` | Invite, remove, and manage org members and their roles |
| Roles | `RoleManagement` | View and manage roles and permissions |
| Audit Log | `AuditManagement` | Full audit trail of authentication and management events |
| Tenant | `TenantProfile` | Edit tenant name and other tenant-level settings |

Tab state is stored in the URL hash (`#users`, `#roles`, `#audit`, `#tenant`) so links are shareable.

### Tenant Admin Requirement

The Descope management widgets call Descope's management API using the user's session token. This requires the **`Tenant Admin`** built-in Descope role at the tenant level — the app-level `admin` role alone is not sufficient.

Procella's sign-up-or-in flow automatically assigns `Tenant Admin` to every user who creates a new tenant (via the `createTenant` flow action). No manual configuration is needed. The role is built into every Descope project, so no infra declaration is needed.

## CLI Login Flow (`/cli-login`)

When `pulumi login http://your-procella-host` is run, the CLI starts a local HTTP server and opens the browser to `/cli-login` with three query parameters:

| Parameter | Description |
|---|---|
| `cliSessionPort` | Port of the CLI's local callback server |
| `cliSessionNonce` | CSRF nonce for the callback |
| `cliSessionDescription` | Human-readable description of the login request (optional) |

### Descope Mode Flow

1. If the user is not authenticated, the Descope sign-up-or-in flow is shown inline.
2. Once authenticated, the user sees a confirmation card showing their email/name and a "Continue" button.
3. Clicking "Continue" calls `POST /api/auth/cli-token` with the session token. The server creates a Descope access key and returns it.
4. The browser redirects to `http://localhost:<cliSessionPort>/?accessToken=<token>&nonce=<nonce>`, which the CLI picks up and stores in `~/.pulumi/credentials.json`.

:::note
`PROCELLA_DESCOPE_MANAGEMENT_KEY` must be set on the server for token creation to work. If it is missing, the error state shows a hint.
:::

### Dev Mode Flow

A password input is shown. The user enters the static dev token and clicks "Authorize". The browser redirects directly to the CLI callback with that token — no server call is made.
