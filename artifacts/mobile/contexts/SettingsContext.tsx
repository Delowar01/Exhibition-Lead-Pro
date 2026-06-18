import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export type ThemePref = "light" | "dark" | "system";
export type CaptureModePref = "single" | "rapid" | "batch";
export type LanguagePref = "en" | "ar";
export type ContactSortPref = "newest" | "oldest" | "name";

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
  notifications: boolean;
  language: LanguagePref;
  biometricEnabled: boolean;
  activeEventId: number | null;
  activeEventName: string | null;
  contactFilters: ContactFilters;
}

const DEFAULTS: AppSettings = {
  theme: "system",
  captureMode: "single",
  notifications: true,
  language: "en",
  biometricEnabled: false,
  activeEventId: null,
  activeEventName: null,
  contactFilters: DEFAULT_CONTACT_FILTERS,
};

interface SettingsContextValue extends AppSettings {
  isLoaded: boolean;
  setTheme: (value: ThemePref) => void;
  setCaptureMode: (value: CaptureModePref) => void;
  setNotifications: (value: boolean) => void;
  setLanguage: (value: LanguagePref) => void;
  setBiometricEnabled: (value: boolean) => void;
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
  setNotifications: () => {},
  setLanguage: () => {},
  setBiometricEnabled: () => {},
  setActiveEvent: () => {},
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
            const parsed = JSON.parse(raw) as Partial<AppSettings>;
            setSettings({ ...DEFAULTS, ...parsed });
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
    setNotifications: (notifications) => patch({ notifications }),
    setLanguage: (language) => patch({ language }),
    setBiometricEnabled: (biometricEnabled) => patch({ biometricEnabled }),
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
