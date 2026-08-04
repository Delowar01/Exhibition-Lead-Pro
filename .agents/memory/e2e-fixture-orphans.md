---
name: Playwright fixture orphans & long-run execution
description: Aborted e2e runs orphan the seeded contact and 409 the next run; how to run long suites reliably
---

**Symptom:** Playwright global-setup fails with `POST /contacts → 409 existing_contact_found` even though every run uses a fresh run tag. Cause: an aborted previous run never ran global-teardown, and duplicate detection matches on the fixture's CONSTANT mobile number (+971500009988), not the name.

**Cleanup:** soft-delete the orphan (`UPDATE contacts SET deleted_at = now() WHERE mobile = '+971500009988' AND deleted_at IS NULL`), delete seeded scan rows (`image_url = 'e2e/seeded/qr-card.png'`), and `rm artifacts/web-app/e2e/.auth/state.json`. Duplicate detection ignores soft-deleted rows.

**Why runs abort:** background processes spawned from the agent shell (even `setsid nohup ... & disown`) are killed when the shell session ends. For anything longer than ~4 minutes (full API suite ≈ 5–6 min), run it via a configured workflow (e.g. restart the `test` workflow) and poll its logs — never via a backgrounded shell command.

**Locator trap:** the AI workspace has suggested-action buttons like "Generate WhatsApp Message" that substring-match `getByRole("button", { name: "Generate" })` before the copilot's real Generate button — silently driving the assistant instead. Use the data-testids (`select-copilot-type`, `button-copilot-generate`) for copilot controls.
