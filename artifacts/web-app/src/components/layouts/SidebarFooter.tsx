import { Building2, ChevronsLeft, ChevronsRight } from "lucide-react";
import { cn } from "@/lib/utils";

const PLAN_LABEL: Record<string, string> = {
  free: "Free Plan",
  starter: "Starter Plan",
  professional: "Professional Plan",
  business: "Business Plan",
  enterprise: "Enterprise Plan",
};

export function planLabel(plan?: string | null): string | null {
  if (!plan) return null;
  return PLAN_LABEL[plan] ?? plan;
}

/**
 * Bottom block of the sidebar: company identity card + collapse control.
 * `plan` is only rendered when real subscription data is available.
 */
export function SidebarFooter({
  companyName,
  plan,
  mini,
  onToggleMini,
  logoUrl,
}: {
  companyName: string;
  plan?: string | null;
  mini: boolean;
  /** Present only on desktop; mobile drawer has no collapse. */
  onToggleMini?: () => void;
  /** Tenant logo (Batch 18); falls back to the building mark. */
  logoUrl?: string | null;
}) {
  const planText = planLabel(plan);
  return (
    <div className={cn("shrink-0 border-t border-border", mini ? "p-2" : "p-3")}>
      <div
        className={cn(
          "flex items-center rounded-lg bg-secondary/50",
          mini ? "justify-center p-2" : "gap-2.5 p-2.5",
        )}
        title={mini ? companyName : undefined}
      >
        {logoUrl ? (
          <img src={logoUrl} alt="" className="h-9 w-9 shrink-0 rounded-lg object-contain bg-white/95 p-0.5" data-testid="sidebar-company-logo" />
        ) : (
          <span className="flex items-center justify-center h-9 w-9 shrink-0 rounded-lg bg-primary-soft text-primary" data-testid="sidebar-company-mark">
            <Building2 className="h-4.5 w-4.5" aria-hidden="true" />
          </span>
        )}
        {!mini && (
          <span className="min-w-0 flex flex-col leading-tight">
            <span className="text-sm font-semibold truncate" data-testid="text-sidebar-company">
              {companyName}
            </span>
            {planText && (
              <span className="text-[11px] text-muted-foreground truncate" data-testid="text-sidebar-plan">
                {planText}
              </span>
            )}
          </span>
        )}
      </div>
      {onToggleMini && (
        <button
          type="button"
          onClick={onToggleMini}
          aria-label={mini ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!mini}
          className={cn(
            "mt-2 flex items-center gap-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-secondary/80 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            mini ? "justify-center h-9 w-10 mx-auto" : "px-3 py-2 w-full",
          )}
          data-testid="button-sidebar-collapse"
        >
          {mini ? (
            <ChevronsRight className="h-4 w-4" aria-hidden="true" />
          ) : (
            <>
              <ChevronsLeft className="h-4 w-4" aria-hidden="true" /> Collapse
            </>
          )}
        </button>
      )}
    </div>
  );
}
