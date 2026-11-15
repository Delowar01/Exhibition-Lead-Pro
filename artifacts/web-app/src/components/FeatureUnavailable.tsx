import { Lock } from "lucide-react";
import { EmptyState } from "@/components/ds";
import { FEATURE_LABEL, type FeatureKey } from "@/lib/entitlements";

// Batch 41 (PB-3) — shown in place of a module the tenant's plan version does
// not include. The API already refuses the module (403 FEATURE_NOT_ENTITLED);
// this view only explains the refusal instead of surfacing raw request errors.
export function FeatureUnavailable({ feature }: { feature: FeatureKey }) {
  return (
    <div data-testid={`feature-unavailable-${feature}`}>
      <EmptyState
        icon={Lock}
        title={`${FEATURE_LABEL[feature]} is not included in your plan`}
        description="This module is not part of your current plan version. Ask your Platform Owner about a plan that includes it."
        className="my-8"
      />
    </div>
  );
}
