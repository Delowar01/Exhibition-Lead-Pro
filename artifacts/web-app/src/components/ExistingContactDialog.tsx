import React from "react";
import type { ExistingContactFound } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Users, Mail, Building2, Calendar, Clock, ExternalLink, GitMerge, UserPlus, Loader2 } from "lucide-react";

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

interface Props {
  data: ExistingContactFound | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submitting?: boolean;
  onAddInteraction: (matchedContactId: number) => void;
  onCreateSeparate: () => void;
  onReview: (contactId: number) => void;
}

export function ExistingContactDialog({
  data,
  open,
  onOpenChange,
  submitting = false,
  onAddInteraction,
  onCreateSeparate,
  onReview,
}: Props) {
  if (!data) return null;

  const contact = data.contact;
  const matchedContactId = contact.id;
  const fullName = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "Unknown contact";
  const primaryMatch = data.matches[0];
  const lastInteraction = formatDate(data.lastInteractionDate);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" /> Existing contact found
          </DialogTitle>
          <DialogDescription>
            {data.message ||
              "A contact matching these details already exists. Choose how to proceed — nothing is merged automatically."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold text-base">{fullName}</div>
              {primaryMatch && (
                <Badge variant="outline" className="font-semibold">
                  {Math.round(primaryMatch.confidence)}% match
                </Badge>
              )}
            </div>
            {contact.jobTitle && (
              <div className="text-sm text-muted-foreground">{contact.jobTitle}</div>
            )}
            <div className="flex flex-col gap-1 text-sm text-muted-foreground">
              {contact.contactCompany && (
                <span className="flex items-center gap-2">
                  <Building2 className="h-3.5 w-3.5" /> {contact.contactCompany}
                </span>
              )}
              {contact.email && (
                <span className="flex items-center gap-2">
                  <Mail className="h-3.5 w-3.5" /> {contact.email}
                </span>
              )}
            </div>
            {primaryMatch?.reasons && primaryMatch.reasons.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {primaryMatch.reasons.map((r, i) => (
                  <Badge key={i} variant="secondary" className="text-[11px] font-normal">
                    {r}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-md border border-border p-3">
              <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" /> Interactions
              </div>
              <div className="font-semibold text-lg leading-tight mt-0.5">{data.interactionCount}</div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" /> Last interaction
              </div>
              <div className="font-medium mt-0.5">{lastInteraction ?? "—"}</div>
            </div>
          </div>

          {data.previousEvents && data.previousEvents.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">Previously captured at</div>
              <div className="flex flex-wrap gap-1.5">
                {data.previousEvents.map((ev, i) => (
                  <Badge key={i} variant="outline" className="gap-1">
                    <Calendar className="h-3 w-3" /> {ev}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          <Button
            className="w-full"
            onClick={() => onAddInteraction(matchedContactId)}
            disabled={submitting}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <GitMerge className="h-4 w-4 mr-2" />
            )}
            Add interaction to existing
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={onCreateSeparate}
            disabled={submitting}
          >
            <UserPlus className="h-4 w-4 mr-2" />
            Create separate contact
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => onReview(matchedContactId)}
            disabled={submitting}
          >
            <ExternalLink className="h-4 w-4 mr-2" />
            Review existing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
