import type { User } from "@workspace/api-client-react";

// Batch 41 (PB-3) — client-side mirror of the server's feature entitlement
// decision. The API enforces every feature (403 FEATURE_NOT_ENTITLED); the
// mobile app only reads `user.entitlements` (resolved by the SAME server
// decision path and returned by login / GET /auth/me) to hide or explain a
// capability the tenant's plan version does not include. Never derived from
// plan metadata on the client.
export type FeatureKey =
  | "ai.assistant"
  | "ai.command_center"
  | "workflow.intelligence"
  | "executive.intelligence"
  | "exports.scheduled"
  | "nfc.capture"
  | "documents"
  | "api.access";

export type EntitlementSource = Pick<User, "entitlements"> | null | undefined;

/**
 * true unless the server's resolved entitlements explicitly deny the feature.
 * A user without tenant entitlements (platform operators, or a session stored
 * before entitlements existed) is not hidden anything — the server decides.
 */
export function featureAllowed(user: EntitlementSource, feature: FeatureKey): boolean {
  const features = user?.entitlements?.features;
  if (!features) return true;
  return features[feature] !== false;
}

export function featureEnforcementOf(user: EntitlementSource): "legacy" | "enforced" | "invalid" | null {
  return user?.entitlements?.featureEnforcement ?? null;
}
