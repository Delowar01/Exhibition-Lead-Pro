import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useGetPlatformActivity } from "@workspace/api-client-react";
import { Activity } from "lucide-react";
import { format } from "date-fns";

export default function PlatformActivity() {
  const { data, isLoading } = useGetPlatformActivity();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Platform Activity</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Activity Feed</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">Loading...</div>
          ) : (
            <div className="space-y-4">
              {data?.map((item) => (
                <div key={item.id} className="flex items-start gap-4 pb-4 border-b border-border last:border-0 last:pb-0">
                  <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center mt-0.5">
                    <Activity className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{item.description}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                      <span>{format(new Date(item.createdAt), 'MMM d, yyyy h:mm a')}</span>
                      {item.companyName && (
                        <>
                          <span>&bull;</span>
                          <span className="font-medium">{item.companyName}</span>
                        </>
                      )}
                      {item.userName && (
                        <>
                          <span>&bull;</span>
                          <span>{item.userName}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {data?.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">No recent activity.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
