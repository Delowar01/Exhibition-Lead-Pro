import { describe, it, expect, beforeAll } from "vitest";

// Phase 2.7 — API standardization & versioning. Runs against the LIVE API at localhost:80
// (api-server workflow must be running + demo tenants seeded). Verifies: versioned + legacy
// paths both resolve, the deprecation signal on legacy, the X-Request-Id response header,
// the request-validation envelope (empty/junk write -> 400 with requestId), and the
// list-query contract (page/limit honored, page-size cap enforced).

const ROOT = "http://localhost:80";
const BASE = `${ROOT}/api`;
const V1 = `${ROOT}/api/v1`;

const TECHCORP = { email: "admin@techcorp.com", password: "Admin123!" };

async function login(base: string, creds = TECHCORP): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (await res.json()).token;
}

let token: string;
beforeAll(async () => {
  token = await login(BASE);
});

function auth(t = token) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${t}` };
}

describe("versioning", () => {
  it("resolves the unauthenticated healthz on both legacy and versioned paths", async () => {
    const [legacy, versioned] = await Promise.all([
      fetch(`${BASE}/healthz`),
      fetch(`${V1}/healthz`),
    ]);
    expect(legacy.status).toBe(200);
    expect(versioned.status).toBe(200);
  });

  it("marks the legacy path deprecated and points to the successor version", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.headers.get("deprecation")).toBe("true");
    expect(res.headers.get("link") ?? "").toContain("/api/v1");
  });

  it("does NOT mark the versioned path deprecated", async () => {
    const res = await fetch(`${V1}/healthz`);
    expect(res.headers.get("deprecation")).toBeNull();
  });

  it("serves an authenticated resource via the versioned path", async () => {
    const v1Token = await login(V1);
    const res = await fetch(`${V1}/contacts`, { headers: auth(v1Token) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.contacts)).toBe(true);
  });
});

describe("request-id", () => {
  it("returns an X-Request-Id header on success", async () => {
    const res = await fetch(`${BASE}/contacts`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("includes requestId in the error envelope on a rejected write", async () => {
    const res = await fetch(`${BASE}/contacts`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.requestId).toBeTruthy();
  });
});

describe("request validation (closes H1)", () => {
  it("rejects an empty body on create with 400", async () => {
    const res = await fetch(`${BASE}/contacts`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a junk-only body (no recognized field) with 400", async () => {
    const res = await fetch(`${BASE}/contacts`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ totallyUnknownKey: "x", another: 5 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty body on PATCH with 400", async () => {
    const res = await fetch(`${BASE}/contacts/1`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-object JSON body with 400", async () => {
    const res = await fetch(`${BASE}/contacts`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify([1, 2, 3]),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a well-formed create (validation does not block valid input)", async () => {
    const res = await fetch(`${BASE}/contacts`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ firstName: "Std", lastName: "Check", fullName: "Std Check" }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    // best-effort cleanup so repeated runs don't accumulate rows
    if (created?.id) {
      await fetch(`${BASE}/contacts/${created.id}`, { method: "DELETE", headers: auth() });
    }
  });
});

describe("list-query contract", () => {
  it("honors page + limit and echoes them in the envelope", async () => {
    const res = await fetch(`${BASE}/contacts?page=1&limit=2`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.limit).toBe(2);
    expect(body.contacts.length).toBeLessThanOrEqual(2);
  });

  it("clamps an over-cap limit to the maximum page size", async () => {
    const res = await fetch(`${BASE}/contacts?limit=99999`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(200);
  });

  it("falls back to a sane default for a non-numeric limit", async () => {
    const res = await fetch(`${BASE}/contacts?limit=abc&page=-3`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeGreaterThan(0);
    expect(body.page).toBeGreaterThanOrEqual(1);
  });
});

// The collection endpoints below historically returned the FULL result set (clients
// bucket/filter/sort client-side). Standardizing them must stay backward compatible:
// with no paging params they still return everything (total === rows returned), and
// pagination is opt-in via page/limit.
describe("opt-in list pagination (backward compatible)", () => {
  const cases: Array<{ path: string; key: string }> = [
    { path: "/follow-ups", key: "followUps" },
    { path: "/meetings", key: "meetings" },
    { path: "/tasks", key: "tasks" },
    { path: "/invitations", key: "invitations" },
  ];

  for (const { path, key } of cases) {
    it(`${path} returns the full set by default (total === rows returned)`, async () => {
      const res = await fetch(`${BASE}${path}`, { headers: auth() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body[key])).toBe(true);
      // Unpaginated: total reflects exactly what was returned (no truncation).
      expect(body.total).toBe(body[key].length);
    });

    it(`${path} paginates only when limit is passed`, async () => {
      const res = await fetch(`${BASE}${path}?limit=1`, { headers: auth() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body[key].length).toBeLessThanOrEqual(1);
    });
  }

  it("/notifications defaults to the recent feed and respects limit", async () => {
    const dflt = await fetch(`${BASE}/notifications`, { headers: auth() });
    expect(dflt.status).toBe(200);
    const dbody = await dflt.json();
    expect(Array.isArray(dbody.notifications)).toBe(true);
    expect(dbody.notifications.length).toBeLessThanOrEqual(50);

    const capped = await fetch(`${BASE}/notifications?limit=1`, { headers: auth() });
    const cbody = await capped.json();
    expect(cbody.notifications.length).toBeLessThanOrEqual(1);
  });
});
