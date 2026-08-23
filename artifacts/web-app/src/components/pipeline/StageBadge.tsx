import { useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdateLead,
  getGetLeadPipelineQueryKey,
  getGetLeadQueryKey,
  type Lead,
  type PipelineStageConfig,
  type PipelineView,
} from "@workspace/api-client-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { cn } from "@/lib/utils";
import { moveLeadStage, stageColor, stageLabel, type StageMap } from "./utils";

interface StageBadgeProps {
  lead: Lead;
  stageMap: StageMap;
  stages: PipelineStageConfig[];
  size?: "sm" | "md";
  className?: string;
}

export function StageBadge({ lead, stageMap, stages, size = "sm", className }: StageBadgeProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const updateLead = useUpdateLead();
  const [open, setOpen] = useState(false);

  const color = stageColor(lead.stage, stageMap);
  const label = stageLabel(lead, stageMap);
  const displayLabel = lead.contactName || lead.title || "This lead";

  // Closing (→ won/lost) and reopening (won/lost → open) are confirmed first;
  // ordinary open→open moves stay immediate. Same rule as Lead Detail.
  const [confirmStage, setConfirmStage] = useState<PipelineStageConfig | null>(null);

  const isClosedKey = (key: string): boolean => {
    const s = stages.find((x) => x.key === key);
    return s ? s.isWon || s.isLost : key === "won" || key === "lost";
  };

  const requestStage = (toStage: string) => {
    if (toStage === lead.stage) return;
    const target = stages.find((s) => s.key === toStage);
    if (target && (target.isWon || target.isLost || isClosedKey(lead.stage))) {
      setConfirmStage(target);
      return;
    }
    changeStage(toStage);
  };

  const changeStage = (toStage: string) => {
    if (toStage === lead.stage) return;
    const pipelineKey = getGetLeadPipelineQueryKey();
    const leadKey = getGetLeadQueryKey(lead.id);
    const prevPipeline = qc.getQueryData<PipelineView>(pipelineKey);
    const prevLead = qc.getQueryData<Lead>(leadKey);

    if (prevPipeline) qc.setQueryData(pipelineKey, moveLeadStage(prevPipeline, lead.id, toStage));
    if (prevLead) qc.setQueryData(leadKey, { ...prevLead, stage: toStage as Lead["stage"] });

    updateLead.mutate(
      { id: lead.id, data: { stage: toStage as never } },
      {
        onError: () => {
          if (prevPipeline) qc.setQueryData(pipelineKey, prevPipeline);
          if (prevLead) qc.setQueryData(leadKey, prevLead);
          toast({ title: "Update failed", description: "Could not change the stage.", variant: "destructive" });
        },
        onSettled: () => {
          qc.invalidateQueries({ queryKey: pipelineKey });
          qc.invalidateQueries({ queryKey: leadKey });
        },
      }
    );
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={`badge-stage-${lead.id}`}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border font-medium transition-colors hover:brightness-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
            size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
            className
          )}
          style={{
            backgroundColor: `${color}1a`,
            borderColor: `${color}55`,
            color,
          }}
        >
          <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
          <span className="truncate max-w-[9rem]">{label}</span>
          <ChevronDown className="h-3 w-3 flex-shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52" onClick={(e) => e.stopPropagation()}>
        {stages.map((s) => (
          <DropdownMenuItem
            key={s.id}
            data-testid={`stage-option-${lead.id}-${s.key}`}
            onClick={() => requestStage(s.key)}
            className="gap-2"
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color || "#94a3b8" }} />
            <span className="flex-1 truncate">{s.name}</span>
            {s.key === lead.stage && <Check className="h-3.5 w-3.5 opacity-70" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>

      <AlertDialog open={confirmStage !== null} onOpenChange={(o) => !o && setConfirmStage(null)}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()} data-testid={`stage-confirm-${lead.id}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmStage?.isWon
                ? "Mark this opportunity as Won?"
                : confirmStage?.isLost
                  ? "Mark this opportunity as Lost?"
                  : "Reopen this opportunity?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmStage?.isWon &&
                `${displayLabel} moves to ${confirmStage.name} and is recorded as Closed Won. History and the linked contact stay intact.`}
              {confirmStage?.isLost &&
                `${displayLabel} moves to ${confirmStage?.name} and is recorded as Closed Lost, leaving the open pipeline total.`}
              {confirmStage && !confirmStage.isWon && !confirmStage.isLost &&
                `${displayLabel} returns to the ${confirmStage.name} stage and counts toward the open pipeline again. Win/loss history is preserved.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`stage-confirm-cancel-${lead.id}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid={`stage-confirm-ok-${lead.id}`}
              onClick={() => {
                if (confirmStage) changeStage(confirmStage.key);
                setConfirmStage(null);
              }}
              className={
                confirmStage?.isLost ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined
              }
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DropdownMenu>
  );
}
