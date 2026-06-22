---
name: Dual portal routing
description: Card Scanner Pro has two separate portals gated by JWT role
---

- `platform_owner` → redirected to `/platform` (Platform Owner portal)
- `company_admin` or `team_member` → redirected to `/admin` (Company Admin portal)

JWT payload includes `role` and `companyId`. The `ProtectedRoute` component in `App.tsx` checks `user.role` and cross-redirects if a user lands on the wrong portal.

**Why:** Separation of concerns — platform staff see all tenants; company users see only their own data.

**How to apply:** When adding new routes, decide which portal they belong to and wrap with `<ProtectedRoute role="platform" ...>` or `<ProtectedRoute role="admin" ...>`.

Seeded demo users (platform owner + per-tenant admins) and their login details live in `replit.md` under "Demo credentials" — do not duplicate credentials here.
