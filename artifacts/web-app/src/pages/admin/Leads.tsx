import React, { useState } from "react";
import { useGetLeadPipeline, useUpdateLead, LeadStage, getGetLeadPipelineQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Building2, MoreHorizontal, Calendar as CalendarIcon, DollarSign, GripVertical } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";

export default function AdminLeads() {
  const { data: pipeline, isLoading } = useGetLeadPipeline();
  const updateLead = useUpdateLead();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [draggedLeadId, setDraggedLeadId] = useState<number | null>(null);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);

  const formatStage = (stage: string) => stage.replace("_", " ");

  const handleDragStart = (e: React.DragEvent, leadId: number) => {
    e.dataTransfer.setData("leadId", leadId.toString());
    e.dataTransfer.effectAllowed = "move";
    setDraggedLeadId(leadId);
  };

  const handleDragOver = (e: React.DragEvent, stageName: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverStage !== stageName) {
      setDragOverStage(stageName);
    }
  };

  const handleDragLeave = () => {
    setDragOverStage(null);
  };

  const handleDrop = (e: React.DragEvent, targetStage: string) => {
    e.preventDefault();
    setDragOverStage(null);
    
    const leadIdStr = e.dataTransfer.getData("leadId");
    if (!leadIdStr) return;
    
    const leadId = parseInt(leadIdStr, 10);
    setDraggedLeadId(null);
    
    if (leadId) {
      // Optimistically update UI
      const previousData = queryClient.getQueryData(getGetLeadPipelineQueryKey());
      
      updateLead.mutate(
        { id: leadId, data: { stage: targetStage as any } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetLeadPipelineQueryKey() });
          },
          onError: () => {
            queryClient.setQueryData(getGetLeadPipelineQueryKey(), previousData);
            toast({
              title: "Update failed",
              description: "Could not move lead.",
              variant: "destructive"
            });
          }
        }
      );
    }
  };

  const handleDragEnd = () => {
    setDraggedLeadId(null);
    setDragOverStage(null);
  };

  const getPriorityColor = (priority?: string) => {
    if (priority === 'high') return 'bg-red-500';
    if (priority === 'medium') return 'bg-yellow-500';
    return 'bg-green-500'; // Default/Low
  };

  if (isLoading) {
    return <div className="p-8 flex items-center justify-center">Loading pipeline...</div>;
  }

  const stages = Object.values(LeadStage);
  const pipelineData = pipeline?.stages || [];

  return (
    <div className="h-full flex flex-col space-y-6 pb-6">
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sales Pipeline</h1>
          <p className="text-muted-foreground mt-1">
            Total Pipeline Value: <span className="font-bold text-foreground">${(pipeline?.totalValue || 0).toLocaleString()}</span>
          </p>
        </div>
      </div>

      <div className="flex-1 flex gap-5 overflow-x-auto pb-4 pt-2 snap-x">
        {stages.map((stageName) => {
          const stageData = pipelineData.find(s => s.stage === stageName) || { leads: [], count: 0, value: 0 };
          const isWon = stageName === 'won';
          const isLost = stageName === 'lost';
          
          let headerStyle = "bg-secondary/80 border-border";
          let columnStyle = "bg-secondary/30 border-border";
          
          if (isWon) {
            headerStyle = "bg-green-100 dark:bg-green-900/30 border-green-200 dark:border-green-800 text-green-800 dark:text-green-300";
            columnStyle = "bg-green-50/50 dark:bg-green-900/10 border-green-200 dark:border-green-800";
          } else if (isLost) {
            headerStyle = "bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400";
            columnStyle = "bg-gray-50/50 dark:bg-gray-900/20 border-gray-200 dark:border-gray-800";
          } else if (dragOverStage === stageName) {
            columnStyle = "bg-primary/5 border-primary/50 shadow-inner";
          }

          return (
            <div 
              key={stageName}
              className={`flex-shrink-0 w-80 rounded-xl border flex flex-col snap-center transition-colors ${columnStyle}`}
              onDragOver={(e) => handleDragOver(e, stageName)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, stageName)}
            >
              <div className={`p-3.5 border-b rounded-t-xl ${headerStyle}`}>
                <div className="flex justify-between items-center mb-1">
                  <h3 className="font-semibold capitalize text-sm">{formatStage(stageName)}</h3>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${isWon ? 'bg-green-200 dark:bg-green-800/50' : isLost ? 'bg-gray-200 dark:bg-gray-700' : 'bg-background border border-border'}`}>
                    {stageData.count}
                  </span>
                </div>
                <div className={`text-xs font-medium ${isWon ? 'text-green-700 dark:text-green-400' : isLost ? 'text-gray-500' : 'text-muted-foreground'}`}>
                  ${stageData.value.toLocaleString()}
                </div>
              </div>

              <div className="flex-1 p-3 overflow-y-auto space-y-3 min-h-[500px]">
                {stageData.leads.map((lead) => {
                  const isDragging = draggedLeadId === lead.id;
                  // Use contact name + company, or fallback to lead title
                  const displayName = lead.contactName || "Unknown Contact";
                  
                  return (
                    <div
                      key={lead.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, lead.id)}
                      onDragEnd={handleDragEnd}
                      className={`bg-card p-3.5 rounded-lg shadow-sm border border-border cursor-grab active:cursor-grabbing hover:border-primary/50 hover:shadow-md transition-all group ${
                        isDragging ? 'opacity-40 scale-95 shadow-none' : 'opacity-100'
                      } ${isWon ? 'border-l-4 border-l-green-500' : ''}`}
                    >
                      <div className="flex justify-between items-start mb-2 gap-2">
                        <div className="flex gap-2 items-start">
                          <GripVertical className="h-4 w-4 text-muted-foreground/30 mt-0.5 -ml-1 cursor-grab opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                          <Link href={`/admin/leads/${lead.id}`} className="font-medium text-sm hover:text-primary transition-colors leading-tight line-clamp-2">
                            {displayName}
                          </Link>
                        </div>
                        <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${getPriorityColor('medium')}`} />
                      </div>
                      
                      <div className="text-xs text-muted-foreground mb-3 flex items-center gap-1.5 pl-5">
                        <Building2 className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">{lead.contactCompany || "No Company"}</span>
                      </div>

                      <div className="flex justify-between items-center mt-3 pt-3 border-t border-border/50 pl-1">
                        <div className="text-sm font-bold flex items-center">
                          ${lead.value?.toLocaleString() || 0}
                        </div>
                        {lead.eventName && (
                          <div className="text-[10px] font-medium bg-secondary px-2 py-0.5 rounded text-muted-foreground truncate max-w-[120px] flex items-center gap-1">
                            <CalendarIcon className="h-2.5 w-2.5" />
                            {lead.eventName}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {stageData.leads.length === 0 && (
                  <div className="h-full w-full flex items-center justify-center min-h-[100px] border-2 border-dashed border-border/50 rounded-lg text-muted-foreground text-xs font-medium">
                    Drop leads here
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
