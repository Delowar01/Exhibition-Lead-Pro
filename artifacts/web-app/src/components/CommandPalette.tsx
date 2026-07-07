import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Contact as ContactIcon, Plus, Sparkles, Camera, Calendar } from "lucide-react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import { useListContacts, getListContactsQueryKey } from "@workspace/api-client-react";
import type { NavGroup } from "@/components/layouts/navigation";

const RECENT_KEY = "csp_recent";
const RECENT_MAX = 8;

interface RecentEntry {
  label: string;
  href: string;
}

function loadRecents(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (e): e is RecentEntry =>
              !!e && typeof e === "object" &&
              typeof (e as RecentEntry).label === "string" &&
              typeof (e as RecentEntry).href === "string",
          )
          .slice(0, RECENT_MAX);
      }
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function pushRecent(entry: RecentEntry) {
  try {
    const list = loadRecents().filter((e) => e.href !== entry.href);
    list.unshift(entry);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* ignore */
  }
}

function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navGroups: NavGroup[];
  portal: "admin" | "platform";
  canViewAssistant?: boolean;
}

export function CommandPalette({ open, onOpenChange, navGroups, portal, canViewAssistant }: CommandPaletteProps) {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounced(query, 250);
  const [recents, setRecents] = useState<RecentEntry[]>([]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setRecents(loadRecents());
    }
  }, [open]);

  const searchEnabled = portal === "admin" && debouncedQuery.trim().length >= 2;
  const contactParams = { search: debouncedQuery.trim(), limit: 6 };
  const { data: contactData, isFetching: contactsFetching } = useListContacts(contactParams, {
    query: {
      queryKey: getListContactsQueryKey(contactParams),
      enabled: searchEnabled,
      staleTime: 30_000,
    },
  });
  const contacts = searchEnabled ? (contactData?.contacts ?? []) : [];

  const go = (href: string, label?: string) => {
    onOpenChange(false);
    if (label) pushRecent({ label, href });
    navigate(href);
  };

  const navItems = useMemo(
    () => navGroups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label }))),
    [navGroups],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder={portal === "admin" ? "Search pages, contacts, actions…" : "Search pages…"}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>{contactsFetching ? "Searching…" : "No results found."}</CommandEmpty>

        {query.length === 0 && recents.length > 0 && (
          <>
            <CommandGroup heading="Recent">
              {recents.map((r) => (
                <CommandItem key={r.href} value={`recent ${r.label}`} onSelect={() => go(r.href)}>
                  <ContactIcon className="mr-2 h-4 w-4 text-muted-foreground" />
                  {r.label}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {contacts.length > 0 && (
          <>
            <CommandGroup heading="Contacts">
              {contacts.map((c) => {
                const displayName =
                  c.fullName ||
                  [c.firstName, c.lastName].filter(Boolean).join(" ") ||
                  c.email ||
                  `Contact #${c.id}`;
                return (
                <CommandItem
                  key={c.id}
                  value={`contact ${displayName} ${c.email ?? ""}`}
                  onSelect={() => go(`/admin/contacts/${c.id}`, displayName)}
                >
                  <ContactIcon className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span className="flex-1 truncate">{displayName}</span>
                  {c.email && (
                    <span className="ml-2 text-xs text-muted-foreground truncate">{c.email}</span>
                  )}
                </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        <CommandGroup heading="Navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.href}
                value={`nav ${item.group ?? ""} ${item.name}`}
                onSelect={() => go(item.href)}
              >
                <Icon className="mr-2 h-4 w-4 text-muted-foreground" />
                <span className="flex-1">{item.name}</span>
                {item.group && (
                  <span className="ml-2 text-xs text-muted-foreground">{item.group}</span>
                )}
              </CommandItem>
            );
          })}
        </CommandGroup>

        {portal === "admin" && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Quick create">
              <CommandItem value="create new contact" onSelect={() => go("/admin/contacts/new")}>
                <Plus className="mr-2 h-4 w-4 text-muted-foreground" /> New Contact
              </CommandItem>
              <CommandItem value="create new lead" onSelect={() => go("/admin/leads")}>
                <Plus className="mr-2 h-4 w-4 text-muted-foreground" /> New Lead
              </CommandItem>
              <CommandItem value="create new event" onSelect={() => go("/admin/events")}>
                <Calendar className="mr-2 h-4 w-4 text-muted-foreground" /> New Event
              </CommandItem>
              <CommandItem value="scan business card" onSelect={() => go("/admin/scan")}>
                <Camera className="mr-2 h-4 w-4 text-muted-foreground" /> Scan Card
              </CommandItem>
            </CommandGroup>
            {(canViewAssistant ?? false) && (
              <>
                <CommandSeparator />
                <CommandGroup heading="AI">
                  <CommandItem value="ask ai command center" onSelect={() => go("/admin/ai-command")}>
                    <Sparkles className="mr-2 h-4 w-4 text-muted-foreground" /> Ask AI Command Center
                  </CommandItem>
                  <CommandItem value="open sales copilot" onSelect={() => go("/admin/ai-copilot")}>
                    <Sparkles className="mr-2 h-4 w-4 text-muted-foreground" /> Open Sales Copilot
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
