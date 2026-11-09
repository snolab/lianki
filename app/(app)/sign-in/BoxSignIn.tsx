"use client";

import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import {
  hasBoxTokens,
  startBoxSignIn,
  syncBoxCookie,
  type BoxConfig,
} from "@/lib/box-oauth/client";
import { boxReturnPath } from "@/lib/box-oauth/return-path";

const BOUNCE = "lk:box:bounce";
/** The same page sent back here again this soon: the box's server still cannot see the sign-in. */
const BOUNCE_MS = 20_000;

/** Not the same page twice within BOUNCE_MS: a server that cannot see the sign-in never loops. */
function mayBounce(to: string): boolean {
  try {
    const last = JSON.parse(sessionStorage.getItem(BOUNCE) ?? "null") as {
      to?: string;
      at?: number;
    } | null;
    if (last?.to === to && Date.now() - (last.at ?? 0) < BOUNCE_MS) return false;
    sessionStorage.setItem(BOUNCE, JSON.stringify({ to, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

/**
 * On a box the sign-in page is only a redirect to lianki.com (docs/box-oauth.md).
 * Already signed in, a page drawn on the box's own server sent the tab here
 * because its token cookie went stale (server-session.ts): the token is
 * refreshed, the cookie written again, and the tab goes straight back to that
 * page (`?next=`). Only if the box's server still cannot see the sign-in does it
 * say so, instead of looping.
 */
export default function BoxSignIn({ config }: { config: BoxConfig }) {
  const [signedIn, setSignedIn] = useState(false);
  const t = useIntlayer("box-sign-in");
  useEffect(() => {
    const next = boxReturnPath(new URLSearchParams(location.search).get("next"));
    if (!hasBoxTokens()) {
      void startBoxSignIn(config, next);
      return;
    }
    void syncBoxCookie(config).then((ok) => {
      // Signed in with nowhere to return to (a "Sign in" link): home, as after signing in.
      const to = next ?? "/home";
      if (ok && mayBounce(to)) location.replace(to);
      else setSignedIn(true);
    });
  }, [config]);
  if (!signedIn) return <span className="loading loading-spinner m-8" aria-busy="true" />;
  return (
    <div className="m-8 max-w-md flex flex-col gap-4" data-box-signed-in>
      <p>{t.serverOnly}</p>
      <div className="flex gap-3 flex-wrap">
        <a className="btn btn-primary" href={config.provider}>
          {t.openOnLianki}
        </a>
        <a className="btn" href="/home">
          {t.backHome}
        </a>
      </div>
    </div>
  );
}
