---
name: Trusted-proxy IP attribution & testing
description: trust proxy = 1 + last-XFF-entry model; how to simulate client IPs in dev tests and avoid the shared loopback login-limiter bucket
---

**Rule:** The API trusts exactly ONE proxy hop (`app.set("trust proxy", 1)`); the attributed client IP is `req.ip` = the LAST X-Forwarded-For entry (appended by the trusted hop). No manual XFF parsing anywhere — left-most parsing is a spoofing vector (client-forged prefixes would bypass IP allow-lists).

**Why:** In production there is one ingress hop that appends the real client IP. In dev, the shared proxy on :80 appends its view of the client (127.0.0.1), so client-supplied XFF through the preview proxy is correctly ignored.

**How to apply (tests):**
- To simulate arbitrary client IPs, connect DIRECTLY to the api-server's own port (PORT env of the workflow process, e.g. 8080) — the test client then IS the single trusted hop, and the last XFF entry it sets becomes `req.ip`.
- Any test that intentionally fails logins/MFA verifies must attribute a UNIQUE test IP via XFF (TEST-NET addresses), or its failures land in the shared 127.0.0.1 per-IP login-failure limiter bucket (~20 failures/15min) and poison the rest of the full suite. This was the cause of full-run-only failures that pass in isolation.
- The full API suite must run exactly ONCE after restarting the api-server workflow; back-to-back full runs saturate the in-memory limiter and cascade file-level beforeAll failures (fast 3–10ms failures = 429s). DB `login_attempts` lockout rows also persist across restarts — purge recent failures when re-gating.
