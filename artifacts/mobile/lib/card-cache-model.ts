// The cached copy of the user's own digital business card (`csp_own_card`) as
// pure, framework-free rules, so CardContext stays a thin React/AsyncStorage
// shell and the account-isolation rules below are unit-tested.
//
// B25 Stage 1 — account-state isolation, part 3 (own-card cache ownership).
// The cached card is TENANT data (the signed-in person's own profile card,
// with server ids, the public token and company id). It is stored under the
// same deterministic owner key as the other isolated state (`accountOwnerKey`,
// `<userId>@<companyId>`, tenant accounts only):
//   • the cache is written ONLY with a resolved tenant owner, as one wrapper
//     `{ owner, card }` in the single storage slot (confidentiality over
//     keeping several accounts' cards on one device);
//   • it is exposed ONLY to that exact owner — never while logged out, never
//     before auth resolves, never to another account (also offline);
//   • a cache written before ownership existed (a raw card, no owner) or with
//     malformed ownership is legacy: ignored and removed, never assigned to
//     whoever signs in next;
//   • an optimistic (offline) edit may reuse server-owned fields (ids, public
//     token, company, visibility, template) ONLY from the current owner's own
//     cached card, never from another account's.
import type { BusinessCard, BusinessCardInput } from "@workspace/api-client-react";

import { isTenantOwnerKey } from "./offline-queue-model";

export interface OwnedCardCache {
  owner: string;
  card: BusinessCard;
}

export type StoredCardCache =
  | { kind: "none" }
  | { kind: "owned"; cache: OwnedCardCache }
  /** Raw pre-ownership card or malformed wrapper: untrusted, to be removed. */
  | { kind: "legacy" };

function looksLikeCard(v: unknown): v is BusinessCard {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as BusinessCard).publicToken === "string";
}

/**
 * Parse the persisted slot. Only `{ owner: <tenant key>, card: <card> }` is
 * trusted; a bare card (the pre-fix shape), a wrapper without a valid tenant
 * owner, or anything else is `legacy` (never adopted by any account).
 */
export function parseStoredCardCache(raw: string | null): StoredCardCache {
  if (!raw) return { kind: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "legacy" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "legacy" };
  const wrapper = parsed as { owner?: unknown; card?: unknown };
  if (isTenantOwnerKey(wrapper.owner) && looksLikeCard(wrapper.card)) {
    return { kind: "owned", cache: { owner: wrapper.owner, card: wrapper.card } };
  }
  return { kind: "legacy" };
}

/** Serialize for storage; null (nothing may be written) without a tenant owner. */
export function serializeCardCache(owner: string | null | undefined, card: BusinessCard): string | null {
  if (!isTenantOwnerKey(owner)) return null;
  return JSON.stringify({ owner, card } satisfies OwnedCardCache);
}

/** The card the given account may see from the cache: its own, or nothing. */
export function visibleCachedCard(cache: OwnedCardCache | null, owner: string | null | undefined): BusinessCard | null {
  if (!cache || !isTenantOwnerKey(owner) || cache.owner !== owner) return null;
  return cache.card;
}

/** True when the stored slot belongs to this owner (so clearing it is clearing one's own cache). */
export function cacheBelongsTo(cache: OwnedCardCache | null, owner: string | null | undefined): boolean {
  return !!cache && isTenantOwnerKey(owner) && cache.owner === owner;
}

/**
 * Build an optimistic card from a pending input so the UI updates instantly
 * (offline or while the request is in flight). Server-owned fields (ids,
 * public token, company, visibility, template) are carried over ONLY from the
 * current owner's own cached card; any other account's card contributes
 * nothing, so an optimistic card never inherits foreign identity. Returns null
 * without a tenant owner (nothing may be built or cached).
 */
export function optimisticCardFor(
  input: BusinessCardInput,
  cache: OwnedCardCache | null,
  owner: string | null | undefined,
  account: { avatarUrl?: string | null; name?: string | null },
  now: string = new Date().toISOString(),
): BusinessCard | null {
  if (!isTenantOwnerKey(owner)) return null;
  const prev = visibleCachedCard(cache, owner);
  return {
    id: prev?.id ?? 0,
    userId: prev?.userId ?? 0,
    companyId: prev?.companyId ?? null,
    publicToken: prev?.publicToken ?? "",
    fullName: input.fullName,
    designation: input.designation ?? null,
    companyName: input.companyName ?? null,
    email: input.email ?? null,
    primaryPhone: input.primaryPhone ?? null,
    alternatePhone: input.alternatePhone ?? null,
    officeAddress: input.officeAddress ?? null,
    website: input.website ?? null,
    linkedin: input.linkedin ?? null,
    facebook: input.facebook ?? null,
    instagram: input.instagram ?? null,
    twitter: input.twitter ?? null,
    youtube: input.youtube ?? null,
    fieldVisibility: input.fieldVisibility ?? prev?.fieldVisibility ?? {},
    templateId: input.templateId ?? prev?.templateId ?? "classic",
    isPublished: input.isPublished ?? prev?.isPublished ?? true,
    avatarUrl: account.avatarUrl ?? prev?.avatarUrl ?? null,
    accountName: account.name ?? prev?.accountName ?? null,
    publicUrl: prev?.publicUrl ?? null,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
}
