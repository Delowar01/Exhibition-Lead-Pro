import { describe, it, expect } from "vitest";

const BASE = "http://localhost:80/api";

describe("health endpoints", () => {
  it("GET /healthz returns liveness status unchanged", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("GET /readyz reports readiness with dependency checks", async () => {
    const res = await fetch(`${BASE}/readyz`);
    expect([200, 503]).toContain(res.status);
    const body = await res.json();
    expect(typeof body.status).toBe("string");
    expect(typeof body.checks?.database).toBe("string");
    expect(typeof body.checks?.storage).toBe("string");
  });
});

describe("global error handling preserves framework status codes", () => {
  it("oversized JSON body returns 413, not 500", async () => {
    const huge = "a".repeat(16 * 1024 * 1024);
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: huge, password: "x" }),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("malformed JSON body returns 400, not 500", async () => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not valid json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });
});
