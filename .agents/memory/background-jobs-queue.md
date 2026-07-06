---
name: Background jobs & queue (Phase 2.6)
description: How async email/notification delivery + recurring maintenance are wired through the in-process job queue, and the non-obvious rules that keep it safe.
---

A provider-agnostic in-process job queue (`lib/jobs/`) moves email/notification
delivery off the request path and runs recurring maintenance. Swappable via
`config.jobs.driver` (single seam — getQueue()); producers never change.

**Worker delivery must distinguish "not configured" from "transport error".**
- `deliverEmailViaWorker` returns a soft skip (`{sent:false, skippedReason:"not_configured"}`)
  when the email provider is unconfigured, but THROWS on a real transport error.
- The handler treats `not_configured` as success (no retry). Only thrown errors retry.
- **Why:** if the worker threw (or never threw) uniformly, an unconfigured env would
  either dead-letter-flood every queued email or never retry a genuinely flaky SMTP.
  This is the load-bearing distinction of the whole async-email design.

**Producer rollback path.** `lib/email` `dispatch()` enqueues when
`config.jobs.asyncEmail` (default true), else calls the synchronous 2.5 `safeSend`.
Enqueue failure degrades to synchronous send. `asyncEmail=false` is the documented
rollback switch. Existing send* callers await but ignore SendResult, so returning
`{sent:true}` optimistically on enqueue is contract-safe.

**Scheduler.** One mechanism (`lib/jobs/scheduler.ts`) runs follow-up reminders +
maintenance; the old standalone follow-up scheduler was folded in (its loop logic is
now `runFollowUpReminders`). All timers are `unref()`d so they never keep the process
alive; each tick is catch-wrapped so a throw only logs.

**Maintenance must be idempotent + time-windowed** (safe under multi-instance):
status transition (pending->expired) or delete-older-than-cutoff. Unread
notifications are always kept. **Audit retention is OPT-IN** (off by default) because
audit_logs is append-only by design — only a positive JOBS_AUDIT_RETENTION_DAYS deletes.

**Caveat:** in-process queue = per-process memory; restart/crash loses queued work and
each instance runs its own queue. Acceptable for transactional email + idempotent
maintenance; swap to a shared broker behind JobQueue when durability is needed.

**AI batch analysis rides the SAME shared queue** (reversed an earlier "self-contained,
NOT the shared queue" design after code review). It enqueues one job per entity
(`AI_ANALYZE_ENTITY_JOB`) with `maxAttempts:1`; the handler updates the batch counters +
finalizes and MUST NOT throw (a per-entity failure is soft-recorded, not dead-lettered) —
otherwise the "unconfigured→retry-flood" hazard above reappears for AI. The in-memory
`jobs` map is polling state only. **Any new queue job type must also be registered in
`lib/jobs/handlers.ts` startWorkers**, or it silently dead-letters ("No handler
registered").
