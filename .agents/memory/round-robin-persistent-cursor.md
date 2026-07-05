---
name: Round-robin assignment needs a persistent cursor
description: Why lead round-robin must use a stored monotonic counter, not count(assigned)%n
---

# Round-robin assignment must use a persistent per-pool cursor

Deriving the round-robin slot from `count(assigned leads in pool) % members.length`
is NOT true round-robin and fails review. Use a dedicated persistent counter row
per pool (`assignment_cursors` keyed by `(companyId, teamId)`, unique index),
read → pick `members[position % n]` → write `position+1`, all inside the pool's
`pg_advisory_xact_lock` transaction.

**Why:** a count-based cursor is not monotonic. It repeats the same owner when
you reassign an already-assigned lead (the assigned-lead count doesn't change),
and it rewinds when a lead is deleted/unassigned (count drops), so consecutive
assignments can land on the same person. The advisory lock only serializes a
flawed derivation — serialization ≠ correct rotation.

**Why not lead_history as the counter:** `lead_history.leadId` is `onDelete:
cascade`, so deleting a lead removes its history rows → the count rewinds. Not
monotonic either.

**How to apply:** any "next in rotation" feature (round-robin owners, etc.) needs
its own append-only/monotonic counter persisted under a per-pool lock. Cover the
invariants in tests: strict rotation across distinct leads, three reassignments
of ONE lead yield three different owners, rotation keeps advancing after a lead
is deleted, per-tenant pools are independent, and concurrent assigns distribute
evenly (advisory lock, no lost increments).
