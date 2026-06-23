---
name: Helmet on the cross-origin API
description: Why helmet must disable CORP/COEP/CSP on the api-server, or cross-origin scan images break
---

The api-server uses wide-open `cors()` and serves scan images that the web and
mobile clients load cross-origin via `<img>`/fetch. When adding `helmet`, you
MUST disable the cross-origin isolation headers:

- `crossOriginResourcePolicy: false` — helmet's default `same-origin` CORP sends
  `Cross-Origin-Resource-Policy: same-origin`, which makes browsers refuse to
  render the API's images from a different origin. This is the silent killer.
- `crossOriginEmbedderPolicy: false` — COEP would force CORP/CORS coordination
  the clients don't provide.
- `contentSecurityPolicy: false` — CSP governs HTML documents; this server only
  emits JSON + images, so a default CSP adds risk with zero benefit.

**Why:** the product is intentionally cross-origin (open CORS + image API).
Enabling CORP/COEP is the kind of change that passes typecheck, tests, and the
JSON smoke tests, then breaks image rendering only in a real browser — very hard
to trace back to a security header.

**How to apply:** keep these three disabled whenever touching the helmet config
in `artifacts/api-server/src/app.ts`. The remaining helmet defaults (nosniff,
frameguard, referrer-policy, HSTS, COOP) are body-safe and reject no requests.
Verify with `curl -D -` that no `Cross-Origin-Resource-Policy` header appears on
an image/health response.
