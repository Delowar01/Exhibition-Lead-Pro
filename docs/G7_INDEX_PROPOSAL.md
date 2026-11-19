# G-7 — Index proposal for the audit, sign-in, security-event and billing-event tables

Status: **PROPOSAL — not approved, not applied.** This document is the only artifact. No
index is declared in the Drizzle schema, no SQL file was added under `lib/db/migrations/`,
and nothing here is part of the release candidate (`d1e884b…`) or of the G-7 code. The
G-7 Analytics module works without these indexes.

All measurements were taken on a disposable local PostgreSQL database filled with
synthetic rows. No hosted database was contacted, so **the row counts of the hosted
tables are not known** (§11, decision 6).

## 1. Summary

- Four tables are read by time, by company or by user and have no index for it:
  `audit_logs`, `login_attempts`, `security_events` (primary key only) and
  `billing_provider_events` (no index on `received_at`).
- **Recommended core — five lookup indexes.** They make every tenant-facing list on these
  tables fast (audit log viewer, Security Center, sign-in history, plan history: 75–135 ms
  → under 8 ms at the tested volume) and take the sign-in lockout check, which runs on
  every sign-in, from 86 ms to 0.01 ms — also during a burst of failed sign-ins. No query
  was slower with them than today.
- **Recommended addition — three BRIN time indexes** (88 kB in total). They are what
  speeds up the Analytics time-range queries (nine 30-day queries: 871 ms → 228 ms). Their
  benefit depends on rows staying in insertion order and can fade (§7); they cannot make a
  query slower.
- **Not recommended: an ordinary (b-tree) index on the timestamp.** It gives the same
  Analytics gain and instant platform-wide "newest first" lists, but it made the audit log
  list of a user with access to two small companies take 531–841 ms instead of 125 ms
  today, and that cost grows with the table. Without the lookup indexes it is worse still.
- **No time index on `leads`**: it slowed the tenant leads list from 0.02 ms to 232 ms.
- Rollout is a separate, owner-approved change **after** the `0040` release is applied and
  verified: `CREATE INDEX CONCURRENTLY`, one statement at a time, then declared in the
  schema. It cannot be folded into `0040` (§10).

## 2. What exists today

| Table | Existing indexes | How it is read |
| --- | --- | --- |
| `audit_logs` | primary key only | audit log viewer (tenant: own companies, newest first; platform: all); plan history of a company; Analytics (events by area, subscription changes, daily series); opt-in retention purge |
| `login_attempts` | primary key only | sign-in lockout check on **every sign-in** (`email`, failures, last minutes); a user's sign-in history; security alerts (last 24 h); Analytics (sign-ins, active users) |
| `security_events` | primary key only | Security Center list (tenant and platform, newest first); security alerts; Analytics (by type) |
| `billing_provider_events` | primary key, unique `event_id`, `status`, `company_id` | Analytics (notification counts in the period). Its lists are ordered by `id`, not by time |
| `leads` | primary key and eight indexes (`company_id`, `(company_id, stage)`, …), none on `created_at` | tenant leads list ordered by `created_at`; Analytics (lead counts) |
| `users` | none on `created_at` | Analytics growth (60,000 rows scan in 7–10 ms) |

Redundancy check: none of the proposed indexes duplicates an existing index or is a prefix
of another proposed one.

## 3. Recommended indexes and exact DDL

```sql
-- Feed this to psql as a file (autocommit). Never wrap it in BEGIN/COMMIT and never send
-- it as one multi-statement string: CREATE INDEX CONCURRENTLY refuses to run in a
-- transaction.
\set ON_ERROR_STOP on
SET statement_timeout = 0;  -- a time-out that interrupts a build leaves an invalid index
SET lock_timeout = 0;       -- a waiting concurrent build blocks no read or write (§9)

-- Core: five lookup indexes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_company_created_idx" ON "audit_logs" USING btree ("company_id", "created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "login_attempts_user_created_idx" ON "login_attempts" USING btree ("user_id", "created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "login_attempts_failed_email_idx" ON "login_attempts" USING btree ("email", "created_at") WHERE success = false;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "security_events_company_created_idx" ON "security_events" USING btree ("company_id", "created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "billing_provider_events_received_at_idx" ON "billing_provider_events" USING btree ("received_at");

-- Addition: three BRIN time indexes for the Analytics time ranges.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_created_at_brin" ON "audit_logs" USING brin ("created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "login_attempts_created_at_brin" ON "login_attempts" USING brin ("created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "security_events_created_at_brin" ON "security_events" USING brin ("created_at");
```

The matching schema declarations (for the same future change, not now):

```ts
// audit_logs
index("audit_logs_company_created_idx").on(t.companyId, t.createdAt),
index("audit_logs_created_at_brin").using("brin", t.createdAt),
// login_attempts
index("login_attempts_user_created_idx").on(t.userId, t.createdAt),
index("login_attempts_failed_email_idx").on(t.email, t.createdAt).where(sql`success = false`),
index("login_attempts_created_at_brin").using("brin", t.createdAt),
// security_events
index("security_events_company_created_idx").on(t.companyId, t.createdAt),
index("security_events_created_at_brin").using("brin", t.createdAt),
// billing_provider_events
index("billing_provider_events_received_at_idx").on(t.receivedAt),
```

| Index | Serves |
| --- | --- |
| `audit_logs (company_id, created_at)` | tenant audit log viewer and its row count, plan history |
| `login_attempts (user_id, created_at)` | a user's sign-in history; active users over long periods |
| `login_attempts (email, created_at) WHERE success = false` | the sign-in lockout check; holds failed sign-ins only |
| `security_events (company_id, created_at)` | tenant Security Center list, policy-block alerts |
| `billing_provider_events (received_at)` | Analytics notification counts (no query orders by this column) |
| BRIN `(created_at)` on the three event tables | Analytics time ranges |

Schema fingerprints, verified locally (the release tooling's own fingerprint query):

| Schema | Fingerprint |
| --- | --- |
| post-`0040` — also exactly what the G-7 branch pushes | `c36a8a2d9c7e502a2ce31ff5f3f412d9` |
| plus the five core indexes | `e3dfa7ef9202164c69f17540ca4dd7f5` |
| plus all eight | `a3cbdc31dc56157def3323e0d6bc479e` |

For both sets the fingerprint is identical whether the indexes are built by the DDL above
or by pushing a schema with the declarations; a push of the declaring schema onto a
DDL-built database reports "No changes detected" and leaves the index objects untouched;
running the DDL a second time skips every statement; dropping the indexes returns the
fingerprint to `c36a8a2d…`.

**Do not give the BRIN indexes a storage option** (such as `autosummarize`). The schema
tool does not recognise it: declared or set by hand, it made every push drop and re-create
the three indexes (reproduced locally).

## 4. Considered and not recommended

| Candidate | Result | Decision |
| --- | --- | --- |
| b-tree `(created_at)` on the three event tables, with the lookup indexes | Analytics as fast as with BRIN; platform-wide newest-first lists 326 → 0.04 ms. But a user with access to two small companies: audit list 125 → **531 ms** (841 ms in an earlier run); five companies' Security Center 0.75 → 7.3 ms; 163 MB; more write cost | **Not recommended** as it stands. Would first need a change to how multi-company lists are queried |
| b-tree `(created_at)` alone, without lookup indexes | small tenant's audit list 106 → **619 ms**; a user's sign-in history 77 → **303 ms**; Security Center 21 → 31–47 ms | **Rejected** |
| `leads (created_at)` | Analytics lead counts 55 → 10 ms, but tenant leads list (first 20) 0.02 → **232 ms** for a small tenant, 1.2 → 5.2 ms for a typical one | **Rejected** |
| `leads (company_id, created_at)` | helps the tenant list, not the platform-wide counts this proposal is about | Out of scope |
| `login_attempts (email, created_at)` over all rows | 169 MB against 17 MB for the failures-only index, for the same lockout query | Rejected |
| partial `audit_logs (created_at) WHERE entity_type = 'subscription'` | 30-day subscription changes 14.7 → 5.4 ms; nothing on a year | Rejected — marginal |
| `users (created_at)` | 7 → 0.5 ms | Rejected — negligible |
| `audit_logs (entity_type, entity_id)` | would serve the platform's "one company's administrative trail" (§6.3) | Not a time index; not analysed |

Why the ordinary timestamp index misbehaves: for "rows of these companies, newest first,
first N" the planner prefers to walk the timestamp index from the newest row and filter,
expecting to find N matches quickly. For tenants with few rows that walk covers the whole
index. A BRIN index cannot be walked in order, so it cannot be chosen for such a query.

A timestamp index of either kind does not protect the lockout check during a burst of
failed sign-ins (today 98 ms; b-tree 119 ms; BRIN 14 ms): it still reads every attempt of
the last minutes. The failures-only index on `(email, created_at)` does (0.01–0.03 ms).

```
-- two small tenants, b-tree timestamp index present               Execution Time: 530.9 ms
Limit
  ->  Index Scan Backward using audit_logs_created_at_idx on audit_logs
        Filter: (company_id = ANY (…))                 -- 78,313 buffers, whole index walked

-- same query, lookup indexes (with or without BRIN)                Execution Time: 0.04 ms
Limit
  ->  Sort
        ->  Bitmap Heap Scan on audit_logs
              ->  Bitmap Index Scan on audit_logs_company_created_idx     -- 14 buffers
```

## 5. Test set-up

PostgreSQL 16.15, local, default settings (`shared_buffers` 128 MB, `work_mem` 4 MB, two
parallel workers), warm cache, schema pushed from this branch. Synthetic rows spread over
three years and stored in time order:

| Table | Rows | Heap |
| --- | ---: | ---: |
| `audit_logs` | 4,000,000 | 441 MB |
| `login_attempts` | 3,000,000 | 295 MB |
| `security_events` | 600,000 | 54 MB |
| `billing_provider_events` | 300,000 | 39 MB |
| `leads` (for the rejected candidate) | 1,500,000 | 132 MB |
| `users` / `companies` | 60,000 / 2,000 | — |

Every query is the one the application sends, run with `EXPLAIN (ANALYZE, BUFFERS)`; the
figure is the median of three runs in milliseconds. Each index configuration was built
inside a transaction and rolled back. The lockout check was sent with bound parameters,
as the application sends it. "Small tenant" is a company with a handful of rows in the
table; "typical tenant" is one of the 2,000 evenly filled companies.

## 6. Query-plan evidence

Columns: today's indexes · the five core indexes · core + BRIN (the recommendation) ·
core + b-tree timestamp (not recommended).

### 6.1 Analytics, the lockout check and the platform-wide screens

| Query | Today | Core | Core + BRIN | Core + b-tree |
| --- | ---: | ---: | ---: | ---: |
| audit events, count (30 days) | 126 | 113 | 20.0 | 18.9 |
| audit events by area (30 days) | 121 | 120 | 20.8 | 18.5 |
| subscription changes (30 days) | 121 | 129 | 13.8 | 12.0 |
| audit daily series (30 days) | 140 | 154 | 54.8 | 69.6 |
| sign-in counts (30 days) | 81.6 | 78.7 | 13.5 | 17.6 |
| active users (30 days) | 141 | 154 | 58.5 | 73.9 |
| sign-in daily series (30 days) | 108 | 117 | 40.8 | 63.3 |
| security events by type (30 days) | 19.6 | 22.5 | 4.06 | 3.97 |
| billing notifications (30 days) | 13.5 | 1.58 | 1.69 | 1.60 |
| audit events, count (365 days) | 153 | 148 | 112 | 73.7 |
| audit events by area (365 days) | 218 | 211 | 165 | 199 |
| subscription changes (365 days) | 126 | 134 | 89.7 | 107 |
| sign-in counts (365 days) | 115 | 115 | 68.6 | 82.2 |
| active users (365 days) | 256 | 156 | 146 | 147 |
| security events by type (365 days) | 33.1 | 31.4 | 27.0 | 23.4 |
| billing notifications (365 days) | 17.1 | 18.8 | 20.1 | 22.6 |
| **sign-in lockout check (every sign-in)** | 85.6 | 0.01 | 0.02 | 0.01 |
| **the same during a burst of 200,000 failed sign-ins in 10 minutes** | 84.1 | 0.03 | 0.02 | 0.03 |
| platform security alerts: failed sign-ins, 24 h | 95.6 | 6.99 | 6.41 | 0.60 |
| platform audit viewer, newest 50 | 326 | 326 | 345 | 0.04 |
| platform audit viewer, subscription rows, newest 50 | 121 | 115 | 115 | 0.53 |
| platform Security Center, newest 100 | 60.5 | 61.0 | 67.0 | 0.06 |

The nine 30-day queries add up to 871 ms today, 890 ms with the core alone, 228 ms with
BRIN and 279 ms with the b-tree. Plans with BRIN: a bitmap scan of the BRIN index followed
by a heap scan of the matching block ranges (audit count, 30 days: 56,446 buffers → 1,665).
Differences of a few milliseconds between columns with the same plan are run-to-run noise.

### 6.2 Tenant-facing lists

| Query | Today | Core | Core + BRIN | Core + b-tree |
| --- | ---: | ---: | ---: | ---: |
| audit log viewer, newest 50 — one small tenant | 104 | 0.03 | 0.01 | 0.01 |
| audit log viewer, newest 50 — one typical tenant | 94.6 | 0.07 | 0.03 | 0.07 |
| audit log viewer, newest 50 — two small tenants | 125 | 0.04 | 0.02 | **531** |
| audit log viewer, newest 50 — small + typical tenant | 113 | 2.84 | 2.88 | 8.84 |
| audit log viewer, newest 50 — five typical tenants | 129 | 7.19 | 9.55 | 3.60 |
| audit log viewer, row count — one / two / five tenants | 96–128 | 0.03–1.28 | 0.01–1.95 | 0.01–2.19 |
| Security Center, newest 100 — one small / one typical tenant | 23.2 / 26.8 | 0.02 / 0.16 | 0.01 / 0.07 | 0.01 / 0.10 |
| Security Center, newest 100 — two small tenants | 25.2 | 0.03 | 0.01 | 0.05 |
| Security Center, newest 100 — five typical tenants | 27.9 | 0.75 | 0.84 | **7.29** |
| security alerts: policy blocks, 24 h — any tenant set | 26–30 | 0.02–0.03 | 0.01–0.03 | 0.01–0.05 |
| security alerts: failed sign-ins of the tenants' users, 24 h | 88–93 | 0.05–0.33 | 0.04–0.30 | 0.33–0.57 |
| plan history, first row — typical / small tenant | 122 / 135 | 1.42 / 0.02 | 1.41 / 0.02 | 2.44 / 0.02 |
| plan history, row count — typical / small tenant | 121 / 122 | 1.46 / 0.02 | 1.43 / 0.02 | 1.58 / 0.02 |
| a user's sign-in history, newest 20 — typical / two sign-ins | 78.0 / 77.0 | 0.02 / 0.01 | 0.02 / 0.01 | 0.02 / 0.01 |

A user with access to more than one company is scoped with `company_id IN (…)`; those are
the "two" and "five" tenant rows.

### 6.3 Measured and left unchanged (no gain, no loss)

| Query | Today | Recommended set | Note |
| --- | ---: | ---: | --- |
| platform audit viewer, newest 50 | 326 | 345 | needs an ordered index on the timestamp, which is not recommended (§4) |
| platform Security Center, newest 100 | 60.5 | 67.0 | same |
| platform: one company's administrative trail, newest 50 | 135 | 140 | its `OR … entity_id = …` branch has no usable index |
| platform audit viewer, filter that matches nothing | 107 | 114 | full scan either way |
| platform audit viewer, text search that matches nothing | 1,252 | — | `ILIKE` over three columns of every row; not an index question (measured in an earlier run, where no index set changed it) |
| leads and users figures in Analytics | 55–75 / 7–10 | unchanged | no index proposed |

These are existing behaviours. They are listed so they are not mistaken for something this
proposal fixes.

Not measured, noted for a separate look: `contacts` and `scans` already carry an ordinary
index on their timestamp alone (`contacts_created_at_idx`, `scans_created_at_idx`). The
effect shown for `leads` in §4 could apply to the tenant contact and capture lists of
small tenants. Those tables were not filled in this test, so this is a question, not a
finding.

## 7. Expected improvements and trade-offs

**Core (five indexes)**

| | Measured |
| --- | --- |
| Gain | lockout check 86 → 0.01 ms, flat during a burst; tenant lists, sign-in history and plan history 75–135 ms → under 8 ms; tenant security alerts 26–93 → under 0.4 ms; platform failed-sign-in alert 96 → 7 ms; active users over a year 256 → 156 ms; billing counts 13.5 → 1.6 ms |
| Disk | ≈ 252 MB for ≈ 830 MB of table data: 120 MB, 90 MB, 17 MB, 18 MB, 6.6 MB. Backups grow accordingly |
| Writes | inserting 100,000 rows (median of five): `audit_logs` 174 → 427 ms, `login_attempts` 197 → 587 ms, `security_events` 180 → 438 ms — about 2 µs → 4–6 µs per row. These tables receive one row per audited action or sign-in |
| Analytics time ranges | unchanged |

**BRIN addition (three indexes)**

| | Measured |
| --- | --- |
| Gain | 30-day Analytics queries 2.4–9× faster; a year 1.1–1.7×. No effect on any tenant list |
| Disk and writes | 88 kB in total; no measurable write cost (432 / 512 / 411 ms against 427 / 587 / 438 ms without) |
| Depends on physical order | A BRIN index stores the lowest and highest timestamp of every 128 table pages. It works while new rows are stored after old ones. With rows of varying size, as in an audit trail, a continuously filled 2,000,000-row test table still read only 1,920–2,466 pages for a 30-day period (ideal ≈ 1,760) |
| Can lose its benefit | When many old pages have free space, new rows are placed there and those page ranges then span years. Reproduced: after a full table rewrite, about 0.5 % of 600,000 new rows landed in old pages; all 441 page ranges widened, and a 30-day period matched 92 % of the table. The summaries never narrow again; only rewriting the table in time order restores them. Likely triggers: enabling the opt-in audit retention purge, a table rewrite, a lasting shift to much smaller rows |
| Failure mode | "no gain", not "slower": the planner costs a BRIN scan from its statistics, and the index cannot be used for ordering |
| Rows added since the last vacuum | Always read, because their page ranges are not summarized yet (autovacuum does it; the storage option that would do it sooner cannot be used, §3). With 600,000 such rows a last-24-hours count took 62 ms, 25 ms once summarized |

**Both**

- Year-long periods gain little: a year is a third of the test data.
- With a few thousand rows every query above is already fast; the indexes then cost little
  and gain little. They are an investment in growth.
- The process-wide read gate keeps bounding how many Analytics queries run at once.

## 8. Safe rollout

Build first, declare second, never the other way round.

1. **After** the `0040` release is applied and verified (§10). Own approval, own
   maintenance note, own rehearsal on a disposable restored copy.
2. Read-only pre-check: table sizes; no invalid index
   (`SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;` returns no row);
   schema fingerprint equals `c36a8a2d9c7e502a2ce31ff5f3f412d9`; no long-running or
   idle-in-transaction session in `pg_stat_activity`; not during the nightly backup.
3. Run the DDL of §3 from a file in `psql`, one statement at a time. No schema push and no
   other DDL on these tables while it runs.
4. After each statement repeat the invalid-index check. It must return no row.
5. `VACUUM (ANALYZE)` the four tables.
6. Deploy the commit whose schema **declares** the indexes. A later schema push then
   reports "No changes detected". Between steps 3 and 6 the migrate one-shot must not run.
7. Post-check: fingerprint `e3dfa7ef…` (core) or `a3cbdc31…` (all eight); compare one
   Analytics request and one sign-in before and after.
8. **Re-pin the fingerprint-pinned tooling.** The deploy verifier and the recovery runner
   pin the schema fingerprint and fail closed on any other value
   (`docs/PLAN_BUILDER_RELEASE_REHEARSAL.md`). They need a reviewed re-pin to the new
   value as part of this change — and back again if the indexes are removed.

A reviewed SQL file (for example `lib/db/migrations/0041_event_table_indexes.sql`) should
accompany that change. Unlike `0040` it must **not** be wrapped in `BEGIN … COMMIT`.

Two orders that must be avoided — both reproduced locally:

- **Declaring first and letting the schema push create the indexes.** `push` issues a
  plain `CREATE INDEX`, which blocks every write to the table for the whole build. On the
  test data inserts into `audit_logs` waited up to 1.6 s through `push`, and 5.4 s behind a
  single plain build. Every audited action and every sign-in writes to these tables.
- **Running the migrate one-shot or any schema push from a checkout that does not declare
  the indexes.** `push` then **drops all of them** without a prompt and exits 0
  ("Changes applied"). The `0040` release states the same rule for its own objects; here
  the loss is performance, not data, but it is silent.

## 9. Locking, failure and rollback

| Situation | Observed locally | Handling |
| --- | --- | --- |
| Concurrent build | 38 inserts completed during one build, slowest 284 ms. Build times at the test volume: 0.2–3.1 s per index, about 11 s for all eight | Use `CONCURRENTLY` only |
| Plain build | A concurrent insert waited 5.4 s, the whole build | Never use a plain `CREATE INDEX` on these tables |
| Another transaction is open | The build waits for it. Meanwhile another session's insert went through in 58 ms, and the index was valid once the build finished. The wait covers every older transaction in the database, a running backup included | Check `pg_stat_activity` first; avoid the backup window |
| While a build waits or runs | It blocks autovacuum and other DDL on that table, not reads or writes. A DDL statement queued behind it (a schema push, an `ALTER TABLE`) would in turn block all access to the table | No other DDL on these tables during the builds |
| Short `lock_timeout` on the build | With `lock_timeout = '2s'` the same wait ended in `ERROR: canceling statement due to lock timeout` and **left an invalid index** | No short time-out for these builds (the DDL sets both to 0) |
| Inside a transaction or a multi-statement string | `ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block`. `DROP INDEX CONCURRENTLY` has the same rule | One statement per call |
| Interrupted or cancelled build | The index remains with `indisvalid = false`; the planner ignores it but every write still maintains it. `CREATE INDEX CONCURRENTLY IF NOT EXISTS` then prints "already exists, skipping" and reports success **without** repairing it | `DROP INDEX CONCURRENTLY IF EXISTS "<name>";` then build again (verified: valid afterwards). The check of step 4 is mandatory |
| Rollback | `DROP INDEX CONCURRENTLY IF EXISTS "<name>";` took 49–125 ms per index and does not block writes; after all of them the fingerprint is `c36a8a2d…` again | Drop the index, deploy a schema that no longer declares it, re-pin the tooling. If the declaring schema is still deployed and the migrate one-shot runs, `push` re-creates the index with a blocking plain build |

Rolling back is safe at any point: the indexes hold no data of their own and no code
depends on them. Each of the eight can be added or removed on its own.

## 10. Compatibility with the approved `0040` release migration

- **No object overlap.** `0040` changes `plans`, `plan_versions`, `subscriptions` and
  `plan_prices`. This proposal touches `audit_logs`, `login_attempts`, `security_events`
  and `billing_provider_events` only.
- **Cannot be merged into `0040`.** `0040` is one transaction with `SET LOCAL` time-outs;
  `CREATE INDEX CONCURRENTLY` cannot run in a transaction, and a plain `CREATE INDEX`
  there would take write-blocking locks on the busiest tables inside the release
  transaction.
- **Must not be applied before `0040`.** The release procedure pins the schema fingerprint
  before (`30c4ecbd867cd2cd59abcb58581ecb04`) and after
  (`c36a8a2d9c7e502a2ce31ff5f3f412d9`). The fingerprint covers index definitions, so an
  index added earlier makes the release's own pre-check fail.
- **G-7 itself changes no schema.** A database pushed from the G-7 branch has the
  post-`0040` fingerprint exactly, so G-7 can follow the release without a schema step,
  with or without these indexes.
- **New pinned values for this change:** `c36a8a2d…` → `e3dfa7ef9202164c69f17540ca4dd7f5`
  (core) or `a3cbdc31dc56157def3323e0d6bc479e` (all eight).

## 11. Owner decisions

1. **Approve the index change as its own batch, after the `0040` release?**
   Recommended: yes.
2. **Core.** Recommended: all five lookup indexes. Each stands alone; a subset is possible.
3. **Analytics time ranges.** Recommended: add the three BRIN indexes — almost free, no
   measured downside, benefit not guaranteed for ever (§7). Alternatives: none (Analytics
   stays at today's speed, bounded by the read gate); or the b-tree timestamp index, only
   after multi-company lists are changed so it cannot slow them (§4).
4. **Leads.** Recommended: no time index.
5. **Form of the change.** Recommended: schema declarations plus a reviewed,
   non-transactional `0041_…sql`; a rehearsal on a disposable restored copy; the
   build-then-declare order and the tooling re-pin of §8.
6. **Timing.** The hosted table sizes were not read. A read-only size check should be the
   first step: with small tables the change is quick and low-risk but brings little today.
7. **Who runs it and when.** A supervised operator session with its own authorization, as
   for the release.

Not part of this proposal and not started: the schema declarations, the `0041` file, any
rehearsal on restored data, and any contact with a hosted database.
