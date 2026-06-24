# End-to-End Verification — Critical Auth & Tenant Flows

**Date:** 2026-06-24
**Scope:** Phase 2.8 (Testing Expansion). Browser-driven E2E verification of the
four critical web-app flows called out for Stage 2, plus the integration/unit gate
suite that runs as the pre-merge gate. **No behavior changes** were made — this is a
test-only phase.

This is a point-in-time record (see [`docs/reports/README.md`](README.md) for what
these reports are). The living gate is the `typecheck` + `test` validation pair,
documented in [`replit.md`](../../replit.md).

## Summary

| Layer | Result |
|---|---|
| Integration + unit suite (`pnpm --filter @workspace/api-server run test`) | **PASS** — 11 files, 124 tests |
| Typecheck (`pnpm --filter @workspace/api-server run typecheck`) | **PASS** |
| E2E — Login + portal routing | **PASS** (UI harness) |
| E2E — Invitation send → accept | **PASS** (UI harness) |
| E2E — Password reset request | **PASS** (UI harness) |
| E2E — Role assignment | **PASS** (UI harness) |
| E2E — MFA login challenge (backup code) | **Covered by integration tests** — UI harness run blocked by harness infrastructure (see below) |

## E2E flows (browser harness)

Each flow was exercised against the live web-app + API at `localhost:80` using the
UI testing harness. Demo / provisioned credentials were used; all provisioned
fixtures were removed afterward (see Cleanup).

1. **Login + portal routing** — Platform owner logs in and lands on `/platform`;
   company admin (employee/admin roles) logs in and lands on `/admin`. Verifies the
   role-based redirect contract.
2. **Invitation send → accept** — Admin sends an "Invite by Email" from
   `/admin/team`; the invitee opens `/accept-invite/:token`, sets name + password,
   and the account is created ("Welcome aboard!"). Verifies the seeded-token →
   account-creation path.
3. **Password reset request** — `/forgot-password` accepts an email and confirms a
   reset link was requested. (Honest flow: no fake reset is performed.)
4. **Role assignment** — Admin opens a team member's "Assign Roles" dialog, toggles
   a custom RBAC role, and saves ("Roles updated"). Verifies `PUT /users/:id/roles`
   end to end.

## MFA login challenge

The MFA enrollment + login-challenge + verification path (TOTP **and** single-use
backup codes, code reuse rejection, and disable) is comprehensively covered by the
**integration suite** (`test/auth-security.test.ts`), which runs against the live
API and is part of the green pre-merge gate.

A browser-level run of the inline `/login` two-factor screen could not be completed:
the UI testing harness became unavailable during this session — even a trivial
"render the login page" probe exhausted the harness iteration budget, and DB
inspection confirmed the harness runs never reached the server (no login attempts
recorded, zero backup codes consumed). This is a harness-infrastructure limitation,
not an application defect; the web MFA screen reuses the same `POST
/api/auth/mfa/verify-login` endpoint that the integration tests verify, and accepts
both TOTP and backup codes in a single field. Re-running the browser MFA flow when
the harness is healthy is tracked as a follow-up.

## Pre-merge gate suite

`pnpm --filter @workspace/api-server run test` against a freshly-restarted api-server
(required — the per-IP login limiter and DB-backed lockout otherwise accumulate
across back-to-back runs):

- **11 files / 124 tests passing**: unit-lib, audit, api-standardization,
  auth-security, contacts-ai, health-errors, jobs, phase24/25,
  repositories-softdelete, services.
- The `jobs` suite intentionally logs dead-letter/`No handler registered` errors
  while exercising the retry path — these are expected test output, not failures.

## Cleanup

All E2E fixtures provisioned for this verification were removed afterward: the
dedicated teammate test user, the accept-invite-created user, the custom "QA Reviewer
E2E" role and its bindings, the seeded + UI-created invitations, MFA enrollment +
backup codes on the test user, and accumulated `login_attempts` noise. Demo accounts
were left in their seeded state.
