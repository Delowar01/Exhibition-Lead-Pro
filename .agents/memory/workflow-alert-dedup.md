---
name: Workflow alert dedup & deep links
description: Daily-digest notification sweeps — dedup atomicity and notification link correctness
---
- Rule: a "1 notification/user/day" guarantee needs the dedup check + insert serialized — wrap the per-company dispatch in a txn holding `pg_advisory_xact_lock(ns, companyId)`; a bare read-then-insert races between scheduler tick and manual trigger (or multi-instance).
- **Why:** architect review caught duplicates possible under concurrent runs; also caught a dead deep link.
- **How to apply:** any notification/digest sweep with a per-user daily marker. Also: notification `link` values must match the real client route (e.g. `/admin/workflow`, not the module's internal name) — assert the link in the integration test, and make sure the test's select projection includes `link`.
