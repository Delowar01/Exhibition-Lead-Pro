import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { User, getMe, setOnFeatureDenied } from "@workspace/api-client-react";
import { createEntitlementRefresher, type RefreshTrigger, type SessionIdentity } from "@/lib/entitlement-refresh";

// localStorage is synchronous, so the stored session is restored DURING the
// very first render (lazy useState initializer) instead of in a post-render
// effect. An authenticated user opening a new tab / reloading is therefore
// never observable as "logged out" — not even for one frame — which is what
// previously allowed protected routes to bounce a live session to /login.
function readStoredAuth(): { user: User | null; token: string | null } {
  try {
    const token = localStorage.getItem("csp_token");
    const rawUser = localStorage.getItem("csp_user");
    if (token && rawUser) {
      return { user: JSON.parse(rawUser) as User, token };
    }
  } catch (error) {
    console.error("Failed to load auth state", error);
  }
  return { user: null, token: null };
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (user: User, token: string, refreshToken?: string | null) => void;
  logout: () => void;
  /**
   * M5: re-read the signed-in user (and with it the plan entitlements) from
   * GET /auth/me. Best effort — it never signs out and never surfaces an error.
   */
  refreshUser: (trigger: RefreshTrigger) => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [initialAuth] = useState(readStoredAuth);
  const [user, setUser] = useState<User | null>(initialAuth.user);
  const [token, setToken] = useState<string | null>(initialAuth.token);
  // Hydration is synchronous now, so there is no loading phase. The flag is
  // kept (always false) so consumers like ProtectedRoute keep their contract.
  const isLoading = false;

  // M5 — entitlement refresh. The user stored at sign-in is re-read from
  // GET /auth/me on session restore, after a token refresh, when the tab comes
  // back to the front and when the API answers 403 FEATURE_NOT_ENTITLED.
  // `userRef` / `generationRef` are the session as of NOW (not as of the last
  // render), which is what the identity guard compares an answer against.
  const userRef = useRef<User | null>(initialAuth.user);
  const generationRef = useRef(0);
  const [refresher] = useState(() =>
    createEntitlementRefresher<User>({
      getIdentity: (): SessionIdentity | null => {
        const current = userRef.current;
        const stored = readStoredAuth();
        // Signed out (here or in another tab), or another account now owns the
        // shared storage: there is nothing to refresh and nothing to apply to.
        if (!current || !stored.user) return null;
        if (stored.user.id !== current.id || (stored.user.companyId ?? null) !== (current.companyId ?? null)) return null;
        return { userId: current.id, companyId: current.companyId ?? null, generation: generationRef.current };
      },
      getUser: () => userRef.current,
      fetchUser: (signal) => getMe({ signal }),
      applyUser: (fresh) => {
        userRef.current = fresh;
        setUser(fresh);
        try {
          localStorage.setItem("csp_user", JSON.stringify(fresh));
        } catch {
          // Storage unavailable — the in-memory user is still current.
        }
      },
    }),
  );
  const refreshUser = useCallback(
    (trigger: RefreshTrigger) => {
      void refresher.refresh(trigger);
    },
    [refresher],
  );

  useEffect(() => {
    refreshUser("restore");
    const onResume = () => {
      if (document.visibilityState === "visible") refreshUser("resume");
    };
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    setOnFeatureDenied(() => refreshUser("feature-denied"));
    return () => {
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
      setOnFeatureDenied(null);
    };
  }, [refreshUser]);

  const login = (newUser: User, newToken: string, refreshToken?: string | null) => {
    userRef.current = newUser;
    generationRef.current += 1;
    setUser(newUser);
    setToken(newToken);
    localStorage.setItem("csp_token", newToken);
    localStorage.setItem("csp_user", JSON.stringify(newUser));
    if (refreshToken) {
      localStorage.setItem("csp_refresh_token", refreshToken);
    } else {
      localStorage.removeItem("csp_refresh_token");
    }
    if (newUser.companyId) {
      localStorage.setItem("csp_company_id", newUser.companyId.toString());
    }
  };

  const logout = () => {
    userRef.current = null;
    generationRef.current += 1;
    setUser(null);
    setToken(null);
    localStorage.removeItem("csp_token");
    localStorage.removeItem("csp_refresh_token");
    localStorage.removeItem("csp_user");
    localStorage.removeItem("csp_company_id");
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, refreshUser, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
