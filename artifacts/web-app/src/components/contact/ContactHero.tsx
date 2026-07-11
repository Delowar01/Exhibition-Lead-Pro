import React, { useEffect, useRef, useState } from "react";
import type { Contact } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Briefcase,
  Building2,
  CalendarClock,
  ChevronLeft,
  Flame,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Phone,
  Snowflake,
  Thermometer,
  Trash2,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { initialsOf, relativeAge, StatTile } from "./shared";

const TEMPERATURE_META: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
  hot: {
    label: "Hot",
    cls: "bg-destructive-soft text-destructive border-destructive/25",
    icon: <Flame className="h-3.5 w-3.5" aria-hidden />,
  },
  warm: {
    label: "Warm",
    cls: "bg-warning-soft text-warning border-warning/25",
    icon: <Thermometer className="h-3.5 w-3.5" aria-hidden />,
  },
  cold: {
    label: "Cold",
    cls: "bg-info-soft text-info border-info/25",
    icon: <Snowflake className="h-3.5 w-3.5" aria-hidden />,
  },
};

export function normalizePhoneForLink(p: string): string {
  return p.replace(/[^\d+]/g, "");
}

export interface ContactHeroProps {
  contact: Contact;
  lastInteractionAt: string | null;
  onBack: () => void;
  onCall: () => void;
  onEmail: () => void;
  onWhatsApp: () => void;
  onScheduleFollowUp: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenCompany?: () => void;
}

export default function ContactHero({
  contact,
  lastInteractionAt,
  onBack,
  onCall,
  onEmail,
  onWhatsApp,
  onScheduleFollowUp,
  onEdit,
  onDelete,
  onOpenCompany,
}: ContactHeroProps) {
  const [collapsed, setCollapsed] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // IntersectionObserver works in any scroll container (window or inner div).
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setCollapsed(!entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fullName =
    `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "Unnamed Contact";
  const temp = contact.leadTemperature ? TEMPERATURE_META[contact.leadTemperature] : null;
  const tags = contact.tags ?? [];
  const visibleTags = tags.slice(0, 3);
  const extraTags = tags.length - visibleTags.length;

  return (
    <>
      <div ref={sentinelRef} aria-hidden className="h-px" />
      <header
        className={cn(
          "sticky top-0 z-30 rounded-2xl border border-border/60 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 shadow-sm transition-all duration-200",
          collapsed ? "px-4 py-2.5" : "px-5 py-4 sm:px-6",
        )}
        data-testid="contact-hero"
        aria-label={`Contact workspace for ${fullName}`}
      >
        <div className="flex items-center gap-3 sm:gap-4 min-w-0 flex-wrap">
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            aria-label="Back to contacts"
            className="shrink-0 h-11 w-11 sm:h-9 sm:w-9"
            data-testid="button-back"
          >
            <ChevronLeft className="h-5 w-5" />
          </Button>

          <Avatar
            className={cn(
              "shrink-0 border border-border transition-all duration-200",
              collapsed ? "h-11 w-11" : "h-[56px] w-[56px] sm:h-[88px] sm:w-[88px]",
            )}
          >
            {contact.cardImageUrl && <AvatarImage src={contact.cardImageUrl} alt="" className="object-cover" />}
            <AvatarFallback
              className={cn(
                "bg-primary-soft text-primary font-semibold",
                collapsed ? "text-sm" : "text-lg sm:text-2xl",
              )}
            >
              {initialsOf(contact.firstName, contact.lastName)}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1 basis-[200px]">
            <div className="flex items-center gap-2 flex-wrap">
              <h1
                className={cn(
                  "font-bold truncate transition-all duration-200",
                  collapsed ? "text-base" : "text-lg sm:text-2xl",
                )}
                data-testid="text-contact-name"
              >
                {fullName}
              </h1>
              <Badge variant="outline" className="capitalize bg-background shrink-0">
                {contact.status.replace(/_/g, " ")}
              </Badge>
              {temp && (
                <Badge variant="outline" className={cn("gap-1 shrink-0", temp.cls)}>
                  {temp.icon} {temp.label}
                </Badge>
              )}
            </div>

            {!collapsed && (
              <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-sm text-muted-foreground mt-1 min-w-0">
                {contact.jobTitle && (
                  <span className="flex items-center gap-1.5 min-w-0">
                    <Briefcase className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{contact.jobTitle}</span>
                  </span>
                )}
                {contact.contactCompany && (
                  <span className="flex items-center gap-1.5 min-w-0">
                    <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {contact.organizationId && onOpenCompany ? (
                      <button
                        type="button"
                        onClick={onOpenCompany}
                        className="truncate hover:text-primary hover:underline text-start"
                        data-testid="link-hero-company"
                      >
                        {contact.contactCompany}
                      </button>
                    ) : (
                      <span className="truncate">{contact.contactCompany}</span>
                    )}
                  </span>
                )}
                {visibleTags.length > 0 && (
                  <span className="flex items-center gap-1 flex-wrap">
                    {visibleTags.map((t) => (
                      <Badge key={t} variant="secondary" className="text-[10px] px-1.5 py-0">
                        {t}
                      </Badge>
                    ))}
                    {extraTags > 0 && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        +{extraTags}
                      </Badge>
                    )}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Quick actions */}
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              variant="outline"
              size="icon"
              onClick={onCall}
              disabled={!contact.mobile}
              aria-label="Call contact"
              className="h-11 w-11 sm:h-9 sm:w-9"
              data-testid="button-hero-call"
            >
              <Phone className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={onWhatsApp}
              disabled={!contact.mobile}
              aria-label="WhatsApp contact"
              className="h-11 w-11 sm:h-9 sm:w-9"
              data-testid="button-hero-whatsapp"
            >
              <MessageCircle className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={onEmail}
              disabled={!contact.email}
              aria-label="Email contact"
              className="h-11 w-11 sm:h-9 sm:w-9"
              data-testid="button-hero-email"
            >
              <Mail className="h-4 w-4" />
            </Button>
            <Button
              onClick={onScheduleFollowUp}
              size="sm"
              className="hidden lg:inline-flex"
              data-testid="button-hero-schedule-followup"
            >
              <CalendarClock className="h-4 w-4 mr-2" /> Schedule Follow-up
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="More actions"
                  className="h-11 w-11 sm:h-9 sm:w-9"
                  data-testid="button-hero-more"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onEdit} data-testid="menu-edit-contact">
                  <Pencil className="h-4 w-4 mr-2" /> Edit contact
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onScheduleFollowUp} className="lg:hidden">
                  <CalendarClock className="h-4 w-4 mr-2" /> Schedule follow-up
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={onDelete}
                  className="text-destructive focus:text-destructive"
                  data-testid="menu-delete-contact"
                >
                  <Trash2 className="h-4 w-4 mr-2" /> Delete contact
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Relationship snapshot */}
        {!collapsed && (
          <div className="hidden sm:grid grid-cols-2 lg:grid-cols-4 gap-2.5 mt-4">
            <StatTile
              label="Relationship Age"
              value={relativeAge(contact.createdAt)}
              icon={<CalendarClock className="h-3 w-3" aria-hidden />}
            />
            <StatTile
              label="Last Interaction"
              value={lastInteractionAt ? relativeAge(lastInteractionAt) + " ago" : "None yet"}
              icon={<Phone className="h-3 w-3" aria-hidden />}
              tone={lastInteractionAt ? "default" : "warning"}
            />
            <StatTile
              label="Owner"
              value={contact.assignedToName ?? "Unassigned"}
              icon={<User className="h-3 w-3" aria-hidden />}
            />
            <StatTile
              label="Stage"
              value={<span className="capitalize">{contact.status.replace(/_/g, " ")}</span>}
              icon={<Briefcase className="h-3 w-3" aria-hidden />}
            />
          </div>
        )}
      </header>
    </>
  );
}
