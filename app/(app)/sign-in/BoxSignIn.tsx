"use client";

import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { hasBoxTokens, startBoxSignIn, type BoxConfig } from "@/lib/box-oauth/client";

/**
 * On a box the sign-in page is only a redirect to lianki.com (docs/box-oauth.md).
 * Already signed in, it does not go round again: a page drawn on the box's own
 * server (which sees no sign-in) sent the user here, so it says that instead of
 * looping through lianki.com and back to /home.
 */
export default function BoxSignIn({ config }: { config: BoxConfig }) {
  const [signedIn, setSignedIn] = useState(false);
  const t = useIntlayer("box-sign-in");
  useEffect(() => {
    if (hasBoxTokens()) setSignedIn(true);
    else void startBoxSignIn(config);
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
