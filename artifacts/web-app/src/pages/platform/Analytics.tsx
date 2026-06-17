import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function PlatformAnalytics() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Detailed Analytics coming soon</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">We are preparing more charts for this section.</p>
        </CardContent>
      </Card>
    </div>
  );
}
