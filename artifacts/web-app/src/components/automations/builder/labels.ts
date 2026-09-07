import { humanize } from "../format";

/** Friendly labels for configuration keys the catalog exposes (fallback: humanized key). */
const CONFIG_KEY_LABELS: Record<string, string> = {
  assignedToId: "Assign to user",
  userId: "User",
  createdById: "Created by",
  teamId: "Team",
  tagId: "Tag",
  tag: "Tag label",
  strategy: "Assignment strategy",
  fields: "Fields",
  stage: "Pipeline stage",
  fromStageKey: "From stage",
  toStageKey: "To stage",
  fromStatus: "From status",
  toStatus: "To status",
  status: "Lead status",
  statusComment: "Status comment",
  leadTemperature: "Lead temperature",
  eventId: "Event",
  organizationId: "Organization",
  contactId: "Contact",
  title: "Title",
  type: "Task type",
  notes: "Notes",
  dueInDays: "Due in (days)",
  dueTime: "Due time",
  scheduleInDays: "Schedule in (days)",
  scheduledTime: "Time",
  assignee: "Assignee",
  recipient: "Recipient",
  to: "Send to",
  subject: "Subject",
  body: "Message",
  value: "Value",
  currency: "Currency (3-letter code)",
  closingDate: "Closing date",
  probability: "Probability (%)",
  priority: "Priority",
  source: "Source",
  companyName: "Company name",
  contactCompany: "Company (free text)",
  jobTitle: "Job title",
  country: "Country",
  city: "City",
  kind: "Who",
};

export function configKeyLabel(key: string): string {
  return CONFIG_KEY_LABELS[key] ?? humanize(key);
}

/** Labels for catalog enum values (statuses, strategies, task types, …). */
const ENUM_LABELS: Record<string, string> = {
  manual: "Specific user (manual)",
  round_robin: "Round robin (team rotation)",
  load_balanced: "Load balanced (fewest open leads)",
  availability: "Availability",
  territory: "Territory",
  quotation_sent: "Quotation sent",
  proposal_sent: "Proposal sent",
  follow_up: "Follow-up",
};

export function enumValueLabel(value: string | number): string {
  const v = String(value);
  return ENUM_LABELS[v] ?? humanize(v);
}

/** Section-level hints shown under the trigger's optional config fields. */
export const TRIGGER_CONFIG_HINTS: Record<string, string> = {
  fields: "Only fire when at least one of the selected fields changed. Leave empty to fire on any change.",
  fromStageKey: "Optional — only when the lead leaves this stage.",
  toStageKey: "Optional — only when the lead enters this stage.",
  fromStatus: "Optional — only when the contact leaves this status.",
  toStatus: "Optional — only when the contact enters this status.",
};
