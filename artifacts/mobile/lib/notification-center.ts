/**
 * Shared notification-center helpers used by BOTH the full Notification Center
 * screen (`app/notifications.tsx`) and the compact header-bell panel
 * (`components/NotificationBell.tsx`).
 *
 * There is deliberately NO second notifications API or duplicated state: both
 * surfaces read the same generated react-query hooks (`useListNotifications`,
 * `useGetUnreadCount`) which share one cache, and both map server links to
 * mobile routes through this single function so deep links stay consistent.
 */

import type { Feather } from "@/components/icons";

export const CATEGORY_ICONS: Record<string, keyof typeof Feather.glyphMap> = {
  security: "shield",
  billing: "credit-card",
  invitations: "user-plus",
  reports: "bar-chart-2",
  ai: "zap",
  subscription: "credit-card",
  events: "calendar",
  user_mgmt: "users",
  mentions: "at-sign",
};

// Server notification links are web-portal paths; map the ones with a mobile
// counterpart and safely ignore the rest (never open external/unknown links).
export function mapLinkToMobileRoute(link: string | null | undefined): string | null {
  if (!link || !link.startsWith("/admin")) return null;
  const lead = link.match(/^\/admin\/leads\/(\d+)/);
  if (lead) return `/pipeline/${lead[1]}`;
  const contact = link.match(/^\/admin\/contacts\/(\d+)/);
  if (contact) return `/contact/${contact[1]}`;
  if (link.startsWith("/admin/leads")) return "/leads";
  if (link.startsWith("/admin/contacts")) return "/contacts";
  return null;
}

export function timeAgo(iso: string, locale: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (mins < 60) return rtf.format(-mins, "minute");
  const hours = Math.round(mins / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 30) return rtf.format(-days, "day");
  return new Date(iso).toLocaleDateString(locale);
}
