---
name: Drizzle PATCH empty-set 500
description: Why every PATCH route must guard against an empty updateData before db.update().set().
---

# PATCH routes: guard empty updateData

All update routes build `updateData` by destructuring known fields from the body,
then prune `undefined` keys. If the body is `{}`, contains only unrecognized
fields (e.g. `{"company":...}` when the column is `contactCompany`), or is missing
entirely, `updateData` becomes `{}` and Drizzle's `db.update(table).set({})`
THROWS → the handler 500s.

**Rule:** after the prune step, every PATCH handler must
`if (Object.keys(updateData).length === 0) { res.status(400).json({ error: "No valid fields to update" }); return; }`
and destructure with `req.body ?? {}` (Express 5 leaves `req.body` undefined when
there is no parsed JSON body, so bare destructuring also 500s).

**Why:** bad/empty input must be a 400, never a 500. Found during production smoke
testing across contacts/tasks/meetings/leads/follow_ups/events — all six shared it.

**How to apply:** place the guard AFTER auth/existence/access/refAccessible checks
and BEFORE `db.update`. Any new PATCH route inherits this requirement. The deeper
cause is that write routes lack Zod validation (manual destructuring) — `lib/api-zod`
schemas exist but aren't wired into request validation yet.
