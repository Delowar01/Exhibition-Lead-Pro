// Persisted app settings (`csp_settings`) as pure, framework-free state
// transitions, so SettingsContext stays a thin React/AsyncStorage shell and the
// account-isolation rules below are unit-tested.
//
// B25 Stage 1 — account-state isolation. Most settings are device preferences
// (theme, language, country, capture mode, notifications, app lock). Three
// values are TENANT data: activeEventId, activeEventName and
// contactFilters.eventId. They are owned by the account that chose them
// (`scopeOwner` = user id + company id) and are only ever exposed to that same
// authenticated account:
//   • every auth boundary (login, logout, session restore) binds the settings to
//     the current account; a different owner — or none — resets the tenant data,
//     in memory and in storage;
//   • settings written before ownership existed have no owner and are therefore
//     never trusted for any account (fail safe, no manual data clear needed);
//   • the exposed view hides tenant data unless the stored owner equals the
//     bound account, so nothing leaks while auth or storage is still loading;
//   • an event missing from the tenant's complete event list is dropped.
import { DEFAULT_COUNTRY, type CountryCode } from "./countries";

export type ThemePref = "light" | "dark" | "system";
export type CaptureModePref = "single" | "rapid" | "batch";
export type LanguagePref = "en" | "ar";
export type ContactSortPref = "newest" | "oldest" | "name";
/** 0 = lock immediately when screen turns off; others = grace period in ms. */
export type LockTimeoutMs = 0 | 15_000 | 30_000 | 60_000 | 300_000;

export interface ContactFilters {
  sort: ContactSortPref;
  status: string | null;
  eventId: number | null;
  temperature: string | null;
  hasFollowUp: boolean;
  hasMeeting: boolean;
  dateFrom: string | null;
  dateTo: string | null;
}

export const DEFAULT_CONTACT_FILTERS: ContactFilters = {
  sort: "newest",
  status: null,
  eventId: null,
  temperature: null,
  hasFollowUp: false,
  hasMeeting: false,
  dateFrom: null,
  dateTo: null,
};

export interface AppSettings {
  theme: ThemePref;
  captureMode: CaptureModePref;
  followUpNotifications: boolean;
  meetingReminders: boolean;
  language: LanguagePref;
  country: CountryCode;
  biometricEnabled: boolean;
  lockTimeoutMs: LockTimeoutMs;
  activeEventId: number | null;
  activeEventName: string | null;
  contactFilters: ContactFilters;
  /** Account that owns the tenant-scoped values above; null = nobody. */
  scopeOwner: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  captureMode: "single",
  followUpNotifications: true,
  meetingReminders: true,
  language: "en",
  country: DEFAULT_COUNTRY,
  biometricEnabled: false,
  lockTimeoutMs: 30_000,
  activeEventId: null,
  activeEventName: null,
  contactFilters: DEFAULT_CONTACT_FILTERS,
  scopeOwner: null,
};

/** Parse persisted settings; unknown/corrupt input falls back to defaults. */
export function parseStoredSettings(raw: string | null): AppSettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings> & { notifications?: boolean };
    const merged: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      contactFilters: { ...DEFAULT_CONTACT_FILTERS, ...parsed.contactFilters },
      // Pre-ownership settings carry no owner: they never match an account.
      scopeOwner: typeof parsed.scopeOwner === "string" ? parsed.scopeOwner : null,
    };
    // Migrate from single `notifications` flag to two separate keys.
    // If the old key is present but the new keys are absent, carry the
    // legacy value forward so existing users keep their preference.
    const legacy = parsed.notifications;
    if (legacy !== undefined) {
      if (parsed.followUpNotifications === undefined) merged.followUpNotifications = legacy;
      if (parsed.meetingReminders === undefined) merged.meetingReminders = legacy;
    }
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function applyPatch(prev: AppSettings, next: Partial<AppSettings>): AppSettings {
  return { ...prev, ...next };
}

/** Owner of tenant-scoped settings: the user AND the tenant they act in. */
export function accountOwnerKey(user: { id: number; companyId?: number | null } | null | undefined): string | null {
  return user ? `${user.id}@${user.companyId ?? "platform"}` : null;
}

function withoutTenantState(settings: AppSettings, owner: string | null): AppSettings {
  return {
    ...settings,
    activeEventId: null,
    activeEventName: null,
    contactFilters: { ...settings.contactFilters, eventId: null },
    scopeOwner: owner,
  };
}

/**
 * Bind settings to the authenticated account (null = logged out). Returns the
 * same object when nothing changes, so callers can skip a storage write.
 */
export function bindSettingsToAccount(settings: AppSettings, owner: string | null): AppSettings {
  if (owner !== null && settings.scopeOwner === owner) return settings;
  const hasTenantState =
    settings.activeEventId !== null ||
    settings.activeEventName !== null ||
    settings.contactFilters.eventId !== null;
  if (!hasTenantState && settings.scopeOwner === owner) return settings;
  return withoutTenantState(settings, owner);
}

/**
 * The settings a screen may see for the currently bound account
 * (undefined = auth not resolved yet, null = logged out).
 */
export function visibleSettings(settings: AppSettings, boundOwner: string | null | undefined): AppSettings {
  if (boundOwner && settings.scopeOwner === boundOwner) return settings;
  return withoutTenantState(settings, settings.scopeOwner);
}

/** Choose (or clear, with null) the capture event for the bound account. */
export function selectActiveEvent(
  settings: AppSettings,
  id: number | null,
  name: string | null,
  owner: string | null | undefined,
): AppSettings {
  const bound = owner ?? null;
  // Never carry another owner's filter into the newly stamped scope.
  const base = settings.scopeOwner === bound ? settings : withoutTenantState(settings, bound);
  return applyPatch(base, { activeEventId: id, activeEventName: id === null ? null : name, scopeOwner: bound });
}

/**
 * Drop an active event / event filter that the tenant's COMPLETE event list
 * does not contain (deleted, or never this tenant's). A partial page cannot
 * prove absence, so it changes nothing. Same object back when unchanged.
 */
export function reconcileAccessibleEvents(
  settings: AppSettings,
  events: ReadonlyArray<{ id: number }>,
  total: number,
): AppSettings {
  if (events.length < total) return settings;
  const ids = new Set(events.map((e) => e.id));
  const dropActive = settings.activeEventId !== null && !ids.has(settings.activeEventId);
  const dropFilter = settings.contactFilters.eventId !== null && !ids.has(settings.contactFilters.eventId);
  if (!dropActive && !dropFilter) return settings;
  return {
    ...settings,
    ...(dropActive ? { activeEventId: null, activeEventName: null } : {}),
    contactFilters: dropFilter ? { ...settings.contactFilters, eventId: null } : settings.contactFilters,
  };
}

/** Attach the capture event to a new-contact payload (null when none is active). */
export function withCaptureEvent<P extends object>(
  payload: P,
  settings: Pick<AppSettings, "activeEventId">,
): P & { eventId: number | null } {
  return { ...payload, eventId: settings.activeEventId ?? null };
}
