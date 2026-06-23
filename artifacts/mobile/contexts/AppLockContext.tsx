import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, type AppStateStatus, Platform } from "react-native";

import {
  authenticateBiometric,
  clearPinLockState,
  hasPinSet,
  MAX_PIN_ATTEMPTS,
  PIN_LOCKOUT_MS,
  readPinLockState,
  verifyPin,
  writePinLockState,
} from "@/lib/biometric";
import { useSettings } from "@/contexts/SettingsContext";

/** Result of a PIN submission attempt. */
export interface SubmitPinResult {
  /** True if the PIN was correct and the app was unlocked. */
  ok: boolean;
  /** True if PIN entry is currently locked out (attempt was ignored or just triggered a lockout). */
  lockedOut: boolean;
  /** Epoch ms until which PIN entry is locked, or null. */
  lockedUntil: number | null;
  /** Remaining attempts before the next lockout. */
  attemptsRemaining: number;
}

interface AppLockContextValue {
  isLocked: boolean;
  /** Whether the user has set up a PIN fallback they can use instead of biometrics. */
  pinFallbackAvailable: boolean;
  /** Epoch ms until which PIN entry is locked out, or null when entry is allowed. */
  pinLockedUntil: number | null;
  /** Remaining wrong attempts before the next temporary lockout. */
  pinAttemptsRemaining: number;
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
   * Verify a PIN entered by the user and unlock if correct. Enforces the
   * brute-force lockout: after MAX_PIN_ATTEMPTS consecutive wrong PINs, PIN
   * entry is temporarily disabled for PIN_LOCKOUT_MS (biometrics stay open).
   */
  submitPin: (pin: string) => Promise<SubmitPinResult>;
  /** Clear an expired lockout once its countdown has elapsed. */
  clearExpiredLockout: () => void;
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
  pinLockedUntil: null,
  pinAttemptsRemaining: MAX_PIN_ATTEMPTS,
  lock: () => {},
  unlock: () => {},
  triggerUnlock: async () => false,
  submitPin: async () => ({
    ok: false,
    lockedOut: false,
    lockedUntil: null,
    attemptsRemaining: MAX_PIN_ATTEMPTS,
  }),
  clearExpiredLockout: () => {},
  refreshPinAvailability: async () => {},
});

export function AppLockProvider({ children }: { children: React.ReactNode }) {
  const { biometricEnabled, lockTimeoutMs, isLoaded } = useSettings();
  const [isLocked, setIsLocked] = useState(false);
  const [pinFallbackAvailable, setPinFallbackAvailable] = useState(false);
  const [pinLockedUntil, setPinLockedUntil] = useState<number | null>(null);
  const [pinAttemptsRemaining, setPinAttemptsRemaining] =
    useState(MAX_PIN_ATTEMPTS);

  // In-flight failed-attempt counter, mirrored to SecureStore so it survives a
  // relaunch. We keep a ref alongside state so submitPin reads the latest value
  // synchronously regardless of React batching.
  const failedAttemptsRef = useRef(0);

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

  // Load PIN availability + persisted lockout state on mount. A lockout that
  // has already expired is normalised back to "open" so the user is never
  // greeted by a stale countdown.
  useEffect(() => {
    void refreshPinAvailability();
    if (Platform.OS === "web") return;
    void (async () => {
      const state = await readPinLockState();
      const now = Date.now();
      if (state.lockedUntil && state.lockedUntil > now) {
        setPinLockedUntil(state.lockedUntil);
        failedAttemptsRef.current = 0;
        setPinAttemptsRemaining(MAX_PIN_ATTEMPTS);
      } else {
        if (state.lockedUntil) await clearPinLockState();
        failedAttemptsRef.current = state.failedAttempts;
        setPinAttemptsRemaining(
          Math.max(0, MAX_PIN_ATTEMPTS - state.failedAttempts),
        );
      }
    })();
  }, [refreshPinAvailability]);

  const clearExpiredLockout = useCallback(() => {
    setPinLockedUntil((prev) => {
      if (prev !== null && Date.now() >= prev) {
        failedAttemptsRef.current = 0;
        setPinAttemptsRemaining(MAX_PIN_ATTEMPTS);
        void clearPinLockState();
        return null;
      }
      return prev;
    });
  }, []);

  const lock = useCallback(() => {
    setIsLocked(true);
  }, []);

  // Reset the brute-force counters after any successful unlock (PIN or bio).
  const resetPinAttempts = useCallback(() => {
    failedAttemptsRef.current = 0;
    setPinAttemptsRemaining(MAX_PIN_ATTEMPTS);
    setPinLockedUntil(null);
    void clearPinLockState();
  }, []);

  const unlock = useCallback(() => {
    setIsLocked(false);
    resetPinAttempts();
  }, [resetPinAttempts]);

  /**
   * Calls the biometric prompt and unlocks on success.
   * Returns true if the app was successfully unlocked, false otherwise.
   * Biometric success also clears any active PIN lockout — a verified owner
   * should never stay throttled.
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
        resetPinAttempts();
      }
      return ok;
    },
    [resetPinAttempts],
  );

  /**
   * Verify a PIN and unlock if correct. Enforces the temporary brute-force
   * lockout after MAX_PIN_ATTEMPTS consecutive failures.
   */
  const submitPin = useCallback(
    async (pin: string): Promise<SubmitPinResult> => {
      const now = Date.now();

      // Already locked out — ignore the attempt entirely.
      if (pinLockedUntil !== null && now < pinLockedUntil) {
        return {
          ok: false,
          lockedOut: true,
          lockedUntil: pinLockedUntil,
          attemptsRemaining: 0,
        };
      }

      const ok = await verifyPin(pin);
      if (ok) {
        setIsLocked(false);
        resetPinAttempts();
        return {
          ok: true,
          lockedOut: false,
          lockedUntil: null,
          attemptsRemaining: MAX_PIN_ATTEMPTS,
        };
      }

      // Wrong PIN — increment the failure counter.
      const nextFailed = failedAttemptsRef.current + 1;
      if (nextFailed >= MAX_PIN_ATTEMPTS) {
        const lockedUntil = now + PIN_LOCKOUT_MS;
        failedAttemptsRef.current = 0;
        setPinAttemptsRemaining(MAX_PIN_ATTEMPTS);
        setPinLockedUntil(lockedUntil);
        await writePinLockState({ failedAttempts: 0, lockedUntil });
        return {
          ok: false,
          lockedOut: true,
          lockedUntil,
          attemptsRemaining: 0,
        };
      }

      failedAttemptsRef.current = nextFailed;
      const remaining = MAX_PIN_ATTEMPTS - nextFailed;
      setPinAttemptsRemaining(remaining);
      await writePinLockState({ failedAttempts: nextFailed, lockedUntil: null });
      return {
        ok: false,
        lockedOut: false,
        lockedUntil: null,
        attemptsRemaining: remaining,
      };
    },
    [pinLockedUntil, resetPinAttempts],
  );

  return (
    <AppLockContext.Provider
      value={{
        isLocked,
        pinFallbackAvailable,
        pinLockedUntil,
        pinAttemptsRemaining,
        lock,
        unlock,
        triggerUnlock,
        submitPin,
        clearExpiredLockout,
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
