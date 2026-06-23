---
name: Login rate limiter should count failures only
description: Per-IP credential rate limiter must skip successful requests, or it false-positives shared IPs and breaks live integration tests.
---

# The per-IP login rate limiter must `skipSuccessfulRequests`

The network-level credential guard on `/auth/login` (+ `/auth/mfa/verify-login`)
must count only FAILED attempts (HTTP >= 400), via express-rate-limit
`skipSuccessfulRequests: true`.

**Why:** a successful authentication is not an attack. Counting it (a) false-positives
legitimate traffic behind a shared IP / corporate NAT (many real users, one IP), and
(b) breaks the live integration suite — every test logs in against the same localhost
IP, so cumulative *successful* logins blow past the limit and unrelated later suites
get a 429 ("Demo tenant login failed ... 429"). Targeted brute force is already
handled by the per-account lockout (login_attempts table); the IP guard exists for
repeated *failures*.

**How to apply:** keep `skipSuccessfulRequests: true` on the login limiter. When a
live test suite suddenly 429s on login, suspect cumulative successful logins against
one IP, not a real limit breach — restarting the api-server resets the in-memory
counter but the right fix is to not count successes. Lockout tests still work because
failed attempts still count.
