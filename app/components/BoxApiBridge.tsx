"use client";

import { createContext, useContext, useEffect, useState } from "react";
import {
  boxSignOut,
  forgetBoxTokens,
  hasBoxTokens,
  installBoxFetch,
  type BoxConfig,
} from "@/lib/box-oauth/client";
import type { BoxMe } from "@/lib/box-oauth/me";
import { resolveBoxUser } from "@/lib/box-oauth/session";
import { setSignOutSession } from "@/lib/sign-out";

/** On a box: who the tab is signed in as at lianki.com. Off a box there is no provider: null. */
const BoxSession = createContext<{ user: BoxMe | null } | null>(null);

/**
 * On a box only (docs/box-oauth.md): from the first render, the page's /api
 * calls go to lianki.com with the box's token. In render, not an effect, so it
 * is in place before any child's effect fetches.
 *
 * The box's server has no session, so it also asks lianki.com who the token
 * belongs to, and holds the page back until it knows: a short spinner, never
 * a flash of "Sign in". The header, the menu and the pages then read it with
 * useShellUser / useSignedIn, and sign-out revokes the token.
 */
export function BoxApiBridge({
  config,
  children,
}: {
  config: BoxConfig;
  children: React.ReactNode;
}) {
  if (typeof window !== "undefined") installBoxFetch(config);
  const [user, setUser] = useState<BoxMe | null | undefined>(undefined);
  useEffect(() => {
    setSignOutSession(async () => {
      await boxSignOut(config);
      return true;
    });
    let live = true;
    void resolveBoxUser({
      hasTokens: hasBoxTokens,
      forget: forgetBoxTokens,
      fetch: (url) => fetch(url),
      objectUrl: (b) => URL.createObjectURL(b),
    }).then((u) => {
      if (live) setUser(u);
    });
    return () => {
      live = false;
      setSignOutSession(undefined);
    };
  }, [config]);
  if (user === undefined)
    return (
      <div className="min-h-screen flex items-center justify-center" data-box-session="loading">
        <span className="loading loading-spinner" aria-busy="true" />
      </div>
    );
  return <BoxSession.Provider value={{ user }}>{children}</BoxSession.Provider>;
}

/** The user to show: the box's account on a box, else what the server said. */
export function useShellUser<T extends { name: string; email: string; image?: string | null }>(
  server: T | null | undefined,
): T | BoxMe | null {
  const s = useContext(BoxSession);
  return s ? s.user : (server ?? null);
}

/** Signed in? On a box from lianki.com's answer, else the server's. */
export function useSignedIn(server: boolean): boolean {
  const s = useContext(BoxSession);
  return s ? s.user !== null : server;
}
