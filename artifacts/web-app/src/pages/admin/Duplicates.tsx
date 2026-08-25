import React, { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useGetContactDuplicates,
  useMergeContacts,
  useListMergeHistory,
  useUndoContactMerge,
  getGetContactDuplicatesQueryKey,
  getListMergeHistoryQueryKey,
  type DuplicateGroup,
  type Contact,
  type MergeHistoryEntry,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CopyCheck, Merge, ChevronRight, Undo2, History as HistoryIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format, parseISO } from "date-fns";

// Fields the merge UI lets you resolve when duplicates disagree. Mirrors the
// server's MERGE_OVERRIDABLE_FIELDS whitelist.
const CONFLICT_FIELDS: Array<{ key: keyof Contact; label: string }> = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "fullName", label: "Full name" },
  { key: "email", label: "Email" },
  { key: "mobile", label: "Mobile" },
  { key: "jobTitle", label: "Job title" },
  { key: "contactCompany", label: "Company" },
  { key: "website", label: "Website" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "industry", label: "Industry" },
  { key: "country", label: "Country" },
];

function contactLabel(c: Contact): string {
  return c.fullName || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || `Contact #${c.id}`;
}

function scoreClass(score: number): string {
  if (score >= 90) return "bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900";
  if (score >= 70) return "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900";
  return "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800/60 dark:text-slate-300 dark:border-slate-700";
}

function DuplicateGroupCard({ group, onMerged }: { group: DuplicateGroup; onMerged: () => void }) {
  const { toast } = useToast();
  const merge = useMergeContacts();
  const [primaryId, setPrimaryId] = useState<number>(group.contacts[0]?.id ?? 0);
  // Per-field override choices (only set when the user picks a specific record's value).
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({});

  const primary = group.contacts.find((c) => c.id === primaryId) ?? group.contacts[0];

  // A field is "in conflict" when at least two records have differing non-empty values.
  const conflicts = useMemo(() => {
    return CONFLICT_FIELDS.filter(({ key }) => {
      const values = group.contacts
        .map((c) => c[key])
        .filter((v) => v != null && String(v).trim() !== "");
      return new Set(values.map((v) => String(v))).size > 1;
    });
  }, [group.contacts]);

  const handleMerge = () => {
    const duplicateIds = group.contacts.map((c) => c.id).filter((id) => id !== primaryId);
    if (duplicateIds.length === 0) return;
    if (!confirm(`Merge ${duplicateIds.length} duplicate(s) into "${contactLabel(primary)}"? The other records will be removed and their scans/leads/tasks reassigned. You can undo this from Merge History.`)) return;
    merge.mutate(
      { data: { primaryId, duplicateIds, fieldValues: Object.keys(fieldValues).length ? fieldValues : undefined } },
      {
        onSuccess: () => {
          toast({ title: "Contacts merged", description: `${duplicateIds.length} duplicate(s) consolidated.` });
          onMerged();
        },
        onError: () => toast({ title: "Merge failed", description: "Please try again.", variant: "destructive" }),
      }
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={`gap-1 ${scoreClass(group.score)}`}>
              {group.score}% match
            </Badge>
            <span className="text-sm text-muted-foreground">{group.contacts.length} contacts</span>
          </div>
          <Button size="sm" onClick={handleMerge} disabled={merge.isPending}>
            <Merge className="h-4 w-4 mr-2" /> {merge.isPending ? "Merging..." : "Merge selected"}
          </Button>
        </div>
        {group.reasons.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {group.reasons.map((r, i) => (
              <Badge key={i} variant="secondary" className="text-xs font-normal">
                {r}
              </Badge>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Choose which record to keep as the primary. Empty fields on the primary are filled in from the others.
        </p>
        {group.contacts.map((c) => (
          <label
            key={c.id}
            className={`flex items-center gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
              primaryId === c.id ? "border-primary bg-primary/5" : "border-border hover:bg-accent/40"
            }`}
          >
            <input
              type="radio"
              name={`primary-${group.matchType}-${group.matchValue}`}
              checked={primaryId === c.id}
              onChange={() => setPrimaryId(c.id)}
              className="accent-primary"
            />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">
                {contactLabel(c)}
                {primaryId === c.id && (
                  <Badge variant="secondary" className="ml-2 text-xs">
                    Keep
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {[c.jobTitle, c.contactCompany].filter(Boolean).join(" · ") || "—"}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {[c.email, c.mobile].filter(Boolean).join(" · ") || "No contact info"}
              </div>
            </div>
            <Link href={`/admin/contacts/${c.id}`} className="text-muted-foreground hover:text-foreground shrink-0" title="Open contact">
              <ChevronRight className="h-4 w-4" />
            </Link>
          </label>
        ))}

        {conflicts.length > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3 space-y-2">
            <p className="text-xs font-semibold text-amber-800">Resolve conflicting fields</p>
            <p className="text-[11px] text-amber-700/80">
              These fields differ across records. Pick the winning value, or leave to keep the primary's.
            </p>
            {conflicts.map(({ key, label }) => {
              const options = Array.from(
                new Map(
                  group.contacts
                    .map((c) => c[key])
                    .filter((v) => v != null && String(v).trim() !== "")
                    .map((v) => [String(v), v])
                ).values()
              );
              const current =
                key in fieldValues ? String(fieldValues[key as string]) : String(primary?.[key] ?? "");
              return (
                <div key={String(key)} className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium w-24 shrink-0">{label}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {options.map((opt) => {
                      const selected = current === String(opt);
                      return (
                        <button
                          key={String(opt)}
                          type="button"
                          onClick={() =>
                            setFieldValues((prev) => ({ ...prev, [key as string]: opt }))
                          }
                          className={`text-xs px-2 py-1 rounded border transition-colors ${
                            selected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-background hover:bg-accent"
                          }`}
                        >
                          {String(opt)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MergeHistoryPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useListMergeHistory();
  const undo = useUndoContactMerge();

  const entries = data?.entries ?? [];

  const handleUndo = (entry: MergeHistoryEntry) => {
    if (!confirm(`Undo this merge? ${entry.mergedIds.length} merged-away contact(s) will be restored along with their scans, leads and tasks.`)) return;
    undo.mutate(
      { id: entry.id },
      {
        onSuccess: (res) => {
          toast({ title: "Merge undone", description: `${res.restoredIds.length} contact(s) restored.` });
          queryClient.invalidateQueries({ queryKey: getListMergeHistoryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetContactDuplicatesQueryKey() });
        },
        onError: (e: any) =>
          toast({ title: "Undo failed", description: e?.message || "Please try again.", variant: "destructive" }),
      }
    );
  };

  if (isLoading) return <div className="p-8 flex justify-center text-muted-foreground">Loading merge history...</div>;
  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 flex flex-col items-center text-center gap-2">
          <HistoryIcon className="h-10 w-10 text-muted-foreground" />
          <div className="font-semibold text-lg">No merges yet</div>
          <p className="text-muted-foreground text-sm max-w-md">Merged contacts will appear here, where you can review or undo them.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <Card key={entry.id}>
          <CardContent className="py-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="font-medium text-sm">
                Merged {entry.mergedIds.length} contact(s) into #{entry.primaryId}
                {entry.undoneAt && (
                  <Badge variant="secondary" className="ml-2 text-xs">
                    Undone
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {format(parseISO(entry.createdAt), "PPp")}
                {entry.performedByName ? ` · by ${entry.performedByName}` : ""}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleUndo(entry)}
              disabled={!!entry.undoneAt || undo.isPending}
            >
              <Undo2 className="h-4 w-4 mr-2" /> Undo
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function AdminDuplicates() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetContactDuplicates({ query: { queryKey: getGetContactDuplicatesQueryKey() } });

  const refetch = () => {
    queryClient.invalidateQueries({ queryKey: getGetContactDuplicatesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListMergeHistoryQueryKey() });
  };

  const groups = data?.groups ?? [];

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3">
          <CopyCheck className="h-7 w-7 text-primary" /> Duplicate Contacts
        </h1>
        <p className="text-muted-foreground mt-1">
          Explainable detection of likely duplicate contacts — matched on email, phone, LinkedIn, website, and name similarity. Review each group and merge to keep your CRM clean.
        </p>
      </div>

      <Tabs defaultValue="duplicates">
        <TabsList>
          <TabsTrigger value="duplicates">Duplicates</TabsTrigger>
          <TabsTrigger value="history">Merge History</TabsTrigger>
        </TabsList>

        <TabsContent value="duplicates" className="mt-4">
          {isLoading ? (
            <div className="p-8 flex justify-center text-muted-foreground">Scanning for duplicates...</div>
          ) : groups.length === 0 ? (
            <Card>
              <CardContent className="py-12 flex flex-col items-center text-center gap-2">
                <CopyCheck className="h-10 w-10 text-emerald-500" />
                <div className="font-semibold text-lg">No duplicates found</div>
                <p className="text-muted-foreground text-sm max-w-md">
                  Your contact database looks clean — no contacts share an email, phone, LinkedIn, website, or a similar name &amp; company.
                </p>
                <Link href="/admin/contacts">
                  <Button variant="outline" className="mt-2">
                    Back to Contacts
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground">
                {groups.length} potential duplicate {groups.length === 1 ? "group" : "groups"} detected.
              </div>
              {groups.map((group, i) => (
                <DuplicateGroupCard key={`${group.matchType}-${group.matchValue}-${i}`} group={group} onMerged={refetch} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <MergeHistoryPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
