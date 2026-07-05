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
            onClick={() => changeStage(s.key)}
            className="gap-2"
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color || "#94a3b8" }} />
            <span className="flex-1 truncate">{s.name}</span>
            {s.key === lead.stage && <Check className="h-3.5 w-3.5 opacity-70" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
