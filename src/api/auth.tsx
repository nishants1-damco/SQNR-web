// Session state for the app (plan §13.2): restores the session from the
// refresh cookie on load, keeps the access token fresh, and follows sign-in
// and sign-out in other tabs. `useAuth()` keeps the shape the routes used
// with Supabase: `{ session, user, loading }`.
import type { User } from "@spatial/contracts";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { api, type ApiClient, type Session } from "./client";

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

/** Refresh this long before the access token expires. */
const EARLY_MS = 90_000;
const CHANNEL = "sqnr-auth";

export function AuthProvider({
  children,
  client = api,
}: {
  children: ReactNode;
  client?: ApiClient;
}) {
  const [session, setSession] = useState<Session | null>(client.currentSession);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
    const unsubscribe = client.onSessionChange((next) => {
      if (!active) return;
      setSession((previous) => {
        // Tell other tabs, so signing out here signs out everywhere.
        if (!!previous !== !!next) channel?.postMessage(next ? "signed-in" : "signed-out");
        return next;
      });
    });
    if (channel) {
      channel.onmessage = (event) => {
        if (event.data === "signed-out" && client.currentSession) {
          void client.signOut().catch(() => undefined);
        }
        if (event.data === "signed-in" && !client.currentSession) {
          void client.refresh().catch(() => undefined);
        }
      };
    }
    client
      .refresh()
      .catch(() => null)
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      unsubscribe();
      channel?.close();
    };
  }, [client]);

  // Refresh ahead of expiry, so long-lived views (an open event stream, a
  // capture in progress) never find the token stale.
  useEffect(() => {
    if (!session) return;
    const wait = Math.max(5_000, session.expiresAt - Date.now() - EARLY_MS);
    const timer = window.setTimeout(() => void client.refresh().catch(() => undefined), wait);
    return () => window.clearTimeout(timer);
  }, [client, session]);

  const value = useMemo(
    () => ({ session, user: session?.user ?? null, loading }),
    [session, loading],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (!state) throw new Error("useAuth must be used inside <AuthProvider>");
  return state;
}
