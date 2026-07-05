---
name: Manual lead-assign clears teamId
description: Why assignment clients must OMIT teamId (not send null) on owner-only manual reassignment
---

Manual lead assignment (`assignLead` / `bulkAssign` manual path) treats an explicit
`teamId` — **including `null`** — as a deliberate SET. Only the manual path does this;
strategy paths fall back to the lead's existing team via `?? existing.teamId`.

**Why:** a bulk/detail "reassign owner" UI whose team picker defaults to empty will
send `teamId: null`, silently wiping every selected lead's team binding even though the
user only meant to change the owner.

**How to apply:** on the client, for the manual strategy send `teamId` ONLY when the
user actually picked a team; otherwise OMIT it (send `undefined`, not `null`):
`teamId: picked != null ? picked : strategy === "manual" ? undefined : null`.
Single-lead detail modals that pre-seed the picker from `lead.teamId` are already safe.
Covered by `test/assignment-roundrobin.test.ts` (manual-preserves-team vs explicit-null).
