import type { User } from "@workspace/api-client-react";

// Batch 41 (PB-3) — client-side mirror of the server's feature entitlement
// decision. The API enforces every feature with `requireFeature` (403
// FEATURE_NOT_ENTITLED); the web app only uses `user.entitlements` (resolved by
// the SAME server decision path and returned by login / GET /auth/me) to hide
// or explain capabilities the tenant's plan version does not include. The UI
// never derives access from plan metadata.
export type FeatureKey =
  | "ai.assistant"
  | "ai.command_center"
  | "workflow.intelligence"
  | "executive.intelligence"
  | "exports.scheduled"
  | "nfc.capture"
  | "documents"
  | "api.access";

export const FEATURE_LABEL: Record<FeatureKey, string> = {
  "ai.assistant": "AI Assistant",
  "ai.command_center": "AI Command Center",
  "workflow.intelligence": "Workflow Intelligence",
  "executive.intelligence": "Executive Intelligence",
  "exports.scheduled": "Scheduled Exports",
  "nfc.capture": "NFC Capture",
  documents: "Documents",
  "api.access": "API Access",
};

/**
 * true unless the server's resolved entitlements explicitly deny the feature.
 * A user without tenant entitlements (platform operators, or a session stored
 * before entitlements existed) is not hidden anything — the server decides.
 */
export function featureAllowed(user: Pick<User, "entitlements"> | null | undefined, feature: FeatureKey): boolean {
  const features = user?.entitlements?.features;
  if (!features) return true;
  return features[feature] !== false;
}

export function featureEnforcementOf(user: Pick<User, "entitlements"> | null | undefined): "legacy" | "enforced" | "invalid" | null {
  return user?.entitlements?.featureEnforcement ?? null;
}
