---
name: Authenticated screenshots
description: How to capture screenshots of auth-gated pages in this app; testing subagent does not export screenshot files.
---

The Playwright testing subagent verifies flows well but returns an empty `screenshotPaths` list — do not rely on it for screenshot deliverables.

**How to apply:** For screenshots of login-gated pages, temporarily add a dev-only effect to the Login page: if `import.meta.env.DEV` and `?demo=<email>&next=<path>` query params are present, auto-submit the demo login using the shared demo password (see the demo credentials table in `replit.md`) and redirect to `next`. Then use the screenshot tool with `path=/login?demo=<demo-admin-email>&next=/admin/...` at each viewport. Remove the effect immediately after capture (before architect review / commit).

**Why:** The screenshot tool loads pages fresh with no localStorage, and the app keeps its JWT in localStorage (`csp_token`), so there is no other way to reach authenticated pages non-interactively.
