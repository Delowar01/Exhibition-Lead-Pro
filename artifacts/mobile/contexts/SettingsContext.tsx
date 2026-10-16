import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import i18n from "@/lib/i18n";
import type { CountryCode } from "@/lib/countries";
import {
  type AppSettings,
  type CaptureModePref,
  type ContactFilters,
  DEFAULT_SETTINGS,
  type LanguagePref,
  type LockTimeoutMs,
  type ThemePref,
  acknowledgeNoEvent,
  applyPatch,
  bindSettingsToAccount,
  parseStoredSettings,
  reconcileAccessibleEvents,
  selectActiveEvent,
  visibleSettings,
} from "@/lib/settings-model";

export {
  DEFAULT_CONTACT_FILTERS,
  type AppSettings,
  type CaptureModePref,
  type ContactFilters,
  type ContactSortPref,
  type LanguagePref,
  type LockTimeoutMs,
  type ThemePref,
} from "@/lib/settings-model";

interface SettingsContextValue extends Omit<AppSettings, "scopeOwner"> {
  isLoaded: boolean;
  setTheme: (value: ThemePref) => void;
  setCaptureMode: (value: CaptureModePref) => void;
  setFollowUpNotifications: (value: boolean) => void;
  setMeetingReminders: (value: boolean) => void;
  setLanguage: (value: LanguagePref) => void;
  setCountry: (value: CountryCode) => void;
  setBiometricEnabled: (value: boolean) => void;
  setLockTimeoutMs: (value: LockTimeoutMs) => void;
  /** Select an event; `null` clears it — an intentional "No Event" choice unless `intentional: false`. */
  setActiveEvent: (id: number | null, name: string | null, opts?: { intentional?: boolean }) => void;
  /** First-scan warning answered with "Continue with No Event": no further warning for this account. */
  acknowledgeNoEvent: () => void;
  setContactFilters: (value: ContactFilters) => void;
  /** Auth boundary: the account now signed in (owner key), or null after logout. */
  bindAccount: (owner: string | null) => void;
  /** Drop an active event / event filter missing from the tenant's event list. */
  reconcileEvents: (events: ReadonlyArray<{ id: number }>, total: number) => void;
}

const STORAGE_KEY = "csp_settings";

// A populated default value means consumers (notably useColors) keep working
// even when rendered outside the provider — e.g. an error-boundary fallback.
const SettingsContext = createContext<SettingsContextValue>({
  ...DEFAULT_SETTINGS,
  isLoaded: true,
  setTheme: () => {},
  setCaptureMode: () => {},
  setFollowUpNotifications: () => {},
  setMeetingReminders: () => {},
  setLanguage: () => {},
  setCountry: () => {},
  setBiometricEnabled: () => {},
  setLockTimeoutMs: () => {},
  setActiveEvent: () => {},
  acknowledgeNoEvent: () => {},
  setContactFilters: () => {},
  bindAccount: () => {},
  reconcileEvents: () => {},
});

function persist(settings: AppSettings) {
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);
  // Account bound by AuthProvider: undefined until auth resolves, null when
  // logged out. Tenant-scoped settings are only visible to this exact owner.
  const [boundOwner, setBoundOwner] = useState<string | null | undefined>(undefined);
  const ownerRef = useRef<string | null | undefined>(undefined);
  const loadedRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    const finish = (raw: string | null) => {
      if (!mounted) return;
      let loaded = parseStoredSettings(raw);
      // Auth may have resolved first; apply its binding to what was stored.
      const owner = ownerRef.current;
      if (owner !== undefined) {
        const bound = bindSettingsToAccount(loaded, owner);
        if (bound !== loaded) persist(bound);
        loaded = bound;
      }
      loadedRef.current = true;
      setSettings(loaded);
      setIsLoaded(true);
    };
    AsyncStorage.getItem(STORAGE_KEY)
      .then(finish)
      .catch(() => finish(null));
    return () => {
      mounted = false;
    };
  }, []);

  // Keep i18next in sync with the persisted language preference. Runs on initial
  // load and on every change, so switching language updates all screens live
  // (no logout / reload needed — react-i18next re-renders consumers).
  useEffect(() => {
    if (i18n.language !== settings.language) {
      void i18n.changeLanguage(settings.language);
    }
  }, [settings.language]);

  const update = useCallback((fn: (prev: AppSettings) => AppSettings) => {
    setSettings((prev) => {
      const next = fn(prev);
      if (next !== prev) persist(next);
      return next;
    });
  }, []);

  const patch = useCallback(
    (next: Partial<AppSettings>) => update((prev) => applyPatch(prev, next)),
    [update],
  );

  const bindAccount = useCallback((owner: string | null) => {
    ownerRef.current = owner;
    setBoundOwner(owner);
    // Before storage has loaded, the load effect applies the binding instead —
    // writing now would overwrite the stored preferences with defaults.
    if (!loadedRef.current) return;
    update((prev) => bindSettingsToAccount(prev, owner));
  }, [update]);

  const reconcileEvents = useCallback(
    (events: ReadonlyArray<{ id: number }>, total: number) =>
      update((prev) => reconcileAccessibleEvents(prev, events, total)),
    [update],
  );

  const { scopeOwner: _owner, ...visible } = visibleSettings(settings, boundOwner);

  const value: SettingsContextValue = {
    ...visible,
    isLoaded,
    setTheme: (theme) => patch({ theme }),
    setCaptureMode: (captureMode) => patch({ captureMode }),
    setFollowUpNotifications: (followUpNotifications) => patch({ followUpNotifications }),
    setMeetingReminders: (meetingReminders) => patch({ meetingReminders }),
    setLanguage: (language) => patch({ language }),
    setCountry: (country) => patch({ country }),
    setBiometricEnabled: (biometricEnabled) => patch({ biometricEnabled }),
    setLockTimeoutMs: (lockTimeoutMs) => patch({ lockTimeoutMs }),
    setActiveEvent: (activeEventId, activeEventName, opts) =>
      update((prev) => selectActiveEvent(prev, activeEventId, activeEventName, ownerRef.current, opts)),
    acknowledgeNoEvent: () => update((prev) => acknowledgeNoEvent(prev, ownerRef.current)),
    setContactFilters: (contactFilters) => patch({ contactFilters }),
    bindAccount,
    reconcileEvents,
  };

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}
