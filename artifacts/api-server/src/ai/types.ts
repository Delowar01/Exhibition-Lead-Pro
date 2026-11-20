// Provider-agnostic AI abstraction types (Stage 5.0 — AI Platform Foundation).
// These decouple the feature code (extraction/scoring/enrichment/assignment) from
// any specific vendor SDK so a new provider can be added by implementing AiProvider.

// Canonical AI feature keys. Also used as the `feature` value in the ai_invocations
// ledger and as the key into per-tenant featureFlags.
export type AiFeature =
  | "card_extraction"
  | "lead_scoring"
  | "contact_enrichment"
  | "assignee_recommendation"
  // Stage 5A — Enterprise AI Intelligence. Each is a JSON-returning feature routed
  // through the same gated runner + ledger as the foundation features.
  | "lead_intelligence"
  | "company_intelligence"
  | "contact_intelligence"
  | "smart_classification"
  | "opportunity_potential"
  // Stage 5B — Enterprise AI Sales Copilot. Each is a JSON-returning feature routed
  // through the same gated runner + ledger; every output is a reviewable draft/brief
  // grounded ONLY in the tenant's CRM data (never auto-sent, never auto-written).
  | "email_composer"
  | "whatsapp_composer"
  | "call_preparation"
  | "meeting_preparation"
  | "proposal_assistant"
  | "followup_suggestions"
  | "sales_coaching"
  | "conversation_summary"
  // Stage 5F — Enterprise AI Workflow Intelligence. Each PHRASES an advisory
  // recommendation whose core (action/owner/timing/priority) is ALREADY computed
  // deterministically from CRM data; the LLM never executes or changes the computed
  // decision. All soft-degrade (deterministic core survives an AI failure) and never
  // auto-assign/route/progress/create/send.
  | "workflow_next_action"
  | "workflow_routing"
  | "workflow_progression"
  | "workflow_reminder"
  | "workflow_task"
  // Stage 5C — Enterprise AI Executive Intelligence. Each PHRASES an executive-grade
  // narrative on top of a deterministic grounded core (health scores, trends, forecasts,
  // alerts) computed from real CRM aggregates. The LLM never invents numbers and never
  // executes anything; it soft-degrades to the deterministic core on failure.
  | "executive_summary"
  | "executive_forecast"
  // Stage 5D — Enterprise AI Command Center. PHRASES a conversational answer on top of
  // a deterministic grounded core (intent classification + orchestrated engine results
  // from real CRM data). The LLM never executes anything, never invents records, and the
  // deterministic answer survives an AI failure (soft-degrade).
  | "assistant_answer";

export const AI_FEATURES: AiFeature[] = [
  "card_extraction",
  "lead_scoring",
  "contact_enrichment",
  "assignee_recommendation",
  "lead_intelligence",
  "company_intelligence",
  "contact_intelligence",
  "smart_classification",
  "opportunity_potential",
  "email_composer",
  "whatsapp_composer",
  "call_preparation",
  "meeting_preparation",
  "proposal_assistant",
  "followup_suggestions",
  "sales_coaching",
  "conversation_summary",
  "workflow_next_action",
  "workflow_routing",
  "workflow_progression",
  "workflow_reminder",
  "workflow_task",
  "executive_summary",
  "executive_forecast",
  "assistant_answer",
];

export interface AiTextPart {
  text: string;
}
export interface AiInlineDataPart {
  inlineData: { mimeType: string; data: string };
}
export type AiPart = AiTextPart | AiInlineDataPart;

export interface AiRequest {
  model: string;
  parts: AiPart[];
  // "json" asks the provider for a JSON-only response; "text" is free-form.
  responseFormat?: "json" | "text";
  maxOutputTokens?: number;
  // Provider hint: token budget for hidden "thinking". 0 disables it (latency win).
  thinkingBudget?: number;
  timeoutMs: number;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** True when the provider returned no usage metadata (counts are a fallback estimate). */
  missingMetadata?: boolean;
}

export interface AiResult {
  text: string;
  usage: AiUsage;
  model: string;
}

// A concrete AI vendor adapter. Implementations must be side-effect free at import
// time beyond what their SDK requires, and must never leak vendor types past this
// interface.
export interface AiProvider {
  readonly name: string;
  generate(req: AiRequest): Promise<AiResult>;
  // True when the provider is configured (credentials present) and callable. Cheap
  // config-presence check — must not make a paid API call. Never throws.
  isConfigured(): boolean;
}

// ── Provider failures ────────────────────────────────────────────────────────────────────
//
// Why a provider call failed, in the few classes the layer acts on. An adapter raises
// AiProviderError for every failure it can classify; anything else (an untyped Error) is
// classified from its message by the runner, as it always was.
//
//   timeout / network / rate_limited / unavailable — the provider could not serve the
//       request right now (transient);
//   auth      — the provider rejected the credentials (a configuration fault);
//   quota     — the provider account's own spending cap or billing stopped the request;
//   refusal   — the provider declined the content of the request;
//   invalid_request  — the provider rejected the request itself (unknown model,
//       malformed request);
//   unsupported_input — THIS provider cannot take this input at all (an image larger
//       than it accepts, an image type it does not read). Raised by the adapter before
//       any request is made;
//   invalid_response — the provider answered, but not with something usable.
//
// The first group, `auth` and `unsupported_input` let the layer try the other provider
// (see isFallbackEligible in runner.ts): the provider could not serve the request, and
// no decision is bypassed by asking the other one. A refusal, a quota stop or a
// rejected request is final: retrying it elsewhere would bypass a decision, not work
// around an outage.
export type AiProviderErrorKind =
  | "timeout"
  | "network"
  | "rate_limited"
  | "unavailable"
  | "auth"
  | "quota"
  | "refusal"
  | "invalid_request"
  | "unsupported_input"
  | "invalid_response";

export class AiProviderError extends Error {
  readonly provider: string;
  readonly kind: AiProviderErrorKind;
  readonly status: number | null;
  /** Tokens the provider reports for a call that still failed (a refusal, for one). */
  readonly usage: AiUsage | null;

  constructor(
    provider: string,
    kind: AiProviderErrorKind,
    message: string,
    opts: { status?: number | null; usage?: AiUsage | null; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "AiProviderError";
    this.provider = provider;
    this.kind = kind;
    this.status = opts.status ?? null;
    this.usage = opts.usage ?? null;
  }
}
