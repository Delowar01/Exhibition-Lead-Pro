import { createContext, useContext, useState, ReactNode } from "react";
import { User } from "@workspace/api-client-react";

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

  const login = (newUser: User, newToken: string, refreshToken?: string | null) => {
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
    setUser(null);
    setToken(null);
    localStorage.removeItem("csp_token");
    localStorage.removeItem("csp_refresh_token");
    localStorage.removeItem("csp_user");
    localStorage.removeItem("csp_company_id");
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isLoading }}>
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
