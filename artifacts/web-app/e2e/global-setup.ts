import fs from "node:fs";
import { Client } from "pg";
import {
  ADMIN,
  API_BASE,
  CAPTURE,
  RUN_TAG,
  STATE_DIR,
  STATE_FILE,
  type SeedState,
  type SeededContact,
} from "./fixtures/seed-values";

async function api(pathname: string, token: string, method: string, body?: unknown) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    throw new Error(`${method} ${pathname} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

async function globalSetup() {
  // 1) Log in (reuses real auth; login rate limiter skips successful logins).
  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  if (!loginRes.ok) {
    throw new Error(
      `Login failed (${loginRes.status}). Is the API up and the demo tenant seeded? ${await loginRes.text()}`,
    );
  }
  const auth = await loginRes.json();
  const token: string = auth.token;
  const refreshToken: string | null = auth.refreshToken ?? null;
  const user = auth.user as SeedState["user"];

  // 2) Create the contact (unique email per run to dodge 409 duplicates).
  const firstName = `${RUN_TAG}`;
  const lastName = "Timeline";
  const email = `${RUN_TAG.toLowerCase()}.timeline@example.test`;
  const jobTitle = "QA Fixture Contact";
  const mobile = "+971500009988";
  const contactRes = await api("/contacts", token, "POST", {
    firstName,
    lastName,
    email,
    jobTitle,
    mobile,
  });
  const contactId: number = contactRes.id;

  // 3) Seed timeline events via API — one of each supported channel + a task +
  //    a follow-up. Deterministic subjects carry the run tag so tests can grep.
  const callSubject = `${RUN_TAG} inbound discovery call`;
  const emailSubject = `${RUN_TAG} intro email`;
  const whatsappSubject = `${RUN_TAG} whatsapp ping`;
  const meetingSubject = `${RUN_TAG} kickoff meeting`;
  const taskTitle = `${RUN_TAG} prepare proposal task`;
  const followUpNotes = `${RUN_TAG} follow up on pricing`;

  await api("/contacts/" + contactId + "/communications", token, "POST", {
    channel: "phone",
    subject: callSubject,
    body: "Discussed requirements.",
    occurredAt: "2026-01-10T09:00:00.000Z",
  });
  await api("/contacts/" + contactId + "/communications", token, "POST", {
    channel: "email",
    subject: emailSubject,
    body: "Sent the deck.",
    occurredAt: "2026-01-11T09:00:00.000Z",
  });
  await api("/contacts/" + contactId + "/communications", token, "POST", {
    channel: "whatsapp",
    subject: whatsappSubject,
    body: "Quick nudge.",
    occurredAt: "2026-01-12T09:00:00.000Z",
  });
  await api("/contacts/" + contactId + "/communications", token, "POST", {
    channel: "calendar",
    subject: meetingSubject,
    body: "Kickoff scheduled.",
    occurredAt: "2026-01-13T09:00:00.000Z",
  });

  await api("/tasks", token, "POST", {
    title: taskTitle,
    type: "call",
    contactId,
    dueDate: "2026-03-01",
    notes: `${RUN_TAG} task notes`,
  });
  await api("/follow-ups", token, "POST", {
    contactId,
    scheduledDate: "2026-03-05",
    notes: followUpNotes,
  });

  // 4) Seed the rich capture directly in Postgres (deterministic; avoids the AI
  //    OCR path in POST /api/scans). Values mirror what the Timeline capture
  //    detail renders: source/user/event/GPS/notes/image/AI-summary/OCR.
  let seededScanId: number | null = null;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL is required to seed the capture interaction row.");
  }
  const pg = new Client({ connectionString: dbUrl });
  await pg.connect();
  try {
    const insert = await pg.query(
      `INSERT INTO scans
        (company_id, user_id, contact_id, image_url, status, extracted_data,
         capture_source, extraction_method, latitude, longitude, gps_accuracy,
         notes, ai_summary, created_at)
       VALUES ($1,$2,$3,$4,'completed',$5,$6,'qr',$7,$8,$9,$10,$11, now())
       RETURNING id`,
      [
        user.companyId,
        user.id,
        contactId,
        CAPTURE.imageUrl,
        JSON.stringify(CAPTURE.extractedData),
        CAPTURE.captureSource,
        CAPTURE.latitude,
        CAPTURE.longitude,
        CAPTURE.gpsAccuracy,
        CAPTURE.notes,
        CAPTURE.aiSummary,
      ],
    );
    seededScanId = insert.rows[0]?.id ?? null;
  } finally {
    await pg.end();
  }

  // 5) Read back the interactions endpoint so capture counts reflect BOTH the
  //    auto-created manual capture (from POST /contacts) and our seeded qr row.
  const interactions = await api(`/contacts/${contactId}/interactions`, token, "GET");
  const captureCount: number = interactions?.total ?? interactions?.interactions?.length ?? 1;

  const contact: SeededContact = {
    id: contactId,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    email,
    jobTitle,
    mobile,
    counts: {
      call: 1,
      email: 1,
      whatsapp: 1,
      meeting: 1,
      task: 1,
      follow_up: 1,
      capture: captureCount,
    },
    searchTerms: {
      call: callSubject,
      task: taskTitle,
    },
  };

  const state: SeedState = {
    runTag: RUN_TAG,
    token,
    refreshToken,
    user,
    contact,
    seededScanId,
    capture: CAPTURE,
  };

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");

  // eslint-disable-next-line no-console
  console.log(
    `[e2e] Seeded contact #${contactId} (${contact.fullName}); capture rows=${captureCount}; scan=${seededScanId}; run tag=${RUN_TAG}`,
  );
}

export default globalSetup;
