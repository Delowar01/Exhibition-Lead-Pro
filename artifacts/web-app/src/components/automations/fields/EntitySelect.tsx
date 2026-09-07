import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Option } from "../entity-options";

// Radix Select rejects an empty-string value, so "nothing selected" is a sentinel.
export const NONE = "__none__";

/**
 * Single-choice selector over human-readable tenant records (or catalog enums).
 * The stored value is the record id / key; the user only ever sees names.
 */
export function EntitySelect({
  id,
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled,
  loading,
  allowClear = true,
  invalid,
  testId,
  ariaLabel,
  className,
}: {
  id?: string;
  value: string | number | null | undefined;
  onChange: (next: string | null) => void;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  allowClear?: boolean;
  invalid?: boolean;
  testId?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const current = value == null || value === "" ? NONE : String(value);
  const known = options.some((o) => o.value === current);
  return (
    <Select value={current} onValueChange={(v) => onChange(v === NONE ? null : v)} disabled={disabled}>
      <SelectTrigger
        id={id}
        data-testid={testId}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        className={cn("w-full", invalid && "border-destructive", className)}
      >
        <SelectValue placeholder={loading ? "Loading…" : placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowClear && <SelectItem value={NONE}>{placeholder}</SelectItem>}
        {!known && current !== NONE && (
          <SelectItem value={current}>#{current} (not found in this company)</SelectItem>
        )}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
            {o.hint && o.hint !== o.label ? <span className="ms-2 text-xs text-muted-foreground">{o.hint}</span> : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Multi-choice picker over tenant records: choose from a select, review as
 * removable chips. Stores an array of ids / keys.
 */
export function MultiEntityPicker({
  id,
  values,
  onChange,
  options,
  placeholder = "Add…",
  disabled,
  loading,
  invalid,
  testId,
  ariaLabel,
  max,
}: {
  id?: string;
  values: Array<string | number>;
  onChange: (next: string[]) => void;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  invalid?: boolean;
  testId?: string;
  ariaLabel?: string;
  max?: number;
}) {
  const chosen = values.map(String);
  const remaining = options.filter((o) => !chosen.includes(o.value));
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? `#${v}`;
  const full = max != null && chosen.length >= max;
  return (
    <div className="space-y-2">
      {chosen.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected values">
          {chosen.map((v) => (
            <li key={v} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs">
              <span>{labelOf(v)}</span>
              {!disabled && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-4 w-4 rounded-full"
                  aria-label={`Remove ${labelOf(v)}`}
                  onClick={() => onChange(chosen.filter((c) => c !== v))}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Select value={NONE} onValueChange={(v) => v !== NONE && onChange([...chosen, v])} disabled={disabled || full}>
        <SelectTrigger id={id} data-testid={testId} aria-label={ariaLabel} aria-invalid={invalid || undefined} className={cn("w-full", invalid && "border-destructive")}>
          <SelectValue placeholder={loading ? "Loading…" : full ? "Maximum reached" : placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{placeholder}</SelectItem>
          {remaining.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
