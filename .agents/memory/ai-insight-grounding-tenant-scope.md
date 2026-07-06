---
name: AI insight grounding & tenant-scoped FK dereferences
description: How AI insights (incl. relationship_intelligence + batch) stay grounded in real CRM rows, and why read-path FK name lookups must be companyId-scoped.
---

# AI insight grounding & tenant-scoped FK dereferences

AI insight generation must derive everything from real CRM rows — no fabricated/mocked
data. `relationship_intelligence` (contact↔lead↔organization links) is computed
deterministically from existing FKs, so its confidence is a fixed 100 (it is a fact
lookup, not a model guess). Batch processing is an in-process, tenant-scoped runner
(Map-backed job store) that fans the SAME single-entity analyzer over many ids; it must
404 on any cross-tenant entity id, never leak existence.

## Rule: FK dereferences in insight context builders must be companyId-scoped

When an insight builder resolves an FK to a human-readable name (e.g. `eventId → event
name`, linked `contactId → contact name`, `organizationId → org name`), scope that lookup
by `companyId`, not by id alone.

**Why:** The codebase invariant is "never read a tenant row by id alone" — a bare
`where id = ?` is an unfiltered cross-tenant read. Even though the WRITE path already
validates FK ownership with `refInCompany`, a read-path name lookup by id alone is a
second, independent leak surface: it can surface a foreign tenant's event/contact/org
name inside an insight payload. Architect flagged exactly this as BLOCKING.

**How to apply:** Thread `companyId` into every name-resolution helper used by AI insight
context builders (relationships service + insights service), so each FK name lookup
filters by tenant. Treat it as defense-in-depth that must hold regardless of the
write-path guard. The entity loaders that fetch by id then apply `canAccessCompany` did
not re-open this payload leak, but converting them to tenant-filtered predicates is a
worthwhile future hardening pass for strict invariant compliance.

## Related

- `fk-caller-vs-tenant-scope.md` — write-path FK ownership (`refInCompany` vs caller-scoped
  `refAccessible`). This file is the READ-path counterpart.
