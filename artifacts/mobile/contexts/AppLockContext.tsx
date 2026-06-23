import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, type AppStateStatus, Platform } from "react-native";

import { authenticateBiometric } from "@/lib/biometric";
import { useSettings } from "@/contexts/SettingsContext";


// How long (ms) the app can be in the background before locking on return.
// Extracted as a constant so it is easy to make user-configurable later.
export const APP_LOCK_TIMEOUT_MS = 30_000;

interface AppLockContextValue {
  isLocked: boolean;
  /** Imperatively lock the app (e.g. after enabling the feature). */
  lock: () => void;
  /** Imperatively unlock the app (e.g. after disabling the feature). */
  unlock: () => void;
  /**
   * Show the biometric prompt and unlock on success.
   * PIN-ready: structured so a future PIN path can be substituted without
   * changing callers — just replace the body of `triggerUnlock`.
   */
  triggerUnlock: (promptMessage: string) => Promise<boolean>;
}

const AppLockContext = createContext<AppLockContextValue>({
  isLocked: false,
  lock: () => {},
  unlock: () => {},
  triggerUnlock: async () => false,
});

export function AppLockProvider({ children }: { children: React.ReactNode }) {
  const { biometricEnabled, isLoaded } = useSettings();
  const [isLocked, setIsLocked] = useState(false);

  // Track when the app moved to background so we can compute elapsed time.
  const lastBackgroundAtRef = useRef<number | null>(null);
  // Keep a stable ref to biometricEnabled so the AppState listener doesn't
  // capture a stale closure.
  const biometricEnabledRef = useRef(biometricEnabled);
  biometricEnabledRef.current = biometricEnabled;

  // Track whether the initial cold-launch lock check has been performed.
  // We must defer until `isLoaded` is true because SettingsProvider loads
  // persisted settings asynchronously (AsyncStorage) and always starts with
  // `biometricEnabled: false`. Locking on mount would miss the persisted value.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!isLoaded || initializedRef.current) return;
    initializedRef.current = true;
    // Cold-launch lock: persisted settings are now available — lock if enabled.
    if (biometricEnabled) {
      setIsLocked(true);
    }
  }, [isLoaded, biometricEnabled]);

  // When the feature is toggled OFF while the app is running, remove the lock
  // immediately (Settings screen calls `unlock()` directly, but this is a
  // safety net).
  useEffect(() => {
    if (!biometricEnabled) {
      setIsLocked(false);
    }
  }, [biometricEnabled]);

  // AppState listener — background / foreground transitions.
  useEffect(() => {
    if (Platform.OS === "web") return;

    function handleAppStateChange(nextState: AppStateStatus) {
      if (nextState === "background" || nextState === "inactive") {
        lastBackgroundAtRef.current = Date.now();
      } else if (nextState === "active") {
        if (!biometricEnabledRef.current) return;
        const backgroundAt = lastBackgroundAtRef.current;
        if (backgroundAt === null) return;
        const elapsed = Date.now() - backgroundAt;
        if (elapsed >= APP_LOCK_TIMEOUT_MS) {
          setIsLocked(true);
        }
        lastBackgroundAtRef.current = null;
      }
    }

    const subscription = AppState.addEventListener("change", handleAppStateChange);
    return () => subscription.remove();
  }, []);

  const lock = useCallback(() => {
    setIsLocked(true);
  }, []);

  const unlock = useCallback(() => {
    setIsLocked(false);
  }, []);

  /**
   * Calls the biometric prompt and unlocks on success.
   * Returns true if the app was successfully unlocked, false otherwise.
   *
   * PIN-ready: replace the body here to add a PIN fallback without touching
   * any caller (AppLockOverlay, future PIN screen, etc.).
   */
  const triggerUnlock = useCallback(
    async (promptMessage: string): Promise<boolean> => {
      if (Platform.OS === "web") {
        setIsLocked(false);
        return true;
      }
      const ok = await authenticateBiometric(promptMessage);
      if (ok) {
        setIsLocked(false);
      }
      return ok;
    },
    [],
  );

  return (
    <AppLockContext.Provider value={{ isLocked, lock, unlock, triggerUnlock }}>
      {children}
    </AppLockContext.Provider>
  );
}

export function useAppLock(): AppLockContextValue {
  return useContext(AppLockContext);
}
