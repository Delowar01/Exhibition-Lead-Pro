import React from "react";
import { useGetCurrentSubscription } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";

export default function AdminSubscription() {
  const { data: sub, isLoading } = useGetCurrentSubscription();

  if (isLoading) return <div className="p-8 flex justify-center">Loading subscription info...</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Subscription</h1>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle>Current Plan</CardTitle>
          <Badge className="capitalize text-sm px-3 py-1" variant={sub?.status === 'active' ? 'default' : 'destructive'}>
            {sub?.status}
          </Badge>
        </CardHeader>
        <CardContent className="pt-4 space-y-8">
          <div className="flex items-baseline gap-4">
            <h2 className="text-4xl font-bold capitalize text-primary">{sub?.plan}</h2>
            <span className="text-muted-foreground">plan</span>
          </div>

          <div className="space-y-3 border border-border rounded-lg p-5 bg-secondary/20">
            <div className="flex justify-between items-center text-sm font-medium">
              <span>Scans Usage</span>
              <span>{sub?.scansUsed || 0} / {sub?.scansLimit || 'Unlimited'}</span>
            </div>
            {sub?.scansLimit ? (
              <Progress value={((sub.scansUsed || 0) / sub.scansLimit) * 100} className="h-2 bg-secondary" />
            ) : (
              <Progress value={10} className="h-2 bg-secondary" />
            )}
            <p className="text-xs text-muted-foreground">Monthly limit resets on {sub?.renewalDate ? new Date(sub.renewalDate).toLocaleDateString() : 'billing cycle'}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
