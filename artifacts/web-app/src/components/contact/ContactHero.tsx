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
  ArrowLeft,
  CalendarClock,
  Flame,
  Mail,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  Snowflake,
  Thermometer,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { initialsOf, relativeAge } from "./shared";

const TEMPERATURE_META: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
  hot: {
    label: "Hot Lead",
    cls: "bg-destructive-soft text-destructive border-destructive/25",
    icon: <Flame className="h-3.5 w-3.5" aria-hidden />,
  },
  warm: {
    label: "Warm Lead",
    cls: "bg-warning-soft text-warning border-warning/25",
    icon: <Thermometer className="h-3.5 w-3.5" aria-hidden />,
  },
  cold: {
    label: "Cold Lead",
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
  const location = [contact.city, contact.country].filter(Boolean).join(", ");
  const companyLine = [contact.jobTitle, contact.contactCompany].filter(Boolean);

  const companyNode = contact.contactCompany ? (
    contact.organizationId && onOpenCompany ? (
      <button
        type="button"
        onClick={onOpenCompany}
        className="font-medium text-foreground hover:text-primary hover:underline"
        data-testid="link-hero-company"
      >
        {contact.contactCompany}
      </button>
    ) : (
      <span className="font-medium text-foreground">{contact.contactCompany}</span>
    )
  ) : null;

  return (
    <>
      <div ref={sentinelRef} aria-hidden className="h-px" />
      <header
        className={cn(
          "sticky top-0 z-30 rounded-2xl border border-border/60 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/90 shadow-sm transition-all duration-200",
          collapsed ? "px-4 py-2.5" : "px-5 py-5 sm:px-6",
        )}
        data-testid="contact-hero"
        aria-label={`Contact workspace for ${fullName}`}
      >
        {/* Back link (hidden when collapsed to save height) */}
        {!collapsed && (
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
            data-testid="button-back"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Contacts
          </button>
        )}

        <div className={cn("flex gap-4 sm:gap-5 min-w-0", collapsed ? "items-center" : "items-start flex-wrap")}>
          {collapsed && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              aria-label="Back to contacts"
              className="shrink-0 h-11 w-11"
            >
              <ArrowLeft className="h-4.5 w-4.5" />
            </Button>
          )}

          <Avatar
            className={cn(
              "shrink-0 border border-border transition-all duration-200",
              collapsed ? "h-11 w-11 rounded-lg" : "h-20 w-20 sm:h-28 sm:w-28 rounded-xl",
            )}
          >
            {contact.cardImageUrl && (
              <AvatarImage src={contact.cardImageUrl} alt="" className="object-cover" />
            )}
            <AvatarFallback
              className={cn(
                "bg-primary-soft text-primary font-semibold rounded-none",
                collapsed ? "text-sm" : "text-xl sm:text-3xl",
              )}
            >
              {initialsOf(contact.firstName, contact.lastName)}
            </AvatarFallback>
          </Avatar>

          {/* Identity column */}
          <div className="min-w-0 flex-1 basis-[240px]">
            <div className="flex items-center gap-2 flex-wrap">
              <h1
                className={cn(
                  "font-bold truncate transition-all duration-200",
                  collapsed ? "text-base" : "text-xl sm:text-2xl",
                )}
                data-testid="text-contact-name"
              >
                {fullName}
              </h1>
              {temp && (
                <Badge variant="outline" className={cn("gap-1 shrink-0", temp.cls)}>
                  {temp.icon} {temp.label}
                </Badge>
              )}
              <Badge variant="outline" className="capitalize bg-background shrink-0">
                {contact.status.replace(/_/g, " ")}
              </Badge>
            </div>

            {!collapsed && (
              <>
                {companyLine.length > 0 && (
                  <p className="text-sm text-muted-foreground mt-1 min-w-0 truncate">
                    {contact.jobTitle}
                    {contact.jobTitle && companyNode && <span className="mx-1.5">·</span>}
                    {companyNode}
                  </p>
                )}

                <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-sm text-muted-foreground mt-2 min-w-0">
                  {contact.email && (
                    <span className="flex items-center gap-1.5 min-w-0">
                      <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <a href={`mailto:${contact.email}`} className="truncate hover:text-primary hover:underline" data-testid="text-hero-email">
                        {contact.email}
                      </a>
                    </span>
                  )}
                  {contact.mobile && (
                    <span className="flex items-center gap-1.5 min-w-0">
                      <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <a href={`tel:${normalizePhoneForLink(contact.mobile)}`} className="truncate hover:text-primary hover:underline">
                        {contact.mobile}
                      </a>
                    </span>
                  )}
                  {location && (
                    <span className="flex items-center gap-1.5 min-w-0">
                      <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span className="truncate">{location}</span>
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 flex-wrap mt-2.5">
                  {tags.map((t) => (
                    <Badge key={t} variant="secondary" className="text-[11px] px-2 py-0.5 rounded-md">
                      {t}
                    </Badge>
                  ))}
                  <button
                    type="button"
                    onClick={onEdit}
                    aria-label="Edit tags"
                    className="inline-flex items-center justify-center h-5.5 w-6 rounded-md border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
                    data-testid="button-hero-add-tag"
                  >
                    <Plus className="h-3 w-3" aria-hidden />
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Score / recency column (real data only) */}
          {!collapsed && (contact.leadScore != null || lastInteractionAt || contact.eventName) && (
            <div className="hidden md:flex flex-col items-start gap-3 shrink-0 ps-5 border-s border-border/60 min-w-[150px]">
              {contact.leadScore != null && (
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    AI Lead Score
                  </p>
                  <p className="text-3xl font-bold text-primary leading-tight" data-testid="text-hero-lead-score">
                    {contact.leadScore}
                    <span className="text-base font-semibold text-muted-foreground">/100</span>
                  </p>
                </div>
              )}
              {(lastInteractionAt || contact.eventName) && (
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Last Interaction
                  </p>
                  {lastInteractionAt ? (
                    <p className="text-sm font-semibold text-destructive">
                      {relativeAge(lastInteractionAt)} ago
                    </p>
                  ) : (
                    <p className="text-sm font-semibold text-muted-foreground">None yet</p>
                  )}
                  {contact.eventName && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[180px]">
                      Met at {contact.eventName}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Collapsed quick actions (right side) */}
          {collapsed && (
            <div className="flex items-center gap-1.5 shrink-0 ms-auto">
              <Button variant="outline" size="icon" onClick={onCall} disabled={!contact.mobile} aria-label="Call contact" className="h-11 w-11">
                <Phone className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" onClick={onWhatsApp} disabled={!contact.mobile} aria-label="WhatsApp contact" className="h-11 w-11">
                <MessageCircle className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" onClick={onEmail} disabled={!contact.email} aria-label="Email contact" className="h-11 w-11">
                <Mail className="h-4 w-4" />
              </Button>
              <HeroMoreMenu onEdit={onEdit} onScheduleFollowUp={onScheduleFollowUp} onDelete={onDelete} />
            </div>
          )}
        </div>

        {/* Expanded action row */}
        {!collapsed && (
          <div className="flex items-center gap-2 flex-wrap mt-4">
            <Button
              variant="outline"
              onClick={onCall}
              disabled={!contact.mobile}
              className="h-10 border-success/40 text-success hover:text-success hover:bg-success-soft"
              data-testid="button-hero-call"
            >
              <Phone className="h-4 w-4 mr-2" /> Call
            </Button>
            <Button
              variant="outline"
              onClick={onWhatsApp}
              disabled={!contact.mobile}
              className="h-10 border-success/40 text-success hover:text-success hover:bg-success-soft"
              data-testid="button-hero-whatsapp"
            >
              <MessageCircle className="h-4 w-4 mr-2" /> WhatsApp
            </Button>
            <Button
              variant="outline"
              onClick={onEmail}
              disabled={!contact.email}
              className="h-10 border-info/40 text-info hover:text-info hover:bg-info-soft"
              data-testid="button-hero-email"
            >
              <Mail className="h-4 w-4 mr-2" /> Email
            </Button>
            <Button
              variant="outline"
              onClick={onScheduleFollowUp}
              className="h-10"
              data-testid="button-hero-schedule-followup"
            >
              <CalendarClock className="h-4 w-4 mr-2" /> Schedule Follow-up
            </Button>
            <HeroMoreMenu onEdit={onEdit} onScheduleFollowUp={onScheduleFollowUp} onDelete={onDelete} label />
          </div>
        )}
      </header>
    </>
  );
}

function HeroMoreMenu({
  onEdit,
  onScheduleFollowUp,
  onDelete,
  label = false,
}: {
  onEdit: () => void;
  onScheduleFollowUp: () => void;
  onDelete: () => void;
  label?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {label ? (
          <Button variant="outline" className="h-10" aria-label="More actions" data-testid="button-hero-more">
            <MoreHorizontal className="h-4 w-4 mr-2" /> More
          </Button>
        ) : (
          <Button variant="ghost" size="icon" aria-label="More actions" className="h-11 w-11" data-testid="button-hero-more">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onEdit} data-testid="menu-edit-contact">
          <Pencil className="h-4 w-4 mr-2" /> Edit contact
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onScheduleFollowUp}>
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
  );
}
