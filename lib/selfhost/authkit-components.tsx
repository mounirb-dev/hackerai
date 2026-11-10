"use client";

/**
 * Client half of the self-hosted AuthKit replacement: `AuthKitProvider`,
 * `useAuth` and `useAccessToken` with the signatures the app already uses.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { NoUserInfo, UserInfo } from "./authkit";

type PublicAuth =
  Omit<UserInfo, "accessToken"> | Omit<NoUserInfo, "accessToken">;

type AuthState = PublicAuth & { loading: boolean };

export type RefreshAuthOptions = { organizationId?: string };

type AuthContextValue = {
  state: AuthState;
  refreshAuth: (
    options?: RefreshAuthOptions,
  ) => Promise<PublicAuth | undefined>;
  getToken: (force: boolean) => Promise<string | undefined>;
  token: string | undefined;
  signOut: (options?: { returnTo?: string }) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function tokenExpiresInMs(token: string): number {
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    return typeof payload.exp === "number"
      ? payload.exp * 1000 - Date.now()
      : 0;
  } catch {
    return 0;
  }
}

export function AuthKitProvider({
  children,
  initialAuth,
}: {
  children: ReactNode;
  initialAuth?: PublicAuth;
  onSessionExpired?: false | (() => void);
}) {
  const [state, setState] = useState<AuthState>({
    ...(initialAuth ?? { user: null }),
    loading: false,
  });
  const [token, setToken] = useState<string | undefined>(undefined);
  const tokenRef = useRef<string | undefined>(undefined);
  const inflight = useRef<Promise<string | undefined> | null>(null);

  const getToken = useCallback(async (force: boolean) => {
    const cached = tokenRef.current;
    if (!force && cached && tokenExpiresInMs(cached) > 60_000) return cached;
    // Collapse concurrent callers (Convex retries, several hooks) into one call.
    inflight.current ??= (async () => {
      try {
        const response = await fetch("/api/selfhost-auth/token", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (response.status === 401) {
          tokenRef.current = undefined;
          setToken(undefined);
          return undefined;
        }
        if (!response.ok)
          throw new Error(`Token request failed (${response.status})`);
        const data = (await response.json()) as { accessToken?: string };
        tokenRef.current = data.accessToken;
        setToken(data.accessToken);
        return data.accessToken;
      } finally {
        inflight.current = null;
      }
    })();
    return inflight.current;
  }, []);

  const refreshAuth = useCallback(
    async (options?: RefreshAuthOptions): Promise<PublicAuth | undefined> => {
      const response = await fetch("/api/selfhost-auth/session", {
        method: options?.organizationId ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: options?.organizationId
          ? JSON.stringify({ organizationId: options.organizationId })
          : undefined,
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok && response.status !== 401) {
        throw new Error(`Session request failed (${response.status})`);
      }
      const next = (
        response.status === 401 ? { user: null } : await response.json()
      ) as PublicAuth;
      setState({ ...next, loading: false });
      if (options?.organizationId) await getToken(true);
      return next;
    },
    [getToken],
  );

  const signOut = useCallback(async (options?: { returnTo?: string }) => {
    window.location.assign(
      `/logout${options?.returnTo ? `?returnTo=${encodeURIComponent(options.returnTo)}` : ""}`,
    );
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ state, refreshAuth, getToken, token, signOut }),
    [state, refreshAuth, getToken, token, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuthContext(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthKitProvider");
  }
  return context;
}

export function useAuth() {
  const { state, refreshAuth, signOut } = useAuthContext();
  return {
    user: state.user,
    loading: state.loading,
    sessionId: state.sessionId,
    organizationId: state.organizationId,
    role: state.role,
    roles: state.roles,
    permissions: state.permissions,
    entitlements: state.entitlements,
    featureFlags: state.featureFlags,
    impersonator: state.impersonator,
    refreshAuth,
    getAuth: refreshAuth,
    signOut,
  };
}

export function useAccessToken() {
  const { state, getToken, token } = useAuthContext();
  const getAccessToken = useCallback(() => getToken(false), [getToken]);
  const refresh = useCallback(() => getToken(true), [getToken]);
  return {
    accessToken: state.user ? token : undefined,
    loading: false,
    error: null as Error | null,
    getAccessToken,
    refresh,
  };
}
