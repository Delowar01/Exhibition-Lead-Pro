// Pure, side-effect-free decision engines for the Stage 5F Enterprise AI Workflow
// Intelligence layer. Every function computes a GROUNDED "core" (the actual decision:
// which risk, which owner, which next stage, which timing/priority) strictly from the
// real CRM fields passed in by the service — no DB access, no AI, no randomness, no
// current-time side effects beyond the `now`/`today` the caller supplies. These cores
// carry deterministic confidence and NEVER execute anything: the service upserts them as
// advisory recommendations a human reviews, and layers optional AI phrasing on top that
// only wraps wording around these decisions (see the WORKFLOW_SAFETY prompt rules).

// ── Row shapes (structural subsets of the Drizzle rows the service loads) ──────

export interface LeadRow {
  id: number;
  title: string | null;
  stage: string;
  value: string | null;
  currency: string | null;
  closingDate: string | null; // YYYY-MM-DD (date-only)
  probability: number | null;
  priority: string | null;
  assignedToId: number | null;
  teamId: number | null;
  contactId: number | null;
  organizationId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactRow {
  id: number;
  status: string;
  followUpDate: string | null; // YYYY-MM-DD (date-only)
  email: string | null;
  mobile: string | null;
  assignedToId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskRow {
  id: number;
  title: string;
  status: string;
  dueDate: string | null; // YYYY-MM-DD (date-only)
  assignedToId: number | null;
}

export interface FollowUpRow {
  id: number;
  status: string;
  scheduledDate: string | null; // YYYY-MM-DD (date-only)
  assignedToId: number | null;
  contactId: number;
}

export interface StageRow {
  key: string;
  name: string;
  sortOrder: number;
  isWon: boolean;
  isLost: boolean;
}

// ── Date helpers (all date-only comparisons use local-date strings) ────────────

const MS_DAY = 86_400_000;

export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDaysStr(days: number, now = new Date()): string {
  return localDateStr(new Date(now.getTime() + days * MS_DAY));
}

function parseDateStr(s: string): Date {
  return new Date(`${s}T00:00:00.000`);
}

// Whole-day difference a - b between two YYYY-MM-DD strings (positive => a after b).
function dayDiffStr(a: string, b: string): number {
  return Math.round((parseDateStr(a).getTime() - parseDateStr(b).getTime()) / MS_DAY);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / MS_DAY);
}

function isTerminalStage(stage: string): boolean {
  const s = (stage ?? "").toLowerCase();
  return ["won", "lost", "closed"].some((t) => s.includes(t));
}

function leadNum(value: string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ── Tunable thresholds (business rules, not magic — surfaced in `basis` text) ──

const STALLED_DAYS = 14; // no update on an open lead
const STALLED_HIGH_DAYS = 30;
const AGING_DAYS = 30; // open lead this old counts as an aging opportunity
const UNANSWERED_DAYS = 7; // open lead/contact with no logged interaction
const EXPIRING_TASK_DAYS = 2; // task due within N days
const HIGH_VALUE = 10_000; // deal value (in its own currency) considered significant
const FOLLOWUP_OVERDUE_CRITICAL_DAYS = 7;

// ── SLA / risk detection ──────────────────────────────────────────────────────

export type RiskLevel = "critical" | "high" | "medium" | "low";

export type RiskCategory =
  | "overdue_lead"
  | "stalled_stage"
  | "aging_opportunity"
  | "unanswered_comms"
  | "missed_follow_up"
  | "unreachable"
  | "expiring_task";

export interface SlaRisk {
  entityType: "lead" | "contact" | "task" | "follow_up";
  entityId: number;
  category: RiskCategory;
  riskLevel: RiskLevel;
  title: string;
  detail: string;
  recommendedAction: string;
  ageDays: number | null;
  ownerId: number | null;
  // Deterministic detection certainty. Every risk here is derived from hard CRM
  // fields (an overdue date, a stale timestamp), so the SIGNAL is certain — the
  // severity is expressed by riskLevel, not by lowering confidence. Kept as an
  // explicit numeric field to satisfy the "risk level + confidence + recommended
  // action" contract and to leave room for future probabilistic risk sources.
  confidence: number;
}

// Deterministic SLA-risk detections are grounded in real CRM fields, so they
// carry full confidence (mirrors the deterministic-core convention elsewhere).
export const SLA_RISK_CONFIDENCE = 100;

// Stamp the deterministic confidence onto a batch of freshly-detected risks.
function withConfidence(risks: Omit<SlaRisk, "confidence">[]): SlaRisk[] {
  return risks.map((r) => ({ ...r, confidence: SLA_RISK_CONFIDENCE }));
}

// Numeric weight per risk level, used for the health score / SLA compliance rollups.
export function riskWeight(level: RiskLevel): number {
  return level === "critical" ? 4 : level === "high" ? 3 : level === "medium" ? 2 : 1;
}

export interface LeadRiskOptions {
  today: string;
  now: Date;
  // Last logged interaction (call/email/meeting/message) per lead id; null when none.
  lastActivityByLead?: Map<number, Date | null>;
}

export function detectLeadRisks(leads: LeadRow[], opts: LeadRiskOptions): SlaRisk[] {
  const risks: Omit<SlaRisk, "confidence">[] = [];
  for (const lead of leads) {
    if (isTerminalStage(lead.stage)) continue; // closed pipeline: no SLA pressure
    const label = lead.title ?? `Lead #${lead.id}`;

    if (lead.closingDate && dayDiffStr(opts.today, lead.closingDate) > 0) {
      const overdueDays = dayDiffStr(opts.today, lead.closingDate);
      risks.push({
        entityType: "lead", entityId: lead.id, category: "overdue_lead",
        riskLevel: overdueDays >= FOLLOWUP_OVERDUE_CRITICAL_DAYS ? "critical" : "high",
        title: label,
        detail: `Closing date ${lead.closingDate} passed ${overdueDays} day(s) ago while the lead is still in "${lead.stage}".`,
        recommendedAction: "Contact the customer to confirm the timeline, then update the closing date or move the deal to a closed stage.",
        ageDays: overdueDays, ownerId: lead.assignedToId,
      });
    }

    const staleDays = daysBetween(opts.now, lead.updatedAt);
    if (staleDays >= STALLED_DAYS) {
      risks.push({
        entityType: "lead", entityId: lead.id, category: "stalled_stage",
        riskLevel: staleDays >= STALLED_HIGH_DAYS ? "high" : "medium",
        title: label,
        detail: `No update in ${staleDays} days; the deal is stalled in "${lead.stage}".`,
        recommendedAction: "Log an update and advance the stage, or schedule the next step.",
        ageDays: staleDays, ownerId: lead.assignedToId,
      });
    }

    const ageDays = daysBetween(opts.now, lead.createdAt);
    if (ageDays >= AGING_DAYS) {
      risks.push({
        entityType: "lead", entityId: lead.id, category: "aging_opportunity",
        riskLevel: ageDays >= AGING_DAYS * 2 ? "medium" : "low",
        title: label,
        detail: `Opportunity has been open for ${ageDays} days without closing.`,
        recommendedAction: "Review whether the deal is still viable and set a realistic closing date.",
        ageDays, ownerId: lead.assignedToId,
      });
    }

    if (opts.lastActivityByLead) {
      const last = opts.lastActivityByLead.get(lead.id) ?? null;
      const sinceDays = last ? daysBetween(opts.now, last) : daysBetween(opts.now, lead.createdAt);
      if (sinceDays >= UNANSWERED_DAYS) {
        risks.push({
          entityType: "lead", entityId: lead.id, category: "unanswered_comms",
          riskLevel: sinceDays >= UNANSWERED_DAYS * 3 ? "high" : "medium",
          title: label,
          detail: last
            ? `No interaction logged in ${sinceDays} days.`
            : `No interaction has ever been logged (open ${sinceDays} days).`,
          recommendedAction: "Reach out to the customer and log the interaction.",
          ageDays: sinceDays, ownerId: lead.assignedToId,
        });
      }
    }
  }
  return withConfidence(risks);
}

export function detectContactRisks(contacts: ContactRow[], today: string): SlaRisk[] {
  const risks: Omit<SlaRisk, "confidence">[] = [];
  for (const c of contacts) {
    const status = (c.status ?? "").toLowerCase();
    if (c.followUpDate && dayDiffStr(today, c.followUpDate) > 0 && status !== "won" && status !== "lost") {
      const overdueDays = dayDiffStr(today, c.followUpDate);
      risks.push({
        entityType: "contact", entityId: c.id, category: "missed_follow_up",
        riskLevel: overdueDays >= FOLLOWUP_OVERDUE_CRITICAL_DAYS ? "critical" : "high",
        title: `Contact #${c.id}`,
        detail: `Follow-up was due ${c.followUpDate} (${overdueDays} day(s) overdue).`,
        recommendedAction: "Reach out now and reschedule or complete the follow-up.",
        ageDays: overdueDays, ownerId: c.assignedToId,
      });
    }
    if (!c.email && !c.mobile && status !== "won" && status !== "lost") {
      risks.push({
        entityType: "contact", entityId: c.id, category: "unreachable",
        riskLevel: "medium",
        title: `Contact #${c.id}`,
        detail: "No email or mobile on file — the contact is unreachable.",
        recommendedAction: "Capture an email or phone number so the contact can be worked.",
        ageDays: null, ownerId: c.assignedToId,
      });
    }
  }
  return withConfidence(risks);
}

export function detectTaskRisks(tasks: TaskRow[], today: string): SlaRisk[] {
  const risks: Omit<SlaRisk, "confidence">[] = [];
  for (const t of tasks) {
    const status = (t.status ?? "").toLowerCase();
    if (status === "completed" || status === "cancelled" || !t.dueDate) continue;
    const diff = dayDiffStr(today, t.dueDate); // >0 overdue, ==0 due today, <0 upcoming
    if (diff > 0) {
      risks.push({
        entityType: "task", entityId: t.id, category: "expiring_task",
        riskLevel: diff >= FOLLOWUP_OVERDUE_CRITICAL_DAYS ? "critical" : "high",
        title: t.title,
        detail: `Task is overdue by ${diff} day(s) (due ${t.dueDate}).`,
        recommendedAction: "Complete the task or move its due date.",
        ageDays: diff, ownerId: t.assignedToId,
      });
    } else if (diff >= -EXPIRING_TASK_DAYS) {
      risks.push({
        entityType: "task", entityId: t.id, category: "expiring_task",
        riskLevel: diff === 0 ? "high" : "medium",
        title: t.title,
        detail: diff === 0 ? `Task is due today (${t.dueDate}).` : `Task is due in ${-diff} day(s) (${t.dueDate}).`,
        recommendedAction: "Plan to complete the task before it is due.",
        ageDays: diff, ownerId: t.assignedToId,
      });
    }
  }
  return withConfidence(risks);
}

export function detectFollowUpRisks(followUps: FollowUpRow[], today: string): SlaRisk[] {
  const risks: Omit<SlaRisk, "confidence">[] = [];
  for (const f of followUps) {
    if ((f.status ?? "").toLowerCase() !== "pending" || !f.scheduledDate) continue;
    const diff = dayDiffStr(today, f.scheduledDate);
    if (diff > 0) {
      risks.push({
        entityType: "follow_up", entityId: f.id, category: "missed_follow_up",
        riskLevel: diff >= FOLLOWUP_OVERDUE_CRITICAL_DAYS ? "critical" : "high",
        title: `Follow-up #${f.id}`,
        detail: `Scheduled follow-up was due ${f.scheduledDate} (${diff} day(s) overdue).`,
        recommendedAction: "Complete or reschedule the follow-up.",
        ageDays: diff, ownerId: f.assignedToId,
      });
    }
  }
  return withConfidence(risks);
}

// ── Follow-up / next-action / priority / due-date cores (per entity) ──────────

export interface FollowupCore {
  suggestedDate: string;
  priority: "Urgent" | "High" | "Normal" | "Low";
  channel: "email" | "whatsapp" | "call";
  overdue: boolean;
  basis: string;
}

export function leadFollowupCore(lead: LeadRow, today: string, now = new Date()): FollowupCore {
  if (lead.closingDate && dayDiffStr(today, lead.closingDate) > 0 && !isTerminalStage(lead.stage)) {
    return { suggestedDate: today, priority: "Urgent", channel: "call", overdue: true, basis: `Closing date ${lead.closingDate} has passed and the lead is still in "${lead.stage}".` };
  }
  const priority: FollowupCore["priority"] = (lead.priority ?? "").toLowerCase() === "high" ? "High" : "Normal";
  return { suggestedDate: addDaysStr(3, now), priority, channel: "email", overdue: false, basis: `Lead is in "${lead.stage}"; suggest a follow-up in 3 days.` };
}

export function contactFollowupCore(c: ContactRow, today: string, now = new Date()): FollowupCore {
  const channel: FollowupCore["channel"] = c.mobile ? "whatsapp" : "email";
  if (c.followUpDate) {
    const diff = dayDiffStr(today, c.followUpDate);
    if (diff > 0) return { suggestedDate: today, priority: "Urgent", channel, overdue: true, basis: `Follow-up was due ${c.followUpDate} and is overdue.` };
    if (diff === 0) return { suggestedDate: today, priority: "High", channel, overdue: false, basis: `Follow-up is scheduled for today (${c.followUpDate}).` };
    return { suggestedDate: c.followUpDate, priority: "Normal", channel, overdue: false, basis: `Follow-up is scheduled for ${c.followUpDate}.` };
  }
  if ((c.status ?? "").toLowerCase() === "new") {
    return { suggestedDate: addDaysStr(1, now), priority: "High", channel, overdue: false, basis: "New contact with no follow-up set; reach out within a day." };
  }
  return { suggestedDate: addDaysStr(3, now), priority: "Normal", channel, overdue: false, basis: "No follow-up date set; suggest reaching out in 3 days." };
}

export interface NextActionCore {
  action: string;
  priority: "Urgent" | "High" | "Normal" | "Low";
  basis: string;
}

export function leadNextActionCore(lead: LeadRow, today: string, now: Date, lastActivity: Date | null): NextActionCore {
  if (lead.closingDate && dayDiffStr(today, lead.closingDate) > 0 && !isTerminalStage(lead.stage)) {
    return { action: "Call the customer today to confirm the timeline, then update the closing date or the stage.", priority: "Urgent", basis: `Closing date ${lead.closingDate} has passed while the lead is open.` };
  }
  if (lead.contactId == null) {
    return { action: "Link a contact to this lead so you can reach the customer.", priority: "High", basis: "The lead has no associated contact." };
  }
  const staleDays = daysBetween(now, lead.updatedAt);
  if (staleDays >= STALLED_DAYS) {
    return { action: "Log an update and advance the stage — the deal has gone quiet.", priority: staleDays >= STALLED_HIGH_DAYS ? "High" : "Normal", basis: `No update in ${staleDays} days.` };
  }
  const sinceActivity = lastActivity ? daysBetween(now, lastActivity) : daysBetween(now, lead.createdAt);
  if (sinceActivity >= UNANSWERED_DAYS) {
    return { action: "Reach out to the customer and log the interaction.", priority: "Normal", basis: `No interaction logged in ${sinceActivity} days.` };
  }
  const stage = (lead.stage ?? "").toLowerCase();
  if (stage.includes("prospect")) return { action: "Qualify the lead: confirm budget, authority, need, and timeline.", priority: "Normal", basis: "Lead is early in the pipeline (prospecting)." };
  if (stage.includes("qualified")) return { action: "Prepare and send a tailored proposal.", priority: "Normal", basis: "Lead is qualified and ready for a proposal." };
  if (stage.includes("proposal")) return { action: "Follow up on the proposal and address any objections.", priority: "High", basis: "A proposal has been sent; keep the momentum." };
  if (stage.includes("negotiation")) return { action: "Push to close: confirm terms and agree on next steps.", priority: "High", basis: "Lead is in negotiation." };
  return { action: "Schedule the next touchpoint to keep the deal moving.", priority: "Normal", basis: `Lead is in "${lead.stage}".` };
}

export function contactNextActionCore(c: ContactRow, today: string): NextActionCore {
  if (c.followUpDate && dayDiffStr(today, c.followUpDate) > 0) {
    return { action: "Reach out now — the scheduled follow-up is overdue.", priority: "Urgent", basis: `Follow-up was due ${c.followUpDate}.` };
  }
  if (!c.email && !c.mobile) {
    return { action: "Capture an email or phone number so the contact can be worked.", priority: "High", basis: "No email or mobile on file." };
  }
  if (!c.followUpDate) {
    return { action: "Schedule a follow-up to keep the relationship active.", priority: "Normal", basis: "No follow-up date is set." };
  }
  return { action: "Prepare for the scheduled follow-up.", priority: "Normal", basis: `Follow-up is scheduled for ${c.followUpDate}.` };
}

export interface PriorityCore {
  priority: "Urgent" | "High" | "Normal" | "Low";
  basis: string;
}

export function leadPriorityCore(lead: LeadRow, today: string, now: Date): PriorityCore {
  if (lead.closingDate && dayDiffStr(today, lead.closingDate) > 0 && !isTerminalStage(lead.stage)) {
    return { priority: "Urgent", basis: `Closing date ${lead.closingDate} has passed.` };
  }
  const value = leadNum(lead.value);
  const closingSoon = lead.closingDate ? dayDiffStr(lead.closingDate, today) : null;
  const staleDays = daysBetween(now, lead.updatedAt);
  if ((value != null && value >= HIGH_VALUE) || (closingSoon != null && closingSoon >= 0 && closingSoon <= 7) || staleDays >= STALLED_HIGH_DAYS) {
    const reasons: string[] = [];
    if (value != null && value >= HIGH_VALUE) reasons.push(`high deal value (${value} ${lead.currency ?? "USD"})`);
    if (closingSoon != null && closingSoon >= 0 && closingSoon <= 7) reasons.push(`closing within ${closingSoon} day(s)`);
    if (staleDays >= STALLED_HIGH_DAYS) reasons.push(`stalled for ${staleDays} days`);
    return { priority: "High", basis: `Elevated because of ${reasons.join(", ")}.` };
  }
  return { priority: "Normal", basis: "No urgency signals detected from value, timing, or staleness." };
}

// ── Suggested owner / lead routing ────────────────────────────────────────────

export interface RoutingCandidate {
  userId: number;
  name: string;
  openLeads: number; // current workload (lower is better)
  won: number; // historical closed-won count
  lost: number; // historical closed-lost count
  territoryMatch: boolean; // owns a territory covering the lead's country/region
  industryMatch: boolean; // has worked the lead's industry before
}

export interface RoutingRankEntry {
  userId: number;
  name: string;
  score: number; // 0-100
  signals: string[];
}

export interface RoutingCore {
  suggestedOwnerId: number | null;
  suggestedOwnerName: string | null;
  ranked: RoutingRankEntry[];
  basis: string;
  confidence: number;
}

// Grounded routing score: 40% historical success rate, 30% inverse workload, 15%
// territory match, 15% industry match. Neutral 0.5 prior when a rep has no closed
// history so a brand-new rep is not unfairly ranked at zero.
export function computeRouting(candidates: RoutingCandidate[]): RoutingCore {
  if (candidates.length === 0) {
    return { suggestedOwnerId: null, suggestedOwnerName: null, ranked: [], basis: "No eligible owners are available in scope.", confidence: 0 };
  }
  const maxLoad = Math.max(1, ...candidates.map((c) => c.openLeads));
  const ranked: RoutingRankEntry[] = candidates
    .map((c) => {
      const decided = c.won + c.lost;
      const successRate = decided > 0 ? c.won / decided : 0.5;
      const workloadFactor = 1 - c.openLeads / maxLoad; // 0 (busiest) .. 1 (idlest)
      let score = 0.4 * successRate + 0.3 * workloadFactor + (c.territoryMatch ? 0.15 : 0) + (c.industryMatch ? 0.15 : 0);
      score = Math.round(score * 100);
      const signals: string[] = [];
      if (decided > 0) signals.push(`${Math.round(successRate * 100)}% win rate (${c.won}/${decided})`);
      signals.push(`${c.openLeads} open lead(s)`);
      if (c.territoryMatch) signals.push("territory match");
      if (c.industryMatch) signals.push("industry match");
      return { userId: c.userId, name: c.name, score, signals };
    })
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  // Confidence reflects how decisively the top candidate leads the pack (and that
  // there is real signal), not certainty about the future.
  const gap = ranked.length > 1 ? top.score - ranked[1].score : top.score;
  const confidence = Math.max(50, Math.min(95, 60 + gap));
  return {
    suggestedOwnerId: top.userId,
    suggestedOwnerName: top.name,
    ranked,
    basis: `${top.name} ranks highest on ${top.signals.join(", ")}.`,
    confidence,
  };
}

// ── Opportunity progression ───────────────────────────────────────────────────

const CANONICAL_STAGES: StageRow[] = [
  { key: "prospect", name: "Prospect", sortOrder: 0, isWon: false, isLost: false },
  { key: "qualified", name: "Qualified", sortOrder: 1, isWon: false, isLost: false },
  { key: "proposal_sent", name: "Proposal Sent", sortOrder: 2, isWon: false, isLost: false },
  { key: "negotiation", name: "Negotiation", sortOrder: 3, isWon: false, isLost: false },
  { key: "won", name: "Won", sortOrder: 4, isWon: true, isLost: false },
  { key: "lost", name: "Lost", sortOrder: 5, isWon: false, isLost: true },
];

export interface ProgressionCore {
  currentStage: string;
  suggestedStageKey: string | null;
  suggestedStageName: string | null;
  action: string;
  basis: string;
  confidence: number;
}

export function leadProgressionCore(lead: LeadRow, stages: StageRow[]): ProgressionCore {
  if (isTerminalStage(lead.stage)) {
    return { currentStage: lead.stage, suggestedStageKey: null, suggestedStageName: null, action: "No progression needed — the deal is in a closed stage.", basis: `Lead is already in "${lead.stage}".`, confidence: 100 };
  }
  const ordered = (stages.length ? [...stages] : CANONICAL_STAGES)
    .filter((s) => !s.isLost)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const cur = (lead.stage ?? "").toLowerCase();
  const idx = ordered.findIndex((s) => s.key.toLowerCase() === cur || s.name.toLowerCase() === cur);
  const next = idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1] : null;
  if (!next) {
    return { currentStage: lead.stage, suggestedStageKey: null, suggestedStageName: null, action: "Work toward closing — the lead is at the last open stage.", basis: `Lead is at the final open stage ("${lead.stage}").`, confidence: 90 };
  }
  return {
    currentStage: lead.stage,
    suggestedStageKey: next.key,
    suggestedStageName: next.name,
    action: `When the exit criteria are met, advance the deal to "${next.name}".`,
    basis: `Lead is in "${lead.stage}"; the next pipeline stage is "${next.name}".`,
    confidence: 100,
  };
}

// ── Workflow health rollup ────────────────────────────────────────────────────

export interface WorkloadEntry {
  userId: number;
  name: string;
  openLeads: number;
  overdueItems: number;
}

export interface WorkflowHealth {
  healthScore: number; // 0-100 (higher = healthier)
  grade: "excellent" | "good" | "fair" | "poor";
  slaCompliance: number; // % of tracked items not at risk
  totals: {
    openLeads: number;
    overdueLeads: number;
    stalledLeads: number;
    agingOpportunities: number;
    missedFollowUps: number;
    overdueTasks: number;
    highRiskOpportunities: number;
    trackedItems: number;
    atRiskItems: number;
  };
  workload: WorkloadEntry[];
  topRisks: SlaRisk[];
  recommendedActions: string[];
}

export interface HealthInput {
  risks: SlaRisk[];
  openLeads: number;
  trackedItems: number; // open leads + pending tasks + pending follow-ups
  workload: WorkloadEntry[];
}

export function computeHealth(input: HealthInput): WorkflowHealth {
  const { risks } = input;
  const byCategory = (c: RiskCategory) => risks.filter((r) => r.category === c).length;
  const overdueLeads = byCategory("overdue_lead");
  const stalledLeads = byCategory("stalled_stage");
  const agingOpportunities = byCategory("aging_opportunity");
  const missedFollowUps = byCategory("missed_follow_up");
  const overdueTasks = risks.filter((r) => r.category === "expiring_task" && (r.ageDays ?? 0) > 0).length;
  const highRisk = risks.filter((r) => r.riskLevel === "critical" || r.riskLevel === "high").length;

  // Distinct at-risk entities (an entity with several risks counts once for SLA rollup).
  const atRiskKeys = new Set(risks.map((r) => `${r.entityType}:${r.entityId}`));
  const atRiskItems = atRiskKeys.size;
  const trackedItems = Math.max(input.trackedItems, atRiskItems);
  const slaCompliance = trackedItems === 0 ? 100 : Math.round(((trackedItems - atRiskItems) / trackedItems) * 100);

  // Health score penalizes by weighted risk against tracked volume, so a handful of
  // criticals in a large book hurts less than the same count in a tiny book.
  const weighted = risks.reduce((sum, r) => sum + riskWeight(r.riskLevel), 0);
  const denom = Math.max(1, trackedItems) * 2; // ~2 avg weight budget per tracked item
  const penalty = Math.min(100, Math.round((weighted / denom) * 100));
  const healthScore = Math.max(0, 100 - penalty);
  const grade: WorkflowHealth["grade"] = healthScore >= 85 ? "excellent" : healthScore >= 70 ? "good" : healthScore >= 50 ? "fair" : "poor";

  const recommendedActions: string[] = [];
  if (overdueLeads > 0) recommendedActions.push(`Resolve ${overdueLeads} overdue lead(s) with a passed closing date.`);
  if (missedFollowUps > 0) recommendedActions.push(`Clear ${missedFollowUps} missed follow-up(s).`);
  if (overdueTasks > 0) recommendedActions.push(`Complete or reschedule ${overdueTasks} overdue task(s).`);
  if (stalledLeads > 0) recommendedActions.push(`Re-engage ${stalledLeads} stalled lead(s).`);
  if (recommendedActions.length === 0) recommendedActions.push("No SLA breaches detected — keep follow-ups and stages current.");

  const rankOrder: Record<RiskLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const topRisks = [...risks]
    .sort((a, b) => rankOrder[a.riskLevel] - rankOrder[b.riskLevel] || (b.ageDays ?? 0) - (a.ageDays ?? 0))
    .slice(0, 10);

  return {
    healthScore, grade, slaCompliance,
    totals: {
      openLeads: input.openLeads, overdueLeads, stalledLeads, agingOpportunities,
      missedFollowUps, overdueTasks, highRiskOpportunities: highRisk,
      trackedItems, atRiskItems,
    },
    workload: [...input.workload].sort((a, b) => b.openLeads - a.openLeads).slice(0, 25),
    topRisks,
    recommendedActions,
  };
}

// ── Workflow bottleneck analysis ──────────────────────────────────────────────

export interface Bottleneck {
  type: "stage_bottleneck" | "team_overload" | "overdue_backlog" | "repeated_losses";
  severity: RiskLevel;
  title: string;
  detail: string;
  metric: number;
  recommendedAction: string;
}

export interface BottleneckInput {
  // Per-stage open-lead counts and count of those stalled (updatedAt older than STALLED_DAYS).
  stageStats: Array<{ stage: string; open: number; stalled: number }>;
  // Per-owner open-lead + overdue-item counts (already scope-filtered by the service).
  workload: WorkloadEntry[];
  overdueTasks: number;
  overdueFollowUps: number;
  wonCount: number;
  lostCount: number;
}

export function analyzeBottlenecks(input: BottleneckInput): Bottleneck[] {
  const out: Bottleneck[] = [];

  for (const s of input.stageStats) {
    if (s.open >= 5 && s.stalled / Math.max(1, s.open) >= 0.4) {
      out.push({
        type: "stage_bottleneck", severity: s.stalled >= 10 ? "high" : "medium",
        title: `"${s.stage}" is a pipeline bottleneck`,
        detail: `${s.stalled} of ${s.open} open leads in "${s.stage}" have stalled (no update in ${STALLED_DAYS}+ days).`,
        metric: s.stalled,
        recommendedAction: `Review the "${s.stage}" stage and unblock or re-qualify the stalled deals.`,
      });
    }
  }

  if (input.workload.length >= 2) {
    const loads = input.workload.map((w) => w.openLeads);
    const total = loads.reduce((a, b) => a + b, 0);
    const avg = total / input.workload.length;
    const top = input.workload[0];
    if (avg > 0 && top.openLeads >= Math.max(10, avg * 2)) {
      out.push({
        type: "team_overload", severity: top.openLeads >= avg * 3 ? "high" : "medium",
        title: `${top.name} is overloaded`,
        detail: `${top.name} holds ${top.openLeads} open leads vs a team average of ${Math.round(avg)}.`,
        metric: top.openLeads,
        recommendedAction: "Rebalance the workload by reassigning some leads to reps with capacity.",
      });
    }
  }

  const backlog = input.overdueTasks + input.overdueFollowUps;
  if (backlog >= 5) {
    out.push({
      type: "overdue_backlog", severity: backlog >= 20 ? "high" : "medium",
      title: "Overdue task & follow-up backlog",
      detail: `${input.overdueTasks} overdue task(s) and ${input.overdueFollowUps} overdue follow-up(s) are piling up.`,
      metric: backlog,
      recommendedAction: "Triage the backlog: complete, reschedule, or reassign overdue items.",
    });
  }

  const decided = input.wonCount + input.lostCount;
  if (decided >= 10 && input.lostCount / decided >= 0.6) {
    out.push({
      type: "repeated_losses", severity: input.lostCount / decided >= 0.75 ? "high" : "medium",
      title: "High loss rate",
      detail: `${input.lostCount} of ${decided} decided deals were lost (${Math.round((input.lostCount / decided) * 100)}%).`,
      metric: input.lostCount,
      recommendedAction: "Review recent loss reasons and coach on qualification and objection handling.",
    });
  }

  const rankOrder: Record<RiskLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return out.sort((a, b) => rankOrder[a.severity] - rankOrder[b.severity] || b.metric - a.metric);
}

// ── Workflow simulation (what-if; predicted outcomes, zero writes) ────────────

export type ScenarioType = "reassign" | "follow_up" | "delay";

export interface SimulationParams {
  candidate?: RoutingCandidate; // for reassign
  delayDays?: number; // for delay
}

export interface SimulationResult {
  scenario: ScenarioType;
  baseline: { winProbability: number; riskLevel: RiskLevel; note: string };
  predicted: { winProbability: number; riskLevel: RiskLevel; note: string };
  deltas: { winProbability: number };
  explanation: string;
  assumptions: string[];
  confidence: number;
}

function stageWinProbability(lead: LeadRow): number {
  if (lead.probability != null) return Math.max(0, Math.min(100, lead.probability));
  const s = (lead.stage ?? "").toLowerCase();
  if (s.includes("won")) return 100;
  if (s.includes("lost")) return 0;
  if (s.includes("negotiation")) return 75;
  if (s.includes("proposal")) return 55;
  if (s.includes("qualified")) return 30;
  return 10; // prospect / unknown
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function leadRiskLevel(lead: LeadRow, today: string, now: Date): RiskLevel {
  if (lead.closingDate && dayDiffStr(today, lead.closingDate) > 0 && !isTerminalStage(lead.stage)) return "critical";
  const staleDays = daysBetween(now, lead.updatedAt);
  if (staleDays >= STALLED_HIGH_DAYS) return "high";
  if (staleDays >= STALLED_DAYS) return "medium";
  return "low";
}

// All simulations are DETERMINISTIC estimates over real CRM fields and write NOTHING.
// They are clearly labeled estimates with explicit assumptions; confidence reflects how
// much grounding data supports the estimate, never certainty about the future.
export function simulate(lead: LeadRow, scenario: ScenarioType, params: SimulationParams, today: string, now = new Date()): SimulationResult {
  const baseProb = stageWinProbability(lead);
  const baseRisk = leadRiskLevel(lead, today, now);
  const assumptions: string[] = ["Estimate derived from current CRM fields only; actual outcomes depend on execution."];

  if (scenario === "reassign") {
    const cand = params.candidate;
    if (!cand) {
      return {
        scenario, baseline: { winProbability: baseProb, riskLevel: baseRisk, note: "Current owner." },
        predicted: { winProbability: baseProb, riskLevel: baseRisk, note: "No candidate provided." },
        deltas: { winProbability: 0 }, explanation: "No reassignment candidate was provided, so the outcome is unchanged.", assumptions, confidence: 0,
      };
    }
    const decided = cand.won + cand.lost;
    const candSuccess = decided > 0 ? cand.won / decided : 0.5;
    // Blend current win prob toward the candidate's historical success rate (bounded ±20 pts).
    const target = candSuccess * 100;
    const adjusted = clampPct(baseProb + Math.max(-20, Math.min(20, (target - baseProb) * 0.5)));
    assumptions.push(decided > 0 ? `Candidate has a ${Math.round(candSuccess * 100)}% historical win rate (${cand.won}/${decided}).` : "Candidate has no closed history; a neutral 50% prior is assumed.");
    if (cand.openLeads >= 15) assumptions.push(`Candidate already holds ${cand.openLeads} open leads, which may dilute attention.`);
    const confidence = decided >= 10 ? 70 : decided > 0 ? 55 : 35;
    return {
      scenario,
      baseline: { winProbability: baseProb, riskLevel: baseRisk, note: "Current owner and state." },
      predicted: { winProbability: adjusted, riskLevel: baseRisk, note: `If reassigned to ${cand.name}.` },
      deltas: { winProbability: adjusted - baseProb },
      explanation: `Reassigning to ${cand.name} shifts the estimated win probability toward their ${Math.round(candSuccess * 100)}% historical win rate.`,
      assumptions, confidence,
    };
  }

  if (scenario === "follow_up") {
    // Scheduling a prompt follow-up clears overdue pressure and modestly lifts win odds.
    const wasOverdue = lead.closingDate ? dayDiffStr(today, lead.closingDate) > 0 : false;
    const staleDays = daysBetween(now, lead.updatedAt);
    const lift = wasOverdue ? 8 : staleDays >= STALLED_DAYS ? 6 : 3;
    const predictedRisk: RiskLevel = baseRisk === "critical" ? "high" : baseRisk === "high" ? "medium" : "low";
    assumptions.push("Assumes the follow-up happens tomorrow and is logged.");
    return {
      scenario,
      baseline: { winProbability: baseProb, riskLevel: baseRisk, note: "No new follow-up." },
      predicted: { winProbability: clampPct(baseProb + lift), riskLevel: predictedRisk, note: "With a follow-up scheduled tomorrow." },
      deltas: { winProbability: lift },
      explanation: "A prompt follow-up reduces SLA risk and keeps the deal warm, modestly improving win odds.",
      assumptions, confidence: 60,
    };
  }

  // delay
  const days = Math.max(1, params.delayDays ?? 7);
  const drop = Math.min(25, 2 + days); // longer delays hurt more, bounded
  const predictedRisk: RiskLevel = baseRisk === "low" ? "medium" : baseRisk === "medium" ? "high" : "critical";
  assumptions.push(`Assumes the next step slips by ${days} day(s).`);
  return {
    scenario,
    baseline: { winProbability: baseProb, riskLevel: baseRisk, note: "Acting on schedule." },
    predicted: { winProbability: clampPct(baseProb - drop), riskLevel: predictedRisk, note: `Delaying the next step by ${days} day(s).` },
    deltas: { winProbability: -drop },
    explanation: `Delaying the next step by ${days} day(s) raises SLA risk and lowers the estimated win probability.`,
    assumptions, confidence: 55,
  };
}
