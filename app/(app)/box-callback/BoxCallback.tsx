"use client";

import { useEffect, useRef, useState } from "react";
import {
  boxSignInBack,
  finishBoxSignIn,
  forgetBoxTokens,
  type BoxConfig,
} from "@/lib/box-oauth/client";
import { adoptAccountLocale } from "@/lib/box-oauth/locale";

/** Trades the one-time code once, removes it from the URL, and goes to the app. */
export default function BoxCallback({ config }: { config: BoxConfig }) {
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    // A failed sign-in leaves no stale cookie behind to start it again (BoxApiBridge).
    const fail = (e: string) => {
      forgetBoxTokens();
      setError(e);
    };
    const search = new URLSearchParams(location.search);
    history.replaceState(null, "", location.pathname);
    finishBoxSignIn(config, search)
      .then(async (e) => {
        if (e) return fail(e);
        // The account's language, not the box host's guess (lib/box-oauth/locale.ts).
        await adoptAccountLocale({
          fetch: (url) => fetch(url),
          languages: navigator.languages ?? [navigator.language],
          setCookie: (line) => {
            document.cookie = line;
          },
        });
        location.replace(boxSignInBack());
      })
      .catch(() => fail("network"));
  }, [config]);
  if (error) return <code className="m-8 block">{error}</code>;
  return <span className="loading loading-spinner m-8" aria-busy="true" />;
}
