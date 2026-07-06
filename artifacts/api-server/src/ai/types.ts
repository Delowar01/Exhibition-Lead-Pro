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
  | "conversation_summary";

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
