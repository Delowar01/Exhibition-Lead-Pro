---
name: Soft-delete parity traps (hard→soft conversion)
description: Non-obvious behavior drifts when converting an onDelete hard-delete to a soft-delete (deletedAt) under a "zero observable change" mandate.
---

# Soft-delete parity traps

When converting a table from hard delete to soft-delete (`deletedAt` stamp), two
classes of behavior silently drift even though typecheck + the happy-path suite stay green.

## 1. softDelete MUST replicate the DB onDelete cascade exactly, in one transaction
A hard `DELETE` fired the FK `onDelete` rules. A soft-delete (`UPDATE ... SET deletedAt`)
fires nothing, so you must hand-replicate every child rule:
- `onDelete: cascade` children → `DELETE` them (e.g. contacts→meetings/follow_ups/contact_status_history; leads→lead_history).
- `onDelete: set null` children → `UPDATE ... SET fk = null` (e.g. contacts→leads/tasks/scans contactId; events→contacts/leads eventId).
Verify the cascade map from the schema BEFORE writing softDelete — grep `onDelete` per referenced table.

## 2. Post-precheck UPDATE helpers that relied on "row gone → no-op" now write to dead rows
**Why:** Background/async writers (e.g. deferred AI lead scoring) commonly do a
fire-and-forget `UPDATE ... WHERE id = ? [AND <still-original>]` and TRUST that if
the row was deleted mid-flight the update matches nothing. Under hard delete that
held. Under soft-delete the row still exists, so the update lands on a soft-deleted
row — and any side effect gated on "did the update return a row?" (push notification,
audit, etc.) wrongly fires for a deleted record.
**How to apply:** Every UPDATE helper called AFTER a pre-check / on a background path
must add `isNull(table.deletedAt)` to its WHERE, not just the read paths. Reads were
the obvious half; these write-after-precheck helpers are the half code review catches.

## Parity gate discipline
Keep the existing integration suite assertion-frozen (no edits) as the parity oracle;
add NEW tests for the soft-delete semantics. For inherently racy paths (async scorer),
test the repo helper directly against a row you soft-deleted by hand — deterministic,
no sleeps.
