// Batch 23 Correction 1 (G-2) — per-IP failed-login ceiling.
//
// The full integration suite performs dozens of INTENTIONAL failed logins from
// one loopback IP, so a local full run starts the API with a larger
// LOGIN_RATE_MAX (docs/LOCALHOST_DEVELOPMENT.md §3/§7). That setting reaches
// the API process only, and this file keeps the security property itself under
// test in isolation: the documented default is 20, an explicit LOGIN_RATE_MAX
// overrides it, only FAILED credential attempts consume the budget, and the
// request after the ceiling is refused with 429 for every caller from that IP —
// including one that would otherwise authenticate. The limiter instance is
// mounted on a private in-process Express app, so nothing here touches the
// shared dev server or its limiter state.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { config } from "../src/config.js";
import { loginRateLimiter } from "../src/middlewares/rateLimit.js";

const ORIGINAL_LOGIN_RATE_MAX = process.env.LOGIN_RATE_MAX;

async function freshConfig(): Promise<typeof config> {
  vi.resetModules();
  return (await import("../src/config.js")).config;
}

describe("loginRateLimitMax configuration", () => {
  afterAll(async () => {
    if (ORIGINAL_LOGIN_RATE_MAX === undefined) delete process.env.LOGIN_RATE_MAX;
    else process.env.LOGIN_RATE_MAX = ORIGINAL_LOGIN_RATE_MAX;
    vi.resetModules();
  });

  it("defaults to 20 failed credential attempts per window when LOGIN_RATE_MAX is unset (hosted/production value)", async () => {
    delete process.env.LOGIN_RATE_MAX;
    const fresh = await freshConfig();
    expect(fresh.security.loginRateLimitMax).toBe(20);
    // The window is the shared /auth window (15 minutes by default).
    expect(fresh.security.rateLimitWindowMs).toBe(15 * 60 * 1000);
  });

  it("an explicit LOGIN_RATE_MAX in the API process environment overrides the default", async () => {
    process.env.LOGIN_RATE_MAX = "1000";
    const fresh = await freshConfig();
    expect(fresh.security.loginRateLimitMax).toBe(1000);
  });
});

describe("loginRateLimiter — failures-only, per-IP, hard 429 after the ceiling", () => {
  let server: Server;
  let base = "";
  const max = config.security.loginRateLimitMax;

  beforeAll(async () => {
    const app = express();
    // A credential endpoint shaped like /auth/login: 200 when the "credentials"
    // are right, 401 otherwise. Only the limiter under test sits in front of it.
    app.post("/login", loginRateLimiter, (req, res) => {
      if (req.query.ok === "1") res.status(200).json({ ok: true });
      else res.status(401).json({ error: "Invalid credentials" });
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no ephemeral port");
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  async function attempt(ok: boolean) {
    const res = await fetch(`${base}/login${ok ? "?ok=1" : ""}`, { method: "POST" });
    const body = await res.json();
    // skipSuccessfulRequests releases a successful attempt on response finish;
    // yield once so the store is settled before the next request.
    await new Promise((r) => setImmediate(r));
    return { status: res.status, body, remaining: remainingOf(res.headers), limit: limitOf(res.headers), retryAfter: res.headers.get("retry-after") };
  }

  // express-rate-limit standard headers (draft-6 "RateLimit-Limit/-Remaining" or
  // the combined draft-7 "RateLimit: limit=…, remaining=…").
  function limitOf(h: Headers): number | null {
    const direct = h.get("ratelimit-limit");
    if (direct) return Number(direct);
    const m = h.get("ratelimit")?.match(/limit=(\d+)/);
    return m ? Number(m[1]) : null;
  }
  function remainingOf(h: Headers): number | null {
    const direct = h.get("ratelimit-remaining");
    if (direct) return Number(direct);
    const m = h.get("ratelimit")?.match(/remaining=(\d+)/);
    return m ? Number(m[1]) : null;
  }

  it("advertises the configured ceiling, does not charge successful attempts, and refuses everyone from the IP after `max` failures", async () => {
    expect(max, "LOGIN_RATE_MAX belongs to the API process; keep it small in the vitest shell").toBeLessThanOrEqual(5000);

    // Successful attempts are not attacks: two of them up front must leave the
    // whole budget for the failures below. (A success's own response header
    // shows the transient pre-release count; the stored budget is proven by
    // the header of the NEXT failed attempt.)
    const first = await attempt(true);
    expect(first.status).toBe(200);
    expect(first.limit).toBe(max);
    expect((await attempt(true)).status).toBe(200);

    // Exactly `max` failures are allowed; each one burns one unit, and a
    // success in between (while budget remains) never gives anything back or
    // takes anything away — failure #i always reports exactly `max - i` remaining.
    for (let i = 1; i <= max; i++) {
      const failed = await attempt(false);
      expect(failed.status, `failure #${i}`).toBe(401);
      expect(failed.remaining, `remaining after failure #${i}`).toBe(max - i);
      if (i % 5 === 0 && i < max) {
        const ok = await attempt(true);
        expect(ok.status, `success after failure #${i}`).toBe(200);
      }
    }

    // The next failed attempt is refused …
    const blocked = await attempt(false);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "Too many requests. Please slow down and try again shortly." });
    expect(blocked.retryAfter).not.toBeNull();
    // … and so is a request that WOULD have authenticated: the guard is an
    // IP-wide network-level ceiling, not a per-account decision.
    const blockedOk = await attempt(true);
    expect(blockedOk.status).toBe(429);
    expect(blockedOk.body).toEqual({ error: "Too many requests. Please slow down and try again shortly." });
  });
});
