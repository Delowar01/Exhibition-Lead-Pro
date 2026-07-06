/**
 * Demo data seed for Card Scanner Pro.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed-demo
 *
 * Idempotent — wipes any existing demo companies then re-creates everything.
 * Password for all demo users: Demo123!
 */

import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import {
  companiesTable,
  contactsTable,
  db,
  eventsTable,
  followUpsTable,
  meetingsTable,
  subscriptionsTable,
  tasksTable,
  usersTable,
} from "@workspace/db";

// ─────────────────────────────────────────────────────────────────────────────
// DATA POOLS
// ─────────────────────────────────────────────────────────────────────────────

const FIRST = [
  "James","Mohammed","Emma","Fatima","Oliver","Ahmed","Sophia","Aisha",
  "William","Omar","Charlotte","Maryam","Liam","Ali","Ava","Nour",
  "Noah","Khalid","Isabella","Sara","Lucas","Abdullah","Amelia","Layla",
  "Mason","Hassan","Harper","Reem","Ethan","Youssef","Evelyn","Dana",
  "Logan","Ibrahim","Abigail","Hessa","Jacob","Tariq","Emily","Shaikha",
];

const LAST = [
  "Smith","Al-Rashid","Johnson","Al-Hassan","Williams","Al-Ahmad",
  "Brown","Al-Mansouri","Jones","Al-Zahra","Garcia","Al-Farsi",
  "Miller","Al-Sayed","Davis","Al-Qasim","Wilson","Al-Maliki",
  "Taylor","Al-Kaabi","Anderson","Al-Otaibi","Thomas","Al-Ghamdi",
  "Jackson","Al-Harbi","White","Al-Shehri","Harris","Al-Zahrani",
  "Martin","Al-Saeed","Thompson","Al-Balushi","Walker","Al-Kuwaiti",
  "Hall","Al-Dosari","Lewis","Al-Muhairi",
];

const CONTACT_COS = [
  "Emirates Group","Dubai Investment Bank","Mubadala Investment","ADNOC Group","Saudi Aramco",
  "STC Solutions","Riyad Bank","Bank Al-Jazira","Al Rajhi Capital","Dubai Holding",
  "Majid Al Futtaim","Emaar Properties","ALDAR Properties","Damac Holdings","Meraas Holding",
  "Etisalat (e&)","Du Telecom","Mobily","Zain KSA","Batelco Group",
  "McKinsey Middle East","KPMG Gulf","Deloitte Arabia","PwC Middle East","EY MENA",
  "Careem Networks","Noon Commerce","Fetchr Logistics","Anghami","Souq Arabia",
  "Investcorp","Gulf Capital","Waha Capital","Mumtalakat Holdings","Kuwait Investment Authority",
  "Abu Dhabi Commercial Bank","Emirates NBD","Mashreq Bank","Commercial Bank Qatar","Arab Bank",
];

const TITLES = [
  "Chief Executive Officer","Chief Financial Officer","Managing Director","Executive Director",
  "Vice President","Senior Vice President","Director, Business Development","Director, Finance",
  "Head of Strategy","Head of Digital Transformation","Head of Investments","Head of Sales",
  "Senior Manager","Business Development Manager","Account Manager","Relationship Manager",
  "Investment Analyst","Portfolio Manager","Risk Manager","Compliance Officer",
  "Sales Director","Regional Sales Manager","Senior Sales Executive","Business Analyst",
  "Marketing Director","Digital Marketing Manager","Project Manager","Solutions Architect",
  "IT Director","General Manager",
];

const COUNTRIES = [
  "United Arab Emirates","Saudi Arabia","Qatar","Kuwait","Bahrain","Oman",
  "Jordan","Egypt","United Kingdom","United States","India","Lebanon",
];
const CITIES: Record<string, string> = {
  "United Arab Emirates": "Dubai",
  "Saudi Arabia": "Riyadh",
  "Qatar": "Doha",
  "Kuwait": "Kuwait City",
  "Bahrain": "Manama",
  "Oman": "Muscat",
  "Jordan": "Amman",
  "Egypt": "Cairo",
  "United Kingdom": "London",
  "United States": "New York",
  "India": "Mumbai",
  "Lebanon": "Beirut",
};

// GPS coordinates near typical MENA event venues
const GPS: [number, number][] = [
  [25.2048, 55.2708], [25.1851, 55.2762], [24.4539, 54.3773], [24.6877, 46.7219],
  [25.2854, 51.5310], [29.3759, 47.9774], [26.2235, 50.5876], [23.5880, 58.3829],
  [25.2124, 55.2899], [25.1968, 55.2750], [24.4672, 54.3891], [24.7136, 46.6753],
];

// Capture sources (20-slot cycle to produce realistic distribution)
const SOURCES = [
  "card","qr","card","signature","card","qr","manual","card","signature","qr",
  "card","nfc","card","qr","signature","card","manual","card","qr","card",
];

// Pipeline status — 5 new, 5 contacted, 4 quotation_sent, 3 negotiation, 2 won, 1 lost per 20
const STATUSES = [
  "new","new","new","new","new",
  "contacted","contacted","contacted","contacted","contacted",
  "quotation_sent","quotation_sent","quotation_sent","quotation_sent",
  "negotiation","negotiation","negotiation",
  "won","won","lost",
];

// Lead temperature — 6 hot, 9 warm, 5 cold per 20
const TEMPS = [
  "hot","hot","hot","hot","hot","hot",
  "warm","warm","warm","warm","warm","warm","warm","warm","warm",
  "cold","cold","cold","cold","cold",
];

// Lead scores aligned with temperatures above
const SCORES = [
  95, 88, 92, 85, 91, 82,
  72, 68, 75, 64, 71, 78, 55, 62, 58,
  38, 42, 25, 31, 28,
];

const AI_REASONS = [
  "Senior decision-maker with confirmed budget and a 30-day evaluation window.",
  "High-engagement C-suite prospect; strong product-market fit confirmed.",
  "Director-level contact actively evaluating vendors — compelling use case.",
  "Verified budget authority; indicated 30-day decision timeline.",
  "Warm referral from existing client; pre-sold on the value proposition.",
  "High-seniority contact with procurement authority. Priority account.",
  "Mid-level manager with influence; internal champion needed.",
  "Expressed interest but procurement cycle is Q4 — nurture monthly.",
  "Good-fit account; contact needs to escalate internally before deciding.",
  "Engaged at event; proposal sent. Awaiting committee review.",
  "Active evaluation; competitive situation with two other vendors.",
  "Initial interest noted; discovery call needed to advance.",
  "Long enterprise sales cycle expected; worth the strategic investment.",
  "Budget constraints flagged; explore phased rollout option.",
  "Needs technical demo before decision; schedule solutions engineer.",
  "Not in active buying cycle; revisit at Q1 budget planning.",
  "Cold outreach; limited engagement so far. Re-approach in 60 days.",
  "Competitor relationship in place; price sensitivity high.",
  "Lost to competitor on pricing. Re-engage if they churn in 6 months.",
  "Successfully closed — upsell expansion opportunity in 6 months.",
];

const NOTES = [
  "Interested in a Series B co-investment. Wants to schedule a partner call next week.",
  "Met at the main exhibition hall. Very engaged; requested detailed proposal.",
  "Potential strategic partner. Decision-maker with full budget authority.",
  "Referred by an existing client. High-priority follow-up required.",
  "Looking to expand regional operations. Exploring joint-venture opportunities.",
  "Attending as conference keynote speaker. Strong regional investor network.",
  "Key decision-maker for Q3 procurement cycle. Proposal due end of month.",
  "Currently evaluating 3 vendors; our solution ranked first in their assessment.",
  "Requested ROI case study and two client references. Follow up within 48 hrs.",
  "Internal budget approved. Waiting for board sign-off — expect decision in 2 weeks.",
  "Interested in pilot programme. Ready to start Q3 if terms are agreed.",
  "Existing contract ending in 6 months. Strategic replacement opportunity.",
  "Expressed strong interest in a regional channel partnership.",
  "Follow up after conference with full product demo and ROI case studies.",
  "Warm introduction through mutual contact at the evening networking session.",
  "Decision timeline confirmed: 30–60 days. Maintain weekly outreach cadence.",
  "Technical team needs briefing before final sign-off. Schedule engineer call.",
  "Pricing negotiation scheduled for next month. CFO joining the call.",
  "Competitive situation — 2 other vendors shortlisted alongside us.",
  "Signed LOI. Working through final contract details with legal team.",
];

const TASK_TITLES = [
  "Send proposal","Schedule demo call","Follow up on pricing","Research prospect company",
  "Prepare ROI presentation","Coordinate with legal team","Update notes after meeting",
  "Send product brochure","Arrange site visit","Confirm meeting logistics",
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function p<T>(arr: readonly T[], i: number): T {
  return arr[((i % arr.length) + arr.length) % arr.length];
}

function hp(pw: string): string {
  return bcrypt.hashSync(pw, 10);
}

/** YYYY-MM-DD string for a date N days from today */
function ds(daysOffset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return d.toISOString().slice(0, 10);
}

function coSlug(co: string): string {
  return co.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") + ".com";
}

function emailFromName(first: string, last: string, domain: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  return `${clean(first)}.${clean(last)}@${domain}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT BUILDER — deterministic, varies with global index
// ─────────────────────────────────────────────────────────────────────────────

function buildContact(
  gi: number,
  companyId: number,
  assignedToId: number,
  createdById: number,
  events: { id: number }[],
) {
  const firstName = p(FIRST, gi * 3 + 1);
  const lastName = p(LAST, gi * 7 + 2);
  const fullName = `${firstName} ${lastName}`;
  const co = p(CONTACT_COS, gi * 11 + 3);
  const domain = coSlug(co);
  const country = p(COUNTRIES, gi * 5 + 4);
  const city = CITIES[country] ?? "Dubai";
  const [lat, lon] = p(GPS, gi * 4 + 2);
  const status = p(STATUSES, gi);
  const temp = p(TEMPS, gi);
  const score = p(SCORES, gi);
  const src = p(SOURCES, gi);
  const ev = p(events, gi);

  const needsFollowUp = ["contacted", "quotation_sent", "negotiation"].includes(status);

  return {
    companyId,
    firstName,
    lastName,
    fullName,
    jobTitle: p(TITLES, gi * 13 + 5),
    contactCompany: co,
    email: emailFromName(firstName, lastName, domain),
    mobile: `+971${50 + (gi % 9)}${String(3000000 + gi * 173).slice(0, 7)}`,
    officePhone: gi % 4 === 0 ? `+971${4 + (gi % 3)}${String(5000000 + gi * 97).slice(0, 7)}` : null,
    website: gi % 3 !== 2 ? `https://www.${domain}` : null,
    country,
    address: `${(gi % 99) + 1} ${city} Business Bay, ${city}`,
    linkedin:
      gi % 3 !== 1
        ? `https://linkedin.com/in/${firstName.toLowerCase().replace(/[^a-z]/g, "")}-${lastName.toLowerCase().replace(/[^a-z]/g, "")}`
        : null,
    status,
    leadScore: score,
    leadTemperature: temp,
    aiReasoning: p(AI_REASONS, gi),
    notes: `[Source: ${src}] ${p(NOTES, gi)}`,
    latitude: Math.round((lat + (gi % 50) * 0.001) * 1e6) / 1e6,
    longitude: Math.round((lon + (gi % 50) * 0.001) * 1e6) / 1e6,
    gpsAccuracy: 5 + (gi % 20),
    eventId: ev.id,
    assignedToId,
    createdById,
    followUpDate: needsFollowUp ? ds(-(30 - (gi % 30)) + (gi % 60)) : null,
    createdAt: new Date(Date.now() - (120 - gi * 1.8) * 86_400_000),
    updatedAt: new Date(Date.now() - (120 - gi * 1.8) * 86_400_000 + 3_600_000),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🌱  Card Scanner Pro — demo data seed\n");

  // ── 1. Clean existing demo data ──────────────────────────────────────────
  const DEMO_NAMES = ["Gulf Ventures Capital", "TechForward Solutions"];
  const existing = await db
    .select({ id: companiesTable.id })
    .from(companiesTable)
    .where(inArray(companiesTable.name, DEMO_NAMES));

  if (existing.length > 0) {
    console.log(`🧹  Removing ${existing.length} existing demo company/companies…`);
    for (const { id } of existing) {
      await db.delete(companiesTable).where(eq(companiesTable.id, id));
    }
  }

  // ── 2. Companies ─────────────────────────────────────────────────────────
  console.log("🏢  Creating 2 companies…");

  const [gvc] = await db
    .insert(companiesTable)
    .values({
      name: "Gulf Ventures Capital",
      industry: "Financial Services",
      country: "United Arab Emirates",
      website: "https://gulfventures.ae",
      phone: "+97144001000",
      plan: "professional",
      status: "active",
    })
    .returning();

  const [tfs] = await db
    .insert(companiesTable)
    .values({
      name: "TechForward Solutions",
      industry: "Technology",
      country: "Saudi Arabia",
      website: "https://techforward.sa",
      phone: "+966112001000",
      plan: "professional",
      status: "active",
    })
    .returning();

  // ── 3. Subscriptions ─────────────────────────────────────────────────────
  const subBase = {
    plan: "professional",
    status: "active",
    scansLimit: 500,
    usersLimit: 20,
    adminsLimit: 5,
    employeesLimit: 15,
    contactsLimit: 2000,
    eventsLimit: 20,
    storageLimitMb: 5000,
    apiLimit: 10000,
  } as const;

  await db.insert(subscriptionsTable).values([
    { ...subBase, companyId: gvc.id, scansUsed: 87 },
    { ...subBase, companyId: tfs.id, scansUsed: 64 },
  ]);

  // ── 4. Users ─────────────────────────────────────────────────────────────
  console.log("👥  Creating 6 users (password: Demo123!)…");
  const pw = hp("Demo123!");
  const uBase = {
    passwordHash: pw,
    isActive: true,
    contactVisibility: "all" as const,
    companyVisibility: "own" as const,
    permissions: {} as Record<string, string[]>,
  };
  // Reports policy (Stage 2.11B / GAP-05): the mid-tier `admin` role keeps reports:view by
  // default to preserve existing customer workflows; a primary_admin may revoke it later via
  // Role & Permission Management. `employee` has NO reports access by default — it must be
  // explicitly granted. (platform_owner is blocked from reports entirely; primary_admin bypasses.)
  // AI Sales Copilot (Stage 5B): admin gets full copilot access (view/generate/use) by
  // default so the generative drafting tools are usable out of the box; employee gets
  // ONLY view (read the panel/drafts) by default — BOTH writes (`generate` and `use`,
  // which mutate) are deny-by-default and must be explicitly granted. A primary_admin
  // bypasses all permission checks; platform_owner is blocked from /ai/copilot.
  const adminPerms: Record<string, string[]> = {
    contacts: ["view", "create", "edit", "delete"],
    leads: ["view", "edit"],
    tasks: ["view", "create", "edit"],
    events: ["view"],
    reports: ["view"],
    ai_copilot: ["view", "generate", "use"],
  };
  const empPerms: Record<string, string[]> = {
    contacts: ["view", "create", "edit"],
    tasks: ["view", "create"],
    ai_copilot: ["view"],
  };

  const [sarah] = await db.insert(usersTable).values({ ...uBase, email: "sarah.mitchell@gulfventures.ae", name: "Sarah Mitchell",  phone: "+971501111001", role: "primary_admin", companyId: gvc.id }).returning();
  const [ahmed] = await db.insert(usersTable).values({ ...uBase, email: "ahmed.rashid@gulfventures.ae",  name: "Ahmed Al-Rashid",  phone: "+971501111002", role: "admin",         companyId: gvc.id, permissions: adminPerms }).returning();
  const [fatima] = await db.insert(usersTable).values({ ...uBase, email: "fatima.alzahra@gulfventures.ae",name: "Fatima Al-Zahra", phone: "+971501111003", role: "employee",      companyId: gvc.id, permissions: empPerms }).returning();
  const [michael] = await db.insert(usersTable).values({ ...uBase, email: "michael.chen@techforward.sa",  name: "Michael Chen",    phone: "+966501112001", role: "primary_admin", companyId: tfs.id }).returning();
  const [rania] = await db.insert(usersTable).values({ ...uBase, email: "rania.hassan@techforward.sa",   name: "Rania Hassan",    phone: "+966501112002", role: "admin",         companyId: tfs.id, permissions: adminPerms }).returning();
  const [omar] = await db.insert(usersTable).values({ ...uBase, email: "omar.alfarsi@techforward.sa",    name: "Omar Al-Farsi",   phone: "+966501112003", role: "employee",      companyId: tfs.id, permissions: empPerms }).returning();

  await db.update(companiesTable).set({ createdById: sarah.id }).where(eq(companiesTable.id, gvc.id));
  await db.update(companiesTable).set({ createdById: michael.id }).where(eq(companiesTable.id, tfs.id));

  const gvcUsers = [sarah, ahmed, fatima];
  const tfsUsers = [michael, rania, omar];

  // ── 5. Events ─────────────────────────────────────────────────────────────
  console.log("📅  Creating 8 events (4 per company)…");

  const gvcEvs = await db.insert(eventsTable).values([
    { companyId: gvc.id, name: "Arabian Business Forum 2026",   venue: "Dubai World Trade Centre",              country: "United Arab Emirates", startDate: "2026-03-10", endDate: "2026-03-12", status: "completed", createdById: sarah.id },
    { companyId: gvc.id, name: "FinTech Innovation Summit",      venue: "ADNEC, Abu Dhabi",                      country: "United Arab Emirates", startDate: "2026-04-20", endDate: "2026-04-21", status: "completed", createdById: sarah.id },
    { companyId: gvc.id, name: "GCC Investment Conference",      venue: "King Abdullah Financial District",      country: "Saudi Arabia",         startDate: "2026-06-15", endDate: "2026-06-17", status: "active",    createdById: ahmed.id },
    { companyId: gvc.id, name: "Dubai Startup Weekend 2026",     venue: "Hub71, Abu Dhabi",                      country: "United Arab Emirates", startDate: "2026-08-05", endDate: "2026-08-07", status: "upcoming",  createdById: ahmed.id },
  ]).returning();

  const tfsEvs = await db.insert(eventsTable).values([
    { companyId: tfs.id, name: "GITEX Global 2025",              venue: "Dubai World Trade Centre",              country: "United Arab Emirates", startDate: "2025-10-14", endDate: "2025-10-18", status: "completed", createdById: michael.id },
    { companyId: tfs.id, name: "Saudi Digital Summit 2026",      venue: "Riyadh International Convention Center",country: "Saudi Arabia",         startDate: "2026-02-22", endDate: "2026-02-24", status: "completed", createdById: michael.id },
    { companyId: tfs.id, name: "Tech Startup Expo Jeddah",       venue: "Jeddah Hilton Convention Centre",       country: "Saudi Arabia",         startDate: "2026-05-10", endDate: "2026-05-11", status: "completed", createdById: rania.id  },
    { companyId: tfs.id, name: "Cloud & AI Middle East",         venue: "Riyadh Front Exhibition Center",        country: "Saudi Arabia",         startDate: "2026-07-08", endDate: "2026-07-09", status: "upcoming",  createdById: michael.id },
  ]).returning();

  // ── 6. Contacts (20 per user × 6 = 120) ──────────────────────────────────
  console.log("📇  Creating 120 contacts…");

  // Build GVC contacts: users 0-2, global indexes 0-59
  const gvcRows = gvcUsers.flatMap((u, ui) =>
    Array.from({ length: 20 }, (_, j) =>
      buildContact(ui * 20 + j, gvc.id, u.id, u.id, gvcEvs),
    ),
  );

  // Build TFS contacts: users 0-2, global indexes 60-119
  const tfsRows = tfsUsers.flatMap((u, ui) =>
    Array.from({ length: 20 }, (_, j) =>
      buildContact(60 + ui * 20 + j, tfs.id, u.id, u.id, tfsEvs),
    ),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insertedGvc = await db.insert(contactsTable).values(gvcRows as any).returning();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insertedTfs = await db.insert(contactsTable).values(tfsRows as any).returning();
  const allContacts = [...insertedGvc, ...insertedTfs];

  // ── 7. Follow-ups ─────────────────────────────────────────────────────────
  console.log("🔔  Creating follow-ups…");

  // Pick contacts in active pipeline stages for follow-ups
  const fuCandidates = allContacts.filter(c =>
    ["contacted", "quotation_sent", "negotiation"].includes(c.status),
  );

  const fuRows = fuCandidates.slice(0, 35).map((c, i) => ({
    companyId: c.companyId,
    contactId: c.id,
    scheduledDate: i < 20 ? ds(3 + i * 2) : ds(-(i - 19) * 3),
    scheduledTime: `${9 + (i % 8)}:${i % 2 === 0 ? "00" : "30"}`,
    notes: p(NOTES, i + 5),
    status: i < 20 ? "pending" : "completed",
    comment: i >= 20 ? "Completed as planned. Agreed on next steps." : null,
    assignedToId: c.assignedToId,
    createdById: c.createdById,
  }));

  await db.insert(followUpsTable).values(fuRows);

  // ── 8. Meetings ───────────────────────────────────────────────────────────
  console.log("🤝  Creating meetings…");

  const mtCandidates = allContacts.filter(c =>
    ["quotation_sent", "negotiation", "won"].includes(c.status),
  );

  const mtTypes = ["online", "physical", "phone_call"] as const;
  const mtRows = mtCandidates.slice(0, 25).map((c, i) => ({
    companyId: c.companyId,
    contactId: c.id,
    meetingDate: i < 15 ? ds(5 + i * 3) : ds(-(i - 14) * 4),
    meetingTime: `${10 + (i % 7)}:00`,
    type: p(mtTypes, i),
    notes:
      i < 15
        ? "Agenda: product demo, commercial terms, implementation timeline."
        : "Meeting completed. Client confirmed interest. Proposal accepted.",
    status: i < 15 ? "scheduled" : "completed",
    comment: i >= 15 ? "Productive meeting — contract sent for review." : null,
    assignedToId: c.assignedToId,
    createdById: c.createdById,
  }));

  await db.insert(meetingsTable).values(mtRows);

  // ── 9. Tasks ──────────────────────────────────────────────────────────────
  console.log("✅  Creating tasks…");

  const allUsers = [...gvcUsers, ...tfsUsers];
  const taskTypes = ["call", "follow_up", "meeting", "proposal", "custom"] as const;
  const taskStatuses = ["pending", "pending", "in_progress", "pending", "completed"] as const;

  const taskRows = allContacts.slice(0, 40).map((c, i) => ({
    companyId: c.companyId,
    contactId: c.id,
    title: `${p(TASK_TITLES, i)} — ${c.fullName ?? c.firstName ?? "Contact"}`,
    type: p(taskTypes, i),
    status: p(taskStatuses, i),
    dueDate: i < 28 ? ds(2 + i) : ds(-(i - 27) * 2),
    dueTime: `${9 + (i % 8)}:00`,
    notes:
      i < 28
        ? "Pending — action required before next contact touchpoint."
        : "Completed on schedule. Outcome logged in contact notes.",
    assignedToId: p(allUsers, i).id,
    assignedById: p(allUsers, i + 1).id,
  }));

  await db.insert(tasksTable).values(taskRows);

  // ── Summary ───────────────────────────────────────────────────────────────
  const byStatus: Record<string, number> = {};
  const byTemp: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byCompany: Record<string, number> = { "Gulf Ventures Capital": 0, "TechForward Solutions": 0 };
  const byUser: Record<string, number> = {};

  for (const [i, c] of allContacts.entries()) {
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    const t = c.leadTemperature ?? "unknown";
    byTemp[t] = (byTemp[t] ?? 0) + 1;
    const src = SOURCES[i % SOURCES.length];
    bySource[src] = (bySource[src] ?? 0) + 1;
    if (i < 60) byCompany["Gulf Ventures Capital"]++;
    else byCompany["TechForward Solutions"]++;
    const u = i < 60 ? gvcUsers[Math.floor(i / 20)] : tfsUsers[Math.floor((i - 60) / 20)];
    byUser[u.name] = (byUser[u.name] ?? 0) + 1;
  }

  const fuPending  = fuRows.filter(f => f.status === "pending").length;
  const fuDone     = fuRows.filter(f => f.status === "completed").length;
  const mtScheduled = mtRows.filter(m => m.status === "scheduled").length;
  const mtDone     = mtRows.filter(m => m.status === "completed").length;
  const taskActive = taskRows.filter(t => ["pending","in_progress"].includes(t.status)).length;
  const taskDone   = taskRows.filter(t => t.status === "completed").length;

  console.log("\n✅  Demo data seeded successfully!");
  console.log("══════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("──────────────────────────────────────────────────────");
  console.log("Companies : 2");
  console.log("  • Gulf Ventures Capital  (UAE, Financial Services)");
  console.log("  • TechForward Solutions  (KSA, Technology)");
  console.log("");
  console.log("Users (6) — password: Demo123!");
  console.log("  GVC  sarah.mitchell@gulfventures.ae   primary_admin");
  console.log("       ahmed.rashid@gulfventures.ae     admin");
  console.log("       fatima.alzahra@gulfventures.ae   employee");
  console.log("  TFS  michael.chen@techforward.sa      primary_admin");
  console.log("       rania.hassan@techforward.sa      admin");
  console.log("       omar.alfarsi@techforward.sa      employee");
  console.log("");
  console.log("Events    : 8 (4 per company — completed/active/upcoming mix)");
  console.log(`Contacts  : ${allContacts.length} (20 per user)`);
  console.log("");
  console.log("  By company:");
  for (const [co, n] of Object.entries(byCompany))
    console.log(`    ${co.padEnd(28)} ${n}`);
  console.log("");
  console.log("  By user:");
  for (const [name, n] of Object.entries(byUser))
    console.log(`    ${name.padEnd(28)} ${n}`);
  console.log("");
  console.log("  By pipeline status:");
  for (const [s, n] of Object.entries(byStatus))
    console.log(`    ${s.padEnd(28)} ${n}`);
  console.log("");
  console.log("  By capture method:");
  for (const [s, n] of Object.entries(bySource))
    console.log(`    ${s.padEnd(28)} ${n}`);
  console.log("");
  console.log("  By lead temperature:");
  console.log(`    hot  ${byTemp["hot"] ?? 0}   warm  ${byTemp["warm"] ?? 0}   cold  ${byTemp["cold"] ?? 0}`);
  console.log("");
  console.log(`Follow-ups: ${fuRows.length}  (${fuPending} upcoming, ${fuDone} completed)`);
  console.log(`Meetings  : ${mtRows.length}  (${mtScheduled} scheduled, ${mtDone} completed)`);
  console.log(`Tasks     : ${taskRows.length}  (${taskActive} active, ${taskDone} completed)`);
  console.log("══════════════════════════════════════════════════════");
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
