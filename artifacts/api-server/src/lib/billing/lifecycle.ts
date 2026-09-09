// Batch 20 — subscription lifecycle and entitlement policy. PURE: no database,
// no config, no provider. Everything that decides "what may this tenant do" or
// "which transition is legal" lives here so the same policy is applied by the
// login path, the per-request gate, the refresh-token path, the mutation
// firewall, the platform-owner lifecycle service, the webhook processor and the
// UI projection.

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "cancelled", "expired", "suspended"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_SOURCES = ["manual", "stripe"] as const;
export type BillingSource = (typeof BILLING_SOURCES)[number];

export const PLAN_IDS = ["free", "starter", "professional", "business", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export type AccessMode = "full" | "read_only" | "blocked";

export function isSubscriptionStatus(v: unknown): v is SubscriptionStatus {
  return typeof v === "string" && (SUBSCRIPTION_STATUSES as readonly string[]).includes(v);
}
export function isBillingSource(v: unknown): v is BillingSource {
  return typeof v === "string" && (BILLING_SOURCES as readonly string[]).includes(v);
}
export function isPlanId(v: unknown): v is PlanId {
  return typeof v === "string" && (PLAN_IDS as readonly string[]).includes(v);
}

// Legacy status values (pre-Batch 20 rows) → canonical states. The repair
// command applies this normalization; the resolver also tolerates it so a
// not-yet-repaired row is interpreted exactly as the legacy gate did.
export function normalizeLegacyStatus(raw: string): SubscriptionStatus | null {
  if (raw === "trial") return "trialing";
  return isSubscriptionStatus(raw) ? raw : null;
}

// ── Entitlement ──────────────────────────────────────────────────────────────

export interface EntitlementInput {
  status: string;
  trialExpiresAt: Date | null;
  currentPeriodEndsAt?: Date | null;
  cancelAtPeriodEnd?: boolean;
}

export type EntitlementReason =
  | "SUBSCRIPTION_MISSING"
  | "SUBSCRIPTION_SUSPENDED"
  | "SUBSCRIPTION_EXPIRED"
  | "TRIAL_ENDED"
  | "PAST_DUE"
  | "SUBSCRIPTION_CANCELLED"
  | "UNKNOWN_STATUS";

export interface Entitlement {
  accessMode: AccessMode;
  reasonCode: EntitlementReason | null;
  // Client-safe sentence shown when an action is unavailable (never provider detail).
  message: string | null;
}

const MESSAGES: Record<EntitlementReason, string> = {
  SUBSCRIPTION_MISSING: "Your company has no subscription record. Please contact support.",
  SUBSCRIPTION_SUSPENDED: "Your company account has been suspended. Please contact support.",
  SUBSCRIPTION_EXPIRED: "Your subscription has expired. Please contact support to renew.",
  TRIAL_ENDED: "Your free trial has ended. Please contact support to activate your subscription.",
  PAST_DUE: "Your subscription payment is past due. Access is read-only until billing is updated.",
  SUBSCRIPTION_CANCELLED: "Your subscription is cancelled. Access is read-only until it is reactivated.",
  UNKNOWN_STATUS: "Your subscription is in an unrecognized state. Please contact support.",
};

export function entitlementMessage(code: EntitlementReason): string {
  return MESSAGES[code];
}

// The single access policy (see docs/B20_SUBSCRIPTION_LIFECYCLE.md):
//   trialing (before trial end) → full     trialing (after)  → blocked (TRIAL_ENDED)
//   active                      → full     past_due          → read_only
//   cancelled                   → read_only expired/suspended → blocked
//   missing row                 → blocked (fail closed; the repair command
//                                 guarantees a row before the new API serves)
// A Stripe cancellation scheduled for period end keeps `active` until the
// provider reports the cancellation, so cancelAtPeriodEnd never blocks on its own.
export function resolveEntitlement(sub: EntitlementInput | null | undefined, now: Date = new Date()): Entitlement {
  if (!sub) return { accessMode: "blocked", reasonCode: "SUBSCRIPTION_MISSING", message: MESSAGES.SUBSCRIPTION_MISSING };
  const status = normalizeLegacyStatus(sub.status);
  switch (status) {
    case "suspended":
      return { accessMode: "blocked", reasonCode: "SUBSCRIPTION_SUSPENDED", message: MESSAGES.SUBSCRIPTION_SUSPENDED };
    case "expired":
      return { accessMode: "blocked", reasonCode: "SUBSCRIPTION_EXPIRED", message: MESSAGES.SUBSCRIPTION_EXPIRED };
    case "trialing":
      if (sub.trialExpiresAt && sub.trialExpiresAt.getTime() <= now.getTime()) {
        return { accessMode: "blocked", reasonCode: "TRIAL_ENDED", message: MESSAGES.TRIAL_ENDED };
      }
      return { accessMode: "full", reasonCode: null, message: null };
    case "active":
      return { accessMode: "full", reasonCode: null, message: null };
    case "past_due":
      return { accessMode: "read_only", reasonCode: "PAST_DUE", message: MESSAGES.PAST_DUE };
    case "cancelled":
      return { accessMode: "read_only", reasonCode: "SUBSCRIPTION_CANCELLED", message: MESSAGES.SUBSCRIPTION_CANCELLED };
    default:
      return { accessMode: "blocked", reasonCode: "UNKNOWN_STATUS", message: MESSAGES.UNKNOWN_STATUS };
  }
}

// ── Billing capabilities (what the tenant may do about it) ───────────────────

export interface CapabilityContext {
  providerAvailable: boolean;
  checkoutEnabled: boolean;
  portalConfigured: boolean;
  hasActivePrices: boolean;
}

export type CapabilityReason =
  | "PROVIDER_UNAVAILABLE"
  | "CHECKOUT_DISABLED"
  | "NO_ACTIVE_PRICES"
  | "STATUS_NOT_ELIGIBLE"
  | "LIVE_SUBSCRIPTION_EXISTS"
  | "NOT_PROVIDER_MANAGED"
  | "NO_PROVIDER_CUSTOMER";

export interface BillingCapabilities {
  checkoutAvailable: boolean;
  checkoutUnavailableReason: CapabilityReason | null;
  portalAvailable: boolean;
  portalUnavailableReason: CapabilityReason | null;
}

export interface CapabilitySubscription {
  status: string;
  billingSource: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

// Provider statuses under which a Stripe subscription object still represents a
// live commitment (a second Checkout must not create a duplicate subscription).
export const LIVE_PROVIDER_STATUSES = new Set(["trialing", "active", "past_due", "unpaid", "paused", "incomplete"]);

export function resolveBillingCapabilities(
  sub: CapabilitySubscription,
  ctx: CapabilityContext,
  providerStatus: string | null = null,
): BillingCapabilities {
  const status = normalizeLegacyStatus(sub.status);
  const liveProviderSubscription =
    sub.billingSource === "stripe" && !!sub.stripeSubscriptionId && (providerStatus == null || LIVE_PROVIDER_STATUSES.has(providerStatus));

  let checkoutUnavailableReason: CapabilityReason | null = null;
  if (!ctx.providerAvailable) checkoutUnavailableReason = "PROVIDER_UNAVAILABLE";
  else if (!ctx.checkoutEnabled) checkoutUnavailableReason = "CHECKOUT_DISABLED";
  else if (!ctx.hasActivePrices) checkoutUnavailableReason = "NO_ACTIVE_PRICES";
  else if (liveProviderSubscription) checkoutUnavailableReason = "LIVE_SUBSCRIPTION_EXISTS";
  else if (status !== "trialing" && status !== "cancelled") checkoutUnavailableReason = "STATUS_NOT_ELIGIBLE";

  let portalUnavailableReason: CapabilityReason | null = null;
  if (!ctx.providerAvailable) portalUnavailableReason = "PROVIDER_UNAVAILABLE";
  else if (sub.billingSource !== "stripe") portalUnavailableReason = "NOT_PROVIDER_MANAGED";
  else if (!sub.stripeCustomerId) portalUnavailableReason = "NO_PROVIDER_CUSTOMER";
  else if (status === "expired" || status === "suspended") portalUnavailableReason = "STATUS_NOT_ELIGIBLE";

  return {
    checkoutAvailable: checkoutUnavailableReason === null,
    checkoutUnavailableReason,
    portalAvailable: portalUnavailableReason === null,
    portalUnavailableReason,
  };
}

// ── Transition table (platform-owner / system actions) ───────────────────────

export const LIFECYCLE_ACTIONS = [
  "set_plan",
  "start_trial",
  "activate",
  "mark_past_due",
  "cancel",
  "expire",
  "suspend",
  "reactivate",
  "set_limits",
  "convert_to_manual",
  "sync_provider",
  "sweep_expire_trial",
] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

interface TransitionRule {
  from: readonly SubscriptionStatus[] | "any";
  // Resulting status; null = status unchanged; "restore" = statusBeforeSuspension.
  to: SubscriptionStatus | null | "restore";
  sources: readonly BillingSource[];
}

const ALL: readonly SubscriptionStatus[] = SUBSCRIPTION_STATUSES;

export const TRANSITIONS: Record<LifecycleAction, TransitionRule> = {
  set_plan: { from: "any", to: null, sources: ["manual"] },
  start_trial: { from: ["trialing", "expired", "cancelled"], to: "trialing", sources: ["manual"] },
  activate: { from: ["trialing", "past_due", "cancelled", "expired"], to: "active", sources: ["manual"] },
  mark_past_due: { from: ["active"], to: "past_due", sources: ["manual"] },
  cancel: { from: ["trialing", "active", "past_due"], to: "cancelled", sources: ["manual"] },
  expire: { from: ["trialing", "active", "past_due", "cancelled"], to: "expired", sources: ["manual"] },
  suspend: { from: ["trialing", "active", "past_due", "cancelled", "expired"], to: "suspended", sources: ["manual", "stripe"] },
  reactivate: { from: ["suspended"], to: "restore", sources: ["manual", "stripe"] },
  set_limits: { from: "any", to: null, sources: ["manual", "stripe"] },
  convert_to_manual: { from: "any", to: null, sources: ["stripe"] },
  sync_provider: { from: "any", to: null, sources: ["stripe"] },
  // System sweep: an elapsed manual trial becomes expired.
  sweep_expire_trial: { from: ["trialing"], to: "expired", sources: ["manual"] },
};

export type TransitionCheck =
  | { ok: true; to: SubscriptionStatus | null }
  | { ok: false; code: "INVALID_TRANSITION" | "MANAGED_BY_PROVIDER" | "NOT_PROVIDER_MANAGED" | "NO_RESTORE_STATE" };

export function checkTransition(
  action: LifecycleAction,
  current: { status: string; billingSource: string; statusBeforeSuspension?: string | null },
): TransitionCheck {
  const rule = TRANSITIONS[action];
  const status = normalizeLegacyStatus(current.status);
  const source = isBillingSource(current.billingSource) ? current.billingSource : "manual";
  if (!rule.sources.includes(source)) {
    return { ok: false, code: source === "stripe" ? "MANAGED_BY_PROVIDER" : "NOT_PROVIDER_MANAGED" };
  }
  if (rule.from !== "any" && (status === null || !rule.from.includes(status))) {
    return { ok: false, code: "INVALID_TRANSITION" };
  }
  if (rule.to === "restore") {
    const prev = current.statusBeforeSuspension ? normalizeLegacyStatus(current.statusBeforeSuspension) : null;
    if (!prev || prev === "suspended") return { ok: false, code: "NO_RESTORE_STATE" };
    return { ok: true, to: prev };
  }
  return { ok: true, to: rule.to };
}

export function allowedActions(current: { status: string; billingSource: string; statusBeforeSuspension?: string | null }): LifecycleAction[] {
  return LIFECYCLE_ACTIONS.filter((a) => a !== "sweep_expire_trial" && checkTransition(a, current).ok);
}

// ── Provider (Stripe) status mapping ─────────────────────────────────────────
//
//   trialing           → trialing        active   → active
//   past_due           → past_due        unpaid   → past_due (read-only)
//   paused             → past_due (read-only; collection paused)
//   canceled           → cancelled
//   incomplete         → NO CHANGE (an unfinished Checkout never removes the
//   incomplete_expired → NO CHANGE  most recent valid entitlement)
export type ProviderStatusMapping = { status: SubscriptionStatus | null; note: string };

export function mapProviderStatus(providerStatus: string): ProviderStatusMapping {
  switch (providerStatus) {
    case "trialing":
      return { status: "trialing", note: "provider trial" };
    case "active":
      return { status: "active", note: "provider active" };
    case "past_due":
      return { status: "past_due", note: "provider past_due" };
    case "unpaid":
      return { status: "past_due", note: "provider unpaid → read-only" };
    case "paused":
      return { status: "past_due", note: "provider paused → read-only" };
    case "canceled":
      return { status: "cancelled", note: "provider canceled" };
    case "incomplete":
    case "incomplete_expired":
      return { status: null, note: `provider ${providerStatus} → entitlement unchanged` };
    default:
      return { status: null, note: `provider ${providerStatus} unknown → entitlement unchanged` };
  }
}

// ── Usage window (scan consumption) ──────────────────────────────────────────
//
// The window is the current billing period when the subscription carries one
// (Stripe-managed, or a manual period set by the platform owner). Otherwise it is
// the rolling calendar-month window anchored at usage_anchor_at → trial_started_at
// → created_at: the window containing `now` starts at the latest monthly
// anniversary of the anchor that is <= now and ends at the next one.

export interface UsageWindowInput {
  currentPeriodStartsAt: Date | null;
  currentPeriodEndsAt: Date | null;
  usageAnchorAt: Date | null;
  trialStartedAt: Date | null;
  createdAt: Date;
}

export interface UsageWindow {
  startsAt: Date;
  endsAt: Date;
  source: "billing_period" | "anchored_month";
}

function addMonthsUtc(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(y, m, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

export function resolveUsageWindow(sub: UsageWindowInput, now: Date = new Date()): UsageWindow {
  const ps = sub.currentPeriodStartsAt;
  const pe = sub.currentPeriodEndsAt;
  if (ps && pe && ps.getTime() <= now.getTime() && now.getTime() < pe.getTime()) {
    return { startsAt: ps, endsAt: pe, source: "billing_period" };
  }
  const anchor = sub.usageAnchorAt ?? sub.trialStartedAt ?? sub.createdAt;
  if (anchor.getTime() > now.getTime()) {
    return { startsAt: addMonthsUtc(anchor, -1), endsAt: anchor, source: "anchored_month" };
  }
  // Number of whole months elapsed since the anchor (bounded; then adjust).
  let months = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  let start = addMonthsUtc(anchor, months);
  while (start.getTime() > now.getTime()) {
    months -= 1;
    start = addMonthsUtc(anchor, months);
  }
  let end = addMonthsUtc(anchor, months + 1);
  while (end.getTime() <= now.getTime()) {
    months += 1;
    start = addMonthsUtc(anchor, months);
    end = addMonthsUtc(anchor, months + 1);
  }
  return { startsAt: start, endsAt: end, source: "anchored_month" };
}

// ── Effective limits ─────────────────────────────────────────────────────────

export const LIMIT_RESOURCES = ["contacts", "events", "admins", "employees", "scans", "storageMb"] as const;
export type LimitResource = (typeof LIMIT_RESOURCES)[number];

export type LimitOverrides = Partial<Record<LimitResource, number | null>>;

export interface PlanLimitDefaults {
  contactsLimit: number | null;
  eventsLimit: number | null;
  adminsLimit: number | null;
  employeesLimit: number | null;
  scansLimit: number | null;
  storageLimitMb: number | null;
}

export interface EffectiveLimit {
  resource: LimitResource;
  limit: number | null; // null = unlimited
  source: "override" | "plan" | "unlimited";
}

const PLAN_KEY: Record<LimitResource, keyof PlanLimitDefaults> = {
  contacts: "contactsLimit",
  events: "eventsLimit",
  admins: "adminsLimit",
  employees: "employeesLimit",
  scans: "scansLimit",
  storageMb: "storageLimitMb",
};

// override ?? plan default ?? unlimited. An override of `null` explicitly means
// "no override" (falls through to the plan), never "unlimited".
export function resolveEffectiveLimits(plan: PlanLimitDefaults | null | undefined, overrides: LimitOverrides | null | undefined): EffectiveLimit[] {
  return LIMIT_RESOURCES.map((resource) => {
    const o = overrides?.[resource];
    if (typeof o === "number" && Number.isFinite(o) && o >= 0) return { resource, limit: Math.floor(o), source: "override" };
    const p = plan?.[PLAN_KEY[resource]];
    if (typeof p === "number" && Number.isFinite(p) && p >= 0) return { resource, limit: Math.floor(p), source: "plan" };
    return { resource, limit: null, source: "unlimited" };
  });
}

export function limitFor(limits: EffectiveLimit[], resource: LimitResource): number | null {
  return limits.find((l) => l.resource === resource)?.limit ?? null;
}

// Legacy `companies.status` mirror value for a canonical state (compatibility
// only — never read for authorization). `past_due` has no legacy equivalent;
// it mirrors as `active` because the legacy column never modelled read-only
// billing states other than `cancelled`.
export function legacyCompanyStatus(status: SubscriptionStatus): string {
  switch (status) {
    case "trialing":
      return "trial";
    case "past_due":
      return "active";
    default:
      return status;
  }
}
