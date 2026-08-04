---
name: Web e2e (Playwright) setup
description: How the web-app Playwright suite auths, seeds, and runs on this NixOS box
---
- Suite: `pnpm --filter @workspace/web-app run test:e2e` (artifacts/web-app/e2e, chromium only, baseURL http://localhost:80).
- Browser: Playwright's downloaded chromium can't load libs on NixOS; config auto-picks a Nix-store patched chromium via executablePath (override PW_CHROMIUM_PATH). If Nix store paths get GC'd, re-provision.
- Auth: real POST /api/auth/login (admin@techcorp.com), then localStorage csp_token/csp_user/csp_refresh_token/csp_company_id via addInitScript — no bypass. Dark mode: csp_theme.
- Seeding: contact + communications/task/follow-up via API; the ONE deterministic capture row is inserted directly into Postgres (DATABASE_URL) to avoid the AI OCR path; teardown deletes scan + contact.
- **Why:** POST /api/scans has no contactId and generates extractedData via AI — nondeterministic; there is no contact-note endpoint (lead notes only) and no contact-timeline system-event generator, so those chips are asserted to exist rather than seeded.
- Filter-chip tests must assert kind-exclusive content + count parity, not "some event visible" (no-op-test trap flagged by review).

**Toast assertions:** toast text matches TWICE (ToastTitle div + the aria-live `role="status"` announcer) → strict-mode violation that only surfaces in some runs. Always assert toast text with `getByText("...", { exact: true })` (the announcer concatenates "Notification " + title + description, so exact match hits only the title).
