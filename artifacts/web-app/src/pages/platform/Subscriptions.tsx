import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useGetPlatformStats } from "@workspace/api-client-react";
import { CreditCard, CheckCircle2 } from "lucide-react";

export default function PlatformSubscriptions() {
  const { data: stats, isLoading } = useGetPlatformStats();

  const plans = [
    { name: "Free", price: "$0", color: "bg-muted" },
    { name: "Starter", price: "$49", color: "bg-blue-500" },
    { name: "Professional", price: "$99", color: "bg-primary" },
    { name: "Enterprise", price: "Custom", color: "bg-slate-900 dark:bg-slate-100" },
  ];

  if (isLoading) {
    return <div className="p-8 flex items-center justify-center">Loading subscriptions...</div>;
  }

  const distribution = stats?.subscriptionDistribution || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Subscriptions</h1>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => {
          const count = distribution.find(d => d.status.toLowerCase() === plan.name.toLowerCase())?.count || 0;
          return (
            <Card key={plan.name} className="overflow-hidden">
              <div className={`h-2 w-full ${plan.color}`} />
              <CardHeader>
                <CardTitle className="flex justify-between items-center">
                  {plan.name}
                  <CreditCard className="h-4 w-4 text-muted-foreground" />
                </CardTitle>
                <CardDescription className="text-2xl font-bold text-foreground">
                  {plan.price}<span className="text-sm font-normal text-muted-foreground">/mo</span>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 mb-4">
                  <div className="text-3xl font-bold">{count}</div>
                  <div className="text-sm text-muted-foreground">companies</div>
                </div>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-primary" /> Core CRM features</div>
                  <div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-primary" /> Card Scanning</div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
