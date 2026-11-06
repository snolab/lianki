"use client";

import { useEffect } from "react";
import { startBoxSignIn, type BoxConfig } from "@/lib/box-oauth/client";

/** On a box the sign-in page is only a redirect to lianki.com (docs/box-oauth.md). */
export default function BoxSignIn({ config }: { config: BoxConfig }) {
  useEffect(() => {
    void startBoxSignIn(config);
  }, [config]);
  return <span className="loading loading-spinner m-8" aria-busy="true" />;
}
