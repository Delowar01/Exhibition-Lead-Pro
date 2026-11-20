import { useQueryClient } from "@tanstack/react-query";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";

import { getMe, refreshToken as requestTokenRefresh, setOnFeatureDenied, setOnUnauthorized } from "@workspace/api-client-react";
import type { UnauthorizedContext, User } from "@workspace/api-client-react";

import { useSettings } from "@/contexts/SettingsContext";
import {
  type EndedSession,
  type SessionEndReason,
  classifyRefreshFailure,
  decideOnUnauthorized,
  endedOwnerWithinGrace,
  parseRefreshResponse,
  withIssuedToken,
} from "@/lib/auth-session-model";
import {
  clearSession,
  getCachedRefreshToken,
  getCachedToken,
  loadSession,
  saveRotatedTokens,
  saveSession,
  saveSessionUser,
} from "@/lib/auth-storage";
import { followBiometricSession, forgetBiometricSession, reconcileBiometricLogin } from "@/lib/biometric";
import { createEntitlementRefresher } from "@/lib/entitlement-refresh";
import { SESSION_RENEWAL_TIMEOUT_MS, withTimeout } from "@/lib/request-timeout";
import { accountOwnerKey } from "@/lib/settings-model";

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** `refreshToken` is the one the sign-in answer carried (absent for a remembered sign-in of an earlier version). */
  login: (token: string, user: User, refreshToken?: string | null) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (user: User) => Promise<void>;
  /**
   * Set when the session ended WITHOUT the user signing out (the server no
   * longer accepts it). The sign-in screen explains it; cleared by the next
   * sign-in, an explicit sign-out or once dismissed.
   */
  sessionNotice: SessionEndReason | null;
  dismissSessionNotice: () => void;
  /**
   * Owner key of a session that ended by itself moments ago (null otherwise,
   * and always null after an explicit sign-out). Lets a capture that was being
   * sent when the session ended be kept on the device for the account that made it.
   */
  endedOwner: () => string | null;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionNotice, setSessionNotice] = useState<SessionEndReason | null>(null);
  const queryClient = useQueryClient();
  // Every auth boundary binds the tenant-scoped settings (active event, event
  // filter) to the account now signed in, so they never carry across accounts.
  const { bindAccount } = useSettings();

  // M5 — entitlement refresh. The user stored at sign-in (and with it the plan
  // entitlements) is re-read from GET /auth/me once a stored session is
  // restored (launch, or a sign-in), when the app returns to the foreground and
  // when the API answers 403 FEATURE_NOT_ENTITLED. (This client has no
  // token-refresh flow, so there is no session-renewal trigger to wire.) Best
  // effort: it never signs out, never touches the token, never surfaces an error.
  // (Phase 2 Batch 1: the client now renews its session — see handleUnauthorized
  // below — and re-reads the user after each renewal through this same refresher.)
  // `userRef` / `generationRef` are the session as of NOW (not as of the last
  // render), which is what the identity guard compares an answer against.
  const userRef = useRef<User | null>(null);
  const generationRef = useRef(0);
  // Phase 2 Batch 1 — session renewal (rules: lib/auth-session-model.ts).
  // Access tokens the CURRENT session has carried, and the session that last
  // ended by itself (for the short capture grace period).
  const issuedTokensRef = useRef<string[]>([]);
  const endedRef = useRef<EndedSession | null>(null);
  // Identity of the SESSION: changes at a sign-in, a sign-out and a session end
  // only. (`generationRef` also moves on a profile edit, which must not make a
  // renewal answer look stale — the server has already rotated the token by then.)
  const sessionEpochRef = useRef(0);
  const [refresher] = useState(() =>
    createEntitlementRefresher<User>({
      getIdentity: () => {
        const current = userRef.current;
        if (!current || !getCachedToken()) return null;
        return {
          userId: current.id,
          companyId: current.companyId ?? null,
          generation: generationRef.current,
        };
      },
      getUser: () => userRef.current,
      fetchUser: (signal) => getMe({ signal }),
      applyUser: (fresh) => {
        const sessionToken = getCachedToken();
        if (!sessionToken) return;
        userRef.current = fresh;
        setUser(fresh);
        void saveSessionUser(sessionToken, fresh).catch(() => {
          // Storage trouble: the in-memory user is still current.
        });
      },
    }),
  );

  useEffect(() => {
    let mounted = true;
    loadSession()
      .then((session) => {
        if (!mounted) return;
        bindAccount(session.token ? accountOwnerKey(session.user) : null);
        setToken(session.token);
        setUser(session.user);
        setIsLoading(false);
        userRef.current = session.user;
        issuedTokensRef.current = session.token ? [session.token] : [];
        void refresher.refresh("restore");
      })
      .catch(() => {
        if (!mounted) return;
        bindAccount(null);
        setIsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [bindAccount, refresher]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresher.refresh("resume");
    });
    setOnFeatureDenied(() => void refresher.refresh("feature-denied"));
    return () => {
      subscription.remove();
      setOnFeatureDenied(null);
    };
  }, [refresher]);

  // The session ended on the server (rules: lib/auth-session-model.ts). Local
  // state is cleared exactly as at a sign-out, with three differences: the
  // sign-in screen is told why, the account is remembered for the short capture
  // grace period, and a biometric sign-in that holds this dead session is
  // forgotten. Captures waiting in the offline queue are not touched — they
  // belong to the account and come back when it signs in again.
  const endSession = useCallback(
    async (reason: SessionEndReason, epoch: number, ended: { token: string; refreshToken: string | null }) => {
      if (sessionEpochRef.current !== epoch) return; // a sign-in or sign-out already replaced that session
      sessionEpochRef.current += 1;
      generationRef.current += 1;
      const owner = accountOwnerKey(userRef.current);
      endedRef.current = owner ? { owner, at: Date.now() } : null;
      issuedTokensRef.current = [];
      userRef.current = null;
      const clearing = clearSession(); // the cached token is gone from this line on
      setSessionNotice(reason);
      bindAccount(null);
      setToken(null);
      setUser(null);
      queryClient.clear();
      try {
        await clearing;
        // "blocked" = the organization is not allowed in right now; the server
        // has NOT revoked the session, so the remembered sign-in stays valid.
        if (reason === "expired") await forgetBiometricSession(ended);
      } catch {
        // Storage trouble must not keep a dead session on screen.
      }
    },
    [bindAccount, queryClient],
  );

  // A request came back 401. Renew the session once (POST /auth/refresh, the
  // API's existing contract) and let the request be retried — but only for a
  // request of THIS session, and without ending the session over a lost
  // connection. Concurrent rejections share one call (the API client
  // deduplicates per rejected token).
  const handleUnauthorized = useCallback(
    async ({ failedToken, url }: UnauthorizedContext): Promise<string | null> => {
      const snapshot = {
        generation: sessionEpochRef.current,
        accessToken: getCachedToken(),
        refreshToken: getCachedRefreshToken(),
        issuedTokens: issuedTokensRef.current,
      };
      const decision = decideOnUnauthorized(snapshot, failedToken, url);
      if (decision.action === "ignore") return null;
      if (decision.action === "retry") return decision.token;
      const current = { token: snapshot.accessToken as string, refreshToken: snapshot.refreshToken };
      if (decision.action === "end") {
        await endSession(decision.reason, snapshot.generation, current);
        return null;
      }
      // Take a renewal answer into use — but only for the session that asked
      // for it, and only while its tokens are still the ones in use. A sign-out,
      // another sign-in or a later renewal makes the answer void.
      const adopt = async (answer: unknown): Promise<string | null> => {
        const renewed = parseRefreshResponse(answer);
        if (!renewed) return null;
        if (sessionEpochRef.current !== snapshot.generation) return null; // signed out or switched while renewing
        if (!(await saveRotatedTokens(current.token, renewed))) return null;
        issuedTokensRef.current = withIssuedToken(issuedTokensRef.current, renewed.token);
        setToken(renewed.token);
        try {
          await followBiometricSession(current, renewed);
        } catch {
          // The remembered sign-in simply expires with its old tokens.
        }
        // Same as the web portal after a renewal: the plan entitlements are re-read.
        void refresher.refresh("restore");
        return renewed.token;
      };
      let answer: unknown;
      try {
        // A renewal that does not answer must not hold every waiting request
        // for ever: after the limit this request fails and the session stays.
        // If the answer still arrives later, the server HAS replaced the refresh
        // token — so it is taken into use then (under the same conditions as
        // above) instead of leaving the app with a token the server no longer accepts.
        answer = await withTimeout(SESSION_RENEWAL_TIMEOUT_MS, (o) => requestTokenRefresh({ refreshToken: decision.refreshToken }, o), {
          onLate: (late) => {
            void adopt(late).catch(() => {});
          },
        });
      } catch (err) {
        const failure = classifyRefreshFailure(err);
        if (failure.kind === "ended") await endSession(failure.reason, snapshot.generation, current);
        return null; // otherwise: no connection / no answer in time / server trouble — the session stays, only this request fails
      }
      try {
        return await adopt(answer);
      } catch {
        return null;
      }
    },
    [endSession, refresher],
  );

  useEffect(() => {
    setOnUnauthorized(handleUnauthorized);
    return () => setOnUnauthorized(null);
  }, [handleUnauthorized]);

  const login = useCallback(
    async (newToken: string, newUser: User, newRefreshToken: string | null = null) => {
      // M5: a refresh still in flight belongs to the previous session — its
      // answer is dropped from here on (generationRef is its identity guard).
      generationRef.current += 1;
      sessionEpochRef.current += 1;
      endedRef.current = null;
      issuedTokensRef.current = [newToken];
      setSessionNotice(null);
      await saveSession(newToken, newUser, newRefreshToken);
      // The remembered biometric sign-in belongs to ONE account: it stays when
      // this is that account (and now points at this session) and is cleared
      // when a different account has just authenticated. Best effort — storage
      // trouble must not block a login.
      try {
        await reconcileBiometricLogin(newUser, { token: newToken, refreshToken: newRefreshToken });
      } catch {
        // ignore
      }
      bindAccount(accountOwnerKey(newUser));
      setToken(newToken);
      setUser(newUser);
      userRef.current = newUser;
      // M5: a biometric quick sign-in restores a STORED user snapshot (as old
      // as its enrolment), so every sign-in re-reads the user once. After a
      // password / MFA sign-in this merely confirms the answer just received.
      void refresher.refresh("restore");
    },
    [bindAccount, refresher],
  );

  const logout = useCallback(async () => {
    generationRef.current += 1;
    sessionEpochRef.current += 1;
    // An explicit sign-out: no notice, and no grace period for late captures.
    endedRef.current = null;
    issuedTokensRef.current = [];
    setSessionNotice(null);
    await clearSession();
    bindAccount(null);
    setToken(null);
    setUser(null);
    userRef.current = null;
    queryClient.clear();
  }, [queryClient, bindAccount]);

  const updateUser = useCallback(
    async (nextUser: User) => {
      // M5: a local edit wins over a refresh answer requested before it.
      generationRef.current += 1;
      userRef.current = nextUser;
      setUser(nextUser);
      // Only the stored USER changes. The tokens are not read back or rewritten
      // here: a failed read of the stored refresh token must never lead to it
      // being deleted, and a renewal under way keeps its own writes.
      const sessionToken = getCachedToken();
      if (sessionToken) await saveSessionUser(sessionToken, nextUser);
      // A profile edit answers with a user that carries no permissions or
      // entitlements: re-read the full user at once, so the cached copy never
      // sits without them until the next resume.
      void refresher.refresh("restore");
    },
    [refresher],
  );

  const dismissSessionNotice = useCallback(() => setSessionNotice(null), []);
  const endedOwner = useCallback(() => endedOwnerWithinGrace(endedRef.current, Date.now()), []);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isLoading,
        isAuthenticated: !!token,
        login,
        logout,
        updateUser,
        sessionNotice,
        dismissSessionNotice,
        endedOwner,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
