import React from "react";
import { useLocation } from "wouter";
import { Bell, Check, CheckCheck, Trash2, Settings2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatDistanceToNow } from "date-fns";
import {
  useListNotifications,
  useGetNotificationPreferences,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  useDeleteNotification,
  useUpdateNotificationPreference,
  type Notification,
  type NotificationPreference,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

const CATEGORY_LABELS: Record<string, string> = {
  security: "Security",
  billing: "Billing",
  invitations: "Invitations",
  reports: "Reports",
  ai: "AI Insights",
  subscription: "Subscription",
  events: "Events",
  user_mgmt: "Team & Users",
  mentions: "Mentions",
  workflows: "Workflow Automation",
};

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

export default function Notifications() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [showPrefs, setShowPrefs] = React.useState(false);

  const { data, isLoading } = useListNotifications();
  const { data: prefsData } = useGetNotificationPreferences();
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const remove = useDeleteNotification();
  const updatePref = useUpdateNotificationPreference();

  const notifications = data?.notifications ?? [];
  const preferences = prefsData?.preferences ?? [];
  const unread = notifications.filter((n) => !n.readAt).length;

  const handleOpen = (n: Notification) => {
    if (!n.readAt) markRead.mutate({ id: n.id });
    if (n.link) setLocation(n.link.replace(/^\/(admin|platform)/, (m) => m));
  };

  const togglePref = (pref: NotificationPreference, field: "inApp" | "email", value: boolean) => {
    updatePref.mutate(
      { data: { category: pref.category, inApp: field === "inApp" ? value : pref.inApp, email: field === "email" ? value : pref.email } },
      { onError: () => toast({ title: "Could not update preference", variant: "destructive" }) },
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Bell className="h-6 w-6 text-primary" /> Notifications
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {unread > 0 ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "You're all caught up"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowPrefs((s) => !s)}>
            <Settings2 className="h-4 w-4 mr-1.5" /> Preferences
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={unread === 0 || markAll.isPending}
            onClick={() => markAll.mutate(undefined)}
          >
            <CheckCheck className="h-4 w-4 mr-1.5" /> Mark all read
          </Button>
        </div>
      </div>

      {showPrefs && (
        <div className="mb-6 rounded-xl border border-border bg-card p-5">
          <h2 className="font-semibold mb-1">Notification preferences</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Choose how you'd like to be notified for each category.
          </p>
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-8 gap-y-3 items-center text-sm">
            <div className="font-medium text-muted-foreground">Category</div>
            <div className="font-medium text-muted-foreground text-center">In-app</div>
            <div className="font-medium text-muted-foreground text-center">Email</div>
            {preferences.map((pref) => (
              <React.Fragment key={pref.category}>
                <div>{categoryLabel(pref.category)}</div>
                <div className="flex justify-center">
                  <Switch checked={pref.inApp} onCheckedChange={(v) => togglePref(pref, "inApp", v)} />
                </div>
                <div className="flex justify-center">
                  <Switch checked={pref.email} onCheckedChange={(v) => togglePref(pref, "email", v)} />
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 text-primary animate-spin" />
        </div>
      ) : notifications.length === 0 ? (
        <div className="text-center py-16 rounded-xl border border-dashed border-border bg-card">
          <Bell className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No notifications yet.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
          {notifications.map((n) => (
            <div
              key={n.id}
              className={`flex items-start gap-3 p-4 transition-colors hover:bg-secondary/40 ${n.readAt ? "" : "bg-primary/5"}`}
            >
              <button className="flex-1 text-left" onClick={() => handleOpen(n)}>
                <div className="flex items-center gap-2">
                  {!n.readAt && <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />}
                  <span className="text-[11px] uppercase tracking-wide font-medium text-muted-foreground">
                    {categoryLabel(n.category)}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                  </span>
                </div>
                <p className="font-medium text-sm mt-0.5">{n.title}</p>
                {n.body && <p className="text-sm text-muted-foreground mt-0.5">{n.body}</p>}
              </button>
              <div className="flex items-center gap-1 flex-shrink-0">
                {!n.readAt && (
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => markRead.mutate({ id: n.id })}>
                    <Check className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => remove.mutate({ id: n.id })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
