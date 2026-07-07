import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StatusTone = "success" | "warning" | "info" | "destructive" | "primary" | "neutral";

const TONES: Record<StatusTone, string> = {
  success: "bg-success-soft text-success border-success/25",
  warning: "bg-warning-soft text-warning border-warning/25",
  info: "bg-info-soft text-info border-info/25",
  destructive: "bg-destructive-soft text-destructive border-destructive/25",
  primary: "bg-primary-soft text-primary border-primary/25",
  neutral: "bg-muted text-muted-foreground border-border",
};

/**
 * The single status badge for the whole product. Replaces per-page
 * hardcoded badge styles. Includes a leading dot so state is never
 * signaled by color alone (colorblind-safe redundancy).
 */
export function StatusBadge({
  tone = "neutral",
  children,
  showDot = true,
  className,
}: {
  tone?: StatusTone;
  children: ReactNode;
  showDot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {showDot && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
