import React from "react";
import { cn } from "@/lib/utils";

export function WorkspaceShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col min-h-full pb-12", className)}>
      {children}
    </div>
  );
}

export function WorkspaceContent({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-1 xl:grid-cols-4 gap-6 mt-6", className)}>
      {children}
    </div>
  );
}

export function WorkspaceMain({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("xl:col-span-3 space-y-6", className)}>{children}</div>;
}

export function WorkspaceSidebar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("space-y-6", className)}>{children}</div>;
}
