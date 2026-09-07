import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** One labelled field with optional hint and inline server/client error (role=alert). */
export function FieldShell({
  id,
  path,
  label,
  required,
  hint,
  error,
  children,
  className,
}: {
  id: string;
  path: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5 min-w-0", className)} data-field={path}>
      <Label htmlFor={id} className="text-xs font-medium">
        {label}
        {required && (
          <span className="text-destructive" aria-hidden="true">
            {" "}
            *
          </span>
        )}
        {required && <span className="sr-only"> (required)</span>}
      </Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p id={`${id}-error`} role="alert" data-testid={`field-error-${path}`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function fieldId(prefix: string, path: string): string {
  return `${prefix}-${path.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}
