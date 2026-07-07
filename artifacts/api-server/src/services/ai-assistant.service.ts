import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as repo from "../repositories/ai-assistant.repository.js";
import * as leadsRepo from "../repositories/leads.repository.js";
import * as eventsRepo from "../repositories/events.repository.js";
import * as orgsRepo from "../repositories/organizations.repository.js";
import * as searchService from "./search.service.js";
import * as workflow from "./ai-workflow.service.js";
import * as executive from "./executive-intelligence.service.js";
import * as copilot from "./ai-copilot.service.js";
import * as insights from "./ai-insights.service.js";
import { resolveSettings } from "./ai.service.js";
import { PROMPTS } from "../ai/prompts.js";
import { phraseAssistantAnswer, logAiError, type AppLanguage } from "../lib/ai.js";

// ── Stage 5D — Enterprise AI Command Center ────────────────────────────────────
//
// Conversational orchestration layer over EVERY existing AI engine (5A insights,
// 5B copilot, 5C executive, 5E capture, 5F workflow) + tenant-scoped CRM search.
//
// SAFETY CONTRACT (identical to every other AI surface):
// - ADVISORY ONLY: the assistant NEVER writes the CRM, never sends email/WhatsApp,
//   never assigns/routes/closes anything. Suggested actions are navigation/draft
//   suggestions the user must perform through the existing manual, audited endpoints.
// - DETERMINISTIC CORE: the intent is classified deterministically and every answer is
//   grounded in real tenant CRM rows fetched through the SAME tenant-scoped services/
//   repositories the rest of the product uses. The LLM only PHRASES the answer on top;
//   on any AI failure the deterministic answer survives (soft-degrade, HTTP 200).
// - HONEST PROVENANCE: deterministic answers carry source="deterministic" and NO
//   provider/model/promptKey; only a successful LLM phrasing flips source="ai".
// - RBAC INSIDE the orchestration: each intent re-checks the caller's permission for
//   the UNDERLYING module (ai_workflow/ai_executive/ai_copilot/ai_insights/contacts/
//   leads/events) before calling it — the assistant can never become a bypass route.
// - TENANT ISOLATION: conversations are per-user per-tenant; all CRM reads go through
//   tenantScope-based repositories. platform_owner is blocked at the route (requireTenantUser).

const MAX_CONTENT_LEN = 2000;
const MAX_TITLE_LEN = 80;

export type Intent =
  | "priorities"
  | "risks"
  | "bottlenecks"
  | "workload"
  | "forecast"
  | "executive_summary"
  | "draft_email"
  | "draft_whatsapp"
  | "call_prep"
  | "meeting_prep"
  | "proposal"
  | "insights"
  | "capture_review"
  | "search_contacts"
  | "search_leads"
  | "search_companies"
  | "search_events"
  | "help";

export interface SuggestedAction {
  label: string;
  type: "navigate" | "prompt";
  target: string; // route path for navigate; a follow-up prompt string for prompt
}

interface EvidenceRef {
  type: string;
  id: number;
  label: string;
}

// Mirrors requirePermission middleware semantics for IN-SERVICE checks: primary_admin
// bypasses; admin/employee need the explicit grant. (platform_owner never reaches this
// service — blocked by requireTenantUser at the route.)
function can(user: AuthUser, module: string, action: string): boolean {
  if (user.role === "primary_admin") return true;
  return (user.permissions?.[module] ?? []).includes(action);
}

function requireCompany(user: AuthUser): number {
  if (user.companyId == null) throw new AppError(400, "No company context");
  return user.companyId;
}

function normLang(raw: unknown): AppLanguage {
  return raw === "ar" ? "ar" : "en";
}

// ── Deterministic intent classification (EN + AR keyword matrix) ───────────────
// First match wins, ordered from most to least specific. Never guesses: an
// unrecognized query falls back to "help" with a capability overview.
const INTENT_RULES: Array<{ intent: Intent; patterns: RegExp[] }> = [
  { intent: "draft_email", patterns: [/\b(draft|write|compose|prepare)\b.*\bemail\b/i, /\bemail\b.*\b(draft|draft it|write)\b/i, /بريد|ايميل|إيميل/] },
  { intent: "draft_whatsapp", patterns: [/whats\s?app/i, /واتساب|واتس اب/] },
  { intent: "call_prep", patterns: [/\b(call|phone)\b.*\b(prep|prepare|preparation|brief)\b/i, /\bprepare\b.*\bcall\b/i, /تحضير.*مكالمة|مكالمة.*تحضير/] },
  { intent: "meeting_prep", patterns: [/\bmeeting\b.*\b(prep|prepare|preparation|agenda|brief)\b/i, /\bprepare\b.*\bmeeting\b/i, /اجتماع/] },
  { intent: "proposal", patterns: [/\bproposal\b/i, /عرض\s?(سعر|تجاري)|اقتراح/] },
  { intent: "capture_review", patterns: [/\bocr\b/i, /\bscan(ned)?\b.*\b(review|confidence|quality|duplicate)\b/i, /\bduplicate (warning|check)s?\b/i, /مسح|بطاقة.*ممسوحة/] },
  { intent: "bottlenecks", patterns: [/bottleneck/i, /\bstuck\b|\bstalled pipeline\b/i, /اختناق|عنق الزجاجة/] },
  { intent: "workload", patterns: [/workload|team load|capacity/i, /عبء|حمل العمل/] },
  { intent: "forecast", patterns: [/forecast|projection|revenue trend/i, /توقع(ات)?/] },
  { intent: "executive_summary", patterns: [/executive (summary|report)|business (summary|risks|health)\b/i, /summar(y|ize|ise).*(business|sales|performance|activit)/i, /ملخص تنفيذي|تقرير تنفيذي/] },
  { intent: "risks", patterns: [/\bat risk\b|\brisk(y|s)?\b.*\b(opportunit|lead|deal)/i, /\b(opportunit|lead|deal)s?\b.*\brisk/i, /مخاطر|في خطر/] },
  { intent: "priorities", patterns: [/priorit/i, /\btoday'?s? (task|priorit|follow)/i, /missed follow|overdue/i, /أولوي|متابعات فائتة|اليوم/] },
  { intent: "insights", patterns: [/\binsight(s)?\b/i, /\bwhy\b.*\bscore\b/i, /\bsummar(y|ize|ise)\b.*\b(lead|contact|company|this)\b/i, /تحليل|رؤى/] },
  { intent: "search_leads", patterns: [/\b(show|find|list|search|which|display)\b.*\blead(s)?\b/i, /\bopportunit(y|ies)\b/i, /عملاء محتملون|فرص/] },
  { intent: "search_events", patterns: [/\b(show|find|list|search|which|display)\b.*\bevent(s)?\b/i, /\b(visited|met) during\b/i, /فعالي|معرض/] },
  { intent: "search_companies", patterns: [/\b(show|find|list|search|which|display)\b.*\b(compan(y|ies)|organi[sz]ations?)\b/i, /شركات/] },
  { intent: "search_contacts", patterns: [/\b(show|find|list|search|which|display)\b.*\b(contact|customer|people|person)s?\b/i, /\bcontacts? from\b/i, /جهات اتصال|عملاء/] },
];

export function classifyIntent(query: string): Intent {
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some((p) => p.test(query))) return rule.intent;
  }
  return "help";
}

// Extracts a free-text search term: quoted text wins, then "from/for/at X", else the
// query minus leading verbs/entity nouns. Empty string = unrestricted list.
function extractTerm(query: string): string {
  const quoted = /"([^"]{2,80})"|'([^']{2,80})'/.exec(query);
  if (quoted) return (quoted[1] ?? quoted[2]).trim();
  const from = /\b(?:from|for|at|of)\s+(?:company\s+)?([A-Za-z0-9\u0600-\u06FF][\w\u0600-\u06FF .&-]{1,60})\??$/i.exec(query.trim());
  if (from) return from[1].replace(/[?.!]+$/, "").trim();
  return "";
}

const COPILOT_INTENT_TO_OUTPUT: Partial<Record<Intent, "email" | "whatsapp" | "call_prep" | "meeting_prep" | "proposal">> = {
  draft_email: "email",
  draft_whatsapp: "whatsapp",
  call_prep: "call_prep",
  meeting_prep: "meeting_prep",
  proposal: "proposal",
};

interface GroundedResult {
  text: string; // deterministic answer text
  data: Record<string, unknown>; // structured payload for the client
  evidence: EvidenceRef[];
  actions: SuggestedAction[];
  confidence: number; // deterministic confidence (100 for real-data lookups)
  phrasable: boolean; // whether LLM phrasing adds value (skipped for pure lists/help)
}

interface ConversationContext {
  contextType: string | null;
  contextId: number | null;
}

// ── Per-intent orchestration. Each handler re-checks the caller's permission for the
// underlying module and returns a deterministic grounded answer built from real rows.
async function runIntent(user: AuthUser, intent: Intent, query: string, ctx: ConversationContext, language: AppLanguage): Promise<GroundedResult> {
  const denied = (module: string, action: string): GroundedResult => ({
    text: language === "ar" ? "ليس لديك صلاحية الوصول إلى هذه الميزة. تواصل مع مدير النظام." : `You don't have permission to use this capability (${module}.${action}). Ask your administrator for access.`,
    data: { permissionDenied: `${module}.${action}` },
    evidence: [],
    actions: [],
    confidence: 100,
    phrasable: false,
  });

  if (intent === "priorities" || intent === "risks") {
    if (!can(user, "ai_workflow", "view")) return denied("ai_workflow", "view");
    const result = await workflow.getSlaRisks(user, {});
    const top = result.risks.slice(0, 8);
    const lines = top.map((r) => `- [${r.riskLevel}] ${r.title}: ${r.detail} → ${r.recommendedAction}`);
    const text = top.length === 0
      ? (language === "ar" ? "لا توجد أولويات أو مخاطر عاجلة اليوم — كل شيء تحت السيطرة." : "No urgent priorities or at-risk items right now — everything is on track.")
      : (language === "ar" ? `أهم ${top.length} أولويات/مخاطر اليوم:\n` : `Top ${top.length} priorities / at-risk items:\n`) + lines.join("\n");
    return {
      text,
      data: { risks: top, counts: result.counts, total: result.total },
      evidence: top.map((r) => ({ type: r.entityType, id: r.entityId, label: r.title })),
      actions: [
        { label: "Open Workflow Intelligence", type: "navigate", target: "/admin/workflow" },
        { label: "Open Pipeline", type: "navigate", target: "/admin/leads" },
      ],
      confidence: 100,
      phrasable: true,
    };
  }

  if (intent === "bottlenecks") {
    if (!can(user, "ai_workflow", "view")) return denied("ai_workflow", "view");
    const result = await workflow.getBottlenecks(user, {});
    const top = (result.bottlenecks as Array<{ title?: string; detail?: string; stage?: string }>).slice(0, 6);
    const lines = top.map((b) => `- ${b.title ?? b.stage ?? "stage"}: ${b.detail ?? ""}`.trim());
    return {
      text: top.length === 0
        ? (language === "ar" ? "لا توجد اختناقات ملحوظة في مسار المبيعات حالياً." : "No notable pipeline bottlenecks detected right now.")
        : (language === "ar" ? "الاختناقات الحالية في مسار المبيعات:\n" : "Current pipeline bottlenecks:\n") + lines.join("\n"),
      data: { bottlenecks: top },
      evidence: [],
      actions: [{ label: "Open Workflow Intelligence", type: "navigate", target: "/admin/workflow" }],
      confidence: 100,
      phrasable: true,
    };
  }

  if (intent === "workload") {
    if (!can(user, "ai_workflow", "view")) return denied("ai_workflow", "view");
    const result = await workflow.getHealth(user, {});
    return {
      text: language === "ar" ? "إليك نظرة عامة على صحة سير العمل وعبء الفريق (انظر التفاصيل أدناه)." : "Here is the current workflow health & team workload overview (details below).",
      data: { health: result },
      evidence: [],
      actions: [{ label: "Open Workflow Intelligence", type: "navigate", target: "/admin/workflow" }],
      confidence: 100,
      phrasable: true,
    };
  }

  if (intent === "forecast") {
    if (!can(user, "ai_executive", "generate")) return denied("ai_executive", "generate");
    const result = await executive.generateForecast(user, {});
    return {
      text: language === "ar" ? "تم إعداد التوقعات من بيانات CRM الفعلية (انظر التفاصيل أدناه)." : "Forecast generated from your real CRM history (details below).",
      data: { forecast: result },
      evidence: [],
      actions: [{ label: "Open Executive Intelligence", type: "navigate", target: "/admin/executive" }],
      confidence: 100,
      phrasable: true,
    };
  }

  if (intent === "executive_summary") {
    if (!can(user, "ai_executive", "generate")) return denied("ai_executive", "generate");
    const result = await executive.generateSummary(user, {});
    return {
      text: language === "ar" ? "تم إعداد الملخص التنفيذي من مؤشرات CRM الفعلية (انظر التفاصيل أدناه)." : "Executive summary generated from your real CRM signals (details below).",
      data: { summary: result },
      evidence: [],
      actions: [{ label: "Open Executive Intelligence", type: "navigate", target: "/admin/executive" }],
      confidence: 100,
      phrasable: true,
    };
  }

  const copilotOutput = COPILOT_INTENT_TO_OUTPUT[intent];
  if (copilotOutput) {
    if (!can(user, "ai_copilot", "generate")) return denied("ai_copilot", "generate");
    if (!ctx.contextType || !ctx.contextId || !["lead", "contact", "organization"].includes(ctx.contextType)) {
      return {
        text: language === "ar"
          ? "لإعداد مسودة، افتح عميلاً محتملاً أو جهة اتصال أولاً ثم اطلب المسودة من هناك — أو أخبرني أي سجل تقصد."
          : "To draft this I need a specific record. Open a lead or contact (or start this conversation from one), then ask again — I never send anything myself; you review every draft.",
        data: { needsContext: true, wanted: copilotOutput },
        evidence: [],
        actions: [
          { label: "Open Leads", type: "navigate", target: "/admin/leads" },
          { label: "Open Contacts", type: "navigate", target: "/admin/contacts" },
        ],
        confidence: 100,
        phrasable: false,
      };
    }
    const entityType = copilot.assertEntityType(ctx.contextType);
    const output = await copilot.generateOutput(user, entityType, ctx.contextId, copilotOutput, { language, instructions: query });
    return {
      text: language === "ar"
        ? "تم إعداد المسودة للمراجعة — لن يتم إرسال أي شيء تلقائياً."
        : "Draft prepared for your review — nothing is ever sent automatically.",
      data: { output },
      evidence: [{ type: ctx.contextType, id: ctx.contextId, label: `${ctx.contextType} #${ctx.contextId}` }],
      actions: [{ label: "Open Sales Copilot", type: "navigate", target: "/admin/ai-copilot" }],
      confidence: typeof output.confidence === "number" ? output.confidence : 100,
      phrasable: false, // the copilot output IS the answer; re-phrasing adds noise
    };
  }

  if (intent === "insights") {
    if (!can(user, "ai_insights", "view")) return denied("ai_insights", "view");
    if (!ctx.contextType || !ctx.contextId || !["lead", "contact", "organization"].includes(ctx.contextType)) {
      return {
        text: language === "ar"
          ? "افتح عميلاً محتملاً أو جهة اتصال أو شركة للحصول على رؤى ذكية عنها."
          : "Open a lead, contact, or company (or start this conversation from one) and I'll summarize its AI insights.",
        data: { needsContext: true },
        evidence: [],
        actions: [{ label: "Open AI Insights", type: "navigate", target: "/admin/ai-insights" }],
        confidence: 100,
        phrasable: false,
      };
    }
    const entityType = insights.assertEntityType(ctx.contextType);
    const rows = await insights.getInsights(user, entityType, ctx.contextId);
    const top = rows.slice(0, 6);
    const lines = top.map((i) => `- ${i.insightType}: ${i.reasoning ?? ""} (confidence ${i.confidence ?? "n/a"})`.trim());
    return {
      text: top.length === 0
        ? (language === "ar" ? "لا توجد رؤى محفوظة لهذا السجل بعد — يمكنك توليدها من لوحة الرؤى." : "No stored insights for this record yet — generate them from the AI Insights panel.")
        : (language === "ar" ? "الرؤى الحالية لهذا السجل:\n" : "Current insights for this record:\n") + lines.join("\n"),
      data: { insights: top },
      evidence: [{ type: ctx.contextType, id: ctx.contextId, label: `${ctx.contextType} #${ctx.contextId}` }],
      actions: [{ label: "Open AI Insights", type: "navigate", target: "/admin/ai-insights" }],
      confidence: 100,
      phrasable: true,
    };
  }

  if (intent === "capture_review") {
    return {
      text: language === "ar"
        ? "لمراجعة جودة المسح الضوئي وتنبيهات التكرار والتعرف على الشركات، افتح سجل المسح — يعرض ثقة كل حقل وتحذيرات التكرار قبل الحفظ."
        : "To review OCR quality, duplicate warnings, and company/contact recognition, open the scan in Capture Review — it shows per-field confidence and duplicate checks before anything is saved. Nothing is ever saved automatically.",
      data: ctx.contextType === "business_card" && ctx.contextId ? { scanId: ctx.contextId } : {},
      evidence: ctx.contextType === "business_card" && ctx.contextId ? [{ type: "business_card", id: ctx.contextId, label: `Scan #${ctx.contextId}` }] : [],
      actions: [{ label: "Open Scans", type: "navigate", target: "/admin/scan" }],
      confidence: 100,
      phrasable: false,
    };
  }

  if (intent === "search_contacts") {
    if (!can(user, "contacts", "view")) return denied("contacts", "view");
    const term = extractTerm(query);
    const raw = term
      ? { combinator: "OR", conditions: [{ field: "name", operator: "contains", value: term }, { field: "company", operator: "contains", value: term }], limit: 10 }
      : { combinator: "AND", conditions: [], limit: 10 };
    const result = await searchService.searchContacts(user, raw, { recordRecent: false });
    const contacts = (result.contacts ?? []) as Array<Record<string, unknown>>;
    const lines = contacts.map((c) => `- ${[c.firstName, c.lastName].filter(Boolean).join(" ") || c.fullName || "Unnamed"}${c.contactCompany ? ` — ${c.contactCompany}` : ""}`);
    return {
      text: contacts.length === 0
        ? (language === "ar" ? `لم يتم العثور على جهات اتصال${term ? ` لـ "${term}"` : ""}.` : `No contacts found${term ? ` for "${term}"` : ""}.`)
        : (language === "ar" ? `تم العثور على ${result.total} جهة اتصال${term ? ` لـ "${term}"` : ""}:\n` : `Found ${result.total} contact(s)${term ? ` for "${term}"` : ""}:\n`) + lines.join("\n"),
      data: { contacts, total: result.total, term },
      evidence: contacts.filter((c) => typeof c.id === "number").map((c) => ({ type: "contact", id: c.id as number, label: String([c.firstName, c.lastName].filter(Boolean).join(" ") || `Contact #${c.id}`) })),
      actions: [{ label: "Open Contacts", type: "navigate", target: "/admin/contacts" }],
      confidence: 100,
      phrasable: false,
    };
  }

  if (intent === "search_leads") {
    if (!can(user, "leads", "view")) return denied("leads", "view");
    const { rows, total } = await leadsRepo.list(user, { limit: 10, offset: 0 });
    const lines = rows.map((l) => `- ${l.title ?? `Lead #${l.id}`} [${l.stage}]${l.value ? ` — ${l.value} ${l.currency ?? ""}` : ""}${l.priority ? ` (${l.priority})` : ""}`.trim());
    return {
      text: rows.length === 0
        ? (language === "ar" ? "لا توجد فرص/عملاء محتملون." : "No leads found.")
        : (language === "ar" ? `لديك ${total} فرصة (أول ${rows.length}):\n` : `You have ${total} lead(s) (showing ${rows.length}):\n`) + lines.join("\n"),
      data: { leads: rows.slice(0, 10), total },
      evidence: rows.map((l) => ({ type: "lead", id: l.id, label: l.title ?? `Lead #${l.id}` })),
      actions: [{ label: "Open Pipeline", type: "navigate", target: "/admin/leads" }],
      confidence: 100,
      phrasable: false,
    };
  }

  if (intent === "search_companies") {
    if (!can(user, "organizations", "view")) return denied("organizations", "view");
    const term = extractTerm(query);
    const { rows } = await orgsRepo.list(user, { search: term || undefined, limit: 10, offset: 0 });
    const lines = rows.map((o) => `- ${o.name}${o.industry ? ` — ${o.industry}` : ""}${o.country ? ` (${o.country})` : ""}`);
    return {
      text: rows.length === 0
        ? (language === "ar" ? `لم يتم العثور على شركات${term ? ` لـ "${term}"` : ""}.` : `No companies found${term ? ` for "${term}"` : ""}.`)
        : (language === "ar" ? `الشركات المطابقة:\n` : `Matching companies:\n`) + lines.join("\n"),
      data: { organizations: rows, term },
      evidence: rows.map((o) => ({ type: "organization", id: o.id, label: o.name })),
      actions: [{ label: "Open Companies", type: "navigate", target: "/admin/companies" }],
      confidence: 100,
      phrasable: false,
    };
  }

  if (intent === "search_events") {
    if (!can(user, "events", "view")) return denied("events", "view");
    const term = extractTerm(query);
    const { rows } = await eventsRepo.list(user, { search: term || undefined, limit: 10, offset: 0 });
    const lines = rows.map((e) => `- ${e.name}${e.country ? ` (${e.country})` : ""} [${e.status}]`);
    return {
      text: rows.length === 0
        ? (language === "ar" ? `لم يتم العثور على فعاليات${term ? ` لـ "${term}"` : ""}.` : `No events found${term ? ` for "${term}"` : ""}.`)
        : (language === "ar" ? "الفعاليات المطابقة:\n" : "Matching events:\n") + lines.join("\n"),
      data: { events: rows, term },
      evidence: rows.map((e) => ({ type: "event", id: e.id, label: e.name })),
      actions: [{ label: "Open Events", type: "navigate", target: "/admin/events" }],
      confidence: 100,
      phrasable: false,
    };
  }

  // help / fallback — deterministic capability overview, adapted to role & permissions.
  const capabilities: string[] = [];
  if (can(user, "ai_workflow", "view")) capabilities.push(language === "ar" ? "أولويات اليوم والمخاطر والاختناقات (اسأل: ما أولوياتي اليوم؟)" : 'Today\'s priorities, at-risk deals & bottlenecks ("What are my priorities today?")');
  if (can(user, "ai_executive", "generate")) capabilities.push(language === "ar" ? "ملخص تنفيذي وتوقعات (اسأل: أعطني ملخصاً تنفيذياً)" : 'Executive summaries & forecasts ("Give me an executive summary")');
  if (can(user, "ai_copilot", "generate")) capabilities.push(language === "ar" ? "مسودات بريد/واتساب وتحضير مكالمات (من داخل سجل)" : 'Email/WhatsApp drafts, call & meeting prep (from a lead/contact)');
  if (can(user, "ai_insights", "view")) capabilities.push(language === "ar" ? "رؤى ذكية عن السجلات" : "AI insights on your records");
  if (can(user, "contacts", "view")) capabilities.push(language === "ar" ? 'البحث (مثال: أظهر جهات الاتصال من "شركة ABC")' : 'Natural search ("Show contacts from \\"Company ABC\\"")');
  return {
    text: (language === "ar" ? "أنا مساعدك الذكي — أعمل فقط على بيانات CRM الحقيقية ولا أنفذ أي إجراء تلقائياً. يمكنني:\n" : "I'm your AI assistant — I only work from your real CRM data and never execute actions automatically. I can help with:\n") + capabilities.map((c) => `- ${c}`).join("\n"),
    data: { capabilities },
    evidence: [],
    actions: [
      { label: language === "ar" ? "أولويات اليوم" : "Today's priorities", type: "prompt", target: language === "ar" ? "ما أولوياتي اليوم؟" : "What are my priorities today?" },
      { label: language === "ar" ? "الفرص المعرضة للخطر" : "Opportunities at risk", type: "prompt", target: language === "ar" ? "ما الفرص المعرضة للخطر؟" : "Show opportunities at risk" },
    ],
    confidence: 100,
    phrasable: false,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

function formatConversation(c: import("@workspace/db").AiConversation) {
  return {
    id: c.id,
    title: c.title,
    contextType: c.contextType,
    contextId: c.contextId,
    lastMessageAt: c.lastMessageAt.toISOString(),
    createdAt: c.createdAt.toISOString(),
  };
}

function formatMessage(m: import("@workspace/db").AiMessage) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    intent: m.intent,
    data: m.data,
    evidence: m.evidence,
    suggestedActions: m.suggestedActions,
    confidence: m.confidence,
    source: m.source,
    provider: m.provider,
    model: m.model,
    promptKey: m.promptKey,
    promptVersion: m.promptVersion,
    createdAt: m.createdAt.toISOString(),
  };
}

const VALID_CONTEXT_TYPES = ["lead", "contact", "organization", "event", "business_card", "document"];

function normContext(raw: { contextType?: unknown; contextId?: unknown }): { contextType: string | null; contextId: number | null } {
  const t = typeof raw.contextType === "string" && VALID_CONTEXT_TYPES.includes(raw.contextType) ? raw.contextType : null;
  const idNum = raw.contextId != null ? parseInt(String(raw.contextId)) : NaN;
  const id = Number.isFinite(idNum) && idNum > 0 ? idNum : null;
  return t && id ? { contextType: t, contextId: id } : { contextType: null, contextId: null };
}

export async function listConversations(user: AuthUser, q?: string) {
  requireCompany(user);
  const rows = await repo.listConversations(user, q);
  return { conversations: rows.map(formatConversation) };
}

export async function createConversation(user: AuthUser, body: Record<string, unknown>) {
  const companyId = requireCompany(user);
  const ctx = normContext(body);
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, MAX_TITLE_LEN) : "New conversation";
  const row = await repo.createConversation({ companyId, userId: user.id, title, ...ctx });
  return formatConversation(row);
}

export async function getConversation(user: AuthUser, id: number) {
  const companyId = requireCompany(user);
  const conv = await repo.findConversation(user, id);
  if (!conv) throw new AppError(404, "Conversation not found");
  const messages = await repo.listMessages(companyId, conv.id);
  return { ...formatConversation(conv), messages: messages.map(formatMessage) };
}

export async function deleteConversation(user: AuthUser, id: number) {
  requireCompany(user);
  const row = await repo.softDeleteConversation(user, id);
  if (!row) throw new AppError(404, "Conversation not found");
  return { success: true };
}

export async function sendMessage(user: AuthUser, conversationId: number, body: Record<string, unknown>) {
  const companyId = requireCompany(user);
  const conv = await repo.findConversation(user, conversationId);
  if (!conv) throw new AppError(404, "Conversation not found");

  const content = typeof body.content === "string" ? body.content.trim().slice(0, MAX_CONTENT_LEN) : "";
  if (!content) throw new AppError(400, "content is required");
  const language = normLang(body.language);
  // Per-message context override (context awareness: the client sends the screen the
  // user is on); falls back to the conversation's opening context.
  const msgCtx = normContext(body);
  const ctx: ConversationContext = msgCtx.contextType
    ? msgCtx
    : { contextType: conv.contextType, contextId: conv.contextId };

  const userMessage = await repo.insertMessage({ conversationId: conv.id, companyId, role: "user", content });

  const intent = classifyIntent(content);
  const grounded = await runIntent(user, intent, content, ctx, language);

  // Best-effort AI phrasing over the deterministic core (soft-degrade on failure).
  let answerText = grounded.text;
  let source: "deterministic" | "ai" = "deterministic";
  let confidence = grounded.confidence;
  let provider: string | null = null;
  let model: string | null = null;
  let promptKey: string | null = null;
  let promptVersion: number | null = null;

  if (grounded.phrasable) {
    try {
      const context = `User question: ${content}\nClassified intent: ${intent}\nDeterministic answer: ${grounded.text}\nStructured results (real CRM data): ${JSON.stringify(grounded.data).slice(0, 8000)}`;
      const phrased = await phraseAssistantAnswer(context, language, { companyId, userId: user.id });
      if (phrased.answer && !phrased.insufficientData) {
        answerText = phrased.answer;
        source = "ai";
        confidence = phrased.confidence;
        provider = phrased.provider;
        model = phrased.model;
        promptKey = PROMPTS.assistant_answer.key;
        promptVersion = phrased.promptVersion;
      }
    } catch (err) {
      logAiError("ai-assistant:answer-phrasing", err);
    }
  }

  const assistantMessage = await repo.insertMessage({
    conversationId: conv.id,
    companyId,
    role: "assistant",
    content: answerText,
    intent,
    data: grounded.data,
    evidence: grounded.evidence,
    suggestedActions: grounded.actions,
    confidence,
    source,
    provider,
    model,
    promptKey,
    promptVersion,
  });

  // First user message titles the conversation.
  const title = conv.title === "New conversation" ? content.slice(0, MAX_TITLE_LEN) : undefined;
  await repo.touchConversation(conv.id, title);

  return { userMessage: formatMessage(userMessage), assistantMessage: formatMessage(assistantMessage) };
}

// Context-aware quick prompts + module links for the Command Center dashboard.
export async function getSuggestions(user: AuthUser, raw: { contextType?: unknown; contextId?: unknown }) {
  const companyId = requireCompany(user);
  const ctx = normContext(raw);
  const prompts: Array<{ label: string; prompt: string }> = [];

  if (ctx.contextType && ["lead", "contact", "organization"].includes(ctx.contextType)) {
    if (can(user, "ai_insights", "view")) prompts.push({ label: "Summarize this record", prompt: "Summarize the insights for this record" });
    if (can(user, "ai_copilot", "generate")) {
      prompts.push({ label: "Draft an email", prompt: "Draft an email for this record" });
      prompts.push({ label: "Prepare a call", prompt: "Prepare a call for this record" });
    }
  } else if (ctx.contextType === "business_card") {
    prompts.push({ label: "Review this scan", prompt: "Review the OCR confidence and duplicate warnings for this scan" });
  }
  if (can(user, "ai_workflow", "view")) {
    prompts.push({ label: "Today's priorities", prompt: "What are my priorities today?" });
    prompts.push({ label: "Opportunities at risk", prompt: "Show opportunities at risk" });
    prompts.push({ label: "Pipeline bottlenecks", prompt: "Where are the bottlenecks in our pipeline?" });
  }
  if (can(user, "ai_executive", "generate")) {
    prompts.push({ label: "Executive summary", prompt: "Give me an executive summary" });
    prompts.push({ label: "Revenue forecast", prompt: "Show me the revenue forecast" });
  }
  if (can(user, "contacts", "view")) prompts.push({ label: "Find contacts", prompt: 'Show contacts from "..."' });

  const [settings, recent] = await Promise.all([
    resolveSettings(companyId).catch(() => null),
    repo.recentAssistantMessages(user, 8),
  ]);

  return {
    context: ctx,
    prompts: prompts.slice(0, 8),
    modules: {
      insights: can(user, "ai_insights", "view"),
      copilot: can(user, "ai_copilot", "view"),
      executive: can(user, "ai_executive", "view"),
      workflow: can(user, "ai_workflow", "view"),
    },
    provider: settings ? { provider: settings.provider, model: settings.model, enabled: settings.enabled } : null,
    recentActivity: recent.map((m) => ({ id: m.id, conversationId: m.conversationId, intent: m.intent, content: m.content.slice(0, 140), source: m.source, createdAt: m.createdAt.toISOString() })),
  };
}
