---
name: Analytics top-performer per-user metrics
description: Each per-user metric in the analytics top-performers list must come from its OWN entity query, not a reused sibling count.
---

In the analytics service that assembles `topPerformers`, each per-user column
(`scans`, `leads`, `won`, `pipelineValue`) must be sourced from a query over its
OWN entity, grouped by that entity's owner column:
- `scans` → scans grouped by `scans.userId`
- `leads` → leads grouped by `leads.assignedToId`
- `won` → won-filtered leads grouped by `leads.assignedToId`
- `pipelineValue` → open-pipeline leads grouped by `leads.assignedToId`

**Why:** the per-user "leads" metric was once fed by a CONTACT count
(`contactCountsByUser`) instead of a lead count. It typechecks, the shape is
identical (`{ userId, value }`), tests that only assert "topPerformers is
non-empty" pass — but the metric is silently wrong and can mis-rank performers.
The bug is invisible unless a test seeds DIFFERENT lead vs contact counts per
user and asserts the exact `leads`/`won` values plus the ranking order.

**How to apply:** when adding a new per-user metric to top-performers (or any
"breakdown by user" assembly), add a dedicated grouped query for it; never reuse
another entity's count just because the row shape matches. Cover it with a test
that seeds distinct counts so a mislabel can't pass.
