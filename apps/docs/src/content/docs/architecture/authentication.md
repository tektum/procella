---
title: Authentication
description: Dev mode, Descope integration, role-based access control, and the update-token auth flow.
---

Procella supports two authentication modes, configured via `PROCELLA_AUTH_MODE`. Both modes produce the same internal `Caller` type — the authorization layer works identically regardless of which mode is active.

:::note[Design Principle]
The only difference between dev and Descope is **authentication** (who are you?), never **authorization** (what can you do?). Both modes produce the same Caller type used by the authorization layer and role hierarchy.
:::

## Dev Mode

When `PROCELLA_AUTH_MODE=dev`, the server validates tokens against a static list configured via environment variables.

The primary user is configured with:
- `PROCELLA_DEV_AUTH_TOKEN` — the token value
- `PROCELLA_DEV_USER_LOGIN` — maps to `login` on the `Caller`
- `PROCELLA_DEV_ORG_LOGIN` — the user's organization

Additional users can be registered via `PROCELLA_DEV_USERS` (a JSON array):

```json
[
  {"token": "token-alice", "login": "alice", "org": "acme", "role": "admin"},
  {"token": "token-bob",   "login": "bob",   "org": "acme", "role": "viewer"}
]
```



## Descope Mode

When `PROCELLA_AUTH_MODE=descope`, the server uses [Descope access keys](https://docs.descope.com/accesskeys) for authentication.

### How It Works

1. Client sends `Authorization: token <descope-access-key>`
2. `DescopeAuthenticator` calls `ExchangeAccessKey` on the Descope SDK
3. Descope validates the key and returns a JWT with tenant claims
4. Procella extracts tenant memberships and roles from the JWT:
   - Each tenant the user belongs to becomes an `OrgRole`
   - Roles are read from the tenant's `roles` array claim
   - The highest role wins: `admin > member > viewer`

### Descope Setup

1. Create a Descope project at [app.descope.com](https://app.descope.com)
2. Define tenants matching your organization names
3. Create roles: `viewer`, `member`, `admin`
4. Assign users to tenants with appropriate roles
5. Generate access keys for programmatic access
6. Set `PROCELLA_DESCOPE_PROJECT_ID` to your project ID

### Descope Management Widgets

The web dashboard embeds Descope's management UI components on the Settings and Tokens pages. These widgets (`UserManagement`, `RoleManagement`, `AuditManagement`, `TenantProfile`, `AccessKeyManagement`, `UserProfile`) call Descope's management API using the user's session token — which requires the **`Tenant Admin`** built-in Descope role at the tenant level. The standard app-level `admin` role is not sufficient.

Procella's sign-up-or-in flow automatically assigns `Tenant Admin` to every user who creates a new tenant, so the Settings page works for all users without manual intervention. `Tenant Admin` is a built-in Descope role (User Admin, SSO Admin, Impersonate), so it exists in every project without being declared in `infra/descope.ts`.

### JWT Claims Mapping

| JWT Claim | Caller Field |
|---|---|
| `sub` | `userId` |
| `sub` | `login` |
| Tenant memberships | `tenantId` (from `dct` claim or tenants object) |
| Tenant roles | `roles` (admin, member, viewer) |

## Role Hierarchy

Three roles with a strict ordering:

| Role | Rank | Permissions |
|---|---|---|
| `viewer` | 1 | Read-only access (GET, HEAD) |
| `member` | 2 | Read + write (POST, PATCH) |
| `admin` | 3 | Full access including delete (DELETE) |

Roles are checked with `AtLeast` semantics — an `admin` satisfies a `member` requirement.

## Authorization Middleware

Hono middleware enforces role requirements on every API request based on HTTP method.

### Method-to-Role Mapping

| HTTP Method | Required Role |
|---|---|
| `GET`, `HEAD` | `viewer` |
| `POST`, `PATCH` | `member` |
| `DELETE` | `admin` |

### Flow

1. Extract the `Caller` from request context (set by Auth middleware)
2. Check the HTTP method against the `METHOD_ROLE_MAP`
3. Verify the caller has the required role
4. Return `403 Forbidden` if insufficient permissions

```
GET  /api/stacks/acme/myproject/dev   → requires viewer role
POST /api/stacks/acme/myproject       → requires member role
DELETE /api/stacks/acme/myproject/dev → requires admin role
```

## Update-Token Auth

During the execution phase of an update (after `StartUpdate`), a separate auth scheme is used:

- **Header**: `Authorization: update-token <lease-token>`
- **Validated by**: Hono middleware
- **Scope**: Only for checkpoint, events, renew_lease, and complete endpoints

The lease token is generated during `StartUpdate` and has an expiration time. The CLI periodically calls `renew_lease` to extend it. This ensures that crashed or abandoned updates can be detected and garbage-collected.

See [Update Lifecycle](./update-lifecycle/) for the full protocol.

## Auth Flow Summary

```
Request arrives
  │
  ├─ /healthz, /api/capabilities → No auth required
  │
  ├─ /api/* (most routes) → Auth middleware
  │    ├─ Extract "Authorization: token <key>"
  │    ├─ Validate via DevAuthService or DescopeAuthService
  │    ├─ Set Caller in context
  │    └─ Authorization middleware
  │         └─ Check method → role mapping
  │
  └─ Execution routes (checkpoint, events, etc.) → UpdateAuth middleware
       ├─ Extract "Authorization: update-token <lease>"
       └─ Validate against database
```
