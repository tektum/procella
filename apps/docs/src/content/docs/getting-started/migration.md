---
title: Migrating to Procella
description: Move Pulumi stack state to Procella using supported export and import workflows.
---

Procella supports migration through the Pulumi CLI's `pulumi stack export` and `pulumi stack import` workflows — no custom state format is required. This guide covers common source backends, secrets handling, validation, and rollback procedures. Confirm your CLI version and workflow against the [compatibility policy](../compatibility/) before migrating.

## How Migration Works

Migration is **per-stack**. Each Pulumi stack has its own state checkpoint — a JSON document called an `UntypedDeployment` that contains your resource graph, outputs, and encrypted secrets. Migration exports this checkpoint from your current backend and imports it into Procella.

**Key facts:**

- You can migrate individual stacks without touching other stacks in the same project
- Your actual cloud resources are never modified — only the state metadata moves
- The Pulumi CLI handles all state translation automatically
- Procella auto-creates the organization and project hierarchy on first stack creation

## Prerequisites

Before migrating, ensure:

1. **Procella is running and accessible** — follow the [Quick Start](./quickstart/) or deploy via one of the [deployment guides](../deployment/railway/)
2. **You have a Procella API token** — either a dev mode token or a Descope access key
3. **The Pulumi CLI is installed** — v3.x or later
4. **You have credentials for your current backend** — Pulumi Cloud token, AWS credentials for S3, etc.

## Migration by Source Backend

### From Pulumi Cloud

```bash
# 1. Log into Pulumi Cloud and select the stack
pulumi login
pulumi stack select myorg/myproject/production

# 2. Export state with decrypted secrets
pulumi stack export --show-secrets --file production.json

# 3. Switch to Procella
pulumi logout
export PULUMI_ACCESS_TOKEN=<your-procella-token>
pulumi login https://procella.example.com

# 4. Create the stack and import state
pulumi stack init myorg/myproject/production
pulumi stack import --file production.json

# 5. Verify — should show zero changes
pulumi preview

```

:::note
Repeat steps 1–5 for each stack in the project. Once all stacks are imported and verified, update `Pulumi.yaml` to lock the project to Procella — see [Migrating Individual Stacks vs Whole Projects](#migrating-individual-stacks-vs-whole-projects) below.
:::

### From S3 / GCS / Azure Blob (DIY Backends)

```bash
# 1. Log into the DIY backend
pulumi login s3://my-pulumi-state-bucket
# or: pulumi login gs://my-bucket
# or: pulumi login azblob://my-container
pulumi stack select production

# 2. Export with decrypted secrets
pulumi stack export --show-secrets --file production.json

# 3. Switch to Procella
pulumi logout
export PULUMI_ACCESS_TOKEN=<your-procella-token>
pulumi login https://procella.example.com

# 4. Create and import
pulumi stack init myorg/myproject/production
pulumi stack import --file production.json

# 5. Verify
pulumi preview
```

Repeat for each stack in the project. See [Migrating Individual Stacks vs Whole Projects](#migrating-individual-stacks-vs-whole-projects) for when to update `Pulumi.yaml`.

### From Local Filesystem

```bash
# 1. Log into local backend
pulumi login --local
pulumi stack select production

# 2. Export
pulumi stack export --show-secrets --file production.json

# 3. Switch to Procella
pulumi logout
export PULUMI_ACCESS_TOKEN=<your-procella-token>
pulumi login https://procella.example.com

# 4. Create and import
pulumi stack init myorg/myproject/production
pulumi stack import --file production.json

# 5. Verify
pulumi preview
```

Repeat for each stack in the project. See [Migrating Individual Stacks vs Whole Projects](#migrating-individual-stacks-vs-whole-projects) for when to update `Pulumi.yaml`.

## Migrating Individual Stacks vs Whole Projects

The `pulumi stack export` and `pulumi stack import` commands work **per-stack** — you export and import one stack at a time. However, Pulumi's `backend.url` in `Pulumi.yaml` is **project-scoped**: it applies to every stack in the project. There is no built-in way to point one stack at Procella and another at Pulumi Cloud within the same project without environment variables.

In practice, this means the migration workflow is:

1. **Export each stack** you want to migrate (one at a time, or all at once)
2. **Switch the project** to Procella by updating `Pulumi.yaml`
3. **Import each stack** into Procella
4. **Verify each stack** with `pulumi preview`

The backend switch (`Pulumi.yaml` change) is the atomic cutover — once you commit it, all stacks in that project use Procella.

### Recommended Approach: Migrate All, Verify Gradually

Since the source backend is never modified (export is read-only), the safest approach is:

1. **Export all stacks** in the project before changing anything
2. **Update `Pulumi.yaml`** to point at Procella and commit
3. **Import stacks one at a time**, starting with dev/staging
4. **Verify each stack** with `pulumi preview` — should show zero changes
5. **Import production last** once you're confident
6. **Keep the source backend** as a fallback — if anything goes wrong, revert the `Pulumi.yaml` change

```yaml
# Pulumi.yaml — this switches ALL stacks in the project to Procella
name: my-project
runtime: typescript
backend:
  url: https://procella.example.com
```

Commit this change. Every developer who pulls the repo automatically uses Procella.

:::tip[Rollback is one git revert away]
If Procella isn't working as expected, `git revert` the `Pulumi.yaml` change. All stacks instantly point back to the original backend. Your source state was never modified.
:::

### If You Need Per-Stack Backends

If you genuinely need different stacks on different backends (e.g., production stays on Pulumi Cloud while dev uses Procella), the only option is the `PULUMI_BACKEND_URL` environment variable:

```bash
# Override backend for a single command
PULUMI_BACKEND_URL=https://procella.example.com pulumi up --stack dev
```

This is useful for CI/CD pipelines where different environments deploy to different backends, but it's not recommended for day-to-day development since it requires every developer to remember the env var.

## Secrets Handling

Secrets are the most important consideration during migration. Pulumi encrypts secret values in your state using a **secrets provider** — the encryption mechanism depends on your backend and configuration.

### Why `--show-secrets` Is Required

When you export with `--show-secrets`, the CLI decrypts all secret values and writes them as plaintext in the export file. When you import into Procella, the CLI re-encrypts them using Procella's encryption (AES-256-GCM with per-stack HKDF key derivation).

**Without `--show-secrets`**, the exported secrets remain encrypted with the *source* backend's keys. Procella cannot decrypt these — the import will succeed but your secrets will be double-encrypted and unusable.

:::caution[Always use --show-secrets]
Cross-backend migration **requires** `--show-secrets` on export. The exported file will contain plaintext secrets — treat it as sensitive, delete it after import, and never commit it to version control.
:::

### Changing Secrets Providers After Import

If you want to use a specific KMS provider instead of Procella's built-in encryption:

```bash
# After importing, change the secrets provider
pulumi stack change-secrets-provider "awskms://alias/MyKey?region=us-east-1"

# Supported providers:
# - default          (Procella's built-in AES-256-GCM)
# - passphrase       (local passphrase, requires PULUMI_CONFIG_PASSPHRASE)
# - awskms://...     (AWS KMS)
# - azurekeyvault://... (Azure Key Vault)
# - gcpkms://...     (Google Cloud KMS)
# - hashivault://... (HashiCorp Vault Transit)
```

### Passphrase-Encrypted Stacks

If your source stack uses passphrase encryption:

```bash
# Set the passphrase before exporting
export PULUMI_CONFIG_PASSPHRASE="your-passphrase"
pulumi stack export --show-secrets --file production.json
```

## Migrating Multiple Stacks

For projects with many stacks, script the migration:

```bash
#!/bin/bash
set -euo pipefail

SOURCE_BACKEND="https://api.pulumi.com"
SOURCE_TOKEN="your-pulumi-cloud-token"
TARGET_BACKEND="https://procella.example.com"
PROCELLA_TOKEN="your-procella-token"
STACKS=("myorg/myproject/dev" "myorg/myproject/staging" "myorg/myproject/production")

EXPORT_DIR=$(mktemp -d)
trap 'rm -rf "$EXPORT_DIR"' EXIT

# Phase 1: Export everything from source first (source is read-only, never modified)
for stack in "${STACKS[@]}"; do
  echo "=== Exporting $stack from source ==="
  safe_name=$(echo "$stack" | tr '/' '-')
  PULUMI_BACKEND_URL="$SOURCE_BACKEND" \
    PULUMI_ACCESS_TOKEN="$SOURCE_TOKEN" \
    pulumi stack export \
    --stack "$stack" \
    --show-secrets \
    --file "$EXPORT_DIR/$safe_name.json"
done

# Phase 2: Import all into Procella
for stack in "${STACKS[@]}"; do
  echo "=== Importing $stack into Procella ==="
  safe_name=$(echo "$stack" | tr '/' '-')

  PULUMI_BACKEND_URL="$TARGET_BACKEND" \
    PULUMI_ACCESS_TOKEN="$PROCELLA_TOKEN" \
    pulumi stack init "$stack" 2>/dev/null || true

  PULUMI_BACKEND_URL="$TARGET_BACKEND" \
    PULUMI_ACCESS_TOKEN="$PROCELLA_TOKEN" \
    pulumi stack import \
    --stack "$stack" \
    --file "$EXPORT_DIR/$safe_name.json"

  echo "=== $stack migrated ==="
done

echo "Migration complete. Run 'pulumi preview' on each stack to verify."
```

## Validation

After importing each stack, verify state integrity:

### 1. Zero-Diff Preview

```bash
pulumi preview
```

A successful migration shows **no proposed changes**. If `preview` shows diffs, the state may have drifted from actual cloud resources — this is a pre-existing issue, not a migration problem. Run `pulumi refresh` to reconcile.

### 2. Resource Count Check

```bash
# Compare resource counts
pulumi stack export | jq '.deployment.resources | length'
```

The resource count should match between source and target exports.

### 3. Stack Outputs

```bash
pulumi stack output
```

All outputs should match the source stack's outputs.

### 4. State Round-Trip

```bash
# Export from Procella and compare structure
pulumi stack export --file post-migration.json
# Compare resource URNs (ignoring metadata differences)
jq -r '.deployment.resources[].urn' production.json | sort > before.txt
jq -r '.deployment.resources[].urn' post-migration.json | sort > after.txt
diff before.txt after.txt
```

## Rollback Plan

If anything goes wrong, you can always roll back:

```bash
# Your source backend is untouched — just log back in
pulumi logout
pulumi login <original-backend>
pulumi stack select myorg/myproject/production

# Verify original state is intact
pulumi preview
```

The source backend's state is never modified during migration. Export is a read-only operation. You can safely delete the Procella stack and try again, or revert to your original backend at any time.

## CI/CD Integration

If your `Pulumi.yaml` already has `backend.url` set to Procella, CI/CD pipelines only need the access token — the backend is picked up automatically from the project file:

```yaml
# GitHub Actions — backend URL comes from Pulumi.yaml
env:
  PULUMI_ACCESS_TOKEN: ${{ secrets.PROCELLA_TOKEN }}

steps:
  - uses: pulumi/actions@v6
    with:
      command: up
      stack-name: myorg/myproject/production
```

```yaml
# GitLab CI — backend URL comes from Pulumi.yaml
variables:
  PULUMI_ACCESS_TOKEN: $PROCELLA_TOKEN

deploy:
  script:
    - pulumi up --yes --stack myorg/myproject/production
```

If you need to override the backend per-environment (e.g., a staging Procella instance), use `PULUMI_BACKEND_URL` as an override:

```yaml
# Override backend for a specific CI environment
env:
  PULUMI_BACKEND_URL: https://procella-staging.example.com
  PULUMI_ACCESS_TOKEN: ${{ secrets.PROCELLA_STAGING_TOKEN }}
```

No other changes are needed — Procella implements the same API as Pulumi Cloud.

## What Doesn't Migrate

| Item | Status | Notes |
|---|---|---|
| Latest state checkpoint | **Migrates** | Full resource graph, outputs, and secrets |
| Stack tags | **Does not migrate** | Re-apply via `pulumi stack tag set` after import |
| Update history | **Does not migrate** | History starts fresh on Procella; source history remains on the original backend |
| Stack policies | **Does not migrate** | Pulumi Cloud-specific feature; not applicable to self-hosted backends |
| Webhooks / integrations | **Does not migrate** | Re-configure in Procella's dashboard |
| Team permissions | **Does not migrate** | Set up RBAC through Descope on Procella |

## Common Issues

### `pulumi preview` shows unexpected changes

This usually means the state has drifted from actual cloud resources — it's not a migration issue. Run `pulumi refresh` to reconcile state with reality, then `pulumi preview` again.

### Import fails with "pending operations"

If the source stack has incomplete operations (e.g., a failed `pulumi up`), the export will include them:

```bash
# Edit the export to clear pending operations
jq '.deployment.pending_operations = []' production.json > production-clean.json
pulumi stack import --file production-clean.json
```

### Secrets appear as ciphertext after import

You forgot `--show-secrets` during export. Re-export from the source backend with `--show-secrets` and re-import.

### Stack name conflicts

If the stack already exists on Procella, delete it first or use a different name:

```bash
pulumi stack rm myorg/myproject/production --yes
pulumi stack init myorg/myproject/production
pulumi stack import --file production.json
```

### Self-signed TLS certificates

If Procella uses self-signed certs, use the `--insecure` flag:

```bash
pulumi login --insecure https://procella.internal.example.com
```
