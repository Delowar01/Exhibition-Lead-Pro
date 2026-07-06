import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq, like } from "drizzle-orm";
import { db, contactsTable, scansTable, companiesTable, usersTable, loginAttemptsTable } from "@workspace/db";
import {
  validateEmail,
  normalizeEmail,
  validateWebsite,
  normalizeWebsite,
  validatePhone,
  validatePostalCode,
  normalizeCompanyName,
  hasLegalSuffix,
  resolveCountry,
  analyzeCaptureFields,
  websiteFromEmail,
  countryFromDialCode,
} from "../src/lib/capture-validation.js";

// ---------------------------------------------------------------------------
// Pure-function coverage for the deterministic capture-validation seam. No DB,
// no AI — these lock the honest normalization/validation rules the analyze
// endpoint depends on.
// ---------------------------------------------------------------------------

describe("capture-validation — email", () => {
  it("accepts a well-formed address and flags a malformed one", () => {
    expect(validateEmail("john@techcorp.com").status).toBe("valid");
    expect(validateEmail("not-an-email").status).toBe("invalid");
    expect(validateEmail("").status).toBe("empty");
  });

  it("normalizes case + surrounding whitespace without inventing data", () => {
    expect(normalizeEmail("  John@TechCorp.COM ")).toBe("john@techcorp.com");
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe("capture-validation — website", () => {
  it("treats a bare domain as valid and suggests a canonical URL on normalize", () => {
    expect(validateWebsite("techcorp.com").status).toBe("valid");
    expect(normalizeWebsite("techcorp.com/")).toBe("https://techcorp.com");
  });
});

describe("capture-validation — phone", () => {
  it("resolves the dial code + country for an international number", () => {
    const v = validatePhone("+971501234567");
    expect(v.status).toBe("valid");
    expect(v.dialCode).toBe("971");
    expect(v.country).toBe("United Arab Emirates");
    expect(v.e164).toBe("+971501234567");
  });

  it("flags an obviously too-short number", () => {
    expect(validatePhone("123").status).toBe("invalid");
  });
});

describe("capture-validation — postal, company, country", () => {
  it("validates postal codes leniently and normalizes company legal suffixes", () => {
    expect(validatePostalCode("00000", "United Arab Emirates").status).not.toBe("invalid");
    expect(hasLegalSuffix("Acme LLC")).toBe(true);
    expect(hasLegalSuffix("Acme")).toBe(false);
    expect(normalizeCompanyName("  acme   llc ")).toBeTruthy();
  });

  it("resolves a country by name", () => {
    expect(resolveCountry("United Arab Emirates")?.name).toBe("United Arab Emirates");
    expect(resolveCountry("Nowhereistan")).toBeNull();
  });
});

describe("capture-validation — deterministic gap-fill helpers", () => {
  it("derives a website from an email domain (skips free providers)", () => {
    expect(websiteFromEmail("john@techcorp.com")).toBe("https://techcorp.com");
    expect(websiteFromEmail("john@gmail.com")).toBeNull();
  });

  it("derives a country from a phone dial code", () => {
    expect(countryFromDialCode("+971501234567")).toBe("United Arab Emirates");
    expect(countryFromDialCode(null)).toBeNull();
  });
});

describe("capture-validation — analyzeCaptureFields aggregate", () => {
  it("returns per-field validations + normalization suggestions + detected geo", () => {
    const r = analyzeCaptureFields({
      firstName: "John",
      lastName: "Doe",
      company: "TechCorp",
      email: "john@techcorp.com",
      mobile: "+971501234567",
      website: "techcorp.com/",
    });
    expect(Array.isArray(r.validations)).toBe(true);
    expect(r.detectedDialCode).toBe("971");
    const website = r.validations.find((v) => v.field === "website");
    expect(website?.status).toBe("valid");
    // A normalization suggestion for the trailing-slash website should be offered.
    expect(r.suggestions.some((s) => s.field === "website")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration coverage for the read-only analyze + batch endpoints.
// ---------------------------------------------------------------------------

const BASE = "http://localhost:80/api";
const TECHCORP = { email: "admin@techcorp.com", password: "Admin123!" };
const NEXUS = { email: "admin@nexussys.io", password: "Admin123!" };
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };

type Session = { token: string; companyId: number };

async function login(creds: { email: string; password: string }): Promise<Session> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  const body = await res.json();
  return { token: body.token, companyId: body.user.companyId };
}

function authHeaders(s: Session) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${s.token}` };
}

const createdContactIds: number[] = [];

describe("POST /scans/analyze — read-only capture intelligence", () => {
  let tech: Session;
  const uniquePhone = "+9715" + String(Date.now()).slice(-8);

  beforeAll(async () => {
    tech = await login(TECHCORP);
    const [c] = await db
      .insert(contactsTable)
      .values({
        companyId: tech.companyId,
        firstName: "Dupe",
        lastName: "Signal",
        fullName: "Dupe Signal",
        mobile: uniquePhone,
        tags: JSON.stringify([]),
        status: "new",
      })
      .returning();
    createdContactIds.push(c.id);
  });

  afterAll(async () => {
    if (createdContactIds.length) {
      await db.delete(contactsTable).where(inArray(contactsTable.id, createdContactIds));
    }
  });

  it("returns validation + duplicate warning for a matching phone (never merges)", async () => {
    const res = await fetch(`${BASE}/scans/analyze`, {
      method: "POST",
      headers: authHeaders(tech),
      body: JSON.stringify({ fields: { firstName: "Dupe", lastName: "Signal", mobile: uniquePhone }, includeAi: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicateWarning.isLikelyDuplicate).toBe(true);
    expect(body.contactMatches.length).toBeGreaterThan(0);
    expect(body.contactMatches[0].reasons.length).toBeGreaterThan(0);
    // Deterministic-only run: no fabricated AI provenance.
    expect(body.aiDegraded).toBe(false);
  });

  it("offers deterministic gap-fill suggestions with honest provenance", async () => {
    const res = await fetch(`${BASE}/scans/analyze`, {
      method: "POST",
      headers: authHeaders(tech),
      body: JSON.stringify({ fields: { company: "TechCorp", email: "someone@brandnewco.com" }, includeAi: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const websiteSug = body.suggestions.find((s: { field: string }) => s.field === "website");
    expect(websiteSug).toBeTruthy();
    expect(websiteSug.source).toBe("deterministic");
  });

  it("rejects an unauthenticated request", async () => {
    const res = await fetch(`${BASE}/scans/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { email: "x@y.com" } }),
    });
    expect(res.status).toBe(401);
  });

  it("recognition is tenant-scoped — another tenant never sees TechCorp's contact", async () => {
    const nexus = await login(NEXUS);
    expect(nexus.companyId).not.toBe(tech.companyId);
    const res = await fetch(`${BASE}/scans/analyze`, {
      method: "POST",
      headers: authHeaders(nexus),
      body: JSON.stringify({ fields: { firstName: "Dupe", lastName: "Signal", mobile: uniquePhone }, includeAi: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The matching phone lives in TechCorp; Nexus must get an empty, non-leaking result.
    expect(body.contactMatches.length).toBe(0);
    expect(body.duplicateWarning.isLikelyDuplicate).toBe(false);
  });

  it("soft-degrades AI industry classification to HTTP 200 with a boolean aiDegraded flag", async () => {
    const res = await fetch(`${BASE}/scans/analyze`, {
      method: "POST",
      headers: authHeaders(tech),
      body: JSON.stringify({ fields: { company: "TechCorp", email: "someone@techcorp.com" }, includeAi: true }),
    });
    // Whether or not the LLM is reachable, the endpoint never 500s: it either
    // returns an AI suggestion with provenance or degrades honestly.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.aiDegraded).toBe("boolean");
  });
});

describe("POST /scans/batch-analyze — async batch", () => {
  let tech: Session;
  beforeAll(async () => {
    tech = await login(TECHCORP);
  });

  it("enqueues (202) and completes with per-item results", async () => {
    const start = await fetch(`${BASE}/scans/batch-analyze`, {
      method: "POST",
      headers: authHeaders(tech),
      body: JSON.stringify({ items: [{ key: "row1", fields: { email: "lead@acmebatch.com", company: "AcmeBatch" } }] }),
    });
    expect(start.status).toBe(202);
    const job = await start.json();
    expect(job.status).toMatch(/queued|running|completed/);

    let done: { status: string; results: unknown[] } | null = null;
    for (let i = 0; i < 20; i++) {
      const poll = await fetch(`${BASE}/scans/batch/${job.id}`, { headers: authHeaders(tech) });
      expect(poll.status).toBe(200);
      const b = await poll.json();
      if (b.status === "completed" || b.status === "failed") {
        done = b;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(done?.status).toBe("completed");
    expect(done?.results.length).toBe(1);
  });
});

describe("POST /scans/analyze — scans:view permission gating", () => {
  const SUFFIX = Date.now();
  const ORG_DOMAIN = `captureperms-${SUFFIX}.test`;
  const EMPLOYEE_EMAIL = `qa-employee@${ORG_DOMAIN}`;
  const PW = "Admin123!";
  let companyId = 0;
  let employeeToken = "";

  beforeAll(async () => {
    const platform = await login(PLATFORM);
    const createCo = await fetch(`${BASE}/companies`, {
      method: "POST",
      headers: authHeaders(platform),
      body: JSON.stringify({ name: `QA CapturePerms ${SUFFIX}`, plan: "professional" }),
    });
    expect(createCo.status).toBe(201);
    companyId = (await createCo.json()).id;
    await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

    // Employee with empty permissions: scans:view is deny-by-default, so the
    // read-only analyze endpoint must 403 rather than leak tenant recognition.
    const createEmp = await fetch(`${BASE}/users`, {
      method: "POST",
      headers: authHeaders(platform),
      body: JSON.stringify({
        email: EMPLOYEE_EMAIL,
        name: "QA Capture Employee",
        role: "employee",
        companyId,
        password: PW,
        permissions: {},
      }),
    });
    expect(createEmp.status).toBe(201);
    const emp = await login({ email: EMPLOYEE_EMAIL, password: PW });
    employeeToken = emp.token;
  });

  afterAll(async () => {
    await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${ORG_DOMAIN}`));
    await db.delete(usersTable).where(like(usersTable.email, `%@${ORG_DOMAIN}`));
    if (companyId) await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  });

  it("403s an employee without scans:view", async () => {
    const res = await fetch(`${BASE}/scans/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${employeeToken}` },
      body: JSON.stringify({ fields: { email: "x@y.com" }, includeAi: false }),
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /scans/:id — additive JSON metadata is returned parsed, not as raw text", () => {
  let tech: Session;
  let scanId: number;

  beforeAll(async () => {
    tech = await login(TECHCORP);
    const [row] = await db
      .insert(scansTable)
      .values({
        companyId: tech.companyId,
        userId: null,
        status: "completed",
        imageUrl: null,
        extractedData: JSON.stringify({ firstName: "Meta", lastName: "Check" }),
        // These three columns are stored as JSON *strings* but the OpenAPI contract
        // promises objects — every response path (incl. GET /scans/:id) must parse them.
        fieldConfidences: JSON.stringify({ firstName: 90, lastName: 80 }),
        validationStatus: JSON.stringify({ email: "empty" }),
        qualityMeta: JSON.stringify({ blur: 0.1, glare: 0.0 }),
      })
      .returning();
    scanId = row.id;
  });

  afterAll(async () => {
    if (scanId) await db.delete(scansTable).where(eq(scansTable.id, scanId));
  });

  it("parses fieldConfidences/validationStatus/qualityMeta into objects on the single-scan path", async () => {
    const res = await fetch(`${BASE}/scans/${scanId}`, { headers: authHeaders(tech) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.fieldConfidences).toBe("object");
    expect(body.fieldConfidences.firstName).toBe(90);
    expect(typeof body.validationStatus).toBe("object");
    expect(body.validationStatus.email).toBe("empty");
    expect(typeof body.qualityMeta).toBe("object");
    expect(body.qualityMeta.blur).toBe(0.1);
  });
});
