# Plan-Version Backfill — Safe Operator Runbook

Scope: `artifacts/api-server/scripts/backfill-plan-versions.ts` (Batch 40 backfill,
Batch 41 hardening, Batch 42 database-identity verification). The script creates
version 1 of every published plan from the plan row's actual values and pins every
NULL-reference subscription to it, verifying inside one transaction that no
tenant's effective limits, overrides, status, access mode, billing source, trial /
period dates, provider price, feature entitlements or trial policy changed. It is
idempotent (a second run writes nothing).

**This runbook authorizes nothing.** A production run requires a separate,
explicit owner authorization naming the database, the operator and the window.
Nothing in this document is a production database operation.

## 1. Why the URL guard alone is not enough

The Batch 41 guard classifies the configured `DATABASE_URL` by its host before any
connection: a loopback host (`localhost`, `127.0.0.1`, `::1`) is "local", anything
else is "remote" and requires an explicit, matching `--expect-host` (plus
`--confirm-production` to `--apply`). `NODE_ENV` is never taken as proof of a
non-production database.

That classification can be wrong when the connection is **forwarded**:

| Scenario | What the URL says | Where the connection really goes |
| --- | --- | --- |
| SSH tunnel `ssh -L 5432:localhost:5432 <vps>` | `localhost:5432` → "local" | the VPS's own database |
| SSH tunnel `ssh -L 5432:<db-host>:5432 <bastion>` | `localhost:5432` → "local" | a remote database server |
| Docker / compose port publish (`127.0.0.1:5432:5432`) | `localhost:5432` → "local" | the container's database (may be a production clone) |
| A copied `.env` / shell profile from another machine | whatever that file says | wherever it pointed on the other machine |
| Two local clusters on different ports | the right host, the wrong port | a different cluster with a same-named database |

In every row the operator's belief ("this is my disposable local database") and
the real target can differ while the URL guard passes.

## 2. What Batch 42 verifies (fail closed)

After the URL guard accepts the configuration and **before any application module
runs**, the script asks the connected server who it is (read-only queries only) and
verifies the answer against the operator's stated expectations:

| Fact | Source | Notes |
| --- | --- | --- |
| database name | `current_database()` | always readable |
| server address / port | `inet_server_addr()`, `inet_server_port()` | `null` for a Unix-socket connection; a **non-loopback** address behind a **loopback URL** means the connection is forwarded |
| cluster system identifier | `pg_control_system().system_identifier` | superuser-only by default; `null` when not readable — never treated as a match |
| environment marker | `COMMENT ON DATABASE … IS 'environment=<name>'` | readable by every role; the database's own declaration of what it is |
| server version, postmaster start time, cluster name | informational | printed as evidence, not gated |

Decision table (`verifyDatabaseIdentity`, `src/lib/db-target.ts`):

| Condition | Result |
| --- | --- |
| `--expect-database` given and ≠ `current_database()` | refuse `EXPECT_DATABASE_MISMATCH` (dry run too) |
| `--apply` without `--expect-database` | refuse `EXPECT_DATABASE_REQUIRED` |
| `--expect-system-id` given, fact not readable | refuse `SYSTEM_ID_UNAVAILABLE` (cannot verify ≠ verified) |
| `--expect-system-id` ≠ system identifier | refuse `SYSTEM_ID_MISMATCH` |
| `--expect-environment` given, database carries no marker | refuse `ENVIRONMENT_MARKER_MISSING` |
| `--expect-environment` ≠ marker | refuse `ENVIRONMENT_MARKER_MISMATCH` |
| database marked `environment=production` without `--confirm-production` | refuse `PRODUCTION_CONFIRMATION_REQUIRED` (even a dry run) |
| database marked `environment=production`, `--apply` without `--expect-environment production` | refuse `ENVIRONMENT_EXPECTATION_REQUIRED` |
| database carries any marker, `--apply` without `--expect-environment` | refuse `ENVIRONMENT_EXPECTATION_REQUIRED` |
| loopback URL but non-loopback server address, without `--allow-forwarded` | refuse `FORWARDED_CONNECTION_SUSPECTED` (dry run too) |
| forwarded + `--apply` without `--confirm-production` | refuse `PRODUCTION_CONFIRMATION_REQUIRED` |

Limits (be honest about them):

- A tunnel whose remote end connects to the remote machine's **own loopback**
  (`ssh -L 5432:localhost:5432 <vps>`) makes the server report a loopback address
  too, so the forwarded-connection check **cannot** see it. The database name,
  the environment marker and (when readable) the system identifier are the
  defences for that case — which is why `--expect-database` is mandatory for
  `--apply` and why every environment should carry a marker.
- A marker is only as good as its maintenance: set it once per environment (see
  §3) and never copy a marked database dump into another environment without
  re-marking it.

## 3. One-time environment marking (per environment, by its owner)

Run as a role allowed to comment on the database (the database owner):

```sql
-- local developer database (disposable)
COMMENT ON DATABASE <local_db_name> IS 'environment=local';
-- staging
COMMENT ON DATABASE <staging_db_name> IS 'environment=staging';
-- production (an OWNER action on the production database; not performed by this script)
COMMENT ON DATABASE <production_db_name> IS 'environment=production';
```

Read it back with `SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database();`.
A production marker makes every run of this script refuse without
`--confirm-production`, and every `--apply` refuse without
`--expect-environment production` — exactly the explicitness the owner
authorization requires.

## 4. Operator procedure (local or staging; production only under authorization)

1. **Shell hygiene.** Start a fresh shell. Do not source a shared `.env`. Export
   `DATABASE_URL`, `SESSION_SECRET`, `NODE_ENV` explicitly. Check for tunnels and
   forwarded ports before running anything:
   ```bash
   ps -ef | grep -E 'ssh .* -L|ssh .* -R' | grep -v grep     # active SSH forwards
   docker ps --format '{{.Names}} {{.Ports}}' | grep 5432     # published container ports
   ss -ltnp | grep 5432                                        # who listens on 5432 locally
   ```
   Any listener you did not start yourself is a reason to stop.
2. **Identity dry run.** Always first, always with an expectation:
   ```bash
   pnpm --filter @workspace/api-server run backfill-plan-versions --expect-database <name> [--expect-environment local]
   ```
   Read the two identity lines the script prints before any backfill output:
   `database target: <host>[:port]/<db> (local|remote)` and
   `database identity: database=… serverAddr=… systemId=… environment=… forwarded=…`.
   Compare them with what you believe the target is. A `forwarded=true` line, an
   unexpected database name, an unexpected marker or an unexpected server address
   ends the procedure.
3. **Evidence snapshot (optional, read-only).** `--snapshot` prints the
   entitlement snapshot (BEFORE evidence) for the record.
4. **Apply (only on a disposable local database, or under a separate owner
   authorization for staging / production).**
   ```bash
   pnpm --filter @workspace/api-server run backfill-plan-versions --apply \
     --expect-database <name> --expect-environment <marker> [--expect-system-id <id>] \
     [--expect-host <host> --confirm-production]      # non-loopback / production only
   ```
   The script runs the dry run again and applies only when it is complete; any
   verification difference rolls everything back (`VERIFICATION_FAILED`).
5. **Record.** Keep the printed identity lines, the verdict line and the
   `evaluationInstant` with the authorization that covered the run.

Exit codes: `0` success / dry-run ok, `2` refused by a guard (nothing was run),
`3` incomplete or failed verification (rolled back), `1` unexpected error.

## 5. What this runbook does NOT do

- It does not connect to, back up, migrate or modify any production database.
- It does not grant `pg_control_system()` to the application role (an optional
  hardening the owner may decide separately; the script works without it).
- It does not replace the owner authorization: a production run needs the
  database name, the environment marker, the operator, the window and the
  explicit `--confirm-production` flag in a separate message.
