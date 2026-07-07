import React, { useState } from "react";
import {
  useListLeadTags,
  useAttachLeadTag,
  useDetachLeadTag,
  useListTags,
  useAssignLead,
  useRecommendLeadAssignee,
  useListUsers,
  useListTeams,
  AssignLeadInputStrategy,
  type AssigneeRecommendation,
  getListLeadTagsQueryKey,
  getGetLeadQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { X, User as UserIcon, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function TagsCard({ leadId }: { leadId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: leadTags } = useListLeadTags(leadId, {
    query: { enabled: !!leadId, queryKey: getListLeadTagsQueryKey(leadId) },
  });
  const { data: allTags } = useListTags();
  const attachTag = useAttachLeadTag();
  const detachTag = useDetachLeadTag();
  const [selectedTag, setSelectedTag] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListLeadTagsQueryKey(leadId) });

  const attached = leadTags?.tags ?? [];
  const attachedIds = new Set(attached.map((t) => t.id));
  const available = (allTags?.tags ?? []).filter((t) => !attachedIds.has(t.id));

  const handleAttach = () => {
    const tagId = parseInt(selectedTag, 10);
    if (!tagId) return;
    attachTag.mutate(
      { id: leadId, data: { tagId } },
      {
        onSuccess: () => {
          setSelectedTag("");
          invalidate();
        },
        onError: () => toast({ title: "Could not attach tag", variant: "destructive" }),
      }
    );
  };

  const handleDetach = (tagId: number) => {
    detachTag.mutate(
      { id: leadId, tagId },
      {
        onSuccess: invalidate,
        onError: () => toast({ title: "Could not remove tag", variant: "destructive" }),
      }
    );
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3 border-b border-border mb-3">
        <CardTitle className="text-base">Tags</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {attached.length === 0 && (
            <p className="text-sm text-muted-foreground">No tags attached.</p>
          )}
          {attached.map((tag) => (
            <Badge
              key={tag.id}
              variant="secondary"
              className="font-normal text-xs flex items-center gap-1"
              style={
                tag.color
                  ? { backgroundColor: `${tag.color}20`, color: tag.color }
                  : undefined
              }
            >
              {tag.name}
              <button onClick={() => handleDetach(tag.id)} className="hover:opacity-70">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
        {available.length > 0 && (
          <div className="flex items-center gap-2">
            <Select value={selectedTag} onValueChange={setSelectedTag}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Add tag..." />
              </SelectTrigger>
              <SelectContent>
                {available.map((tag) => (
                  <SelectItem key={tag.id} value={tag.id.toString()}>
                    {tag.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={handleAttach} disabled={!selectedTag}>
              Add
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function AssignmentCard({
  lead,
  leadId,
}: {
  lead: { assignedToId?: number | null; assignedToName?: string | null; teamId?: number | null; teamName?: string | null };
  leadId: number;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: usersData } = useListUsers({ limit: 200 });
  const { data: teamsData } = useListTeams();
  const assignLead = useAssignLead();
  const recommend = useRecommendLeadAssignee();
  const [owner, setOwner] = useState<string>(lead.assignedToId ? lead.assignedToId.toString() : "");
  const [strategy, setStrategy] = useState<AssignLeadInputStrategy>(AssignLeadInputStrategy.manual);
  const [teamId, setTeamId] = useState<string>(lead.teamId ? lead.teamId.toString() : "");
  const [rec, setRec] = useState<AssigneeRecommendation | null>(null);

  const users = usersData?.users ?? [];
  const teams = teamsData?.teams ?? [];
  const teamRequired = strategy === "load_balanced" || strategy === "availability";

  const STRATEGY_LABELS: Record<AssignLeadInputStrategy, string> = {
    manual: "Manual (pick owner)",
    round_robin: "Round-robin",
    load_balanced: "Load-balanced",
    availability: "Availability",
    territory: "Territory",
    ai: "AI recommendation",
  };

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });

  const handleAssign = (val: string) => {
    setOwner(val === "unassigned" ? "" : val);
    const assignedToId = val && val !== "unassigned" ? parseInt(val, 10) : null;
    assignLead.mutate(
      { id: leadId, data: { assignedToId, teamId: lead.teamId ?? null, strategy: "manual" } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Lead reassigned" });
        },
        onError: () => toast({ title: "Could not reassign", variant: "destructive" }),
      }
    );
  };

  const handleStrategyAssign = () => {
    const parsedTeam = teamId ? parseInt(teamId, 10) : (lead.teamId ?? null);
    assignLead.mutate(
      { id: leadId, data: { strategy, teamId: parsedTeam } },
      {
        onSuccess: () => {
          invalidate();
          setRec(null);
          toast({ title: `Assigned via ${STRATEGY_LABELS[strategy].toLowerCase()}` });
        },
        onError: (e: any) =>
          toast({
            title: "Could not assign",
            description: e?.message || "Check the strategy requirements (a team may be required).",
            variant: "destructive",
          }),
      }
    );
  };

  const handleRecommend = () => {
    const parsedTeam = teamId ? parseInt(teamId, 10) : (lead.teamId ?? null);
    recommend.mutate(
      { id: leadId, data: { teamId: parsedTeam } },
      {
        onSuccess: (data) => setRec(data),
        onError: (e: any) =>
          toast({
            title: "No recommendation",
            description: e?.message || "Could not compute a recommendation.",
            variant: "destructive",
          }),
      }
    );
  };

  const applyRecommendation = () => {
    if (!rec) return;
    setOwner(rec.assignedToId.toString());
    assignLead.mutate(
      { id: leadId, data: { assignedToId: rec.assignedToId, teamId: teamId ? parseInt(teamId, 10) : (lead.teamId ?? null), strategy: "manual" } },
      {
        onSuccess: () => {
          invalidate();
          setRec(null);
          toast({ title: "Recommendation applied" });
        },
        onError: () => toast({ title: "Could not assign", variant: "destructive" }),
      }
    );
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3 border-b border-border mb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <UserIcon className="h-4 w-4 text-primary" /> Assignment
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground mb-1">Owner</p>
          <Select value={owner || "unassigned"} onValueChange={handleAssign}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Unassigned" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id.toString()}>
                  {u.name} {u.role === "platform_owner" ? "(Admin)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="pt-4 border-t border-border">
          <p className="text-sm font-medium text-muted-foreground mb-3">Auto-Assign Strategy</p>
          <div className="space-y-3">
            <Select value={strategy} onValueChange={(v) => setStrategy(v as AssignLeadInputStrategy)}>
              <SelectTrigger>
                <SelectValue placeholder="Select strategy" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(STRATEGY_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {teamRequired && (
              <Select value={teamId} onValueChange={setTeamId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a team (required)" />
                </SelectTrigger>
                <SelectContent>
                  {teams.map((t) => (
                    <SelectItem key={t.id} value={t.id.toString()}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {strategy === "ai" ? (
              <Button onClick={handleRecommend} disabled={recommend.isPending} className="w-full">
                <Sparkles className="h-4 w-4 mr-2" /> Get Recommendation
              </Button>
            ) : (
              <Button
                onClick={handleStrategyAssign}
                disabled={assignLead.isPending || strategy === "manual" || (teamRequired && !teamId)}
                className="w-full"
                variant="secondary"
              >
                Auto-Assign Now
              </Button>
            )}
          </div>
        </div>

        {rec && (
          <div className="mt-3 p-3 bg-primary/10 border border-primary/20 rounded-md space-y-2">
            <p className="text-sm font-medium">Recommended: {rec.assignedToName}</p>
            <p className="text-xs text-muted-foreground">{rec.reasoning}</p>
            <Button size="sm" onClick={applyRecommendation} className="w-full mt-2" disabled={assignLead.isPending}>
              Apply Recommendation
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
