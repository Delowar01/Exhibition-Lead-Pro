---
name: Reports permission policy & the gated-read lockout trap
description: How analytics/reports access is gated per role, and the trap of adding requirePermission to a previously-open read.
---

# Reports / analytics permission policy

Reports endpoints are gated by `requirePermission("reports","view")` (after the
platform-owner tenant firewall). Effective access by role:

- **platform_owner** — blocked entirely (tenant firewall rejects before the permission gate).
- **primary_admin** — always full access (bypasses `requirePermission`).
- **admin** (mid-tier) — keeps `reports:view` **by default**; a primary_admin may revoke it via Role & Permission Management.
- **employee** — **no** reports access by default; must be explicitly granted `reports:view`.

**Why:** governance owner's decision — preserve existing admin/manager workflows (no regression
for the trusted mid-tier) while closing the gap where employees with otherwise-denied
permissions could still read full CRM analytics.

**How to apply:** the role defaults live in the demo seed's `adminPerms`/`empPerms`. The
`reports` module already exists in `PERMISSION_CATALOG`.

# The gated-read lockout trap (general lesson)

Adding `requirePermission(module, action)` to a route/router that was **previously an open
read** silently locks out every non-bypassing role (`admin`, `employee`) that lacks that
exact permission in their stored `permissions` JSON — even though the change "looks" purely
additive. Only `platform_owner`/`primary_admin` bypass.

**How to apply:** before shipping such a gate, audit the LIVE data
(`SELECT role, COUNT(*), COUNT(*) FILTER (WHERE permissions ? '<module>') FROM users ...`)
to see who would lose access, decide the intended baseline per role, and **backfill existing
rows** in addition to updating the seed (the seed only affects fresh installs). The
`permissions` column is `jsonb`, so backfill with
`permissions = permissions || '{"<module>":["<action>"]}'::jsonb`. Production data needs the
same one-time backfill at deploy time — the dev DB backfill does not carry over.

**Concrete mechanism (Stage 5B `ai_copilot`):** the backfill is an idempotent startup
routine (`api-server/src/lib/permission-backfill.ts`) wired into `index.ts` after
`app.listen` (fire-and-forget, logs+continues on failure — never blocks boot). Idempotency
comes from a `NOT jsonb_exists(permissions, '<module>')` guard so it only touches rows
missing the key and never clobbers an explicit primary_admin grant/revoke. Use
`jsonb_exists(col, key)` (not the `?` operator) inside a drizzle `sql\`\`` template to avoid
placeholder ambiguity. This same startup call runs in production on first boot after deploy,
so no separate manual prod migration is needed. Test the upgrade path by stripping the key
off a seeded admin+employee, asserting 403, calling the backfill fn directly, then asserting
access restored per policy (admin default-on incl. generate; employee view ONLY — `use` is a
WRITE (POST /outputs/:id/use), so like `generate` it stays deny-by-default/opt-in, not seeded).
