import React, { useState } from "react";
import { Building2, Calendar as CalendarIcon, GripVertical } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdateLead,
  getGetLeadPipelineQueryKey,
  type Lead,
  type PipelineStage,
  type PipelineStageConfig,
  type PipelineView,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  BRAND,
  companyName,
  displayName,
  formatMoney,
  moveLeadStage,
  PRIORITY_META,
  type StageMap,
} from "./utils";

interface KanbanBoardProps {
  view: PipelineView;
  stages: PipelineStageConfig[];
  stageMap: StageMap;
  selectMode: boolean;
  selectedIds: Set<number>;
  onToggleSelect: (id: number) => void;
  onOpenLead: (id: number) => void;
}

export function KanbanBoard({
  view,
  stages,
  selectMode,
  selectedIds,
  onToggleSelect,
  onOpenLead,
}: KanbanBoardProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const updateLead = useUpdateLead();
  const [draggedLeadId, setDraggedLeadId] = useState<number | null>(null);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);

  const handleDrop = (e: React.DragEvent, targetStageKey: string) => {
    e.preventDefault();
    setDragOverStage(null);
    const leadIdStr = e.dataTransfer.getData("leadId");
    setDraggedLeadId(null);
    if (!leadIdStr) return;
    const leadId = parseInt(leadIdStr, 10);
    if (!leadId) return;

    const key = getGetLeadPipelineQueryKey();
    const prev = qc.getQueryData<PipelineView>(key);
    if (prev) qc.setQueryData(key, moveLeadStage(prev, leadId, targetStageKey));

    updateLead.mutate(
      { id: leadId, data: { stage: targetStageKey as never } },
      {
        onError: () => {
          if (prev) qc.setQueryData(key, prev);
          toast({ title: "Update failed", description: "Could not move lead.", variant: "destructive" });
        },
        onSettled: () => qc.invalidateQueries({ queryKey: key }),
      }
    );
  };

  if (stages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-xl border-2 border-dashed border-border/50 text-sm text-muted-foreground">
        No pipeline stages configured. Configure stages in Pipeline Settings.
      </div>
    );
  }

  return (
    <div className="flex flex-1 gap-4 overflow-x-auto pb-4 pt-1">
      {stages.map((stage) => {
        const data: PipelineStage =
          view.stages.find((s) => s.stage === stage.key) || { stage: stage.key, leads: [], count: 0, value: 0 };
        const color = stage.color || BRAND.navy300;
        const isOver = dragOverStage === stage.key;
        return (
          <div
            key={stage.id}
            data-testid={`kanban-column-${stage.key}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragOverStage !== stage.key) setDragOverStage(stage.key);
            }}
            onDragLeave={() => setDragOverStage(null)}
            onDrop={(e) => handleDrop(e, stage.key)}
            className="flex w-80 flex-shrink-0 flex-col rounded-xl border transition-colors"
            style={{
              borderColor: isOver ? BRAND.orange : `${BRAND.navy}1a`,
              backgroundColor: isOver ? BRAND.orangeSoft : BRAND.navySoft,
            }}
          >
            <div className="flex items-center justify-between rounded-t-xl border-b px-3.5 py-3" style={{ borderColor: `${BRAND.navy}14` }}>
              <div className="flex min-w-0 items-center gap-2">
                <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
                <h3 className="truncate text-sm font-semibold" style={{ color: BRAND.navy }}>
                  <span className="dark:text-foreground">{stage.name}</span>
                </h3>
                <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {data.count}
                </span>
              </div>
              <span className="text-xs font-semibold" style={{ color: BRAND.orange }}>
                {formatMoney(data.value, undefined, { compact: true })}
              </span>
            </div>

            <div className="min-h-[400px] flex-1 space-y-2.5 overflow-y-auto p-2.5">
              {data.leads.map((lead: Lead) => {
                const isDragging = draggedLeadId === lead.id;
                const isSelected = selectedIds.has(lead.id);
                const pr = lead.priority ? PRIORITY_META[lead.priority] : null;
                const company = companyName(lead);
                const money = formatMoney(lead.value, lead.currency);
                return (
                  <div
                    key={lead.id}
                    data-testid={`kanban-card-${lead.id}`}
                    draggable={!selectMode}
                    onDragStart={(e) => {
                      if (selectMode) return;
                      e.dataTransfer.setData("leadId", lead.id.toString());
                      e.dataTransfer.effectAllowed = "move";
                      setDraggedLeadId(lead.id);
                    }}
                    onDragEnd={() => {
                      setDraggedLeadId(null);
                      setDragOverStage(null);
                    }}
                    onClick={() => (selectMode ? onToggleSelect(lead.id) : onOpenLead(lead.id))}
                    className={`group rounded-lg border bg-card p-3 shadow-sm transition-all ${
                      selectMode
                        ? `cursor-pointer ${isSelected ? "ring-2" : "hover:border-border"}`
                        : "cursor-pointer hover:shadow-md"
                    } ${isDragging ? "scale-95 opacity-40" : "opacity-100"}`}
                    style={{
                      borderColor: isSelected ? BRAND.orange : undefined,
                      boxShadow: isSelected ? `0 0 0 2px ${BRAND.orange}55` : undefined,
                    }}
                  >
                    <div className="mb-1.5 flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-1.5">
                        {selectMode ? (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => onToggleSelect(lead.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="mt-0.5 flex-shrink-0"
                            style={{ accentColor: BRAND.orange }}
                          />
                        ) : (
                          <GripVertical className="-ml-1 mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground/30 opacity-0 transition-opacity group-hover:opacity-100" />
                        )}
                        <span className="line-clamp-2 text-sm font-medium leading-tight">{displayName(lead)}</span>
                      </div>
                      {pr && <span className={`mt-1 h-2 w-2 flex-shrink-0 rounded-full ${pr.dot}`} />}
                    </div>
                    {company && (
                      <div className="mb-2 flex items-center gap-1.5 pl-5 text-xs text-muted-foreground">
                        <Building2 className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">{company}</span>
                      </div>
                    )}
                    <div className="mt-2 flex items-center justify-between border-t border-border/50 pl-1 pt-2">
                      <span className="text-sm font-bold" style={{ color: BRAND.navy }}>
                        <span className="dark:text-foreground">{money ?? "\u2014"}</span>
                      </span>
                      {lead.eventName && (
                        <span className="flex max-w-[120px] items-center gap-1 truncate rounded bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          <CalendarIcon className="h-2.5 w-2.5" />
                          {lead.eventName}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              {data.leads.length === 0 && (
                <div className="flex min-h-[100px] items-center justify-center rounded-lg border-2 border-dashed border-border/50 text-xs font-medium text-muted-foreground">
                  Drop leads here
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
