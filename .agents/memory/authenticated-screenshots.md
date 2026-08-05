---
name: Authenticated screenshots
description: How to capture screenshots of auth-gated pages in this app; testing subagent does not export screenshot files.
---

The Playwright testing subagent verifies flows well but returns an empty `screenshotPaths` list — do not rely on it for screenshot deliverables.

**How to apply:** For screenshots of login-gated pages, temporarily add a dev-only effect to the Login page: if `import.meta.env.DEV` and `?demo=<email>&next=<path>` query params are present, auto-submit the demo login using the shared demo password (see the demo credentials table in `replit.md`) and redirect to `next`. Then capture. Remove the effect immediately after capture (before architect review / commit).

**Expo web / mobile artifact:** the built-in screenshot tool does NOT work with the demo-login flow there — it captures and closes the browser before the async login+redirect completes (every shot comes back blank white, and the API never even receives the login POST). Instead, write a throwaway Playwright script that reuses the web-app's Nix-chromium resolution (copy `resolveChromium()` from `artifacts/web-app/playwright.config.ts`, `import { chromium } from "@playwright/test"`, run with `node` from `artifacts/web-app/`). It can wait for real content text, click tabs/modals, scroll to prove sticky behavior, and loop viewports/langs/themes in one run. Demo-hook query params that worked: `?demo=1&next=<path>&lang=en|ar&theme=light|dark` (lang persists server-side — always end with a lang=en run). Delete the script after.

**Why:** The screenshot tool loads pages fresh with no localStorage, and the app keeps its JWT in localStorage (`csp_token`), so there is no other way to reach authenticated pages non-interactively.
