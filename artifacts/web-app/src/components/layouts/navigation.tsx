import {
  Users, LayoutDashboard, Calendar, CreditCard, Settings, Camera, Contact,
  BarChart2, CopyCheck, MonitorSmartphone, ShieldCheck, Building2, ShieldAlert,
  Network, BookUser, GitBranch, LineChart, Columns3, Tags, FolderOpen,
  Sparkles, Layers, Bot, Workflow, BarChart3, Activity, SlidersHorizontal,
  Briefcase, PieChart,
} from "lucide-react";
import { workflowAccess } from "@/components/automations/permissions";
import { subscriptionAccess } from "@/components/billing/permissions";
import type { LucideIcon } from "lucide-react";
import type { User } from "@workspace/api-client-react";

export interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
}

export interface NavGroup {
  id: string;
  label: string | null;
  items: NavItem[];
}

export function buildAdminNav(user: User | null): NavGroup[] {
  const isFullAccess = user?.role === "primary_admin" || user?.role === "platform_owner";
  const docPerms = (user?.permissions?.documents as string[] | undefined) ?? [];
  const canViewDocuments = isFullAccess || docPerms.includes("view");
  const execPerms = (user?.permissions?.ai_executive as string[] | undefined) ?? [];
  const canViewExecutive =
    user?.role !== "platform_owner" && (isFullAccess || execPerms.includes("view"));
  const assistantPerms = (user?.permissions?.ai_assistant as string[] | undefined) ?? [];
  const canViewAssistant =
    user?.role !== "platform_owner" && (isFullAccess || assistantPerms.includes("view"));

  const groups: NavGroup[] = [
    {
      id: "main",
      label: null,
      items: [{ name: "Dashboard", href: "/admin", icon: LayoutDashboard }],
    },
    {
      id: "crm",
      label: "CRM",
      items: [
        { name: "Contacts", href: "/admin/contacts", icon: Contact },
        { name: "Companies", href: "/admin/companies", icon: Building2 },
        { name: "Leads Pipeline", href: "/admin/leads", icon: Columns3 },
        { name: "Duplicates", href: "/admin/duplicates", icon: CopyCheck },
        { name: "Tags", href: "/admin/tags", icon: Tags },
        ...(workflowAccess(user).canView ? [{ name: "Automations", href: "/admin/automations", icon: Workflow }] : []),
      ],
    },
    {
      id: "capture",
      label: "Capture",
      items: [{ name: "Scan Card", href: "/admin/scan", icon: Camera }],
    },
    {
      id: "activities",
      label: "Activities",
      items: [
        { name: "Events", href: "/admin/events", icon: Calendar },
        ...(canViewDocuments
          ? [{ name: "Documents", href: "/admin/documents", icon: FolderOpen }]
          : []),
      ],
    },
    {
      id: "ai",
      label: "AI Intelligence",
      items: [
        { name: "AI Workspace", href: canViewAssistant ? "/admin/ai-command" : "/admin/ai-insights", icon: Sparkles }
      ],
    },
    {
      id: "analytics",
      label: "Analytics & Reports",
      items: [
        { name: "Reports", href: "/admin/reports", icon: BarChart2 },
        { name: "Performance Analytics", href: "/admin/analytics", icon: PieChart },
      ],
    },
    {
      id: "organization",
      label: "Organization",
      items: [
        { name: "Team", href: "/admin/team", icon: Users },
        { name: "Departments", href: "/admin/departments", icon: Building2 },
        { name: "Teams", href: "/admin/teams", icon: Network },
        { name: "Employee Directory", href: "/admin/directory", icon: BookUser },
        { name: "Org Hierarchy", href: "/admin/org-hierarchy", icon: GitBranch },
        { name: "Roles & Permissions", href: "/admin/roles", icon: ShieldCheck },
      ],
    },
    {
      id: "administration",
      label: "Administration",
      items: [
        { name: "Organization Profile", href: "/admin/organization", icon: Building2 },
        { name: "Pipeline Settings", href: "/admin/pipeline-settings", icon: SlidersHorizontal },
        { name: "Security", href: "/admin/security", icon: ShieldAlert },
        // Batch 20: billing is visible only to users holding subscriptions:view
        // (primary_admin implicitly); platform operators never see tenant billing.
        ...(subscriptionAccess(user).canView
          ? [{ name: "Subscription", href: "/admin/subscription", icon: CreditCard }]
          : []),
        { name: "Sessions", href: "/admin/sessions", icon: MonitorSmartphone },
        { name: "Settings", href: "/admin/settings", icon: Settings },
      ],
    },
  ];

  return groups.filter((g) => g.items.length > 0);
}

export function buildPlatformNav(): NavGroup[] {
  return [
    {
      id: "main",
      label: null,
      items: [{ name: "Dashboard", href: "/platform", icon: LayoutDashboard }],
    },
    {
      id: "tenants",
      label: "Tenants",
      items: [
        { name: "Companies", href: "/platform/companies", icon: Building2 },
        { name: "Users", href: "/platform/users", icon: Users },
        { name: "Subscriptions", href: "/platform/subscriptions", icon: CreditCard },
      ],
    },
    {
      id: "insights",
      label: "Insights",
      items: [
        { name: "Analytics", href: "/platform/analytics", icon: BarChart3 },
        { name: "AI Intelligence", href: "/platform/ai", icon: Sparkles },
        { name: "Activity", href: "/platform/activity", icon: Activity },
      ],
    },
    {
      id: "administration",
      label: "Administration",
      items: [{ name: "Settings", href: "/platform/settings", icon: Settings }],
    },
  ];
}
