import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePreference = "light" | "dark" | "system";

// Batch 18: the user's explicit preference is stored PER USER + COMPANY
// (`csp_theme:u<id>c<company>`), so a shared browser never carries one tenant's
// choice into another. The pre-B18 global key (`csp_theme`) is honored only
// while nobody is signed in and is migrated into the scoped key on first use.
const LEGACY_KEY = "csp_theme";
const scopedKey = (scope: string) => `${LEGACY_KEY}:${scope}`;

interface ThemeContextValue {
  /** The preference in effect: explicit user choice, else the tenant default, else "system". */
  theme: ThemePreference;
  /** The user's explicit choice for the current scope (null = follows the tenant/platform default). */
  preference: ThemePreference | null;
  /** The signed-in tenant's default theme (null outside a branded tenant). */
  tenantDefault: ThemePreference | null;
  /** The theme actually applied right now (system resolved). */
  resolvedTheme: "light" | "dark";
  setTheme: (theme: ThemePreference) => void;
  /** Drop the explicit preference and follow the tenant/platform default again. */
  clearPreference: () => void;
  /** Wired by the branding provider: current user/company scope + tenant default. */
  configureScope: (scope: string | null, tenantDefault: ThemePreference | null) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function isPref(v: unknown): v is ThemePreference {
  return v === "light" || v === "dark" || v === "system";
}

function readKey(key: string): ThemePreference | null {
  try {
    const v = localStorage.getItem(key);
    return isPref(v) ? v : null;
  } catch {
    return null;
  }
}

function writeKey(key: string, value: ThemePreference | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/** Preference for a scope; a pre-B18 global value is adopted once into the scope, then removed. */
function readScoped(scope: string | null): ThemePreference | null {
  if (!scope) return readKey(LEGACY_KEY);
  const own = readKey(scopedKey(scope));
  if (own) return own;
  const legacy = readKey(LEGACY_KEY);
  if (legacy) {
    writeKey(scopedKey(scope), legacy);
    writeKey(LEGACY_KEY, null);
    return legacy;
  }
  return null;
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(theme: ThemePreference): "light" | "dark" {
  return theme === "dark" || (theme === "system" && systemPrefersDark()) ? "dark" : "light";
}

function apply(resolved: "light" | "dark") {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [scope, setScope] = useState<string | null>(null);
  const [tenantDefault, setTenantDefault] = useState<ThemePreference | null>(null);
  const [preference, setPreference] = useState<ThemePreference | null>(() => readScoped(null));
  const theme: ThemePreference = preference ?? tenantDefault ?? "system";
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() => resolve(preference ?? "system"));

  const configureScope = useCallback((nextScope: string | null, nextDefault: ThemePreference | null) => {
    setScope((prev) => {
      if (prev !== nextScope) setPreference(readScoped(nextScope));
      return nextScope;
    });
    setTenantDefault(nextDefault);
  }, []);

  const setTheme = useCallback(
    (next: ThemePreference) => {
      setPreference(next);
      writeKey(scope ? scopedKey(scope) : LEGACY_KEY, next);
    },
    [scope],
  );

  const clearPreference = useCallback(() => {
    setPreference(null);
    writeKey(scope ? scopedKey(scope) : LEGACY_KEY, null);
  }, [scope]);

  useEffect(() => {
    const run = () => {
      const r = resolve(theme);
      setResolvedTheme(r);
      apply(r);
    };
    run();
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", run);
    return () => mq.removeEventListener("change", run);
  }, [theme]);

  const value = useMemo(
    () => ({ theme, preference, tenantDefault, resolvedTheme, setTheme, clearPreference, configureScope }),
    [theme, preference, tenantDefault, resolvedTheme, setTheme, clearPreference, configureScope],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
