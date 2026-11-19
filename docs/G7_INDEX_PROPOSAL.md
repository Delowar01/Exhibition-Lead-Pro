# G-7 — Index proposal for the audit, sign-in, security-event and billing-event tables

Status: **PROPOSAL — not approved, not applied.** This document is the only artifact. No
index is declared in the Drizzle schema, no SQL file was added under `lib/db/migrations/`,
and nothing here is part of the release candidate (`d1e884b…`) or of the G-7 code. The
G-7 Analytics module works without these indexes.

All measurements were taken on a disposable local PostgreSQL database filled with
synthetic rows. No hosted database was contacted, so **the row counts of the hosted
tables are not known** (§11, decision 5).

## 1. Summary

- Four tables are read by time, by company or by user and have no index for it:
  `audit_logs`, `login_attempts`, `security_events` (primary key only) and
  `billing_provider_events` (no index on `received_at`).
- **Recommended: five lookup indexes.** At the tested volume they take the sign-in lockout
  check, which runs on every sign-in, from 86 ms to 0.01 ms (also during a burst of failed
  sign-ins); the tenant audit log viewer, a user's sign-in history and plan history from
  77–135 ms to under 8 ms; the tenant Security Center from 23–28 ms to under 1 ms. No
  query moved to a slower plan, with one small exception (billing counts over a full
  year, 17 → 19 ms).
- **A time-range index for the Analytics queries is not recommended now.** Both kinds
  were measured (§4). An ordinary b-tree on the timestamp makes the audit list of a user
  with access to two small companies 4–8 times slower than today. A BRIN index avoids
  that and costs almost nothing, but its gain depends on how the table is physically
  filled, and once that order is lost it makes the Analytics queries 1.5–1.8 times
  **slower** than today. Without either, Analytics keeps today's speed, bounded by the
  read gate.
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

CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_company_created_idx" ON "audit_logs" USING btree ("company_id", "created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "login_attempts_user_created_idx" ON "login_attempts" USING btree ("user_id", "created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "login_attempts_failed_email_idx" ON "login_attempts" USING btree ("email", "created_at") WHERE success = false;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "security_events_company_created_idx" ON "security_events" USING btree ("company_id", "created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "billing_provider_events_received_at_idx" ON "billing_provider_events" USING btree ("received_at");
```

The matching schema declarations (for the same future change, not now):

```ts
// audit_logs
index("audit_logs_company_created_idx").on(t.companyId, t.createdAt),
// login_attempts
index("login_attempts_user_created_idx").on(t.userId, t.createdAt),
index("login_attempts_failed_email_idx").on(t.email, t.createdAt).where(sql`success = false`),
// security_events
index("security_events_company_created_idx").on(t.companyId, t.createdAt),
// billing_provider_events
index("billing_provider_events_received_at_idx").on(t.receivedAt),
```

| Index | Serves |
| --- | --- |
| `audit_logs (company_id, created_at)` | tenant audit log viewer, plan history |
| `login_attempts (user_id, created_at)` | a user's sign-in history; active users over long periods |
| `login_attempts (email, created_at) WHERE success = false` | the sign-in lockout check; holds failed sign-ins only |
| `security_events (company_id, created_at)` | tenant Security Center list, policy-block alerts |
| `billing_provider_events (received_at)` | Analytics notification counts (no query orders by this column) |

Schema fingerprints, verified locally (the release tooling's own fingerprint query):

| Schema | Fingerprint |
| --- | --- |
| post-`0040` — also exactly what the G-7 branch pushes | `c36a8a2d9c7e502a2ce31ff5f3f412d9` |
| plus the five recommended indexes | `e3dfa7ef9202164c69f17540ca4dd7f5` |

The fingerprint is identical whether the indexes are built by the DDL above or by pushing
a schema with the declarations; a push of the declaring schema onto a DDL-built database
reports "No changes detected" and leaves the index objects untouched; running the DDL a
second time skips every statement; dropping the indexes returns the fingerprint to
`c36a8a2d…`. A subset of the five has its own fingerprint, to be computed in the
rehearsal.

## 4. A time-range index for the Analytics queries — measured, not recommended now

The Analytics module reads these tables by time range. Two kinds of index serve that.

| | BRIN `(created_at)` on the three event tables | b-tree `(created_at)` on the three event tables |
| --- | --- | --- |
| 30-day Analytics queries (§6.1) | 2.4–9× faster while the table is in time order and summarized | 1.7–10× faster |
| Platform-wide newest-first lists | unchanged (326 ms, 61 ms) | 326 → 0.04 ms, 61 → 0.06 ms |
| Size / write cost | 88 kB in total / none measurable | 163 MB / up to a third more per insert |
| Tenant lists | cannot affect them: a BRIN index cannot be read in order | a user with access to two small companies: audit list 125 → **531 ms** (841 ms in another run); five companies' Security Center 0.75 → 7.3 ms |
| When it goes wrong | **slower than today** (see below) | slower tenant lists, growing with the table |

**Why the b-tree misbehaves.** For "rows of these companies, newest first, first N" the
planner prefers to walk the timestamp index from the newest row and filter, expecting to
find N matches quickly. For tenants with few rows that walk covers the whole index:

```
-- two small tenants, b-tree timestamp index present               Execution Time: 530.9 ms
Limit
  ->  Index Scan Backward using audit_logs_created_at_idx on audit_logs
        Filter: (company_id = ANY (…))                 -- 78,313 buffers, whole index walked

-- same query, the five recommended indexes only                    Execution Time: 0.04 ms
Limit
  ->  Sort
        ->  Bitmap Heap Scan on audit_logs
              ->  Bitmap Index Scan on audit_logs_company_created_idx     -- 14 buffers
```

Without the lookup indexes the b-tree is worse still: a small tenant's audit list
106 → 619 ms, a user's sign-in history 77 → 303 ms.

**Why BRIN is fragile.** A BRIN index stores the lowest and highest timestamp of every
128 table pages. It helps only while new rows are stored after old ones.

| State of the table and index | audit count, 30 days | audit by area, 30 days | sign-in counts, 30 days |
| --- | ---: | ---: | ---: |
| no time index (today's plan), same data | 150–168 | 190–201 | 114–122 |
| BRIN, table in time order, all page ranges summarized | 49 | 75 | 37 |
| BRIN, table in time order, 600,000 new rows not yet summarized | 82 | 90 | 46 |
| BRIN, new rows scattered into old pages | **252–273** | **276–284** | **193–202** |

- *Not yet summarized*: page ranges added since the last vacuum are always read. On an
  insert-only table autovacuum starts after 1,000 rows plus 20 % of the table, so the
  unsummarized part can be larger than a 30-day period. `brin_summarize_new_values()`
  does the same on demand and changes no schema. The storage option that would do it
  automatically cannot be used: declared or set by hand, it made every schema push drop
  and re-create the index (reproduced locally).
- *Scattered*: when old pages have free space, new rows are placed there and those page
  ranges then span years. Reproduced: after a full table rewrite, about 0.5 % of 600,000
  new rows landed in old pages, all 441 page ranges widened, and every 30-day query read
  the whole table through the index — slower than a plain scan. The planner keeps
  choosing the index because the column's order statistic stays at 1.0. Likely triggers:
  enabling the opt-in audit retention purge, a table rewrite, a lasting shift to smaller
  rows. After a purge, `REINDEX INDEX CONCURRENTLY` rebuilds the summaries; while old and
  new rows share pages, only rewriting the table in time order does.
- In steady state the effect is small: a continuously filled 2,000,000-row test table with
  rows of varying size read 1,920–2,466 pages for a 30-day period (ideal ≈ 1,760).

If faster Analytics becomes a need, the BRIN index is the lower-risk of the two — it can
only affect the Analytics queries and is dropped in milliseconds — provided someone
watches it; the b-tree needs a change to how multi-company lists are queried first.

A timestamp index of either kind does not protect the lockout check during a burst of
failed sign-ins (today 98 ms; b-tree 119 ms; BRIN 14 ms): it still reads every attempt of
the last minutes. The failures-only index of §3 does (0.03 ms).

### Other candidates

| Candidate | Result | Decision |
| --- | --- | --- |
| `leads (created_at)` | Analytics lead counts 55 → 10 ms, but tenant leads list (first 20) 0.02 → **232 ms** for a small tenant, 1.2 → 5.2 ms for a typical one | **Rejected** |
| `leads (company_id, created_at)` | helps the tenant list, not the platform-wide counts this proposal is about | Out of scope |
| `login_attempts (email, created_at)` over all rows | 169 MB against 17 MB for the failures-only index, for the same lockout query | Rejected |
| partial `audit_logs (created_at) WHERE entity_type = 'subscription'` | 30-day subscription changes 14.7 → 5.4 ms; nothing on a year | Rejected — marginal |
| `users (created_at)` | 7 → 0.5 ms | Rejected — negligible |
| `audit_logs (entity_type, entity_id)` | would serve the platform's "one company's administrative trail" (§6.4) | Not a time index; not analysed |

## 5. Test set-up

PostgreSQL 16.15, local, default settings (`shared_buffers` 128 MB, `work_mem` 4 MB, two
parallel workers), schema pushed from this branch. Synthetic rows spread over three years
and stored in time order:

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
inside a transaction and rolled back. "Small tenant" is a company with a handful of rows
in the table; "typical tenant" is one of the 2,000 evenly filled companies; §6.3 adds a
tenant that holds a third of all rows.

Each table below is one run. The same query's "today" figure differs by some
milliseconds between runs, and by more when large inserts have just pushed the tables out
of the cache — compare within a row, not across tables.

## 6. Query-plan evidence

Columns of §6.1 and §6.2: today's indexes · the five recommended indexes · those plus BRIN
· those plus a b-tree on the timestamp (the two options of §4).

### 6.1 Analytics, the lockout check and the platform-wide screens

| Query | Today | Recommended | + BRIN | + b-tree |
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
| **the same during a burst of failed sign-ins** | 84.1 | 0.03 | 0.02 | 0.03 |
| platform security alerts: failed sign-ins, 24 h | 95.6 | 6.99 | 6.41 | 0.60 |
| platform audit viewer, newest 50 | 326 | 326 | 345 | 0.04 |
| platform audit viewer, subscription rows, newest 50 | 121 | 115 | 115 | 0.53 |
| platform Security Center, newest 100 | 60.5 | 61.0 | 67.0 | 0.06 |

With the recommended indexes the time-range queries on the three event tables keep
today's sequential plan; their figures in the first two columns differ only by run-to-run
variation (the nine 30-day queries add up to 871 ms and 890 ms). Billing counts use the
new index: much faster for 30 days, slightly slower for a full year, where a third of the
table is read through the index. The BRIN figures are for a freshly built index on a
table in time order (§4).

The lockout check was sent with bound parameters, as the application sends it. The burst
is 200,000 failed sign-ins in 10 minutes spread over 60,000 e-mail addresses; a flood on
a single address still reads all of that address's failures in the window. The
failures-only index is used because the driver sends unnamed statements, which are
planned with their values; under a forced generic plan (`plan_cache_mode`) it could not
be used and the check would fall back to today's plan.

### 6.2 Tenant-facing lists

| Query | Today | Recommended | + BRIN | + b-tree |
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

### 6.3 A tenant that holds a third of all rows

One company was given every third audit and security row (1.3 million and 200,000).

| Query for that tenant | Today | Recommended | Plan with the recommended indexes |
| --- | ---: | ---: | --- |
| audit log viewer, newest 50 | 183 | 0.03 | index, in order |
| audit log viewer, filter on subscription rows (1.5 %), newest 50 | 140 | 0.64 | index, in order |
| audit log viewer, filter that matches nothing, newest 50 | 152 | 148 | sequential, as today |
| audit log viewer, text search that matches nothing | 520 | 574 | sequential, as today |
| audit log viewer, row count | 157 | 183 | sequential, as today |
| audit log viewer, newest 50 — this tenant and a small one | 189 | 211 | sequential, as today |
| plan history, first row | 163 | 0.32 | index, in order |
| plan history, newest 20 | 155 | 33.4 | index, in order |
| plan history, row count | 173 | 169 | sequential, as today |
| Security Center, newest 100 | 48.7 | 0.03 | index, in order |
| security alerts: policy blocks, 24 h | 39.9 | 0.05 | index |

Where the index would not help, the planner keeps today's plan; the differences in those
rows are run-to-run variation on an identical plan.

### 6.4 Measured and left unchanged by the recommendation

| Query | Today | Recommended | Note |
| --- | ---: | ---: | --- |
| Analytics time ranges on the three event tables | 20–141 (30 days) | unchanged | would need a time-range index (§4) |
| platform audit viewer, newest 50 | 326 | 326 | would need an ordered index on the timestamp (§4) |
| platform Security Center, newest 100 | 60.5 | 61.0 | same |
| platform: one company's administrative trail, newest 50 | 135 | 128 | its `OR … entity_id = …` branch has no usable index |
| platform audit viewer, filter that matches nothing | 107 | 116 | full scan either way |
| platform audit viewer, text search that matches nothing | 1,252 | — | `ILIKE` over three columns of every row; not an index question (an earlier run, where no index set changed it) |
| leads and users figures in Analytics | 55–75 / 7–10 | unchanged | no index proposed |

These are existing behaviours. They are listed so they are not mistaken for something this
proposal fixes.

Not measured, noted for a separate look: `contacts` and `scans` already carry an ordinary
index on their timestamp alone (`contacts_created_at_idx`, `scans_created_at_idx`). The
effect shown for `leads` in §4 could apply to the tenant contact and capture lists of
small tenants. Those tables were not filled in this test, so this is a question, not a
finding.

## 7. Expected improvements and trade-offs

| | Measured for the five recommended indexes |
| --- | --- |
| Gain | lockout check 86 → 0.01 ms, flat during a burst; tenant audit log viewer, sign-in history and plan history 77–135 ms → under 8 ms; tenant Security Center 23–28 ms → under 1 ms; tenant security alerts 26–93 ms → under 0.4 ms; platform failed-sign-in alert 96 → 7 ms; active users over a year 256 → 156 ms; billing counts for 30 days 13.5 → 1.6 ms |
| Small loss | billing counts for a full year 17.1 → 18.8 ms |
| Disk | ≈ 252 MB for ≈ 830 MB of table data: 120 MB, 90 MB, 17 MB, 18 MB, 6.6 MB. Backups grow accordingly |
| Writes | inserting 100,000 rows (median of five): `audit_logs` 174 → 427 ms, `login_attempts` 197 → 587 ms, `security_events` 180 → 438 ms — about 2 µs → 4–6 µs per row. These tables receive one row per audited action or sign-in |
| Analytics time ranges, platform-wide newest-first lists | unchanged |

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
   idle-in-transaction session in `pg_stat_activity`; not during the nightly backup; the
   backup and recovery gates of the release procedure are satisfied, because the pinned
   tooling cannot run again until step 6.
3. Run the DDL of §3 from a file in `psql`, one statement at a time. No schema push and no
   other DDL on these tables while it runs.
4. After each statement repeat the invalid-index check. It must return no row.
5. `VACUUM (ANALYZE)` the four tables; confirm the fingerprint is
   `e3dfa7ef9202164c69f17540ca4dd7f5`.
6. **Re-pin the fingerprint-pinned tooling by a reviewed ops change** (or an explicit,
   recorded waiver). The deploy verifier, the recovery runner and the Stage 2B tooling pin
   the schema fingerprint and fail closed on any other value
   (`docs/PLAN_BUILDER_RELEASE_REHEARSAL.md`). From step 3 until this re-pin none of them
   can run. The deploy verifier must be re-pinned before the deploy of step 7.
7. Deploy the commit whose schema **declares** the indexes. A later schema push then
   reports "No changes detected". Between steps 3 and 7 the migrate one-shot must not run.
8. Post-check: fingerprint unchanged; compare one sign-in and one tenant audit list
   before and after.

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
| Concurrent build | 38 inserts completed during one build, slowest 284 ms. Build times at the test volume: 0.2–3.1 s per index, about 7 s for the five | Use `CONCURRENTLY` only |
| Plain build | A concurrent insert waited 5.4 s, the whole build | Never use a plain `CREATE INDEX` on these tables |
| Another transaction is open | The build waits for it. Meanwhile another session's insert went through in 58 ms, and the index was valid once the build finished. The wait covers every older transaction in the database, a running backup included | Check `pg_stat_activity` first; avoid the backup window |
| While a build waits or runs | It blocks autovacuum and other DDL on that table, not reads or writes. A DDL statement queued behind it (a schema push, an `ALTER TABLE`) would in turn block all access to the table | No other DDL on these tables during the builds |
| Short `lock_timeout` on the build | With `lock_timeout = '2s'` the same wait ended in `ERROR: canceling statement due to lock timeout` and **left an invalid index** | No short time-out for these builds (the DDL sets both to 0) |
| Inside a transaction or a multi-statement string | `ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block`. `DROP INDEX CONCURRENTLY` has the same rule | One statement per call |
| Interrupted or cancelled build | The index remains with `indisvalid = false`; the planner ignores it but every write still maintains it. `CREATE INDEX CONCURRENTLY IF NOT EXISTS` then prints "already exists, skipping" and reports success **without** repairing it | `DROP INDEX CONCURRENTLY IF EXISTS "<name>";` then build again (verified: valid afterwards). The check of step 4 is mandatory |
| Rollback | `DROP INDEX CONCURRENTLY IF EXISTS "<name>";` took 49–125 ms per index and does not block writes; after all of them the fingerprint is `c36a8a2d…` again | Drop the index, deploy a schema that no longer declares it, re-pin the tooling back. If the declaring schema is still deployed and the migrate one-shot runs, `push` re-creates the index with a blocking plain build |

Rolling back is safe at any point: the indexes hold no data of their own and no code
depends on them. Each of the five can be added or removed on its own.

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
- **New pinned value for this change:** `c36a8a2d…` → `e3dfa7ef9202164c69f17540ca4dd7f5`.

## 11. Owner decisions

1. **Approve the index change as its own batch, after the `0040` release?**
   Recommended: yes.
2. **Scope.** Recommended: all five lookup indexes. Each stands alone; a subset is
   possible.
3. **A time-range index for Analytics.** Recommended: none for now (§4). To be revisited
   when Analytics latency on real data becomes a concern — then BRIN with someone watching
   it, or a b-tree after multi-company lists have been changed.
4. **Form of the change.** Recommended: schema declarations plus a reviewed,
   non-transactional `0041_…sql`; a rehearsal on a disposable restored copy; the
   build-then-declare order and the tooling re-pin of §8.
5. **Timing.** The hosted table sizes were not read. A read-only size check should be the
   first step: with small tables the change is quick and low-risk but brings little today.
6. **Who runs it and when.** A supervised operator session with its own authorization, as
   for the release.

Not part of this proposal and not started: the schema declarations, the `0041` file, any
rehearsal on restored data, and any contact with a hosted database.
