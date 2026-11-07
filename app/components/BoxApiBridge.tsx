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
import {
  flagViewOn,
  resolveBoxAccount,
  type BoxAccount,
  type FlagView,
} from "@/lib/box-oauth/session";
import { setSignOutSession } from "@/lib/sign-out";

/**
 * On a box: who the tab is signed in as at lianki.com, with production's flags
 * and owner role for that account (null when signed out). Off a box there is
 * no provider: null.
 */
const BoxSession = createContext<{ user: BoxMe | null; account: BoxAccount | null } | null>(null);

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
  const [account, setAccount] = useState<BoxAccount | null | undefined>(undefined);
  useEffect(() => {
    setSignOutSession(async () => {
      await boxSignOut(config);
      return true;
    });
    let live = true;
    void resolveBoxAccount({
      hasTokens: hasBoxTokens,
      forget: forgetBoxTokens,
      fetch: (url) => fetch(url),
      objectUrl: (b) => URL.createObjectURL(b),
    }).then((a) => {
      if (live) setAccount(a);
    });
    return () => {
      live = false;
      setSignOutSession(undefined);
    };
  }, [config]);
  if (account === undefined)
    return (
      <div className="min-h-screen flex items-center justify-center" data-box-session="loading">
        <span className="loading loading-spinner" aria-busy="true" />
      </div>
    );
  return (
    <BoxSession.Provider value={{ user: account?.user ?? null, account }}>
      {children}
    </BoxSession.Provider>
  );
}

/**
 * The flags and owner role to decide by: on a box signed in through lianki.com,
 * production's for the bound account (docs/box-oauth.md, "Flags on a box");
 * otherwise what the server read. A box's own server reads its local D1 and
 * has no session, so its answer is not the account's.
 */
export function useFlagView(server: FlagView): FlagView {
  const s = useContext(BoxSession);
  return flagViewOn(s ? { account: s.account } : null, server);
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
