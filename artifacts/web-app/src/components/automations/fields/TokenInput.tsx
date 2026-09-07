import { useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Comma-separated list input for "is one of / is not one of" on free-text and
 * numeric fields. Keeps the raw text locally (so typing a trailing comma is not
 * eaten) and emits the parsed list on every change.
 */
export function TokenInput({
  id,
  values,
  onChange,
  numeric,
  disabled,
  invalid,
  testId,
  placeholder,
  ariaLabel,
}: {
  id?: string;
  values: Array<string | number>;
  onChange: (next: Array<string | number>) => void;
  numeric?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  testId?: string;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(values.join(", "));
  return (
    <div className="space-y-1">
      <Input
        id={id}
        value={text}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-label={ariaLabel}
        data-testid={testId}
        placeholder={placeholder ?? (numeric ? "e.g. 10, 25, 100" : "e.g. event, referral")}
        className={cn(invalid && "border-destructive")}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const parts = raw
            .split(",")
            .map((p) => p.trim())
            .filter((p) => p !== "");
          onChange(numeric ? parts.map((p) => (p !== "" && !Number.isNaN(Number(p)) ? Number(p) : p)) : parts);
        }}
      />
      <p className="text-xs text-muted-foreground">Separate values with commas.</p>
    </div>
  );
}
