---
name: Document version-number concurrency
description: How per-document version numbers stay unique/monotonic under concurrent uploads.
---

# Document version-number concurrency

Appending a new document version computes `max(versionNumber)+1` then inserts. Under
concurrent uploads to the SAME document this races: two writers read the same max and
one collides.

**Rule:** serialize per-document version inserts with a transaction-scoped Postgres
advisory lock (`pg_advisory_xact_lock(namespace, documentId)`) taken at the top of the
insert transaction, and keep the unique index `(document_id, version_number)` as a hard
backstop.

**Why:** a bare retry-on-unique-violation loop retries with NO backoff, so N-way parallel
uploads re-collide on every retry and exhaust attempts → non-201 responses. The advisory
lock makes the max+1/insert/repoint deterministic; different documents still proceed in
parallel; the lock auto-releases on commit/rollback.

**How to apply:** any "append monotonic sequence number scoped to a parent row" path (not
just documents) should prefer a per-parent advisory lock over a retry race. Keep the
unique constraint regardless — it guards alternate write paths and manual SQL. Give each
such feature its OWN advisory-lock namespace constant to avoid accidental cross-feature
serialization.
