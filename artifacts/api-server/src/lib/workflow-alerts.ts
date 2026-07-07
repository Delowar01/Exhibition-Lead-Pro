import {
  db,
  companiesTable,
  usersTable,
  leadsTable,
  contactsTable,
  tasksTable,
  followUpsTable,
  notificationsTable,
} from "@workspace/db";
import { and, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { createNotification } from "../services/notifications.service.js";
import { resolveSettings } from "../services/ai.service.js";
import {
  detectLeadRisks,
  detectContactRisks,
  detectTaskRisks,
  detectFollowUpRisks,
  localDateStr,
  DEFAULT_WORKFLOW_RULES,
  type SlaRisk,
  type WorkflowRules,
} from "./workflow-intelligence.js";

// Stage 5F gap 12 — workflow risk notification dispatch. A recurring per-tenant sweep
// that turns CRITICAL/HIGH workflow risks (the same deterministic detections the
// /ai/workflow/sla-risks endpoint serves) into in-app/email notifications:
//   • each risk OWNER gets a digest of their own critical/high items, and
//   • every active primary_admin gets an executive rollup for the tenant.
// ADVISORY ONLY: this writes notifications, never the source CRM. Idempotent per
// LOCAL day per user via a metadata marker (kind: "workflow_alerts") — one digest per
// user per day, re-ticks within the same day are no-ops.

const MAX_ROWS = 5_000;
const ALERT_KIND = "workflow_alerts";

interface SweepResult {
  companies: number;
  notified: number;
  skipped: number; // users already alerted today
}

async function loadRules(companyId: number): Promise<WorkflowRules> {
  try {
    return (await resolveSettings(companyId)).workflowRules;
  } catch {
    return DEFAULT_WORKFLOW_RULES;
  }
}

// Compute the tenant-wide critical/high risk set for one company (no auth user — this
// is a system sweep; the company id itself is the tenant boundary on every query).
async function computeCompanyRisks(companyId: number): Promise<SlaRisk[]> {
  const rules = await loadRules(companyId);
  const [leads, contacts, tasks, followUps] = await Promise.all([
    db
      .select({
        id: leadsTable.id, title: leadsTable.title, stage: leadsTable.stage, value: leadsTable.value,
        currency: leadsTable.currency, closingDate: leadsTable.closingDate, probability: leadsTable.probability,
        priority: leadsTable.priority, assignedToId: leadsTable.assignedToId, teamId: leadsTable.teamId,
        contactId: leadsTable.contactId, organizationId: leadsTable.organizationId,
        createdAt: leadsTable.createdAt, updatedAt: leadsTable.updatedAt,
      })
      .from(leadsTable)
      .where(and(eq(leadsTable.companyId, companyId), isNull(leadsTable.deletedAt)))
      .limit(MAX_ROWS),
    db
      .select({
        id: contactsTable.id, status: contactsTable.status, followUpDate: contactsTable.followUpDate,
        email: contactsTable.email, mobile: contactsTable.mobile, assignedToId: contactsTable.assignedToId,
        createdAt: contactsTable.createdAt, updatedAt: contactsTable.updatedAt,
      })
      .from(contactsTable)
      .where(and(eq(contactsTable.companyId, companyId), isNull(contactsTable.deletedAt)))
      .limit(MAX_ROWS),
    db
      .select({ id: tasksTable.id, title: tasksTable.title, status: tasksTable.status, dueDate: tasksTable.dueDate, assignedToId: tasksTable.assignedToId })
      .from(tasksTable)
      .where(and(eq(tasksTable.companyId, companyId), notInArray(tasksTable.status, ["completed", "cancelled"])))
      .limit(MAX_ROWS),
    db
      .select({ id: followUpsTable.id, status: followUpsTable.status, scheduledDate: followUpsTable.scheduledDate, assignedToId: followUpsTable.assignedToId, contactId: followUpsTable.contactId })
      .from(followUpsTable)
      .where(and(eq(followUpsTable.companyId, companyId), eq(followUpsTable.status, "pending")))
      .limit(MAX_ROWS),
  ]);

  const today = localDateStr(new Date());
  const now = new Date();
  const risks = [
    // No lastActivityByLead here: the unanswered_comms detector needs the per-lead
    // activity join, which is deliberately skipped in the sweep to keep it cheap —
    // overdue/stalled/aging/missed/expiring already cover every critical/high source.
    ...detectLeadRisks(leads, { today, now, rules }),
    ...detectContactRisks(contacts, today, rules),
    ...detectTaskRisks(tasks, today, rules),
    ...detectFollowUpRisks(followUps, today, rules),
  ];
  return risks.filter((r) => r.riskLevel === "critical" || r.riskLevel === "high");
}

// Local start-of-day for the daily dedup window.
function localDayStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// Users in this company already alerted today (metadata marker).
async function alreadyAlertedToday(companyId: number, userIds: number[]): Promise<Set<number>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ userId: notificationsTable.userId })
    .from(notificationsTable)
    .where(and(
      eq(notificationsTable.companyId, companyId),
      inArray(notificationsTable.userId, userIds),
      gte(notificationsTable.createdAt, localDayStart()),
      sql`${notificationsTable.metadata} ->> 'kind' = ${ALERT_KIND}`,
    ));
  return new Set(rows.map((r) => r.userId));
}

function riskLine(r: SlaRisk): string {
  return `${r.riskLevel === "critical" ? "CRITICAL" : "High"}: ${r.title} — ${r.detail}`;
}

// Advisory-lock namespace for the per-company alert dispatch critical section.
const ALERT_LOCK_NS = 5_600_012;

// Run the sweep for a single tenant. Returns how many users were notified/skipped.
// The dedup check + dispatch run inside a transaction holding a per-company
// pg_advisory_xact_lock, so concurrent runs (scheduler tick + manual trigger,
// or multiple instances) serialize: the second runner waits, re-reads today's
// markers, and skips — preserving the 1/user/local-day guarantee.
export async function runWorkflowAlertsForCompany(companyId: number): Promise<{ notified: number; skipped: number }> {
  const risks = await computeCompanyRisks(companyId);
  if (risks.length === 0) return { notified: 0, skipped: 0 };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ALERT_LOCK_NS}, ${companyId})`);
    return dispatchCompanyAlerts(companyId, risks);
  });
}

async function dispatchCompanyAlerts(companyId: number, risks: SlaRisk[]): Promise<{ notified: number; skipped: number }> {
  if (risks.length === 0) return { notified: 0, skipped: 0 };

  const users = await db
    .select({ id: usersTable.id, role: usersTable.role, isActive: usersTable.isActive })
    .from(usersTable)
    .where(and(eq(usersTable.companyId, companyId), eq(usersTable.isActive, true)));
  const activeIds = new Set(users.map((u) => u.id));
  const primaryAdmins = users.filter((u) => u.role === "primary_admin").map((u) => u.id);

  // Per-owner digest of their own critical/high items.
  const byOwner = new Map<number, SlaRisk[]>();
  for (const r of risks) {
    if (r.ownerId == null || !activeIds.has(r.ownerId)) continue;
    const arr = byOwner.get(r.ownerId) ?? [];
    arr.push(r);
    byOwner.set(r.ownerId, arr);
  }

  const targets = [...new Set([...byOwner.keys(), ...primaryAdmins])];
  const alerted = await alreadyAlertedToday(companyId, targets);
  const today = localDateStr(new Date());
  const critical = risks.filter((r) => r.riskLevel === "critical").length;
  const high = risks.length - critical;

  let notified = 0;
  let skipped = 0;

  for (const [ownerId, own] of byOwner) {
    if (alerted.has(ownerId)) { skipped++; continue; }
    const ownCritical = own.filter((r) => r.riskLevel === "critical").length;
    const top = own.slice(0, 5).map(riskLine).join("\n");
    await createNotification({
      userId: ownerId,
      companyId,
      category: "ai",
      title: ownCritical > 0
        ? `Workflow alert: ${ownCritical} critical item(s) need attention`
        : `Workflow alert: ${own.length} at-risk item(s) assigned to you`,
      body: `${own.length} of your items are at critical/high workflow risk today.\n${top}${own.length > 5 ? `\n…and ${own.length - 5} more.` : ""}`,
      link: "/admin/workflow",
      metadata: { kind: ALERT_KIND, date: today, scope: "owner", critical: ownCritical, high: own.length - ownCritical },
    });
    notified++;
  }

  // Executive rollup for primary admins (skip if they already got an owner digest today
  // or a rollup earlier today — one workflow alert per user per day, total).
  for (const adminId of primaryAdmins) {
    if (alerted.has(adminId) || byOwner.has(adminId)) { if (alerted.has(adminId)) skipped++; continue; }
    await createNotification({
      userId: adminId,
      companyId,
      category: "ai",
      title: `Workflow risk summary: ${critical} critical, ${high} high`,
      body: `The AI workflow engine flagged ${risks.length} critical/high risk item(s) across the company today. Review the SLA risk board for details.`,
      link: "/admin/workflow",
      metadata: { kind: ALERT_KIND, date: today, scope: "executive", critical, high },
    });
    notified++;
  }

  return { notified, skipped };
}

// Global recurring sweep across all live tenants (registered with the jobs scheduler).
// Suspended/expired/cancelled tenants are skipped — no alerts for dormant accounts.
export async function runWorkflowAlerts(): Promise<SweepResult> {
  const companies = await db
    .select({ id: companiesTable.id })
    .from(companiesTable)
    .where(inArray(companiesTable.status, ["trial", "active"]));

  const result: SweepResult = { companies: companies.length, notified: 0, skipped: 0 };
  for (const c of companies) {
    try {
      const r = await runWorkflowAlertsForCompany(c.id);
      result.notified += r.notified;
      result.skipped += r.skipped;
    } catch (err) {
      // One broken tenant must not stop the sweep for everyone else.
      logger.error({ err, companyId: c.id }, "Workflow alert sweep failed for company");
    }
  }
  if (result.notified > 0) {
    logger.info(result, "Workflow risk alerts dispatched");
  }
  return result;
}
