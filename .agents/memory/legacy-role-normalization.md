---
name: Legacy role normalization at auth boundary
description: Why stored DB roles are normalized in requireAuth instead of trusted as-is, and the failure mode that motivated it.
---

# Legacy role normalization at the auth boundary

The server normalizes the stored user role at the auth boundary
(`normalizeRole()` in `requireAuth.ts`, applied to `req.user.role`; also applied
in `auth.ts` login/me/register responses + `signToken`). It maps the pre-Phase-0
names `company_admin -> primary_admin` and `team_member -> employee`.

**Why:** A DB can lag a code-level role rename. Production users were created
before the rename and still store `company_admin` with empty `permissions {}`,
but authorization (`requirePermission` bypass, `requireRole`, `ROLE_RANK`) only
recognizes the canonical names. The mismatch silently 403s every
permission-gated write (POST /scans, PATCH/DELETE /contacts, /users). Because
every non-manual mobile capture method (card/signature OCR, QR, LinkedIn QR,
NFC) funnels its final lead creation through those writes, the whole Lead
Capture Engine appeared broken ("only Manual Entry works") while the cause was
purely authorization, not OCR/native modules.

**How to apply:**
- When prod DB is read-only and can't be migrated, normalize legacy enum/role
  values in code at the single auth boundary so the fix self-heals on republish
  — don't scatter per-route role checks.
- A 403 (not 502) on OCR/scan endpoints points at the permission gate, not the
  AI engine. Check the caller's role/permissions before debugging OCR.
- If you rename a role/enum in code, also migrate existing rows OR add a
  normalization shim; otherwise older environments regress on next deploy.
