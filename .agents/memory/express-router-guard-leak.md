---
name: Express router guard leak
description: Why router-level middleware in the api-server must be path-scoped, not path-less
---

In the api-server, all sub-routers are mounted **path-less** on one shared parent router, and
each route defines its own full path. Consequently a path-less `router.use(mw)` inside a
sub-router runs for EVERY request flowing through the parent — not just that router's own routes.

**Rule:** Any *terminating* router-level guard (a role check, or audit middleware that registers
a response `finish` listener) MUST be path-scoped to the module base, e.g.
`router.use("/contacts", guard)`. Never mount a terminating guard path-less.

**Why:** A path-less role guard on one router 403'd unrelated routes on other routers; a path-less
audit middleware registered one finish-listener per router a request passed through, producing
multiple/mislabeled audit rows for a single write.

**How to apply:** Non-terminating middleware that always calls `next()` (e.g. auth that only
populates `req.user`) is safe path-less. Everything that can end the response must be path-scoped.
