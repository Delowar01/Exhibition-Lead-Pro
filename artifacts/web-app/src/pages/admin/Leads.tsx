import React, { useState } from "react";
import { useGetLeadPipeline, useUpdateLead, LeadStage, getGetLeadPipelineQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { format } from "date-fns";
import { Building2, Clock, CalendarIcon, MoreHorizontal } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function AdminLeads() {
  const { data: pipeline, isLoading } = useGetLeadPipeline();
  const updateLead = useUpdateLead();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [draggedLeadId, setDraggedLeadId] = useState<number | null>(null);

  const formatStage = (stage: string) => {
    return stage.replace("_", " ");
  };

  const handleDragStart = (e: React.DragEvent, leadId: number) => {
    e.dataTransfer.setData("leadId", leadId.toString());
    setDraggedLeadId(leadId);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault(); // Necessary to allow dropping
  };

  const handleDrop = (e: React.DragEvent, targetStage: string) => {
    e.preventDefault();
    const leadIdStr = e.dataTransfer.getData("leadId");
    if (!leadIdStr) return;
    
    const leadId = parseInt(leadIdStr, 10);
    setDraggedLeadId(null);
    
    // Only update if we dropped it somewhere
    if (leadId) {
      updateLead.mutate(
        { id: leadId, data: { stage: targetStage as any } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetLeadPipelineQueryKey() });
          },
          onError: (err) => {
            toast({
              title: "Failed to update lead",
              description: "There was an error updating the pipeline.",
              variant: "destructive"
            });
          }
        }
      );
    }
  };

  const handleDragEnd = () => {
    setDraggedLeadId(null);
  };

  if (isLoading) {
    return <div className="p-8 flex items-center justify-center">Loading pipeline...</div>;
  }

  const stages = Object.values(LeadStage);
  const pipelineData = pipeline?.stages || [];

  return (
    <div className="h-full flex flex-col space-y-6">
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Leads Pipeline</h1>
          <p className="text-muted-foreground mt-1">Total Pipeline Value: <span className="font-bold text-foreground">${pipeline?.totalValue?.toLocaleString() || 0}</span></p>
        </div>
      </div>

      <div className="flex-1 flex gap-4 overflow-x-auto pb-4 pt-2">
        {stages.map((stageName) => {
          const stageData = pipelineData.find(s => s.stage === stageName) || { leads: [], count: 0, value: 0 };
          
          return (
            <div 
              key={stageName}
              className="flex-shrink-0 w-80 bg-secondary/30 rounded-xl border border-border flex flex-col"
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, stageName)}
            >
              <div className="p-4 border-b border-border/50 bg-secondary/50 rounded-t-xl">
                <div className="flex justify-between items-center mb-1">
                  <h3 className="font-semibold capitalize text-sm">{formatStage(stageName)}</h3>
                  <span className="bg-background text-foreground text-xs font-medium px-2 py-0.5 rounded-full border border-border">
                    {stageData.count}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground font-medium">
                  ${stageData.value.toLocaleString()}
                </div>
              </div>

              <div className="flex-1 p-3 overflow-y-auto space-y-3 min-h-[200px]">
                {stageData.leads.map((lead) => (
                  <div
                    key={lead.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, lead.id)}
                    onDragEnd={handleDragEnd}
                    className={`bg-card p-4 rounded-lg shadow-sm border border-border cursor-grab active:cursor-grabbing hover:border-primary/50 transition-all ${draggedLeadId === lead.id ? 'opacity-50 scale-95' : 'opacity-100'}`}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <div className="font-medium text-sm">{lead.contactName || "Unknown Contact"}</div>
                      <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                    </div>
                    
                    <div className="text-xs text-muted-foreground mb-3 flex items-center gap-1.5">
                      <Building2 className="h-3 w-3" />
                      <span className="truncate">{lead.contactCompany || "No Company"}</span>
                    </div>

                    <div className="flex justify-between items-center mt-3 pt-3 border-t border-border/50">
                      <div className="text-sm font-semibold text-primary">
                        ${lead.value?.toLocaleString() || 0}
                      </div>
                      {lead.eventName && (
                        <div className="text-[10px] bg-secondary px-2 py-1 rounded text-muted-foreground truncate max-w-[100px]">
                          {lead.eventName}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
