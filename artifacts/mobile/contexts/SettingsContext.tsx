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

export interface AppSettings {
  theme: ThemePref;
  captureMode: CaptureModePref;
  notifications: boolean;
  language: LanguagePref;
  biometricEnabled: boolean;
}

const DEFAULTS: AppSettings = {
  theme: "system",
  captureMode: "single",
  notifications: true,
  language: "en",
  biometricEnabled: false,
};

interface SettingsContextValue extends AppSettings {
  isLoaded: boolean;
  setTheme: (value: ThemePref) => void;
  setCaptureMode: (value: CaptureModePref) => void;
  setNotifications: (value: boolean) => void;
  setLanguage: (value: LanguagePref) => void;
  setBiometricEnabled: (value: boolean) => void;
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
