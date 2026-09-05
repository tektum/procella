---
title: Horizontal Scaling
description: Running multiple Procella replicas behind a load balancer.
---

Procella is designed to scale horizontally. The Bun server is stateless — all shared state lives in PostgreSQL and S3-compatible blob storage. You can run N replicas behind a load balancer with no code changes.

## Architecture

```
┌──────────┐
│ Pulumi   │
│ CLI      │
└────┬─────┘
     │
┌────▼─────┐
│  Caddy   │  round-robin LB + health checks
│  :9090   │
└────┬─────┘
     │
  ┌──┼──┐
  │  │  │
┌─▼┐┌▼─┐┌▼─┐
│R1││R2││R3│  Procella replicas (stateless)
└─┬┘└┬─┘└┬─┘
  │  │   │
  └──┼───┘
     │
┌────▼─────┐   ┌─────────┐
│PostgreSQL │   │ S3/MinIO│
│  (state)  │   │ (blobs) │
└───────────┘   └─────────┘
```

## Quick Start

```bash
bun run docker:cluster    # Start 3 replicas + Caddy + PostgreSQL + MinIO
bun run e2e:cluster       # Run full E2E tests against the cluster
```

## What's Shared

| Component | Storage | Scaling Impact |
|---|---|---|
| Database metadata | PostgreSQL | Shared — all replicas connect to the same database |
| Checkpoints | S3 (MinIO) | Shared — all replicas read/write the same bucket |
| GC worker | One active | Advisory lock ensures only one runs at a time |
| GitHub publication worker | PostgreSQL outbox | Leased `SKIP LOCKED` claims prevent duplicate concurrent delivery |

## Cluster-Safe GC

The garbage collection worker uses a transaction-scoped PostgreSQL advisory lock to ensure only one instance runs across the entire cluster:

```sql
SELECT pg_try_advisory_xact_lock(0x5472617461_4743);  -- GC lock (historic value, do not change)
```

- Each replica attempts to acquire the lock every 60 seconds
- Only the replica that acquires the lock runs the GC cycle
- PostgreSQL releases the lock when the transaction commits, rolls back, or its connection closes

GitHub update publications use a separate transactional outbox. Replicas claim non-overlapping rows with `FOR UPDATE SKIP LOCKED`, perform GitHub network calls after committing the claim, and acknowledge only the claimed revision. Expired claims use bounded retries before dead-lettering, and scheduled drains stop before the Lambda invocation deadline.

## Load Balancer Configuration

### Caddy (Included)

The included `Caddyfile` configures Caddy as a simple round-robin reverse proxy:

```
:9090 {
    reverse_proxy procella-cluster:9090 {
        lb_policy round_robin
        health_uri /healthz
        health_interval 5s
    }
}
```

### Other Load Balancers

Any HTTP load balancer works. Requirements:
- **Health check**: `GET /healthz` returns 200 when healthy
- **Sticky sessions**: Not required — all state is in the database
- **Protocol**: HTTP/1.1 (Pulumi CLI uses HTTP/1.1)
- **Timeouts**: Set upstream timeout to at least 300 seconds (large `pulumi up` operations can take minutes)

## Production Considerations

### PostgreSQL

- Use a managed PostgreSQL service (RDS, Cloud SQL, etc.) for high availability
- Enable connection pooling (PgBouncer) if running many replicas

### S3 Storage

- Use real S3 or a managed S3-compatible service instead of MinIO
- Configure `PROCELLA_BLOB_S3_BUCKET` and optionally `PROCELLA_BLOB_S3_ENDPOINT`
- Ensure the bucket exists before starting the server

### Replica Count

- Start with 2–3 replicas for redundancy
- Add replicas based on request volume — each replica handles concurrent requests efficiently via Bun's event loop
- The database is typically the bottleneck, not the Bun server

### Container Orchestration

The Docker Compose cluster profile is a development tool. For production, use:
- **Kubernetes** — deploy as a `Deployment` with `replicas: N`, backed by a `Service`
- **ECS/Fargate** — define a task with the Procella container and a service with desired count
- **Docker Swarm** — use `deploy.replicas` (similar to the compose cluster profile)

All options work because the server is stateless and health-checkable.
