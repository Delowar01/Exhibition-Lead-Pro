import React, { useState } from "react";
import { Link } from "wouter";
import { useGetContactDuplicates, useMergeContacts, getGetContactDuplicatesQueryKey, type DuplicateGroup, type Contact } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CopyCheck, Mail, Phone, User, Merge, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const MATCH_LABELS: Record<string, { label: string; icon: React.ReactNode; className: string }> = {
  email: { label: "Same email", icon: <Mail className="h-3.5 w-3.5" />, className: "bg-blue-100 text-blue-700 border-blue-200" },
  phone: { label: "Same phone", icon: <Phone className="h-3.5 w-3.5" />, className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  name: { label: "Same name & company", icon: <User className="h-3.5 w-3.5" />, className: "bg-amber-100 text-amber-700 border-amber-200" },
};

function contactLabel(c: Contact): string {
  return c.fullName || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || `Contact #${c.id}`;
}

function DuplicateGroupCard({ group, onMerged }: { group: DuplicateGroup; onMerged: () => void }) {
  const { toast } = useToast();
  const merge = useMergeContacts();
  const [primaryId, setPrimaryId] = useState<number>(group.contacts[0]?.id ?? 0);
  const match = MATCH_LABELS[group.matchType] ?? MATCH_LABELS.name;

  const handleMerge = () => {
    const duplicateIds = group.contacts.map((c) => c.id).filter((id) => id !== primaryId);
    if (duplicateIds.length === 0) return;
    if (!confirm(`Merge ${duplicateIds.length} duplicate(s) into "${contactLabel(group.contacts.find((c) => c.id === primaryId)!)}"? The other records will be permanently removed and their scans/leads reassigned.`)) return;
    merge.mutate({ data: { primaryId, duplicateIds } }, {
      onSuccess: () => {
        toast({ title: "Contacts merged", description: `${duplicateIds.length} duplicate(s) consolidated.` });
        onMerged();
      },
      onError: () => toast({ title: "Merge failed", description: "Please try again.", variant: "destructive" }),
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={`gap-1 ${match.className}`}>{match.icon} {match.label}</Badge>
            <span className="text-sm text-muted-foreground">{group.contacts.length} contacts</span>
          </div>
          <Button size="sm" onClick={handleMerge} disabled={merge.isPending}>
            <Merge className="h-4 w-4 mr-2" /> {merge.isPending ? "Merging..." : "Merge selected"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">Choose which record to keep as the primary. Empty fields on the primary will be filled in from the others.</p>
        {group.contacts.map((c) => (
          <label key={c.id} className={`flex items-center gap-3 rounded-md border p-3 cursor-pointer transition-colors ${primaryId === c.id ? "border-primary bg-primary/5" : "border-border hover:bg-accent/40"}`}>
            <input type="radio" name={`primary-${group.matchType}-${group.matchValue}`} checked={primaryId === c.id} onChange={() => setPrimaryId(c.id)} className="accent-primary" />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{contactLabel(c)}{primaryId === c.id && <Badge variant="secondary" className="ml-2 text-xs">Keep</Badge>}</div>
              <div className="text-xs text-muted-foreground truncate">
                {[c.jobTitle, c.contactCompany].filter(Boolean).join(" · ") || "—"}
              </div>
              <div className="text-xs text-muted-foreground truncate">{[c.email, c.mobile].filter(Boolean).join(" · ") || "No contact info"}</div>
            </div>
            <Link href={`/admin/contacts/${c.id}`} className="text-muted-foreground hover:text-foreground shrink-0" title="Open contact">
              <ChevronRight className="h-4 w-4" />
            </Link>
          </label>
        ))}
      </CardContent>
    </Card>
  );
}

export default function AdminDuplicates() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetContactDuplicates({ query: { queryKey: getGetContactDuplicatesQueryKey() } });

  const refetch = () => queryClient.invalidateQueries({ queryKey: getGetContactDuplicatesQueryKey() });

  const groups = data?.groups ?? [];

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3"><CopyCheck className="h-7 w-7 text-primary" /> Duplicate Contacts</h1>
        <p className="text-muted-foreground mt-1">AI-assisted detection of likely duplicate contacts in your database. Review each group and merge to keep your CRM clean.</p>
      </div>

      {isLoading ? (
        <div className="p-8 flex justify-center text-muted-foreground">Scanning for duplicates...</div>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <CopyCheck className="h-10 w-10 text-emerald-500" />
            <div className="font-semibold text-lg">No duplicates found</div>
            <p className="text-muted-foreground text-sm max-w-md">Your contact database looks clean — no contacts share an email, phone number, or name &amp; company.</p>
            <Link href="/admin/contacts"><Button variant="outline" className="mt-2">Back to Contacts</Button></Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="text-sm text-muted-foreground">{groups.length} potential duplicate {groups.length === 1 ? "group" : "groups"} detected.</div>
          {groups.map((group, i) => (
            <DuplicateGroupCard key={`${group.matchType}-${group.matchValue}-${i}`} group={group} onMerged={refetch} />
          ))}
        </div>
      )}
    </div>
  );
}
