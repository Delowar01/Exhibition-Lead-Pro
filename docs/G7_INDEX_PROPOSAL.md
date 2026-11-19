# G-7 — Timestamp index proposal (audit, sign-in, security and billing-event tables)

Status: **PROPOSAL — not approved, not applied.** This document is the only artifact. No
index is declared in the Drizzle schema, no SQL file was added under `lib/db/migrations/`,
and nothing here is part of the release candidate (`d1e884b…`) or of the G-7 code. The
G-7 Analytics module works without these indexes; they only make it, and several older
screens, faster.

All measurements were taken on a disposable local PostgreSQL database filled with
synthetic rows. No hosted database was contacted, so **the row counts of the hosted
tables are not known** (see §10, decision 5).

## 1. Summary

- Four append-only tables are read by time range or "newest first" and have no index that
  supports it: `audit_logs`, `login_attempts`, `security_events` (primary key only) and
  `billing_provider_events` (no index on `received_at`).
- Recommendation: **seven indexes on those four tables** (§3). At the tested volume they
  cut the 30-day Analytics queries by 4–9×, the sign-in lockout check (run on every
  sign-in) from 81 ms to 0.05 ms, and the audit-log and security-event screens from
  50–340 ms to under 1 ms.
- **A timestamp index must never be added alone to `audit_logs`, `login_attempts` or
  `security_events`.** Alone, it makes tenant-facing "one company / one user, newest
  first" lists *slower* than today (up to 7× in the tests). Each needs its companion
  index; the pairs are part of the recommendation.
- **No time index is recommended on `leads`** (an earlier idea, withdrawn): it would slow
  the tenant leads list from 0.02 ms to 232 ms for a small tenant.
- Rollout is a separate, owner-approved change **after** the `0040` release has been
  applied and verified: built with `CREATE INDEX CONCURRENTLY`, one statement at a time,
  then declared in the schema. It cannot be folded into `0040` (§9).

## 2. What exists today

| Table | Existing indexes | How it is read by time |
| --- | --- | --- |
| `audit_logs` | primary key only | Analytics (events by area, subscription changes, daily series); audit-log viewer (tenant and platform, newest first); plan history of a company; opt-in retention purge |
| `login_attempts` | primary key only | sign-in lockout check on **every sign-in** (`email`, failures, last minutes); Analytics (sign-ins, active users); security alerts (last 24 h); a user's sign-in history |
| `security_events` | primary key only | Security Center list (tenant and platform, newest first); security alerts; Analytics (by type) |
| `billing_provider_events` | primary key, unique `event_id`, `status`, `company_id` | Analytics (notification counts in the period). Lists are ordered by `id`, not by time |
| `leads` | primary key and eight indexes (`company_id`, `(company_id, stage)`, …) — none on `created_at` | Analytics (lead counts); tenant leads list ordered by `created_at` |
| `users` | — none on `created_at` | Analytics growth (60,000 rows scan in 7–10 ms) |

`scans`, `contacts` and `ai_invocations` already have an index on their creation time and
are not part of this proposal.

Redundancy check: none of the seven proposed indexes duplicates an existing one, and none
is a prefix of another proposed one (`(created_at)` and `(company_id, created_at)` serve
different queries — a platform-wide time range needs the timestamp first; a
single-company list needs the company first).

## 3. Recommended indexes and exact DDL

```sql
-- Send every statement on its own: never inside BEGIN/COMMIT and never as one
-- multi-statement string (CREATE INDEX CONCURRENTLY refuses to run in a transaction).
SET statement_timeout = 0;  -- a time-out that interrupts a build leaves an invalid index
SET lock_timeout = 0;       -- a waiting concurrent build blocks no read or write (§8)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_company_created_idx" ON "audit_logs" USING btree ("company_id", "created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "login_attempts_created_at_idx" ON "login_attempts" USING btree ("created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "login_attempts_user_created_idx" ON "login_attempts" USING btree ("user_id", "created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "security_events_created_at_idx" ON "security_events" USING btree ("created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "security_events_company_created_idx" ON "security_events" USING btree ("company_id", "created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "billing_provider_events_received_at_idx" ON "billing_provider_events" USING btree ("received_at");
```

The matching schema declarations (to be added in the same future change, not now):

```ts
// audit_logs
index("audit_logs_created_at_idx").on(t.createdAt),
index("audit_logs_company_created_idx").on(t.companyId, t.createdAt),
// login_attempts
index("login_attempts_created_at_idx").on(t.createdAt),
index("login_attempts_user_created_idx").on(t.userId, t.createdAt),
// security_events
index("security_events_created_at_idx").on(t.createdAt),
index("security_events_company_created_idx").on(t.companyId, t.createdAt),
// billing_provider_events
index("billing_provider_events_received_at_idx").on(t.receivedAt),
```

Verified locally: a database built from the current schema plus the DDL above, and a
database pushed from a schema carrying these declarations, have the **same schema
fingerprint** (`82e81e7c4e6d8046d1ff86f0bf4a7447`), and `push` then reports
"No changes detected". Running the DDL a second time changes nothing, and dropping the
seven indexes returns the fingerprint to `c36a8a2d9c7e502a2ce31ff5f3f412d9`.

| Index | Why |
| --- | --- |
| `audit_logs (created_at)` | Analytics time ranges; platform audit viewer newest-first; retention purge |
| `audit_logs (company_id, created_at)` | **Required companion.** Tenant audit viewer, its row count, plan history |
| `login_attempts (created_at)` | Lockout check, Analytics sign-ins / active users, security alerts |
| `login_attempts (user_id, created_at)` | **Required companion.** A user's sign-in history; active users over long periods |
| `security_events (created_at)` | Platform Security Center list, Analytics by type |
| `security_events (company_id, created_at)` | **Required companion.** Tenant Security Center list, policy-block alerts |
| `billing_provider_events (received_at)` | Analytics notification counts |

### Considered and not recommended

| Candidate | Result | Decision |
| --- | --- | --- |
| `leads (created_at)` | Analytics lead counts 55 → 10 ms, but the tenant leads list (first 20, ordered by creation time) went 0.02 → 232 ms for a small tenant and 1.2 → 5.2 ms for a typical one | **Rejected** — slows a tenant-facing screen to speed up a platform report |
| `login_attempts (email, created_at)` | 169 MB; the lockout check is already 0.05 ms with `(created_at)` because its window is minutes long | Rejected — no gain |
| partial `audit_logs (created_at) WHERE entity_type = 'subscription'` | 30-day subscription changes 14.7 → 5.4 ms; no gain on a year | Rejected — marginal |
| `users (created_at)` | 7 → 0.5 ms | Rejected — negligible at this table's size |

## 4. Test set-up

PostgreSQL 16.15, local, default settings (`shared_buffers` 128 MB, `work_mem` 4 MB,
two parallel workers), warm cache, schema pushed from this branch. Synthetic rows spread
over three years and inserted in time order, as append-only tables are filled in practice:

| Table | Rows | Heap |
| --- | ---: | ---: |
| `audit_logs` | 4,000,000 | 441 MB |
| `login_attempts` | 3,000,000 | 296 MB |
| `security_events` | 600,000 | 54 MB |
| `billing_provider_events` | 300,000 | 39 MB |
| `leads` | 1,500,000 | 132 MB |
| `users` / `companies` | 60,000 / 2,000 | — |

Each query was run with `EXPLAIN (ANALYZE, BUFFERS)`; the figure is the median execution
time, first run discarded. Queries are the ones the application sends, with literal
values. "Small tenant" is a company with two or three rows in the table; "typical tenant"
is one of the 2,000 evenly filled companies.

## 5. Query-plan evidence

### 5.1 Analytics queries and other existing screens — before and after the recommended set

Before, every query below is a full sequential scan.

| Query | Before (ms) | After (ms) | Change | Buffers before → after | Plan after |
| --- | ---: | ---: | ---: | ---: | --- |
| audit: count of events (30 d) | 115.2 | 15.07 | 7.6× | 56,432 → 303 | index-only scan, `audit_logs_created_at_idx` |
| audit: events by area (30 d) | 134.4 | 20.43 | 6.6× | 56,451 → 40,429 | index scan, `audit_logs_created_at_idx` |
| audit: subscription changes (30 d) | 132.6 | 15.12 | 8.8× | 56,432 → 40,397 | index scan, `audit_logs_created_at_idx` |
| audit: daily series (30 d) | 154.8 | 48.67 | 3.2× | 56,508 → 303 | index-only scan, `audit_logs_created_at_idx` |
| sign-ins: attempt counts (30 d) | 81.0 | 18.67 | 4.3× | 37,931 → 20,332 | index scan, `login_attempts_created_at_idx` |
| sign-ins: active users (30 d) | 169.6 | 45.30 | 3.7× | 39,207 → 21,793 | index scan, `login_attempts_created_at_idx` |
| sign-ins: daily series (30 d) | 102.4 | 46.77 | 2.2× | 38,007 → 20,332 | index scan, `login_attempts_created_at_idx` |
| security events: by type (30 d) | 26.2 | 4.35 | 6.0× | 6,916 → 849 | index scan, `security_events_created_at_idx` |
| billing notifications: counts (30 d) | 16.4 | 2.18 | 7.5× | 5,000 → 360 | index scan, `billing_provider_events_received_at_idx` |
| audit: count of events (365 d) | 170.2 | 71.63 | 2.4× | 56,432 → 3,648 | index-only scan, `audit_logs_created_at_idx` |
| audit: events by area (365 d) | 243.4 | 222.82 | 1.1× | 56,451 → 490,074 | index scan, `audit_logs_created_at_idx` |
| audit: subscription changes (365 d) | 136.8 | 130.16 | 1.1× | 56,432 → 490,045 | index scan, `audit_logs_created_at_idx` |
| sign-ins: attempt counts (365 d) | 114.8 | 93.61 | 1.2× | 37,931 → 251,304 | index scan, `login_attempts_created_at_idx` |
| sign-ins: active users (365 d) | 270.4 | 156.17 | 1.7× | 39,267 → 323,816 | index scan, `login_attempts_user_created_idx` |
| security events: by type (365 d) | 41.9 | 34.97 | 1.2× | 6,916 → 10,811 | index scan, `security_events_created_at_idx` |
| billing notifications: counts (365 d) | 22.7 | 18.83 | 1.2× | 5,000 → 4,523 | index scan, `billing_provider_events_received_at_idx` |
| **sign-in lockout check (every sign-in)** | 80.8 | 0.05 | 1,616× | 37,934 → 20 | index scan, `login_attempts_created_at_idx` |
| **audit viewer, platform, newest 50** | 339.6 | 0.06 | 5,660× | 56,506 → 21 | index scan, `audit_logs_created_at_idx` |
| audit viewer, one company, newest 50 | 100.2 | 0.15 | 668× | 56,506 → 53 | index scan, `audit_logs_company_created_idx` |
| security events list, newest 50 | 48.4 | 0.06 | 807× | 6,971 → 6 | index scan, `security_events_created_at_idx` |
| a user's sign-in history, newest 20 | 78.5 | 0.13 | 604× | 38,008 → 26 | index scan, `login_attempts_user_created_idx` |
| leads: count (30 d / 365 d) | 54.6 / 73.5 | 51.27 / 73.08 | unchanged | 16,951 → 16,951 | sequential scan (no index proposed) |
| users: created in the period (30 d / 365 d) | 7.4 / 9.3 | 8.13 / 10.56 | unchanged | 1,276 → 1,276 | sequential scan (no index proposed) |

The nine 30-day queries on the four indexed tables add up to about 930 ms before and
about 215 ms after.

### 5.2 Why the companion indexes are required

The same queries under three configurations: today's indexes; a timestamp index alone on
each table ("bare"); the recommended set.

| Query | Today (ms) | Bare timestamp index only (ms) | Recommended set (ms) |
| --- | ---: | ---: | ---: |
| audit log viewer, newest 50 — typical tenant | 85.75 | 20.55 | 0.05 |
| audit log viewer, newest 50 — **small tenant** | 106.03 | **619.43** | 0.01 |
| audit log viewer, row count — typical / small tenant | 86.73 / 94.58 | 102.33 / 96.27 | 0.33 / 0.01 |
| a user's sign-in history, newest 20 — typical user | 77.06 | **302.81** | 0.02 |
| a user's sign-in history, newest 20 — user with two sign-ins | 79.08 | **241.47** | 0.01 |
| security events, newest 100 — typical tenant | 21.02 | **31.36** | 0.12 |
| security events, newest 100 — small tenant | 23.61 | **47.28** | 0.03 |
| plan history, first row — typical / small tenant | 123.97 / 126.97 | 116.56 / 119.84 | 2.45 / 0.02 |
| plan history, row count — typical / small tenant | 116.27 / 141.93 | 116.05 / 123.56 | 1.65 / 0.03 |
| security alerts, tenant's failed sign-ins, 24 h | 90.58 | 0.59 | 0.48 |
| security alerts, tenant's policy blocks, 24 h | 28.68 | 0.09 | 0.01 |
| leads list, first 20 — typical tenant (with a bare `leads (created_at)`) | 1.15 | **5.17** | 0.98 (no leads index) |
| leads list, first 20 — **small tenant** (with a bare `leads (created_at)`) | 0.02 | **231.88** | 0.03 (no leads index) |

The cause is the same every time. For "rows of one company, newest first, first N", the
planner prefers to walk a timestamp index from the newest row and filter, expecting to
find N matching rows quickly. For a tenant with few rows that walk covers the whole index:

```
-- small tenant, timestamp index only                              Execution Time: 621.677 ms
Limit (actual rows=3)
  ->  Index Scan Backward using audit_logs_created_at_idx on audit_logs (actual rows=3)
        Filter: (company_id = $0)
        Rows Removed by Filter: 4000000
        Buffers: shared hit=1406408 read=67108

-- same query with the companion index                               Execution Time: 0.125 ms
Limit (actual rows=3)
  ->  Index Scan Backward using audit_logs_company_created_idx on audit_logs (actual rows=3)
        Index Cond: (company_id = $0)
        Buffers: shared hit=32
```

### 5.3 Measured and left unchanged (no gain, no loss)

| Query | Today (ms) | Recommended set (ms) | Note |
| --- | ---: | ---: | --- |
| platform: one company's administrative trail, newest 50 | 119.7 – 127.9 | 121.9 – 132.4 | its `OR … entity_id = …` branch has no usable index; still a full scan |
| platform audit viewer, total row count | 201.3 | 178.4 | counts the whole table |
| platform audit viewer, filter that matches nothing | 117.2 | 105.4 | full scan either way |
| platform audit viewer, text search that matches nothing | 1,252 | 1,197 | `ILIKE` over three columns of every row; not an index question |
| leads pipeline / leads list (no leads index) | 0.01 – 1.15 | 0.02 – 0.98 | unchanged plans |

These are existing behaviours, not regressions; they are listed so they are not mistaken
for something this proposal fixes.

Not measured, noted for a separate look: `contacts` and `scans` already carry a timestamp
index on its own (`contacts_created_at_idx`, `scans_created_at_idx`). The effect shown in
§5.2 for `leads` could apply to the tenant contact and capture lists of small tenants in
the same way. Those tables were not filled in this test, so this is a question, not a
finding.

## 6. Expected improvements and trade-offs

**Improvements** (at the tested volume)

- Default 30-day Analytics view: 4–9× faster per query on the four tables.
- Every sign-in: the lockout check stops scanning the whole `login_attempts` table.
- Audit-log viewer, Security Center list, sign-in history, plan history: from 50–340 ms
  to under 3 ms, for tenants and for the platform.
- The process-wide read gate keeps bounding how many Analytics queries run at once; the
  indexes shorten how long each one runs.

**Trade-offs**

| Cost | Measured |
| --- | --- |
| Disk | ≈ 398 MB of new indexes for ≈ 830 MB of table data (`audit_logs` 86 + 120 MB, `login_attempts` 64 + 90 MB, `security_events` 13 + 18 MB, `billing_provider_events` 6.6 MB). Backups grow accordingly |
| Writes | Inserting 100,000 rows: `audit_logs` ≈ 175–225 ms → ≈ 445–690 ms; `login_attempts` ≈ 160–195 ms → ≈ 445–720 ms; `security_events` ≈ 165–205 ms → ≈ 420–820 ms. That is about 2 µs → 5–6 µs per row; these tables receive one row per audited action or sign-in |
| Year-long periods | Little gain (1.1–2.4×): a year is a third of the test data, so most of the table is read either way. Counts and daily series still improve because they are answered from the index alone |
| Leads and users figures | Unchanged (about 50–75 ms and 7–10 ms at the tested volume), by decision (§3) |
| Physical order | The gains assume rows are stored roughly in time order, which holds for append-only tables. In a first test with timestamps scattered at random the two wide audit queries became *slower* (127 → 152 ms, 123 → 220 ms). A large back-dated import into these tables would reduce the benefit |
| Small tables | With a few thousand rows every query above is already fast; the indexes then cost little and gain little. They are an investment in growth |

## 7. Safe rollout

Build first, declare second, and never the other way round.

1. **After** the `0040` release is applied and verified (§9). Own approval, own
   maintenance note, own rehearsal on a disposable restored copy.
2. Read-only pre-check: table sizes, no invalid index left behind, schema fingerprint
   equals the post-`0040` value `c36a8a2d9c7e502a2ce31ff5f3f412d9`.
3. Run the DDL of §3 **one statement at a time** in a plain `psql` session (autocommit).
   `CREATE INDEX CONCURRENTLY` does not block reads or writes while it builds.
4. After each statement check that no index is invalid:
   `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;` must return no row.
5. Deploy the commit whose schema **declares** the seven indexes. A later schema push then
   reports "No changes detected" (verified: the index objects are untouched). Between
   steps 3 and 5 the migrate one-shot must not be run (see below).
6. Post-check: fingerprint equals `82e81e7c4e6d8046d1ff86f0bf4a7447`; run `ANALYZE` on the
   four tables; compare one Analytics request and one sign-in before and after.

A reviewed SQL file (for example `lib/db/migrations/0041_analytics_timestamp_indexes.sql`)
should accompany that change. Unlike `0040` it must **not** be wrapped in
`BEGIN … COMMIT`, and it must be fed to `psql` as a file or statement by statement.

Two orders that must be avoided — both were reproduced locally:

- **Declaring first and letting the schema push create the indexes.** `push` issues a
  plain `CREATE INDEX`, which blocks every write to the table for the whole build. On the
  test data inserts into `audit_logs` waited up to 1.6 s through `push`, and 5.4 s behind a
  single plain build. Every audited action and every sign-in writes to these tables.
- **Running the migrate one-shot or any schema push from a checkout that does not declare
  the indexes.** `push` then **drops all seven** without a prompt and exits 0
  ("Changes applied"). This is the rule the `0040` release already states for its own
  objects; here the loss is performance, not data, but it is silent.

## 8. Locking, failure and rollback

| Situation | Observed locally | Handling |
| --- | --- | --- |
| Concurrent build | 38 inserts completed during one build, slowest 284 ms. Build times at the test volume: 0.2–3.0 s per index, 9 s for all seven | Use `CONCURRENTLY` only |
| Plain build | A concurrent insert waited 5.4 s, the whole build | Never use a plain `CREATE INDEX` on these tables |
| Another transaction is open | A concurrent build waits for transactions that were already writing to the table. While it waited, another session's insert went through in 58 ms, and the index was valid once the build finished | Check `pg_stat_activity` for long-running or idle-in-transaction sessions before starting |
| Short `lock_timeout` on the build | With `lock_timeout = '2s'` the same wait ended in `ERROR: canceling statement due to lock timeout` and **left an invalid index** | Do not set a short lock time-out for these builds (the DDL sets it to 0): waiting is harmless, failing is not. The same applies to `statement_timeout` |
| Inside a transaction or a multi-statement string | `ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block` | One statement per call |
| Interrupted or cancelled build | The index remains with `indisvalid = false`; the planner ignores it but every write still maintains it. `CREATE INDEX CONCURRENTLY IF NOT EXISTS` then prints "already exists, skipping" and reports success **without** repairing it | After any failure: `DROP INDEX CONCURRENTLY IF EXISTS "<name>";` then build again (verified: valid afterwards). The validity check of step 4 is mandatory |
| Rollback | `DROP INDEX CONCURRENTLY IF EXISTS "<name>";` took 49–125 ms per index and does not block writes; after all seven the fingerprint is the post-`0040` value again | Drop the index, then deploy a schema that no longer declares it. (If the declaring schema is still deployed and the migrate one-shot is run, `push` re-creates the index with a blocking plain build) |

Rolling back is safe at any point: the indexes hold no data of their own, no code depends
on them, and removing them only returns the queries to today's speed. Each of the four
tables can be rolled out or rolled back independently, **but the two indexes of a pair
always go together** (§5.2).

## 9. Compatibility with the approved `0040` release migration

- **No object overlap.** `0040` changes `plans`, `plan_versions`, `subscriptions` and
  `plan_prices`. This proposal touches `audit_logs`, `login_attempts`, `security_events`
  and `billing_provider_events` only.
- **Cannot be merged into `0040`.** `0040` is one transaction with `SET LOCAL` time-outs;
  `CREATE INDEX CONCURRENTLY` cannot run in a transaction. Converting to plain
  `CREATE INDEX` to fit would take write-blocking locks on the busiest tables inside the
  release transaction.
- **Must not be applied before `0040`.** The release procedure pins the schema fingerprint
  before (`30c4ecbd867cd2cd59abcb58581ecb04`) and after
  (`c36a8a2d9c7e502a2ce31ff5f3f412d9`). The fingerprint covers index definitions, so any
  index added earlier makes the release's own pre-check fail.
- **G-7 itself changes no schema.** A database pushed from the G-7 branch has the
  post-`0040` fingerprint `c36a8a2d…` exactly, so G-7 can follow the release without a
  schema step, with or without these indexes.
- **New fingerprint pair for this change:** `c36a8a2d9c7e502a2ce31ff5f3f412d9` →
  `82e81e7c4e6d8046d1ff86f0bf4a7447` (current schema plus the seven indexes; identical
  whether built by the DDL or declared in the schema).

## 10. Owner decisions

1. **Approve the index change as its own batch, after the `0040` release?**
   Recommended: yes.
2. **Scope.** Recommended: all seven. A smaller scope is possible per table
   (`billing_provider_events` alone; or any of the three pairs), never half a pair.
3. **Leads.** Recommended: no time index on `leads`; its Analytics figures stay at today's
   speed. To be revisited only with new evidence.
4. **Form of the change.** Recommended: schema declarations plus a reviewed,
   non-transactional `0041_…sql`, a rehearsal on a disposable restored copy, and the
   build-then-declare order of §7.
5. **Timing.** The hosted table sizes were not read. A read-only size check should be the
   first step of the approved change: with small tables the change is quick and low-risk
   but brings little today; it becomes worth more as the audit and sign-in tables grow.
6. **Who runs it and when.** A supervised operator session with its own authorization,
   as for the release.

Not part of this proposal and not started: the schema declarations, the `0041` file, any
rehearsal on restored data, and any contact with a hosted database.
