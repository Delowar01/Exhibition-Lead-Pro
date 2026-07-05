import { useState } from "react";
import { X, UserCheck, ArrowRightLeft, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useBulkAssignLeads,
  useUpdateLead,
  useDeleteLead,
  getGetLeadPipelineQueryKey,
  BulkAssignInputStrategy,
  type User,
  type Team,
  type PipelineStageConfig,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { BRAND } from "./utils";

const STRATEGY_LABELS: Record<BulkAssignInputStrategy, string> = {
  manual: "Manual (pick owner)",
  round_robin: "Round-robin",
  load_balanced: "Load-balanced",
  availability: "Availability",
  territory: "Territory",
  ai: "AI recommendation",
};

const TEAM_REQUIRED = ["round_robin", "load_balanced", "availability"];

interface BulkBarProps {
  selectedIds: Set<number>;
  users: User[];
  teams: Team[];
  stages: PipelineStageConfig[];
  onClear: () => void;
}

export function BulkBar({ selectedIds, users, teams, stages, onClear }: BulkBarProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const bulkAssign = useBulkAssignLeads();
  const updateLead = useUpdateLead();
  const deleteLead = useDeleteLead();

  const [mode, setMode] = useState<"assign" | "stage">("assign");
  const [strategy, setStrategy] = useState<BulkAssignInputStrategy>(BulkAssignInputStrategy.round_robin);
  const [owner, setOwner] = useState("");
  const [team, setTeam] = useState("");
  const [stageKey, setStageKey] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [working, setWorking] = useState(false);

  const count = selectedIds.size;
  const teamRequired = TEAM_REQUIRED.includes(strategy);
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetLeadPipelineQueryKey() });

  const runAssign = () => {
    const leadIds = [...selectedIds];
    if (leadIds.length === 0) return;
    if (strategy === "manual" && !owner) {
      toast({ title: "Pick an owner", description: "Manual assignment needs a target owner.", variant: "destructive" });
      return;
    }
    if (teamRequired && !team) {
      toast({ title: "Pick a team", description: "This strategy requires a team.", variant: "destructive" });
      return;
    }
    bulkAssign.mutate(
      {
        data: {
          leadIds,
          strategy,
          assignedToId: strategy === "manual" && owner ? parseInt(owner, 10) : null,
          // Manual with no team must OMIT teamId (undefined) — an explicit null
          // is treated as a set and would clear each lead's team binding.
          teamId: team ? parseInt(team, 10) : strategy === "manual" ? undefined : null,
        },
      },
      {
        onSuccess: (res) => {
          invalidate();
          toast({
            title: `Assigned ${res.assigned} lead(s)`,
            description: res.failed > 0 ? `${res.failed} could not be assigned.` : undefined,
            variant: res.failed > 0 ? "destructive" : undefined,
          });
          onClear();
        },
        onError: () => toast({ title: "Bulk assign failed", variant: "destructive" }),
      }
    );
  };

  const runStageChange = async () => {
    const leadIds = [...selectedIds];
    if (leadIds.length === 0 || !stageKey) {
      toast({ title: "Pick a stage", variant: "destructive" });
      return;
    }
    setWorking(true);
    const results = await Promise.allSettled(
      leadIds.map((id) => updateLead.mutateAsync({ id, data: { stage: stageKey as never } }))
    );
    setWorking(false);
    const failed = results.filter((r) => r.status === "rejected").length;
    invalidate();
    toast({
      title: `Updated ${leadIds.length - failed} lead(s)`,
      description: failed > 0 ? `${failed} could not be updated.` : undefined,
      variant: failed > 0 ? "destructive" : undefined,
    });
    onClear();
  };

  const runDelete = async () => {
    const leadIds = [...selectedIds];
    setConfirmDelete(false);
    setWorking(true);
    const results = await Promise.allSettled(leadIds.map((id) => deleteLead.mutateAsync({ id })));
    setWorking(false);
    const failed = results.filter((r) => r.status === "rejected").length;
    invalidate();
    toast({
      title: `Deleted ${leadIds.length - failed} lead(s)`,
      description: failed > 0 ? `${failed} could not be deleted.` : undefined,
      variant: failed > 0 ? "destructive" : undefined,
    });
    onClear();
  };

  return (
    <div
      data-testid="bulk-bar"
      className="flex flex-shrink-0 flex-wrap items-center gap-2.5 rounded-xl border p-3 text-white"
      style={{ backgroundColor: BRAND.navy, borderColor: BRAND.navy }}
    >
      <span className="whitespace-nowrap text-sm font-semibold">{count} selected</span>
      <div className="flex overflow-hidden rounded-md border border-white/20">
        <button
          type="button"
          onClick={() => setMode("assign")}
          className={`px-3 py-1 text-xs font-medium ${mode === "assign" ? "text-white" : "text-white/60"}`}
          style={{ backgroundColor: mode === "assign" ? BRAND.orange : "transparent" }}
        >
          Assign
        </button>
        <button
          type="button"
          onClick={() => setMode("stage")}
          className={`px-3 py-1 text-xs font-medium ${mode === "stage" ? "text-white" : "text-white/60"}`}
          style={{ backgroundColor: mode === "stage" ? BRAND.orange : "transparent" }}
        >
          Move stage
        </button>
      </div>

      {mode === "assign" ? (
        <>
          <Select value={strategy} onValueChange={(v) => setStrategy(v as BulkAssignInputStrategy)}>
            <SelectTrigger className="h-8 w-[190px] border-white/20 bg-white/10 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.values(BulkAssignInputStrategy).map((s) => (
                <SelectItem key={s} value={s}>
                  {STRATEGY_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {strategy === "manual" ? (
            <Select value={owner} onValueChange={setOwner}>
              <SelectTrigger className="h-8 w-[170px] border-white/20 bg-white/10 text-white">
                <SelectValue placeholder="Owner" />
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id.toString()}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Select value={team} onValueChange={setTeam}>
              <SelectTrigger className="h-8 w-[170px] border-white/20 bg-white/10 text-white">
                <SelectValue placeholder={teamRequired ? "Team (required)" : "Team (optional)"} />
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
          <Button
            size="sm"
            onClick={runAssign}
            disabled={count === 0 || bulkAssign.isPending}
            className="h-8 text-white hover:opacity-90"
            style={{ backgroundColor: BRAND.orange }}
          >
            <UserCheck className="mr-1.5 h-3.5 w-3.5" />
            {bulkAssign.isPending ? "Assigning..." : "Assign"}
          </Button>
        </>
      ) : (
        <>
          <Select value={stageKey} onValueChange={setStageKey}>
            <SelectTrigger className="h-8 w-[190px] border-white/20 bg-white/10 text-white">
              <SelectValue placeholder="Target stage" />
            </SelectTrigger>
            <SelectContent>
              {stages.map((s) => (
                <SelectItem key={s.id} value={s.key}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={runStageChange}
            disabled={count === 0 || working}
            className="h-8 text-white hover:opacity-90"
            style={{ backgroundColor: BRAND.orange }}
          >
            <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />
            {working ? "Moving..." : "Move"}
          </Button>
        </>
      )}

      <div className="ml-auto flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfirmDelete(true)}
          disabled={count === 0 || working}
          className="h-8 text-white/80 hover:bg-red-500/20 hover:text-white"
          data-testid="button-bulk-delete"
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Delete
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClear}
          className="h-8 text-white/80 hover:bg-white/10 hover:text-white"
          data-testid="button-clear-selection"
        >
          <X className="mr-1.5 h-3.5 w-3.5" />
          Clear
        </Button>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {count} lead(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected leads. Associated scans and contacts are not deleted. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runDelete} className="bg-red-600 hover:bg-red-700">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
