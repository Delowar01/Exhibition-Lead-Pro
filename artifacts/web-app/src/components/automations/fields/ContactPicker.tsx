import { useEffect, useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { useListContacts, getListContactsQueryKey, useGetContact, getGetContactQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function contactName(c: { fullName?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null; id: number }): string {
  return c.fullName || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || `Contact #${c.id}`;
}

/**
 * Searchable contact selector (typeahead over the tenant's contacts through the
 * existing GET /contacts search). Stores the contact id; shows the name.
 */
export function ContactPicker({
  id,
  value,
  onChange,
  disabled,
  invalid,
  testId,
  ariaLabel = "Contact",
}: {
  id?: string;
  value: number | null | undefined;
  onChange: (next: number | null) => void;
  disabled?: boolean;
  invalid?: boolean;
  testId?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 250);
  const params = { search: q, limit: 8 } as const;
  const results = useListContacts(params, { query: { enabled: open && q.length >= 2, queryKey: getListContactsQueryKey(params) } });
  const selected = useGetContact(value ?? 0, { query: { enabled: value != null && value > 0, queryKey: getGetContactQueryKey(value ?? 0), staleTime: 60_000 } });

  const label = value == null ? null : selected.data ? contactName(selected.data) : selected.isError ? `Contact #${value} (not found)` : `Contact #${value}`;

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={ariaLabel}
            aria-invalid={invalid || undefined}
            data-testid={testId}
            disabled={disabled}
            className={cn("w-full justify-between font-normal", !label && "text-muted-foreground", invalid && "border-destructive")}
          >
            <span className="truncate">{label ?? "Search contacts…"}</span>
            <ChevronsUpDown className="ms-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[16rem] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Type at least 2 characters…" value={search} onValueChange={setSearch} />
            <CommandList>
              {q.length < 2 ? (
                <CommandEmpty>Type to search by name, company or email.</CommandEmpty>
              ) : results.isFetching ? (
                <CommandEmpty>Searching…</CommandEmpty>
              ) : (
                <CommandEmpty>No contacts found.</CommandEmpty>
              )}
              <CommandGroup>
                {(results.data?.contacts ?? []).map((c) => (
                  <CommandItem
                    key={c.id}
                    value={String(c.id)}
                    onSelect={() => {
                      onChange(c.id);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <Check className={cn("me-2 h-4 w-4", value === c.id ? "opacity-100" : "opacity-0")} aria-hidden="true" />
                    <span className="truncate">{contactName(c)}</span>
                    {c.contactCompany && <span className="ms-2 truncate text-xs text-muted-foreground">{c.contactCompany}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value != null && !disabled && (
        <Button type="button" variant="ghost" size="icon" aria-label="Clear contact" onClick={() => onChange(null)}>
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
