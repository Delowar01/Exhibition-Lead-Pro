# Lead Capture Pro — master completion and release roadmap (status of record, 2026-10-23)

This is the durable, owner-facing roadmap of what is complete, what is deployed, what is hosted-verified and what remains
before the product can be called released. It replaces nothing: batch design records (`B19` … `B25_OBJECT_STORAGE.md`),
the gap register (`B23_FINAL_RECONCILIATION.md`) and the technical brief stay the detailed sources; this page is the
single place where every track carries one explicit state. **Batch numbers B1–B26 are not renumbered.**

**The whole product is NOT complete** until the physical and hosted release criteria in §6 pass. No statement in this
document claims otherwise.

## 1. State vocabulary (every row carries exactly one primary state)
| state | meaning |
|---|---|
| CODE COMPLETE | implemented and validated locally (tests, typecheck, build) on a named commit; not necessarily deployed |
| DEPLOYED | that commit is the running product on the hosted dev stack (`develop` → `deploy-dev-vps`) |
| HOSTED VERIFIED | a hosted read-only or smoke run proved the behaviour on the hosted stack (run ids recorded) |
| PHYSICAL TEST PENDING | needs a physical-device pass (Android) that has not been recorded for the current build |
| OWNER ACTION | blocked on an action only the owner / operator can take (credential, decision, approval) |
| BLOCKED | blocked by a recorded hard stop or a failed gate; the blocker and the next step are named |
| NOT STARTED | no approved batch, no code |

## 2. Completed batches B1–B24
| item | state | evidence / notes |
|---|---|---|
| Batches 1–8 (foundation, multi-tenant CRM, org, analytics, AI platform, Stage 5.9 design system, device verification) | DEPLOYED · HOSTED VERIFIED · device-verified (Honor Magic V5, Android 16 — last recorded device pass) | `PROJECT_TECHNICAL_BRIEF.md` §B; `docs/reports/` |
| B9 Reports & Export Center · B10 Dashboard & Analytics · B11 Lead closure · B12 CRM lifecycle · B13 UX polish · B14 durable PostgreSQL queue · B15 workflow definitions · B16 workflow engine · B17 automation UI · B18 tenant branding · B19 billing audit (docs) · B20 subscription lifecycle + hybrid Stripe · B21 Platform Owner admin panel · B22 production & provider verification | DEPLOYED · HOSTED VERIFIED | `B23_FINAL_RECONCILIATION.md` §1.2–§1.3 (deploy and activation run ids per batch), §2.2 traceability |
| B23 final reconciliation (gap register G-1…G-10, release gates) | DEPLOYED (document) | G-1, G-2, G-5, G-9, G-10 closed in B24; G-6 backups: isolated restore verified, schedule / off-host deferred by owner; G-3 protected-export storage path: covered by B25 first-party downloads, hosted export artifact evidence still owed; G-4 / G-7 / G-8 = owner decisions (§5) |
| B24 release-gate closure | DEPLOYED · HOSTED VERIFIED | activation run 36972460934; API suite green except the storage-gated set |
| B25 Phase 1 local verification totals — recorded in `PROJECT_TECHNICAL_BRIEF.md` §B and `LOCALHOST_DEVELOPMENT.md` §7 for the Phase 1 PRODUCT correction series of 2026-10-02 (the product document's "Correction 7 (2026-10-02) — exact GCS generation strings", `B25_OBJECT_STORAGE.md` §19; a different series from the Stage 2A ops-tooling corrections below) | — | API 1529 passed / 0 failed / 1 skipped (105 files); Playwright 152/152; mobile 142/142; workspace typecheck exit 0; API + web builds PASS. Pre-B25 reference (B24, no object storage): API 1248 passed / 9 storage-gated / 28 skipped of 1285 |
| Mobile release-branch revalidation totals — recorded 2026-10-23 on `claude/mobile-release-blockers` `6a8dad1` (batch 9 local runs; see §4) | — | mobile 271 passed (21 files); API suite 1572 passed / 11 skipped / 0 failed (109 files + 1 skipped); Playwright targeted 3/3, full 154 passed / 1 failed (the documented billing-badge assertion, §5); typecheck + builds PASS |

## 3. B25 — product object storage off Google Cloud (owner decision: remove Google Cloud completely)
Stage vocabulary (maps to the transitional steps of `B25_OBJECT_STORAGE.md` §8): Stage 1 = step 1 (B25 code deployed,
GCS primary, inventory registered) · Stage 2A = step 2 (encrypted filesystem primary + legacy fallback + strict GCS
mirror, proven by a disposable smoke) · Stage 2B = step 3 (copy + verify migration of every legacy object) · Stage 2C =
steps 4–5 (fs-first reads, fallback reads observed at 0, every referenced object proven) · Stage 2D = step 6 (fallback and
mirror disabled) · Stage 2E = step 7 (Google Cloud credentials, driver, dependency and bucket removed).

| stage | state | evidence / blocker / next step |
|---|---|---|
| PRODUCT STORAGE CODE DEPLOYED — B25 Phase 1 (storage contract, encrypted fs driver, `storage_objects` inventory, first-party byte routes, resumable migration command) including the product document's Phase 1 correction series 1–7 of 2026-10-02 (`B25_OBJECT_STORAGE.md` §12–§19; product code, part of `develop` `e559b002`) | DEPLOYED (product `develop` `e559b002`) | `B25_OBJECT_STORAGE.md` §1–§19; the mobile private-file client is rollback-safe |
| STAGE 2A OPS TOOLING / CORRECTIONS — the hosted activation and smoke tooling on `ops/b25-stage2a-fs-activation-tooling` (workflow `b25-stage1-inspection.yml` + three scripts; NOT product code, never deployed with the product): ops Corrections 1–6 (exact residue settlements 1–3, tiered tenant snapshot, mid-smoke guard, protected live-inventory model, company-row attribution) | CODE COMPLETE · HOSTED VERIFIED (read-only inspections; the settlements 1–2 executed) at ops head `1c2c7b1` | ops Correction 7 (same-run smoke branding allowance, form-aware record comparison, always-printed verdicts, exact company-60 residue-4 tooling) is NOT part of `1c2c7b1`: it is implemented in batch 10 for independent review and is never deployed in the product — see §3 Stage 2A and §5 |
| Stage 1 — hosted B25 with GCS primary | HOSTED VERIFIED | Stage 1 smoke and residue settlements recorded in the ops branch history; one deliberately retained exception row (tombstone `f048b5d4-…`, company 53, `LEGACY_RETAINED`, provider object kept at a locked generation) — must stay untouched until Stage 2E review |
| Stage 2A — fs primary + fallback + strict GCS mirror | **BLOCKED** (activated on the host and read-only verified; **NOT CLOSED**) | Hosted runtime proven by read-only inspections (latest 39880540504: fs / fallback true / mirror gcs / legacyDelete false, encryption configured, schema fingerprint stable, protected inventory 8/8, Correction 6 attribution BRANDING_CHANGE_PROVEN, start readiness TRUE). The Correction 6 final disposable smoke (run 39880703889) passed setup and the 62-check product contract but FAILED at the VPS-side verification on a Correction 5 tooling defect (the smoke tenant's own logo key is excluded from the legacy-reference resolution → references 5 / ambiguous 1); the fail-closed cleanup left two explained disposable tombstones (deleted company 60). Next: ops Correction 7 (ops-tooling fix on the ops branch + exact residue-4 settlement tooling + tests — not a product change) → independent review → ONE read-only readiness inspection → ONE smoke → post-switch verify → closure. Customer data untouched; no second smoke was run |
| Stage 2B — migration tooling (preflight / dry-run / guarded copy-verify / postverify over the product's `migrate-storage`) | BLOCKED (design + local contract library complete; branch gate not met) | Gate: Stage 2A closed + mobile deployment + maintenance release. Design: the two-class protected model (FS_NATIVE_MIRRORED / FS_MIGRATED_WITH_RETAINED_LEGACY), six migration states, 23-case test matrix. Hosted migration count = 0 |
| Stage 2C — fs-first reads proven, fallback reads at 0 over an agreed window | NOT STARTED | after Stage 2B postverify READY; includes the decision on rewriting legacy-shaped feature references |
| Stage 2D — disable legacy fallback and GCS mirror | NOT STARTED | last configuration-only rollback point for post-Stage-2A objects; needs a reviewed `retainedLegacyObjects` count |
| Stage 2E — remove Google Cloud (credentials, driver, dependency, deploy check, bucket) | NOT STARTED · OWNER ACTION | needs the owner-held offline recovery copy of the encryption key, a volume + database backup procedure, the retained-exception decision |
| Maintenance window (no-upload) | ACTIVE (operational declaration; the product does not technically enforce it) | released only after Stage 2A closure, mobile deployment and a post-deploy storage regression |

## 4. Mobile release track
| item | state | evidence / next step |
|---|---|---|
| MOBILE-R1 — production AI card-scanning readiness (server-side Gemini only; explicit `AI_NOT_CONFIGURED` handling: localized scan error, pre-scan readiness notice, no bundled secret guard; QR / NFC / manual modes preserved) | CODE COMPLETE (`claude/mobile-release-blockers` `6a8dad1`, ahead 3 / behind 0 of `develop`) · NOT DEPLOYED | Revalidated 2026-10-23: mobile tests + typecheck PASS; API suite 1572 passed / 11 skipped / 0 failed; API + web typecheck and builds PASS; targeted Playwright event-assignment 3/3; full Playwright carries only the pre-existing billing-badge assertion (§5). Deployment is gated on Stage 2A closure (fast-forward of `develop`, normal push) |
| MOBILE-R2 — intentional "No Event" capture, first-scan warning, later single / bulk event assignment (mobile, API `POST /contacts/bulk-assign-event` with tenant-scoped reference checks and `contacts.event_assign` audit, admin web dialog), offline queue safety, account switching | CODE COMPLETE (same head) · NOT DEPLOYED | same evidence; no schema / migration / storage / compose / deploy-workflow change on the branch |
| Mobile APK / EAS build with R1 + R2 | NOT BUILT | built only after the server / web deployment of the same head; never from this track's ops sessions |
| Gemini production configuration (server-side credential for live OCR / AI) | OWNER ACTION | `GEMINI_PRODUCTION_CONFIG_RUNBOOK.md` (on the mobile branch): variable NAMES and the hidden-input procedure only; no key is staged by any automation; without it the hosted scan path answers 503 `AI_NOT_CONFIGURED` by design |
| Android physical acceptance of the R1 / R2 build | PHYSICAL TEST PENDING | last recorded device pass: Batch 8 (Honor Magic V5, Android 16); required before any release claim |

## 5. Platform Owner surface, Plan Builder and outstanding defects
| item | state | notes |
|---|---|---|
| Subscription & Plan Builder (dynamic plans, versions, entitlements, limits, allowances, trials, transitions) | NOT STARTED — requirements READY | `PLAN_BUILDER_REQUIREMENTS.md` (PB-1 … PB-5; the APPROVED baseline = what exists today, every builder detail marked PROPOSED until the owner confirms it, recommended DEFAULTS for the open decisions U1–U7 — none of them owner-approved yet); sequenced after the B25 track; no schema until the data-model approval |
| Platform Owner tenant / subscription / user / audit controls (B21) | DEPLOYED · HOSTED VERIFIED | companies CRUD, administrators with one-time initial password, subscription lifecycle actions, administrative audit view, firewall from tenant CRM data |
| Platform Owner analytics (`/platform/analytics`) | OWNER ACTION (gap G-7) | the page is a "coming soon" placeholder while the dashboard, revenue / scan trends and activity feed are live; decision: wire the existing platform aggregates or remove the route |
| Platform Owner settings (`/platform/settings`) | NOT STARTED | a single "Platform Configuration" card without approved acceptance criteria; candidate scope (with the Plan Builder): provider mode, trial defaults, feature catalog |
| Platform Owner security / support / tenant controls beyond B21 (support access to a tenant, tenant security posture view, suspension workflows) | NOT STARTED | tenant-side Security Center exists (policy, sessions, audit); no platform-side support tooling is approved; must keep the platform-owner firewall (404 cross-tenant, 403 on tenant CRM modules) |
| Outstanding release defect — Playwright `x-billing.spec.ts:182` (tenant Subscription badge) | OPEN (test / label mismatch since B20, not a product regression) | the spec expects the badge text to contain the canonical status token `trialing`; the page renders the label "Trial" (`STATUS_LABEL`); spec and page are byte-identical between `develop` `e559b002` and the mobile head; fix = one line in the spec or the label, in its own small batch; the test is never deleted or weakened in the mobile track |
| Outstanding ops defect — B25 Stage 2A ops Correction 7 (the Correction 5 reference classification of the smoke tenant's own logo key; the record comparison carrying the smoke keys; verdicts swallowed by `set -e`) | OPEN — implementation prepared in batch 10 for independent review (ops branch only; no product change) | see §3 Stage 2A; the exact residue-4 manifest (company 60, run 39880703889) with a read-only eligibility mode and a separately confirmed settlement |
| Owner decisions G-4 (mobile per-entity Workflow / Copilot sections), G-8 (Phase 4 / 6 / 7 / 9 remainders) | OWNER ACTION | recorded in `B23_FINAL_RECONCILIATION.md` §4 |
| External verifications: live Gemini OCR, SMTP delivery, live Stripe | OWNER ACTION | each behind explicit approval; credentials only in the hosted env; never in automation |
| Backups: daily schedule activation and off-host copy (G-6, G-6D) | OWNER ACTION (deferred by owner) | isolated restore rehearsals passed; not a blocker for B25 |
| B26 | NOT STARTED | undefined; nothing is approved beyond the tracks above |

## 6. Release criteria (all required before "released" can be claimed)
1. B25 Stage 2A = CLOSED / PASS (complete smoke + post-switch READY) and the maintenance window released.
2. Mobile R1 / R2 deployed (server + web) with a post-deploy storage regression PASS, then the APK built and a physical
   Android acceptance recorded.
3. Gemini production credential configured by the operator and ONE live OCR verification recorded (opt-in script).
4. B25 Stage 2B migration executed and post-verified; Stage 2C observation complete; Stage 2D / 2E by separate approval.
5. The open Playwright billing-badge defect fixed in its own batch; every suite green except the documented storage-gated set.
6. Plan Builder: delivered per PB-1 … PB-5 or explicitly deferred by the owner (it is a pending core feature today).

## 7. Order of execution (unchanged discipline: one approved batch at a time; hard stops never improvised around)
Correction 7 → Stage 2A closure → `develop` fast-forward to the mobile head (normal push) → deployment + independent
read-only storage regression → maintenance release → Stage 2B branch and tooling (no hosted dispatch until reviewed) →
Stage 2B preflight / dry-run → owner decision on the copy → Stage 2C / 2D / 2E → Plan Builder PB-1 … PB-5 → B26.
