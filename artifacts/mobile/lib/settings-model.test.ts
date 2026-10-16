// B25 Stage 1 — mobile account-state isolation.
// Found on a physical device: the active event ("Leap") chosen under the real
// tenant survived logout, so a different account in a different tenant (with
// zero events) saw it on the Capture screen and every capture path would have
// sent that foreign eventId. activeEventId/activeEventName and
// contactFilters.eventId lived in device-wide `csp_settings` with no owner, and
// nothing on the auth boundary reset them.
// Red on 72a2437: tenant B inherits tenant A's event after logout, after a
// session replacement and from legacy settings; no stale event is ever cleared.
import { describe, expect, it } from "vitest";

import {
  type AppSettings,
  DEFAULT_SETTINGS,
  accountOwnerKey,
  applyPatch,
  bindSettingsToAccount,
  parseStoredSettings,
  reconcileAccessibleEvents,
  selectActiveEvent,
  visibleSettings,
  withCaptureEvent,
} from "./settings-model";

const TENANT_A_USER = { id: 11, companyId: 1 };
const TENANT_B_USER = { id: 77, companyId: 53 };
const OWNER_A = accountOwnerKey(TENANT_A_USER);
const OWNER_B = accountOwnerKey(TENANT_B_USER);
const LEAP = { id: 501, name: "Leap" };

/** What the provider writes to AsyncStorage and reads back on the next launch. */
function persistAndReload(s: AppSettings): AppSettings {
  return parseStoredSettings(JSON.stringify(s));
}

function tenantAWithLeap(): AppSettings {
  let s = bindSettingsToAccount(parseStoredSettings(null), OWNER_A);
  s = selectActiveEvent(s, LEAP.id, LEAP.name, OWNER_A);
  s = applyPatch(s, { contactFilters: { ...s.contactFilters, eventId: LEAP.id } });
  return persistAndReload(s);
}

function expectNoTenantEvent(s: AppSettings) {
  expect(s.activeEventId).toBeNull();
  expect(s.activeEventName).toBeNull();
  expect(s.contactFilters.eventId).toBeNull();
}

describe("account owner key", () => {
  it("binds to both the user and the tenant", () => {
    expect(OWNER_A).not.toBe(OWNER_B);
    expect(accountOwnerKey({ id: 11, companyId: 2 })).not.toBe(OWNER_A);
    expect(accountOwnerKey(null)).toBeNull();
    expect(accountOwnerKey({ id: 1, companyId: null })).toBe("1@platform");
  });
});

describe("1. RED proof — tenant A's event must not reach tenant B (the device scenario)", () => {
  it("logout under A then login as B yields no active event and no event filter", () => {
    let s = tenantAWithLeap();
    expect(visibleSettings(s, OWNER_A).activeEventId).toBe(LEAP.id);

    s = persistAndReload(bindSettingsToAccount(s, null)); // logout
    s = persistAndReload(bindSettingsToAccount(s, OWNER_B)); // login as B

    expectNoTenantEvent(visibleSettings(s, OWNER_B));
    expectNoTenantEvent(s);
  });
});

describe("2. logout clears tenant-scoped state in memory AND in storage", () => {
  it("nulls activeEventId, activeEventName and contactFilters.eventId", () => {
    const loggedOut = bindSettingsToAccount(tenantAWithLeap(), null);
    expectNoTenantEvent(loggedOut); // in-memory value the provider keeps
    expectNoTenantEvent(persistAndReload(loggedOut)); // what AsyncStorage now holds
    expect(loggedOut.scopeOwner).toBeNull();
  });

  it("the logged-out (login screen) view exposes no event even before storage is rewritten", () => {
    expectNoTenantEvent(visibleSettings(tenantAWithLeap(), null));
  });
});

describe("3. tenant switch", () => {
  it("A selects an event, the account changes to B: B receives nothing from A", () => {
    const switched = bindSettingsToAccount(tenantAWithLeap(), OWNER_B);
    expectNoTenantEvent(switched);
    expect(switched.scopeOwner).toBe(OWNER_B);
    expectNoTenantEvent(visibleSettings(switched, OWNER_B));
  });

  it("the same user id in a different tenant is a different owner", () => {
    const sameUserOtherTenant = accountOwnerKey({ id: TENANT_A_USER.id, companyId: 99 });
    expectNoTenantEvent(bindSettingsToAccount(tenantAWithLeap(), sameUserOtherTenant));
  });
});

describe("4. session replacement without a clean logout", () => {
  it("a new login while A's settings are still persisted (no logout) resets them", () => {
    // AuthContext.login is called for B (password, MFA or biometric vault) with
    // A's ownership still on disk — no logout ever ran.
    expectNoTenantEvent(persistAndReload(bindSettingsToAccount(tenantAWithLeap(), OWNER_B)));
  });

  it("an app restart that restores a different account's session resets them", () => {
    const restoredAsB = bindSettingsToAccount(persistAndReload(tenantAWithLeap()), OWNER_B);
    expectNoTenantEvent(restoredAsB);
  });

  it("even before the binding is applied, an unbound or mismatched view exposes nothing", () => {
    const s = tenantAWithLeap();
    expectNoTenantEvent(visibleSettings(s, undefined)); // auth still loading
    expectNoTenantEvent(visibleSettings(s, OWNER_B)); // B bound, storage not yet rewritten
  });
});

describe("5. legacy csp_settings without ownership metadata", () => {
  const LEGACY_RAW = JSON.stringify({
    theme: "dark",
    language: "ar",
    activeEventId: LEAP.id,
    activeEventName: LEAP.name,
    contactFilters: { ...DEFAULT_SETTINGS.contactFilters, eventId: LEAP.id },
  });

  it("is never trusted for a newly authenticated account", () => {
    const loaded = parseStoredSettings(LEGACY_RAW);
    expectNoTenantEvent(visibleSettings(loaded, OWNER_B));
    expectNoTenantEvent(visibleSettings(loaded, OWNER_A));
    const bound = bindSettingsToAccount(loaded, OWNER_B);
    expectNoTenantEvent(bound);
    expect(bound.theme).toBe("dark");
    expect(bound.language).toBe("ar");
  });
});

describe("6. an active event missing from the current tenant's complete event list", () => {
  it("is cleared (with the event filter) before any capture can use it", () => {
    const s = tenantAWithLeap();
    const reconciled = reconcileAccessibleEvents(s, [{ id: 1 }, { id: 2 }], 2);
    expectNoTenantEvent(reconciled);
    expectNoTenantEvent(visibleSettings(reconciled, OWNER_A));
    expect(withCaptureEvent({}, visibleSettings(reconciled, OWNER_A)).eventId).toBeNull();
  });

  it("is kept when the list is only a partial page (absence is not proven)", () => {
    const s = tenantAWithLeap();
    const partial = reconcileAccessibleEvents(s, [{ id: 1 }], 250);
    expect(partial.activeEventId).toBe(LEAP.id);
  });

  it("an empty complete list (tenant with zero events) clears it", () => {
    expectNoTenantEvent(reconcileAccessibleEvents(tenantAWithLeap(), [], 0));
  });
});

describe("7. 'No event' in the picker", () => {
  it("clears both the id and the name", () => {
    const cleared = selectActiveEvent(tenantAWithLeap(), null, null, OWNER_A);
    expect(cleared.activeEventId).toBeNull();
    expect(cleared.activeEventName).toBeNull();
    expect(visibleSettings(cleared, OWNER_A).activeEventId).toBeNull();
  });
});

describe("8. capture payload after an account switch", () => {
  it("manual capture sends eventId = null until B explicitly selects a B event", () => {
    let s = bindSettingsToAccount(tenantAWithLeap(), OWNER_B);
    const payload = withCaptureEvent({ firstName: "B25" }, visibleSettings(s, OWNER_B));
    expect(payload).toEqual({ firstName: "B25", eventId: null });

    s = selectActiveEvent(s, 9001, "B25 Physical Test Event", OWNER_B);
    expect(withCaptureEvent({ firstName: "B25" }, visibleSettings(s, OWNER_B)).eventId).toBe(9001);
  });
});

describe("9. a valid current-tenant event keeps working", () => {
  it("survives restart for the same account and reconciliation that contains it", () => {
    let s = tenantAWithLeap();
    s = bindSettingsToAccount(persistAndReload(s), OWNER_A); // restart, same session
    expect(visibleSettings(s, OWNER_A).activeEventId).toBe(LEAP.id);
    expect(visibleSettings(s, OWNER_A).activeEventName).toBe(LEAP.name);
    s = reconcileAccessibleEvents(s, [{ id: 3 }, { id: LEAP.id }], 2);
    expect(visibleSettings(s, OWNER_A).activeEventId).toBe(LEAP.id);
    expect(visibleSettings(s, OWNER_A).contactFilters.eventId).toBe(LEAP.id);
    expect(bindSettingsToAccount(s, OWNER_A)).toBe(s); // no rewrite when nothing changes
  });

  it("selecting another accessible event updates capture normally", () => {
    const s = selectActiveEvent(tenantAWithLeap(), 502, "Gitex", OWNER_A);
    expect(withCaptureEvent({}, visibleSettings(s, OWNER_A)).eventId).toBe(502);
  });
});

describe("10. device-level preferences survive the account reset", () => {
  it("theme, language, country, capture mode, notifications, biometric and lock timeout are untouched", () => {
    let s = bindSettingsToAccount(parseStoredSettings(null), OWNER_A);
    s = applyPatch(s, {
      theme: "dark",
      language: "ar",
      country: "AE",
      captureMode: "batch",
      followUpNotifications: false,
      meetingReminders: false,
      biometricEnabled: true,
      lockTimeoutMs: 300_000,
    });
    s = selectActiveEvent(s, LEAP.id, LEAP.name, OWNER_A);
    const device = (x: AppSettings) => ({
      theme: x.theme,
      language: x.language,
      country: x.country,
      captureMode: x.captureMode,
      followUpNotifications: x.followUpNotifications,
      meetingReminders: x.meetingReminders,
      biometricEnabled: x.biometricEnabled,
      lockTimeoutMs: x.lockTimeoutMs,
    });
    const before = device(s);
    expect(device(persistAndReload(bindSettingsToAccount(s, null)))).toEqual(before);
    expect(device(persistAndReload(bindSettingsToAccount(s, OWNER_B)))).toEqual(before);
  });

  it("keeps the legacy single `notifications` flag migration", () => {
    const s = parseStoredSettings(JSON.stringify({ notifications: false }));
    expect(s.followUpNotifications).toBe(false);
    expect(s.meetingReminders).toBe(false);
  });
});

describe("11. persisted contact-filter event", () => {
  it("is reset on the account boundary while non-tenant filter choices stay", () => {
    let s = bindSettingsToAccount(parseStoredSettings(null), OWNER_A);
    s = applyPatch(s, {
      contactFilters: { ...s.contactFilters, eventId: LEAP.id, sort: "name", status: "contacted" },
    });
    const switched = persistAndReload(bindSettingsToAccount(s, OWNER_B));
    expect(switched.contactFilters.eventId).toBeNull();
    expect(switched.contactFilters.sort).toBe("name");
    expect(switched.contactFilters.status).toBe("contacted");
  });

  it("a filter event missing from the current tenant's complete list is cleared", () => {
    let s = bindSettingsToAccount(parseStoredSettings(null), OWNER_A);
    s = applyPatch(s, { contactFilters: { ...s.contactFilters, eventId: 404 } });
    expect(reconcileAccessibleEvents(s, [{ id: 1 }], 1).contactFilters.eventId).toBeNull();
  });
});

// MOBILE-R2 — intentional "No Event" capture: warn once, never repeatedly; the
// acknowledgement is tenant data (reset on every auth boundary and when an event
// is selected), so it can never leak a choice across accounts.
import { acknowledgeNoEvent, captureEventDecision } from "./settings-model";

describe("11. first-scan warning without an event (MOBILE-R2)", () => {
  it("a freshly bound account with no event is warned before the first capture", () => {
    const s = bindSettingsToAccount(parseStoredSettings(null), OWNER_A);
    expect(captureEventDecision(s)).toBe("warn");
  });

  it("'Continue with No Event' acknowledges once; later captures proceed without another warning (also after a restart)", () => {
    let s = bindSettingsToAccount(parseStoredSettings(null), OWNER_A);
    s = acknowledgeNoEvent(s, OWNER_A);
    expect(s.noEventAcknowledged).toBe(true);
    expect(captureEventDecision(s)).toBe("proceed");
    expect(withCaptureEvent({ firstName: "A" }, s).eventId).toBeNull();
    const reloaded = persistAndReload(s);
    expect(captureEventDecision(visibleSettings(reloaded, OWNER_A))).toBe("proceed");
    expect(acknowledgeNoEvent(reloaded, OWNER_A)).toBe(reloaded); // idempotent: no storage write
  });

  it("picking 'No event' in the picker is intentional: no warning follows", () => {
    let s = tenantAWithLeap();
    s = selectActiveEvent(s, null, null, OWNER_A);
    expect(s.activeEventId).toBeNull();
    expect(s.activeEventName).toBeNull();
    expect(s.noEventAcknowledged).toBe(true);
    expect(captureEventDecision(s)).toBe("proceed");
  });

  it("clearing non-intentionally (e.g. reconciliation drops a deleted event) keeps the warning", () => {
    let s = tenantAWithLeap();
    s = reconcileAccessibleEvents(s, [], 0);
    expect(s.activeEventId).toBeNull();
    expect(s.noEventAcknowledged).toBe(false);
    expect(captureEventDecision(s)).toBe("warn");
    expect(captureEventDecision(selectActiveEvent(tenantAWithLeap(), null, null, OWNER_A, { intentional: false }))).toBe("warn");
  });

  it("selecting an event resets the acknowledgement, so clearing it later warns again unless chosen intentionally", () => {
    let s = acknowledgeNoEvent(bindSettingsToAccount(parseStoredSettings(null), OWNER_A), OWNER_A);
    s = selectActiveEvent(s, LEAP.id, LEAP.name, OWNER_A);
    expect(s.noEventAcknowledged).toBe(false);
    expect(captureEventDecision(s)).toBe("proceed"); // an event is active
    expect(captureEventDecision(reconcileAccessibleEvents(s, [], 0))).toBe("warn");
  });

  it("the acknowledgement is tenant state: logout, a different account and legacy settings never inherit it", () => {
    const acked = persistAndReload(acknowledgeNoEvent(bindSettingsToAccount(parseStoredSettings(null), OWNER_A), OWNER_A));
    expect(bindSettingsToAccount(acked, null).noEventAcknowledged).toBe(false);
    expect(bindSettingsToAccount(acked, OWNER_B).noEventAcknowledged).toBe(false);
    expect(visibleSettings(acked, OWNER_B).noEventAcknowledged).toBe(false);
    expect(visibleSettings(acked, undefined).noEventAcknowledged).toBe(false);
    const legacy = parseStoredSettings(JSON.stringify({ ...DEFAULT_SETTINGS, noEventAcknowledged: true, scopeOwner: null }));
    expect(bindSettingsToAccount(legacy, OWNER_A).noEventAcknowledged).toBe(false);
    expect(captureEventDecision(bindSettingsToAccount(legacy, OWNER_A))).toBe("warn");
    // Nobody signed in: nothing to acknowledge, nothing stored.
    expect(acknowledgeNoEvent(DEFAULT_SETTINGS, null)).toBe(DEFAULT_SETTINGS);
    expect(parseStoredSettings(JSON.stringify({ noEventAcknowledged: "yes" })).noEventAcknowledged).toBe(false);
  });
});
