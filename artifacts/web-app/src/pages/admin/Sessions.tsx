import React from "react";
import { Monitor, Smartphone, Tablet, Globe, Loader2, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  useListSessions,
  useTerminateSession,
  useTerminateOtherSessions,
  type SessionInfo,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

function deviceIcon(deviceType?: string | null) {
  switch ((deviceType || "").toLowerCase()) {
    case "mobile":
      return Smartphone;
    case "tablet":
      return Tablet;
    case "desktop":
      return Monitor;
    default:
      return Globe;
  }
}

function formatWhen(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function SessionRow({
  session,
  onTerminate,
  terminating,
}: {
  session: SessionInfo;
  onTerminate: (id: number) => void;
  terminating: boolean;
}) {
  const Icon = deviceIcon(session.deviceType);
  const label = [session.browser, session.os].filter(Boolean).join(" · ") || "Unknown device";

  return (
    <div className="flex items-center gap-4 py-4 first:pt-0 last:pb-0">
      <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center shrink-0">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-medium truncate">{label}</p>
          {session.current && (
            <Badge variant="secondary" className="text-xs">
              This device
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground truncate">
          {session.ipAddress || "Unknown IP"} · Last active {formatWhen(session.lastUsedAt)}
        </p>
      </div>
      {!session.current && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onTerminate(session.id)}
          disabled={terminating}
        >
          Sign out
        </Button>
      )}
    </div>
  );
}

export default function AdminSessions() {
  const { toast } = useToast();
  const { data, isLoading, refetch } = useListSessions();

  const terminateOne = useTerminateSession({
    mutation: {
      onSuccess: () => {
        toast({ title: "Session ended", description: "That device has been signed out." });
        refetch();
      },
      onError: () => {
        toast({ variant: "destructive", title: "Could not end session", description: "Please try again." });
      },
    },
  });

  const terminateOthers = useTerminateOtherSessions({
    mutation: {
      onSuccess: (res) => {
        toast({
          title: "Other sessions ended",
          description: `Signed out ${res.terminated} other device(s).`,
        });
        refetch();
      },
      onError: () => {
        toast({ variant: "destructive", title: "Could not sign out other devices", description: "Please try again." });
      },
    },
  });

  const sessions = data?.sessions ?? [];
  const hasOthers = sessions.some((s) => !s.current);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Active Sessions</h1>
          <p className="text-muted-foreground mt-1">
            Devices currently signed in to your account.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => terminateOthers.mutate()}
          disabled={!hasOthers || terminateOthers.isPending}
        >
          {terminateOthers.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
          Sign out all other devices
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your devices</CardTitle>
          <CardDescription>
            If you don't recognize a device, sign it out and change your password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No active sessions.</p>
          ) : (
            <div className="divide-y divide-border">
              {sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  terminating={terminateOne.isPending}
                  onTerminate={(id) => terminateOne.mutate({ id })}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
