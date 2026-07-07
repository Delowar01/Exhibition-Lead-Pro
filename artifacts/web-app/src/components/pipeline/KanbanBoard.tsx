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
import { StageBadge } from "./StageBadge";
import {
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
  stageMap,
  selectMode,
  selectedIds,
  onToggleSelect,
  onOpenLead,
}: KanbanBoardProps) {
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
        const color = stage.color || "var(--color-primary)";
        return (
          <div
            key={stage.id}
            data-testid={`kanban-column-${stage.key}`}
            className="flex w-[340px] flex-shrink-0 flex-col rounded-xl border bg-muted/20 border-border"
          >
            <div className="flex items-center justify-between border-b bg-card/50 px-3.5 py-3 rounded-t-xl">
              <div className="flex min-w-0 items-center gap-2">
                <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
                <h3 className="truncate text-sm font-semibold">
                  <span className="text-foreground">{stage.name}</span>
                </h3>
                <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {data.count}
                </span>
              </div>
              <span className="text-xs font-semibold text-primary">
                {formatMoney(data.value, undefined, { compact: true })}
              </span>
            </div>

            <div className="min-h-[400px] flex-1 space-y-2.5 overflow-y-auto p-2.5">
              {data.leads.map((lead: Lead) => {
                const isSelected = selectedIds.has(lead.id);
                const pr = lead.priority ? PRIORITY_META[lead.priority] : null;
                const company = companyName(lead);
                const money = formatMoney(lead.value, lead.currency);
                return (
                  <div
                    key={lead.id}
                    data-testid={`kanban-card-${lead.id}`}
                    onClick={() => (selectMode ? onToggleSelect(lead.id) : onOpenLead(lead.id))}
                    className={`group relative flex flex-col rounded-xl border bg-card p-3.5 shadow-sm transition-all ${
                      selectMode
                        ? `cursor-pointer ${isSelected ? "border-primary ring-1 ring-primary" : "hover:border-border"}`
                        : "cursor-pointer hover:shadow-md hover:border-primary/50"
                    }`}
                  >
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-2">
                        {selectMode && (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => onToggleSelect(lead.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="mt-1 flex-shrink-0 accent-primary"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="line-clamp-2 text-sm font-medium leading-tight text-foreground">{displayName(lead)}</div>
                          {company && (
                            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Building2 className="h-3.5 w-3.5 flex-shrink-0" />
                              <span className="truncate">{company}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                        {pr && (
                          <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pr.badge}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${pr.dot}`} />
                            {pr.label}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="mt-auto pt-3 flex items-center justify-between border-t border-border/50">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-foreground">
                          {money ?? "\u2014"}
                        </span>
                      </div>
                      
                      <div className="flex items-center gap-2">
                        {lead.eventName && (
                          <span className="flex max-w-[120px] items-center gap-1 truncate rounded bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            <CalendarIcon className="h-2.5 w-2.5" />
                            {lead.eventName}
                          </span>
                        )}
                        <StageBadge lead={lead} stageMap={stageMap} stages={stages} size="sm" className="bg-background shadow-xs hover:bg-muted" />
                      </div>
                    </div>
                  </div>
                );
              })}
              {data.leads.length === 0 && (
                <div className="flex min-h-[100px] items-center justify-center rounded-lg border-2 border-dashed border-border/50 text-xs font-medium text-muted-foreground">
                  Empty stage
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
