---
name: Reschedule lifecycle (follow-ups & meetings)
description: How reschedule works server-side and the UI rule it implies for "upcoming" lists.
---

Rescheduling a follow-up or meeting (PATCH with `status: "rescheduled"`) does NOT
update the row in place. The server, in one transaction:
1. marks the existing row `status: "rescheduled"` (keeps the comment), then
2. inserts a NEW active row (`pending` for follow-ups, `scheduled` for meetings)
   with the new date/time, carrying over notes/assignee/contact.

So a `rescheduled` row is a superseded historical record; the active successor is
a separate new row.

**Rule:** Never include `rescheduled` in an "Upcoming" list — only the active
status (`pending`/`scheduled`). Including it surfaces stale rows as live work and
looks like a duplicate of the successor. Current mobile screens exclude
`rescheduled` from all tabs (Upcoming/Completed/Cancelled).

**Why:** Showing `rescheduled` as upcoming was a real bug — after one reschedule
the same item appeared twice (the rescheduled original + its new successor).

**How to apply:** Applies to `followups.tsx` and `meetings.tsx` tab predicates,
and any future report/list that buckets these by status.
