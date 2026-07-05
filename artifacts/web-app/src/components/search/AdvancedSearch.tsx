import React, { useState } from "react";
import {
  useSearchContacts,
  useListSavedSearches,
  useCreateSavedSearch,
  useDeleteSavedSearch,
  useListRecentSearches,
  useClearRecentSearches,
  useListEvents,
  useListUsers,
  getListSavedSearchesQueryKey,
  getListRecentSearchesQueryKey,
  getListEventsQueryKey,
  getListUsersQueryKey,
  SearchConditionField,
  SearchConditionOperator,
  SearchContactsInputCombinator,
  SavedSearchInputKind,
  type SearchCondition,
  type SearchContactsInput,
  type SearchContactsResult,
  type SavedSearch,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Star, Bookmark, Clock, X, Search } from "lucide-react";

const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  company: "Company",
  email: "Email",
  phone: "Phone",
  industry: "Industry",
  country: "Country",
  tags: "Tags",
  notes: "Notes",
  event: "Event",
  employee: "Employee (owner)",
};

const OPERATOR_LABELS: Record<string, string> = {
  contains: "contains",
  notContains: "does not contain",
  equals: "equals",
  notEquals: "does not equal",
  startsWith: "starts with",
  endsWith: "ends with",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
};

const ID_FIELDS = new Set<string>([SearchConditionField.event, SearchConditionField.employee]);
const NO_VALUE_OPS = new Set<string>([
  SearchConditionOperator.isEmpty,
  SearchConditionOperator.isNotEmpty,
]);

function operatorsFor(field: string): string[] {
  if (ID_FIELDS.has(field)) {
    return [
      SearchConditionOperator.equals,
      SearchConditionOperator.notEquals,
      SearchConditionOperator.isEmpty,
      SearchConditionOperator.isNotEmpty,
    ];
  }
  return Object.values(SearchConditionOperator);
}

function newCondition(): SearchCondition {
  return {
    field: SearchConditionField.name,
    operator: SearchConditionOperator.contains,
    value: "",
  };
}

export function AdvancedSearchDialog({
  open,
  onOpenChange,
  onApplied,
  initialInput,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onApplied: (result: SearchContactsResult, input: SearchContactsInput, summary: string) => void;
  initialInput?: SearchContactsInput | null;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [combinator, setCombinator] = useState<SearchContactsInputCombinator>(
    (initialInput?.combinator as SearchContactsInputCombinator) ?? SearchContactsInputCombinator.AND,
  );
  const [conditions, setConditions] = useState<SearchCondition[]>(
    initialInput?.conditions?.length ? initialInput.conditions : [newCondition()],
  );

  const searchContacts = useSearchContacts();
  const createSaved = useCreateSavedSearch();
  const deleteSaved = useDeleteSavedSearch();
  const clearRecents = useClearRecentSearches();

  const { data: savedData } = useListSavedSearches(undefined, {
    query: { enabled: open, queryKey: getListSavedSearchesQueryKey() },
  });
  const { data: recentData } = useListRecentSearches(undefined, {
    query: { enabled: open, queryKey: getListRecentSearchesQueryKey() },
  });
  const { data: eventsData } = useListEvents(
    { limit: 200 },
    { query: { enabled: open, queryKey: getListEventsQueryKey({ limit: 200 }) } },
  );
  const { data: usersData } = useListUsers(
    { limit: 200 },
    { query: { enabled: open, queryKey: getListUsersQueryKey({ limit: 200 }) } },
  );

  const events = eventsData?.events ?? [];
  const users = usersData?.users ?? [];
  const saved = savedData?.savedSearches ?? [];
  const recents = recentData?.recentSearches ?? [];

  const update = (idx: number, patch: Partial<SearchCondition>) => {
    setConditions((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };

  const setField = (idx: number, field: string) => {
    const ops = operatorsFor(field);
    const cur = conditions[idx];
    const nextOp = ops.includes(cur.operator) ? cur.operator : ops[0];
    update(idx, {
      field: field as SearchCondition["field"],
      operator: nextOp as SearchCondition["operator"],
      value: "",
    });
  };

  const buildInput = (): SearchContactsInput => {
    const cleaned = conditions
      .filter((c) => NO_VALUE_OPS.has(c.operator) || String(c.value ?? "").trim() !== "")
      .map((c) => ({
        field: c.field,
        operator: c.operator,
        value: NO_VALUE_OPS.has(c.operator) ? null : c.value,
      }));
    return { combinator, conditions: cleaned, limit: 50, page: 1 };
  };

  const summarize = (input: SearchContactsInput): string => {
    if (!input.conditions.length) return "All contacts";
    return input.conditions
      .map((c) => {
        const f = FIELD_LABELS[c.field] ?? c.field;
        const op = OPERATOR_LABELS[c.operator] ?? c.operator;
        if (NO_VALUE_OPS.has(c.operator)) return `${f} ${op}`;
        let v = String(c.value ?? "");
        if (c.field === SearchConditionField.event) {
          v = events.find((e) => String(e.id) === v)?.name ?? v;
        } else if (c.field === SearchConditionField.employee) {
          v = users.find((u) => String(u.id) === v)?.name ?? v;
        }
        return `${f} ${op} "${v}"`;
      })
      .join(` ${input.combinator} `);
  };

  const runSearch = (input: SearchContactsInput) => {
    searchContacts.mutate(
      { data: input },
      {
        onSuccess: (res) => {
          onApplied(res, input, summarize(input));
          queryClient.invalidateQueries({ queryKey: getListRecentSearchesQueryKey() });
          onOpenChange(false);
        },
        onError: () => toast({ title: "Search failed", variant: "destructive" }),
      },
    );
  };

  const handleSearch = () => {
    const input = buildInput();
    if (!input.conditions.length) {
      toast({ title: "Add at least one condition", variant: "destructive" });
      return;
    }
    runSearch(input);
  };

  const loadInput = (payload: unknown) => {
    const p = (payload ?? {}) as Partial<SearchContactsInput>;
    setCombinator((p.combinator as SearchContactsInputCombinator) ?? SearchContactsInputCombinator.AND);
    setConditions(p.conditions?.length ? (p.conditions as SearchCondition[]) : [newCondition()]);
  };

  const handleSave = (kind: SavedSearchInputKind) => {
    const input = buildInput();
    if (!input.conditions.length) {
      toast({ title: "Add at least one condition first", variant: "destructive" });
      return;
    }
    const name = window.prompt(
      kind === SavedSearchInputKind.view ? "Name this view" : "Name this filter",
    );
    if (!name || !name.trim()) return;
    createSaved.mutate(
      { data: { name: name.trim(), kind, entityType: "contact", payload: input } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSavedSearchesQueryKey() });
          toast({ title: kind === SavedSearchInputKind.view ? "View saved" : "Filter saved" });
        },
        onError: () => toast({ title: "Could not save", variant: "destructive" }),
      },
    );
  };

  const handleDeleteSaved = (s: SavedSearch) => {
    deleteSaved.mutate(
      { id: s.id },
      {
        onSuccess: () =>
          queryClient.invalidateQueries({ queryKey: getListSavedSearchesQueryKey() }),
        onError: () => toast({ title: "Could not delete", variant: "destructive" }),
      },
    );
  };

  const handleApplySaved = (s: SavedSearch) => {
    loadInput(s.payload);
    runSearch({ ...(s.payload as SearchContactsInput), limit: 50, page: 1 });
  };

  const handleClearRecents = () => {
    clearRecents.mutate(
      {},
      {
        onSuccess: () =>
          queryClient.invalidateQueries({ queryKey: getListRecentSearchesQueryKey() }),
      },
    );
  };

  const filters = saved.filter((s) => s.kind === "filter");
  const views = saved.filter((s) => s.kind === "view");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Advanced Search</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Match</span>
            <Select value={combinator} onValueChange={(v) => setCombinator(v as SearchContactsInputCombinator)}>
              <SelectTrigger className="w-[90px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SearchContactsInputCombinator.AND}>ALL</SelectItem>
                <SelectItem value={SearchContactsInputCombinator.OR}>ANY</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-muted-foreground">of these conditions</span>
          </div>

          <div className="space-y-2">
            {conditions.map((c, idx) => (
              <div key={idx} className="flex flex-wrap items-center gap-2">
                <Select value={c.field} onValueChange={(v) => setField(idx, v)}>
                  <SelectTrigger className="w-[150px] h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(SearchConditionField).map((f) => (
                      <SelectItem key={f} value={f}>
                        {FIELD_LABELS[f] ?? f}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={c.operator}
                  onValueChange={(v) => update(idx, { operator: v as SearchCondition["operator"], value: NO_VALUE_OPS.has(v) ? null : c.value })}
                >
                  <SelectTrigger className="w-[160px] h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {operatorsFor(c.field).map((op) => (
                      <SelectItem key={op} value={op}>
                        {OPERATOR_LABELS[op] ?? op}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {!NO_VALUE_OPS.has(c.operator) &&
                  (c.field === SearchConditionField.event ? (
                    <Select value={String(c.value ?? "")} onValueChange={(v) => update(idx, { value: v })}>
                      <SelectTrigger className="flex-1 min-w-[160px] h-9">
                        <SelectValue placeholder="Select event" />
                      </SelectTrigger>
                      <SelectContent>
                        {events.map((e) => (
                          <SelectItem key={e.id} value={String(e.id)}>
                            {e.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : c.field === SearchConditionField.employee ? (
                    <Select value={String(c.value ?? "")} onValueChange={(v) => update(idx, { value: v })}>
                      <SelectTrigger className="flex-1 min-w-[160px] h-9">
                        <SelectValue placeholder="Select employee" />
                      </SelectTrigger>
                      <SelectContent>
                        {users.map((u) => (
                          <SelectItem key={u.id} value={String(u.id)}>
                            {u.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      className="flex-1 min-w-[160px] h-9"
                      placeholder="Value"
                      value={String(c.value ?? "")}
                      onChange={(e) => update(idx, { value: e.target.value })}
                    />
                  ))}

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 text-destructive"
                  onClick={() => setConditions((prev) => prev.filter((_, i) => i !== idx))}
                  disabled={conditions.length === 1}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setConditions((prev) => [...prev, newCondition()])}
          >
            <Plus className="h-4 w-4 mr-1" /> Add condition
          </Button>

          {(filters.length > 0 || views.length > 0) && (
            <div className="border-t pt-3 space-y-2">
              {filters.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
                    <Bookmark className="h-3 w-3" /> Saved Filters
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {filters.map((s) => (
                      <Badge
                        key={s.id}
                        variant="secondary"
                        className="cursor-pointer gap-1 py-1"
                        onClick={() => handleApplySaved(s)}
                      >
                        {s.name}
                        <X
                          className="h-3 w-3 hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteSaved(s);
                          }}
                        />
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {views.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
                    <Star className="h-3 w-3" /> Saved Views
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {views.map((s) => (
                      <Badge
                        key={s.id}
                        variant="outline"
                        className="cursor-pointer gap-1 py-1"
                        onClick={() => handleApplySaved(s)}
                      >
                        {s.name}
                        <X
                          className="h-3 w-3 hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteSaved(s);
                          }}
                        />
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {recents.length > 0 && (
            <div className="border-t pt-3">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Recent Searches
                </p>
                <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={handleClearRecents}>
                  Clear
                </Button>
              </div>
              <div className="flex flex-col gap-1">
                {recents.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="text-left text-xs text-muted-foreground hover:text-foreground truncate"
                    onClick={() => {
                      loadInput(r.payload);
                      runSearch({ ...(r.payload as SearchContactsInput), limit: 50, page: 1 });
                    }}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <div className="flex gap-2 mr-auto">
            <Button variant="outline" size="sm" onClick={() => handleSave(SavedSearchInputKind.filter)}>
              <Bookmark className="h-4 w-4 mr-1" /> Save filter
            </Button>
            <Button variant="outline" size="sm" onClick={() => handleSave(SavedSearchInputKind.view)}>
              <Star className="h-4 w-4 mr-1" /> Save view
            </Button>
          </div>
          <Button onClick={handleSearch} disabled={searchContacts.isPending}>
            <Search className="h-4 w-4 mr-1" /> Search
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
