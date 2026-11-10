"use client";

import { useEffect, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import {
  boxSignInBack,
  finishBoxSignIn,
  forgetBoxTokens,
  type BoxConfig,
} from "@/lib/box-oauth/client";
import { adoptAccountLocale } from "@/lib/box-oauth/locale";

/** Trades the one-time code once, removes it from the URL, and goes to the app. */
export default function BoxCallback({ config }: { config: BoxConfig }) {
  const [failed, setFailed] = useState(false);
  const t = useIntlayer("box-sign-in");
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    // A failed sign-in leaves no stale cookie behind to start it again (BoxApiBridge).
    // The reason code is for the console only; the user reads one translated line.
    const fail = (e: string) => {
      console.warn("[box-callback] sign-in failed:", e);
      forgetBoxTokens();
      setFailed(true);
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
  if (failed)
    return (
      <div className="m-8 max-w-md flex flex-col gap-4" role="alert" data-box-callback-failed>
        <p>{t.callbackFailed}</p>
        <div className="flex gap-3 flex-wrap">
          <a className="btn btn-primary" href="/sign-in">
            {t.signInAgain}
          </a>
          <a className="btn" href="/home">
            {t.backHome}
          </a>
        </div>
      </div>
    );
  return <span className="loading loading-spinner m-8" aria-busy="true" />;
}
