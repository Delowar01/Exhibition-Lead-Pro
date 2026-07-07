import React from "react";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

interface WorkspaceHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  onBack?: () => void;
  badges?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function WorkspaceHeader({
  title,
  subtitle,
  onBack,
  badges,
  actions,
  className,
}: WorkspaceHeaderProps) {
  return (
    <div className={cn("flex flex-col md:flex-row md:items-start justify-between gap-4 sticky top-0 z-10 bg-background/95 backdrop-blur py-4 border-b border-border/50", className)}>
      <div className="flex items-start gap-4">
        {onBack && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            className="rounded-full mt-1"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-3xl font-bold tracking-tight truncate">{title}</h1>
            {badges}
          </div>
          {subtitle && (
            <div className="text-muted-foreground mt-1 flex items-center gap-2 text-sm flex-wrap">
              {subtitle}
            </div>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex items-center gap-2 flex-shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}
