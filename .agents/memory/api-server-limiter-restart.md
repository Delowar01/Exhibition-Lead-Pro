---
name: Resetting the api-server login limiter for a clean gate run
description: Which workflow to restart (and why aborted test runs count) so the full api-server suite passes on a single run.
---

The full `@workspace/api-server` `test` suite runs sequentially (`fileParallelism: false`) against the LIVE api-server on localhost:80. The per-IP login limiter (`loginRateLimitMax`, default 20 FAILED logins / 15-min window) lives in the running api-server process's memory. As the gate has grown to ~20 test files, a SECOND back-to-back run accumulates failed-login tests past 20 → valid logins start returning 429, which cascades into whole files failing/skipping (dynamic `skipIf`/beforeAll-login guards make the skip count balloon, e.g. 263 skipped).

**Rule:** before the gate run, restart the api-server and run the suite EXACTLY ONCE.

**Why the restart kept "not working":** the workflow that actually runs the api-server is named `artifacts/api-server: API Server` (command `pnpm --filter @workspace/api-server run dev`). The `Project` workflow is NOT the server — it only re-runs the `typecheck` + `test` validation tasks. Restarting `Project` does not reset the limiter (and actually triggers another test run). Use `listWorkflows()` to find the real service workflow name; restart that one.

**How to apply:**
1. `restart_workflow("artifacts/api-server: API Server")`
2. Verify reset: POST a VALID login (use a seeded demo credential from the "Demo credentials" table in `replit.md`) to `localhost:80/api/auth/login` and expect HTTP 200 (not 429). Do not hardcode credentials here.
3. Run `pnpm --filter @workspace/api-server run test` ONCE.

**Trap:** a `pnpm test` invocation that times out / returns "-1 no output" at the tool layer STILL fully executed the suite server-side and consumed the limiter. Treat it as a run — restart before the next attempt, don't just re-run.

**Running the suite:** the suite takes >4 min; bash tool calls cap at 2 min and background/`setsid` processes are killed between calls. Run it via the registered `test` workflow (restart_workflow "test") and poll with refresh_all_logs — never via a foreground/backgrounded bash `pnpm test`.
