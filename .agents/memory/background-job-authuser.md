---
name: Background jobs must rebuild the full AuthUser
description: Async job workers can't reuse req.user; a partial user object breaks tenant-scoped reads.
---

Background job workers (executive report export, and any future DB-queued job that
reads tenant CRM data) run AFTER the originating request has ended, so `req.user`
is gone. Reconstructing a partial `{ id, companyId, role }` object is NOT enough:
the analytics/scope layer reads `user.accessibleCompanies.length` (and role/perms),
so a partial user throws `Cannot read properties of undefined (reading 'length')`
and the job fails.

**Rule:** rebuild a faithful AuthUser inside the worker via
`loadAuthUserById(userId)` (middlewares/requireAuth.ts), then re-check
`worker.companyId === payload.companyId` before doing tenant-scoped work.

**Why:** keeps background reads isolated exactly as they were at request time
(accessibleCompanies / role / effective permissions), instead of over-scoping with
a faked `primary_admin` or under-scoping with an empty accessibleCompanies list.

**How to apply:** never fake a role/user in a worker. Persist only the `userId` in
the job payload and re-hydrate with `loadAuthUserById`. It returns null for
deleted/disabled users — treat that as an authorization failure and fail the job.
