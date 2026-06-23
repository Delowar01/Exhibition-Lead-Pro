import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, type AppStateStatus, Platform } from "react-native";

import { authenticateBiometric, hasPinSet, verifyPin } from "@/lib/biometric";
import { useSettings } from "@/contexts/SettingsContext";


interface AppLockContextValue {
  isLocked: boolean;
  /** Whether the user has set up a PIN fallback they can use instead of biometrics. */
  pinFallbackAvailable: boolean;
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
  /**
   * Verify a PIN entered by the user and unlock if correct.
   * Returns true on success, false on wrong PIN.
   */
  submitPin: (pin: string) => Promise<boolean>;
  /**
   * Re-read hasPinSet() from SecureStore and refresh `pinFallbackAvailable`.
   * Call this after saving or clearing a PIN in Settings so the overlay
   * shows/hides the "Use PIN instead" button without a full restart.
   */
  refreshPinAvailability: () => Promise<void>;
}

const AppLockContext = createContext<AppLockContextValue>({
  isLocked: false,
  pinFallbackAvailable: false,
  lock: () => {},
  unlock: () => {},
  triggerUnlock: async () => false,
  submitPin: async () => false,
  refreshPinAvailability: async () => {},
});

export function AppLockProvider({ children }: { children: React.ReactNode }) {
  const { biometricEnabled, lockTimeoutMs, isLoaded } = useSettings();
  const [isLocked, setIsLocked] = useState(false);
  const [pinFallbackAvailable, setPinFallbackAvailable] = useState(false);

  // Track when the app moved to background so we can compute elapsed time.
  const lastBackgroundAtRef = useRef<number | null>(null);

  // Keep stable refs to settings so the AppState listener never captures
  // stale closures.
  const biometricEnabledRef = useRef(biometricEnabled);
  biometricEnabledRef.current = biometricEnabled;
  const lockTimeoutMsRef = useRef(lockTimeoutMs);
  lockTimeoutMsRef.current = lockTimeoutMs;

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
      if (nextState === "inactive" || nextState === "background") {
        if (!biometricEnabledRef.current) return;

        if (lockTimeoutMsRef.current === 0) {
          // "Immediately" mode: lock as soon as the screen goes inactive /
          // the device locks. The user will see the unlock prompt on resume.
          setIsLocked(true);
        } else {
          // Grace-period mode: record the timestamp; we'll compare on resume.
          lastBackgroundAtRef.current = Date.now();
        }
      } else if (nextState === "active") {
        if (!biometricEnabledRef.current) return;

        if (lockTimeoutMsRef.current === 0) {
          // Already locked above; nothing more to do here.
          lastBackgroundAtRef.current = null;
          return;
        }

        const backgroundAt = lastBackgroundAtRef.current;
        if (backgroundAt === null) return;
        const elapsed = Date.now() - backgroundAt;
        if (elapsed >= lockTimeoutMsRef.current) {
          setIsLocked(true);
        }
        lastBackgroundAtRef.current = null;
      }
    }

    const subscription = AppState.addEventListener("change", handleAppStateChange);
    return () => subscription.remove();
  }, []);

  const refreshPinAvailability = useCallback(async () => {
    if (Platform.OS === "web") {
      setPinFallbackAvailable(false);
      return;
    }
    const has = await hasPinSet();
    setPinFallbackAvailable(has);
  }, []);

  // Load PIN availability on mount.
  useEffect(() => {
    void refreshPinAvailability();
  }, [refreshPinAvailability]);

  const lock = useCallback(() => {
    setIsLocked(true);
  }, []);

  const unlock = useCallback(() => {
    setIsLocked(false);
  }, []);

  /**
   * Calls the biometric prompt and unlocks on success.
   * Returns true if the app was successfully unlocked, false otherwise.
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

  /**
   * Verify a PIN and unlock if correct.
   */
  const submitPin = useCallback(async (pin: string): Promise<boolean> => {
    const ok = await verifyPin(pin);
    if (ok) {
      setIsLocked(false);
    }
    return ok;
  }, []);

  return (
    <AppLockContext.Provider
      value={{
        isLocked,
        pinFallbackAvailable,
        lock,
        unlock,
        triggerUnlock,
        submitPin,
        refreshPinAvailability,
      }}
    >
      {children}
    </AppLockContext.Provider>
  );
}

export function useAppLock(): AppLockContextValue {
  return useContext(AppLockContext);
}
