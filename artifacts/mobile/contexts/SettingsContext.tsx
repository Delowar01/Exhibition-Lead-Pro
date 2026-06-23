import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import i18n from "@/lib/i18n";
import { DEFAULT_COUNTRY, type CountryCode } from "@/lib/countries";

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
}

const DEFAULTS: AppSettings = {
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
};

interface SettingsContextValue extends AppSettings {
  isLoaded: boolean;
  setTheme: (value: ThemePref) => void;
  setCaptureMode: (value: CaptureModePref) => void;
  setFollowUpNotifications: (value: boolean) => void;
  setMeetingReminders: (value: boolean) => void;
  setLanguage: (value: LanguagePref) => void;
  setCountry: (value: CountryCode) => void;
  setBiometricEnabled: (value: boolean) => void;
  setLockTimeoutMs: (value: LockTimeoutMs) => void;
  setActiveEvent: (id: number | null, name: string | null) => void;
  setContactFilters: (value: ContactFilters) => void;
}

const STORAGE_KEY = "csp_settings";

// A populated default value means consumers (notably useColors) keep working
// even when rendered outside the provider — e.g. an error-boundary fallback.
const SettingsContext = createContext<SettingsContextValue>({
  ...DEFAULTS,
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
  setContactFilters: () => {},
});

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!mounted) return;
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Partial<AppSettings> & { notifications?: boolean };
            const merged: AppSettings = { ...DEFAULTS, ...parsed };
            // Migrate from single `notifications` flag to two separate keys.
            // If the old key is present but the new keys are absent, carry the
            // legacy value forward so existing users keep their preference.
            const legacy = parsed.notifications;
            if (legacy !== undefined) {
              if (parsed.followUpNotifications === undefined) merged.followUpNotifications = legacy;
              if (parsed.meetingReminders === undefined) merged.meetingReminders = legacy;
            }
            setSettings(merged);
          } catch {
            // keep defaults
          }
        }
        setIsLoaded(true);
      })
      .catch(() => {
        if (mounted) setIsLoaded(true);
      });
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

  const patch = useCallback((next: Partial<AppSettings>) => {
    setSettings((prev) => {
      const merged = { ...prev, ...next };
      void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      return merged;
    });
  }, []);

  const value: SettingsContextValue = {
    ...settings,
    isLoaded,
    setTheme: (theme) => patch({ theme }),
    setCaptureMode: (captureMode) => patch({ captureMode }),
    setFollowUpNotifications: (followUpNotifications) => patch({ followUpNotifications }),
    setMeetingReminders: (meetingReminders) => patch({ meetingReminders }),
    setLanguage: (language) => patch({ language }),
    setCountry: (country) => patch({ country }),
    setBiometricEnabled: (biometricEnabled) => patch({ biometricEnabled }),
    setLockTimeoutMs: (lockTimeoutMs) => patch({ lockTimeoutMs }),
    setActiveEvent: (activeEventId, activeEventName) =>
      patch({ activeEventId, activeEventName }),
    setContactFilters: (contactFilters) => patch({ contactFilters }),
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
