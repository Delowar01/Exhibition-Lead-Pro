import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Design-system typography hierarchy. Use these instead of ad-hoc
 * text-* class combinations so type stays consistent product-wide.
 */

export function Display({ children, className }: { children: ReactNode; className?: string }) {
  return <h1 className={cn("text-4xl font-bold tracking-tight text-foreground", className)}>{children}</h1>;
}

export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn("text-lg font-semibold text-foreground", className)}>{children}</h2>;
}

export function SubsectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("text-sm font-semibold text-foreground", className)}>{children}</h3>;
}

export function Body({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-sm text-foreground", className)}>{children}</p>;
}

export function Caption({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-xs text-muted-foreground", className)}>{children}</p>;
}

export function KpiNumber({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-3xl font-bold tracking-tight tabular-nums text-foreground", className)}>{children}</span>;
}

export function OverlineLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("text-[11px] font-semibold uppercase tracking-wider text-muted-foreground", className)}>
      {children}
    </span>
  );
}
