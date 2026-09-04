import type { Contact, Lead } from "@workspace/db";
import * as runsRepo from "../../repositories/workflow_runs.repository.js";
import { WorkflowFailure, WorkflowSkip } from "./errors.js";
import type { RecipientKind } from "./catalog.js";

// =============================================================================
// Recipient resolution (Batch 16) for the B15 recipient kinds:
//   record_owner  the record's assigned user            (absent → skip)
//   actor         the user whose mutation fired the run  (absent → skip)
//   user          an explicitly configured user id       (must belong to the
//                 company — otherwise a DETERMINISTIC failure, never a fallback)
//   contact       the record's contact email (email actions only; absent → skip)
// Every resolved user is re-verified as an active member of the run's company.
// =============================================================================

export interface RecipientContext {
  companyId: number;
  actorUserId: number | null;
  entityType: "lead" | "contact";
  lead?: Lead;
  contact?: Contact;
}

export interface RecipientConfig {
  kind: RecipientKind;
  userId?: number;
}

export interface ResolvedUser {
  id: number;
  email: string;
  name: string;
}

async function verifiedUser(companyId: number, id: number, whenMissing: () => Error): Promise<ResolvedUser> {
  const u = await runsRepo.activeUserInCompany(companyId, id);
  if (!u) throw whenMissing();
  return { id: u.id, email: u.email, name: u.name };
}

export async function resolveUserRecipient(cfg: RecipientConfig, ctx: RecipientContext): Promise<ResolvedUser> {
  switch (cfg.kind) {
    case "record_owner": {
      const ownerId = ctx.entityType === "lead" ? ctx.lead?.assignedToId : ctx.contact?.assignedToId;
      if (ownerId == null) throw new WorkflowSkip("record has no owner");
      return verifiedUser(ctx.companyId, ownerId, () => new WorkflowSkip("record owner is no longer an active user"));
    }
    case "actor": {
      if (ctx.actorUserId == null) throw new WorkflowSkip("event has no acting user");
      return verifiedUser(ctx.companyId, ctx.actorUserId, () => new WorkflowSkip("acting user is no longer an active user"));
    }
    case "user": {
      if (cfg.userId == null) throw new WorkflowFailure("INVALID_CONFIG", "recipient.userId is required for kind user");
      return verifiedUser(ctx.companyId, cfg.userId, () => new WorkflowFailure("REFERENCE_INVALID", `configured user #${cfg.userId} is not an active user of this company`));
    }
    case "contact":
      throw new WorkflowFailure("INVALID_CONFIG", 'recipient kind "contact" is only valid for email actions');
  }
}

// Loads the contact behind the record (a contact entity is its own contact).
export async function recordContact(ctx: RecipientContext): Promise<Contact | undefined> {
  if (ctx.entityType === "contact") return ctx.contact;
  const contactId = ctx.lead?.contactId;
  if (contactId == null) return undefined;
  return runsRepo.contactInCompany(ctx.companyId, contactId);
}

export async function resolveEmailRecipient(cfg: RecipientConfig, ctx: RecipientContext): Promise<{ email: string; userId: number | null }> {
  if (cfg.kind === "contact") {
    const contact = await recordContact(ctx);
    if (!contact) throw new WorkflowSkip("record has no contact");
    const email = contact.email?.trim();
    if (!email) throw new WorkflowSkip("contact has no email address");
    return { email, userId: null };
  }
  const user = await resolveUserRecipient(cfg, ctx);
  return { email: user.email, userId: user.id };
}
