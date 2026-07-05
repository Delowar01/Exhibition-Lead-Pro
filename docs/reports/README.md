# Reports

Point-in-time QA, release, and pre-build verification reports captured during
development. These are historical records of what was tested and found at a given
date; for the living architecture and developer documentation, see the
[`docs/` index](../README.md).

| Report | Scope |
|---|---|
| [QA Report — Full Regression](QA_REPORT.md) | Full regression of the mobile app (App Lock, currency fix, feature regression); separates automated/code-review results from items pending native on-device verification. |
| [Production Release Checklist](PRODUCTION_RELEASE_CHECKLIST.md) | Final production verification & QA sign-off across the mobile app + API server (functional, data-consistency, security, performance, UX phases). |
| [OCR / QR / NFC Verification](OCR_QR_NFC_VERIFICATION.md) | Pre-build verification of the mobile capture pipeline (OCR, QR, NFC, contact extraction) and the server OCR path. |
| [E2E Verification — Auth & Tenant Flows](E2E_VERIFICATION.md) | Phase 2.8 browser E2E of the four required critical flows (login+**MFA**, invite→accept, password reset, role assignment). Login routing, invite, reset, and role assignment PASS via the harness; the browser **MFA** challenge is blocked by a testing-harness outage (covered at the integration level meanwhile). Includes the green pre-merge gate suite (124 tests). |
| [Stage 2 — Definition of Done](STAGE_2_DEFINITION_OF_DONE.md) | Phase 2.10 Monitoring & Observability sign-off: enriched structured logs, `GET /metrics`, real `GET /readyz` storage probe (closes tech-debt M2), tenant-scoped audit-log viewer (`GET /security/audit`), and security alerts (`GET /security/alerts`). Additive/backward-compatible. |
| [Stage 2 — Phase Report (2.1–2.10)](STAGE_2_PHASE_REPORT.md) | End-to-end record of the full Stage 2 program: what was built and verified in each phase (auth hardening, service/repository refactors, RBAC, email/notifications, background jobs, API standardization, testing, performance, observability), the test-count trajectory (14 → 148), and deferred follow-ups. |
| [Enterprise Privacy Audit](ENTERPRISE_PRIVACY_AUDIT.md) | The enterprise-privacy gap analysis (GAP-01…GAP-07) against the Standard Enterprise SaaS Privacy Model, plus the §8 remediation appendix and AI-protection summary. |
| [Enterprise Privacy Implementation Report](ENTERPRISE_PRIVACY_IMPLEMENTATION_REPORT.md) | Stage 2.11 (A+B) implementation + Stage 2.11C validation/compliance sign-off: completed work, files modified, security improvements, route/guard audit, regression results (228/228), recommendations, and the final **PASS WITH RECOMMENDATIONS** verdict. |
| [Stage 3 — Phase 1 Report (Organizational Foundation)](STAGE_3_PHASE_1_REPORT.md) | Additive org-structure foundation: Departments + Teams modules (CRUD/archive/restore/member assignment), expanded employee org profiles, Employee Directory, and reporting Org Hierarchy. Tenant-isolated, contract-first. Includes the architect-flagged cross-tenant org-FK fix (`refInCompany`). Green gate: 16 files / 250 tests. |
| [Stage 3 — Phase 2 Report (Executive Dashboards & Analytics)](STAGE_3_PHASE_2_REPORT.md) | Additive read-only analytics over existing data + Phase 1 org structure: 5 scoped GET endpoints (company/department/team/employee/scope-options), web Executive Dashboard (`/admin/analytics`), mobile "My Numbers". Scope-private (employee own-only, team-lead/dept-head drill-in), cross-currency-correct, micro-cached. Includes the architect-flagged `topPerformers[].leads` lead-count fix. Green gate: 17 files / 269 tests. |
| [Stage 3 — Phase 3B Report (Enterprise Document Management)](STAGE_3_PHASE_3B_REPORT.md) | Documents attachable to company/contact/lead/event: upload/download/preview/rename/move/soft-delete/restore, immutable versioning (never overwrite), search + filters. Metadata in Postgres, bytes in object storage via signed URLs. `platform_owner` has NO access (tenant firewall); writes permission-gated, reads tenant-scoped. Concurrency-hardened version numbering (unique index + per-document advisory lock). Green gate: 18 files / 306 tests. |

> These reports describe the mobile client and the broader product history. Many
> items they list as "pending native verification" require real-device testing and
> are tracked there, not in the engineering [Technical-Debt Register](../tech-debt.md).
